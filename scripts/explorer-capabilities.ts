// Node-only capabilities the local Explorer API (scripts/serve.ts) injects into
// the shared Hono app so its "Discover & Analyze" admin view works LOCALLY.
// These wrap the scraping (scripts/discover.ts) and the process-spawning batch
// analyzer (scripts/_ollama-session.ts) — neither of which can run on the
// Cloudflare Worker the same app.ts also boots. app.ts never imports this
// module; it receives these as plain function deps and 404s when they're absent
// (mirroring the sourceReader capability). See src/server/app.ts.

import {
  discover,
  loadAnalyzedIds,
  planWorklist,
  type Candidate,
  type DiscoverOpts,
  type SortKey,
} from "./discover.ts";
import { formatUsage, runAssessPaced, sessionUsageWindow } from "./_ollama-session.ts";
import { claimNextSubmission, completeSubmission, createSubmission, requeueSubmission, resetRunning } from "../src/jobs/service.ts";
import { openDb } from "../src/db/index.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { resolveProfile } from "../src/product/profile.ts";
import { loadAnalysisPolicy } from "../src/product/analysis-policy.ts";
import { randomUUID } from "node:crypto";
import { acquireExecutor } from "../src/runner/ownership.ts";
import { configuredExecution, currentSubmissionConfig } from "../src/server/analysis-node.ts";
import type { SubmissionConfig } from "../src/product/submission-config.ts";
import { sanitizeAnalysisDiagnostic } from "../src/product/analyses.ts";
import type { DataSource } from "../src/product/datasource.ts";
import type { ProductionProfile } from "../src/product/profile.ts";
import { settingsAssessArgs, type ExplorerSettings } from "../src/product/settings.ts";
import { resolveProvider } from "../src/llm/provider.ts";
import { loadSettingsIfPresent } from "../src/server/settings-node.ts";

/**
 * The rate-limit wait (runAssessPaced -> probeSession) pings Ollama Cloud, so it
 * only makes sense when the provider IS ollama and a key is available to probe
 * with. Anywhere else (OpenAI, vLLM...) a probe is meaningless and would either
 * fail or stall the queue, so pacing is off.
 */
export function shouldWaitOnRateLimit(settings: ExplorerSettings | null, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const r = resolveProvider({ provider: settings?.provider.id, baseUrl: settings?.provider.baseUrl }, env);
    return r.id === "ollama" && Boolean(r.apiKey ?? settings?.provider.apiKey);
  } catch {
    return false;
  }
}

const STORE_ID_RE = /^[a-p]{32}$/;

