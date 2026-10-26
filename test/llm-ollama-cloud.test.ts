import { describe, it, expect, vi } from "vitest";
import {
  buildChatBody,
  parseChatResponse,
  parseRetryAfterMs,
  createOllamaCloudClient,
  DEFAULT_NUM_CTX,
  DEFAULT_TIMEOUT_MS,
  resolveTimeoutMs,
} from "../src/llm/providers/ollama-cloud.ts";
import type { LlmRequest } from "../src/llm/client.ts";

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  label: "monolith",
  model: "minimax-m3",
  prompt: "assess this extension",
  params: { temperature: 0 },
  ...over,
});

describe("ollama-cloud buildChatBody", () => {
  it("builds a non-streaming /api/chat body with the model and a user message", () => {
    const body = buildChatBody(req());
    expect(body.model).toBe("minimax-m3");
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: "user", content: "assess this extension" }]);
    expect((body.options as { temperature: number }).temperature).toBe(0);
  });

  it("defaults temperature to 0 when not provided", () => {
    const body = buildChatBody(req({ params: undefined }));
    expect((body.options as { temperature: number }).temperature).toBe(0);
  });

  it("omits `think` entirely when not set (keeps the no-think request/fixture identical)", () => {
    expect("think" in buildChatBody(req())).toBe(false);
    expect("think" in buildChatBody(req({ params: { temperature: 0 } }))).toBe(false);
  });

  it("forwards a boolean `think` toggle at the top level (not inside options)", () => {
    const body = buildChatBody(req({ params: { temperature: 0, think: true } }));
    expect(body.think).toBe(true);
    expect((body.options as Record<string, unknown>).think).toBeUndefined();
  });

  it("forwards a graded `think` level verbatim", () => {
    expect(buildChatBody(req({ params: { temperature: 0, think: "high" } })).think).toBe("high");
  });

  it("sets options.num_ctx to the default context window", () => {
    const body = buildChatBody(req());
    expect((body.options as { num_ctx: number }).num_ctx).toBe(DEFAULT_NUM_CTX);
  });

  it("honors an explicit numCtx argument and a per-request num_ctx param over it", () => {
    expect((buildChatBody(req(), 8192).options as { num_ctx: number }).num_ctx).toBe(8192);
    const body = buildChatBody(req({ params: { temperature: 0, num_ctx: 4096 } }), 8192);
    expect((body.options as { num_ctx: number }).num_ctx).toBe(4096);
  });

  it("honors the OLLAMA_NUM_CTX env var when no explicit numCtx is given", () => {
    process.env.OLLAMA_NUM_CTX = "16384";
    try {
      expect((buildChatBody(req()).options as { num_ctx: number }).num_ctx).toBe(16384);
    } finally {
      delete process.env.OLLAMA_NUM_CTX;
    }
  });

  it("resolves the per-attempt timeout: explicit option > OLLAMA_TIMEOUT_MS env > default", () => {
    // The default must cover a long single-extension assess call (the validated
    // large-extension monolith generation alone ran ~119s; 013's structured output is longer).
    expect(resolveTimeoutMs(undefined)).toBe(DEFAULT_TIMEOUT_MS);
    expect(resolveTimeoutMs(5_000)).toBe(5_000);
    process.env.OLLAMA_TIMEOUT_MS = "42000";
    try {
      expect(resolveTimeoutMs(undefined)).toBe(42_000);
      expect(resolveTimeoutMs(5_000)).toBe(5_000); // explicit option still wins
    } finally {
      delete process.env.OLLAMA_TIMEOUT_MS;
    }
  });

  it("forwards `format` at the top level (structured output)", () => {
    const schema = { type: "object", properties: { tier: { type: "string" } } };
    const body = buildChatBody(req({ params: { temperature: 0, format: schema } }));
    expect(body.format).toEqual(schema);
    expect((body.options as Record<string, unknown>).format).toBeUndefined();
  });

  it("maps known sampling params into options", () => {
    const body = buildChatBody(req({ params: { temperature: 0.2, top_p: 0.9, num_predict: 512, seed: 7 } }));
    const options = body.options as Record<string, unknown>;
    expect(options.temperature).toBe(0.2);
    expect(options.top_p).toBe(0.9);
    expect(options.num_predict).toBe(512);
    expect(options.seed).toBe(7);
  });

  it("warns on a genuinely unknown param but silently ignores the `run` fixture-key index", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const body = buildChatBody(req({ params: { temperature: 0, run: 2, frobnicate: true } }));
      expect("run" in body).toBe(false);
      expect("frobnicate" in body).toBe(false);
      expect((body.options as Record<string, unknown>).frobnicate).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/frobnicate/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("ollama-cloud parseRetryAfterMs", () => {
  it("parses delta-seconds and caps the result", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("9999")).toBe(30_000);
  });

  it("returns undefined for a missing or garbage header", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs("not a date")).toBeUndefined();
  });
});

