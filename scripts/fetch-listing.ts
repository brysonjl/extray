#!/usr/bin/env -S npx tsx
// CLI: fetch a Chrome Web Store listing's developer/trader section and write
// it as a developer-listing artifact NEXT TO the unpacked extension
// (improvement 008b). Accepts either a bare 32-char extension ID or any Web
// Store detail URL, like fetch-crx.ts.
//
//   npm run fetch-listing -- <id-or-url...> [--out-dir <dir>] [--force]
//
// The artifact lands as a SIBLING of the unpacked dir, never inside it:
//
//   <out-dir>/<id>.developer-listing.json   (default example_crxs/<id>.developer-listing.json)
//
// `<out-dir>/<id>/` is the unpacked extension root — the static pipeline walks
// every file under it, so an artifact inside would be ingested as an extension
// file and contaminate analysis. listingPathFor() in src/listing/types.ts is
// the single source of truth for the mapping (corpus samples use the
// `corpus/<sample>/developer-listing.json` form; see listingCandidatePaths).
//
// The artifact is the fixture: repeat runs skip IDs whose artifact already
// exists (zero network requests) unless --force, mirroring the record/replay
// posture of the LLM fixtures — the deterministic pipeline only ever READS
// these files, it never fetches. A removed/unlisted extension (HTTP 404, or
// the store's empty-shell 200 page) still writes an artifact, with the
// design's explicit `source: "unavailable"` marker, so "listing gone" is
// distinguishable from "never fetched". Only transport-level failures
// (network down, 5xx) abort with a FetchError and exit code 2.
//
// Each item is fetched independently — one failure does not stop the rest —
// and a summary is printed when more than one item is processed.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { FetchError } from "./fetch-crx.ts";
import { parseListingHtml } from "../src/listing/parse-listing-html.ts";
import { listingPathFor, unavailableListing, type DeveloperListing } from "../src/listing/types.ts";

/** Pull the 32-char (a–p) extension ID out of a bare ID or a Web Store URL.
 *  (Copied from fetch-crx.ts, which keeps it private.) */
function extractId(input: string): string {
  const trimmed = input.trim();
  const matches = trimmed.match(/[a-p]{32}/g);
  if (matches && matches.length > 0) return matches[matches.length - 1]!;
  throw new FetchError(
    `could not find a 32-char extension ID in "${input}". ` +
      `Pass the ID directly or a chromewebstore.google.com/detail/.../<id> URL.`,
  );
}

function listingUrl(id: string): string {
  return `https://chromewebstore.google.com/detail/${id}`;
}

// A browser-shaped request: the store serves the full server-rendered page
// (incl. the DSA developer section) to ordinary browser requests; a bare
// default fetch UA risks a degraded or blocked response.
const REQUEST_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

interface Options {
  outDir: string;
  force: boolean;
}

export interface ListingFetchResult {
  id: string;
  artifactPath: string;
  listing: DeveloperListing | null; // null when skipped (existing artifact reused)
  skipped: boolean;
}

/**
 * Fetch + parse one listing and write the SIBLING artifact
 * <out-dir>/<id>.developer-listing.json (never a file inside <out-dir>/<id>/,
 * which is the unpacked extension root the pipeline ingests wholesale).
 * Reusable by other scripts; throws FetchError on transport failure only —
 * a missing/removed listing is a SUCCESSFUL fetch of the fact "unavailable".
 * `fetchImpl` is injectable so tests can exercise every path offline.
 */
export async function fetchListing(
  input: string,
  opts: Options,
  fetchImpl: typeof fetch = fetch,
): Promise<ListingFetchResult> {
  const id = extractId(input);
  const artifactPath = listingPathFor(join(opts.outDir, id));

  if (existsSync(artifactPath) && !opts.force) {
    process.stdout.write(`listing artifact already at ${artifactPath} (pass --force to re-fetch)\n`);
    return { id, artifactPath, listing: null, skipped: true };
  }

  process.stdout.write(`fetching listing for ${id} …\n`);
  const fetchedAt = new Date().toISOString();

  let res: Response;
  try {
    res = await fetchImpl(listingUrl(id), { redirect: "follow", headers: REQUEST_HEADERS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new FetchError(`network failure fetching listing for ${id}: ${msg}`);
  }

  let listing: DeveloperListing;
  if (res.status === 404 || res.status === 410) {
    // Listing removed/never existed — that is an answer, not an error.
    listing = unavailableListing(id, fetchedAt);
  } else if (!res.ok) {
    throw new FetchError(
      `listing fetch for ${id} failed: HTTP ${res.status} ${res.statusText}. ` +
        `Transient store/network trouble — retry later (artifact NOT written).`,
    );
  } else {
    const html = await res.text();
    // parseListingHtml also detects the store's empty-shell 200 page for
    // unknown IDs (og:url points at the store root) → source "unavailable".
    listing = parseListingHtml(html, id, fetchedAt);
  }

  mkdirSync(opts.outDir, { recursive: true });
  writeFileSync(artifactPath, JSON.stringify(listing, null, 2) + "\n");
  process.stdout.write(`wrote ${artifactPath} (source: ${listing.source})\n`);
  return { id, artifactPath, listing, skipped: false };
}

function cli(): void {
  const program = new Command();
  program
    .name("fetch-listing")
    .description("Fetch Chrome Web Store developer/trader listing data into <out-dir>/<id>.developer-listing.json")
    .argument("<id-or-url...>", "one or more extension IDs or Chrome Web Store detail URLs")
    .option("--out-dir <dir>", "directory holding the unpacked extensions (artifacts land beside <id>/)", "example_crxs")
    .option("--force", "re-fetch and overwrite an existing artifact", false)
    .action(async (inputs: string[], opts: Options) => {
      let ok = 0;
      let skipped = 0;
      const failures: string[] = [];
      for (const item of inputs) {
        try {
          const { skipped: wasSkipped } = await fetchListing(item, opts);
          if (wasSkipped) skipped++;
          else ok++;
        } catch (e) {
          if (e instanceof FetchError) {
            process.stderr.write(`fetch-listing: ${e.message}\n`);
            failures.push(item);
          } else {
            throw e;
          }
        }
      }

      if (inputs.length > 1) {
        process.stdout.write(`\ndone: ${ok} fetched, ${skipped} skipped, ${failures.length} failed\n`);
        if (failures.length > 0) process.stdout.write(`failed: ${failures.join(", ")}\n`);
      }
      if (failures.length > 0) process.exit(2);
    });

  program.parseAsync();
}

// Only run the CLI when invoked directly — importing this module must not
// trigger argument parsing against the importer.
if (import.meta.url === `file://${process.argv[1]}`) cli();
