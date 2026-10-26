// The DAG methodology arm (id: "dag"). A third front-end behind the Methodology
// seam, additive to the monolith: it produces the same finding set via a gated
// node graph and converges on the same backend (see collect.ts). The monolith
// and its claim-verifier are untouched. See docs/dag-methodology.md.
//
// Beyond the original vertical slice, three gated source-reading deep dives now
// cover the corpus shapes the slice missed: library-tamper (B), obfuscated
// exfiltration (C), and web-exposed message handlers (D). Each is structurally a
// clone of taint-flow-reviewer (deterministic candidate → verifyClaim →
// verified-behavior) gated on a distinct pack signal. Remaining documented nodes
// are added by extending NODES (docs/dag-methodology.md).

import type { LlmClient } from "../../llm/client.ts";
import { collectAndAssemble } from "./collect.ts";
import type { DagNode } from "./node.ts";
import { crossFileFlowReviewer } from "./nodes/cross-file-flow-reviewer.ts";
import { destinationReviewer } from "./nodes/destination-reviewer.ts";
import { externallyConnectableReviewer } from "./nodes/externally-connectable-reviewer.ts";
import { makeFindingChallenger } from "./nodes/finding-challenger.ts";
import { libraryTamperDeepDive } from "./nodes/library-tamper-deep-dive.ts";
import { obfuscationExfilReviewer } from "./nodes/obfuscation-exfil-reviewer.ts";
import { permissionJustification } from "./nodes/permission-justification.ts";
import { remoteScriptReviewer } from "./nodes/remote-script-reviewer.ts";
import { riskClassifier } from "./nodes/risk-classifier.ts";
import { taintFlowReviewer } from "./nodes/taint-flow-reviewer.ts";
import { runDag } from "./scheduler.ts";
import type { Methodology, MethodologyOutput, MethodologySample } from "../types.ts";

/** Finding-producing nodes. The finding-challenger depends on all of them, so it
 *  runs last and re-examines every confirmed finding. */
const PRODUCERS: DagNode[] = [
  riskClassifier,
  permissionJustification,
  destinationReviewer,
  taintFlowReviewer,
  libraryTamperDeepDive,
  obfuscationExfilReviewer,
  externallyConnectableReviewer,
  crossFileFlowReviewer,
  remoteScriptReviewer,
];

/** The full node registry. Order is irrelevant — the scheduler topologically
 *  sorts; the challenger's upstream = every producer pins it last. */
export const NODES: DagNode[] = [...PRODUCERS, makeFindingChallenger(PRODUCERS.map((n) => n.id))];

export interface DagOptions {
  /** Model for the nodes' verifyClaim/challenger calls. Defaults to the arm's
   *  own model (self-verify) — override for an independent check, same knob as
   *  the other arms' `verifierModel`. */
  verifierModel?: string;
}

export function createDag(model: string, opts: DagOptions = {}): Methodology {
  const verifierModel = opts.verifierModel ?? model;
  return {
    id: "dag",
    model,
    async run(sample: MethodologySample, client: LlmClient): Promise<MethodologyOutput> {
      if (!sample.pack) {
        throw new Error("dag methodology requires sample.pack (it consumes the evidence pack)");
      }
      const outputs = await runDag(NODES, {
        pack: sample.pack,
        sampleDir: sample.sampleDir,
        listing: sample.listing ?? null,
        enrichment: sample.enrichment ?? null,
        client,
        model,
        verifierModel,
        onProgress: sample.onProgress,
      });
      return collectAndAssemble(NODES, outputs, sample, model, client);
    },
  };
}
