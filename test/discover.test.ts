// The pure half of scripts/discover.ts: the HTML/XML parsers (validated against
// real markup captured from extpose.com and chromewebstore.google.com), number
// coercion, threshold filtering, sorting, and the dedup/limit worklist plan.
// The network + CLI half is a thin shell exercised live via a --dry-run.

import { describe, expect, it } from "vitest";
import {
  applyFilters,
  type Candidate,
  freshCount,
  languagesFromExtposeDetail,
  parseCount,
  parseExtposeListing,
  parseSitemapIndex,
  parseSitemapShardIds,
  parseWebstoreCategory,
  parseWebstoreDetail,
  passesEnglishFilter,
  planWorklist,
  sortCandidates,
  storeIdFromExtposeDetail,
} from "../scripts/discover.ts";

const ID = (c: string) => c.repeat(32);

// A trimmed but faithful two-card extpose listing (note the leading image anchor
// that shares each card's numeric id — it must not become a row or a name).
const EXTPOSE_LISTING = `
<li>
  <a href="/ext/40668"><img loading="lazy"></a>
  <div class="flex-1 min-w-0">
    <a href="/ext/40668" class="block text-[16px] font-semibold text-ink hover:text-indigo-600 transition-colors">
      Adobe Acrobat: PDF edit, convert &amp; sign tools
    </a>
    <div class="text-[13.5px] text-muted line-clamp-2">Do more in Google Chrome with Adobe Acrobat PDF tools.</div>
    <div class="flex items-center flex-wrap">
      <span class="text-[13px] text-muted tabular-nums"><span class="font-semibold text-ink">318,000,000</span> installs</span>
      <span class="text-[13px] text-muted tabular-nums">★ 4.4 (62,024)</span>
    </div>
  </div>
</li>
<li>
  <a href="/ext/499014"><img loading="lazy"></a>
  <div class="flex-1 min-w-0">
    <a href="/ext/499014" class="block text-[16px] font-semibold text-ink">Grammar Checker</a>
    <div class="flex items-center flex-wrap">
      <span class="text-[13px] text-muted tabular-nums"><span class="font-semibold text-ink">147,000,000</span> installs</span>
      <span class="text-[13px] text-muted tabular-nums">★ 4.6 (15,370)</span>
    </div>
  </div>
</li>`;

// Real Web Store category markup: one result div per extension.
const WEBSTORE_CATEGORY = `
<div jscontroller="LcrBLd" data-item-id="kdpelmjpfafjppnhbloffcjpeomlnpah" class="cD9yc" ssk='32:kdpelmjpfafjppnhbloffcjpeomlnpah'><a href="./detail/wps-pdf-read-edit-fill-co/kdpelmjpfafjppnhbloffcjpeomlnpah" jslog="147884; index:0">WPS</a></div>
<div jscontroller="LcrBLd" data-item-id="aopddeflghjljihihabdclejbojaomaf" class="cD9yc"><a href="./detail/some-tool/aopddeflghjljihihabdclejbojaomaf">Some</a></div>`;

// Real Web Store detail fragments (og title + users + rating + ratings + category).
const WEBSTORE_DETAIL = `
<meta property="og:title" content="WPS PDF - Read, Edit, Fill, Convert, and AI Chat PDF with Ease - Chrome Web Store">
<div>7,000,000 users</div>
<div aria-label="4.5 out of 5 stars"></div>
<div>183 ratings</div>
<a href="/category/extensions/productivity/tools">Tools</a>`;

const EXTPOSE_DETAIL = `
<a class="store-link" href="https://chromewebstore.google.com/detail/adobe-acrobat-pdf-edit-co/efaidnbmnnnibpcajpcglclefindmkaj">Open in Chrome Web Store</a>`;

describe("parseCount", () => {
  it("strips commas", () => expect(parseCount("318,000,000")).toBe(318_000_000));
  it("handles K/M/B suffixes and +", () => {
    expect(parseCount("10K")).toBe(10_000);
    expect(parseCount("1.2M+")).toBe(1_200_000);
    expect(parseCount("2B")).toBe(2_000_000_000);
  });
  it("returns null for empties", () => {
    expect(parseCount(null)).toBeNull();
    expect(parseCount("")).toBeNull();
    expect(parseCount("n/a")).toBeNull();
  });
});

