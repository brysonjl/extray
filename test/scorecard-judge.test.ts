import { describe, it, expect } from "vitest";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { fixtureFileName } from "../src/llm/record-replay.ts";
import { judgeMustDetect, judgeAssertsClass, parseVerdict, JudgeParseError } from "../src/scorecard/judge.ts";

// These are PLUMBING tests (fake-canned verdicts). They prove the harness wires
// the verdict through and builds the prompt correctly — NOT that the real judge
// resists inflation/verbosity bias (that is the Unit 8 pilot's job).

const cannedJudge = (satisfied: boolean, rationale = "because") =>
  new FakeLlmClient(() => JSON.stringify({ satisfied, rationale }));

describe("judgeMustDetect (plumbing)", () => {
  it("returns the parsed verdict and asks about the given behavior", async () => {
    let prompt = "";
    const fake = new FakeLlmClient((req) => {
      prompt = req.prompt;
      return JSON.stringify({ satisfied: true, rationale: "names the exfil host" });
    });
    const v = await judgeMustDetect(
      "cookie values are sent to an external host (collect.evil-analytics-cdn.com)",
      "FINDING: cookies POSTed to collect.evil-analytics-cdn.com",
      fake,
      "m",
    );
    expect(v.satisfied).toBe(true);
    expect(v.rationale).toContain("exfil host");
    // Instruction precedes the untrusted methodology output block.
    expect(prompt.indexOf("BEHAVIOR TO CHECK")).toBeLessThan(prompt.indexOf("<methodology_output>"));
  });

  it("records a negative verdict (the CDN-is-not-exfil distinction is representable)", async () => {
    const v = await judgeMustDetect("exfil to an external host", "uses jsdelivr CDN for assets", cannedJudge(false, "only a legitimate CDN"), "m");
    expect(v.satisfied).toBe(false);
  });

  it("requests structured output (format: json) so unparseable completions are rare", async () => {
    const fake = cannedJudge(true);
    await judgeMustDetect("exfil", "FINDING: exfil", fake, "m");
    expect(fake.calls[0]!.params).toMatchObject({ format: "json" });
  });

  it("an unparseable completion names the fixture file to delete (RECORD poisons it)", async () => {
    const garbage = new FakeLlmClient(() => "no verdict here");
    await expect(judgeMustDetect("exfil", "output", garbage, "m")).rejects.toThrow(JudgeParseError);
    // The named file must be the exact one RecordReplayClient would have written.
    const expected = fixtureFileName(garbage.calls[0]!);
    await expect(judgeMustDetect("exfil", "output", garbage, "m")).rejects.toThrow(expected);
  });
});

describe("judgeAssertsClass (must_not_emit / false-alarm path)", () => {
  it("reports whether a finding class is asserted", async () => {
    const v = await judgeAssertsClass("data-exfiltration high-severity", "FINDING: exfiltrates cookies", cannedJudge(true), "m");
    expect(v.satisfied).toBe(true);
  });
});

describe("parseVerdict", () => {
  it("extracts a JSON verdict embedded in surrounding prose", () => {
    const v = parseVerdict('Sure. {"satisfied": false, "rationale": "vague mention only"} done');
    expect(v.satisfied).toBe(false);
    expect(v.rationale).toBe("vague mention only");
  });

  it("throws JudgeParseError on unparseable output", () => {
    expect(() => parseVerdict("maybe?")).toThrow(JudgeParseError);
  });

  it("picks the result object when the model emits scratch-pad JSON first (no crash)", () => {
    const v = parseVerdict('thinking: {"note":"scratch"} answer: {"satisfied": true, "rationale": "asserted"}');
    expect(v.satisfied).toBe(true);
    expect(v.rationale).toBe("asserted");
  });

  it("parses a verdict whose rationale quotes code containing braces", () => {
    // Real RECORD regression: the judge's rationale quoted `getAll({})`, whose
    // embedded braces defeated the old flat-object regex and crashed the run.
    const v = parseVerdict(
      '{"satisfied": true, "rationale": "asserts `chrome.cookies.getAll({})` sends to `fetch(...)`"}',
    );
    expect(v.satisfied).toBe(true);
    expect(v.rationale).toContain("getAll({})");
  });

  it("accepts a stringified boolean satisfied value", () => {
    expect(parseVerdict('{"satisfied":"true","rationale":"x"}').satisfied).toBe(true);
    expect(parseVerdict('{"satisfied":"false","rationale":"x"}').satisfied).toBe(false);
  });

  it("throws when satisfied is a non-boolean, non-true/false value", () => {
    expect(() => parseVerdict('{"satisfied":"maybe"}')).toThrow(JudgeParseError);
  });

  it("recovers the verdict when a stray unmatched { in prose precedes it", () => {
    // The stray { keeps the balanced walker at depth>0 forever, swallowing the
    // real object — the {"satisfied" rescue scan must still find it.
    const v = parseVerdict('the output mentions chrome.cookies.getAll( { ... so: {"satisfied": true, "rationale": "asserted"}');
    expect(v.satisfied).toBe(true);
    expect(v.rationale).toBe("asserted");
  });

  it("does not let a later malformed verdict-shaped object shadow an earlier valid verdict", () => {
    const v = parseVerdict('{"satisfied": false, "rationale": "valid earlier"} revised: {"satisfied": "maybe", "rationale": "junk"}');
    expect(v.satisfied).toBe(false);
    expect(v.rationale).toBe("valid earlier");
  });
});
