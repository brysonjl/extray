// The agentic methodology arm (id: "agentic"). A third front-end behind the
// Methodology seam, additive to the monolith and the DAG. A goal-driven agent
// reads the unpacked source tree directly through a sandboxed tool loop
// (loop.ts), grounding behavioral claims via the SHARED claim-verifier, then
// converges on the SAME deterministic backend the DAG collector uses
// (collectAndAssemble): classifyFindings → computeVerdict → synthesize →
// assembleRiskReport → renderReportMarkdown. The agent never sets the tier.
// See docs/agentic-methodology.md.

import type { LlmClient } from "../../llm/client.ts";
import { statedPurposeOf } from "../../report/assemble.ts";
import { buildDestinations, buildObfuscation, buildPermissions } from "../../report/build.ts";
import { renderReportMarkdown } from "../../report/render-md.ts";
import { collectAndAssemble, type DagTrace } from "../dag/collect.ts";
import { okResult, type DagNode, type Dismissal, type NodeOutputs } from "../dag/node.ts";
import type { VerifierVerdict } from "../claim-verifier.ts";
import type { Finding } from "../findings.ts";
import type { Methodology, MethodologyOutput, MethodologySample } from "../types.ts";
import { runAgentLoop, type DimensionOutcome, type ToolCall } from "./loop.ts";

// Per-dimension tool-call budget. Each of the 5 dimensions runs its own short,
// bounded-transcript loop concurrently, so this caps the depth of one dimension,
// not the whole run. Kept small because a focused dimension closes quickly.
const DEFAULT_MAX_STEPS_PER_DIMENSION = 8;

export interface AgenticOptions {
  /** Per-dimension tool-call budget (each of the 5 dimensions gets its own). */
  maxStepsPerDimension?: number;
  /** Model for the claim-verifier (defaults to the arm's own model). */
  verifierModel?: string;
}

/** The arm's structured trace — the auditable answer to "why did the agent look at X". */
export interface AgenticTrace {
  dimensions: DimensionOutcome[];
  toolCalls: ToolCall[];
  steps: number;
  budgetExhausted: boolean;
  findings: Finding[];
  verdicts: VerifierVerdict[];
  dismissals: Dismissal[];
  /** The deterministic backend tail (verdict, synthesis, rendered report). */
  dag: DagTrace;
}

/** A compact, identity-stripped orientation map the agent starts from. It is
 *  extension-derived, so the loop wraps it in the untrusted envelope. */
function buildOrientation(sample: MethodologySample): string {
  const pack = sample.pack!;
  const listing = sample.listing ?? null;
  const stated = statedPurposeOf(pack, listing);
  const perms = buildPermissions(pack);
  const dests = buildDestinations(pack);
  const obf = buildObfuscation(pack);
  return JSON.stringify(
    {
      stated_purpose: stated ? stated.text.slice(0, 1500) : null,
      permissions: { api: perms.api.map((p) => p.permission), hosts: perms.hosts },
      destinations: dests.rows.map((r) => ({ host: r.host, party: r.party, any_dynamic: r.any_dynamic })),
      obfuscation_flagged: obf.flagged.map((f) => f.path),
      files: pack.files.map((f) => f.path),
    },
    null,
    1,
  );
}

// Synthetic node so the agent's accumulated output can flow through the DAG
// collector unchanged. Its id is the single key in the outputs map below.
const AGENT_NODE: DagNode = {
  id: "agentic-investigation",
  version: "1.0",
  kind: "llm",
  sourceAccess: "targeted-reads",
  upstream: [],
  gate: () => true,
  run: () => {
    throw new Error("AGENT_NODE is a collector placeholder and is never run by a scheduler");
  },
};

export function createAgentic(model: string, opts: AgenticOptions = {}): Methodology {
  const maxStepsPerDimension = opts.maxStepsPerDimension ?? DEFAULT_MAX_STEPS_PER_DIMENSION;
  const verifierModel = opts.verifierModel ?? model;
  return {
    id: "agentic",
    model,
    async run(sample: MethodologySample, client: LlmClient): Promise<MethodologyOutput> {
      if (!sample.pack) {
        throw new Error("agentic methodology requires sample.pack (used as the agent's starting map)");
      }

      const state = await runAgentLoop({
        pack: sample.pack,
        sampleDir: sample.sampleDir,
        listing: sample.listing ?? null,
        orientation: buildOrientation(sample),
        client,
        model,
        verifierModel,
        maxStepsPerDimension,
        onProgress: sample.onProgress,
      });

      // Pack the investigation into one synthetic node result and run the EXACT
      // DAG backend tail — the deterministic verdict engine owns the tier.
      const outputs: NodeOutputs = new Map([
        [
          AGENT_NODE.id,
          okResult({
            findings: state.findings,
            verdicts: state.verdicts,
            dismissals: state.dismissals,
            usage: state.usage,
          }),
        ],
      ]);
      const assembled = await collectAndAssemble([AGENT_NODE], outputs, sample, model, client);

      // The shared DAG collector tags its RiskReport "dag"; relabel to this arm
      // and re-render (deterministic, no LLM) so the report names its own
      // methodology honestly. Everything else — tier, classification, synthesis
      // — is reused verbatim from collectAndAssemble.
      const dagTrace = assembled.structured as DagTrace;
      const riskReport = { ...dagTrace.risk_report, methodology: "agentic" };

      const trace: AgenticTrace = {
        dimensions: state.dimensions,
        toolCalls: state.toolCalls,
        steps: state.steps,
        budgetExhausted: state.budgetExhausted,
        findings: state.findings,
        verdicts: state.verdicts,
        dismissals: state.dismissals,
        dag: { ...dagTrace, risk_report: riskReport },
      };

      return { report: renderReportMarkdown(riskReport), tier: assembled.tier, usage: assembled.usage, structured: trace };
    },
  };
}
