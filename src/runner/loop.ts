// The runner's tick: decide what is due (planTick — pure), then do it (runTick
// — thin effects over injected seams). One tick does at most one analysis;
// ingest/discovery/sync are cheap side-tasks that stay live even while LLM
// work is backed off. All durable state lives in the DB (runner_state, the
// submission queue, ledger_event) — the process can die at any point and the
// next boot resumes from resetRunning() + the stamps.

import { loadAnalysisPolicy } from "../product/analysis-policy.ts";
import type { DatabaseSync } from "node:sqlite";
import type { DataSource } from "../product/datasource.ts";
import type { ProductionProfile } from "../product/profile.ts";
import type { SubmissionConfig } from "../product/submission-config.ts";
import {
  claimNextSubmission,
  getSubmission,
  completeSubmission,
  requeueSubmission,
  type SubmissionRow,
  type SubmissionSource,
} from "../jobs/service.ts";
import type { RunnerConfig } from "./config.ts";
import { lastFlagValue } from "../product/assess-args.ts";
import {
  getDirtyForSync,
  getState,
  getStateDate,
  getStateInt,
  setDirtyForSync,
  setState,
  setStateDate,
} from "./state.ts";
import { canStartJob, headroom, typicalJobCost, type Headroom } from "./ledger.ts";
import { ingestRemote, planFailureUpdatesByStore, type IngestDeps } from "./ingest-remote.ts";
import { discoverAndEnqueue, type DiscoveryDeps } from "./discovery.ts";

// ---- pure planning -----------------------------------------------------------

export interface TickInputs {
  now: Date;
  lastIngestAt: Date | null;
  lastDiscoveryAt: Date | null;
  lastSyncAt: Date | null;
  /** Set while waiting out a rate-limited session; elapsed ⇒ probe first. */
  backoffUntil: Date | null;
  /** Set after too many consecutive non-rate-limit failures (self-healing). */
  pausedUntil: Date | null;
  dirtyForSync: boolean;
  /** Local mirror rows (source='remote') not yet terminal — sync gating. */
  remoteJobsOpen: number;
}

export interface TickPlan {
  ingest: boolean;
  discovery: boolean;
  analyze: boolean;
  /** Analysis resumes from a backoff: probe the session before claiming. */
  probeBeforeAnalyze: boolean;
  sync: boolean;
}

/** Push when dirty and the remote-facing work is drained — but never let
 *  results sit unpushed past the latency bound (or before a first sync).
 *  Separated out because runTick re-evaluates it AFTER the analysis phase:
 *  a job completed this tick should sync this tick, not the next. */
export function planSync(s: Pick<TickInputs, "now" | "dirtyForSync" | "remoteJobsOpen" | "lastSyncAt">, cfg: RunnerConfig): boolean {
  const t = s.now.getTime();
  return (
    cfg.ingestRemote &&
    s.dirtyForSync &&
    (s.remoteJobsOpen === 0 || s.lastSyncAt === null || t - s.lastSyncAt.getTime() >= cfg.syncMaxLatencyHours * 3_600_000)
  );
}

export function planTick(s: TickInputs, cfg: RunnerConfig): TickPlan {
  const t = s.now.getTime();
  const due = (last: Date | null, everyMs: number) => last === null || t - last.getTime() >= everyMs;

  const paused = s.pausedUntil !== null && t < s.pausedUntil.getTime();
  const backedOff = s.backoffUntil !== null && t < s.backoffUntil.getTime();
  const analyze = !paused && !backedOff;

  return {
    ingest: cfg.ingestRemote && due(s.lastIngestAt, cfg.ingestEveryMin * 60_000),
    discovery: due(s.lastDiscoveryAt, cfg.discoveryEveryHours * 3_600_000),
    analyze,
    probeBeforeAnalyze: analyze && s.backoffUntil !== null,
    sync: planSync(s, cfg),
  };
}

// ---- effects -----------------------------------------------------------------

export interface AssessOutcome {
  code: number | null;
  lastStderrLine: string | null;
  rateLimited: boolean;
  resultReportId?: number;
  cancelled?: boolean;
}