describe("ollama-cloud parseChatResponse", () => {
  it("maps message content and token counts to text + usage", () => {
    const r = parseChatResponse({ message: { content: "hello" }, prompt_eval_count: 26, eval_count: 290, total_duration: 2_000_000 });
    expect(r.text).toBe("hello");
    expect(r.usage).toEqual({ inputTokens: 26, outputTokens: 290, wallClockMs: 2 });
  });

  it("throws on an API error field", () => {
    expect(() => parseChatResponse({ error: "model not found" })).toThrow(/model not found/);
  });

  it("tolerates missing token counts (defaults to 0 when the prompt size is unknown)", () => {
    const r = parseChatResponse({ message: { content: "x" } });
    expect(r.usage.inputTokens).toBe(0);
    expect(r.usage.outputTokens).toBe(0);
    expect(r.usage.inputTokensEstimated).toBeUndefined();
  });

  it("estimates inputTokens from the prompt size when prompt_eval_count is missing (minimax-m3 drops it)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A realistic monolith-sized prompt: ~84k chars → ceil(84_137 / 4) tokens.
      const r = parseChatResponse({ message: { content: "x" }, eval_count: 5 }, 84_137);
      expect(r.usage.inputTokens).toBe(Math.ceil(84_137 / 4));
      expect(r.usage.inputTokensEstimated).toBe(true);
      expect(r.usage.outputTokens).toBe(5);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/no prompt_eval_count/);
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT flag a provider-reported input count as estimated", () => {
    const r = parseChatResponse({ message: { content: "x" }, prompt_eval_count: 21_000, eval_count: 5 }, 84_137);
    expect(r.usage.inputTokens).toBe(21_000);
    expect(r.usage.inputTokensEstimated).toBeUndefined();
  });

  it("marks an in-body API error as NOT retryable", () => {
    let caught: unknown;
    try {
      parseChatResponse({ error: "model not found" });
    } catch (e) {
      caught = e;
    }
    expect((caught as { retryable?: boolean }).retryable).toBe(false);
  });

  it("warns when the output was truncated (done_reason length)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      parseChatResponse({ message: { content: "x" }, done_reason: "length", prompt_eval_count: 10, eval_count: 5 });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/done_reason="length"/);
    } finally {
      warn.mockRestore();
    }
  });

  it("warns when prompt_eval_count is suspiciously low for the prompt size (silent input truncation)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // 60_000 chars => expect >= ~10_000 tokens; 500 is way below.
      parseChatResponse({ message: { content: "x" }, prompt_eval_count: 500, eval_count: 5 }, 60_000);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/silently truncated/);
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT warn when prompt_eval_count is plausible for the prompt size", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // 60_000 chars / 6 = 10_000 minimum; 15_000 is plausible (~4 chars/token).
      parseChatResponse({ message: { content: "x" }, prompt_eval_count: 15_000, eval_count: 5 }, 60_000);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("ollama-cloud client (injected fetch, no network)", () => {
  it("POSTs to /api/chat with bearer auth and returns the parsed response", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = (init?.headers as Record<string, string>).authorization ?? "";
      return new Response(JSON.stringify({ message: { content: "ok" }, prompt_eval_count: 12, eval_count: 4 }), { status: 200 });
    }) as typeof fetch;
    const client = createOllamaCloudClient({ apiKey: "secret", fetchImpl });
    const res = await client.complete(req());
    expect(seenUrl).toBe("https://ollama.com/api/chat");
    expect(seenAuth).toBe("Bearer secret");
    expect(res.text).toBe("ok");
    expect(res.usage.outputTokens).toBe(4);
  });

  it("throws with status detail on a non-2xx response", async () => {
    const fetchImpl = (async () => new Response("bad request", { status: 400, statusText: "Bad Request" })) as typeof fetch;
    const client = createOllamaCloudClient({ apiKey: "secret", fetchImpl });
    await expect(client.complete(req())).rejects.toThrow(/400/);
  });

  it("throws a clear error when the API key is missing", async () => {
    const client = createOllamaCloudClient({ apiKey: "", fetchImpl: (async () => new Response("{}")) as typeof fetch });
    await expect(client.complete(req())).rejects.toThrow(/OLLAMA_API_KEY/);
  });

  it("retries a transient 5xx and then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls < 3) return new Response("upstream error", { status: 503, statusText: "Service Unavailable" });
      return new Response(JSON.stringify({ message: { content: "ok" }, eval_count: 1 }), { status: 200 });
    }) as typeof fetch;
    const client = createOllamaCloudClient({ apiKey: "secret", fetchImpl, retries: 2, retryBaseMs: 0 });
    const res = await client.complete(req());
    expect(res.text).toBe("ok");
    expect(calls).toBe(3);
  });

  it("retries a transient network/abort error and then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) throw new DOMException("This operation was aborted", "AbortError");
      return new Response(JSON.stringify({ message: { content: "ok" }, eval_count: 1 }), { status: 200 });
    }) as typeof fetch;
    const client = createOllamaCloudClient({ apiKey: "secret", fetchImpl, retries: 2, retryBaseMs: 0 });
    const res = await client.complete(req());
    expect(res.text).toBe("ok");
    expect(calls).toBe(2);
  });

  it("does NOT retry a deterministic 4xx (e.g. unknown model)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("model not found", { status: 404, statusText: "Not Found" });
    }) as typeof fetch;
    const client = createOllamaCloudClient({ apiKey: "secret", fetchImpl, retries: 2, retryBaseMs: 0 });
    await expect(client.complete(req())).rejects.toThrow(/404/);
    expect(calls).toBe(1);
  });

  it("retries a 429 rate limit and then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
      return new Response(JSON.stringify({ message: { content: "ok" }, eval_count: 1 }), { status: 200 });
    }) as typeof fetch;
    const client = createOllamaCloudClient({ apiKey: "secret", fetchImpl, retries: 2, retryBaseMs: 0 });
    const res = await client.complete(req());
    expect(res.text).toBe("ok");
    expect(calls).toBe(2);
  });

  it("honors a Retry-After header for the backoff delay instead of the base backoff", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) {
        return new Response("rate limited", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify({ message: { content: "ok" }, eval_count: 1 }), { status: 200 });
    }) as typeof fetch;
    // retryBaseMs is huge: if Retry-After (0s) were ignored, this test would
    // sleep 10s and blow well past the elapsed-time bound below.
    const client = createOllamaCloudClient({ apiKey: "secret", fetchImpl, retries: 2, retryBaseMs: 10_000 });
    const started = Date.now();
    const res = await client.complete(req());
    expect(res.text).toBe("ok");
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("does NOT retry a 200 response carrying an in-body API error", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response(JSON.stringify({ error: "model not found" }), { status: 200 });
    }) as typeof fetch;
    const client = createOllamaCloudClient({ apiKey: "secret", fetchImpl, retries: 2, retryBaseMs: 0 });
    await expect(client.complete(req())).rejects.toThrow(/model not found/);
    expect(calls).toBe(1);
  });

  it("sends options.num_ctx in the request body", async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ message: { content: "ok" }, eval_count: 1 }), { status: 200 });
    }) as typeof fetch;
    const client = createOllamaCloudClient({ apiKey: "secret", fetchImpl });
    await client.complete(req());
    expect((seenBody.options as { num_ctx: number }).num_ctx).toBe(DEFAULT_NUM_CTX);
  });

  it("honors the numCtx client option in the request body", async () => {
    let seenBody: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ message: { content: "ok" }, eval_count: 1 }), { status: 200 });
    }) as typeof fetch;
    const client = createOllamaCloudClient({ apiKey: "secret", fetchImpl, numCtx: 32_768 });
    await client.complete(req());
    expect((seenBody.options as { num_ctx: number }).num_ctx).toBe(32_768);
  });

  it("warns about likely silent truncation when prompt_eval_count is far below the prompt size", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const fetchImpl = (async () =>
        new Response(
          JSON.stringify({ message: { content: "ok" }, prompt_eval_count: 10, eval_count: 1 }),
          { status: 200 },
        )) as typeof fetch;
      const client = createOllamaCloudClient({ apiKey: "secret", fetchImpl });
      await client.complete(req({ prompt: "x".repeat(10_000) }));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/silently truncated/);
    } finally {
      warn.mockRestore();
    }
  });
});
