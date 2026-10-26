// Canonical-verdict selection: the ONE report per catalog key a given role
// sees, resolved against the role-scoped preference list in profile.ts. This is
// the central product-data decision (plan §4): newest store-backed 'assess'
// report whose (methodology, model) matches the highest-priority allowed arm.
//
// The arm list is BOUND, not interpolated — the CASE expression is built from
// `?` placeholders so the profile stays config while the SQL stays injection-free.
//
// There are TWO kinds of catalog entry, and they are selected by different
// rules on purpose:
//
//   store-backed — a real extension. The rules above apply in full: only the
//     role's allowed arms count, and the pinned arm wins. Key = the store id.
//
//   synthetic    — a labeled corpus sample (corpus/*). Included only when the
//     profile says so (requireStoreBacked: false), and then by RECENCY alone,
//     whatever arm produced it. A synthetic sample is not a verdict of record
//     about anything in the world; it exists so a fresh install has something
//     to look at and so the answer keys have somewhere to point. Holding it to
//     the pinned-arm rule would just make it invisible. Key = `corpus:<sample>`.
//
// Every synthetic row carries `synthetic: true` all the way to the UI badge —
// nothing derived from `corpus/` may ever read as a real extension.

import type { DataSource, Row } from "./datasource.ts";
import { safe } from "./datasource.ts";
import { ELIGIBLE_RUN_SQL } from "./eligibility.ts";
import { allowedArms, armKey, type ProductionProfile, type Role } from "./profile.ts";

export interface CanonicalRow {
  reportId: number;
  storeId: string;
  name: string | null;
  version: string | null;
  manifestVersion: number | null;
  tier: string | null;
  /** verdict.rationale lifted into a typed column at record time. */
  rationale: string | null;
  numFindings: number;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedUsd: number | null;
  methodology: string;
  model: string;
  think: string | null;
  mode: string | null;
  gitSha: string | null;
  analyzerVersion: string | null;
  assessedAt: string;
  /** Position in the role's preference list; 0 = the pinned arm. */
  prefRank: number;
  /** A labeled corpus sample, NOT a real extension. Drives the UI badge. */
  synthetic: boolean;
  /** Corpus sample directory name, for synthetic rows only. */
  sample: string | null;
}

/** The id a catalog entry is addressed by: a 32-char store id for a real
 *  extension, `corpus:<sample>` for a synthetic one. Minted in SQL (never
 *  stored) — `target.store_id` stays NULL for corpus rows, because they do not
 *  have one and the DB should not pretend otherwise. */
const CATALOG_KEY_SQL = "COALESCE(t.store_id, 'corpus:' || t.sample)";

export const CORPUS_KEY_PREFIX = "corpus:";

export function isCorpusKey(key: string): boolean {
  return key.startsWith(CORPUS_KEY_PREFIX);
}

/** Synthetic samples are part of the catalog exactly when the profile stops
 *  requiring a store-backed target. One flag, one meaning, one reader. */
export function includesCorpus(profile: ProductionProfile): boolean {
  return !profile.requireStoreBacked;
}

/** The shared projection. Both scopes select the same columns so one
 *  toCanonical() reads either. */
const PROJECTION = `rep.id AS report_id, ${CATALOG_KEY_SQL} AS store_id, t.sample, t.is_corpus,
             t.name, t.version, t.manifest_version,
             rep.tier, rep.overall_rationale, rep.num_findings,
             rep.input_tokens, rep.output_tokens, rep.estimated_usd,
             r.methodology, r.model, r.think, r.mode, r.git_sha, r.analyzer_version,
             r.started_at`;

/** Store-backed selection for an N-arm preference list. `?` slots: the N arm
 *  keys (methodology||'|'||model), then optionally one trailing store_id. */
