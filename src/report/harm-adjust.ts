// Deterministic harm-level adjustment: correct a finding's SEVERITY/finding_type
// when the pack proves the claimed harm cannot hold, BEFORE the verdict rolls up.
//
// The generation model reliably spots real code constructs but routinely
// mischaracterizes their harm: a `chrome.runtime.onMessage` handler becomes an
// "unvalidated sender vulnerability" though no web page can reach it, and a
// Google-Analytics POST becomes "data exfiltration" though it is disclosed
// first-party telemetry. The claim-verifier confirms the mechanism EXISTS but
// never whether the claimed harm level is supported, so these flow into the tier
// as concern findings and over-escalate benign extensions (measured: 15 + 14 of
// the tier-driving false positives on ground-truth-benign extensions).
//
// This applies only DETERMINISTIC, pack-proven corrections — never a judgment
// call — so it is recall-safe: it fires only when a manifest/data-flow fact
// makes the claimed harm impossible, and it caps severity rather than dropping
// the finding (the capability is still reported, just not as realized harm).

import type { EvidencePack } from "../pipeline/schema.ts";
import { SEVERITY_ORDER, type Severity } from "../methodologies/findings.ts";
import type { ReportFinding } from "./contract.ts";

/** A host pattern that grants WEB pages access to the extension's messaging. */
const WEB_ORIGIN = /^(https?:\/\/|\*:\/\/)|<all_urls>/i;

/**
 * Can a WEB PAGE send a message this extension receives? Only when
 * externally_connectable declares a web-origin match (or a wildcard). Absent
 * that, `onMessage`/`onMessageExternal` are reachable only by the extension's
 * own contexts (and, for External, other installed extensions) — never by a web
 * page. So a "handler does not validate sender" claim has no web attack surface.
 */
export function webMessageReachable(pack: EvidencePack): boolean {
  const ec = pack.manifest_analysis.externally_connectable;
  if (!ec) return false;
  if (ec.wildcards === true) return true;
  return (ec.matches ?? []).some((m) => WEB_ORIGIN.test(m));
}

// Well-known analytics / product-telemetry / error-monitoring endpoints —
// disclosed third-party telemetry, not exfiltration. A STRICT allowlist of exact
// registrable hosts (anchored, never a substring), so a lookalike like
// `evil-analytics-cdn.com` is NOT absolved. Adding a host here says "traffic to
// THIS domain is telemetry"; it is recall-safe precisely because it names
// specific, verifiable SaaS domains rather than matching an "analytics" keyword.
export const KNOWN_ANALYTICS = [
  /^(.*\.)?google-analytics\.com$/i,
  /^(.*\.)?googletagmanager\.com$/i,
  /^analytics\.google\.com$/i,
  /^(.*\.)?doubleclick\.net$/i,
  /^(.*\.)?mixpanel\.com$/i,
  /^(.*\.)?segment\.(io|com)$/i,
  /^(.*\.)?amplitude\.com$/i,
  /^(.*\.)?datadoghq\.com$/i,
  /^(.*\.)?browser-intake-datadoghq\.com$/i,
  /^(.*\.)?sentry\.io$/i,
  /^(.*\.)?ingest\.sentry\.io$/i,
  /^(.*\.)?bugsnag\.com$/i,
  /^(.*\.)?fullstory\.com$/i,
  /^(.*\.)?hotjar\.com$/i,
  /^(.*\.)?(events\.data|browser\.events\.data)\.microsoft\.com$/i,
  /^(.*\.)?(self\.events\.data|mobile\.events\.data)\.microsoft\.com$/i,
  /^(.*\.)?(browser\.pipe\.aria|mobile\.pipe\.aria)\.microsoft\.com$/i,
];

