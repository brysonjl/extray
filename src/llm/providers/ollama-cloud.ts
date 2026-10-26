// Ollama Cloud provider adapter for the LlmClient seam. This is the ONE place a
// concrete provider is wired; it is loaded on demand (via LLM_ADAPTER) only for
// RECORD runs, never imported by the scored REPLAY paths. Plug it in with:
//
//   OLLAMA_API_KEY=... LLM_ADAPTER=src/llm/providers/ollama-cloud.ts \
//     npm run scorecard -- --model minimax-m3 --record
//
// Cloud API (https://docs.ollama.com/cloud): POST https://ollama.com/api/chat
// with `Authorization: Bearer $OLLAMA_API_KEY` and {model, messages, stream:false}.
// The model id comes from --model (req.model), so swapping models needs no code
// change — pass the exact Ollama tag (e.g. minimax-m3, gpt-oss:120b).

import type { LlmClient, LlmRequest, LlmResponse } from "../client.ts";
import { checkContext } from "../context.ts";
import { isRetryableStatus, parseRetryAfterMs, withRetries, type RetryHints } from "../http-retry.ts";

// Re-exported: the retry policy moved to ../http-retry.ts when the second
// (OpenAI-compatible) adapter needed the identical rules, but this stays the
// documented import site for the native adapter.
export { parseRetryAfterMs };

export const DEFAULT_HOST = "https://ollama.com";

// Ollama defaults num_ctx to a small window (2-4k) and SILENTLY truncates any
// prompt beyond it. Monolith prompts already run ~21k input tokens, so the
// context window must be set explicitly. 64k is the default: comfortably above
// the largest current prompt and well within what minimax-m3-class cloud models
// support (their advertised windows are >= 128k); override with OLLAMA_NUM_CTX
// (or the numCtx option) for bigger packs or smaller models.
export const DEFAULT_NUM_CTX = 65_536;

type FetchImpl = typeof fetch;

export interface OllamaCloudOptions {
  apiKey?: string;
  host?: string;
  fetchImpl?: FetchImpl;
  /** Per-attempt timeout. Default: OLLAMA_TIMEOUT_MS env or DEFAULT_TIMEOUT_MS.
   *  A 266k-token assess prompt takes ~2+ min of generation; the default must
   *  cover it, and a single slow extension can be widened via env without code. */
  timeoutMs?: number;
  /** Retry attempts for transient failures (timeout/network/5xx/429/408). Default 2 (3 tries total). */
  retries?: number;
  /** Linear backoff base between retries, in ms. Default 500. */
  retryBaseMs?: number;
  /** Context window (options.num_ctx). Default: OLLAMA_NUM_CTX env or DEFAULT_NUM_CTX. */
  numCtx?: number;
  /** Verified deployment/model ceiling; the observed model ceiling still applies. */
  modelContextTokens?: number;
  /** Includes completion/reasoning tokens. Also sent as num_predict. */
  outputReserve?: number;
  /** Exact count including provider framing, when a matching tokenizer exists. */
  countInputTokens?: (req: LlmRequest) => number;
}

/** Resolve the context window: explicit option > OLLAMA_NUM_CTX env > default. */
function resolveNumCtx(numCtx?: number): number {
  if (typeof numCtx === "number" && numCtx > 0) return numCtx;
  const env = Number(process.env.OLLAMA_NUM_CTX);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_NUM_CTX;
}

// Per-attempt timeout. 120s was too tight: the validated large-extension monolith call took
// 118.8s of generation alone, and 013's structured-findings output is longer.
// An aborted attempt is retried (it looks transient), so a too-low timeout
// burns 3 × timeoutMs and then kills the run.
export const DEFAULT_TIMEOUT_MS = 600_000;

