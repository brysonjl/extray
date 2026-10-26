// Tier 2 — gated deep dive (sourceAccess: targeted-reads). For each sensitive
// flow that risk-classifier surfaced, this node forms a candidate
// inferred-behavior claim and adjudicates it against the REAL source via the
// shared claim-verifier (verifyClaim). A confirmed claim becomes a
// verified-behavior in the report; a refuted/needs-dynamic/inconclusive one is
// recorded as an excluded claim by the collector. This is the validation layer,
// distributed into the node that produces the finding — there is no separate
// post-pass. Gated, so the only LLM cost here is paid when a sensitive flow
// actually exists.

import { newSourceCaches, reachabilityContextFromPack, verifyClaim, type VerifierVerdict } from "../../claim-verifier.ts";
import { statedPurposeOf } from "../../../report/assemble.ts";
import { isGrounded, resolveEvidenceRefs, type Finding, type Severity } from "../../findings.ts";
import { addUsage, okResult, type DagNode, type NodeContext, type NodeResult, ZERO_USAGE } from "../node.ts";
import type { RiskClassifierData, SensitiveFlow } from "./risk-classifier.ts";

function upstreamFlows(ctx: NodeContext): SensitiveFlow[] {
  const data = ctx.upstream.get("risk-classifier")?.data as RiskClassifierData | undefined;
  return data?.sensitiveFlows ?? [];
}

// A sensitive flow → a one-line mechanism claim, grounded at the sink the flow
// was correlated on. external egress is high severity; first-party / unknown is
// medium (the verdict engine weighs the destination party separately too).
function candidateFinding(flow: SensitiveFlow, i: number): Finding {
  const dest = flow.dest_host ?? "an unresolved network destination";
  const severity: Severity = flow.dest_party === "external" ? "high" : "medium";
  return {
    id: `taint:${i}`,
    title: `${flow.source_kind} value reaches ${dest}`,
    claim_type: "inferred-behavior",
    severity,
    category: "data-exfiltration",
    // A correlated egress flow; whether it is abuse or a product feature is not
    // statically decidable here, so the nature stays "unknown" until reviewed.
    finding_type: "unknown",
    confidence: "medium",
    claimed_mechanism: `A ${flow.source_kind} value is read and passed to ${flow.sink_api}, sending it to ${dest} (${flow.dest_party}).`,
    evidence_refs: [{ file: flow.file, location: flow.sink_location, symbol: null, sink_or_string: flow.sink_api }],
    detail:
      `Layer-4 data-flow analysis correlated a ${flow.source_kind} source with the ${flow.sink_api} sink at ` +
      `${flow.file}:${flow.sink_location.line}, reaching ${dest} (party: ${flow.dest_party}).`,
  };
}

export const taintFlowReviewer: DagNode = {
  id: "taint-flow-reviewer",
  version: "1.0",
  kind: "llm",
  sourceAccess: "targeted-reads",
  upstream: ["risk-classifier"],
  gate: (ctx) => upstreamFlows(ctx).length > 0,
  async run(ctx): Promise<NodeResult> {
    const flows = upstreamFlows(ctx);
    const caches = newSourceCaches();
    const searchFiles = ctx.pack.files.map((f) => f.path);
    const reachability = reachabilityContextFromPack(ctx.pack, statedPurposeOf(ctx.pack, ctx.listing));
    const findings: Finding[] = [];
    const verdicts: VerifierVerdict[] = [];
    let usage = ZERO_USAGE;

    for (let i = 0; i < flows.length; i++) {
      const finding = candidateFinding(flows[i]!, i);
      findings.push(finding);
      const res = resolveEvidenceRefs(finding, ctx.sampleDir);
      // Ungrounded (cited file absent on disk) → no verdict; the collector
      // records it as an excluded claim (unresolvable-evidence), never asserted.
      if (!isGrounded(res)) continue;
      const { verdict, usage: u } = await verifyClaim(
        finding,
        res.resolved,
        {
          sampleDir: ctx.sampleDir,
          client: ctx.client,
          model: ctx.verifierModel,
          dataFlows: ctx.pack.cross_file.data_flows,
          searchFiles,
          reachability,
        },
        caches,
      );
      verdicts.push(verdict);
      usage = addUsage(usage, u);
    }

    return okResult({ findings, verdicts, usage });
  },
};