describe("parseExtposeListing", () => {
  const rows = parseExtposeListing(EXTPOSE_LISTING);
  it("yields one row per card (image anchor excluded, ids deduped)", () => {
    expect(rows.map((r) => r.extposeId)).toEqual(["40668", "499014"]);
  });
  it("decodes the name and reads inline metrics", () => {
    expect(rows[0]).toEqual({
      extposeId: "40668",
      name: "Adobe Acrobat: PDF edit, convert & sign tools",
      installs: 318_000_000,
      rating: 4.4,
      ratingCount: 62_024,
    });
  });
  it("does not bleed one card's metrics into the next", () => {
    expect(rows[1]!.installs).toBe(147_000_000);
    expect(rows[1]!.ratingCount).toBe(15_370);
  });
});

describe("storeIdFromExtposeDetail", () => {
  it("recovers the 32-char id from the outbound Web Store link", () => {
    expect(storeIdFromExtposeDetail(EXTPOSE_DETAIL)).toBe("efaidnbmnnnibpcajpcglclefindmkaj");
  });
  it("returns null when absent", () => expect(storeIdFromExtposeDetail("<p>nothing</p>")).toBeNull());
});

describe("languagesFromExtposeDetail", () => {
  const withLangs = (codes: string[]) =>
    `<dt class="ds-row-label">Languages</dt> <dd class="flex flex-wrap">` +
    codes.map((c) => `<a href="/ext/40668/${c}" class="ds-chip bg-fill">${c}</a>`).join(" ") +
    `</dd>`;
  it("reads the locale codes from the Languages row, deduped in order", () => {
    expect(languagesFromExtposeDetail(withLangs(["en", "en-GB", "ru", "zh-CN"]))).toEqual(["en", "en-GB", "ru", "zh-CN"]);
  });
  it("returns [] when the page declares no locales (row omitted)", () => {
    expect(languagesFromExtposeDetail("<dt>Publisher</dt><dd>Adobe Inc.</dd>")).toEqual([]);
  });
});

describe("passesEnglishFilter", () => {
  it("keeps unknown (null) and no-locale ([]) extensions", () => {
    expect(passesEnglishFilter(null)).toBe(true);
    expect(passesEnglishFilter([])).toBe(true);
  });
  it("keeps anything that ships an English locale", () => {
    expect(passesEnglishFilter(["en"])).toBe(true);
    expect(passesEnglishFilter(["ru", "en-GB", "de"])).toBe(true);
  });
  it("drops declared-locale sets with no English (foreign-only)", () => {
    expect(passesEnglishFilter(["ru"])).toBe(false);
    expect(passesEnglishFilter(["zh-CN", "zh-TW"])).toBe(false);
    expect(passesEnglishFilter(["ko"])).toBe(false);
  });
});

describe("parseWebstoreCategory", () => {
  it("extracts ids in order with their slug", () => {
    expect(parseWebstoreCategory(WEBSTORE_CATEGORY)).toEqual([
      { storeId: "kdpelmjpfafjppnhbloffcjpeomlnpah", slug: "wps-pdf-read-edit-fill-co" },
      { storeId: "aopddeflghjljihihabdclejbojaomaf", slug: "some-tool" },
    ]);
  });
});

describe("parseWebstoreDetail", () => {
  it("pulls name/installs/rating/reviews/category", () => {
    expect(parseWebstoreDetail(WEBSTORE_DETAIL)).toEqual({
      name: "WPS PDF - Read, Edit, Fill, Convert, and AI Chat PDF with Ease",
      installs: 7_000_000,
      rating: 4.5,
      ratingCount: 183,
      category: "productivity/tools",
    });
  });
});

describe("sitemap parsing", () => {
  it("reads shard urls from the index", () => {
    const xml = `<sitemapindex><sitemap><loc>https://chromewebstore.google.com/sitemap?shard=0</loc></sitemap>
      <sitemap><loc>https://chromewebstore.google.com/sitemap?shard=1</loc></sitemap></sitemapindex>`;
    expect(parseSitemapIndex(xml)).toHaveLength(2);
  });
  it("reads store ids from a shard's detail urls", () => {
    const xml = `<urlset><url><loc>https://chromewebstore.google.com/detail/applypilot/${ID("a")}</loc></url>
      <url><loc>https://chromewebstore.google.com/detail/freshtab/${ID("b")}</loc></url></urlset>`;
    expect(parseSitemapShardIds(xml)).toEqual([ID("a"), ID("b")]);
  });
});

