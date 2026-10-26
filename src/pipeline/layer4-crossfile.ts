// Layer 4 — cross-file linkage. Connects per-file Layer-3 facts into
// whole-extension views: permission usage, message graph, content-script reach,
// destination summary. Always recomputed from assembled facts (never cached).

import type { CrossFile, DataFlow, ScriptEntry, ManifestAnalysis } from "./schema.ts";
import { normalizeChain } from "./layer3-ast/util.ts";

type Matcher = (api: string, category: string) => boolean;

// Declared permission -> how its use shows up in Layer-3 sinks. Permissions with
// a detectable JS API live here; declared permissions absent here have no
// statically-attributable API (bucketed cannot_determine_statically).
const PERMISSION_API: Record<string, Matcher> = {
  cookies: (a) => a.startsWith("chrome.cookies.") || a === "document.cookie",
  storage: (a) => a.startsWith("chrome.storage."),
  tabs: (a) => a.startsWith("chrome.tabs."),
  contextMenus: (a) => a.startsWith("chrome.contextMenus."),
  clipboardWrite: (a, c) => c === "clipboard" || a.startsWith("navigator.clipboard."),
  clipboardRead: (a) => a === "navigator.clipboard.readText" || a === "navigator.clipboard.read",
  scripting: (a) => a.startsWith("chrome.scripting."),
  webRequest: (a) => a.startsWith("chrome.webRequest."),
  webRequestBlocking: (a) => a.startsWith("chrome.webRequest."),
  declarativeNetRequest: (a) => a.startsWith("chrome.declarativeNetRequest."),
  proxy: (a) => a.startsWith("chrome.proxy."),
  debugger: (a) => a.startsWith("chrome.debugger."),
  management: (a) => a.startsWith("chrome.management."),
  identity: (a) => a.startsWith("chrome.identity."),
  downloads: (a) => a.startsWith("chrome.downloads."),
  nativeMessaging: (a) => a.startsWith("chrome.nativeMessaging."),
  tabCapture: (a) => a.startsWith("chrome.tabCapture."),
  desktopCapture: (a) => a.startsWith("chrome.desktopCapture."),
};

function scriptRole(path: string): string {
  const p = path.toLowerCase();
  if (p.includes("background") || p.includes("service")) return "background";
  if (p.includes("popup")) return "popup";
  if (p.includes("option")) return "options";
  if (p.includes("devtools") || p.includes("panel")) return "devtools";
  if (p.includes("content")) return "content";
  return path;
}

