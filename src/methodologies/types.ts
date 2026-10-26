// The Methodology seam. #4 ships one real arm (the monolith); idea #2 will add
// the agentic raw-source arm and the multi-node DAG behind this same interface.
// The input is a sample *context*, NOT a bare EvidencePack: the agentic arm
// reads the unpacked tree directly and consumes no pack, so `run(pack)` could
// not represent it. The monolith uses `sample.pack` (and, since improvement
// 013, `sample.sampleDir` for the claim-verifier's targeted source reads).
// A methodology returns its report as free-form text — the judge and
// tier-normalizer do all scoring on that text, applied identically to every
// arm; `structured` is an optional, arm-specific trace for artifacts/tests.

import type { LlmClient, Usage } from "../llm/client.ts";
import type { EvidencePack } from "../pipeline/schema.ts";
import type { HostEnrichment } from "../enrichment/types.ts";
import type { ListingInput } from "../report/build.ts";
import type { Tier } from "../report/contract.ts";

export type MethodologyProgress = (stage: string, phase: "started" | "finished" | "skipped" | "failed", message: string) => Promise<void>;

export interface MethodologySample {
  onProgress?: MethodologyProgress;
  /** Path to the unpacked extension dir (what analyze() consumes). */
  sampleDir: string;
  /** Present for pack-consuming arms (monolith, DAG); absent for the agentic arm. */
  pack?: EvidencePack;
  /** Store-listing artifact (008b) when one exists beside the extension dir;
   *  feeds the developer section and the stated-purpose comparison. */
  listing?: ListingInput | null;
  /** Host-enrichment artifact (015) when one exists beside the extension dir;
   *  folded into the serialized pack the arms read and the destination rows. */
  enrichment?: HostEnrichment | null;
}

/** A token-usage row for a step whose tokens bypass the injected LlmClient (e.g.
 *  the Pi arm runs its own model session), so the CLI's UsageTracker never sees
 *  them. An arm surfaces these so the CLI can merge them into per-step accounting,
 *  keeping the usage rows reconciled with the report aggregate. */
export interface ExtraUsageLine {
  label: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface MethodologyOutput {
  report: string;
  usage: Usage;
  /** Per-step usage for passes that bypass the injected client (the Pi generation
   *  passes). Empty/absent for arms whose every call goes through the client. */
  usageByStep?: ExtraUsageLine[];
  /** The arm's NATIVE risk tier, when it produces one (the monolith's
   *  deterministic verdict). The scorecard grades this directly and skips the
   *  neutral normalizer; arms that emit only free-form prose omit it and fall
   *  back to normalization. */
  tier?: Tier;
  /** Optional arm-specific structured trace (e.g. the monolith's generated
   *  findings + verifier verdicts). Must be JSON-serializable. */
  structured?: unknown;
}

export interface Methodology {
  id: string;
  /** Model id used for this arm's LLM calls (drives fixture keys). */
  model: string;
  run(sample: MethodologySample, client: LlmClient): Promise<MethodologyOutput>;
}
