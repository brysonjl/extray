// W2.1: the provider seam. The point of these tests is that ONE set of knobs
// (--provider / --base-url / env) resolves the same endpoint for the LlmClient
// arms and for pi — pi used to hard-default to Ollama Cloud with no override.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createProviderClient,
  describeProvider,
  normalizeProviderId,
  ollamaNativeHost,
  ProviderConfigError,
  resolveApiKey,
  resolveProvider,
} from "../src/llm/provider.ts";
import { resolveConnection } from "../src/methodologies/pi/runner.ts";

/** An env with nothing provider-related in it, so a developer's shell can't leak in. */
const EMPTY: Record<string, string | undefined> = {};

describe("normalizeProviderId", () => {
  it("accepts the canonical ids and the documented aliases", () => {
    expect(normalizeProviderId("ollama")).toBe("ollama");
    expect(normalizeProviderId("ollama-cloud")).toBe("ollama");
    expect(normalizeProviderId("openai")).toBe("openai");
    expect(normalizeProviderId(" NVIDIA ")).toBe("nvidia");
    expect(normalizeProviderId("nim")).toBe("nvidia");
    expect(normalizeProviderId("nvidia-nim")).toBe("nvidia");
    expect(normalizeProviderId("openai-compatible")).toBe("openai-compatible");
    expect(normalizeProviderId("custom")).toBe("openai-compatible");
    expect(normalizeProviderId(" OpenAI ")).toBe("openai");
  });

  it("rejects an unknown provider by name, listing the valid ones", () => {
    expect(() => normalizeProviderId("anthropic")).toThrow(ProviderConfigError);
    expect(() => normalizeProviderId("anthropic")).toThrow(/anthropic.*openai-compatible/s);
  });
});

describe("resolveProvider precedence", () => {
  it("defaults to the Ollama Cloud preset on an empty env (the historical default)", () => {
    const p = resolveProvider({}, EMPTY);
    expect(p.id).toBe("ollama");
    expect(p.baseUrl).toBe("https://ollama.com/v1");
    expect(p.wire).toBe("ollama-native");
    expect(p.apiKey).toBeUndefined();
  });

  it("infers the preset from whichever credentials are present", () => {
    expect(resolveProvider({}, { OLLAMA_API_KEY: "k" }).id).toBe("ollama");
    expect(resolveProvider({}, { OPENAI_API_KEY: "k" }).id).toBe("openai");
    expect(resolveProvider({}, { NVIDIA_API_KEY: "k" }).id).toBe("nvidia");
    // A base URL means a custom endpoint even when an OPENAI key is also set.
    const custom = resolveProvider({}, { OPENAI_BASE_URL: "https://llm.internal.example/v1", OPENAI_API_KEY: "k" });
    expect(custom.id).toBe("openai-compatible");
    expect(custom.baseUrl).toBe("https://llm.internal.example/v1");
    expect(custom.apiKey).toBe("k");
  });

  it("lets an explicit flag beat the env, and the cross-provider env beat the preset env", () => {
    const env = { EXTRAY_LLM_PROVIDER: "openai", OPENAI_BASE_URL: "https://preset.example/v1", EXTRAY_LLM_BASE_URL: "https://override.example/v1" };
    // EXTRAY_LLM_BASE_URL wins over OPENAI_BASE_URL...
    expect(resolveProvider({}, env).baseUrl).toBe("https://override.example/v1");
    // ...and --base-url wins over both.
    expect(resolveProvider({ baseUrl: "https://flag.example/v1" }, env).baseUrl).toBe("https://flag.example/v1");
    // --provider wins over $EXTRAY_LLM_PROVIDER.
    expect(resolveProvider({ provider: "ollama" }, env).id).toBe("ollama");
  });

  it("prefers EXTRAY_LLM_API_KEY over the preset's own key var, and reports where each value came from", () => {
    const p = resolveProvider({}, { EXTRAY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "preset", EXTRAY_LLM_API_KEY: "override" });
    expect(p.apiKey).toBe("override");
    expect(p.origin).toEqual({ provider: "$EXTRAY_LLM_PROVIDER", baseUrl: "preset default", apiKey: "$EXTRAY_LLM_API_KEY" });
  });

  it("upgrades the pre-existing OLLAMA_HOST (a native host, no /v1) instead of ignoring it", () => {
    const p = resolveProvider({}, { OLLAMA_API_KEY: "k", OLLAMA_HOST: "https://ollama.internal/" });
    expect(p.baseUrl).toBe("https://ollama.internal/v1");
    expect(ollamaNativeHost(p.baseUrl)).toBe("https://ollama.internal");
  });

  it("strips a trailing slash from every resolved base URL", () => {
    expect(resolveProvider({ baseUrl: "https://x.example/v1/" }, EMPTY).baseUrl).toBe("https://x.example/v1");
  });

  it("refuses a custom endpoint with no base URL, naming the flag and both env vars", () => {
    expect(() => resolveProvider({ provider: "openai-compatible" }, EMPTY)).toThrow(ProviderConfigError);
    expect(() => resolveProvider({ provider: "custom" }, EMPTY)).toThrow(/--base-url.*EXTRAY_LLM_BASE_URL.*OPENAI_BASE_URL/s);
  });

  it("never puts the API key in the human-readable description", () => {
    const line = describeProvider(resolveProvider({}, { OPENAI_API_KEY: "sk-secret-value" }));
    expect(line).not.toContain("sk-secret-value");
    expect(line).toContain("https://api.openai.com/v1");
  });
});

