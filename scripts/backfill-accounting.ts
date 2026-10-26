#!/usr/bin/env -S npx tsx
// CLI: backfill the bake-off DB's accounting columns that the live paths never
// populated (closes 018's accounting follow-up):
//
//   - usage.estimated_usd      — priced from each row's OWN model at the committed
//                                price table (src/llm/model-pricing.ts)
//   - report.estimated_usd     — the sum of the report's child usage rows when any
//                                exist, else its token totals priced at run.model
//   - scorecard.estimated_usd  — from the run-level usage rows, else the stored
//                                token totals priced at run.model
//   - finding.claim_type       — recovered from the raw generated findings inside
//                                report.structured_json (matched by finding_id),
//                                then the sound partial rule for rows still NULL:
//                                kind='verified-behavior' can ONLY originate from an
//                                inferred-behavior claim (see src/report/classify.ts),
//                                so those become 'inferred-behavior'; traceless
//                                observed-capability rows have three possible origins
//                                and stay NULL. Ground-truth runs are never touched.
//
//   npm run backfill-accounting -- [--db .out/bakeoff.sqlite] [--dry-run]
//
// Models absent from the price table stay NULL and are reported per model —
// never a guessed $0. Idempotent: values are recomputed and overwritten, so a
// re-run reports 0 changes. The DB may be concurrently written by live runs, so
// the real run computes AND applies inside one IMMEDIATE transaction (a single
// consistent snapshot); --dry-run opens the file read-only and only prints.

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { costOf } from "../src/llm/usage.ts";
import { DEFAULT_MODEL_PRICING } from "../src/llm/model-pricing.ts";
import { openDb } from "../src/db/index.ts";

