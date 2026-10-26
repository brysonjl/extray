#!/usr/bin/env -S npx tsx
// The runner daemon: the always-on process that drains the deployed Explorer's
// submission queue, scrapes for new extensions on a schedule, analyzes the
// unified local queue one job at a time (user submissions before discovery
// backfill, budget-gated via the learned Ollama session ledger), and pushes
// results up with explorer:sync. A separate progress publisher mirrors exact
// job state while analyses run; catalog sync makes their report links available.
//
//   npm run runner                       # the daemon (launchd/systemd target)
//   npm run runner -- --once            # one tick, then exit
//   npm run runner -- --once --dry-run  # print what a tick would do; no effects
//   npm run runner -- enqueue --ids-file worklists/foo.txt [--priority 50]
//
// Config: defaults ← ./runner.config.json (optional) ← flags below. State
// lives in the bake-off DB (submission/runner_state/ledger_event) — kill the
// process at any point; the next boot recovers via resetRunning().

import { Command } from "commander";
import { readFileSync } from "node:fs";
import "./_env.ts";
import { openDb } from "../src/db/index.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { resolveProfile } from "../src/product/profile.ts";
import { createSubmission, findActiveSubmission, resetRunning } from "../src/jobs/service.ts";
import { loadRunnerConfig, type RunnerConfig } from "../src/runner/config.ts";
import { armVisibilityError, pinnedArmWarning } from "../src/runner/ingest-remote.ts";
import { peekNextSubmission, planTick, readTickInputs, runTick, type RunnerDeps } from "../src/runner/loop.ts";
import { canStartJob, headroom, typicalJobCost } from "../src/runner/ledger.ts";
import { d1Query, d1Write, runStep } from "./_d1.ts";
import { probeSession, runAssessPaced, sessionUsageWindow } from "./_ollama-session.ts";
import { lastFlagValue } from "../src/product/assess-args.ts";
import { acquireExecutor } from "../src/runner/ownership.ts";
import { startProgressPublisher } from "./explorer-progress.ts";
import { resolveRunnerSubmissionConfig } from "../src/runner/configuration.ts";
import { configuredExecution } from "../src/server/analysis-node.ts";

const log = (msg: string) => process.stderr.write(`[runner ${new Date().toISOString()}] ${msg}\n`);

function buildDeps(cfg: RunnerConfig): RunnerDeps {
  const db = openDb(cfg.db);
  const model = lastFlagValue(cfg.assessArgs, "--model") ?? "glm-5.2:cloud";
  return {
    db,
    ds: new SqliteDataSource(db),
    cfg,
    profile: resolveProfile(),
    log,
    d1Query: (sql) => d1Query(cfg.database, cfg.d1Mode, sql),
    d1Write: (statements) => d1Write(cfg.database, cfg.d1Mode, ["--command", statements.join(" ")]),
    // wait:false — the daemon owns backoff (requeue + backoff_until + probe),
    // so a rate-limited run returns immediately instead of blocking for hours.
    discoveryConfiguration: () => resolveRunnerSubmissionConfig(cfg.assessArgs),
    runAssess: (storeId, assessArgs, configuration, job) => {
      const execution = configuration ? configuredExecution(configuration) : null;
      return runAssessPaced(storeId, { assessArgs: execution ? [...execution.args, "--db", cfg.db] : assessArgs,
        env: { ...execution?.env, ...(job ? { EXTRAY_ANALYSIS_JOB_ID: String(job.id), EXTRAY_ANALYSIS_ATTEMPT_ID: String(job.currentAttemptId), EXTRAY_ANALYSIS_DB: cfg.db } : {}) }, wait: false });
    },
    probe: (configuration) => {
      if (!configuration) return probeSession({ model });
      if (configuration.provider.id !== "ollama") return Promise.resolve("unavailable");
      let execution: ReturnType<typeof configuredExecution>;
      try { execution = configuredExecution(configuration); }
      catch {
        // Let normal execution report an obsolete connection as a terminal
        // configuration failure, rather than blocking it behind a quota probe.
        return Promise.resolve("unavailable");
      }
      return probeSession({ model: configuration.model,
        host: configuration.provider.baseUrl?.replace(/\/v1\/?$/, ""),
        apiKey: execution.env.EXTRAY_LLM_API_KEY ?? "",
      });
    },
    runSync: () =>
      runStep("node_modules/.bin/tsx", [
        "scripts/sync-explorer.ts",
        cfg.d1Mode,
        "--db",
        cfg.db,
        "--database",
        cfg.database,
      ]),
    usedSeconds: (hours) => sessionUsageWindow(cfg.db, hours).serverSeconds,
  };
}

function preflight(cfg: RunnerConfig): void {
  const profile = resolveProfile();
  const armError = armVisibilityError(cfg.assessArgs, profile);
  if (armError) {
    log(armError);
    process.exit(1);
  }
  const warning = pinnedArmWarning(cfg.assessArgs, profile);
  if (warning) log(`warning: ${warning}`);
}

