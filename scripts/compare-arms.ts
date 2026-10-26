#!/usr/bin/env -S npx tsx
// CLI: assemble a side-by-side comparison bundle for ONE extension — every
// automated arm-run (monolith/dag/pi × model) against the ground-truth run — out
// of the bake-off DB, so a reviewer (or the /loop driver) can spot where the arms
// diverge from the deep manual read: false positives, false negatives, tier
// disagreements, and shaky mechanisms.
//
//   npm run compare-arms -- --store-id <id>   [--db <path>] [--markdown]
//   npm run compare-arms -- --sample <name>   [--db <path>] [--markdown]
//
// It does the DETERMINISTIC half only: it pulls each run's findings, computes
// tier deltas and category/severity distributions, and lays the finding lists
// out next to the ground-truth set. It deliberately does NOT try to semantically
// match free-text findings across arms — that judgment (which arm finding IS
// ground-truth finding X, which is a true false positive) is left to the LLM
// step in the loop, seeded by this bundle. Default output is JSON; --markdown
// renders a human-skimmable summary table.
//
// "Latest wins": when an arm (methodology+model) was run more than once for the
// same target, only the most recent run is compared, so re-runs don't pile up.

import "./_env.ts";
import { outcomeFromStructured } from "../src/report/outcome.ts";
import type { AnalysisOutcome } from "../src/report/contract.ts";
import { existsSync } from "node:fs";
import { Command } from "commander";
import { DatabaseSync } from "node:sqlite";

const GROUND_TRUTH = "ground-truth";

interface FindingRow {
  finding_id: string | null;
  title: string | null;
  severity: string | null;
  category: string | null;
  finding_type: string | null;
  confidence: string | null;
  is_verified: number;
  exclusion_reason: string | null;
  claimed_mechanism: string | null;
  detail: string | null;
}

interface RunRow {
  run_id: number;
  methodology: string;
  model: string;
  mode: string | null;
  started_at: string;
  report_id: number;
  structured_json: string | null;
  tier: string | null;
}

interface FindingSet {
  tier?: string | null;
  run_id?: number;
  counts: { asserted: number; excluded: number };
  severity_hist: Record<string, number>;
  category_set: string[];
  findings: FindingRow[];
  excluded: FindingRow[];
}

interface ArmBundle extends FindingSet {
  run_id: number;
  methodology: string;
  model: string;
  tier: string | null;
  tier_matches_truth: boolean | null;
  comparison_complete: boolean | null;
  outcome?: AnalysisOutcome;
  /** Categories ground-truth asserted that this arm did not assert at all. */
  categories_truth_only: string[];
  /** Categories this arm asserted that ground-truth did not — candidate noise. */
  categories_arm_only: string[];
}

interface ComparisonBundle {
  target: { store_id: string | null; sample: string | null; name: string | null };
  ground_truth: (FindingSet & { run_id: number; tier: string | null }) | null;
  arms: ArmBundle[];
  note: string;
}

function severityHist(rows: FindingRow[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const r of rows) {
    const k = r.severity ?? "unknown";
    h[k] = (h[k] ?? 0) + 1;
  }
  return h;
}

function categorySet(rows: FindingRow[]): string[] {
  return [...new Set(rows.map((r) => r.category).filter((c): c is string => !!c))].sort();
}

/** Most recent run per (methodology, model) for this target. */
function latestRuns(runs: RunRow[]): RunRow[] {
  const best = new Map<string, RunRow>();
  for (const r of runs) {
    const key = `${r.methodology}\0${r.model}`;
    const prev = best.get(key);
    if (!prev || r.started_at > prev.started_at) best.set(key, r);
  }
  return [...best.values()];
}

function findingsFor(db: DatabaseSync, reportId: number): { asserted: FindingRow[]; excluded: FindingRow[] } {
  const all = db
    .prepare(
      `SELECT finding_id, title, severity, category, finding_type, confidence, is_verified,
              exclusion_reason, claimed_mechanism, detail
         FROM finding WHERE report_id = ? ORDER BY is_verified DESC`,
    )
    .all(reportId) as unknown as FindingRow[];
  return { asserted: all.filter((f) => f.is_verified === 1), excluded: all.filter((f) => f.is_verified === 0) };
}

