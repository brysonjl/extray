// Forward DNS resolution for domain-kind hosts (improvement 017): resolves the
// literal contacted host to the actual network target — its A/AAAA address(es)
// and the CNAME chain fronting it — so the enricher can RDAP-enrich the REAL
// destination instead of stopping at domain-registration facts, and so a
// CDN-fronted host can be told apart from an origin server (the CNAME chain is
// the primary CDN-detection signal; see cdn.ts).
//
// Native node:dns/promises only — no new dependency, same "native, no new HTTP
// client" posture as rdap.ts. Network-touching by design; invoked ONLY by the
// enrich-hosts CLI (RECORD), never by analyze() or the report path. Every
// lookup is dependency-injected so tests stay fully offline, exactly like
// EnrichDeps.fetchImpl in rdap.ts (record/replay posture).

import { resolve4 as dnsResolve4, resolve6 as dnsResolve6, resolveCname as dnsResolveCname } from "node:dns/promises";
import type { DnsStatus } from "./types.ts";

/** resolveHost never returns "not_applicable" — that value only describes a
 *  record for a host where resolution was never attempted (ipv4/ipv6 kind). */
export type ResolutionStatus = Exclude<DnsStatus, "not_applicable">;

export interface DnsResolution {
  status: ResolutionStatus;
  /** Distinct A/AAAA addresses found, IPv4 before IPv6, in resolver order. */
  addresses: string[];
  /** CNAME hops followed before the address-bearing name; [] when the host
   *  resolves directly with no CNAME, or none could be followed. */
  cname_chain: string[];
}

export interface ResolveDeps {
  resolve4Impl?: (host: string) => Promise<string[]>;
  resolve6Impl?: (host: string) => Promise<string[]>;
  resolveCnameImpl?: (host: string) => Promise<string[]>;
}

// Guards a misconfigured or cyclic CNAME chain — real chains are 1-3 hops.
const MAX_CNAME_HOPS = 8;

function errorCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null ? (e as { code?: string }).code : undefined;
}

/** Follow the CNAME chain from `name` until a name has no CNAME of its own
 *  (the address-bearing name) or MAX_CNAME_HOPS is reached. Never throws — a
 *  lookup failure simply ends the chain at its current length. */
async function followCnameChain(name: string, deps: ResolveDeps): Promise<string[]> {
  const resolveCname = deps.resolveCnameImpl ?? dnsResolveCname;
  const chain: string[] = [];
  let current = name;
  for (let i = 0; i < MAX_CNAME_HOPS; i++) {
    let targets: string[];
    try {
      targets = await resolveCname(current);
    } catch {
      break; // ENODATA/ENOTFOUND — current has no CNAME, chain ends here
    }
    const next = targets[0];
    if (!next) break;
    current = next.toLowerCase().replace(/\.$/, "");
    chain.push(current);
  }
  return chain;
}

/** "ENOTFOUND" (name doesn't exist), "ENODATA" (name exists, no record of this
 *  type — a confirmed negative), or "other" (resolver/transport failure — we
 *  don't actually know, distinct from a confirmed no-address result). */
type AddrOutcome = { addrs: string[]; code: "ok" | "ENOTFOUND" | "ENODATA" | "other" };

async function tryAddresses(fn: (host: string) => Promise<string[]>, host: string): Promise<AddrOutcome> {
  try {
    return { addrs: await fn(host), code: "ok" };
  } catch (e) {
    const code = errorCode(e);
    return { addrs: [], code: code === "ENOTFOUND" || code === "ENODATA" ? code : "other" };
  }
}

/**
 * Resolve a domain-kind host's literal A/AAAA addresses and the CNAME chain
 * fronting it. Never throws — a DNS failure degrades to a status, exactly like
 * an RDAP failure degrades to lookup_status; the caller decides what (if
 * anything) to do next.
 */
export async function resolveHost(host: string, deps: ResolveDeps = {}): Promise<DnsResolution> {
  const resolve4 = deps.resolve4Impl ?? dnsResolve4;
  const resolve6 = deps.resolve6Impl ?? dnsResolve6;

  const [v4, v6, cname_chain] = await Promise.all([
    tryAddresses(resolve4, host),
    tryAddresses(resolve6, host),
    followCnameChain(host, deps),
  ]);

  if (v4.code === "ENOTFOUND" && v6.code === "ENOTFOUND") return { status: "nxdomain", addresses: [], cname_chain };
  const addresses = [...new Set([...v4.addrs, ...v6.addrs])];
  if (addresses.length > 0) return { status: "ok", addresses, cname_chain };
  // Neither family yielded an address. A genuine resolver/transport failure on
  // either side means we don't actually know — "error", not a confirmed negative.
  if (v4.code === "other" || v6.code === "other") return { status: "error", addresses: [], cname_chain };
  return { status: "no_address", addresses: [], cname_chain };
}
