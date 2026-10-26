#!/usr/bin/env -S npx tsx
// Read-only local web dashboard for exploring the bake-off DB (.out/bakeoff.sqlite).
// Serves a hand-written single-page UI from web/dashboard/ plus a JSON API under
// /api/* that turns the SQL bake-off queries (docs/bakeoff-db.md) into filterable
// views: how models/methodologies perform, what runs exist, which extensions were
// analyzed, the findings each run produced, and one report's full detail.
//
//   npm run dashboard -- [--db .out/bakeoff.sqlite] [--port 8787]
//
// Deliberately dependency-free: only node:http / node:sqlite / node:fs / node:path,
// the same primitives the rest of the repo already relies on. The frontend is plain
// HTML+CSS+ES-modules so it works fully offline (no framework, no CDN).
//
// Safety posture, non-negotiable:
//   - The DB is opened READ-ONLY and the server binds to 127.0.0.1 only.
//   - Every value derived from the query string is bound via `?` placeholders;
//     SQL is never built by string-interpolating a user value.
//   - The only dynamic identifiers (sort columns/direction) are validated against
//     hard-coded allowlists before they reach the SQL string.
//   - A missing/empty DB degrades to empty result sets rather than crashing.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { costOf, type CostRates } from "../src/llm/usage.ts";
import { resolveEffectiveRates } from "../src/llm/model-pricing.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "..", "web", "dashboard");
const ROW_CAP = 500; // every list endpoint caps rows; clients may lower via ?limit.

// ---- arg parsing (no commander — keep the web surface to Node built-ins) -----

interface Args {
  db: string;
  port: number;
  costRates?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { db: ".out/bakeoff.sqlite", port: 8787, costRates: process.env.LLM_COST_RATES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") out.db = argv[++i] ?? out.db;
    else if (a === "--port") out.port = Number(argv[++i] ?? out.port) || out.port;
    else if (a === "--cost-rates") out.costRates = argv[++i] ?? out.costRates;
  }
  return out;
}

/** Estimated USD for a (model, tokens) pair under `pricing`, or null when the
 *  model has no rate — never a guessed $0, so "—" reads as "unpriced". */
function estimateUsd(pricing: CostRates, model: unknown, inTok: unknown, outTok: unknown): number | null {
  if (typeof model !== "string" || model === "") return null;
  return costOf({ model, inputTokens: Number(inTok) || 0, outputTokens: Number(outTok) || 0 }, pricing);
}

/** Read-time priced_usd is a FALLBACK, not an override: a stored estimated_usd
 *  was priced at write time under an auditable rate card (possibly a --cost-rates
 *  snapshot), so the recompute is offered only when the stored value is absent.
 *  Renderers show `priced_usd ?? estimated_usd`, so returning null here leaves the
 *  stored figure to win. */
function pricedFallback(pricing: CostRates, stored: unknown, model: unknown, inTok: unknown, outTok: unknown): number | null {
  return stored != null ? null : estimateUsd(pricing, model, inTok, outTok);
}

// ---- query-string helpers ---------------------------------------------------

/** A trimmed, non-empty string param, else undefined (so it drops out of WHERE). */
function strParam(url: URL, key: string): string | undefined {
  const v = url.searchParams.get(key);
  const t = v?.trim();
  return t ? t : undefined;
}

/** ?limit, clamped to [1, ROW_CAP]; default ROW_CAP. */
function limitParam(url: URL): number {
  const raw = Number(url.searchParams.get("limit"));
  if (!Number.isFinite(raw) || raw <= 0) return ROW_CAP;
  return Math.min(Math.floor(raw), ROW_CAP);
}

/** Resolve ?sort / ?dir against a hard-coded allowlist. The map keys are the
 *  public sort names; values are the trusted SQL column expressions. */
function sortParam(
  url: URL,
  allow: Record<string, string>,
  fallback: string,
): { col: string; dir: "ASC" | "DESC" } {
  const key = url.searchParams.get("sort") ?? "";
  const col = allow[key] ?? allow[fallback]!;
  const dir = (url.searchParams.get("dir") ?? "").toUpperCase() === "ASC" ? "ASC" : "DESC";
  return { col, dir };
}

// ---- API handlers (each returns a JSON-serializable value) -------------------

type Row = Record<string, unknown>;
type DB = DatabaseSync;

