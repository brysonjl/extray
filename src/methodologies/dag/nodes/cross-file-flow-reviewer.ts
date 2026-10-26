// Tier 2 — gated deep dive (sourceAccess: targeted-reads). The static layer can
// capture a storage→network DataFlow (the exfil half) without seeing the cookie→
// storage staging write that feeds it, because the staging write goes through an
// imported wrapper and is never recorded as a sink. So a real cross-file
// cookie-exfiltration flow shows up only as a `storage` source reaching an
// external host, with the cookie read sitting in a DIFFERENT file. This node
// pairs each staged storage flow with the extension's cookie-source sites, mints
// one inferred-behavior claim per flow, and lets the shared claim-verifier
// adjudicate it against the WHOLE files (the corpus files are tiny, so each ref
// yields its entire file to the verifier — enough to match the shared storage
// key across files). Grounding the finding at the COOKIE side keeps its source
// site distinct from taint-flow-reviewer's storage-side finding, so the two do
// not collide in the verdict-aware dedup.

import { newSourceCaches, reachabilityContextFromPack, verifyClaim, type VerifierVerdict } from "../../claim-verifier.ts";
import { statedPurposeOf } from "../../../report/assemble.ts";
import { isGrounded, resolveEvidenceRefs, type EvidenceRef, type Finding } from "../../findings.ts";
import { addUsage, okResult, type DagNode, type NodeContext, type NodeResult, ZERO_USAGE } from "../node.ts";
import type { DataFlow } from "../../../pipeline/schema.ts";

const COOKIE_SOURCE = /cookies\.(get|getAll)|document\.cookie/;

interface CookieSource {
  file: string;
  line: number;
  api: string;
}

// First cookie-source sink per script, deduped by path — the staging read sites
// that could feed a storage key the exfil half later reads.
function cookieSources(ctx: NodeContext): CookieSource[] {
  const out: CookieSource[] = [];
  const seen = new Set<string>();
  for (const script of ctx.pack.scripts) {
    if (seen.has(script.path)) continue;
    const sink = script.sinks.find((s) => COOKIE_SOURCE.test(s.api));
    if (!sink) continue;
    seen.add(script.path);
    out.push({ file: script.path, line: sink.location.line, api: sink.api });
  }
  return out;
}

// A staged storage flow = storage source reaching a non-first-party host. A
// first-party-extension destination is the adjudicated-benign case and is not a
// cross-file exfil candidate.
function stagedStorageFlows(ctx: NodeContext): DataFlow[] {
  return (ctx.pack.cross_file.data_flows ?? []).filter(
    (f) => f.source_kind === "storage" && f.dest_party !== "first-party-extension",
  );
}

function candidateFinding(flow: DataFlow, i: number, sources: CookieSource[]): Finding {
  const dest = flow.dest_host ?? "an external host";
  const primary = sources[0]!;
  // ref[0] PRIMARY grounds the finding at the cookie side (distinct source site
  // from the storage-side taint finding). Then the storage→network sink, then up
  // to 2 more cookie sources from OTHER files so the verifier sees the staging
  // file even when there are several cookie reads. Cap at 4 (verifyClaim only
  // pulls 4 windows).
  const refs: EvidenceRef[] = [
    { file: primary.file, location: { line: primary.line }, symbol: null, sink_or_string: primary.api },
    { file: flow.file, location: flow.sink_location, symbol: null, sink_or_string: flow.sink_api },
  ];
  for (const src of sources.slice(1)) {
    if (refs.length >= 4) break;
    refs.push({ file: src.file, location: { line: src.line }, symbol: null, sink_or_string: src.api });
  }
  const sourceFiles = sources.map((s) => s.file).join(", ");
  return {
    id: `xfile:${i}`,
    title: `Cross-file cookie exfiltration via storage staging → ${dest}`,
    claim_type: "inferred-behavior",
    severity: "high",
    category: "data-exfiltration",
    finding_type: "unknown",
    confidence: "medium",
    claimed_mechanism:
      `Cookies read in another file are staged into chrome.storage, then read and sent to ${dest} ` +
      `via ${flow.sink_api} from ${flow.file}, so the cookie-to-network flow spans files.`,
    evidence_refs: refs,
    detail:
      `Cookie-source file(s) ${sourceFiles} read cookies; a storage→network sink at ` +
      `${flow.file}:${flow.sink_location.line} then sends a staged storage value to ${dest}.`,
  };
}

export const crossFileFlowReviewer: DagNode = {
  id: "cross-file-flow-reviewer",
  version: "1.0",
  kind: "llm",
  sourceAccess: "targeted-reads",
  upstream: [],
  // A staged storage→external flow AND a cookie source — without a cookie read
  // there is nothing that could have been staged.
  gate: (ctx) => stagedStorageFlows(ctx).length > 0 && cookieSources(ctx).length > 0,
  async run(ctx): Promise<NodeResult> {
    const flows = stagedStorageFlows(ctx);
    const sources = cookieSources(ctx);
    const caches = newSourceCaches();
    const searchFiles = ctx.pack.files.map((f) => f.path);
    const reachability = reachabilityContextFromPack(ctx.pack, statedPurposeOf(ctx.pack, ctx.listing));
    const findings: Finding[] = [];
    const verdicts: VerifierVerdict[] = [];
    let usage = ZERO_USAGE;

    for (let i = 0; i < flows.length; i++) {
      const finding = candidateFinding(flows[i]!, i, sources);
      findings.push(finding);
      const res = resolveEvidenceRefs(finding, ctx.sampleDir);
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
