// Security regressions for the "malicious web page -> code execution on a
// laptop running `npm run serve`" chain: DNS rebinding, CSRF, key exfiltration
// via settings, and pi's `!cmd` / `$VAR` config-value resolution.

import { describe, it, expect, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openDb } from "../src/db/index.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { createApp } from "../src/server/app.ts";
import { SettingsError, validateSettings, type ExplorerSettings } from "../src/product/settings.ts";
import { applySettingsApiKey, nodeSettingsStore } from "../src/server/settings-node.ts";
import { buildPiRegistry, PI_KEY_PLACEHOLDER, PI_PROVIDER_NAME } from "../src/methodologies/pi/runner.ts";
import { shouldWaitOnRateLimit } from "../scripts/explorer-capabilities.ts";
import { resolveProvider } from "../src/llm/provider.ts";

const SECRET = "sk-operator-secret";
const STORE_ID = "a".repeat(32);

const stored: ExplorerSettings = {
  methodology: "pi",
  model: "glm-5.2:cloud",
  provider: { id: "openai-compatible", baseUrl: "https://llm.internal.example/v1", apiKey: SECRET },
};

function boot(opts: { guard: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "extray-sec-"));
  const ds = new SqliteDataSource(openDb(join(dir, "t.sqlite")));
  const runSubmission = vi.fn();
  let settings = stored;
  const writes: ExplorerSettings[] = [];
  const app = createApp({
    ds,
    runSubmission,
    loopbackGuard: opts.guard ? {} : undefined,
    settings: {
      path: join(dir, "settings.json"),
      read: () => settings,
      write: (s) => {
        settings = s;
        writes.push(s);
      },
    },
  });
  return { app, runSubmission, current: () => settings };
}

const post = (app: ReturnType<typeof boot>["app"], init: { headers?: Record<string, string>; body?: string }) =>
  app.request("/api/submissions", { method: "POST", ...init, body: init.body ?? JSON.stringify({ input: STORE_ID }) });

describe("DNS rebinding: Host allowlist", () => {
  it("403s a foreign Host on every route when bound to loopback", async () => {
    const { app } = boot({ guard: true });
    for (const path of ["/api/meta", "/api/settings", "/api/catalog"]) {
      const res = await app.request(path, { headers: { host: "evil.example:8788" } });
      expect(res.status, path).toBe(403);
    }
  });

  it.each(["127.0.0.1:8788", "localhost", "localhost:8788", "[::1]:8788", "[::1]"])("accepts Host %s", async (host) => {
    const { app } = boot({ guard: true });
    const res = await app.request("/api/meta", { headers: { host } });
    expect(res.status).toBe(200);
  });

  it("is not applied when the guard is off (Cloudflare Worker)", async () => {
    const { app } = boot({ guard: false });
    const res = await app.request("/api/meta", { headers: { host: "extray.example.com" } });
    expect(res.status).toBe(200);
  });
});

describe("CSRF on state-changing routes", () => {
  it("rejects a text/plain cross-site POST and never starts the runner", async () => {
    const { app, runSubmission } = boot({ guard: true });
    const res = await post(app, { headers: { "content-type": "text/plain", origin: "https://evil.example" } });
    expect(res.status).toBe(415);
    expect(runSubmission).not.toHaveBeenCalled();
  });

  it("rejects a JSON POST from a foreign Origin", async () => {
    const { app, runSubmission } = boot({ guard: true });
    const res = await post(app, { headers: { "content-type": "application/json", origin: "https://evil.example" } });
    expect(res.status).toBe(403);
    expect(runSubmission).not.toHaveBeenCalled();
  });

  it("rejects a bodyless/no-content-type PUT to settings", async () => {
    const { app, current } = boot({ guard: true });
    const res = await app.request("/api/settings", { method: "PUT", body: JSON.stringify({ model: "x" }) });
    expect(res.status).toBe(415);
    expect(current().model).toBe(stored.model);
  });

  it.each(["http://localhost:5173", "http://127.0.0.1:5173", "http://127.0.0.1:8788"])("allows Origin %s", async (origin) => {
    const { app, runSubmission } = boot({ guard: true });
    const res = await post(app, { headers: { "content-type": "application/json; charset=utf-8", origin } });
    expect(res.status).toBe(201);
    expect(runSubmission).toHaveBeenCalledTimes(1);
  });
});

describe("settings: key bound to its endpoint", () => {
  it("clears the stored key when baseUrl changes without a new key", () => {
    const next = validateSettings({ provider: { baseUrl: "https://evil.example/v1" } }, stored);
    expect(next.provider.apiKey).toBeUndefined();
  });

  it("clears the stored key when provider.id changes without a new key", () => {
    expect(validateSettings({ provider: { id: "openai" } }, stored).provider.apiKey).toBeUndefined();
  });

  it("keeps the key when neither endpoint field changes, or a new key arrives with the change", () => {
    expect(validateSettings({ model: "m" }, stored).provider.apiKey).toBe(SECRET);
    expect(validateSettings({ provider: { baseUrl: stored.provider.baseUrl } }, stored).provider.apiKey).toBe(SECRET);
    expect(validateSettings({ provider: { baseUrl: "https://b.example/v1", apiKey: "new" } }, stored).provider.apiKey).toBe("new");
  });

  it("clears the key through the HTTP route too", async () => {
    const { app, current } = boot({ guard: true });
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: { baseUrl: "https://evil.example/v1" } }),
    });
    expect(res.status).toBe(200);
    expect(current().provider.apiKey).toBeUndefined();
  });

  it.each(["!touch /tmp/x", "$HOME", "pre${HOME}", "a$b"])("rejects dangerous key %j", (key) => {
    expect(() => validateSettings({ provider: { apiKey: key } }, stored)).toThrow(SettingsError);
  });
});