export interface RunnerDeps {
  db: DatabaseSync;
  ds: DataSource;
  cfg: RunnerConfig;
  profile: ProductionProfile;
  log: (msg: string) => void;
  /** Effect seams — every one injectable for tests. */
  d1Query: (sql: string) => Record<string, unknown>[] | null;
  d1Write: (statements: string[]) => void;
  runAssess: (storeId: string, assessArgs: string[], configuration?: SubmissionConfig, job?: SubmissionRow) => Promise<AssessOutcome>;
  /** Configured Ollama jobs probe their pinned endpoint/model; other providers use timed retry. */
  probe: (configuration?: SubmissionConfig) => Promise<"ok" | "limited" | "error" | "unavailable">;
  runSync: () => void;
  /** Server-seconds of recorded activity over the trailing window. */
  usedSeconds: (windowHours: number) => number;
  discoverImpl?: DiscoveryDeps["discoverImpl"];
  loadAnalyzedImpl?: DiscoveryDeps["loadAnalyzedImpl"];
  now?: () => Date;
  discoveryConfiguration?: () => SubmissionConfig | undefined;
}

export function readTickInputs(db: DatabaseSync, now: Date): TickInputs {
  const open = db
    .prepare("SELECT COUNT(*) AS n FROM submission WHERE source = 'remote' AND status IN ('queued','running')")
    .get() as { n: number };
  return {
    now,
    lastIngestAt: getStateDate(db, "last_ingest_at"),
    lastDiscoveryAt: getStateDate(db, "last_discovery_at"),
    lastSyncAt: getStateDate(db, "last_sync_at"),
    backoffUntil: getStateDate(db, "backoff_until"),
    pausedUntil: getStateDate(db, "paused_until"),
    dirtyForSync: getDirtyForSync(db),
    remoteJobsOpen: open.n,
  };
}

function ledgerEvent(db: DatabaseSync, now: Date, kind: string, fields: { storeId?: string | null; model?: string | null; detail?: string | null } = {}): void {
  db.prepare("INSERT INTO ledger_event (ts, kind, source, store_id, model, detail) VALUES (?,?,?,?,?,?)").run(
    now.toISOString(),
    kind,
    "runner",
    fields.storeId ?? null,
    fields.model ?? null,
    fields.detail ?? null,
  );
}

/** The next claimable row WITHOUT claiming it — the budget gate peeks before
 *  committing (a deferred discovery job must not burn an attempt). Single
 *  runner ⇒ the row it claims immediately after is the same one. */
export function peekNextSubmission(db: DatabaseSync, now: Date): { id: number; storeId: string | null; source: SubmissionSource | null } | null {
  const row = db
    .prepare(
      `SELECT id, store_id, source FROM submission
       WHERE status = 'queued' AND (not_before IS NULL OR not_before <= ?)
       ORDER BY priority DESC, created_at ASC, id ASC LIMIT 1`,
    )
    .get(now.toISOString()) as { id: number; store_id: string | null; source: string | null } | undefined;
  return row ? { id: row.id, storeId: row.store_id, source: (row.source as SubmissionSource | null) ?? null } : null;
}

