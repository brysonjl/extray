// The promotion rule, factored out of render.ts so every renderer (markdown,
// HTML, report JSON) consumes ONE classification of the verified finding set:
//
//   - observed-capability findings with resolvable evidence are asserted as
//     capabilities (no causal story is told, so no LLM verification needed).
//   - inferred-behavior claims are asserted ONLY when the claim-verifier
//     returned `confirmed` against real source.
//   - everything else — refuted, needs-dynamic, inconclusive, unresolvable
//     evidence, unverified — is an EXCLUDED claim with its reason (dismissals
//     are recorded, never silently dropped — per docs/analysis-dag.md).
//
// Also owned here: the dangling-id rewrite. Generated finding ids (f1, f2 …)
// leak into detail prose ("see f2") but findings are renumbered 1..N in the
// report, so cited ids resolve to nothing a reader can follow. After numbering,
// id tokens are rewritten to "finding N" / "an excluded claim" in all prose.

import type { Finding, FindingsReport, FindingType, RefResolution } from "../methodologies/findings.ts";
import { isGrounded, resolveEvidenceRefs } from "../methodologies/findings.ts";
import type { VerificationResult, VerifierVerdict } from "../methodologies/claim-verifier.ts";
import type { ExcludedClaim, ExclusionReason, ReportDismissal, ReportFinding } from "./contract.ts";

export interface ClassifiedFindings {
  findings: ReportFinding[];
  excluded: ExcludedClaim[];
  /** Concerns whose mechanism the verifier CONFIRMED but whose claimed harm it
   *  explicitly cleared (harm_supported === false, recall-gated upstream) —
   *  checked-and-cleared, so they render as dismissals, never assertions. */
  dismissals: ReportDismissal[];
}

function verification(v: VerifierVerdict): ReportFinding["verification"] {
  return {
    verdict: "confirmed",
    grounding: v.grounding_line,
    rationale: v.rationale,
    evidence_quote: v.evidence_quote || null,
    corrections: v.corrected_facts ?? [],
  };
}

/**
 * Rewrite a verifier-corrected IOC (a wrong host/URL the generator named) out of
 * finding prose (improvement 020). The verifier resolves the ACTUAL destination
 * from source; this replaces the claimed token so the headline never ships a host
 * the code contradicts. Longest claimed token first, so a host+path is corrected
 * before its bare host. Only the exact claimed substring is touched.
 */
function applyCorrections(text: string, corrections: Array<{ claimed: string; actual: string }>): string {
  let out = text;
  for (const { claimed, actual } of [...corrections].sort((a, b) => b.claimed.length - a.claimed.length)) {
    out = out.split(claimed).join(actual);
  }
  return out;
}

/** Hostnames referenced in prose — a coarse registrable-domain-ish match. */
const HOST_RE = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/gi;
// Hosts we never treat as a suspect IOC: the extension's own store/update
// infra, doc/spec namespaces, and file-extension false positives.
const HOST_ALLOWLIST = new Set([
  "chrome.google.com", "clients2.google.com", "chromewebstore.google.com",
  "www.w3.org", "w3.org", "schemas.microsoft.com",
]);
const NON_HOST_TLDS = new Set(["js", "ts", "json", "html", "css", "png", "svg", "map", "md", "txt"]);

function proseHosts(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(HOST_RE)) {
    const h = m[0].toLowerCase();
    const tld = h.slice(h.lastIndexOf(".") + 1);
    if (!NON_HOST_TLDS.has(tld) && !HOST_ALLOWLIST.has(h)) out.add(h);
  }
  return out;
}

/** Registrable-domain approximation (last two labels, port stripped) so a
 *  destination `www.hotcleaner.com` grounds a prose mention of `hotcleaner.com`. */
function registrable(host: string): string {
  const h = host.toLowerCase().split(":")[0]!;
  const parts = h.split(".").filter(Boolean);
  return parts.length <= 2 ? h : parts.slice(-2).join(".");
}

/**
 * Deterministic IOC-consistency tripwire (improvement 020, Fix D). Flags an
 * asserted finding whose prose names an external host that is grounded NOWHERE —
 * not in the statically-resolved destination set, not in the finding's own cited
 * source or the verifier's quote. That is the fingerprint of a hallucinated or
 * mis-decoded IOC (the class that shipped `hotcleaner.com` as the exfil host).
 * Best-effort: skipped entirely when no resolved-host baseline is available, so a
 * run without a destination table never emits false alarms. Fix A's write-back
 * removes verifier-corrected hosts before this runs, so a corrected finding is clean.
 */
