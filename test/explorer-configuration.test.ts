import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/index.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { createApp, type AppDeps } from "../src/server/app.ts";
import { DEFAULT_SETTINGS, type ExplorerSettings, type SettingsStore } from "../src/product/settings.ts";
import { snapshotSettings } from "../src/product/submission-config.ts";
import { getSubmission } from "../src/jobs/service.ts";

const STORE = "a".repeat(32);
let db: DatabaseSync;
let ds: SqliteDataSource;
let dir: string;
let defaults: ExplorerSettings;
let settings: SettingsStore;
let runSubmission = vi.fn<() => void>();
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "explorer-config-"));
  db = openDb(join(dir, "test.sqlite")); ds = new SqliteDataSource(db);
  defaults = { ...DEFAULT_SETTINGS, provider: { id: "ollama", baseUrl: "https://ollama.example.test", apiKey: "private-key-sentinel" }, options: { piShard: true, maxTokens: 10000 } };
  settings = { path: "/test/settings.json", read: () => structuredClone(defaults), write: (value) => { defaults = structuredClone(value); } };
  runSubmission = vi.fn<() => void>();
});
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
function makeApp(deps: Partial<AppDeps> = {}) { return createApp({ ds, settings, runSubmission, ...deps }); }
async function post(body: unknown, role = "admin", deps: Partial<AppDeps> = {}, path = "/api/submissions") {
  return makeApp(deps).request(path, { method: "POST", headers: { "content-type": "application/json", "x-explorer-role": role }, body: JSON.stringify(body) });
}
async function submittedId(body: unknown): Promise<number> {
  const response = await post(body); expect(response.status).toBe(201);
  const parsed = await response.json() as { jobId: number }; return parsed.jobId;
}
function jobCount(): number { return Number(db.prepare("SELECT COUNT(*) AS n FROM submission").get()!.n); }

