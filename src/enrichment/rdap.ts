// The RDAP enricher (improvement 015). Given the external hosts a pipeline
// produced, it resolves each one's authoritative RDAP server via the IANA
// bootstrap, fetches the registration/allocation object, and maps it onto the
// host-enrichment record schema. Network-touching by design — it is invoked
// ONLY by the enrich-hosts CLI (RECORD), never by analyze() or the report
// path, which only ever READ the committed artifact (record/replay posture,
// same as the 008b listing fetcher and the LLM fixtures).
//
// RDAP only (RFC 7480-7484): no legacy WHOIS, no geo, no keyed reputation APIs.
// Native fetch only — no new HTTP-client dependency. The fetch+backoff+
// Retry-After shape mirrors src/llm/providers/ollama-cloud.ts (a long RECORD
// run against per-source-rate-limited RIR/registry RDAP must survive a lone
// 429/5xx/timeout). Each host is enriched independently: one host's failure
// becomes that host's `error` record, never aborting the rest.
//
// v1.1 (improvement 017): a domain-kind host's domain-RDAP lookup and its
// forward-DNS-resolution-then-IP-RDAP lookup (resolve.ts) are independent —
// either may fail without blanking the other. The resolved IP is then matched
// against the CDN policy list (cdn.ts) so a CDN-fronted host's IP facts get
// labeled as the edge network's, not asserted as the destination's location.

import type {
  DomainEnrichment,
  HostEnrichment,
  HostEnrichmentRecord,
  HostKind,
  IpEnrichment,
  LookupStatus,
} from "./types.ts";
import { matchCdn } from "./cdn.ts";
import { resolveHost, type DnsResolution, type ResolveDeps } from "./resolve.ts";

type FetchImpl = typeof fetch;

const IANA_BOOTSTRAP: Record<"dns" | "ipv4" | "ipv6", string> = {
  dns: "https://data.iana.org/rdap/dns.json",
  ipv4: "https://data.iana.org/rdap/ipv4.json",
  ipv6: "https://data.iana.org/rdap/ipv6.json",
};

/** IANA bootstrap file: services map a set of keys (TLDs or CIDRs) to RDAP base URLs. */
interface Bootstrap {
  services: [string[], string[]][];
}

export interface EnrichDeps extends ResolveDeps {
  fetchImpl?: FetchImpl;
  /** Per-attempt timeout. Default: HOST_ENRICHMENT_TIMEOUT_MS env or 15s. */
  timeoutMs?: number;
  /** Retry attempts for transient failures (timeout/network/5xx/429/408). Default 2. */
  retries?: number;
  /** Linear backoff base between retries, in ms. Default 500. */
  retryBaseMs?: number;
  /** Delay between hosts to be gentle on per-source RDAP rate limits. Default 150. */
  jitterMs?: number;
  /** Bootstrap cache, injectable so a process/test can share or reset it. */
  bootstrapCache?: Map<string, Bootstrap>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RETRY_AFTER_MS = 30_000;

/** RECORD re-fetches an artifact older than this. RDAP `created`/`registrar`
 *  are immutable, but `expires`/`statuses` and IP allocation drift — kept
 *  DISTINCT from the 90-day newly_registered window (see project.ts). */
export const ARTIFACT_STALE_DAYS = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function resolveTimeoutMs(timeoutMs?: number): number {
  if (typeof timeoutMs === "number" && timeoutMs > 0) return timeoutMs;
  const env = Number(process.env.HOST_ENRICHMENT_TIMEOUT_MS);
  if (Number.isFinite(env) && env > 0) return env;
  return DEFAULT_TIMEOUT_MS;
}

function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms, capped. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  let ms: number;
  if (Number.isFinite(seconds)) ms = seconds * 1000;
  else {
    const date = Date.parse(header);
    if (Number.isNaN(date)) return undefined;
    ms = date - Date.now();
  }
  if (ms < 0) return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

// ---- host classification -------------------------------------------------

export interface ClassifiedHost {
  kind: HostKind;
  /** The literal to look up: the IP for IPs, the full host for domains. */
  query: string;
}

/**
 * Classify a destination_summary host (already normalized by destinationHostOf —
 * ports/IPv6/userinfo may still ride along) as a domain or an IP literal, and
 * strip the port. Bracketed `[2001:db8::1]:443`, bare IPv6, dotted IPv4:port,
 * and `host:port` domains are all handled.
 */
export function classifyHost(host: string): ClassifiedHost {
  const h = host.trim().toLowerCase();
  const v6Bracketed = h.match(/^\[([0-9a-f:]+)\](?::\d+)?$/i);
  if (v6Bracketed) return { kind: "ipv6", query: v6Bracketed[1]! };
  if ((h.match(/:/g)?.length ?? 0) >= 2) return { kind: "ipv6", query: h }; // bare IPv6
  const noPort = h.replace(/:\d+$/, "");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(noPort)) return { kind: "ipv4", query: noPort };
  return { kind: "domain", query: noPort };
}

