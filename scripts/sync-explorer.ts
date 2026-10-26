#!/usr/bin/env -S npx tsx
// One-command snapshot sync of the local bake-off DB to the deployed Explorer.
// The local DB stays the single source of truth; remote D1 is a disposable
// projection of it. Each sync:
//
//   1. exports the product slice        (scripts/export-d1.ts)
//   2. uploads new evidence files to R2 (scripts/upload-source-r2.ts — before
//      D1, so a new report never cites a file the viewer can't fetch yet)
//   3. adds missing queue columns for schema v5+; newer schemas refuse
//   4. upserts the snapshot and prunes removed rows, preserving retained exact
//      report references and exporting per-pass usage for the admin workbench
//   5. publishes exact job progress, then closes only legacy unmirrored queued
//      requests against newer user-visible canonical reports.
//
// A local process/child-group lease serializes catalog writers from this source
// database. Each invocation owns a private export file; a live writer or its
// surviving descendants cannot be displaced by a second invocation.
//
// Resolution uses the same canonicalReport() the app serves, role "user" — so
// if the deployment overrides EXPLORER_PROFILE, run this with the same value.
//
//   npm run explorer:sync -- --local             # wrangler dev state
//   npm run explorer:sync -- --remote            # the deployed database
//   [--db .out/bakeoff.sqlite] [--database ext-ray] [--dry-run] [--skip-r2]

import { rmSync } from "node:fs";
import { acquireCatalogSync } from "../src/runner/catalog-sync-ownership.ts";
import { createCatalogExport, runCatalogStep } from "./_catalog-sync-process.ts";
import { DatabaseSync } from "node:sqlite";
import { d1Query } from "./_d1.ts";
import { wranglerArgs } from "./_wrangler.ts";
import { canonicalReport } from "../src/product/canonical.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { resolveProfile } from "../src/product/profile.ts";
import { SCHEMA_VERSION } from "../src/db/schema.ts";
import { openDb } from "../src/db/index.ts";
import { progressMigration, PROGRESS_SCHEMA, sqlValue } from "../src/product/progress-projection.ts";
import { ensureProgressSourceId, publishProgress } from "./explorer-progress.ts";



// Children before parents; submission is deliberately absent (it holds the
// deployment's own state). This reset applies only to schemas older than v5;
// dropping report nulls submission.result_report_id via ON DELETE SET NULL.
// Normal refreshes upsert reports and preserve retained exact result links.
// Usage ships with reports; the empty evaluation tables also exist in D1 and
// reference target/run. Drop all children before their parents for valid FKs.
const DROP_PRODUCT_TABLES =
  "DROP TABLE IF EXISTS finding; DROP TABLE IF EXISTS sample_score; DROP TABLE IF EXISTS usage; " +
  "DROP TABLE IF EXISTS scorecard; DROP TABLE IF EXISTS report; DROP TABLE IF EXISTS target; " +
  "DROP TABLE IF EXISTS run; DROP TABLE IF EXISTS schema_meta;";

interface Args {
  db: string;
  database: string;
  mode: "--local" | "--remote" | null;
  dryRun: boolean;
  skipR2: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { db: ".out/bakeoff.sqlite", database: "ext-ray", mode: null, dryRun: false, skipR2: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") out.db = argv[++i] ?? out.db;
    else if (a === "--database") out.database = argv[++i] ?? out.database;
    else if (a === "--local" || a === "--remote") out.mode = a;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--skip-r2") out.skipR2 = true;
  }
  return out;
}

// ---- pure planning (unit-tested) --------------------------------------------

export type SchemaAction =
  | { kind: "import" }
  | { kind: "migrate"; remoteVersion: number }
  | { kind: "reset"; remoteVersion: number }
  | { kind: "refuse"; reason: string };

/** What the import step must do given the remote schema version (null = fresh
 *  database / no schema_meta yet). Version 5+ queues migrate additively;
 *  older catalogs reset before import, and newer schemas refuse. */
export function schemaAction(remoteVersion: number | null, localVersion: number): SchemaAction {
  if (remoteVersion === null || remoteVersion === localVersion) return { kind: "import" };
  if (remoteVersion >= 5 && remoteVersion < localVersion) return { kind: "migrate", remoteVersion };
  if (remoteVersion < localVersion) return { kind: "reset", remoteVersion };
  return {
    kind: "refuse",
    reason: `remote schema is v${remoteVersion}, newer than this checkout's v${localVersion} — pull/rebuild before syncing`,
  };
}

export interface RemoteSubmission {
  id: number;
  store_id: string | null;
  status: string;
  result_report_id: number | null;
  created_at: string;
}

export interface CanonicalRef {
  reportId: number;
  /** run.started_at of the canonical report (ISO 8601). */
  assessedAt: string;
}

export interface SubmissionPlan {
  statements: string[];
  closed: { id: number; storeId: string; reportId: number }[];
  relinked: { id: number; storeId: string; reportId: number }[];
  pending: { id: number; storeId: string | null }[];
}