async function handleOutcome(deps: RunnerDeps, job: SubmissionRow, res: AssessOutcome, now: () => Date): Promise<void> {
  const { db, ds, cfg, log } = deps;
  const storeId = job.storeId!;
  const model = job.configuration?.model ?? lastFlagValue(cfg.assessArgs, "--model");

  if (res.cancelled) {
    await completeSubmission(ds, job.id, { status: "cancelled", resultReportId: res.resultReportId, now: now() });
    if (res.resultReportId) setDirtyForSync(db, true, now());
    return;
  }

  if ((res.code === 0 || res.code === 6) && res.resultReportId) {
    await completeSubmission(ds, job.id, { status: "succeeded", resultReportId: res.resultReportId, now: now() });
    setDirtyForSync(db, true, now());
    setState(db, "consecutive_failures", null, now());
    ledgerEvent(db, now(), "job_done", { storeId, model });
    log(`✓ ${storeId} completed (report ${res.resultReportId})`);
    return;
  }

  if (res.rateLimited) {
    const backoffUntil = new Date(now().getTime() + cfg.budget.backoffMs);
    // Only Ollama limits inform its learned session capacity. A different
    // provider's 429 is recorded, but must not train the Ollama budget ledger.
    const ollama = !job.configuration || job.configuration.provider.id === "ollama";
    const gauge = ollama ? JSON.stringify({ sessionSeconds: deps.usedSeconds(5) })
      : JSON.stringify({ provider: job.configuration!.provider.id });
    ledgerEvent(db, now(), ollama ? "rate_limit" : "provider_rate_limit", { storeId, model, detail: gauge });
    if (job.attempts + 1 >= cfg.budget.maxAttempts) {
      await completeSubmission(ds, job.id, {
        status: "failed",
        error: `rate-limited on ${cfg.budget.maxAttempts} attempts — giving up`,
        now: now(),
      });
      if (cfg.ingestRemote && job.source === "remote") deps.d1Write(planFailureUpdatesByStore([{ storeId, error: "rate-limited repeatedly — resubmit later" }], now().toISOString()));
      log(`✗ ${storeId} failed: rate-limited on ${cfg.budget.maxAttempts} attempts`);
    } else {
      await requeueSubmission(ds, job.id, { notBefore: backoffUntil });
      log(`⏸ ${storeId} rate-limited — requeued (attempt ${job.attempts + 1}), backing off until ${backoffUntil.toISOString()}`);
    }
    setStateDate(db, "backoff_until", backoffUntil, now());
    ledgerEvent(db, now(), "backoff_start", { detail: backoffUntil.toISOString() });
    return;
  }

  const error = res.code === 0 || res.code === 6 ? "Analysis finished but its report was not recorded. Check database storage and retry."
    : res.lastStderrLine ?? `assess exited ${res.code ?? "on a signal"}`;
  const perExtension = res.code !== null && [0, 2, 3, 4, 6].includes(res.code);
  if (perExtension) {
    await completeSubmission(ds, job.id, { status: "failed", error, now: now() });
    if (cfg.ingestRemote && job.source === "remote") deps.d1Write(planFailureUpdatesByStore([{ storeId, error }], now().toISOString()));
    ledgerEvent(db, now(), "job_failed", { storeId, model, detail: error.slice(0, 300) });
    log(`✗ ${storeId} failed (exit ${res.code}): ${error}`);
  } else {
    // Unexpected exit — requeue with a long deferral rather than losing the job.
    await requeueSubmission(ds, job.id, { notBefore: new Date(now().getTime() + cfg.failurePauseMin * 60_000) });
    ledgerEvent(db, now(), "job_failed", { storeId, model, detail: `unexpected exit ${res.code}: ${error.slice(0, 300)}` });
    log(`✗ ${storeId} unexpected exit ${res.code ?? "(signal)"} — requeued with deferral: ${error}`);
  }

  const failures = getStateInt(db, "consecutive_failures") + 1;
  if (failures >= cfg.maxConsecutiveFailures) {
    const until = new Date(now().getTime() + cfg.failurePauseMin * 60_000);
    setStateDate(db, "paused_until", until, now());
    setState(db, "consecutive_failures", null, now());
    log(
      `‼ ${failures} consecutive failures — this looks like a config/environment problem, not bad extensions. ` +
        `Pausing analysis until ${until.toISOString()} (ingest/discovery continue).`,
    );
  } else {
    setState(db, "consecutive_failures", String(failures), now());
  }
}

export interface TickResult {
  plan: TickPlan;
  analyzed: string | null;
}

/** One full tick. Serial by design: at most one analysis per tick, and the
 *  side-tasks run inline (they are seconds, not minutes). */
