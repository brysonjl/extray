// Shared, failure-tolerant bake-off DB sink for the analysis CLIs. The DB is a
// SECONDARY output: a write failure warns and is swallowed so the primary report
// artifacts (and the CLI's exit code) are never affected by it. Pass `--no-db`
// (db === false) to skip entirely.

import { openDb, recordRun, type RunInput } from "../src/db/index.ts";

export interface LedgerEventInput {
  kind: string;
  source?: string | null;
  storeId?: string | null;
  model?: string | null;
  detail?: string | null;
  now?: Date;
}

/** Append one ledger_event row (rate limits, probes, backoffs — the runner's
 *  budget ledger learns caps from these). Same never-abort posture as
 *  recordRunSafe: a write failure warns and is swallowed. */
export function recordLedgerEventSafe(dbPath: string | false | undefined, ev: LedgerEventInput): void {
  if (!dbPath) return;
  try {
    const db = openDb(dbPath);
    try {
      db.prepare("INSERT INTO ledger_event (ts, kind, source, store_id, model, detail) VALUES (?,?,?,?,?,?)").run(
        (ev.now ?? new Date()).toISOString(),
        ev.kind,
        ev.source ?? null,
        ev.storeId ?? null,
        ev.model ?? null,
        ev.detail ?? null,
      );
    } finally {
      db.close();
    }
  } catch (e) {
    process.stderr.write(`warning: ledger event write skipped (${(e as Error).message})\n`);
  }
}

export interface RecordedRunReceipt {
  version: 1;
  runId: number;
  reports: { reportId: number; storeId: string | null }[];
}

export function recordRunSafe(dbPath: string | false | undefined, input: RunInput): RecordedRunReceipt | null {
  if (!dbPath) return null;
  try {
    const db = openDb(dbPath);
    try {
      const id = recordRun(db, input);
      process.stdout.write(`recorded run #${id} (${input.kind}) to ${dbPath}\n`);
      const reports = db.prepare("SELECT r.id AS reportId, t.store_id AS storeId FROM report r JOIN target t ON t.id = r.target_id WHERE r.run_id = ? ORDER BY r.id").all(id) as { reportId: number; storeId: string | null }[];
      return { version: 1, runId: id, reports };
    } finally {
      db.close();
    }
  } catch (e) {
    process.stderr.write(`warning: bake-off DB write skipped (${(e as Error).message})\n`);
    return null;
  }
}
