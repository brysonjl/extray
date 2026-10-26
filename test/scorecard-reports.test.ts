import { describe, it, expect } from "vitest";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { createMonolith } from "../src/methodologies/monolith.ts";
import { PINNED_ANALYZED_AT, ScorecardError } from "../src/scorecard/index.ts";
import { analyzeCorpus } from "../scripts/analyze-corpus.ts";
import { generateReports, renderReportJson, renderReportMarkdown } from "../src/scorecard/reports.ts";

// Analyze the corpus ONCE and inject the packs so each call doesn't re-run the
// pipeline (~6s).
const packs = new Map(
  analyzeCorpus("corpus", { analyzedAt: PINNED_ANALYZED_AT }).filter((r) => r.valid).map((r) => [r.sample, r.pack] as const),
);

const fakeMonolith = new FakeLlmClient((req) => {
  if (req.label === "monolith") {
    return JSON.stringify({
      summary: "A cookie manager.",
      overall_risk: "high",
      findings: [
        {
          id: "f1",
          title: "Cookie exfiltration",
          claim_type: "inferred-behavior",
          confidence: "high",
          claimed_mechanism: "exfiltrates cookies to an external host",
          evidence_refs: [{ file: "manifest.json", location: null, symbol: null, sink_or_string: null }],
          detail: "FINDING: exfiltrates cookies to an external host.",
        },
      ],
    });
  }
  // The arm's claim-verifier post-pass is part of the methodology, not judging.
  if (req.label === "verify:claim") {
    return JSON.stringify({ verdict: "confirmed", grounding_line: { file: "manifest.json", line: 1 }, rationale: "ok", evidence_quote: "…" });
  }
  // So is the synthesis post-pass (verdict + summaries over the asserted set).
  if (req.label === "synthesize") {
    return JSON.stringify({
      layperson_summary: "lay",
      technical_summary: "tech",
      tier: "high-risk",
      tier_rationale: "because",
      per_area: [],
      description_deviation: { deviates: null, note: "" },
    });
  }
  throw new Error(`reports should only call the methodology, not "${req.label}"`);
});

describe("generateReports", () => {
  it("emits one report per labeled sample with raw text + metadata (no judging)", async () => {
    const reports = await generateReports(createMonolith("fake-model"), { client: fakeMonolith, packs });
    expect(reports.length).toBe(11);
    const a = reports.find((r) => r.sample === "mutant-a-exfil-fetch")!;
    expect(a.methodology).toBe("monolith");
    expect(a.model).toBe("fake-model");
    expect(a.kind).toBe("malicious");
    expect(a.report).toContain("FINDING:");
    expect(a.usage).toBeDefined();
    // The benign sample carries its expected tier through.
    const benign = reports.find((r) => r.sample === "demo-cookie-manager")!;
    expect(benign.kind).toBe("benign");
    expect(benign.expected_tier).toBeTruthy();
  });

  it("pre-flights: a labeled sample with no pack fails loudly before any LLM call", async () => {
    const partial = new Map(packs);
    partial.delete("mutant-a-exfil-fetch");
    await expect(generateReports(createMonolith("m"), { client: fakeMonolith, packs: partial })).rejects.toBeInstanceOf(ScorecardError);
  });
});

describe("report renderers", () => {
  const sample = {
    sample: "mutant-a-exfil-fetch",
    kind: "malicious" as const,
    expected_tier: "high-risk" as const,
    methodology: "monolith",
    model: "fake-model",
    report: "# Security Assessment\n\nFINDING: exfil.",
    usage: { inputTokens: 100, outputTokens: 20 },
  };

  it("JSON is round-trippable and preserves the report text", () => {
    const parsed = JSON.parse(renderReportJson(sample));
    expect(parsed.sample).toBe("mutant-a-exfil-fetch");
    expect(parsed.report).toBe(sample.report);
    expect(parsed.usage.outputTokens).toBe(20);
  });

  it("Markdown carries a provenance header and the raw report body", () => {
    const md = renderReportMarkdown(sample);
    expect(md).toContain("**mutant-a-exfil-fetch**");
    expect(md).toContain("`monolith`");
    expect(md).toContain("expected tier `high-risk`");
    expect(md).toContain("FINDING: exfil.");
  });
});