function clamp(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}
function numOrUndef(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// ---- discover capability -----------------------------------------------------

export interface DiscoverResponse {
  candidates: Candidate[];
  /** How many candidates were dropped as already-analyzed (excludeAnalyzed). */
  skippedAnalyzed: number;
  /** How many were dropped because no store id resolved. */
  droppedNoStoreId: number;
  /** Raw candidate count the query produced before dedup/limit. */
  total: number;
}

/** Build a discover runner bound to a bake-off DB. Returns candidates as JSON —
 *  no worklist file is written (the UI holds the selection). Bounds the query so
 *  a form submit can't kick off a runaway scrape. */
export function makeDiscoverCapability(dbPath: string) {
  return async (raw: Record<string, unknown>): Promise<DiscoverResponse> => {
    const source = raw.source === "webstore" ? "webstore" : "extpose";
    const sortRaw = String(raw.sort ?? "installs");
    const sort: SortKey = (["installs", "rating", "reviews", "none"].includes(sortRaw) ? sortRaw : "installs") as SortKey;
    const limit = clamp(raw.limit, 1, 200, 50);
    const opts: DiscoverOpts = {
      source,
      collection: raw.collection ? String(raw.collection) : undefined,
      category: raw.category ? String(raw.category) : undefined,
      pages: clamp(raw.pages, 1, 5, 1),
      filters: {
        minInstalls: numOrUndef(raw.minInstalls),
        maxInstalls: numOrUndef(raw.maxInstalls),
        minRating: numOrUndef(raw.minRating),
        maxRating: numOrUndef(raw.maxRating),
        minReviews: numOrUndef(raw.minReviews),
      },
      sort,
      limit,
      enrich: raw.enrich === true,
      excludeNonEnglish: raw.excludeNonEnglish === true,
      concurrency: 4,
      delay: 200,
    };
    const analyzed = raw.excludeAnalyzed === true ? loadAnalyzedIds(dbPath) : new Set<string>();
    const cands = await discover(opts, analyzed);
    const plan = planWorklist(cands, analyzed, limit);
    return {
      candidates: plan.selected,
      skippedAnalyzed: plan.skippedAnalyzed.length,
      droppedNoStoreId: plan.droppedNoStoreId,
      total: cands.length,
    };
  };
}

// ---- local submission runner -------------------------------------------------

/** Nudge the local queue: "a job was just enqueued, drain it". Fire-and-forget
 *  — the caller's HTTP response must not wait on an analysis. */
export type RunSubmissionCapability = () => void;

/**
 * Drains the submission queue IN THIS PROCESS.
 *
 * The deployed shape is a queue plus a separate drain worker, which is right
 * for Cloudflare and wrong for a laptop: a stranger who clicks Analyze on
 * `npm run serve` would watch the job sit at `queued` forever with nothing
 * running it, and no indication that a second process was supposed to exist.
 * Bound to loopback, the server IS the worker.
 *
 * Serial by design, for the same reasons as makeAnalyzeBatch: Ollama session
 * pacing assumes one analysis at a time, and it avoids SQLITE_BUSY against the
 * API's own DB handle. The heavy runner daemon (scripts/runner.ts) remains the
 * option for unattended, budget-governed, remote-ingesting operation — this is
 * deliberately the small version: claim, assess, complete.
 */
export function makeSubmissionRunner(
  dbPath: string,
  ds: DataSource,
  profile: ProductionProfile,
  log: (msg: string) => void = (m) => console.log(`[analysis] ${m}`),
): RunSubmissionCapability {
  let draining = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(kick, Math.max(1000, Math.min(ms, 30_000)));
    timer.unref();
  };

  async function drain(): Promise<void> {
    const ownerDb = openDb(dbPath);
    const release = acquireExecutor(ownerDb);
    if (!release) { ownerDb.close(); schedule(30_000); return; }
    try {
      await resetRunning(ds);
      for (;;) {
        const policy = await loadAnalysisPolicy(ds);
        const manualPause = (await ds.get("SELECT value FROM runner_state WHERE key='manual_pause'"))?.value;
        if (manualPause === "1" || (manualPause !== "0" && policy?.paused)) { schedule(30_000); return; }
        const holds = await ds.all("SELECT value FROM runner_state WHERE key IN ('backoff_until','paused_until')");
        const until = Math.max(0, ...holds.map((r) => Date.parse(String(r.value)) || 0));
        if (until > Date.now()) { schedule(until - Date.now()); return; }
        const job = await claimNextSubmission(ds);
        if (!job) {
          const pending = await ds.get("SELECT COUNT(*) n FROM submission WHERE status = 'queued'");
          if (Number(pending?.n) > 0) schedule(30_000);
          return;
        }
        if (!job.storeId) {
          await completeSubmission(ds, job.id, { status: "failed", error: "no store id extracted from input" });
          continue;
        }
        try {
          if (job.hasConfiguration && !job.configuration) throw new Error("This job has an unsupported or invalid configuration. Submit a new analysis.");
          const settings = loadSettingsIfPresent();
          const execution = job.configuration ? configuredExecution(job.configuration) : {
            args: settings ? settingsAssessArgs(settings) : [], env: undefined,
          };
          const res = await runAssessPaced(job.storeId, {
            assessArgs: [...execution.args, "--db", dbPath], env: { ...execution.env, EXTRAY_ANALYSIS_JOB_ID: String(job.id), EXTRAY_ANALYSIS_ATTEMPT_ID: String(job.currentAttemptId), EXTRAY_ANALYSIS_DB: dbPath }, wait: false,
          });
          if (res.cancelled) {
            await completeSubmission(ds, job.id, { status: "cancelled", resultReportId: res.resultReportId });
            if (res.resultReportId) await ds.run("INSERT INTO runner_state(key,value,updated_at) VALUES ('dirty_for_sync','1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", new Date().toISOString());
          } else if ((res.code === 0 || res.code === 6) && res.resultReportId) {
            await completeSubmission(ds, job.id, { status: "succeeded", resultReportId: res.resultReportId });
            await ds.run("INSERT INTO runner_state (key,value,updated_at) VALUES ('dirty_for_sync','1',?) ON CONFLICT(key) DO UPDATE SET value='1',updated_at=excluded.updated_at", new Date().toISOString());
            log(`completed ${job.storeId} (job ${job.id}, report ${res.resultReportId})`);
          } else if (res.rateLimited && job.attempts + 1 < (policy?.retryLimit ?? 8)) {
            const notBefore = new Date(Date.now() + (policy?.retryBackoffMinutes ?? 30) * 60_000);
            await requeueSubmission(ds, job.id, { notBefore });
            await ds.run("INSERT INTO runner_state (key,value,updated_at) VALUES ('backoff_until',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", notBefore.toISOString(), new Date().toISOString());
            schedule(30_000);
            return;
          } else {
            await completeSubmission(ds, job.id, { status: "failed", error: res.code === 0 || res.code === 6
              ? "Analysis finished but its report was not recorded. Check database storage and retry."
              : res.lastStderrLine ?? `assess exited ${res.code}` });
          }
        } catch (e) {
          await completeSubmission(ds, job.id, { status: "failed", error: (e as Error).message });
        }
      }
    } finally { release(); ownerDb.close(); }
  }

  function kick(): void {
    if (draining) return;
    draining = true;
    void drain().catch((e: unknown) => { log(`queue drain stopped: ${(e as Error).message}`); schedule(30_000); })
      .finally(() => { draining = false; });
  }
  return kick;
}

