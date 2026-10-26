// The budget ledger (src/runner/ledger.ts): job-cost medians from recorded
// usage, the session cap learned from rate-limit gauge snapshots, and the
// discovery gating policy.

import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/index.ts";
import { DEFAULT_RUNNER_CONFIG } from "../src/runner/config.ts";
import { canStartJob, headroom, learnedSessionCap, typicalJobCost } from "../src/runner/ledger.ts";

const ARM = { methodology: "pi", model: "glm-5.2:cloud" };
const cfg = DEFAULT_RUNNER_CONFIG;

let db: DatabaseSync;

beforeEach(() => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "ledger-")), "db.sqlite"));
});

function seedRun(startedAt: string, wallClockMs: number, arm = ARM): void {
  const res = db
    .prepare("INSERT INTO run (run_hash, kind, methodology, model, started_at) VALUES (?,?,?,?,?)")
    .run(`h-${startedAt}-${wallClockMs}-${Math.random()}`, "assess", arm.methodology, arm.model, startedAt);
  db.prepare("INSERT INTO usage (run_id, label, model, wall_clock_ms) VALUES (?,?,?,?)").run(
    Number(res.lastInsertRowid),
    "pi",
    arm.model,
    wallClockMs,
  );
}

function seedRateLimit(ts: string, sessionSeconds: number | string): void {
  const detail = typeof sessionSeconds === "number" ? JSON.stringify({ sessionSeconds }) : sessionSeconds;
  db.prepare("INSERT INTO ledger_event (ts, kind, source, detail) VALUES (?, 'rate_limit', 'runner', ?)").run(ts, detail);
}

describe("typicalJobCost", () => {
  it("falls back below 3 samples", () => {
    seedRun("2026-08-01T00:00:00Z", 100_000);
    const c = typicalJobCost(db, cfg, ARM);
    expect(c.serverSeconds).toBe(cfg.budget.typicalJobSecondsFallback);
    expect(c.samples).toBe(1);
  });

  it("takes the median of recent pinned-arm runs, ignoring other arms", () => {
    seedRun("2026-08-01T00:00:00Z", 100_000);
    seedRun("2026-08-01T01:00:00Z", 200_000);
    seedRun("2026-08-01T02:00:00Z", 900_000);
    seedRun("2026-08-01T03:00:00Z", 900_000_000, { methodology: "monolith", model: "glm-5.2:cloud" });
    const c = typicalJobCost(db, cfg, ARM);
    expect(c.samples).toBe(3);
    expect(c.serverSeconds).toBe(200); // median of 100/200/900
  });
});

describe("learnedSessionCap", () => {
  it("falls back below 2 parseable observations (assess text events don't count)", () => {
    seedRateLimit("2026-08-01T00:00:00Z", "ollama-cloud: 429 Too Many Requests"); // assess-style text
    seedRateLimit("2026-08-01T01:00:00Z", 1800);
    const cap = learnedSessionCap(db, cfg);
    expect(cap.seconds).toBe(cfg.budget.sessionCapSecondsFallback);
    expect(cap.samples).toBe(1);
  });

  it("takes a conservative (25th percentile) of the observed gauges", () => {
    for (const [i, s] of [1000, 2000, 3000, 4000].entries()) {
      seedRateLimit(`2026-08-01T0${i}:00:00Z`, s);
    }
    const cap = learnedSessionCap(db, cfg);
    expect(cap.samples).toBe(4);
    expect(cap.seconds).toBe(2000); // index floor(4*0.25)=1 of sorted [1000,2000,3000,4000]
  });
});

describe("headroom + canStartJob", () => {
  it("user/remote jobs always start; discovery needs comfortable headroom in both windows", () => {
    const h = headroom(db, cfg, { sessionUsedSeconds: 0, weeklyUsedSeconds: 0 });
    const typical = { serverSeconds: 300, samples: 5 };
    expect(canStartJob("user", h, typical, cfg)).toBe(true);
    expect(canStartJob("remote", h, typical, cfg)).toBe(true);
    expect(canStartJob(null, h, typical, cfg)).toBe(true);
    expect(canStartJob("discovery", h, typical, cfg)).toBe(true);

    // Session window nearly spent: discovery defers, user work still attempts.
    const tight = headroom(db, cfg, {
      sessionUsedSeconds: cfg.budget.sessionCapSecondsFallback - 100,
      weeklyUsedSeconds: 0,
    });
    expect(canStartJob("discovery", tight, typical, cfg)).toBe(false);
    expect(canStartJob("remote", tight, typical, cfg)).toBe(true);

    // Weekly window spent: same story.
    const weeklyTight = headroom(db, cfg, {
      sessionUsedSeconds: 0,
      weeklyUsedSeconds: cfg.budget.weeklyCapSecondsFallback - 100,
    });
    expect(canStartJob("discovery", weeklyTight, typical, cfg)).toBe(false);
  });

  it("headroom never goes negative", () => {
    const h = headroom(db, cfg, { sessionUsedSeconds: 10_000_000, weeklyUsedSeconds: 10_000_000 });
    expect(h.sessionSeconds).toBe(0);
    expect(h.weeklySeconds).toBe(0);
  });
});