describe("configured submission API", () => {
  it("freezes local defaults with no credential bytes and returns a durable queue identity", async () => {
    const id = await submittedId({ input: STORE, force: true });
    const before = (await getSubmission(ds, id))!;
    expect(before.configuration).toEqual(snapshotSettings(defaults));
    expect(before.source).toBe("admin");
    expect(runSubmission).toHaveBeenCalledOnce();
    const persisted = db.prepare("SELECT config_json,config_key FROM submission WHERE id=?").get(id)!;
    expect(JSON.stringify(persisted)).not.toContain("private-key-sentinel");
    const put = await makeApp().request("/api/settings", { method: "PUT", headers: { "x-explorer-role": "admin", "content-type": "application/json" }, body: JSON.stringify({ methodology: "monolith", model: "another-model", options: { think: "low", maxTokens: 20000 } }) });
    expect(put.status).toBe(200);
    expect((await getSubmission(ds, id))!.configuration).toEqual(before.configuration);
    const detail = await makeApp().request(`/api/analyses/${id}`, { headers: { "x-explorer-role": "admin" } });
    const payload = await detail.json() as { configuration: unknown };
    expect(payload.configuration).toEqual(before.configuration);
    expect(JSON.stringify(payload)).not.toContain("private-key-sentinel");
  });
  it("resolves per-job methodology, model and option overrides without changing defaults", async () => {
    const id = await submittedId({ input: STORE, force: true, configuration: { methodology: "monolith", model: "custom-model", options: { think: "high", verifierModel: "independent-verifier", maxTokens: 50000 } } });
    expect((await getSubmission(ds, id))!.configuration).toMatchObject({ methodology: "monolith", model: "custom-model", provider: { id: "ollama" }, options: { think: "high", verifierModel: "independent-verifier", maxTokens: 50000 } });
    expect(defaults.methodology).toBe("pi"); expect(defaults.model).toBe(DEFAULT_SETTINGS.model);
  });
  it("keeps different configurations distinct and deduplicates equivalent active configs", async () => {
    const first = await submittedId({ input: STORE, force: true, configuration: { model: "first-model" } });
    const second = await submittedId({ input: STORE, force: true, configuration: { model: "second-model" } });
    expect(second).not.toBe(first); expect(jobCount()).toBe(2);
    const duplicate = await post({ input: STORE, force: true, configuration: { model: "first-model", options: { maxTokens: 10000, piShard: true } } });
    expect(duplicate.status).toBe(200); expect(await duplicate.json()).toMatchObject({ jobId: first });
    expect(jobCount()).toBe(2); expect(runSubmission).toHaveBeenCalledTimes(2);
  });
  it("rejects credential, connection, filesystem and arbitrary configuration fields before enqueue", async () => {
    for (const configuration of [{ apiKey: "bad-secret" }, { provider: { id: "openai", apiKey: "bad-secret" } }, { baseUrl: "https://evil.example" }, { outputPath: "/tmp/report" }, { args: ["--anything"] }, { version: 99 }, { options: { apiKey: "bad-secret" } }]) {
      const response = await post({ input: STORE, configuration });
      expect(response.status).toBe(400); expect(await response.text()).not.toContain("bad-secret");
    }
    expect(jobCount()).toBe(0); expect(runSubmission).not.toHaveBeenCalled();
  });
  it("rejects unsupported combinations and malformed bodies", async () => {
    for (const body of [null, [], "hello", { input: STORE, configuration: null }, { input: STORE, configuration: [] }, { input: STORE, configuration: { methodology: "pi", options: { replay: true } } }, { input: STORE, configuration: { options: { maxTokens: -1 } } }]) expect((await post(body)).status).toBe(400);
    expect(jobCount()).toBe(0); expect(runSubmission).not.toHaveBeenCalled();
  });
  it("rejects explicit configuration for users and unavailable local capabilities", async () => {
    const body = { input: STORE, configuration: { model: "custom" } };
    expect((await post(body, "user")).status).toBe(403);
    expect((await post(body, "admin", { settings: undefined })).status).toBe(403);
    expect((await post(body, "admin", { runSubmission: undefined })).status).toBe(403);
    expect(jobCount()).toBe(0); expect(runSubmission).not.toHaveBeenCalled();
  });
  it("freezes defaults for local user submissions while keeping user priority", async () => {
    const response = await post({ input: STORE }, "user");
    expect(response.status).toBe(201);
    const { jobId } = await response.json() as { jobId: number };
    const before = (await getSubmission(ds, jobId))!;
    expect(before.configuration).toMatchObject({ version: 1, model: DEFAULT_SETTINGS.model });
    expect(before.source).toBe("user");
    defaults.model = "changed-after-enqueue";
    expect((await getSubmission(ds, jobId))!.configuration).toEqual(before.configuration);
  });
  it("scrubs raw diagnostics on the legacy user status endpoint", async () => {
    const id = await submittedId({ input: STORE });
    db.prepare("UPDATE submission SET status='failed',error=? WHERE id=?").run("Provider failed apiKey=private-key-sentinel", id);
    const response = await makeApp().request(`/api/submissions/${id}?storeId=${STORE}`, { headers: { "x-explorer-role": "user" } });
    expect(await response.text()).not.toContain("private-key-sentinel");
  });
  it("does not disclose configuration or credentials to users polling a joined submission", async () => {
    const id = await submittedId({ input: STORE, force: true, configuration: { model: "custom-private-model" } });
    const response = await makeApp().request(`/api/submissions/${id}?storeId=${STORE}`, { headers: { "x-explorer-role": "user" } });
    expect(response.status).toBe(200);
    const wire = await response.text();
    expect(wire).not.toContain("custom-private-model"); expect(wire).not.toContain("private-key-sentinel"); expect(wire).not.toContain("configuration");
  });
});

describe("batch submission validation", () => {
  function capability() { return { start: vi.fn(() => ({ batchId: "test-batch" })), active: () => [], status: () => null }; }
  it("rejects a batch atomically when any target is invalid", async () => {
    const analyzeBatch = capability();
    for (const body of [null, [], { storeIds: [STORE, "invalid"] }, { storeIds: [STORE, 123] }, { storeIds: [] }, { storeIds: Array(101).fill(STORE) }]) expect((await post(body, "admin", { analyzeBatch }, "/api/analyze-batch")).status).toBe(400);
    expect(analyzeBatch.start).not.toHaveBeenCalled(); expect(jobCount()).toBe(0);
  });
  it("passes the frozen config and deduplicated targets into the batch capability", async () => {
    const analyzeBatch = capability();
    expect((await post({ storeIds: [STORE, STORE], configuration: { model: "batch-model" } }, "admin", { analyzeBatch }, "/api/analyze-batch")).status).toBe(202);
    expect(analyzeBatch.start).toHaveBeenCalledWith([STORE], expect.objectContaining({ version: 1, model: "batch-model", provider: { id: "ollama", baseUrl: "https://ollama.example.test" } }));
    expect(JSON.stringify(analyzeBatch.start.mock.calls)).not.toContain("private-key-sentinel");
  });
  it("rejects unsupported batch configuration rather than silently ignoring it", async () => {
    const analyzeBatch = capability();
    const body = { storeIds: [STORE], configuration: { model: "batch-model" } };
    expect((await post(body, "admin", { analyzeBatch, settings: undefined }, "/api/analyze-batch")).status).toBe(403);
    expect((await post(body, "admin", { analyzeBatch, runSubmission: undefined }, "/api/analyze-batch")).status).toBe(403);
    expect(analyzeBatch.start).not.toHaveBeenCalled();
  });
});
