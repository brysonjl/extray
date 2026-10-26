// Tier 1 — deterministic, gated (sourceAccess: targeted-reads for fs
// corroboration only — NO LLM calls). Remotely-hosted script loaded into a
// PRIVILEGED extension context (background page / service worker / extension
// page) is the ban-worthy Great-Suspender class: the real behavior lives in a
// payload static analysis can never see, and the verdict engine floors it at
// high-risk (verdict.ts isRemoteHostedCode). No other node read the pipeline's
// remote-script evidence, so that floor was unreachable from dag.
//
// The privileged-script set is derived from the RAW manifest
// (background.scripts / service_worker / page) plus files an extension page
// references (`html:<page>` labels, sandboxed pages excluded) — NOT from
// manifest_analysis.background, which records only the FIRST MV2 background
// script, nor from referenced_by alone, which omits MV2 background.scripts
// entirely. content_scripts[].js are excluded: they run in web pages.
//
// Precision (the 018 lesson — the old floor was the #1 FP source): the
// `script.src` ast_role over-matches (ANY `<x>.src =` assignment, e.g. img.src),
// so a JS-driven candidate floors ONLY when corroborated as a script load — the
// manifest CSP whitelists remote script sources (`remote-script-src` weakness),
// or a createElement('script') sits within ±2000 chars of the sink. Declarative
// <script src> tags and importScripts() can only load code, so they need no
// corroboration. Known-analytics hosts (harm-adjust allowlist) and first-party
// hosts are dismissals, not findings; unresolved/uncorroborated loaders emit an
// informational medium/'unknown' shape that never floors (the
// destination-reviewer lesson: 'unknown' never drives the tier).

import { readFileSync } from "node:fs";
import type { EvidencePack, NetworkDestination, ScriptEntry } from "../../../pipeline/schema.ts";
import { destinationHostOf } from "../../../pipeline/layer4-crossfile.ts";
import { looksLikeHost } from "../../../report/build.ts";
import { firstPartyHosts, isKnownAnalyticsHost } from "../../../report/harm-adjust.ts";
import { safeSourcePath, type EvidenceRef, type Finding } from "../../findings.ts";
import { okResult, type DagNode, type Dismissal, type NodeResult, ZERO_USAGE } from "../node.ts";

