import { describe, it, expect } from "vitest";
import { computeMetrics, computeStability, STABILITY_SENTINEL, type JudgedRun } from "../src/scorecard/metrics.ts";
import type { Label, Tier } from "../src/scorecard/labels.ts";

const ZERO = { inputTokens: 0, outputTokens: 0 };

function mal(sample: string, pid: string, behaviors: string[], over: Partial<Label> = {}): Label {
  return {
    sample_id: sample, kind: "malicious", base_ref: "demo-cookie-manager", injected_pattern_id: pid,
    expected_tier: "high-risk", is_bellwether: ["B", "E", "G"].includes(pid),
    is_generalization_probe: pid === "H", source: { id: "s", version: "1" },
    must_detect: behaviors, cleared: null, must_not_emit: [], ...over,
  };
}
function ben(sample: string, mustNotEmit: string[]): Label {
  return {
    sample_id: sample, kind: "benign", base_ref: null, injected_pattern_id: null,
    expected_tier: "concerning", is_bellwether: false, is_generalization_probe: false,
    source: { id: "s", version: "1" }, must_detect: [], cleared: true, must_not_emit: mustNotEmit,
  };
}
function run(sample: string, tier: Tier, md: Array<[string, boolean]>, mne?: Array<[string, boolean]>): JudgedRun {
  return {
    sample, normalizedTier: tier, tierSource: "native",
    mustDetect: md.map(([behavior, satisfied]) => ({ behavior, satisfied, rationale: "" })),
    mustNotEmit: mne?.map(([cls, asserted]) => ({ class: cls, asserted, rationale: "" })),
    usage: ZERO,
  };
}
const labelMap = (...ls: Label[]) => new Map(ls.map((l) => [l.sample_id, l]));

describe("computeMetrics", () => {
  it("full detection → coverage 1.0, tier-recall 1.0, zero unsafe misses", () => {
    const labels = labelMap(mal("a", "A", ["exfil"]));
    const m = computeMetrics(labels, [run("a", "high-risk", [["exfil", true]])]);
    expect(m.totals.coverage_known_shapes).toBe(1);
    expect(m.totals.tier_recall).toBe(1);
    expect(m.totals.unsafe_misses).toBe(0);
  });

  it("F/G partial credit: 2 of 3 must_detect satisfied → coverage 2/3", () => {
    const labels = labelMap(mal("f", "F", ["x", "y", "z"]));
    const m = computeMetrics(labels, [run("f", "high-risk", [["x", true], ["y", true], ["z", false]])]);
    expect(m.per_sample[0]!.coverage).toBeCloseTo(2 / 3);
  });

  it("blanket-high-risk trap: perfect tier-recall but ~0 coverage, and NOT an unsafe miss", () => {
    const labels = labelMap(mal("a", "A", ["exfil"]), mal("c", "C", ["decoder"]));
    const m = computeMetrics(labels, [run("a", "high-risk", [["exfil", false]]), run("c", "high-risk", [["decoder", false]])]);
    expect(m.totals.tier_recall).toBe(1); // recall says "detected"
    expect(m.totals.coverage_known_shapes).toBe(0); // coverage says nothing was detected
    expect(m.totals.unsafe_misses).toBe(0); // high-risk tier is not a dismissal
  });

  it("coverage split: H lands in open_world, never folded into known-shapes", () => {
    const labels = labelMap(mal("a", "A", ["exfil"]), mal("h", "H", ["covert"]));
    const m = computeMetrics(labels, [run("a", "high-risk", [["exfil", true]]), run("h", "concerning", [["covert", true]])]);
    expect(m.totals.coverage_known_shapes).toBe(1); // only A
    expect(m.totals.coverage_open_world).toBe(1); // only H
    expect(m.generalization_H.detected).toBe(true);
  });

  it("benign false-alarm: asserting a must_not_emit class flips false_alarm and lists the sample", () => {
    const labels = labelMap(ben("etc", ["data-exfiltration high-severity"]));
    const m = computeMetrics(labels, [run("etc", "concerning", [], [["data-exfiltration high-severity", true]])]);
    expect(m.per_sample[0]!.false_alarm).toBe(true);
    expect(m.totals.false_alarm_samples).toEqual(["etc"]);
  });

  it("unsafe_misses sums confident-dismissals and hedged-misses", () => {
    const labels = labelMap(mal("a", "A", ["exfil"]), mal("c", "C", ["decoder"]));
    const m = computeMetrics(labels, [
      run("a", "clean", [["exfil", false]]), // confident-dismissal
      run("c", "inconclusive", [["decoder", false]]), // hedged-miss
    ]);
    expect(m.totals.false_dismissals).toBe(1);
    expect(m.totals.hedged_misses).toBe(1);
    expect(m.totals.unsafe_misses).toBe(2);
  });

  it("H tier-masking: concerning + ~0 coverage is flagged, tier-recall still credits it", () => {
    const labels = labelMap(mal("h", "H", ["covert"], { expected_tier: "concerning" }));
    const m = computeMetrics(labels, [run("h", "concerning", [["covert", false]])]);
    expect(m.per_sample[0]!.miss_kind).toBe("tier-correct-behavior-missed");
    expect(m.generalization_H.tier_masked).toBe(true);
    expect(m.totals.tier_recall).toBe(1); // concerning ≥ concerning
    expect(m.totals.unsafe_misses).toBe(0); // not a dismissal — surfaced via generalization
  });

  it("non-H malicious sample at concerning tier with 0 coverage is a hedged-miss", () => {
    const labels = labelMap(mal("a", "A", ["exfil"]));
    const m = computeMetrics(labels, [run("a", "concerning", [["exfil", false]])]);
    expect(m.per_sample[0]!.miss_kind).toBe("hedged-miss");
    expect(m.totals.hedged_misses).toBe(1);
    expect(m.totals.unsafe_misses).toBe(1);
  });

  it("bellwether: B/E/G coverage 0 sets per_arm_missed (never a product no_build)", () => {
    const labels = labelMap(mal("b", "B", ["tamper"]), mal("e", "E", ["crossfile"]));
    const m = computeMetrics(labels, [run("b", "concerning", [["tamper", false]]), run("e", "high-risk", [["crossfile", true]])]);
    expect(m.bellwether.B).toBe(0);
    expect(m.bellwether.E).toBe(1);
    expect(m.bellwether.per_arm_missed).toBe(true);
    expect(m.bellwether).not.toHaveProperty("no_build_flag");
  });

  it("--no-tier-recall omits tier_recall from totals", () => {
    const labels = labelMap(mal("a", "A", ["exfil"]));
    const m = computeMetrics(labels, [run("a", "high-risk", [["exfil", true]])], { tierRecall: false });
    expect(m.totals.tier_recall).toBeNull();
  });

  it("stability: sentinel unless measurable; identical runs → 1.0, a differing run → < 1.0", () => {
    const labels = labelMap(mal("a", "A", ["exfil"]));
    const replay = computeMetrics(labels, [run("a", "high-risk", [["exfil", true]])]);
    expect(replay.totals.stability).toBe(STABILITY_SENTINEL);

    const identical = new Map([["a", [run("a", "high-risk", [["exfil", true]]), run("a", "high-risk", [["exfil", true]])]]]);
    expect(computeStability(identical)).toBe(1);
    const differing = new Map([["a", [run("a", "high-risk", [["exfil", true]]), run("a", "clean", [["exfil", false]])]]]);
    expect(computeStability(differing)).toBeLessThan(1);
  });
});
