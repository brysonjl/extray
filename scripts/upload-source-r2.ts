#!/usr/bin/env -S npx tsx
// Populate the ext-ray-source R2 bucket with the evidence-referenced source
// files the code viewer can actually request (deploy plan 2026-07-06-001,
// source-viewer follow-up). The UI only ever asks for paths cited in finding
// evidence refs, so this uploads exactly that subset — ~2k code files /
// ~550MB today, not the full 5.8GB of analyzed trees.
//
// Keys mirror the reader contract (src/server/source-r2.ts): "<source_dir>/
// <relPath>" with source_dir straight from the DB. Selection mirrors the
// product surface: findings on store-backed, non-corpus assess reports with a
// risk report. Filters mirror serving reality: safe relative paths, code
// extensions only, ≤10MB (the reader's cap — anything bigger 404s anyway).
//
// Uploads shell out to `wrangler r2 object put` (no extra credentials beyond
// `wrangler login`) with a small concurrency pool. A manifest in .out/
// records what was uploaded so re-runs only push new/changed files; --force
// re-uploads everything. At much larger scale, switch to rclone/S3 API.
//
//   npm run explorer:r2:upload -- --local            # wrangler dev simulator
//   npm run explorer:r2:upload -- --remote           # the real bucket
//   [--db .out/bakeoff.sqlite] [--bucket ext-ray-source] [--concurrency 6]
//   [--dry-run] [--force]

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { wranglerArgs } from "./_wrangler.ts";

const CODE_EXTENSIONS = new Set(["js", "mjs", "cjs", "ts", "json", "html", "htm", "css", "txt"]);
const MAX_SOURCE_BYTES = 10_000_000; // mirrors source-node.ts / source-r2.ts
const ALLOWED_ROOTS = ["example_crxs", "corpus"];

interface Args {
  db: string;
  bucket: string;
  mode: "--local" | "--remote" | null;
  concurrency: number;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    db: ".out/bakeoff.sqlite",
    bucket: "ext-ray-source",
    mode: null,
    concurrency: 6,
    dryRun: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") out.db = argv[++i] ?? out.db;
    else if (a === "--bucket") out.bucket = argv[++i] ?? out.bucket;
    else if (a === "--local" || a === "--remote") out.mode = a;
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]) || out.concurrency;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--force") out.force = true;
  }
  return out;
}

