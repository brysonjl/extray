// Tier 0 — deterministic. No LLM, no source reads. Triages the pack's correlated
// data-flows (layer 4: a cookie/storage/identity source reaching a network or
// navigation sink, joined to the destination's party) into a coarse-tiered list
// of sensitive flows. That list is this node's `data` side-output: it is the
// gate signal for taint-flow-reviewer AND the candidate set that node verifies.
//
// This is the cheapest possible triage — pure pack rollup — so the expensive,
// source-reading deep dive only fires when a sensitive flow actually exists.
// (Future: also seed candidates from scripts[].taint_sketches whose
// classification reaches code-exec; v1 uses the cross-file data_flows join.)

import type { DataFlow, Location } from "../../../pipeline/schema.ts";
import { okResult, type DagNode, type NodeResult, ZERO_USAGE } from "../node.ts";

export type FlowTier = "high" | "medium" | "low";

export interface SensitiveFlow {
  file: string;
  sink_api: string;
  sink_location: Location;
  source_kind: string;
  dest_host: string | null;
  dest_party: DataFlow["dest_party"];
  tier: FlowTier;
}

export interface RiskClassifierData {
  sensitiveFlows: SensitiveFlow[];
}

// data_flows are already "sensitive source → network/navigation sink"; the
// remaining axis is the destination party. Egress to an external/unknown host is
// the high-value case; egress to the publisher's own domain is notable but
// adjudicated as first-party, so it is tiered lower.
function tierOf(party: DataFlow["dest_party"]): FlowTier {
  if (party === "external") return "high";
  if (party === "unknown") return "medium";
  return "low"; // first-party-extension
}

export const riskClassifier: DagNode = {
  id: "risk-classifier",
  version: "1.0",
  kind: "deterministic",
  sourceAccess: "none",
  upstream: [],
  gate: () => true,
  async run(ctx): Promise<NodeResult> {
    const flows = ctx.pack.cross_file.data_flows ?? [];
    const sensitiveFlows: SensitiveFlow[] = flows.map((f) => ({
      file: f.file,
      sink_api: f.sink_api,
      sink_location: f.sink_location,
      source_kind: f.source_kind,
      dest_host: f.dest_host,
      dest_party: f.dest_party,
      tier: tierOf(f.dest_party),
    }));
    const data: RiskClassifierData = { sensitiveFlows };
    return okResult({ usage: ZERO_USAGE, data });
  },
};
