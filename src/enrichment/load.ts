// Single loader for the committed host-enrichment artifact (015), used by every
// corpus entry point (scorecard grading, the reports CLI, the DAG/monolith arms)
// so the bytes the arms reason over and the bytes the report renders come from
// one source. Kept out of types.ts so that module stays fs-free — mirrors
// src/listing/load.ts exactly.

import { existsSync, readFileSync } from "node:fs";
import { enrichmentCandidatePaths, parseHostEnrichment, EnrichmentError, type HostEnrichment } from "./types.ts";

export class EnrichmentLoadError extends Error {}

/**
 * Load the host-enrichment artifact beside an unpacked extension dir, or null
 * when none exists. A present-but-malformed artifact is a hard error
 * (EnrichmentLoadError naming the path) rather than a silent null — a committed
 * artifact that no longer parses must fail loudly, not vanish from the report.
 */
export function loadEnrichmentBeside(extensionDir: string): HostEnrichment | null {
  const path = enrichmentCandidatePaths(extensionDir).find(existsSync);
  if (!path) return null;
  try {
    return parseHostEnrichment(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    if (e instanceof EnrichmentError || e instanceof SyntaxError) {
      throw new EnrichmentLoadError(`malformed host-enrichment artifact at ${path}: ${(e as Error).message}`);
    }
    throw e;
  }
}
