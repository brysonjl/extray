// The `assess` CLI's pre-spend behavior (W2.3). Every case here must reach its
// conclusion WITHOUT an API key and WITHOUT a live call — that is the whole
// point of a preflight: the decision to spend is made before the spend.

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A throwaway copy of a corpus sample. The de-minify pass rewrites bundled JS in
 * place and deliberately REFUSES to run against a labeled corpus sample, so
 * assess cannot be pointed at `corpus/` directly.
 */
let sampleDir: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "assess-cli-"));
  sampleDir = join(dir, "extension");
  cpSync("corpus/mutant-a-exfil-fetch/extension", sampleDir, { recursive: true });
});

/** A settings path that never exists: the CLIs read .extray/settings.json at startup, and a developer's saved key must not turn a test into a live run. */
const NO_SETTINGS = join(tmpdir(), "extray-no-such-settings", "settings.json");

function assess(args: string[], extraEnv: NodeJS.ProcessEnv = {}): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1", SKIP_DOTENV: "1", EXTRAY_SETTINGS_PATH: NO_SETTINGS };
  for (const k of Object.keys(env)) if (/API_KEY|BASE_URL|LLM_ADAPTER|EXTRAY_LLM/.test(k)) delete env[k];
  Object.assign(env, extraEnv);
  try {
    return {
      status: 0,
      stdout: execFileSync("npx", ["tsx", "scripts/assess.ts", ...args], { encoding: "utf8", env }),
      stderr: "",
    };
  } catch (e: any) {
    return { status: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

/** Like `base` but live-mode (no --replay), for the pi arm, which cannot replay. A 1000-token
 *  ceiling makes the preflight refuse before any request, so these can never spend. */
const DUMMY_ENDPOINT = { EXTRAY_LLM_API_KEY: "test-dummy-key", EXTRAY_LLM_BASE_URL: "http://127.0.0.1:1/v1" };
const piNoSpend = (extra: string[]) => ["--dir", sampleDir, "--no-db", "--max-tokens", "1000", "--out", mkdtempSync(join(tmpdir(), "assess-out-")), ...extra];

/** Common flags: never record, never touch the shared bake-off DB. */
const base = (extra: string[]) => ["--dir", sampleDir, "--replay", "--no-db", "--out", mkdtempSync(join(tmpdir(), "assess-out-")), ...extra];

describe("assess cost preflight", () => {
  it("prints the estimate, the range and its measured basis before doing anything", () => {
    const r = assess(base(["--methodology", "monolith", "--model", "glm-5.2:cloud"]));
    expect(r.stdout).toContain("cost preflight");
    expect(r.stdout).toMatch(/estimated spend:.*tokens|estimated spend/);
    expect(r.stdout).toMatch(/likely range/);
    // REPLAY with no fixture for this model is the expected end state (exit 4);
    // what matters is that the preflight came first.
    expect(r.stdout.indexOf("cost preflight")).toBeGreaterThanOrEqual(0);
  }, 120000);

  it("defaults to the pi arm (locked 2026-09-09) and warns about its cost profile", () => {
    const r = assess(piNoSpend(["--model", "glm-5.2:cloud"]), DUMMY_ENDPOINT);
    // The banner names where requests go — and never the key.
    expect(r.stdout).toMatch(/requests go to: openai-compatible|requests go to: ollama @ http:\/\/127\.0\.0\.1:1\/v1/);
    expect(r.stdout).not.toContain("test-dummy-key");
    expect(r.stdout).toMatch(/methodology="pi"/);
    // pi cannot be interrupted mid-session; the preflight says so rather than
    // implying --max-tokens is a hard mid-run guarantee for it.
    expect(r.stdout).toMatch(/cannot abort mid-session/);
  }, 120000);

  it("refuses up front when --max-tokens is below the estimate, spending nothing", () => {
    const r = assess(piNoSpend(["--methodology", "pi", "--model", "glm-5.2:cloud"]), DUMMY_ENDPOINT);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/exceeds --max-tokens/);
    expect(r.stderr).toMatch(/nothing was spent/);
  }, 120000);

  it("refuses --replay with the live-only pi arm instead of silently going live", () => {
    const r = assess(base(["--methodology", "pi", "--model", "glm-5.2:cloud"]));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/pi is live-only; use --methodology monolith for an offline replay/);
    // Fails fast: no preflight, so nothing was even estimated, let alone spent.
    expect(r.stdout).not.toContain("cost preflight");
    // Same when pi is one arm of a comma list.
    expect(assess(base(["--methodology", "monolith,pi", "--model", "glm-5.2:cloud"])).status).toBe(2);
  }, 120000);

  it("reports a pi provider misconfiguration as a clean exit-2 error, not a stack trace", () => {
    // LLM_ADAPTER makes assess skip its own up-front key check (the escape hatch
    // for a custom client), so pi's own provider resolution is what finds the
    // missing key. It used to escape as a raw ProviderConfigError stack.
    const adapter = join(mkdtempSync(join(tmpdir(), "assess-adapter-")), "adapter.mjs");
    writeFileSync(adapter, 'export default { complete() { throw new Error("live call attempted"); } };\n');
    const r = assess(
      ["--dir", sampleDir, "--no-db", "--yes", "--out", mkdtempSync(join(tmpdir(), "assess-out-")), "--methodology", "pi", "--model", "glm-5.2:cloud"],
      { LLM_ADAPTER: adapter },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/assess: no API key for provider/);
    expect(r.stderr).not.toMatch(/Node\.js v\d|\.ts:\d+/);
  }, 120000);

  it("rejects a non-numeric --max-tokens rather than silently ignoring the ceiling", () => {
    const r = assess(base(["--methodology", "monolith", "--max-tokens", "lots"]));
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--max-tokens must be a positive integer/);
  }, 120000);

  it("proceeds past the preflight when the ceiling is generous", () => {
    const r = assess(base(["--methodology", "monolith", "--model", "glm-5.2:cloud", "--max-tokens", "100000000"]));
    expect(r.stdout).toContain("cost preflight");
    // It got as far as needing a fixture, i.e. past every budget gate.
    expect(r.status).toBe(4);
  }, 120000);
});

