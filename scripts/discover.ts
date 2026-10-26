#!/usr/bin/env -S npx tsx
// CLI: DISCOVER Chrome extensions to grow the analyzed corpus. Query a discovery
// source by parameters (installs, rating, review count, category, "new",
// featured / top charts), dedup against extensions already in the bake-off DB,
// and emit a worklist file — the exact `one ID per line` format that
// `npm run assess -- --ids-file <list>` consumes. Optionally chain straight into
// assess with --run.
//
//   npm run discover -- --source extpose  --collection top-installed --min-installs 1000000 --limit 100
//   npm run discover -- --source extpose  --collection new --category tools --limit 50
//   npm run discover -- --source webstore --category productivity/tools --enrich --min-installs 100000
//   npm run discover -- --source webstore --collection sitemap --limit 500 --new-vs .out/store-snapshot.txt
//   npm run discover -- --source extpose  --collection top-installed --limit 20 --exclude-analyzed --run
//
// Two sources, one output shape (a Candidate: 32-char store id + metadata):
//
//   • extpose  — https://extpose.com. Collection & category listing pages render
//     installs / rating / review-count INLINE (50 rows/page, paginated), so
//     threshold + sort queries need no per-item fetch. The only extra hop is
//     one detail GET per SURVIVING row to recover the 32-char Web Store id
//     (extpose links rows by its own numeric id). robots.txt allows this.
//     Collections: top-installed, top-grossing, featured, new, delisted.
//
//   • webstore — https://chromewebstore.google.com. Category pages embed the
//     32-char ids directly (~34 items, the store's own ranking); the sitemap
//     (34 shards × ~9.8k) enumerates the whole store. Neither exposes installs
//     or rating inline, so --enrich fetches one detail page per id to fill them
//     (needed for install/rating/review filters). --new-vs diffs the sitemap
//     against a saved id snapshot to surface newly-listed extensions.
//
// This scrapes extpose/Google pages (no public discovery API exists — the
// official Chrome Web Store API is publish-only). Scraping is against Google's
// ToS even where robots.txt permits the paths; keep request volume modest
// (--concurrency / --delay) and use it for internal research.

import "./_env.ts";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { Command } from "commander";
import { openDb } from "../src/db/index.ts";
import {
  DEFAULT_MAX_WAIT_HOURS,
  DEFAULT_POLL_MINUTES,
  formatUsage,
  runAssessPaced,
  sessionUsageWindow,
} from "./_ollama-session.ts";

export class DiscoverError extends Error {}

const STORE_ID_RE = /^[a-p]{32}$/;
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// The pinned production analysis flags --run hands to assess — single-sourced
// in src/product/assess-args.ts; re-exported so existing consumers
// (backfill-catalog, tests) keep importing from here.
import { DEFAULT_ASSESS_ARGS } from "../src/product/assess-args.ts";
export { DEFAULT_ASSESS_ARGS };

export const EXTPOSE_COLLECTIONS = ["top-installed", "top-grossing", "featured", "new", "delisted"] as const;

// Safety ceiling for the extpose backfill loop: when --exclude-analyzed leaves
// fewer than --limit fresh candidates, discover keeps pulling listing pages
// (50 rows each) until it nets --limit or hits this cap. Bounds the per-run
// detail-fetch volume so a heavily-covered corpus can't trigger a runaway scrape.
export const EXTPOSE_MAX_PAGES = 10;

// ---- shared candidate shape --------------------------------------------------

export interface Candidate {
  /** 32-char Web Store id — the pipeline's key. Null before resolution/enrich. */
  storeId: string | null;
  name: string | null;
  installs: number | null;
  rating: number | null;
  ratingCount: number | null;
  category: string | null;
  /** Locale codes the extension ships (`_locales/`), from the extpose detail
   *  page. [] when it declares none; null when the source doesn't expose them
   *  (webstore). A rough origin signal — see passesEnglishFilter. */
  languages: string[] | null;
  source: "extpose" | "webstore";
  /** Where this row came from (extpose numeric id or webstore slug/url). */
  ref: string;
}

export interface Filters {
  minInstalls?: number;
  maxInstalls?: number;
  minRating?: number;
  maxRating?: number;
  minReviews?: number;
}

