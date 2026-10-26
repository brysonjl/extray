// Metrics — a PURE function of (labels, per-run judged outputs). No IO, no LLM.
// Implements the six metrics from corpus/grading-ground-truth.md plus the
// review-hardened refinements:
//   - coverage SPLIT into known-shapes (A–G) vs open-world (H); H is never folded
//     into the A–G number.
//   - unsafe_misses = confident-dismissals + hedged-misses (headline safety
//     figure), so an evasive arm can't hide misses in the hedge bucket.
//   - H tier-masking: H's expected_tier is `concerning` (= benign base), so a
//     missed H still scores tier-recall; flagged as tier-correct-behavior-missed.
//   - per_arm bellwether (never a product no_build).
//   - stability emits a `not measured (replay)` sentinel unless the caller says
//     fixtures carry N distinct sampled completions.

import { TIER_ORDER, type Label, type Tier } from "./labels.ts";
import type { Usage } from "../llm/client.ts";

export interface JudgedRun {
  sample: string;
  normalizedTier: Tier;
  /** "native": the arm's own deterministic tier was graded directly.
   *  "normalized": the neutral LLM normalizer mapped free-form prose. */
  tierSource: "native" | "normalized";
  mustDetect: Array<{ behavior: string; satisfied: boolean; rationale: string }>;
  mustNotEmit?: Array<{ class: string; asserted: boolean; rationale: string }>;
  usage: Usage;
}

export type MissKind = "confident-dismissal" | "hedged-miss" | "tier-correct-behavior-missed" | null;

export interface PerSample {
  sample: string;
  kind: Label["kind"];
  expected_tier: Tier;
  normalized_tier: Tier;
  tier_source: "native" | "normalized";
  must_detect: Array<{ behavior: string; satisfied: boolean; rationale: string }>;
  must_not_emit?: Array<{ class: string; asserted: boolean; rationale: string }>;
  coverage: number;
  false_alarm?: boolean; // benign only: true = emitted a must_not_emit class
  miss_kind?: MissKind; // malicious only
  usage: Usage;
}

export const STABILITY_SENTINEL = "not measured (replay)" as const;

export interface MetricsResult {
  per_sample: PerSample[];
  totals: {
    coverage_known_shapes: number; // A–G
    coverage_open_world: number | null; // H (null if H absent)
    tier_recall: number | null; // null when --no-tier-recall
    false_alarm_samples: string[]; // benign samples that emitted a forbidden class
    unsafe_misses: number; // confident-dismissals + hedged-misses
    false_dismissals: number;
    hedged_misses: number;
    stability: number | typeof STABILITY_SENTINEL;
    cost: Usage;
  };
  bellwether: { B: number | null; E: number | null; G: number | null; per_arm_missed: boolean };
  generalization_H: { detected: boolean; coverage: number | null; tier_masked: boolean };
}

export interface MetricsOptions {
  tierRecall?: boolean; // default true
  stabilityMeasurable?: boolean; // default false → sentinel
}

function coverageOf(run: JudgedRun): number {
  if (run.mustDetect.length === 0) return 0;
  return run.mustDetect.filter((m) => m.satisfied).length / run.mustDetect.length;
}

/** tier ≥ expected (inconclusive never satisfies recall). */
function meetsTier(normalized: Tier, expected: Tier): boolean {
  if (normalized === "inconclusive" || expected === "inconclusive") return normalized === expected;
  return TIER_ORDER[normalized] >= TIER_ORDER[expected];
}

function classifyMiss(label: Label, tier: Tier, coverage: number): MissKind {
  if (coverage > 0) return null; // some behavior detected → not a dismissal
  if (tier === "clean" || tier === "low-risk") return "confident-dismissal";
  if (tier === "inconclusive") return "hedged-miss";
  // tier is concerning or high-risk with zero coverage:
  if (label.is_generalization_probe && tier === label.expected_tier) return "tier-correct-behavior-missed";
  if (tier === "concerning") return "hedged-miss";
  return null; // high-risk with 0 coverage = blanket-high-risk trap; caught by coverage, not a safety miss
}

/** Structured projection used for stability comparison. */
function projection(run: JudgedRun): string {
  const satisfied = run.mustDetect
    .filter((m) => m.satisfied)
    .map((m) => m.behavior)
    .sort();
  return JSON.stringify([run.normalizedTier, satisfied]);
}

