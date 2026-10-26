// Bake-off DB: open a SQLite file and record analysis runs into it. This is the
// ONE seam both the live CLIs (assess / reports / scorecard) and the backfill
// `npm run ingest` use, so however a run reaches the DB the rows look identical.
//
// recordRun() is IDEMPOTENT: every run is keyed by a content hash over its knobs
// + provenance (started_at, source_path). Re-recording the same run replaces it
// (cascade-delete + re-insert) rather than duplicating — so a backfill is safe
// to re-run, and a deterministic REPLAY re-run does not pile up dupes. Live runs
// pass a wall-clock started_at, which makes each invocation distinct.
//
// Inputs are loosely typed and read DEFENSIVELY: backfill feeds heterogeneous
// JSON written across the project's history, so a missing/renamed field degrades
// one column to NULL instead of throwing.

import { outcomeFromStructured } from "../report/outcome.ts";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.ts";

export class DbError extends Error {}

// ---- input contracts (loose by design) -------------------------------------

export interface UsageLine {
  label: string;
  model: string;
  calls?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  wallClockMs?: number | null;
  estimatedUsd?: number | null;
}

export interface DbTargetInput {
  sample?: string | null;
  storeId?: string | null;
  name?: string | null;
  version?: string | null;
  manifestVersion?: number | null;
  sourceDir?: string | null;
  isCorpus: boolean;
  labelKind?: string | null;
  expectedTier?: string | null;

  tier?: string | null;
  tierSource?: string | null;
  /** Free-form rendered report text. */
  report?: string | null;
  /** Full arm-specific structured trace; a RiskReport is extracted from it when present. */
  structured?: unknown;
  /** Already-extracted RiskReport; overrides extraction from `structured`. */
  riskReport?: Record<string, unknown> | null;
  usage?: { inputTokens?: number; outputTokens?: number; wallClockMs?: number } | null;
  /** Per-step usage attributed to this target (single-extension assess runs). */
  usageByStep?: UsageLine[] | null;
  estimatedUsd?: number | null;
}

export interface DbSampleScoreInput {
  sample: string;
  labelKind?: string | null;
  expectedTier?: string | null;
  normalizedTier?: string | null;
  tierSource?: string | null;
  coverage?: number | null;
  missKind?: string | null;
  falseAlarm?: boolean | null;
  mustDetect?: unknown;
  mustNotEmit?: unknown;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export interface DbScorecardInput {
  coverageKnownShapes?: number | null;
  coverageOpenWorld?: number | null;
  tierRecall?: number | null;
  unsafeMisses?: number | null;
  falseDismissals?: number | null;
  hedgedMisses?: number | null;
  falseAlarmCount?: number | null;
  stability?: string | number | null;
  bellwether?: { B?: number | null; E?: number | null; G?: number | null; per_arm_missed?: boolean } | null;
  h?: { detected?: boolean; coverage?: number | null; tier_masked?: boolean } | null;
  totalInputTokens?: number | null;
  totalOutputTokens?: number | null;
  estimatedUsd?: number | null;
  raw?: unknown;
  /** Run-level usage accounting (per step), when available. */
  usageByStep?: UsageLine[] | null;
  samples?: DbSampleScoreInput[];
}

export interface RunInput {
  kind: "assess" | "reports" | "scorecard";
  methodology: string;
  model: string;
  verifierModel?: string | null;
  judgeModel?: string | null;
  think?: string | null;
  mode?: string | null;
  /** True when the Pi arm's model I/O was routed through the headroom compression proxy. */
  headroom?: boolean | null;
  /** Pi sharded fan-out: effective model per dimension + synthesis. NULL when monolithic. */
  subagentModels?: Record<string, string> | null;
  runs?: number | null;
  tierRecall?: boolean | null;
  analyzerVersion?: string | null;
  reportSchemaVersion?: string | null;
  corpusDir?: string | null;
  fixturesDir?: string | null;
  costRates?: unknown;
  gitSha?: string | null;
  /** ISO 8601 — live runs pass wall-clock now(); backfill passes file mtime. */
  startedAt: string;
  /** Backfill provenance: the file or dir this run was reconstructed from. */
  sourcePath?: string | null;
  extra?: Record<string, unknown>;
  targets: DbTargetInput[];
  scorecard?: DbScorecardInput | null;
}

// ---- coercion helpers (tolerant of malformed/absent fields) -----------------

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function bool01(v: unknown): number | null {
  return typeof v === "boolean" ? (v ? 1 : 0) : null;
}
function jsonOrNull(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v);
}
function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Pull the structured RiskReport out of an arm's trace, wherever it nests it
 *  (monolith: `structured.risk_report`; dag/agentic: `structured.dag.risk_report`). */
