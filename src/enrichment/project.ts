// Two derived views over a host-enrichment record, both DESCRIPTIVE ONLY (they
// never feed the deterministic risk tier — see docs/reference/improvements/015):
//
//   1. deriveSignals() — the report/dashboard's boolean context signals
//      (newly_registered, high_risk_country, expired_or_hold). boolean | null;
//      null (data absent) is deliberately distinct from false (data present,
//      signal not met).
//   2. projectHostEnrichment() — the COMPACT per-host projection folded into the
//      serialized pack the LLM arms read. The on-disk artifact stays COMPLETE;
//      only this view is compressed: timestamps collapse to age-in-days, only
//      decision-relevant fields survive, every null/empty field is omitted (no
//      `field: null` noise), and a redacted/not_found/error host degrades to a
//      short status token rather than an object of nulls. This is what keeps
//      per-host context to a handful of tokens with NO top-N cap on hosts.
//
// Ages are computed relative to the pack's analyzed_at (pinned for corpus/bakeoff
// runs), so the projection is deterministic there and the immutable `created`
// date dominates — the volatile `fetched_at` never enters the projection.
//
// CDN-fronted hosts (017, record.cdn set by the enricher's CNAME/org/ASN match
// against cdn-providers.json) are a special case in BOTH views: high_risk_country
// is forced null (not false) rather than read off the CDN's edge-IP country, and
// the projection swaps the raw owner/ASN/country facts for the provider label —
// in either case because that IP data describes the CDN operator, not the
// destination's actual location.

import { isHighRiskCountry } from "../listing/country.ts";
import type { HostEnrichmentRecord } from "./types.ts";

/** Window for the newly_registered signal (domain age). Policy const, kept
 *  DISTINCT from the 30-day artifact-staleness window on purpose. */
export const NEWLY_REGISTERED_WINDOW_DAYS = 90;

/** Whole days from an earlier ISO instant to a later one; null on unparseable. */
export function daysBetween(fromIso: string | null, toIso: string): number | null {
  if (!fromIso) return null;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.floor((to - from) / 86_400_000);
}

const HOLD_STATUS = /hold/i; // RDAP "client hold"/"server hold" (EPP clientHold/serverHold)

/** The three descriptive booleans (boolean | null). */
export interface DerivedSignals {
  newly_registered: boolean | null;
  high_risk_country: boolean | null;
  expired_or_hold: boolean | null;
}

export function deriveSignals(record: HostEnrichmentRecord, analyzedAt: string): DerivedSignals {
  const d = record.domain;

  // newly_registered: domain created within the window. null when created unknown.
  let newly_registered: boolean | null = null;
  if (d?.created) {
    const age = daysBetween(d.created, analyzedAt);
    newly_registered = age === null ? null : age >= 0 && age <= NEWLY_REGISTERED_WINDOW_DAYS;
  }

  // high_risk_country: IP-registration country. Populated for domain hosts too
  // once forward DNS resolution + IP RDAP succeed (017), but suppressed (null)
  // when the host is CDN-fronted — that country describes the CDN operator's
  // edge, not the destination's actual location, so asserting risk from it
  // would be exactly the false-attribution problem CDN labeling exists to
  // avoid. isHighRiskCountry is itself three-valued (null country ⇒ null).
  const high_risk_country = record.cdn ? null : isHighRiskCountry(record.ip?.country ?? null);

  // expired_or_hold: domain expiry in the past, or an EPP hold status. null when
  // we have neither an expiry nor any status to judge from.
  let expired_or_hold: boolean | null = null;
  if (d && (d.expires !== null || d.statuses.length > 0)) {
    const expiredPast = d.expires ? (daysBetween(analyzedAt, d.expires) ?? 0) < 0 : false;
    const onHold = d.statuses.some((s) => HOLD_STATUS.test(s));
    expired_or_hold = expiredPast || onHold;
  }

  return { newly_registered, high_risk_country, expired_or_hold };
}

/**
 * Compact projection for the LLM pack view. Returns a short status token for
 * any non-ok lookup, else a lean object carrying only decision-relevant,
 * present fields (ages instead of ISO timestamps; true-only derived flags). An
 * `ok` record that yielded nothing useful also degrades to the `"ok"` token
 * rather than an empty object.
 */
export function projectHostEnrichment(record: HostEnrichmentRecord, analyzedAt: string): string | Record<string, unknown> {
  if (record.lookup_status !== "ok") return record.lookup_status; // "redacted" | "not_found" | "error"

  const signals = deriveSignals(record, analyzedAt);
  const out: Record<string, unknown> = {};

  if (record.domain) {
    const d = record.domain;
    if (d.registrable && d.registrable !== record.host) out.registrable = d.registrable;
    if (d.registrar) out.registrar = d.registrar;
    const registeredAge = daysBetween(d.created, analyzedAt);
    if (registeredAge !== null) out.registered_days_ago = registeredAge;
    if (d.expires) {
      const expiresIn = daysBetween(analyzedAt, d.expires);
      if (expiresIn !== null) out.expires_in_days = expiresIn;
    }
    if (d.registrant_org) out.registrant_org = d.registrant_org;

    // The resolved network target (017): which IP this host currently points
    // to. A CDN match REPLACES the raw owner/ASN/country facts with the
    // provider label — those facts describe the CDN's edge, not the
    // destination's actual location, so surfacing them as plain facts here
    // would assert exactly the "country of origin" this exists to avoid.
    if (record.cdn) {
      out.cdn = record.cdn.provider;
    } else if (record.ip) {
      if (record.ip.owner_org) out.resolved_owner_org = record.ip.owner_org;
      if (record.ip.asn) out.resolved_asn = record.ip.asn;
      if (record.ip.country) out.resolved_country = record.ip.country;
    }
  } else if (record.ip) {
    const ip = record.ip;
    out.kind = record.kind; // IPs are unusual destinations; name the kind explicitly
    if (record.cdn) {
      out.cdn = record.cdn.provider;
    } else {
      if (ip.network_name) out.network_name = ip.network_name;
      if (ip.owner_org) out.owner_org = ip.owner_org;
      if (ip.asn) out.asn = ip.asn;
      if (ip.country) out.country = ip.country;
      const allocatedAge = daysBetween(ip.allocated, analyzedAt);
      if (allocatedAge !== null) out.allocated_days_ago = allocatedAge;
    }
  }

  // True-only derived flags — a false/null signal is noise the model need not see.
  if (signals.newly_registered === true) out.newly_registered = true;
  if (signals.expired_or_hold === true) out.expired_or_hold = true;
  if (signals.high_risk_country === true) out.high_risk_country = true;

  return Object.keys(out).length > 0 ? out : "ok";
}
