// Tier 2 — gated deep dive (sourceAccess: targeted-reads). A vendored library
// (lib/) is third-party code that should never originate network calls on its
// own; a network sink inside one is the classic supply-chain tamper signal (a
// CDN-fingerprinting / telemetry call injected into a copy of jQuery). For each
// lib/ script carrying such a sink this node forms a candidate inferred-behavior
// claim and adjudicates it against the REAL source via the shared claim-verifier
// (verifyClaim). A confirmed claim becomes a verified-behavior in the report; a
// refuted/needs-dynamic/inconclusive one is recorded as an excluded claim by the
// collector. Gated, so the only LLM cost here is paid when a tampered library
// actually exists. A legit vendored lib that merely reads document.cookie with
// NO network sink does not fire.

import { newSourceCaches, reachabilityContextFromPack, verifyClaim, type VerifierVerdict } from "../../claim-verifier.ts";
import { statedPurposeOf } from "../../../report/assemble.ts";
import { isGrounded, resolveEvidenceRefs, type Finding } from "../../findings.ts";
import { addUsage, okResult, type DagNode, type NodeContext, type NodeResult, ZERO_USAGE } from "../node.ts";
import { destinationHostOf } from "../../../pipeline/layer4-crossfile.ts";
import { looksLikeHost } from "../../../report/build.ts";
import type { ScriptEntry, Sink } from "../../../pipeline/schema.ts";

// A vendored library making a network call is the tamper signal.
const NETWORK_SINK = /^(fetch|XMLHttpRequest|sendBeacon)$|\bfetch\b|XMLHttpRequest|sendBeacon/;

function isLibScript(s: ScriptEntry): boolean {
  return s.path.startsWith("lib/");
}

function networkSinks(s: ScriptEntry): Sink[] {
  return s.sinks.filter((k) => NETWORK_SINK.test(k.api));
}

// The first destination that resolves to a real external host, with the line it
// sits on. Uses the pipeline's URL parser (destinationHostOf) + host sanity check
// rather than a loose dotted-substring regex — the latter wrongly treated jQuery
// internals like `t.url` (a property access, kind "unknown") as a host, so the
// claim named `t.url` instead of the injected `cdn-jq-telemetry.com` and a
// rigorous verifier refuted the mis-stated mechanism. destinationHostOf requires
// a real `scheme://`/`//` prefix, so `t.url` yields null and is skipped.
function resolvedDest(s: ScriptEntry): { host: string; line: number } | null {
  for (const d of s.network_destinations) {
    const host = destinationHostOf(d.value);
    if (host && looksLikeHost(host)) return { host, line: d.location.line };
  }
  return null;
}

function candidateFinding(script: ScriptEntry, sink: Sink, host: string | null, i: number): Finding {
  const dest = host ?? "an external host";
  return {
    id: `tamper:${i}`,
    title: `Tampered vendored library: ${script.path}`,
    claim_type: "inferred-behavior",
    severity: "high",
    category: "supply-chain",
    finding_type: "unknown",
    confidence: "medium",
    claimed_mechanism:
      `The vendored library ${script.path} contains an injected network call (${sink.api}) that exfiltrates data to ` +
      `${dest} — unexpected for a third-party library.`,
    evidence_refs: [{ file: script.path, location: sink.location, symbol: null, sink_or_string: sink.api }],
    detail:
      `The vendored library ${script.path} contains a ${sink.api} network sink at ${script.path}:${sink.location.line}` +
      `${host ? `, reaching ${host}` : ""}. Third-party libraries should not originate network calls — a likely tamper/supply-chain injection.`,
  };
}

export const libraryTamperDeepDive: DagNode = {
  id: "library-tamper-deep-dive",
  version: "1.0",
  kind: "llm",
  sourceAccess: "targeted-reads",
  upstream: [],
  gate: (ctx) => ctx.pack.scripts.some((s) => isLibScript(s) && networkSinks(s).length > 0),
  async run(ctx): Promise<NodeResult> {
    const targets = ctx.pack.scripts.filter((s) => isLibScript(s) && networkSinks(s).length > 0);
    const caches = newSourceCaches();
    const searchFiles = ctx.pack.files.map((f) => f.path);
    const reachability = reachabilityContextFromPack(ctx.pack, statedPurposeOf(ctx.pack, ctx.listing));
    const findings: Finding[] = [];
    const verdicts: VerifierVerdict[] = [];
    let usage = ZERO_USAGE;

    for (let i = 0; i < targets.length; i++) {
      const script = targets[i]!;
      const sinks = networkSinks(script);
      const dest = resolvedDest(script);
      // Cite the network sink ON the resolved-host's line so the claimed sink and
      // the named host align (the verifier checks "this sink reaches that host");
      // fall back to the first network sink when no host resolved.
      const sink = (dest && sinks.find((k) => k.location.line === dest.line)) ?? sinks[0]!;
      const finding = candidateFinding(script, sink, dest?.host ?? null, i);
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