/** UPDATE statements that close the submission loop after an import. Interpolated
 *  values are integers we validate and an ISO timestamp we generate — no caller
 *  input reaches the SQL. Status guards keep a concurrent worker safe. */
export function planSubmissionUpdates(
  subs: RemoteSubmission[],
  canonicalFor: (storeId: string) => CanonicalRef | null,
  nowIso: string,
): SubmissionPlan {
  const plan: SubmissionPlan = { statements: [], closed: [], relinked: [], pending: [] };
  for (const s of subs) {
    if (!Number.isInteger(s.id)) throw new Error(`non-integer submission id: ${String(s.id)}`);
    const ref = s.store_id ? canonicalFor(s.store_id) : null;
    if (ref && !Number.isInteger(ref.reportId)) throw new Error(`non-integer report id: ${String(ref.reportId)}`);
    if (s.status === "queued") {
      // Only a report assessed AFTER the job was created satisfies it — a
      // `force` re-analysis job must not close against the report that
      // already existed when it was submitted. ISO strings compare lexically.
      if (ref && s.store_id && ref.assessedAt > s.created_at) {
        plan.statements.push(
          `UPDATE submission SET status = 'succeeded', result_report_id = ${ref.reportId}, ` +
            `finished_at = '${nowIso}' WHERE id = ${s.id} AND status = 'queued' ` +
            `AND COALESCE(progress_revision,0)=0 AND EXISTS(SELECT 1 FROM report WHERE id=${ref.reportId});`,
        );
        plan.closed.push({ id: s.id, storeId: s.store_id, reportId: ref.reportId });
      } else {
        plan.pending.push({ id: s.id, storeId: s.store_id });
      }
    }
  }
  return plan;
}

// ---- process plumbing --------------------------------------------------------
// Read-only D1 queries use the shared helper; catalog writes run as tracked process groups.

function remoteSchemaVersion(a: Args): number | null {
  const rows = d1Query(a.database, a.mode!, "SELECT value FROM schema_meta WHERE key = 'schema_version'");
  if (rows === null || rows.length === 0) return null;
  const n = Number(rows[0]?.value);
  return Number.isFinite(n) ? n : null;
}

function pullSubmissions(a: Args): RemoteSubmission[] {
  const columns = (d1Query(a.database, a.mode!, "PRAGMA table_info(submission)") ?? []).map(r => r.name);
  const unmirrored = columns.includes("progress_revision") ? "AND COALESCE(progress_revision,0)=0 " : "";
  const rows = d1Query(
    a.database,
    a.mode!,
    "SELECT id, store_id, status, result_report_id, created_at FROM submission " +
      `WHERE status = 'queued' ${unmirrored}AND id>0 ORDER BY created_at ASC`,
  );
  return (rows ?? []) as unknown as RemoteSubmission[];
}

/** Canonical user-visible report per store_id, computed from the LOCAL snapshot
 *  (identical to remote post-import — ids are copied verbatim). */
async function resolveCanonical(dbPath: string, storeIds: string[]): Promise<Map<string, CanonicalRef>> {
  const map = new Map<string, CanonicalRef>();
  if (storeIds.length === 0) return map;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const ds = new SqliteDataSource(db);
    const profile = resolveProfile();
    for (const sid of storeIds) {
      const row = await canonicalReport(ds, "user", sid, profile);
      if (row) map.set(sid, { reportId: row.reportId, assessedAt: row.assessedAt });
    }
  } finally {
    db.close();
  }
  return map;
}

/** Claim source authority before importing catalog IDs. The post-write check
 * resolves concurrent first publishers without letting the loser import data. */
export async function reserveCatalogSource(sourceId: string, readSource: () => unknown, write: (sql: string) => Promise<void>): Promise<void> {
  const previous = readSource();
  if (previous && previous !== sourceId) throw new Error("Hosted progress belongs to another source database; refusing catalog replacement");
  if (!previous) {
    await write(`${PROGRESS_SCHEMA}\nINSERT OR IGNORE INTO analysis_projection_source(singleton,source_id,revision) VALUES(1,${sqlValue(sourceId)},0);`);
  }
  if (readSource() !== sourceId) throw new Error("Another source database claimed hosted catalog ownership; refusing catalog replacement");
}

