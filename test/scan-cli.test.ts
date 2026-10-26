// The `scan` verb: the no-key path, and the first command a stranger runs.
// Locked 2026-09-09 — it must accept all three inputs (unpacked --dir, a 32-char
// store id, a Chrome Web Store URL). Only the --dir form is exercised end-to-end
// here: the other two download a CRX, and the test suite is offline by contract
// (see the input-resolution tests below, which assert the network is NOT touched
// for anything that isn't a real id/URL).

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A settings path that never exists: the CLIs read .extray/settings.json at startup, and a developer's saved key must not turn a test into a live run. */
const NO_SETTINGS = join(tmpdir(), "extray-no-such-settings", "settings.json");

/** Run `scan` with a scrubbed env, proving no key and no .env are involved. */
function scan(args: string[]): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1", SKIP_DOTENV: "1", EXTRAY_SETTINGS_PATH: NO_SETTINGS };
  for (const k of Object.keys(env)) if (/API_KEY|BASE_URL|LLM_ADAPTER|EXTRAY_LLM/.test(k)) delete env[k];
  try {
    return { status: 0, stdout: execFileSync("npx", ["tsx", "scripts/scan.ts", ...args], { encoding: "utf8", env }), stderr: "" };
  } catch (e: any) {
    return { status: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

describe("scan --dir", () => {
  it("writes a pack and a self-contained HTML report with no key, no .env and no verdict", () => {
    const out = mkdtempSync(join(tmpdir(), "scan-"));
    const r = scan([
      "--dir",
      "corpus/mutant-i-png-steganography/extension",
      "--out",
      join(out, "pack.json"),
      "--html",
      join(out, "report.html"),
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("report.html");
    // The free path presents facts and signals, never a tier — that separation
    // is the product decision, so it is asserted rather than assumed.
    expect(r.stdout).toContain("no LLM ran, so there is no verdict");

    const html = readFileSync(join(out, "report.html"), "utf8");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("binary-asset-read-as-data");
    JSON.parse(readFileSync(join(out, "pack.json"), "utf8")); // a valid pack landed
  }, 60000);
});

describe("scan input resolution", () => {
  it("with no input at all, names all three accepted forms", () => {
    const r = scan([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--dir/);
    expect(r.stderr).toMatch(/32-char/);
    expect(r.stderr).toMatch(/URL/);
  }, 60000);

  it("tells you to use --dir when a directory is passed positionally, instead of trying to fetch it", () => {
    const r = scan(["corpus/mutant-a-exfil-fetch/extension"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/looks like a directory/);
    expect(r.stderr).toMatch(/--dir corpus\/mutant-a-exfil-fetch\/extension/);
    // Crucially: it never reported a fetch attempt.
    expect(r.stdout).not.toMatch(/fetching/);
  }, 60000);

  it("rejects a missing --dir before doing any work", () => {
    const r = scan(["--dir", "./no-such-extension-dir"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/does not exist/);
  }, 60000);

  it("refuses both an id and --dir at once rather than silently preferring one", () => {
    const r = scan(["ddkjiahejlhfcafbddmgiahcphecmpfh", "--dir", "corpus/base"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/not both/);
  }, 60000);
});
