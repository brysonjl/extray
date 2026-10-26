// Typed accessors over the runner_state KV table — the daemon state that must
// survive a restart. The DB is the durable truth; the process keeps nothing.

import type { DatabaseSync } from "node:sqlite";

export type StateKey =
  | "backoff_until"
  | "paused_until"
  | "manual_pause"
  | "last_ingest_at"
  | "last_discovery_at"
  | "last_sync_at"
  | "dirty_for_sync"
  | "consecutive_failures";

export function getState(db: DatabaseSync, key: StateKey): string | null {
  const row = db.prepare("SELECT value FROM runner_state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setState(db: DatabaseSync, key: StateKey, value: string | null, now: Date = new Date()): void {
  if (value === null) {
    db.prepare("DELETE FROM runner_state WHERE key = ?").run(key);
    return;
  }
  db.prepare(
    `INSERT INTO runner_state (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now.toISOString());
}

export function getStateDate(db: DatabaseSync, key: StateKey): Date | null {
  const v = getState(db, key);
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function setStateDate(db: DatabaseSync, key: StateKey, value: Date | null, now?: Date): void {
  setState(db, key, value ? value.toISOString() : null, now);
}

export function getStateInt(db: DatabaseSync, key: StateKey): number {
  const v = Number(getState(db, key));
  return Number.isFinite(v) ? v : 0;
}

export function getDirtyForSync(db: DatabaseSync): boolean {
  return getState(db, "dirty_for_sync") === "1";
}

export function setDirtyForSync(db: DatabaseSync, dirty: boolean, now?: Date): void {
  setState(db, "dirty_for_sync", dirty ? "1" : null, now);
}
