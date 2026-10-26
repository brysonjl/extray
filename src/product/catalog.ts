// Catalog search: the role-scoped canonical set, hydrated into CatalogRows,
// then filtered/sorted/paged in process. At catalog scale (~340 canonical
// rows locally) JS filtering over cached derived rows beats pushing the
// JSON-derived facets into SQL; revisit with FTS when coverage grows (plan §7).
//
// Hydration is batch + cached: report blobs are fetched only for reportIds not
// already in the derived-row cache (chunked IN(...) queries — never one query
// per row, which would blow the Workers subrequest budget), parsed once, and
// reduced to ~1KB CatalogRow bases. The cache holds derived rows, not parsed
// blobs, so it stays small enough for a Workers isolate; entries are immutable
// (a re-analysis mints a new reportId).

import type { DataSource } from "./datasource.ts";
import { canonicalReports, riskReportsFor, type CanonicalRow } from "./canonical.ts";
import { catalogRowBase, withAdminCatalogColumns, FINDING_TYPE_FACETS, type CatalogRow, type Tier } from "./dto.ts";
import type { ProductionProfile, Role } from "./profile.ts";

export interface CatalogQuery {
  q?: string;
  tier?: string;
  access?: string;
  developer?: string; // trader | high-risk-country | non-store-update
  findingType?: string; // malicious | vulnerability | unwanted | risky-capability
  sort?: string; // risk | recent | name
  page?: number;
  pageSize?: number;
}

export interface CatalogResult {
  rows: CatalogRow[];
  total: number;
  page: number;
  pageSize: number;
}

const TIER_RANK: Record<string, number> = {
  "high-risk": 0, concerning: 1, inconclusive: 2, "low-risk": 3, clean: 4,
};

export const CATALOG_SORTS = ["risk", "recent", "name"] as const;
// Capability facets (surfaced as the "Capability" dropdown). Order = display order;
// the deriver in dto.ts (accessFacetsOf) must push in the same order.
export const ACCESS_FACETS = [
  "cookies",
  "all-sites",
  "injects-code",
  "intercepts-network",
  "native-messaging",
  "downloads",
  "reads-history",
  "remote-code",
  "obfuscated",
] as const;
export const DEVELOPER_FACETS = ["trader", "high-risk-country", "non-store-update"] as const;

function matchesDeveloperFacet(row: CatalogRow, facet: string): boolean {
  if (facet === "trader") return row.flags.isTrader === true;
  if (facet === "high-risk-country") return row.flags.highRiskCountry === true;
  if (facet === "non-store-update") return row.flags.nonStoreUpdate === true;
  return false;
}

/** Derived-row cache keyed by reportId. Bounded like the old parsed-report
 *  cache was; insertion-order eviction is fine for an append-only DB. */
const baseCaches = new WeakMap<DataSource, Map<number, CatalogRow>>();
const BASE_CACHE_MAX = 5000;

async function hydrateCatalogRows(ds: DataSource, canonical: CanonicalRow[], role: Role): Promise<CatalogRow[]> {
  // Report IDs are unique only within a database. Never reuse another binding's
  // rows when a Worker receives a replacement database in the same isolate.
  let baseCache = baseCaches.get(ds);
  if (!baseCache) { baseCache = new Map(); baseCaches.set(ds, baseCache); }
  const missing = canonical.filter((r) => !baseCache.has(r.reportId));
  if (missing.length > 0) {
    const blobs = await riskReportsFor(ds, missing.map((r) => r.reportId));
    for (const row of missing) {
      if (baseCache.size >= BASE_CACHE_MAX) {
        const first = baseCache.keys().next();
        if (!first.done) baseCache.delete(first.value);
      }
      baseCache.set(row.reportId, catalogRowBase(row, blobs.get(row.reportId) ?? null));
    }
  }
  return canonical.map((row) => {
    const base = baseCache.get(row.reportId) ?? catalogRowBase(row, null);
    return role === "admin" ? withAdminCatalogColumns(base, row) : base;
  });
}

