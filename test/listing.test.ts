// Store-listing fetcher tests (improvement 008b).
//
// Fixtures under test/fixtures/listing/:
//   - ublock-origin-lite.html — REAL page, fetched live 2026-06-12 from
//     https://chromewebstore.google.com/detail/ddkjiahejlhfcafbddmgiahcphecmpfh
//     and trimmed to the chunks the parser reads (head meta tags, Overview
//     section, Details section incl. the DSA developer/non-trader rows).
//     uBO Lite is a NON-trader listing: email present, no address/website.
//   - trader-synthetic.html — hand-crafted, markup structure copied verbatim
//     from the real Adblock Plus trader listing (same fetch date) with
//     synthetic developer values that exercise entity decoding and the
//     name/address/website/trader-true path.

import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseListingHtml } from "../src/listing/parse-listing-html.ts";
import {
  LISTING_FILENAME,
  ListingError,
  listingCandidatePaths,
  listingPathFor,
  parseDeveloperListing,
  unavailableListing,
} from "../src/listing/types.ts";
import { deriveCountry, isHighRiskCountry } from "../src/listing/country.ts";
import { fetchListing } from "../scripts/fetch-listing.ts";
import { FetchError } from "../scripts/fetch-crx.ts";
import { peekBlockedNetworkAttempts, takeBlockedNetworkAttempts } from "./setup-network.ts";

const UBO_ID = "ddkjiahejlhfcafbddmgiahcphecmpfh";
const TRADER_ID = "abcdefghijklmnopabcdefghijklmnop";
const FETCHED_AT = "2026-06-12T00:00:00.000Z";

function fixture(name: string): string {
  return readFileSync(`test/fixtures/listing/${name}`, "utf8");
}

// The global setup records and rejects ambient remote fetches, including
// swallowed failures. These tests retain their explicit guard regression.

describe("parseListingHtml — real non-trader listing (uBlock Origin Lite)", () => {
  const listing = parseListingHtml(fixture("ublock-origin-lite.html"), UBO_ID, FETCHED_AT);

  it("carries the identity fields through verbatim", () => {
    expect(listing.extension_id).toBe(UBO_ID);
    expect(listing.fetched_at).toBe(FETCHED_AT);
    expect(listing.source).toBe("chrome-web-store");
  });

  it("falls back to the Details 'Offered by' row for the developer name", () => {
    expect(listing.developer.name).toBe("Raymond Hill (gorhill)");
  });

  it("extracts the email from the DSA developer row", () => {
    expect(listing.developer.email).toBe("ubo@raymondhill.net");
  });

  it("reports explicit nulls for fields this listing does not state", () => {
    expect(listing.developer.address).toBeNull();
    expect(listing.developer.website).toBeNull();
    expect(listing.country).toBeNull();
  });

  it("reads is_trader=false from the DSA non-trader statement", () => {
    expect(listing.developer.is_trader).toBe(false);
  });

  it("extracts the full Overview description, entity-decoded", () => {
    expect(listing.description).not.toBeNull();
    expect(listing.description).toContain("An efficient content blocker.");
    expect(listing.description).toContain("uBO Lite (uBOL) is an efficient MV3-based content blocker.");
    // &#39; in the served HTML must come back as an apostrophe.
    expect(listing.description).toContain("uBlock Origin's built-in filter lists");
    expect(listing.description).not.toContain("&#39;");
    // Markup must be gone.
    expect(listing.description).not.toMatch(/<[a-z]+/i);
  });
});

describe("parseListingHtml — trader listing (synthetic, real ABP structure)", () => {
  const listing = parseListingHtml(fixture("trader-synthetic.html"), TRADER_ID, FETCHED_AT);

  it("extracts and entity-decodes the trader name", () => {
    expect(listing.developer.name).toBe("Müller & Söhne GmbH");
  });

  it("extracts the multi-line address (street / city / country lines)", () => {
    expect(listing.developer.address).toBe("Prinzenstr. 34\nBerlin 10969\nDE");
  });

  it("derives the country from the address last line", () => {
    expect(listing.country).toBe("DE");
  });

  it("extracts the website href, entity-decoded", () => {
    expect(listing.developer.website).toBe("https://example.com/?a=1&b=2");
  });

  it("extracts the email even when only present as a text node", () => {
    expect(listing.developer.email).toBe("support@example.com");
  });

  it("reads is_trader=true from the DSA trader statement", () => {
    expect(listing.developer.is_trader).toBe(true);
  });

  it("keeps the description's paragraphs and decodes numeric/hex entities", () => {
    expect(listing.description).toContain("Blocks things & saves time.");
    expect(listing.description).toContain("Müller & Söhne's blocker — second paragraph.");
  });
});