export async function runTick(deps: RunnerDeps): Promise<TickResult> {
  const policy = await loadAnalysisPolicy(deps.ds);
  if (policy) deps = { ...deps, cfg: { ...deps.cfg,
    discoveryEveryHours: policy.discoveryEveryHours,
    discovery: policy.discoveryEnabled ? policy.discoveryQueries.map((q) => ({ ...q, limit: Math.min(q.limit ?? policy.discoveryLimit, policy.discoveryLimit) })) : [],
    budget: { ...deps.cfg.budget, maxAttempts: policy.retryLimit, backoffMs: policy.retryBackoffMinutes * 60000,
      sessionCapSecondsFallback: policy.sessionCapSeconds, weeklyCapSecondsFallback: policy.weeklyCapSeconds },
  } };
  const { db, ds, cfg, profile, log } = deps;
  const now = deps.now ?? (() => new Date());
  const inputs = readTickInputs(db, now());
  const plan = planTick(inputs, cfg);
  const manualPause = getState(db, "manual_pause");
  if (manualPause === "1" || (manualPause !== "0" && policy?.paused)) { plan.analyze = false; plan.probeBeforeAnalyze = false; }
  if (policy?.discoveryEnabled === false) plan.discovery = false;

  if (plan.ingest) {
    const ingestDeps: IngestDeps = {
      ds,
      profile,
      d1Query: deps.d1Query,
      d1Write: deps.d1Write,
      priority: cfg.priorities.remote,
      now,
      log,
      configuration: deps.discoveryConfiguration?.(),
    };
    try {
      const r = await ingestRemote(ingestDeps);
      if (r.mirrored > 0 || r.rejected > 0) log(`ingest: ${r.mirrored} mirrored, ${r.alreadyMirrored} already local, ${r.rejected} rejected`);
    } catch (e) {
      log(`ingest failed (will retry next interval): ${(e as Error).message}`);
    }
    setStateDate(db, "last_ingest_at", now(), now());
  }

  if (plan.discovery) {
    try {
      const r = await discoverAndEnqueue({
        ds,
        cfg,
        profile,
        discoverImpl: deps.discoverImpl,
        loadAnalyzedImpl: deps.loadAnalyzedImpl,
        now,
        log,
        policy: policy ?? undefined,
        configuration: deps.discoveryConfiguration?.(),
      });
      log(`discovery: ${r.enqueued} enqueued, ${r.skippedAnalyzed} already analyzed, ${r.queriesFailed} queries failed`);
    } catch (e) {
      log(`discovery failed (will retry next interval): ${(e as Error).message}`);
    }
    setStateDate(db, "last_discovery_at", now(), now());
  }

  let analyzed: string | null = null;
  if (plan.analyze) {
    const peeked = peekNextSubmission(db, now());
    const candidate = peeked ? await getSubmission(ds, peeked.id) : null;
    let proceed = candidate !== null;
    if (plan.probeBeforeAnalyze && candidate) {
      // A non-Ollama retry must not depend on an unrelated Ollama account.
      // Invalid snapshots also bypass probing so execution can fail explicitly.
      const shouldProbe = !candidate.hasConfiguration || candidate.configuration?.provider.id === "ollama";
      const status = shouldProbe ? await deps.probe(candidate.configuration ?? undefined) : "unavailable";
      if (status === "ok" || status === "unavailable") {
        setStateDate(db, "backoff_until", null, now());
        ledgerEvent(db, now(), "backoff_end");
        log(status === "ok" ? "▶ session has capacity again — resuming analysis" : "▶ retry delay elapsed — resuming analysis without an Ollama capacity probe");
      } else {
        const until = new Date(now().getTime() + cfg.budget.backoffMs);
        setStateDate(db, "backoff_until", until, now());
        ledgerEvent(db, now(), status === "limited" ? "probe_limited" : "probe_error");
        log(`⏸ probe: still ${status === "limited" ? "rate-limited" : "unreachable"} — backing off until ${until.toISOString()}`);
        proceed = false;
      }
    }
    if (proceed) {
      if (peeked) {
        const h: Headroom = headroom(db, cfg, {
          sessionUsedSeconds: deps.usedSeconds(5),
          weeklyUsedSeconds: deps.usedSeconds(168),
        });
        const typical = typicalJobCost(db, cfg, { methodology: profile.pinned.methodology, model: profile.pinned.model });
        if (!canStartJob(peeked.source, h, typical, cfg)) {
          log(
            `budget: deferring discovery job ${peeked.storeId} — headroom session ${Math.round(h.sessionSeconds)}s / ` +
              `weekly ${Math.round(h.weeklySeconds)}s vs typical job ${Math.round(typical.serverSeconds)}s`,
          );
        } else {
          const job = await claimNextSubmission(ds, now());
          if (job) {
            if (!job.storeId || (job.hasConfiguration && !job.configuration)) {
              await completeSubmission(ds, job.id, { status: "failed", error: !job.storeId ? "no store id extracted from input" : "unsupported or invalid analysis configuration", now: now() });
            } else {
              log(`analyzing ${job.storeId} (source ${job.source ?? "user"}, priority ${job.priority}, attempt ${job.attempts})`);
              let res: AssessOutcome;
              try { res = await deps.runAssess(job.storeId, [...cfg.assessArgs, "--db", cfg.db], job.configuration ?? undefined, job); }
              catch (error) { res = { code: 2, lastStderrLine: (error as Error).message, rateLimited: false }; }
              await handleOutcome(deps, job, res, now);
              analyzed = job.storeId;
            }
          }
        }
      }
    }
  }

  // Re-evaluate sync from FRESH state: a job completed this tick set the dirty
  // flag (and may have drained the remote queue) after the opening plan.
  const syncDue = planSync(readTickInputs(db, now()), cfg);
  if (syncDue) {
    try {
      deps.runSync();
      setDirtyForSync(db, false, now());
      setStateDate(db, "last_sync_at", now(), now());
      log("sync: pushed + close-loop complete");
    } catch (e) {
      // Stay dirty; the latency bound will retry.
      setStateDate(db, "last_sync_at", now(), now());
      log(`sync failed (will retry): ${(e as Error).message}`);
    }
  }

  return { plan: { ...plan, sync: syncDue }, analyzed };
}
