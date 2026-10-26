// The static report is the project's free/offline on-ramp (discovery B.3.1):
// no API key, no token spend, no network. That claim is only worth making if it
// is enforced, so this file tests the guarantee itself rather than the output —
// the import graph of the static path must not reach src/llm/, and running it
// end-to-end must not issue a single request.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { analyze } from "../src/pipeline/index.ts";
import { renderStaticReportHtml } from "../src/report/render-static-html.ts";

const ROOT = resolve(import.meta.dirname, "..");

/**
 * Every module reachable from `entries` through RUNTIME imports. `import type` /
 * `export type` statements are skipped: they are erased by the compiler, so a
 * type-only reference to a contract in another subsystem costs nothing at
 * runtime and must not fail this check.
 */
function runtimeImportGraph(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = entries.map((e) => resolve(ROOT, e));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(import|export)\s+([\s\S]*?)\bfrom\s*["']([^"']+)["']/g)) {
      if (/^type\s/.test(m[2]!)) continue; // `import type … from` — erased
      const spec = m[3]!;
      if (!spec.startsWith(".")) continue; // node: builtins and packages are checked separately
      queue.push(resolve(dirname(file), spec));
    }
  }
  return seen;
}

describe("static report: no LLM in the path", () => {
  // Both front doors onto the static path are guarded: the dir-only `analyze`
  // (src/cli.ts) and the unified `scan` verb (scripts/scan.ts), which also
  // accepts a store id / URL. `scan` is the one a stranger actually runs, so
  // leaving it out would guard the wrong entry point.
  const graph = runtimeImportGraph(["src/cli.ts", "scripts/scan.ts", "src/scan.ts", "src/report/render-static-html.ts"]);

  it("never reaches src/llm/ from either CLI or the static renderer", () => {
    const llm = [...graph].map((f) => relative(ROOT, f)).filter((f) => f.startsWith("src/llm/"));
    expect(llm).toEqual([]);
  });

  it("never names LlmClient anywhere in that graph", () => {
    const offenders = [...graph].filter((f) => /\bLlmClient\b/.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("pulls in no network-capable node builtin", () => {
    const offenders: string[] = [];
    for (const f of graph) {
      for (const m of readFileSync(f, "utf8").matchAll(/from\s*["'](node:(?:http|https|net|tls|dgram|dns)(?:\/[^"']*)?)["']/g)) {
        offenders.push(`${relative(ROOT, f)} → ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("static report: no network at runtime", () => {
  it("analyzes and renders an extension without a single fetch", () => {
    const real = globalThis.fetch;
    const calls: string[] = [];
    // Every outbound call in this codebase goes through global fetch (RDAP, the
    // store-listing scraper, every LLM provider), so counting fetches is a real
    // offline assertion, not a proxy for one.
    globalThis.fetch = (...args: Parameters<typeof fetch>) => {
      calls.push(String(args[0]));
      throw new Error("the static report path must not make network requests");
    };
    try {
      const pack = analyze("corpus/mutant-i-png-steganography/extension", { analyzedAt: "2026-01-01T00:00:00Z" });
      const html = renderStaticReportHtml(pack);
      expect(html).toContain("binary-asset-read-as-data");
    } finally {
      globalThis.fetch = real;
    }
    expect(calls).toEqual([]);
  });
});

describe("analyze --html", () => {
  it("writes a self-contained report with no API key present in the environment", () => {
    const out = mkdtempSync(join(tmpdir(), "static-report-"));
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
    // Prove the key is not what makes this work: strip every provider key.
    for (const k of Object.keys(env)) if (/API_KEY|LLM_ADAPTER/.test(k)) delete env[k];
    const stdout = execFileSync(
      "npx",
      ["tsx", "src/cli.ts", "corpus/mutant-i-png-steganography/extension", "--out", join(out, "pack.json"), "--html", join(out, "report.html")],
      { encoding: "utf8", env },
    );
    expect(stdout).toContain("static HTML report written to");
    const html = readFileSync(join(out, "report.html"), "utf8");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("img/icon_128x128.png");
    // The enrichment artifact sits beside the corpus extension dir and is read
    // from disk, never fetched.
    expect(html).toContain("Google LLC");
  });
});
