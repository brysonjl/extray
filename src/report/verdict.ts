// The verdict engine: a PURE, deterministic function from the analysis layer's
// outputs (the classified findings + the already-built deterministic sections)
// to the report's tier and per-area breakdown. This is the single owner of the
// risk verdict — the synthesis (humanization) step receives this result and
// narrates it, but can never change it. Same inputs ⇒ same verdict, byte for
// byte, so the scorecard grades the tier reproducibly with no LLM in the loop.
//
// It rolls up the SAME section objects the report renders (permissions,
// destinations, obfuscation, developer, coverage), so the verdict and the
// rendered sections can never disagree.
//
// Inputs that decide the tier:
//   - ASSERTED findings carry a generation-assigned severity and a verification
//     status. A VERIFIED-BEHAVIOR (confirmed mechanism) at high/critical is the
//     only thing that reaches "high-risk": confirmed harm. A broad
//     OBSERVED-CAPABILITY is potential, not confirmed, so it caps at
//     "concerning".
//   - Deterministic section signals (dangerous combinations, host breadth,
//     destinations, obfuscation flags, developer identity) drive per-area
//     levels and can raise "clean"→"concerning" on their own.
//   - Heavy coverage gaps with no verified visibility ⇒ "inconclusive".

import type { Category, FindingType, Severity } from "../methodologies/findings.ts";
import { SEVERITY_ORDER } from "../methodologies/findings.ts";
import { isHardObfuscation } from "../pipeline/obfuscation.ts";
import {
  AREAS,
  AREA_LEVELS,
  type Area,
  type AreaLevel,
  type AreaSignal,
  type CoverageSection,
  type DestinationsSection,
  type DeveloperSection,
  type ObfuscationSection,
  type PermissionsSection,
  type ReportFinding,
  type Tier,
  type Verdict,
} from "./contract.ts";

export interface VerdictSections {
  permissions: PermissionsSection;
  destinations: DestinationsSection;
  obfuscation: ObfuscationSection;
  developer: DeveloperSection;
  coverage: CoverageSection;
}

/** Each finding category rolls up into exactly one report area (or none). */
const CATEGORY_AREA: Record<Category, Area | null> = {
  permissions: "permissions",
  "data-exfiltration": "network",
  "remote-resources": "network",
  "messaging-surface": "network",
  obfuscation: "obfuscation",
  "code-execution": "obfuscation",
  "supply-chain": "obfuscation",
  "claim-mismatch": null,
  anomaly: null,
  other: null,
};

const levelRank = (l: AreaLevel): number => AREA_LEVELS.indexOf(l);
const maxLevel = (a: AreaLevel, b: AreaLevel): AreaLevel => (levelRank(a) >= levelRank(b) ? a : b);

function capSeverity(sev: Severity, cap: Severity): Severity {
  return SEVERITY_ORDER[sev] > SEVERITY_ORDER[cap] ? cap : sev;
}

/** A finding's contribution to its area level. An observed capability is
 *  potential, not confirmed, so its severity is capped at medium here. A
 *  low-confidence observed capability is a claim the verifier could not stand
 *  up (e.g. a retained-inconclusive concern): it informs the report but must
 *  not drive the tier, so it contributes only "low". */
function findingLevel(f: ReportFinding): AreaLevel {
  const confirmed = f.kind === "verified-behavior";
  if (!confirmed && f.confidence === "low") return "low";
  const sev = confirmed ? f.severity : capSeverity(f.severity, "medium");
  if (sev === "critical" || sev === "high") return confirmed ? "high" : "notable";
  if (sev === "medium") return "notable";
  if (sev === "low") return "low";
  return "none";
}

