import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCorpusLabels, loadLabel, LabelError } from "../src/scorecard/labels.ts";

describe("loadCorpusLabels (real corpus)", () => {
  const labels = loadCorpusLabels("corpus");

  it("loads all 11 samples and excludes the base symlink alias", () => {
    expect(labels.size).toBe(11);
    expect(labels.has("base")).toBe(false);
  });

  it("parses ExtRay Demo Cookie Manager as the benign FP-trap", () => {
    const l = labels.get("demo-cookie-manager")!;
    expect(l.kind).toBe("benign");
    expect(l.cleared).toBe(true);
    expect(l.expected_tier).toBe("concerning");
    expect(l.must_not_emit).toContain("data-exfiltration high-severity");
    expect(l.must_detect.length).toBe(0);
  });

  it("parses stacked bellwether mutant-g with two must_detect entries", () => {
    const l = labels.get("mutant-g-stacked-be")!;
    expect(l.kind).toBe("malicious");
    expect(l.is_bellwether).toBe(true);
    expect(l.must_detect.length).toBe(2);
    expect(l.expected_tier).toBe("high-risk");
  });

  it("flags mutant-h as the generalization probe", () => {
    expect(labels.get("mutant-h-curveball-clipboard")!.is_generalization_probe).toBe(true);
  });
});

describe("label validation", () => {
  function fixture(name: string, body: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), "labels-"));
    mkdirSync(join(root, name), { recursive: true });
    writeFileSync(join(root, name, "label.yaml"), JSON.stringify(body)); // JSON is valid YAML
    return root;
  }

  it("rejects a sample_id that does not match the directory name", () => {
    const root = fixture("mutant-x", { sample_id: "wrong", kind: "malicious", expected_tier: "high-risk", source: { id: "s" }, must_detect: ["x"] });
    expect(() => loadLabel(root, "mutant-x")).toThrow(LabelError);
  });

  it("rejects a malicious sample with no must_detect", () => {
    const root = fixture("mutant-y", { sample_id: "mutant-y", kind: "malicious", expected_tier: "high-risk", source: { id: "s" }, must_detect: [] });
    expect(() => loadLabel(root, "mutant-y")).toThrow(/at least one must_detect/);
  });

  it("rejects an expected_tier outside the verdict enum", () => {
    const root = fixture("mutant-z", { sample_id: "mutant-z", kind: "malicious", expected_tier: "scary", source: { id: "s" }, must_detect: ["x"] });
    expect(() => loadLabel(root, "mutant-z")).toThrow(/verdict enum/);
  });

  it("rejects a benign sample missing cleared", () => {
    const root = fixture("benign-1", { sample_id: "benign-1", kind: "benign", expected_tier: "clean", source: { id: "s" } });
    expect(() => loadLabel(root, "benign-1")).toThrow(/cleared/);
  });

  it("rejects must_detect containing a non-string element", () => {
    const root = fixture("mutant-w", { sample_id: "mutant-w", kind: "malicious", expected_tier: "high-risk", source: { id: "s" }, must_detect: ["ok", 42] });
    expect(() => loadLabel(root, "mutant-w")).toThrow(/must be an array of strings/);
  });

  it("rejects a label file that is not a YAML mapping", () => {
    const root = mkdtempSync(join(tmpdir(), "labels-"));
    mkdirSync(join(root, "mutant-scalar"), { recursive: true });
    writeFileSync(join(root, "mutant-scalar", "label.yaml"), "just a string");
    expect(() => loadLabel(root, "mutant-scalar")).toThrow(LabelError);
  });
});
