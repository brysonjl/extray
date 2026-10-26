// LLM-judge — the grading mechanism for the PRIMARY metric (must_detect
// coverage). One judge call per must_detect entry, so stacked mutants F/G get
// per-pattern partial credit. The same mechanism also decides, per benign
// sample, whether the output asserts a must_not_emit finding class (feeds the
// false-alarm metric).
//
// The methodology output is UNTRUSTED (it may carry adversarial extension text),
// so it is wrapped in the envelope with the judge instructions first. The
// behavior/class string is internally authored (a label), so it lives in the
// trusted instruction section. Determinism comes from replay, not from assuming
// the model is deterministic.
//
// NOTE: a FakeLlmClient test of this module proves plumbing only. The real
// judge's resistance to assertion-inflation / under-crediting / verbosity bias
// is gated against RECORD-captured completions in the Unit 8 pilot.

import type { LlmClient } from "../llm/client.ts";
import { buildPrompt } from "../llm/envelope.ts";
import { fixtureFileName } from "../llm/record-replay.ts";
import { objectsWith } from "./parse.ts";

export interface JudgeVerdict {
  satisfied: boolean;
  rationale: string;
}

export class JudgeParseError extends Error {}

/** Accept a boolean, or the strings "true"/"false" (some models stringify it). */
function coerceBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

const COVERAGE_RULES = [
  "Rules:",
  "- 'asserted' means the output makes the claim as a finding, not merely mentions related words.",
  "- A destination tied to the extension's stated purpose (a legitimate CDN or update URL) does NOT count as exfiltration to an external host.",
  "- For a non-network covert-channel behavior, the output must name the specific channel (e.g. clipboard, context menus); flagging only broad permissions does NOT satisfy it.",
  "- Judge only whether the behavior is asserted. Do not reward verbosity; terse and verbose assertions are equal.",
  'Respond with ONLY a JSON object: {"satisfied": true|false, "rationale": "<one sentence>"}.',
].join("\n");

/** Extract a {satisfied, rationale} verdict from free-form judge text. */
export function parseVerdict(text: string): JudgeVerdict {
  // Last VALID verdict wins: a later verdict-shaped object with a non-boolean
  // `satisfied` must not shadow (and crash on) an earlier valid verdict.
  const objs = objectsWith(text, "satisfied");
  for (let i = objs.length - 1; i >= 0; i--) {
    const satisfied = coerceBool(objs[i]!.satisfied);
    if (satisfied !== null) {
      return { satisfied, rationale: typeof objs[i]!.rationale === "string" ? (objs[i]!.rationale as string) : "" };
    }
  }
  throw new JudgeParseError(
    `could not parse a {satisfied, rationale} verdict from judge output (${text.length} chars; no JSON object with a boolean "satisfied")`,
  );
}

async function judge(
  client: LlmClient,
  model: string,
  label: string,
  instructions: string,
  output: string,
): Promise<JudgeVerdict> {
  const prompt = buildPrompt(instructions, [{ tag: "methodology_output", content: output }]);
  // format: "json" asks the provider for structured output, removing most of the
  // unparseable-completion failure class (and changing the fixture keys — see
  // docs/reference/improvements/004).
  const req = { label, model, prompt, params: { temperature: 0, format: "json" } };
  const res = await client.complete(req);
  try {
    return parseVerdict(res.text);
  } catch (e) {
    if (e instanceof JudgeParseError) {
      // In RECORD mode the unparseable completion was already persisted and will
      // replay forever — name the fixture file so the user knows what to delete.
      throw new JudgeParseError(`${e.message} — recorded fixture: ${fixtureFileName(req)}; delete it from the fixture dir to force a re-record`);
    }
    throw e;
  }
}

/** Did the methodology output assert the given observable behavior? (coverage) */
export function judgeMustDetect(
  behavior: string,
  output: string,
  client: LlmClient,
  model: string,
): Promise<JudgeVerdict> {
  const instructions = [
    "You are grading whether a security analysis output asserts a specific observable behavior.",
    `BEHAVIOR TO CHECK: ${behavior}`,
    "Does the analysis output below assert that this behavior is present?",
    COVERAGE_RULES,
  ].join("\n");
  return judge(client, model, "judge:must_detect", instructions, output);
}

/**
 * Did the output assert the given finding CLASS? Used for benign must_not_emit:
 * `asserted === true` means a potential false alarm. Same prompt shape as
 * judgeMustDetect, reframed around a finding class.
 */
export function judgeAssertsClass(
  findingClass: string,
  output: string,
  client: LlmClient,
  model: string,
): Promise<JudgeVerdict> {
  const instructions = [
    "You are grading whether a security analysis output asserts a finding of a specific class.",
    `FINDING CLASS TO CHECK: ${findingClass}`,
    "Does the analysis output below assert a finding of this class against the extension?",
    COVERAGE_RULES,
  ].join("\n");
  return judge(client, model, "judge:must_not_emit", instructions, output);
}