/** Run a query, but treat a missing-table error (a file written before the
 *  schema existed, or a brand-new/empty file) as "no data" rather than a 500 —
 *  the spec asks for graceful degradation on an empty/missing DB. Any other
 *  error propagates. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof Error && /no such table/i.test(e.message)) return fallback;
    throw e;
  }
}

/** Distinct filter values powering every dropdown. SELECT DISTINCT off the
 *  relevant tables; falls back to the closed enums the spec lists so dropdowns
 *  are populated even when the DB is sparse. */
function apiMeta(db: DB): Row {
  const distinct = (sql: string): string[] =>
    (db.prepare(sql).all() as Row[]).map((r) => Object.values(r)[0]).filter((v): v is string => typeof v === "string" && v !== "");
  const union = (live: string[], enums: string[]): string[] => {
    const set = new Set([...live, ...enums]);
    return [...set];
  };
  return {
    methodologies: distinct("SELECT DISTINCT methodology FROM run ORDER BY methodology"),
    models: distinct("SELECT DISTINCT model FROM run ORDER BY model"),
    kinds: distinct("SELECT DISTINCT kind FROM run ORDER BY kind"),
    tiers: union(
      distinct("SELECT DISTINCT tier FROM report WHERE tier IS NOT NULL ORDER BY tier"),
      ["clean", "low-risk", "concerning", "high-risk", "inconclusive"],
    ),
    severities: union(
      distinct("SELECT DISTINCT severity FROM finding WHERE severity IS NOT NULL ORDER BY severity"),
      ["critical", "high", "medium", "low", "info"],
    ),
    categories: union(
      distinct("SELECT DISTINCT category FROM finding WHERE category IS NOT NULL ORDER BY category"),
      [
        "permissions", "data-exfiltration", "code-execution", "obfuscation", "supply-chain",
        "messaging-surface", "remote-resources", "claim-mismatch", "anomaly", "other",
      ],
    ),
    findingTypes: union(
      distinct("SELECT DISTINCT finding_type FROM finding WHERE finding_type IS NOT NULL AND finding_type != '' ORDER BY finding_type"),
      ["vulnerability", "malicious", "unwanted", "risky-capability", "benign", "unknown"],
    ),
  };
}

/** Headline comparison: one row per (methodology, model) from the MOST RECENT
 *  scorecard run, with a flag when more than one scorecard run exists for that
 *  pair. This is the "how are models/methodologies performing" view. */
function apiPerformance(db: DB, pricing: CostRates): Row[] {
  const rows = db
    .prepare(
      `WITH ranked AS (
         SELECT r.methodology, r.model, r.started_at, r.id AS run_id,
                sc.coverage_known_shapes, sc.coverage_open_world, sc.tier_recall,
                sc.unsafe_misses, sc.false_alarm_count, sc.stability, sc.estimated_usd,
                sc.total_input_tokens, sc.total_output_tokens,
                ROW_NUMBER() OVER (PARTITION BY r.methodology, r.model ORDER BY r.started_at DESC) AS rn,
                COUNT(*)    OVER (PARTITION BY r.methodology, r.model)                            AS run_count
         FROM scorecard sc JOIN run r ON r.id = sc.run_id
       )
       SELECT methodology, model, started_at, run_id,
              coverage_known_shapes, coverage_open_world, tier_recall,
              unsafe_misses, false_alarm_count, stability, estimated_usd,
              total_input_tokens, total_output_tokens,
              run_count, (run_count > 1) AS multiple_runs
       FROM ranked
       WHERE rn = 1
       ORDER BY coverage_known_shapes DESC, tier_recall DESC, methodology, model`,
    )
    .all() as Row[];
  // Read-time fallback for rows written before write-time pricing existed. NOTE
  // total_input/output_tokens are arm-only (judge/normalize excluded by design),
  // so this recompute under-prices — another reason it only fills a NULL, never
  // overrides the stored write-time estimate.
  for (const r of rows) r.priced_usd = pricedFallback(pricing, r.estimated_usd, r.model, r.total_input_tokens, r.total_output_tokens);
  return rows;
}

/** Run list, filterable by kind / methodology / model. Each row carries what the
 *  run actually produced: the analyzed extension's name (or target count for a
 *  multi-target corpus run), the verdict tier(s), asserted/excluded finding
 *  counts, and token/cost totals. Tokens come from `report.*` (the authoritative
 *  per-target totals) rather than the sparsely-populated per-step `usage` table,
 *  so a run's headline cost is correct even when step accounting is missing. A
 *  second query attaches the verified-finding type breakdown per run. */
