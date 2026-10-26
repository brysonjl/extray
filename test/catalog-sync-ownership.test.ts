import { afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { rmSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/index.ts";
import { acquireCatalogSync, type CatalogSyncLease } from "../src/runner/catalog-sync-ownership.ts";
import { createCatalogExport, runCatalogStep } from "../scripts/_catalog-sync-process.ts";
const mocked = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: mocked.spawn }));
const databases: DatabaseSync[] = [];
const dirs: string[] = [];
const database = () => { const db = openDb(":memory:"); databases.push(db); return db; };
const absent = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); mocked.spawn.mockReset(); for (const db of databases.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("catalog synchronization ownership", () => {
  it("refuses live owners and safely releases without clearing a successor", () => {
    const db = database(); const first = acquireCatalogSync(db)!;
    expect(acquireCatalogSync(db)).toBeNull();
    expect(first.release()).toBe(true);
    const second = acquireCatalogSync(db)!;
    first.release();
    expect(acquireCatalogSync(db)).toBeNull();
    second.release(); expect(acquireCatalogSync(db)).not.toBeNull();
  });
  it("keeps ownership until a registered child group including grandchildren is gone", () => {
    const db = database(); const lease = acquireCatalogSync(db)!;
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const clear = lease.registerChild(222, true);
    expect(lease.release()).toBe(false);
    expect(clear()).toBe(false);
    expect(kill).toHaveBeenCalledWith(-222, 0);
    expect(db.prepare("SELECT value FROM runner_state WHERE key='catalog_sync_owner'").get()).toBeDefined();
    kill.mockImplementation(absent);
    expect(clear()).toBe(true);
    expect(lease.release()).toBe(true);
    expect(db.prepare("SELECT value FROM runner_state WHERE key='catalog_sync_owner'").get()).toBeUndefined();
  });
  it("cannot recover a dead parent while descendants survive, then recovers once both are gone", () => {
    const db = database();
    db.prepare("INSERT INTO runner_state VALUES('catalog_sync_owner',?,'now')").run(JSON.stringify({pid:111,token:"old",childPid:222,childGroup:true}));
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => pid === -222 ? true : absent());
    expect(acquireCatalogSync(db)).toBeNull();
    expect(kill).toHaveBeenCalledWith(111, 0);expect(kill).toHaveBeenCalledWith(-222, 0);
    kill.mockImplementation(absent);
    expect(acquireCatalogSync(db)).not.toBeNull();
  });
  it("fails closed when child-group liveness is unknown", () => {
    const db = database();
    db.prepare("INSERT INTO runner_state VALUES('catalog_sync_owner',?,'now')").run(JSON.stringify({pid:111,token:"old",childPid:222,childGroup:true}));
    vi.spyOn(process, "kill").mockImplementation((pid) => { if (pid === 111) return absent(); throw Object.assign(new Error("denied"), {code:"EPERM"}); });
    expect(acquireCatalogSync(db)).toBeNull();
  });
  it("creates private unique export paths for separate invocations", () => {
    const first = createCatalogExport();const second = createCatalogExport();dirs.push(first.directory, second.directory);
    expect(first.path).not.toBe(second.path);
    expect(statSync(first.directory).mode & 0o777).toBe(0o700);
    expect(statSync(second.directory).mode & 0o777).toBe(0o700);
  });
});

