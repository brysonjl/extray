import { afterEach, describe, expect, it, vi } from "vitest";
import { createOfflineFetchGuard, isLoopbackUrl, peekBlockedNetworkAttempts, takeBlockedNetworkAttempts } from "./setup-network.ts";
import { createOpenAiCompatibleClient } from "../src/llm/providers/openai-compatible.ts";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("global offline fetch guard", () => {
  it.each(["https://ollama.com/api/chat", "https://api.openai.com/v1/chat/completions"]) ("blocks ambient provider fetch %s before any I/O", (url) => {
    expect(() => fetch(url, { headers: { Authorization: "Bearer synthetic-key" }, body: "synthetic source", method: "POST" })).toThrow(/offline test suite/);
    expect(takeBlockedNetworkAttempts()).toEqual([url]);
  });
  it("still records an attempt if application code swallows the exception", () => {
    try { void fetch("https://provider.invalid/v1"); } catch { /* Intentional degraded-path probe. */ }
    expect(peekBlockedNetworkAttempts()).toEqual(["https://provider.invalid/v1"]);
    expect(takeBlockedNetworkAttempts()).toEqual(["https://provider.invalid/v1"]);
    expect(peekBlockedNetworkAttempts()).toEqual([]);
  });
  it("handles Request and URL inputs without leaking query, credentials, headers, or source", () => {
    for (const input of [new URL("https://user:synthetic-password@provider.invalid/v1?key=synthetic-query#token"), new Request("https://provider.invalid/v1?key=synthetic-query", { headers: { Authorization: "synthetic-header" } })]) {
      expect(() => fetch(input)).toThrow("real network fetch attempted (https://provider.invalid/v1)");
    }
    expect(takeBlockedNetworkAttempts()).toEqual(["https://provider.invalid/v1", "https://provider.invalid/v1"]);
  });
  it("keeps spyOn/stubGlobal fetch mocks usable and restores the guarded original", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("mock-spy"));
    expect(await (await fetch("https://provider.invalid/v1")).text()).toBe("mock-spy");
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("mock-global")));
    expect(await (await fetch("https://provider.invalid/v1")).text()).toBe("mock-global");
    vi.unstubAllGlobals();
    expect(peekBlockedNetworkAttempts()).toEqual([]);
    expect(() => fetch("https://provider.invalid/v1")).toThrow(/offline test suite/);
    expect(takeBlockedNetworkAttempts()).toHaveLength(1);
  });
  it("protects a provider's default fetch while its injected stub remains usable", async () => {
    const request = { label: "test", model: "synthetic-model", prompt: "synthetic source" };
    const client = createOpenAiCompatibleClient({ baseUrl: "https://provider.invalid/v1", apiKey: "synthetic-key", retries: 0 });
    await expect(client.complete(request)).rejects.toThrow(/offline test suite/);
    expect(takeBlockedNetworkAttempts()).toEqual(["https://provider.invalid/v1/chat/completions"]);
    const stub = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "stubbed" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })));
    const injected = createOpenAiCompatibleClient({ baseUrl: "https://provider.invalid/v1", apiKey: "synthetic-key", fetchImpl: stub });
    expect((await injected.complete(request)).text).toBe("stubbed");
    expect(peekBlockedNetworkAttempts()).toEqual([]);
  });
});

describe("loopback and redirect policy without opening a socket", () => {
  it.each(["http://127.0.0.1:1234", "http://127.1:1234", "http://127.9.8.7:1234", "http://localhost:1234", "http://localhost.:1234", "http://[::1]:1234"]) ("allows loopback URL %s", async (url) => {
    expect(isLoopbackUrl(new URL(url))).toBe(true);
    const transport = vi.fn().mockResolvedValue(new Response("local"));
    const guard = createOfflineFetchGuard(transport);
    expect(await (await guard.fetch(url)).text()).toBe("local");
    expect(transport).toHaveBeenCalledWith(url, { redirect: "error" });
    expect(guard.takeAttempts()).toEqual([]);
  });
  it.each(["https://localhost.provider.invalid", "https://127.0.0.1.provider.invalid", "http://192.168.1.1", "http://[::2]"]) ("never delegates non-loopback URL %s", (url) => {
    const transport = vi.fn();
    const guard = createOfflineFetchGuard(transport);
    expect(() => guard.fetch(url)).toThrow(/offline test suite/);
    expect(transport).not.toHaveBeenCalled();
    expect(guard.takeAttempts()).toEqual([url + "/"]);
  });
  it("overrides automatic follow and preserves explicit manual redirects and other request options", async () => {
    const transport = vi.fn().mockResolvedValue(new Response("local"));
    const guard = createOfflineFetchGuard(transport);
    const headers = { "x-synthetic": "value" };
    await guard.fetch("http://127.0.0.1/", { redirect: "follow", headers });
    expect(transport).toHaveBeenLastCalledWith("http://127.0.0.1/", { redirect: "error", headers });
    const request = new Request("http://127.0.0.1/", { redirect: "manual" });
    await guard.fetch(request);
    expect(transport).toHaveBeenLastCalledWith(request, { redirect: "manual" });
  });
  it("permits in-memory data/blob fetches without treating them as outbound attempts", async () => {
    const transport = vi.fn().mockResolvedValue(new Response("memory"));
    const guard = createOfflineFetchGuard(transport);
    for (const url of ["data:text/plain,synthetic", "blob:nodedata:synthetic"]) await guard.fetch(url);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(guard.takeAttempts()).toEqual([]);
  });
});
