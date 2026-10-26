// The shared rate-limit signature (src/llm/rate-limit.ts): message sniffing
// plus the cause-chain walk assess's classifyError relies on for exit code 5 —
// the pi arm bypasses the LlmClient seam, so its 429s arrive as plain Errors.

import { describe, expect, it } from "vitest";
import { isRateLimitError, looksRateLimited } from "../src/llm/rate-limit.ts";

describe("isRateLimitError", () => {
  it("matches pi-shaped plain Errors carrying provider 429/quota wording", () => {
    expect(isRateLimitError(new Error("ollama-cloud: 429 Too Many Requests for model glm-5.2:cloud"))).toBe(true);
    expect(isRateLimitError(new Error("openai error: rate_limit_exceeded"))).toBe(true);
    expect(isRateLimitError(new Error("you have hit your usage limit for this session"))).toBe(true);
  });

  it("walks the cause chain", () => {
    const inner = new Error("HTTP 429 for https://ollama.com/v1/chat/completions");
    const outer = new Error("pi session failed", { cause: new Error("model call failed", { cause: inner }) });
    expect(isRateLimitError(outer)).toBe(true);
  });

  it("rejects ordinary failures and pathological chains", () => {
    expect(isRateLimitError(new Error("manifest.json is not valid JSON"))).toBe(false);
    expect(isRateLimitError(new Error("download failed: HTTP 404"))).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
    expect(isRateLimitError("plain string mentioning quota")).toBe(true);
    const loop = new Error("benign");
    loop.cause = loop; // self-referencing cause must not spin
    expect(isRateLimitError(loop)).toBe(false);
  });
});

describe("looksRateLimited", () => {
  it("stays in sync with the historical signatures", () => {
    expect(looksRateLimited("RESOURCE_EXHAUSTED: quota")).toBe(true);
    expect(looksRateLimited("out of credits")).toBe(true);
    expect(looksRateLimited(null)).toBe(false);
  });
});
