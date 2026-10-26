import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

interface ExecutorOwner { pid: number; token: string; childPid?: number }
const OWNER_KEY = "executor_owner";
function ownerRow(db: DatabaseSync): { value: string } | undefined {
  return db.prepare("SELECT value FROM runner_state WHERE key = ?").get(OWNER_KEY) as { value: string } | undefined;
}
function validPid(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function parseOwner(raw: string): ExecutorOwner | null {
  try {
    const owner = JSON.parse(raw) as ExecutorOwner;
    return validPid(owner?.pid) && typeof owner.token === "string" && owner.token.length > 0 &&
      (owner.childPid === undefined || validPid(owner.childPid)) ? owner : null;
  } catch { return null; }
}
/** Permission errors and unknown process state must never permit takeover. */
function isAbsent(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** One executor per local database. Both the orchestrating process and its
 * current analysis child must be gone before crash recovery can reclaim work. */
export function acquireExecutor(db: DatabaseSync): (() => void) | null {
  const token = randomUUID();
  const owner: ExecutorOwner = { pid: process.pid, token };
  const old = ownerRow(db);
  if (old) {
    const previous = parseOwner(old.value);
    if (!previous || !isAbsent(previous.pid) || (previous.childPid !== undefined && !isAbsent(previous.childPid))) return null;
    db.prepare("DELETE FROM runner_state WHERE key = ? AND value = ?").run(OWNER_KEY, old.value);
  }
  const inserted = db.prepare("INSERT OR IGNORE INTO runner_state (key,value,updated_at) VALUES (?,?,?)").run(OWNER_KEY, JSON.stringify(owner), new Date().toISOString());
  if (!inserted.changes) return null;
  const heartbeat = (state: "active" | "stopped") => {
    const at = new Date().toISOString();
    const current = ownerRow(db);
    if (!current || parseOwner(current.value)?.token !== token) return;
    db.prepare("INSERT INTO runner_state(key,value,updated_at) VALUES ('executor_heartbeat',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at")
      .run(JSON.stringify({ at, state, pid: process.pid, token }), at);
  };
  heartbeat("active");
  const timer = setInterval(() => { try { heartbeat("active"); } catch { /* A closing owner will release the timer. */ } }, 5000);
  timer.unref();
  return () => {
    clearInterval(timer);
    heartbeat("stopped");
    // Child registration changes the serialized value, but never the token.
    const current = ownerRow(db);
    if (current && parseOwner(current.value)?.token === token) {
      db.prepare("DELETE FROM runner_state WHERE key = ? AND value = ?").run(OWNER_KEY, current.value);
    }
  };
}

/** Attach a spawned child only to this process's existing ownership. The
 * returned callback clears that child after exit without changing ownership,
 * and cannot clear a successor child or a replacement executor's registration. */
export function registerExecutorChild(db: DatabaseSync, childPid: number): () => void {
  if (!validPid(childPid)) throw new Error("analysis child PID must be a positive integer");
  const row = ownerRow(db);
  const owner = row ? parseOwner(row.value) : null;
  if (!row || !owner || owner.pid !== process.pid) return () => {};
  const next = JSON.stringify({ ...owner, childPid });
  const updated = db.prepare("UPDATE runner_state SET value = ?, updated_at = ? WHERE key = ? AND value = ?")
    .run(next, new Date().toISOString(), OWNER_KEY, row.value);
  if (!updated.changes) return () => {};
  return () => {
    const current = ownerRow(db);
    const value = current ? parseOwner(current.value) : null;
    if (!current || !value || value.token !== owner.token || value.childPid !== childPid) return;
    delete value.childPid;
    db.prepare("UPDATE runner_state SET value = ?, updated_at = ? WHERE key = ? AND value = ?")
      .run(JSON.stringify(value), new Date().toISOString(), OWNER_KEY, current.value);
  };
}
