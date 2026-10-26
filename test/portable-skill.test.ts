import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { Ajv } from "ajv";
import { skillAssets, syncSkill } from "../scripts/sync-skill.ts";
import { DIMENSIONS } from "../src/methodologies/pi/guidance.ts";

const skill = resolve("skills/extray-review");
let scratch: string;
let source: string;
let installed: string;

function report() {
  return {
    schema_version: "1.0", methodology: "extray-review", verification: "not-run",
    target: { name: "Test extension", version: "1.0" }, evidence_mode: "source-only",
    investigation: "complete", summary: "The scoped source review finished.",
    findings: [{
      id: "f1", title: "Network request", claim_type: "inferred-behavior", severity: "low",
      category: "remote-resources", confidence: "high", finding_type: "risky-capability",
      claimed_mechanism: "The background script requests a static resource.",
      evidence_refs: [{ file: "background.js", location: { line: 2 }, symbol: null,
        sink_or_string: "fetch(" }], detail: "A request occurs when the background script starts.",
    }],
    coverage: DIMENSIONS.map((dimension) => ({
      dimension, status: dimension === "exfiltration" ? "findings" : "cleared",
      finding_ids: dimension === "exfiltration" ? ["f1"] : [] as string[],
      checks_run: ["Read manifest.json and background.js lines 1–2."], note: "Scoped inspection of this small fixture.",
    })),
    limitations: ["Static review only; no browser execution or remote payload analysis."],
  };
}

function run(value: unknown) {
  const file = join(scratch, "candidate.json");
  writeFileSync(file, JSON.stringify(value));
  return spawnSync(process.execPath, [join(installed, "scripts/validate-report.mjs"), file, "--source", source], {
    cwd: scratch, encoding: "utf8", env: { ...process.env, NODE_PATH: "" },
  });
}

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "extray-skill-"));
  source = join(scratch, "untrusted source");
  installed = join(scratch, "installed skill");
  mkdirSync(source);
  cpSync(skill, installed, { recursive: true });
  writeFileSync(join(source, "manifest.json"), '{"manifest_version":3,"name":"Test extension","version":"1.0"}');
  // Test data is only read, never evaluated by the validator.
  writeFileSync(join(source, "background.js"), '// fixture\nfetch("https://example.invalid/static.json");\n');
  writeFileSync(join(scratch, "outside.txt"), "outside the sample");
  symlinkSync(join(scratch, "outside.txt"), join(source, "escape.js"));
  mkdirSync(join(source, "nested"));
  writeFileSync(join(source, "nested", "normal.js"), "// contained file\n");
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("portable ExtRay skill", () => {
  it("ships current Pi guidance and taxonomy and a valid standard JSON Schema", () => {
    expect(() => syncSkill(true)).not.toThrow();
    const schema = JSON.parse(skillAssets()["report.schema.json"]!);
    const validate = new Ajv({ strict: true }).compile(schema);
    expect(validate(report()), JSON.stringify(validate.errors)).toBe(true);
  });

  it("can be copied outside the repo and validates source references without dependencies", () => {
    const result = run(report());
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("claims unverified");
  });

  it("accepts honest incomplete reports, including zero findings and no inspection", () => {
    const value = report();
    value.investigation = "incomplete";
    value.findings = [];
    for (const c of value.coverage) {
      c.status = "inconclusive";
      c.finding_ids = [];
      c.checks_run = [];
      c.note = "Source inspection was not completed within the available budget.";
    }
    expect(run(value).status).toBe(0);
  });

  it.each([
    ["missing coverage", (v: ReturnType<typeof report>) => { v.coverage.pop(); }],
    ["duplicate coverage", (v: ReturnType<typeof report>) => { v.coverage[4] = v.coverage[0]!; }],
    ["false completion", (v: ReturnType<typeof report>) => { v.coverage[4]!.status = "inconclusive"; }],
    ["empty dismissal checks", (v: ReturnType<typeof report>) => { v.coverage[4]!.checks_run = []; }],
    ["unknown finding id", (v: ReturnType<typeof report>) => { v.coverage[0]!.finding_ids = ["missing"]; }],
    ["unaccounted finding", (v: ReturnType<typeof report>) => { v.coverage[0]!.finding_ids = []; v.coverage[0]!.status = "cleared"; }],
    ["duplicate finding id", (v: ReturnType<typeof report>) => { v.findings.push(v.findings[0]!); }],
    ["missing mechanism", (v: ReturnType<typeof report>) => { v.findings[0]!.claimed_mechanism = ""; }],
    ["unsupported enum", (v: ReturnType<typeof report>) => { v.findings[0]!.severity = "catastrophic"; }],
    ["invented verification", (v: ReturnType<typeof report>) => { v.verification = "confirmed"; }],
    ["line outside file", (v: ReturnType<typeof report>) => { v.findings[0]!.evidence_refs[0]!.location.line = 999; }],
    ["fractional line", (v: ReturnType<typeof report>) => { v.findings[0]!.evidence_refs[0]!.location.line = 1.5; }],
    ["invented token", (v: ReturnType<typeof report>) => { v.findings[0]!.evidence_refs[0]!.sink_or_string = "chrome.cookies.getAll"; }],
    ["capability labeled malicious", (v: ReturnType<typeof report>) => {
      v.findings[0]!.claim_type = "observed-capability"; v.findings[0]!.claimed_mechanism = "";
      v.findings[0]!.finding_type = "malicious";
    }],
  ])("rejects %s", (_name, mutate) => {
    const value = report();
    mutate(value);
    expect(run(value).status).toBe(1);
  });

  it.each(["../outside.txt", "/etc/passwd", "C:/Windows/file", "nested/../../outside.txt", "nested\\file.js", "escape.js", "missing.js", "nested"])(
    "rejects unsafe or nonexistent citation %s", (file) => {
      const value = report();
      value.findings[0]!.evidence_refs[0]!.file = file;
      expect(run(value).status).toBe(1);
    },
  );

  it("does not permit a forged engine verdict or an absent report", () => {
    expect(run({ ...report(), verdict: { tier: "clean" } }).status).toBe(1);
    expect(run(null).status).toBe(1);
  });

  it("checks optional columns against the original source line", () => {
    const value = report();
    const location = { line: 2, column: 1 };
    value.findings[0]!.evidence_refs[0]!.location = location;
    expect(run(value).status).toBe(0);
    location.column = 1000;
    expect(run(value).status).toBe(1);
    location.column = 0;
    expect(run(value).status).toBe(1);
  });

  it("reports parse/usage errors separately", () => {
    const file = join(scratch, "broken.json");
    writeFileSync(file, "{broken");
    const cli = join(installed, "scripts/validate-report.mjs");
    expect(spawnSync(process.execPath, [cli, file, "--source", source]).status).toBe(2);
    expect(spawnSync(process.execPath, [cli]).status).toBe(2);
    expect(spawnSync(process.execPath, [cli, "--help"]).status).toBe(0);
  });

  it("has no missing or out-of-package Markdown references after copying", () => {
    for (const file of ["SKILL.md", "references/reporting.md", "references/investigation.md", "references/extray-tools.md"]) {
      const content = readFileSync(join(installed, file), "utf8");
      for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
        const target = match[1]!;
        expect(target).not.toMatch(/^(?:\/|\.\.\/)/);
        const relativeDir = file.includes("/") ? "references" : "";
        expect(() => readFileSync(join(installed, relativeDir, target))).not.toThrow();
      }
    }
    expect(readFileSync(join(installed, "LICENSE"), "utf8")).toBe(readFileSync("LICENSE", "utf8"));
  });
});