/** Resolve the per-attempt timeout: explicit option > OLLAMA_TIMEOUT_MS env > default. */
export function resolveTimeoutMs(timeoutMs?: number): number {
  if (typeof timeoutMs === "number" && timeoutMs > 0) return timeoutMs;
  const env = Number(process.env.OLLAMA_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_TIMEOUT_MS;
}

// Provider-neutral param names that map 1:1 into Ollama's `options` object
// (https://docs.ollama.com/api — Modelfile/runtime parameters). `temperature`
// and `num_ctx` are handled separately (both have defaults).
const OPTIONS_PARAMS = new Set([
  "top_p",
  "top_k",
  "min_p",
  "num_predict",
  "repeat_penalty",
  "seed",
  "stop",
]);

// Params that are intentionally NOT part of the request body and must be
// dropped without a warning. `run` is a fixture-key differentiator (it exists
// only so repeated calls with an identical prompt hash to distinct fixtures).
const SILENTLY_IGNORED_PARAMS = new Set(["run"]);

/** Native Ollama /api/chat request body (non-streaming). */
export function buildChatBody(req: LlmRequest, numCtx?: number): Record<string, unknown> {
  const params = req.params ?? {};
  const temperature = typeof params.temperature === "number" ? params.temperature : 0;
  // num_ctx may be overridden per-request via params; otherwise option/env/default.
  const ctx = typeof params.num_ctx === "number" ? params.num_ctx : resolveNumCtx(numCtx);
  const options: Record<string, unknown> = { temperature, num_ctx: ctx };
  const body: Record<string, unknown> = {
    model: req.model,
    messages: [{ role: "user", content: req.prompt }],
    stream: false,
    options,
  };
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (key === "temperature" || key === "num_ctx") continue; // handled above
    if (key === "think") {
      // Reasoning/effort knob. Ollama's /api/chat takes `think` at the TOP level
      // (not inside `options`): a boolean toggle, or a graded level
      // ("low"|"medium"|"high") on models that support it (e.g. gpt-oss).
      // Forwarded verbatim and only when the caller set it.
      body.think = value;
    } else if (key === "format") {
      // Structured output: `format` is a top-level /api/chat field ("json" or a
      // JSON schema object). Forwarded verbatim.
      body.format = value;
    } else if (OPTIONS_PARAMS.has(key)) {
      options[key] = value;
    } else if (!SILENTLY_IGNORED_PARAMS.has(key)) {
      // Unknown knob: warn rather than throw — the param still participates in
      // the fixture key, so dropping it must at least be visible.
      console.warn(`ollama-cloud: ignoring unknown param "${key}" (not forwarded to /api/chat)`);
    }
  }
  return body;
}

/**
 * Map a native /api/chat response to LlmResponse (token counts → usage).
 * `promptChars` (the serialized messages length) enables the silent-truncation
 * heuristic: Ollama drops prompt tokens beyond num_ctx without erroring, so a
 * prompt_eval_count far below chars/6 (English prose runs ~4 chars/token; /6 is
 * a deliberately loose bound to avoid false positives) means the model likely
 * never saw the whole prompt.
 */
export function parseChatResponse(json: unknown, promptChars?: number): LlmResponse {
  const j = json as Record<string, unknown>;
  if (j.error) {
    // A 200 body with an in-body error ("model not found", bad request shape…)
    // is deterministic — retrying it 3× with backoff just wastes a RECORD run.
    const err = new Error(`ollama-cloud: API error: ${String(j.error)}`);
    (err as { retryable?: boolean }).retryable = false;
    throw err;
  }
  const message = j.message as { content?: unknown } | undefined;
  const text = typeof message?.content === "string" ? message.content : "";
  let inputTokens = typeof j.prompt_eval_count === "number" ? j.prompt_eval_count : 0;
  const outputTokens = typeof j.eval_count === "number" ? j.eval_count : 0;
  // minimax-m3 omits prompt_eval_count on ~half its responses; coercing that to
  // 0 silently zeroes input-token accounting (and thus cost). Estimate from the
  // prompt size at the ~4 chars/token anchor above and mark it, so downstream
  // never mistakes the estimate for a provider-reported count.
  let inputTokensEstimated = false;
  if (typeof j.prompt_eval_count !== "number" && typeof promptChars === "number" && promptChars > 0) {
    inputTokens = Math.ceil(promptChars / 4);
    inputTokensEstimated = true;
    console.warn(
      `ollama-cloud: response carried no prompt_eval_count; estimating inputTokens=${inputTokens} ` +
        `from the ~${promptChars}-char prompt (~4 chars/token) — the count is approximate`,
    );
  }
  if (j.done_reason === "length") {
    console.warn(
      `ollama-cloud: response hit the output token limit (done_reason="length"); the completion is truncated`,
    );
  }
  if (typeof j.prompt_eval_count === "number" && typeof promptChars === "number" && promptChars > 0) {
    const roughMinTokens = Math.floor(promptChars / 6);
    if (j.prompt_eval_count < roughMinTokens) {
      console.warn(
        `ollama-cloud: prompt_eval_count=${j.prompt_eval_count} is suspiciously low for a ~${promptChars}-char prompt ` +
          `(expected >= ~${roughMinTokens} tokens); the prompt may have been silently truncated — check num_ctx`,
      );
    }
  }
  const usage: LlmResponse["usage"] = { inputTokens, outputTokens };
  if (inputTokensEstimated) usage.inputTokensEstimated = true;
  if (typeof j.total_duration === "number") usage.wallClockMs = Math.round(j.total_duration / 1e6);
  return { text, usage };
}

