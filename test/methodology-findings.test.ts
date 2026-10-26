import { describe, it, expect } from "vitest";
import {
  parseFindingsReport,
  resolveEvidenceRefs,
  safeSourcePath,
  isGrounded,
  FindingsParseError,
  type Finding,
} from "../src/methodologies/findings.ts";

const SAMPLE_DIR = "corpus/mutant-a-exfil-fetch/extension";

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "f1",
  title: "t",
  claim_type: "inferred-behavior",
  severity: "medium",
  category: "other",
  finding_type: "unknown",
  confidence: "medium",
  claimed_mechanism: "m",
  evidence_refs: [],
  detail: "d",
  ...over,
});

describe("parseFindingsReport", () => {
  it("parses a well-formed findings report", () => {
    const text = JSON.stringify({
      summary: "an extension",
      overall_risk: "high",
      findings: [
        {
          id: "f1",
          title: "Exfil",
          claim_type: "inferred-behavior",
          confidence: "high",
          claimed_mechanism: "reads cookies then POSTs them",
          evidence_refs: [{ file: "js/background.js", location: { line: 10, column: 2 }, symbol: "send", sink_or_string: "fetch" }],
          detail: "details here",
        },
      ],
    });
    const r = parseFindingsReport(text);
    expect(r.summary).toBe("an extension");
    expect(r.overall_risk).toBe("high");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.evidence_refs[0]).toEqual({
      file: "js/background.js",
      location: { line: 10, column: 2 },
      symbol: "send",
      sink_or_string: "fetch",
    });
  });

  it("picks the LAST findings object (reasoning models emit scratch JSON first)", () => {
    const scratch = JSON.stringify({ findings: [{ id: "draft", title: "draft" }] });
    const real = JSON.stringify({ summary: "s", overall_risk: "low", findings: [{ id: "f1", title: "real" }] });
    const r = parseFindingsReport(`thinking...\n${scratch}\nfinal:\n${real}`);
    expect(r.findings.map((f) => f.title)).toEqual(["real"]);
  });

  it("coerces tolerantly: unknown claim_type/severity/category → safe defaults, bad confidence → low, refs without a file dropped", () => {
    const r = parseFindingsReport(
      JSON.stringify({
        findings: [
          {
            title: "x",
            claim_type: "behavioral-hypothesis",
            severity: "catastrophic",
            category: "made-up",
            confidence: "certain",
            evidence_refs: [{ file: "a.js" }, { location: { line: 1 } }, "not-an-object", { file: "" }],
          },
        ],
      }),
    );
    const f = r.findings[0]!;
    expect(f.claim_type).toBe("inferred-behavior");
    expect(f.severity).toBe("info"); // unknown severity must not inflate the verdict
    expect(f.category).toBe("other");
    expect(f.confidence).toBe("low");
    expect(f.evidence_refs).toEqual([{ file: "a.js", location: null, symbol: null, sink_or_string: null }]);
    expect(f.id).toBe("f1"); // missing id synthesized from index
  });

  it("dedupes colliding finding ids so verdicts can never cross wires", () => {
    const r = parseFindingsReport(JSON.stringify({ findings: [{ id: "f1" }, { id: "f1" }, { id: "f1" }] }));
    expect(r.findings.map((f) => f.id)).toEqual(["f1", "f1-2", "f1-3"]);
  });

  it("drops non-object findings entries instead of crashing", () => {
    const r = parseFindingsReport(JSON.stringify({ findings: [null, "x", 4, { id: "ok" }] }));
    expect(r.findings.map((f) => f.id)).toEqual(["ok"]);
  });

  it("rescues parseable finding objects when ONE unescaped quote corrupts the top-level JSON", () => {
    // Reproduction of the recorded failure: a sink_or_string containing a raw
    // `"` makes the whole report object unparseable; the sibling findings are
    // valid JSON on their own and must be salvaged.
    const good = '{"id": "f2", "title": "good", "claim_type": "inferred-behavior", "evidence_refs": [{"file": "a.js"}], "detail": "ok"}';
    const text = `{
      "summary": "salvage me",
      "overall_risk": "high",
      "findings": [
        {"id": "f1", "title": "broken", "claim_type": "observed-capability", "evidence_refs": [{"file": "b.js", "sink_or_string": "addListener(("message") => {})"}]},
        ${good}
      ]
    }`;
    const r = parseFindingsReport(text);
    expect(r.findings.map((f) => f.id)).toContain("f2"); // the good finding survives
    expect(r.findings.find((f) => f.id === "f2")!.evidence_refs[0]!.file).toBe("a.js");
  });

  it("throws FindingsParseError when no findings object exists and nothing is rescuable (not silently 'clean')", () => {
    expect(() => parseFindingsReport("This extension is totally fine.")).toThrow(FindingsParseError);
    expect(() => parseFindingsReport('{"findings": "none"}')).toThrow(FindingsParseError);
  });
});

describe("safeSourcePath / resolveEvidenceRefs", () => {
  it("resolves a real extension-relative file", () => {
    expect(safeSourcePath(SAMPLE_DIR, "js/background.js")).toContain("js/background.js");
    expect(safeSourcePath(SAMPLE_DIR, "manifest.json")).not.toBeNull();
  });

  it("rejects traversal and absolute paths (model-cited paths are attacker-influenced)", () => {
    expect(safeSourcePath(SAMPLE_DIR, "../../../etc/passwd")).toBeNull();
    expect(safeSourcePath(SAMPLE_DIR, "/etc/passwd")).toBeNull();
    expect(safeSourcePath(SAMPLE_DIR, "..")).toBeNull();
  });

  it("rejects files that do not exist and directories", () => {
    expect(safeSourcePath(SAMPLE_DIR, "js/not-here.js")).toBeNull();
    expect(safeSourcePath(SAMPLE_DIR, "js")).toBeNull();
  });

  it("splits refs into resolved/unresolved; grounded iff ≥1 resolves", () => {
    const f = finding({
      evidence_refs: [
        { file: "js/background.js", location: null, symbol: null, sink_or_string: null },
        { file: "js/invented.js", location: null, symbol: null, sink_or_string: null },
      ],
    });
    const res = resolveEvidenceRefs(f, SAMPLE_DIR);
    expect(res.resolved.map((r) => r.file)).toEqual(["js/background.js"]);
    expect(res.unresolved.map((r) => r.file)).toEqual(["js/invented.js"]);
    expect(isGrounded(res)).toBe(true);
  });

  it("a finding with no refs (or only invented refs) is ungrounded — the model invented it", () => {
    expect(isGrounded(resolveEvidenceRefs(finding(), SAMPLE_DIR))).toBe(false);
    const f = finding({ evidence_refs: [{ file: "ghost.js", location: null, symbol: null, sink_or_string: null }] });
    expect(isGrounded(resolveEvidenceRefs(f, SAMPLE_DIR))).toBe(false);
  });
});
