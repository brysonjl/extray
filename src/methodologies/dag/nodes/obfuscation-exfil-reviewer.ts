// Tier 2 — gated deep dive (sourceAccess: targeted-reads). A FIRST-PARTY file
// that is obfuscated AND also performs a network call / touches sensitive data
// is the signal that an obfuscated routine assembles a hidden destination at
// runtime and exfiltrates data (the mutant-c document.cookie → fetch(atob(...))
// shape). We do NOT attempt full string-array decoding here — verifyClaim
// reading the REAL obfuscated source is enough to confirm the cookie→fetch
// behavior even when the destination host is assembled dynamically. Vendored
// libraries under lib/ are excluded (their tamper/known-lib concerns are the
// supply-chain node's job, not first-party exfil). Gated, so the LLM cost is
// only paid when a first-party obfuscated egress file actually exists.

import { newSourceCaches, reachabilityContextFromPack, verifyClaim, type VerifierVerdict } from "../../claim-verifier.ts";
import { statedPurposeOf } from "../../../report/assemble.ts";
import { isGrounded, resolveEvidenceRefs, type Finding } from "../../findings.ts";
import { addUsage, okResult, type DagNode, type NodeContext, type NodeResult, ZERO_USAGE } from "../node.ts";
import type { ScriptEntry, Sink } from "../../../pipeline/schema.ts";

const NETWORK_SINK = /fetch|XMLHttpRequest|sendBeacon/;

/** First-party (not under lib/) obfuscated script with a network/cookie egress surface. */
function isFirstParty(script: ScriptEntry): boolean {
  return !script.path.startsWith("lib/");
}

function networkSink(script: ScriptEntry): Sink | undefined {
  return script.sinks.find((s) => NETWORK_SINK.test(s.api));
}

function cookieSink(script: ScriptEntry): Sink | undefined {
  return script.sinks.find((s) => s.api.includes("cookie"));
}

/** Gate predicate: obfuscation flagged, first-party, AND a network/cookie egress surface. */
function isObfuscatedExfilCandidate(script: ScriptEntry): boolean {
  if (script.obfuscation?.flagged !== true) return false;
  if (!isFirstParty(script)) return false;
  return (
    networkSink(script) !== undefined ||
    script.network_destinations.length > 0 ||
    cookieSink(script) !== undefined
  );
}

function candidates(ctx: NodeContext): ScriptEntry[] {
  return ctx.pack.scripts.filter(isObfuscatedExfilCandidate);
}

// One candidate Finding per obfuscated first-party egress file. The egress sink
// (network preferred, else the cookie read) anchors the evidence ref so the
// verifier reads the actual obfuscated routine around it.
function candidateFinding(script: ScriptEntry, i: number): Finding {
  const net = networkSink(script);
  const cookie = cookieSink(script);
  const sink = net ?? cookie;
  const sinkApi = sink?.api ?? "a network call";
  const location = sink?.location ?? null;
  const decoderNote = script.obfuscation?.string_array_decoder_detected
    ? " (a string-array decoder was detected)"
    : "";
  const sinkLine = location ? `${script.path}:${location.line}` : script.path;
  return {
    id: `obf:${i}`,
    title: `Obfuscated exfiltration routine: ${script.path}`,
    claim_type: "inferred-behavior",
    severity: "high",
    category: "data-exfiltration",
    finding_type: "unknown",
    confidence: "medium",
    claimed_mechanism: `The obfuscated file ${script.path} assembles a destination at runtime and sends sensitive data (document.cookie) to it via ${sinkApi}.`,
    evidence_refs: [{ file: script.path, location, symbol: null, sink_or_string: sink?.api ?? null }],
    detail:
      `${script.path} is flagged as obfuscated${decoderNote} and reaches the ${sinkApi} sink at ` +
      `${sinkLine} — an obfuscated first-party routine with a network/cookie egress surface.`,
  };
}

export const obfuscationExfilReviewer: DagNode = {
  id: "obfuscation-exfil-reviewer",
  version: "1.0",
  kind: "llm",
  sourceAccess: "targeted-reads",
  upstream: [],
  gate: (ctx) => candidates(ctx).length > 0,
  async run(ctx): Promise<NodeResult> {
    const scripts = candidates(ctx);
    const caches = newSourceCaches();
    const searchFiles = ctx.pack.files.map((f) => f.path);
    const reachability = reachabilityContextFromPack(ctx.pack, statedPurposeOf(ctx.pack, ctx.listing));
    const findings: Finding[] = [];
    const verdicts: VerifierVerdict[] = [];
    let usage = ZERO_USAGE;

    for (let i = 0; i < scripts.length; i++) {
      const finding = candidateFinding(scripts[i]!, i);
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
