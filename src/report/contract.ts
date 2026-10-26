// The risk-report contract: ONE structured object assembled after verification,
// from which every consumer renders — markdown, HTML, and the report JSON. This
// is the consistency seam the MVP asks for: the six surface areas (permissions,
// destinations, obfuscation, developer, verdict, findings) are fields here, so
// every report carries every section regardless of what the LLM chose to write
// findings about. A slimmed implementation of docs/risk-report-schema.md.
//
// Two provenance rules govern what may appear where:
//   - Deterministic sections (permissions, destinations, obfuscation, developer,
//     coverage) come ONLY from the evidence pack / listing artifact — no LLM text.
//   - Synthesized fields (verdict, summaries, description_deviation) come from
//     the post-verification synthesis call, regenerated AFTER the verifier from
//     the asserted finding set plus the deterministic digests. Excluded claims
//     enter that call only as title+reason with an explicit do-not-re-assert
//     instruction — a prompt-level guard, not a mechanical guarantee. This is
//     what closes the pre-013 failure mode (overall_risk generated BEFORE
//     verification and rendered verbatim after, so the risk line could assert a
//     mechanism the report's own excluded-claims section refuted); the verdict
//     now rests on the verified set, though a prompt-injected model could still
//     in principle parrot an excluded claim.

import type { Category, ClaimType, Confidence, EvidenceRef, FindingType, Severity } from "../methodologies/findings.ts";
import type { FixtureContext } from "../fixture-context.ts";
import type { ImportedSkillReview } from "../reviews/types.ts";
import type { Location, OpaqueRegion } from "../pipeline/schema.ts";
import type { CdnMatch, DnsStatus, DomainEnrichment, HostKind, IpEnrichment, LookupStatus } from "../enrichment/types.ts";

// 1.3: optional investigation outcome distinguishes artifacts, completion and submission.
// 1.2: extension identity carries optional synthetic-fixture context for exports.
// 1.1: findings/excluded claims carry `claim_type` (the generator's original
// label, preserved through classification demotions/promotions — additive).
export const REPORT_SCHEMA_VERSION = "1.3";

/** Risk verdict enum, low→high. Owned here; the scorecard re-exports it. */
export const TIERS = ["clean", "low-risk", "concerning", "high-risk", "inconclusive"] as const;
export type Tier = (typeof TIERS)[number];

/** Severity ordering for tier comparisons (`inconclusive` is unordered). */
export const TIER_ORDER: Record<Exclude<Tier, "inconclusive">, number> = {
  clean: 0,
  "low-risk": 1,
  concerning: 2,
  "high-risk": 3,
};

/**
 * Always-applicable blind spots of the static pipeline, duplicated into every
 * report so a single artifact is self-describing (docs/risk-report-schema.md,
 * "Epistemic limits"). Constant across runs; reflects pipeline design.
 */
export const STRUCTURAL_LIMITS = [
  "library files are skipped from sink/taint analysis by default",
  "taint sketches are limited to 1-3 hops within a single file; cross-file flows are not tracked",
  "indirect exfiltration channels (Image.src, redirects, sendBeacon, native messaging) are catalogued but not linked into taint chains",
  "dynamic code (eval, Function constructors, runtime string assembly) is opaque unless deobfuscation recovered it",
  "remotely-fetched configuration and runtime state are not observable from the bundled code",
] as const;

/**
 * Extension identity. `store_id` is set only by the single-extension assess
 * path; corpus runs leave it null because the sample directory name is a
 * ground-truth hint (improvement 001) and the report body reaches the judge.
 */
export interface ExtensionIdentity {
  name: string | null;
  version: string | null;
  manifest_version: number;
  store_id: string | null;
  fixture?: FixtureContext;
}

/** One API permission with everywhere the pipeline saw it exercised. */
export interface PermissionRow {
  permission: string;
  /** Declared as optional (`optional_permissions`) rather than required. */
  optional: boolean;
  status: "used" | "unused" | "undetermined";
  /** Capped at MAX_USAGE_SITES for display; `total_usage` carries the true count. */
  usage: Array<{ path: string; line: number; api: string }>;
  total_usage: number;
  /** Layperson explanation of what the permission allows (from the permission
   *  catalog — deterministic, no LLM). */
  description: string;
  /** Link to the official Google documentation for this permission. */
  doc_url: string;
  /** Chrome's verbatim install-time warning for this permission, or null when
   *  Chrome shows none. The official, layperson-facing risk wording. */
  install_warning: string | null;
  /** Layperson description of how this extension actually uses the permission,
   *  derived from the static call-site evidence (deterministic, no LLM). */
  usage_plain: string;
}