const LOADER_ROLES = new Set(["script.src", "importScripts.url"]);
// Remote by scheme: http(s) or protocol-relative. data:/chrome-extension:/
// relative values are packaged or inert, not a remote payload.
const REMOTE_URL = /^(https?:)?\/\//i;
const INLINE_PATH = /^(.+\.html?)#inline-\d+$/i;
const CREATE_SCRIPT = /createElement\s*\(\s*['"`]script['"`]/i;
const CORROBORATION_RADIUS = 2000;
const MAX_EVIDENCE_SITES = 3;

/** A loader whose destination resolved to a concrete remote host. */
interface HostCandidate {
  host: string;
  /** File to cite ON DISK — for inline scripts this is the .html page, never
   *  the `<page>.html#inline-N` pseudo-path (it would fail safeSourcePath). */
  file: string;
  line: number | null;
  role: string;
  context: string;
  /** Declarative <script src> / importScripts — inherently a script load. */
  needsNoCorroboration: boolean;
}

/** A loader-shaped site whose destination could not be statically resolved. */
interface UnresolvedCandidate {
  file: string;
  line: number;
  value: string;
  context: string;
}

interface Candidates {
  hosts: HostCandidate[];
  unresolved: UnresolvedCandidate[];
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Manifest paths are root-relative; normalize like layer 2 does. */
function normPath(p: string): string {
  return p.replace(/^\//, "").replace(/^\.\//, "");
}

/** Privileged script path → human name of the context it runs in. */
function privilegedScripts(pack: EvidencePack): Map<string, string> {
  const out = new Map<string, string>();
  const manifest = (pack.extension?.manifest ?? {}) as Record<string, unknown>;
  const bg = (manifest.background ?? {}) as Record<string, unknown>;
  for (const s of asStringArray(bg.scripts)) out.set(normPath(s), "background page");
  if (typeof bg.service_worker === "string") out.set(normPath(bg.service_worker), "service worker");
  const sandboxed = sandboxedPages(manifest);
  for (const f of pack.files ?? []) {
    if (out.has(f.path)) continue;
    const page = (f.referenced_by ?? [])
      .filter((r) => r.startsWith("html:"))
      .map((r) => r.slice("html:".length))
      .find((p) => !sandboxed.has(p));
    if (page) out.set(f.path, `extension page ${page}`);
  }
  return out;
}

function sandboxedPages(manifest: Record<string, unknown>): Set<string> {
  const sandbox = (manifest.sandbox ?? {}) as Record<string, unknown>;
  return new Set(asStringArray(sandbox.pages).map(normPath));
}

/** Every JS-driven loader candidate in one privileged script. */
function scriptCandidates(script: ScriptEntry, file: string, context: string, into: Candidates): void {
  for (const d of script.network_destinations ?? []) {
    if (!LOADER_ROLES.has(d.ast_role)) continue;
    if (d.kind === "static" || d.kind === "template") {
      if (!REMOTE_URL.test(d.value)) continue; // data:/chrome:/relative — not remote
      const host = destinationHostOf(d.value);
      if (host && looksLikeHost(host)) {
        into.hosts.push({
          host,
          file,
          line: d.location.line,
          role: d.ast_role,
          context,
          needsNoCorroboration: d.ast_role === "importScripts.url",
        });
      } else {
        // Remote by scheme but the host itself did not fold (`https://${…}/x.js`).
        into.unresolved.push({ file, line: d.location.line, value: d.value, context });
      }
    } else if (d.kind === "unknown") {
      into.unresolved.push({ file, line: d.location.line, value: d.value, context });
    }
  }
}

/** Deterministic candidate collection — pack only, no fs reads (gate-safe). */
function collectCandidates(pack: EvidencePack): Candidates {
  const into: Candidates = { hosts: [], unresolved: [] };
  const privileged = privilegedScripts(pack);
  const sandboxed = sandboxedPages((pack.extension?.manifest ?? {}) as Record<string, unknown>);

  for (const script of pack.scripts ?? []) {
    const inline = script.path.match(INLINE_PATH);
    if (inline) {
      const page = inline[1]!;
      if (!sandboxed.has(page)) scriptCandidates(script, page, `extension page ${page}`, into);
      continue;
    }
    const context = privileged.get(script.path);
    if (context) scriptCandidates(script, script.path, context, into);
  }

  // Declarative <script src> per privileged (non-sandboxed) extension page.
  for (const raw of (pack.resources?.html ?? []) as Array<Record<string, unknown>>) {
    const page = typeof raw.path === "string" ? raw.path : null;
    if (!page || sandboxed.has(page)) continue;
    const refs = (raw.remote_refs ?? []) as Array<{ kind: string; url: string }>;
    const urls = new Set([
      ...refs.filter((r) => r.kind === "script.src").map((r) => r.url),
      ...asStringArray(raw.remote_scripts),
    ]);
    for (const url of urls) {
      const host = destinationHostOf(url);
      if (!host || !looksLikeHost(host)) continue;
      into.hosts.push({
        host,
        file: page,
        line: null,
        role: "script.src",
        context: `extension page ${page}`,
        needsNoCorroboration: true, // a <script> tag can only load script
      });
    }
  }

  return into;
}

/** Publisher domain trivially derivable from the manifest's own homepage_url. */
function publisherDomain(pack: EvidencePack): string | null {
  const url = pack.developer?.homepage_url;
  const host = url ? destinationHostOf(url) : null;
  return host ? host.replace(/^www\./, "").toLowerCase() : null;
}

function isFirstParty(host: string, fp: Set<string>, pub: string | null): boolean {
  const h = host.toLowerCase();
  if (fp.has(h)) return true;
  return pub !== null && (h === pub || h.endsWith("." + pub));
}

/**
 * Corroborate a bare `.src =` site as a SCRIPT load: createElement('script')
 * within ±2000 chars of the sink. For inline-script candidates the cited file
 * is the .html page and the recorded line is inline-relative, so the window is
 * anchored on the host text instead. Any read failure → not corroborated.
 */
function createsScriptNearby(sampleDir: string, cand: HostCandidate, cache: Map<string, string | null>): boolean {
  let src = cache.get(cand.file);
  if (src === undefined) {
    const abs = safeSourcePath(sampleDir, cand.file);
    try {
      src = abs ? readFileSync(abs, "utf8") : null;
    } catch {
      src = null;
    }
    cache.set(cand.file, src);
  }
  if (!src) return false;
  let offset = 0;
  if (cand.line !== null && !cand.file.endsWith(".html") && !cand.file.endsWith(".htm")) {
    for (let i = 1, pos = 0; i < cand.line; i++) {
      pos = src.indexOf("\n", pos) + 1;
      if (pos === 0) break;
      offset = pos;
    }
  } else {
    const i = src.indexOf(cand.host);
    if (i !== -1) offset = i;
  }
  const window = src.slice(Math.max(0, offset - CORROBORATION_RADIUS), offset + CORROBORATION_RADIUS);
  return CREATE_SCRIPT.test(window);
}

function refsFor(sites: HostCandidate[], host: string): EvidenceRef[] {
  return sites.slice(0, MAX_EVIDENCE_SITES).map((c) => ({
    file: c.file,
    location: c.line !== null ? { line: c.line } : null,
    symbol: null,
    sink_or_string: host,
  }));
}

export const remoteScriptReviewer: DagNode = {
  id: "remote-script-reviewer",
  version: "1.0",
  kind: "deterministic",
  sourceAccess: "targeted-reads",
  upstream: [],
  gate: (ctx) => {
    const c = collectCandidates(ctx.pack);
    return c.hosts.length > 0 || c.unresolved.length > 0;
  },
  async run(ctx): Promise<NodeResult> {
    const { hosts, unresolved } = collectCandidates(ctx.pack);
    const findings: Finding[] = [];
    const dismissals: Dismissal[] = [];

    // MV3 forbids remotely-hosted code in privileged contexts, so every
    // candidate is inert — one dismissal for the whole class, not per-site spam.
    if (ctx.pack.manifest_analysis?.manifest_version === 3) {
      dismissals.push({
        concern: "remotely-hosted script in a privileged context",
        checks_run: ["manifest version"],
        note: `manifest_version 3: the platform forbids remotely-hosted script in privileged extension contexts, so the ${hosts.length + unresolved.length} loader-shaped candidate site(s) cannot load remote code.`,
      });
      return okResult({ dismissals, usage: ZERO_USAGE });
    }

    const fp = firstPartyHosts(ctx.pack);
    const pub = publisherDomain(ctx.pack);
    const cspWhitelistsRemoteScript = (ctx.pack.manifest_analysis?.csp?.weaknesses ?? []).includes("remote-script-src");
    const readCache = new Map<string, string | null>();
    let n = 0;

    // Resolved-host candidates, adjudicated per host (first match wins).
    const byHost = new Map<string, HostCandidate[]>();
    for (const c of hosts) {
      const g = byHost.get(c.host);
      if (g) g.push(c);
      else byHost.set(c.host, [c]);
    }
    for (const [host, sites] of byHost) {
      if (isFirstParty(host, fp, pub)) {
        dismissals.push({
          concern: `remote script from ${host}`,
          checks_run: ["destination-party adjudication"],
          note: `${host} is the publisher's own domain (first-party) — self-hosted code, not a third-party payload.`,
        });
        continue;
      }
      if (isKnownAnalyticsHost(host)) {
        dismissals.push({
          concern: `remote script from ${host}`,
          checks_run: ["known-analytics allowlist"],
          note: `${host} is a disclosed-telemetry-grade analytics host — reported as telemetry, not a covert remote payload.`,
        });
        continue;
      }
      const lead = sites[0]!;
      const corroborated =
        sites.some((c) => c.needsNoCorroboration) ||
        cspWhitelistsRemoteScript ||
        sites.some((c) => createsScriptNearby(ctx.sampleDir, c, readCache));
      if (corroborated) {
        // Deterministically reaches the verdict engine's isRemoteHostedCode
        // floor: remote-resources + unwanted + high (observed-capability — the
        // load is asserted from the pack; no causal story, no LLM verification).
        findings.push({
          id: `rscript:${++n}`,
          title: `Remote script loaded into a privileged context: ${host}`,
          claim_type: "observed-capability",
          severity: "high",
          category: "remote-resources",
          finding_type: "unwanted",
          confidence: "high",
          claimed_mechanism: "",
          evidence_refs: refsFor(sites, host),
          detail:
            `The ${lead.context} loads executable script from ${host}` +
            `${lead.line !== null ? ` (${lead.file}:${lead.line})` : ` (${lead.file})`}. ` +
            `The remote payload runs with the extension's privileges and its true behavior is unauditable from the bundled package.` +
            `${cspWhitelistsRemoteScript ? ` The manifest CSP whitelists remote script sources ('remote-script-src'), permitting the load at runtime.` : ""}`,
        });
      } else {
        // Uncorroborated `.src =` — statically indistinguishable from img.src
        // (a real-world extension's f13 FP class). Informational only; never floors.
        findings.push({
          id: `rscript:${++n}`,
          title: `Uncorroborated remote .src assignment in a privileged context: ${host}`,
          claim_type: "observed-capability",
          severity: "medium",
          category: "remote-resources",
          finding_type: "unknown",
          confidence: "medium",
          claimed_mechanism: "",
          evidence_refs: refsFor(sites, host),
          detail:
            `The ${lead.context} assigns ${host} to a .src property` +
            `${lead.line !== null ? ` (${lead.file}:${lead.line})` : ` (${lead.file})`}, but nothing corroborates a script element ` +
            `(no CSP remote-script whitelist, no createElement('script') near the sink) — possibly an image or media load.`,
        });
      }
    }

    // Unresolved loaders (destination not statically resolvable), one
    // informational finding per file — sub-floor by construction ('unknown').
    const byFile = new Map<string, UnresolvedCandidate[]>();
    for (const c of unresolved) {
      const g = byFile.get(c.file);
      if (g) g.push(c);
      else byFile.set(c.file, [c]);
    }
    for (const [file, sites] of byFile) {
      const lead = sites[0]!;
      findings.push({
        id: `rscript:${++n}`,
        title: `Unresolved script-source assignment in a privileged context: ${file}`,
        claim_type: "observed-capability",
        severity: "medium",
        category: "remote-resources",
        finding_type: "unknown",
        confidence: "medium",
        claimed_mechanism: "",
        evidence_refs: [{ file, location: { line: lead.line }, symbol: null, sink_or_string: lead.value || null }],
        detail:
          `The ${lead.context} (${file}:${lead.line}) assigns a value to a script-loader .src whose destination could not be ` +
          `statically resolved (${sites.length} site${sites.length > 1 ? "s" : ""}; first value: \`${lead.value.slice(0, 80)}\`). ` +
          `Recorded as an unresolved loader surface, not a confirmed remote load.`,
      });
    }

    return okResult({ findings, dismissals, usage: ZERO_USAGE });
  },
};
