import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeAnalyzeBatch } from "../scripts/explorer-capabilities.ts";
import { configuredExecution, currentSubmissionConfig, resolveSubmissionSettings } from "../src/server/analysis-node.ts";
import { nodeSettingsStore } from "../src/server/settings-node.ts";
import { DEFAULT_SETTINGS, type ExplorerSettings } from "../src/product/settings.ts";
import { snapshotSettings } from "../src/product/submission-config.ts";
import { openDb } from "../src/db/index.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { completeSubmission } from "../src/jobs/service.ts";

let dir: string;
let dbPath: string;
const SECRET = "sk-only-for-the-original-endpoint";
const connection = (): ExplorerSettings => ({
  methodology: "monolith", model: "snapshot-model", options: { think: false, maxTokens: 12345, useCache: false },
  provider: { id: "openai-compatible", baseUrl: "https://analysis.example/v1", apiKey: SECRET },
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "extray-explorer-execution-"));
  dbPath = join(dir, "jobs.sqlite");
  for (const key of ["EXTRAY_LLM_PROVIDER", "EXTRAY_LLM_BASE_URL", "EXTRAY_LLM_API_KEY", "OLLAMA_API_KEY", "OLLAMA_BASE_URL", "OLLAMA_HOST", "OPENAI_API_KEY", "OPENAI_BASE_URL", "NVIDIA_API_KEY", "NVIDIA_BASE_URL", "SCORECARD_MODEL", "SCORECARD_THINK", "SCORECARD_VERIFIER_MODEL", "LLM_ADAPTER", "EXPLORER_PROFILE"]) vi.stubEnv(key, undefined);
  vi.stubEnv("EXTRAY_SETTINGS_PATH", join(dir, "settings.json"));
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe("durable analysis batches", () => {
  it("survives capability reconstruction and shares matching queued analyses across batch memberships", async () => {
    const kick = vi.fn();
    const config = snapshotSettings(connection());
    const a = "a".repeat(32); const b = "b".repeat(32);
    const original = makeAnalyzeBatch(dbPath, () => "2026-10-18T10:00:00.000Z", kick);
    const first = await original.start([a, b, a], config);
    const second = await original.start([a], config);
    expect(kick).toHaveBeenCalledTimes(2);
    const restarted = makeAnalyzeBatch(dbPath, undefined, vi.fn());
    const one = restarted.status(first.batchId)!;
    const two = restarted.status(second.batchId)!;
    expect(one.startedAt).toBe("2026-10-18T10:00:00.000Z");
    expect(one.items).toHaveLength(2);
    expect(two.items).toHaveLength(1);
    expect(one.items.find((item) => item.storeId === a)?.jobId).toBe(two.items[0]?.jobId);
    expect(restarted.active().map((batch) => batch.batchId).sort()).toEqual([first.batchId, second.batchId].sort());
    const db = openDb(dbPath);
    try {
      const ds = new SqliteDataSource(db);
      await completeSubmission(ds, two.items[0]!.jobId!, { status: "failed", error: "controlled failure" });
      expect(restarted.status(second.batchId)).toMatchObject({ done: true, items: [{ status: "failed", error: "controlled failure" }] });
      expect(restarted.status(first.batchId)?.done).toBe(false);
      expect(restarted.active().map((batch) => batch.batchId)).toEqual([first.batchId]);
      await completeSubmission(ds, one.items.find((item) => item.storeId === b)!.jobId!, { status: "succeeded" });
      expect(restarted.status(first.batchId)?.done).toBe(true);
      expect(restarted.active()).toEqual([]);
      expect((db.prepare("SELECT COUNT(*) n FROM submission").get() as { n: number }).n).toBe(2);
    } finally { db.close(); }
  });

  it("keeps different configurations as separate jobs and retains completed batch history", async () => {
    const batch = makeAnalyzeBatch(dbPath, undefined, vi.fn());
    const config = snapshotSettings(connection());
    const first = await batch.start(["c".repeat(32)], config);
    const changed = await batch.start(["c".repeat(32)], { ...config, model: "another-model" });
    expect(batch.status(first.batchId)?.items[0]?.jobId).not.toBe(batch.status(changed.batchId)?.items[0]?.jobId);
    expect(batch.status("does-not-exist")).toBeNull();
  });
});