export interface PermissionsSection {
  api: PermissionRow[];
  hosts: { required: string[]; optional: string[] };
  /** Plain-language note about the host-access scope (broad vs specific vs none). */
  hosts_plain: string;
  dangerous_combinations: Array<{ kind: string; evidence: string[] }>;
}

/**
 * RDAP-derived registration/ownership context for one external host (improvement
 * 015), joined onto the row from the committed host-enrichment artifact. Present
 * only when an artifact covers this host; null/absent means "never enriched".
 * The `domain`/`ip` blocks carry the COMPLETE artifact facts; the three derived
 * booleans are DESCRIPTIVE CONTEXT ONLY (boolean | null, null = data absent) and
 * deliberately do NOT feed the deterministic risk tier (src/report/verdict.ts).
 *
 * `dns_status`/`resolved_addresses`/`cname_chain`/`cdn` (017) describe the
 * actual network target a domain-kind host resolves to — `ip` is populated from
 * `resolved_addresses[0]` when resolution succeeded. When `cdn` is non-null, the
 * `ip` country/owner/ASN facts describe the CDN operator's edge, not the
 * destination's actual location; renderers must label accordingly rather than
 * asserting them as origin facts (high_risk_country is already forced null in
 * that case — see src/enrichment/project.ts).
 */
export interface DestinationEnrichment {
  kind: HostKind;
  lookup_status: LookupStatus;
  domain: DomainEnrichment | null;
  ip: IpEnrichment | null;
  dns_status: DnsStatus;
  resolved_addresses: string[];
  cname_chain: string[];
  cdn: CdnMatch | null;
  newly_registered: boolean | null;
  high_risk_country: boolean | null;
  expired_or_hold: boolean | null;
}

/** One external host with how it is reached. Party from data-flow adjudication when known. */
export interface DestinationRow {
  host: string;
  references: number;
  any_dynamic: boolean;
  reached_via: string[];
  example_sites: Array<{ path: string; line: number; role: string }>;
  party: "first-party-extension" | "external" | "unknown" | null;
  /** RDAP enrichment, when a host-enrichment artifact covers this host (015). */
  enrichment?: DestinationEnrichment | null;
}

export interface DestinationsSection {
  rows: DestinationRow[];
  /** Soundness: calls whose destination could not be statically resolved. */
  unresolved: Array<{ path: string; ast_role: string; location: Location }>;
}

export interface ObfuscationEntry {
  path: string;
  identifier_entropy: number;
  mean_identifier_length: number;
  hex_escape_density_per_kb: number;
  string_array_decoder_detected: boolean;
  packer_signature: string | null;
}

export interface ObfuscationSection {
  flagged: ObfuscationEntry[];
  /** Regions static analysis cannot see past (obfuscated files, dynamic exec sites). */
  opaque_regions: OpaqueRegion[];
}

/**
 * Merged developer view: manifest self-reported fields plus the store-listing
 * artifact (008b) when one exists. `listing_available: null` means "never
 * fetched" — distinct from `false`, "fetched and the listing is gone".
 */
export interface DeveloperSection {
  name: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  country: string | null;
  is_trader: boolean | null;
  high_risk_country: boolean | null;
  update_url: string | null;
  non_store_update_url: boolean;
  sources: Array<"manifest" | "store_listing">;
  listing_available: boolean | null;
  listing_fetched_at: string | null;
}

export const AREAS = ["permissions", "network", "obfuscation", "developer"] as const;
export type Area = (typeof AREAS)[number];

export const AREA_LEVELS = ["none", "low", "notable", "high"] as const;
export type AreaLevel = (typeof AREA_LEVELS)[number];

/** Per-area signal driving the verdict breakdown ("what drove the tier"). */
export interface AreaSignal {
  area: Area;
  level: AreaLevel;
  note: string;
}