class Child extends EventEmitter {
  pid = 34567;
  connected = true;
  kill = vi.fn(() => true);
  send = vi.fn((_message: unknown, callback: (error: Error | null) => void) => { callback(null); return true; });
  disconnect = vi.fn(() => { this.connected = false; });
}
function subprocess(clear: () => boolean = vi.fn(() => true)) {
  const child = new Child();mocked.spawn.mockReturnValue(child);
  const lease: CatalogSyncLease = { registerChild: vi.fn(() => clear), release: vi.fn(() => true) };
  return {child, lease, clear};
}
describe("catalog subprocess tracking", () => {
  it("refuses a command that cannot run the Node startup gate", async () => {
    const { lease } = subprocess();
    await expect(runCatalogStep(lease, "not-node", [])).rejects.toThrow("current Node executable");
    expect(mocked.spawn).not.toHaveBeenCalled();
    expect(lease.registerChild).not.toHaveBeenCalled();
  });
  it("registers the directly spawned process group and awaits close", async () => {
    const {child,lease,clear}=subprocess();
    let settled=false;
    const result=runCatalogStep(lease,process.execPath,["--import","tsx","scripts/export-d1.ts"]).then(()=>{settled=true;});
    expect(mocked.spawn).toHaveBeenCalledWith(process.execPath,["--import",new URL("../scripts/_catalog-sync-start.mjs",import.meta.url).href,"--import","tsx","scripts/export-d1.ts"],{stdio:["inherit","inherit","inherit","ipc"],detached:process.platform!=="win32"});
    expect(child.send).not.toHaveBeenCalled();
    child.emit("message", { type: "catalog-sync-ready" });
    expect(child.send).toHaveBeenCalledWith({ type: "catalog-sync-start" }, expect.any(Function));
    expect(vi.mocked(lease.registerChild).mock.invocationCallOrder[0]).toBeLessThan(child.send.mock.invocationCallOrder[0]!);
    expect(lease.registerChild).toHaveBeenCalledWith(child.pid,process.platform!=="win32");
    child.emit("exit",0);await Promise.resolve();expect(settled).toBe(false);expect(clear).not.toHaveBeenCalled();
    child.emit("close",0);await result;expect(settled).toBe(true);expect(clear).toHaveBeenCalledOnce();
  });
  it("retains live descendant ownership after the direct child closes", async () => {
    vi.useFakeTimers();
    const {child,lease}=subprocess(()=>false);
    const result=runCatalogStep(lease,process.execPath,["mock"]);
    const assertion=expect(result).rejects.toThrow(/descendant is still running/);
    child.emit("close",0);
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;expect(lease.release).not.toHaveBeenCalled();
  });
  it("waits for helper shutdown while keeping competing catalog writers excluded", async () => {
    vi.useFakeTimers();
    const db = database(); const lease = acquireCatalogSync(db)!;
    const child = new Child(); mocked.spawn.mockReturnValue(child);
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    let settled = false;
    const result = runCatalogStep(lease, process.execPath, ["mock"]).then(() => { settled = true; });
    child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(75);
    expect(settled).toBe(false);
    expect(acquireCatalogSync(db)).toBeNull();
    expect(lease.release()).toBe(false);
    kill.mockImplementation((pid) => Math.abs(pid) === child.pid ? absent() : true);
    await vi.advanceTimersByTimeAsync(25);
    await result;
    expect(lease.release()).toBe(true);
    expect(acquireCatalogSync(db)).not.toBeNull();
  });
  it("keeps the original subprocess failure after waiting for helper shutdown", async () => {
    vi.useFakeTimers();
    const clear = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const {child,lease}=subprocess(clear);
    const result=runCatalogStep(lease,process.execPath,["mock"]);
    const assertion=expect(result).rejects.toThrow("subprocess failed");
    child.emit("error",new Error("subprocess failed"));
    child.emit("exit",1);
    child.emit("close",1);
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(clear).toHaveBeenCalledTimes(2);
    expect(lease.release).not.toHaveBeenCalled();
  });
  it("settles a late send failure after exit while still waiting for registered helpers", async () => {
    vi.useFakeTimers();
    const clear = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const {child,lease}=subprocess(clear);
    let sendCallback: ((error: Error | null) => void) | undefined;
    child.send.mockImplementation((_message, callback) => { sendCallback = callback; return true; });
    const failure = new Error("late send failure");
    const result=runCatalogStep(lease,process.execPath,["mock"]);
    const assertion=expect(result).rejects.toBe(failure);
    child.emit("message", { type: "catalog-sync-ready" });
    child.emit("exit",1);
    expect(clear).not.toHaveBeenCalled();
    sendCallback!(failure);
    expect(child.disconnect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    child.emit("close",1);
    expect(clear).toHaveBeenCalledTimes(2);
    expect(lease.release).not.toHaveBeenCalled();
  });
  it("kills the process group on failed registration and only rejects after exit", async () => {
    const {child,lease}=subprocess();
    vi.mocked(lease.registerChild).mockImplementation(()=>{throw new Error("cannot register");});
    const kill=vi.spyOn(process,"kill").mockReturnValue(true);
    let error: unknown;let settled=false;
    const result=runCatalogStep(lease,process.execPath,["mock"]).catch((e)=>{error=e;settled=true;});
    if(process.platform!=="win32")expect(kill).toHaveBeenCalledWith(-child.pid,"SIGKILL");
    else expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(child.disconnect).toHaveBeenCalledOnce();
    child.emit("message", { type: "catalog-sync-ready" });
    expect(child.send).not.toHaveBeenCalled();
    await Promise.resolve();expect(settled).toBe(false);
    child.emit("exit",null);await result;expect((error as Error).message).toBe("cannot register");
  });
  it("does not clear ownership on an error while the subprocess is still alive", async () => {
    const {child,lease,clear}=subprocess();
    const result=runCatalogStep(lease,process.execPath,["mock"]);
    const assertion=expect(result).rejects.toThrow("kill EPERM");
    child.emit("error",new Error("kill EPERM"));await Promise.resolve();expect(clear).not.toHaveBeenCalled();
    child.emit("close",1);await assertion;expect(clear).toHaveBeenCalledOnce();
  });
});
