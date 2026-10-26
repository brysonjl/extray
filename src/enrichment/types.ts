// Host-enrichment artifact contract (improvement 015). The enricher
// (scripts/enrich-hosts.ts) writes one artifact next to each unpacked
// extension carrying RDAP-derived registration/ownership context for every
// external host the extension's code reaches. Downstream consumers read it
// back through parseHostEnrichment.
//
// This is the RDAP analog of the 008b store-listing artifact and follows the
// SAME conventions deliberately (do not invent new ones):
//   - The artifact lives OUTSIDE the evidence pack. The static pipeline stays
//     deterministic and offline (analyze() never fetches); the artifact is
//     merged in at assembly time, exactly like developer-listing.json.
//   - Placement: the artifact is a SIBLING of the unpacked extension dir,
//     never a file inside it. `example_crxs/<id>/` (and `corpus/<sample>/
//     extension/`) IS the unpacked extension root — the static pipeline walks
//     every file under it, so a host-enrichment.json inside would be ingested
//     as an extension file and contaminate analysis. enrichmentPathFor is the
//     single source of truth for the sibling mapping; enrichmentCandidatePaths
//     is what integrators use to find an artifact for a given extension dir.
//   - Explicit-null convention: every field RDAP did not state is null (or []
//     for absent lists), never missing and never guessed. `lookup_status`
//     distinguishes the cases that otherwise collapse to "no data": `redacted`
//     (server answered, fields withheld per RFC 9537) is NOT `not_found` (no
//     such object) is NOT `error` (the lookup itself failed). A missing host
//     entry means "never enriched", never "clean".
//
// The `source: "rdap"` discriminator is reserved so a later geo/reputation tier
// ("maxmind"/"virustotal", deferred from v1) can sit beside the RDAP block
// without a schema break.
//
// v1.1 (improvement 017) adds the actual network target for domain-kind hosts:
// forward DNS resolution (native node:dns, not RDAP — same "reserved network
// surface" caveat as the deferred ip.ptr) plus the CNAME chain that fronts the
// host, RDAP-enriched on the FIRST resolved address so `ip` now also populates
// for domain-kind records. A CDN match (cdn-providers.json) labels hosts fronted
// by a known CDN/edge network — when present, `ip.country`/`owner_org`/`asn`
// describe the CDN operator's edge, NOT the destination's actual location, and
// must be presented as such (see deriveSignals/projectHostEnrichment, which
// suppress/relabel accordingly). DNS answers are far more volatile than RDAP
// registration facts (TTLs of minutes, GeoDNS), so resolved_addresses/cdn carry
// the SAME artifact-level staleness caveat already documented for RDAP
// `expires`/`statuses` — this is a known limitation, not a bug.

import { dirname, join } from "node:path";

export class EnrichmentError extends Error {}

/** Artifact basename used by the corpus layout (`corpus/<sample>/host-enrichment.json`). */
export const ENRICHMENT_FILENAME = "host-enrichment.json";

/**
 * Sibling artifact path for an unpacked extension dir:
 * `example_crxs/<id>` → `example_crxs/<id>.host-enrichment.json`.
 * Never resolves to a path inside the extension dir.
 */
export function enrichmentPathFor(extensionDir: string): string {
  return `${extensionDir.replace(/\/+$/, "")}.host-enrichment.json`;
}

/**
 * Candidate artifact locations for an unpacked extension dir, in lookup order:
 *   1. the sibling-file form `<dir>.host-enrichment.json` (what the enrich-hosts
 *      CLI writes for `example_crxs/<id>/`), then
 *   2. the corpus-layout form `<parent>/host-enrichment.json` (e.g.
 *      `corpus/<sample>/host-enrichment.json` beside `extension/`).
 * Integrators read the first candidate that exists.
 */
export function enrichmentCandidatePaths(extensionDir: string): string[] {
  const dir = extensionDir.replace(/\/+$/, "");
  return [enrichmentPathFor(dir), join(dirname(dir), ENRICHMENT_FILENAME)];
}

