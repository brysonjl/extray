import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const KEY = "catalog_sync_owner";
interface Owner { pid: number; token: string; childPid?: number; childGroup?: boolean }
const validPid = (pid: unknown): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
function parse(raw: string): Owner | null {
  try { const owner = JSON.parse(raw); return validPid(owner?.pid) && typeof owner.token === "string" && owner.token && (owner.childPid === undefined || validPid(owner.childPid)) && (owner.childGroup === undefined || typeof owner.childGroup === "boolean") ? owner : null; }
  catch { return null; }
}
function row(db: DatabaseSync): { value: string } | undefined { return db.prepare("SELECT value FROM runner_state WHERE key=?").get(KEY) as { value: string } | undefined; }
function absent(pid: number, group = false): boolean {
  try { process.kill(group ? -pid : pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
export interface CatalogSyncLease {
  /** Register a child/group before authorizing any writer work in that child. */
  registerChild(pid: number, group: boolean): () => boolean;
  release(): boolean;
}
/** Serialize catalog snapshots from this authoritative DB. Never steal a lock
 * while either the parent or a recorded child/process group can still write. */
export function acquireCatalogSync(db: DatabaseSync): CatalogSyncLease | null {
  const previous = row(db);
  if (previous) {
    const owner = parse(previous.value);
    if (!owner || !absent(owner.pid) || (owner.childPid !== undefined && !absent(owner.childPid, owner.childGroup))) return null;
    db.prepare("DELETE FROM runner_state WHERE key=? AND value=?").run(KEY, previous.value);
  }
  const owner: Owner = { pid: process.pid, token: randomUUID() };
  if (!db.prepare("INSERT OR IGNORE INTO runner_state(key,value,updated_at) VALUES(?,?,?)").run(KEY, JSON.stringify(owner), new Date().toISOString()).changes) return null;
  return {
    registerChild(pid, group) {
      if (!validPid(pid)) throw new Error("Invalid catalog subprocess PID");
      const current = row(db); const found = current ? parse(current.value) : null;
      if (!current || found?.token !== owner.token) throw new Error("Catalog sync ownership changed before child registration");
      if (found.childPid !== undefined && !absent(found.childPid, found.childGroup)) throw new Error("A catalog subprocess is still running");
      const value = JSON.stringify({ ...owner, childPid: pid, childGroup: group });
      const updated = db.prepare("UPDATE runner_state SET value=?,updated_at=? WHERE key=? AND value=?").run(value, new Date().toISOString(), KEY, current.value);
      if (!updated.changes) throw new Error("Catalog sync ownership changed before child registration");
      return () => {
        // close can precede the exit of orphaned grandchildren. Keep ownership
        // until the entire recorded group is gone, including permission errors.
        if (!absent(pid, group)) return false;
        const latest = row(db); const value = latest ? parse(latest.value) : null;
        if (latest && value?.token === owner.token && value.childPid === pid) {
          db.prepare("UPDATE runner_state SET value=?,updated_at=? WHERE key=? AND value=?").run(JSON.stringify(owner), new Date().toISOString(), KEY, latest.value);
        }
        return true;
      };
    },
    release() {
      const current = row(db); const value = current ? parse(current.value) : null;
      if (!current || value?.token !== owner.token) return true;
      if (value.childPid !== undefined && !absent(value.childPid, value.childGroup)) return false;
      db.prepare("DELETE FROM runner_state WHERE key=? AND value=?").run(KEY, current.value);
      return true;
    },
  };
}
