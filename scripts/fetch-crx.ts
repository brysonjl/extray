#!/usr/bin/env -S npx tsx
// CLI: fetch + unpack a Chrome extension's CRX so it can be fed to `npm run
// analyze`. Accepts either a bare 32-char extension ID or any Chrome Web Store
// detail URL (old chrome.google.com or new chromewebstore.google.com).
//
//   npm run fetch-crx -- <id-or-url...> [--from-file <list>] [--out <dir>]
//                       [--keep-crx] [--force] [--prodversion <version>]
//
// Accepts any number of IDs/URLs as arguments and/or a --from-file list (one
// ID or URL per line; blank lines and #-comments ignored). Each item is fetched
// independently — one failure does not stop the rest — and a summary is printed
// when more than one item is processed.
//
// Downloads the CRX from Google's update endpoint, strips the CRX2/CRX3 header
// to recover the embedded ZIP, and unpacks it into <out>/<id>/. The unpacked
// directory is exactly what src/cli.ts expects as its <path> argument.
//
// Unpacking uses `fflate` (pure JS, no native/subprocess dependency) instead
// of shelling out to the system `unzip` binary.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { Command } from "commander";
import { unzipSync, type UnzipFileInfo } from "fflate";

// A recent stable Chrome version. Google's CRX endpoint rejects requests whose
// prodversion looks too old, so bump this occasionally if downloads start 204ing.
const PRODVERSION = "131.0.0.0";

export class FetchError extends Error {}

/** Pull the 32-char (a–p) extension ID out of a bare ID or a Web Store URL. */
function extractId(input: string): string {
  const trimmed = input.trim();
  // Web Store IDs are exactly 32 chars drawn from a–p. Match the last such run
  // so a slug that happens to contain such a run can't shadow the real ID.
  const matches = trimmed.match(/[a-p]{32}/g);
  if (matches && matches.length > 0) return matches[matches.length - 1]!;
  throw new FetchError(
    `could not find a 32-char extension ID in "${input}". ` +
      `Pass the ID directly or a chromewebstore.google.com/detail/.../<id> URL.`,
  );
}

function requestedProdversion(value: string | undefined): string {
  const version = value ?? PRODVERSION;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version) || version.trim() !== version) {
    throw new FetchError("--prodversion must contain four numeric components (for example 131.0.0.0)");
  }
  return version;
}

function crxDownloadUrl(id: string, prodversion: string): string {
  const x = `id=${id}&installsource=ondemand&uc`;
  return (
    "https://clients2.google.com/service/update2/crx" +
    "?response=redirect&acceptformat=crx2,crx3" +
    `&prodversion=${prodversion}` +
    `&x=${encodeURIComponent(x)}`
  );
}

/** Redirect URLs may contain signed query tokens; retain only public location. */
function safeFinalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}

