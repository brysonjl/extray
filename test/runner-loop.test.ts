// The runner tick (src/runner/loop.ts): the pure planTick schedule matrix,
// then runTick end-to-end over a temp DB with every effect seam mocked —
// success, rate-limit requeue + backoff + probe-gated resume, per-extension
// failure with remote write-back, budget deferral of discovery jobs, and the
// consecutive-failure pause.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/index.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";
import { snapshotSettings } from "../src/product/submission-config.ts";
import { createSubmission } from "../src/jobs/service.ts";
import { DEFAULT_RUNNER_CONFIG, type RunnerConfig } from "../src/runner/config.ts";
import { getState, getStateDate, setStateDate, setState } from "../src/runner/state.ts";
import { planTick, runTick, type RunnerDeps, type TickInputs } from "../src/runner/loop.ts";

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const NOW = new Date("2026-08-11T12:00:00Z");

const cfg: RunnerConfig = { ...DEFAULT_RUNNER_CONFIG, discovery: [] };

function baseInputs(over: Partial<TickInputs> = {}): TickInputs {
  return {
    now: NOW,
    lastIngestAt: NOW, // nothing due unless a test says so
    lastDiscoveryAt: NOW,
    lastSyncAt: NOW,
    backoffUntil: null,
    pausedUntil: null,
    dirtyForSync: false,
    remoteJobsOpen: 0,
    ...over,
  };
}

describe("planTick", () => {
  it("fires ingest/discovery on their intervals (and always on first boot)", () => {
    expect(planTick(baseInputs({ lastIngestAt: null, lastDiscoveryAt: null }), cfg)).toMatchObject({
      ingest: true,
      discovery: true,
    });
    const stale = new Date(NOW.getTime() - (cfg.ingestEveryMin + 1) * 60_000);
    expect(planTick(baseInputs({ lastIngestAt: stale }), cfg).ingest).toBe(true);
    expect(planTick(baseInputs(), cfg)).toMatchObject({ ingest: false, discovery: false });
  });

  it("disables Cloudflare ingest and sync with ingestRemote:false", () => {
    const local = { ...cfg, ingestRemote: false };
    expect(planTick(baseInputs({ lastIngestAt: null, lastSyncAt: null, dirtyForSync: true }), local)).toMatchObject({ ingest: false, sync: false });
  });

  it("holds analysis during backoff, probes when it elapses", () => {
    const future = new Date(NOW.getTime() + 60_000);
    const past = new Date(NOW.getTime() - 60_000);
    expect(planTick(baseInputs({ backoffUntil: future }), cfg)).toMatchObject({ analyze: false });
    expect(planTick(baseInputs({ backoffUntil: past }), cfg)).toMatchObject({ analyze: true, probeBeforeAnalyze: true });
    expect(planTick(baseInputs(), cfg)).toMatchObject({ analyze: true, probeBeforeAnalyze: false });
  });

  it("holds analysis while paused (ingest/discovery unaffected)", () => {
    const future = new Date(NOW.getTime() + 60_000);
    const p = planTick(baseInputs({ pausedUntil: future, lastIngestAt: null }), cfg);
    expect(p.analyze).toBe(false);
    expect(p.ingest).toBe(true);
  });

  it("syncs when dirty and remote work is drained, or past the latency bound", () => {
    expect(planTick(baseInputs({ dirtyForSync: true, remoteJobsOpen: 0 }), cfg).sync).toBe(true);
    expect(planTick(baseInputs({ dirtyForSync: true, remoteJobsOpen: 2 }), cfg).sync).toBe(false);
    const stale = new Date(NOW.getTime() - (cfg.syncMaxLatencyHours + 1) * 3_600_000);
    expect(planTick(baseInputs({ dirtyForSync: true, remoteJobsOpen: 2, lastSyncAt: stale }), cfg).sync).toBe(true);
    expect(planTick(baseInputs({ dirtyForSync: false }), cfg).sync).toBe(false);
  });
});