// DOM-injection APIs. Per the external-call ledger's own definition, these are
// NOT remote code execution — assigning to innerHTML runs no fetched/eval'd
// source, it injects markup into a DOM the context already controls. A
// "code-execution vulnerability" whose mechanism is one of these is a category
// error the model routinely makes; on an extension's own pages it is self-XSS at
// most. eval / new Function (genuine dynamic code) are deliberately absent.
const DOM_INJECTION = /\b(innerhtml|outerhtml|insertadjacenthtml|dangerouslysetinnerhtml|document\.write)\b/i;
const REAL_CODE_EXEC = /\b(eval|new function|function\s*\(|settimeout\s*\(\s*["'`]|setinterval\s*\(\s*["'`]|executescript)\b/i;

/** Is this host a well-known analytics/telemetry SaaS endpoint (strict match)? */
export function isKnownAnalyticsHost(host: string): boolean {
  return KNOWN_ANALYTICS.some((re) => re.test(host));
}

/** Is this text a DOM-injection mechanism (innerHTML & friends) with NO genuine
 *  dynamic-code construct — i.e. NOT remote code execution by the ledger's own
 *  definition? Shared with the verifier's deterministic harm-clear gate. */
export function isDomInjectionOnly(text: string): boolean {
  return DOM_INJECTION.test(text) && !REAL_CODE_EXEC.test(text);
}

export function firstPartyHosts(pack: EvidencePack): Set<string> {
  const s = new Set<string>();
  for (const flow of pack.cross_file?.data_flows ?? []) {
    if (flow.dest_party === "first-party-extension" && flow.dest_host) s.add(flow.dest_host.toLowerCase());
  }
  return s;
}

/** Hosts mentioned in a URL inside model-authored text (evidence + detail). */
export function hostsInText(text: string): string[] {
  const hosts = new Set<string>();
  const re = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) hosts.add(m[1]!.toLowerCase());
  return [...hosts];
}

function capSeverity(sev: Severity, cap: Severity): Severity {
  return SEVERITY_ORDER[sev] > SEVERITY_ORDER[cap] ? cap : sev;
}

export interface HarmAdjustment {
  findings: ReportFinding[];
  notes: string[];
}

/**
 * Cap the severity (and de-escalate the finding_type) of concern findings the
 * pack proves cannot hold the claimed harm. Returns new finding objects; inputs
 * are not mutated. `notes` records each correction for the trace.
 */
export function adjustFindingHarm(findings: ReportFinding[], pack: EvidencePack): HarmAdjustment {
  const reachable = webMessageReachable(pack);
  const fp = firstPartyHosts(pack);
  const notes: string[] = [];

  const out = findings.map((f) => {
    // Rule A — an "unvalidated sender" messaging vulnerability with no
    // web-reachable message surface is not web-exploitable.
    if (f.category === "messaging-surface" && f.finding_type === "vulnerability" && !reachable) {
      notes.push(`"${f.title}": messaging-surface downgraded — no web-reachable message surface (externally_connectable has no web origin).`);
      return { ...f, severity: capSeverity(f.severity, "low"), finding_type: "risky-capability" as const };
    }
    // Rule B — a data-exfiltration finding whose only resolved destinations are
    // the publisher's own domain or a known analytics endpoint is disclosed
    // telemetry, not exfiltration. Requires at least one identifiable host and
    // EVERY host benign (fail-safe: an unidentifiable host keeps the finding).
    if (f.category === "data-exfiltration" && (f.finding_type === "unwanted" || f.finding_type === "vulnerability")) {
      const hosts = [
        ...new Set([...hostsInText(f.detail), ...f.evidence_refs.flatMap((r) => hostsInText(r.sink_or_string ?? ""))]),
      ];
      if (hosts.length > 0 && hosts.every((h) => fp.has(h) || KNOWN_ANALYTICS.some((re) => re.test(h)))) {
        notes.push(`"${f.title}": data-exfiltration downgraded — destinations are first-party/known-analytics (${hosts.join(", ")}).`);
        return { ...f, severity: capSeverity(f.severity, "low"), finding_type: "risky-capability" as const };
      }
    }
    // Rule C — a "code-execution vulnerability" whose mechanism is DOM injection
    // (innerHTML and friends) is not remote code execution (the ledger excludes
    // these by definition); with no eval/Function in the same claim it is a DOM/
    // markup surface, at most self-XSS on the extension's own page. Cap it.
    if (f.category === "code-execution" && f.finding_type === "vulnerability") {
      const text = `${f.title} ${f.detail} ${f.claimed_mechanism ?? ""} ${f.evidence_refs.map((r) => r.sink_or_string ?? "").join(" ")}`;
      if (DOM_INJECTION.test(text) && !REAL_CODE_EXEC.test(text)) {
        notes.push(`"${f.title}": code-execution downgraded — DOM injection (innerHTML), not remote code execution.`);
        return { ...f, severity: capSeverity(f.severity, "low"), finding_type: "risky-capability" as const };
      }
    }
    return f;
  });

  return { findings: out, notes };
}