/** How the host was classified for its RDAP lookup. */
export type HostKind = "domain" | "ipv4" | "ipv6";

/**
 * Outcome of one host's RDAP lookup. Distinguishes cases that otherwise all
 * read as "no data": redacted (answered, fields withheld) vs not_found (no such
 * object) vs error (the lookup failed). `ok` does NOT mean every field is
 * populated — individual fields stay null when RDAP omits them.
 */
export type LookupStatus = "ok" | "redacted" | "not_found" | "error";

/** Domain registration facts (present when kind === "domain"; else null). */
export interface DomainEnrichment {
  registrable: string; // the registrable domain queried (e.g. example.com)
  registrar: string | null;
  created: string | null; // ISO-8601 — the high-signal field
  updated: string | null; // ISO-8601
  expires: string | null; // ISO-8601
  nameservers: string[];
  registrant_org: string | null; // often redacted post-GDPR
  statuses: string[]; // EPP statuses, e.g. clientHold
}

/**
 * IP allocation facts. Present when kind === "ipv4"/"ipv6" (the host itself is
 * the IP), OR when kind === "domain" and forward DNS resolution + IP RDAP both
 * succeeded (017) — in that case these facts describe `resolved_addresses[0]`,
 * the address the host currently points to, not the host string itself.
 */
export interface IpEnrichment {
  network_name: string | null;
  owner_org: string | null; // RDAP entity with role registrant
  asn: string | null; // e.g. AS13335; null when the RIR omits an origin AS
  country: string | null; // ISO-2
  allocated: string | null; // ISO-8601
  ptr: string | null; // reverse DNS — reserved; deferred in v1 (RDAP-only)
}

/** Outcome of resolving a domain-kind host's literal A/AAAA addresses (017).
 *  "not_applicable" is the only valid value for ipv4/ipv6-kind hosts — there is
 *  nothing to resolve when the host string is already the IP. Distinguishes
 *  "the name doesn't exist" (nxdomain) from "it exists but has no address record"
 *  (no_address) from a transport/resolver failure (error), same "don't collapse
 *  distinct no-data cases" posture as `lookup_status`. */
export type DnsStatus = "ok" | "nxdomain" | "no_address" | "error" | "not_applicable";

export type CdnMatchedBy = "cname" | "org" | "asn";

/** A host matched against the CDN/edge-network policy list (cdn-providers.json,
 *  017). When present, the IP-registration facts (`ip.country`/`owner_org`/`asn`)
 *  describe the CDN operator's edge, not the destination's actual location —
 *  consumers must label accordingly rather than asserting them as origin facts. */
export interface CdnMatch {
  provider: string;
  matched_by: CdnMatchedBy;
}

/** One host's enrichment record; `host` keys it against destination_summary. */
export interface HostEnrichmentRecord {
  host: string; // matches a destination_summary host (normalized by destinationHostOf)
  kind: HostKind;
  lookup_status: LookupStatus;
  domain: DomainEnrichment | null;
  ip: IpEnrichment | null;
  /** Forward-DNS resolution outcome for the literal contacted host (017). */
  dns_status: DnsStatus;
  /** Every distinct A/AAAA address found; [] unless dns_status === "ok". `ip`
   *  (when populated for a domain-kind record) describes resolved_addresses[0]. */
  resolved_addresses: string[];
  /** CNAME hops followed before the address record; [] when none/not_applicable.
   *  The primary CDN-detection signal — see CdnMatch. */
  cname_chain: string[];
  cdn: CdnMatch | null;
}

export interface HostEnrichment {
  fetched_at: string; // ISO-8601 — staleness stamp (re-fetched when older than 30d on RECORD)
  source: "rdap";
  hosts: HostEnrichmentRecord[];
}

function coerceString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function coerceStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

const HOST_KINDS = new Set<HostKind>(["domain", "ipv4", "ipv6"]);
const LOOKUP_STATUSES = new Set<LookupStatus>(["ok", "redacted", "not_found", "error"]);
const DNS_STATUSES = new Set<DnsStatus>(["ok", "nxdomain", "no_address", "error", "not_applicable"]);
const CDN_MATCHED_BY = new Set<CdnMatchedBy>(["cname", "org", "asn"]);

