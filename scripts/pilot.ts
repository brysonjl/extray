#!/usr/bin/env -S npx tsx
// CLI: run the must-detect inter-rater + calibration pilot gate. Produces the
// filled Results table for corpus/must-detect-pilot.md and exits non-zero on
// rater disagreement or judge-calibration failure, so the gate is enforceable.
//
//   npm run pilot -- [--model <judge-model>] [--model2 <second-rater-model>]
//                    [--second-rater <label>] [--record] [--fixtures <dir>]
//                    [--corpus <dir>] [--write]
//
// REPLAY is the default (needs committed fixtures for the monolith outputs AND
// both raters); RECORD needs LLM_ADAPTER. The second rater MUST be
// model-independent of the judge (a different model family, or human entries) —
// a same-model second pass measures self-consistency, not agreement.

import "./_env.ts"; // load .env before option defaults / adapter read process.env
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { RecordReplayClient, FixtureMissError, type ReplayMode } from "../src/llm/record-replay.ts";
import { analyzeCorpus } from "../src/corpus.ts";
import { loadAdapter } from "./_adapter.ts";
import { createMonolith, parseThink } from "../src/methodologies/monolith.ts";
import { runPilot, renderPilotTable, PILOT_SAMPLES, PilotError, type PilotInputs } from "../src/scorecard/pilot.ts";
import { PINNED_ANALYZED_AT, ScorecardError } from "../src/scorecard/index.ts";
import { JudgeParseError } from "../src/scorecard/judge.ts";
import { LabelError } from "../src/scorecard/labels.ts";

const RESULTS_START = "<!-- PILOT:RESULTS:START -->";
const RESULTS_END = "<!-- PILOT:RESULTS:END -->";

function writeResults(pilotDocPath: string, table: string): void {
  if (!existsSync(pilotDocPath)) return;
  const doc = readFileSync(pilotDocPath, "utf8");
  if (!doc.includes(RESULTS_START) || !doc.includes(RESULTS_END)) return;
  const before = doc.slice(0, doc.indexOf(RESULTS_START) + RESULTS_START.length);
  const after = doc.slice(doc.indexOf(RESULTS_END));
  writeFileSync(pilotDocPath, `${before}\n\n${table}\n\n${after}`);
}

const program = new Command();
program
  .name("pilot")
  .description("Run the must-detect inter-rater + calibration pilot gate")
  .option("--model <id>", "judge / monolith model; falls back to $PILOT_MODEL", process.env.PILOT_MODEL || "unspecified")
  .option("--model2 <id>", "second-rater model (must differ); falls back to $PILOT_MODEL2", process.env.PILOT_MODEL2 || "unspecified-2")
  .option("--think <level>", "monolith reasoning effort: true|false|low|medium|high (drives fixture keys); falls back to $SCORECARD_THINK", process.env.SCORECARD_THINK)
  .option("--verifier-model <id>", "claim-verifier model (013); defaults to --model; falls back to $SCORECARD_VERIFIER_MODEL", process.env.SCORECARD_VERIFIER_MODEL)
  .option("--second-rater <label>", "second-rater label for the report", "different-model-family")
  .option("--record", "RECORD mode (needs LLM_ADAPTER); default REPLAY")
  .option("--fixtures <dir>", "fixture directory", "corpus/fixtures/llm")
  .option("--corpus <dir>", "corpus directory", "corpus")
  .option("--write", "write the filled table into corpus/must-detect-pilot.md")
  .addHelpText(
    "after",
    "\nExit codes:\n  0  gate passed\n  2  config/usage error (missing pack, no adapter, same model for both raters)\n  4  REPLAY fixture miss\n  5  gate failed (rater disagreement or calibration failure)\n",
  )
  .action(async (opts: { model: string; model2: string; think?: string; verifierModel?: string; secondRater: string; record?: boolean; fixtures: string; corpus: string; write?: boolean }) => {
    try {
      // The second rater MUST be model-independent — same-model self-agreement is not an inter-rater gate.
      if (opts.model === opts.model2) {
        throw new ScorecardError(`--model2 ("${opts.model2}") must differ from --model — a same-model second pass measures self-consistency, not agreement`);
      }
      let think;
      try {
        think = parseThink(opts.think);
      } catch (e) {
        throw new ScorecardError((e as Error).message);
      }
      const mode: ReplayMode = opts.record ? "RECORD" : "REPLAY";
      const client = new RecordReplayClient({ mode, fixtureDir: opts.fixtures, wrapped: mode === "RECORD" ? await loadAdapter() : undefined });

      // Produce methodology-style output for each pilot sample via the monolith.
      const packs = new Map(
        analyzeCorpus(opts.corpus, { analyzedAt: PINNED_ANALYZED_AT }).filter((r) => r.valid).map((r) => [r.sample, r.pack] as const),
      );
      const monolith = createMonolith(opts.model, { think, verifierModel: opts.verifierModel });
      const outputs = new Map<string, string>();
      for (const sample of PILOT_SAMPLES) {
        const pack = packs.get(sample);
        if (!pack) throw new ScorecardError(`no valid evidence pack for pilot sample "${sample}". Run \`npm run analyze-corpus\` first.`);
        const out = await monolith.run({ sampleDir: join(opts.corpus, sample, "extension"), pack }, client);
        outputs.set(sample, out.report);
      }

      const inputs: PilotInputs = {
        outputs,
        rater1: client,
        model1: opts.model,
        rater2: client, // fixtures are keyed by model, so model2 ≠ model1 selects different fixtures
        model2: opts.model2,
        secondRaterLabel: opts.secondRater,
        corpusDir: opts.corpus,
      };
      const report = await runPilot(inputs);
      const table = renderPilotTable(report);
      process.stdout.write(table + "\n");
      if (opts.write) writeResults(join(opts.corpus, "must-detect-pilot.md"), table);

      if (!report.passed) process.exit(5);
    } catch (e) {
      if (e instanceof FixtureMissError) {
        process.stderr.write(`pilot: ${e.message}\n`);
        process.exit(4);
      }
      if (e instanceof ScorecardError || e instanceof PilotError || e instanceof LabelError || e instanceof JudgeParseError) {
        process.stderr.write(`pilot: ${e.message}\n`);
        process.exit(2);
      }
      throw e;
    }
  });

program.parseAsync();