export interface Verdict {
  tier: Tier;
  rationale: string;
  per_area: AreaSignal[];
}

export interface DescriptionDeviation {
  /** The stated purpose the assessment compared against, and where it came from. */
  stated_purpose: string | null;
  stated_source: "store_listing" | "manifest" | null;
  /** null when no stated purpose was available to compare. */
  deviates: boolean | null;
  note: string;
}

/** An asserted finding, post-verification, ready to render. */
export interface ReportFinding {
  number: number;
  id: string;
  kind: "verified-behavior" | "observed-capability";
  /** The generator's original claim label. `kind` is the ASSERTED label after
   *  classification (demotions included); this preserves what the arm claimed. */
  claim_type: ClaimType;
  title: string;
  severity: Severity;
  category: Category;
  /** Threat-class: the nature of the finding, orthogonal to category/severity. */
  finding_type: FindingType;
  detail: string;
  claimed_mechanism: string | null;
  confidence: Confidence;
  evidence_refs: EvidenceRef[];
  verification: {
    verdict: "confirmed";
    grounding: { file: string; line: number | null } | null;
    rationale: string;
    evidence_quote: string | null;
    /** IOC corrections the verifier resolved from source (improvement 020). The
     *  finding prose above has ALREADY been rewritten from these — kept here so
     *  the correction is auditable (claimed host/URL → what the code resolves to). */
    corrections: Array<{ claimed: string; actual: string }>;
  } | null;
}

export const EXCLUSION_REASONS = [
  "refuted",
  "needs-dynamic",
  "inconclusive",
  "unresolvable-evidence",
  "not-verified",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

/** A generated claim that did NOT survive verification — recorded, never silently dropped. */
export interface ExcludedClaim {
  id: string;
  title: string;
  claim_type: ClaimType;
  reason: ExclusionReason;
  detail: string;
  claimed_mechanism: string | null;
  evidence_refs: EvidenceRef[];
  verifier_rationale: string | null;
  verifier_quote: string | null;
}

/**
 * A concern the investigation explicitly CHECKED and cleared — distinct from an
 * excluded claim (a generated finding the verifier refuted). Dismissals are the
 * negative result of a deliberate look: the concern examined, the concrete checks
 * run, and why nothing was asserted. Produced by the multi-node (DAG) and sharded
 * (Pi) arms; empty for single-shot arms. Surfacing these is what keeps a
 * thoroughly-investigated benign extension from rendering as an empty no-op
 * report. Shape mirrors `Dismissal` in methodologies/dag/node.ts (kept here so the
 * report contract owns no methodology import).
 */
export interface ReportDismissal {
  /** The concern that was checked (e.g. "unjustified host access"). */
  concern: string;
  /** The checks actually run, so a dismissal is never a bare clean bill of health. */
  checks_run: string[];
  note: string;
}

export interface CoverageSection {
  opaque_regions: number;
  indirect_calls: number;
  unresolved_destinations: number;
  unparsed_files: string[];
  structural_limits: readonly string[];
}

/** Artifact production, investigation completion, and submission are separate. */
export interface AnalysisOutcome {
  artifact_generated: true;
  investigation: "complete" | "incomplete";
  final_submission: "accepted" | "not-accepted";
  reasons: string[];
}

export interface RiskReport {
  /** Optional external review, kept separate from all verified/asserted findings. */
  skill_review?: ImportedSkillReview;
  /** Absent in old reports and methods without an investigation session. */
  outcome?: AnalysisOutcome;
  report_schema_version: string;
  analyzer_version: string;
  methodology: string;
  model: string;
  /** Point-in-time stamp: when the evidence pack was produced (pinned for corpus runs). */
  generated_at: string;
  extension: ExtensionIdentity;
  verdict: Verdict;
  summaries: { layperson: string; technical: string };
  description_deviation: DescriptionDeviation;
  permissions: PermissionsSection;
  destinations: DestinationsSection;
  obfuscation: ObfuscationSection;
  developer: DeveloperSection;
  findings: ReportFinding[];
  excluded_claims: ExcludedClaim[];
  /** Concerns explicitly checked and cleared (the investigation's negative
   *  results). Empty for arms that do not record dismissals. */
  dismissals: ReportDismissal[];
  coverage: CoverageSection;
}
