// Tier 2 — gated deep dive (sourceAccess: targeted-reads). When an extension is
// broadly reachable by web pages (externally_connectable with wildcards / broad
// matches) AND exposes an onMessageExternal handler, an unvalidated handler can
// leak data (e.g. return all cookies) to any caller. This node forms one
// candidate inferred-behavior claim and adjudicates it against the REAL source
// via the shared claim-verifier (verifyClaim) — structurally identical to
// taint-flow-reviewer: build a deterministic candidate Finding from a pack
// signal, resolve evidence refs, verify against source, push the verdict. Gated,
// so the only LLM cost here is paid when a web-exposed message surface exists.

import { newSourceCaches, reachabilityContextFromPack, verifyClaim, type VerifierVerdict } from "../../claim-verifier.ts";
import { statedPurposeOf } from "../../../report/assemble.ts";
import { isGrounded, resolveEvidenceRefs, type EvidenceRef, type Finding } from "../../findings.ts";
import { addUsage, okResult, type DagNode, type NodeContext, type NodeResult, ZERO_USAGE } from "../node.ts";

const EXTERNAL_LISTENER = /onmessageexternal|messageexternal/i;

/** The first external-message listener across all scripts, with its file path. */
function findExternalListener(ctx: NodeContext): { file: string; line: number } | null {
  for (const script of ctx.pack.scripts) {
    for (const listener of script.listeners) {
      if (EXTERNAL_LISTENER.test(listener.kind)) {
        return { file: script.path, line: listener.location.line };
      }
    }
  }
  return null;
}

/** True iff externally_connectable broadly reachable, OR an external handler exists. */
function isWebExposed(ctx: NodeContext): boolean {
  const ec = ctx.pack.manifest_analysis.externally_connectable;
  const broad = !!ec && (ec.wildcards === true || (Array.isArray(ec.matches) && ec.matches.length > 0));
  return broad || findExternalListener(ctx) !== null;
}

export const externallyConnectableReviewer: DagNode = {
  id: "externally-connectable-reviewer",
  version: "1.0",
  kind: "llm",
  sourceAccess: "targeted-reads",
  upstream: [],
  gate: (ctx) => isWebExposed(ctx),
  async run(ctx): Promise<NodeResult> {
    const ec = ctx.pack.manifest_analysis.externally_connectable;
    const listener = findExternalListener(ctx);

    const matchesStr = ec?.wildcards
      ? (ec.matches && ec.matches.length > 0 ? ec.matches.join(", ") : "<all-urls>")
      : ec?.matches && ec.matches.length > 0
        ? ec.matches.join(", ")
        : "<unspecified>";

    const file = listener ? listener.file : "manifest.json";
    const location = listener ? { line: listener.line } : null;
    const handlerLoc = listener ? `${listener.file}:${listener.line}` : "manifest.json";

    const ref: EvidenceRef = {
      file,
      location,
      symbol: null,
      sink_or_string: "chrome.runtime.onMessageExternal",
    };

    const finding: Finding = {
      id: "extconn:0",
      title: "Web-exposed message handler may leak data to any site",
      claim_type: "inferred-behavior",
      severity: "high",
      category: "messaging-surface",
      // A web-exposed handler any page can reach is an exploitable surface —
      // the extension is the vector regardless of author intent.
      finding_type: "vulnerability",
      confidence: "medium",
      claimed_mechanism:
        `externally_connectable matches ${matchesStr} so any web page can message the extension; ` +
        `the onMessageExternal handler returns sensitive data (cookies) to the caller without validating the sender.`,
      evidence_refs: [ref],
      detail:
        `externally_connectable matches ${matchesStr}, exposing the extension to web pages, ` +
        `and an onMessageExternal handler is registered at ${handlerLoc}.`,
    };

    const caches = newSourceCaches();
    const searchFiles = ctx.pack.files.map((f) => f.path);
    const reachability = reachabilityContextFromPack(ctx.pack, statedPurposeOf(ctx.pack, ctx.listing));
    const findings: Finding[] = [];
    const verdicts: VerifierVerdict[] = [];
    let usage = ZERO_USAGE;

    for (const candidate of [finding]) {
      findings.push(candidate);
      const res = resolveEvidenceRefs(candidate, ctx.sampleDir);
      // Ungrounded (cited file absent on disk) → no verdict; the collector
      // records it as an excluded claim (unresolvable-evidence), never asserted.
      if (!isGrounded(res)) continue;
      const { verdict, usage: u } = await verifyClaim(
        candidate,
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
