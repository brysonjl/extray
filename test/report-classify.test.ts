import { describe, it, expect } from "vitest";
import { auditIocConsistency, classifyFindings, rewriteIdReferences } from "../src/report/classify.ts";
import type { Finding, FindingsReport, RefResolution } from "../src/methodologies/findings.ts";
import type { VerificationResult, VerifierVerdict } from "../src/methodologies/claim-verifier.ts";

const ref = (file: string) => ({ file, location: null, symbol: null, sink_or_string: null });

const finding = (id: string, over: Partial<Finding> = {}): Finding => ({
  id,
  title: `Finding ${id}`,
  claim_type: "inferred-behavior",
  severity: "medium",
  category: "other",
  finding_type: "unknown",
  confidence: "medium",
  claimed_mechanism: `mechanism of ${id}`,
  evidence_refs: [ref("a.js")],
  detail: `detail of ${id}`,
  ...over,
});

const verdict = (id: string, v: VerifierVerdict["verdict"], over: Partial<VerifierVerdict> = {}): VerifierVerdict => ({
  claim_id: id,
  verdict: v,
  grounding_line: { file: "a.js", line: 12 },
  rationale: `because ${v}`,
  evidence_quote: `quote-for-${id}`,
  harm_supported: null,
  harm_rationale: "",
  corrected_facts: [],
  ...over,
});

const grounded: RefResolution = { resolved: [ref("a.js")], unresolved: [] };
const ungrounded: RefResolution = { resolved: [], unresolved: [ref("ghost.js")] };

function classify(findings: Finding[], verdicts: VerifierVerdict[], resolutions?: Map<string, RefResolution>) {
  const result: VerificationResult = {
    resolutions: resolutions ?? new Map(findings.map((f) => [f.id, grounded])),
    verdicts: new Map(verdicts.map((v) => [v.claim_id, v])),
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const report: FindingsReport = { summary: "the summary", overall_risk: "the risk line", findings };
  return classifyFindings(report, result);
}

describe("classifyFindings promotion rules", () => {
  it("promotes a confirmed behavioral claim with grounding and quote", () => {
    const { findings, excluded } = classify([finding("f1")], [verdict("f1", "confirmed")]);
    expect(findings).toHaveLength(1);
    expect(excluded).toHaveLength(0);
    expect(findings[0]).toMatchObject({
      number: 1,
      kind: "verified-behavior",
      verification: { verdict: "confirmed", grounding: { file: "a.js", line: 12 }, evidence_quote: "quote-for-f1" },
    });
  });

  it("asserts observed-capability findings without any verdict, numbered after verified behaviors", () => {
    const { findings } = classify(
      [finding("cap", { claim_type: "observed-capability", claimed_mechanism: "" }), finding("beh")],
      [verdict("beh", "confirmed")],
    );
    expect(findings.map((f) => [f.number, f.id, f.kind])).toEqual([
      [1, "beh", "verified-behavior"],
      [2, "cap", "observed-capability"],
    ]);
    expect(findings[1]!.verification).toBeNull();
    expect(findings[1]!.claimed_mechanism).toBeNull();
  });

  it("demotes a refuted claim with the refuting evidence — recorded, never dropped", () => {
    const { findings, excluded } = classify([finding("f1")], [verdict("f1", "refuted")]);
    expect(findings).toHaveLength(0);
    expect(excluded).toHaveLength(1);
    expect(excluded[0]).toMatchObject({ reason: "refuted", verifier_quote: "quote-for-f1" });
  });

  it("maps needs-dynamic / inconclusive / verdict-less claims to their exclusion reasons", () => {
    const { excluded } = classify(
      [finding("f1"), finding("f2"), finding("f3")],
      [verdict("f1", "needs-dynamic"), verdict("f2", "inconclusive")],
    );
    // f2 is finding_type "unknown" (the helper default) → inconclusive stays excluded.
    expect(excluded.map((e) => [e.id, e.reason])).toEqual([
      ["f1", "needs-dynamic"],
      ["f2", "inconclusive"],
      ["f3", "not-verified"],
    ]);
  });

  it("retains an inconclusive CONCERN (a real surface) as a low-confidence observed capability, not an exclusion", () => {
    const surface = finding("f1", { finding_type: "vulnerability", category: "messaging-surface" });
    const { findings, excluded } = classify([surface], [verdict("f1", "inconclusive")]);
    expect(excluded).toHaveLength(0);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ id: "f1", kind: "observed-capability", confidence: "low", verification: null });
    // the causal mechanism it asserts is preserved for the reader (its own id
    // token is rewritten to the reader-visible number, as for any finding)
    expect(findings[0]!.claimed_mechanism).toContain("mechanism of finding 1");
  });

  it("still excludes an inconclusive BENIGN/unknown claim (noise, not a surface)", () => {
    const { findings, excluded } = classify([finding("f1", { finding_type: "benign" })], [verdict("f1", "inconclusive")]);
    expect(findings).toHaveLength(0);
    expect(excluded).toMatchObject([{ id: "f1", reason: "inconclusive" }]);
  });

  it("flags findings whose evidence does not resolve", () => {
    const f = finding("ghost", { evidence_refs: [ref("ghost.js")] });
    const { findings, excluded } = classify([f], [], new Map([["ghost", ungrounded]]));
    expect(findings).toHaveLength(0);
    expect(excluded[0]!.reason).toBe("unresolvable-evidence");
  });

  it("demotes a confirmed manifest-only claim to observed-capability (a grant is not a behavior) but keeps its verification", () => {
    const fact = finding("f1", { evidence_refs: [ref("manifest.json")] });
    const { findings, excluded } = classify([fact], [verdict("f1", "confirmed", { grounding_line: { file: "manifest.json", line: 1 } })], new Map([["f1", { resolved: [ref("manifest.json")], unresolved: [] }]]));
    expect(excluded).toHaveLength(0);
    expect(findings[0]!.kind).toBe("observed-capability");
    expect(findings[0]!.verification).not.toBeNull();
  });

  it("still refutes a confabulated manifest-only behavioral claim — demotion never skips verification", () => {
    const lie = finding("f1", { evidence_refs: [ref("manifest.json")] });
    const { findings, excluded } = classify([lie], [verdict("f1", "refuted")], new Map([["f1", { resolved: [ref("manifest.json")], unresolved: [] }]]));
    expect(findings).toHaveLength(0);
    expect(excluded[0]!.reason).toBe("refuted");
  });

  it("rewrites dangling generated ids in prose to the reader-visible finding numbers", () => {
    const a = finding("f1", { claim_type: "observed-capability", detail: "stands alone" });
    const b = finding("f2", {
      claim_type: "observed-capability",
      detail: "relevant to the exfiltration in f1, unlike f9 which is unknown",
    });
    const { findings } = classify([a, b], []);
    expect(findings[1]!.detail).toBe("relevant to the exfiltration in finding 1, unlike f9 which is unknown");
  });

  it("rewrites references to excluded claims as excluded, not as findings", () => {
    const kept = finding("f1", { claim_type: "observed-capability", detail: "see f2 for the refuted story" });
    const gone = finding("f2");
    const { findings } = classify([kept, gone], [verdict("f2", "refuted")]);
    expect(findings[0]!.detail).toContain('an excluded claim ("Finding f2")');
    expect(findings[0]!.detail).not.toContain("see f2");
  });
});

