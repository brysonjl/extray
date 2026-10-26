import { safe } from "./datasource.ts";
import { loadAnalysisPolicy } from "./analysis-policy.ts";
import type { DataSource, Row, SqlParam } from "./datasource.ts";
import type { ProductionProfile } from "./profile.ts";
import { reportById, riskReportOf } from "./canonical.ts";
import { parseSubmissionConfig } from "./submission-config.ts";
import type { AnalysisCounts, AnalysisDetail, AnalysisList, AnalysisRow, RunnerSnapshot, AnalysisEvent } from "./analysis-contract.ts";

const STATUSES = new Set(["active", "history", "all", "queued", "running", "succeeded", "failed", "cancelled"]);
const SOURCES = new Set(["all", "unknown", "user", "remote", "discovery", "admin"]);
const SORTS = new Set(["queue", "newest", "oldest"]);
export class AnalysisQueryError extends Error {}

/** PRAGMA works on both SQLite and D1. Detect columns, not a version that a
 * hosted export may have copied independently of the submission migration. */
async function columns(ds: DataSource, table: "submission" | "target" | "runner_state" | "analysis_event"): Promise<Set<string>> {
  const rows = await ds.all(`PRAGMA table_info(${table})`);
  return new Set(rows.map((r) => String(r.name)));
}
function queueMetadata(cols: Set<string>): boolean {
  return ["source", "priority", "attempts", "not_before"].every((c) => cols.has(c));
}
function nullableString(v: unknown): string | null { return typeof v === "string" ? v : null; }
function nullableNumber(v: unknown): number | null { return typeof v === "number" && Number.isFinite(v) ? v : null; }
function parseObject(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(v);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
/** Diagnostics are bounded and scrubbed; never return raw provider JSON. */
export function sanitizeAnalysisDiagnostic(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  if (/(?:^|:\s*)[\[{]/.test(v.trim())) return "Analysis failed; structured diagnostics are available in the operator logs.";
  return v.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(api[-_]?key|token|password|secret|authorization)["\']?\s*[:=]\s*["\']?[^"\'\s,;}\]]+["\']?/gi, "$1=[redacted]")
    .replace(/\bsk-[a-z0-9_-]+/gi, "[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, (url) => { try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return "[URL]"; } })
    .slice(0, 1000);
}
function rowDto(row: Row, cols: Set<string>, now: Date): AnalysisRow {
  const notBefore = nullableString(row.not_before);
  const status = row.status as AnalysisRow["status"];
  const delayTime = notBefore === null ? null : Date.parse(notBefore);
  return {
    jobId: row.id as number, storeId: nullableString(row.store_id), name: nullableString(row.name),
    batchId: nullableString(row.batch_id), status,
    cancelRequestedAt: nullableString(row.cancel_requested_at), retryOf: nullableNumber(row.retry_of), currentStage: status === "running" ? nullableString(row.current_stage) : null,
    source: SOURCES.has(String(row.source)) && row.source !== "all" && row.source !== "unknown" ? row.source as AnalysisRow["source"] : null,
    priority: nullableNumber(row.priority), retryCount: nullableNumber(row.attempts), notBefore,
    createdAt: row.created_at as string, startedAt: nullableString(row.started_at), finishedAt: nullableString(row.finished_at),
    error: sanitizeAnalysisDiagnostic(row.error), resultReportId: nullableNumber(row.result_report_id),
    eligibility: status !== "queued" ? "not-applicable" : !cols.has("not_before") || (delayTime !== null && !Number.isFinite(delayTime)) ? "unknown" : delayTime !== null && delayTime > now.getTime() ? "retry-delay" : "ready",
  };
}
async function counts(ds: DataSource, cols: Set<string>, now: Date): Promise<AnalysisCounts> {
  const out: AnalysisCounts = { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0, ready: null, delayed: null };
  if (!cols.size) return out;
  for (const r of await ds.all("SELECT status, COUNT(*) AS n FROM submission GROUP BY status")) {
    if (["queued", "running", "succeeded", "failed", "cancelled"].includes(String(r.status))) out[r.status as "queued"] = Number(r.n);
  }
  if (cols.has("not_before")) {
    const r = await ds.get(`SELECT
      COALESCE(SUM(CASE WHEN not_before IS NULL OR julianday(not_before) <= julianday(?) THEN 1 ELSE 0 END), 0) AS ready,
      COALESCE(SUM(CASE WHEN julianday(not_before) > julianday(?) THEN 1 ELSE 0 END), 0) AS delayed
      FROM submission WHERE status = 'queued'`, now.toISOString(), now.toISOString());
    out.ready = Number(r?.ready ?? 0); out.delayed = Number(r?.delayed ?? 0);
  }
  return out;
}
function integer(raw: string | undefined, fallback: number, max: number, name: string): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > max) throw new AnalysisQueryError(`invalid ${name}`);
  return Number(raw);
}
async function projection(ds: DataSource, cols: Set<string>, detail: boolean): Promise<string> {
  const keys = ["id", "store_id", "status", "source", "priority", "attempts", "not_before", "created_at", "started_at", "finished_at", "error", "result_report_id", "batch_id", "cancel_requested_at", "retry_of", ...(detail ? ["profile_json", "config_json"] : [])];
  const target = await columns(ds, "target");
  const name = ["store_id", "name", "id"].every((k) => target.has(k))
    ? "(SELECT t.name FROM target t WHERE t.store_id = s.store_id AND t.name IS NOT NULL ORDER BY t.id DESC LIMIT 1) AS name"
    : "NULL AS name";
  const events = await columns(ds, "analysis_event");
  const attemptFilter = cols.has("current_attempt_id") ? " AND e.attempt_id=s.current_attempt_id" : "";
  const stage = events.has("stage") ? `(SELECT e.stage FROM analysis_event e WHERE e.submission_id=s.id AND e.kind='stage-started'${attemptFilter} ORDER BY e.sequence DESC LIMIT 1) AS current_stage` : "NULL AS current_stage";
  return [...keys.map((k) => cols.has(k) ? `s.${k}` : `NULL AS ${k}`), name, stage].join(", ");
}
export async function listAnalyses(ds: DataSource, query: Record<string, string>, now: Date): Promise<AnalysisList> {
  const status = query.status ?? "active", source = query.source ?? "all", sort = query.sort ?? "queue";
  if (!STATUSES.has(status)) throw new AnalysisQueryError("invalid status");
  if (!SOURCES.has(source)) throw new AnalysisQueryError("invalid source");
  if (!SORTS.has(sort)) throw new AnalysisQueryError("invalid sort");
  if ((query.q?.length ?? 0) > 200) throw new AnalysisQueryError("search is too long (max 200 characters)");
  const page = integer(query.page, 1, 1_000_000, "page"), pageSize = integer(query.pageSize, 25, 100, "pageSize");
  const cols = await columns(ds, "submission");
  const result: AnalysisList = { rows: [], total: 0, page, pageSize, observedAt: now.toISOString(), counts: await counts(ds, cols, now), queueMetadataAvailable: queueMetadata(cols) };
  if (!cols.size) return result;
  const where: string[] = [], params: SqlParam[] = [];
  if (status === "active") where.push("s.status IN ('queued','running')");
  else if (status === "history") where.push("s.status IN ('succeeded','failed','cancelled')");
  else if (status !== "all") { where.push("s.status = ?"); params.push(status); }
  if (source === "unknown") where.push(cols.has("source") ? "s.source IS NULL" : "1 = 1");
  else if (source !== "all") { if (cols.has("source")) { where.push("s.source = ?"); params.push(source); } else where.push("1 = 0"); }
  if (query.batchId) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(query.batchId)) throw new AnalysisQueryError("invalid batch ID");
    const tables = await ds.all("PRAGMA table_info(analysis_batch_item)");
    if (tables.length) { where.push("EXISTS (SELECT 1 FROM analysis_batch_item b WHERE b.submission_id=s.id AND b.batch_id=?)"); params.push(query.batchId); }
    else if (cols.has("batch_id")) { where.push("s.batch_id=?"); params.push(query.batchId); }
    else where.push("1=0");
  }
  if (query.q?.trim()) {
    where.push("(s.store_id LIKE ? ESCAPE '\\' OR s.input_raw LIKE ? ESCAPE '\\')");
    const pattern = `%${query.q.trim().replace(/[\\%_]/g, "\\$&")}%`; params.push(pattern, pattern);
  }
  const filter = where.length ? `WHERE ${where.join(" AND ")}` : "";
  result.total = Number((await ds.get(`SELECT COUNT(*) AS n FROM submission s ${filter}`, ...params))?.n ?? 0);
  const order = sort === "newest" ? "s.created_at DESC, s.id DESC" : sort === "oldest" ? "s.created_at ASC, s.id ASC"
    : `CASE s.status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, ${cols.has("priority") ? "s.priority DESC," : ""} s.created_at ASC, s.id ASC`;
  result.rows = (await ds.all(`SELECT ${await projection(ds, cols, false)} FROM submission s ${filter} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize)).map((r) => rowDto(r, cols, now));
  return result;
}
export async function analysisDetail(ds: DataSource, id: number, profile: ProductionProfile, now: Date): Promise<AnalysisDetail | null> {
  const cols = await columns(ds, "submission");
  if (!cols.size) return null;
  const row = await ds.get(`SELECT ${await projection(ds, cols, true)} FROM submission s WHERE s.id = ?`, id);
  if (!row) return null;
  const rawProfile = parseObject(row.profile_json)?.pinned;
  const pinned = rawProfile && typeof rawProfile === "object" ? rawProfile as Record<string, unknown> : null;
  const dto: AnalysisDetail = { ...rowDto(row, cols, now), profile: pinned && typeof pinned.methodology === "string" && typeof pinned.model === "string" ? { methodology: pinned.methodology, model: pinned.model } : null, configuration: parseSubmissionConfig(nullableString(row.config_json)), result: null };
  dto.attempts = (await safe(() => ds.all("SELECT id,status,started_at,finished_at,error FROM analysis_attempt WHERE submission_id=? ORDER BY id", id), [] as Row[]))
    .map((r) => ({ id: Number(r.id), status: String(r.status), startedAt: String(r.started_at), finishedAt: nullableString(r.finished_at), error: sanitizeAnalysisDiagnostic(r.error) }));
  dto.events = (await analysisEvents(ds, id, 0)).events;
  if (dto.resultReportId !== null) {
    const result = await reportById(ds, dto.resultReportId, profile);
    if (result && result.storeId === dto.storeId) {
      dto.result = { reportId: result.reportId, storeId: result.storeId, methodology: result.methodology, model: result.model, tier: result.tier, costUsd: result.estimatedUsd, assessedAt: result.assessedAt };
      const risk = await riskReportOf(ds, result.reportId);
      const o = risk?.outcome as Record<string, unknown> | undefined;
      if (o && (o.investigation === "complete" || o.investigation === "incomplete") && (o.final_submission === "accepted" || o.final_submission === "not-accepted")) {
        dto.result.outcome = { investigation: o.investigation, final_submission: o.final_submission, reasons: Array.isArray(o.reasons) ? o.reasons.slice(0, 20).map(sanitizeAnalysisDiagnostic).filter((v): v is string => v !== null) : [] };
      }
    }
  }
  return dto;
}
export async function runnerSnapshot(ds: DataSource, local: boolean, now: Date): Promise<RunnerSnapshot> {
  const cols = await columns(ds, "submission");
  const stateColumns = await columns(ds, "runner_state");
  const stateAvailable = stateColumns.has("key") && stateColumns.has("value");
  const values = new Map<string, unknown>();
  if (stateAvailable) for (const r of await ds.all("SELECT key, value FROM runner_state WHERE key IN ('backoff_until','paused_until','manual_pause','last_sync_at','last_ingest_at','dirty_for_sync','executor_heartbeat','progress_observed_at','progress_synced_at')")) values.set(String(r.key), r.value);
  const date = (key: string): string | null => { const v = values.get(key); return typeof v === "string" && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null; };
  const heartbeat = parseObject(values.get("executor_heartbeat"));
  const heartbeatAt = heartbeat && typeof heartbeat.at === "string" && Number.isFinite(Date.parse(heartbeat.at)) ? heartbeat.at : null;
  const policy = stateAvailable ? await loadAnalysisPolicy(ds) : null;
  const paused = values.get("manual_pause") === "1" || (values.get("manual_pause") !== "0" && (policy?.paused ?? false));
  // Hosted progress publishes every 30 seconds; tolerate two missed intervals.
  const staleAfterMs = local ? 20_000 : 90_000;
  return { mode: local ? "local" : "external", observedAt: now.toISOString(), liveness: !heartbeatAt ? "unknown" : heartbeat?.state === "stopped" ? "offline" : now.getTime() - Date.parse(heartbeatAt) > staleAfterMs ? "stale" : "online", heartbeatAt, paused, progressObservedAt: date("progress_observed_at"), progressSyncedAt: date("progress_synced_at"), stateAvailable, queueMetadataAvailable: queueMetadata(cols), counts: await counts(ds, cols, now), backoffUntil: date("backoff_until"), pausedUntil: date("paused_until"), lastSyncAt: date("last_sync_at"), lastIngestAt: date("last_ingest_at"), dirtyForSync: stateAvailable ? values.get("dirty_for_sync") === "1" : null };
}

export async function analysisEvents(ds: DataSource, jobId: number, after: number): Promise<{ events: AnalysisEvent[]; nextCursor: number }> {
  const rows = await safe(() => ds.all("SELECT id,sequence,attempt_id,kind,stage,message,created_at FROM analysis_event WHERE submission_id=? AND sequence>? ORDER BY sequence LIMIT 200", jobId, after), [] as Row[]);
  const events = rows.map((r) => ({ id: Number(r.id), sequence: Number(r.sequence), attemptId: nullableNumber(r.attempt_id), kind: String(r.kind), stage: nullableString(r.stage), message: sanitizeAnalysisDiagnostic(r.message) ?? "Event recorded", createdAt: String(r.created_at) }));
  return { events, nextCursor: events.at(-1)?.sequence ?? after };
}
