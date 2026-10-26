// Single loader for the committed developer-listing artifact (008b), used by
// BOTH corpus entry points (scorecard grading and the reports CLI) so the
// report a developer inspects and the report the scorecard grades are produced
// from identical inputs. Kept out of types.ts so that module stays fs-free.

import { existsSync, readFileSync } from "node:fs";
import { listingCandidatePaths, parseDeveloperListing, ListingError, type DeveloperListing } from "./types.ts";

export class ListingLoadError extends Error {}

/**
 * Load the developer-listing artifact beside an unpacked extension dir, or
 * null when none exists. A present-but-malformed artifact is a hard error
 * (ListingLoadError naming the path) rather than a silent null — a committed
 * artifact that no longer parses must fail loudly, not vanish from the report.
 */
export function loadListingBeside(extensionDir: string): DeveloperListing | null {
  const path = listingCandidatePaths(extensionDir).find(existsSync);
  if (!path) return null;
  try {
    return parseDeveloperListing(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    if (e instanceof ListingError || e instanceof SyntaxError) {
      throw new ListingLoadError(`malformed developer-listing artifact at ${path}: ${(e as Error).message}`);
    }
    throw e;
  }
}
