// SQL projection shared by local-D1 tests and the Node publisher. No secrets or
// process-control identities are part of this hosted, read-only projection.
import type { DatabaseSync } from "node:sqlite";
import { sanitizeAnalysisDiagnostic } from "./analyses.ts";
import { parseSubmissionConfig } from "./submission-config.ts";
import { validateAnalysisPolicy } from "./analysis-policy.ts";

export const PROGRESS_SCHEMA = `
CREATE TABLE IF NOT EXISTS analysis_projection_source (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), source_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS analysis_projection_identity(id INTEGER PRIMARY KEY AUTOINCREMENT,identity TEXT NOT NULL UNIQUE);
`;

const SUBMISSION_COLUMNS: Record<string, string> = {
  source: "TEXT", priority: "INTEGER NOT NULL DEFAULT 50", origin_id: "INTEGER",
  attempts: "INTEGER NOT NULL DEFAULT 0", not_before: "TEXT", config_json: "TEXT", config_key: "TEXT", batch_id: "TEXT",
  cancel_requested_at: "TEXT", retry_of: "INTEGER", current_attempt_id: "INTEGER",
  progress_revision: "INTEGER NOT NULL DEFAULT 0",
};

/** Run before the current CREATE TABLE/INDEX statements on preserved v5 queues. */
export function progressMigration(columns: string[]): string[] {
  if (!columns.length) return [];
  return Object.entries(SUBMISSION_COLUMNS).filter(([name]) => !columns.includes(name))
    .map(([name, type]) => `ALTER TABLE submission ADD COLUMN ${name} ${type};`);
}

export function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Nonfinite projection value");
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function projectedProfile(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw);
    const arm = (v: unknown) => {
      if (!v || typeof v !== "object") return null;
      const candidate = v as Record<string, unknown>;
      return typeof candidate.methodology === "string" && typeof candidate.model === "string"
        ? { methodology: candidate.methodology, model: candidate.model } : null;
    };
    const pinned = arm(value?.pinned);
    if (!pinned) return null;
    const arms = (list: unknown) => Array.isArray(list) ? list.map(arm).filter(Boolean) : [];
    return JSON.stringify({ pinned, userFallback: arms(value.userFallback), adminReference: arms(value.adminReference), requireStoreBacked: value.requireStoreBacked === true });
  } catch { return null; }
}

export interface ProgressProjection { sourceId: string; revision: number; observedAt: string; statements: string[] }

/** Captures one consistent local snapshot. A local-only job uses a negative
 * ID in the mirror; an ingested job retains every remote user's positive ID.
 * The single-source guard prevents another database reusing those identities.
 * Repeated or out-of-order deliveries cannot regress a newer job or heartbeat.
 */
