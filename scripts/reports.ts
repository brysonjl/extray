#!/usr/bin/env -S npx tsx
// CLI: run one methodology over the corpus and write each extension's generated
// risk report in both machine-readable (.json) and human-readable (.md) form.
// This is the raw per-extension product output — NOT the scored rollup, which is
// `npm run scorecard`.
//
//   npm run reports -- [--methodology monolith] [--model <id>] [--record]
//                      [--fixtures <dir>] [--corpus <dir>] [--out <dir>]
//
// REPLAY is the default (serves committed fixtures, errors loudly on a miss).
// RECORD requires a provider adapter (set LLM_ADAPTER); it captures fixtures the
// same way the scorecard does, so a prior `npm run scorecard --record` already
// makes this run offline.

import "./_env.ts"; // load .env before option defaults / adapter read process.env
import { mkdirSync } from "node:fs";
import { Command } from "commander";
import { RecordReplayClient, FixtureMissError, type ReplayMode } from "../src/llm/record-replay.ts";
import { CostRatesError } from "../src/llm/usage.ts";
import { resolveEffectiveRates } from "../src/llm/model-pricing.ts";
import { createMonolith, parseThink } from "../src/methodologies/monolith.ts";
import { createDag } from "../src/methodologies/dag/index.ts";
import { createAgentic } from "../src/methodologies/agentic/index.ts";
import { createPi } from "../src/methodologies/pi/index.ts";
import type { Methodology } from "../src/methodologies/types.ts";
import { ScorecardError } from "../src/scorecard/index.ts";
import { LabelError } from "../src/scorecard/labels.ts";
import { generateReports } from "../src/scorecard/reports.ts";
import { writeSampleArtifacts } from "./_report-artifacts.ts";
import { loadAdapter } from "./_adapter.ts";
import { recordRunSafe } from "./_db.ts";
import { runInputFromReports } from "../src/db/adapters.ts";
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
  .name("reports")
  .description("Generate each extension's raw risk report (JSON + Markdown) for one methodology")
  .option("--methodology <id>", "methodology to run", "monolith")
  .option("--model <id>", "model id (drives fixture keys); falls back to $SCORECARD_MODEL", process.env.SCORECARD_MODEL || "unspecified")
  .option("--think <level>", "model reasoning effort: true|false|low|medium|high (drives fixture keys); falls back to $SCORECARD_THINK", process.env.SCORECARD_THINK)
  .option("--verifier-model <id>", "claim-verifier model (013); defaults to --model; falls back to $SCORECARD_VERIFIER_MODEL", process.env.SCORECARD_VERIFIER_MODEL)
  .option("--cost-rates <json-or-file>", 'USD per 1M tokens by model: {"<model>":{"input":N,"output":N},"default":{…}}; falls back to $LLM_COST_RATES', process.env.LLM_COST_RATES)
  .option("--record", "RECORD mode (live provider calls); default is REPLAY")
  .option("--fixtures <dir>", "fixture directory", "corpus/fixtures/llm")
  .option("--corpus <dir>", "corpus directory", "corpus")
  // Eval artifacts carry ground-truth labels in their headers — they must not
  // land in the same directory as real `npm run assess` reports (.out/reports).
  .option("--out <dir>", "output directory for <sample>.json + <sample>.md", ".out/eval-reports")
  .option("--db <path>", "bake-off DB to record this run into (for cross-run comparison)", ".out/bakeoff.sqlite")
  .option("--no-db", "do not record this run to the bake-off DB")
  .addHelpText(
    "after",
    "\nExit codes:\n  0  success\n  2  config/usage error (bad flag, unknown methodology, missing pack, provider misconfigured)\n  4  REPLAY fixture miss (record fixtures with --record or `npm run scorecard --record`)\n" +
      providerHelpText(),
  )
  .action(
    async (opts: { methodology: string; model: string; think?: string; verifierModel?: string; costRates?: string; record?: boolean; fixtures: string; corpus: string; out: string; db: string | false } & ProviderFlags) => {
      try {
        const startedAt = new Date().toISOString();
        const mode: ReplayMode = opts.record ? "RECORD" : "REPLAY";
        let provider: ProviderProvenance | null = null;
        const client = new RecordReplayClient({
          mode,
          fixtureDir: opts.fixtures,
          wrapped: mode === "RECORD" ? await loadAdapter({ provider: opts.provider, baseUrl: opts.baseUrl }, (p) => { provider = p; }) : undefined,
        });
        const methodology = makeMethodology(opts.methodology, opts.model, opts.think, opts.verifierModel, opts);
        // Pi generation bypasses the client used for verification/synthesis.
        if (methodology.id === "pi" && mode === "RECORD") {
          const p = resolveProvider({ provider: opts.provider, baseUrl: opts.baseUrl });
          provider = providerProvenance({ id: p.id, baseUrl: p.baseUrl });
        }
        // Rates default to the committed price table (overlaid with any
        // --cost-rates / $LLM_COST_RATES override) so estimated_usd lands
        // non-null at write time; unlisted models stay null (uncostedModels).
        const rates = resolveEffectiveRates(opts.costRates);

        const reports = await generateReports(methodology, { corpusDir: opts.corpus, client, costRates: rates });

        mkdirSync(opts.out, { recursive: true });
        for (const r of reports) {
          writeSampleArtifacts(opts.out, {
            sample: r.sample,
            kind: r.kind,
            expectedTier: r.expected_tier,
            methodology: r.methodology,
            model: r.model,
            output: { report: r.report, usage: r.usage, structured: r.structured, tier: r.tier },
          });
        }
        process.stdout.write(
          `wrote ${reports.length} report${reports.length === 1 ? "" : "s"} (.json + .md + .html) to ${opts.out}/ ` +
            `for methodology="${methodology.id}" model="${methodology.model}"\n`,
        );

        recordRunSafe(
          opts.db,
          withProviderProvenance(runInputFromReports({
            knobs: { methodology: methodology.id, model: methodology.model, verifierModel: opts.verifierModel, think: opts.think, mode, corpusDir: opts.corpus, fixturesDir: opts.fixtures, costRates: rates },
            startedAt,
            reports,
          }), provider),
        );
      } catch (e) {
        if (e instanceof FixtureMissError) {
          process.stderr.write(`reports: ${e.message}\n`);
          process.exit(4);
        }
        if (e instanceof ScorecardError || e instanceof LabelError || e instanceof CostRatesError) {
          process.stderr.write(`reports: ${e.message}\n`);
          process.exit(2);
        }
        throw e;
      }
    },
  );

program.parseAsync();