// ---- main --------------------------------------------------------------------

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (!a.mode) {
    console.error("Pass --local (wrangler dev state) or --remote (the deployed database).");
    process.exit(1);
  }
  const tag = a.dryRun ? "[sync dry-run]" : "[sync]";
  const syncDb = openDb(a.db);
  const lease = acquireCatalogSync(syncDb);
  if (!lease) { syncDb.close(); throw new Error("Another catalog sync or its subprocesses still own this database; wait for that sync to finish."); }
  let exportDirectory: string | undefined;
  try {
  const exported = createCatalogExport();
  exportDirectory = exported.directory;
  const exportPath = exported.path;
  const runStep = (command: string, args: string[]) => runCatalogStep(lease, command, args);
  const d1Write = (database: string, mode: "--local" | "--remote", args: string[]) =>
    runStep(process.execPath, ["node_modules/.bin/wrangler", ...wranglerArgs(["d1", "execute", database, mode, "-y", ...args])]);


  // Validate identity before importing catalog IDs. Operational publishers and
  // catalog refreshes must refer to the same authoritative local database.
  const identityDb = openDb(a.db);
  try {
    const source = a.dryRun ? identityDb.prepare("SELECT value FROM runner_state WHERE key='progress_source_id'").get()?.value : ensureProgressSourceId(identityDb);
    const readSource = () => d1Query(a.database, a.mode!, "SELECT source_id FROM analysis_projection_source WHERE singleton=1")?.[0]?.source_id;
    const remoteSource = readSource();
    if (remoteSource && source !== remoteSource) throw new Error("Hosted progress belongs to another source database; refusing catalog replacement");
    const version = remoteSchemaVersion(a);
    if (version !== null && version > SCHEMA_VERSION) throw new Error("Hosted schema is newer than this checkout; update before syncing");
    if (!a.dryRun) await reserveCatalogSource(String(source), readSource, (sql) => d1Write(a.database, a.mode!, ["--command", sql]));
  } finally { identityDb.close(); }

  console.log(`${tag} 1/5 export ${a.db} → ${exportPath}`);
  await runStep(process.execPath, ["--import", "tsx", "scripts/export-d1.ts", "--db", a.db, "--out", exportPath]);

  if (a.skipR2) {
    console.log(`${tag} 2/5 R2 evidence upload — skipped (--skip-r2)`);
  } else {
    console.log(`${tag} 2/5 R2 evidence upload`);
    await runStep(process.execPath, [
      "--import", "tsx", "scripts/upload-source-r2.ts",
      "--db",
      a.db,
      a.mode,
      ...(a.dryRun ? ["--dry-run"] : []),
    ]);
  }

  const remoteVersion = remoteSchemaVersion(a);
  const action = schemaAction(remoteVersion, SCHEMA_VERSION);
  if (action.kind === "refuse") {
    console.error(`${tag} ${action.reason}`);
    throw new Error(action.reason);
  }
  if (action.kind === "reset") {
    console.log(
      `${tag} 3/5 remote schema v${action.remoteVersion} < local v${SCHEMA_VERSION} — dropping product tables (submissions kept)`,
    );
    if (!a.dryRun) await d1Write(a.database, a.mode!, ["--command", DROP_PRODUCT_TABLES]);
  } else if (action.kind === "migrate") {
    console.log(`${tag} 3/5 additive migration from v${action.remoteVersion}; preserving exact report references`);
  } else {
    console.log(`${tag} 3/5 schema check ok (remote ${remoteVersion === null ? "fresh" : `v${remoteVersion}`})`);
  }

  const columns = (d1Query(a.database, a.mode!, "PRAGMA table_info(submission)") ?? []).map(r => String(r.name));
  const migration = progressMigration(columns);
  if (migration.length && !a.dryRun) await d1Write(a.database, a.mode!, ["--command", migration.join("\n")]);

  console.log(`${tag} 4/5 import ${exportPath}${a.dryRun ? " — skipped" : ""}`);
  if (!a.dryRun) await d1Write(a.database, a.mode!, ["--file", exportPath]);

  if (!a.dryRun) {
    const db = openDb(a.db);
    try { publishProgress(db, a.database, a.mode!); } finally { db.close(); }
  }

  console.log(`${tag} 5/5 submission close-loop`);
  const subs = pullSubmissions(a);
  const storeIds = [...new Set(subs.map((s) => s.store_id).filter((s): s is string => s !== null))];
  const canonical = await resolveCanonical(a.db, storeIds);
  const plan = planSubmissionUpdates(subs, (sid) => canonical.get(sid) ?? null, new Date().toISOString());

  for (const c of plan.closed) console.log(`  job ${c.id} → succeeded (${c.storeId} → report ${c.reportId})`);
  for (const r of plan.relinked) console.log(`  job ${r.id} → re-linked (${r.storeId} → report ${r.reportId})`);
  if (plan.statements.length > 0 && !a.dryRun) await d1Write(a.database, a.mode!, ["--command", plan.statements.join(" ")]);

  if (plan.pending.length > 0) {
    console.log(`${tag} still awaiting analysis:`);
    for (const p of plan.pending) console.log(`  job ${p.id}: ${p.storeId ?? "(no store id)"}`);
  }
  console.log(
    `${tag} done — closed ${plan.closed.length}, re-linked ${plan.relinked.length}, pending ${plan.pending.length}`,
  );
  } finally {
    const released = lease.release(); syncDb.close();
    // A surviving writer may still need the private SQL file. Its process
    // group keeps ownership, and the temp directory is intentionally retained.
    if (released && exportDirectory) rmSync(exportDirectory, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