// Registrable-domain suffix heuristic (reused approach from 012, not a full PSL —
// a vendored public-suffix list is a follow-up only if this misses meaningfully).
// Covers the common second-level registry suffixes; anything else collapses to
// the last two labels, and a 1-2 label host is returned as-is.
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "co.nz", "org.nz", "co.jp", "or.jp", "ne.jp",
  "com.br", "com.cn", "net.cn", "org.cn", "com.mx", "co.in", "co.kr", "or.kr",
  "com.tr", "co.za", "com.sg", "com.hk", "com.tw", "com.ua", "com.ar", "com.tr",
]);

export function registrableDomain(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return host;
  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_PART_SUFFIXES.has(lastTwo) && labels.length >= 3) return labels.slice(-3).join(".");
  return lastTwo;
}

// ---- IP / CIDR matching (for the IP bootstrap) ---------------------------

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const o = Number(p);
    if (!Number.isInteger(o) || o < 0 || o > 255) return null;
    n = (n * 256 + o) >>> 0;
  }
  return n >>> 0;
}

function cidrContainsV4(cidr: string, ipInt: number): boolean {
  const [base, bitsStr] = cidr.split("/");
  const baseInt = ipv4ToInt(base ?? "");
  const bits = Number(bitsStr);
  if (baseInt === null || !Number.isInteger(bits)) return false;
  if (bits === 0) return true;
  const mask = bits >= 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return ((ipInt & mask) >>> 0) === ((baseInt & mask) >>> 0);
}

/** Expand a (possibly `::`-abbreviated) IPv6 literal to a 128-bit BigInt. */
function ipv6ToBigInt(ip: string): bigint | null {
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0]!.split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1]!.split(":") : []) : [];
  const missing = 8 - (head.length + tail.length);
  if (halves.length === 1 && head.length !== 8) return null;
  if (missing < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    n = (n << 16n) + BigInt(parseInt(g, 16));
  }
  return n;
}

function cidrContainsV6(cidr: string, ipBig: bigint): boolean {
  const [base, bitsStr] = cidr.split("/");
  const baseBig = ipv6ToBigInt(base ?? "");
  const bits = Number(bitsStr);
  if (baseBig === null || !Number.isInteger(bits)) return false;
  if (bits === 0) return true;
  const mask = (~0n << BigInt(128 - bits)) & ((1n << 128n) - 1n);
  return (ipBig & mask) === (baseBig & mask);
}

// ---- bootstrap + server resolution ---------------------------------------

async function loadBootstrap(kind: "dns" | "ipv4" | "ipv6", deps: EnrichDeps): Promise<Bootstrap> {
  const url = IANA_BOOTSTRAP[kind];
  const cache = deps.bootstrapCache;
  const cached = cache?.get(url);
  if (cached) return cached;
  const { json } = await fetchRdap(url, deps);
  const bootstrap: Bootstrap = { services: Array.isArray(json?.services) ? json.services : [] };
  cache?.set(url, bootstrap);
  return bootstrap;
}