function coerceDomain(v: unknown): DomainEnrichment | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    registrable: typeof o.registrable === "string" ? o.registrable : "",
    registrar: coerceString(o.registrar),
    created: coerceString(o.created),
    updated: coerceString(o.updated),
    expires: coerceString(o.expires),
    nameservers: coerceStringArray(o.nameservers),
    registrant_org: coerceString(o.registrant_org),
    statuses: coerceStringArray(o.statuses),
  };
}

function coerceIp(v: unknown): IpEnrichment | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  return {
    network_name: coerceString(o.network_name),
    owner_org: coerceString(o.owner_org),
    asn: coerceString(o.asn),
    country: coerceString(o.country),
    allocated: coerceString(o.allocated),
    ptr: coerceString(o.ptr),
  };
}

// dns_status/resolved_addresses/cname_chain/cdn are additive (017): tolerant
// per-field, same as domain/ip, so an artifact recorded before this addition
// still parses — it just truthfully carries "never resolved" defaults rather
// than being dropped or treated as a malformed record.
function coerceDnsStatus(v: unknown): DnsStatus {
  return typeof v === "string" && DNS_STATUSES.has(v as DnsStatus) ? (v as DnsStatus) : "not_applicable";
}

function coerceCdn(v: unknown): CdnMatch | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.provider !== "string" || !CDN_MATCHED_BY.has(o.matched_by as CdnMatchedBy)) return null;
  return { provider: o.provider, matched_by: o.matched_by as CdnMatchedBy };
}

/**
 * Validate + normalize a parsed host-enrichment.json. Tolerant per-field
 * (unknown/missing optional fields coerce to null/[], same posture as the
 * listing/findings coerce helpers) but fail-loud when the value is not an
 * enrichment artifact at all — the identity fields the enricher always writes
 * (fetched_at, source "rdap", a hosts array) are the gate. A record whose
 * host/kind/lookup_status are not the expected shape is dropped rather than
 * poisoning the whole artifact.
 */
export function parseHostEnrichment(json: unknown): HostEnrichment {
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new EnrichmentError("host enrichment must be a JSON object");
  }
  const o = json as Record<string, unknown>;
  if (typeof o.fetched_at !== "string") {
    throw new EnrichmentError("host enrichment is missing fetched_at — not an enrichment artifact");
  }
  if (o.source !== "rdap") {
    throw new EnrichmentError(`host enrichment has unknown source ${JSON.stringify(o.source)}`);
  }
  if (!Array.isArray(o.hosts)) {
    throw new EnrichmentError("host enrichment is missing a hosts array — not an enrichment artifact");
  }

  const hosts: HostEnrichmentRecord[] = [];
  for (const raw of o.hosts) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.host !== "string") continue;
    if (!HOST_KINDS.has(r.kind as HostKind)) continue;
    if (!LOOKUP_STATUSES.has(r.lookup_status as LookupStatus)) continue;
    hosts.push({
      host: r.host,
      kind: r.kind as HostKind,
      lookup_status: r.lookup_status as LookupStatus,
      domain: coerceDomain(r.domain),
      ip: coerceIp(r.ip),
      dns_status: coerceDnsStatus(r.dns_status),
      resolved_addresses: coerceStringArray(r.resolved_addresses),
      cname_chain: coerceStringArray(r.cname_chain),
      cdn: coerceCdn(r.cdn),
    });
  }
  return { fetched_at: o.fetched_at, source: "rdap", hosts };
}

/** Index an artifact's records by host for the host-keyed join consumers do. */
export function recordsByHost(enrichment: HostEnrichment | null | undefined): Map<string, HostEnrichmentRecord> {
  const map = new Map<string, HostEnrichmentRecord>();
  for (const r of enrichment?.hosts ?? []) map.set(r.host, r);
  return map;
}
