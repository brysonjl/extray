// One-click ingest of the labeled synthetic corpus into the Explorer catalog.
//
// Why this exists: a fresh clone has an empty database, and an empty catalog
// teaches a newcomer nothing about what the tool produces. The corpus is the
// one dataset we can populate it with honestly — it ships in the repo, it has
// answer keys, and it has committed LLM replay fixtures, so the ingest runs
// OFFLINE with no API key and costs nothing.
//
// Two properties this must never lose:
//   1. Every row lands as a corpus target (is_corpus = 1), which is what makes
//      the UI badge it "synthetic test fixture". These are mutants we
//      wrote; a reader must never mistake one for a store extension.
//   2. It replays committed fixtures. It never records live, so a "clean"
//      environment cannot quietly turn the demo button into a bill.

import { generateReports } from "../scorecard/reports.ts";
import { createMonolith } from "../methodologies/monolith.ts";
import { RecordReplayClient, FixtureMissError } from "../llm/record-replay.ts";
import { resolveEffectiveRates } from "../llm/model-pricing.ts";
import { runInputFromReports } from "../db/adapters.ts";
import type { RunInput } from "../db/index.ts";

/** The exact generation/verification configuration for the committed synthetic
 * baseline. Replay matches label, model, prompt and parameters. The ingest
 * integration test checks all 11 demo samples. Changes to source or prompts
 * require genuine matching recordings; use docs/evaluation.md and the fixture
 * manifest to validate the full chain rather than substituting another arm.
 */
export const CORPUS_INGEST_ARM = {
  methodology: "monolith",
  model: "glm-5.2:cloud",
  think: "high",
  verifierModel: "gpt-oss:120b",
} as const;

export interface CorpusIngestResult {
  /** Samples that replayed and were recorded. */
  ingested: string[];
  /** Samples with no committed fixture for this arm — skipped, not failed. */
  skipped: { sample: string; reason: string }[];
}

export interface CorpusIngestOptions {
  corpusDir?: string;
  fixturesDir?: string;
  /** Persist the run. Injected so the pure part stays testable and so this
   *  module does not have to know how the caller opened its database. */
  record: (input: RunInput) => void;
}

export async function ingestCorpus(opts: CorpusIngestOptions): Promise<CorpusIngestResult> {
  const startedAt = new Date().toISOString();
  const corpusDir = opts.corpusDir ?? "corpus";
  const fixtureDir = opts.fixturesDir ?? "corpus/fixtures/llm";
  // REPLAY with no wrapped client: a fixture miss CANNOT fall through to the
  // network, so this stays free and offline by construction rather than by
  // convention.
  const client = new RecordReplayClient({ mode: "REPLAY", fixtureDir });
  const methodology = createMonolith(CORPUS_INGEST_ARM.model, {
    think: CORPUS_INGEST_ARM.think,
    verifierModel: CORPUS_INGEST_ARM.verifierModel,
  });

  const skipped: CorpusIngestResult["skipped"] = [];
  const reports = await generateReports(methodology, {
    corpusDir,
    client,
    costRates: resolveEffectiveRates(),
    onSampleError: (sample, err) => {
      if (!(err instanceof FixtureMissError)) return false;
      skipped.push({ sample, reason: `no committed ${CORPUS_INGEST_ARM.methodology} fixture for this sample` });
      return true;
    },
  });

  if (reports.length > 0) {
    opts.record(
      runInputFromReports({
        knobs: {
          methodology: methodology.id,
          model: methodology.model,
          mode: "REPLAY",
          corpusDir,
          fixturesDir: fixtureDir,
        },
        startedAt,
        reports,
      }),
    );
  }

  return { ingested: reports.map((r) => r.sample), skipped };
}