function rdapBaseFromServices(services: [string[], string[]][], key: string): string | null {
  for (const [keys, urls] of services) {
    if (keys.includes(key)) return pickHttps(urls);
  }
  return null;
}

function pickHttps(urls: string[]): string | null {
  return urls.find((u) => u.startsWith("https://")) ?? urls[0] ?? null;
}

/** Resolve the authoritative RDAP base URL for a classified host, or null. */
export async function resolveRdapBase(c: ClassifiedHost, deps: EnrichDeps): Promise<string | null> {
  if (c.kind === "domain") {
    const tld = c.query.split(".").pop()!;
    const bootstrap = await loadBootstrap("dns", deps);
    return rdapBaseFromServices(bootstrap.services, tld);
  }
  // IP: longest-prefix CIDR match.
  const bootstrap = await loadBootstrap(c.kind === "ipv4" ? "ipv4" : "ipv6", deps);
  const ipInt = c.kind === "ipv4" ? ipv4ToInt(c.query) : null;
  const ipBig = c.kind === "ipv6" ? ipv6ToBigInt(c.query) : null;
  if (c.kind === "ipv4" && ipInt === null) return null;
  if (c.kind === "ipv6" && ipBig === null) return null;
  let best: string | null = null;
  let bestBits = -1;
  for (const [cidrs, urls] of bootstrap.services) {
    for (const cidr of cidrs) {
      const bits = Number(cidr.split("/")[1]);
      const hit = c.kind === "ipv4" ? cidrContainsV4(cidr, ipInt!) : cidrContainsV6(cidr, ipBig!);
      if (hit && bits > bestBits) {
        bestBits = bits;
        best = pickHttps(urls);
      }
    }
  }
  return best;
}

// ---- RDAP fetch (retry/backoff/Retry-After) ------------------------------

class RdapError extends Error {
  retryable: boolean;
  retryAfterMs?: number;
  constructor(message: string, retryable: boolean, retryAfterMs?: number) {
    super(message);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

interface RdapResponse {
  status: number;
  json: any | null;
}

function joinUrl(base: string, path: string): string {
  return base.replace(/\/?$/, "/") + path;
}

/**
 * One timeout-guarded fetch + JSON parse, retried on transient failures. A 404
 * is returned (not thrown) so the caller maps it to lookup_status "not_found";
 * other non-2xx after retries throw RdapError → "error".
 */
export async function fetchRdap(url: string, deps: EnrichDeps): Promise<RdapResponse> {
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = resolveTimeoutMs(deps.timeoutMs);
  const retries = deps.retries ?? 2;
  const retryBaseMs = deps.retryBaseMs ?? 500;

  const attempt = async (): Promise<RdapResponse> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        redirect: "follow",
        headers: { Accept: "application/rdap+json, application/json" },
        signal: controller.signal,
      });
      if (res.status === 404) return { status: 404, json: null };
      if (!res.ok) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
        throw new RdapError(`RDAP ${res.status} ${res.statusText} for ${url}`, isRetryableStatus(res.status), retryAfterMs);
      }
      return { status: res.status, json: await res.json() };
    } finally {
      clearTimeout(timer);
    }
  };

  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await attempt();
    } catch (e) {
      lastErr = e;
      // No explicit flag ⇒ network/abort (transient by nature).
      const flag = (e as RdapError)?.retryable;
      const transient = flag === true || flag === undefined;
      if (!transient || i === retries) throw e;
      const retryAfterMs = (e as RdapError)?.retryAfterMs;
      await sleep(retryAfterMs ?? retryBaseMs * (i + 1));
    }
  }
  throw lastErr;
}

// ---- RDAP object parsing -------------------------------------------------

function eventDate(json: any, action: string): string | null {
  const events = Array.isArray(json?.events) ? json.events : [];
  const e = events.find((x: any) => typeof x?.eventAction === "string" && x.eventAction.toLowerCase() === action);
  return e && typeof e.eventDate === "string" ? e.eventDate : null;
}

