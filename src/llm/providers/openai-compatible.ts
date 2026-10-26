// Generic OpenAI-compatible provider adapter for the LlmClient seam. This is the
// v1 required provider shape (docs/decisions.md § OSS product, 2026-09-09): any
// endpoint that speaks POST <baseUrl>/chat/completions, configured with nothing
// but a base URL and an API key. OpenAI, vLLM, LM Studio, OpenRouter, Groq,
// Together, llama.cpp and local Ollama are all this shape, so they are presets
// over one adapter rather than one adapter each (see ../provider.ts).
//
//   EXTRAY_LLM_PROVIDER=openai-compatible \
//   OPENAI_BASE_URL=https://my-endpoint.example/v1 OPENAI_API_KEY=... \
//     npm run assess -- <id> --methodology monolith --model <model>
//
// Ollama Cloud keeps its own native adapter (./ollama-cloud.ts) even though it
// also serves /v1: the native /api/chat body carries `num_ctx`, and Ollama
// SILENTLY TRUNCATES prompts past a small default context window. There is no
// OpenAI-compatible field for that, so routing Ollama through this adapter would
// quietly truncate 200k-token assess prompts. The `ollama` preset therefore
// resolves to the native adapter; both are driven by the same base-URL + key knobs.

import type { LlmClient, LlmRequest, LlmResponse } from "../client.ts";
import { isRetryableStatus, parseRetryAfterMs, withRetries, type RetryHints } from "../http-retry.ts";

type FetchImpl = typeof fetch;

// Same per-attempt default as the native adapter: a 266k-token assess prompt
// takes 2+ minutes of generation, and an aborted attempt is retried (it looks
// transient), so a too-low timeout burns 3 x timeoutMs and then kills the run.
export const DEFAULT_TIMEOUT_MS = 600_000;

export interface OpenAiCompatibleOptions {
  /** OpenAI-compatible base URL, INCLUDING any /v1 suffix. Required. */
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: FetchImpl;
  /** Per-attempt timeout. Default: LLM_TIMEOUT_MS env or DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Retry attempts for transient failures. Default 2 (3 tries total). */
  retries?: number;
  /** Linear backoff base between retries, in ms. Default 500. */
  retryBaseMs?: number;
  /** Label used in error messages, e.g. the preset id. Default "openai-compatible". */
  name?: string;
}

