import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/index.ts";
import * as ownership from "../src/runner/ownership.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";
import { cancelSubmission, claimNextSubmission, createSubmission, getSubmission, completeSubmission } from "../src/jobs/service.ts";
import { runAssessPaced } from "../scripts/_ollama-session.ts";

const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), spawn: mocked.spawn,
}));

class FakeChild extends EventEmitter {
  pid: number | undefined = 87654;
  stderr = new EventEmitter();
  kill = vi.fn(() => true);
}
let dir: string;
let path: string;
let db: DatabaseSync;
let child: FakeChild;
let release: (() => void) | null;
const storeId = "a".repeat(32);
const receiptPath = () => (mocked.spawn.mock.calls[0]![2] as { env: NodeJS.ProcessEnv }).env.EXTRAY_ASSESS_RECEIPT!;
const owner = () => JSON.parse((db.prepare("SELECT value FROM runner_state WHERE key='executor_owner'").get() as { value: string }).value) as { pid: number; childPid?: number };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "extray-assess-spawn-")); path = join(dir, "jobs.sqlite");
  db = openDb(path); release = ownership.acquireExecutor(db);
  child = new FakeChild(); mocked.spawn.mockReset().mockReturnValue(child);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); release?.(); db.close(); rmSync(dir, { recursive: true, force: true }); });