function apiRuns(db: DB, url: URL, pricing: CostRates): { rows: Row[]; cap: number } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  const kind = strParam(url, "kind");
  const methodology = strParam(url, "methodology");
  const model = strParam(url, "model");
  if (kind) { where.push("r.kind = ?"); params.push(kind); }
  if (methodology) { where.push("r.methodology = ?"); params.push(methodology); }
  if (model) { where.push("r.model = ?"); params.push(model); }
  const sort = sortParam(
    url,
    {
      started_at: "r.started_at", kind: "r.kind", methodology: "r.methodology", model: "r.model",
      targets: "num_targets", num_findings: "num_findings", input_tokens: "input_tokens", output_tokens: "output_tokens",
    },
    "started_at",
  );
  const limit = limitParam(url);
  const rows = db
    .prepare(
      `SELECT r.id, r.kind, r.methodology, r.model, r.mode, r.think, r.started_at,
              (SELECT COUNT(*)  FROM target t WHERE t.run_id = r.id)                       AS num_targets,
              (SELECT MAX(t.name) FROM target t WHERE t.run_id = r.id)                      AS target_name,
              (SELECT GROUP_CONCAT(DISTINCT rep.tier) FROM report rep WHERE rep.run_id = r.id)        AS tiers,
              (SELECT COALESCE(SUM(rep.num_findings),0) FROM report rep WHERE rep.run_id = r.id)      AS num_findings,
              (SELECT COALESCE(SUM(rep.num_excluded),0) FROM report rep WHERE rep.run_id = r.id)      AS num_excluded,
              (SELECT COALESCE(SUM(rep.input_tokens),0)  FROM report rep WHERE rep.run_id = r.id)     AS input_tokens,
              (SELECT COALESCE(SUM(rep.output_tokens),0) FROM report rep WHERE rep.run_id = r.id)     AS output_tokens,
              (SELECT SUM(rep.estimated_usd) FROM report rep WHERE rep.run_id = r.id)                 AS estimated_usd
       FROM run r
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY ${sort.col} ${sort.dir}
       LIMIT ?`,
    )
    .all(...params, limit) as Row[];
  attachFindingTypes(db, rows);
  for (const r of rows) r.priced_usd = estimateUsd(pricing, r.model, r.input_tokens, r.output_tokens);
  return { rows, cap: limit };
}

/** Attach a `finding_types` map ({ malicious: 2, … }) of asserted findings to
 *  each run row, via one grouped query over the returned run ids. Mutates rows. */
function attachFindingTypes(db: DB, rows: Row[]): void {
  if (rows.length === 0) return;
  const byId = new Map<number, Record<string, number>>();
  for (const r of rows) byId.set(r.id as number, {});
  const ids = [...byId.keys()];
  const counts = db
    .prepare(
      `SELECT rep.run_id AS run_id, f.finding_type AS finding_type, COUNT(*) AS n
       FROM finding f JOIN report rep ON rep.id = f.report_id
       WHERE f.is_verified = 1 AND rep.run_id IN (${ids.map(() => "?").join(",")})
       GROUP BY rep.run_id, f.finding_type`,
    )
    .all(...ids) as Row[];
  for (const c of counts) {
    const m = byId.get(c.run_id as number);
    if (m) m[(c.finding_type as string) || "unknown"] = c.n as number;
  }
  for (const r of rows) r.finding_types = byId.get(r.id as number) ?? {};
}

/** One row per analyzed extension, grouped by coalesce(store_id, sample, name) so
 *  even backfilled targets that carry only a name (no store id / sample) still
 *  appear and remain clickable. Each row summarizes everything we know across
 *  runs: corpus/label/expected tier, version, #runs, the methodologies that have
 *  assessed it, total asserted findings, the set of tiers it has been assigned,
 *  and when it was last assessed. */