describe("parseListingHtml — degraded inputs", () => {
  it("yields all-null fields (never throws) on a stripped page that is still a listing", () => {
    const html =
      `<html><head><meta property="og:url" content="https://chromewebstore.google.com/detail/x/${TRADER_ID}">` +
      `</head><body><p>nothing of note</p></body></html>`;
    const listing = parseListingHtml(html, TRADER_ID, FETCHED_AT);
    expect(listing.source).toBe("chrome-web-store");
    expect(listing.developer).toEqual({ name: null, address: null, email: null, website: null, is_trader: null });
    expect(listing.description).toBeNull();
    expect(listing.country).toBeNull();
  });

  it("marks the store's empty-shell page (og:url at store root, no listing sections) unavailable", () => {
    const html =
      '<html><head><meta property="og:title" content="Chrome Web Store">' +
      '<meta property="og:url" content="https://chromewebstore.google.com/"></head><body></body></html>';
    const listing = parseListingHtml(html, TRADER_ID, FETCHED_AT);
    expect(listing).toEqual(unavailableListing(TRADER_ID, FETCHED_AT));
  });

  it("throws ListingError on empty input", () => {
    expect(() => parseListingHtml("", TRADER_ID, FETCHED_AT)).toThrow(ListingError);
    expect(() => parseListingHtml("   \n  ", TRADER_ID, FETCHED_AT)).toThrow(ListingError);
  });

  it("throws ListingError on non-HTML input", () => {
    expect(() => parseListingHtml("just some words, no markup", TRADER_ID, FETCHED_AT)).toThrow(ListingError);
    expect(() => parseListingHtml('{"json": true}', TRADER_ID, FETCHED_AT)).toThrow(ListingError);
  });
});

describe("deriveCountry — last-line heuristic", () => {
  it("maps full country names on the last line", () => {
    expect(deriveCountry("1 Main St\nSpringfield\nUnited States")).toBe("US");
    expect(deriveCountry("Seoul\nSouth Korea")).toBe("KR");
    expect(deriveCountry("Berlin\nGermany")).toBe("DE");
  });

  it("maps common variants and punctuation", () => {
    expect(deriveCountry("1 Main St\nUSA")).toBe("US");
    expect(deriveCountry("1 Main St\nU.S.A.")).toBe("US");
    expect(deriveCountry("London\nUnited Kingdom")).toBe("GB");
    expect(deriveCountry("Seoul\nRepublic of Korea")).toBe("KR");
  });

  it("passes through an uppercase alpha-2 last line", () => {
    expect(deriveCountry("Prinzenstr. 34\nBerlin 10969\nDE")).toBe("DE");
    expect(deriveCountry("Paris\nFR")).toBe("FR");
  });

  it("accepts an alpha-2 code as the last token of the last line", () => {
    expect(deriveCountry("Prinzenstr. 34, Berlin 10969 DE")).toBe("DE");
  });

  it("returns null when unrecognized — never guesses", () => {
    expect(deriveCountry("42 Nowhere Lane\nAtlantis")).toBeNull();
    expect(deriveCountry("Toronto, ON")).toBeNull(); // ON is not an ISO code
    expect(deriveCountry("")).toBeNull();
    expect(deriveCountry(null)).toBeNull();
  });

  it("does not mistake a US 'City, ST' suffix for a colliding ISO country code", () => {
    // CA=Canada, DE=Germany, IN=India, GA=Gabon as ISO — but here they are
    // California/Delaware/Indiana/Georgia. The comma-before-code US convention
    // suppresses the country guess rather than mis-resolving it.
    expect(deriveCountry("123 Main St, San Francisco, CA")).toBeNull();
    expect(deriveCountry("1 Tech Way, Wilmington, DE")).toBeNull();
    expect(deriveCountry("500 Office Rd, Atlanta, GA")).toBeNull();
    // The international postal-then-code form (no comma before the code) still resolves.
    expect(deriveCountry("Prinzenstr. 34 Berlin 10969 DE")).toBe("DE");
    // A standalone country-code line is unambiguous and still resolves.
    expect(deriveCountry("Prinzenstr. 34\nBerlin 10969\nDE")).toBe("DE");
  });
});

describe("isHighRiskCountry — policy data file", () => {
  it("flags listed codes (case-insensitively)", () => {
    expect(isHighRiskCountry("CN")).toBe(true);
    expect(isHighRiskCountry("ru")).toBe(true);
  });

  it("clears unlisted codes", () => {
    expect(isHighRiskCountry("US")).toBe(false);
    expect(isHighRiskCountry("DE")).toBe(false);
  });

  it("is null (unknown), not false, when the country is unknown", () => {
    expect(isHighRiskCountry(null)).toBeNull();
  });

  it("honors an injected policy list", () => {
    const data = { version: 1, note: "test", countries: ["AA"] };
    expect(isHighRiskCountry("AA", data)).toBe(true);
    expect(isHighRiskCountry("CN", data)).toBe(false);
  });
});

