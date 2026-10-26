// Structured-finding contract for the generation → verification split
// (improvement 013). The monolith no longer asserts a free-form assessment;
// it emits findings, each tagged with a claim type:
//
//   - "observed-capability": a specific API / permission / string / destination
//     is present in the evidence pack. No causal story is being told.
//   - "inferred-behavior": a claim that the code *does* X — a mechanism. These
//     are where confabulation lives (a real-extension "cookie-stuffing" finding), so
//     they are only asserted in the final report after the claim-verifier
//     adjudicates them against real source.
//
// Parsing is tolerant (reuses the scorecard's balanced-JSON walker): malformed
// findings are coerced or dropped field-by-field, but a completion with no
// findings object at all is a hard FindingsParseError — treating it as "no
// findings" would silently read as a clean extension.

import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Location } from "../pipeline/schema.ts";
import { lastObjectWith, objectsWith } from "../scorecard/parse.ts";

export const CLAIM_TYPES = ["observed-capability", "inferred-behavior"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

// Threat-class taxonomy: the *nature* of a finding, orthogonal to `category`
// (which says WHERE — which surface — a finding sits) and `severity` (how bad
// if it holds). `category` groups by surface; `finding_type` groups by what
// KIND of problem it is, so that two findings in the same category (e.g. a
// web-exposed message handler any page can abuse vs. a covert exfil to an
// attacker host) are distinguishable.
//
//   - "vulnerability": an exploitable weakness a third party could abuse — the
//     extension is the vector/victim (unvalidated externally_connectable
//     handler, eval of remote input, world-readable web-accessible resources).
//   - "malicious": code that harms or deceives the user BY DESIGN (covert
//     exfil to an attacker host, silent self-uninstall, cookie hijacking,
//     hidden affiliate injection). Intent-laden: assign ONLY to a confirmed
//     mechanism (inferred-behavior) backed by strong evidence. When in doubt,
//     it is "unknown", never "malicious" — downstream analysis may promote it.
//   - "unwanted": privacy-invasive but a common business model — tracking,
//     fingerprinting, telemetry, adware/affiliate monetization. The "grey" bucket.
//   - "risky-capability": a powerful/broad capability, concerning by breadth
//     but consistent with a plausible stated purpose (cookies + all_urls,
//     MAIN-world injection, broad OAuth scopes). The capability itself, not a
//     confirmed abuse.
//   - "benign": a cleared concern or scoped negative ("we checked X, it's
//     accounted for"). Mirrors the report's "positive" findings.
//   - "unknown": flagged but the nature cannot be determined. The conservative
//     default for anything ambiguous.
export const FINDING_TYPES = [
  "vulnerability",
  "malicious",
  "unwanted",
  "risky-capability",
  "benign",
  "unknown",
] as const;
export type FindingType = (typeof FINDING_TYPES)[number];

export const CONFIDENCES = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

// Severity = "how serious IF this finding holds" (orthogonal to confidence).
// Assigned by the generation node — the analysis layer owns this mapped field;
// it is what the deterministic verdict rollup consumes (verification gates
// which findings count, and the report's tier is a pure function of these).
export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const SEVERITY_ORDER: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

// Closed category taxonomy (mirrors docs/risk-report-schema.md). Maps each
// finding to a report area for the per-area verdict breakdown.
export const CATEGORIES = [
  "permissions",
  "data-exfiltration",
  "code-execution",
  "obfuscation",
  "supply-chain",
  "messaging-surface",
  "remote-resources",
  "claim-mismatch",
  "anomaly",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** A pointer from a finding to the pack/source fact it relies on. */
export interface EvidenceRef {
  /** Extension-relative path, exactly as it appears in the pack (e.g. "background.js"). */
  file: string;
  /** Cited sink/listener location, when the pack carried one. */
  location: Location | null;
  /** Enclosing function/symbol name, when known. */
  symbol: string | null;
  /** The exact API or string the finding cites (e.g. "document.cookie ="). */
  sink_or_string: string | null;
}

export interface Finding {
  id: string;
  title: string;
  claim_type: ClaimType;
  /** How serious if it holds. Analysis-layer field; drives the verdict rollup. */
  severity: Severity;
  /** Closed taxonomy; maps the finding to a report area. */
  category: Category;
  confidence: Confidence;
  /** Threat-class: the nature of the finding, orthogonal to category/severity. */
  finding_type: FindingType;
  /** One-line causal story to be checked ("reads X then sends it to Y"). */
  claimed_mechanism: string;
  evidence_refs: EvidenceRef[];
  detail: string;
}

export interface FindingsReport {
  summary: string;
  overall_risk: string;
  findings: Finding[];
}

export class FindingsParseError extends Error {}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function coerceLocation(v: unknown): Location | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.line !== "number" || !Number.isFinite(o.line)) return null;
  const loc: Location = { line: o.line };
  if (typeof o.column === "number" && Number.isFinite(o.column)) loc.column = o.column;
  return loc;
}

function coerceRef(v: unknown): EvidenceRef | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  // A ref without a file path cannot be resolved against anything — drop it.
  if (typeof o.file !== "string" || o.file.trim() === "") return null;
  return {
    file: o.file,
    location: coerceLocation(o.location),
    symbol: typeof o.symbol === "string" && o.symbol !== "" ? o.symbol : null,
    sink_or_string: typeof o.sink_or_string === "string" && o.sink_or_string !== "" ? o.sink_or_string : null,
  };
}

