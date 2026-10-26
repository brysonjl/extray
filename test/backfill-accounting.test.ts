// computePlan is a pure function of the DB — unit-test the recall/money-critical
// branches (per-model pricing, the cost_rates_json skip, unlisted-model NULL, the
// claim_type trace match + verified-behavior partial rule + ground-truth skip)
// without touching the real bake-off DB.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { computePlan } from "../scripts/backfill-accounting.ts";

// glm-5.2 is in DEFAULT_MODEL_PRICING (1.40 in / 4.40 out per 1M); gemma4 is not.
function seed() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "backfill-")), "db.sqlite"));
  const run = db.prepare(
    "INSERT INTO run (run_hash, kind, methodology, model, mode, cost_rates_json, started_at) VALUES (?,?,?,?,?,?,?)",
  );
  const target = db.prepare("INSERT INTO target (run_id, is_corpus) VALUES (?, 0)");
  const report = db.prepare(
    "INSERT INTO report (run_id, target_id, tier, input_tokens, output_tokens, estimated_usd, structured_json) VALUES (?,?,?,?,?,?,?)",
  );
  const usage = db.prepare(
    "INSERT INTO usage (run_id, label, model, input_tokens, output_tokens, estimated_usd) VALUES (?,?,?,?,?,?)",
  );
  const finding = db.prepare(
    "INSERT INTO finding (report_id, finding_id, kind, claim_type, is_verified) VALUES (?,?,?,?,?)",
  );
  return { db, run, target, report, usage, finding };
}

describe("backfill computePlan", () => {
  it("prices usage rows at each row's own model and leaves unlisted models NULL", () => {
    const s = seed();
    const runId = Number(s.run.run("h1", "assess", "monolith", "glm-5.2:cloud", "RECORD", null, "2026-07-01").lastInsertRowid);
    s.usage.run(runId, "monolith", "glm-5.2:cloud", 1_000_000, 1_000_000, null); // → 1.40 + 4.40 = 5.80
    s.usage.run(runId, "monolith", "gemma4:31b-cloud", 1_000_000, 0, null); // unlisted → NULL
    const plan = computePlan(s.db);
    expect(plan.usageUpdates).toHaveLength(1);
    expect(plan.usageUpdates[0]!.usd).toBeCloseTo(5.8, 6);
    expect([...plan.usageUnpriced.keys()]).toEqual(["gemma4:31b-cloud"]);
  });

  it("does NOT overwrite estimated_usd on a run that carries a persisted rate card", () => {
    const s = seed();
    const runId = Number(s.run.run("h2", "assess", "monolith", "glm-5.2:cloud", "RECORD", '{"default":{"input":1,"output":1}}', "2026-07-01").lastInsertRowid);
    s.usage.run(runId, "monolith", "glm-5.2:cloud", 1_000_000, 1_000_000, 2.0); // audited under the persisted card
    const plan = computePlan(s.db);
    expect(plan.usageUpdates).toHaveLength(0); // left alone
  });

  it("recovers finding.claim_type from the structured trace, applies the verified-behavior rule, and never touches ground-truth", () => {
    const s = seed();
    const armRun = Number(s.run.run("h3", "assess", "monolith", "glm-5.2:cloud", "RECORD", null, "2026-07-01").lastInsertRowid);
    const armTarget = Number(s.target.run(armRun).lastInsertRowid);
    const trace = JSON.stringify({ generated: { findings: [{ id: "f1", claim_type: "observed-capability" }] } });
    const repId = Number(s.report.run(armRun, armTarget, "low-risk", 0, 0, null, trace).lastInsertRowid);
    s.finding.run(repId, "f1", "observed-capability", "observed-capability", 1); // trace match, already correct → no update
    s.finding.run(repId, "f2", "verified-behavior", null, 1); // no trace entry → verified rule → inferred-behavior

    // Ground-truth run: never touched.
    const gtRun = Number(s.run.run("h4", "assess", "ground-truth", "human", "RECORD", null, "2026-07-01").lastInsertRowid);
    const gtTarget = Number(s.target.run(gtRun).lastInsertRowid);
    const gtRep = Number(s.report.run(gtRun, gtTarget, "high-risk", 0, 0, null, null).lastInsertRowid);
    s.finding.run(gtRep, "g1", "verified-behavior", null, 1);

    const plan = computePlan(s.db);
    const updates = new Map(plan.claimTypeUpdates.map((u) => [u.id, u.claimType]));
    // f1 already equals its trace value → no update; f2 gets the verified rule.
    expect(plan.traceMatched).toBe(1);
    expect(plan.verifiedRule).toBe(1);
    expect([...updates.values()]).toEqual(["inferred-behavior"]);
    // The ground-truth verified-behavior row is not in the update set.
    expect(plan.claimTypeUpdates).toHaveLength(1);
  });
});