describe("parseDeveloperListing — artifact validator", () => {
  it("round-trips the parsed real fixture through JSON", () => {
    const listing = parseListingHtml(fixture("ublock-origin-lite.html"), UBO_ID, FETCHED_AT);
    const back = parseDeveloperListing(JSON.parse(JSON.stringify(listing)));
    expect(back).toEqual(listing);
  });

  it("round-trips the unavailable marker artifact", () => {
    const gone = unavailableListing(UBO_ID, FETCHED_AT);
    expect(parseDeveloperListing(JSON.parse(JSON.stringify(gone)))).toEqual(gone);
  });

  it("is tolerant per-field: missing developer/wrong types coerce to null", () => {
    const back = parseDeveloperListing({
      extension_id: UBO_ID,
      fetched_at: FETCHED_AT,
      source: "chrome-web-store",
      developer: { name: 42, is_trader: "yes" },
      description: ["not", "a", "string"],
    });
    expect(back.developer).toEqual({ name: null, address: null, email: null, website: null, is_trader: null });
    expect(back.description).toBeNull();
    expect(back.country).toBeNull();
  });

  it("throws ListingError when the value is not a listing artifact at all", () => {
    expect(() => parseDeveloperListing(null)).toThrow(ListingError);
    expect(() => parseDeveloperListing([])).toThrow(ListingError);
    expect(() => parseDeveloperListing({})).toThrow(ListingError);
    expect(() => parseDeveloperListing({ extension_id: UBO_ID, fetched_at: FETCHED_AT, source: "ftp" })).toThrow(
      ListingError,
    );
  });
});

// ---------------------------------------------------------------------------
// Artifact placement: the artifact is a SIBLING of the unpacked extension dir,
// never a file inside it — example_crxs/<id>/ is the unpacked extension root
// and the static pipeline ingests every file under it.
// ---------------------------------------------------------------------------

describe("listingPathFor — sibling artifact mapping", () => {
  it("maps an unpacked dir to <dir>.developer-listing.json", () => {
    expect(listingPathFor(`example_crxs/${UBO_ID}`)).toBe(`example_crxs/${UBO_ID}.developer-listing.json`);
  });

  it("strips trailing slashes so <dir>/ and <dir> map identically", () => {
    expect(listingPathFor(`example_crxs/${UBO_ID}/`)).toBe(`example_crxs/${UBO_ID}.developer-listing.json`);
    expect(listingPathFor(`example_crxs/${UBO_ID}///`)).toBe(`example_crxs/${UBO_ID}.developer-listing.json`);
  });

  it("never resolves to a path inside the extension dir", () => {
    expect(listingPathFor(`/abs/out/${UBO_ID}`).startsWith(`/abs/out/${UBO_ID}/`)).toBe(false);
  });
});

describe("listingCandidatePaths — integrator lookup order", () => {
  it("returns the sibling-file form first, then the corpus-layout form", () => {
    expect(listingCandidatePaths("corpus/demo-cookie-manager/extension")).toEqual([
      "corpus/demo-cookie-manager/extension.developer-listing.json",
      join("corpus/demo-cookie-manager", LISTING_FILENAME),
    ]);
  });

  it("handles trailing slashes", () => {
    expect(listingCandidatePaths("corpus/sample/extension/")).toEqual([
      "corpus/sample/extension.developer-listing.json",
      "corpus/sample/developer-listing.json",
    ]);
  });
});

// ---------------------------------------------------------------------------
// fetchListing — skip/--force and write-location behavior, fully offline via
// the injectable fetch.
// ---------------------------------------------------------------------------