// Remotely-hosted or dynamically-injected code that the analysis JUDGED a
// concern (not a benign CDN asset). Loading code the bundled package cannot
// audit — a remote <script src>, an eval'd payload — from a non-first-party
// source is the textbook reason extensions are pulled from the store, and the
// actual behavior lives in a payload static analysis can never see. So this
// pattern is treated as a high-severity surface that floors the tier at
// high-risk, rather than capping at "concerning" like other observed
// capabilities. Gated on finding_type so the script.src/img.src mislabel class
// (a benign `.src=` with no concern type) cannot escalate on its own.
const REMOTE_CODE_CATEGORIES = new Set<Category>(["remote-resources", "code-execution"]);
const REMOTE_CODE_CONCERN_TYPES = new Set<FindingType>(["malicious", "unwanted", "vulnerability"]);
// The floor is meant for genuine remote/dynamic code with a real payload the
// bundle cannot audit — which the generation model rates high/critical. Low/
// medium code-execution findings are dominated by benign vendor-library eval
// (jquery.jeditable) and innerHTML sinks the model types "vulnerability"; those
// must not single-handedly floor the tier at high-risk. Every corpus true
// positive (including Great Suspender) carries a high/critical
// remote-code finding, so this gate is recall-safe.
const REMOTE_CODE_SEVERITIES = new Set<Severity>(["high", "critical"]);
function isRemoteHostedCode(f: ReportFinding): boolean {
  return (
    REMOTE_CODE_CATEGORIES.has(f.category) &&
    REMOTE_CODE_CONCERN_TYPES.has(f.finding_type) &&
    REMOTE_CODE_SEVERITIES.has(f.severity)
  );
}

function areaFindingLevel(findings: ReportFinding[], area: Area): AreaLevel {
  let level: AreaLevel = "none";
  for (const f of findings)
    if (CATEGORY_AREA[f.category] === area) level = maxLevel(level, isRemoteHostedCode(f) ? "high" : findingLevel(f));
  return level;
}

