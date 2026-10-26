// Unit coverage for the SHARDED Pi arm's pure, non-live surface: shard-mode
// detection, per-dimension model resolution (the tiered-fan-out knob), the
// usage-merge that splits main vs subagent tokens without losing the reconciliation
// to the report aggregate, and the aborted-shard salvage / incompleteness marker
// (018 follow-up: wind-down decision, salvage provenance, uncovered-dimension
// detection, and the clean/low-risk→inconclusive tier override). The live Pi
// sessions themselves are exercised by `npm run assess --methodology pi` against
// Ollama Cloud, not here.

import { describe, it, expect } from "vitest";
import { adjustTierForGaps, capableFloorWarnings, effectiveSubagentModels, isSharded } from "../src/methodologies/pi/index.ts";
import {
  DIMENSIONS,
  buildInstructions,
  buildShardInstructions,
  buildSynthesisInstructions,
  classifySalvage,
  commitSubmission,
  shouldWindDown,
  uncoveredDimensions,
  type Collected,
  type Dimension,
  type RawFinding,
} from "../src/methodologies/pi/runner.ts";
import { TIERS } from "../src/report/contract.ts";
import type { Dismissal } from "../src/methodologies/dag/node.ts";
import { UsageTracker } from "../src/llm/usage.ts";
import type { LlmClient, LlmRequest, LlmResponse } from "../src/llm/client.ts";