function rankedSql(nArms: number, byKey: boolean): string {
  const whens = Array.from({ length: nArms }, (_, i) => `WHEN ? THEN ${i}`).join(" ");
  return `
    WITH pref AS (
      SELECT ${PROJECTION},
             CASE r.methodology || '|' || r.model ${whens} ELSE 99 END AS pref_rank
      FROM report rep
      JOIN run r    ON r.id = rep.run_id
      JOIN target t ON t.id = rep.target_id
      WHERE r.kind = 'assess' AND t.is_corpus = 0 AND t.store_id IS NOT NULL
        AND ${ELIGIBLE_RUN_SQL}
        AND rep.risk_report_json IS NOT NULL AND rep.risk_report_json != ''
        ${byKey ? `AND ${CATALOG_KEY_SQL} = ?` : ""}
    ),
    ranked AS (
      SELECT pref.*,
             ROW_NUMBER() OVER (PARTITION BY store_id ORDER BY pref_rank ASC, started_at DESC) AS rn
      FROM pref
      WHERE pref_rank < 99
    )
    SELECT * FROM ranked WHERE rn = 1`;
}

/** Synthetic selection: newest report per corpus sample, any arm, any run kind
 *  that produced a risk report (`reports` and `scorecard` runs both do — the
 *  offline replay ingest is a `reports` run). pref_rank is reported as 99 to
 *  say plainly "outside the preference list"; nothing ranks these against
 *  each other but recency. */
function corpusSql(byKey: boolean): string {
  return `
    WITH pref AS (
      SELECT ${PROJECTION}, 99 AS pref_rank
      FROM report rep
      JOIN run r    ON r.id = rep.run_id
      JOIN target t ON t.id = rep.target_id
      WHERE t.is_corpus = 1 AND t.sample IS NOT NULL
        AND ${ELIGIBLE_RUN_SQL}
        AND rep.risk_report_json IS NOT NULL AND rep.risk_report_json != ''
        ${byKey ? `AND ${CATALOG_KEY_SQL} = ?` : ""}
    ),
    ranked AS (
      SELECT pref.*, ROW_NUMBER() OVER (PARTITION BY store_id ORDER BY started_at DESC) AS rn
      FROM pref
    )
    SELECT * FROM ranked WHERE rn = 1`;
}

function toCanonical(r: Row): CanonicalRow {
  return {
    reportId: r.report_id as number,
    storeId: r.store_id as string,
    name: (r.name as string | null) ?? null,
    version: (r.version as string | null) ?? null,
    manifestVersion: (r.manifest_version as number | null) ?? null,
    tier: (r.tier as string | null) ?? null,
    rationale: (r.overall_rationale as string | null) ?? null,
    numFindings: (r.num_findings as number | null) ?? 0,
    inputTokens: (r.input_tokens as number | null) ?? null,
    outputTokens: (r.output_tokens as number | null) ?? null,
    estimatedUsd: (r.estimated_usd as number | null) ?? null,
    methodology: r.methodology as string,
    model: r.model as string,
    think: (r.think as string | null) ?? null,
    mode: (r.mode as string | null) ?? null,
    gitSha: (r.git_sha as string | null) ?? null,
    analyzerVersion: (r.analyzer_version as string | null) ?? null,
    assessedAt: r.started_at as string,
    prefRank: r.pref_rank as number,
    synthetic: r.is_corpus === 1,
    sample: (r.sample as string | null) ?? null,
  };
}

/** One canonical report per store_id for `role` — the role-scoped catalog set.
 *  An extension none of the role's arms has assessed simply does not appear. */
export async function canonicalReports(ds: DataSource, role: Role, profile: ProductionProfile): Promise<CanonicalRow[]> {
  const arms = allowedArms(profile, role);
  const rows =
    arms.length === 0 ? [] : await safe(() => ds.all(rankedSql(arms.length, false), ...arms.map(armKey)), [] as Row[]);
  const corpus = includesCorpus(profile) ? await safe(() => ds.all(corpusSql(false)), [] as Row[]) : [];
  return [...rows, ...corpus].map(toCanonical);
}

/** The canonical report for one extension under `role`, or null ("not assessed"
 *  — deliberately indistinguishable from "does not exist" for a User). */
export async function canonicalReport(
  ds: DataSource,
  role: Role,
  storeId: string,
  profile: ProductionProfile,
): Promise<CanonicalRow | null> {
  if (isCorpusKey(storeId)) {
    if (!includesCorpus(profile)) return null;
    const row = await safe(() => ds.get(corpusSql(true), storeId), undefined);
    return row ? toCanonical(row) : null;
  }
  const arms = allowedArms(profile, role);
  if (arms.length === 0) return null;
  const row = await safe(() => ds.get(rankedSql(arms.length, true), ...arms.map(armKey), storeId), undefined);
  return row ? toCanonical(row) : null;
}

