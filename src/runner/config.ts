// Runner daemon configuration: defaults ← optional runner.config.json ←
// environment. Everything path-like is resolvable to absolute so the same
// config moves to a Linux box (systemd) unchanged; everything time-like is a
// number the pure planners (loop.ts, ledger.ts) consume without touching the
// clock themselves.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_ASSESS_ARGS } from "../product/assess-args.ts";

/** One scheduled discovery query — a subset of scripts/discover.ts's
 *  DiscoverOpts with runner-appropriate defaults filled in at run time. */
export interface DiscoveryQueryConfig {
  source: "extpose" | "webstore";
  collection?: string;
  category?: string;
  limit?: number;
}

export interface RunnerConfig {
  /** Bake-off DB (the queue + ledger live here too). */
  db: string;
  /** Deployed D1 database name + wrangler mode for the remote submission pull. */
  database: string;
  d1Mode: "--remote" | "--local";
  /** Cloudflare integration: ingest, catalog/source sync, progress and failure
   *  write-backs. False keeps all results local (the --no-remote option). */
  ingestRemote: boolean;

  /** Main loop cadence. */
  tickMs: number;
  /** How often to pull queued submissions from the deployed D1. */
  ingestEveryMin: number;
  /** How often the discovery scrape runs. */
  discoveryEveryHours: number;
  /** Sync when dirty and the remote-source queue is drained — but never let
   *  results sit unpushed longer than this. */
  syncMaxLatencyHours: number;

  /** Claim priorities by submission source. */
  priorities: { user: number; remote: number; admin: number; discovery: number };

  /** Budget policy knobs (src/runner/ledger.ts). Seconds are Ollama
   *  server-reported generation time — the same unit sessionUsageWindow sums. */
  budget: {
    /** Session (~5h) spend cap fallback until enough 429s are observed. */
    sessionCapSecondsFallback: number;
    /** Weekly spend cap — static guess (no observed-event learning yet). */
    weeklyCapSecondsFallback: number;
    /** Fallback per-job cost until enough successful runs exist. */
    typicalJobSecondsFallback: number;
    /** Discovery jobs need this × typical-job headroom in the session window. */
    discoverySessionFactor: number;
    /** …and this × in the weekly window. */
    discoveryWeeklyFactor: number;
    /** Backoff after a rate-limited run, before the next probe. */
    backoffMs: number;
    /** Rate-limit requeues per job before it is marked failed. */
    maxAttempts: number;
  };

  /** Consecutive non-rate-limit failures before analysis pauses… */
  maxConsecutiveFailures: number;
  /** …and for how long (self-healing: analysis resumes after the pause). */
  failurePauseMin: number;

  /** Scheduled discovery queries. English filter is always on for these —
   *  the D1 export drops non-English extensions unconditionally, so analyzing
   *  them from discovery would spend budget on reports that never ship. */
  discovery: DiscoveryQueryConfig[];

  /** The pinned analysis flags handed to scripts/assess.ts (--db appended). */
  assessArgs: string[];
}

export const DEFAULT_RUNNER_CONFIG: RunnerConfig = {
  db: ".out/bakeoff.sqlite",
  database: "ext-ray",
  d1Mode: "--remote",
  ingestRemote: true,

  tickMs: 30_000,
  ingestEveryMin: 10,
  discoveryEveryHours: 24,
  syncMaxLatencyHours: 6,

  priorities: { user: 100, remote: 100, admin: 100, discovery: 10 },

  budget: {
    sessionCapSecondsFallback: 45 * 60,
    weeklyCapSecondsFallback: 20 * 3600,
    typicalJobSecondsFallback: 300,
    discoverySessionFactor: 1.5,
    discoveryWeeklyFactor: 3,
    backoffMs: 30 * 60_000,
    maxAttempts: 8,
  },

  maxConsecutiveFailures: 3,
  failurePauseMin: 60,

  discovery: [
    { source: "extpose", collection: "new", limit: 10 },
    { source: "extpose", collection: "top-installed", limit: 5 },
  ],

  assessArgs: DEFAULT_ASSESS_ARGS,
};

/** Deep-ish merge: one level of nesting (priorities/budget), arrays replaced. */
function mergeConfig(base: RunnerConfig, over: Partial<RunnerConfig>): RunnerConfig {
  return {
    ...base,
    ...over,
    priorities: { ...base.priorities, ...(over.priorities ?? {}) },
    budget: { ...base.budget, ...(over.budget ?? {}) },
  };
}

/** Resolve the effective config: defaults ← configPath (or ./runner.config.json
 *  when present) ← explicit overrides (CLI flags). */
export function loadRunnerConfig(
  opts: { configPath?: string; overrides?: Partial<RunnerConfig>; cwd?: string } = {},
): RunnerConfig {
  const cwd = opts.cwd ?? process.cwd();
  let cfg = DEFAULT_RUNNER_CONFIG;
  const path = opts.configPath ?? resolve(cwd, "runner.config.json");
  if (opts.configPath || existsSync(path)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new Error(`runner config ${path} is not valid JSON: ${(e as Error).message}`);
    }
    cfg = mergeConfig(cfg, parsed as Partial<RunnerConfig>);
  }
  if (opts.overrides) cfg = mergeConfig(cfg, opts.overrides);
  return { ...cfg, db: resolve(cwd, cfg.db) };
}