function apiExtensions(db: DB, url: URL): { rows: Row[]; cap: number } {
  const q = strParam(url, "q");
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (q) {
    where.push("(t.name LIKE ? OR t.store_id LIKE ? OR t.sample LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const limit = limitParam(url);
  const rows = db
    .prepare(
      `SELECT COALESCE(t.store_id, t.sample, t.name) AS identifier,
              MAX(t.name)                          AS name,
              MAX(t.is_corpus)                     AS is_corpus,
              MAX(t.label_kind)                    AS label_kind,
              MAX(t.expected_tier)                 AS expected_tier,
              MAX(t.version)                       AS version,
              COUNT(DISTINCT t.run_id)             AS num_runs,
              GROUP_CONCAT(DISTINCT r.methodology) AS methodologies,
              GROUP_CONCAT(DISTINCT rep.tier)      AS tiers,
              COALESCE(SUM(rep.num_findings),0)    AS total_findings,
              MAX(r.started_at)                    AS last_assessed
       FROM target t
       LEFT JOIN report rep ON rep.target_id = t.id
       LEFT JOIN run r      ON r.id = t.run_id
       WHERE COALESCE(t.store_id, t.sample, t.name) IS NOT NULL
       ${where.length ? "AND " + where.join(" AND ") : ""}
       GROUP BY COALESCE(t.store_id, t.sample, t.name)
       ORDER BY num_runs DESC, identifier
       LIMIT ?`,
    )
    .all(...params, limit) as Row[];
  return { rows, cap: limit };
}

/** All-runs rollup powering the Performance tab's "All assessments" table: one
 *  row per (methodology, model) across EVERY run (not just scorecard ones, so pi
 *  and plain assess runs are visible), with run/report counts, average + total
 *  asserted findings, token + cost totals, and a per-tier verdict distribution
 *  (attached as a `tiers` map via a second grouped query). */
function apiRollup(db: DB, pricing: CostRates): Row[] {
  const rows = db
    .prepare(
      `SELECT r.methodology, r.model,
              COUNT(DISTINCT r.id)            AS num_runs,
              COUNT(rep.id)                   AS num_reports,
              AVG(rep.num_findings)           AS avg_findings,
              COALESCE(SUM(rep.num_findings),0)  AS total_findings,
              COALESCE(SUM(rep.input_tokens),0)  AS input_tokens,
              COALESCE(SUM(rep.output_tokens),0) AS output_tokens,
              SUM(rep.estimated_usd)          AS estimated_usd
       FROM run r
       LEFT JOIN report rep ON rep.run_id = r.id
       GROUP BY r.methodology, r.model
       ORDER BY num_runs DESC, r.methodology, r.model`,
    )
    .all() as Row[];
  // Per-(methodology, model) tier distribution, merged onto each rollup row.
  const tierRows = db
    .prepare(
      `SELECT r.methodology, r.model, rep.tier AS tier, COUNT(*) AS n
       FROM report rep JOIN run r ON r.id = rep.run_id
       WHERE rep.tier IS NOT NULL
       GROUP BY r.methodology, r.model, rep.tier`,
    )
    .all() as Row[];
  const key = (m: unknown, md: unknown) => `${m} ${md}`;
  const byKey = new Map<string, Record<string, number>>();
  for (const r of rows) byKey.set(key(r.methodology, r.model), {});
  for (const t of tierRows) {
    const m = byKey.get(key(t.methodology, t.model));
    if (m) m[t.tier as string] = t.n as number;
  }
  for (const r of rows) r.tiers = byKey.get(key(r.methodology, r.model)) ?? {};
  // Cost estimate over the group's summed tokens at the active rate card.
  for (const r of rows) r.priced_usd = estimateUsd(pricing, r.model, r.input_tokens, r.output_tokens);
  return rows;
}

/** Rich per-extension detail. Identified by exactly one of store_id / sample /
 *  name (matching how the Extensions list groups them). Returns the aggregated
 *  identity, every report across runs (newest first, with full knobs + tokens),
 *  and the asserted-finding breakdown by type × severity. Returns null when the
 *  identifier matches no target. */
function apiExtensionDetail(db: DB, url: URL, pricing: CostRates): Row | null {
  const byStore = strParam(url, "store_id");
  const bySample = strParam(url, "sample");
  const byName = strParam(url, "name");
  let col: string;
  let val: string;
  if (byStore) { col = "t.store_id"; val = byStore; }
  else if (bySample) { col = "t.sample"; val = bySample; }
  else if (byName) { col = "t.name"; val = byName; }
  else return null;

  const identity = db
    .prepare(
      `SELECT MAX(t.name)          AS name,
              MAX(t.store_id)       AS store_id,
              MAX(t.sample)         AS sample,
              MAX(t.version)        AS version,
              MAX(t.manifest_version) AS manifest_version,
              MAX(t.is_corpus)      AS is_corpus,
              MAX(t.label_kind)     AS label_kind,
              MAX(t.expected_tier)  AS expected_tier,
              COUNT(DISTINCT t.run_id) AS num_runs
       FROM target t WHERE ${col} = ?`,
    )
    .get(val) as Row | undefined;
  if (!identity || identity.num_runs === 0) return null;

  const reports = db
    .prepare(
      `SELECT rep.id, r.methodology, r.model, r.kind, r.mode, r.think,
              rep.tier, rep.tier_source, rep.num_findings, rep.num_excluded,
              rep.input_tokens, rep.output_tokens, rep.estimated_usd, r.started_at
       FROM report rep
       JOIN run r    ON r.id = rep.run_id
       JOIN target t ON t.id = rep.target_id
       WHERE ${col} = ?
       ORDER BY r.started_at DESC`,
    )
    .all(val) as Row[];
  for (const r of reports) r.priced_usd = estimateUsd(pricing, r.model, r.input_tokens, r.output_tokens);

  const findingSummary = db
    .prepare(
      `SELECT f.finding_type AS finding_type, f.severity AS severity, COUNT(*) AS n
       FROM finding f
       JOIN report rep ON rep.id = f.report_id
       JOIN target t   ON t.id = rep.target_id
       WHERE ${col} = ? AND f.is_verified = 1
       GROUP BY f.finding_type, f.severity`,
    )
    .all(val) as Row[];

  return { identity, reports, findingSummary };
}

/** Report list joined to run + target; filter by methodology/model/tier/sample/store_id.
 *  Omits the large *_json columns — those ship only from /api/report/:id. */
function apiReports(db: DB, url: URL, pricing: CostRates): { rows: Row[]; cap: number } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  const add = (key: string, sql: string) => {
    const v = strParam(url, key);
    if (v) { where.push(sql); params.push(v); }
  };
  add("methodology", "r.methodology = ?");
  add("model", "r.model = ?");
  add("tier", "rep.tier = ?");
  add("sample", "t.sample = ?");
  add("store_id", "t.store_id = ?");
  add("name", "t.name = ?");
  const run = strParam(url, "run");
  if (run && /^\d+$/.test(run)) { where.push("rep.run_id = ?"); params.push(Number(run)); }
  const sort = sortParam(
    url,
    {
      started_at: "r.started_at", tier: "rep.tier", num_findings: "rep.num_findings",
      methodology: "r.methodology", model: "r.model", identifier: "identifier",
    },
    "started_at",
  );
  const limit = limitParam(url);
  const rows = db
    .prepare(
      `SELECT rep.id, r.methodology, r.model, r.kind,
              COALESCE(t.store_id, t.sample) AS identifier, t.name, t.sample, t.store_id,
              rep.tier, rep.num_findings, rep.num_excluded,
              rep.input_tokens, rep.output_tokens, rep.estimated_usd, r.started_at
       FROM report rep
       JOIN run r    ON r.id = rep.run_id
       JOIN target t ON t.id = rep.target_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY ${sort.col} ${sort.dir}
       LIMIT ?`,
    )
    .all(...params, limit) as Row[];
  for (const r of rows) r.priced_usd = estimateUsd(pricing, r.model, r.input_tokens, r.output_tokens);
  return { rows, cap: limit };
}

/** Cross-arm findings view: every finding joined to its report/run/target for
 *  context. Filter by severity/category/verified/methodology/model/sample/store_id. */
function apiFindings(db: DB, url: URL): { rows: Row[]; cap: number } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  const add = (key: string, sql: string) => {
    const v = strParam(url, key);
    if (v) { where.push(sql); params.push(v); }
  };
  add("severity", "f.severity = ?");
  add("category", "f.category = ?");
  add("finding_type", "f.finding_type = ?");
  add("methodology", "r.methodology = ?");
  add("model", "r.model = ?");
  add("sample", "t.sample = ?");
  add("store_id", "t.store_id = ?");
  const verified = strParam(url, "verified"); // "1" asserted | "0" excluded
  if (verified === "1" || verified === "0") {
    where.push("f.is_verified = ?");
    params.push(Number(verified));
  }
  const sort = sortParam(
    url,
    {
      severity: "f.severity", category: "f.category", finding_type: "f.finding_type",
      methodology: "r.methodology", model: "r.model", started_at: "r.started_at", title: "f.title",
    },
    "started_at",
  );
  const limit = limitParam(url);
  const rows = db
    .prepare(
      `SELECT f.id, f.report_id, f.finding_id, f.title, f.kind, f.severity, f.category, f.finding_type,
              f.confidence, f.claim_type, f.is_verified, f.exclusion_reason,
              r.methodology, r.model,
              COALESCE(t.store_id, t.sample) AS identifier, rep.tier, r.started_at
       FROM finding f
       JOIN report rep ON rep.id = f.report_id
       JOIN run r      ON r.id  = rep.run_id
       JOIN target t   ON t.id  = rep.target_id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY ${sort.col} ${sort.dir}
       LIMIT ?`,
    )
    .all(...params, limit) as Row[];
  return { rows, cap: limit };
}

