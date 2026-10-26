// must-detect inter-rater pilot harness (Unit 8). The enforceable gate that runs
// BEFORE scores are trusted. Two parts:
//
//  1. Inter-rater agreement on the judgment-hardest labels, scored by TWO
//     INDEPENDENT raters — the LLM-judge and a MODEL-INDEPENDENT second rater
//     (human adjudication, or a different model family). A same-model second
//     pass is not acceptable (it measures self-consistency, not agreement).
//
//  2. A judge calibration gate run against the REAL judge: it must resist
//     over-crediting (vague name-drop → not satisfied), under-crediting (terse/
//     synonym assertion → still satisfied), and verbosity bias (terse vs verbose
//     → same verdict).
//
// HONEST FRAMING: passing this gate demonstrates inter-rater agreement +
// inflation-resistance on a small pilot. It does NOT establish validity against
// external ground truth — the calibration answers encode the label-authors'
// intent. Coverage stays provisional and the scorecard says so.

import type { LlmClient } from "../llm/client.ts";
import { loadCorpusLabels } from "./labels.ts";
import { judgeMustDetect, judgeAssertsClass } from "./judge.ts";

/** The judgment-hardest samples (per corpus/must-detect-pilot.md). */
export const PILOT_SAMPLES = [
  "demo-cookie-manager",
  "mutant-a-exfil-fetch",
  "mutant-e-crossfile-flow",
  "mutant-g-stacked-be",
  "mutant-h-curveball-clipboard",
] as const;

export interface RaterEntry {
  sample: string;
  kind: "must_detect" | "must_not_emit";
  entry: string;
  rater1: boolean;
  rater2: boolean;
  agree: boolean;
}

export interface CalibrationCase {
  id: string;
  behavior: string;
  output: string;
  expected: boolean;
  /** Cases sharing a verbosityPair must produce the SAME verdict as each other. */
  verbosityPair?: string;
}

export const CALIBRATION_SET: CalibrationCase[] = [
  { id: "over-credit-decoy", behavior: "cookie values are sent to an external host", output: "The extension uses cookies and makes network requests for normal operation.", expected: false },
  { id: "clear-assert", behavior: "cookie values are sent to an external host", output: "FINDING: document.cookie is read and POSTed to https://collect.evil.example/c.", expected: true },
  { id: "under-credit-terse", behavior: "cookie values are sent to an external host", output: "cookies → fetch(evil.example) exfil.", expected: true },
  { id: "verbosity-terse", behavior: "a vendored library was modified to exfiltrate data", output: "jquery.min.js tampered; now beacons document.cookie out.", expected: true, verbosityPair: "lib-tamper" },
  { id: "verbosity-verbose", behavior: "a vendored library was modified to exfiltrate data", output: "On close inspection, the vendored jQuery library appears to diverge from its known-good release: an added routine collects document.cookie and transmits it to an external endpoint, i.e. the dependency has been tampered with to exfiltrate data.", expected: true, verbosityPair: "lib-tamper" },
];

export interface CalibrationResult {
  cases: Array<{ id: string; expected: boolean; got: boolean; pass: boolean }>;
  verbosityPairsConsistent: boolean;
  passed: boolean;
}

export interface PilotReport {
  entries: RaterEntry[];
  secondRater: string;
  calibration: CalibrationResult;
  allAgree: boolean;
  passed: boolean;
}

export interface PilotInputs {
  /** Methodology-style output per pilot sample (monolith output or hand-written stand-in). */
  outputs: Map<string, string>;
  rater1: LlmClient;
  model1: string;
  rater2: LlmClient;
  model2: string;
  /** Label for the second rater in the report (e.g. "human", "different-model-family"). */
  secondRaterLabel: string;
  corpusDir?: string;
}