function entityWithRole(json: any, role: string): any | null {
  const entities = Array.isArray(json?.entities) ? json.entities : [];
  return entities.find((e: any) => Array.isArray(e?.roles) && e.roles.includes(role)) ?? null;
}

/** Pull a value from a jCard (RFC 7095) entry array, e.g. fn/org. */
function vcardValue(entity: any, key: string): string | null {
  const arr = entity?.vcardArray?.[1];
  if (!Array.isArray(arr)) return null;
  const entry = arr.find((e: any) => Array.isArray(e) && e[0] === key);
  return entry && typeof entry[3] === "string" ? entry[3] : null;
}

function entityName(entity: any): string | null {
  return vcardValue(entity, "fn") ?? vcardValue(entity, "org");
}

/** RFC 9537 redaction signalled by the `redacted` member or a redaction notice/remark. */
function signalsRedaction(json: any): boolean {
  if (Array.isArray(json?.redacted) && json.redacted.length > 0) return true;
  const notes = [...(Array.isArray(json?.notices) ? json.notices : []), ...(Array.isArray(json?.remarks) ? json.remarks : [])];
  return notes.some((n: any) => {
    const hay = `${n?.title ?? ""} ${n?.type ?? ""} ${(Array.isArray(n?.description) ? n.description.join(" ") : "")}`.toLowerCase();
    return /redact|withheld|due to authorization/.test(hay);
  });
}

function parseDomainObject(json: any, registrable: string): DomainEnrichment {
  const nameservers = (Array.isArray(json?.nameservers) ? json.nameservers : [])
    .map((n: any) => (typeof n?.ldhName === "string" ? n.ldhName.toLowerCase() : null))
    .filter((s: string | null): s is string => s !== null);
  const statuses = Array.isArray(json?.status) ? json.status.filter((s: unknown): s is string => typeof s === "string") : [];
  return {
    registrable,
    registrar: entityName(entityWithRole(json, "registrar")),
    created: eventDate(json, "registration"),
    updated: eventDate(json, "last changed"),
    expires: eventDate(json, "expiration"),
    nameservers,
    registrant_org: entityName(entityWithRole(json, "registrant")),
    statuses,
  };
}

function parseAsn(json: any): string | null {
  // ARIN exposes an origin-AS extension; other RIRs omit AS from IP objects.
  const a = json?.arin_originas0_originautnums;
  if (Array.isArray(a) && typeof a[0] === "number") return `AS${a[0]}`;
  return null;
}

function parseIpObject(json: any): IpEnrichment {
  const country = typeof json?.country === "string" && /^[A-Za-z]{2}$/.test(json.country) ? json.country.toUpperCase() : null;
  const registrant = entityWithRole(json, "registrant") ?? entityWithRole(json, "administrative");
  return {
    network_name: typeof json?.name === "string" ? json.name : null,
    owner_org: entityName(registrant),
    asn: parseAsn(json),
    country,
    allocated: eventDate(json, "registration") ?? eventDate(json, "last changed"),
    ptr: null, // reverse DNS deferred in v1 (keeps the network surface RDAP-only)
  };
}

// ---- per-host orchestration ----------------------------------------------

const NO_RESOLUTION: DnsResolution = { status: "error", addresses: [], cname_chain: [] };

function errorRecord(host: string, kind: HostKind): HostEnrichmentRecord {
  return { host, kind, lookup_status: "error", domain: null, ip: null, dns_status: "not_applicable", resolved_addresses: [], cname_chain: [], cdn: null };
}

/**
 * RDAP-fetch and parse an IP object for a literal IP address (v4 or v6). Shared
 * by the ipv4/ipv6 top-level path AND by the domain path's secondary lookup on
 * a resolved address (017) — the RDAP shape and lookup_status derivation are
 * identical either way, only what the caller does with the result differs.
 */