/** Same rules as app.ts isSafeRelPath — evidence paths are hostile input. */
function isSafeRelPath(p: string): boolean {
  if (!p || p.length > 512 || p.includes("\0") || p.includes("\\") || p.startsWith("/")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

function hasCodeExtension(p: string): boolean {
  const dot = p.lastIndexOf(".");
  return dot > 0 && CODE_EXTENSIONS.has(p.slice(dot + 1).toLowerCase());
}

/** Evidence-referenced (source_dir, file) pairs for product-visible reports. */
function evidenceKeys(db: DatabaseSync): Map<string, string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT t.source_dir AS dir, f.evidence_json AS ev
       FROM finding f
       JOIN report rep ON rep.id = f.report_id
       JOIN run r      ON r.id = rep.run_id
       JOIN target t   ON t.id = rep.target_id
       WHERE r.kind = 'assess' AND t.is_corpus = 0 AND t.store_id IS NOT NULL
         AND rep.risk_report_json IS NOT NULL AND rep.risk_report_json != ''
         AND t.source_dir IS NOT NULL AND t.source_dir != ''
         AND f.evidence_json IS NOT NULL AND f.evidence_json != ''`,
    )
    .all() as { dir: string; ev: string }[];

  const keyToLocalPath = new Map<string, string>();
  for (const { dir, ev } of rows) {
    if (!ALLOWED_ROOTS.some((r) => dir === r || dir.startsWith(`${r}/`))) continue;
    let refs: unknown;
    try {
      refs = JSON.parse(ev);
    } catch {
      continue;
    }
    if (!Array.isArray(refs)) continue;
    for (const ref of refs) {
      const file = (ref as { file?: unknown })?.file;
      if (typeof file !== "string" || !isSafeRelPath(file) || !hasCodeExtension(file)) continue;
      keyToLocalPath.set(`${dir}/${file}`, resolve(dir, file));
    }
  }
  return keyToLocalPath;
}

function put(bucket: string, key: string, file: string, mode: string): Promise<string | null> {
  return new Promise((res) => {
    const proc = spawn(
      "node_modules/.bin/wrangler",
      wranglerArgs(["r2", "object", "put", `${bucket}/${key}`, "--file", file, mode]),
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let err = "";
    proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
    proc.on("close", (code) => res(code === 0 ? null : err.trim().split("\n").slice(-3).join(" ")));
    proc.on("error", (e) => res(e.message));
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.mode && !args.dryRun) {
    console.error("Pass --local (wrangler dev simulator) or --remote (real bucket), or --dry-run.");
    process.exit(1);
  }
  // The same bucket name can belong to different accounts. Read an explicitly
  // selected config before consulting the cache, so a missing file cannot be
  // hidden by previously uploaded evidence. Never include credentials here.
  const configPath = process.env.EXTRAY_WRANGLER_CONFIG;
  const targetKey = configPath ? `-${createHash("sha256").update(JSON.stringify([
    resolve(configPath), readFileSync(configPath).toString("base64"), process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  ])).digest("hex")}` : "";
  const db = new DatabaseSync(args.db, { readOnly: true });
  const candidates = evidenceKeys(db);

  const manifestPath = `.out/r2-upload-manifest-${args.bucket}${args.mode === "--local" ? "-local" : ""}${targetKey}.json`;
  const manifest: Record<string, { size: number; mtimeMs: number }> =
    !args.force && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};

  const repoRoot = realpathSync(process.cwd());
  const toUpload: { key: string; path: string; size: number; mtimeMs: number }[] = [];
  const counts = { missing: 0, oversized: 0, unchanged: 0, escaped: 0 };

  for (const [key, path] of candidates) {
    let real: string;
    let st: ReturnType<typeof statSync>;
    try {
      real = realpathSync(path);
      st = statSync(real);
    } catch {
      counts.missing++;
      continue;
    }
    // Symlink containment, same posture as source-node.ts: the resolved file
    // must still live under the repo's analysis trees.
    if (!real.startsWith(repoRoot + sep) || !st.isFile()) {
      counts.escaped++;
      continue;
    }
    if (st.size > MAX_SOURCE_BYTES) {
      counts.oversized++;
      continue;
    }
    const prev = manifest[key];
    if (prev && prev.size === st.size && prev.mtimeMs === st.mtimeMs) {
      counts.unchanged++;
      continue;
    }
    toUpload.push({ key, path: real, size: st.size, mtimeMs: st.mtimeMs });
  }

  const totalMb = (toUpload.reduce((s, u) => s + u.size, 0) / 1024 / 1024).toFixed(1);
  console.log(
    `${candidates.size} evidence files → upload ${toUpload.length} (${totalMb}MB); ` +
      `skip: ${counts.unchanged} unchanged, ${counts.missing} missing, ${counts.oversized} oversized, ${counts.escaped} escaped`,
  );
  if (args.dryRun || toUpload.length === 0) return;

  // The local simulator is one SQLite file — parallel `wrangler r2 object put
  // --local` processes race it into SQLITE_BUSY failures. Serialize local;
  // remote talks to the real R2 API and takes the full pool.
  const concurrency = args.mode === "--local" ? 1 : args.concurrency;

  let done = 0;
  const failures: { key: string; error: string }[] = [];
  const queue = [...toUpload];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const error = await put(args.bucket, item.key, item.path, args.mode!);
        if (error) {
          failures.push({ key: item.key, error });
        } else {
          manifest[item.key] = { size: item.size, mtimeMs: item.mtimeMs };
        }
        done++;
        if (done % 100 === 0) console.log(`  ${done}/${toUpload.length}…`);
      }
    }),
  );

  writeFileSync(manifestPath, JSON.stringify(manifest));
  console.log(`Uploaded ${toUpload.length - failures.length}/${toUpload.length} (manifest: ${manifestPath})`);
  if (failures.length > 0) {
    for (const f of failures.slice(0, 10)) console.error(`  FAILED ${f.key}: ${f.error}`);
    if (failures.length > 10) console.error(`  … and ${failures.length - 10} more`);
    process.exit(1);
  }
}

void main();