async function downloadCrx(id: string, prodversion: string): Promise<{ crx: Buffer; provenance: CrxDownloadProvenance }> {
  const downloadUrl = crxDownloadUrl(id, prodversion);
  const fetchedAt = new Date().toISOString();
  const res = await fetch(downloadUrl, { redirect: "follow" });
  if (!res.ok) {
    throw new FetchError(
      `download failed for ${id}: HTTP ${res.status} ${res.statusText}. ` +
        `The extension may be unpublished, region-locked, or not a public Web Store item.`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new FetchError(`download for ${id} returned an empty body`);
  return {
    crx: buf,
    provenance: {
      requestedProdversion: prodversion,
      downloadUrl,
      finalUrl: safeFinalUrl(res.url),
      fetchedAt,
      downloadedAt: new Date().toISOString(),
      crxSha256: createHash("sha256").update(buf).digest("hex"),
      crxBytes: buf.length,
    },
  };
}

/**
 * Strip the CRX wrapper and return the embedded ZIP bytes.
 *   - "Cr24" magic → CRX2 (version 2) or CRX3 (version 3) header, then ZIP.
 *   - "PK"   magic → already a raw ZIP (some mirrors hand one back directly).
 */
function crxToZip(buf: Buffer): Buffer {
  if (buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4b) return buf; // "PK"

  if (buf.length < 16 || buf.toString("latin1", 0, 4) !== "Cr24") {
    throw new FetchError("downloaded bytes are neither a CRX (Cr24) nor a ZIP (PK) — refusing to unpack");
  }

  const version = buf.readUInt32LE(4);
  if (version === 2) {
    const pubKeyLen = buf.readUInt32LE(8);
    const sigLen = buf.readUInt32LE(12);
    const zipStart = 16 + pubKeyLen + sigLen;
    if (zipStart > buf.length) throw new FetchError("malformed CRX2 header (offsets exceed file size)");
    return buf.subarray(zipStart);
  }
  if (version === 3) {
    const headerLen = buf.readUInt32LE(8);
    const zipStart = 12 + headerLen;
    if (zipStart > buf.length) throw new FetchError("malformed CRX3 header (offsets exceed file size)");
    return buf.subarray(zipStart);
  }
  throw new FetchError(`unsupported CRX version ${version} (only 2 and 3 are known)`);
}

/** Exported so tests can exercise the Zip Slip guard directly against a hand-built ZIP. */
export function unzipInto(zip: Buffer, destDir: string): void {
  // The CRX is untrusted third-party content, so guard against Zip Slip:
  // reject any entry that would resolve outside destDir before a single byte
  // is decompressed or written.
  //
  // We do this as two passes over the same bytes. Pass 1 calls unzipSync with
  // a `filter` that always returns false — fflate still walks every entry in
  // the ZIP's central directory to hand each one to the filter (as real entry
  // metadata, not parsed CLI text), but returning false skips decompression
  // entirely, so we get every entry name for free without spending a cycle on
  // bytes we might end up refusing. Only once every name has been validated
  // does pass 2 run (no filter) to actually decompress and write.
  const zipBytes = new Uint8Array(zip.buffer, zip.byteOffset, zip.byteLength);

  let entryNames: string[];
  try {
    entryNames = [];
    unzipSync(zipBytes, {
      filter: (file: UnzipFileInfo) => {
        entryNames.push(file.name);
        return false;
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new FetchError(`could not read ZIP archive: ${msg}`);
  }
  assertSafeZipEntryNames(entryNames, destDir);

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new FetchError(`could not read ZIP archive: ${msg}`);
  }
  mkdirSync(destDir, { recursive: true });
  for (const [name, data] of Object.entries(entries)) {
    if (name.length === 0 || name.endsWith("/")) continue; // directory entries carry no bytes
    const target = resolve(destDir, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
}

/**
 * Reject the archive if any entry path would escape destDir (Zip Slip) — e.g.
 * "../../etc/x" — or is an absolute path — e.g. "/etc/x". Resolves each entry
 * name against destDir and confirms the result still lives under it.
 */
function assertSafeZipEntryNames(names: string[], destDir: string): void {
  const root = resolve(destDir);
  for (const rawName of names) {
    const name = rawName.replace(/\/+$/, ""); // drop the trailing slash on directory entries
    if (name.length === 0) continue;
    if (name.startsWith("/") || name.startsWith("\\")) {
      throw new FetchError(`refusing to unpack: ZIP entry uses an absolute path: ${rawName}`);
    }
    const target = resolve(destDir, name);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new FetchError(`refusing to unpack: ZIP entry escapes the destination (Zip Slip): ${rawName}`);
    }
  }
}

interface Options {
  out: string;
  keepCrx: boolean;
  force: boolean;
  prodversion?: string;
}

export interface CrxDownloadProvenance {
  requestedProdversion: string;
  /** Official request URL, including the requested Chrome target and store ID. */
  downloadUrl: string;
  /** Final response origin/path; credentials, query and fragment are excluded. */
  finalUrl: string | null;
  fetchedAt: string;
  /** Download body completion time, before unpacking. */
  downloadedAt: string;
  crxSha256: string;
  crxBytes: number;
}

export interface FetchResult {
  id: string;
  /** The unpacked extension directory (what analyze() consumes). */
  destDir: string;
  /** True when an existing unpack was reused instead of re-fetched. */
  skipped: boolean;
  /** Present only for a fresh download; an existing tree has unknown provenance. */
  provenance?: CrxDownloadProvenance;
}

/**
 * Fetch + unpack one extension into <out>/<id>/ and return where it landed.
 * Reusable by other scripts (e.g. assess.ts); throws FetchError on any failure.
 * Emits brief progress to stdout so callers get feedback for free.
 */
export async function fetchAndUnpack(input: string, opts: Options): Promise<FetchResult> {
  const prodversion = requestedProdversion(opts.prodversion);
  const id = extractId(input);
  const destDir = join(opts.out, id);

  if (existsSync(join(destDir, "manifest.json")) && !opts.force) {
    process.stdout.write(`already unpacked at ${destDir} (pass --force to re-fetch)\n`);
    return { id, destDir, skipped: true };
  }

  process.stdout.write(`fetching ${id} …\n`);
  const { crx, provenance } = await downloadCrx(id, prodversion);
  const zip = crxToZip(crx);
  unzipInto(zip, destDir);

  if (opts.keepCrx) {
    mkdirSync(opts.out, { recursive: true });
    writeFileSync(join(opts.out, `${id}.crx`), crx);
  }

  const note = existsSync(join(destDir, "manifest.json")) ? "" : "  (warning: no manifest.json found)";
  process.stdout.write(`unpacked ${id} → ${destDir}${note}\n`);
  return { id, destDir, skipped: false, provenance };
}

/** CLI wrapper: fetch + unpack one item. Returns "ok" or "skipped". */
async function run(input: string, opts: Options): Promise<"ok" | "skipped"> {
  const { skipped } = await fetchAndUnpack(input, opts);
  return skipped ? "skipped" : "ok";
}

/** Parse a list file: one ID/URL per line; blank lines and #-comments ignored. */
export function readListFile(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new FetchError(`could not read --from-file ${path}: ${msg}`);
  }
  return text
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0);
}

interface CliOptions extends Options {
  fromFile?: string;
}

function cli(): void {
  const program = new Command();
  program
  .name("fetch-crx")
  .description("Download + unpack one or more Chrome extension CRXs into <out>/<id>/ for analysis")
  .argument("[id-or-url...]", "one or more extension IDs or Chrome Web Store detail URLs")
  .option("--from-file <list>", "read additional IDs/URLs from a file (one per line; # comments ok)")
  .option("--out <dir>", "directory to unpack into (one subdir per extension)", "example_crxs")
  .option("--keep-crx", "also save the raw .crx alongside the unpacked dir", false)
  .option("--prodversion <version>", "Chrome target version (four numeric components)", PRODVERSION)
  .option("--force", "re-fetch and overwrite even if already unpacked", false)
  .action(async (inputs: string[], opts: CliOptions) => {
    const items = [...inputs];
    if (opts.fromFile) {
      try {
        items.push(...readListFile(opts.fromFile));
      } catch (e) {
        if (e instanceof FetchError) {
          process.stderr.write(`fetch-crx: ${e.message}\n`);
          process.exit(2);
        }
        throw e;
      }
    }

    if (items.length === 0) {
      process.stderr.write("fetch-crx: nothing to fetch — pass an ID/URL or --from-file <list>\n");
      process.exit(2);
    }

    let ok = 0;
    let skipped = 0;
    const failures: string[] = [];
    for (const item of items) {
      try {
        const status = await run(item, opts);
        if (status === "ok") ok++;
        else skipped++;
      } catch (e) {
        if (e instanceof FetchError) {
          process.stderr.write(`fetch-crx: ${e.message}\n`);
          failures.push(item);
        } else {
          throw e;
        }
      }
    }

    if (items.length > 1) {
      process.stdout.write(`\ndone: ${ok} fetched, ${skipped} skipped, ${failures.length} failed\n`);
      if (failures.length > 0) process.stdout.write(`failed: ${failures.join(", ")}\n`);
    }
    if (failures.length > 0) process.exit(1);
  });

  program.parseAsync();
}

// Only run the CLI when invoked directly — importing this module (e.g. assess.ts
// reusing fetchAndUnpack) must not trigger argument parsing against the importer.
if (import.meta.url === `file://${process.argv[1]}`) cli();