/** Resolve the per-attempt timeout: explicit option > LLM_TIMEOUT_MS env > default. */
export function resolveTimeoutMs(timeoutMs?: number): number {
  if (typeof timeoutMs === "number" && timeoutMs > 0) return timeoutMs;
  const env = Number(process.env.LLM_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_TIMEOUT_MS;
}

// Provider-neutral param names that map 1:1 onto documented OpenAI
// chat-completions fields. Everything else is dropped with a warning, because a
// silently-ignored knob still participates in the fixture key.
const PASSTHROUGH_PARAMS = new Set([
  "temperature",
  "top_p",
  "seed",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "max_completion_tokens",
]);

// Params that are intentionally NOT part of the request body and must be dropped
// without a warning:
//   run     — a fixture-key differentiator only (repeated identical prompts).
//   think   — Ollama's reasoning-effort knob; no portable /v1 equivalent, and
//             `reasoning_effort` is rejected by most non-OpenAI endpoints.
//   num_ctx — a native-Ollama context-window knob with no /v1 equivalent.
const SILENTLY_IGNORED_PARAMS = new Set(["run", "think", "num_ctx"]);

/** Build an OpenAI /chat/completions request body (non-streaming). */
export function buildCompletionsBody(req: LlmRequest): Record<string, unknown> {
  const params = req.params ?? {};
  const body: Record<string, unknown> = {
    model: req.model,
    messages: [{ role: "user", content: req.prompt }],
    stream: false,
    temperature: typeof params.temperature === "number" ? params.temperature : 0,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (key === "temperature") continue; // handled above
    if (key === "num_predict") {
      // The arms speak Ollama's output-cap name; /v1 calls it max_tokens.
      body.max_tokens = value;
    } else if (key === "format") {
      // Structured output. "json" is the arms' shorthand for JSON mode; a schema
      // object is forwarded as a json_schema response format. The API wants the
      // schema wrapped as json_schema: { name, schema }; a bare schema there is
      // rejected (400) by OpenAI and by compatible servers that validate it.
      body.response_format =
        value === "json" ? { type: "json_object" } : { type: "json_schema", json_schema: { name: "response", schema: value } };
    } else if (PASSTHROUGH_PARAMS.has(key)) {
      body[key] = value;
    } else if (!SILENTLY_IGNORED_PARAMS.has(key)) {
      console.warn(`openai-compatible: ignoring unknown param "${key}" (not forwarded to /chat/completions)`);
    }
  }
  return body;
}

/**
 * Map a /chat/completions response onto LlmResponse. `promptChars` enables the
 * same missing-input-count estimate the native adapter makes: some
 * OpenAI-compatible servers omit `usage` entirely, and coercing that to 0
 * silently zeroes token accounting (and therefore cost).
 */
export function parseCompletionsResponse(json: unknown, promptChars?: number, name = "openai-compatible"): LlmResponse {
  const j = json as Record<string, unknown>;
  if (j.error) {
    // A 200 body with an in-body error (bad model, bad request shape) is
    // deterministic — retrying it 3x with backoff just wastes a RECORD run.
    const detail = typeof j.error === "string" ? j.error : ((j.error as { message?: string })?.message ?? JSON.stringify(j.error));
    const err: Error & RetryHints = new Error(`${name}: API error: ${detail}`);
    err.retryable = false;
    throw err;
  }
  const choice = (j.choices as Array<{ message?: { content?: unknown }; finish_reason?: unknown }> | undefined)?.[0];
  const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const usageJson = j.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
  let inputTokens = typeof usageJson?.prompt_tokens === "number" ? usageJson.prompt_tokens : 0;
  const outputTokens = typeof usageJson?.completion_tokens === "number" ? usageJson.completion_tokens : 0;
  let inputTokensEstimated = false;
  if (typeof usageJson?.prompt_tokens !== "number" && typeof promptChars === "number" && promptChars > 0) {
    inputTokens = Math.ceil(promptChars / 4);
    inputTokensEstimated = true;
    console.warn(
      `${name}: response carried no usage.prompt_tokens; estimating inputTokens=${inputTokens} ` +
        `from the ~${promptChars}-char prompt (~4 chars/token) — the count is approximate`,
    );
  }
  if (choice?.finish_reason === "length") {
    console.warn(`${name}: response hit the output token limit (finish_reason="length"); the completion is truncated`);
  }
  const usage: LlmResponse["usage"] = { inputTokens, outputTokens };
  if (inputTokensEstimated) usage.inputTokensEstimated = true;
  return { text, usage };
}

/** Normalize a base URL for concatenation: drop any trailing slash. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function createOpenAiCompatibleClient(opts: OpenAiCompatibleOptions): LlmClient {
  const name = opts.name ?? "openai-compatible";
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const apiKey = opts.apiKey;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);

  async function attempt(req: LlmRequest): Promise<LlmResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = buildCompletionsBody(req);
      const res = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Some self-hosted endpoints need no auth at all; only send the header
          // when a key exists so a keyless local server isn't rejected.
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err: Error & RetryHints = new Error(
          `${name}: ${res.status} ${res.statusText} for model "${req.model}" at ${baseUrl}${text ? `: ${text.slice(0, 300)}` : ""}`,
        );
        err.retryable = isRetryableStatus(res.status);
        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
        if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
        throw err;
      }
      return parseCompletionsResponse(await res.json(), JSON.stringify(body.messages).length, name);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    complete(req: LlmRequest): Promise<LlmResponse> {
      return withRetries(() => attempt(req), { retries: opts.retries, retryBaseMs: opts.retryBaseMs });
    },
  };
}
