// CDN/edge-network detection (improvement 017): labels a host as fronted by a
// known CDN so the report can say "fronted by Cloudflare" instead of asserting
// the RDAP IP-registration country as the destination's actual location — edge
// IPs report the CDN operator's registration country, not the origin's.
//
// cdn-providers.json is a DATA file, not code — same "policy reviewable and
// swappable per deployment" pattern as high-risk-countries.json (src/listing/
// country.ts). Matching priority, most to least reliable:
//   1. CNAME suffix — the chain DNS resolution followed to reach the address
//      record. Cheap, ASN-independent, and the strongest signal: most CDNs put
//      customer traffic behind a distinctive CNAME before the final A/AAAA.
//   2. org_patterns — substring match against the RDAP IP entity/network name.
//      Catches CDNs that anycast straight to an IP with no exposed CNAME.
//   3. asns — corroborating only. Our RDAP pipeline only extracts an origin AS
//      when the IP's RIR is ARIN (see rdap.ts's parseAsn) — RIPE/APNIC/LACNIC/
//      AFRINIC IP objects leave it null — so this signal alone would miss most
//      non-ARIN-registered CDN edge nodes.

import { createRequire } from "node:module";
import type { CdnMatch, IpEnrichment } from "./types.ts";

const require = createRequire(import.meta.url);

interface CdnProvider {
  name: string;
  cname_suffixes: string[];
  org_patterns: string[];
  asns: string[];
}

interface CdnProvidersData {
  version: number;
  note: string;
  providers: CdnProvider[];
}

const CDN_PROVIDERS = require("../pipeline/data/cdn-providers.json") as CdnProvidersData;

function matchesCnameSuffix(name: string, suffix: string): boolean {
  return name === suffix || name.endsWith("." + suffix);
}

/**
 * Match a host's CNAME chain and/or resolved IP against the CDN policy list.
 * `cnameChain` is [] for literal-IP hosts (no resolution was attempted) and for
 * domain hosts that resolved with no CNAME hop. `ip` is the RDAP IP block for
 * whichever address the host (or its resolved address) maps to, or null when
 * unavailable. Returns the first match in priority order, or null.
 */
export function matchCdn(cnameChain: string[], ip: IpEnrichment | null): CdnMatch | null {
  for (const rawName of cnameChain) {
    const name = rawName.toLowerCase().replace(/\.$/, "");
    for (const provider of CDN_PROVIDERS.providers) {
      if (provider.cname_suffixes.some((suf) => matchesCnameSuffix(name, suf))) {
        return { provider: provider.name, matched_by: "cname" };
      }
    }
  }

  const orgHaystack = `${ip?.owner_org ?? ""} ${ip?.network_name ?? ""}`.toLowerCase().trim();
  if (orgHaystack) {
    for (const provider of CDN_PROVIDERS.providers) {
      if (provider.org_patterns.some((pat) => orgHaystack.includes(pat.toLowerCase()))) {
        return { provider: provider.name, matched_by: "org" };
      }
    }
  }

  if (ip?.asn) {
    for (const provider of CDN_PROVIDERS.providers) {
      if (provider.asns.includes(ip.asn)) return { provider: provider.name, matched_by: "asn" };
    }
  }

  return null;
}
