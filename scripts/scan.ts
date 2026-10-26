#!/usr/bin/env -S npx tsx
// CLI: `scan` — the free, no-key path, and the first thing a stranger runs.
//
//   npm run scan -- --dir ./unpacked-extension
//   npm run scan -- <chrome-web-store-id>
//   npm run scan -- <chrome-web-store-detail-url>
//
// Fetching a CRX by id/URL uses the network; the
// ANALYSIS after unpacking needs no API key, no account, and no network — so the
// --dir form is fully offline, and the id/URL form touches the network exactly
// once, to download the extension.
//
// Output is a self-contained HTML report plus the evidence pack it was rendered
// from. No LLM runs on this path at any point: `scan` presents facts and signals,
// never a tier or a verdict. For an LLM verdict, run `npm run assess` (which
// defaults to the pi arm and does cost money).
//
// This file deliberately does NOT import ./_env.ts: the free path must work with
// no .env file at all, and there is nothing here for it to configure.

import { existsSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Command } from "commander";
import { HardError } from "../src/pipeline/index.ts";
import { EnrichmentLoadError } from "../src/enrichment/load.ts";
import { InvalidPackError, runStaticScan } from "../src/scan.ts";
import { fetchAndUnpack, FetchError } from "./fetch-crx.ts";

/** A misuse of the CLI (no input, conflicting inputs, bad path). */
class UsageError extends Error {}

const STORE_ID_RE = /^[a-p]{32}$/;

interface Options {
  dir?: string;
  out?: string;
  html?: string;
  crxOut: string;
  cache: string | false;
  force?: boolean;
}

/**
 * Resolve whichever of the three inputs was given into an unpacked directory.
 * `--dir` is offline; an id or a store URL is downloaded and unpacked first.
 * Anything that is neither a directory nor a recognizable id/URL is a usage
 * error rather than a fetch attempt, so a typo'd path does not hit the network.
 */
async function resolveInput(input: string | undefined, opts: Options): Promise<{ id: string; dir: string; fetched: boolean }> {
  if (opts.dir) {
    if (input) throw new UsageError("pass either <id-or-url> or --dir, not both");
    if (!existsSync(opts.dir)) throw new UsageError(`--dir ${opts.dir} does not exist`);
    return { id: basename(resolve(opts.dir)), dir: opts.dir, fetched: false };
  }
  if (!input) {
    throw new UsageError(
      "nothing to scan — pass --dir <unpacked-extension>, a 32-char Chrome Web Store id, or a Chrome Web Store URL",
    );
  }
  // A bare path passed positionally is a common slip; name it rather than
  // failing later with an id-extraction error.
  if (!STORE_ID_RE.test(input.trim()) && !/[a-p]{32}/.test(input) && existsSync(input)) {
    throw new UsageError(`"${input}" looks like a directory — pass it as --dir ${input}`);
  }
  process.stdout.write(`fetching ${input} from the Chrome Web Store …\n`);
  const fetched = await fetchAndUnpack(input, { out: opts.crxOut, keepCrx: false, force: opts.force ?? false });
  return { id: fetched.id, dir: fetched.destDir, fetched: true };
}

async function run(input: string | undefined, opts: Options): Promise<void> {
  const { id, dir, fetched } = await resolveInput(input, opts);

  // Default the artifact names off the extension id so scanning several in a row
  // does not silently overwrite the previous report.
  const outDir = ".out/scans";
  let out = opts.out;
  let html = opts.html;
  if (!out && !html) {
    mkdirSync(outDir, { recursive: true });
    out = join(outDir, `${id}.evidence-pack.json`);
    html = join(outDir, `${id}.html`);
  }

  const result = runStaticScan(dir, { out, html, cacheDir: opts.cache === false ? undefined : opts.cache });

  if (fetched) process.stdout.write(`unpacked to ${dir}\n`);
  for (const f of result.wrote) process.stdout.write(`wrote ${f}\n`);
  const signals = result.pack.summary_signals;
  process.stdout.write(
    `static signals: ${signals.high.length} high, ${signals.medium.length} medium, ${signals.low.length} low — ` +
      `no LLM ran, so there is no verdict. Open the HTML report to read the evidence.\n`,
  );
}

const program = new Command();
program
  .name("scan")
  .description("Static, free, no-key analysis of a Chrome extension → self-contained HTML report")
  .argument("[id-or-url]", "32-char Chrome Web Store id, or a Chrome Web Store detail URL (fetched over the network)")
  .option("--dir <path>", "scan an already-unpacked extension directory (fully offline)")
  .option("--out <file>", "evidence-pack path (default .out/scans/<id>.evidence-pack.json)")
  .option("--html <file>", "HTML report path (default .out/scans/<id>.html)")
  .option("--crx-out <dir>", "where a fetched CRX is unpacked (id/URL mode)", "example_crxs")
  .option("--cache <dir>", "Layer-3 static cache directory", ".cache")
  .option("--no-cache", "disable the Layer-3 static cache")
  .option("--force", "re-fetch even if already unpacked (id/URL mode)", false)
  .addHelpText(
    "after",
    "\nNo API key, no account, no LLM. --dir makes no network request at all; an id/URL\n" +
      "makes exactly one, to download the CRX. `npm run assess` adds an LLM verdict (and cost).\n" +
      "\nExit codes:\n  0  success\n  2  config/usage error (no input, bad path, fetch failure)\n" +
      "  3  static analysis failed or produced an invalid pack\n",
  )
  .action(async (input: string | undefined, opts: Options) => {
    try {
      await run(input, opts);
    } catch (e) {
      if (e instanceof InvalidPackError || e instanceof HardError) {
        process.stderr.write(`scan: ${e.message}\n`);
        process.exit(3);
      }
      if (e instanceof UsageError || e instanceof FetchError || e instanceof EnrichmentLoadError) {
        process.stderr.write(`scan: ${e.message}\n`);
        process.exit(2);
      }
      throw e;
    }
  });

program.parseAsync();
