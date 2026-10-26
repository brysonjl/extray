#!/usr/bin/env -S npx tsx
// Runner observability: one readable snapshot of the queue, the daemon's
// schedule stamps, backoff/pause state, the budget ledger's learned caps +
// current headroom, and the recent ledger events. The DB is the queryable
// truth — this only reads.
//
//   npm run runner:status            # human-readable
//   npm run runner:status -- --json  # for scripting

import "./_env.ts";
import { openDb } from "../src/db/index.ts";
import { resolveProfile } from "../src/product/profile.ts";
import { loadRunnerConfig } from "../src/runner/config.ts";
import { getDirtyForSync, getStateDate, getStateInt } from "../src/runner/state.ts";
import { headroom, learnedSessionCap, typicalJobCost } from "../src/runner/ledger.ts";
import { formatUsage, sessionUsageWindow } from "./_ollama-session.ts";

function parseArgs(argv: string[]): { json: boolean; db?: string; config?: string } {
  const out: { json: boolean; db?: string; config?: string } = { json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") out.json = true;
    else if (argv[i] === "--db") out.db = argv[++i];
    else if (argv[i] === "--config") out.config = argv[++i];
  }
  return out;
}

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  const cfg = loadRunnerConfig({ configPath: a.config, overrides: a.db ? { db: a.db } : {} });
  const profile = resolveProfile();
  const db = openDb(cfg.db);

  const queue = db
    .prepare(
      `SELECT COALESCE(source, 'user') AS source, status, COUNT(*) AS n
       FROM submission GROUP BY COALESCE(source, 'user'), status ORDER BY source, status`,
    )
    .all() as Array<{ source: string; status: string; n: number }>;
  const oldest = db
    .prepare("SELECT store_id, created_at FROM submission WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
    .get() as { store_id: string | null; created_at: string } | undefined;
  const events = db
    .prepare("SELECT ts, kind, source, store_id, detail FROM ledger_event ORDER BY id DESC LIMIT 10")
    .all() as Array<{ ts: string; kind: string; source: string | null; store_id: string | null; detail: string | null }>;

  const usage5 = sessionUsageWindow(cfg.db, 5);
  const usage168 = sessionUsageWindow(cfg.db, 168);
  const h = headroom(db, cfg, { sessionUsedSeconds: usage5.serverSeconds, weeklyUsedSeconds: usage168.serverSeconds });
  const cap = learnedSessionCap(db, cfg);
  const typical = typicalJobCost(db, cfg, profile.pinned);

  const state = {
    backoffUntil: getStateDate(db, "backoff_until")?.toISOString() ?? null,
    pausedUntil: getStateDate(db, "paused_until")?.toISOString() ?? null,
    lastIngestAt: getStateDate(db, "last_ingest_at")?.toISOString() ?? null,
    lastDiscoveryAt: getStateDate(db, "last_discovery_at")?.toISOString() ?? null,
    lastSyncAt: getStateDate(db, "last_sync_at")?.toISOString() ?? null,
    dirtyForSync: getDirtyForSync(db),
    consecutiveFailures: getStateInt(db, "consecutive_failures"),
  };

  if (a.json) {
    process.stdout.write(
      JSON.stringify(
        {
          db: cfg.db,
          queue,
          oldestQueued: oldest ?? null,
          state,
          budget: {
            sessionUsedSeconds: usage5.serverSeconds,
            weeklyUsedSeconds: usage168.serverSeconds,
            sessionCapSeconds: cap.seconds,
            sessionCapObservations: cap.samples,
            sessionHeadroomSeconds: h.sessionSeconds,
            weeklyHeadroomSeconds: h.weeklySeconds,
            typicalJobSeconds: typical.serverSeconds,
            typicalJobSamples: typical.samples,
          },
          recentEvents: events,
        },
        null,
        2,
      ) + "\n",
    );
    return;
  }

  const mins = (s: number) => `${(s / 60).toFixed(1)}m`;
  console.log(`runner status — ${cfg.db}`);
  console.log(`\nqueue:`);
  if (queue.length === 0) console.log("  (empty)");
  for (const q of queue) console.log(`  ${q.source.padEnd(10)} ${q.status.padEnd(10)} ${q.n}`);
  if (oldest) console.log(`  oldest queued: ${oldest.store_id ?? "?"} since ${oldest.created_at}`);
  console.log(`\ndaemon state:`);
  console.log(`  backoff until:    ${state.backoffUntil ?? "—"}`);
  console.log(`  paused until:     ${state.pausedUntil ?? "—"}`);
  console.log(`  last ingest:      ${state.lastIngestAt ?? "never"}`);
  console.log(`  last discovery:   ${state.lastDiscoveryAt ?? "never"}`);
  console.log(`  last sync:        ${state.lastSyncAt ?? "never"}${state.dirtyForSync ? "  (dirty — push pending)" : ""}`);
  if (state.consecutiveFailures > 0) console.log(`  consecutive failures: ${state.consecutiveFailures}`);
  console.log(`\nbudget (server-time, learned locally — Ollama exposes no quota API):`);
  console.log(`  session: ${mins(usage5.serverSeconds)} used of ~${mins(cap.seconds)} cap (${cap.samples} observation(s)) → ${mins(h.sessionSeconds)} headroom`);
  console.log(`  weekly:  ${mins(usage168.serverSeconds)} used of ~${mins(h.weeklyCapSeconds)} cap → ${mins(h.weeklySeconds)} headroom`);
  console.log(`  typical ${profile.pinned.methodology}/${profile.pinned.model} job: ${mins(typical.serverSeconds)} (${typical.samples} sample(s))`);
  console.log(`  ${formatUsage(usage5)}`);
  console.log(`\nlast ${events.length} ledger event(s):`);
  if (events.length === 0) console.log("  (none)");
  for (const e of events) {
    console.log(`  ${e.ts}  ${e.kind.padEnd(14)} ${e.source ?? ""} ${e.store_id ?? ""} ${e.detail?.slice(0, 60) ?? ""}`);
  }
}

main();
