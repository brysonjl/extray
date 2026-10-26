// Tier 1 — narrow LLM, snippets-only (observed-capability only). Classifies each
// external destination the extension reaches against its stated purpose:
// expected-for-purpose / infrastructure (CDN, analytics, error reporting) /
// suspicious / unknown. Only a host the model AFFIRMATIVELY flags as suspicious
// with a resolved call site becomes a finding; other explicit classifications,
// including "unknown", are dismissals. Missing classifications
// are incomplete analysis, never evidence that a destination was checked.
// "unknown" used to become a finding too, which was the dominant false-positive
// source: it flagged CDNs, first-party sites, XML namespace URIs, even code
// identifiers (every host the model couldn't place defaulted to unknown). This
// node only sees a bare destination, never a proven data flow — confirmed
// source→host exfiltration is taint-flow-reviewer's job (a verified, flow-based
// finding), so dropping "unknown" here costs no recall.
// One batched call over all hosts (same cost rationale as permission-justification).
//
// Grounding: buildDestinations already joins each host to its example call sites
// (file + line) from the per-script destination lists, so a finding cites a real
// source location. A suspicious host with no resolved site is dismissed with a
// note rather than asserted ungrounded.

import { buildPrompt, type UntrustedBlock } from "../../../llm/envelope.ts";
import { stableStringify } from "../../../llm/record-replay.ts";
import { buildDestinations } from "../../../report/build.ts";
import { statedPurposeOf } from "../../../report/assemble.ts";
import type { DestinationRow } from "../../../report/contract.ts";
import { recordsByHost } from "../../../enrichment/types.ts";
import { projectHostEnrichment } from "../../../enrichment/project.ts";
import { lastObjectWith, objectsWith } from "../../../scorecard/parse.ts";
import type { EvidenceRef, Finding, Severity } from "../../findings.ts";
import { errorResult, okResult, type DagNode, type Dismissal, type NodeContext, type NodeResult } from "../node.ts";

const INSTRUCTIONS = [
  "You are classifying the external network destinations a Chrome extension reaches, against what the extension says it does.",
  "You are given the stated purpose and, for each host, how many times it is referenced, how it is reached, whether any reference is built dynamically, the party relationship when known, and — when available — RDAP registration context (registrar/owner, age in days, derived flags such as newly_registered). Treat that context as supporting evidence, not proof: registration facts are self-reported and attacker-influenceable.",
  "For each host, decide:",
  '- "expected-for-purpose": the stated purpose plainly requires talking to this host.',
  '- "infrastructure": a well-known CDN, analytics, or error-reporting service.',
  '- "suspicious": unrelated to the stated purpose, or a likely exfiltration/affiliate endpoint.',
  '- "unknown": cannot tell from the information given.',
  "Judge only against the stated purpose and the data given — do not invent behavior.",
  "Respond with ONLY a JSON object:",
  '{"classifications": [{"host": "<host>", "classification": "expected-for-purpose" | "infrastructure" | "suspicious" | "unknown", "reasoning": "<one line>"}]}',
].join("\n");

type Classification = "expected-for-purpose" | "infrastructure" | "suspicious" | "unknown";
const CLASSIFICATIONS = new Set<Classification>(["expected-for-purpose", "infrastructure", "suspicious", "unknown"]);

function parseClassifications(text: string): Map<string, { classification: Classification; reasoning: string }> {
  const out = new Map<string, { classification: Classification; reasoning: string }>();
  const envelope = lastObjectWith(text, "classifications");
  // The requested format wraps host objects in an array; objectsWith only
  // extracts top-level objects. Keep standalone host objects compatible too.
  const candidates: unknown[] = envelope
    ? (Array.isArray(envelope.classifications) ? envelope.classifications : [])
    : objectsWith(text, "classification");
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const o = candidate as Record<string, unknown>;
    if (typeof o.host !== "string") continue;
    if (!CLASSIFICATIONS.has(o.classification as Classification)) continue;
    out.set(o.host, {
      classification: o.classification as Classification,
      reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
    });
  }
  return out;
}