export function createOllamaCloudClient(opts: OllamaCloudOptions = {}): LlmClient {
  const apiKey = opts.apiKey ?? process.env.OLLAMA_API_KEY;
  const host = opts.host ?? process.env.OLLAMA_HOST ?? DEFAULT_HOST;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);

  // One attempt: timeout-guarded fetch + parse. Throws on a non-2xx; the caller
  // decides whether the failure is transient and worth a retry.
  async function attempt(req: LlmRequest): Promise<LlmResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const body = buildChatBody(req, opts.numCtx);
      const res = await doFetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const err: Error & RetryHints = new Error(
          `ollama-cloud: ${res.status} ${res.statusText} for model "${req.model}"${text ? `: ${text.slice(0, 300)}` : ""}`,
        );
        err.retryable = isRetryableStatus(res.status);
        // Honor a server-supplied Retry-After (429/503 commonly carry one).
        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
        if (retryAfterMs !== undefined) err.retryAfterMs = retryAfterMs;
        throw err;
      }
      return parseChatResponse(await res.json(), JSON.stringify(body.messages).length);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    complete(req: LlmRequest): Promise<LlmResponse> {
      if (!apiKey) {
        return Promise.reject(new Error("ollama-cloud: OLLAMA_API_KEY is not set (create one at ollama.com/settings/keys)"));
      }
      try {
        const body = buildChatBody(req, opts.numCtx);
        const options = body.options as Record<string, unknown>;
        const outputReserve = options.num_predict ?? opts.outputReserve ?? Math.min(32_768, Math.floor(Number(options.num_ctx) / 2));
        const context = checkContext({
          model: req.model, prompt: JSON.stringify(body.messages) + JSON.stringify(body.format ?? ""),
          contextTokens: Math.min(Number(options.num_ctx), opts.modelContextTokens ?? Infinity),
          outputReserve: Number(outputReserve), exactInputTokens: opts.countInputTokens?.(req),
        });
        if (!context.exact && context.inputTokens + context.outputReserve > context.contextTokens * 0.75) {
          console.warn(`ollama-cloud: context fit is uncertain (UTF-8 bytes/2 estimate ${context.inputTokens}, output reserve ${context.outputReserve}, context ${context.contextTokens}); no exact tokenizer configured`);
        }
        req = { ...req, params: { ...req.params, num_predict: outputReserve, num_ctx: context.contextTokens } };
      } catch (err) {
        return Promise.reject(err);
      }
      // A long RECORD run makes hundreds of calls against a flaky cloud API; a lone
      // timeout/network blip, 5xx, or rate-limit must not abort the whole run —
      // see ../http-retry.ts for the policy both adapters share.
      return withRetries(() => attempt(req), { retries: opts.retries, retryBaseMs: opts.retryBaseMs });
    },
  };
}

/** Default export: env-configured client, loaded via LLM_ADAPTER. */
export default createOllamaCloudClient();
