// Typed adapters: convert each CLI's in-memory result objects into the loose
// RunInput recordRun() consumes. The backfill script builds RunInput straight
// from parsed JSON instead; these exist so the LIVE write path stays strongly
// typed against the real result shapes (RiskReport, ScorecardResult, …).

import { ANALYZER_VERSION } from "../pipeline/schema.ts";
import { REPORT_SCHEMA_VERSION } from "../report/contract.ts";
import type { CostSummary } from "../llm/usage.ts";
import type { ScorecardResult } from "../scorecard/index.ts";
import type { GeneratedReport } from "../scorecard/reports.ts";
import type { MethodologyOutput } from "../methodologies/types.ts";
import { resolveGitSha, type RunInput, type UsageLine } from "./index.ts";

/** Per-step accounting → usage rows. */
export function costSummaryToLines(s: CostSummary | undefined | null): UsageLine[] {
  if (!s) return [];
  return s.entries.map((e) => ({
    label: e.label,
    model: e.model,
    calls: e.calls,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    wallClockMs: e.wallClockMs,
    estimatedUsd: e.estimatedUsd,
  }));
}

/** Shared knob block common to every run kind. */
interface Knobs {
  methodology: string;
  model: string;
  verifierModel?: string;
  judgeModel?: string;
  think?: string;
  mode?: string;
  /** True when the Pi arm was routed through the headroom compression proxy. */
  headroom?: boolean;
  /** Pi sharded fan-out: effective model per dimension + synthesis. Absent when monolithic. */
  subagentModels?: Record<string, string>;
  corpusDir?: string;
  fixturesDir?: string;
  costRates?: unknown;
}

function baseRun(knobs: Knobs, kind: RunInput["kind"], startedAt: string): Omit<RunInput, "targets"> {
  return {
    kind,
    methodology: knobs.methodology,
    model: knobs.model,
    verifierModel: knobs.verifierModel ?? null,
    judgeModel: knobs.judgeModel ?? null,
    think: knobs.think ?? null,
    mode: knobs.mode ?? null,
    headroom: knobs.headroom ?? null,
    subagentModels: knobs.subagentModels ?? null,
    analyzerVersion: ANALYZER_VERSION,
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    corpusDir: knobs.corpusDir ?? null,
    fixturesDir: knobs.fixturesDir ?? null,
    costRates: knobs.costRates ?? null,
    gitSha: resolveGitSha(),
    startedAt,
  };
}

/** Single-extension `assess` run → one run, one target. */
export function runInputFromAssess(args: {
  knobs: Knobs;
  startedAt: string;
  storeId: string | null;
  sourceDir: string;
  result: MethodologyOutput;
  /** The re-rendered report text (with store_id injected), as written to disk. */
  reportText: string;
  accounting: CostSummary;
}): RunInput {
  return {
    ...baseRun(args.knobs, "assess", args.startedAt),
    targets: [
      {
        storeId: args.storeId,
        sourceDir: args.sourceDir,
        isCorpus: false,
        tier: args.result.tier ?? null,
        report: args.reportText,
        structured: args.result.structured,
        usage: args.result.usage,
        usageByStep: costSummaryToLines(args.accounting),
        estimatedUsd: args.accounting.estimatedUsd,
      },
    ],
  };
}

/** Corpus `reports` run → one run, one target per sample (full risk reports). */
export function runInputFromReports(args: { knobs: Knobs; startedAt: string; reports: GeneratedReport[] }): RunInput {
  return {
    ...baseRun(args.knobs, "reports", args.startedAt),
    targets: args.reports.map((r) => ({
      sample: r.sample,
      isCorpus: true,
      labelKind: r.kind,
      expectedTier: r.expected_tier,
      tier: r.tier ?? null,
      report: r.report,
      structured: r.structured,
      usage: r.usage,
      usageByStep: costSummaryToLines(r.accounting),
      estimatedUsd: r.accounting?.estimatedUsd ?? null,
    })),
  };
}

/** Corpus `scorecard` run → one run, one target per sample, plus the scored
 *  rollup and per-sample judged results. `outputs` (the per-sample graded
 *  MethodologyOutput, keyed by sample) is optional: when supplied, each target
 *  also carries the arm's full risk report, so `finding` rows are populated
 *  exactly as a `reports` run would. Without it, target/report rows are
 *  tier+usage only (the metrics-only behavior). */
export function runInputFromScorecard(args: {
  knobs: Knobs;
  startedAt: string;
  result: ScorecardResult;
  outputs?: Map<string, MethodologyOutput>;
}): RunInput {
  const r = args.result;
  return {
    ...baseRun(args.knobs, "scorecard", args.startedAt),
    judgeModel: r.judge_model,
    runs: r.runs,
    tierRecall: r.totals.tier_recall !== null,
    targets: r.per_sample.map((s) => {
      const out = args.outputs?.get(s.sample);
      return {
        sample: s.sample,
        isCorpus: true,
        labelKind: s.kind,
        expectedTier: s.expected_tier,
        // Keep the GRADED tier (normalized) for the report row, so the DB
        // reflects what the scorecard actually scored — not the arm's raw
        // native tier (which the structured trace also carries).
        tier: s.normalized_tier,
        tierSource: s.tier_source,
        report: out?.report ?? null,
        structured: out?.structured,
        usage: s.usage,
      };
    }),
    scorecard: {
      coverageKnownShapes: r.totals.coverage_known_shapes,
      coverageOpenWorld: r.totals.coverage_open_world,
      tierRecall: r.totals.tier_recall,
      unsafeMisses: r.totals.unsafe_misses,
      falseDismissals: r.totals.false_dismissals,
      hedgedMisses: r.totals.hedged_misses,
      falseAlarmCount: r.totals.false_alarm_samples.length,
      stability: r.totals.stability,
      bellwether: r.bellwether,
      h: r.generalization_H,
      totalInputTokens: r.totals.cost.inputTokens,
      totalOutputTokens: r.totals.cost.outputTokens,
      estimatedUsd: r.accounting.estimatedUsd,
      usageByStep: costSummaryToLines(r.accounting),
      raw: { totals: r.totals, bellwether: r.bellwether, generalization_H: r.generalization_H, caveats: r.caveats },
      samples: r.per_sample.map((s) => ({
        sample: s.sample,
        labelKind: s.kind,
        expectedTier: s.expected_tier,
        normalizedTier: s.normalized_tier,
        tierSource: s.tier_source,
        coverage: s.coverage,
        missKind: s.miss_kind ?? null,
        falseAlarm: s.false_alarm ?? null,
        mustDetect: s.must_detect,
        mustNotEmit: s.must_not_emit ?? null,
        inputTokens: s.usage.inputTokens,
        outputTokens: s.usage.outputTokens,
      })),
    },
  };
}
