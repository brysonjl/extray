import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db/index.ts";
import { acquireCatalogSync } from "../src/runner/catalog-sync-ownership.ts";
import { runCatalogStep } from "../scripts/_catalog-sync-process.ts";

const driver = new URL("./helpers/catalog-sync-parent.ts", import.meta.url);
const gate = new URL("../scripts/_catalog-sync-start.mjs", import.meta.url).href;
const children: ChildProcess[] = [];
const directories: string[] = [];
const groups = new Set<number>();
const alive = (pid: number, group = false) => {
  try { process.kill(group ? -pid : pid, 0); return true; }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true; // Unknown liveness must stay fail-closed.
    throw error;
  }
};
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Test subprocess did not reach expected state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function workspace() {
  const directory = mkdtempSync(join(tmpdir(), "extray-sync-start-"));
  directories.push(directory);
  return directory;
}
function launch(mode: string, directory: string): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(driver), mode, directory], {
    stdio: "ignore", env: { ...process.env, SKIP_DOTENV: "1" },
  });
  children.push(child);
  return child;
}
async function groupPid(directory: string): Promise<number> {
  const path = join(directory, "group-pid");
  await until(() => existsSync(path));
  const pid = Number(readFileSync(path, "utf8"));
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  groups.add(pid);
  return pid;
}
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
afterEach(async () => {
  // Kill only processes/groups created by this test. Do this before deleting
  // marker directories so a failed assertion cannot leave a background writer.
  for (const child of children.splice(0)) if (!exited(child)) child.kill("SIGKILL");
  for (const pid of groups) {
    try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); }
    catch (error) { if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    await until(() => !alive(pid, process.platform !== "win32"));
  }
  groups.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("catalog subprocess startup", () => {
  it.each([false, true])("rejects failed registration without starting the writer (signal denied: %s)", async (denySignal) => {
    const directory = workspace();
    const marker = join(directory, "unexpected-write");
    const failure = new Error("Synthetic registration failure");
    let pid = 0;
    const originalKill = process.kill;
    const kill = !denySignal ? undefined : process.platform === "win32"
      ? vi.spyOn(ChildProcess.prototype, "kill").mockImplementation(() => false)
      : vi.spyOn(process, "kill").mockImplementation((target, signal) => {
        if (target === -pid && signal === "SIGKILL") throw Object.assign(new Error("Denied test signal"), { code: "EPERM" });
        return originalKill(target, signal);
      });
    try {
      await expect(runCatalogStep({
        registerChild(childPid) { pid = childPid; groups.add(pid); throw failure; },
        release: () => true,
      }, process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`])).rejects.toBe(failure);
      expect(alive(pid)).toBe(false);
      expect(existsSync(marker)).toBe(false);
    } finally { kill?.mockRestore(); }
  });

  it.each(["before-registration", "after-registration"])("does not start a writer if the parent dies %s", async (mode) => {
    const directory = workspace();
    const parent = launch(mode, directory);
    const pid = await groupPid(directory);
    await until(() => exited(parent));
    await until(() => !alive(pid, process.platform !== "win32"));
    expect(parent.exitCode).not.toBe(0);
    expect(existsSync(join(directory, "writer-started"))).toBe(false);
    const db = openDb(join(directory, "catalog.sqlite"));
    try {
      const replacement = acquireCatalogSync(db);
      expect(replacement).not.toBeNull();
      replacement!.release();
    } finally { db.close(); }
  });

  it("excludes replacement writers after the parent dies once authorized work starts", async () => {
    const directory = workspace();
    const parent = launch("running", directory);
    const pid = await groupPid(directory);
    await until(() => existsSync(join(directory, "writer-started")));
    parent.kill("SIGKILL");
    await until(() => exited(parent));
    expect(alive(pid)).toBe(true);
    const db = openDb(join(directory, "catalog.sqlite"));
    try { expect(acquireCatalogSync(db)).toBeNull(); }
    finally { db.close(); }
  });

  it.skipIf(process.platform === "win32")("retains ownership for a surviving writer descendant after the direct child exits", async () => {
    const directory = workspace();
    const parent = launch("descendant", directory);
    const pid = await groupPid(directory);
    await until(() => exited(parent));
    expect(parent.exitCode).toBe(1);
    expect(readFileSync(join(directory, "failure"), "utf8")).toContain("descendant is still running");
    expect(alive(pid, true)).toBe(true);
    const db = openDb(join(directory, "catalog.sqlite"));
    try { expect(acquireCatalogSync(db)).toBeNull(); }
    finally { db.close(); }
  });

  it("allows inherited workers/forks after authorization and preserves target exit failures", async () => {
    const directory = workspace();
    const marker = join(directory, "worker-args");
    const forkMarker = join(directory, "fork-args");
    const worker = join(directory, "worker.mjs");
    const fork = join(directory, "fork.mjs");
    writeFileSync(worker, "import { parentPort } from 'node:worker_threads'; parentPort.postMessage('ready');");
    writeFileSync(fork, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(forkMarker)},JSON.stringify(process.execArgv)); process.disconnect();`);
    const db = openDb(join(directory, "catalog.sqlite"));
    const lease = acquireCatalogSync(db)!;
    try {
      await runCatalogStep(lease, process.execPath, ["-e", `
        const { Worker } = require('node:worker_threads');
        const worker = new Worker(${JSON.stringify(worker)});
        worker.on('message', args => require('node:fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify(args)));
        require('node:child_process').fork(${JSON.stringify(fork)}, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      `]);
      expect(JSON.parse(readFileSync(marker, "utf8"))).toBe("ready");
      expect(JSON.parse(readFileSync(forkMarker, "utf8"))).not.toContain(gate);
      await expect(runCatalogStep(lease, process.execPath, ["-e", "process.exit(7)"])).rejects.toThrow("exited 7");
      expect(lease.release()).toBe(true);
    } finally { lease.release(); db.close(); }
  });

  it.each(["disconnect", "malformed"])("fails closed when the preload receives %s instead of permission", async (mode) => {
    const directory = workspace();
    const marker = join(directory, "unexpected-write");
    const child = spawn(process.execPath, ["--import", gate, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected')`], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    children.push(child);
    child.once("message", () => {
      if (mode === "disconnect") child.disconnect();
      else child.send({ type: "incorrect" });
    });
    await until(() => exited(child));
    expect(child.exitCode).toBe(1);
    expect(existsSync(marker)).toBe(false);
  });
});