// ---- pure parsing (unit-tested) ---------------------------------------------

/** "318,000,000" | "7,000,000" | "10K" | "1.2M+" → integer, else null. */
export function parseCount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/,/g, "");
  const m = s.match(/^([\d.]+)\s*([kmb])?\+?$/i);
  if (m) {
    let n = Number(m[1]);
    const suf = m[2]?.toLowerCase();
    if (suf === "k") n *= 1e3;
    else if (suf === "m") n *= 1e6;
    else if (suf === "b") n *= 1e9;
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  const digits = s.replace(/[^\d]/g, "");
  return digits ? Number(digits) : null;
}

export interface ExtposeRow {
  extposeId: string;
  name: string;
  installs: number | null;
  rating: number | null;
  ratingCount: number | null;
}

/**
 * Parse an extpose collection/category listing page into rows. Each card links
 * its title via <a href="/ext/<numeric>">Name</a>; installs and rating render
 * inline just below it. Rows are sliced at successive title anchors so a card's
 * metadata can't bleed into its neighbour. Dedups by extposeId (the card image
 * links the same id) preserving order.
 */
export function parseExtposeListing(html: string): ExtposeRow[] {
  // Title anchor: href to a numeric /ext/ id whose inner text is a real name
  // (the image anchor for the same id wraps an <img>, so [^<] excludes it).
  const anchorRe = /<a\s+href="\/ext\/(\d+)"[^>]*>\s*([^<]+?)\s*<\/a>/g;
  const anchors: { id: string; name: string; start: number; end: number }[] = [];
  for (let m = anchorRe.exec(html); m; m = anchorRe.exec(html)) {
    anchors.push({ id: m[1]!, name: decodeEntities(m[2]!.trim()), start: m.index, end: anchorRe.lastIndex });
  }
  const rows: ExtposeRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i]!;
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    const slice = html.slice(a.end, anchors[i + 1]?.start ?? html.length);
    const inst = slice.match(/<span[^>]*font-semibold[^>]*>\s*([\d,]+)\s*<\/span>\s*installs/i);
    const rat = slice.match(/★\s*([\d.]+)\s*\(([\d,]+)\)/);
    rows.push({
      extposeId: a.id,
      name: a.name,
      installs: inst ? parseCount(inst[1]) : null,
      rating: rat ? Number(rat[1]) : null,
      ratingCount: rat ? parseCount(rat[2]) : null,
    });
  }
  return rows;
}

/** Recover the 32-char Web Store id from an extpose detail page (its outbound
 *  Chrome Web Store link), or null if none is present. */
