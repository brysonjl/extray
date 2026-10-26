// Node fs implementation of the SourceReader seam (app.ts). Constrained twice:
// the source_dir recorded in the DB must sit under an allowlisted analysis-tree
// root (never arbitrary repo files — the repo also holds reports and secrets),
// and the joined file path must resolve inside that tree after symlink
// resolution. Anything else reads as "not available" (null), same as a missing
// file — the endpoint never distinguishes refusal from absence.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { SourceReader } from "./app.ts";

/** Trees an analysis may have recorded as source_dir. */
const ALLOWED_ROOTS = ["example_crxs", "corpus"];

/** Deminified bundles reach ~2MB; this is a backstop, not a normal-case limit.
 *  The endpoint slices to a line window, so the cap never reaches the wire. */
const MAX_SOURCE_BYTES = 10_000_000;

export function nodeSourceReader(repoRoot: string): SourceReader {
  return (sourceDir, relPath) => {
    try {
      if (!ALLOWED_ROOTS.some((r) => sourceDir === r || sourceDir.startsWith(`${r}/`))) return null;
      const rootReal = realpathSync(repoRoot);
      const dirReal = realpathSync(resolve(rootReal, sourceDir));
      if (!dirReal.startsWith(rootReal + sep)) return null;
      const fileReal = realpathSync(resolve(dirReal, relPath));
      if (!fileReal.startsWith(dirReal + sep)) return null;
      const st = statSync(fileReal);
      if (!st.isFile() || st.size > MAX_SOURCE_BYTES) return null;
      return readFileSync(fileReal, "utf8");
    } catch {
      return null;
    }
  };
}
