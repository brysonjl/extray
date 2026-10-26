// Explorer Settings (W3.5). The invariant worth a test suite: the provider API
// key is stored server-side and NEVER travels back to the browser. Everything
// else here is ordinary validation, but that one property is the reason the
// feature is a server-side file instead of localStorage.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import {
  DEFAULT_SETTINGS,
  parseSettingsFile,
  redactSettings,
  SettingsError,
  settingsAssessArgs,
  settingsEnv,
  serializeSettings,
  validateSettings,
  type ExplorerSettings,
} from "../src/product/settings.ts";
import { loadSettingsIfPresent, nodeSettingsStore } from "../src/server/settings-node.ts";
import { createApp } from "../src/server/app.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { openDb } from "../src/db/index.ts";
import type { AppEnv } from "../src/server/role.ts";

const SECRET = "sk-do-not-leak-me";

const withKey: ExplorerSettings = {
  methodology: "monolith",
  model: "glm-5.2:cloud",
  provider: { id: "openai-compatible", baseUrl: "https://llm.internal.example/v1", apiKey: SECRET },
};

describe("validateSettings", () => {
  it("merges a partial patch onto what is already stored", () => {
    const next = validateSettings({ model: "qwen3.5:cloud" }, withKey);
    expect(next.model).toBe("qwen3.5:cloud");
    expect(next.methodology).toBe("monolith");
    expect(next.provider.apiKey).toBe(SECRET);
  });

  it("accepts an untested model — the table warns, it never blocks", () => {
    expect(validateSettings({ model: "brand-new-model-nobody-measured" }).model).toBe("brand-new-model-nobody-measured");
  });

  it("rejects a methodology that is not a product arm", () => {
    expect(() => validateSettings({ methodology: "ground-truth" })).toThrow(SettingsError);
    expect(() => validateSettings({ methodology: "nonsense" })).toThrow(/unknown methodology/);
  });

  it("rejects a base URL that is not http(s), rather than failing mid-analysis", () => {
    expect(() => validateSettings({ provider: { baseUrl: "file:///etc/passwd" } })).toThrow(/must be http/);
    expect(() => validateSettings({ provider: { baseUrl: "not a url" } })).toThrow(/is not a URL/);
  });

  it("normalizes provider aliases through the same resolver the CLI uses", () => {
    expect(validateSettings({ provider: { id: "custom" } }).provider.id).toBe("openai-compatible");
    expect(validateSettings({ provider: { id: "ollama-cloud" } }).provider.id).toBe("ollama");
    expect(validateSettings({ provider: { id: "nim" } }).provider.id).toBe("nvidia");
    expect(validateSettings({ provider: { id: "nvidia-nim" } }).provider.id).toBe("nvidia");
    expect(() => validateSettings({ provider: { id: "anthropic" } })).toThrow(SettingsError);
  });

  it("clears the stored key on an explicitly empty value — un-setting must not need a text editor", () => {
    expect(validateSettings({ provider: { apiKey: "" } }, withKey).provider.apiKey).toBeUndefined();
    expect(validateSettings({ provider: { baseUrl: "" } }, withKey).provider.baseUrl).toBeUndefined();
  });

  it("rejects a non-object body", () => {
    expect(() => validateSettings("hello")).toThrow(SettingsError);
    expect(() => validateSettings([1, 2])).toThrow(SettingsError);
  });
});

describe("redactSettings", () => {
  it("never serializes the key, and says only whether one is set", () => {
    const pub = redactSettings(withKey, {});
    expect(JSON.stringify(pub)).not.toContain(SECRET);
    expect(pub.apiKeySet).toBe(true);
    expect(pub).not.toHaveProperty("provider.apiKey");
  });

  it("distinguishes 'no key here' from 'key comes from the environment'", () => {
    const noKey = { ...withKey, provider: { ...withKey.provider, apiKey: undefined } };
    expect(redactSettings(noKey, {}).apiKeyFromEnv).toBe(false);
    expect(redactSettings(noKey, { OLLAMA_API_KEY: "x" }).apiKeyFromEnv).toBe(true);
    // A stored key wins, so the UI does not claim the environment is in charge.
    expect(redactSettings(withKey, { OLLAMA_API_KEY: "x" }).apiKeyFromEnv).toBe(false);
  });

  it("carries the model advisory so the UI needs no second copy of the table", () => {
    expect(redactSettings({ ...withKey, model: "glm-5.2:cloud" }, {}).modelStatus).toBe("recommended");
    expect(redactSettings({ ...withKey, model: "minimax-m3:cloud" }, {}).modelStatus).toBe("caution");
    expect(redactSettings({ ...withKey, model: "who-knows" }, {}).modelStatus).toBe("untested");
  });

  it("advertises NVIDIA and recognizes its environment key without returning it", () => {
    const settings = validateSettings({ model: "nvidia/test-model", provider: { id: "nvidia" } });
    const pub = redactSettings(settings, { OLLAMA_API_KEY: "", OPENAI_API_KEY: "", NVIDIA_API_KEY: SECRET });
    expect(pub.choices.providers).toContain("nvidia");
    expect(pub.apiKeyFromEnv).toBe(true);
    expect(pub.apiKeySet).toBe(false);
    expect(JSON.stringify(pub)).not.toContain(SECRET);
    expect(settingsAssessArgs(settings)).toContain("nvidia");
  });
});

describe("settings → analysis", () => {
  it("turns settings into assess flags, with the key OFF the command line", () => {
    const args = settingsAssessArgs(withKey);
    expect(args).toEqual([
      "--methodology", "monolith",
      "--model", "glm-5.2:cloud",
      "--provider", "openai-compatible",
      "--base-url", "https://llm.internal.example/v1",
    ]);
    // argv is world-readable via `ps`; the key travels in the environment.
    expect(args.join(" ")).not.toContain(SECRET);
    expect(settingsEnv(withKey)).toEqual({ EXTRAY_LLM_API_KEY: SECRET });
  });
});