describe("NVIDIA NIM preset", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses NVIDIA credentials and endpoint without borrowing another provider's key", () => {
    const p = resolveProvider({ provider: "nim" }, { NVIDIA_API_KEY: "nvapi-test", OPENAI_API_KEY: "openai-test" });
    expect(p).toMatchObject({
      id: "nvidia", label: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: "nvapi-test", wire: "openai-completions",
      origin: { provider: "--provider", baseUrl: "preset default", apiKey: "$NVIDIA_API_KEY" },
    });
    expect(describeProvider(p)).not.toContain("nvapi-test");
    const missingKey = resolveProvider({ provider: "nvidia" }, { OPENAI_API_KEY: "other-key" });
    expect(() => resolveApiKey(missingKey)).toThrow(/NVIDIA_API_KEY.*build\.nvidia\.com/);
  });

  it("preserves existing inference precedence and supports an explicit NVIDIA selection", () => {
    const env = { NVIDIA_API_KEY: "nvapi-test", OPENAI_API_KEY: "openai-test", OLLAMA_API_KEY: "ollama-test" };
    expect(resolveProvider({}, env).id).toBe("ollama");
    expect(resolveProvider({}, { ...env, OLLAMA_API_KEY: undefined }).id).toBe("openai");
    expect(resolveProvider({}, { ...env, EXTRAY_LLM_PROVIDER: "nvidia" }).apiKey).toBe("nvapi-test");
  });

  it("honors preset and explicit overrides while withholding the NVIDIA key from redirected URLs", () => {
    const env = { NVIDIA_API_KEY: "nvapi-test", NVIDIA_BASE_URL: "https://nim.example/v1/" };
    expect(resolveProvider({ provider: "nvidia" }, env)).toMatchObject({ baseUrl: "https://nim.example/v1", apiKey: "nvapi-test" });
    for (const p of [
      resolveProvider({ provider: "nvidia", baseUrl: "https://other.example/v1" }, env),
      resolveProvider({ provider: "nvidia" }, { ...env, EXTRAY_LLM_BASE_URL: "https://other.example/v1" }),
    ]) {
      expect(p.apiKey).toBeUndefined();
      expect(p.keyWithheld).toBe(true);
      expect(() => resolveApiKey(p)).toThrow(/NVIDIA_API_KEY.*not sent there/);
    }
    expect(resolveProvider({ provider: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1/" }, env).apiKey).toBe("nvapi-test");
    expect(resolveProvider({ provider: "nvidia" }, { ...env, EXTRAY_LLM_API_KEY: "override" }).apiKey).toBe("override");
    expect(resolveProvider({ provider: "nvidia", apiKey: "explicit" }, { ...env, EXTRAY_LLM_API_KEY: "override" }).apiKey).toBe("explicit");
  });

  it("sends a schema request through the real provider factory and parses NVIDIA-shaped usage", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 40, completion_tokens: 8 },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = createProviderClient(resolveProvider({ provider: "nvidia" }, { NVIDIA_API_KEY: "nvapi-test" }));
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const result = await client.complete({ label: "nvidia-schema", model: "nvidia/test-model", prompt: "Return JSON.", params: { format: schema, num_predict: 128 } });
    expect(result).toEqual({ text: '{"ok":true}', usage: { inputTokens: 40, outputTokens: 8 } });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer nvapi-test");
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "nvidia/test-model", max_tokens: 128, stream: false,
      response_format: { type: "json_schema", json_schema: { name: "response", schema } },
    });
  });
});

