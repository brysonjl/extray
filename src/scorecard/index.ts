// Scorecard orchestration: run one methodology over the corpus, judge each
// must_detect (and benign must_not_emit), normalize each output's tier, and
// compute the metrics. Pure of any concrete LLM provider — the caller injects an
// LlmClient (a RecordReplayClient in practice).

import { join } from "node:path";
import { analyzeCorpus } from "../corpus.ts";
import type { LlmClient } from "../llm/client.ts";
import { UsageTracker, summarizeCost, type CostRates, type CostSummary } from "../llm/usage.ts";
import { loadListingBeside, ListingLoadError } from "../listing/load.ts";
import { loadEnrichmentBeside, EnrichmentLoadError } from "../enrichment/load.ts";
import { loadCorpusLabels, type Label } from "./labels.ts";
import { judgeMustDetect, judgeAssertsClass } from "./judge.ts";
import { normalizeTier } from "./normalize.ts";
import { computeMetrics, type JudgedRun, type MetricsResult } from "./metrics.ts";
import type { Methodology, MethodologyOutput } from "../methodologies/types.ts";
import type { EvidencePack } from "../pipeline/schema.ts";

/** Pinned so the monolith prompt — and thus fixture keys — are byte-stable. */
export const PINNED_ANALYZED_AT = "2026-01-01T00:00:00Z";

export const CAVEATS = [
  "closed-world (A–G mirror the static-analysis taxonomy; H is the only open-world probe)",
  "synthetic (hand-authored mutants, not real-world malware)",
  "N=1 base (samples are correlated, not independent trials — ranking is directional)",
  "coverage validity bounded by the judge — agreement on a small pilot, not external ground truth",
  "stability measured only when fixtures carry N>1 distinct sampled runs (--runs N; sentinel otherwise)",
] as const;

export interface ScorecardResult extends MetricsResult {
  methodology: string;
  model: string;
  judge_model: string;
  runs: number;
  caveats: string[];
  /** Full-run token/cost accounting per (step, model) — unlike totals.cost
   *  (the arm's own usage), this also counts judge + normalize calls, closing
   *  the previously documented undercount. $ estimates appear when cost rates
   *  are supplied (USD per 1M tokens). */
  accounting: CostSummary;
}

export interface RunScorecardOptions {
  corpusDir?: string;
  client: LlmClient;
  runs?: number;
  tierRecall?: boolean;
  stabilityMeasurable?: boolean;
  /**
   * Model for the judge + tier-normalize calls. Should be a DIFFERENT model
   * family than the arm's model — self-grading is leniency-biased, and per-arm
   * judges make cross-arm scores incomparable (improvement 002). Defaults to
   * methodology.model with a loud warning.
   */
  judgeModel?: string;
  /** Pre-analyzed packs by sample; when provided, skips re-running the pipeline. */
  packs?: Map<string, EvidencePack>;
  /**
   * How many samples to investigate in parallel (default 1 = sequential, the
   * original behavior). Samples are independent, so this is pure wall-clock
   * speedup; results merge in label order so the scorecard stays deterministic.
   * Each in-flight sample may itself fan out (an agentic sample runs its 5
   * dimensions concurrently), so total in-flight LLM calls ≈ concurrency × that
   * fan-out — raise it with provider rate limits in mind.
   */
  concurrency?: number;
  /** USD-per-1M-token rates by model id (optional "default" fallback). When
   *  provided, the result's accounting carries $ estimates per step. */
  costRates?: CostRates;
  /**
   * Called once per sample (first run only) with the exact methodology output
   * the scorecard graded. The CLI uses it to persist the per-sample reports
   * (md/json/html) so the artifacts you inspect ARE the ones that were scored.
   * IO stays in the CLI; the scoring core never touches the filesystem.
   */
  onSampleReport?: (sample: string, output: MethodologyOutput) => void;
}

export class ScorecardError extends Error {}

/**
 * Wrap a client so every request carries a run index in `params`. Without it,
 * --runs N issues byte-identical requests and record-on-miss replays run 1's
 * fixture for runs 2..N — stability becomes a tautological 1.0 and cost is
 * summed N× over one completion (improvement 003). Applied only when nRuns > 1
 * so single-run fixture keys — and the committed fixtures — stay stable.
 */
function withRunIndex(client: LlmClient, run: number): LlmClient {
  return {
    complete: (req) => client.complete({ ...req, params: { ...(req.params ?? {}), run } }),
  };
}

/** Run `fn` over `items` with at most `limit` in flight; results stay in input order. */
async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Pre-flight: every labeled sample must have a valid pack BEFORE any LLM call. */
function preflight(labels: Map<string, Label>, packs: Map<string, EvidencePack>): void {
  const missing = [...labels.keys()].filter((s) => !packs.has(s));
  if (missing.length > 0) {
    throw new ScorecardError(
      `missing/invalid evidence pack for: ${missing.join(", ")}. Run \`npm run analyze-corpus\` first.`,
    );
  }
}

