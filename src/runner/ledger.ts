// The budget ledger: estimate how much Ollama Cloud session/weekly capacity is
// left and whether a job may start. Ollama exposes NO quota API (see
// scripts/_ollama-session.ts), so capacity is LEARNED: when the runner observes
// a rate-limited run it snapshots the local usage gauge into a ledger_event,
// and the session cap is a conservative percentile of those snapshots. Until
// enough 429s have been observed, static fallbacks from RunnerConfig apply.
//
// Everything here is deterministic given the DB + inputs; the clock and usage
// sums are passed in by the caller (loop.ts) so tests need no fakes beyond a
// seeded temp DB.

import type { DatabaseSync } from "node:sqlite";
import type { RunnerConfig } from "./config.ts";
import type { SubmissionSource } from "../jobs/service.ts";

export interface JobCost {
  /** Median server-reported generation seconds per pinned-arm run. */
  serverSeconds: number;
  /** How many runs informed it (0 → the fallback is in effect). */
  samples: number;
}

/** Median per-run server-seconds over the last ≤20 pinned-arm assess runs. */
export function typicalJobCost(db: DatabaseSync, cfg: RunnerConfig, arm: { methodology: string; model: string }): JobCost {
  const rows = db
    .prepare(
      `SELECT COALESCE(SUM(u.wall_clock_ms), 0) AS ms
       FROM run r JOIN usage u ON u.run_id = r.id
       WHERE r.kind = 'assess' AND r.methodology = ? AND r.model = ?
       GROUP BY r.id ORDER BY r.started_at DESC LIMIT 20`,
    )
    .all(arm.methodology, arm.model) as Array<{ ms: number }>;
  const secs = rows.map((r) => r.ms / 1000).filter((s) => s > 0).sort((a, b) => a - b);
  if (secs.length < 3) return { serverSeconds: cfg.budget.typicalJobSecondsFallback, samples: secs.length };
  return { serverSeconds: secs[Math.floor(secs.length / 2)]!, samples: secs.length };
}

export interface LearnedCap {
  seconds: number;
  /** Rate-limit observations informing it (0 → fallback). */
  samples: number;
}

/** The session spend level at which 429s have historically arrived: the 25th
 *  percentile of the usage-gauge snapshots the runner recorded on its last ≤10
 *  rate-limit events (conservative — undercounted pi usage only biases this
 *  lower). Fallback until at least 2 observations exist. */
export function learnedSessionCap(db: DatabaseSync, cfg: RunnerConfig): LearnedCap {
  const rows = db
    .prepare(
      `SELECT detail FROM ledger_event
       WHERE kind = 'rate_limit' AND source = 'runner' AND detail IS NOT NULL
       ORDER BY ts DESC LIMIT 10`,
    )
    .all() as Array<{ detail: string }>;
  const gauges: number[] = [];
  for (const r of rows) {
    try {
      const d = JSON.parse(r.detail) as { sessionSeconds?: unknown };
      if (typeof d.sessionSeconds === "number" && d.sessionSeconds > 0) gauges.push(d.sessionSeconds);
    } catch {
      // assess-written events carry message text, not JSON — skip.
    }
  }
  if (gauges.length < 2) return { seconds: cfg.budget.sessionCapSecondsFallback, samples: gauges.length };
  gauges.sort((a, b) => a - b);
  return { seconds: gauges[Math.floor(gauges.length * 0.25)]!, samples: gauges.length };
}

export interface Headroom {
  /** Estimated server-seconds left in the ~5h session window (≥0). */
  sessionSeconds: number;
  /** Estimated server-seconds left in the weekly window (≥0). */
  weeklySeconds: number;
  sessionCap: LearnedCap;
  weeklyCapSeconds: number;
  sessionUsedSeconds: number;
  weeklyUsedSeconds: number;
}

export function headroom(
  db: DatabaseSync,
  cfg: RunnerConfig,
  used: { sessionUsedSeconds: number; weeklyUsedSeconds: number },
): Headroom {
  const sessionCap = learnedSessionCap(db, cfg);
  const weeklyCapSeconds = cfg.budget.weeklyCapSecondsFallback;
  return {
    sessionSeconds: Math.max(0, sessionCap.seconds - used.sessionUsedSeconds),
    weeklySeconds: Math.max(0, weeklyCapSeconds - used.weeklyUsedSeconds),
    sessionCap,
    weeklyCapSeconds,
    sessionUsedSeconds: used.sessionUsedSeconds,
    weeklyUsedSeconds: used.weeklyUsedSeconds,
  };
}

/** May a job from this source start now? User-facing work always attempts
 *  (rate limits are handled reactively — wait-and-retry is cheap thanks to the
 *  RECORD cache); discovery backfill is the budget's pressure valve and only
 *  runs with comfortable headroom in BOTH windows. */
export function canStartJob(
  source: SubmissionSource | null,
  h: Headroom,
  typical: JobCost,
  cfg: RunnerConfig,
): boolean {
  if (source !== "discovery") return true;
  return (
    h.sessionSeconds >= cfg.budget.discoverySessionFactor * typical.serverSeconds &&
    h.weeklySeconds >= cfg.budget.discoveryWeeklyFactor * typical.serverSeconds
  );
}
