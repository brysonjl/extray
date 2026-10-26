// R2 implementation of the SourceReader seam (app.ts) for the Cloudflare
// deployment. Objects are keyed exactly as the local fs contract:
// `<source_dir>/<relPath>` (source_dir from the DB, e.g. "example_crxs/<id>"),
// so the endpoint and DB rows need no changes — scripts/upload-source-r2.ts
// populates the bucket with the evidence-referenced files under those keys.
//
// Same posture as source-node.ts: allowlisted roots, size cap, and any
// failure reads as "not available" (null) — refusal is indistinguishable from
// absence. Containment needs no realpath here: object keys are opaque strings
// (no symlinks/`..` resolution in R2), and relPath was already validated by
// isSafeRelPath before the reader is consulted.
//
// Typed structurally against the documented R2 binding API — no global
// @cloudflare/workers-types pollution (same approach as datasource-d1.ts).

import type { SourceReader } from "./app.ts";

/** Mirrors source-node.ts ALLOWED_ROOTS: only analysis-tree keys are readable,
 *  even if the bucket ever holds anything else. */
const ALLOWED_ROOTS = ["example_crxs", "corpus"];

/** Mirrors source-node.ts MAX_SOURCE_BYTES. */
const MAX_SOURCE_BYTES = 10_000_000;

export interface R2ObjectBodyLike {
  size: number;
  text(): Promise<string>;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
}

export function r2SourceReader(bucket: R2BucketLike): SourceReader {
  return async (sourceDir, relPath) => {
    try {
      if (!ALLOWED_ROOTS.some((r) => sourceDir === r || sourceDir.startsWith(`${r}/`))) return null;
      if (sourceDir.includes("..") || sourceDir.includes("\0") || sourceDir.endsWith("/")) return null;
      const obj = await bucket.get(`${sourceDir}/${relPath}`);
      if (!obj || obj.size > MAX_SOURCE_BYTES) return null;
      return await obj.text();
    } catch {
      return null;
    }
  };
}
