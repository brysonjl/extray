// The static scan: evidence pack + optional self-contained HTML report from an
// unpacked extension directory. This is the free/offline on-ramp (discovery
// B.3.1) — no API key, no token spend, no network request — so NOTHING here may
// import src/llm/*. test/static-report-offline.test.ts asserts that from the
// import graph of every CLI that reaches this module.
//
// It lives apart from the CLIs because two of them need it: `scan`
// (scripts/scan.ts, which additionally accepts a store id / URL and fetches) and
// the older dir-only `analyze` (src/cli.ts). One implementation, two front doors.

import { writeFileSync } from "node:fs";
import { analyze } from "./pipeline/index.ts";
import { validatePack } from "./pipeline/schema.ts";
import { loadEnrichmentBeside } from "./enrichment/load.ts";
import { renderStaticReportHtml } from "./report/render-static-html.ts";
import type { EvidencePack } from "./pipeline/schema.ts";

/** A pack that failed its own schema — a bug in the pipeline, not in the input. */
export class InvalidPackError extends Error {
  constructor(readonly errors: string[]) {
    super(`produced an invalid evidence pack:\n${errors.map((x) => "  - " + x).join("\n")}`);
  }
}

export interface StaticScanOptions {
  /** Where to write the evidence pack. Omit to skip writing it. */
  out?: string;
  /** Where to write the self-contained HTML report. Omit to skip it. */
  html?: string;
  /** Layer-3 cache directory; undefined disables the cache. */
  cacheDir?: string;
  /** Pinned timestamp, for reproducible output. */
  analyzedAt?: string;
}

export interface StaticScanResult {
  pack: EvidencePack;
  /** Files written, in the order they were written. */
  wrote: string[];
  /** The HTML report path, when one was requested and written. */
  htmlPath?: string;
}

/**
 * Analyze an unpacked extension directory and write whichever artifacts were
 * asked for. Throws HardError (bad dir / unreadable manifest), InvalidPackError,
 * or EnrichmentLoadError; callers own the exit codes.
 */
export function runStaticScan(dir: string, opts: StaticScanOptions = {}): StaticScanResult {
  const pack = analyze(dir, { cacheDir: opts.cacheDir, ...(opts.analyzedAt ? { analyzedAt: opts.analyzedAt } : {}) });

  const { valid, errors } = validatePack(pack);
  if (!valid) throw new InvalidPackError(errors);

  const wrote: string[] = [];
  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify(pack, null, 2) + "\n");
    wrote.push(opts.out);
  }
  if (opts.html) {
    // Enrichment is read from a committed artifact beside the extension dir,
    // never fetched. A malformed artifact is a hard failure by the loader's
    // contract: a committed file that no longer parses must not silently vanish
    // from the report.
    const enrichment = loadEnrichmentBeside(dir);
    writeFileSync(opts.html, renderStaticReportHtml(pack, { enrichment }));
    wrote.push(opts.html);
  }
  return { pack, wrote, ...(opts.html ? { htmlPath: opts.html } : {}) };
}