export async function runScorecard(methodology: Methodology, opts: RunScorecardOptions): Promise<ScorecardResult> {
  const corpusDir = opts.corpusDir ?? "corpus";
  const nRuns = opts.runs ?? 1;
  const judgeModel = opts.judgeModel ?? methodology.model;
  if (judgeModel === methodology.model) {
    process.stderr.write(
      `scorecard: WARNING — judge model "${judgeModel}" is the arm's own model. Self-grading is ` +
        `leniency-biased and cross-arm scores become incomparable; pass --judge-model with a different model family.\n`,
    );
  }

  const labels = loadCorpusLabels(corpusDir);
  const packs =
    opts.packs ??
    new Map(
      analyzeCorpus(corpusDir, { analyzedAt: PINNED_ANALYZED_AT })
        .filter((r) => r.valid)
        .map((r) => [r.sample, r.pack] as const),
    );
  preflight(labels, packs);

  // Track every LLM call (methodology, verifier, judge, normalize) per (label,
  // model) for the full-run accounting; totals.cost stays arm-only by design.
  const tracked = new UsageTracker(opts.client);

  // Grade one sample (all its runs). Samples are independent, so the caller runs
  // them with bounded concurrency; this returns its judged runs + the first-run
  // output for onSampleReport, to be merged in label order by the caller.
  const gradeSample = async ([sample, label]: [string, Label]): Promise<{
    sample: string;
    firstOut?: MethodologyOutput;
    runs: JudgedRun[];
  }> => {
    const pack = packs.get(sample)!;
    const sampleDir = join(corpusDir, sample, "extension");
    // Load the same 008b listing artifact reports.ts uses, so the graded report
    // is produced from identical inputs to the one a developer inspects.
    let listing;
    let enrichment;
    try {
      listing = loadListingBeside(sampleDir);
      // 015: same host-enrichment artifact reports.ts loads — graded inputs match.
      enrichment = loadEnrichmentBeside(sampleDir);
    } catch (e) {
      if (e instanceof ListingLoadError || e instanceof EnrichmentLoadError) throw new ScorecardError(e.message);
      throw e;
    }
    const runs: JudgedRun[] = [];
    let firstOut: MethodologyOutput | undefined;
    for (let i = 0; i < nRuns; i++) {
      // The run index is threaded into the METHODOLOGY call only: judge/normalize
      // requests hash the methodology output, so distinct outputs get distinct
      // fixtures automatically, while identical outputs share one judged verdict
      // (judge sampling noise must not count against the arm's stability).
      const armClient = nRuns > 1 ? withRunIndex(tracked, i) : tracked;
      const out = await methodology.run({ sampleDir, pack, listing, enrichment }, armClient);
      // Pi SDK sessions bypass the injected client. Merge only those external
      // passes; adding out.usage would count verifier/critic/synthesis twice.
      for (const pass of out.usageByStep ?? []) tracked.addExternal(pass);
      if (i === 0) firstOut = out;
      // Metrics retain the methodology's arm-only usage. The accounting tracker
      // separately includes every external pass and judge/normalize call.
      const usage = out.usage;

      const mustDetect = [];
      for (const behavior of label.must_detect) {
        const v = await judgeMustDetect(behavior, out.report, tracked, judgeModel);
        mustDetect.push({ behavior, satisfied: v.satisfied, rationale: v.rationale });
      }

      let mustNotEmit: JudgedRun["mustNotEmit"];
      if (label.kind === "benign") {
        mustNotEmit = [];
        for (const cls of label.must_not_emit) {
          const v = await judgeAssertsClass(cls, out.report, tracked, judgeModel);
          mustNotEmit.push({ class: cls, asserted: v.satisfied, rationale: v.rationale });
        }
      }

      // Grade the arm's NATIVE tier when it produces one (the monolith's
      // deterministic verdict): it IS the methodology's considered judgment, so
      // re-deriving it from the report prose with the neutral normalizer would
      // be circular (the report states the tier) and add LLM variance. The
      // normalizer remains the fair fallback for arms that emit only free text.
      const tierSource = out.tier ? "native" : "normalized";
      const tier = out.tier ?? (await normalizeTier(out.report, tracked, judgeModel));
      runs.push({ sample, normalizedTier: tier, tierSource, mustDetect, mustNotEmit, usage });
    }
    return { sample, firstOut, runs };
  };

  // Default 1 = the original sequential behavior; merge in label order so the
  // scorecard and onSampleReport callbacks stay deterministic regardless of
  // which sample finished first.
  const perSample = await mapBounded([...labels], opts.concurrency ?? 1, gradeSample);
  const judged: JudgedRun[] = [];
  for (const r of perSample) {
    if (r.firstOut) opts.onSampleReport?.(r.sample, r.firstOut);
    judged.push(...r.runs);
  }

  const metrics = computeMetrics(labels, judged, {
    tierRecall: opts.tierRecall,
    stabilityMeasurable: opts.stabilityMeasurable,
  });

  return {
    ...metrics,
    methodology: methodology.id,
    model: methodology.model,
    judge_model: judgeModel,
    runs: nRuns,
    caveats: [...CAVEATS],
    accounting: summarizeCost(tracked.breakdown(), opts.costRates),
  };
}