// ---- analyze-batch capability ------------------------------------------------

export type BatchItemStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface BatchItem {
  jobId?: number;
  storeId: string;
  status: BatchItemStatus;
  error?: string;
}

export interface BatchStatus {
  batchId: string;
  items: BatchItem[];
  done: boolean;
  startedAt: string;
  /** The rolling Ollama session-activity gauge (local activity, not a quota). */
  usage: string;
}

export interface AnalyzeBatch {
  start(storeIds: string[], configuration?: SubmissionConfig): Promise<{ batchId: string }>;
  status(batchId: string): BatchStatus | null;
  /** Still-running batches, newest first — lets the UI re-attach to an ongoing
   *  run after the page was navigated away from and back. */
  active(): BatchStatus[];
}

/**
 * Durable batch submission: captures configuration and joins jobs to a batch
 * in SQLite. Progress is reconstructed from submissions after restart. The
 * shared executor handles serial execution, ownership, and rate-limit delays.
 */
export function makeAnalyzeBatch(
  dbPath: string,
  nowIso: () => string = () => new Date().toISOString(),
  kick?: RunSubmissionCapability,
): AnalyzeBatch {
  const read = (batchId: string): BatchStatus | null => {
    const db = openDb(dbPath);
    try {
      const rows = db.prepare(`SELECT s.id AS jobId, s.store_id AS storeId, s.status, s.error, b.created_at AS createdAt
        FROM analysis_batch_item b JOIN submission s ON s.id=b.submission_id WHERE b.batch_id=? ORDER BY s.id`).all(batchId) as unknown as (BatchItem & { createdAt: string })[];
      if (!rows.length) return null;
      return { batchId, items: rows.map(({ createdAt, ...r }) => ({ ...r, error: sanitizeAnalysisDiagnostic(r.error) ?? undefined })), done: rows.every((r) => r.status === "succeeded" || r.status === "failed" || r.status === "cancelled"), startedAt: rows[0]!.createdAt, usage: formatUsage(sessionUsageWindow(dbPath)) };
    } finally { db.close(); }
  };
  return {
    async start(storeIds, configuration = currentSubmissionConfig()) {
      const db = openDb(dbPath);
      const ds = new SqliteDataSource(db);
      const batchId = randomUUID();
      try {
        for (const storeId of new Set(storeIds)) {
          const job = await createSubmission(ds, { inputRaw: storeId, storeId, profile: resolveProfile(), source: "admin", priority: 100,
            requestedBy: "admin", configuration, batchId });
          await ds.run("INSERT INTO analysis_batch_item (batch_id,submission_id,created_at) VALUES (?,?,?)", batchId, job.id, nowIso());
        }
      } finally { db.close(); }
      kick?.();
      return { batchId };
    },
    status: read,
    active() {
      const db = openDb(dbPath);
      try {
        const rows = db.prepare(`SELECT b.batch_id AS id FROM analysis_batch_item b JOIN submission s ON s.id=b.submission_id
          WHERE s.status IN ('queued','running') GROUP BY b.batch_id ORDER BY MAX(b.created_at) DESC LIMIT 50`).all() as { id: string }[];
        return rows.map((r) => read(r.id)).filter((r): r is BatchStatus => r !== null);
      } finally { db.close(); }
    },
  };
}