// Exported so the report layer keys its example-call-site map with the SAME
// normalization layer4 used for destination_summary hosts — otherwise hosts
// with ports/IPv6/userinfo/templates (e.g. `1.2.3.4:8080`, `${api}`→`*`) would
// never match and the report would silently drop example sites for exactly the
// suspicious destinations.
export function destinationHostOf(value: string): string | null {
  const m = value.match(/^[a-z]+:\/\/([^/?#]+)/i) ?? value.match(/^\/\/([^/?#]+)/);
  if (m && m[1]) return m[1].replace(/\$\{[^}]*\}/g, "*");
  return null;
}
const hostOf = destinationHostOf;

// Registrable-ish publisher domains, derived from the surfaces the manifest
// itself ties to the publisher: externally_connectable matches and update_url.
// Used only for suffix matching (host === pub || host endsWith "." + pub), which
// sidesteps a full public-suffix list — sufficient to recognize `api.publisher.example`
// as publisher-owned when `publisher.example` is declared.
function publisherDomains(
  manifest: Record<string, unknown>,
  externallyConnectable: ManifestAnalysis["externally_connectable"],
): Set<string> {
  const out = new Set<string>();
  const addHost = (h: string | null) => {
    if (!h) return;
    const bare = h.replace(/^\*\./, "").replace(/^www\./, "").toLowerCase();
    if (bare && !bare.includes("*")) out.add(bare);
  };
  for (const m of externallyConnectable?.matches ?? []) addHost(hostOf(m) ?? m.replace(/^https?:\/\//, "").split("/")[0] ?? null);
  const updateUrl = typeof manifest.update_url === "string" ? manifest.update_url : null;
  if (updateUrl) addHost(hostOf(updateUrl));
  return out;
}

function partyOf(host: string | null, publishers: Set<string>): DataFlow["dest_party"] {
  if (!host || host.includes("*")) return "unknown";
  const h = host.toLowerCase();
  for (const pub of publishers) {
    if (h === pub || h.endsWith("." + pub)) return "first-party-extension";
  }
  return "external";
}

// "cookie-source-to-network-sink" -> "cookie".
function sourceKindOf(classification: string): string {
  const i = classification.indexOf("-source-to-");
  return i === -1 ? "data" : classification.slice(0, i);
}

export function analyzeCrossFile(
  manifest: Record<string, unknown>,
  scripts: ScriptEntry[],
  externallyConnectable: ManifestAnalysis["externally_connectable"],
): CrossFile {
  const permissions = [
    ...new Set(
      [
        ...(Array.isArray(manifest.permissions) ? manifest.permissions : []),
        ...(Array.isArray(manifest.optional_permissions) ? manifest.optional_permissions : []),
      ].filter((p): p is string => typeof p === "string"),
    ),
  ];

  // Permission -> usage.
  const permissionUsage: CrossFile["permission_usage"] = {};
  const unused: string[] = [];
  const cannotDetermine: string[] = [];

  for (const perm of permissions) {
    const matcher = PERMISSION_API[perm];
    if (!matcher) { cannotDetermine.push(perm); continue; }
    const sites: Array<{ path: string; line: number; api: string }> = [];
    for (const s of scripts) {
      for (const sink of s.sinks) {
        // Layer-3 sinks are already normalized, but normalize again here so
        // hand-assembled or cached-from-older-pass entries (browser.*, window.*
        // spellings) still map onto declared permissions.
        if (matcher(normalizeChain(sink.api), sink.category)) sites.push({ path: s.path, line: sink.location.line, api: sink.api });
      }
    }
    if (sites.length > 0) permissionUsage[perm] = sites.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
    else unused.push(perm);
  }

  // Message graph.
  const nodeMap = new Map<string, { id: string; path: string }>();
  for (const s of scripts) {
    if (s.sinks.some((x) => x.category === "messaging") || s.listeners.length > 0) {
      nodeMap.set(`${scriptRole(s.path)}|${s.path}`, { id: scriptRole(s.path), path: s.path });
    }
  }
  const nodes = [...nodeMap.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const edges: Array<Record<string, unknown>> = [];
  for (const s of scripts) {
    if (s.sinks.some((x) => x.api === "chrome.runtime.sendMessage")) {
      edges.push({ from: scriptRole(s.path), to: "background", channel: "chrome.runtime.sendMessage" });
    }
    if (externallyConnectable) {
      const ext = s.listeners.find((l) => l.kind.includes("onMessageExternal"));
      if (ext) edges.push({ from: "external", to: scriptRole(s.path), channel: "onMessageExternal", receiver_validates_sender: ext.validates_sender });
    }
  }

  // Content-script reach.
  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const reach = contentScripts.map((cs) => {
    const o = cs as Record<string, unknown>;
    const files = (Array.isArray(o.js) ? o.js : []).filter((f): f is string => typeof f === "string");
    const sinkSummary: Record<string, number> = {};
    for (const f of files) {
      const script = scripts.find((s) => s.path === f.replace(/^\//, ""));
      for (const sink of script?.sinks ?? []) sinkSummary[sink.category] = (sinkSummary[sink.category] ?? 0) + 1;
    }
    return { matches: Array.isArray(o.matches) ? o.matches : [], files, sink_summary: sinkSummary };
  });

  // Destination summary.
  const byHost = new Map<string, { references: number; any_dynamic: boolean; reached_via: Set<string> }>();
  for (const s of scripts) {
    for (const d of s.network_destinations) {
      const host = hostOf(d.value);
      if (!host) continue;
      let agg = byHost.get(host);
      if (!agg) { agg = { references: 0, any_dynamic: false, reached_via: new Set() }; byHost.set(host, agg); }
      agg.references += 1;
      if (d.kind !== "static") agg.any_dynamic = true;
      agg.reached_via.add(d.ast_role);
    }
  }
  const destinationSummary = [...byHost.entries()]
    .map(([host, a]) => ({ host, references: a.references, any_dynamic: a.any_dynamic, reached_via: [...a.reached_via].sort() }))
    .sort((a, b) => (a.host < b.host ? -1 : 1));

  // Data flows: join each cookie/storage/identity → network|navigation taint
  // sketch to the destination party. The dest host is the network_destination on
  // the same source line as the sink (best-effort; the taint sketch does not
  // carry the URL itself). Only source-bearing flows are emitted.
  const publishers = publisherDomains(manifest, externallyConnectable);
  const dataFlows: DataFlow[] = [];
  // Window (in columns) within which a destination is considered to belong to a
  // sink call. A fetch/XHR URL arg sits immediately after the call token, so the
  // destination column is just past the sink column. This must be tight: minified
  // bundles put every call on one physical line, so line-only matching collides
  // (it would attribute an unrelated host to every sink on the line).
  const COL_WINDOW = 80;
  for (const s of scripts) {
    if (!s.taint_sketches.length) continue;
    const dests = s.network_destinations
      .map((d) => ({ line: d.location.line, column: d.location.column ?? 0, host: hostOf(d.value) }))
      .filter((d): d is { line: number; column: number; host: string } => d.host !== null);
    // Nearest destination on the same line whose column is at/after the sink call
    // and within the window; closest wins.
    const nearestHost = (line: number, col: number): string | null => {
      let best: { host: string; d: number } | null = null;
      for (const dst of dests) {
        if (dst.line !== line) continue;
        const delta = dst.column - col;
        if (delta < 0 || delta > COL_WINDOW) continue;
        if (!best || delta < best.d) best = { host: dst.host, d: delta };
      }
      return best?.host ?? null;
    };
    for (const t of s.taint_sketches) {
      if (!/-source-to-(network|navigation)-sink$/.test(t.classification)) continue;
      const sourceKind = sourceKindOf(t.classification);
      if (sourceKind === "data") continue; // only typed sources (cookie/storage/…)
      const host = nearestHost(t.sink.location.line, t.sink.location.column ?? 0);
      dataFlows.push({
        source_kind: sourceKind,
        file: s.path,
        sink_api: t.sink.api,
        sink_location: t.sink.location,
        dest_host: host,
        dest_party: partyOf(host, publishers),
      });
    }
  }
  dataFlows.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.sink_location.line - b.sink_location.line));

  return {
    permission_usage: permissionUsage,
    unused_permissions: unused.sort(),
    cannot_determine_statically: cannotDetermine.sort(),
    message_graph: { nodes, edges },
    content_script_reach: reach,
    destination_summary: destinationSummary,
    data_flows: dataFlows,
  };
}
