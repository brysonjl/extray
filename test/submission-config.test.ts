import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/index.ts";
import { SCHEMA_VERSION } from "../src/db/schema.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";
import { DEFAULT_SETTINGS, type ExplorerSettings } from "../src/product/settings.ts";
import { configurationKey, parseSubmissionConfig, snapshotSettings } from "../src/product/submission-config.ts";
import { claimNextSubmission, completeSubmission, createSubmission, findConfiguredSubmission, getSubmission } from "../src/jobs/service.ts";

const SECRET = "sk-snapshot-must-never-contain-me";
const storeId = "a".repeat(32);
const sourceSettings = (): ExplorerSettings => ({
  methodology: "monolith", model: "model-a",
  provider: { id: "openai-compatible", baseUrl: "https://models.example/v1", apiKey: SECRET },
  options: { think: "high", maxTokens: 12345 },
});
const dbs: DatabaseSync[] = [];
const dirs: string[] = [];
const dbForTest = () => { const db = openDb(":memory:"); dbs.push(db); return db; };
afterEach(() => { for (const db of dbs.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("submission configuration snapshots", () => {
  it("copies validated nonsecret settings independently of future settings mutations", () => {
    const settings = sourceSettings();
    const config = snapshotSettings(settings);
    settings.model = "changed";
    settings.provider.baseUrl = "https://other.example/v1";
    settings.options!.maxTokens = 1;
    expect(config).toEqual({ version: 1, defaultsVersion: 1, defaultSemantics: { maxTokens: "explicit", think: "explicit" }, methodology: "monolith", model: "model-a", provider: { id: "openai-compatible", baseUrl: "https://models.example/v1" }, options: { think: "high", maxTokens: 12345, verifierModel: "model-a", enrich: false, forceFresh: false, useCache: true, replay: false } });
    expect(JSON.stringify(config)).not.toContain(SECRET);
  });

  it("pins versioned defaults and preserves historical unknown defaults", () => {
    const pi = snapshotSettings(DEFAULT_SETTINGS);
    expect(pi.defaultsVersion).toBe(1);
    expect(pi.options).toMatchObject({ piMaxTurns: 50, piShard: false, piNoPack: false, verifierModel: DEFAULT_SETTINGS.model, enrich: false, forceFresh: false, useCache: true });
    expect(pi.defaultSemantics).toEqual({ maxTokens: "unlimited", think: "provider-default" });
    const historical = { version: 1, methodology: "pi", model: "older-model", provider: { id: "ollama" } };
    expect(parseSubmissionConfig(historical)).toEqual(historical);
    expect(parseSubmissionConfig({ ...pi, defaultsVersion: 2 })).toBeNull();
  });

  it("never echoes secret or unknown nested provider fields from stored configuration", () => {
    const config = snapshotSettings(sourceSettings());
    const parsed = parseSubmissionConfig(JSON.stringify({ ...config, secret: SECRET, provider: { ...config.provider, apiKey: SECRET, extra: { secret: SECRET } } }));
    expect(parsed).toEqual(config);
    expect(JSON.stringify(parsed)).not.toContain(SECRET);
    expect(parseSubmissionConfig({ ...config, options: { apiKey: SECRET } })).toBeNull();
    expect(parseSubmissionConfig({ ...config, provider: { id: "openai-compatible", baseUrl: `https://user:${SECRET}@models.example/v1` } })).toBeNull();
  });

  it.each([null, undefined, "invalid json", {}, { version: 2 }, { ...snapshotSettings(DEFAULT_SETTINGS), version: 0 }, { ...snapshotSettings(DEFAULT_SETTINGS), methodology: "unknown" }])("rejects unknown, missing, or invalid snapshot versions (%j)", (value) => {
    expect(parseSubmissionConfig(value)).toBeNull();
  });

  it("canonicalizes nested key ordering without collapsing distinct configurations", () => {
    const first = snapshotSettings({ ...DEFAULT_SETTINGS, options: { piShard: true, piSubagentModels: { obfuscation: "model-o", exfiltration: "model-e" } } });
    const reordered = { ...first, options: { ...first.options, piSubagentModels: { exfiltration: "model-e", obfuscation: "model-o" }, piShard: true } };
    expect(configurationKey(first)).toBe(configurationKey(reordered));
    expect(configurationKey(first)).not.toBe(configurationKey({ ...first, model: "different" }));
  });
});

describe("configured submission queue", () => {
  it("persists immutable settings and batch identity across claim and completion", async () => {
    const db = dbForTest();
    const ds = new SqliteDataSource(db);
    const settings = sourceSettings();
    const config = snapshotSettings(settings);
    const job = await createSubmission(ds, { inputRaw: storeId, storeId, profile: DEFAULT_PROFILE, configuration: config, batchId: "batch-demo", source: "admin" });
    settings.model = "other";
    config.model = "also-changed-after-insert";
    const claimed = await claimNextSubmission(ds);
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.configuration?.model).toBe("model-a");
    expect(claimed?.batchId).toBe("batch-demo");
    expect(claimed?.hasConfiguration).toBe(true);
    await completeSubmission(ds, job.id, { status: "failed", error: "test-only" });
    expect((await getSubmission(ds, job.id))?.configuration).toEqual(job.configuration);
    const stored = db.prepare("SELECT config_json FROM submission WHERE id = ?").get(job.id) as { config_json: string };
    expect(stored.config_json).not.toContain(SECRET);
  });

  it("deduplicates concurrent equivalent configurations, but permits distinct and completed analyses", async () => {
    const ds = new SqliteDataSource(dbForTest());
    const configuration = snapshotSettings(sourceSettings());
    const create = () => createSubmission(ds, { inputRaw: storeId, storeId, profile: DEFAULT_PROFILE, configuration });
    const jobs = await Promise.all(Array.from({ length: 8 }, create));
    expect(new Set(jobs.map((job) => job.id)).size).toBe(1);
    expect((await findConfiguredSubmission(ds, storeId, configuration))?.id).toBe(jobs[0]!.id);
    const distinct = await createSubmission(ds, { inputRaw: storeId, storeId, profile: DEFAULT_PROFILE, configuration: { ...configuration, model: "different-model" } });
    expect(distinct.id).not.toBe(jobs[0]!.id);
    await completeSubmission(ds, jobs[0]!.id, { status: "succeeded" });
    expect((await create()).id).not.toBe(jobs[0]!.id);
  });

  it("keeps legacy profile-based submissions usable, and flags malformed snapshots", async () => {
    const db = dbForTest();
    const ds = new SqliteDataSource(db);
    const legacy = await createSubmission(ds, { inputRaw: storeId, storeId, profile: DEFAULT_PROFILE });
    expect(legacy.configuration).toBeNull();
    expect(legacy.hasConfiguration).toBe(false);
    expect(legacy.batchId).toBeNull();
    expect((await claimNextSubmission(ds))?.id).toBe(legacy.id);
    db.prepare("UPDATE submission SET config_json = ? WHERE id = ?").run('{"version":99,"secret":"never echo"}', legacy.id);
    const invalid = await getSubmission(ds, legacy.id);
    expect(invalid?.configuration).toBeNull();
    expect(invalid?.hasConfiguration).toBe(true);
    expect(JSON.stringify(invalid)).not.toContain("never echo");
  });

  it("migrates a v6 database without losing queued work or inventing historical configuration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "extray-config-migration-")); dirs.push(dir);
    const path = join(dir, "db.sqlite");
    const old = openDb(path);
    const row = await createSubmission(new SqliteDataSource(old), { inputRaw: storeId, storeId, profile: DEFAULT_PROFILE, priority: 91, source: "discovery" });
    old.exec("ALTER TABLE submission DROP COLUMN config_json");
    old.exec("ALTER TABLE submission DROP COLUMN config_key");
    old.exec("ALTER TABLE submission DROP COLUMN batch_id");
    old.prepare("UPDATE schema_meta SET value = '6' WHERE key = 'schema_version'").run();
    old.close();
    const migrated = openDb(path); dbs.push(migrated);
    expect((migrated.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe(String(SCHEMA_VERSION));
    const preserved = await getSubmission(new SqliteDataSource(migrated), row.id);
    expect(preserved).toMatchObject({ id: row.id, status: "queued", storeId, priority: 91, source: "discovery", configuration: null, hasConfiguration: false, batchId: null });
    const fresh = await createSubmission(new SqliteDataSource(migrated), { inputRaw: storeId, storeId, profile: DEFAULT_PROFILE, configuration: snapshotSettings(DEFAULT_SETTINGS) });
    expect(fresh.configuration?.version).toBe(1);
  });
});
