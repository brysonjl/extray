import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { openDb, recordRun } from "../src/db/index.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";
import { createApp } from "../src/server/app.ts";

const NOW = new Date("2026-10-18T12:00:00.000Z");
const STORE = "a".repeat(32);
let db: DatabaseSync;
let ds: SqliteDataSource;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "explorer-analyses-"));
  db = openDb(join(dir, "test.sqlite"));
  ds = new SqliteDataSource(db);
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
function app(local = false) { return createApp({ ds, now: () => NOW, profile: DEFAULT_PROFILE, ...(local ? { runSubmission() {} } : {}) }); }
async function get(path: string, role = "admin", local = false) { return app(local).request(path, { headers: { "x-explorer-role": role } }); }
// Test-side JSON assertions inspect heterogeneous endpoint payloads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(path: string): Promise<any> { return (await get(path)).json(); }
function insert(status = "queued", extra: Record<string, string | number | null> = {}) {
  const row = { input_raw: `https://chromewebstore.google.com/detail/example/${STORE}`, store_id: STORE, status, created_at: NOW.toISOString(), profile_json: JSON.stringify({ ...DEFAULT_PROFILE, apiKey: "secret-profile-token" }), requested_by: "private@example.com", ...extra };
  const keys = Object.keys(row);
  return Number(db.prepare(`INSERT INTO submission (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...Object.values(row)).lastInsertRowid);
}
function seed() {
  return [
    insert("queued", { source: "user", priority: 50, created_at: "2026-10-18T11:00:00.000Z" }),
    insert("queued", { source: "discovery", priority: 10, not_before: "2026-10-18T13:00:00.000Z", attempts: 2 }),
    insert("running", { source: "admin", started_at: "2026-10-18T11:59:00.000Z" }),
    insert("failed", { error: "upstream failed", finished_at: NOW.toISOString() }),
    insert("succeeded", { finished_at: NOW.toISOString() }),
  ];
}

describe("admin analysis workspace API", () => {
  it("authorizes every global endpoint using server role, including spoofed admin lens", async () => {
    const [id] = seed();
    for (const path of ["/api/analyses", `/api/analyses/${id}`, "/api/runner"]) {
      expect((await get(path, "user")).status).toBe(404);
      const restricted = createApp({ ds, roleResolver: () => "user" });
      expect((await restricted.request(`${path}?lens=admin`, { headers: { "x-explorer-role": "admin" } })).status).toBe(404);
    }
    expect(await (await get("/api/meta", "admin")).json()).toHaveProperty("analyses", true);
    expect(await (await get("/api/meta", "user")).json()).not.toHaveProperty("analyses");
  });
  it("lists active jobs with honest retry eligibility, global counts and queue priority", async () => {
    const [ready, delayed, running] = seed();
    const body = await json("/api/analyses");
    expect(body.rows.map((r: { jobId: number }) => r.jobId)).toEqual([running, ready, delayed]);
    expect(body.counts).toEqual({ queued: 2, running: 1, succeeded: 1, failed: 1, cancelled: 0, ready: 1, delayed: 1 });
    expect(body.rows[2]).toMatchObject({ retryCount: 2, eligibility: "retry-delay", priority: 10 });
    expect(body.rows[0].eligibility).toBe("not-applicable");
    expect(body.queueMetadataAvailable).toBe(true);
    expect(body.observedAt).toBe(NOW.toISOString());
    const wire = JSON.stringify(body);
    expect(wire).not.toContain("private@example.com"); expect(wire).not.toContain("secret-profile-token"); expect(wire).not.toContain("profile_json");
  });
  it("filters status, source, search and pagination without changing global counts", async () => {
    const ids = seed();
    expect((await json("/api/analyses?status=history")).total).toBe(2);
    expect((await json("/api/analyses?status=failed")).rows[0].jobId).toBe(ids[3]);
    expect((await json("/api/analyses?source=discovery")).rows[0].jobId).toBe(ids[1]);
    expect((await json("/api/analyses?status=all&source=unknown")).total).toBe(2);
    expect((await json(`/api/analyses?q=${STORE.slice(0, 12)}`)).total).toBe(3);
    expect((await json("/api/analyses?q=chromewebstore")).total).toBe(3);
    const paged = await json("/api/analyses?status=all&sort=oldest&pageSize=2&page=2");
    expect(paged).toMatchObject({ page: 2, pageSize: 2, total: 5 });
    expect(paged.rows.map((r: { jobId: number }) => r.jobId)).toEqual(ids.slice(2, 4));
    expect((await json("/api/analyses?status=all&sort=newest&pageSize=1")).rows[0].jobId).toBe(ids[4]);
    expect((await json("/api/analyses?status=all&page=100")).rows).toEqual([]);
  });
  it("rejects invalid filters and pagination; binds and escapes search literally", async () => {
    seed();
    for (const query of ["sort=created_at;DROP TABLE submission", "status=invalid", "source=anything", "page=0", "page=-1", "page=1.5", "page=Infinity", "pageSize=101", "pageSize=0", `q=${"x".repeat(201)}`]) expect((await get(`/api/analyses?${query}`)).status).toBe(400);
    for (const q of ["' OR 1=1 --", "%", "_", "\\"]) expect((await json(`/api/analyses?q=${encodeURIComponent(q)}`)).total).toBe(0);
    expect((await json("/api/analyses?status=all")).total).toBe(5);
  });
  it("reports missing IDs and malformed profiles without crashing", async () => {
    const id = insert("queued", { profile_json: "bad json" });
    const detail = await json(`/api/analyses/${id}`);
    expect(detail.profile).toBeNull(); expect(detail.configuration).toBeNull(); expect(detail.result).toBeNull();
    for (const raw of ["99999", "nope", "-1", "90071992547409920"]) expect((await get(`/api/analyses/${raw}`)).status).toBe(404);
  });
  it("projects pinned profile only, and bounds/scrubs diagnostics", async () => {
    const id = insert("failed", { error: "request failed api_key=secret123 Bearer token123 https://user:pw@example.com/path?token=hidden" });
    const body = await json(`/api/analyses/${id}`);
    expect(body.profile).toEqual(DEFAULT_PROFILE.pinned);
    for (const secret of ["secret123", "token123", "user:pw", "hidden", "secret-profile-token"]) expect(JSON.stringify(body)).not.toContain(secret);
    const raw = insert("failed", { error: JSON.stringify({ apiKey: "sensitive" }) });
    expect((await json(`/api/analyses/${raw}`)).error).not.toContain("sensitive");
    const embedded = insert("failed", { error: 'HTTP 400: {"apiKey":"embedded-secret"}' });
    expect((await json(`/api/analyses/${embedded}`)).error).not.toContain("embedded-secret");
  });
  it("returns validated configuration without credentials or arbitrary stored JSON", async () => {
    const config = { version: 1, methodology: "pi", model: "glm-5.2:cloud", apiKey: "top-secret", provider: { id: "ollama", apiKey: "nested-secret" }, options: { piShard: true, maxTokens: 50000 } };
    const id = insert("queued", { config_json: JSON.stringify(config) });
    const body = await json(`/api/analyses/${id}`);
    expect(body.configuration).toMatchObject({ version: 1, methodology: "pi", model: "glm-5.2:cloud", provider: { id: "ollama" }, options: { piShard: true, maxTokens: 50000 } });
    expect(JSON.stringify(body)).not.toContain("secret");
    db.prepare("UPDATE submission SET config_json = ? WHERE id = ?").run(JSON.stringify({ ...config, version: 99 }), id);
    expect((await json(`/api/analyses/${id}`)).configuration).toBeNull();
    db.prepare("UPDATE submission SET config_json = ? WHERE id = ?").run(JSON.stringify({ ...config, provider: { id: "ollama", baseUrl: "https://example.com?token=hidden" } }), id);
    expect((await json(`/api/analyses/${id}`)).configuration).toBeNull();
  });
  it("links only the recorded result and preserves investigation outcome", async () => {
    const record = (model: string) => recordRun(db, { kind: "assess", methodology: "pi", model, startedAt: "2026-10-18T10:00:00.000Z", targets: [{ storeId: STORE, sourceDir: "fake", isCorpus: false, structured: { risk_report: { extension: { name: "Recorded extension", version: "1" }, verdict: { tier: "low-risk", rationale: "Test" }, findings: [], outcome: { artifact_generated: true, investigation: "incomplete", final_submission: "not-accepted", reasons: ["Turn limit reached"] } } } }] });
    record("custom-model");
    const reportId = Number(db.prepare("SELECT id FROM report").get()!.id);
    record(DEFAULT_PROFILE.pinned.model);
    const id = insert("succeeded", { result_report_id: reportId });
    const body = await json(`/api/analyses/${id}`);
    expect(body.result).toMatchObject({ reportId, model: "custom-model", storeId: STORE, outcome: { investigation: "incomplete", final_submission: "not-accepted", reasons: ["Turn limit reached"] } });
    expect(body.name).toBe("Recorded extension");
    db.prepare("DELETE FROM report WHERE id = ?").run(reportId);
    expect((await json(`/api/analyses/${id}`)).result).toBeNull();
  });
  it("runner exposes database facts without claiming heartbeat/liveness", async () => {
    seed();
    db.prepare("INSERT INTO runner_state (key,value,updated_at) VALUES (?,?,?)").run("paused_until", "2026-10-18T13:00:00Z", NOW.toISOString());
    db.prepare("INSERT INTO runner_state (key,value,updated_at) VALUES (?,?,?)").run("last_sync_at", NOW.toISOString(), NOW.toISOString());
    db.prepare("INSERT INTO runner_state (key,value,updated_at) VALUES (?,?,?)").run("dirty_for_sync", "1", NOW.toISOString());
    const snapshot = await (await get("/api/runner", "admin", true)).json();
    expect(snapshot).toMatchObject({ mode: "local", liveness: "unknown", stateAvailable: true, lastSyncAt: NOW.toISOString(), dirtyForSync: true, pausedUntil: "2026-10-18T13:00:00.000Z" });
    expect((await json("/api/runner")).mode).toBe("external");
    expect(snapshot).not.toHaveProperty("heartbeat");
  });
});

describe("legacy hosted and empty databases", () => {
  function legacy() {
    db.exec(`DROP TABLE submission; DROP TABLE runner_state;
      CREATE TABLE submission (id INTEGER PRIMARY KEY, input_raw TEXT, store_id TEXT, status TEXT, profile_json TEXT, requested_by TEXT, created_at TEXT, started_at TEXT, finished_at TEXT, error TEXT, result_report_id INTEGER);`);
  }
  it("reads v5 without inventing queue metadata or execution status", async () => {
    legacy(); const id = insert();
    const body = await json("/api/analyses");
    expect(body.queueMetadataAvailable).toBe(false);
    expect(body.rows[0]).toMatchObject({ jobId: id, source: null, priority: null, retryCount: null, eligibility: "unknown" });
    expect(body.counts).toMatchObject({ queued: 1, ready: null, delayed: null });
    expect((await json("/api/analyses?source=discovery")).total).toBe(0);
    expect((await json("/api/analyses?source=unknown")).total).toBe(1);
    expect((await json(`/api/analyses/${id}`)).profile).toEqual(DEFAULT_PROFILE.pinned);
    expect(await json("/api/runner")).toMatchObject({ mode: "external", stateAvailable: false, dirtyForSync: null, liveness: "unknown" });
  });
  it("returns empty collections and unavailable facts when tables are absent", async () => {
    legacy(); db.exec("DROP TABLE submission");
    expect(await json("/api/analyses")).toMatchObject({ rows: [], total: 0, queueMetadataAvailable: false });
    expect((await get("/api/analyses/1")).status).toBe(404);
    expect(await json("/api/runner")).toMatchObject({ stateAvailable: false, counts: { ready: null, delayed: null } });
  });
});