// ---- filtering / sorting / planning -----------------------------------------

function cand(over: Partial<Candidate>): Candidate {
  return {
    storeId: ID("a"),
    name: null,
    installs: null,
    rating: null,
    ratingCount: null,
    category: null,
    languages: null,
    source: "extpose",
    ref: "x",
    ...over,
  };
}

describe("applyFilters", () => {
  const cs = [
    cand({ storeId: ID("a"), installs: 5_000_000, rating: 4.5, ratingCount: 900 }),
    cand({ storeId: ID("b"), installs: 500, rating: 2.1, ratingCount: 10 }),
    cand({ storeId: ID("c"), installs: null, rating: null, ratingCount: null }),
  ];
  it("keeps only rows clearing every threshold", () => {
    expect(applyFilters(cs, { minInstalls: 1_000_000 }).map((c) => c.storeId)).toEqual([ID("a")]);
  });
  it("supports a max (e.g. low-install / new)", () => {
    expect(applyFilters(cs, { maxInstalls: 1000 }).map((c) => c.storeId)).toEqual([ID("b")]);
  });
  it("drops rows with unknown metrics against a threshold that needs them", () => {
    // The null-metric row can never satisfy an install threshold.
    expect(applyFilters(cs, { minInstalls: 1 }).some((c) => c.storeId === ID("c"))).toBe(false);
  });
  it("combines rating + review thresholds", () => {
    expect(applyFilters(cs, { maxRating: 3, minReviews: 5 }).map((c) => c.storeId)).toEqual([ID("b")]);
  });
});

describe("sortCandidates", () => {
  const cs = [
    cand({ storeId: ID("a"), installs: 100 }),
    cand({ storeId: ID("b"), installs: 9000 }),
    cand({ storeId: ID("c"), installs: null }),
  ];
  it("orders by installs desc, nulls last", () => {
    expect(sortCandidates(cs, "installs").map((c) => c.storeId)).toEqual([ID("b"), ID("a"), ID("c")]);
  });
  it("is a no-op for 'none'", () => {
    expect(sortCandidates(cs, "none")).toBe(cs);
  });
});

describe("freshCount", () => {
  it("counts distinct, resolved, non-analyzed store ids (drives extpose backfill)", () => {
    const cands = [
      cand({ storeId: ID("a") }),
      cand({ storeId: ID("a") }), // dup — counted once
      cand({ storeId: ID("b") }), // already analyzed
      cand({ storeId: null }), // unresolved
      cand({ storeId: "NOTVALID" }), // malformed
      cand({ storeId: ID("c") }),
    ];
    expect(freshCount(cands, new Set([ID("b")]))).toBe(2); // a + c
  });
  it("is zero when every resolved id is already analyzed", () => {
    const cands = [cand({ storeId: ID("a") }), cand({ storeId: ID("b") })];
    expect(freshCount(cands, new Set([ID("a"), ID("b")]))).toBe(0);
  });
});

describe("planWorklist", () => {
  it("dedups by store id, drops analyzed + unresolved, then caps to limit", () => {
    const cands = [
      cand({ storeId: ID("a") }),
      cand({ storeId: ID("a") }), // dup
      cand({ storeId: null }), // unresolved
      cand({ storeId: ID("b") }), // already analyzed
      cand({ storeId: ID("c") }),
      cand({ storeId: ID("d") }),
    ];
    const plan = planWorklist(cands, new Set([ID("b")]), 2);
    expect(plan.selected.map((c) => c.storeId)).toEqual([ID("a"), ID("c")]); // capped at 2
    expect(plan.skippedAnalyzed).toEqual([ID("b")]);
    expect(plan.droppedNoStoreId).toBe(1);
  });
  it("rejects malformed store ids", () => {
    const plan = planWorklist([cand({ storeId: "NOTVALID" })], new Set(), 10);
    expect(plan.selected).toEqual([]);
    expect(plan.droppedNoStoreId).toBe(1);
  });
});
