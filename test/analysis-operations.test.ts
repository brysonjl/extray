import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/index.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";
import { DEFAULT_SETTINGS } from "../src/product/settings.ts";
import { snapshotSettings } from "../src/product/submission-config.ts";
import { analysisDetail, analysisEvents, listAnalyses, runnerSnapshot } from "../src/product/analyses.ts";
import { appendAnalysisEvent } from "../src/jobs/events.ts";
import { cancelSubmission, claimNextSubmission, completeSubmission, createSubmission, getSubmission, reprioritizeSubmission, resetRunning, retrySubmission, requeueSubmission } from "../src/jobs/service.ts";
import { acquireExecutor } from "../src/runner/ownership.ts";
import { recordAssessStage } from "../src/runner/progress-node.ts";
import { createApp } from "../src/server/app.ts";
import { resolveRunnerSubmissionConfig } from "../src/runner/configuration.ts";
import { DEFAULT_ASSESS_ARGS } from "../src/product/assess-args.ts";
const STORE = "a".repeat(32), NOW = new Date("2026-10-18T12:00:00Z");
let db: DatabaseSync, ds: SqliteDataSource, dir: string, path: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "analysis-operations-")); path = join(dir, "db.sqlite"); db = openDb(path); ds = new SqliteDataSource(db); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); db.close(); rmSync(dir, { recursive: true, force: true }); });
async function enqueue(storeId = STORE) { return createSubmission(ds, { inputRaw: storeId, storeId, profile: DEFAULT_PROFILE, configuration: snapshotSettings(DEFAULT_SETTINGS), now: NOW }); }
function app(local = true) { return createApp({ ds, now: () => NOW, ...(local ? { runSubmission: vi.fn() } : {}) }); }
function request(route: string, method = "POST", role = "admin", body: unknown = {}, local = true) { return app(local).request(route, { method, headers: { "content-type": "application/json", "x-explorer-role": role }, body: method === "GET" ? undefined : JSON.stringify(body) }); }

