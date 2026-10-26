#!/usr/bin/env -S npx tsx
// CLI: run one methodology over the corpus and emit a scorecard (JSON + Markdown).
//
//   npm run scorecard -- [--methodology monolith] [--model <id>] [--judge-model <id>]
//                        [--runs N] [--no-tier-recall] [--record] [--fixtures <dir>]
//                        [--corpus <dir>] [--out <basename>]
//
// REPLAY is the default and serves committed fixtures, erroring loudly on a miss.
// RECORD requires a provider adapter (none is committed): set LLM_ADAPTER to a
// module path whose default export implements LlmClient.

import "./_env.ts"; // load .env before option defaults / adapter read process.env
import { writeFileSync } from "node:fs";
import { Command } from "commander";
import { RecordReplayClient, FixtureMissError, type ReplayMode } from "../src/llm/record-replay.ts";
import { CostRatesError } from "../src/llm/usage.ts";
import { resolveEffectiveRates } from "../src/llm/model-pricing.ts";
import { createMonolith, parseThink } from "../src/methodologies/monolith.ts";
import { createDag } from "../src/methodologies/dag/index.ts";
import { createAgentic } from "../src/methodologies/agentic/index.ts";
import { createPi } from "../src/methodologies/pi/index.ts";
import type { Methodology, MethodologyOutput } from "../src/methodologies/types.ts";
import { runScorecard, ScorecardError } from "../src/scorecard/index.ts";
import { renderJson, renderMarkdown } from "../src/scorecard/report.ts";
import { JudgeParseError } from "../src/scorecard/judge.ts";
import { LabelError, loadCorpusLabels } from "../src/scorecard/labels.ts";
import { writeSampleArtifacts } from "./_report-artifacts.ts";
import { loadAdapter } from "./_adapter.ts";
import { recordRunSafe } from "./_db.ts";
import { runInputFromScorecard } from "../src/db/adapters.ts";
import { warnIfSelfVerify } from "../src/methodologies/claim-verifier.ts";
import { warnUntestedModel } from "../src/llm/model-table.ts";
import { addProviderOptions, providerHelpText, type ProviderFlags } from "./_provider-flags.ts";
import { resolveProvider } from "../src/llm/provider.ts";
import { providerProvenance, withProviderProvenance, type ProviderProvenance } from "../src/llm/provenance.ts";

function makeMethodology(id: string, model: string, thinkRaw?: string, verifierModel?: string, provider?: ProviderFlags): Methodology {
  // Loud when self-verifying, mirroring the judge's self-grading warning —
  // measured ~77% confirm-rate leniency bias (018).
  warnIfSelfVerify(id, model, verifierModel ?? model);
  // Model choice is a correctness variable (src/llm/model-table.ts).
  warnUntestedModel(model);
  try {
    if (id === "monolith") return createMonolith(model, { think: parseThink(thinkRaw), verifierModel });
    if (id === "dag") return createDag(model, { verifierModel });
    if (id === "agentic") return createAgentic(model, { verifierModel });
    if (id === "pi") return createPi(model, { verifierModel, provider: provider?.provider, baseUrl: provider?.baseUrl });
    throw new ScorecardError(`unknown methodology "${id}" (expected "monolith", "dag", "agentic", or "pi")`);
  } catch (e) {
    if (e instanceof ScorecardError) throw e;
    throw new ScorecardError((e as Error).message);
  }
}