async function lookupIp(ipLiteral: string, deps: EnrichDeps): Promise<{ ip: IpEnrichment | null; status: LookupStatus }> {
  const c = classifyHost(ipLiteral);
  if (c.kind === "domain") return { ip: null, status: "error" }; // not a literal IP — should not happen
  const base = await resolveRdapBase(c, deps);
  if (!base) return { ip: null, status: "error" }; // no RDAP server known for this range
  const { status, json } = await fetchRdap(joinUrl(base, `ip/${c.query}`), deps);
  if (status === 404) return { ip: null, status: "not_found" };
  if (!json) return { ip: null, status: "error" };
  const ip = parseIpObject(json);
  const lookup_status = signalsRedaction(json) && ip.owner_org === null && ip.network_name === null ? "redacted" : "ok";
  return { ip, status: lookup_status };
}

/** Enrich one host. Never throws — a failure becomes an `error` record. */
export async function enrichHost(host: string, deps: EnrichDeps): Promise<HostEnrichmentRecord> {
  const c = classifyHost(host);

  if (c.kind !== "domain") {
    try {
      const { ip, status: lookup_status } = await lookupIp(c.query, deps);
      return {
        host, kind: c.kind, lookup_status, domain: null, ip,
        dns_status: "not_applicable", resolved_addresses: [], cname_chain: [],
        cdn: matchCdn([], ip),
      };
    } catch {
      return errorRecord(host, c.kind);
    }
  }

  // Domain RDAP (registration facts) and forward DNS resolution → IP RDAP (the
  // actual network target, 017) are independent lookups. Either may fail
  // without blanking out the other — never let one's failure drop data the
  // other already produced.
  let lookup_status: LookupStatus = "error";
  let domain: DomainEnrichment | null = null;
  try {
    const base = await resolveRdapBase(c, deps);
    if (base) {
      const registrable = registrableDomain(c.query);
      const { status, json } = await fetchRdap(joinUrl(base, `domain/${registrable}`), deps);
      if (status === 404) {
        lookup_status = "not_found";
      } else if (json) {
        domain = parseDomainObject(json, registrable);
        // Whole-lookup redaction only when redaction left us without the
        // high-signal field; a present `created` with a withheld registrant is
        // still "ok".
        lookup_status = signalsRedaction(json) && domain.created === null ? "redacted" : "ok";
      }
    }
  } catch {
    lookup_status = "error";
  }

  let resolution = NO_RESOLUTION;
  let ip: IpEnrichment | null = null;
  try {
    resolution = await resolveHost(c.query, deps);
    if (resolution.status === "ok" && resolution.addresses[0]) {
      ip = (await lookupIp(resolution.addresses[0], deps)).ip;
    }
  } catch {
    // resolveHost never throws by contract; lookupIp's underlying RDAP fetch
    // can (transport failure beyond retries) — degrade to "no resolved-IP
    // data" without discarding the domain RDAP result computed above.
    resolution = { status: "error", addresses: resolution.addresses, cname_chain: resolution.cname_chain };
    ip = null;
  }

  return {
    host, kind: c.kind, lookup_status, domain, ip,
    dns_status: resolution.status, resolved_addresses: resolution.addresses, cname_chain: resolution.cname_chain,
    cdn: matchCdn(resolution.cname_chain, ip),
  };
}

/**
 * Enrich every host (NO top-N cap), serially with a small jitter between
 * lookups so a burst of hosts on one registry/RIR does not trip its per-source
 * rate limit. Caller supplies the host list (already deduped/normalized and
 * filtered of wildcard + first-party hosts). `fetchedAt` is the staleness stamp.
 */
export async function enrichHosts(hosts: string[], fetchedAt: string, deps: EnrichDeps = {}): Promise<HostEnrichment> {
  const jitterMs = deps.jitterMs ?? 150;
  const records: HostEnrichmentRecord[] = [];
  for (let i = 0; i < hosts.length; i++) {
    if (i > 0 && jitterMs > 0) await sleep(jitterMs);
    records.push(await enrichHost(hosts[i]!, deps));
  }
  records.sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  return { fetched_at: fetchedAt, source: "rdap", hosts: records };
}
