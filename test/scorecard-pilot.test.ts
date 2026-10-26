import { describe, it, expect } from "vitest";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { runPilot, runCalibration, PilotError, type PilotInputs } from "../src/scorecard/pilot.ts";

// Heuristic judge over the built prompt: "satisfied" when the prompt shows an
// exfil/tamper/covert marker. Deterministic, no network. (Plumbing only — the
// REAL judge's behavior is validated by RECORD-captured fixtures in a live run.)
const MARKER = /evil|exfil|tamper|beacon|posted|clipboard|context.?menu/i;
// Inspect only the untrusted output block — the judge's own instructions mention
// "exfiltration"/"clipboard", so matching the whole prompt would always be true.
function outputBlock(prompt: string): string {
  const m = prompt.match(/<methodology_output>([\s\S]*?)<\/methodology_output>/);
  return m ? m[1]! : prompt;
}
const heuristic = new FakeLlmClient((req) => JSON.stringify({ satisfied: MARKER.test(outputBlock(req.prompt)), rationale: "" }));
const inverted = new FakeLlmClient((req) => JSON.stringify({ satisfied: !MARKER.test(outputBlock(req.prompt)), rationale: "" }));
const alwaysYes = new FakeLlmClient(() => JSON.stringify({ satisfied: true, rationale: "" }));

const outputs = new Map<string, string>([
  ["demo-cookie-manager", "The extension reads cookies for its stated cookie-editing purpose only; nothing leaves the browser."],
  ["mutant-a-exfil-fetch", "FINDING: cookies exfil to evil host."],
  ["mutant-e-crossfile-flow", "FINDING: cross-file cookie exfil to evil host."],
  ["mutant-g-stacked-be", "FINDING: tampered jquery beacons cookies; cross-file exfil to evil host."],
  ["mutant-h-curveball-clipboard", "FINDING: covert clipboard + context-menu channel leaks cookies."],
]);

const base = (over: Partial<PilotInputs> = {}): PilotInputs => ({
  outputs,
  rater1: heuristic,
  model1: "judge-model",
  rater2: heuristic,
  model2: "second-model",
  secondRaterLabel: "different-model-family",
  ...over,
});

describe("must-detect pilot gate", () => {
  it("two raters agreeing + passing calibration → gate passes, full table", async () => {
    const report = await runPilot(base());
    expect(report.allAgree).toBe(true);
    expect(report.calibration.passed).toBe(true);
    expect(report.passed).toBe(true);
    expect(report.entries.length).toBeGreaterThan(0);
  });

  it("a model-independent second rater that splits → gate fails and flags the disagreement", async () => {
    const report = await runPilot(base({ rater2: inverted }));
    expect(report.allAgree).toBe(false);
    expect(report.passed).toBe(false);
    expect(report.entries.some((e) => !e.agree)).toBe(true);
  });

  it("stacked mutant-g scores each must_detect entry independently", async () => {
    const report = await runPilot(base());
    const g = report.entries.filter((e) => e.sample === "mutant-g-stacked-be");
    expect(g.length).toBe(2); // B + E behaviors scored separately
  });

  it("calibration catches an over-crediting judge (vague decoy → wrongly satisfied)", async () => {
    const cal = await runCalibration(alwaysYes, "m");
    expect(cal.passed).toBe(false);
    expect(cal.cases.find((c) => c.id === "over-credit-decoy")!.pass).toBe(false);
  });

  it("calibration passes for a judge that resists inflation and is verbosity-consistent", async () => {
    const cal = await runCalibration(heuristic, "m");
    expect(cal.passed).toBe(true);
    expect(cal.verbosityPairsConsistent).toBe(true);
  });

  it("fails loudly (not a vacuous pass) when a pilot sample output is missing", async () => {
    const partial = new Map(outputs);
    partial.delete("mutant-e-crossfile-flow");
    await expect(runPilot(base({ outputs: partial }))).rejects.toBeInstanceOf(PilotError);
  });
});