describe("pi sharded fan-out", () => {
  it("isSharded: monolith by default, sharded on any shard/tier knob", () => {
    expect(isSharded({})).toBe(false);
    expect(isSharded({ verifierModel: "x" })).toBe(false); // unrelated knob
    expect(isSharded({ shard: true })).toBe(true);
    expect(isSharded({ subagentModel: "m" })).toBe(true);
    expect(isSharded({ subagentModels: { exfiltration: "m" } })).toBe(true);
    expect(isSharded({ synthesisModel: "m" })).toBe(true);
  });

  it("effectiveSubagentModels: a general subagent model tiers the whole fleet but leaves synthesis on the primary", () => {
    const map = effectiveSubagentModels("primary:cloud", { subagentModel: "cheap:cloud" });
    for (const dim of DIMENSIONS) expect(map[dim]).toBe("cheap:cloud");
    expect(map.synthesis).toBe("primary:cloud"); // general subagent model does NOT cheapen synthesis
  });

  it("effectiveSubagentModels: precedence is per-dimension > general subagent model > primary", () => {
    const map = effectiveSubagentModels("primary:cloud", {
      subagentModel: "cheap:cloud",
      subagentModels: { exfiltration: "glm-5.2:cloud" },
    });
    expect(map.exfiltration).toBe("glm-5.2:cloud"); // per-dimension wins
    expect(map.obfuscation).toBe("cheap:cloud"); // general default
    expect(map["code-execution"]).toBe("cheap:cloud");
  });

  it("effectiveSubagentModels: unspecified dimensions fall back to the primary (capable) model", () => {
    const map = effectiveSubagentModels("primary:cloud", { subagentModels: { obfuscation: "cheap:cloud" } });
    expect(map.obfuscation).toBe("cheap:cloud");
    // every other dimension stays on the primary model — default fan-out cannot regress recall
    for (const dim of DIMENSIONS) {
      if (dim !== "obfuscation") expect(map[dim]).toBe("primary:cloud");
    }
    // synthesis defaults to the primary model too
    expect(map.synthesis).toBe("primary:cloud");
  });

  // Improvement 016, fix 3 — sharding without per-dimension overrides silently
  // runs the high-signal dimensions on the general subagent model, defeating the
  // "capable on exfil/code-exec" intent runner.ts documents.
  it("capableFloorWarnings: warns when exfil/code-exec are downtiered by the general fallback", () => {
    const warnings = capableFloorWarnings("primary:cloud", { subagentModel: "cheap:cloud" });
    expect(warnings).toHaveLength(2);
    expect(warnings.join("\n")).toContain("exfiltration");
    expect(warnings.join("\n")).toContain("code-execution");
    expect(warnings.join("\n")).toContain("cheap:cloud");
  });

  it("capableFloorWarnings: silent when both high-signal dimensions are explicitly assigned", () => {
    const warnings = capableFloorWarnings("primary:cloud", {
      subagentModel: "cheap:cloud",
      subagentModels: { exfiltration: "glm-5.2:cloud", "code-execution": "glm-5.2:cloud" },
    });
    expect(warnings).toEqual([]);
  });

  it("capableFloorWarnings: warns only for the dimension left on the general fallback", () => {
    const warnings = capableFloorWarnings("primary:cloud", {
      subagentModel: "cheap:cloud",
      subagentModels: { exfiltration: "glm-5.2:cloud" },
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("code-execution");
  });

  it("capableFloorWarnings: silent when no general downtiering happens (dims stay on primary)", () => {
    // Only an unrelated dimension is tiered; exfil/code-exec resolve to the primary model.
    expect(capableFloorWarnings("primary:cloud", { subagentModels: { obfuscation: "cheap:cloud" } })).toEqual([]);
    expect(capableFloorWarnings("primary:cloud", { shard: true })).toEqual([]);
  });

  it("effectiveSubagentModels: explicit synthesis + exfil/code-exec overrides are honored", () => {
    const map = effectiveSubagentModels("base:cloud", {
      subagentModels: { exfiltration: "glm-5.2:cloud", "code-execution": "glm-5.2:cloud" },
      synthesisModel: "qwen3.5:cloud",
    });
    expect(map.exfiltration).toBe("glm-5.2:cloud");
    expect(map["code-execution"]).toBe("glm-5.2:cloud");
    expect(map.synthesis).toBe("qwen3.5:cloud");
    expect(map["permission-justification"]).toBe("base:cloud");
  });

  // Improvement 016, fix 4 — the pack-on/pack-off A/B lever. Pack-off must strip
  // BOTH channels the pack reaches the agent: the <orientation> block and the
  // read_pack tool (verified here on the instructions; the tool omission is
  // wired alongside in the runner).
  describe("pack-off instructions (noPack)", () => {
    const ORIENT = "UNIQUE_ORIENTATION_MARKER_42";

    it("monolith: pack-on embeds the orientation + read_pack; pack-off strips both", () => {
      const on = buildInstructions(ORIENT); // default noPack=false
      expect(on).toContain("<orientation>");
      expect(on).toContain(ORIENT);
      expect(on).toContain("read_pack");

      const off = buildInstructions(ORIENT, true);
      expect(off).not.toContain("<orientation>");
      expect(off).not.toContain(ORIENT);
      expect(off).not.toContain("read_pack");
      expect(off).toContain("No static-analysis map"); // cold-exploration note
    });

    it("shard: pack-off strips the orientation + read_pack for a dimension shard", () => {
      const on = buildShardInstructions(ORIENT, "exfiltration");
      expect(on).toContain(ORIENT);
      expect(on).toContain("read_pack");

      const off = buildShardInstructions(ORIENT, "exfiltration", true);
      expect(off).not.toContain(ORIENT);
      expect(off).not.toContain("read_pack");
      // the dimension scope survives pack-off
      expect(off).toContain("SCOPED to ONE dimension only: exfiltration");
    });

    it("synthesis: pack-off strips the orientation + read_pack but keeps shard context", () => {
      const on = buildSynthesisInstructions(ORIENT, "SHARD_DIGEST", ["a.js"]);
      expect(on).toContain(ORIENT);
      expect(on).toContain("read_pack");

      const off = buildSynthesisInstructions(ORIENT, "SHARD_DIGEST", ["a.js"], true);
      expect(off).not.toContain(ORIENT);
      expect(off).not.toContain("read_pack");
      // the cross-dimension inputs (not from the pack) still flow in
      expect(off).toContain("SHARD_DIGEST");
      expect(off).toContain("a.js");
    });
  });

  describe("synthesis coverage backstop (uncovered dimensions handed to the capable pass)", () => {
    const ORIENT = "ORIENT_MARKER";

    it("names each shard-level gap and gives the finding/dismissal/leave directive", () => {
      const out = buildSynthesisInstructions(ORIENT, "DIGEST", ["a.js"], false, [
        "stated-purpose-deviation",
        "obfuscation",
      ]);
      expect(out).toContain("COVERAGE GAPS");
      expect(out).toContain("stated-purpose-deviation");
      expect(out).toContain("obfuscation");
      // the three sanctioned resolutions — resolve with a finding, a named dismissal, or leave it
      expect(out).toContain("add a finding");
      expect(out).toContain("begins with the dimension name");
      expect(out).toContain("leave it unresolved");
      // recall-safety: an unresolvable gap is reported uninvestigated, never rubber-stamped clean
      expect(out).toContain("do not guess");
    });

    it("emits no coverage-gap directive when the shards covered everything (default empty)", () => {
      const clean = buildSynthesisInstructions(ORIENT, "DIGEST", ["a.js"]);
      expect(clean).not.toContain("COVERAGE GAPS");
      // and explicitly-empty behaves the same as the default
      const explicitEmpty = buildSynthesisInstructions(ORIENT, "DIGEST", ["a.js"], false, []);
      expect(explicitEmpty).not.toContain("COVERAGE GAPS");
    });
  });

  it("UsageTracker.addExternal: Pi-pass tokens merge into per-step accounting and still reconcile", () => {
    // A stub client whose every call reports fixed usage (the in-band steps:
    // verify:claim + synthesize go through the tracker).
    const stub: LlmClient = {
      async complete(_req: LlmRequest): Promise<LlmResponse> {
        return { text: "{}", usage: { inputTokens: 100, outputTokens: 10 }, raw: {} } as LlmResponse;
      },
    };
    const tracker = new UsageTracker(stub);
    return (async () => {
      await tracker.complete({ label: "verify:claim", model: "v", prompt: "", params: {} } as LlmRequest);
      await tracker.complete({ label: "synthesize", model: "v", prompt: "", params: {} } as LlmRequest);
      // Pi generation passes bypass the client — folded in out-of-band:
      tracker.addExternal({ label: "pi:gen:exfiltration", model: "glm-5.2:cloud", inputTokens: 5000, outputTokens: 400 });
      tracker.addExternal({ label: "pi:gen:synthesis", model: "qwen3.5:cloud", inputTokens: 3000, outputTokens: 200 });

      const summary = tracker.summary();
      const labels = summary.entries.map((e) => e.label).sort();
      expect(labels).toEqual(["pi:gen:exfiltration", "pi:gen:synthesis", "synthesize", "verify:claim"]);
      // The split sums back to the run aggregate: 2×(100/10) in-band + the two Pi passes.
      expect(summary.totals.inputTokens).toBe(100 + 100 + 5000 + 3000);
      expect(summary.totals.outputTokens).toBe(10 + 10 + 400 + 200);
      // a re-added external label aggregates rather than duplicating
      tracker.addExternal({ label: "pi:gen:exfiltration", model: "glm-5.2:cloud", inputTokens: 1, outputTokens: 1 });
      const exfil = tracker.breakdown().find((e) => e.label === "pi:gen:exfiltration")!;
      expect(exfil.inputTokens).toBe(5001);
      expect(exfil.calls).toBe(2);
    })();
  });
});

// ---- aborted-shard salvage + incompleteness marker (018 follow-up) ----------

const raw = (category: string): RawFinding => ({
  title: "t",
  claim_type: "observed-capability",
  severity: "low",
  category,
  confidence: "low",
  finding_type: "unknown",
  claimed_mechanism: "",
  evidence_refs: [],
  detail: "",
});
const dismiss = (concern: string): Dismissal => ({ concern, checks_run: ["grep"], note: "clean" });
const shard = (dimension: Dimension, submitted: boolean) => ({ dimension, submitted });

describe("pi aborted-shard salvage", () => {
  describe("shouldWindDown", () => {
    it("fires on a turn-ceiling abort with no valid submission", () => {
      expect(shouldWindDown(false, "turn-ceiling")).toBe(true);
    });

    it("fires when the model just stopped without submitting (no abort at all)", () => {
      expect(shouldWindDown(false, null)).toBe(true);
    });

    it("never fires once a valid submission landed", () => {
      expect(shouldWindDown(true, null)).toBe(false);
      expect(shouldWindDown(true, "turn-ceiling")).toBe(false);
    });

    it("submit-ceiling aborts are exempt — invalid-submit runaways fail fast", () => {
      expect(shouldWindDown(false, "submit-ceiling")).toBe(false);
    });
  });

  describe("classifySalvage", () => {
    it("clean submission → none (no salvage needed)", () => {
      expect(classifySalvage({ submitted: true, submittedViaWindDown: false, hasRejectedWork: true })).toBe("none");
    });

    it("submission forced by the wind-down re-prompt → wind-down", () => {
      expect(classifySalvage({ submitted: true, submittedViaWindDown: true, hasRejectedWork: false })).toBe("wind-down");
    });

    it("never submitted but a rejected execute() left work behind → submit-rejected", () => {
      expect(classifySalvage({ submitted: false, submittedViaWindDown: false, hasRejectedWork: true })).toBe("submit-rejected");
    });

    it("never submitted, nothing collected → none (the pre-salvage empty behavior)", () => {
      expect(classifySalvage({ submitted: false, submittedViaWindDown: false, hasRejectedWork: false })).toBe("none");
    });
  });

  describe("uncoveredDimensions", () => {
    it("a dead shard whose dimension nothing else covers is uncovered", () => {
      const shards = [shard("exfiltration", false), shard("obfuscation", true)];
      expect(uncoveredDimensions(shards, [], [])).toEqual(["exfiltration"]);
    });

    it("covered-by-merge: a category-matching finding from any pass clears the gap", () => {
      // synthesis (or a sibling shard) produced an exfiltration-category finding —
      // the dimension WAS investigated even though its own shard died
      const shards = [shard("exfiltration", false)];
      expect(uncoveredDimensions(shards, [raw("data-exfiltration")], [])).toEqual([]);
      // any category mapped to the dimension counts, not just the namesake one
      expect(uncoveredDimensions(shards, [raw("remote-resources")], [])).toEqual([]);
    });

    it("a finding in an UNRELATED category does not clear the gap", () => {
      const shards = [shard("exfiltration", false)];
      expect(uncoveredDimensions(shards, [raw("obfuscation")], [])).toEqual(["exfiltration"]);
    });

    it("dismissal matching: a dimension-named dismissal from the merge clears the gap", () => {
      const shards = [shard("code-execution", false)];
      expect(uncoveredDimensions(shards, [], [dismiss("code-execution: no eval, no remote scripts")])).toEqual([]);
      // an unrelated dimension's dismissal does not
      expect(uncoveredDimensions(shards, [], [dismiss("obfuscation: source is readable")])).toEqual(["code-execution"]);
    });

    it("submitted shards are never uncovered; all-dead-no-output marks every dimension (run 452)", () => {
      // a shard that submitted is covered by construction (its own coverage floor)
      expect(uncoveredDimensions([shard("obfuscation", true)], [], [])).toEqual([]);
      // run 452: ALL FIVE shards aborted with zero submissions → every dimension uncovered
      const dead = DIMENSIONS.map((d) => shard(d, false));
      expect(uncoveredDimensions(dead, [], [])).toEqual([...DIMENSIONS]);
    });
  });

  describe("adjustTierForGaps", () => {
    const GAPS = ["exfiltration", "code-execution"];

    it("withholds clean and low-risk → inconclusive, naming the gaps and the withholding", () => {
      for (const tier of ["clean", "low-risk"] as const) {
        const adj = adjustTierForGaps(tier, GAPS);
        expect(adj).not.toBeNull();
        expect(adj!.tier).toBe("inconclusive");
        expect(adj!.note).toContain("exfiltration");
        expect(adj!.note).toContain("code-execution");
        expect(adj!.note.toLowerCase()).toContain("withheld");
        expect(adj!.note.toLowerCase()).toContain("not cleared");
      }
    });

    it("NEVER touches concerning/high-risk/inconclusive — a confirmed finding stands (recall-safety)", () => {
      for (const tier of ["concerning", "high-risk", "inconclusive"] as const) {
        expect(adjustTierForGaps(tier, GAPS)).toBeNull();
      }
    });

    it("empty gaps → null for every tier (a complete run is untouched)", () => {
      for (const tier of TIERS) expect(adjustTierForGaps(tier, [])).toBeNull();
    });
  });

  describe("commitSubmission (wind-down must never net-lose findings)", () => {
    const raw = (title: string) => ({ title, category: "data-exfiltration", severity: "medium", confidence: "medium", claim_type: "observed-capability", finding_type: "unknown", evidence_refs: [], detail: "" }) as unknown as RawFinding;
    const fresh = (): Collected => ({ summary: "s0", findings: [raw("A"), raw("B"), raw("C")], dismissals: [], submitted: false });

    it("a REJECTED lossy resubmission does not overwrite a richer earlier attempt", () => {
      const c = fresh();
      commitSubmission(c, "s1", [raw("A")], [], false); // wind-down resubmits a subset, still rejected
      expect(c.findings.map((f) => f.title)).toEqual(["A", "B", "C"]); // richer prior set retained
    });

    it("a REJECTED equal-or-richer resubmission replaces the prior attempt", () => {
      const c = fresh();
      commitSubmission(c, "s1", [raw("A"), raw("B"), raw("C"), raw("D")], [], false);
      expect(c.findings).toHaveLength(4);
    });

    it("an ACCEPTED submission is always authoritative, even if smaller", () => {
      const c = fresh();
      commitSubmission(c, "s1", [raw("A")], [], true); // coverage/critic passed
      expect(c.findings.map((f) => f.title)).toEqual(["A"]);
    });
  });
});
