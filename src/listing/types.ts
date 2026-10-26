// Store-listing artifact contract (improvement 008b). The fetcher
// (scripts/fetch-listing.ts) writes the artifact next to each unpacked
// extension; downstream consumers read it back through parseDeveloperListing.
// The artifact deliberately lives OUTSIDE the evidence pack: the static
// pipeline stays deterministic and offline, and the orchestrator merges this
// file in as a second developer block with provenance "store_listing" (see
// docs/reference/improvements/008b).
//
// Placement rule: the artifact is a SIBLING of the unpacked extension dir,
// never a file inside it. `example_crxs/<id>/` (and `corpus/<sample>/
// extension/`) IS the unpacked extension root — the static pipeline walks
// every file under it, so a developer-listing.json inside would be ingested
// as an extension file and contaminate analysis. listingPathFor is the single
// source of truth for the sibling mapping; listingCandidatePaths is what
// integrators use to find an artifact for a given extension dir.
//
// Same explicit-null convention as the pack schema: every field the listing
// did not state is null, never missing and never guessed — "no address" must
// be distinguishable from "we didn't look". `source: "unavailable"` is the
// design's explicit marker for a removed/unlisted extension, distinct from a
// live listing that simply omits fields.

import { dirname, join } from "node:path";

export class ListingError extends Error {}

/** Artifact basename used by the corpus layout (`corpus/<sample>/developer-listing.json`). */
export const LISTING_FILENAME = "developer-listing.json";

/**
 * Sibling artifact path for an unpacked extension dir:
 * `example_crxs/<id>` → `example_crxs/<id>.developer-listing.json`.
 * Never resolves to a path inside the extension dir.
 */
export function listingPathFor(extensionDir: string): string {
  return `${extensionDir.replace(/\/+$/, "")}.developer-listing.json`;
}

/**
 * Candidate artifact locations for an unpacked extension dir, in lookup order:
 *   1. the sibling-file form `<dir>.developer-listing.json` (what the
 *      fetch-listing CLI writes for `example_crxs/<id>/`), then
 *   2. the corpus-layout form `<parent>/developer-listing.json` (e.g.
 *      `corpus/<sample>/developer-listing.json` beside `extension/`).
 * Integrators merge the first candidate that exists.
 */
export function listingCandidatePaths(extensionDir: string): string[] {
  const dir = extensionDir.replace(/\/+$/, "");
  return [listingPathFor(dir), join(dirname(dir), LISTING_FILENAME)];
}

export interface DeveloperListing {
  extension_id: string;
  fetched_at: string; // ISO-8601
  source: "chrome-web-store" | "unavailable";
  developer: {
    name: string | null;
    address: string | null;
    email: string | null;
    website: string | null;
    is_trader: boolean | null;
  };
  /** Store listing description text (plain text), for claim-vs-behavior analysis. */
  description: string | null;
  /** Country derived from the address last line (heuristic over data file), never guessed. */
  country: string | null;
}

/** The explicit "listing unavailable" artifact (removed/unlisted extension). */
export function unavailableListing(extensionId: string, fetchedAt: string): DeveloperListing {
  return {
    extension_id: extensionId,
    fetched_at: fetchedAt,
    source: "unavailable",
    developer: { name: null, address: null, email: null, website: null, is_trader: null },
    description: null,
    country: null,
  };
}

function coerceString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function coerceBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/**
 * Validate + normalize a parsed developer-listing.json. Tolerant per-field
 * (unknown/missing optional fields coerce to null, same posture as the
 * findings coerce helpers) but fail-loud when the value is not a listing
 * artifact at all — the identity fields the fetcher always writes
 * (extension_id, fetched_at, a known source) are the gate.
 */
export function parseDeveloperListing(json: unknown): DeveloperListing {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new ListingError("developer listing must be a JSON object");
  }
  const o = json as Record<string, unknown>;

  if (typeof o.extension_id !== "string" || typeof o.fetched_at !== "string") {
    throw new ListingError("developer listing is missing extension_id/fetched_at — not a listing artifact");
  }
  if (o.source !== "chrome-web-store" && o.source !== "unavailable") {
    throw new ListingError(`developer listing has unknown source ${JSON.stringify(o.source)}`);
  }

  const rawDev =
    o.developer !== null && typeof o.developer === "object" && !Array.isArray(o.developer)
      ? (o.developer as Record<string, unknown>)
      : {};

  return {
    extension_id: o.extension_id,
    fetched_at: o.fetched_at,
    source: o.source,
    developer: {
      name: coerceString(rawDev.name),
      address: coerceString(rawDev.address),
      email: coerceString(rawDev.email),
      website: coerceString(rawDev.website),
      is_trader: coerceBool(rawDev.is_trader),
    },
    description: coerceString(o.description),
    country: coerceString(o.country),
  };
}