describe("real assess spawn adapter with mocked subprocess", () => {
  it("spawns the analyzer directly, keeps its PID registered through exit, and reads the exact receipt on close", async () => {
    const args = ["--model", "pinned-model", "--db", path];
    const result = runAssessPaced(storeId, { assessArgs: args, env: { EXTRAY_IGNORE_SETTINGS: "1", EXTRAY_LLM_API_KEY: "private-test-key" }, wait: false });
    expect(mocked.spawn).toHaveBeenCalledOnce();
    const [command, argv, options] = mocked.spawn.mock.calls[0]!;
    expect(command).toBe(process.execPath);
    expect(argv).toEqual(["--import", "tsx", "scripts/assess.ts", storeId, ...args]);
    expect(argv).not.toContain("private-test-key");
    expect(options).toMatchObject({ stdio: ["ignore", "inherit", "pipe"], env: { EXTRAY_IGNORE_SETTINGS: "1", EXTRAY_LLM_API_KEY: "private-test-key" } });
    expect(owner().childPid).toBe(child.pid);
    const receipt = receiptPath();
    writeFileSync(receipt, JSON.stringify({ version: 1, reports: [
      { storeId: "b".repeat(32), reportId: 900 }, { storeId, reportId: 321 },
    ] }));
    let settled = false; void result.then(() => { settled = true; });
    child.emit("exit", 0);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(owner().childPid).toBe(child.pid);
    expect(existsSync(receipt)).toBe(true);
    child.emit("close", 0);
    expect(await result).toEqual({ code: 0, lastStderrLine: null, rateLimited: false, resultReportId: 321 });
    expect(owner().childPid).toBeUndefined();
    expect(existsSync(dirname(receipt))).toBe(false);
  });

  it.each([
    undefined,
    "not json",
    JSON.stringify({ version: 2, reports: [{ storeId, reportId: 321 }] }),
    JSON.stringify({ version: 1, reports: [{ storeId: "b".repeat(32), reportId: 321 }] }),
    JSON.stringify({ version: 1, reports: [{ storeId, reportId: "321" }] }),
    JSON.stringify({ version: 1, reports: [{ storeId, reportId: -1 }] }),
  ])("never invents a report ID for missing or invalid receipts (%s)", async (contents) => {
    const result = runAssessPaced(storeId, { assessArgs: ["--db", path], wait: false });
    const receipt = receiptPath();
    if (contents !== undefined) writeFileSync(receipt, contents);
    child.emit("close", 0);
    expect(await result).not.toHaveProperty("resultReportId");
    expect(owner().childPid).toBeUndefined();
    expect(existsSync(dirname(receipt))).toBe(false);
  });

  it("returns the receipt for an artifact-producing incomplete investigation (exit 6)", async () => {
    const result = runAssessPaced(storeId, { assessArgs: ["--db", path], wait: false });
    writeFileSync(receiptPath(), JSON.stringify({ version: 1, reports: [{ storeId, reportId: 88 }] }));
    child.emit("close", 6);
    expect(await result).toMatchObject({ code: 6, resultReportId: 88, rateLimited: false });
  });

  it("kills an unregistered child and postpones rejection and cleanup until close", async () => {
    vi.spyOn(ownership, "registerExecutorChild").mockImplementation(() => { throw new Error("ownership write failed"); });
    let rejection: unknown;
    let settled = false;
    const result = runAssessPaced(storeId, { assessArgs: ["--db", path], wait: false }).then(
      () => { settled = true; }, (error) => { settled = true; rejection = error; },
    );
    const receipt = receiptPath();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(existsSync(dirname(receipt))).toBe(true);
    child.emit("exit", null, "SIGKILL");
    await Promise.resolve();
    expect(settled).toBe(false);
    child.emit("close", null, "SIGKILL");
    await result;
    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("ownership write failed");
    expect(existsSync(dirname(receipt))).toBe(false);
  });

  it("retains live child ownership after a process error until close confirms termination", async () => {
    let settled = false;
    let rejection: unknown;
    const result = runAssessPaced(storeId, { assessArgs: ["--db", path], wait: false }).then(
      () => { settled = true; }, (error) => { settled = true; rejection = error; },
    );
    const receipt = receiptPath();
    child.emit("error", new Error("kill EPERM"));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(owner().childPid).toBe(child.pid);
    expect(existsSync(dirname(receipt))).toBe(true);
    child.emit("close", 1);
    await result;
    expect((rejection as Error).message).toBe("kill EPERM");
    expect(owner().childPid).toBeUndefined();
    expect(existsSync(dirname(receipt))).toBe(false);
  });

  it.each([undefined, 88])("waits for close before acknowledging cancellation and retains any recorded artifact (%s)", async (reportId) => {
    vi.useFakeTimers();
    const ds = new SqliteDataSource(db);
    const job = await createSubmission(ds, { inputRaw: storeId, storeId, profile: DEFAULT_PROFILE });
    const claimed = await claimNextSubmission(ds);
    const result = runAssessPaced(storeId, { assessArgs: ["--db", path], env: { EXTRAY_ANALYSIS_JOB_ID: String(job.id), EXTRAY_ANALYSIS_ATTEMPT_ID: String(claimed?.currentAttemptId) }, wait: false });
    if (reportId) writeFileSync(receiptPath(), JSON.stringify({ version: 1, reports: [{ storeId, reportId }] }));
    await cancelSubmission(ds, job.id);
    await vi.advanceTimersByTimeAsync(250);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect((await getSubmission(ds, job.id))?.status).toBe("running");
    let settled = false; void result.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL"); expect(settled).toBe(false);
    child.emit("close", null, "SIGKILL");
    const outcome = await result;
    expect(outcome.cancelled).toBe(true);
    expect(outcome.resultReportId).toBe(reportId);
    await completeSubmission(ds, job.id, { status: "cancelled" });
    expect((await getSubmission(ds, job.id))?.status).toBe("cancelled");
    expect(owner().childPid).toBeUndefined();
  });

  it("cleans up the receipt when the subprocess cannot be spawned", async () => {
    child.pid = undefined;
    const result = runAssessPaced(storeId, { assessArgs: ["--db", path], wait: false });
    const assertion = expect(result).rejects.toThrow("spawn unavailable");
    const receipt = receiptPath();
    child.emit("error", new Error("spawn unavailable"));
    await assertion;
    expect(owner().childPid).toBeUndefined();
    expect(existsSync(dirname(receipt))).toBe(false);
    child.emit("close", -2); // Node also emits close after a spawn error.
  });
});
