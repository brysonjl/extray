// The generic OpenAI-compatible adapter (W2.1). Same idiom as
// llm-ollama-cloud.test.ts: pure tests over the exported body/response helpers,
// plus client tests against an INJECTED fetchImpl so nothing touches a network.
// Every client test points at a deliberately NON-Ollama base URL, which is the
// verification criterion for W2.1.

import { describe, it, expect, vi } from "vitest";
import {
  buildCompletionsBody,
  createOpenAiCompatibleClient,
  normalizeBaseUrl,
  parseCompletionsResponse,
  resolveTimeoutMs,
  DEFAULT_TIMEOUT_MS,
} from "../src/llm/providers/openai-compatible.ts";
import type { LlmRequest } from "../src/llm/client.ts";

const BASE = "https://llm.internal.example/v1";

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  label: "monolith",
  model: "glm-5.2",
  prompt: "assess this extension",
  params: { temperature: 0 },
  ...over,
});

/** A fetchImpl that records its calls and replies with a canned completion. */
function stubFetch(reply: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL, requestInit: RequestInit) => {
    calls.push({ url: String(url), init: requestInit });
    return new Response(typeof reply === "string" ? reply : JSON.stringify(reply), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const completion = (content: string, usage?: Record<string, number>) => ({
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
  ...(usage ? { usage } : {}),
});

describe("buildCompletionsBody", () => {
  it("builds a non-streaming /chat/completions body with one user message", () => {
    const body = buildCompletionsBody(req());
    expect(body.model).toBe("glm-5.2");
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: "user", content: "assess this extension" }]);
    expect(body.temperature).toBe(0);
  });

  it("defaults temperature to 0 when not provided", () => {
    expect(buildCompletionsBody(req({ params: undefined })).temperature).toBe(0);
  });

  it("renames the arms' Ollama-shaped num_predict onto max_tokens", () => {
    const body = buildCompletionsBody(req({ params: { num_predict: 4096 } }));
    expect(body.max_tokens).toBe(4096);
    expect("num_predict" in body).toBe(false);
  });

  it('maps format:"json" onto JSON mode and a schema object onto json_schema', () => {
    expect(buildCompletionsBody(req({ params: { format: "json" } })).response_format).toEqual({ type: "json_object" });
    const schema = { type: "object", properties: {} };
    expect(buildCompletionsBody(req({ params: { format: schema } })).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "response", schema },
    });
  });

  it("forwards the documented passthrough params verbatim", () => {
    const body = buildCompletionsBody(req({ params: { top_p: 0.9, seed: 7, stop: ["x"] } }));
    expect(body.top_p).toBe(0.9);
    expect(body.seed).toBe(7);
    expect(body.stop).toEqual(["x"]);
  });

  it("drops native-Ollama-only knobs SILENTLY (no /v1 equivalent) but warns on a genuinely unknown one", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const body = buildCompletionsBody(req({ params: { think: "high", num_ctx: 65536, run: 2 } }));
    expect("think" in body).toBe(false);
    expect("num_ctx" in body).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    buildCompletionsBody(req({ params: { mystery_knob: 1 } }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"mystery_knob"'));
    warn.mockRestore();
  });
});

describe("parseCompletionsResponse", () => {
  it("reads the first choice's content and the usage counts", () => {
    const res = parseCompletionsResponse(completion("verdict", { prompt_tokens: 120, completion_tokens: 9 }));
    expect(res.text).toBe("verdict");
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 9 });
  });

  it("estimates and MARKS inputTokens when the server omits usage (zeroing cost silently is worse)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = parseCompletionsResponse(completion("verdict"), 400);
    expect(res.usage.inputTokens).toBe(100); // ~4 chars/token
    expect(res.usage.inputTokensEstimated).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no usage.prompt_tokens"));
    warn.mockRestore();
  });

  it("treats an in-body error as DETERMINISTIC (retryable: false) rather than retrying it 3x", () => {
    let thrown: (Error & { retryable?: boolean }) | undefined;
    try {
      parseCompletionsResponse({ error: { message: "model not found" } });
    } catch (e) {
      thrown = e as Error & { retryable?: boolean };
    }
    expect(thrown?.message).toMatch(/model not found/);
    expect(thrown?.retryable).toBe(false);
  });

  it('warns when the completion was truncated (finish_reason "length")', () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    parseCompletionsResponse({ choices: [{ message: { content: "cut" }, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("truncated"));
    warn.mockRestore();
  });

  it("tolerates a response with no choices rather than throwing", () => {
    expect(parseCompletionsResponse({ usage: { prompt_tokens: 1, completion_tokens: 0 } }).text).toBe("");
  });
});

describe("createOpenAiCompatibleClient against a non-Ollama base URL", () => {
  it("POSTs to <baseUrl>/chat/completions with a bearer token", async () => {
    const { calls, fetchImpl } = stubFetch(completion("ok", { prompt_tokens: 5, completion_tokens: 1 }));
    const client = createOpenAiCompatibleClient({ baseUrl: BASE, apiKey: "secret", fetchImpl });
    const res = await client.complete(req());
    expect(res.text).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://llm.internal.example/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer secret");
  });

  it("sends NO Authorization header when there is no key, so a keyless local endpoint works", async () => {
    const { calls, fetchImpl } = stubFetch(completion("ok", { prompt_tokens: 1, completion_tokens: 1 }));
    const client = createOpenAiCompatibleClient({ baseUrl: "http://127.0.0.1:8000/v1", fetchImpl });
    await client.complete(req());
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("tolerates a base URL with a trailing slash", async () => {
    const { calls, fetchImpl } = stubFetch(completion("ok", { prompt_tokens: 1, completion_tokens: 1 }));
    await createOpenAiCompatibleClient({ baseUrl: `${BASE}/`, apiKey: "k", fetchImpl }).complete(req());
    expect(calls[0]!.url).toBe(`${BASE}/chat/completions`);
    expect(normalizeBaseUrl(`${BASE}//`)).toBe(BASE);
  });

  it("retries a 429 and then succeeds", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      return new Response(JSON.stringify(completion("ok", { prompt_tokens: 1, completion_tokens: 1 })), { status: 200 });
    }) as unknown as typeof fetch;
    const client = createOpenAiCompatibleClient({ baseUrl: BASE, apiKey: "k", fetchImpl, retries: 2, retryBaseMs: 0 });
    expect((await client.complete(req())).text).toBe("ok");
    expect(n).toBe(2);
  });

  it("does NOT retry a 400 (a deterministic failure), and names the endpoint in the error", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response("bad model", { status: 400, statusText: "Bad Request" });
    }) as unknown as typeof fetch;
    const client = createOpenAiCompatibleClient({ baseUrl: BASE, apiKey: "k", fetchImpl, retries: 2, retryBaseMs: 0 });
    await expect(client.complete(req())).rejects.toThrow(/400.*llm\.internal\.example/s);
    expect(n).toBe(1);
  });
});

describe("resolveTimeoutMs", () => {
  it("prefers an explicit option, then $LLM_TIMEOUT_MS, then the default", () => {
    expect(resolveTimeoutMs(1234)).toBe(1234);
    vi.stubEnv("LLM_TIMEOUT_MS", "4321");
    expect(resolveTimeoutMs()).toBe(4321);
    vi.unstubAllEnvs();
    expect(resolveTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
  });
});
