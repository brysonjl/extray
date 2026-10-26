import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlmClient, type FakeResponder } from "../src/llm/fake.ts";
import { RecordReplayClient, fixtureKey } from "../src/llm/record-replay.ts";
import { createMonolith } from "../src/methodologies/monolith.ts";
import { runScorecard, ScorecardError, PINNED_ANALYZED_AT } from "../src/scorecard/index.ts";
import { renderMarkdown, renderJson } from "../src/scorecard/report.ts";
import { analyzeCorpus } from "../scripts/analyze-corpus.ts";

// Analyze the corpus ONCE and inject the packs so each runScorecard call doesn't
// re-run the pipeline (~6s).
const packs = new Map(
  analyzeCorpus("corpus", { analyzedAt: PINNED_ANALYZED_AT }).filter((r) => r.valid).map((r) => [r.sample, r.pack] as const),
);

// A fake that drives a full run: monolith asserts malice (as a structured
// behavioral finding citing manifest.json, which exists in every sample, so the
// claim is grounded and verified), the verifier confirms, judge confirms every
// behavior, benign asserts no forbidden class, normalizer rates high-risk.
const MONOLITH_FINDINGS = JSON.stringify({
  summary: "A cookie manager with exfiltration behavior.",
  overall_risk: "high",
  findings: [
    {
      id: "f1",
      title: "Cookie exfiltration",
      claim_type: "inferred-behavior",
      confidence: "high",
      claimed_mechanism: "exfiltrates cookies to an external host and runs an obfuscated decoder",
      evidence_refs: [{ file: "manifest.json", location: null, symbol: null, sink_or_string: null }],
      detail: "FINDING: the extension exfiltrates cookies to an external host and runs an obfuscated decoder.",
    },
  ],
});
const respondFullDetect: FakeResponder = (req) => {
  switch (req.label) {
    case "monolith":
      return MONOLITH_FINDINGS;
    case "verify:claim":
      return JSON.stringify({ verdict: "confirmed", grounding_line: { file: "manifest.json", line: 1 }, rationale: "implemented as claimed", evidence_quote: "…" });
    case "synthesize":
      return JSON.stringify({
        layperson_summary: "It exfiltrates cookies.",
        technical_summary: "Verified exfiltration (finding 1).",
        tier: "high-risk",
        tier_rationale: "verified exfiltration",
        per_area: [],
        description_deviation: { deviates: null, note: "" },
      });
    case "judge:must_detect":
      return JSON.stringify({ satisfied: true, rationale: "the output asserts this behavior" });
    case "judge:must_not_emit":
      return JSON.stringify({ satisfied: false, rationale: "no such finding asserted" });
    case "normalize:tier":
      return JSON.stringify({ tier: "high-risk" });
    default:
      throw new Error(`unexpected label ${req.label}`);
  }
};
const fullDetect = new FakeLlmClient(respondFullDetect);

afterEach(() => vi.restoreAllMocks());

describe("runScorecard (full run via fake client)", () => {
  it("produces a ScorecardResult over all 11 samples with split coverage", async () => {
    const result = await runScorecard(createMonolith("fake-model"), { client: fullDetect, packs, judgeModel: "fake-judge" });
    expect(result.per_sample.length).toBe(11);
    expect(result.totals.coverage_known_shapes).toBe(1); // A–G all detected
    expect(result.totals.coverage_open_world).toBe(1); // H detected separately
    expect(result.totals.unsafe_misses).toBe(0);
    expect(result.bellwether.per_arm_missed).toBe(false);
    expect(result.generalization_H.detected).toBe(true);
    expect(result.methodology).toBe("monolith");
    expect(result.caveats.length).toBeGreaterThan(0);
  });

  it("pre-flight throws ScorecardError (before any LLM call) when a labeled sample has no pack", async () => {
    const partial = new Map(packs);
    partial.delete("mutant-e-crossfile-flow");
    await expect(runScorecard(createMonolith("fake-model"), { client: fullDetect, packs: partial, judgeModel: "fake-judge" })).rejects.toBeInstanceOf(ScorecardError);
  });

  it("--no-tier-recall omits tier-recall", async () => {
    const result = await runScorecard(createMonolith("fake-model"), { client: fullDetect, tierRecall: false, packs, judgeModel: "fake-judge" });
    expect(result.totals.tier_recall).toBeNull();
  });

  it("accounts every LLM call by (step, model) — including judge/normalize, closing the documented undercount", async () => {
    const fake = new FakeLlmClient(respondFullDetect);
    const result = await runScorecard(createMonolith("fake-model"), {
      client: fake,
      packs,
      judgeModel: "fake-judge",
      costRates: { "fake-model": { input: 1, output: 2 }, "fake-judge": { input: 10, output: 20 } },
    });
    const byStep = new Map(result.accounting.entries.map((e) => [`${e.label} ${e.model}`, e]));
    // The arm's steps run on the arm model; grading steps on the judge model.
    expect(byStep.get("monolith fake-model")!.calls).toBe(11);
    expect(byStep.get("verify:claim fake-model")!.calls).toBe(11); // one grounded behavioral claim per sample
    expect(byStep.get("synthesize fake-model")!.calls).toBe(11); // humanization runs once per sample
    expect(byStep.get("judge:must_detect fake-judge")!.calls).toBeGreaterThan(0);
    // The monolith emits a NATIVE deterministic tier, so the neutral normalizer
    // is never called — tier-recall grades out.tier directly (no LLM, no cost).
    expect(byStep.has("normalize:tier fake-judge")).toBe(false);
    // Totals cover ALL calls the fake saw, exactly once each.
    expect(result.accounting.totals.calls).toBe(fake.calls.length);
    expect(result.accounting.estimatedUsd).not.toBeNull();
    expect(result.accounting.uncostedModels).toEqual([]);
    // The rendered scorecard carries the per-step table.
    const md = renderMarkdown(result);
    expect(md).toContain("## Run accounting (tokens & cost by step)");
    expect(md).toContain("| monolith | fake-model | 11 |");
    expect(md).toContain("est. full-run cost (USD)");
  });

  it("Markdown renders both coverage figures, the per-arm bellwether line, unsafe misses, H, caveats, and quoted rationale", async () => {
    const result = await runScorecard(createMonolith("fake-model"), { client: fullDetect, packs, judgeModel: "fake-judge" });
    const md = renderMarkdown(result);
    expect(md).toContain("coverage — known shapes (A–G)");
    expect(md).toContain("coverage — open world (H)");
    expect(md).toContain("Bellwether (per-arm — NOT a product no-build verdict)");
    expect(md).toContain("unsafe misses");
    expect(md).toContain("Generalization probe (H)");
    expect(md).toContain("Caveats");
    expect(md).toContain("> _judge:_"); // rationale rendered as a quoted/provenance block
    expect(md).not.toContain("no_build");
    expect(JSON.parse(renderJson(result)).totals).toBeDefined();
  });
});

