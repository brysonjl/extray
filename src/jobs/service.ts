// Submission jobs: create / read / claim / complete rows in the `submission`
// table — the unified analysis queue. The Explorer API (local Node AND the
// deployed D1 Worker) creates rows; only the LOCAL runner daemon claims and
// completes them. The queue columns added in schema v6 (source, priority,
// origin_id, attempts, not_before) exist only in the local DB — the deployed
// D1 table stays v5-shaped — so writes only reference them when a value is
// actually supplied, and reads tolerate their absence.

import { appendAnalysisEvent } from "./events.ts";
import type { DataSource, Row } from "../product/datasource.ts";
import type { ProductionProfile } from "../product/profile.ts";
import { configurationKey, parseSubmissionConfig, type SubmissionConfig } from "../product/submission-config.ts";

export type SubmissionStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** Who put the job in the queue; drives priority + failure write-back. */
export type SubmissionSource = "user" | "remote" | "discovery" | "admin";

export interface SubmissionRow {
  id: number;
  inputRaw: string;
  storeId: string | null;
  status: SubmissionStatus;
  requestedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  resultReportId: number | null;
  source: SubmissionSource | null;
  priority: number;
  originId: number | null;
  attempts: number;
  notBefore: string | null;
  configuration?: SubmissionConfig | null;
  batchId?: string | null;
  /** A malformed snapshot must fail, never silently fall back to mutable defaults. */
  hasConfiguration?: boolean;
  cancelRequestedAt?: string | null;
  retryOf?: number | null;
  currentAttemptId?: number | null;
}

export class SubmissionQuotaError extends Error {
  constructor() {
    super("daily submission limit reached — try again later");
    this.name = "SubmissionQuotaError";
  }
}

