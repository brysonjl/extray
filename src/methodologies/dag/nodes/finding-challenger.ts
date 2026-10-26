// Tier 2.5 — the adversarial refute pass. An independent skeptic over every
// CONFIRMED inferred-behavior finding the deep-dive nodes produced. The deep
// dives both build AND verify their own candidates, so a confirmation is, in
// effect, self-graded. This node re-examines each confirmed finding with a
// DISTINCT, refutation-focused prompt and the real source; a finding that
// survives a pass built to kill it is much stronger than one nobody challenged.
//
// Mechanics: it emits a VerifierVerdict per challenged claim_id. The collector
// merges with REFUTATION PRECEDENCE — only an explicit "refuted" here vetoes the
// producer's "confirmed" (the finding is then excluded); "inconclusive" /
// "needs-dynamic" / "confirmed" leave the finding standing. So the challenger can
// only ever SUBTRACT a confirmation it can actively disprove, never invent one.
//
// It MUST use a different prompt + label than claim-verifier: replaying the
// identical verify:claim request (temperature 0) would just return the same
// "confirmed" fixture and challenge nothing.
//
// Constructed via a factory so createDag can wire upstream = every other node id
// — that guarantees it runs last (after all producers) without a hand-maintained
// list, and stays correct as nodes are added.

import { buildPrompt, type UntrustedBlock } from "../../../llm/envelope.ts";
import { stableStringify } from "../../../llm/record-replay.ts";
import {
  extractSource,
  newSourceCaches,
  parseVerifierVerdict,
  type SourceCaches,
  type VerifierVerdict,
} from "../../claim-verifier.ts";
import { isGrounded, resolveEvidenceRefs, type EvidenceRef, type Finding } from "../../findings.ts";
import { addUsage, okResult, type DagNode, type Dismissal, type NodeContext, type NodeResult, ZERO_USAGE } from "../node.ts";
import type { LlmClient, Usage } from "../../../llm/client.ts";

const MAX_SOURCE_BLOCKS = 4;

const INSTRUCTIONS = [
  "You are an independent, skeptical reviewer trying to REFUTE a security finding that a PRIOR analysis pass marked CONFIRMED about a Chrome browser extension.",
  "You are given the finding (its claimed mechanism) and the actual source it cites. Your job is to find any reason the cited code does NOT implement the claimed mechanism.",
  "Be adversarial but honest:",
  '- "refuted": the cited source is readable and does NOT implement the claimed mechanism (the prior pass over-claimed) — quote the code that shows the absence or contradiction.',
  '- "confirmed": you tried to refute it and could not — the source genuinely implements the claimed mechanism. Quote the line(s) that do.',
  '- "needs-dynamic": the mechanism is genuinely runtime-only and static source can neither implement nor contradict it.',
  '- "inconclusive": the provided source is insufficient to judge.',
  "Do NOT refute a mechanism that the source really implements just because it is described tersely. Only refute genuine over-claims / confabulations. When the code clearly implements the claim, uphold it as confirmed.",
  "Respond with ONLY a JSON object:",
  '{"verdict": "confirmed" | "refuted" | "needs-dynamic" | "inconclusive", "grounding_line": {"file": "<path>", "line": <number>} | null, "rationale": "<1-3 sentences>", "evidence_quote": "<verbatim source>"}',
].join("\n");

/** Independently challenge one already-confirmed finding against real source. */
async function challengeFinding(
  finding: Finding,
  resolvedRefs: EvidenceRef[],
  opts: { sampleDir: string; client: LlmClient; model: string; searchFiles: string[]; dataFlows?: NodeContext["pack"]["cross_file"]["data_flows"] },
  caches: SourceCaches,
): Promise<{ verdict: VerifierVerdict; usage: Usage }> {
  const blocks: UntrustedBlock[] = [
    {
      tag: "finding_under_challenge",
      content: stableStringify({
        id: finding.id,
        title: finding.title,
        claimed_mechanism: finding.claimed_mechanism,
        detail: finding.detail,
        evidence_refs: finding.evidence_refs,
      }),
    },
  ];
  const seen = new Set<string>();
  for (const ref of resolvedRefs) {
    if (seen.size >= MAX_SOURCE_BLOCKS) break;
    const win = extractSource(opts.sampleDir, ref, caches, opts.searchFiles);
    if (!win) continue;
    const key = `${win.file} ${win.note}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push({ tag: "source", content: `FILE: ${win.file}\nWINDOW: ${win.note}\n----\n${win.content}` });
  }

  const res = await opts.client.complete({
    label: "dag:finding-challenger",
    model: opts.model,
    prompt: buildPrompt(INSTRUCTIONS, blocks),
    params: { temperature: 0, format: "json" },
  });
  return { verdict: parseVerifierVerdict(res.text, finding.id), usage: res.usage };
}

/**
 * Build the finding-challenger node. `upstreamIds` should be every other node in
 * the registry, so the challenger runs after all producers.
 */
export function makeFindingChallenger(upstreamIds: string[]): DagNode {
  return {
    id: "finding-challenger",
    version: "1.0",
    kind: "llm",
    sourceAccess: "targeted-reads",
    upstream: upstreamIds,
    // Only worth running when some upstream node confirmed an inferred-behavior.
    gate: (ctx) => confirmedCandidates(ctx).length > 0,
    async run(ctx): Promise<NodeResult> {
      const candidates = confirmedCandidates(ctx);
      const caches = newSourceCaches();
      const searchFiles = ctx.pack.files.map((f) => f.path);
      const verdicts: VerifierVerdict[] = [];
      const dismissals: Dismissal[] = [];
      let usage = ZERO_USAGE;

      for (const finding of candidates) {
        const res = resolveEvidenceRefs(finding, ctx.sampleDir);
        // Can't challenge what we can't read — leave the confirmation standing.
        if (!isGrounded(res)) continue;
        const { verdict, usage: u } = await challengeFinding(
          finding,
          res.resolved,
          { sampleDir: ctx.sampleDir, client: ctx.client, model: ctx.verifierModel, searchFiles, dataFlows: ctx.pack.cross_file.data_flows },
          caches,
        );
        verdicts.push(verdict);
        usage = addUsage(usage, u);
        if (verdict.verdict === "refuted") {
          dismissals.push({
            concern: `challenged finding "${finding.title}"`,
            checks_run: ["independent adversarial refutation against source"],
            note: verdict.rationale || "refuted on re-examination",
          });
        }
      }

      return okResult({ verdicts, dismissals, usage, data: { challenged: candidates.length } });
    },
  };
}

/** Confirmed inferred-behavior findings across all upstream node outputs. */
function confirmedCandidates(ctx: NodeContext): Finding[] {
  const out: Finding[] = [];
  for (const r of ctx.upstream.values()) {
    const confirmed = new Set(r.verdicts.filter((v) => v.verdict === "confirmed").map((v) => v.claim_id));
    for (const f of r.findings) {
      if (f.claim_type === "inferred-behavior" && confirmed.has(f.id)) out.push(f);
    }
  }
  return out;
}