describe("runScorecard — independent judge model (improvement 002)", () => {
  it("uses judgeModel for judge + normalize calls, records it, and renders it", async () => {
    const fake = new FakeLlmClient(respondFullDetect);
    const result = await runScorecard(createMonolith("fake-model"), { client: fake, packs, judgeModel: "fake-judge" });
    const ARM_LABELS = ["monolith", "verify:claim", "synthesize"];
    const graderCalls = fake.calls.filter((c) => !ARM_LABELS.includes(c.label));
    expect(graderCalls.length).toBeGreaterThan(0);
    expect(graderCalls.every((c) => c.model === "fake-judge")).toBe(true);
    // The arm's own calls (generation, claim-verifier, synthesis) stay on the arm model.
    expect(fake.calls.filter((c) => ARM_LABELS.includes(c.label)).every((c) => c.model === "fake-model")).toBe(true);
    expect(result.judge_model).toBe("fake-judge");
    expect(renderMarkdown(result)).toContain("judge: fake-judge");
    expect(JSON.parse(renderJson(result)).judge_model).toBe("fake-judge");
  });

  it("warns loudly when the judge model is the arm's own model (default or explicit)", async () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const result = await runScorecard(createMonolith("fake-model"), { client: fullDetect, packs });
    expect(result.judge_model).toBe("fake-model"); // defaulted to the arm's model
    expect(write).toHaveBeenCalledWith(expect.stringMatching(/WARNING.*judge model/i));
  });

  it("does not warn when judgeModel differs from the arm's model", async () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await runScorecard(createMonolith("fake-model"), { client: fullDetect, packs, judgeModel: "fake-judge" });
    expect(write).not.toHaveBeenCalled();
  });
});

describe("runScorecard — run-indexed fixtures (improvement 003)", () => {
  it("runs=1 keeps the request free of a run param (committed single-run fixture keys stay stable)", async () => {
    const fake = new FakeLlmClient(respondFullDetect);
    await runScorecard(createMonolith("fake-model"), { client: fake, packs, judgeModel: "fake-judge" });
    expect(fake.calls.every((c) => !("run" in (c.params ?? {})))).toBe(true);
  });

  it("N runs produce N distinct fixture keys per sample for the methodology call", async () => {
    const fake = new FakeLlmClient(respondFullDetect);
    await runScorecard(createMonolith("fake-model"), { client: fake, packs, runs: 3, judgeModel: "fake-judge" });
    const monolith = fake.calls.filter((c) => c.label === "monolith");
    expect(monolith.length).toBe(11 * 3);
    const bySample = new Map<string, Set<string>>();
    for (const c of monolith) {
      if (!bySample.has(c.prompt)) bySample.set(c.prompt, new Set());
      bySample.get(c.prompt)!.add(fixtureKey(c));
    }
    for (const keys of bySample.values()) expect(keys.size).toBe(3); // distinct key per run
  });

  it("RECORD with runs=2 persists 2 distinct monolith fixtures per sample (no record-on-miss replay)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fixtures-"));
    const live = new FakeLlmClient(respondFullDetect);
    const recorder = new RecordReplayClient({ mode: "RECORD", fixtureDir: dir, wrapped: live });
    await runScorecard(createMonolith("fake-model"), { client: recorder, packs, runs: 2, judgeModel: "fake-judge" });
    const monolithFixtures = readdirSync(dir).filter((f) => f.startsWith("monolith-"));
    expect(monolithFixtures.length).toBe(11 * 2);
  });
});