export function auditIocConsistency(findings: ReportFinding[], resolvedHosts: Set<string>): string[] {
  if (resolvedHosts.size === 0) return [];
  const resolved = new Set([...resolvedHosts].map(registrable));
  const warnings: string[] = [];
  for (const f of findings) {
    const grounded = [
      ...f.evidence_refs.map((r) => r.sink_or_string ?? ""),
      f.verification?.evidence_quote ?? "",
      f.verification?.grounding?.file ?? "",
    ].join("\n").toLowerCase();
    const named = new Set([...proseHosts(f.title), ...proseHosts(f.claimed_mechanism ?? "")]);
    for (const host of named) {
      if (resolved.has(registrable(host))) continue;
      if (grounded.includes(host)) continue;
      warnings.push(
        `finding ${f.number} ("${f.title}") names host "${host}" that is absent from the resolved destinations ` +
          `and from its own grounded evidence — possible hallucinated or mis-decoded IOC.`,
      );
    }
  }
  return warnings;
}

function excludedClaim(f: Finding, reason: ExclusionReason, v?: VerifierVerdict): ExcludedClaim {
  return {
    id: f.id,
    title: f.title || f.id,
    claim_type: f.claim_type,
    reason,
    detail: f.detail,
    claimed_mechanism: f.claimed_mechanism || null,
    evidence_refs: f.evidence_refs,
    verifier_rationale: v?.rationale ?? null,
    verifier_quote: v?.evidence_quote || null,
  };
}

/**
 * A confirmed-mechanism claim whose CLAIMED HARM the verifier cleared: the code
 * is real, the alleged danger is not (an unreachable message surface, disclosed
 * telemetry read as exfiltration). Rendered under "checked and cleared" with the
 * mechanism named, so a reader never mistakes it for a nothing-found check.
 */
function harmClearedDismissal(f: Finding, v: VerifierVerdict): ReportDismissal {
  return {
    concern: f.title || f.id,
    checks_run: [
      "mechanism confirmed against real source",
      "claimed harm/reachability adjudicated against manifest and destination context — not supported",
    ],
    note:
      `mechanism exists but the claimed harm is unsupported: ${v.harm_rationale || v.rationale}` +
      (v.evidence_quote ? ` (evidence: ${v.evidence_quote})` : ""),
  };
}

/**
 * Rewrite generated-id tokens in prose to their reader-visible names ("see f2"
 * → "see finding 3"). Only PROSE references are touched: backtick code spans
 * are left verbatim, and tokens that read as code/filenames rather than prose
 * (`f12.js`, `f2(`, `obj.f3`, `$f2`) are skipped, so a snippet citing a real
 * variable named like a finding id is never corrupted. Unknown ids pass
 * through untouched.
 */