describe("runTick", () => {
  let db: DatabaseSync;
  let deps: RunnerDeps;
  let clock: Date;

  let sequence = 0;
  async function successful(storeId: string) {
    const run = db.prepare("INSERT INTO run (run_hash,kind,methodology,model,started_at) VALUES (?,'assess','monolith','custom-model',?)").run(`run-${++sequence}`, NOW.toISOString());
    const target = db.prepare("INSERT INTO target (run_id,store_id,is_corpus) VALUES (?,?,0)").run(run.lastInsertRowid, storeId);
    const report = db.prepare("INSERT INTO report (run_id,target_id) VALUES (?,?)").run(run.lastInsertRowid,target.lastInsertRowid);
    return { code: 0, lastStderrLine: null, rateLimited: false, resultReportId: Number(report.lastInsertRowid) };
  }

  beforeEach(() => {
    db = openDb(join(mkdtempSync(join(tmpdir(), "loop-")), "db.sqlite"));
    clock = new Date(NOW);
    deps = {
      db,
      ds: new SqliteDataSource(db),
      cfg,
      profile: DEFAULT_PROFILE,
      log: () => {},
      d1Query: vi.fn().mockReturnValue([]),
      d1Write: vi.fn(),
      runAssess: vi.fn().mockImplementation(successful),
      probe: vi.fn().mockResolvedValue("ok"),
      runSync: vi.fn(),
      usedSeconds: vi.fn().mockReturnValue(0),
      now: () => clock,
    };
    // Nothing due by default: stamp the interval tasks as fresh.
    setStateDate(db, "last_ingest_at", NOW);
    setStateDate(db, "last_discovery_at", NOW);
    setStateDate(db, "last_sync_at", NOW);
  });

  async function enqueue(storeId: string, over: Record<string, unknown> = {}) {
    return createSubmission(deps.ds, {
      inputRaw: storeId,
      storeId,
      profile: DEFAULT_PROFILE,
      source: "remote",
      priority: 100,
      ...over,
    } as Parameters<typeof createSubmission>[1]);
  }

  it("claims and completes the top job, then syncs in the same tick", async () => {
    await enqueue(ID_A);
    const r = await runTick(deps);
    expect(r.analyzed).toBe(ID_A);
    const row = (await deps.ds.get("SELECT status, result_report_id FROM submission WHERE store_id = ?", ID_A))!;
    expect(row.status).toBe("succeeded");
    const ev = db.prepare("SELECT kind FROM ledger_event ORDER BY id DESC LIMIT 1").get() as { kind: string };
    expect(ev.kind).toBe("job_done");
    expect(deps.runAssess).toHaveBeenCalledWith(ID_A, [...cfg.assessArgs, "--db", cfg.db], undefined, expect.objectContaining({ storeId: ID_A, status: "running" }));
    // Completion dirtied the snapshot and drained the remote queue → same-tick sync.
    expect(deps.runSync).toHaveBeenCalledTimes(1);
    expect(getState(db, "dirty_for_sync")).toBeNull();
  });

  it("keeps new and previously dirty results local when Cloudflare integration is disabled", async () => {
    deps = { ...deps, cfg: { ...cfg, ingestRemote: false } };
    setStateDate(db, "last_ingest_at", null);
    setStateDate(db, "last_sync_at", null);
    setState(db, "dirty_for_sync", "1");
    // A previously imported job can still finish locally without a write-back.
    await enqueue(ID_A);
    const tick = await runTick(deps);
    expect(tick).toMatchObject({ analyzed: ID_A, plan: { ingest: false, sync: false } });
    expect(deps.d1Query).not.toHaveBeenCalled();
    expect(deps.d1Write).not.toHaveBeenCalled();
    expect(deps.runSync).not.toHaveBeenCalled();
    expect(getState(db, "dirty_for_sync")).toBe("1");
    // Explicitly re-enabling integration makes the pending snapshot eligible.
    deps = { ...deps, cfg };
    await runTick(deps);
    expect(deps.runSync).toHaveBeenCalledTimes(1);
  });

  it.each([
    { code: 2, lastStderrLine: "download failed", rateLimited: false },
    { code: 5, lastStderrLine: "429", rateLimited: true },
  ])("keeps imported-job failure updates local when integration is disabled (%j)", async (outcome) => {
    deps = { ...deps, cfg: { ...cfg, ingestRemote: false, budget: { ...cfg.budget, maxAttempts: 1 } } };
    await enqueue(ID_A);
    deps.runAssess = vi.fn().mockResolvedValue(outcome);
    await runTick(deps);
    expect(await deps.ds.get("SELECT status FROM submission WHERE store_id=?", ID_A)).toMatchObject({ status: "failed" });
    expect(deps.d1Write).not.toHaveBeenCalled();
    expect(deps.runSync).not.toHaveBeenCalled();
  });

  it("fails a missing receipt rather than substituting an older report or re-spending", async () => {
    await successful(ID_A);
    const job = await enqueue(ID_A);
    deps.runAssess = vi.fn().mockResolvedValue({ code: 0, lastStderrLine: null, rateLimited: false });
    await runTick(deps);
    const row = await deps.ds.get("SELECT status, error, result_report_id FROM submission WHERE id=?",job.id);
    expect(row).toMatchObject({status: "failed",result_report_id:null});
    expect(row?.error).toContain("report was not recorded");
  });
  it("retains the recorded report when cancellation ends an artifact-producing attempt", async () => {
    const receipt = await successful(ID_A);
    const job = await enqueue(ID_A);
    deps.runAssess = vi.fn().mockResolvedValue({ ...receipt, code: null, cancelled: true });
    await runTick(deps);
    expect(await deps.ds.get("SELECT status,result_report_id FROM submission WHERE id=?", job.id)).toMatchObject({ status: "cancelled", result_report_id: receipt.resultReportId });
    expect(deps.runSync).toHaveBeenCalledOnce();
  });
  it("manual pause blocks claims and resume preserves custom daemon settings", async () => {
    await enqueue(ID_A);
    deps = { ...deps, cfg: { ...cfg, assessArgs: ["--model", "custom-daemon-model"] } };
    setState(db, "manual_pause", "1");
    expect((await runTick(deps)).plan.analyze).toBe(false);
    expect(deps.runAssess).not.toHaveBeenCalled();
    setState(db, "manual_pause", "0");
    await runTick(deps);
    expect(deps.runAssess).toHaveBeenCalledWith(ID_A, ["--model", "custom-daemon-model", "--db", cfg.db], undefined, expect.anything());
    expect(await deps.ds.get("SELECT value FROM runner_state WHERE key='analysis_policy'")).toBeUndefined();
  });

  it("links the actual incomplete result instead of a canonical report", async () => {
    await successful(ID_A);
    const actual = await successful(ID_A);
    const job = await enqueue(ID_A);
    deps.runAssess = vi.fn().mockResolvedValue({...actual,code:6});
    await runTick(deps);
    expect(await deps.ds.get("SELECT status,result_report_id FROM submission WHERE id=?",job.id)).toMatchObject({status:"succeeded",result_report_id:actual.resultReportId});
  });

  it("rate limit: requeues with backoff, snapshots the gauge, and probe-gates the resume", async () => {
    await enqueue(ID_A);
    deps.usedSeconds = vi.fn().mockReturnValue(1234);
    deps.runAssess = vi.fn().mockResolvedValue({ code: 5, lastStderrLine: "429", rateLimited: true });
    await runTick(deps);

    const row = (await deps.ds.get("SELECT status, attempts, not_before FROM submission WHERE store_id = ?", ID_A))!;
    expect(row.status).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(getStateDate(db, "backoff_until")).toEqual(new Date(NOW.getTime() + cfg.budget.backoffMs));
    const rl = db.prepare("SELECT detail FROM ledger_event WHERE kind = 'rate_limit'").get() as { detail: string };
    expect(JSON.parse(rl.detail)).toEqual({ sessionSeconds: 1234 });

    // Backoff active: the next tick does not analyze.
    deps.runAssess = vi.fn();
    await runTick(deps);
    expect(deps.runAssess).not.toHaveBeenCalled();

    // Backoff elapsed but the probe still says limited: backoff extends.
    clock = new Date(NOW.getTime() + cfg.budget.backoffMs + 1000);
    deps.probe = vi.fn().mockResolvedValue("limited");
    await runTick(deps);
    expect(deps.runAssess).not.toHaveBeenCalled();
    expect(getStateDate(db, "backoff_until")!.getTime()).toBe(clock.getTime() + cfg.budget.backoffMs);

    // Probe ok: backoff clears and the job runs.
    clock = new Date(clock.getTime() + cfg.budget.backoffMs + 1000);
    deps.probe = vi.fn().mockResolvedValue("ok");
    deps.runAssess = vi.fn().mockImplementation(successful);
    const r = await runTick(deps);
    expect(r.analyzed).toBe(ID_A);
    expect(getStateDate(db, "backoff_until")).toBeNull();
  });

  it("resumes a configured non-Ollama job after timed backoff without an Ollama probe", async () => {
    const configuration = snapshotSettings({ methodology: "monolith", model: "configured-model", provider: { id: "openai-compatible", baseUrl: "https://models.example/v1" } });
    await enqueue(ID_A, { configuration });
    deps.runAssess = vi.fn().mockResolvedValue({ code: 5, lastStderrLine: "429", rateLimited: true });
    deps.probe = vi.fn().mockResolvedValue("error");
    await runTick(deps);
    expect(getStateDate(db, "backoff_until")).toEqual(new Date(NOW.getTime() + cfg.budget.backoffMs));
    expect(db.prepare("SELECT COUNT(*) n FROM ledger_event WHERE kind='rate_limit'").get()!.n).toBe(0);
    expect(db.prepare("SELECT model,detail FROM ledger_event WHERE kind='provider_rate_limit'").get()).toMatchObject({ model: "configured-model", detail: JSON.stringify({ provider: "openai-compatible" }) });
    deps.runAssess = vi.fn().mockImplementation(successful);
    await runTick(deps);
    expect(deps.runAssess).not.toHaveBeenCalled();
    clock = new Date(NOW.getTime() + cfg.budget.backoffMs + 1000);
    expect((await runTick(deps)).analyzed).toBe(ID_A);
    expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.runAssess).toHaveBeenCalledWith(ID_A, [...cfg.assessArgs, "--db", cfg.db], configuration, expect.objectContaining({ storeId: ID_A, status: "running" }));
    expect(getStateDate(db, "backoff_until")).toBeNull();
    expect((await deps.ds.get("SELECT status FROM submission WHERE store_id=?", ID_A))?.status).toBe("succeeded");
  });

  it("probes a configured Ollama retry using its pinned connection and model", async () => {
    const configuration = snapshotSettings({ methodology: "pi", model: "configured-ollama-model", provider: { id: "ollama", baseUrl: "https://ollama.example/v1" } });
    await enqueue(ID_A, { configuration });
    setStateDate(db, "backoff_until", new Date(NOW.getTime() - 1000));
    deps.probe = vi.fn().mockResolvedValue("limited");
    await runTick(deps);
    expect(deps.probe).toHaveBeenCalledWith(configuration);
    expect(deps.runAssess).not.toHaveBeenCalled();
    clock = new Date(NOW.getTime() + cfg.budget.backoffMs + 1000);
    deps.probe = vi.fn().mockResolvedValue("ok");
    expect((await runTick(deps)).analyzed).toBe(ID_A);
    expect(deps.probe).toHaveBeenCalledWith(configuration);
  });

  it("lets an unavailable configured connection fail explicitly instead of probing forever", async () => {
    const configuration = snapshotSettings({ methodology: "pi", model: "configured-model", provider: { id: "ollama", baseUrl: "https://old.example/v1" } });
    const job = await enqueue(ID_A, { configuration });
    setStateDate(db, "backoff_until", new Date(NOW.getTime() - 1000));
    deps.probe = vi.fn().mockResolvedValue("unavailable");
    deps.runAssess = vi.fn().mockRejectedValue(new Error("Provider connection changed after enqueue"));
    await runTick(deps);
    expect((await deps.ds.get("SELECT status,error FROM submission WHERE id=?", job.id))).toMatchObject({ status: "failed", error: "Provider connection changed after enqueue" });
    expect(getStateDate(db, "backoff_until")).toBeNull();
  });

  it("does not spend on probes when no job is ready to retry", async () => {
    await enqueue(ID_A);
    await deps.ds.run("UPDATE submission SET not_before=?", new Date(NOW.getTime() + 60000).toISOString());
    setStateDate(db, "backoff_until", new Date(NOW.getTime() - 1000));
    await runTick(deps);
    expect(deps.probe).not.toHaveBeenCalled();
    expect(deps.runAssess).not.toHaveBeenCalled();
  });

  it("rate limit: fails the job (and writes back to D1) after maxAttempts", async () => {
    const tight = { ...cfg, budget: { ...cfg.budget, maxAttempts: 1 } };
    deps = { ...deps, cfg: tight };
    await enqueue(ID_A);
    deps.runAssess = vi.fn().mockResolvedValue({ code: 5, lastStderrLine: "429", rateLimited: true });
    await runTick(deps);
    const row = (await deps.ds.get("SELECT status FROM submission WHERE store_id = ?", ID_A))!;
    expect(row.status).toBe("failed");
    expect(deps.d1Write).toHaveBeenCalled();
  });

  it("per-extension failure: fails the row, writes back for remote source only", async () => {
    await enqueue(ID_A);
    deps.runAssess = vi.fn().mockResolvedValue({ code: 2, lastStderrLine: "download failed: HTTP 404", rateLimited: false });
    await runTick(deps);
    const row = (await deps.ds.get("SELECT status, error FROM submission WHERE store_id = ?", ID_A))!;
    expect(row).toMatchObject({ status: "failed", error: "download failed: HTTP 404" });
    expect(deps.d1Write).toHaveBeenCalledTimes(1);
    const statements = (deps.d1Write as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string[];
    expect(statements[0]).toContain(`store_id = '${ID_A}'`);

    // A discovery-source failure does NOT touch D1.
    (deps.d1Write as ReturnType<typeof vi.fn>).mockClear();
    await enqueue(ID_B, { source: "discovery", priority: 10 });
    await runTick(deps);
    expect(deps.d1Write).not.toHaveBeenCalled();
  });

  it("pauses analysis after maxConsecutiveFailures, then self-heals", async () => {
    deps.runAssess = vi.fn().mockResolvedValue({ code: 2, lastStderrLine: "boom", rateLimited: false });
    for (let i = 0; i < cfg.maxConsecutiveFailures; i++) {
      await enqueue(`${"abcdefgh"[i]!.repeat(32)}`);
      await runTick(deps);
    }
    const paused = getStateDate(db, "paused_until");
    expect(paused).not.toBeNull();

    // While paused: no claim.
    await enqueue(ID_B);
    deps.runAssess = vi.fn();
    await runTick(deps);
    expect(deps.runAssess).not.toHaveBeenCalled();

    // After the pause: work resumes.
    clock = new Date(paused!.getTime() + 1000);
    deps.runAssess = vi.fn().mockImplementation(successful);
    const r = await runTick(deps);
    expect(r.analyzed).toBe(ID_B);
  });

  it("budget: defers a discovery job on tight headroom but runs user work", async () => {
    await enqueue(ID_A, { source: "discovery", priority: 10 });
    deps.usedSeconds = vi.fn().mockReturnValue(cfg.budget.sessionCapSecondsFallback); // window fully spent
    deps.runAssess = vi.fn();
    let r = await runTick(deps);
    expect(r.analyzed).toBeNull();
    expect(deps.runAssess).not.toHaveBeenCalled();
    const row = (await deps.ds.get("SELECT status, attempts FROM submission WHERE store_id = ?", ID_A))!;
    expect(row).toMatchObject({ status: "queued", attempts: 0 }); // deferral burns nothing

    // A user job outranks it and runs despite the tight window.
    await enqueue(ID_B, { source: "remote", priority: 100 });
    deps.runAssess = vi.fn().mockImplementation(successful);
    r = await runTick(deps);
    expect(r.analyzed).toBe(ID_B);
  });

  it("a failing sync keeps the dirty flag for the retry path", async () => {
    await enqueue(ID_A);
    deps.runSync = vi.fn(() => {
      throw new Error("wrangler exploded");
    });
    await runTick(deps); // job succeeds → dirty → sync attempt throws
    expect(getState(db, "dirty_for_sync")).toBe("1");
  });
});