describe("rewriteIdReferences", () => {
  it("only touches tokens that match a known id", () => {
    const map = new Map([["f1", "finding 3"]]);
    expect(rewriteIdReferences("f1 f2 f1x xf1", map)).toBe("finding 3 f2 f1x xf1");
  });

  it("leaves backtick code spans verbatim", () => {
    const map = new Map([["f1", "finding 3"]]);
    expect(rewriteIdReferences("see f1 but not `const f1 = 2`", map)).toBe("see finding 3 but not `const f1 = 2`");
  });

  it("does not corrupt code/filename tokens that merely collide with a finding id", () => {
    const map = new Map([["f2", "finding 5"]]);
    expect(rewriteIdReferences("the f2.js loader and f2() helper and obj.f2", map)).toBe("the f2.js loader and f2() helper and obj.f2");
    // A genuine prose reference is still rewritten.
    expect(rewriteIdReferences("as shown in f2.", map)).toBe("as shown in finding 5.");
  });
});

describe("claim_type passthrough + harm-cleared dismissals (018 residual)", () => {
  it("preserves the generator's claim_type on asserted and excluded claims", () => {
    const out = classify(
      [
        finding("f1"), // inferred, confirmed → verified-behavior
        finding("f2", { claim_type: "observed-capability" }),
        finding("f3"), // refuted → excluded
      ],
      [verdict("f1", "confirmed"), verdict("f3", "refuted")],
    );
    expect(out.findings.find((f) => f.id === "f1")!.claim_type).toBe("inferred-behavior");
    expect(out.findings.find((f) => f.id === "f2")!.claim_type).toBe("observed-capability");
    expect(out.excluded.find((e) => e.id === "f3")!.claim_type).toBe("inferred-behavior");
  });

  it("keeps the original claim_type through the manifest-only demotion", () => {
    const manifestRef = { file: "manifest.json", location: null, symbol: null, sink_or_string: null };
    const out = classify(
      [finding("f1", { evidence_refs: [manifestRef] })],
      [verdict("f1", "confirmed")],
      new Map([["f1", { resolved: [manifestRef], unresolved: [] }]]),
    );
    const f = out.findings.find((x) => x.id === "f1")!;
    expect(f.kind).toBe("observed-capability"); // demoted label
    expect(f.claim_type).toBe("inferred-behavior"); // original claim preserved
  });

  it("routes a confirmed finding whose claimed harm was cleared to dismissals, not assertions or exclusions", () => {
    const out = classify(
      [finding("f1", { title: "Exfiltrates telemetry" })],
      [verdict("f1", "confirmed", { harm_supported: false, harm_rationale: "only first-party telemetry endpoints" })],
    );
    expect(out.findings).toHaveLength(0);
    expect(out.excluded).toHaveLength(0);
    expect(out.dismissals).toHaveLength(1);
    expect(out.dismissals[0]!.concern).toBe("Exfiltrates telemetry");
    expect(out.dismissals[0]!.note).toContain("only first-party telemetry endpoints");
    expect(out.dismissals[0]!.checks_run.join(" ")).toContain("mechanism confirmed");
  });

  it("asserts confirmed findings normally when harm_supported is true or null (fail-open)", () => {
    const out = classify(
      [finding("f1"), finding("f2")],
      [verdict("f1", "confirmed", { harm_supported: true }), verdict("f2", "confirmed")], // f2: null (legacy)
    );
    expect(out.findings.map((f) => f.id).sort()).toEqual(["f1", "f2"]);
    expect(out.dismissals).toHaveLength(0);
  });
});