export function rewriteIdReferences(text: string, idToName: Map<string, string>): string {
  return text
    .split(/(`[^`]*`)/)
    .map((seg, i) =>
      i % 2 === 1
        ? seg // inside a backtick code span — leave verbatim
        : // not preceded by . $ or a word char (member/identifier), and not
          // followed by a word char, `(` (call), or `.<word>` (a file extension
          // or member) — but a trailing sentence period (`f2.`) is fine.
          seg.replace(/(^|[^.$\w])(f\d{1,3})(?![\w(]|\.\w)/g, (_m, pre, tok) => pre + (idToName.get(tok) ?? tok)),
    )
    .join("");
}

/**
 * A claim whose every cited file is the manifest is a static manifest fact,
 * not a behavior. The generator sometimes tags such facts inferred-behavior;
 * the verifier then trivially "confirms" them (the manifest is readable
 * source) and they would render as "verified behavior" — overstating a
 * permission grant into a behavior. They still go THROUGH verification (a
 * confabulated mechanism citing only the manifest must still be refutable);
 * only the asserted label is demoted to observed-capability.
 */
function isManifestOnly(f: Finding): boolean {
  return f.evidence_refs.length > 0 && f.evidence_refs.every((r) => r.file === "manifest.json");
}

// An inconclusive verdict means the verifier could neither confirm nor refute
// the mechanism. Dropping such a claim entirely loses a true signal when it
// asserts a genuine concern — a real surface like an unvalidated message
// handler that writes state (the over-pruning seen in dag, per
// docs/methodology-validation-2026-06-22.md). For these threat-classes we keep
// the claim as a LOW-confidence observed capability instead of excluding it;
// benign/unknown inconclusives stay excluded as noise.
const RETAIN_INCONCLUSIVE_TYPES = new Set<FindingType>(["vulnerability", "malicious", "unwanted"]);

export function classifyFindings(report: FindingsReport, result: VerificationResult, sampleDir?: string): ClassifiedFindings {
  const verified: Array<{ f: Finding; v: VerifierVerdict }> = [];
  const observed: Array<{ f: Finding; v: VerifierVerdict | null; lowConfidence?: boolean }> = [];
  const excluded: ExcludedClaim[] = [];
  const dismissals: ReportDismissal[] = [];

  for (const f of report.findings) {
    const res: RefResolution =
      result.resolutions.get(f.id) ??
      (sampleDir ? resolveEvidenceRefs(f, sampleDir) : { resolved: [], unresolved: f.evidence_refs });
    if (!isGrounded(res)) {
      excluded.push(excludedClaim(f, "unresolvable-evidence"));
      continue;
    }
    if (f.claim_type === "observed-capability") {
      observed.push({ f, v: null });
      continue;
    }
    const v = result.verdicts.get(f.id);
    if (!v) excluded.push(excludedClaim(f, "not-verified"));
    else if (v.verdict === "confirmed") {
      // Harm-cleared (018 residual): the mechanism is real but the verifier
      // explicitly judged the claimed harm unsupported (recall-gated upstream —
      // only an honored explicit false lands here; null always asserts). Route
      // to dismissals so the corroboration gate never sees it as a concern.
      if (v.harm_supported === false) dismissals.push(harmClearedDismissal(f, v));
      else if (isManifestOnly(f)) observed.push({ f, v });
      else verified.push({ f, v });
    } else if (v.verdict === "needs-dynamic") excluded.push(excludedClaim(f, "needs-dynamic", v));
    else if (v.verdict === "inconclusive") {
      if (RETAIN_INCONCLUSIVE_TYPES.has(f.finding_type)) observed.push({ f, v: null, lowConfidence: true });
      else excluded.push(excludedClaim(f, "inconclusive", v));
    } else excluded.push(excludedClaim(f, "refuted", v));
  }

  // The asserted set, numbered: verified behaviors first (the strongest
  // statements), then observed capabilities.
  let n = 0;
  const findings: ReportFinding[] = [
    ...verified.map(({ f, v }) => ({
      number: ++n,
      id: f.id,
      kind: "verified-behavior" as const,
      claim_type: f.claim_type,
      title: f.title || f.id,
      severity: f.severity,
      category: f.category,
      finding_type: f.finding_type,
      detail: f.detail,
      claimed_mechanism: f.claimed_mechanism || null,
      confidence: f.confidence,
      evidence_refs: f.evidence_refs,
      verification: verification(v),
    })),
    ...observed.map(({ f, v, lowConfidence }) => ({
      number: ++n,
      id: f.id,
      kind: "observed-capability" as const,
      claim_type: f.claim_type,
      title: f.title || f.id,
      severity: f.severity,
      category: f.category,
      finding_type: f.finding_type,
      detail: f.detail,
      claimed_mechanism: f.claimed_mechanism || null,
      // A retained-inconclusive surface is downgraded to low confidence: the
      // surface is real but its causal mechanism could not be confirmed.
      confidence: lowConfidence ? ("low" as const) : f.confidence,
      evidence_refs: f.evidence_refs,
      verification: v ? verification(v) : null,
    })),
  ];

  // IOC write-back (improvement 020): correct any host/URL the verifier resolved
  // to a different value than the generator claimed, so the wrong host never
  // reaches the headline. Runs before id-rewrite; touches title/detail/mechanism.
  for (const f of findings) {
    const corr = f.verification?.corrections;
    if (!corr || corr.length === 0) continue;
    f.title = applyCorrections(f.title, corr);
    f.detail = applyCorrections(f.detail, corr);
    if (f.claimed_mechanism) f.claimed_mechanism = applyCorrections(f.claimed_mechanism, corr);
  }

  const idToName = new Map<string, string>();
  for (const f of findings) idToName.set(f.id, `finding ${f.number}`);
  for (const e of excluded) idToName.set(e.id, `an excluded claim ("${e.title}")`);
  for (const f of findings) {
    f.detail = rewriteIdReferences(f.detail, idToName);
    if (f.claimed_mechanism) f.claimed_mechanism = rewriteIdReferences(f.claimed_mechanism, idToName);
  }
  for (const e of excluded) {
    e.detail = rewriteIdReferences(e.detail, idToName);
    if (e.claimed_mechanism) e.claimed_mechanism = rewriteIdReferences(e.claimed_mechanism, idToName);
  }

  return { findings, excluded, dismissals };
}