const program = new Command();
addProviderOptions(program)
  .name("scorecard")
  .description("Score one analysis methodology against the labeled corpus")
  .option("--methodology <id>", "methodology to run", "monolith")
  .option("--model <id>", "model id (drives fixture keys); falls back to $SCORECARD_MODEL", process.env.SCORECARD_MODEL || "unspecified")
  .option("--judge-model <id>", "judge/normalizer model — use a DIFFERENT model family than --model; falls back to $SCORECARD_JUDGE_MODEL", process.env.SCORECARD_JUDGE_MODEL)
  .option("--think <level>", "model reasoning effort: true|false|low|medium|high (drives fixture keys); falls back to $SCORECARD_THINK", process.env.SCORECARD_THINK)
  .option("--verifier-model <id>", "claim-verifier model (013); defaults to --model; falls back to $SCORECARD_VERIFIER_MODEL", process.env.SCORECARD_VERIFIER_MODEL)
  .option("--cost-rates <json-or-file>", 'USD per 1M tokens by model: {"<model>":{"input":N,"output":N},"default":{…}}; falls back to $LLM_COST_RATES', process.env.LLM_COST_RATES)
  .option("--runs <n>", "repeated runs per sample (≥2 to exercise stability)", "1")
  .option("--concurrency <n>", "samples investigated in parallel (default 1; raise with provider rate limits in mind)", "1")
  .option("--no-tier-recall", "rank on coverage alone (skip tier-recall)")
  .option("--record", "RECORD mode (live provider calls); default is REPLAY")
  .option("--fixtures <dir>", "fixture directory", "corpus/fixtures/llm")
  .option("--corpus <dir>", "corpus directory", "corpus")
  .option("--out <basename>", "output basename (.json + .md)", "scorecard")
  .option("--reports-dir <dir>", "also write each graded sample's report (.json + .md + .html) here")
  .option("--db <path>", "bake-off DB to record this run into (for cross-run comparison)", ".out/bakeoff.sqlite")
  .option("--no-db", "do not record this run to the bake-off DB")
  .addHelpText(
    "after",
    "\nExit codes:\n  0  success\n  2  config/usage error (bad flag, unknown methodology, missing pack, provider misconfigured)\n  4  REPLAY fixture miss (record fixtures with --record to fix)\n" +
      providerHelpText(),
  )
  .action(
    async (opts: {
      methodology: string;
      model: string;
      judgeModel?: string;
      think?: string;
      verifierModel?: string;
      costRates?: string;
      runs: string;
      concurrency: string;
      tierRecall: boolean;
      record?: boolean;
      fixtures: string;
      corpus: string;
      out: string;
      reportsDir?: string;
      db: string | false;
    } & ProviderFlags) => {
      try {
        const startedAt = new Date().toISOString();
        const nRuns = Number(opts.runs);
        if (!Number.isInteger(nRuns) || nRuns < 1) {
          throw new ScorecardError(`--runs must be a positive integer (got "${opts.runs}")`);
        }
        const concurrency = Number(opts.concurrency);
        if (!Number.isInteger(concurrency) || concurrency < 1) {
          throw new ScorecardError(`--concurrency must be a positive integer (got "${opts.concurrency}")`);
        }
        const mode: ReplayMode = opts.record ? "RECORD" : "REPLAY";
        let provider: ProviderProvenance | null = null;
        const client = new RecordReplayClient({
          mode,
          fixtureDir: opts.fixtures,
          wrapped: mode === "RECORD" ? await loadAdapter({ provider: opts.provider, baseUrl: opts.baseUrl }, (p) => { provider = p; }) : undefined,
        });
        const methodology = makeMethodology(opts.methodology, opts.model, opts.think, opts.verifierModel, opts);
        // Pi generation uses its own connection, independently of LLM_ADAPTER.
        // This field is generation provenance, not the verifier/judge endpoint.
        if (methodology.id === "pi" && mode === "RECORD") {
          const p = resolveProvider({ provider: opts.provider, baseUrl: opts.baseUrl });
          provider = providerProvenance({ id: p.id, baseUrl: p.baseUrl });
        }
        // Rates default to the committed price table (overlaid with any
        // --cost-rates / $LLM_COST_RATES override) so estimated_usd lands
        // non-null at write time; unlisted models stay null (uncostedModels).
        const rates = resolveEffectiveRates(opts.costRates);

        // Per-sample report artifacts (incl. HTML) when --reports-dir is set.
        // The labels give each sample's kind/expected tier for the provenance
        // header; the callback fires for the exact output the scorecard grades.
        const labels = opts.reportsDir ? loadCorpusLabels(opts.corpus) : null;
        let reportsWritten = 0;
        // Collect each sample's graded output so the DB write below can persist
        // the full risk report (findings + summaries), not just the metrics —
        // this is what makes a scorecard run populate `finding` rows. Always
        // collected; --reports-dir additionally writes the file artifacts.
        const sampleOutputs = new Map<string, MethodologyOutput>();

        const result = await runScorecard(methodology, {
          corpusDir: opts.corpus,
          client,
          runs: nRuns,
          concurrency,
          tierRecall: opts.tierRecall,
          // judgeModel undefined → runScorecard self-grades with a loud warning.
          judgeModel: opts.judgeModel,
          costRates: rates,
          // Run-indexed fixture keys make N runs N distinct completions, so
          // stability is measurable in REPLAY too (a missing run-indexed
          // fixture throws instead of silently replaying run 0's).
          stabilityMeasurable: nRuns > 1,
          onSampleReport: (sample, output) => {
            sampleOutputs.set(sample, output);
            if (opts.reportsDir) {
              const label = labels!.get(sample);
              writeSampleArtifacts(opts.reportsDir, {
                sample,
                kind: label?.kind,
                expectedTier: label?.expected_tier,
                methodology: methodology.id,
                model: methodology.model,
                output,
              });
              reportsWritten++;
            }
          },
        });

        writeFileSync(`${opts.out}.json`, renderJson(result));
        writeFileSync(`${opts.out}.md`, renderMarkdown(result));
        process.stdout.write(
          `scorecard written to ${opts.out}.json / ${opts.out}.md — ` +
            `coverage A–G ${(result.totals.coverage_known_shapes * 100).toFixed(0)}%, ` +
            `unsafe misses ${result.totals.unsafe_misses}\n`,
        );
        if (opts.reportsDir) {
          process.stdout.write(`wrote ${reportsWritten} per-sample reports (.json + .md + .html) to ${opts.reportsDir}/\n`);
        }

        recordRunSafe(
          opts.db,
          withProviderProvenance(runInputFromScorecard({
            knobs: {
              methodology: methodology.id,
              model: methodology.model,
              judgeModel: opts.judgeModel,
              verifierModel: opts.verifierModel,
              think: opts.think,
              mode,
              corpusDir: opts.corpus,
              fixturesDir: opts.fixtures,
              costRates: rates,
            },
            startedAt,
            result,
            outputs: sampleOutputs,
          }), provider),
        );
      } catch (e) {
        if (e instanceof FixtureMissError) {
          process.stderr.write(`scorecard: ${e.message}\n`);
          process.exit(4);
        }
        if (e instanceof ScorecardError || e instanceof LabelError || e instanceof JudgeParseError || e instanceof CostRatesError) {
          process.stderr.write(`scorecard: ${e.message}\n`);
          process.exit(2);
        }
        throw e;
      }
    },
  );

program.parseAsync();
