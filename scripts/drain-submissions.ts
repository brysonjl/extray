#!/usr/bin/env -S npx tsx
// Submission drain pipeline: pull queued Explorer submissions from deployed
// D1, run the real
// analysis locally on each (scripts/assess.ts), then push the results up with
// the existing snapshot sync — whose close-loop flips the queued jobs to
// succeeded. Remote rows stay `queued` while analyses run (never `running`):
// a crashed drain then costs nothing — the next run just picks the same rows
// up again — and the app's active-job dedup keeps working throughout.
//
//   npm run explorer:drain -- --remote            # the deployed queue
//   npm run explorer:drain -- --local             # wrangler dev state
//   [--db .out/bakeoff.sqlite] [--database ext-ray] [--dry-run] [--skip-r2]
//   [-- <assess flags>]        # REPLACES the default assess flag set below
//
// Per queued store_id (deduped, oldest first) the drain spawns
//   assess <store-id> <assess flags> --db <db>
// A known per-extension failure (assess exit 2/3/4: fetch, static analysis,
// replay miss) is written back to the submission row (status 'failed' +
// error, which the Submit page surfaces) so the queue converges instead of
// re-analyzing a dead extension every drain; an unexpected exit aborts. If
// EVERY analysis failed, nothing is marked — that pattern is a config or
// environment problem (no LLM creds, bad flags), not N bad extensions.
//
// Succeeded jobs are NOT closed here: `explorer:sync` is the single writer
// that closes them, keyed on the same canonicalReport() the app serves. That
// is why the assess arm must be user-visible under the active EXPLORER_PROFILE
// — preflighted below, because an arm mismatch would burn real analysis money
// on reports that never close a job (and never reach a User's catalog).

import { d1Query, d1Write, runStep, type D1Mode } from "./_d1.ts";
import { resolveProfile } from "../src/product/profile.ts";
import {
  armVisibilityError,
  pinnedArmWarning,
  planDrain,
  planFailureUpdates,
  type QueuedRow,
} from "../src/runner/ingest-remote.ts";
export { armVisibilityError, pinnedArmWarning, planDrain, planFailureUpdates, type QueuedRow };
import {
  DEFAULT_MAX_WAIT_HOURS,
  DEFAULT_POLL_MINUTES,
  formatUsage,
  runAssessPaced,
  sessionUsageWindow,
} from "./_ollama-session.ts";

/** The pinned production analysis invocation (matches DEFAULT_PROFILE's
 *  pinned arm) — single-sourced in src/product/assess-args.ts; re-exported for
 *  existing consumers. Overridden wholesale by anything after `--` on the CLI. */
import { DEFAULT_ASSESS_ARGS } from "../src/product/assess-args.ts";
export { DEFAULT_ASSESS_ARGS };

interface Args {
  db: string;
  database: string;
  mode: D1Mode | null;
  dryRun: boolean;
  skipR2: boolean;
  wait: boolean;
  waitPollMin: number;
  waitMaxHours: number;
  assessArgs: string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    db: ".out/bakeoff.sqlite",
    database: "ext-ray",
    mode: null,
    dryRun: false,
    skipR2: false,
    wait: true,
    waitPollMin: DEFAULT_POLL_MINUTES,
    waitMaxHours: DEFAULT_MAX_WAIT_HOURS,
    assessArgs: DEFAULT_ASSESS_ARGS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") out.db = argv[++i] ?? out.db;
    else if (a === "--database") out.database = argv[++i] ?? out.database;
    else if (a === "--local" || a === "--remote") out.mode = a;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "--skip-r2") out.skipR2 = true;
    else if (a === "--no-wait") out.wait = false;
    else if (a === "--wait-poll-min") out.waitPollMin = Number(argv[++i] ?? out.waitPollMin);
    else if (a === "--wait-max-hours") out.waitMaxHours = Number(argv[++i] ?? out.waitMaxHours);
    else if (a === "--") {
      out.assessArgs = argv.slice(i + 1);
      break;
    }
  }
  return out;
}

// ---- process plumbing --------------------------------------------------------
// (The pure planning half — planDrain, planFailureUpdates, the arm preflights —
// lives in src/runner/ingest-remote.ts, shared with the runner daemon.)