export function buildProgressProjection(db: DatabaseSync, sourceId: string, revision: number, observedAt: string): ProgressProjection {
  if (!sourceId || !Number.isSafeInteger(revision) || revision < 1 || !Number.isFinite(Date.parse(observedAt))) throw new Error("Invalid progress snapshot identity");
  const statements: string[] = [
    `INSERT OR IGNORE INTO analysis_projection_source(singleton,source_id,revision) VALUES(1,${sqlValue(sourceId)},0);`,
    // Reserve the revision before publishing any payload. Imports can overlap
    // between statements; once a newer snapshot starts, older writes must stop.
    // Equality permits retrying a partially delivered snapshot of this revision.
    `UPDATE analysis_projection_source SET revision=${revision} WHERE singleton=1 AND source_id=${sqlValue(sourceId)} AND revision<=${revision};`,
  ];
  const guard = `EXISTS(SELECT 1 FROM analysis_projection_source WHERE singleton=1 AND source_id=${sqlValue(sourceId)} AND revision=${revision})`;
  const memberships = new Map<number, number[]>();
  if (hasTable(db, "analysis_remote_origin")) {
    for (const row of db.prepare("SELECT remote_id,submission_id FROM analysis_remote_origin").all()) {
      const id = Number(row.submission_id);
      memberships.set(id, [...(memberships.get(id) ?? []), Number(row.remote_id)]);
    }
  }
  const jobs = db.prepare("SELECT * FROM submission ORDER BY id").all();
  const ids = new Map<number, number[]>();
  for (const job of jobs) {
    const localId = Number(job.id);
    // Keep the local analysis URL stable when remote requests later join it.
    // Positive aliases represent those distinct requests; none replaces -localId.
    const remoteIds = memberships.get(localId) ?? (Number(job.origin_id) > 0 ? [Number(job.origin_id)] : []);
    const mapped = [-localId, ...new Set(remoteIds)];
    ids.set(localId, mapped);
    const configuration = parseSubmissionConfig(job.config_json);
    for (const id of mapped) {
      const reportId = Number(job.result_report_id) || null;
      const runHash = reportId ? db.prepare("SELECT r.run_hash FROM report rp JOIN run r ON r.id=rp.run_id WHERE rp.id=?").get(reportId)?.run_hash : null;
      const result = reportId && runHash ? `(SELECT rp.id FROM report rp JOIN target t ON t.id=rp.target_id JOIN run r ON r.id=rp.run_id WHERE rp.id=${reportId} AND t.store_id=${sqlValue(job.store_id)} AND r.run_hash=${sqlValue(runHash)})` : "NULL";
      const row: Record<string, unknown> = {
        id, input_raw: job.store_id ?? "", store_id: job.store_id, status: job.status,
        profile_json: projectedProfile(job.profile_json), created_at: job.created_at, started_at: job.started_at,
        finished_at: job.finished_at, error: sanitizeAnalysisDiagnostic(job.error),
        source: job.source, priority: job.priority ?? 50, attempts: job.attempts ?? 0,
        not_before: job.not_before, config_json: configuration ? JSON.stringify(configuration) : null,
        batch_id: job.batch_id, cancel_requested_at: job.cancel_requested_at,
        retry_of: job.retry_of ? (ids.get(Number(job.retry_of))?.[0] ?? -Number(job.retry_of)) : null,
        current_attempt_id: job.current_attempt_id ? -Number(job.current_attempt_id) : null,
        progress_revision: revision,
      };
      const columns = Object.keys(row);
      // Preserve the deployed requester's identity and original input on updates.
      const updates = columns.filter(c => !["id", "input_raw", "created_at"].includes(c)).map(c => `${c}=excluded.${c}`);
      statements.push(`INSERT INTO submission(${columns.join(",")},result_report_id) SELECT ${Object.values(row).map(sqlValue).join(",")},${result} WHERE ${guard} ON CONFLICT(id) DO UPDATE SET ${updates.join(",")},result_report_id=${result} WHERE submission.progress_revision<=${revision};`);
    }
  }
  // A shared remote job has one attempt/event stream per remote submission.
  // Mirror IDs are generated from (local event, remote job) via stable text keys
  // rather than numeric multiplication that could overflow safe integers.
  for (const table of ["analysis_attempt", "analysis_event"] as const) {
    if (!hasTable(db, table)) continue;
    for (const original of db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()) {
      const mapped = ids.get(Number(original.submission_id)) ?? [];
      for (const id of mapped) {
        const row: Record<string, unknown> = { ...original, submission_id: id };
        delete row.id;
        if (table === "analysis_attempt") {
          row.executor_token = "hosted-observation";
          row.error = sanitizeAnalysisDiagnostic(row.error);
        } else {
          row.message = sanitizeAnalysisDiagnostic(row.message) ?? "Analysis update";
          // Resolve the matching mirrored attempt after its insert above.
          delete row.attempt_id;
        }
        const columns = Object.keys(row);
        const key = `${table}:${original.id}:${id}`;
        statements.push(`INSERT OR IGNORE INTO analysis_projection_identity(identity) SELECT ${sqlValue(key)} WHERE ${guard};`);
        const mirroredId = `-(SELECT id FROM analysis_projection_identity WHERE identity=${sqlValue(key)})`;
        const attempt = table === "analysis_event" && original.attempt_id
          ? `-(SELECT id FROM analysis_projection_identity WHERE identity=${sqlValue(`analysis_attempt:${original.attempt_id}:${id}`)})` : "NULL";
        statements.push(`INSERT INTO ${table}(id,${columns.join(",")}${table === "analysis_event" ? ",attempt_id" : ""}) SELECT ${mirroredId},${Object.values(row).map(sqlValue).join(",")}${table === "analysis_event" ? `,${attempt}` : ""} WHERE ${guard} ON CONFLICT(id) DO UPDATE SET ${columns.map(c => `${c}=excluded.${c}`).join(",")}${table === "analysis_event" ? ",attempt_id=excluded.attempt_id" : ""};`);
        if (table === "analysis_attempt" && jobs.find(j => Number(j.id) === Number(original.submission_id))?.current_attempt_id === original.id) {
          statements.push(`UPDATE submission SET current_attempt_id=${mirroredId} WHERE id=${id} AND ${guard};`);
        }
      }
    }
  }
  if (hasTable(db, "analysis_batch_item")) {
    for (const row of db.prepare("SELECT * FROM analysis_batch_item").all()) {
      for (const id of ids.get(Number(row.submission_id)) ?? []) statements.push(`INSERT OR IGNORE INTO analysis_batch_item(batch_id,submission_id,created_at) SELECT ${sqlValue(row.batch_id)},${id},${sqlValue(row.created_at)} WHERE ${guard};`);
    }
  }
  const stateKeys = ["manual_pause", "backoff_until", "paused_until", "analysis_policy", "last_sync_at", "last_ingest_at", "dirty_for_sync", "executor_heartbeat"];
  for (const key of stateKeys) {
    const state = db.prepare("SELECT value FROM runner_state WHERE key=?").get(key);
    let value = state?.value;
    if (key === "analysis_policy" && typeof value === "string") {
      try { value = JSON.stringify(validateAnalysisPolicy(JSON.parse(value))); } catch { value = null; }
    }
    if (key === "executor_heartbeat" && typeof value === "string") {
      try {
        const h = JSON.parse(value);
        value = typeof h.at === "string" && Number.isFinite(Date.parse(h.at)) && ["active", "stopped"].includes(h.state)
          ? JSON.stringify({ at: h.at, state: h.state }) : null;
      } catch { value = null; }
    }
    if (key === "dirty_for_sync" && value !== "1") value = null;
    if (key === "manual_pause" && value !== "1" && value !== "0") value = null;
    if (["backoff_until", "paused_until", "last_sync_at", "last_ingest_at"].includes(key) && (typeof value !== "string" || !Number.isFinite(Date.parse(value)))) value = null;
    if (value != null) statements.push(`INSERT INTO runner_state(key,value,updated_at) SELECT ${sqlValue(key)},${sqlValue(value)},${sqlValue(observedAt)} WHERE ${guard} ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;`);
    else statements.push(`DELETE FROM runner_state WHERE key=${sqlValue(key)} AND ${guard};`);
  }
  for (const key of ["progress_observed_at", "progress_synced_at"]) statements.push(`INSERT INTO runner_state(key,value,updated_at) SELECT ${sqlValue(key)},${sqlValue(observedAt)},${sqlValue(observedAt)} WHERE ${guard} ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;`);
  return { sourceId, revision, observedAt, statements };
}