/** One report's full detail: report row + target + run knobs + findings (asserted
 *  then excluded) + per-step usage + the rendered report_text. Returns null when
 *  no such report id exists. */
function apiReportDetail(db: DB, id: number, pricing: CostRates): Row | null {
  const report = db
    .prepare(
      `SELECT rep.id, rep.run_id, rep.target_id, rep.tier, rep.tier_source,
              rep.overall_rationale, rep.layperson_summary, rep.technical_summary,
              rep.description_deviates, rep.num_findings, rep.num_excluded,
              rep.input_tokens, rep.output_tokens, rep.estimated_usd, rep.report_text,
              rep.risk_report_json,
              r.kind, r.methodology, r.model, r.verifier_model, r.judge_model,
              r.think, r.mode, r.runs, r.analyzer_version, r.report_schema_version,
              r.git_sha, r.started_at, r.source_path,
              t.sample, t.store_id, t.name, t.version, t.manifest_version,
              t.source_dir, t.is_corpus, t.label_kind, t.expected_tier
       FROM report rep
       JOIN run r    ON r.id = rep.run_id
       JOIN target t ON t.id = rep.target_id
       WHERE rep.id = ?`,
    )
    .get(id) as Row | undefined;
  if (!report) return null;

  const findings = db
    .prepare(
      `SELECT id, finding_id, title, kind, severity, category, finding_type, confidence, claim_type,
              is_verified, exclusion_reason, claimed_mechanism, detail
       FROM finding
       WHERE report_id = ?
       ORDER BY is_verified DESC,
                CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2
                              WHEN 'low' THEN 3 WHEN 'info' THEN 4 ELSE 5 END,
                id`,
    )
    .all(id) as Row[];

  const usage = db
    .prepare(
      `SELECT label, model, calls, input_tokens, output_tokens, wall_clock_ms, estimated_usd
       FROM usage
       WHERE run_id = ? AND (target_id = ? OR target_id IS NULL)
       ORDER BY label, model`,
    )
    .all(report.run_id as number, report.target_id as number) as Row[];
  // Price each step at ITS OWN model — verifier/judge steps may run a different
  // model than the run's headline one, so the run model would misprice them. Only
  // a fallback: a stored per-row estimate (write-time, auditable) always wins.
  for (const u of usage) u.priced_usd = pricedFallback(pricing, u.estimated_usd, u.model, u.input_tokens, u.output_tokens);

  // Lift the structured permissions and destinations sections out of the stored
  // RiskReport so the detail view can render them as proper tables (with doc
  // links / call sites) rather than only inside the preformatted report text.
  // Parse defensively: a malformed or absent json column just yields no panel.
  let permissions: unknown = null;
  let destinations: unknown = null;
  let dismissals: unknown = null;
  const rawRiskReport = report.risk_report_json;
  if (typeof rawRiskReport === "string" && rawRiskReport !== "") {
    try {
      const parsed = JSON.parse(rawRiskReport) as {
        permissions?: unknown;
        destinations?: unknown;
        dismissals?: unknown;
      };
      permissions = parsed.permissions ?? null;
      destinations = parsed.destinations ?? null;
      // Concerns the run checked and cleared — surfaced so a thorough benign run
      // does not render as empty. Absent on reports produced before this field.
      dismissals = Array.isArray(parsed.dismissals) ? parsed.dismissals : null;
    } catch {
      permissions = null;
      destinations = null;
      dismissals = null;
    }
  }
  // Drop the large raw json from the report row — only the lifted slices ship.
  delete report.risk_report_json;
  report.priced_usd = estimateUsd(pricing, report.model, report.input_tokens, report.output_tokens);

  return { report, findings, usage, permissions, destinations, dismissals };
}