function toSubmission(r: Row): SubmissionRow {
  return {
    id: r.id as number,
    inputRaw: r.input_raw as string,
    storeId: (r.store_id as string | null) ?? null,
    status: r.status as SubmissionStatus,
    requestedBy: (r.requested_by as string | null) ?? null,
    createdAt: r.created_at as string,
    startedAt: (r.started_at as string | null) ?? null,
    finishedAt: (r.finished_at as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    resultReportId: (r.result_report_id as number | null) ?? null,
    // v6 queue columns: absent on D1 rows (v5-shaped) → defaults.
    source: (r.source as SubmissionSource | null) ?? null,
    priority: typeof r.priority === "number" ? r.priority : 50,
    originId: (r.origin_id as number | null) ?? null,
    attempts: typeof r.attempts === "number" ? r.attempts : 0,
    notBefore: (r.not_before as string | null) ?? null,
    configuration: parseSubmissionConfig(r.config_json),
    hasConfiguration: r.config_json != null,
    batchId: (r.batch_id as string | null) ?? null,
    cancelRequestedAt: (r.cancel_requested_at as string | null) ?? null,
    retryOf: (r.retry_of as number | null) ?? null,
    currentAttemptId: (r.current_attempt_id as number | null) ?? null,
  };
}

export async function createSubmission(
  ds: DataSource,
  input: {
    inputRaw: string;
    storeId: string;
    profile: ProductionProfile;
    requestedBy?: string | null;
    now?: Date;
    /** v6 queue fields — LOCAL DB only. Omit when writing to deployed D1. */
    source?: SubmissionSource;
    priority?: number;
    originId?: number | null;
    configuration?: SubmissionConfig;
    batchId?: string;
    /** Join an active job for this store (or this exact configuration). */
    deduplicate?: boolean;
    /** Admission and the insert share one SQL statement in SQLite and D1. */
    quota?: { limit: number; since: string };
  },
): Promise<SubmissionRow> {
  const createdAt = (input.now ?? new Date()).toISOString();
  const cols = ["input_raw", "store_id", "status", "profile_json", "requested_by", "created_at"];
  const vals: Array<string | number | null> = [
    input.inputRaw,
    input.storeId,
    "queued",
    JSON.stringify(input.profile),
    input.requestedBy ?? null,
    createdAt,
  ];
  if (input.source !== undefined) {
    cols.push("source");
    vals.push(input.source);
  }
  if (input.priority !== undefined) {
    cols.push("priority");
    vals.push(input.priority);
  }
  if (input.originId !== undefined && input.originId !== null) {
    cols.push("origin_id");
    vals.push(input.originId);
  }
  if (input.configuration) {
    cols.push("config_json", "config_key");
    vals.push(JSON.stringify(input.configuration), configurationKey(input.configuration));
  }
  if (input.batchId) { cols.push("batch_id"); vals.push(input.batchId); }
  const placeholders = cols.map(() => "?").join(",");
  const guards: string[] = [];
  const guardParams: Array<string | number> = [];
  if (input.configuration || input.deduplicate) {
    guards.push(`NOT EXISTS (SELECT 1 FROM submission WHERE store_id = ?${input.configuration ? " AND config_key = ?" : ""} AND status IN ('queued','running'))`);
    guardParams.push(input.storeId);
    if (input.configuration) guardParams.push(configurationKey(input.configuration));
  }
  if (input.quota) {
    if (!input.requestedBy || !Number.isSafeInteger(input.quota.limit) || input.quota.limit < 1) {
      throw new Error("Submission quota requires an identity and a positive integer limit");
    }
    guards.push("(SELECT COUNT(*) FROM submission WHERE requested_by = ? AND created_at >= ?) < ?");
    guardParams.push(input.requestedBy, input.quota.since, input.quota.limit);
  }
  // A read followed by an INSERT races across requests/isolate instances. A
  // single conditional INSERT makes quota consumption and dedup atomic at the
  // database, using the same SQL on the Node and Cloudflare adapters.
  const res = await ds.run(
    `INSERT INTO submission (${cols.join(", ")}) SELECT ${placeholders}${guards.length ? ` WHERE ${guards.join(" AND ")}` : ""}`,
    ...vals, ...guardParams,
  );
  if (!res.changes) {
    // Joining existing work must remain possible even when the caller's quota
    // is full. Only a newly inserted job consumes a slot or emits an event.
    const existing = input.configuration
      ? await findConfiguredSubmission(ds, input.storeId, input.configuration)
      : input.deduplicate ? await findActiveSubmission(ds, input.storeId) : null;
    if (existing) return existing;
    if (input.quota) throw new SubmissionQuotaError();
    throw new Error("The active analysis changed during submission; please retry.");
  }
  await appendAnalysisEvent(ds, res.lastInsertRowid, { kind: "submitted", message: "Analysis submitted", now: input.now });
  return (await getSubmission(ds, res.lastInsertRowid))!;
}

export async function findConfiguredSubmission(ds: DataSource, storeId: string, configuration: SubmissionConfig): Promise<SubmissionRow | null> {
  const row = await ds.get(
    "SELECT * FROM submission WHERE store_id = ? AND config_key = ? AND status IN ('queued','running') ORDER BY id LIMIT 1",
    storeId, configurationKey(configuration),
  );
  return row ? toSubmission(row) : null;
}

export async function getSubmission(ds: DataSource, id: number): Promise<SubmissionRow | null> {
  const row = await ds.get("SELECT * FROM submission WHERE id = ?", id);
  return row ? toSubmission(row) : null;
}

/** A live (queued/running) job for the same extension — the dedup
 *  short-circuit: submitting an ID that's already in flight joins that job. */
export async function findActiveSubmission(ds: DataSource, storeId: string): Promise<SubmissionRow | null> {
  const row = await ds.get(
    `SELECT * FROM submission WHERE store_id = ? AND status IN ('queued','running')
     ORDER BY created_at ASC LIMIT 1`,
    storeId,
  );
  return row ? toSubmission(row) : null;
}

/** Atomically claim the most eligible queued job (mark it running): highest
 *  priority first, oldest first within a priority, skipping rows whose
 *  not_before backoff hasn't elapsed. Single UPDATE so two claimants never get
 *  the same row. LOCAL DB only (references v6 columns). Returns null when
 *  nothing is claimable. */
export async function claimNextSubmission(ds: DataSource, now: Date = new Date()): Promise<SubmissionRow | null> {
  const iso = now.toISOString();
  const row = await ds.get(
    `UPDATE submission SET status = 'running', started_at = ?
     WHERE id = (SELECT id FROM submission
                 WHERE status = 'queued' AND (not_before IS NULL OR not_before <= ?)
                 ORDER BY priority DESC, created_at ASC, id ASC LIMIT 1)
       AND COALESCE(
         (SELECT CASE value WHEN '1' THEN 1 WHEN '0' THEN 0 END FROM runner_state WHERE key='manual_pause'),
         (SELECT json_extract(value,'$.paused') FROM runner_state WHERE key='analysis_policy'), 0) = 0
     RETURNING *`,
    iso,
    iso,
  );
  if (!row) return null;
  const owner = await ds.get("SELECT value FROM runner_state WHERE key='executor_owner'");
  let token: string | null = null;
  try { token = JSON.parse(String(owner?.value)).token ?? null; } catch { /* Historical/unmanaged execution. */ }
  const attempt = await ds.run("INSERT INTO analysis_attempt (submission_id,executor_token,status,started_at) VALUES (?,?,'running',?)", row.id as number, token, iso);
  await ds.run("UPDATE submission SET current_attempt_id=? WHERE id=? AND status='running'", attempt.lastInsertRowid, row.id as number);
  await appendAnalysisEvent(ds, row.id as number, { kind: "started", message: "Executor started analysis", attemptId: attempt.lastInsertRowid, now });
  return toSubmission({ ...row, current_attempt_id: attempt.lastInsertRowid });
}

/** Put a claimed job back in the queue after a transient failure (rate limit):
 *  running → queued, attempts+1, claimable again at `notBefore`. */
export async function requeueSubmission(
  ds: DataSource,
  id: number,
  opts: { notBefore: Date },
): Promise<void> {
  const row = await ds.get(`UPDATE submission SET status = CASE WHEN cancel_requested_at IS NULL THEN 'queued' ELSE 'cancelled' END,
    finished_at = CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE ? END, started_at = NULL,
    attempts = attempts + 1, not_before = ? WHERE id = ? AND status = 'running' RETURNING *`, new Date().toISOString(), opts.notBefore.toISOString(), id);
  if (row) {
    await ds.run("UPDATE analysis_attempt SET status=?,finished_at=? WHERE id=? AND status='running'", row.status === "cancelled" ? "cancelled" : "retry-delay", new Date().toISOString(), (row.current_attempt_id as number | null) ?? null);
    await appendAnalysisEvent(ds, id, { kind: row.status === "cancelled" ? "cancelled" : "retry-delay", message: row.status === "cancelled" ? "Cancellation acknowledged after execution ended" : `Retry scheduled after ${opts.notBefore.toISOString()}`, attemptId: row.current_attempt_id as number | null });
  }
}

/** Boot-time crash recovery: exactly one runner exists, so any `running` row at
 *  startup is an orphan from a crashed run — requeue them all. Returns how many
 *  rows were recovered. */
export async function resetRunning(ds: DataSource): Promise<number> {
  const rows = await ds.all("SELECT id,current_attempt_id,cancel_requested_at FROM submission WHERE status='running'");
  for (const row of rows) {
    const at = new Date().toISOString();
    await ds.run("UPDATE analysis_attempt SET status='interrupted',finished_at=?,error='Executor stopped before acknowledgement' WHERE id=? AND status='running'", at, (row.current_attempt_id as number | null) ?? null);
    const recovered = await ds.get(`UPDATE submission SET status=CASE WHEN cancel_requested_at IS NULL THEN 'queued' ELSE 'cancelled' END,
      started_at=NULL,finished_at=CASE WHEN cancel_requested_at IS NULL THEN NULL ELSE ? END WHERE id=? AND status='running' RETURNING status`, at, row.id as number);
    if (!recovered) continue;
    const cancelled = recovered.status === "cancelled";
    await appendAnalysisEvent(ds, row.id as number, { kind: cancelled ? "cancelled" : "recovered", message: cancelled ? "Cancellation acknowledged after orphaned executor exited" : "Interrupted execution recovered to queue", attemptId: row.current_attempt_id as number | null });
  }
  return rows.length;
}

/** The local mirror row for a remote D1 submission id, when one exists —
 *  the ingest dedup key. */
export async function findByOriginId(ds: DataSource, originId: number): Promise<SubmissionRow | null> {
  const row = await ds.get("SELECT * FROM submission WHERE origin_id = ? LIMIT 1", originId);
  return row ? toSubmission(row) : null;
}

export async function completeSubmission(
  ds: DataSource,
  id: number,
  outcome: { status: "succeeded" | "failed" | "cancelled"; error?: string | null; resultReportId?: number | null; now?: Date },
): Promise<void> {
  const at = (outcome.now ?? new Date()).toISOString();
  const row = await ds.get(`UPDATE submission SET status=?,error=?,result_report_id=?,finished_at=?
    WHERE id=? AND status IN ('queued','running') RETURNING current_attempt_id`, outcome.status, outcome.error ?? null, outcome.resultReportId ?? null, at, id);
  if (!row) return;
  await ds.run("UPDATE analysis_attempt SET status=?,finished_at=?,error=? WHERE id=? AND status='running'", outcome.status, at, outcome.error ?? null, (row.current_attempt_id as number | null) ?? null);
  await appendAnalysisEvent(ds, id, { kind: outcome.status, message: outcome.status === "cancelled" ? "Cancellation acknowledged; process exited" : outcome.status === "succeeded" ? "Execution finished; report recorded" : "Execution failed", attemptId: row.current_attempt_id as number | null, now: outcome.now });
}

export class AnalysisOperationError extends Error {}

/** A queued cancellation is atomic with claim. Running work remains running
 * until the child exits and the executor acknowledges the request. */
export async function cancelSubmission(ds: DataSource, id: number, now = new Date()): Promise<SubmissionRow> {
  const row = await ds.get(`UPDATE submission SET cancel_requested_at=?,
    status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
    finished_at=CASE WHEN status='queued' THEN ? ELSE finished_at END
    WHERE id=? AND status IN ('queued','running') AND cancel_requested_at IS NULL RETURNING *`, now.toISOString(), now.toISOString(), id);
  if (row) await appendAnalysisEvent(ds, id, { kind: row.status === "cancelled" ? "cancelled" : "cancel-requested", message: row.status === "cancelled" ? "Queued analysis cancelled" : "Cancellation requested; waiting for process exit", attemptId: row.current_attempt_id as number | null, now });
  const job = row ? toSubmission(row) : await getSubmission(ds, id);
  if (!job) throw new AnalysisOperationError("Analysis not found");
  if (job.status !== "running" && job.status !== "cancelled") throw new AnalysisOperationError("Only queued or running analyses can be cancelled");
  return job;
}

export async function reprioritizeSubmission(ds: DataSource, id: number, priority: number, now = new Date()): Promise<void> {
  if (!Number.isInteger(priority) || priority < 0 || priority > 1000) throw new AnalysisOperationError("Priority must be an integer from 0 to 1000");
  const result = await ds.run("UPDATE submission SET priority=? WHERE id=? AND status='queued'", priority, id);
  if (!result.changes) throw new AnalysisOperationError("Only queued analyses can change priority");
  await appendAnalysisEvent(ds, id, { kind: "priority", message: `Priority changed to ${priority}`, now });
}

/** Retrying records a new job with the same immutable config and a parent link.
 * Repeated requests join the active child; SQL serializes concurrent inserts. */
export async function retrySubmission(ds: DataSource, id: number, now = new Date()): Promise<SubmissionRow> {
  const original = await getSubmission(ds, id);
  if (!original || !["failed", "cancelled", "succeeded"].includes(original.status)) throw new AnalysisOperationError("Only finished analyses can be retried");
  if (!original.configuration || !original.storeId) throw new AnalysisOperationError("This historical analysis has no reproducible configuration; submit a new analysis with explicit settings");
  const existing = await ds.get("SELECT id FROM submission WHERE retry_of=? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1", id);
  if (existing) return (await getSubmission(ds, existing.id as number))!;
  const active = await findConfiguredSubmission(ds, original.storeId, original.configuration);
  if (active) throw new AnalysisOperationError(`An identical analysis is already active (#${active.id})`);
  const result = await ds.run(`INSERT INTO submission (input_raw,store_id,status,profile_json,requested_by,created_at,source,priority,config_json,config_key,retry_of)
    SELECT input_raw,store_id,'queued',profile_json,'admin',?,'admin',priority,config_json,config_key,id FROM submission parent WHERE id=?
    AND NOT EXISTS (SELECT 1 FROM submission child WHERE child.store_id=parent.store_id AND child.config_key=parent.config_key AND child.status IN ('queued','running'))`, now.toISOString(), id);
  if (!result.changes) {
    const joined = await ds.get("SELECT id FROM submission WHERE retry_of=? AND status IN ('queued','running') ORDER BY id DESC LIMIT 1", id);
    if (joined) return (await getSubmission(ds, joined.id as number))!;
    throw new AnalysisOperationError("A matching analysis became active; refresh the queue");
  }
  await appendAnalysisEvent(ds, result.lastInsertRowid, { kind: "submitted", message: `Retry of analysis #${id}`, now });
  return (await getSubmission(ds, result.lastInsertRowid))!;
}