/** Run the judge calibration gate against the REAL judge (rater1). */
export async function runCalibration(rater1: LlmClient, model1: string): Promise<CalibrationResult> {
  const cases = [];
  const byPair = new Map<string, boolean[]>();
  for (const c of CALIBRATION_SET) {
    const v = await judgeMustDetect(c.behavior, c.output, rater1, model1);
    const pass = v.satisfied === c.expected;
    cases.push({ id: c.id, expected: c.expected, got: v.satisfied, pass });
    if (c.verbosityPair) {
      if (!byPair.has(c.verbosityPair)) byPair.set(c.verbosityPair, []);
      byPair.get(c.verbosityPair)!.push(v.satisfied);
    }
  }
  const verbosityPairsConsistent = [...byPair.values()].every((vs) => vs.every((v) => v === vs[0]));
  const passed = cases.every((c) => c.pass) && verbosityPairsConsistent;
  return { cases, verbosityPairsConsistent, passed };
}

export class PilotError extends Error {}

export async function runPilot(inputs: PilotInputs): Promise<PilotReport> {
  const labels = loadCorpusLabels(inputs.corpusDir ?? "corpus");
  const entries: RaterEntry[] = [];

  for (const sample of PILOT_SAMPLES) {
    const label = labels.get(sample);
    const output = inputs.outputs.get(sample);
    // A missing pilot sample must FAIL LOUDLY — silently skipping would let the
    // gate report PASS with no evidence (vacuous agreement over an empty set).
    if (!label) throw new PilotError(`pilot sample "${sample}" has no label in the corpus`);
    if (output === undefined) throw new PilotError(`pilot sample "${sample}" has no methodology output`);

    if (label.kind === "malicious") {
      for (const behavior of label.must_detect) {
        const r1 = await judgeMustDetect(behavior, output, inputs.rater1, inputs.model1);
        const r2 = await judgeMustDetect(behavior, output, inputs.rater2, inputs.model2);
        entries.push({ sample, kind: "must_detect", entry: behavior, rater1: r1.satisfied, rater2: r2.satisfied, agree: r1.satisfied === r2.satisfied });
      }
    } else {
      for (const cls of label.must_not_emit) {
        const r1 = await judgeAssertsClass(cls, output, inputs.rater1, inputs.model1);
        const r2 = await judgeAssertsClass(cls, output, inputs.rater2, inputs.model2);
        entries.push({ sample, kind: "must_not_emit", entry: cls, rater1: r1.satisfied, rater2: r2.satisfied, agree: r1.satisfied === r2.satisfied });
      }
    }
  }

  const calibration = await runCalibration(inputs.rater1, inputs.model1);
  // Non-empty guard: an empty entry set is a vacuous "all agree", not a pass.
  const allAgree = entries.length > 0 && entries.every((e) => e.agree);
  return { entries, secondRater: inputs.secondRaterLabel, calibration, allAgree, passed: allAgree && calibration.passed };
}

/** Render the filled Results table for corpus/must-detect-pilot.md. */
export function renderPilotTable(report: PilotReport): string {
  const L: string[] = [];
  L.push(`Second rater: **${report.secondRater}** (model-independent of the judge).`);
  L.push("");
  L.push("| Sample | entry | Rater 1 (judge) | Rater 2 | Agree? |");
  L.push("|--------|-------|-----------------|---------|--------|");
  for (const e of report.entries) {
    const abbrev = e.entry.length > 60 ? e.entry.slice(0, 57) + "…" : e.entry;
    L.push(`| ${e.sample} | ${abbrev} | ${e.rater1 ? "yes" : "no"} | ${e.rater2 ? "yes" : "no"} | ${e.agree ? "✓" : "✗"} |`);
  }
  L.push("");
  L.push(`Judge calibration: ${report.calibration.passed ? "PASS" : "FAIL"} ` +
    `(${report.calibration.cases.filter((c) => c.pass).length}/${report.calibration.cases.length} cases; ` +
    `verbosity-parity ${report.calibration.verbosityPairsConsistent ? "consistent" : "INCONSISTENT"}).`);
  L.push("");
  L.push(report.passed
    ? "**Gate: PASS** — inter-rater agreement + inflation-resistance demonstrated (not external-ground-truth validity; coverage stays provisional)."
    : "**Gate: FAIL** — tighten the disagreeing phrasings (or the judge prompt) and re-run before trusting scores.");
  return L.join("\n");
}
