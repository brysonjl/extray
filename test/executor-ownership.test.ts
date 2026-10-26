import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/index.ts";
import { acquireExecutor, registerExecutorChild } from "../src/runner/ownership.ts";
import type { DatabaseSync } from "node:sqlite";

const dbs: DatabaseSync[] = [];
function database() { const db = openDb(":memory:"); dbs.push(db); return db; }
afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) db.close(); });
const owner = (db: DatabaseSync) => db.prepare("SELECT value FROM runner_state WHERE key = 'executor_owner'").get() as { value: string } | undefined;
function writeOwner(db: DatabaseSync, value: string) {
  db.prepare("INSERT OR REPLACE INTO runner_state (key,value,updated_at) VALUES ('executor_owner',?,?)").run(value, new Date().toISOString());
}

describe("local executor ownership", () => {
  it("refuses a concurrent live executor and permits reacquisition after release", () => {
    const db = database();
    const release = acquireExecutor(db);
    expect(release).toBeTypeOf("function");
    const first = owner(db)?.value;
    expect(JSON.parse(first!).pid).toBe(process.pid);
    expect(acquireExecutor(db)).toBeNull();
    expect(owner(db)?.value).toBe(first);
    release!();
    expect(owner(db)).toBeUndefined();
    const second = acquireExecutor(db);
    expect(second).toBeTypeOf("function");
    expect(owner(db)?.value).not.toBe(first);
    // A repeated stale release must not remove a successor's ownership.
    release!();
    expect(owner(db)).toBeDefined();
    second!();
  });

  it("recovers a dead process using a liveness probe without signalling it", () => {
    const db = database();
    const deadPid = 123456;
    writeOwner(db, JSON.stringify({ pid: deadPid, token: "dead-process" }));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); });
    const release = acquireExecutor(db);
    expect(release).toBeTypeOf("function");
    expect(kill).toHaveBeenCalledExactlyOnceWith(deadPid, 0);
    expect(JSON.parse(owner(db)!.value).pid).toBe(process.pid);
    release!();
  });

  it("does not displace an owner whose liveness cannot be checked", () => {
    const db = database();
    const original = JSON.stringify({ pid: 98765, token: "restricted-process" });
    writeOwner(db, original);
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); });
    expect(acquireExecutor(db)).toBeNull();
    expect(owner(db)?.value).toBe(original);
  });

  it("does not reclaim a dead parent's still-live analysis child", () => {
    const db = database();
    const parentPid = 123456, childPid = 123457;
    const original = JSON.stringify({ pid: parentPid, token: "orphaned-parent", childPid });
    writeOwner(db, original);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === parentPid) throw Object.assign(new Error("no such process"), { code: "ESRCH" });
      return true;
    });
    expect(acquireExecutor(db)).toBeNull();
    expect(owner(db)?.value).toBe(original);
    expect(kill.mock.calls).toEqual([[parentPid, 0], [childPid, 0]]);
  });

  it("recovers only after both parent and registered child have exited", () => {
    const db = database();
    writeOwner(db, JSON.stringify({ pid: 123456, token: "dead-family", childPid: 123457 }));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("no such process"), { code: "ESRCH" }); });
    const release = acquireExecutor(db);
    expect(release).toBeTypeOf("function");
    expect(kill.mock.calls).toEqual([[123456, 0], [123457, 0]]);
    release!();
  });

  it("does not reclaim an orphaned child whose liveness is inaccessible", () => {
    const db = database();
    writeOwner(db, JSON.stringify({ pid: 123456, token: "restricted-child", childPid: 123457 }));
    vi.spyOn(process, "kill").mockImplementation((pid) => {
      throw Object.assign(new Error("probe failed"), { code: pid === 123456 ? "ESRCH" : "EPERM" });
    });
    expect(acquireExecutor(db)).toBeNull();
  });

  it("registers children with stable tokens and clears only the matching child", () => {
    const db = database();
    const release = acquireExecutor(db)!;
    const first = JSON.parse(owner(db)!.value);
    const clearFirst = registerExecutorChild(db, 123456);
    expect(JSON.parse(owner(db)!.value)).toEqual({ ...first, childPid: 123456 });
    const clearSecond = registerExecutorChild(db, 123457);
    clearFirst();
    expect(JSON.parse(owner(db)!.value).childPid).toBe(123457);
    clearSecond();
    expect(JSON.parse(owner(db)!.value)).toEqual(first);
    release();
    expect(owner(db)).toBeUndefined();
  });

  it("releases registered ownership but never modifies a successor", () => {
    const db = database();
    const release = acquireExecutor(db)!;
    const clear = registerExecutorChild(db, 123456);
    release();
    expect(owner(db)).toBeUndefined();
    const releaseNext = acquireExecutor(db)!;
    const clearNext = registerExecutorChild(db, 123456);
    const successor = owner(db)!.value;
    clear(); release();
    expect(owner(db)!.value).toBe(successor);
    clearNext(); releaseNext();
  });

  it("does not register children without this process's existing ownership", () => {
    const db = database();
    registerExecutorChild(db, 123456)();
    expect(owner(db)).toBeUndefined();
    const other = JSON.stringify({ pid: process.pid + 1, token: "other-executor" });
    writeOwner(db, other);
    registerExecutorChild(db, 123456)();
    expect(owner(db)!.value).toBe(other);
    expect(() => registerExecutorChild(db, -1)).toThrow("positive integer");
  });

  it.each(["malformed", JSON.stringify({ pid: 0 }), JSON.stringify({ pid: -3 }), JSON.stringify({ pid: "123" })])("leaves an unrecognizable ownership record untouched (%s)", (value) => {
    const db = database();
    writeOwner(db, value);
    const kill = vi.spyOn(process, "kill");
    expect(acquireExecutor(db)).toBeNull();
    expect(owner(db)?.value).toBe(value);
    expect(kill).not.toHaveBeenCalled();
  });
});