function coerceFinding(v: unknown, index: number): Finding | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  // Unknown claim_type defaults to inferred-behavior: the conservative bucket,
  // since those claims must survive verification before being asserted.
  const claimType = (CLAIM_TYPES as readonly string[]).includes(o.claim_type as string)
    ? (o.claim_type as ClaimType)
    : "inferred-behavior";
  const confidence = (CONFIDENCES as readonly string[]).includes(o.confidence as string)
    ? (o.confidence as Confidence)
    : "low";
  // Unknown severity → "info": a malformed severity must not silently inflate
  // the verdict (the rollup is severity-driven). Unknown category → "other".
  const severity = (SEVERITIES as readonly string[]).includes(o.severity as string)
    ? (o.severity as Severity)
    : "info";
  const category = (CATEGORIES as readonly string[]).includes(o.category as string)
    ? (o.category as Category)
    : "other";
  // Unknown finding_type → "unknown": the conservative bucket. A malformed or
  // absent type must never silently read as "malicious" or "benign".
  const findingType = (FINDING_TYPES as readonly string[]).includes(o.finding_type as string)
    ? (o.finding_type as FindingType)
    : "unknown";
  const refs = Array.isArray(o.evidence_refs)
    ? o.evidence_refs.map(coerceRef).filter((r): r is EvidenceRef => r !== null)
    : [];
  return {
    id: str(o.id, `f${index + 1}`) || `f${index + 1}`,
    title: str(o.title),
    claim_type: claimType,
    severity,
    category,
    confidence,
    finding_type: findingType,
    claimed_mechanism: str(o.claimed_mechanism),
    evidence_refs: refs,
    detail: str(o.detail),
  };
}

/**
 * Extract a FindingsReport from free-form model text. Tolerant per-field, and
 * with a per-finding rescue: when the top-level object is corrupt (one
 * unescaped quote inside a 20k-char completion breaks the whole JSON.parse),
 * the individual finding objects that DO parse are salvaged — losing one
 * malformed finding beats losing the report. Throws FindingsParseError only
 * when no findings can be recovered at all.
 */
export function parseFindingsReport(text: string): FindingsReport {
  const obj = lastObjectWith(text, "findings");
  let rawFindings: unknown[];
  let summary: string;
  let overallRisk: string;
  if (obj && Array.isArray(obj.findings)) {
    rawFindings = obj.findings;
    summary = str(obj.summary);
    overallRisk = str(obj.overall_risk);
  } else {
    // Rescue: finding objects are self-contained — collect every parseable
    // object that looks like a finding ("id" is its first key per the schema,
    // which is what the balanced-rescue scan anchors on; claim_type confirms
    // the shape), and pull summary/overall_risk from any parseable fragment.
    rawFindings = objectsWith(text, "id").filter((o) => "claim_type" in o);
    if (rawFindings.length === 0) {
      throw new FindingsParseError(
        `could not parse a findings report from model output (${text.length} chars; no JSON object with a "findings" array, and no individual finding objects to rescue)`,
      );
    }
    summary = str(lastObjectWith(text, "summary")?.summary);
    overallRisk = str(lastObjectWith(text, "overall_risk")?.overall_risk);
  }
  const findings = rawFindings.map(coerceFinding).filter((f): f is Finding => f !== null);
  // Dedupe ids so verifier verdicts (keyed by id) can never collide.
  const seen = new Map<string, number>();
  for (const f of findings) {
    const n = seen.get(f.id) ?? 0;
    seen.set(f.id, n + 1);
    if (n > 0) f.id = `${f.id}-${n + 1}`;
  }
  return { summary, overall_risk: overallRisk, findings };
}

// ---- Deterministic evidence-ref resolution (the pre-LLM grounding check) ----

/**
 * Resolve a model-cited file path against the unpacked extension dir. The path
 * comes from model output over attacker-controlled data, so it must not escape
 * `sampleDir` (outside absolute paths and parent traversal are rejected).
 * Returns the absolute path for an existing regular file inside the dir, else
 * null. File tools may also request directories or either kind of entry.
 */
export function safeSourcePath(sampleDir: string, file: string, kind: "file" | "directory" | "any" = "file"): string | null {
  const root = resolve(sampleDir);
  const abs = resolve(root, file);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  if (!existsSync(abs)) return null;
  try {
    const stat = statSync(abs);
    if (kind === "file" && !stat.isFile()) return null;
    if (kind === "directory" && !stat.isDirectory()) return null;
    if (kind === "any" && !stat.isFile() && !stat.isDirectory()) return null;
  } catch {
    return null;
  }
  // Symlink guard: the lexical check above is satisfied by a symlink that LIVES
  // inside the dir but POINTS outside it (an unpacked CRX can carry such an
  // entry), and statSync/readFileSync both follow symlinks — so a link could
  // steer a read out of the sandbox. Resolve symlinks and re-check containment
  // against the real root before trusting the path.
  try {
    const realRoot = realpathSync(root);
    const realAbs = realpathSync(abs);
    if (realAbs !== realRoot && !realAbs.startsWith(realRoot + sep)) return null;
  } catch {
    return null;
  }
  return abs;
}

export interface RefResolution {
  resolved: EvidenceRef[];
  unresolved: EvidenceRef[];
}

/**
 * Deterministic grounding pre-check: a ref resolves iff its cited file actually
 * exists in the unpacked extension. A finding none of whose refs resolve is
 * itself a flag — the model cited evidence that does not exist — and is never
 * sent to the LLM verifier (it is demoted in the rendered report instead).
 */
export function resolveEvidenceRefs(finding: Finding, sampleDir: string): RefResolution {
  const resolved: EvidenceRef[] = [];
  const unresolved: EvidenceRef[] = [];
  for (const ref of finding.evidence_refs) {
    (safeSourcePath(sampleDir, ref.file) ? resolved : unresolved).push(ref);
  }
  return { resolved, unresolved };
}

/** A finding is grounded when at least one evidence ref resolves to real source. */
export function isGrounded(res: RefResolution): boolean {
  return res.resolved.length > 0;
}