// ---- routing ----------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Serve a static file from WEB_ROOT, defaulting "/" to index.html. Path is
 *  normalized and confined to WEB_ROOT (no traversal out of the web dir). */
async function serveStatic(res: ServerResponse, pathname: string): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = normalize(join(WEB_ROOT, rel));
  if (!full.startsWith(WEB_ROOT) || !existsSync(full)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const body = await readFile(full);
  res.writeHead(200, { "content-type": MIME[extname(full)] ?? "application/octet-stream" });
  res.end(body);
}

function handleApi(db: DB, url: URL, res: ServerResponse, pricing: CostRates): void {
  const p = url.pathname;
  const EMPTY_LIST = { rows: [], cap: ROW_CAP };
  const EMPTY_META = { methodologies: [], models: [], kinds: [], tiers: [], severities: [], categories: [], findingTypes: [] };
  if (p === "/api/meta") return sendJson(res, 200, safe(() => apiMeta(db), EMPTY_META));
  if (p === "/api/pricing") return sendJson(res, 200, { rates: pricing, note: PRICING_NOTE });
  if (p === "/api/performance") return sendJson(res, 200, safe(() => ({ rows: apiPerformance(db, pricing) }), { rows: [] }));
  if (p === "/api/rollup") return sendJson(res, 200, safe(() => ({ rows: apiRollup(db, pricing) }), { rows: [] }));
  if (p === "/api/runs") return sendJson(res, 200, safe(() => apiRuns(db, url, pricing), EMPTY_LIST));
  if (p === "/api/extensions") return sendJson(res, 200, safe(() => apiExtensions(db, url), EMPTY_LIST));
  if (p === "/api/extension") {
    const detail = safe(() => apiExtensionDetail(db, url, pricing), null);
    return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: "extension not found" });
  }
  if (p === "/api/reports") return sendJson(res, 200, safe(() => apiReports(db, url, pricing), EMPTY_LIST));
  if (p === "/api/findings") return sendJson(res, 200, safe(() => apiFindings(db, url), EMPTY_LIST));
  const m = p.match(/^\/api\/report\/(\d+)$/);
  if (m) {
    const detail = safe(() => apiReportDetail(db, Number(m[1]), pricing), null);
    return detail ? sendJson(res, 200, detail) : sendJson(res, 404, { error: "report not found" });
  }
  return sendJson(res, 404, { error: "unknown endpoint" });
}