export function extractRiskReport(structured: unknown): Record<string, unknown> | null {
  if (!isObj(structured)) return null;
  if (isObj(structured.risk_report)) {
    const outcome = outcomeFromStructured(structured);
    return outcome ? { ...structured.risk_report, outcome } : structured.risk_report;
  }
  if (isObj(structured.dag) && isObj(structured.dag.risk_report)) return structured.dag.risk_report;
  return null;
}

/** Best-effort current commit; null when not in a repo / git unavailable. */
export function resolveGitSha(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

// ---- open / migrate ---------------------------------------------------------

/** Open (creating if needed) the bake-off DB at `path`, applying the schema.
 *  Throws DbError if the file was written by a newer SCHEMA_VERSION. */
export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  // Concurrent assess processes record here at end-of-run; wait out a
  // concurrent writer instead of failing with "database is locked".
  db.exec("PRAGMA busy_timeout = 10000");
  // Migrate BEFORE applying SCHEMA_SQL: the DDL includes indexes over columns
  // that migrations add (e.g. idx_submission_claim on submission.priority), so
  // an older file must be brought forward first. Fresh files have no
  // schema_meta yet and skip straight to the DDL.
  const hasMeta = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
    .get() as { name: string } | undefined;
  const row = hasMeta
    ? (db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined)
    : undefined;
  const found = row ? Number(row.value) : null;
  if (found !== null && found > SCHEMA_VERSION) {
    db.close();
    throw new DbError(
      `DB at ${path} has schema v${found}, newer than this build's v${SCHEMA_VERSION}. Use a newer build or a fresh --db path.`,
    );
  }
  // found < SCHEMA_VERSION: forward migrations land here. v1 is the floor.
  if (found !== null && found < SCHEMA_VERSION) migrate(db, found);
  db.exec(SCHEMA_SQL);
  if (found === null) {
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  } else if (found < SCHEMA_VERSION) {
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
  }
  return db;
}

/** Apply forward DDL migrations for a DB opened at version `from`. Each step is
 *  idempotent (additive columns guarded against a re-applied step). */