export function storeIdFromExtposeDetail(html: string): string | null {
  const m =
    html.match(/chromewebstore\.google\.com\/detail\/[^"'\s<>]*?([a-p]{32})/) ??
    html.match(/chrome\.google\.com\/webstore\/detail\/[^"'\s<>]*?([a-p]{32})/);
  return m ? m[1]! : null;
}

/** The locale codes an extension ships, from the extpose detail page's
 *  "Languages" row (`<dt>Languages</dt><dd>…<a href="/ext/<id>/<locale>">`).
 *  Returns [] when the extension declares no `_locales` (extpose omits the row).
 *  Used as a rough origin signal — a declared locale set with no English is
 *  almost always a foreign-market extension. */
export function languagesFromExtposeDetail(html: string): string[] {
  const dd = html.match(/>Languages<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/);
  if (!dd) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of dd[1]!.matchAll(/href="\/ext\/\d+\/([A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?)"/g)) {
    const code = m[1]!;
    if (!seen.has(code)) {
      seen.add(code);
      out.push(code);
    }
  }
  return out;
}

export interface WebstoreItem {
  storeId: string;
  slug: string | null;
}

/** Parse a Web Store category page: each result is a <div data-item-id="<id>">
 *  with a "./detail/<slug>/<id>" link. Returns ids in the store's own order. */
export function parseWebstoreCategory(html: string): WebstoreItem[] {
  const re = /data-item-id="([a-p]{32})"/g;
  const out: WebstoreItem[] = [];
  const seen = new Set<string>();
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const id = m[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    const near = html.slice(m.index, m.index + 300);
    const slug = near.match(/\.\/detail\/([a-z0-9-]+)\//)?.[1] ?? null;
    out.push({ storeId: id, slug });
  }
  return out;
}

export interface WebstoreDetail {
  name: string | null;
  installs: number | null;
  rating: number | null;
  ratingCount: number | null;
  category: string | null;
}

/** Extract installs / rating / review-count / name / category from a Web Store
 *  detail page (for --enrich, where the category/sitemap gave only the id). */
export function parseWebstoreDetail(html: string): WebstoreDetail {
  const title = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] ?? null;
  const users = html.match(/([\d,]+)\s*users/);
  const rating = html.match(/aria-label="([\d.]+) out of 5 stars"/);
  const ratings = html.match(/([\d,]+)\s*ratings/);
  return {
    name: title ? decodeEntities(title.replace(/\s*-\s*Chrome Web Store\s*$/, "")) : null,
    installs: users ? parseCount(users[1]) : null,
    rating: rating ? Number(rating[1]) : null,
    ratingCount: ratings ? parseCount(ratings[1]) : null,
    category: html.match(/\/category\/extensions\/([a-z0-9/_-]+)"/)?.[1] ?? null,
  };
}

/** Sitemap index → the shard sub-sitemap URLs. */
export function parseSitemapIndex(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
}

/** A sitemap shard → the 32-char store ids of its /detail/ URLs, in order. */
export function parseSitemapShardIds(xml: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/\/detail\/[^<>"\s]*?([a-p]{32})</g)) {
    const id = m[1]!;
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// ---- pure filtering / planning (unit-tested) --------------------------------

/** Keep candidates that satisfy every provided threshold. A null field fails a
 *  threshold that references it (you can't confirm an unknown-install extension
 *  clears --min-installs), so unenriched rows are dropped by install/rating/
 *  review filters — surface that in the CLI so it isn't silently lossy. */
export function applyFilters(cands: Candidate[], f: Filters): Candidate[] {
  return cands.filter((c) => {
    if (f.minInstalls != null && !(c.installs != null && c.installs >= f.minInstalls)) return false;
    if (f.maxInstalls != null && !(c.installs != null && c.installs <= f.maxInstalls)) return false;
    if (f.minRating != null && !(c.rating != null && c.rating >= f.minRating)) return false;
    if (f.maxRating != null && !(c.rating != null && c.rating <= f.maxRating)) return false;
    if (f.minReviews != null && !(c.ratingCount != null && c.ratingCount >= f.minReviews)) return false;
    return true;
  });
}

/** Keep-or-drop under the English-only origin filter: keep when the extension
 *  declares NO locales (unknown — many legit English extensions ship none) or
 *  declares any English locale; drop only when it ships locales and none is
 *  English (a Russian/Korean/Chinese-only extension). Not a true nationality
 *  test — a foreign extension that adds an `en` locale still passes. */
export function passesEnglishFilter(languages: string[] | null): boolean {
  if (!languages || languages.length === 0) return true;
  return languages.some((l) => l.toLowerCase() === "en" || l.toLowerCase().startsWith("en-"));
}

export type SortKey = "installs" | "rating" | "reviews" | "none";

/** Sort descending by the chosen metric; nulls sink to the bottom. Stable-ish
 *  (input order preserved for equal keys). */
export function sortCandidates(cands: Candidate[], key: SortKey): Candidate[] {
  if (key === "none") return cands;
  const pick = (c: Candidate) =>
    key === "installs" ? c.installs : key === "rating" ? c.rating : c.ratingCount;
  return [...cands]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (pick(b.c) ?? -1) - (pick(a.c) ?? -1) || a.i - b.i)
    .map((x) => x.c);
}

export interface WorklistPlan {
  /** Final, deduped, store-id-bearing candidates to write / analyze. */
  selected: Candidate[];
  /** Ids dropped because the corpus DB already has them (--exclude-analyzed). */
  skippedAnalyzed: string[];
  /** Candidates dropped because no 32-char store id could be resolved. */
  droppedNoStoreId: number;
}

/** How many distinct, store-id-bearing candidates are NOT already analyzed — i.e.
 *  how many would survive planWorklist's exclusion. Drives the extpose backfill:
 *  keep paging until this reaches `limit` so already-analyzed rows don't eat into
 *  the requested count. */
export function freshCount(cands: Candidate[], analyzed: Set<string>): number {
  const fresh = new Set<string>();
  for (const c of cands) {
    if (c.storeId && STORE_ID_RE.test(c.storeId) && !analyzed.has(c.storeId)) fresh.add(c.storeId);
  }
  return fresh.size;
}

/**
 * Turn raw candidates into the worklist selection: drop rows without a store id,
 * dedup by store id, drop ids already analyzed, then cap to `limit`.
 */
export function planWorklist(cands: Candidate[], analyzed: Set<string>, limit: number): WorklistPlan {
  const skippedAnalyzed: string[] = [];
  const selected: Candidate[] = [];
  const seen = new Set<string>();
  let droppedNoStoreId = 0;
  for (const c of cands) {
    if (!c.storeId || !STORE_ID_RE.test(c.storeId)) {
      droppedNoStoreId++;
      continue;
    }
    if (seen.has(c.storeId)) continue;
    seen.add(c.storeId);
    if (analyzed.has(c.storeId)) {
      skippedAnalyzed.push(c.storeId);
      continue;
    }
    selected.push(c);
    if (selected.length >= limit) break;
  }
  return { selected, skippedAnalyzed, droppedNoStoreId };
}

/** Distinct store ids already present in the bake-off DB, for --exclude-analyzed. */
export function loadAnalyzedIds(dbPath: string): Set<string> {
  const db = openDb(dbPath);
  try {
    const rows = db
      .prepare("SELECT DISTINCT store_id FROM target WHERE store_id IS NOT NULL")
      .all() as Array<{ store_id: string }>;
    return new Set(rows.map((r) => r.store_id));
  } finally {
    db.close();
  }
}

// ---- network (thin, not unit-tested) ----------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function fetchText(url: string, delayMs: number): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (delayMs > 0) await sleep(delayMs);
    try {
      const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
      if (res.status === 404) throw new DiscoverError(`404 Not Found: ${url}`);
      if (res.status === 429 || res.status >= 500) {
        lastErr = new DiscoverError(`HTTP ${res.status} for ${url}`);
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new DiscoverError(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (e) {
      if (e instanceof DiscoverError && /404/.test(e.message)) throw e;
      lastErr = e;
    }
  }
  throw new DiscoverError(`fetch failed after retries: ${url} (${(lastErr as Error)?.message ?? "unknown"})`);
}

/** Run `fn` over items with at most `limit` in flight. Preserves input order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---- providers ---------------------------------------------------------------

export interface DiscoverOpts {
  source: "extpose" | "webstore";
  collection?: string;
  category?: string;
  pages: number;
  filters: Filters;
  sort: SortKey;
  limit: number;
  enrich: boolean;
  /** extpose only: drop extensions whose declared locales lack English (rough
   *  foreign-market filter). No-op for webstore (languages not scraped). */
  excludeNonEnglish: boolean;
  newVs?: string;
  concurrency: number;
  delay: number;
}

function extposeListUrl(opts: DiscoverOpts, page: number): string {
  const base = opts.category
    ? `https://extpose.com/chrome/categories/${opts.category}`
    : `https://extpose.com/collections/${opts.collection}/chrome`;
  return page === 1 ? `${base}/` : `${base}/page/${page}`;
}

async function discoverExtpose(opts: DiscoverOpts, analyzed: Set<string>): Promise<Candidate[]> {
  if (opts.category && opts.collection) {
    // extpose exposes collection OR category listings, not their intersection.
    process.stderr.write("discover: extpose ignores --collection when --category is set (category listing used)\n");
  }
  if (!opts.category && !EXTPOSE_COLLECTIONS.includes((opts.collection ?? "") as (typeof EXTPOSE_COLLECTIONS)[number])) {
    throw new DiscoverError(
      `--collection must be one of ${EXTPOSE_COLLECTIONS.join(", ")} (or pass --category), got ${JSON.stringify(opts.collection)}`,
    );
  }

  // Page through the listing, resolving a store id per surviving row. Already-
  // analyzed rows are excluded downstream (planWorklist), so a fixed window would
  // yield `limit − overlap` results and shrink toward zero as the corpus grows.
  // Instead we keep paging until `limit` FRESH (non-analyzed) candidates are
  // resolvable — pulling at least opts.pages, and at most EXTPOSE_MAX_PAGES.
  const resolved: Candidate[] = [];
  const seenRefs = new Set<string>();
  if (opts.pages > EXTPOSE_MAX_PAGES) {
    process.stderr.write(
      `discover: --pages ${opts.pages} clipped to the EXTPOSE_MAX_PAGES safety ceiling (${EXTPOSE_MAX_PAGES})\n`,
    );
  }
  // The loop runs to the CEILING (not opts.pages): the early break below stops
  // at opts.pages once enough fresh candidates are in hand, and the backfill
  // pages past it — but never past the ceiling, even for an explicit --pages.
  const maxPages = EXTPOSE_MAX_PAGES;
  for (let p = 1; p <= maxPages; p++) {
    const url = extposeListUrl(opts, p);
    process.stdout.write(`  fetching ${url}\n`);
    const rows = parseExtposeListing(await fetchText(url, opts.delay));
    if (rows.length === 0) break; // ran off the end of the listing

    // Rows carry inline installs/rating/reviews → filter before the per-row hop,
    // and drop extpose ids already seen on an earlier page.
    const pageCands: Candidate[] = applyFilters(
      rows.map((r) => ({
        storeId: null,
        name: r.name,
        installs: r.installs,
        rating: r.rating,
        ratingCount: r.ratingCount,
        category: opts.category ?? null,
        languages: null,
        source: "extpose",
        ref: r.extposeId,
      })),
      opts.filters,
    ).filter((c) => !seenRefs.has(c.ref));
    pageCands.forEach((c) => seenRefs.add(c.ref));

    // Resolve the 32-char store id via one detail GET each (concurrency-limited).
    // The same detail page carries the declared-locale list, so capture it here
    // for free rather than paying a second fetch.
    await mapLimit(pageCands, opts.concurrency, async (c) => {
      try {
        const detail = await fetchText(`https://extpose.com/ext/${c.ref}`, opts.delay);
        c.storeId = storeIdFromExtposeDetail(detail);
        c.languages = languagesFromExtposeDetail(detail);
      } catch (e) {
        process.stderr.write(`  ! ext/${c.ref}: ${(e as Error).message}\n`);
      }
    });
    // Drop foreign-market extensions before counting toward the limit, so the
    // backfill pages deeper to replace them (same as --exclude-analyzed).
    const kept = opts.excludeNonEnglish ? pageCands.filter((c) => passesEnglishFilter(c.languages)) : pageCands;
    if (opts.excludeNonEnglish && kept.length < pageCands.length) {
      process.stdout.write(`  dropped ${pageCands.length - kept.length} non-English on page ${p}\n`);
    }
    resolved.push(...kept);

    // Stop once we've pulled the requested pages AND have enough fresh candidates.
    const fresh = freshCount(resolved, analyzed);
    process.stdout.write(`  page ${p}: ${resolved.length} resolved, ${fresh}/${opts.limit} fresh\n`);
    if (p >= opts.pages && fresh >= opts.limit) break;
  }
  return sortCandidates(resolved, opts.sort);
}

async function discoverWebstore(opts: DiscoverOpts, analyzed: Set<string>): Promise<Candidate[]> {
  let items: WebstoreItem[] = [];

  if (opts.collection === "sitemap") {
    // Enumerate ids from sitemap shards until we have plenty to filter down to
    // --limit. Each shard is ~9.8k ids; take shards one at a time.
    const index = parseSitemapIndex(await fetchText("https://chromewebstore.google.com/sitemap", opts.delay));
    const shards = index.filter((u) => u.includes("shard="));
    process.stdout.write(`  sitemap: ${shards.length} shards\n`);
    const ids: string[] = [];
    // Pull enough shards to comfortably exceed the target (one shard usually suffices).
    const targetPool = Math.max(opts.limit * 4, 2000);
    for (const shardUrl of shards) {
      process.stdout.write(`  fetching ${shardUrl}\n`);
      ids.push(...parseSitemapShardIds(await fetchText(shardUrl, opts.delay)));
      if (ids.length >= targetPool) break;
    }
    let pool = [...new Set(ids)];

    if (opts.newVs) {
      const before = existsSync(opts.newVs)
        ? new Set(readFileSync(opts.newVs, "utf8").split("\n").map((l) => l.trim()).filter(Boolean))
        : new Set<string>();
      const fresh = pool.filter((id) => !before.has(id));
      process.stdout.write(`  --new-vs: ${fresh.length}/${pool.length} ids not in snapshot ${opts.newVs}\n`);
      // Update the snapshot with everything we saw this run (union), so the next
      // run's "new" is relative to now. Never a filter target itself.
      writeFileSync(opts.newVs, [...new Set([...before, ...pool])].sort().join("\n") + "\n");
      pool = fresh;
    }
    items = pool.map((id) => ({ storeId: id, slug: null }));
  } else if (opts.category) {
    const url = `https://chromewebstore.google.com/category/extensions/${opts.category}`;
    process.stdout.write(`  fetching ${url}\n`);
    items = parseWebstoreCategory(await fetchText(url, opts.delay));
    process.stdout.write(`  parsed ${items.length} items\n`);
  } else {
    throw new DiscoverError("webstore source needs --category <group/sub> or --collection sitemap");
  }

  let cands: Candidate[] = items.map((it) => ({
    storeId: it.storeId,
    name: it.slug,
    installs: null,
    rating: null,
    ratingCount: null,
    category: opts.category ?? null,
    languages: null,
    source: "webstore",
    ref: it.slug ?? it.storeId,
  }));

  const wantsMetric =
    opts.filters.minInstalls != null || opts.filters.maxInstalls != null ||
    opts.filters.minRating != null || opts.filters.maxRating != null ||
    opts.filters.minReviews != null || opts.sort !== "none";

  if (opts.enrich) {
    // Cap enrichment so a sitemap run doesn't fetch thousands of detail pages.
    // For category source this slice is the store's own ranking (meaningful);
    // for sitemap it's arbitrary order, so an install-ranked sitemap query is
    // best-effort within this window — extpose's pre-sorted collections are the
    // right tool when you want a true global install ranking. Grow the window
    // past already-analyzed ids (dropped downstream) so it still holds `want`
    // FRESH candidates — store ids are known pre-enrich, so this costs no fetches
    // and stops the analyzed set from starving an --exclude-analyzed run.
    const want = Math.ceil(opts.limit * 1.5) + 10;
    let fresh = 0;
    let cut = 0;
    for (; cut < cands.length && fresh < want; cut++) {
      if (!analyzed.has(cands[cut]!.storeId!)) fresh++;
    }
    cands = cands.slice(0, cut);
    // Only fetch detail pages for the fresh ones; analyzed ids stay in the list
    // (unenriched) to be counted+dropped downstream, not paid for here.
    const toEnrich = cands.filter((c) => !analyzed.has(c.storeId!));
    process.stdout.write(`  enriching ${toEnrich.length} fresh item(s) via detail pages…\n`);
    await mapLimit(toEnrich, opts.concurrency, async (c) => {
      try {
        const d = parseWebstoreDetail(await fetchText(`https://chromewebstore.google.com/detail/${c.storeId}`, opts.delay));
        c.name = d.name ?? c.name;
        c.installs = d.installs;
        c.rating = d.rating;
        c.ratingCount = d.ratingCount;
        c.category = d.category ?? c.category;
      } catch (e) {
        process.stderr.write(`  ! detail/${c.storeId}: ${(e as Error).message}\n`);
      }
    });
  } else if (wantsMetric) {
    process.stderr.write(
      "discover: webstore install/rating/review filters & sort need --enrich (detail pages carry those); " +
        "without it those thresholds drop every row. Add --enrich or remove the thresholds.\n",
    );
  }

  return sortCandidates(applyFilters(cands, opts.filters), opts.sort);
}

/** `analyzed` (default empty) lets the providers page/enrich past ids already in
 *  the corpus so an --exclude-analyzed run still yields ~`limit` fresh candidates
 *  instead of `limit − overlap`. planWorklist still does the final exclusion. */
export async function discover(opts: DiscoverOpts, analyzed: Set<string> = new Set()): Promise<Candidate[]> {
  return opts.source === "extpose" ? discoverExtpose(opts, analyzed) : discoverWebstore(opts, analyzed);
}

// ---- output + --run ----------------------------------------------------------

function defaultOutPath(opts: DiscoverOpts): string {
  const tag = [opts.source, opts.collection, opts.category?.replace(/\//g, "-")].filter(Boolean).join("-");
  return `worklists/discover-${tag}.txt`;
}

function writeWorklist(path: string, plan: WorklistPlan, opts: DiscoverOpts): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, plan.selected.map((c) => c.storeId).join("\n") + "\n");
  // Sidecar provenance: the query + per-id metadata behind the worklist.
  const sidecar = {
    query: { ...opts },
    generatedAt: new Date().toISOString(),
    count: plan.selected.length,
    skippedAnalyzed: plan.skippedAnalyzed.length,
    droppedNoStoreId: plan.droppedNoStoreId,
    candidates: plan.selected,
  };
  writeFileSync(`${path}.json`, JSON.stringify(sidecar, null, 2) + "\n");
}

interface RunOpts {
  db: string;
  wait: boolean;
  waitPollMin: number;
  waitMaxHours: number;
}

/**
 * Analyze the selected extensions one at a time, pacing around Ollama's session
 * limit: if an analysis is rate-limited, wait for the session to reset and
 * retry that extension (see scripts/_ollama-session.ts). Returns a process exit
 * code (1 if any extension failed for a non-rate-limit reason).
 */
async function runPacedBatch(ids: string[], o: RunOpts): Promise<number> {
  const assessArgs = [...DEFAULT_ASSESS_ARGS, "--db", o.db];
  const usageLine = () => formatUsage(sessionUsageWindow(o.db));
  process.stdout.write(`\n[discover --run] analyzing ${ids.length} extension(s)${o.wait ? " (waits on rate limits)" : ""}\n  ${usageLine()}\n`);
  let ok = 0;
  const failed: string[] = [];
  for (const [i, id] of ids.entries()) {
    process.stdout.write(`\n[${i + 1}/${ids.length}] ${id}\n`);
    const res = await runAssessPaced(id, {
      assessArgs,
      wait: o.wait,
      pollMs: o.waitPollMin * 60_000,
      maxWaitMs: o.waitMaxHours * 3_600_000,
      usageLine,
    });
    if (res.code === 0) ok++;
    else {
      failed.push(id);
      process.stderr.write(`  ✗ ${id} failed (exit ${res.code})${res.rateLimited ? " [still rate-limited, gave up]" : ""}\n`);
    }
  }
  process.stdout.write(`\n[discover --run] done: ${ok} ok, ${failed.length} failed\n  ${usageLine()}\n`);
  return failed.length > 0 ? 1 : 0;
}

// ---- CLI ---------------------------------------------------------------------

function toNum(v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new DiscoverError(`expected a number, got ${JSON.stringify(v)}`);
  return n;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("discover")
    .description("Query a discovery source for Chrome extensions and emit an assess worklist")
    .requiredOption("--source <extpose|webstore>", "discovery source")
    .option("--collection <name>", `extpose: ${EXTPOSE_COLLECTIONS.join("|")}; webstore: sitemap`)
    .option("--category <cat>", "extpose: a category slug (e.g. tools); webstore: group/sub (e.g. productivity/tools)")
    .option("--pages <n>", "extpose: listing pages to pull (50 rows each)", toNum, 1)
    .option("--min-installs <n>", "keep extensions with at least this many installs", toNum)
    .option("--max-installs <n>", "keep extensions with at most this many installs", toNum)
    .option("--min-rating <x>", "keep extensions rated at least this (0–5)", toNum)
    .option("--max-rating <x>", "keep extensions rated at most this (0–5)", toNum)
    .option("--min-reviews <n>", "keep extensions with at least this many ratings", toNum)
    .option("--sort <installs|rating|reviews|none>", "sort before capping to --limit", "installs")
    .option("--limit <n>", "max extensions to output", toNum, 50)
    .option("--enrich", "webstore: fetch each detail page for installs/rating (extpose is inline)", false)
    .option("--exclude-non-english", "extpose: drop extensions whose declared locales lack English", false)
    .option("--new-vs <file>", "webstore sitemap: emit only ids absent from this snapshot, then update it")
    .option("--exclude-analyzed", "drop ids already in the bake-off DB", false)
    .option("--db <path>", "bake-off DB for --exclude-analyzed and --run", ".out/bakeoff.sqlite")
    .option("--out <file>", "worklist output path (default worklists/discover-<...>.txt)")
    .option("--concurrency <n>", "max in-flight detail fetches", toNum, 4)
    .option("--delay <ms>", "delay before each request (politeness)", toNum, 250)
    .option("--dry-run", "print the plan; write nothing and don't run assess", false)
    .option("--run", "after writing the worklist, analyze it with assess (pinned pi/glm arm)", false)
    .option("--no-wait", "with --run: fail fast on Ollama rate limits instead of waiting for reset")
    .option("--wait-poll-min <n>", "with --run: minutes between session-reset probes", toNum, DEFAULT_POLL_MINUTES)
    .option("--wait-max-hours <n>", "with --run: give up waiting for a reset after this many hours", toNum, DEFAULT_MAX_WAIT_HOURS)
    .action(async (o) => {
      const source = o.source as string;
      if (source !== "extpose" && source !== "webstore") {
        throw new DiscoverError(`--source must be "extpose" or "webstore", got ${JSON.stringify(source)}`);
      }
      const sort = o.sort as SortKey;
      if (!["installs", "rating", "reviews", "none"].includes(sort)) {
        throw new DiscoverError(`--sort must be installs|rating|reviews|none, got ${JSON.stringify(sort)}`);
      }
      const opts: DiscoverOpts = {
        source,
        collection: o.collection,
        category: o.category,
        pages: o.pages,
        filters: {
          minInstalls: o.minInstalls,
          maxInstalls: o.maxInstalls,
          minRating: o.minRating,
          maxRating: o.maxRating,
          minReviews: o.minReviews,
        },
        sort,
        limit: o.limit,
        enrich: o.enrich,
        excludeNonEnglish: o.excludeNonEnglish,
        newVs: o.newVs,
        concurrency: o.concurrency,
        delay: o.delay,
      };

      const analyzed = o.excludeAnalyzed ? loadAnalyzedIds(o.db) : new Set<string>();
      if (o.excludeAnalyzed) process.stdout.write(`  corpus has ${analyzed.size} analyzed id(s) to exclude\n`);

      process.stdout.write(`discover: querying ${source}…\n`);
      const cands = await discover(opts, analyzed);
      const plan = planWorklist(cands, analyzed, opts.limit);

      process.stdout.write(
        `\ndiscover: ${plan.selected.length} selected` +
          `${plan.skippedAnalyzed.length ? `, ${plan.skippedAnalyzed.length} already analyzed` : ""}` +
          `${plan.droppedNoStoreId ? `, ${plan.droppedNoStoreId} unresolved` : ""}\n`,
      );
      for (const c of plan.selected.slice(0, 25)) {
        const bits = [c.installs != null ? `${c.installs.toLocaleString()} inst` : null, c.rating != null ? `★${c.rating}` : null]
          .filter(Boolean)
          .join(" ");
        process.stdout.write(`  ${c.storeId}  ${bits}${c.name ? `  ${c.name}` : ""}\n`);
      }
      if (plan.selected.length > 25) process.stdout.write(`  … +${plan.selected.length - 25} more\n`);

      if (o.dryRun) {
        process.stdout.write("\ndiscover: --dry-run, nothing written\n");
        return;
      }
      if (plan.selected.length === 0) {
        process.stdout.write("\ndiscover: nothing to write (no candidates survived)\n");
        return;
      }

      const outPath = (o.out as string) ?? defaultOutPath(opts);
      writeWorklist(outPath, plan, opts);
      process.stdout.write(`\ndiscover: wrote ${plan.selected.length} id(s) → ${outPath} (+ ${outPath}.json)\n`);

      if (o.run) {
        const code = await runPacedBatch(
          plan.selected.map((c) => c.storeId as string),
          { db: o.db, wait: o.wait, waitPollMin: o.waitPollMin, waitMaxHours: o.waitMaxHours },
        );
        process.exit(code);
      }
    });

  await program.parseAsync();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    process.stderr.write(`discover: ${(e as Error).message}\n`);
    process.exit(2);
  });
}