/** Fraction of samples whose runs all produce an identical projection (1.0 = fully stable). */
export function computeStability(runsBySample: Map<string, JudgedRun[]>): number {
  const samples = [...runsBySample.values()].filter((rs) => rs.length > 0);
  if (samples.length === 0) return 1;
  const stable = samples.filter((rs) => rs.every((r) => projection(r) === projection(rs[0]!))).length;
  return stable / samples.length;
}

function sumUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    wallClockMs: (a.wallClockMs ?? 0) + (b.wallClockMs ?? 0),
  };
}

export function computeMetrics(labels: Map<string, Label>, runs: JudgedRun[], opts: MetricsOptions = {}): MetricsResult {
  const tierRecall = opts.tierRecall !== false;

  const bySample = new Map<string, JudgedRun[]>();
  for (const r of runs) {
    if (!bySample.has(r.sample)) bySample.set(r.sample, []);
    bySample.get(r.sample)!.push(r);
  }

  const per_sample: PerSample[] = [];
  const knownShapeCov: number[] = [];
  let openWorldCov: number | null = null;
  const tierHits: boolean[] = [];
  const falseAlarmSamples: string[] = [];
  let falseDismissals = 0;
  let hedgedMisses = 0;
  let cost: Usage = { inputTokens: 0, outputTokens: 0, wallClockMs: 0 };
  const bellwether: Record<string, number> = {};
  let perArmMissed = false;
  let hDetected = false;
  let hTierMasked = false;

  for (const [sample, label] of labels) {
    const sampleRuns = bySample.get(sample) ?? [];
    if (sampleRuns.length === 0) continue;
    const run = sampleRuns[0]!; // per-sample display uses run 0
    // Cost sums per-run usage. This is correct ONLY because runScorecard threads
    // a run index into the request params when runs > 1, so every JudgedRun is a
    // DISTINCT completion (a missing run-indexed fixture throws under REPLAY
    // rather than replaying run 0's). Without that, identical replayed usage
    // would be double-counted N× (improvement 003).
    for (const rr of sampleRuns) cost = sumUsage(cost, rr.usage);

    const coverage = coverageOf(run);
    const entry: PerSample = {
      sample,
      kind: label.kind,
      expected_tier: label.expected_tier,
      normalized_tier: run.normalizedTier,
      tier_source: run.tierSource,
      must_detect: run.mustDetect,
      coverage,
      usage: run.usage,
    };

    if (label.kind === "benign") {
      const asserted = run.mustNotEmit ?? [];
      entry.must_not_emit = asserted;
      const falseAlarm = asserted.some((c) => c.asserted);
      entry.false_alarm = falseAlarm;
      if (falseAlarm) falseAlarmSamples.push(sample);
    } else {
      // malicious
      if (label.is_generalization_probe) {
        openWorldCov = coverage;
        hDetected = coverage > 0;
      } else {
        knownShapeCov.push(coverage);
      }
      if (tierRecall) tierHits.push(meetsTier(run.normalizedTier, label.expected_tier));

      const miss = classifyMiss(label, run.normalizedTier, coverage);
      entry.miss_kind = miss;
      if (miss === "confident-dismissal") falseDismissals++;
      else if (miss === "hedged-miss") hedgedMisses++;
      else if (miss === "tier-correct-behavior-missed") hTierMasked = true;

      const pid = label.injected_pattern_id;
      if (pid && (pid === "B" || pid === "E" || pid === "G")) {
        bellwether[pid] = coverage;
        if (coverage === 0) perArmMissed = true;
      }
    }

    per_sample.push(entry);
  }

  const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

  return {
    per_sample,
    totals: {
      coverage_known_shapes: mean(knownShapeCov),
      coverage_open_world: openWorldCov,
      tier_recall: tierRecall ? mean(tierHits.map((h) => (h ? 1 : 0))) : null,
      false_alarm_samples: falseAlarmSamples,
      unsafe_misses: falseDismissals + hedgedMisses,
      false_dismissals: falseDismissals,
      hedged_misses: hedgedMisses,
      stability: opts.stabilityMeasurable ? computeStability(bySample) : STABILITY_SENTINEL,
      cost,
    },
    bellwether: {
      B: bellwether.B ?? null,
      E: bellwether.E ?? null,
      G: bellwether.G ?? null,
      per_arm_missed: perArmMissed,
    },
    generalization_H: { detected: hDetected, coverage: openWorldCov, tier_masked: hTierMasked },
  };
}