function cap1(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function permissionsArea(findings: ReportFinding[], p: PermissionsSection): AreaSignal {
  let level = areaFindingLevel(findings, "permissions");
  const combos = p.dangerous_combinations;
  const hosts = p.hosts.required;
  const allUrls = hosts.some((h) => h === "<all_urls>" || h === "*://*/*" || /:\/\/\*\/?$/.test(h));
  if (combos.length > 0) level = maxLevel(level, "high");
  else if (allUrls || hosts.length >= 4) level = maxLevel(level, "notable");
  else if (hosts.length > 0) level = maxLevel(level, "low");
  if (level === "none" && p.api.length > 0) level = "low";

  const bits: string[] = [];
  if (combos.length > 0) bits.push(`dangerous combination${combos.length > 1 ? "s" : ""} (${combos.map((c) => c.kind).join(", ")})`);
  if (allUrls) bits.push("access to every site (<all_urls>)");
  else if (hosts.length >= 4) bits.push(`${hosts.length} host patterns`);
  if (p.api.length > 0) bits.push(`${p.api.length} declared permission${p.api.length > 1 ? "s" : ""}`);
  const note = bits.length > 0 ? cap1(bits.join("; ")) + "." : "No API permissions or host access declared.";
  return { area: "permissions", level, note };
}

function networkArea(findings: ReportFinding[], d: DestinationsSection): AreaSignal {
  let level = areaFindingLevel(findings, "network");
  const egress = d.rows.some((r) => r.party === "first-party-extension");
  // Egress to the publisher's OWN domain is the most benign network adjudication
  // the pipeline can make (settings sync, auth to the extension's own API). It is
  // descriptive, not an affirmative risk signal — real exfil surfaces as a
  // verified network finding (raising the area to high below) or a flagged
  // suspicious host. So first-party egress alone contributes only "low".
  if (egress) level = maxLevel(level, "low");
  // An unresolved destination is a STATIC-ANALYSIS BLIND SPOT — a network call
  // whose URL is built from runtime values (a config object, a variable) the
  // folder could not reduce to a literal. It is recorded for soundness in the
  // Coverage section, but it is NOT, by itself, evidence of risky egress:
  // dynamically-built request URLs are ubiquitous in benign code (any extension
  // with a configurable server). Treating it as "notable" auto-escalated every
  // such extension to "concerning". Affirmative network risk — a verified exfil
  // finding, first-party egress, a flagged suspicious host — still raises
  // notable/high above; unresolved alone contributes only "low".
  if (d.unresolved.length > 0) level = maxLevel(level, "low");
  if (d.rows.length > 0 && level === "none") level = "low";

  const verifiedExfil = findings.find(
    (f) => CATEGORY_AREA[f.category] === "network" && f.kind === "verified-behavior" && (f.severity === "high" || f.severity === "critical"),
  );
  const bits: string[] = [];
  if (verifiedExfil) bits.push(`verified ${verifiedExfil.category.replace(/-/g, " ")} (finding ${verifiedExfil.number})`);
  if (d.rows.length > 0) bits.push(`${d.rows.length} external host${d.rows.length > 1 ? "s" : ""}`);
  if (d.unresolved.length > 0) bits.push(`${d.unresolved.length} unresolved destination${d.unresolved.length > 1 ? "s" : ""}`);
  if (egress) bits.push("data egress to the publisher's own domain");
  const note = bits.length > 0 ? cap1(bits.join("; ")) + "." : "No external destinations were statically resolved.";
  return { area: "network", level, note };
}

function obfuscationArea(findings: ReportFinding[], o: ObfuscationSection): AreaSignal {
  const fromFindings = areaFindingLevel(findings, "obfuscation");
  let level = fromFindings;
  // Exclude import(): MV3 forbids remote ES modules, so a bundled dynamic import
  // is not a static blind spot the way eval'd/Function'd code is.
  const dynExec = o.opaque_regions.filter((r) => r.kind === "dynamic-code-exec" && r.api !== "import()").length;
  const hardFlagged = o.flagged.filter(isHardObfuscation).length;
  if (hardFlagged > 0) level = maxLevel(level, "notable");
  if (dynExec > 0) level = maxLevel(level, "notable");

  const bits: string[] = [];
  if (hardFlagged > 0) bits.push(`${hardFlagged} obfuscated file${hardFlagged > 1 ? "s" : ""}`);
  if (dynExec > 0) bits.push(`${dynExec} dynamic code-execution site${dynExec > 1 ? "s" : ""}`);
  // A code-execution / supply-chain FINDING can raise this area even when the
  // structural scanner flagged nothing (o.flagged / o.opaque_regions empty).
  // Cite it so the note can never contradict the level — mirrors the network
  // area's finding reference.
  if (bits.length === 0 && fromFindings !== "none") {
    const areaFindings = findings.filter((f) => CATEGORY_AREA[f.category] === "obfuscation");
    const lead = areaFindings.find(isRemoteHostedCode) ?? areaFindings[0];
    if (lead) bits.push(`${lead.category.replace(/-/g, " ")} flagged in source (finding ${lead.number})`);
  }
  const note = bits.length > 0 ? cap1(bits.join("; ")) + "." : "No obfuscation or dynamic code execution was flagged.";
  return { area: "obfuscation", level, note };
}

function developerArea(dev: DeveloperSection): AreaSignal {
  let level: AreaLevel = "none";
  const bits: string[] = [];
  if (dev.high_risk_country === true) {
    level = maxLevel(level, "high");
    bits.push(`developer in a high-risk country${dev.country ? ` (${dev.country})` : ""}`);
  }
  if (dev.non_store_update_url) {
    level = maxLevel(level, "notable");
    bits.push("updates from a non-store URL");
  }
  const hasIdentity = dev.name !== null || dev.website !== null || dev.address !== null;
  if (!hasIdentity) {
    // Missing identity is only affirmative when a store listing WAS fetched and
    // still carries no developer. When no listing was ever fetched
    // (listing_available === null — every `assess --dir`/corpus run), it is
    // absence of data, not a risk signal, so it may not floor the tier at
    // concerning on its own.
    const listingFetched = dev.listing_available !== null;
    level = maxLevel(level, listingFetched ? "notable" : "low");
    bits.push("no developer identity available");
  } else if (dev.website === null || dev.address === null) {
    level = maxLevel(level, "low");
  }
  const note =
    bits.length > 0
      ? cap1(bits.join("; ")) + "."
      : hasIdentity
        ? "Developer identity present; standard update channel."
        : "Limited developer identity.";
  return { area: "developer", level, note };
}

const CONCERN_TYPES = new Set<FindingType>(["malicious", "unwanted", "vulnerability"]);

/** A finding that represents realized RISK, not merely capability breadth. This
 *  is the corroboration the tier requires before a deterministic area signal
 *  (broad permissions, a minified/obfuscated bundle, missing identity) is
 *  allowed to lift the tier above low-risk. Mirrors the ground-truth rule:
 *  "concerning" needs a data flow beyond stated purpose, a vulnerability, or a
 *  disclosure gap — a justified-broad capability with no such finding is
 *  low-risk however powerful. */
const JUSTIFIED_TYPES = new Set<FindingType>(["risky-capability", "benign"]);

function isConcernFinding(f: ReportFinding): boolean {
  const sev = SEVERITY_ORDER[f.severity];
  // A confirmed behavior corroborates concern — UNLESS the arm itself typed it
  // "risky-capability" (defined in the taxonomy as "consistent with a plausible
  // stated purpose") or "benign". Those are justified capabilities, not harm:
  // ground truth calls a verified executeScript on a screenshot tool or tabCapture
  // on a volume booster low-risk, so a self-labelled justified capability must not
  // hold the tier at concerning on its own.
  if (f.kind === "verified-behavior" && sev >= SEVERITY_ORDER.medium && !JUSTIFIED_TYPES.has(f.finding_type)) return true;
  // A concern-typed finding (malicious/unwanted/vulnerability) at medium+ counts
  // EVEN at low confidence: a weak "this looks like history exfiltration" signal
  // must still hold the tier at concerning rather than let the corroboration gate
  // demote it to low-risk. (Low confidence is dampened where it belongs — in the
  // area-level and maxAsserted inflation checks — not here, so recall on malware
  // the arm was merely unsure about is preserved.)
  if (CONCERN_TYPES.has(f.finding_type) && sev >= SEVERITY_ORDER.medium) return true;
  // A disclosure/behavior mismatch or anomaly is itself the concern.
  if (f.category === "claim-mismatch" || f.category === "anomaly") return true;
  return false;
}

/** Affirmative, non-capability corroboration from the deterministic sections:
 *  a host RDAP-flagged newly-registered / high-risk-country / expired, or a
 *  developer in a high-risk country / updating outside the store. These are
 *  real risk signals (unlike broad host access or minification), so they
 *  justify "concerning" on their own. */
function hasAffirmativeSectionSignal(sections: VerdictSections): boolean {
  const dev = sections.developer;
  if (dev.high_risk_country === true || dev.non_store_update_url === true) return true;
  return sections.destinations.rows.some((r) => {
    const e = r.enrichment;
    return !!e && (e.newly_registered === true || e.high_risk_country === true || e.expired_or_hold === true);
  });
}

/**
 * Roll the asserted findings + per-area signals up to a single tier.
 *   high-risk    — a CONFIRMED (verified-behavior) finding at high/critical.
 *   concerning   — a verified-behavior at medium, a broad observed capability
 *                  (high/critical), or any area at "high"/"notable" — BUT only
 *                  when corroborated by a concern finding or affirmative section
 *                  signal (else the extension is justified-broad capability →
 *                  low-risk, matching ground-truth calibration).
 *   low-risk     — only low-severity findings / "low" area signals, or
 *                  uncorroborated capability breadth.
 *   clean        — nothing of note in any area.
 *   inconclusive — coverage too degraded to judge (heavy opaque/unparsed
 *                  surface AND no verified visibility).
 */
function rollUpTier(findings: ReportFinding[], areas: AreaSignal[], coverage: CoverageSection, corroborated: boolean): { tier: Tier; rationale: string } {
  const verified = findings.filter((f) => f.kind === "verified-behavior");
  const maxVerified = verified.reduce<Severity>((m, f) => (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[m] ? f.severity : m), "info");
  // A low-confidence observed-capability is a claim verification could not stand
  // up; it must not escalate the tier on severity alone (mirrors findingLevel).
  const tierRelevant = findings.filter((f) => !(f.kind === "observed-capability" && f.confidence === "low"));
  const maxAsserted = tierRelevant.reduce<Severity>((m, f) => (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[m] ? f.severity : m), "info");
  const topAreaLevel = areas.reduce<AreaLevel>((m, a) => maxLevel(m, a.level), "none");

  // Inconclusive = we were genuinely blind. Only OPAQUE regions (obfuscated /
  // dynamic-exec code) count as blindness — an unparsed minified library is not
  // a blind spot the way eval'd code is, so it must not push a clean extension
  // to "inconclusive". And a concrete HIGH area signal (a dangerous permission
  // combination, a high-risk developer) means we DID find something, so the
  // verdict is concerning/high — not "couldn't tell". This branch therefore
  // runs AFTER area levels are known and is guarded on both.
  // Remotely-hosted / dynamically-injected code judged a concern floors the
  // tier at high-risk — checked first, because finding it means we are NOT
  // blind to the most important thing (it overrides the inconclusive guard),
  // and because the remote payload's true behavior is unverifiable by design.
  const remoteCode = findings.find(isRemoteHostedCode);
  if (remoteCode) {
    return {
      tier: "high-risk",
      rationale: `Remotely-hosted or dynamically-injected code was flagged as a concern: ${remoteCode.title} (finding ${remoteCode.number}). Code the bundled package cannot audit, loaded from a non-first-party source, is treated as high-risk regardless of whether the remote payload could be confirmed against source.`,
    };
  }
  if (coverage.opaque_regions >= 3 && verified.length === 0 && topAreaLevel !== "high") {
    return {
      tier: "inconclusive",
      rationale: `Coverage is too degraded to judge: ${coverage.opaque_regions} region(s) are opaque to static analysis (obfuscated or dynamically executed) and no behavior could be verified against source.`,
    };
  }
  if (maxVerified === "critical" || maxVerified === "high") {
    const lead = verified.find((f) => f.severity === maxVerified)!;
    return { tier: "high-risk", rationale: `A ${maxVerified}-severity behavior was confirmed against source: ${lead.title} (finding ${lead.number}).` };
  }
  if (maxVerified === "medium" || maxAsserted === "high" || maxAsserted === "critical" || topAreaLevel === "high" || topAreaLevel === "notable") {
    // Corroboration gate. A concern finding (isConcernFinding folded into
    // `corroborated`) or an affirmative section signal keeps the extension at
    // concerning. If the ONLY drivers are deterministic capability signals —
    // broad host access, a dangerous permission combination, a minified/
    // obfuscated bundle, an unresolved destination — with no finding-backed
    // risk, the extension is powerful-but-justified, which ground truth
    // calibrates as low-risk. High-risk paths above are unaffected.
    if (corroborated) {
      return { tier: "concerning", rationale: concerningWhy(findings, areas) };
    }
    const drivers = areas.filter((a) => a.level === "high" || a.level === "notable").map((a) => a.area);
    return {
      tier: "low-risk",
      rationale: `Broad or notable capability signals${drivers.length > 0 ? ` (${drivers.join(", ")})` : ""} were detected, but none was corroborated by a finding-backed concern (no data flow beyond the stated purpose, vulnerability, disclosure gap, or suspicious destination). Consistent with a capable-but-justified extension.`,
    };
  }
  if (maxAsserted !== "info" || topAreaLevel === "low") {
    return { tier: "low-risk", rationale: "Only minor or narrowly-scoped capabilities, consistent with a limited extension; no concerning behavior was asserted." };
  }
  return { tier: "clean", rationale: "No notable capabilities, destinations, obfuscation, or findings were detected." };
}

function concerningWhy(findings: ReportFinding[], areas: AreaSignal[]): string {
  const drivers = areas.filter((a) => a.level === "high" || a.level === "notable").map((a) => `${a.area} (${a.level})`);
  const medVerified = findings.find((f) => f.kind === "verified-behavior" && f.severity === "medium");
  const broadCap = findings.find((f) => f.kind === "observed-capability" && (f.severity === "high" || f.severity === "critical"));
  const lead = medVerified
    ? `a confirmed medium-severity behavior (finding ${medVerified.number})`
    : broadCap
      ? `a broad capability (finding ${broadCap.number})`
      : "broad or anomalous capability";
  return `No high-severity harmful behavior was confirmed against source, but ${lead}${drivers.length > 0 ? ` with notable signals in ${drivers.join(", ")}` : ""} places the extension above low-risk — the user should weigh whether the access is warranted.`;
}

/** The verdict: pure function of the classified findings + the built sections. */
export function computeVerdict(findings: ReportFinding[], sections: VerdictSections): Verdict {
  const per_area: AreaSignal[] = [
    permissionsArea(findings, sections.permissions),
    networkArea(findings, sections.destinations),
    obfuscationArea(findings, sections.obfuscation),
    developerArea(sections.developer),
  ];
  per_area.sort((a, b) => AREAS.indexOf(a.area) - AREAS.indexOf(b.area));
  const corroborated = findings.some(isConcernFinding) || hasAffirmativeSectionSignal(sections);
  const { tier, rationale } = rollUpTier(findings, per_area, sections.coverage, corroborated);
  return { tier, rationale, per_area };
}