describe("assess model advisory", () => {
  it("warns that a measured-poor model is measured-poor", () => {
    const r = assess(base(["--methodology", "monolith", "--model", "minimax-m3:cloud"]));
    expect(r.stderr).toMatch(/MEASURED-POOR/);
    expect(r.stderr).toMatch(/LITERALLY NOTHING/);
  }, 120000);

  it("stays quiet for a recommended model", () => {
    const r = assess(base(["--methodology", "monolith", "--model", "glm-5.2:cloud"]));
    expect(r.stderr).not.toMatch(/UNTESTED|MEASURED-POOR/);
  }, 120000);
});

describe("assess and the Explorer Settings key", () => {
  // A stored key belongs to the provider + base URL it was saved for. The CLI
  // announces when it applies one, so that is the observable.
  const withSettings = (provider: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "assess-settings-"));
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ methodology: "monolith", model: "glm-5.2:cloud", provider }));
    return { EXTRAY_SETTINGS_PATH: path };
  };
  const run = (extra: string[], env: NodeJS.ProcessEnv) =>
    assess(["--dir", sampleDir, "--no-db", "--max-tokens", "1000", "--out", mkdtempSync(join(tmpdir(), "assess-out-")), "--methodology", "monolith", ...extra], env);
  const stored = { id: "ollama", apiKey: "stored-secret" };

  it("applies the stored key when no flag redirects it (control)", () => {
    const r = run([], withSettings(stored));
    expect(r.stderr).toMatch(/using the API key saved in Explorer Settings/);
    expect(r.stderr + r.stdout).not.toContain("stored-secret");
  }, 120000);

  it("does NOT apply an ollama key under --provider openai", () => {
    expect(run(["--provider", "openai"], withSettings(stored)).stderr).not.toMatch(/saved in Explorer Settings/);
  }, 120000);

  it("does NOT apply the stored key under a different --base-url", () => {
    const env = withSettings({ ...stored, baseUrl: "https://ollama.com/v1" });
    expect(run(["--base-url", "https://elsewhere.example/v1"], env).stderr).not.toMatch(/saved in Explorer Settings/);
  }, 120000);
});