// Improvement 020, Fix A — a verifier-resolved IOC correction rewrites the wrong
// host out of the asserted finding's prose so the headline never ships it.
describe("IOC correction write-back (020)", () => {
  it("rewrites a corrected host out of title, detail, and mechanism, and records it", () => {
    const f = finding("f1", {
      title: "Telemetry POSTed to https://www.hotcleaner.com/upd2",
      detail: "Xa() POSTs the body to https://www.hotcleaner.com/upd2 and applies the response.",
      claimed_mechanism: "reads state then POSTs to www.hotcleaner.com/upd2",
    });
    const v = verdict("f1", "confirmed", {
      corrected_facts: [{ claimed: "www.hotcleaner.com/upd2", actual: "api64.com/upd2" }],
    });
    const { findings } = classify([f], [v]);
    expect(findings[0]!.title).toBe("Telemetry POSTed to https://api64.com/upd2");
    expect(findings[0]!.detail).toContain("api64.com/upd2");
    expect(findings[0]!.detail).not.toContain("hotcleaner");
    expect(findings[0]!.claimed_mechanism).toContain("api64.com/upd2");
    expect(findings[0]!.verification!.corrections).toEqual([
      { claimed: "www.hotcleaner.com/upd2", actual: "api64.com/upd2" },
    ]);
  });

  it("leaves prose untouched and records no corrections when the verifier found none", () => {
    const { findings } = classify([finding("f1", { title: "a clean finding" })], [verdict("f1", "confirmed")]);
    expect(findings[0]!.title).toBe("a clean finding");
    expect(findings[0]!.verification!.corrections).toEqual([]);
  });
});

// Improvement 020, Fix D — the deterministic IOC-consistency tripwire.
describe("auditIocConsistency (020)", () => {
  const assert1 = (over: Partial<Finding>, v: Partial<VerifierVerdict> = {}) =>
    classify([finding("f1", over)], [verdict("f1", "confirmed", v)]).findings;

  it("flags a title host grounded neither in destinations nor in the finding's evidence", () => {
    const findings = assert1({ title: "exfiltrates cookies to evil-c2.example" });
    const w = auditIocConsistency(findings, new Set(["api64.com", "www.hotcleaner.com"]));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("evil-c2.example");
  });

  it("does not flag a host present in the resolved destinations", () => {
    const findings = assert1({ title: "exfiltrates to api64.com" });
    expect(auditIocConsistency(findings, new Set(["api64.com"]))).toHaveLength(0);
  });

  it("does not flag a host grounded in the finding's own evidence quote", () => {
    const findings = assert1({ title: "posts to grounded-host.example" }, {
      evidence_quote: "fetch('https://grounded-host.example/x')",
    });
    expect(auditIocConsistency(findings, new Set(["other.com"]))).toHaveLength(0);
  });

  it("grounds a bare prose host against a www-subdomain destination (registrable match)", () => {
    const findings = assert1({ title: "opens https://hotcleaner.com/x" });
    expect(auditIocConsistency(findings, new Set(["www.hotcleaner.com"]))).toHaveLength(0);
  });

  it("is a no-op with no resolved-host baseline (never a false alarm)", () => {
    const findings = assert1({ title: "exfiltrates to evil-c2.example" });
    expect(auditIocConsistency(findings, new Set())).toHaveLength(0);
  });
});