describe("applySettingsApiKey", () => {
  const ollama: ExplorerSettings = { ...stored, provider: { id: "ollama", apiKey: SECRET } };
  const nvidia: ExplorerSettings = { ...stored, provider: { id: "nvidia", apiKey: SECRET } };

  it("sets the settings provider's own variable, never the cross-provider override", () => {
    const env: NodeJS.ProcessEnv = {};
    applySettingsApiKey(ollama, env);
    expect(env.OLLAMA_API_KEY).toBe(SECRET);
    expect(env.EXTRAY_LLM_API_KEY).toBeUndefined();
  });

  it("does not send an Ollama key to OpenAI under --provider openai", () => {
    const env: NodeJS.ProcessEnv = {};
    applySettingsApiKey(ollama, env, { provider: "openai" });
    expect(env).toEqual({});
  });

  it("withholds the key when the base URL in effect differs", () => {
    const env: NodeJS.ProcessEnv = {};
    applySettingsApiKey(stored, env, { baseUrl: "https://elsewhere.example/v1" });
    expect(env).toEqual({});
  });

  it("does not overwrite a key the user exported", () => {
    const env: NodeJS.ProcessEnv = { OLLAMA_API_KEY: "mine" };
    applySettingsApiKey(ollama, env);
    expect(env.OLLAMA_API_KEY).toBe("mine");
  });

  it("makes a saved NVIDIA key available through the shared provider resolver", () => {
    const env: NodeJS.ProcessEnv = {};
    applySettingsApiKey(nvidia, env, { provider: "nim", baseUrl: "https://integrate.api.nvidia.com/v1/" });
    expect(env).toEqual({ NVIDIA_API_KEY: SECRET });
    expect(resolveProvider({ provider: "nvidia" }, env).apiKey).toBe(SECRET);
  });

  it("does not overwrite an exported NVIDIA key", () => {
    const env: NodeJS.ProcessEnv = { NVIDIA_API_KEY: "existing" };
    applySettingsApiKey(nvidia, env);
    expect(env.NVIDIA_API_KEY).toBe("existing");
  });

  it.each([
    { provider: "openai" },
    { provider: "ollama" },
    { baseUrl: "https://elsewhere.example/v1" },
  ])("withholds a saved NVIDIA key when flags change its endpoint: %j", (flags) => {
    const env: NodeJS.ProcessEnv = {};
    applySettingsApiKey(nvidia, env, flags);
    expect(env).toEqual({});
  });

  it.each(["EXTRAY_LLM_BASE_URL", "NVIDIA_BASE_URL"])("withholds a saved NVIDIA key when %s redirects the endpoint", (variable) => {
    const env: NodeJS.ProcessEnv = { [variable]: "https://elsewhere.example/v1" };
    applySettingsApiKey(nvidia, env);
    expect(env.NVIDIA_API_KEY).toBeUndefined();
  });
});

describe("settings file hygiene", () => {
  it("writes 0600, tightens a pre-existing loose file, and leaves no temp file", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "extray-sec-")), ".extray");
    const path = join(dir, "settings.json");
    const store = nodeSettingsStore(path);
    store.write(stored);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    chmodSync(path, 0o644);
    store.write(stored);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
  });
});

describe("pi key handling", () => {
  it("hands registerProvider a placeholder under the fixed ExtRay name, not the key", async () => {
    const spy = vi.spyOn(ModelRuntime.prototype, "registerProvider");
    try {
      await buildPiRegistry({ provider: "ollama", baseUrl: "https://x.example/v1", apiKey: "!touch /tmp/x" }, "m");
      const [name, cfg] = spy.mock.calls[0]!;
      expect(name).toBe(PI_PROVIDER_NAME);
      expect(name).toBe("extray");
      expect((cfg as { apiKey: string }).apiKey).toBe(PI_KEY_PLACEHOLDER);
      expect(PI_KEY_PLACEHOLDER).not.toMatch(/^!|\$/);
    } finally {
      spy.mockRestore();
    }
  });

  it("delivers the real key as a literal (never executed) via the runtime override", async () => {
    const { modelRuntime, model } = await buildPiRegistry(
      { provider: "ollama", baseUrl: "https://x.example/v1", apiKey: "!echo pwned" },
      "m",
    );
    const r = await modelRuntime.getAuth(model);
    expect(r?.auth.apiKey).toBe("!echo pwned");
  });

  it("works for a keyless endpoint (empty key) with the placeholder", async () => {
    const { modelRuntime, model } = await buildPiRegistry({ provider: "openai-compatible", baseUrl: "http://localhost:8000/v1", apiKey: "" }, "m");
    const r = await modelRuntime.getAuth(model);
    expect(r?.auth.apiKey).toBe(PI_KEY_PLACEHOLDER);
  });
});

describe("rate-limit pacing is Ollama-only", () => {
  it("waits only for ollama with a key", () => {
    expect(shouldWaitOnRateLimit({ ...stored, provider: { id: "ollama", apiKey: "k" } }, {})).toBe(true);
    expect(shouldWaitOnRateLimit({ ...stored, provider: { id: "ollama" } }, {})).toBe(false);
    expect(shouldWaitOnRateLimit({ ...stored, provider: { id: "openai", apiKey: "k" } }, {})).toBe(false);
    expect(shouldWaitOnRateLimit(null, { OLLAMA_API_KEY: "k" })).toBe(true);
    expect(shouldWaitOnRateLimit(null, {})).toBe(false);
  });
});