interface Row {
  [k: string]: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** USD for (model, tokens) at the committed table, or null when unlisted. */
function priceAt(model: unknown, inTok: unknown, outTok: unknown): number | null {
  if (typeof model !== "string" || model === "") return null;
  return costOf({ model, inputTokens: Number(inTok) || 0, outputTokens: Number(outTok) || 0 }, DEFAULT_MODEL_PRICING);
}

/** Locate the raw generated findings inside an arm's structured trace. Paths
 *  verified against the live DB: monolith nests them under `generated`;
 *  dag/pi/agentic carry them at the top level; agentic ALSO mirrors the same
 *  array under `dag` — first match wins so the mirror is never read twice. */
function rawTraceFindings(structured: unknown): unknown[] | null {
  if (!isObj(structured)) return null;
  if (isObj(structured.generated) && Array.isArray(structured.generated.findings)) return structured.generated.findings;
  if (Array.isArray(structured.findings)) return structured.findings;
  if (isObj(structured.dag) && Array.isArray(structured.dag.findings)) return structured.dag.findings;
  return null;
}

const near = (a: number | null, b: number | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a - b) < 1e-12;

const tally = (m: Map<string, number>, key: string): void => {
  m.set(key, (m.get(key) ?? 0) + 1);
};

const fmtTally = (m: Map<string, number>): string =>
  [...m.entries()].sort().map(([k, n]) => `${k}=${n}`).join(", ") || "none";

interface Plan {
  usageUpdates: Array<{ id: number; usd: number }>;
  usagePriced: Map<string, number>;
  usageUnpriced: Map<string, number>;
  reportUpdates: Array<{ id: number; usd: number }>;
  reportFromUsage: number;
  reportFromRunModel: number;
  reportVerifierMismatch: number;
  reportUnpriced: Map<string, number>;
  scorecardUpdates: Array<{ runId: number; usd: number }>;
  scorecardFromUsage: number;
  scorecardUnpriced: Map<string, number>;
  claimTypeUpdates: Array<{ id: number; claimType: string }>;
  traceMatched: number;
  traceReports: number;
  dupeSkippedReports: number;
  verifiedRule: number;
  stillNull: number;
}

/** Compute every pending write from one consistent read of the DB. Pure reads —
 *  the caller decides whether to apply (real run) or just print (--dry-run). */
export function computePlan(db: DatabaseSync): Plan {
  const plan: Plan = {
    usageUpdates: [], usagePriced: new Map(), usageUnpriced: new Map(),
    reportUpdates: [], reportFromUsage: 0, reportFromRunModel: 0, reportVerifierMismatch: 0, reportUnpriced: new Map(),
    scorecardUpdates: [], scorecardFromUsage: 0, scorecardUnpriced: new Map(),
    claimTypeUpdates: [], traceMatched: 0, traceReports: 0, dupeSkippedReports: 0, verifiedRule: 0, stillNull: 0,
  };

  // Runs whose estimated_usd was written under an EXPLICIT, persisted rate card
  // (--cost-rates / $LLM_COST_RATES snapshotted to run.cost_rates_json) are left
  // alone: re-pricing them at the committed default table would silently overwrite
  // an audited figure. The backfill only fills the NULLs the live paths never
  // priced (cost_rates_json is NULL on 100% of today's rows — this guards future
  // override runs). Ground-truth is skipped for the same never-touch reason.
  const pricedRuns = new Set(
    (db.prepare("SELECT id FROM run WHERE cost_rates_json IS NOT NULL").all() as Row[]).map((r) => r.id as number),
  );

  // ---- usage: price each row at ITS OWN model --------------------------------
  const usageRows = db
    .prepare("SELECT id, run_id, target_id, model, input_tokens, output_tokens, estimated_usd FROM usage")
    .all() as Row[];
  // (run_id, target_id) → the recomputed child-row estimates, for the report and
  // scorecard passes below (SUM over priced rows; null when none priced).
  const childByKey = new Map<string, { rows: number; sum: number | null }>();
  for (const u of usageRows) {
    const usd = priceAt(u.model, u.input_tokens, u.output_tokens);
    const key = `${u.run_id}|${u.target_id ?? "run"}`;
    const agg = childByKey.get(key) ?? { rows: 0, sum: null };
    agg.rows++;
    if (usd !== null) {
      agg.sum = (agg.sum ?? 0) + usd;
      tally(plan.usagePriced, u.model as string);
      if (!pricedRuns.has(u.run_id as number) && !near(usd, u.estimated_usd as number | null))
        plan.usageUpdates.push({ id: u.id as number, usd });
    } else {
      tally(plan.usageUnpriced, u.model as string);
    }
    childByKey.set(key, agg);
  }

  // ---- report: child-usage sum, else token totals at run.model ---------------
  const reportRows = db
    .prepare(
      `SELECT rep.id, rep.run_id, rep.target_id, rep.input_tokens, rep.output_tokens, rep.estimated_usd,
              r.model, r.verifier_model
       FROM report rep JOIN run r ON r.id = rep.run_id`,
    )
    .all() as Row[];
  for (const rep of reportRows) {
    const child = childByKey.get(`${rep.run_id}|${rep.target_id}`);
    let usd: number | null;
    if (child && child.rows > 0) {
      usd = child.sum;
      if (usd !== null) plan.reportFromUsage++;
    } else {
      usd = priceAt(rep.model, rep.input_tokens, rep.output_tokens);
      if (usd !== null) {
        plan.reportFromRunModel++;
        // The report token totals include verifier calls; when the verifier ran a
        // DIFFERENT model, pricing everything at run.model misattributes those
        // tokens. Priced anyway (best available), but counted loudly.
        if (rep.verifier_model !== null && rep.verifier_model !== rep.model) plan.reportVerifierMismatch++;
      }
    }
    if (usd === null) tally(plan.reportUnpriced, String(rep.model));
    else if (!pricedRuns.has(rep.run_id as number) && !near(usd, rep.estimated_usd as number | null))
      plan.reportUpdates.push({ id: rep.id as number, usd });
  }

  // ---- scorecard: run-level usage rows, else stored totals at run.model ------
  const scRows = db
    .prepare(
      `SELECT sc.run_id, sc.total_input_tokens, sc.total_output_tokens, sc.estimated_usd, r.model
       FROM scorecard sc JOIN run r ON r.id = sc.run_id`,
    )
    .all() as Row[];
  for (const sc of scRows) {
    const child = childByKey.get(`${sc.run_id}|run`);
    let usd: number | null;
    if (child && child.rows > 0) {
      usd = child.sum;
      if (usd !== null) plan.scorecardFromUsage++;
    } else {
      usd = priceAt(sc.model, sc.total_input_tokens, sc.total_output_tokens);
    }
    if (usd === null) tally(plan.scorecardUnpriced, String(sc.model));
    else if (!pricedRuns.has(sc.run_id as number) && !near(usd, sc.estimated_usd as number | null))
      plan.scorecardUpdates.push({ runId: sc.run_id as number, usd });
  }

  // ---- finding.claim_type (never ground-truth runs) ---------------------------
  const traceReports = db
    .prepare(
      `SELECT rep.id, rep.structured_json
       FROM report rep JOIN run r ON r.id = rep.run_id
       WHERE r.methodology != 'ground-truth'`,
    )
    .all() as Row[];
  const findingStmt = db.prepare(
    "SELECT id, finding_id, kind, claim_type FROM finding WHERE report_id = ?",
  );
  for (const rep of traceReports) {
    // id → claim_type from the raw trace findings, when a usable trace exists.
    let byId: Map<string, string> | null = null;
    if (typeof rep.structured_json === "string" && rep.structured_json !== "") {
      let raw: unknown[] | null = null;
      try {
        raw = rawTraceFindings(JSON.parse(rep.structured_json));
      } catch {
        raw = null; // malformed trace → treated as traceless
      }
      if (raw) {
        byId = new Map();
        for (const f of raw) {
          if (!isObj(f) || typeof f.id !== "string" || typeof f.claim_type !== "string") continue;
          if (byId.has(f.id)) {
            // Ambiguous trace: the same id twice means an id→claim_type match
            // could pick the wrong one. Don't guess — skip this report's trace.
            console.warn(`backfill-accounting: report ${rep.id}: duplicate finding id "${f.id}" in trace — skipping trace match for this report`);
            byId = null;
            plan.dupeSkippedReports++;
            break;
          }
          byId.set(f.id, f.claim_type);
        }
        if (byId) plan.traceReports++;
      }
    }
    const findings = findingStmt.all(rep.id as number) as Row[];
    for (const f of findings) {
      const current = f.claim_type as string | null;
      const fromTrace = byId && typeof f.finding_id === "string" ? byId.get(f.finding_id) : undefined;
      if (fromTrace !== undefined) {
        plan.traceMatched++;
        if (fromTrace !== current) plan.claimTypeUpdates.push({ id: f.id as number, claimType: fromTrace });
      } else if (current === null && f.kind === "verified-behavior") {
        plan.verifiedRule++;
        plan.claimTypeUpdates.push({ id: f.id as number, claimType: "inferred-behavior" });
      } else if (current === null) {
        plan.stillNull++;
      }
    }
  }

  return plan;
}

function printPlan(plan: Plan, dryRun: boolean): void {
  const verb = dryRun ? "would update" : "updated";
  console.log(`usage: ${verb} ${plan.usageUpdates.length} row(s)`);
  console.log(`  priced (by model): ${fmtTally(plan.usagePriced)}`);
  console.log(`  unpriced, left NULL (by model): ${fmtTally(plan.usageUnpriced)}`);
  console.log(`report: ${verb} ${plan.reportUpdates.length} row(s)`);
  console.log(`  priced from child usage rows: ${plan.reportFromUsage}; from token totals at run.model: ${plan.reportFromRunModel}`);
  console.log(`  of the run.model-priced: ${plan.reportVerifierMismatch} row(s) had verifier_model != model (verifier tokens priced at the run model — potential misattribution)`);
  console.log(`  unpriced, left NULL (by run.model): ${fmtTally(plan.reportUnpriced)}`);
  console.log(`scorecard: ${verb} ${plan.scorecardUpdates.length} row(s) (from run-level usage: ${plan.scorecardFromUsage}; unpriced by run.model: ${fmtTally(plan.scorecardUnpriced)})`);
  console.log(`finding.claim_type: ${verb} ${plan.claimTypeUpdates.length} row(s)`);
  console.log(`  trace-matched: ${plan.traceMatched} row(s) across ${plan.traceReports} traced report(s); trace skipped for duplicate ids: ${plan.dupeSkippedReports} report(s)`);
  console.log(`  verified-behavior rule (traceless → 'inferred-behavior'): ${plan.verifiedRule} row(s)`);
  console.log(`  still NULL (traceless observed-capability / excluded): ${plan.stillNull} row(s); ground-truth runs untouched`);
}

function apply(db: DatabaseSync, plan: Plan): void {
  const usageStmt = db.prepare("UPDATE usage SET estimated_usd = ? WHERE id = ?");
  for (const u of plan.usageUpdates) usageStmt.run(u.usd, u.id);
  const reportStmt = db.prepare("UPDATE report SET estimated_usd = ? WHERE id = ?");
  for (const r of plan.reportUpdates) reportStmt.run(r.usd, r.id);
  const scStmt = db.prepare("UPDATE scorecard SET estimated_usd = ? WHERE run_id = ?");
  for (const s of plan.scorecardUpdates) scStmt.run(s.usd, s.runId);
  const ctStmt = db.prepare("UPDATE finding SET claim_type = ? WHERE id = ?");
  for (const c of plan.claimTypeUpdates) ctStmt.run(c.claimType, c.id);
}

const program = new Command();
program
  .name("backfill-accounting")
  .description("Backfill estimated_usd (usage/report/scorecard) and finding.claim_type in the bake-off DB")
  .option("--db <path>", "bake-off DB to backfill", ".out/bakeoff.sqlite")
  .option("--dry-run", "print what WOULD change without writing (opens the DB read-only)")
  .action((opts: { db: string; dryRun?: boolean }) => {
    if (!existsSync(opts.db)) {
      process.stderr.write(`backfill-accounting: no DB at ${opts.db} (nothing to backfill)\n`);
      process.exit(2);
    }
    if (opts.dryRun) {
      const db = new DatabaseSync(opts.db, { readOnly: true });
      try {
        printPlan(computePlan(db), true);
      } finally {
        db.close();
      }
      return;
    }
    // Live writers may hit the DB mid-backfill: openDb sets busy_timeout, and
    // IMMEDIATE takes the write lock up front so compute+apply see one snapshot.
    const db = openDb(opts.db);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const plan = computePlan(db);
        apply(db, plan);
        db.exec("COMMIT");
        printPlan(plan, false);
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    } finally {
      db.close();
    }
  });

// Entry-guarded so test imports of computePlan don't run the CLI
// (CI has no .out/bakeoff.sqlite).
if (import.meta.url === `file://${process.argv[1]}`) program.parse();