function stubFetch(body: string, status = 200): { impl: typeof fetch; calls: () => number } {
  let n = 0;
  const impl = (async () => {
    n++;
    return new Response(body, { status, headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  return { impl, calls: () => n };
}

describe("fetchListing — artifact placement + skip/--force", () => {
  it("writes the artifact as a sibling of <out-dir>/<id>/, never inside it", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "listing-"));
    mkdirSync(join(outDir, UBO_ID), { recursive: true }); // simulate the unpacked extension root
    const { impl } = stubFetch(fixture("ublock-origin-lite.html"));

    const r = await fetchListing(UBO_ID, { outDir, force: false }, impl);

    expect(r.skipped).toBe(false);
    expect(r.artifactPath).toBe(join(outDir, `${UBO_ID}.developer-listing.json`));
    expect(existsSync(r.artifactPath)).toBe(true);
    // The unpacked extension root must stay pristine.
    expect(existsSync(join(outDir, UBO_ID, LISTING_FILENAME))).toBe(false);

    const artifact = parseDeveloperListing(JSON.parse(readFileSync(r.artifactPath, "utf8")));
    expect(artifact.extension_id).toBe(UBO_ID);
    expect(artifact.source).toBe("chrome-web-store");
    expect(artifact.developer.email).toBe("ubo@raymondhill.net");
    expect(Number.isNaN(Date.parse(artifact.fetched_at))).toBe(false);
  });

  it("does not require the unpacked dir to exist", async () => {
    const outDir = join(mkdtempSync(join(tmpdir(), "listing-")), "nested", "out");
    const { impl } = stubFetch(fixture("trader-synthetic.html"));
    const r = await fetchListing(TRADER_ID, { outDir, force: false }, impl);
    expect(existsSync(r.artifactPath)).toBe(true);
  });

  it("accepts a Web Store detail URL and resolves the embedded ID", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "listing-"));
    const { impl } = stubFetch(fixture("ublock-origin-lite.html"));
    const r = await fetchListing(`https://chromewebstore.google.com/detail/ubo-lite/${UBO_ID}`, { outDir, force: false }, impl);
    expect(r.id).toBe(UBO_ID);
    expect(r.artifactPath).toBe(join(outDir, `${UBO_ID}.developer-listing.json`));
  });

  it("skips without touching the network when the artifact already exists", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "listing-"));
    const path = join(outDir, `${UBO_ID}.developer-listing.json`);
    writeFileSync(path, '{"sentinel":true}\n');
    const stub = stubFetch(fixture("ublock-origin-lite.html"));

    const r = await fetchListing(UBO_ID, { outDir, force: false }, stub.impl);

    expect(r.skipped).toBe(true);
    expect(r.listing).toBeNull();
    expect(stub.calls()).toBe(0);
    expect(readFileSync(path, "utf8")).toContain("sentinel"); // untouched
  });

  it("re-fetches and overwrites when --force is set", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "listing-"));
    const path = join(outDir, `${UBO_ID}.developer-listing.json`);
    writeFileSync(path, '{"sentinel":true}\n');
    const stub = stubFetch(fixture("ublock-origin-lite.html"));

    const r = await fetchListing(UBO_ID, { outDir, force: true }, stub.impl);

    expect(r.skipped).toBe(false);
    expect(stub.calls()).toBe(1);
    const artifact = parseDeveloperListing(JSON.parse(readFileSync(path, "utf8")));
    expect(artifact.developer.email).toBe("ubo@raymondhill.net");
  });

  it("records HTTP 404 as a source:unavailable artifact at the sibling path", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "listing-"));
    const { impl } = stubFetch("", 404);
    const r = await fetchListing(UBO_ID, { outDir, force: false }, impl);
    expect(r.artifactPath).toBe(join(outDir, `${UBO_ID}.developer-listing.json`));
    const artifact = parseDeveloperListing(JSON.parse(readFileSync(r.artifactPath, "utf8")));
    expect(artifact.source).toBe("unavailable");
    expect(artifact.developer).toEqual({ name: null, address: null, email: null, website: null, is_trader: null });
  });

  it("throws FetchError (and writes nothing) on transient HTTP errors", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "listing-"));
    const { impl } = stubFetch("server error", 503);
    await expect(fetchListing(UBO_ID, { outDir, force: false }, impl)).rejects.toThrow(FetchError);
    expect(existsSync(join(outDir, `${UBO_ID}.developer-listing.json`))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The guard's own regression tests: without these, the guard could rot into a
// no-op (a stray restore, a vitest lifecycle change) and nobody would notice
// until the store traffic came back.
// ---------------------------------------------------------------------------

describe("offline guard — the injected fetch is the only network seam", () => {
  it("is armed: an omitted fetchImpl is caught, not silently fetched live", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "listing-"));
    // Deliberately no third argument — this is the exact mistake the guard exists
    // to catch, so it must reach the ambient global and be stopped there.
    await expect(fetchListing(UBO_ID, { outDir, force: false })).rejects.toThrow(FetchError);
    // Drained here so afterEach sees a clean slate: this attempt is the point.
    expect(takeBlockedNetworkAttempts()).toEqual([`https://chromewebstore.google.com/detail/${UBO_ID}`]);
    // A blocked fetch must leave no artifact behind — no half-real fixture.
    expect(existsSync(join(outDir, `${UBO_ID}.developer-listing.json`))).toBe(false);
  });

  it("stays quiet on the fixture-driven path: the stub serves, the global is untouched", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "listing-"));
    const stub = stubFetch(fixture("ublock-origin-lite.html"));
    await fetchListing(UBO_ID, { outDir, force: false }, stub.impl);
    expect(stub.calls()).toBe(1);
    expect(peekBlockedNetworkAttempts()).toEqual([]);
  });
});
