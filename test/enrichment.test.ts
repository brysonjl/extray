// Host-enrichment tests (improvement 015): the RDAP analog of listing.test.ts.
//
// Everything network-touching is exercised OFFLINE through an injected fetch
// stub — the only place real RDAP is hit is the enrich-hosts CLI in RECORD mode,
// and the committed corpus artifacts (corpus/<sample>/extension.host-enrichment
// .json) keep every other path hermetic. The load-bearing assertions:
//   - the artifact round-trips and is parsed tolerantly / fail-loud;
//   - the compact projection carries decision-relevant fields with NO `field:
//     null` noise and degrades non-ok lookups to a status token;
//   - the deterministic report join attaches enrichment WITHOUT moving the
//     verdict (descriptive context, never the tier);
//   - the report/projection path makes ZERO network calls (replay posture).

import { afterEach, describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENRICHMENT_FILENAME,
  EnrichmentError,
  enrichmentCandidatePaths,
  enrichmentPathFor,
  parseHostEnrichment,
  recordsByHost,
  type HostEnrichment,
  type HostEnrichmentRecord,
} from "../src/enrichment/types.ts";
import { loadEnrichmentBeside } from "../src/enrichment/load.ts";
import { deriveSignals, projectHostEnrichment } from "../src/enrichment/project.ts";
import { classifyHost, registrableDomain, enrichHost, enrichHosts, type EnrichDeps } from "../src/enrichment/rdap.ts";
import { resolveHost } from "../src/enrichment/resolve.ts";
import { matchCdn } from "../src/enrichment/cdn.ts";
import { enrichExtension, hostsToEnrich } from "../scripts/enrich-hosts.ts";
import { analyze } from "../src/pipeline/index.ts";
import { buildDestinations } from "../src/report/build.ts";
import { serializePackForPrompt } from "../src/methodologies/monolith.ts";
import { peekBlockedNetworkAttempts, takeBlockedNetworkAttempts } from "./setup-network.ts";

const PIN = "2026-01-01T00:00:00Z";

// ---------------------------------------------------------------------------
// Offline guard (W1.3; discovery §B.3.7). This file has TWO network seams, and
// neither fails loudly on its own:
//
//   - RDAP over `EnrichDeps.fetchImpl`, which defaults to the ambient global;
//   - forward DNS in resolve.ts, which imports node:dns/promises DIRECTLY and
//     only offers per-call injection via ResolveDeps.
//
// Fetch is guarded by global setup; DNS remains mocked at this module edge.
// Both are swallowed by design — enrichHost() "never throws, a failure becomes
// an error record" and resolveHost() degrades a resolver failure to a status.
// That is correct for production and hostile to a test: an omitted dep would
// hit the real IANA bootstrap and the real resolver, then quietly return a
// plausible-looking degraded record. So the guard cannot rely on an exception
// propagating; it RECORDS every attempt and afterEach turns the recording into
// a failure attributed to the test that made it. Same posture as REPLAY mode in
// src/llm/record-replay.ts: deterministic by default, never a silent live call.
//
// node:dns/promises is mocked rather than merely observed because resolve.ts
// binds its three resolvers at import time; only the module edge can intercept
// them. resolve.ts is the sole importer, so the narrow three-export mock is
// complete.
// ---------------------------------------------------------------------------

const { netAttempts } = vi.hoisted(() => ({ netAttempts: [] as string[] }));

vi.mock("node:dns/promises", () => {
  const deny = (fn: string) => async (host: string): Promise<string[]> => {
    netAttempts.push(`dns.${fn}(${host})`);
    // Shaped like a resolver failure (code + message) so the code under test
    // takes its real error path rather than an exotic one.
    throw Object.assign(new Error(`offline test suite: real DNS ${fn}("${host}") attempted`), { code: "EOFFLINE" });
  };
  return { resolve4: deny("resolve4"), resolve6: deny("resolve6"), resolveCname: deny("resolveCname") };
});

afterEach(() => {
  expect(netAttempts.splice(0), "a test in this file reached for the real DNS resolver").toEqual([]);
});

// ---------------------------------------------------------------------------
// Path helpers — sibling artifact mapping, mirrors listingPathFor exactly.
// ---------------------------------------------------------------------------

describe("enrichmentPathFor / enrichmentCandidatePaths", () => {
  it("maps an unpacked dir to <dir>.host-enrichment.json", () => {
    expect(enrichmentPathFor("example_crxs/abc")).toBe("example_crxs/abc.host-enrichment.json");
  });
  it("strips trailing slashes and never resolves inside the extension dir", () => {
    expect(enrichmentPathFor("example_crxs/abc///")).toBe("example_crxs/abc.host-enrichment.json");
    expect(enrichmentPathFor("/abs/abc").startsWith("/abs/abc/")).toBe(false);
  });
  it("returns the sibling form first, then the corpus-layout form", () => {
    expect(enrichmentCandidatePaths("corpus/x/extension")).toEqual([
      "corpus/x/extension.host-enrichment.json",
      join("corpus/x", ENRICHMENT_FILENAME),
    ]);
  });
});

