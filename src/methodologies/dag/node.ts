// The DAG node contract (docs/dag-methodology.md). A node is a pure-ish function
// of its declared inputs — the evidence pack subset it reads, the outputs of its
// upstream nodes, and (for deep-dive nodes only) targeted source reads from the
// unpacked dir. Same inputs ⇒ same output, so a node is independently cacheable.
//
// Nodes emit exactly what the collector feeds to classifyFindings: `Finding`s
// (claim_type-tagged) and, for source-grounded nodes, `VerifierVerdict`s keyed
// by finding id. A node may mint a finding that becomes a `verified-behavior`
// ONLY by emitting an inferred-behavior Finding together with a `confirmed`
// VerifierVerdict — i.e. only nodes that actually read source can confirm a
// mechanism. Pack-only nodes top out at observed-capability. `dismissals` record
// "checked, not present" so a clean area is never a silent omission.
//
// `data` is a node's structured side-output for DOWNSTREAM nodes/gates to read
// (e.g. risk-classifier's sensitive-flow list gates and seeds taint-flow-reviewer).
// It never reaches the report; only findings/verdicts/dismissals do.

import type { LlmClient, Usage } from "../../llm/client.ts";
import type { EvidencePack } from "../../pipeline/schema.ts";
import type { HostEnrichment } from "../../enrichment/types.ts";
import type { ListingInput } from "../../report/build.ts";
import type { VerifierVerdict } from "../claim-verifier.ts";
import type { Finding } from "../findings.ts";

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

export interface Dismissal {
  /** The concern that was checked (e.g. "unjustified host access"). */
  concern: string;
  /** The checks actually run, so a dismissal is never a clean-bill-of-health. */
  checks_run: string[];
  note: string;
}

export type NodeStatus = "ok" | "skipped" | "error";

export interface NodeResult {
  findings: Finding[];
  /** Source-grounded verdicts, keyed by finding id via `claim_id`. Grounded nodes only. */
  verdicts: VerifierVerdict[];
  dismissals: Dismissal[];
  status: NodeStatus;
  /** Why the node was skipped (gate not met) or errored. */
  reason?: string;
  usage: Usage;
  /** Node-specific structured output consumed by downstream nodes/gates only. */
  data?: unknown;
}

export type NodeOutputs = Map<string, NodeResult>;

export interface NodeContext {
  pack: EvidencePack;
  /** Unpacked extension dir — fs reads ONLY. Never enters a prompt (label-leak guard). */
  sampleDir: string;
  /** Outputs of already-executed nodes (always includes this node's declared upstream). */
  upstream: NodeOutputs;
  /** Store-listing artifact when one exists beside the sample; feeds stated-purpose. */
  listing: ListingInput | null;
  /** Host-enrichment artifact (015) when one exists beside the sample; feeds the
   *  destination-reviewer's per-host RDAP context and the report's destination rows. */
  enrichment: HostEnrichment | null;
  client: LlmClient;
  model: string;
  /** Model for verifyClaim/challenger calls. Defaults to `model` (self-verify)
   *  at the factory; override for an independent, leniency-free check. */
  verifierModel: string;
}

export type NodeKind = "deterministic" | "llm";
export type SourceAccess = "none" | "snippets-only" | "targeted-reads";

export interface DagNode {
  id: string;
  /** Part of the (future) cache key; bump when the node's logic changes. */
  version: string;
  kind: NodeKind;
  /** A node may only mint verified-behavior when this is "targeted-reads". */
  sourceAccess: SourceAccess;
  /** Node ids whose output this node depends on (drives topological order). */
  upstream: string[];
  /** Does this node run at all for this pack? Evaluated with upstream available. */
  gate(ctx: NodeContext): boolean;
  run(ctx: NodeContext): Promise<NodeResult>;
}

// ---- Result constructors ----

export function okResult(partial: Partial<NodeResult> & { usage: Usage }): NodeResult {
  return {
    findings: partial.findings ?? [],
    verdicts: partial.verdicts ?? [],
    dismissals: partial.dismissals ?? [],
    status: "ok",
    usage: partial.usage,
    data: partial.data,
  };
}

export function skippedResult(reason: string): NodeResult {
  return { findings: [], verdicts: [], dismissals: [], status: "skipped", reason, usage: ZERO_USAGE };
}

export function errorResult(reason: string): NodeResult {
  return { findings: [], verdicts: [], dismissals: [], status: "error", reason, usage: ZERO_USAGE };
}
