#!/usr/bin/env -S npx tsx
// CLI: analyze <path-to-unpacked-extension> [--out evidence-pack.json] [--html report.html]
//
// The dir-only entry point, kept because `npm run analyze` predates the unified
// verbs and because it is the narrowest possible import graph for the offline
// guarantee (test/static-report-offline.test.ts). Strangers should use
// `npm run scan`, which is this plus store-id/URL input — see scripts/scan.ts.
//
// Exit 0 on success; 3 on hard failure (dir missing / manifest unreadable or
// unparseable) or on a pack that fails schema validation; 2 on a malformed
// enrichment artifact. (Same codes as `scan`.)
//
// --html is the free/offline on-ramp (discovery B.3.1): a self-contained static
// report from the same pack, with no API key, no token spend, and no network
// request. Nothing on this path may import src/llm/*.

import { Command } from "commander";
import { HardError } from "./pipeline/index.ts";
import { EnrichmentLoadError } from "./enrichment/load.ts";
import { InvalidPackError, runStaticScan } from "./scan.ts";

const program = new Command();
program
  .name("analyze")
  .description("Static analysis of an unpacked MV3 Chrome extension → evidence-pack.json")
  .argument("<path>", "path to the unpacked extension directory")
  .option("--out <file>", "output path", "evidence-pack.json")
  .option("--html <file>", "also write a self-contained static HTML report (no LLM, no network)")
  .option("--cache <dir>", "Layer-3 cache directory", ".cache")
  .option("--no-cache", "disable the Layer-3 cache")
  .action((path: string, opts: { out: string; html?: string; cache: string | false }) => {
    let result;
    try {
      result = runStaticScan(path, {
        out: opts.out,
        html: opts.html,
        cacheDir: opts.cache === false ? undefined : opts.cache,
      });
    } catch (e) {
      // Same codes as `scan` and `assess`: 3 = static analysis failed (hard
      // failure or an invalid pack), 2 = config/usage.
      if (e instanceof InvalidPackError || e instanceof HardError) {
        process.stderr.write(`analyze: ${e.message}\n`);
        process.exit(3);
      }
      if (e instanceof EnrichmentLoadError) {
        process.stderr.write(`analyze: ${e.message}\n`);
        process.exit(2);
      }
      throw e;
    }

    process.stdout.write(`evidence pack written to ${opts.out}\n`);
    if (result.htmlPath) {
      process.stdout.write(`static HTML report written to ${result.htmlPath}\n`);
    }
  });

program.parse();
