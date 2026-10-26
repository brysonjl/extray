import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { openDb, recordRun } from "../src/db/index.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { registerAnalysisManagementRoutes } from "../src/server/analysis-management.ts";
import { devRoleResolver, roleMiddleware, type AppEnv } from "../src/server/role.ts";
import { DEFAULT_SETTINGS, type ExplorerSettings } from "../src/product/settings.ts";
import { snapshotSettings } from "../src/product/submission-config.ts";
import { listAnalysisProfiles, type AnalysisProfile } from "../src/product/analysis-profiles.ts";
import { DEFAULT_ANALYSIS_POLICY, loadAnalysisPolicy, readAnalysisPolicy, updateAnalysisPolicy, validateAnalysisPolicy } from "../src/product/analysis-policy.ts";
import { estimateAnalysis } from "../src/product/analysis-estimate.ts";
import { createSubmission, completeSubmission } from "../src/jobs/service.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";

let db: DatabaseSync; let ds: SqliteDataSource;
const settings: ExplorerSettings = { ...DEFAULT_SETTINGS, methodology: "monolith", model: "history-model", provider: { id: "openai-compatible", baseUrl: "https://models.example/v1", apiKey: "secret-never-in-a-profile" } };
const config = { methodology: "monolith", model: "history-model", options: { think: "high" } };
beforeEach(() => { db = openDb(":memory:"); ds = new SqliteDataSource(db); });
afterEach(() => db.close());
function app(enabled = true) {
  const app = new Hono<AppEnv>(); app.use("/api/*", roleMiddleware(devRoleResolver()));
  registerAnalysisManagementRoutes(app, { ds, enabled, resolveSettings: () => settings }); return app;
}
function request(path: string, method = "GET", body?: unknown, role = "admin") {
  return app().request(path, { method, headers: { "x-explorer-role": role, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

describe("analysis profile API", () => {
  it("supports persisted CRUD without saving connection credentials", async () => {
    const create = await request("/api/analysis-profiles", "POST", { name: "Thorough review", configuration: config });
    expect(create.status).toBe(201);
    const profile = await create.json() as AnalysisProfile;
    expect(profile.configuration.defaultsVersion).toBe(1);
    expect(profile.configuration.options).toMatchObject({ think: "high", verifierModel: "history-model", useCache: true });
    expect(JSON.stringify(profile)).not.toContain("secret-never-in-a-profile");
    expect(String(db.prepare("SELECT config_json FROM analysis_profile").get()!.config_json)).not.toContain("secret-never-in-a-profile");
    const listed = await (await request("/api/analysis-profiles")).json() as { profiles: AnalysisProfile[] };
    expect(listed.profiles).toHaveLength(1);
    expect((await request(`/api/analysis-profiles/${profile.id}`, "PUT", { name: "Economy", configuration: { ...config, options: { maxTokens: 5000 } } })).status).toBe(200);
    expect((await listAnalysisProfiles(ds))[0]).toMatchObject({ name: "Economy", configuration: { options: { maxTokens: 5000 } } });
    expect((await request(`/api/analysis-profiles/${profile.id}`, "DELETE")).status).toBe(200);
    expect((await listAnalysisProfiles(ds))).toEqual([]);
    expect((await request(`/api/analysis-profiles/${profile.id}`, "DELETE")).status).toBe(404);
  });
  it("rejects secrets, invalid options, names, and duplicate names", async () => {
    expect((await request("/api/analysis-profiles", "POST", { name: "", configuration: config })).status).toBe(400);
    expect((await request("/api/analysis-profiles", "POST", { name: "x", configuration: { ...config, provider: { apiKey: "must-not-store" } } })).status).toBe(400);
    expect((await request("/api/analysis-profiles", "POST", { name: "x", configuration: { ...config, options: { piShard: true } } })).status).toBe(400);
    await request("/api/analysis-profiles", "POST", { name: "Review", configuration: config });
    expect((await request("/api/analysis-profiles", "POST", { name: "review", configuration: config })).status).toBe(409);
    expect((await listAnalysisProfiles(ds))).toHaveLength(1);
  });
  it("gates every management route for public users and disabled installations", async () => {
    for (const [path, method, body] of [["/api/analysis-profiles", "GET"], ["/api/analysis-profiles", "POST", { name: "x", configuration: config }], ["/api/analysis-profiles/unknown", "DELETE"], ["/api/runner-policy", "GET"], ["/api/runner-policy", "PUT", { paused: true }], ["/api/analysis-estimate", "POST", { configuration: config }]] as const) {
      expect((await request(path, method, body, "user")).status).toBe(404);
      expect((await app(false).request(path, { method, headers: { "x-explorer-role": "admin" } })).status).toBe(404);
    }
    expect(await loadAnalysisPolicy(ds)).toBeNull();
  });
});

describe("persisted runner policy", () => {
  it("keeps existing file policy effective until explicitly saved, then persists validated partial updates", async () => {
    expect(await loadAnalysisPolicy(ds)).toBeNull();
    expect(await readAnalysisPolicy(ds)).toEqual(DEFAULT_ANALYSIS_POLICY);
    const saved = await updateAnalysisPolicy(ds, { paused: true, retryLimit: 2, discoveryEveryHours: 6, discoveryQueries: [{ source: "webstore", category: "productivity", limit: 8 }] });
    expect(saved.paused).toBe(true);
    expect(await loadAnalysisPolicy(new SqliteDataSource(db))).toEqual(saved);
    expect((await updateAnalysisPolicy(ds, { paused: false })).retryLimit).toBe(2);
    const payload = await (await request("/api/runner-policy")).json();
    expect(payload).toMatchObject({ saved: true, applies: "next-scheduling-tick", policy: { paused: false, retryLimit: 2 } });
  });
  it("shows manual pause overrides without materializing policy and clears them on explicit save", async () => {
    await ds.run("INSERT INTO runner_state VALUES('manual_pause','1','now')");
    expect(await loadAnalysisPolicy(ds)).toBeNull();
    expect((await readAnalysisPolicy(ds)).paused).toBe(true);
    await updateAnalysisPolicy(ds,{ paused:false,retryLimit:3 });
    expect(await ds.get("SELECT value FROM runner_state WHERE key='manual_pause'")).toBeUndefined();
    expect((await readAnalysisPolicy(ds)).paused).toBe(false);
    await ds.run("INSERT INTO runner_state VALUES('manual_pause','1','now')");
    const response=await (await request("/api/runner-policy")).json() as {policy:{paused:boolean}};
    expect(response.policy.paused).toBe(true);
  });
  it("rejects unsupported concurrency, invalid schedules and unknown fields without changing saved policy", async () => {
    for (const invalid of [{ maxConcurrent: 2 }, { retryLimit: -1 }, { discoveryEveryHours: .5 }, { discoveryQueries: [{ source: "external" }] }, { discoveryQueries: [] }, { budget: "unlimited" }, { minInstalls: "1000" }, { discoveryQueries: [{ source: "extpose", collection: "https://evil.example" }] }]) {
      expect(() => validateAnalysisPolicy(invalid)).toThrow();
      expect((await request("/api/runner-policy", "PUT", invalid)).status).toBe(400);
    }
    expect(await loadAnalysisPolicy(ds)).toBeNull();
    expect(validateAnalysisPolicy({ discoveryEnabled: false, discoveryQueries: [] }).discoveryQueries).toEqual([]);
  });
  it("fails closed on corrupted stored policy while allowing a valid repair", async () => {
    await ds.run("INSERT INTO runner_state(key,value,updated_at) VALUES ('analysis_policy','broken','now')");
    await expect(loadAnalysisPolicy(ds)).rejects.toThrow(/invalid/);
    await updateAnalysisPolicy(ds, { paused: true });
    expect((await readAnalysisPolicy(ds)).paused).toBe(true);
  });
});

describe("historical analysis estimates", () => {
  it("returns no fabricated estimate when history is missing", async () => {
    expect(await estimateAnalysis(ds, snapshotSettings(settings))).toMatchObject({ basis: "unavailable", sampleSize: 0, cost: null, tokens: null, durationSeconds: null });
    expect((await request("/api/analysis-estimate", "POST", { configuration: config, targets: 101 })).status).toBe(400);
  });
  it("prefers exact-config historical medians and preserves uncertainty for a batch", async () => {
    const configuration = snapshotSettings(settings);
    for (const [index, cost] of [1, 3, 20].entries()) {
      const storeId = String.fromCharCode(97 + index).repeat(32);
      const startedAt = new Date(Date.UTC(2026, 9, 18, 1, index)).toISOString();
      const runId = recordRun(db, { kind: "assess", methodology: settings.methodology, model: settings.model, mode: "RECORD", startedAt, targets: [{ storeId, isCorpus: false, estimatedUsd: cost, usage: { inputTokens: 100 * cost, outputTokens: 10 * cost }, usageByStep: [{ label: "analysis", model: settings.model, wallClockMs: 1000 * cost }] }] });
      const reportId = Number(db.prepare("SELECT id FROM report WHERE run_id=?").get(runId)!.id);
      const job = await createSubmission(ds, { inputRaw: storeId, storeId, profile: DEFAULT_PROFILE, configuration });
      await ds.run("UPDATE submission SET started_at=? WHERE id=?", startedAt, job.id);
      await completeSubmission(ds, job.id, { status: "succeeded", resultReportId: reportId, now: new Date(Date.parse(startedAt) + cost * 1000) });
    }
    const estimate = await estimateAnalysis(ds, configuration, 5);
    expect(estimate).toMatchObject({ basis: "exact-configuration", sampleSize: 3, targets: 5, cost: { medianUsd: 3, batchMedianUsd: 15 }, tokens: { median: 330 } });
    expect(estimate.cost!.lowUsd).toBeCloseTo(1.4);
    expect(estimate.cost!.highUsd).toBeCloseTo(16.6);
    expect(estimate.durationSeconds!.median).toBeCloseTo(3, 3);
    const fallback = await estimateAnalysis(ds, snapshotSettings({ ...settings, options: { maxTokens: 500 } }));
    expect(fallback.basis).toBe("same-methodology-model");
    expect(fallback.note).toMatch(/options.*may differ/);
    expect((await estimateAnalysis(ds, snapshotSettings({ ...settings, model: "unobserved-model" }))).basis).toBe("unavailable");
  });
});
