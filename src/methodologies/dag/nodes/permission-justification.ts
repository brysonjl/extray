// Tier 1 — narrow LLM, snippets-only (no source reads → emits observed-capability
// only). Judges whether each requested permission is justified by the extension's
// stated purpose and its observed call sites. Logical fan-out (one judgment per
// permission) is issued as ONE batched call: until provider prompt-caching is
// available, batching pays the shared-context ingestion once instead of per
// permission (docs/dag-methodology.md, cost model). The per-permission judgment
// stays the audit unit.
//
// Unjustified / weakly-justified permissions become observed-capability findings;
// justified and unused permissions are recorded as dismissals (checked, not a
// finding) to keep the false-alarm surface low.

import { buildPrompt, type UntrustedBlock } from "../../../llm/envelope.ts";
import { stableStringify } from "../../../llm/record-replay.ts";
import { buildPermissions } from "../../../report/build.ts";
import { statedPurposeOf } from "../../../report/assemble.ts";
import { objectsWith } from "../../../scorecard/parse.ts";
import type { EvidenceRef, Finding, Severity } from "../../findings.ts";
import { okResult, type DagNode, type Dismissal, type NodeContext, type NodeResult } from "../node.ts";

const INSTRUCTIONS = [
  "You are assessing whether each permission a Chrome extension requests is justified by what the extension says it does and where it actually uses the permission.",
  "You are given the stated purpose and, for each permission, its usage status and a few example call sites from static analysis.",
  "For each permission, decide:",
  '- "justified": the stated purpose plainly needs this permission and it is used.',
  '- "weakly-justified": plausibly related to the purpose but broad or thinly used.',
  '- "unjustified": the stated purpose does not explain this permission.',
  '- "unused": declared but no call site was found.',
  "Judge only against the stated purpose and usage given — do not invent behavior. If the stated purpose is empty, judge a permission unjustified only when no usage supports it.",
  "Respond with ONLY a JSON object:",
  '{"judgments": [{"permission": "<name>", "judgment": "justified" | "weakly-justified" | "unjustified" | "unused", "reasoning": "<one line>"}]}',
].join("\n");

type Judgment = "justified" | "weakly-justified" | "unjustified" | "unused";
const JUDGMENTS = new Set<Judgment>(["justified", "weakly-justified", "unjustified", "unused"]);

function parseJudgments(text: string): Map<string, { judgment: Judgment; reasoning: string }> {
  const out = new Map<string, { judgment: Judgment; reasoning: string }>();
  for (const o of objectsWith(text, "judgment")) {
    if (typeof o.permission !== "string") continue;
    if (!JUDGMENTS.has(o.judgment as Judgment)) continue;
    out.set(o.permission, {
      judgment: o.judgment as Judgment,
      reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
    });
  }
  return out;
}

export const permissionJustification: DagNode = {
  id: "permission-justification",
  version: "1.0",
  kind: "llm",
  sourceAccess: "snippets-only",
  upstream: [],
  gate: (ctx) => buildPermissions(ctx.pack).api.length > 0,
  async run(ctx: NodeContext): Promise<NodeResult> {
    const perms = buildPermissions(ctx.pack).api;
    const stated = statedPurposeOf(ctx.pack, ctx.listing);

    const promptPerms = perms.map((p) => ({
      permission: p.permission,
      optional: p.optional,
      status: p.status,
      usage_count: p.total_usage,
      example_sites: p.usage.slice(0, 3).map((u) => ({ file: u.path, line: u.line, api: u.api })),
    }));
    const blocks: UntrustedBlock[] = [
      { tag: "stated_purpose", content: stated ? stated.text : "(none provided)" },
      { tag: "permissions", content: stableStringify(promptPerms) },
    ];
    const res = await ctx.client.complete({
      label: "dag:permission-justification",
      model: ctx.model,
      prompt: buildPrompt(INSTRUCTIONS, blocks),
      params: { temperature: 0, format: "json" },
    });
    const judged = parseJudgments(res.text);

    const findings: Finding[] = [];
    const dismissals: Dismissal[] = [];
    let n = 0;
    for (const p of perms) {
      const j = judged.get(p.permission);
      const verdict = j?.judgment ?? "unused";
      if (verdict === "unjustified" || verdict === "weakly-justified") {
        const severity: Severity = verdict === "unjustified" ? "medium" : "low";
        const refs: EvidenceRef[] = [{ file: "manifest.json", location: null, symbol: null, sink_or_string: p.permission }];
        const site = p.usage[0];
        if (site) refs.push({ file: site.path, location: { line: site.line }, symbol: null, sink_or_string: site.api });
        findings.push({
          id: `perm:${++n}`,
          title: `${verdict === "unjustified" ? "Unjustified" : "Weakly justified"} permission: ${p.permission}`,
          claim_type: "observed-capability",
          severity,
          category: "permissions",
          finding_type: "risky-capability",
          confidence: "medium",
          claimed_mechanism: "",
          evidence_refs: refs,
          detail: `The "${p.permission}" permission is ${verdict.replace("-", " ")} given the stated purpose${
            p.total_usage > 0 ? ` (used at ${p.total_usage} site${p.total_usage > 1 ? "s" : ""})` : " (no call site found)"
          }. ${j?.reasoning ?? ""}`.trim(),
        });
      } else {
        dismissals.push({
          concern: `permission "${p.permission}"`,
          checks_run: ["stated-purpose justification", "call-site usage"],
          note: `${verdict}${j?.reasoning ? `: ${j.reasoning}` : ""}`,
        });
      }
    }

    return okResult({ findings, dismissals, usage: res.usage });
  },
};
