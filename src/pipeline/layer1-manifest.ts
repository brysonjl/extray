// Layer 1 — manifest surface analysis. Describes declared capabilities and trust
// posture from manifest.json alone. Deterministic, no source reads.

import type { Developer, ManifestAnalysis } from "./schema.ts";

const DEFAULT_UPDATE_URL = "https://clients2.google.com/service/update2/crx";

// Permission -> coarse capability category (docs/static-analysis.md Layer 1).
const CATEGORY_BY_PERMISSION: Record<string, string> = {
  cookies: "cookies",
  storage: "storage",
  unlimitedStorage: "storage",
  clipboardWrite: "clipboard",
  clipboardRead: "clipboard",
  scripting: "dom-injection",
  webRequest: "web-request",
  webRequestBlocking: "web-request",
  declarativeNetRequest: "declarative-net-request",
  declarativeNetRequestWithHostAccess: "declarative-net-request",
  debugger: "debugger",
  management: "management",
  proxy: "proxy",
  nativeMessaging: "native-messaging",
  identity: "identity",
  downloads: "downloads",
  tabCapture: "tab-capture",
  desktopCapture: "desktop-capture",
};

const BROAD_HOST_PATTERNS = new Set(["<all_urls>", "*://*/*", "http://*/*", "https://*/*", "*://*"]);

// Host match patterns as they appear in `permissions` (MV2) — <all_urls> or a
// scheme (incl. wildcard scheme) followed by ://.
const HOST_PATTERN_RE = /^(\*|https?|wss?|file|ftp):\/\//i;

