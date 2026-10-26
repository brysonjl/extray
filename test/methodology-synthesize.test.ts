import { describe, it, expect } from "vitest";
import { describeDeviation, parseSynthesis, SynthesisParseError } from "../src/methodologies/synthesize.ts";

// Synthesis is humanization only — it produces prose + a deviation OBSERVATION.
// The tier and per-area breakdown are decided upstream by the verdict engine
// and are NOT part of the synthesis output.
const GOOD = {
  layperson_summary: "lay",
  technical_summary: "tech",
  description_deviation: { deviates: false, note: "matches" },
};

describe("parseSynthesis", () => {
  it("parses a well-formed synthesis (summaries + deviation; no tier)", () => {
    const s = parseSynthesis(JSON.stringify(GOOD));
    expect(s.layperson_summary).toBe("lay");
    expect(s.technical_summary).toBe("tech");
    expect(s.description_deviation).toEqual({ deviates: false, note: "matches" });
    expect("tier" in s).toBe(false);
  });

  it("treats a non-boolean deviates as null (not assessable)", () => {
    const s = parseSynthesis(JSON.stringify({ ...GOOD, description_deviation: { deviates: "yes", note: "n" } }));
    expect(s.description_deviation.deviates).toBeNull();
  });

  it("throws SynthesisParseError when no summary-bearing object exists", () => {
    expect(() => parseSynthesis("the extension seems fine")).toThrow(SynthesisParseError);
  });

  it("recovers the summary object from prose-wrapped completions", () => {
    const s = parseSynthesis(`Sure! Here it is:\n${JSON.stringify(GOOD)}\nHope that helps.`);
    expect(s.layperson_summary).toBe("lay");
  });
});

describe("describeDeviation", () => {
  const synth = parseSynthesis(JSON.stringify(GOOD));

  it("carries the stated purpose and source through", () => {
    const d = describeDeviation(synth, { text: "Edit cookies.", source: "manifest" });
    expect(d).toEqual({ stated_purpose: "Edit cookies.", stated_source: "manifest", deviates: false, note: "matches" });
  });

  it("forces deviates to null when no stated purpose existed, regardless of model output", () => {
    const d = describeDeviation(parseSynthesis(JSON.stringify({ ...GOOD, description_deviation: { deviates: true, note: "x" } })), null);
    expect(d.deviates).toBeNull();
    expect(d.stated_purpose).toBeNull();
  });
});