function migrate(db: DatabaseSync, from: number): void {
  if (from < 8 && db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'submission'").get()) {
    const cols = db.prepare("PRAGMA table_info(submission)").all() as Array<{ name: string }>;
    for (const [column, type] of [["cancel_requested_at", "TEXT"], ["retry_of", "INTEGER"], ["current_attempt_id", "INTEGER"]]) {
      if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE submission ADD COLUMN ${column} ${type}`);
    }
  }
  if (from < 7 && db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'submission'").get()) {
    const cols = db.prepare("PRAGMA table_info(submission)").all() as Array<{ name: string }>;
    for (const column of ["config_json", "config_key", "batch_id"]) {
      if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE submission ADD COLUMN ${column} TEXT`);
    }
  }
  // v1 → v2: finding.finding_type (threat-class). CREATE TABLE IF NOT EXISTS
  // won't add a column to an existing table, so add it explicitly.
  if (from < 2) {
    const cols = db.prepare("PRAGMA table_info(finding)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "finding_type")) {
      db.exec("ALTER TABLE finding ADD COLUMN finding_type TEXT");
    }
  }
  // v2 → v3: run.headroom (was the Pi arm routed through the compression proxy).
  if (from < 3) {
    const cols = db.prepare("PRAGMA table_info(run)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "headroom")) {
      db.exec("ALTER TABLE run ADD COLUMN headroom INTEGER");
    }
  }
  // v3 → v4: run.subagent_models (Pi sharded fan-out: JSON model map).
  if (from < 4) {
    const cols = db.prepare("PRAGMA table_info(run)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "subagent_models")) {
      db.exec("ALTER TABLE run ADD COLUMN subagent_models TEXT");
    }
  }
  // v4 → v5: the Explorer's submission job table. Purely additive; the CREATE
  // TABLE IF NOT EXISTS in SCHEMA_SQL (already executed by openDb) creates it,
  // so this step exists only to document the version bump.
  // v5 → v6: unified-queue columns on submission (LOCAL DB only — the deployed
  // D1 submission table stays v5-shaped, see the schema comment). ledger_event
  // and runner_state arrive via SCHEMA_SQL's CREATE TABLE IF NOT EXISTS.
  if (from < 6) {
    // A pre-v5 file may not have the submission table yet; SCHEMA_SQL (run
    // after migrations) then creates it already v6-shaped.
    const hasSubmission = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'submission'")
      .get();
    if (hasSubmission) {
      const cols = db.prepare("PRAGMA table_info(submission)").all() as Array<{ name: string }>;
      const has = (n: string) => cols.some((c) => c.name === n);
      if (!has("source")) db.exec("ALTER TABLE submission ADD COLUMN source TEXT");
      if (!has("priority")) db.exec("ALTER TABLE submission ADD COLUMN priority INTEGER NOT NULL DEFAULT 50");
      if (!has("origin_id")) db.exec("ALTER TABLE submission ADD COLUMN origin_id INTEGER");
      if (!has("attempts")) db.exec("ALTER TABLE submission ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
      if (!has("not_before")) db.exec("ALTER TABLE submission ADD COLUMN not_before TEXT");
      // Pre-v6 rows all came from the Explorer submit flow.
      db.exec("UPDATE submission SET source = 'user' WHERE source IS NULL");
    }
  }
}

// ---- record -----------------------------------------------------------------