function dryRunTick(deps: RunnerDeps): void {
  const now = new Date();
  const inputs = readTickInputs(deps.db, now);
  const plan = planTick(inputs, deps.cfg);
  log(`dry-run: plan = ${JSON.stringify(plan)}`);
  log(`dry-run: state = ${JSON.stringify({ ...inputs, now: undefined })}`);
  const peeked = peekNextSubmission(deps.db, now);
  if (!peeked) {
    log("dry-run: queue empty — nothing claimable");
    return;
  }
  const h = headroom(deps.db, deps.cfg, {
    sessionUsedSeconds: deps.usedSeconds(5),
    weeklyUsedSeconds: deps.usedSeconds(168),
  });
  const typical = typicalJobCost(deps.db, deps.cfg, {
    methodology: deps.profile.pinned.methodology,
    model: deps.profile.pinned.model,
  });
  const allowed = canStartJob(peeked.source, h, typical, deps.cfg);
  log(
    `dry-run: next job = ${peeked.storeId} (source ${peeked.source ?? "user"}) — ` +
      `${allowed ? "would run" : "budget-deferred"}; headroom session ${Math.round(h.sessionSeconds)}s ` +
      `(cap ${Math.round(h.sessionCap.seconds)}s from ${h.sessionCap.samples} observation(s)), ` +
      `weekly ${Math.round(h.weeklySeconds)}s; typical job ${Math.round(typical.serverSeconds)}s (${typical.samples} sample(s))`,
  );
}

async function daemon(cfg: RunnerConfig, once: boolean, dryRun: boolean): Promise<void> {
  preflight(cfg);
  const deps = buildDeps(cfg);

  if (dryRun) {
    dryRunTick(deps);
    return;
  }

  const release = acquireExecutor(deps.db);
  if (!release) { deps.db.close(); throw new Error("Another analysis executor owns this database. Stop it before starting the daemon."); }
  const stopPublisher = startProgressPublisher({ db: deps.db, database: cfg.database, mode: cfg.d1Mode, enabled: cfg.ingestRemote, log });
  try {
    const recovered = await resetRunning(deps.ds);
    if (recovered > 0) log(`boot: requeued ${recovered} orphaned running job(s) from a previous crash`);

    let stopping = false;
    const stop = (sig: string) => {
      if (stopping) process.exit(1); // second signal: force
      stopping = true;
      log(`${sig} received — finishing the current tick, then exiting (again to force)`);
    };
    process.on("SIGTERM", () => stop("SIGTERM"));
    process.on("SIGINT", () => stop("SIGINT"));

    log(
      `started: db=${cfg.db} remote=${cfg.ingestRemote ? `${cfg.database} ${cfg.d1Mode}` : "off"} ` +
        `tick=${cfg.tickMs / 1000}s ingest=${cfg.ingestEveryMin}m discovery=${cfg.discoveryEveryHours}h`,
    );
    do {
      try {
        await runTick(deps);
      } catch (e) {
        log(`tick failed: ${(e as Error).message}`);
      }
      if (once || stopping) break;
      await new Promise((r) => setTimeout(r, cfg.tickMs));
    } while (!stopping);
    log(once ? "single tick complete" : "stopped");
  } finally { release(); stopPublisher(); deps.db.close(); }
}

async function enqueue(cfg: RunnerConfig, idsFile: string, priority: number): Promise<void> {
  const db = openDb(cfg.db);
  const ds = new SqliteDataSource(db);
  const profile = resolveProfile();
  const ids = readFileSync(idsFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  let queued = 0;
  let skipped = 0;
  for (const id of ids) {
    if (!/^[a-p]{32}$/.test(id)) {
      log(`enqueue: skipping invalid id ${JSON.stringify(id)}`);
      skipped++;
      continue;
    }
    if (await findActiveSubmission(ds, id)) {
      skipped++;
      continue;
    }
    await createSubmission(ds, {
      inputRaw: id,
      storeId: id,
      profile,
      requestedBy: "runner:enqueue",
      source: "admin",
      priority,
    });
    queued++;
  }
  log(`enqueue: ${queued} queued, ${skipped} skipped (invalid or already live) from ${idsFile}`);
}

const program = new Command();
program
  .name("runner")
  .description("Always-on analysis runner: drains submissions, schedules discovery, paces the Ollama budget")
  .option("--db <path>", "bake-off DB path override")
  .option("--database <name>", "deployed D1 database name override")
  .option("--local", "pull submissions from wrangler dev state instead of the deployed D1")
  .option("--no-remote", "disable Cloudflare ingest, sync, progress and failure write-backs; keep results local")
  .option("--config <path>", "runner config JSON (default ./runner.config.json when present)")
  .option("--once", "run one tick and exit")
  .option("--dry-run", "print what a tick would do without doing it")
  .action(async (opts: { db?: string; database?: string; local?: boolean; remote?: boolean; config?: string; once?: boolean; dryRun?: boolean }) => {
    const cfg = loadRunnerConfig({
      configPath: opts.config,
      overrides: {
        ...(opts.db ? { db: opts.db } : {}),
        ...(opts.database ? { database: opts.database } : {}),
        ...(opts.local ? { d1Mode: "--local" as const } : {}),
        ...(opts.remote === false ? { ingestRemote: false } : {}),
      },
    });
    await daemon(cfg, opts.once ?? false, opts.dryRun ?? false);
  });

program
  .command("enqueue")
  .description("push a worklist into the unified queue (replaces unpaced assess --ids-file batches)")
  .requiredOption("--ids-file <path>", "one store id per line; # comments ok")
  .option("--priority <n>", "claim priority (default 50; user submissions run at 100, discovery at 10)", "50")
  .option("--db <path>", "bake-off DB path override")
  .option("--config <path>", "runner config JSON")
  .action(async (opts: { idsFile: string; priority: string; db?: string; config?: string }) => {
    const cfg = loadRunnerConfig({
      configPath: opts.config,
      overrides: { ...(opts.db ? { db: opts.db } : {}) },
    });
    await enqueue(cfg, opts.idsFile, Number(opts.priority));
  });

program.parseAsync();