function run(opts: { storeId?: string; sample?: string; sourceDir?: string; db: string; markdown?: boolean }): void {
  if (!opts.storeId && !opts.sample && !opts.sourceDir)
    throw new Error("pass --store-id <id>, --sample <name>, or --source-dir <path>");
  if (!existsSync(opts.db)) throw new Error(`no bake-off DB at ${opts.db} (run an assessment first)`);
  const db = new DatabaseSync(opts.db);

  // Match ONLY the requested identifier. A single `WHERE col = ?` (not an
  // `OR` over the columns) — an unused column's value would be NULL, and
  // `sample IS NULL` would otherwise match every non-corpus target in the DB.
  // `source_dir` is the join key for `assess --dir` runs (corpus mutants),
  // which carry neither a store id nor a sample. fixed whitelist → safe to interpolate.
  const idCol = opts.storeId ? "store_id" : opts.sample ? "sample" : "source_dir";
  const idVal = opts.storeId ?? opts.sample ?? opts.sourceDir!;

  const runs = db
    .prepare(
      `SELECT run.id AS run_id, run.methodology, run.model, run.mode, run.started_at,
              report.id AS report_id, report.tier, report.structured_json
         FROM run
         JOIN target ON target.run_id = run.id
         JOIN report ON report.target_id = target.id
        WHERE target.${idCol} = ?
        ORDER BY run.started_at`,
    )
    .all(idVal) as unknown as RunRow[];

  if (runs.length === 0) throw new Error(`no runs in ${opts.db} for ${idVal}`);

  const latest = latestRuns(runs);
  const truthRun = latest.find((r) => r.methodology === GROUND_TRUTH) ?? null;
  const truth = truthRun ? findingsFor(db, truthRun.report_id) : { asserted: [], excluded: [] };
  const truthCats = new Set(categorySet(truth.asserted));

  const identity = db
    .prepare(`SELECT name FROM target WHERE ${idCol} = ? AND name IS NOT NULL LIMIT 1`)
    .get(idVal) as { name?: string } | undefined;

  const arms: ArmBundle[] = latest
    .filter((r) => r.methodology !== GROUND_TRUTH)
    .sort((a, b) => a.methodology.localeCompare(b.methodology) || a.model.localeCompare(b.model))
    .map((r) => {
      const f = findingsFor(db, r.report_id);
      const cats = categorySet(f.asserted);
      const outcome = outcomeFromStructured(r.structured_json ? JSON.parse(r.structured_json) : undefined);
      const incomplete = outcome?.investigation === "incomplete";
      return {
        run_id: r.run_id,
        methodology: r.methodology,
        model: r.model,
        tier: r.tier,
        tier_matches_truth: truthRun && !incomplete ? r.tier === truthRun.tier : null,
        comparison_complete: outcome ? !incomplete : null,
        ...(outcome ? { outcome } : {}),
        counts: { asserted: f.asserted.length, excluded: f.excluded.length },
        severity_hist: severityHist(f.asserted),
        category_set: cats,
        categories_truth_only: [...truthCats].filter((c) => !cats.includes(c)),
        categories_arm_only: cats.filter((c) => !truthCats.has(c)),
        findings: f.asserted,
        excluded: f.excluded,
      };
    });

  const bundle: ComparisonBundle = {
    target: { store_id: opts.storeId ?? null, sample: opts.sample ?? opts.sourceDir ?? null, name: identity?.name ?? null },
    ground_truth: truthRun
      ? {
          run_id: truthRun.run_id,
          tier: truthRun.tier,
          counts: { asserted: truth.asserted.length, excluded: truth.excluded.length },
          severity_hist: severityHist(truth.asserted),
          category_set: [...truthCats],
          findings: truth.asserted,
          excluded: truth.excluded,
        }
      : null,
    arms,
    note: truthRun
      ? "categories_truth_only ≈ candidate false negatives; categories_arm_only ≈ candidate false positives. Confirm by reading the findings — category overlap is a coarse signal, not a match."
      : "NO ground-truth run recorded for this target yet — record one with `npm run record-truth` before comparing.",
  };

  if (opts.markdown) {
    process.stdout.write(renderMarkdown(bundle));
  } else {
    process.stdout.write(JSON.stringify(bundle, null, 2) + "\n");
  }
  db.close();
}

function renderMarkdown(b: ComparisonBundle): string {
  const gt = b.ground_truth;
  const lines: string[] = [];
  lines.push(`# Arm comparison — ${b.target.name ?? b.target.store_id ?? b.target.sample}`);
  lines.push("");
  lines.push(`Ground truth tier: **${gt?.tier ?? "—"}** · ${gt?.counts.asserted ?? 0} findings, ${gt?.counts.excluded ?? 0} excluded`);
  lines.push("");
  lines.push("| arm | model | tier | tier=GT | findings | excl | extra-cats | missing-cats |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const a of b.arms) {
    lines.push(
      `| ${a.methodology} | ${a.model} | ${a.tier ?? "—"}${a.comparison_complete === false ? " (INCOMPLETE; provisional)" : ""} | ${a.tier_matches_truth === null ? "—" : a.tier_matches_truth ? "✓" : "✗"} | ${a.counts.asserted} | ${a.counts.excluded} | ${a.categories_arm_only.join(",") || "—"} | ${a.categories_truth_only.join(",") || "—"} |`,
    );
  }
  lines.push("");
  lines.push(`> ${b.note}`);
  lines.push("");
  return lines.join("\n");
}

const program = new Command();
program
  .name("compare-arms")
  .description("Side-by-side comparison of automated arms vs the ground-truth run for one extension")
  .option("--store-id <id>", "Chrome Web Store id to compare")
  .option("--sample <name>", "corpus sample name to compare")
  .option("--source-dir <path>", "join key for `assess --dir` runs (corpus mutants) that carry no store id / sample")
  .option("--db <path>", "bake-off DB path", ".out/bakeoff.sqlite")
  .option("--markdown", "render a human-skimmable summary instead of JSON")
  .action((opts: { storeId?: string; sample?: string; sourceDir?: string; db: string; markdown?: boolean }) => {
    try {
      run(opts);
    } catch (e) {
      process.stderr.write(`compare-arms: ${(e as Error).message}\n`);
      process.exit(2);
    }
  });

program.parseAsync();