function computeRunHash(input: RunInput): string {
  // Stable identity: knobs + versions + provenance. started_at distinguishes
  // genuine re-runs (live, wall-clock now) while source_path + mtime keeps a
  // backfill of the same artifact idempotent.
  const identity = {
    kind: input.kind,
    methodology: input.methodology,
    model: input.model,
    verifierModel: input.verifierModel ?? null,
    judgeModel: input.judgeModel ?? null,
    think: input.think ?? null,
    mode: input.mode ?? null,
    headroom: input.headroom ?? null,
    subagentModels: input.subagentModels ?? null,
    runs: input.runs ?? null,
    analyzerVersion: input.analyzerVersion ?? null,
    reportSchemaVersion: input.reportSchemaVersion ?? null,
    corpusDir: input.corpusDir ?? null,
    fixturesDir: input.fixturesDir ?? null,
    startedAt: input.startedAt,
    sourcePath: input.sourcePath ?? null,
    targets: input.targets.map((t) => t.sample ?? t.storeId ?? t.sourceDir ?? null),
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function insertFindings(db: DatabaseSync, reportId: number, riskReport: Record<string, unknown> | null): { findings: number; excluded: number } {
  if (!riskReport) return { findings: 0, excluded: 0 };
  const stmt = db.prepare(
    `INSERT INTO finding
      (report_id, finding_id, title, kind, severity, category, finding_type, confidence, claim_type,
       is_verified, exclusion_reason, claimed_mechanism, detail, evidence_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const asserted = Array.isArray(riskReport.findings) ? riskReport.findings : [];
  for (const f of asserted) {
    if (!isObj(f)) continue;
    stmt.run(
      reportId,
      str(f.id),
      str(f.title),
      str(f.kind),
      str(f.severity),
      str(f.category),
      str(f.finding_type),
      str(f.confidence),
      str(f.claim_type),
      1,
      null,
      str(f.claimed_mechanism),
      str(f.detail),
      jsonOrNull(f.evidence_refs),
    );
  }
  const excluded = Array.isArray(riskReport.excluded_claims) ? riskReport.excluded_claims : [];
  for (const f of excluded) {
    if (!isObj(f)) continue;
    stmt.run(
      reportId,
      str(f.id),
      str(f.title),
      null, // kind
      null, // severity
      null, // category
      null, // finding_type
      null, // confidence
      str(f.claim_type),
      0,
      str(f.reason),
      str(f.claimed_mechanism),
      str(f.detail),
      jsonOrNull(f.evidence_refs),
    );
  }
  // Portable skill candidates are searchable records, but never asserted or
  // verified findings. Preserve the agent's classifications as candidate data.
  const imported = isObj(riskReport.skill_review) ? riskReport.skill_review : null;
  const review = imported && isObj(imported.review) ? imported.review : null;
  const candidates = review && Array.isArray(review.findings) ? review.findings : [];
  for (const f of candidates) {
    if (!isObj(f)) continue;
    stmt.run(reportId, str(f.id), str(f.title), "candidate", str(f.severity), str(f.category),
      str(f.finding_type), str(f.confidence), str(f.claim_type), 0, "not-verified",
      str(f.claimed_mechanism), str(f.detail), jsonOrNull(f.evidence_refs));
  }
  return { findings: asserted.length, excluded: excluded.length + candidates.length };
}

function insertUsage(db: DatabaseSync, runId: number, targetId: number | null, lines: UsageLine[] | null | undefined): void {
  if (!lines || lines.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO usage (run_id, target_id, label, model, calls, input_tokens, output_tokens, wall_clock_ms, estimated_usd)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (const l of lines) {
    stmt.run(
      runId,
      targetId,
      l.label ?? "",
      l.model ?? "",
      num(l.calls),
      num(l.inputTokens),
      num(l.outputTokens),
      num(l.wallClockMs),
      num(l.estimatedUsd),
    );
  }
}

/** Record one run and all its children. Returns the run row id. Idempotent on
 *  run_hash: an existing run with the same hash is replaced. */
export function recordRun(db: DatabaseSync, input: RunInput): number {
  const runHash = computeRunHash(input);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM run WHERE run_hash = ?").run(runHash);
    const runRes = db
      .prepare(
        `INSERT INTO run
          (run_hash, kind, methodology, model, verifier_model, judge_model, think, mode, headroom, subagent_models, runs, tier_recall,
           analyzer_version, report_schema_version, corpus_dir, fixtures_dir, cost_rates_json, git_sha,
           started_at, source_path, raw_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        runHash,
        input.kind,
        input.methodology,
        input.model,
        str(input.verifierModel),
        str(input.judgeModel),
        str(input.think),
        str(input.mode),
        bool01(input.headroom ?? null),
        jsonOrNull(input.subagentModels ?? null),
        num(input.runs),
        bool01(input.tierRecall ?? null),
        str(input.analyzerVersion),
        str(input.reportSchemaVersion),
        str(input.corpusDir),
        str(input.fixturesDir),
        jsonOrNull(input.costRates),
        str(input.gitSha),
        input.startedAt,
        str(input.sourcePath),
        jsonOrNull(input.extra ?? null),
      );
    const runId = Number(runRes.lastInsertRowid);

    const targetStmt = db.prepare(
      `INSERT INTO target
        (run_id, sample, store_id, name, version, manifest_version, source_dir, is_corpus, label_kind, expected_tier)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    const reportStmt = db.prepare(
      `INSERT INTO report
        (run_id, target_id, tier, tier_source, overall_rationale, layperson_summary, technical_summary,
         description_deviates, num_findings, num_excluded, input_tokens, output_tokens, estimated_usd,
         report_text, risk_report_json, structured_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );

    // Map sample name → target id, so scorecard sample_score rows can link back.
    const targetBySample = new Map<string, number>();

    for (const t of input.targets) {
      const rr = t.riskReport ?? extractRiskReport(t.structured);
      const ext = isObj(rr) && isObj(rr.extension) ? rr.extension : null;
      const tRes = targetStmt.run(
        runId,
        str(t.sample),
        str(t.storeId) ?? (ext ? str(ext.store_id) : null),
        str(t.name) ?? (ext ? str(ext.name) : null),
        str(t.version) ?? (ext ? str(ext.version) : null),
        t.manifestVersion ?? (ext ? num(ext.manifest_version) : null),
        str(t.sourceDir),
        t.isCorpus ? 1 : 0,
        str(t.labelKind),
        str(t.expectedTier),
      );
      const targetId = Number(tRes.lastInsertRowid);
      if (t.sample) targetBySample.set(t.sample, targetId);

      const verdict = isObj(rr) && isObj(rr.verdict) ? rr.verdict : null;
      const summaries = isObj(rr) && isObj(rr.summaries) ? rr.summaries : null;
      const devDev = isObj(rr) && isObj(rr.description_deviation) ? rr.description_deviation : null;
      const asserted = isObj(rr) && Array.isArray(rr.findings) ? rr.findings.length : null;
      const excluded = isObj(rr) && Array.isArray(rr.excluded_claims) ? rr.excluded_claims.length : null;

      const rRes = reportStmt.run(
        runId,
        targetId,
        str(t.tier) ?? (verdict ? str(verdict.tier) : null),
        str(t.tierSource),
        verdict ? str(verdict.rationale) : null,
        summaries ? str(summaries.layperson) : null,
        summaries ? str(summaries.technical) : null,
        devDev ? bool01(devDev.deviates ?? null) : null,
        asserted,
        excluded,
        num(t.usage?.inputTokens),
        num(t.usage?.outputTokens),
        num(t.estimatedUsd),
        str(t.report),
        jsonOrNull(rr),
        jsonOrNull(t.structured ?? null),
      );
      const reportId = Number(rRes.lastInsertRowid);

      insertFindings(db, reportId, isObj(rr) ? rr : null);
      insertUsage(db, runId, targetId, t.usageByStep);
    }

    if (input.scorecard) {
      const sc = input.scorecard;
      db.prepare(
        `INSERT INTO scorecard
          (run_id, coverage_known_shapes, coverage_open_world, tier_recall, unsafe_misses, false_dismissals,
           hedged_misses, false_alarm_count, stability, bellwether_b, bellwether_e, bellwether_g, per_arm_missed,
           h_detected, h_coverage, h_tier_masked, total_input_tokens, total_output_tokens, estimated_usd, raw_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        runId,
        num(sc.coverageKnownShapes),
        num(sc.coverageOpenWorld),
        num(sc.tierRecall),
        num(sc.unsafeMisses),
        num(sc.falseDismissals),
        num(sc.hedgedMisses),
        num(sc.falseAlarmCount),
        sc.stability === undefined || sc.stability === null ? null : String(sc.stability),
        num(sc.bellwether?.B ?? null),
        num(sc.bellwether?.E ?? null),
        num(sc.bellwether?.G ?? null),
        bool01(sc.bellwether?.per_arm_missed ?? null),
        bool01(sc.h?.detected ?? null),
        num(sc.h?.coverage ?? null),
        bool01(sc.h?.tier_masked ?? null),
        num(sc.totalInputTokens),
        num(sc.totalOutputTokens),
        num(sc.estimatedUsd),
        jsonOrNull(sc.raw ?? null),
      );
      insertUsage(db, runId, null, sc.usageByStep);

      const ssStmt = db.prepare(
        `INSERT INTO sample_score
          (run_id, target_id, sample, label_kind, expected_tier, normalized_tier, tier_source, coverage,
           miss_kind, false_alarm, must_detect_json, must_not_emit_json, input_tokens, output_tokens)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const s of sc.samples ?? []) {
        ssStmt.run(
          runId,
          targetBySample.get(s.sample) ?? null,
          s.sample,
          str(s.labelKind),
          str(s.expectedTier),
          str(s.normalizedTier),
          str(s.tierSource),
          num(s.coverage),
          str(s.missKind),
          bool01(s.falseAlarm ?? null),
          jsonOrNull(s.mustDetect ?? null),
          jsonOrNull(s.mustNotEmit ?? null),
          num(s.inputTokens),
          num(s.outputTokens),
        );
      }
    }

    db.exec("COMMIT");
    return runId;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