describe("durable analysis operations", () => {
  it("cancels queued work atomically so later claim and completion cannot revive it", async () => {
    const job = await enqueue();
    expect((await cancelSubmission(ds, job.id, NOW)).status).toBe("cancelled");
    expect(await claimNextSubmission(ds, NOW)).toBeNull();
    await completeSubmission(ds, job.id, { status: "succeeded" });
    expect((await getSubmission(ds, job.id))?.status).toBe("cancelled");
    expect((await cancelSubmission(ds, job.id, NOW)).status).toBe("cancelled");
  });
  it("claim winning the cancellation race records a request until execution acknowledges", async () => {
    const job = await enqueue();
    const [claimed, cancelled] = await Promise.all([claimNextSubmission(ds, NOW), cancelSubmission(ds, job.id, NOW)]);
    expect(claimed?.id).toBe(job.id); expect(cancelled.status).toBe("running");
    expect((await getSubmission(ds, job.id))?.cancelRequestedAt).toBe(NOW.toISOString());
    await completeSubmission(ds, job.id, { status: "cancelled", now: NOW });
    const detail = await analysisDetail(ds, job.id, DEFAULT_PROFILE, NOW);
    expect(detail?.status).toBe("cancelled"); expect(detail?.attempts?.[0]?.status).toBe("cancelled");
    expect(detail?.events?.map((e) => e.kind)).toContain("cancel-requested");
  });
  it("cancellation winning the claim race never starts an attempt", async () => {
    const job = await enqueue();
    const [cancelled, claimed] = await Promise.all([cancelSubmission(ds, job.id, NOW), claimNextSubmission(ds, NOW)]);
    expect(cancelled.status).toBe("cancelled"); expect(claimed).toBeNull();
    expect((await analysisDetail(ds, job.id, DEFAULT_PROFILE, NOW))?.attempts).toEqual([]);
  });
  it("keeps attempts through retry delays and recovery, acknowledges orphan cancellation", async () => {
    const job = await enqueue();
    await claimNextSubmission(ds, NOW);
    await requeueSubmission(ds, job.id, { notBefore: NOW });
    await claimNextSubmission(ds, NOW);
    await cancelSubmission(ds, job.id, NOW);
    db.close(); db = openDb(path); ds = new SqliteDataSource(db);
    expect(await resetRunning(ds)).toBe(1);
    const detail = await analysisDetail(ds, job.id, DEFAULT_PROFILE, NOW);
    expect(detail?.status).toBe("cancelled");
    expect(detail?.attempts?.map((attempt) => attempt.status)).toEqual(["retry-delay", "interrupted"]);
    expect(await claimNextSubmission(ds, NOW)).toBeNull();
  });
  it("retries preserve settings and record lineage while concurrent retries join one child", async () => {
    const job = await enqueue(); await claimNextSubmission(ds, NOW); await completeSubmission(ds, job.id, { status: "failed", now: NOW });
    const retried = await Promise.all(Array.from({ length: 5 }, () => retrySubmission(ds, job.id, NOW)));
    expect(new Set(retried.map((j) => j.id)).size).toBe(1);
    expect(retried[0]?.retryOf).toBe(job.id); expect(retried[0]?.configuration).toEqual(job.configuration);
    expect(retried[0]?.id).not.toBe(job.id);
    expect((await getSubmission(ds, job.id))?.status).toBe("failed");
    await expect(retrySubmission(ds, retried[0]!.id, NOW)).rejects.toThrow("finished");
  });
  it("honors cancellation arriving after recovery reads the orphaned row", async () => {
    const job = await enqueue(); await claimNextSubmission(ds, NOW);
    const original = ds.run.bind(ds);
    let intercepted = false;
    vi.spyOn(ds, "run").mockImplementation(async (sql, ...params) => {
      if (!intercepted && sql.startsWith("UPDATE analysis_attempt SET status='interrupted'")) {
        intercepted = true;
        await cancelSubmission(ds, job.id, NOW);
      }
      return original(sql, ...params);
    });
    await resetRunning(ds);
    expect(intercepted).toBe(true);
    expect((await getSubmission(ds, job.id))?.status).toBe("cancelled");
    expect(await claimNextSubmission(ds, NOW)).toBeNull();
  });
  it("changes only queued priority and reports batch membership including joined jobs", async () => {
    const first = await enqueue(), second = await enqueue("b".repeat(32));
    await reprioritizeSubmission(ds, second.id, 999, NOW);
    expect((await claimNextSubmission(ds, NOW))?.id).toBe(second.id);
    await expect(reprioritizeSubmission(ds, second.id, 5, NOW)).rejects.toThrow("queued");
    await expect(reprioritizeSubmission(ds, first.id, 1001, NOW)).rejects.toThrow("1000");
    await ds.run("INSERT INTO analysis_batch_item VALUES (?,?,?)", "batch-1", first.id, NOW.toISOString());
    expect((await listAnalyses(ds, { batchId: "batch-1", status: "all" }, NOW)).rows.map((r) => r.jobId)).toEqual([first.id]);
  });
  it("records actual stage boundaries, survives reopening, and rejects obsolete attempt callbacks", async () => {
    const job = await enqueue(); const claimed = await claimNextSubmission(ds, NOW);
    vi.stubEnv("EXTRAY_ANALYSIS_DB", path); vi.stubEnv("EXTRAY_ANALYSIS_JOB_ID", String(job.id)); vi.stubEnv("EXTRAY_ANALYSIS_ATTEMPT_ID", String(claimed?.currentAttemptId));
    await recordAssessStage("preparation", "started", "Preparing package");
    await recordAssessStage("preparation", "finished", "Package ready");
    await recordAssessStage("pi:exfiltration", "started", "Pi dimension started");
    expect((await listAnalyses(ds, {}, NOW)).rows[0]?.currentStage).toBe("pi:exfiltration");
    const before = await analysisEvents(ds, job.id, 0);
    vi.stubEnv("EXTRAY_ANALYSIS_ATTEMPT_ID", "99999"); await recordAssessStage("synthesis", "started", "obsolete callback");
    expect((await analysisEvents(ds, job.id, 0)).events).toHaveLength(before.events.length);
    db.close(); db = openDb(path); ds = new SqliteDataSource(db);
    expect((await analysisEvents(ds, job.id, before.events[1]!.sequence)).events.map((e) => e.stage)).toEqual(["preparation", "preparation", "pi:exfiltration"]);
    await appendAnalysisEvent(ds, job.id, { kind: "note", message: 'HTTP 400: {"apiKey":"hidden-secret"}' });
    expect(JSON.stringify(await analysisEvents(ds, job.id, 0))).not.toContain("hidden-secret");
    await requeueSubmission(ds, job.id, { notBefore: NOW }); await claimNextSubmission(ds, NOW);
    expect((await listAnalyses(ds, {}, NOW)).rows[0]?.currentStage).toBeNull();
  });
  it("reports authoritative heartbeat freshness without exposing executor identity", async () => {
    const release = acquireExecutor(db)!;
    const online = await runnerSnapshot(ds, true, new Date());
    expect(online.liveness).toBe("online"); expect(online.heartbeatAt).toBeTruthy();
    expect(JSON.stringify(online)).not.toContain('"pid"'); expect(JSON.stringify(online)).not.toContain('"token"');
    expect((await runnerSnapshot(ds, true, new Date(Date.now() + 25000))).liveness).toBe("stale");
    expect((await runnerSnapshot(ds, false, new Date(Date.now() + 45000))).liveness).toBe("online");
    expect((await runnerSnapshot(ds, false, new Date(Date.now() + 95000))).liveness).toBe("stale");
    release(); expect((await runnerSnapshot(ds, true, new Date())).liveness).toBe("offline");
  });
});