describe("nodeSettingsStore", () => {
  let path: string;
  beforeEach(() => {
    path = join(mkdtempSync(join(tmpdir(), "extray-settings-")), "settings.json");
  });

  it("round-trips, and writes the key 0600 because the file holds a secret", () => {
    const store = nodeSettingsStore(path);
    store.write(withKey);
    expect(store.read()).toEqual(withKey);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain(SECRET);
  });

  it("treats a missing file as first-run defaults, not an error", () => {
    expect(nodeSettingsStore(path).read()).toEqual(DEFAULT_SETTINGS);
    expect(loadSettingsIfPresent(path)).toBeNull();
  });

  it("survives a hand-mangled file rather than making the server unbootable", () => {
    expect(parseSettingsFile("{ not json")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettingsFile('{"methodology":"nonsense"}')).toEqual(DEFAULT_SETTINGS);
  });
});

describe("settings API", () => {
  const boot = (withStore: boolean) => {
    const dir = mkdtempSync(join(tmpdir(), "extray-settings-api-"));
    const ds = new SqliteDataSource(openDb(join(dir, "db.sqlite")));
    const store = nodeSettingsStore(join(dir, "settings.json"));
    return {
      app: createApp({ ds, ...(withStore ? { settings: store } : {}) }) as Hono<AppEnv>,
      store,
    };
  };

  it("404s where the capability was not injected — the Worker has no settings", async () => {
    const { app } = boot(false);
    expect((await app.request("/api/settings", { headers: { "x-explorer-role": "admin" } })).status).toBe(404);
  });

  it("404s for a non-admin, even locally", async () => {
    const { app } = boot(true);
    expect((await app.request("/api/settings", { headers: { "x-explorer-role": "user" } })).status).toBe(404);
  });

  it("does not advertise the Settings view in /api/meta when it is unavailable", async () => {
    const admin = { headers: { "x-explorer-role": "admin" } };
    expect(await (await boot(false).app.request("/api/meta", admin)).json()).not.toHaveProperty("settings");
    expect(await (await boot(true).app.request("/api/meta", admin)).json()).toHaveProperty("settings", true);
  });

  it("stores a key and never returns it — not on write, not on read", async () => {
    const { app, store } = boot(true);
    const headers = { "x-explorer-role": "admin", "content-type": "application/json" };
    const put = await app.request("/api/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ model: "qwen3.5:cloud", provider: { id: "openai", apiKey: SECRET } }),
    });
    expect(put.status).toBe(200);
    expect(await put.text()).not.toContain(SECRET);

    const get = await app.request("/api/settings", { headers });
    expect(await get.text()).not.toContain(SECRET);
    expect(((await (await app.request("/api/settings", { headers })).json()) as { apiKeySet: boolean }).apiKeySet).toBe(true);
    // It really was persisted — the CLI reads this same file.
    expect(store.read().provider.apiKey).toBe(SECRET);
    expect(store.read().model).toBe("qwen3.5:cloud");
  });

  it("answers a bad value with 400 and the reason, not a 500", async () => {
    const { app } = boot(true);
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: { "x-explorer-role": "admin", "content-type": "application/json" },
      body: JSON.stringify({ methodology: "ground-truth" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/unknown methodology/);
  });
});


describe("advanced settings", () => {
  it("round-trips options without returning credentials", () => {
    const next = validateSettings({ options: { think: false, maxTokens: 8000, verifierModel: "verifier", useCache: false } }, withKey);
    expect(parseSettingsFile(serializeSettings(next))).toEqual(next);
    expect(redactSettings(next, {}).options).toEqual(next.options);
    expect(JSON.stringify(redactSettings(next, {}))).not.toContain(SECRET);
    expect(settingsAssessArgs(next)).toEqual(expect.arrayContaining(["--think", "false", "--max-tokens", "8000", "--verifier-model", "verifier", "--no-cache"]));
  });

  it("retains omitted options, replaces explicit options, and supports clearing invalid old combinations", () => {
    const current = { ...withKey, options: { think: "high" as const, maxTokens: 4000 } };
    expect(validateSettings({ model: "other" }, current).options).toEqual(current.options);
    expect(validateSettings({ options: { enrich: true } }, current).options).toEqual({ enrich: true });
    expect(validateSettings({ options: null }, current).options).toEqual({});
    expect(validateSettings({ options: { think: null } }, current).options).toEqual({});
    const invalid = { ...withKey, methodology: "pi", options: { replay: true, think: "high" as const } };
    expect(validateSettings({ options: null }, invalid).options).toEqual({});
    expect(validateSettings({ options: {} }, invalid).options).toEqual({});
  });

  it("clears arm-specific saved options when changing methodology", () => {
    const current = { ...withKey, options: { think: "high" as const, replay: true, maxTokens: 4000 } };
    expect(validateSettings({ methodology: "pi" }, current).options).toEqual({ maxTokens: 4000 });
    expect(() => validateSettings({ methodology: "pi", options: { replay: true } }, current)).toThrow(SettingsError);
  });

  it("rejects credentials hidden in otherwise public endpoint URLs", () => {
    for (const baseUrl of ["https://user:secret@example.com/v1", "https://example.com/v1?key=secret", "https://example.com/v1#secret"]) {
      expect(() => validateSettings({ provider: { baseUrl } }, withKey)).toThrow(/must not contain credentials/);
    }
  });
});