describe("queued execution settings", () => {
  it("carries a saved NVIDIA connection into queued CLI execution with the key only in the environment", () => {
    nodeSettingsStore().write({ ...connection(), model: "nvidia/test-model", provider: { id: "nvidia", apiKey: SECRET } });
    const snapshot = currentSubmissionConfig();
    expect(snapshot.provider).toEqual({ id: "nvidia", baseUrl: "https://integrate.api.nvidia.com/v1" });
    const execution = configuredExecution(snapshot);
    expect(execution.args).toEqual(expect.arrayContaining(["--provider", "nvidia", "--base-url", "https://integrate.api.nvidia.com/v1"]));
    expect(execution.env.EXTRAY_LLM_API_KEY).toBe(SECRET);
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
    expect(execution.args.join(" ")).not.toContain(SECRET);
  });

  it("pins arguments to the snapshot while allowing credential rotation at the same endpoint", () => {
    const settings = nodeSettingsStore();
    settings.write(connection());
    const snapshot = currentSubmissionConfig();
    settings.write({ ...connection(), model: "new-default", options: { think: "high", maxTokens: 999 }, provider: { ...connection().provider, apiKey: "rotated-key" } });
    vi.stubEnv("SCORECARD_MODEL", "environment-default");
    vi.stubEnv("SCORECARD_THINK", "high");
    vi.stubEnv("SCORECARD_VERIFIER_MODEL", "environment-verifier");
    vi.stubEnv("LLM_ADAPTER", "/tmp/unrelated-adapter.ts");
    const execution = configuredExecution(snapshot);
    expect(execution.args).toEqual(["--methodology", "monolith", "--model", "snapshot-model", "--provider", "openai-compatible", "--base-url", "https://analysis.example/v1", "--verifier-model", "snapshot-model", "--think", "false", "--max-tokens", "12345", "--no-cache"]);
    expect(execution.args.join(" ")).not.toContain("rotated-key");
    expect(execution.env).toMatchObject({ EXTRAY_IGNORE_SETTINGS: "1", SKIP_DOTENV: "1", EXTRAY_LLM_API_KEY: "rotated-key" });
    for (const key of ["SCORECARD_THINK", "SCORECARD_VERIFIER_MODEL", "LLM_ADAPTER"]) {
      expect(execution.env).toHaveProperty(key, undefined);
    }
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
  });

  it("rejects endpoint or provider changes after enqueue instead of forwarding credentials", () => {
    const settings = nodeSettingsStore(); settings.write(connection());
    const snapshot = currentSubmissionConfig();
    settings.write({ ...connection(), provider: { id: "openai-compatible", baseUrl: "https://other.example/v1", apiKey: "other-key" } });
    expect(() => configuredExecution(snapshot)).toThrow(/connection changed/);
    settings.write({ ...connection(), provider: { id: "openai", baseUrl: "https://analysis.example/v1", apiKey: "other-key" } });
    expect(() => configuredExecution(snapshot)).toThrow(/connection changed/);
  });

  it("resolves environment-only endpoints at enqueue and refuses later retargeting", () => {
    vi.stubEnv("EXTRAY_LLM_PROVIDER", "openai-compatible");
    vi.stubEnv("EXTRAY_LLM_BASE_URL", "https://environment.example/v1");
    vi.stubEnv("EXTRAY_LLM_API_KEY", "environment-key");
    vi.stubEnv("SCORECARD_MODEL", "environment-model");
    const snapshot = currentSubmissionConfig();
    expect(snapshot.provider).toEqual({ id: "openai-compatible", baseUrl: "https://environment.example/v1" });
    expect(snapshot.model).toBe("environment-model");
    expect(configuredExecution(snapshot).env.EXTRAY_LLM_API_KEY).toBe("environment-key");
    vi.stubEnv("EXTRAY_LLM_BASE_URL", "https://redirected.example/v1");
    expect(() => configuredExecution(snapshot)).toThrow(/connection changed/);
  });

  it("does not attach a stored preset key to an endpoint supplied by a later environment override", () => {
    nodeSettingsStore().write({ ...DEFAULT_SETTINGS, provider: { id: "ollama", apiKey: SECRET } });
    vi.stubEnv("EXTRAY_LLM_BASE_URL", "https://unrelated.example/v1");
    const snapshot = currentSubmissionConfig();
    expect(snapshot.provider.baseUrl).toBe("https://unrelated.example/v1");
    expect(() => configuredExecution(snapshot)).toThrow(/saved credential belongs to a different endpoint/);
  });

  it("does not include secrets while resolving per-submission settings", () => {
    expect(resolveSubmissionSettings(connection())).toMatchObject({ model: "snapshot-model", provider: { id: "openai-compatible", baseUrl: "https://analysis.example/v1" } });
    expect(resolveSubmissionSettings(connection()).provider.apiKey).toBeUndefined();
  });
});