describe("operation route authorization and validation", () => {
  it("gates all writes by admin and local executor, validates priority, and rejects finished cancellation", async () => {
    const job = await enqueue();
    for (const route of [`/api/analyses/${job.id}/cancel`, `/api/analyses/${job.id}/retry`, "/api/runner/pause", "/api/runner/resume"]) {
      expect((await request(route, "POST", "user")).status).toBe(404);
      expect((await request(route, "POST", "admin", {}, false)).status).toBe(404);
    }
    expect((await request(`/api/analyses/${job.id}`, "PATCH", "admin", { priority: -1 })).status).toBe(400);
    expect((await request(`/api/analyses/${job.id}`, "PATCH", "admin", { priority: 99, status: "failed" })).status).toBe(400);
    expect((await request(`/api/analyses/${job.id}`, "PATCH", "admin", { priority: 99 })).status).toBe(200);
    await completeSubmission(ds, job.id, { status: "failed" });
    expect((await request(`/api/analyses/${job.id}/cancel`)).status).toBe(409);
    expect((await request(`/api/analyses/${job.id}/retry`)).status).toBe(201);
    expect((await request(`/api/analyses/${job.id}/events?after=NaN`, "GET")).status).toBe(400);
    expect((await request(`/api/analyses/${job.id}/events`, "GET", "user")).status).toBe(404);
  });
  it("pause/resume preserves custom daemon defaults and running work", async () => {
    const job = await enqueue(); await claimNextSubmission(ds, NOW);
    expect((await request("/api/runner/pause")).status).toBe(200);
    expect((await runnerSnapshot(ds, true, NOW)).paused).toBe(true);
    expect(await ds.get("SELECT value FROM runner_state WHERE key='analysis_policy'")).toBeUndefined();
    await enqueue("b".repeat(32));
    expect(await claimNextSubmission(ds, NOW)).toBeNull();
    expect((await getSubmission(ds, job.id))?.status).toBe("running");
    expect((await request("/api/runner/resume")).status).toBe(200);
    expect((await runnerSnapshot(ds, true, NOW)).paused).toBe(false);
  });
});

it("snapshots the standard daemon CLI including shard model and refresh semantics", () => {
  const base = { ...DEFAULT_SETTINGS, provider: { id: "ollama" as const, baseUrl: "https://ollama.com/v1" } };
  const config = resolveRunnerSubmissionConfig(DEFAULT_ASSESS_ARGS, base);
  expect(config).toMatchObject({ methodology: "pi", model: "glm-5.2:cloud", options: { piShard: true, piSubagentModel: "minimax-m2.7:cloud", enrich: true, forceFresh: true } });
  expect(resolveRunnerSubmissionConfig([...DEFAULT_ASSESS_ARGS, "--headroom"], base)).toBeUndefined();
});