function isHostPattern(p: string): boolean {
  return p === "<all_urls>" || HOST_PATTERN_RE.test(p);
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function hasBroadHost(hostPatterns: string[]): boolean {
  return hostPatterns.some((p) => BROAD_HOST_PATTERNS.has(p));
}

export function analyzeManifest(manifest: Record<string, unknown>): ManifestAnalysis {
  // In MV2, host match patterns live alongside API permissions in `permissions`
  // (and `optional_permissions`); split them out so broad-host detection and
  // dangerous combinations fire for MV2 manifests too.
  const permissions = asStringArray(manifest.permissions).filter((p) => !isHostPattern(p));
  const optionalPermissions = asStringArray(manifest.optional_permissions).filter((p) => !isHostPattern(p));
  const hostPermissions = [
    ...asStringArray(manifest.host_permissions),
    ...asStringArray(manifest.permissions).filter(isHostPattern),
  ];
  const optionalHostPermissions = [
    ...asStringArray(manifest.optional_host_permissions),
    ...asStringArray(manifest.optional_permissions).filter(isHostPattern),
  ];
  const allPerms = [...permissions, ...optionalPermissions];

  // Capability categories (sorted, deduped, deterministic).
  const categories = new Set<string>();
  for (const p of allPerms) {
    const cat = CATEGORY_BY_PERMISSION[p];
    if (cat) categories.add(cat);
  }
  if (hostPermissions.length > 0 || optionalHostPermissions.length > 0) categories.add("network");

  // Content-script match patterns contribute to broad-host detection.
  const contentScripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [];
  const csMatches: string[] = [];
  for (const cs of contentScripts) {
    if (cs && typeof cs === "object") csMatches.push(...asStringArray((cs as Record<string, unknown>).matches));
    categories.add("dom-injection");
  }
  const broadHost = hasBroadHost([...hostPermissions, ...csMatches]);

  // Dangerous combinations.
  const dangerous: Array<{ kind: string; evidence: string[] }> = [];
  const has = (p: string) => allPerms.includes(p);
  if (has("cookies") && broadHost) {
    dangerous.push({ kind: "cookies+broad-host", evidence: ["cookies", broadHostEvidence(hostPermissions, csMatches)] });
  }
  if ((has("webRequest") || has("webRequestBlocking")) && broadHost) {
    dangerous.push({ kind: "webRequest+broad-host", evidence: ["webRequest", broadHostEvidence(hostPermissions, csMatches)] });
  }
  if (has("scripting") && broadHost) {
    dangerous.push({ kind: "scripting+broad-host", evidence: ["scripting", broadHostEvidence(hostPermissions, csMatches)] });
  }
  for (const lone of ["debugger", "management", "proxy", "nativeMessaging"]) {
    if (has(lone)) dangerous.push({ kind: `lone-${lone}`, evidence: [lone] });
  }

  // CSP weaknesses.
  const csp = parseCsp(manifest.content_security_policy);

  // externally_connectable surface.
  const externallyConnectable = parseExternallyConnectable(manifest.externally_connectable);

  // Update channel.
  const updateUrl = typeof manifest.update_url === "string" ? manifest.update_url : null;
  const nonDefaultUpdateUrl = updateUrl !== null && updateUrl !== DEFAULT_UPDATE_URL;

  // Background.
  const background = parseBackground(manifest.background);

  return {
    manifest_version: typeof manifest.manifest_version === "number" ? manifest.manifest_version : 0,
    capability_categories: [...categories].sort(),
    // Required vs optional kept distinguishable (optional grants need a user
    // gesture and carry less standing risk).
    host_permissions: { required: hostPermissions, optional: optionalHostPermissions },
    dangerous_combinations: dangerous,
    csp,
    externally_connectable: externallyConnectable,
    update_url: updateUrl,
    non_default_update_url: nonDefaultUpdateUrl,
    content_scripts: contentScripts,
    background,
  };
}

// Developer identity, self-reported (improvement 008 phase 1). Manifest-derived
// like the rest of Layer 1, but populates its own top-level pack section so the
// future store-listing data (provenance "store_listing") can sit beside it.
export function extractDeveloper(manifest: Record<string, unknown>): Developer {
  // MV3 `author` is either a plain string (a name) or an `{ email }` object.
  let author: Developer["author"] = null;
  const rawAuthor = manifest.author;
  if (typeof rawAuthor === "string" && rawAuthor.trim() !== "") {
    author = { name: rawAuthor, email: null };
  } else if (rawAuthor && typeof rawAuthor === "object" && !Array.isArray(rawAuthor)) {
    const email = (rawAuthor as Record<string, unknown>).email;
    author = { name: null, email: typeof email === "string" ? email : null };
  }

  const homepageUrl = typeof manifest.homepage_url === "string" ? manifest.homepage_url : null;
  const updateUrl = typeof manifest.update_url === "string" ? manifest.update_url : null;

  return {
    author,
    homepage_url: homepageUrl,
    update_url: updateUrl,
    has_website: homepageUrl !== null && /^https?:\/\//i.test(homepageUrl),
    non_store_update_url: updateUrl !== null && updateUrl !== DEFAULT_UPDATE_URL,
    // Populated by the future store-listing fetcher (008b); explicit nulls so
    // "has address?" is answerable (no, not unknown) from a phase-1 pack.
    address: null,
    country: null,
    provenance: "self_reported",
  };
}

function broadHostEvidence(hostPermissions: string[], csMatches: string[]): string {
  return [...hostPermissions, ...csMatches].find((p) => BROAD_HOST_PATTERNS.has(p)) ?? "<all_urls>";
}

function parseCsp(raw: unknown): { extension_pages: string | null; weaknesses: string[] } {
  let extensionPages: string | null = null;
  if (typeof raw === "string") extensionPages = raw;
  else if (raw && typeof raw === "object") {
    const v = (raw as Record<string, unknown>).extension_pages;
    if (typeof v === "string") extensionPages = v;
  }
  const weaknesses: string[] = [];
  if (extensionPages) {
    if (/unsafe-eval/.test(extensionPages)) weaknesses.push("unsafe-eval");
    if (/unsafe-inline/.test(extensionPages)) weaknesses.push("unsafe-inline");
    if (/script-src[^;]*https?:\/\//.test(extensionPages)) weaknesses.push("remote-script-src");
  }
  return { extension_pages: extensionPages, weaknesses };
}

function parseExternallyConnectable(raw: unknown): ManifestAnalysis["externally_connectable"] {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const matches = asStringArray(obj.matches);
  const ids = asStringArray(obj.ids);
  const wildcards = matches.some((m) => m.includes("*")) || ids.includes("*");
  return { matches, ids, wildcards };
}

function parseBackground(raw: unknown): ManifestAnalysis["background"] {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.service_worker === "string") {
    return { kind: "service_worker", script: obj.service_worker, module: obj.type === "module" };
  }
  if (typeof obj.page === "string") return { kind: "page", script: obj.page, module: false };
  if (Array.isArray(obj.scripts)) {
    const first = obj.scripts.find((s): s is string => typeof s === "string") ?? null;
    return { kind: "scripts", script: first, module: obj.type === "module" };
  }
  return null;
}