// assess exit codes that mean "this extension" rather than "this setup":
// 2 config/fetch, 3 static analysis, 4 replay cache miss (scripts/assess.ts).
const PER_EXTENSION_EXIT_CODES = new Set([2, 3, 4]);

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (!a.mode) {
    console.error("Pass --local (wrangler dev state) or --remote (the deployed database).");
    process.exit(1);
  }
  const tag = a.dryRun ? "[drain dry-run]" : "[drain]";

  const profile = resolveProfile();
  const armError = armVisibilityError(a.assessArgs, profile);
  if (armError) {
    console.error(`${tag} ${armError}`);
    process.exit(1);
  }
  const armWarning = pinnedArmWarning(a.assessArgs, profile);
  if (armWarning) console.error(`${tag} warning: ${armWarning}`);

  console.log(`${tag} 1/4 pulling queued submissions (${a.database} ${a.mode})`);
  const rows = d1Query(
    a.database,
    a.mode,
    "SELECT id, store_id FROM submission WHERE status = 'queued' ORDER BY created_at ASC, id ASC",
  );
  const plan = planDrain((rows ?? []) as unknown as QueuedRow[]);
  if (plan.work.length === 0 && plan.rejected.length === 0) {
    console.log(`${tag} queue is empty — nothing to do`);
    return;
  }
  for (const w of plan.work) console.log(`  ${w.storeId} (job ${w.submissionIds.join(", ")})`);
  for (const r of plan.rejected) console.log(`  job ${r.id} → will be marked failed: ${r.reason}`);
  if (a.dryRun) {
    console.log(`${tag} would assess ${plan.work.length} extension(s) with: ${a.assessArgs.join(" ")}`);
    return;
  }

  const usageLine = () => formatUsage(sessionUsageWindow(a.db));
  console.log(`${tag} 2/4 assessing ${plan.work.length} extension(s)${a.wait ? " (waits on rate limits)" : ""}: ${a.assessArgs.join(" ")}`);
  console.log(`${tag} ${usageLine()}`);
  const failures: { ids: number[]; error: string }[] = plan.rejected.map((r) => ({ ids: [r.id], error: r.reason }));
  let analyzed = 0;
  for (const [i, w] of plan.work.entries()) {
    console.log(`${tag} [${i + 1}/${plan.work.length}] ${w.storeId}`);
    // --db appended last so it wins over any passthrough value: assess must
    // record into the same DB the sync step exports, or jobs never close.
    // Paced: a rate-limited analysis waits for the Ollama session to reset and
    // retries the same extension rather than failing it.
    const res = await runAssessPaced(w.storeId, {
      assessArgs: [...a.assessArgs, "--db", a.db],
      wait: a.wait,
      pollMs: a.waitPollMin * 60_000,
      maxWaitMs: a.waitMaxHours * 3_600_000,
      usageLine,
    });
    if (res.code === 0) {
      analyzed++;
    } else if (PER_EXTENSION_EXIT_CODES.has(res.code ?? -1)) {
      failures.push({ ids: w.submissionIds, error: res.lastStderrLine ?? `assess exited ${res.code}` });
      console.error(`${tag} ${w.storeId} failed (exit ${res.code}) — job ${w.submissionIds.join(", ")} will be marked failed`);
    } else {
      throw new Error(
        `assess exited ${res.code ?? "on a signal"} for ${w.storeId} — not a per-extension failure; aborting the drain`,
      );
    }
  }
  if (plan.work.length > 0 && analyzed === 0) {
    throw new Error(
      `all ${plan.work.length} assessment(s) failed — that pattern is a config/environment problem ` +
        `(LLM credentials, flags), so no submission is being marked failed. Fix the setup and re-run.`,
    );
  }

  console.log(`${tag} 3/4 recording ${failures.length} failure(s)`);
  const statements = planFailureUpdates(failures, new Date().toISOString());
  if (statements.length > 0) d1Write(a.database, a.mode, ["--command", statements.join(" ")]);

  if (analyzed > 0) {
    console.log(`${tag} 4/4 push + close-loop (explorer:sync ${a.mode})`);
    runStep("node_modules/.bin/tsx", [
      "scripts/sync-explorer.ts",
      a.mode,
      "--db",
      a.db,
      "--database",
      a.database,
      ...(a.skipR2 ? ["--skip-r2"] : []),
    ]);
  } else {
    console.log(`${tag} 4/4 sync skipped — no new analyses to push`);
  }
  console.log(`${tag} done — analyzed ${analyzed}, failed ${failures.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