export const destinationReviewer: DagNode = {
  id: "destination-reviewer",
  version: "1.1",
  kind: "llm",
  sourceAccess: "snippets-only",
  upstream: [],
  gate: (ctx) => buildDestinations(ctx.pack).rows.length > 0,
  async run(ctx: NodeContext): Promise<NodeResult> {
    const rows = buildDestinations(ctx.pack, ctx.enrichment).rows;
    const stated = statedPurposeOf(ctx.pack, ctx.listing);

    // Fold the SAME compact RDAP projection the monolith sees onto each host
    // (omitted when no record covers the host — never a `field: null` stub).
    const byHost = recordsByHost(ctx.enrichment);
    const promptRows = rows.map((r: DestinationRow) => {
      const record = byHost.get(r.host);
      return {
        host: r.host,
        references: r.references,
        any_dynamic: r.any_dynamic,
        reached_via: r.reached_via,
        party: r.party,
        ...(record ? { enrichment: projectHostEnrichment(record, ctx.pack.analyzed_at) } : {}),
      };
    });
    const blocks: UntrustedBlock[] = [
      { tag: "stated_purpose", content: stated ? stated.text : "(none provided)" },
      { tag: "destinations", content: stableStringify(promptRows) },
    ];
    const res = await ctx.client.complete({
      label: "dag:destination-reviewer",
      model: ctx.model,
      prompt: buildPrompt(INSTRUCTIONS, blocks),
      params: { temperature: 0, format: "json" },
    });
    const classified = parseClassifications(res.text);
    const missing = rows.filter((r) => !classified.has(r.host));
    if (missing.length > 0) {
      return {
        ...errorResult(`Destination classification coverage incomplete: ${rows.length - missing.length}/${rows.length} requested hosts classified (${missing.length} missing).`),
        usage: res.usage,
      };
    }

    const findings: Finding[] = [];
    const dismissals: Dismissal[] = [];
    let n = 0;
    for (const r of rows) {
      const c = classified.get(r.host)!; // Complete coverage was checked above.
      const verdict = c.classification;
      // Only a host the model AFFIRMATIVELY flags as suspicious-against-purpose
      // becomes a finding. An explicit "unknown" when a host can't be tied to
      // the purpose is a dismissal, NOT a data-exfiltration finding: a bare
      // unexplained destination is not proof of exfiltration (taint-flow-reviewer
      // owns confirmed source→host flows, verified). Treating "unknown" as a
      // finding was the dominant false positive (CDNs, first-party sites,
      // namespace URIs, even code identifiers — all default to "unknown").
      const flagged = verdict === "suspicious";
      const site = r.example_sites[0];
      if (flagged && site) {
        const severity: Severity = "medium";
        const refs: EvidenceRef[] = [{ file: site.path, location: { line: site.line }, symbol: null, sink_or_string: r.host }];
        findings.push({
          id: `dest:${++n}`,
          title: `Suspicious destination: ${r.host}`,
          claim_type: "observed-capability",
          severity,
          category: "data-exfiltration",
          finding_type: "unknown",
          confidence: "medium",
          claimed_mechanism: "",
          evidence_refs: refs,
          detail: `The extension reaches ${r.host} (${r.references} reference${r.references > 1 ? "s" : ""}, reached via ${
            r.reached_via.join(", ") || "unknown"
          }${r.any_dynamic ? ", some built dynamically" : ""}). Classified ${verdict} against the stated purpose. ${
            c.reasoning
          }`.trim(),
        });
      } else {
        dismissals.push({
          concern: `destination ${r.host}`,
          checks_run: ["stated-purpose match", "infrastructure check"],
          note: `${verdict}${!site && flagged ? " (no resolved call site to ground a finding)" : ""}${
            c.reasoning ? `: ${c.reasoning}` : ""
          }`,
        });
      }
    }

    return okResult({ findings, dismissals, usage: res.usage });
  },
};
