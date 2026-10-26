// Neutral tier-normalizer — maps a methodology's free-form output to the verdict
// enum WITHOUT advantaging the DAG's native rollup shape. This is the top
// fairness risk in the bake-off, so the rubric is isolated here, phrased in
// behavior/severity terms (never DAG node / rule_id vocabulary), and auditable.
// If a neutral mapping proves shaky, the scorecard can rank on coverage alone
// (--no-tier-recall).
//
// The methodology output is untrusted → wrapped in the envelope, instructions
// first. As with the judge, FakeLlmClient tests prove plumbing only; the real
// verbosity-parity / held-out-neutrality checks run in the Unit 8 pilot.

import type { LlmClient } from "../llm/client.ts";
import { buildPrompt } from "../llm/envelope.ts";
import { TIERS, type Tier } from "./labels.ts";
import { lastObjectWith } from "./parse.ts";

// The audited rubric. Behavior/severity terms only — no DAG/rule_id vocabulary.
const RUBRIC = [
  "Map the security analysis output below to exactly one risk tier:",
  '- "high-risk": the output asserts a confirmed malicious behavior such as data exfiltration to an external host, code execution from a remote/obfuscated source, or a tampered dependency that exfiltrates data.',
  '- "concerning": the output describes broad/sensitive capabilities or a real-but-limited/conditional channel, without asserting a confirmed high-severity malicious behavior.',
  '- "low-risk": the output describes minor or narrowly-scoped concerns only.',
  '- "clean": the output asserts no security concern.',
  '- "inconclusive": the output is empty, ambiguous, or refuses to assess.',
  "Fairness rule: do NOT rate high-risk on the basis of a signed-hash / verified_contents mismatch alone — that is a signature check, not reasoned behavior. Rate on the asserted behavior only.",
  'Respond with ONLY a JSON object: {"tier": "<one of clean|low-risk|concerning|high-risk|inconclusive>"}.',
].join("\n");

/** Extract a tier from free-form normalizer output; unknown/missing → inconclusive. */
export function parseTier(text: string): Tier {
  const obj = lastObjectWith(text, "tier");
  if (obj && typeof obj.tier === "string" && (TIERS as readonly string[]).includes(obj.tier)) {
    return obj.tier as Tier;
  }
  // Ambiguous/unparseable output is itself an inconclusive signal, not an error.
  return "inconclusive";
}

export async function normalizeTier(output: string, client: LlmClient, model: string): Promise<Tier> {
  const prompt = buildPrompt(RUBRIC, [{ tag: "methodology_output", content: output }]);
  // format: "json" — structured output, same rationale (and fixture-key change) as the judge.
  const res = await client.complete({ label: "normalize:tier", model, prompt, params: { temperature: 0, format: "json" } });
  return parseTier(res.text);
}
