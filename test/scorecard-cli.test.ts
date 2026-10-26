import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("npx", ["tsx", "scripts/scorecard.ts", ...args], {
      encoding: "utf8",
      // SKIP_DOTENV + cleared LLM_ADAPTER so a developer's local .env can't change
      // these error-path assertions. The provider env vars are cleared for the
      // same reason: since W2.1, RECORD mode falls back from LLM_ADAPTER to the
      // provider presets, so an exported OLLAMA_API_KEY would make the
      // misconfiguration path succeed (and spend money).
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        SKIP_DOTENV: "1",
        // Never read a developer's saved Settings key (see assess-cli.test.ts).
        EXTRAY_SETTINGS_PATH: join(tmpdir(), "extray-no-such-settings", "settings.json"),
        LLM_ADAPTER: "",
        EXTRAY_LLM_PROVIDER: "",
        EXTRAY_LLM_BASE_URL: "",
        EXTRAY_LLM_API_KEY: "",
        OLLAMA_API_KEY: "",
        OLLAMA_HOST: "",
        OLLAMA_BASE_URL: "",
        OPENAI_API_KEY: "",
        OPENAI_BASE_URL: "",
        NVIDIA_API_KEY: "",
        NVIDIA_BASE_URL: "",
      },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { status: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

describe("scorecard CLI", () => {
  // This case runs the whole static corpus pass, so it is the expensive one in
  // this file; the untested-model assertion rides along on it rather than paying
  // for a second subprocess. Every other case below exits during option/provider
  // resolution, before any analysis.
  it("REPLAY with no committed fixtures exits non-zero with a loud fixture-miss message, and warns on the untested model", () => {
    // The fixtures dir holds only .gitkeep, so the first monolith call misses.
    const out = join(mkdtempSync(join(tmpdir(), "sc-")), "scorecard");
    const r = run(["--model", "no-such-model", "--out", out]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/fixture/i);
    // Model choice is a correctness variable (src/llm/model-table.ts).
    expect(r.stderr).toMatch(/UNTESTED/);
  }, 120000);

  it("RECORD with no adapter and no provider credentials exits non-zero, naming the key to set", () => {
    const out = join(mkdtempSync(join(tmpdir(), "sc-")), "scorecard");
    const r = run(["--record", "--out", out]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/OLLAMA_API_KEY|EXTRAY_LLM_API_KEY/);
  }, 60000);

  it("RECORD against a custom endpoint with no base URL is a config error, not a silent default", () => {
    const out = join(mkdtempSync(join(tmpdir(), "sc-")), "scorecard");
    const r = run(["--record", "--provider", "openai-compatible", "--out", out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--base-url/);
  }, 60000);

  it("RECORD with the NVIDIA preset and no key fails with NVIDIA setup guidance", () => {
    const out = join(mkdtempSync(join(tmpdir(), "sc-")), "scorecard");
    const r = run(["--record", "--provider", "nvidia", "--out", out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/NVIDIA_API_KEY/);
    expect(r.stderr).toContain("https://build.nvidia.com/");
  }, 60000);

  it("rejects an unknown provider by name instead of falling back", () => {
    const out = join(mkdtempSync(join(tmpdir(), "sc-")), "scorecard");
    const r = run(["--record", "--provider", "anthropic", "--out", out]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown provider "anthropic"/);
  }, 60000);
});