/** Shown verbatim in the UI so a $ figure is never mistaken for a real bill. */
const PRICING_NOTE =
  "Estimated from token counts at the underlying models' published per-token API list pricing " +
  "(Ollama Cloud itself bills by subscription/GPU-time, not per token). A yardstick for comparison, not an invoice.";

function makeHandler(db: DB, pricing: CostRates) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "read-only: GET only" });
      return;
    }
    try {
      if (url.pathname.startsWith("/api/")) {
        handleApi(db, url, res, pricing);
      } else {
        void serveStatic(res, url.pathname).catch(() => {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end("error");
        });
      }
    } catch (e) {
      sendJson(res, 500, { error: (e as Error).message });
    }
  };
}

/** Build the HTTP server bound to a read-only DB. Exported so tests can boot it
 *  on an ephemeral port without a child process. */
export function createDashboardServer(dbPath: string, pricing: CostRates = resolveEffectiveRates()) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const server = createServer(makeHandler(db, pricing));
  server.on("close", () => {
    try { db.close(); } catch { /* already closed */ }
  });
  return server;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.db)) {
    // Read-only open of a non-existent file throws; fail with a clear message.
    console.error(`bake-off DB not found at ${args.db}. Run an assess/reports/scorecard, or pass --db <path>.`);
    process.exit(1);
  }
  let pricing: CostRates;
  try {
    pricing = resolveEffectiveRates(args.costRates);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const server = createDashboardServer(args.db, pricing);
  server.listen(args.port, "127.0.0.1", () => {
    console.log(`Bake-off dashboard:  http://127.0.0.1:${args.port}`);
    console.log(`Serving DB (read-only): ${args.db}`);
    console.log(`Cost estimates: ${Object.keys(pricing).length} model rates (API list pricing; --cost-rates to override)`);
  });
}

// Run only when invoked directly (not when imported by a test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
