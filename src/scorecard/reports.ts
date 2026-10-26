// Per-extension report generation: run one methodology over the corpus and emit
// each sample's raw generated risk report — the actual product-shaped output,
// NOT the scored rollup (that is the scorecard). Two formats per sample:
//   - machine-readable JSON (report text + metadata + usage)
//   - human-readable Markdown (the report, with a small provenance header)
//
// This is intentionally judgment-free: no judge, no tier-normalizer, no metrics.
// It exists so a developer can read and validate what each (model × methodology)
// actually produces for each extension. Like the scorecard it is provider-pure —
// the caller injects an LlmClient (a RecordReplayClient in practice).

import { join } from "node:path";
import { analyzeCorpus } from "../corpus.ts";
import type { LlmClient, Usage } from "../llm/client.ts";
import { UsageTracker, type CostRates, type CostSummary } from "../llm/usage.ts";
import { loadListingBeside, ListingLoadError } from "../listing/load.ts";
import { loadEnrichmentBeside, EnrichmentLoadError } from "../enrichment/load.ts";
import { loadCorpusLabels, type Label, type Tier } from "./labels.ts";
import { ScorecardError, PINNED_ANALYZED_AT } from "./index.ts";
import type { Methodology } from "../methodologies/types.ts";
import type { EvidencePack } from "../pipeline/schema.ts";

export interface GeneratedReport {
  sample: string;
  kind: Label["kind"];
  expected_tier: Label["expected_tier"];
  methodology: string;
  model: string;
  report: string;
  usage: Usage;
  /** The arm's native risk tier, when it produces one. */
  tier?: Tier;
  /** Arm-specific structured trace (e.g. monolith findings + verifier verdicts), when the arm provides one. */
  structured?: unknown;
  /** Per-step token/cost accounting for THIS sample's calls (mirrors what a
   *  single-extension assess records) — feeds the bake-off DB's usage rows. */
  accounting?: CostSummary;
}

export interface GenerateReportsOptions {
  corpusDir?: string;
  client: LlmClient;
  /** Pre-analyzed packs by sample; when provided, skips re-running the pipeline. */
  packs?: Map<string, EvidencePack>;
  /** USD-per-1M rates for the per-sample accounting; absent → token counts only. */
  costRates?: CostRates;
  /**
   * Called when ONE sample fails. Return true to skip it and keep going.
   * Default (absent) rethrows, which is what `eval` and `reports` want: a
   * scorecard computed over a silently partial corpus is a wrong number.
   * The Explorer's offline corpus ingest sets it, because there it is honest
   * to say "9 of 11 samples have committed fixtures for this arm".
   */
  onSampleError?: (sample: string, err: unknown) => boolean;
}

/** Run the methodology over every labeled sample and collect its raw output. */
export async function generateReports(
  methodology: Methodology,
  opts: GenerateReportsOptions,
): Promise<GeneratedReport[]> {
  const corpusDir = opts.corpusDir ?? "corpus";
  const labels = loadCorpusLabels(corpusDir);
  const packs =
    opts.packs ??
    new Map(
      analyzeCorpus(corpusDir, { analyzedAt: PINNED_ANALYZED_AT })
        .filter((r) => r.valid)
        .map((r) => [r.sample, r.pack] as const),
    );

  // Pre-flight: every labeled sample must have a pack BEFORE any LLM call.
  const missing = [...labels.keys()].filter((s) => !packs.has(s));
  if (missing.length > 0) {
    throw new ScorecardError(
      `missing/invalid evidence pack for: ${missing.join(", ")}. Run \`npm run analyze-corpus\` first.`,
    );
  }

  const out: GeneratedReport[] = [];
  for (const [sample, label] of labels) {
    try {
      out.push(await one(sample, label));
    } catch (e) {
      if (!opts.onSampleError?.(sample, e)) throw e;
    }
  }
  return out;

  async function one(sample: string, label: Label): Promise<GeneratedReport> {
    const pack = packs.get(sample)!;
    const sampleDir = join(corpusDir, sample, "extension");
    // 008b: a committed corpus/<sample>/developer-listing.json artifact feeds
    // the developer section; samples without one stay manifest-only. NOTE:
    // adding/changing an artifact changes the synthesize prompt and thus that
    // sample's synthesize fixture key (generation/verify fixtures are unaffected).
    let listing;
    let enrichment;
    try {
      listing = loadListingBeside(sampleDir);
      // 015: a committed host-enrichment.json artifact folds RDAP context into
      // the serialized pack the arms read and the destination rows. Like the
      // listing, adding/changing it changes the affected arm fixture keys.
      enrichment = loadEnrichmentBeside(sampleDir);
    } catch (e) {
      if (e instanceof ListingLoadError || e instanceof EnrichmentLoadError) throw new ScorecardError(e.message);
      throw e;
    }
    // Fresh tracker per sample so each report carries ITS OWN per-step
    // accounting (usage rows attribute to the right target in the DB).
    const tracker = new UsageTracker(opts.client);
    const res = await methodology.run({ sampleDir, pack, listing, enrichment }, tracker);
    // Fold in usage from passes that bypassed the tracker (the Pi arm's own
    // model sessions), mirroring the assess CLI's accounting.
    for (const l of res.usageByStep ?? []) tracker.addExternal(l);
    return {
      sample,
      kind: label.kind,
      expected_tier: label.expected_tier,
      methodology: methodology.id,
      model: methodology.model,
      report: res.report,
      usage: res.usage,
      ...(res.tier !== undefined ? { tier: res.tier } : {}),
      ...(res.structured !== undefined ? { structured: res.structured } : {}),
      accounting: tracker.summary(opts.costRates),
    };
  }
}

/** Machine-readable per-sample artifact. */
export function renderReportJson(r: GeneratedReport): string {
  return JSON.stringify(r, null, 2) + "\n";
}

/** Human-readable per-sample artifact: a provenance header + the raw report. */
export function renderReportMarkdown(r: GeneratedReport): string {
  return [
    `<!-- generated report — do not hand-edit; regenerate with \`npm run reports\` -->`,
    `> **${r.sample}** · methodology: \`${r.methodology}\` · model: \`${r.model}\``,
    `> label: ${r.kind}, expected tier \`${r.expected_tier}\` · usage: ${r.usage.inputTokens}/${r.usage.outputTokens} tokens`,
    ``,
    r.report,
    ``,
  ].join("\n");
}
