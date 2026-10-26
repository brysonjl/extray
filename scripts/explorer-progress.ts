// Publish only operational observations. Catalog and evidence sync remain a
// separate operation so long-running analyses can report progress cheaply.
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../src/db/schema.ts";
import { buildProgressProjection, progressMigration, PROGRESS_SCHEMA } from "../src/product/progress-projection.ts";
import { d1Query, d1Write, type D1Mode } from "./_d1.ts";

export const IDENTITY_SCHEMA = "CREATE TABLE IF NOT EXISTS analysis_projection_identity(id INTEGER PRIMARY KEY AUTOINCREMENT,identity TEXT NOT NULL UNIQUE);";

/** Atomic allocation across independently running serve/daemon/sync processes. */
export function allocateProgressRevision(db: DatabaseSync, at: string): number {
  const timestamp = Date.parse(at);
  if (!Number.isSafeInteger(timestamp) || timestamp < 1) throw new Error("Invalid progress timestamp");
  const row = db.prepare(`INSERT INTO runner_state(key,value,updated_at) VALUES('progress_revision',?,?)
    ON CONFLICT(key) DO UPDATE SET value=CAST(MAX(CAST(runner_state.value AS INTEGER)+1,CAST(excluded.value AS INTEGER)) AS TEXT),updated_at=excluded.updated_at
    RETURNING value`).get(String(timestamp), at) as { value: string };
  return Number(row.value);
}

/** Fresh queues receive the observation column after their base table exists. */
export function progressSchemaStatements(columns: string[]): string[] {
  return [...progressMigration(columns), SCHEMA_SQL, ...(columns.length ? [] : ["ALTER TABLE submission ADD COLUMN progress_revision INTEGER NOT NULL DEFAULT 0;"]), PROGRESS_SCHEMA, IDENTITY_SCHEMA];
}

export function ensureProgressSourceId(db: DatabaseSync, at = new Date().toISOString()): string {
  db.prepare("INSERT OR IGNORE INTO runner_state(key,value,updated_at) VALUES('progress_source_id',?,?)").run(randomUUID(), at);
  const value = db.prepare("SELECT value FROM runner_state WHERE key='progress_source_id'").get()?.value;
  if (typeof value !== "string" || !value) throw new Error("Invalid local progress source identity");
  return value;
}

export function publishProgress(db: DatabaseSync, database: string, mode: D1Mode): void {
  const remoteVersion = Number(d1Query(database, mode, "SELECT value FROM schema_meta WHERE key='schema_version'")?.[0]?.value ?? 0);
  if (remoteVersion > SCHEMA_VERSION) throw new Error("Hosted schema is newer than this publisher; update the checkout before syncing");
  const at = new Date().toISOString();
  const sourceId = ensureProgressSourceId(db, at);
  const remote = d1Query(database, mode, "SELECT source_id FROM analysis_projection_source WHERE singleton=1");
  if (remote?.[0]?.source_id && remote[0].source_id !== sourceId) throw new Error("Hosted progress belongs to another source database; refusing to reuse its job identities");
  const columns = (d1Query(database, mode, "PRAGMA table_info(submission)") ?? []).map(r => String(r.name));
  db.exec("BEGIN IMMEDIATE");
  let projection;
  try {
    const revision = allocateProgressRevision(db, at);
    projection = buildProgressProjection(db, sourceId, revision, at);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  const sql = [...progressSchemaStatements(columns), ...projection.statements].join("\n");
  const dir = mkdtempSync(join(tmpdir(), "extray-progress-"));
  try {
    const path = join(dir, "progress.sql");
    writeFileSync(path, sql, { mode: 0o600 });
    d1Write(database, mode, ["--file", path]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function startProgressPublisher(options: { db: DatabaseSync; database: string; mode: D1Mode; enabled: boolean; log?: (message: string) => void }): () => void {
  if (!options.enabled) return () => {};
  const tick = () => {
    try { publishProgress(options.db, options.database, options.mode); }
    catch (error) { options.log?.(`progress sync failed; will retry: ${(error as Error).message}`); }
  };
  const timer = setInterval(tick, 30_000);
  timer.unref();
  // Defer initial network work until the runner has installed its heartbeat.
  const first = setTimeout(tick, 1000); first.unref();
  return () => { clearTimeout(first); clearInterval(timer); tick(); };
}