describe("preset env keys are bound to the preset's own endpoint", () => {
  it("does not send OLLAMA_API_KEY / OPENAI_API_KEY to a base URL overridden by flag or EXTRAY_LLM_BASE_URL", () => {
    const viaFlag = resolveProvider({ provider: "ollama", baseUrl: "https://evil.example/v1" }, { OLLAMA_API_KEY: "secret" });
    expect(viaFlag.apiKey).toBeUndefined();
    const viaEnv = resolveProvider({ provider: "openai" }, { OPENAI_API_KEY: "secret", EXTRAY_LLM_BASE_URL: "https://evil.example/v1" });
    expect(viaEnv.apiKey).toBeUndefined();
    expect(() => resolveApiKey(viaFlag)).toThrow(/EXTRAY_LLM_API_KEY/);
  });

  it("still sends it when the override is the preset's own default URL", () => {
    expect(resolveProvider({ provider: "ollama", baseUrl: "https://ollama.com/v1/" }, { OLLAMA_API_KEY: "secret" }).apiKey).toBe("secret");
  });

  it("sends an explicit key (argument or EXTRAY_LLM_API_KEY) to a custom base URL", () => {
    expect(resolveProvider({ provider: "ollama", baseUrl: "https://x.example/v1", apiKey: "a" }, {}).apiKey).toBe("a");
    expect(resolveProvider({ provider: "ollama", baseUrl: "https://x.example/v1" }, { EXTRAY_LLM_API_KEY: "b" }).apiKey).toBe("b");
  });
});

describe("resolveApiKey", () => {
  it("fails fast with guidance when a HOSTED preset has no key", () => {
    expect(() => resolveApiKey(resolveProvider({ provider: "ollama" }, EMPTY))).toThrow(/OLLAMA_API_KEY/);
    expect(() => resolveApiKey(resolveProvider({ provider: "openai" }, EMPTY))).toThrow(/OPENAI_API_KEY/);
  });

  it("allows a keyless CUSTOM endpoint — a local vLLM/LM Studio server needs no auth", () => {
    const p = resolveProvider({ provider: "openai-compatible", baseUrl: "http://127.0.0.1:8000/v1" }, EMPTY);
    expect(resolveApiKey(p)).toBe("");
  });
});

describe("pi honors the same provider knobs (locked 2026-09-09)", () => {
  // resolveConnection reads process.env by contract (it is called from inside an
  // arm, with no env to thread through), so clear the provider vars: a developer
  // who exports OLLAMA_API_KEY must not turn the fail-fast assertion green.
  beforeEach(() => {
    for (const name of ["EXTRAY_LLM_PROVIDER", "EXTRAY_LLM_BASE_URL", "EXTRAY_LLM_API_KEY", "OLLAMA_API_KEY", "OLLAMA_HOST", "OLLAMA_BASE_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "NVIDIA_API_KEY", "NVIDIA_BASE_URL"]) {
      vi.stubEnv(name, undefined as unknown as string);
    }
  });
  afterEach(() => vi.unstubAllEnvs());

  // pi's live session cannot be record/replayed by design, so the verifiable
  // claim is that its provider registry is handed the SAME endpoint the
  // LlmClient arms resolve from the same knobs.
  it("resolves a non-Ollama base URL + key from the pi connection options", () => {
    const conn = resolveConnection({ provider: "openai-compatible", baseUrl: "https://llm.internal.example/v1", apiKey: "k" });
    expect(conn).toEqual({ provider: "openai-compatible", baseUrl: "https://llm.internal.example/v1", apiKey: "k" });
  });

  it("agrees with the LlmClient resolution for the same inputs", () => {
    const overrides = { provider: "openai", apiKey: "k" };
    const client = resolveProvider(overrides, EMPTY);
    const pi = resolveConnection(overrides);
    expect(pi.baseUrl).toBe(client.baseUrl);
    expect(pi.provider).toBe(client.id);
  });

  it("still fails fast when a hosted preset has no key (pi is live-only)", () => {
    expect(() => resolveConnection({ provider: "ollama", apiKey: undefined })).toThrow(/OLLAMA_API_KEY|EXTRAY_LLM_API_KEY/);
  });

  it("resolves NVIDIA credentials identically for pi and the shared client", () => {
    vi.stubEnv("NVIDIA_API_KEY", "nvapi-test");
    const client = resolveProvider();
    expect(resolveConnection({})).toEqual({ provider: "nvidia", baseUrl: client.baseUrl, apiKey: client.apiKey });
  });
});
