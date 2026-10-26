#!/usr/bin/env node
// Plain Node validator for the labeled test corpus. No test framework.
// Checks every corpus/<sample>/label.yaml against the label contract documented
// in corpus/grading-ground-truth.md, plus structural invariants.
//
// Usage: node scripts/validate-corpus.mjs   (exits non-zero on any failure)

import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { validateDestinations } from "./corpus-destination-safety.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = join(ROOT, "corpus");

// Verdict tiers, from docs/risk-report-schema.md (verdict.overall enum).
const TIERS = ["clean", "low-risk", "concerning", "high-risk", "inconclusive"];
const PATTERN_IDS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];

const errors = [];
const fail = (sample, msg) => errors.push(`[${sample}] ${msg}`);

// Non-sample directories that legitimately live under corpus/. `fixtures/` is
// the committed LLM record/replay store, not a labeled sample.
const NON_SAMPLE_DIRS = new Set(["fixtures"]);

// Sample dirs = immediate corpus children that are real directories (not the
// `base` symlink alias, not files like grading-ground-truth.md).
const entries = readdirSync(CORPUS, { withFileTypes: true });
const samples = entries
  .filter((e) => (e.isDirectory() && !e.isSymbolicLink() && !NON_SAMPLE_DIRS.has(e.name)))
  .map((e) => e.name);

// `base` must be a symlink alias and is explicitly excluded from the sample set.
const baseEntry = entries.find((e) => e.name === "base");
if (baseEntry && !baseEntry.isSymbolicLink()) {
  fail("base", "`base` must be a symlink alias, not a real sample directory");
}

if (samples.length === 0) fail("corpus", "no sample directories found");

for (const sample of samples) {
  const dir = join(CORPUS, sample);
  const labelPath = join(dir, "label.yaml");
  const extDir = join(dir, "extension");

  if (!existsSync(extDir) || !statSync(extDir).isDirectory()) {
    fail(sample, "missing extension/ directory");
  } else if (existsSync(join(extDir, "_metadata", "verified_contents.json"))) {
    fail(sample, "_metadata/verified_contents.json must be stripped (confounds the bake-off)");
  }

  // Fixture context lives outside the investigator's readable source tree.
  try {
    const fixture = JSON.parse(readFileSync(join(dir, "extension.fixture.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
    if (fixture.kind !== "synthetic" || typeof fixture.family !== "string" || !fixture.family.trim()) {
      fail(sample, "extension.fixture.json requires kind=synthetic and a nonempty family");
    }
    if (manifest.name !== fixture.family) fail(sample, "manifest name must match the neutral fixture family");
    if (/mutant|exfil|steganograph|obfuscat|tampered|malicious|benign/i.test(manifest.name)) {
      fail(sample, "manifest name must not reveal the expected answer");
    }
  } catch (e) {
    fail(sample, `missing or invalid fixture identity: ${e.message}`);
  }

  if (!existsSync(labelPath)) {
    fail(sample, "missing label.yaml");
    continue;
  }

  let label;
  try {
    label = parseYaml(readFileSync(labelPath, "utf8"));
  } catch (e) {
    fail(sample, `label.yaml does not parse: ${e.message}`);
    continue;
  }

  // Required-everywhere fields.
  if (label.sample_id !== sample) fail(sample, `sample_id "${label.sample_id}" != dir name`);
  if (!["benign", "malicious"].includes(label.kind)) fail(sample, `kind must be benign|malicious`);
  if (!TIERS.includes(label.expected_tier)) fail(sample, `expected_tier "${label.expected_tier}" not in ${TIERS.join("|")}`);
  if (typeof label.is_bellwether !== "boolean") fail(sample, "is_bellwether must be a boolean");
  if (!label.source || !label.source.id || !label.source.version) fail(sample, "source.{id,version} required");

  if (label.kind === "malicious") {
    if (label.base_ref && samples.includes(label.base_ref) && existsSync(extDir)) {
      for (const error of validateDestinations(extDir, join(CORPUS, label.base_ref, "extension"))) fail(sample, error);
    } else {
      fail(sample, "malicious samples require a valid base_ref for destination validation");
    }
    if (!Array.isArray(label.must_detect) || label.must_detect.length === 0) {
      fail(sample, "malicious samples must list >=1 must_detect behavior");
    }
    if (label.injected_pattern_id != null && !PATTERN_IDS.includes(label.injected_pattern_id)) {
      fail(sample, `injected_pattern_id "${label.injected_pattern_id}" not in ${PATTERN_IDS.join("")}`);
    }
    if (label.base_ref && !samples.includes(label.base_ref)) {
      fail(sample, `base_ref "${label.base_ref}" is not a corpus sample`);
    }
  }

  if (label.kind === "benign") {
    if (Array.isArray(label.must_detect) && label.must_detect.length > 0) {
      fail(sample, "benign samples assert clearing, not detection — must_detect must be empty");
    }
    if (label.cleared !== true) fail(sample, "benign samples must set cleared: true");
    if (!Array.isArray(label.must_not_emit) || label.must_not_emit.length === 0) {
      fail(sample, "benign samples must list >=1 must_not_emit finding class");
    }
  }
}

if (errors.length) {
  console.error(`Corpus validation FAILED (${errors.length} issue${errors.length > 1 ? "s" : ""}):`);
  for (const e of errors) console.error("  - " + e);
  process.exit(1);
}
console.log(`Corpus validation passed: ${samples.length} sample(s) OK.`);