export async function searchCatalog(
  ds: DataSource,
  role: Role,
  profile: ProductionProfile,
  query: CatalogQuery,
): Promise<CatalogResult> {
  let rows = await hydrateCatalogRows(ds, await canonicalReports(ds, role, profile), role);

  const q = query.q?.trim().toLowerCase();
  if (q) {
    rows = rows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.storeId.toLowerCase().includes(q) ||
        (r.developerName ?? "").toLowerCase().includes(q) ||
        r.headline.toLowerCase().includes(q),
    );
  }
  if (query.tier) rows = rows.filter((r) => r.tier === query.tier);
  if (query.access) rows = rows.filter((r) => r.access.includes(query.access!));
  if (query.developer) rows = rows.filter((r) => matchesDeveloperFacet(r, query.developer!));
  if (query.findingType) rows = rows.filter((r) => r.findingTypes.includes(query.findingType!));

  const sort = CATALOG_SORTS.includes(query.sort as (typeof CATALOG_SORTS)[number]) ? query.sort : "risk";
  if (sort === "risk") {
    // Reviewer's queue: worst tier first, ties broken by recency.
    rows.sort(
      (a, b) =>
        (TIER_RANK[a.tier ?? ""] ?? 9) - (TIER_RANK[b.tier ?? ""] ?? 9) ||
        b.assessedAt.localeCompare(a.assessedAt),
    );
  } else if (sort === "recent") {
    rows.sort((a, b) => b.assessedAt.localeCompare(a.assessedAt));
  } else {
    rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  const total = rows.length;
  const pageSize = Math.min(Math.max(Math.floor(query.pageSize ?? 50), 1), 200);
  const maxPage = Math.max(Math.ceil(total / pageSize), 1);
  const page = Math.min(Math.max(Math.floor(query.page ?? 1), 1), maxPage);
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize };
}

/** Home counts: tier distribution over the role's canonical set; Admin adds
 *  cost/token totals. Never leaks arms the role can't see (it's computed from
 *  the role-scoped selection). */
export async function catalogStats(
  ds: DataSource,
  role: Role,
  profile: ProductionProfile,
): Promise<Record<string, unknown>> {
  const canonical = await canonicalReports(ds, role, profile);
  const byTier: Record<string, number> = {};
  for (const r of canonical) {
    const t = r.tier ?? "unknown";
    byTier[t] = (byTier[t] ?? 0) + 1;
  }
  const lastAssessed = canonical.reduce<string | null>(
    (acc, r) => (acc === null || r.assessedAt > acc ? r.assessedAt : acc),
    null,
  );
  const stats: Record<string, unknown> = { total: canonical.length, byTier, lastAssessed };
  if (role === "admin") {
    stats.totalCostUsd = canonical.reduce((s, r) => s + (r.estimatedUsd ?? 0), 0);
    stats.totalInputTokens = canonical.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
    stats.totalOutputTokens = canonical.reduce((s, r) => s + (r.outputTokens ?? 0), 0);
    stats.byPipeline = canonical.reduce<Record<string, number>>((m, r) => {
      const k = `${r.methodology} · ${r.model}`;
      m[k] = (m[k] ?? 0) + 1;
      return m;
    }, {});
  }
  return stats;
}

/** Filter enums + facet definitions for dropdowns (GET /api/meta). Static —
 *  the closed tier enum plus the derived facet vocabulary this module owns. */
export function catalogMeta(role: Role): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    tiers: ["high-risk", "concerning", "inconclusive", "low-risk", "clean"] satisfies Tier[],
    access: ACCESS_FACETS,
    developer: DEVELOPER_FACETS,
    findingTypes: FINDING_TYPE_FACETS,
    sorts: CATALOG_SORTS,
    severities: ["critical", "high", "medium", "low", "info", "positive"],
  };
  if (role === "admin") {
    meta.roles = ["user", "admin"];
  }
  return meta;
}