/** Every store-backed assess report for one extension (the Admin "other
 *  analyses" index), newest first. NOT role-filtered — callers must gate. */
export function allReportsFor(ds: DataSource, storeId: string): Promise<Row[]> {
  return safe(
    () =>
      ds.all(
        `SELECT rep.id AS report_id, r.methodology, r.model, rep.tier, rep.num_findings,
                rep.estimated_usd, rep.input_tokens, rep.output_tokens, r.started_at
         FROM report rep
         JOIN run r    ON r.id = rep.run_id
         JOIN target t ON t.id = rep.target_id
         WHERE r.kind = 'assess' AND t.is_corpus = 0 AND t.store_id = ?
           AND ${ELIGIBLE_RUN_SQL}
           AND rep.risk_report_json IS NOT NULL AND rep.risk_report_json != ''
         ORDER BY r.started_at DESC`,
        storeId,
      ),
    [] as Row[],
  );
}

/** One specific report row (for GET /api/reports/:id), with the same join
 *  shape as canonical rows so the detail builder can treat both alike.
 *  Returns null for held runs, name-only / json-less reports, and corpus reports
 *  unless the profile includes the synthetic corpus — those are otherwise
 *  never product-visible regardless of role. */
export async function reportById(
  ds: DataSource,
  reportId: number,
  profile?: ProductionProfile,
): Promise<(CanonicalRow & { prefRank: -1 }) | null> {
  const corpusOk = profile ? includesCorpus(profile) : false;
  const row = await safe(
    () =>
      ds.get(
        `SELECT ${PROJECTION.replace("r.started_at", "r.started_at, -1 AS pref_rank")}
         FROM report rep
         JOIN run r    ON r.id = rep.run_id
         JOIN target t ON t.id = rep.target_id
         WHERE rep.id = ?
           AND ${ELIGIBLE_RUN_SQL}
           AND rep.risk_report_json IS NOT NULL AND rep.risk_report_json != ''
           AND ((r.kind = 'assess' AND t.is_corpus = 0 AND t.store_id IS NOT NULL)
                OR (? = 1 AND t.is_corpus = 1 AND t.sample IS NOT NULL))`,
        reportId,
        corpusOk ? 1 : 0,
      ),
    undefined,
  );
  return row ? (toCanonical(row) as CanonicalRow & { prefRank: -1 }) : null;
}

function parseRiskReport(j: unknown): Record<string, unknown> | null {
  if (typeof j !== "string" || j === "") return null;
  try {
    const obj: unknown = JSON.parse(j);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The stored RiskReport JSON for one report id, parsed. Uncached: the detail
 *  paths parse one blob per request; catalog hydration goes through
 *  riskReportsFor + the derived-row cache in catalog.ts instead — holding
 *  every parsed blob in memory would not fit a Workers isolate. */
export async function riskReportOf(ds: DataSource, reportId: number): Promise<Record<string, unknown> | null> {
  const row = await safe(
    () => ds.get(`SELECT rep.risk_report_json AS j FROM report rep JOIN run r ON r.id = rep.run_id
                  WHERE rep.id = ? AND ${ELIGIBLE_RUN_SQL}`, reportId),
    undefined,
  );
  return parseRiskReport(row?.j);
}

/** Batch fetch: SQLite and D1 both cap bound parameters (D1 at 100), so one
 *  IN(...) query per chunk. Missing ids simply have no entry in the map. */
const RISK_REPORT_CHUNK = 100;

export async function riskReportsFor(
  ds: DataSource,
  reportIds: number[],
): Promise<Map<number, Record<string, unknown> | null>> {
  const out = new Map<number, Record<string, unknown> | null>();
  for (let i = 0; i < reportIds.length; i += RISK_REPORT_CHUNK) {
    const chunk = reportIds.slice(i, i + RISK_REPORT_CHUNK);
    const marks = chunk.map(() => "?").join(",");
    const rows = await safe(
      () => ds.all(`SELECT rep.id, rep.risk_report_json AS j FROM report rep JOIN run r ON r.id = rep.run_id
                    WHERE rep.id IN (${marks}) AND ${ELIGIBLE_RUN_SQL}`, ...chunk),
      [] as Row[],
    );
    for (const row of rows) out.set(row.id as number, parseRiskReport(row.j));
  }
  return out;
}
