// Loads and validates each corpus `<sample>/label.yaml` into typed objects the
// metrics layer consumes. The label contract is defined in
// corpus/grading-ground-truth.md; this module enforces its invariants and fails
// fast (LabelError) on a malformed label. Labels are methodology-neutral (no
// rule_id / node names) — only observable behaviors.

import { readdirSync, lstatSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export class LabelError extends Error {}

// The verdict enum is owned by the report contract (it is the report's risk
// vocabulary, embedded in every report since the synthesis node landed); the
// scorecard re-exports it so grading and reports can never drift apart.
import { TIERS, TIER_ORDER, type Tier } from "../report/contract.ts";
export { TIERS, TIER_ORDER };
export type { Tier };

export interface Label {
  sample_id: string;
  kind: "benign" | "malicious";
  base_ref: string | null;
  injected_pattern_id: string | null;
  expected_tier: Tier;
  is_bellwether: boolean;
  is_generalization_probe: boolean;
  source: { id: string; version: string };
  /** malicious: observable behaviors to detect; benign: empty. */
  must_detect: string[];
  /** benign only: true = analyzer must emit no behavioral high-severity finding. */
  cleared: boolean | null;
  /** benign only: finding classes that count as a false alarm if emitted. */
  must_not_emit: string[];
  notes?: string;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function validate(sampleId: string, raw: Record<string, unknown>): Label {
  const fail = (m: string): never => {
    throw new LabelError(`${sampleId}/label.yaml: ${m}`);
  };

  if (raw.sample_id !== sampleId) fail(`sample_id "${String(raw.sample_id)}" must equal the directory name`);
  const kind = raw.kind;
  if (kind !== "benign" && kind !== "malicious") fail(`kind must be "benign" or "malicious"`);
  const tier = raw.expected_tier;
  if (typeof tier !== "string" || !TIERS.includes(tier as Tier)) fail(`expected_tier "${String(tier)}" not in the verdict enum`);

  const src = raw.source as Record<string, unknown> | undefined;
  if (!src || asString(src.id) === null) fail(`source.id is required`);

  const stringArray = (v: unknown, field: string): string[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) fail(`${field} must be an array of strings`);
    return v as string[];
  };
  const mustDetect = stringArray(raw.must_detect, "must_detect");
  const mustNotEmit = stringArray(raw.must_not_emit, "must_not_emit");

  if (kind === "malicious" && mustDetect.length === 0) fail(`malicious sample must list at least one must_detect behavior`);
  if (kind === "benign" && raw.cleared !== true && raw.cleared !== false) fail(`benign sample must set cleared (boolean)`);

  return {
    sample_id: sampleId,
    kind: kind as Label["kind"],
    base_ref: asString(raw.base_ref),
    injected_pattern_id: asString(raw.injected_pattern_id),
    expected_tier: tier as Tier,
    is_bellwether: raw.is_bellwether === true,
    is_generalization_probe: raw.is_generalization_probe === true,
    source: { id: String(src!.id), version: String(src!.version ?? "") },
    must_detect: mustDetect,
    cleared: kind === "benign" ? (raw.cleared as boolean) : null,
    must_not_emit: mustNotEmit,
    notes: asString(raw.notes) ?? undefined,
  };
}

/** Load one sample's label. Throws LabelError if missing or malformed. */
export function loadLabel(corpusDir: string, sample: string): Label {
  const path = join(corpusDir, sample, "label.yaml");
  if (!existsSync(path)) throw new LabelError(`${sample}: label.yaml not found at ${path}`);
  const parsed = parseYaml(readFileSync(path, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LabelError(`${sample}/label.yaml: expected a YAML mapping, got ${Array.isArray(parsed) ? "a list" : typeof parsed}`);
  }
  return validate(sample, parsed as Record<string, unknown>);
}

/**
 * Load every corpus sample's label, keyed by sample id. Excludes the `base`
 * symlink alias and any non-directory entry (same rule as analyzeCorpus).
 */
export function loadCorpusLabels(corpusDir = "corpus"): Map<string, Label> {
  const out = new Map<string, Label>();
  for (const name of readdirSync(corpusDir).sort()) {
    const dir = join(corpusDir, name);
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) continue; // skip `base` alias + files
    if (!existsSync(join(dir, "label.yaml"))) continue;
    out.set(name, loadLabel(corpusDir, name));
  }
  return out;
}