// ---------------------------------------------------------------------------
// Artifact validator — tolerant per-field, fail-loud on non-artifacts.
// ---------------------------------------------------------------------------

const SAMPLE_RECORD: HostEnrichmentRecord = {
  host: "api.example.com",
  kind: "domain",
  lookup_status: "ok",
  domain: {
    registrable: "example.com",
    registrar: "Example Registrar",
    created: "2025-12-01T00:00:00Z",
    updated: "2025-12-15T00:00:00Z",
    expires: "2027-12-01T00:00:00Z",
    nameservers: ["ns1.example.com"],
    registrant_org: null,
    statuses: ["client transfer prohibited"],
  },
  ip: null,
  dns_status: "not_applicable",
  resolved_addresses: [],
  cname_chain: [],
  cdn: null,
};

const SAMPLE_ARTIFACT: HostEnrichment = {
  fetched_at: "2026-06-01T00:00:00Z",
  source: "rdap",
  hosts: [SAMPLE_RECORD],
};

describe("parseHostEnrichment", () => {
  it("round-trips a full artifact through JSON", () => {
    expect(parseHostEnrichment(JSON.parse(JSON.stringify(SAMPLE_ARTIFACT)))).toEqual(SAMPLE_ARTIFACT);
  });

  it("is tolerant per-field and drops records of the wrong shape", () => {
    const back = parseHostEnrichment({
      fetched_at: "2026-06-01T00:00:00Z",
      source: "rdap",
      hosts: [
        { host: "x.com", kind: "domain", lookup_status: "ok", domain: { registrar: 42 }, ip: null },
        { host: "y.com", kind: "bogus", lookup_status: "ok" }, // bad kind → dropped
        { kind: "domain", lookup_status: "ok" }, // no host → dropped
      ],
    });
    expect(back.hosts.length).toBe(1);
    expect(back.hosts[0]!.domain).toEqual({
      registrable: "",
      registrar: null,
      created: null,
      updated: null,
      expires: null,
      nameservers: [],
      registrant_org: null,
      statuses: [],
    });
  });

  it("defaults dns_status/resolved_addresses/cname_chain/cdn when an artifact predates 017", () => {
    // An artifact recorded before improvement 017 has no dns_status/cdn at all —
    // it must still parse, truthfully reporting "never resolved" rather than
    // being dropped or treated as malformed.
    const back = parseHostEnrichment({
      fetched_at: "2026-06-01T00:00:00Z",
      source: "rdap",
      hosts: [{ host: "legacy.com", kind: "domain", lookup_status: "ok", domain: null, ip: null }],
    });
    expect(back.hosts[0]).toMatchObject({
      dns_status: "not_applicable",
      resolved_addresses: [],
      cname_chain: [],
      cdn: null,
    });
  });

  it("throws EnrichmentError when the value is not an enrichment artifact", () => {
    expect(() => parseHostEnrichment(null)).toThrow(EnrichmentError);
    expect(() => parseHostEnrichment({})).toThrow(EnrichmentError);
    expect(() => parseHostEnrichment({ fetched_at: "x", source: "whois", hosts: [] })).toThrow(EnrichmentError);
    expect(() => parseHostEnrichment({ fetched_at: "x", source: "rdap" })).toThrow(EnrichmentError);
  });

  it("recordsByHost indexes by host (and tolerates null)", () => {
    expect(recordsByHost(SAMPLE_ARTIFACT).get("api.example.com")).toEqual(SAMPLE_RECORD);
    expect(recordsByHost(null).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Derived signals — boolean | null, null (absent) distinct from false.
// ---------------------------------------------------------------------------

function domainRecord(
  over: Partial<HostEnrichmentRecord["domain"] & object>,
  recordOver: Partial<HostEnrichmentRecord> = {},
): HostEnrichmentRecord {
  return {
    host: "h.com",
    kind: "domain",
    lookup_status: "ok",
    domain: {
      registrable: "h.com",
      registrar: null,
      created: null,
      updated: null,
      expires: null,
      nameservers: [],
      registrant_org: null,
      statuses: [],
      ...over,
    },
    ip: null,
    dns_status: "not_applicable",
    resolved_addresses: [],
    cname_chain: [],
    cdn: null,
    ...recordOver,
  };
}

describe("deriveSignals", () => {
  it("newly_registered: true within 90d, false outside, null when created unknown", () => {
    expect(deriveSignals(domainRecord({ created: "2025-11-15T00:00:00Z" }), PIN).newly_registered).toBe(true); // ~47d
    expect(deriveSignals(domainRecord({ created: "2024-01-01T00:00:00Z" }), PIN).newly_registered).toBe(false);
    expect(deriveSignals(domainRecord({ created: null }), PIN).newly_registered).toBeNull();
  });

  it("expired_or_hold: past expiry or a hold status → true; null when no expiry/status", () => {
    expect(deriveSignals(domainRecord({ expires: "2025-06-01T00:00:00Z" }), PIN).expired_or_hold).toBe(true);
    expect(deriveSignals(domainRecord({ expires: "2027-06-01T00:00:00Z" }), PIN).expired_or_hold).toBe(false);
    expect(deriveSignals(domainRecord({ statuses: ["client hold"] }), PIN).expired_or_hold).toBe(true);
    expect(deriveSignals(domainRecord({}), PIN).expired_or_hold).toBeNull();
  });

  it("high_risk_country: from IP country, three-valued", () => {
    const ip = (country: string | null): HostEnrichmentRecord => ({
      host: "1.2.3.4",
      kind: "ipv4",
      lookup_status: "ok",
      domain: null,
      ip: { network_name: "N", owner_org: "O", asn: "AS1", country, allocated: null, ptr: null },
      dns_status: "not_applicable",
      resolved_addresses: [],
      cname_chain: [],
      cdn: null,
    });
    expect(deriveSignals(ip("CN"), PIN).high_risk_country).toBe(true);
    expect(deriveSignals(ip("US"), PIN).high_risk_country).toBe(false);
    expect(deriveSignals(ip(null), PIN).high_risk_country).toBeNull();
  });

  it("high_risk_country: suppressed to null when CDN-fronted, even with a high-risk IP country (017)", () => {
    // The IP's RDAP country describes the CDN operator's edge, not the
    // destination's actual location — asserting risk from it would be exactly
    // the false-attribution problem CDN labeling exists to avoid.
    const rec = domainRecord(
      { created: "2025-12-15T00:00:00Z" },
      {
        ip: { network_name: "CLOUDFLARENET", owner_org: "Cloudflare, Inc.", asn: "AS13335", country: "CN", allocated: null, ptr: null },
        cdn: { provider: "Cloudflare", matched_by: "cname" },
      },
    );
    expect(deriveSignals(rec, PIN).high_risk_country).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Compact projection — decision-relevant, no null noise, status tokens.
// ---------------------------------------------------------------------------

describe("projectHostEnrichment", () => {
  it("ok domain → compact object with ages, no null/empty fields", () => {
    // SAMPLE_RECORD was created 31d before the pin → newly_registered fires.
    const p = projectHostEnrichment(SAMPLE_RECORD, PIN) as Record<string, unknown>;
    expect(p).toEqual({
      registrable: "example.com",
      registrar: "Example Registrar",
      registered_days_ago: 31,
      expires_in_days: 699,
      newly_registered: true,
    });
    // No null/empty noise leaks: nameservers, statuses, updated, registrant_org all dropped.
    expect(JSON.stringify(p)).not.toContain("null");
    expect(p).not.toHaveProperty("registrant_org");
    expect(p).not.toHaveProperty("nameservers");
  });

  it("non-ok lookups degrade to a short status token, not an object of nulls", () => {
    for (const status of ["redacted", "not_found", "error"] as const) {
      const rec: HostEnrichmentRecord = {
        host: "h", kind: "domain", lookup_status: status, domain: null, ip: null,
        dns_status: "not_applicable", resolved_addresses: [], cname_chain: [], cdn: null,
      };
      expect(projectHostEnrichment(rec, PIN)).toBe(status);
    }
  });

  it("includes only TRUE derived flags", () => {
    const rec = domainRecord({ created: "2025-12-15T00:00:00Z", expires: "2025-06-01T00:00:00Z", statuses: ["server hold"] });
    const p = projectHostEnrichment(rec, PIN) as Record<string, unknown>;
    expect(p.newly_registered).toBe(true);
    expect(p.expired_or_hold).toBe(true);
    expect(p).not.toHaveProperty("high_risk_country"); // null signal omitted, never `false`
  });

  it("ip → kind + owner/asn/country, age, no nulls", () => {
    const rec: HostEnrichmentRecord = {
      host: "8.8.8.8",
      kind: "ipv4",
      lookup_status: "ok",
      domain: null,
      ip: { network_name: "GOGL", owner_org: "Google LLC", asn: "AS15169", country: "US", allocated: "2014-03-14T00:00:00Z", ptr: null },
      dns_status: "not_applicable",
      resolved_addresses: [],
      cname_chain: [],
      cdn: null,
    };
    const p = projectHostEnrichment(rec, PIN) as Record<string, unknown>;
    expect(p.kind).toBe("ipv4");
    expect(p.owner_org).toBe("Google LLC");
    expect(p.asn).toBe("AS15169");
    expect(JSON.stringify(p)).not.toContain("null"); // ptr:null never leaks
  });

  it("domain + resolved IP, no CDN match → surfaces resolved_owner_org/asn/country (017)", () => {
    const rec = domainRecord(
      { created: "2025-12-15T00:00:00Z" },
      { ip: { network_name: "EXAMPLE-NET", owner_org: "Example Hosting LLC", asn: "AS64500", country: "DE", allocated: null, ptr: null } },
    );
    const p = projectHostEnrichment(rec, PIN) as Record<string, unknown>;
    expect(p.resolved_owner_org).toBe("Example Hosting LLC");
    expect(p.resolved_asn).toBe("AS64500");
    expect(p.resolved_country).toBe("DE");
  });

  it("domain + CDN match → cdn label replaces the resolved IP facts (017)", () => {
    const rec = domainRecord(
      { created: "2025-12-15T00:00:00Z" },
      {
        ip: { network_name: "CLOUDFLARENET", owner_org: "Cloudflare, Inc.", asn: "AS13335", country: "US", allocated: null, ptr: null },
        cdn: { provider: "Cloudflare", matched_by: "cname" },
      },
    );
    const p = projectHostEnrichment(rec, PIN) as Record<string, unknown>;
    expect(p.cdn).toBe("Cloudflare");
    expect(p).not.toHaveProperty("resolved_owner_org");
    expect(p).not.toHaveProperty("resolved_asn");
    expect(p).not.toHaveProperty("resolved_country");
    expect(p).not.toHaveProperty("high_risk_country"); // suppressed to null, so omitted too
  });

  it("literal IP + CDN match → cdn label replaces the raw owner/asn/country facts (017)", () => {
    const rec: HostEnrichmentRecord = {
      host: "104.16.1.1",
      kind: "ipv4",
      lookup_status: "ok",
      domain: null,
      ip: { network_name: "CLOUDFLARENET", owner_org: "Cloudflare, Inc.", asn: "AS13335", country: "US", allocated: "2014-03-14T00:00:00Z", ptr: null },
      dns_status: "not_applicable",
      resolved_addresses: [],
      cname_chain: [],
      cdn: { provider: "Cloudflare", matched_by: "org" },
    };
    const p = projectHostEnrichment(rec, PIN) as Record<string, unknown>;
    expect(p.kind).toBe("ipv4");
    expect(p.cdn).toBe("Cloudflare");
    expect(p).not.toHaveProperty("owner_org");
    expect(p).not.toHaveProperty("asn");
    expect(p).not.toHaveProperty("country");
    expect(p).not.toHaveProperty("allocated_days_ago");
  });
});

// ---------------------------------------------------------------------------
// Host classification + registrable-domain heuristic.
// ---------------------------------------------------------------------------

describe("classifyHost / registrableDomain", () => {
  it("classifies domains and IPs, stripping ports", () => {
    expect(classifyHost("api.example.com")).toEqual({ kind: "domain", query: "api.example.com" });
    expect(classifyHost("example.com:8443")).toEqual({ kind: "domain", query: "example.com" });
    expect(classifyHost("1.2.3.4")).toEqual({ kind: "ipv4", query: "1.2.3.4" });
    expect(classifyHost("1.2.3.4:8080")).toEqual({ kind: "ipv4", query: "1.2.3.4" });
    expect(classifyHost("[2001:db8::1]:443")).toEqual({ kind: "ipv6", query: "2001:db8::1" });
    expect(classifyHost("2001:db8::1")).toEqual({ kind: "ipv6", query: "2001:db8::1" });
  });

  it("extracts the registrable domain via the suffix heuristic", () => {
    expect(registrableDomain("api.example.com")).toBe("example.com");
    expect(registrableDomain("example.com")).toBe("example.com");
    expect(registrableDomain("a.b.c.example.com")).toBe("example.com");
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("localhost")).toBe("localhost");
  });
});

// ---------------------------------------------------------------------------
// Forward DNS resolution (017) — fully offline via injected resolve*Impl.
// ---------------------------------------------------------------------------

describe("resolveHost (offline)", () => {
  it("ok: dedups A/AAAA addresses, IPv4 before IPv6", async () => {
    const r = await resolveHost("example.com", {
      resolve4Impl: async () => ["1.2.3.4", "1.2.3.4"],
      resolve6Impl: async () => ["2001:db8::1"],
      resolveCnameImpl: notFound,
    });
    expect(r).toEqual({ status: "ok", addresses: ["1.2.3.4", "2001:db8::1"], cname_chain: [] });
  });

  it("nxdomain: both families report ENOTFOUND", async () => {
    const r = await resolveHost("ghost.example.com", { resolve4Impl: notFound, resolve6Impl: notFound, resolveCnameImpl: notFound });
    expect(r.status).toBe("nxdomain");
    expect(r.addresses).toEqual([]);
  });

  it("no_address: the name exists (ENODATA) but has no A/AAAA", async () => {
    const enodata = () => Promise.reject(Object.assign(new Error("no data"), { code: "ENODATA" }));
    const r = await resolveHost("mail-only.example.com", { resolve4Impl: enodata, resolve6Impl: enodata, resolveCnameImpl: notFound });
    expect(r.status).toBe("no_address");
  });

  it("error: a genuine resolver failure is distinct from a confirmed no_address", async () => {
    const timeout = () => Promise.reject(Object.assign(new Error("timed out"), { code: "ETIMEOUT" }));
    const r = await resolveHost("flaky.example.com", { resolve4Impl: timeout, resolve6Impl: notFound, resolveCnameImpl: notFound });
    expect(r.status).toBe("error");
  });

  it("follows a multi-hop CNAME chain until the address-bearing name", async () => {
    const cnames: Record<string, string[]> = {
      "api.example.com": ["edge.intermediate.net"],
      "edge.intermediate.net": ["target.cloudfront.net"],
    };
    const r = await resolveHost("api.example.com", {
      resolve4Impl: async () => ["5.6.7.8"],
      resolve6Impl: notFound,
      resolveCnameImpl: async (h: string) => cnames[h] ?? Promise.reject(Object.assign(new Error("no cname"), { code: "ENODATA" })),
    });
    expect(r.cname_chain).toEqual(["edge.intermediate.net", "target.cloudfront.net"]);
  });
});

// ---------------------------------------------------------------------------
// CDN matching (017) — against the real cdn-providers.json policy data.
// ---------------------------------------------------------------------------

describe("matchCdn", () => {
  it("matches by CNAME suffix (highest priority)", () => {
    expect(matchCdn(["d111111abcdef8.cloudfront.net"], null)).toEqual({ provider: "Amazon CloudFront", matched_by: "cname" });
  });

  it("matches by RDAP org pattern when no CNAME is available", () => {
    const ip = { network_name: "CLOUDFLARENET", owner_org: "Cloudflare, Inc.", asn: null, country: "US", allocated: null, ptr: null };
    expect(matchCdn([], ip)).toEqual({ provider: "Cloudflare", matched_by: "org" });
  });

  it("matches by ASN only as a last resort", () => {
    const ip = { network_name: null, owner_org: null, asn: "AS199524", country: null, allocated: null, ptr: null };
    expect(matchCdn([], ip)).toEqual({ provider: "Gcore", matched_by: "asn" });
  });

  it("prefers a CNAME match over a conflicting org/ASN match", () => {
    const ip = { network_name: "CLOUDFLARENET", owner_org: "Cloudflare, Inc.", asn: "AS13335", country: "US", allocated: null, ptr: null };
    expect(matchCdn(["assets.cloudfront.net"], ip)).toEqual({ provider: "Amazon CloudFront", matched_by: "cname" });
  });

  it("returns null when nothing matches (a plain origin server)", () => {
    const ip = { network_name: "SOME-HOSTING-CO", owner_org: "Example Hosting LLC", asn: "AS64500", country: "DE", allocated: null, ptr: null };
    expect(matchCdn(["origin.example.com"], ip)).toBeNull();
    expect(matchCdn([], null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// RDAP enrichment — fully offline via an injected fetch stub.
// ---------------------------------------------------------------------------

const DNS_BOOTSTRAP = { services: [[["com"], ["https://rdap.test/com/"]]] };
const IPV4_BOOTSTRAP = { services: [[["8.0.0.0/8"], ["https://rdap.arin.test/"]]] };

const DOMAIN_OK = {
  ldhName: "EXAMPLE.COM",
  status: ["client transfer prohibited"],
  events: [
    { eventAction: "registration", eventDate: "2025-12-01T00:00:00Z" },
    { eventAction: "expiration", eventDate: "2027-12-01T00:00:00Z" },
    { eventAction: "last changed", eventDate: "2025-12-15T00:00:00Z" },
  ],
  nameservers: [{ ldhName: "NS1.EXAMPLE.COM" }, { ldhName: "NS2.EXAMPLE.COM" }],
  entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Example Registrar"]]] }],
};

const IP_OK = {
  name: "GOGL",
  country: "US",
  events: [{ eventAction: "registration", eventDate: "2014-03-14T00:00:00Z" }],
  entities: [{ roles: ["registrant"], vcardArray: ["vcard", [["fn", {}, "text", "Google LLC"]]] }],
  arin_originas0_originautnums: [15169],
};

// ENOTFOUND by default so every existing offline test's domain-host lookups
// never touch real DNS (the enricher resolves domain-kind hosts as of 017) —
// tests that want to exercise resolution pass their own resolve*Impl overrides.
function notFound(): Promise<never> {
  return Promise.reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
}

function stub(
  routes: Array<[string, { status?: number; body?: unknown }]>,
  resolveOverrides: Partial<EnrichDeps> = {},
): { deps: EnrichDeps; calls: () => number } {
  let n = 0;
  const impl = (async (url: string) => {
    n++;
    for (const [frag, r] of routes) {
      if (String(url).includes(frag)) {
        return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200 });
      }
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return {
    deps: {
      fetchImpl: impl,
      jitterMs: 0,
      retries: 0,
      bootstrapCache: new Map(),
      resolve4Impl: notFound,
      resolve6Impl: notFound,
      resolveCnameImpl: notFound,
      ...resolveOverrides,
    },
    calls: () => n,
  };
}

describe("enrichHost (offline)", () => {
  it("parses an OK domain object (events, registrar, nameservers, statuses)", async () => {
    const { deps } = stub([
      ["rdap/dns.json", { body: DNS_BOOTSTRAP }],
      ["domain/example.com", { body: DOMAIN_OK }],
    ]);
    const rec = await enrichHost("api.example.com", deps);
    expect(rec.lookup_status).toBe("ok");
    expect(rec.domain).toMatchObject({
      registrable: "example.com",
      registrar: "Example Registrar",
      created: "2025-12-01T00:00:00Z",
      expires: "2027-12-01T00:00:00Z",
      nameservers: ["ns1.example.com", "ns2.example.com"],
      statuses: ["client transfer prohibited"],
    });
  });

  it("maps HTTP 404 to lookup_status not_found", async () => {
    const { deps } = stub([["rdap/dns.json", { body: DNS_BOOTSTRAP }], ["domain/example.com", { status: 404 }]]);
    expect((await enrichHost("example.com", deps)).lookup_status).toBe("not_found");
  });

  it("maps RFC 9537 redaction (no created) to lookup_status redacted", async () => {
    const redacted = { ldhName: "EXAMPLE.COM", redacted: [{ name: { type: "Registrant" } }], events: [], entities: [] };
    const { deps } = stub([["rdap/dns.json", { body: DNS_BOOTSTRAP }], ["domain/example.com", { body: redacted }]]);
    expect((await enrichHost("example.com", deps)).lookup_status).toBe("redacted");
  });

  it("parses an OK IP object (owner, ASN, country) via the IP bootstrap", async () => {
    const { deps } = stub([["rdap/ipv4.json", { body: IPV4_BOOTSTRAP }], ["ip/8.8.8.8", { body: IP_OK }]]);
    const rec = await enrichHost("8.8.8.8", deps);
    expect(rec.kind).toBe("ipv4");
    expect(rec.ip).toMatchObject({ network_name: "GOGL", owner_org: "Google LLC", asn: "AS15169", country: "US" });
  });

  it("maps a transport failure to lookup_status error (never throws)", async () => {
    const deps: EnrichDeps = {
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
      jitterMs: 0,
      retries: 0,
      bootstrapCache: new Map(),
      resolve4Impl: notFound,
      resolve6Impl: notFound,
      resolveCnameImpl: notFound,
    };
    expect((await enrichHost("example.com", deps)).lookup_status).toBe("error");
  });

  it("ipv4/ipv6-kind hosts never attempt DNS resolution (dns_status not_applicable)", async () => {
    const { deps } = stub([["rdap/ipv4.json", { body: IPV4_BOOTSTRAP }], ["ip/8.8.8.8", { body: IP_OK }]]);
    const rec = await enrichHost("8.8.8.8", deps);
    expect(rec.dns_status).toBe("not_applicable");
    expect(rec.resolved_addresses).toEqual([]);
    expect(rec.cname_chain).toEqual([]);
  });

  it("resolves a domain host's actual IP and RDAP-enriches it (017)", async () => {
    const { deps } = stub(
      [
        ["rdap/dns.json", { body: DNS_BOOTSTRAP }],
        ["domain/example.com", { body: DOMAIN_OK }],
        ["rdap/ipv4.json", { body: IPV4_BOOTSTRAP }],
        ["ip/8.8.8.8", { body: IP_OK }],
      ],
      { resolve4Impl: async () => ["8.8.8.8"] },
    );
    const rec = await enrichHost("api.example.com", deps);
    expect(rec.lookup_status).toBe("ok"); // domain RDAP unaffected
    expect(rec.dns_status).toBe("ok");
    expect(rec.resolved_addresses).toEqual(["8.8.8.8"]);
    expect(rec.ip).toMatchObject({ owner_org: "Google LLC", asn: "AS15169", country: "US" });
  });

  it("a DNS failure does not blank out a successful domain RDAP lookup (independent failures)", async () => {
    const { deps } = stub([["rdap/dns.json", { body: DNS_BOOTSTRAP }], ["domain/example.com", { body: DOMAIN_OK }]]);
    // stub()'s default resolvers are ENOTFOUND for every host.
    const rec = await enrichHost("api.example.com", deps);
    expect(rec.lookup_status).toBe("ok");
    expect(rec.domain).not.toBeNull();
    expect(rec.dns_status).toBe("nxdomain");
    expect(rec.ip).toBeNull();
  });

  it("a failed domain RDAP lookup does not block DNS resolution (independent failures)", async () => {
    const { deps } = stub(
      [["rdap/dns.json", { body: DNS_BOOTSTRAP }], ["domain/example.com", { status: 404 }]],
      { resolve4Impl: async () => ["8.8.8.8"] },
    );
    const rec = await enrichHost("example.com", deps);
    expect(rec.lookup_status).toBe("not_found");
    expect(rec.domain).toBeNull();
    expect(rec.dns_status).toBe("ok");
    expect(rec.resolved_addresses).toEqual(["8.8.8.8"]);
  });

  it("labels a resolved CDN-fronted host instead of asserting the edge IP's country (017)", async () => {
    const CLOUDFLARE_IP = {
      name: "CLOUDFLARENET",
      country: "US",
      events: [],
      entities: [{ roles: ["registrant"], vcardArray: ["vcard", [["fn", {}, "text", "Cloudflare, Inc."]]] }],
    };
    const { deps } = stub(
      [
        ["rdap/dns.json", { body: DNS_BOOTSTRAP }],
        ["domain/example.com", { body: DOMAIN_OK }],
        ["rdap/ipv4.json", { body: IPV4_BOOTSTRAP }],
        ["ip/8.8.8.8", { body: CLOUDFLARE_IP }],
      ],
      {
        resolve4Impl: async () => ["8.8.8.8"],
        // Only the original name has a CNAME; the target itself does not — a
        // realistic single-hop chain that correctly terminates the loop.
        resolveCnameImpl: async (h: string) => {
          if (h === "api.example.com") return ["edge.cdn.cloudflare.net"];
          throw Object.assign(new Error("no cname"), { code: "ENODATA" });
        },
      },
    );
    const rec = await enrichHost("api.example.com", deps);
    expect(rec.cname_chain).toEqual(["edge.cdn.cloudflare.net"]);
    expect(rec.cdn).toEqual({ provider: "Cloudflare", matched_by: "cname" });
  });

  it("enrichHosts returns one record per host, sorted, with the staleness stamp", async () => {
    const { deps } = stub([["rdap/dns.json", { body: DNS_BOOTSTRAP }], ["domain/example.com", { body: DOMAIN_OK }]]);
    const art = await enrichHosts(["b.example.com", "a.example.com"], "2026-06-01T00:00:00Z", deps);
    expect(art.source).toBe("rdap");
    expect(art.fetched_at).toBe("2026-06-01T00:00:00Z");
    expect(art.hosts.map((h) => h.host)).toEqual(["a.example.com", "b.example.com"]);
  });
});

// ---------------------------------------------------------------------------
// enrich-hosts CLI — write-location, skip-when-fresh (zero network), --force.
// ---------------------------------------------------------------------------

function tempExtension(host: string): string {
  const root = mkdtempSync(join(tmpdir(), "enrich-"));
  const ext = join(root, "extension");
  mkdirSync(ext, { recursive: true });
  writeFileSync(join(ext, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "t", version: "1", permissions: ["storage"] }));
  writeFileSync(join(ext, "background.js"), `fetch("https://${host}/collect");\n`);
  return ext;
}

describe("enrichExtension (offline)", () => {
  it("writes the artifact as a sibling of the extension dir, never inside it", async () => {
    const ext = tempExtension("api.example.com");
    expect(hostsToEnrich(ext)).toContain("api.example.com");
    const { deps, calls } = stub([["rdap/dns.json", { body: DNS_BOOTSTRAP }], ["domain/example.com", { body: DOMAIN_OK }]]);

    const r = await enrichExtension(ext, { force: false }, deps);
    expect(r.artifactPath).toBe(`${ext}.host-enrichment.json`);
    expect(existsSync(r.artifactPath)).toBe(true);
    expect(existsSync(join(ext, ENRICHMENT_FILENAME))).toBe(false); // root stays pristine
    const art = parseHostEnrichment(JSON.parse(readFileSync(r.artifactPath, "utf8")));
    expect(art.hosts[0]!.host).toBe("api.example.com");
    const networkAfterFirst = calls();

    // Re-run: a fresh artifact covering every host is reused — ZERO new requests.
    const r2 = await enrichExtension(ext, { force: false }, deps);
    expect(r2.skipped).toBe(true);
    expect(calls()).toBe(networkAfterFirst);

    // --force re-enriches.
    const r3 = await enrichExtension(ext, { force: true }, deps);
    expect(r3.skipped).toBe(false);
    expect(calls()).toBeGreaterThan(networkAfterFirst);
    rmSync(ext, { recursive: true, force: true });
    rmSync(`${ext}.host-enrichment.json`, { force: true });
  });
});

// ---------------------------------------------------------------------------
// Integration against the committed corpus artifacts (replay = zero network).
// ---------------------------------------------------------------------------

describe("committed corpus enrichment (replay)", () => {
  // The control retains public RDAP metadata for unchanged infrastructure.
  // Reserved demo/mutant hosts carry no fabricated real-host enrichment.
  const DIR = "corpus/demo-cookie-manager/extension";
  const pack = analyze(DIR, { analyzedAt: PIN });
  const enrichment = loadEnrichmentBeside(DIR);

  it("an artifact is committed and covers the external hosts", () => {
    expect(enrichment).not.toBeNull();
    expect(enrichment!.hosts.length).toBeGreaterThan(0);
  });

  it("buildDestinations attaches enrichment by host-keyed join (descriptive, not the tier)", () => {
    const rows = buildDestinations(pack, enrichment).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.enrichment !== undefined)).toBe(true);
    expect(rows.some((r) => r.enrichment && r.enrichment.lookup_status === "ok")).toBe(true);
    // A host with no record stays explicit-null, never a fabricated clean signal.
    const noArtifact = buildDestinations(pack, null).rows;
    expect(noArtifact.every((r) => r.enrichment === null)).toBe(true);
  });

  it("serializePackForPrompt folds the compact projection only when enrichment is supplied", () => {
    const withE = serializePackForPrompt(pack, enrichment);
    const withoutE = serializePackForPrompt(pack);
    expect(withoutE).toBe(serializePackForPrompt(pack, null)); // null == omitted, byte-identical
    expect(withoutE).not.toContain("registered_days_ago");
    expect(withE).toContain("registered_days_ago");
    expect(withE).toContain("enrichment");
  });
});

// ---------------------------------------------------------------------------
// The guard's own regression tests: without these the guard could rot into a
// no-op (a stray restore, a dropped vi.mock) and the live RDAP/DNS traffic
// would come back unnoticed — precisely because both seams fail silently.
// ---------------------------------------------------------------------------

describe("offline guard — RDAP and DNS are the only network seams", () => {
  it("is armed: omitting every dep records both attempts instead of reaching the network", async () => {
    // No fetchImpl, no resolve*Impl — the exact mistake the guard exists to catch.
    const rec = await enrichHost("example.com", { retries: 0, jitterMs: 0 });

    // Note what this proves: enrichHost DID NOT THROW. It returned a degraded
    // record that a careless assertion could still accept. Only the recording
    // below distinguishes "blocked" from "the network was quietly hit".
    expect(rec.lookup_status).toBe("error");
    expect(rec.dns_status).toBe("error");

    // Drained here so afterEach sees a clean slate: these attempts are the point.
    const attempted = [...netAttempts.splice(0), ...takeBlockedNetworkAttempts()];
    expect(attempted).toContain("https://data.iana.org/rdap/dns.json");
    expect(attempted).toContain("dns.resolve4(example.com)");
    expect(attempted).toContain("dns.resolve6(example.com)");
    expect(attempted).toContain("dns.resolveCname(example.com)");
  });

  it("stays quiet on the injected path: the stub serves both seams", async () => {
    // stub()'s default resolvers are ENOTFOUND for every host, so a dns_status
    // of "nxdomain" (not the mock's "error") is itself proof the INJECTED
    // resolvers ran and the module-edge mock was never reached.
    const { deps, calls } = stub([
      ["rdap/dns.json", { body: DNS_BOOTSTRAP }],
      ["domain/example.com", { body: DOMAIN_OK }],
    ]);
    const rec = await enrichHost("api.example.com", deps);
    expect(rec.lookup_status).toBe("ok");
    expect(rec.dns_status).toBe("nxdomain");
    expect(calls()).toBeGreaterThan(0);
    expect(netAttempts).toEqual([]);
    expect(peekBlockedNetworkAttempts()).toEqual([]);
  });
});
