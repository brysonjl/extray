// Layer 2 — file inventory and provenance. Enumerates every shipped file with
// metadata, a reference graph (manifest + HTML + JS imports), and anomaly flags.
// Provenance is stubbed {known:false} in v0 (allowlist deferred).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, posix } from "node:path";
import type { FileEntry } from "./schema.ts";

export interface Layer2Result {
  files: FileEntry[];
  /** Paths referenced by manifest/HTML/JS but absent on disk (soft anomaly). */
  missingReferences: string[];
}

const TYPE_BY_EXT: Record<string, string> = {
  ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".json": "json", ".html": "html", ".htm": "html", ".css": "css",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".txt": "text", ".md": "text",
};

const MAGIC: Array<{ type: string; bytes: number[] }> = [
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { type: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "font/woff", bytes: [0x77, 0x4f, 0x46, 0x46] },
  { type: "font/woff2", bytes: [0x77, 0x4f, 0x46, 0x32] },
];

/** Byte count following an image format's terminal marker. A conformant decoder
 *  stops at that marker, so appended bytes still render fine while remaining
 *  trivially readable via `fetch(chrome.runtime.getURL(...)).arrayBuffer()` —
 *  the standard way to smuggle config, keys, or a payload inside a shipped
 *  asset. Returns 0 for formats we do not delimit. */
function trailingBytesAfterImageEnd(buf: Buffer, type: string): number {
  if (type === "image/png") {
    // IEND chunk = "IEND" + 4-byte CRC, always last.
    const i = buf.lastIndexOf(Buffer.from("IEND"));
    return i === -1 ? 0 : buf.length - (i + 8);
  }
  if (type === "image/gif") {
    const i = buf.lastIndexOf(0x3b); // trailer
    return i === -1 ? 0 : buf.length - (i + 1);
  }
  if (type === "image/jpeg") {
    const i = buf.lastIndexOf(Buffer.from([0xff, 0xd9])); // EOI
    return i === -1 ? 0 : buf.length - (i + 2);
  }
  return 0;
}

const VENDOR_RE = /(^|\/)(lib|vendor|node_modules)\//;

function ext(path: string): string {
  const i = path.lastIndexOf(".");
  return i === -1 ? "" : path.slice(i).toLowerCase();
}

function walk(root: string): string[] {
  const out: string[] = [];
  const recurse = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) recurse(abs);
      else if (entry.isFile()) out.push(abs);
    }
  };
  recurse(root);
  return out;
}

// ---- reference extraction ----

const IMPORT_RES = [
  /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/g,
  /import\s*['"]([^'"]+)['"]/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
];
const HTML_RES = [
  /<script[^>]+src=['"]([^'"]+)['"]/gi,
  /<link[^>]+href=['"]([^'"]+)['"]/gi,
  /<img[^>]+src=['"]([^'"]+)['"]/gi,
  /<iframe[^>]+src=['"]([^'"]+)['"]/gi,
];

function extract(patterns: RegExp[], source: string): string[] {
  const found: string[] = [];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) if (m[1]) found.push(m[1]);
  }
  return found;
}

/** Resolve a relative/absolute specifier (from a file at relFrom) to a rel path, or null for bare/remote. */
function resolveSpecifier(spec: string, relFrom: string): string | null {
  if (/^[a-z]+:\/\//i.test(spec) || spec.startsWith("//")) return null; // remote
  let rel: string;
  if (spec.startsWith("/")) rel = spec.slice(1);
  else if (spec.startsWith("./") || spec.startsWith("../")) rel = posix.normalize(posix.join(posix.dirname(relFrom), spec));
  else return null; // bare specifier (npm-style) — not shipped in the extension
  return rel.replace(/^\.\//, "");
}

function manifestRefs(manifest: Record<string, unknown>): Array<{ ref: string; via: string }> {
  const refs: Array<{ ref: string; via: string }> = [];
  const add = (v: unknown, via: string) => {
    if (typeof v !== "string") return;
    // Manifest refs are root-relative; normalize like resolveSpecifier does so
    // "./js/bg.js", "a/./b", and backslash paths match the on-disk inventory.
    const rel = posix.normalize(v.split("\\").join("/").replace(/^\//, "")).replace(/^\.\//, "");
    if (rel && rel !== ".") refs.push({ ref: rel, via });
  };
  const bg = manifest.background as Record<string, unknown> | undefined;
  if (bg) { add(bg.service_worker, "manifest:background.service_worker"); add(bg.page, "manifest:background.page"); }
  for (const cs of (Array.isArray(manifest.content_scripts) ? manifest.content_scripts : [])) {
    const o = cs as Record<string, unknown>;
    for (const f of [...(Array.isArray(o.js) ? o.js : []), ...(Array.isArray(o.css) ? o.css : [])]) add(f, "manifest:content_scripts");
  }
  const action = (manifest.action ?? manifest.browser_action) as Record<string, unknown> | undefined;
  if (action) add(action.default_popup, "manifest:action.default_popup");
  add(manifest.options_page, "manifest:options_page");
  const oui = manifest.options_ui as Record<string, unknown> | undefined;
  if (oui) add(oui.page, "manifest:options_ui.page");
  add(manifest.devtools_page, "manifest:devtools_page");
  const icons = manifest.icons as Record<string, unknown> | undefined;
  if (icons) for (const v of Object.values(icons)) add(v, "manifest:icons");
  for (const war of (Array.isArray(manifest.web_accessible_resources) ? manifest.web_accessible_resources : [])) {
    const o = war as Record<string, unknown>;
    for (const r of (Array.isArray(o.resources) ? o.resources : [])) {
      // WAR entries are glob patterns; an exact on-disk match is meaningless for
      // globs, so skip them rather than reporting a false missing-asset.
      if (typeof r === "string" && /[*?[\]]/.test(r)) continue;
      add(r, "manifest:web_accessible_resources");
    }
  }
  return refs;
}

export function analyzeFiles(root: string, manifest: Record<string, unknown>): Layer2Result {
  const absFiles = walk(root);
  const relPaths = absFiles.map((a) => relative(root, a).split(/[\\/]/).join("/"));
  const onDisk = new Set(relPaths);

  // Build the reference graph: ref path -> set of "via" labels.
  const referencedBy = new Map<string, Set<string>>();
  const missing = new Set<string>();
  const addRef = (ref: string, via: string) => {
    if (onDisk.has(ref)) {
      let set = referencedBy.get(ref);
      if (!set) { set = new Set(); referencedBy.set(ref, set); }
      set.add(via);
    } else {
      missing.add(ref);
    }
  };

  for (const { ref, via } of manifestRefs(manifest)) addRef(ref, via);

  // HTML + JS import edges.
  for (let i = 0; i < absFiles.length; i++) {
    const rel = relPaths[i]!;
    const e = ext(rel);
    if (e === ".html" || e === ".htm") {
      for (const spec of extract(HTML_RES, readFileSync(absFiles[i]!, "utf8"))) {
        const r = resolveSpecifier(spec, rel);
        if (r) addRef(r, `html:${rel}`);
      }
    } else if (e === ".js" || e === ".mjs" || e === ".cjs") {
      for (const spec of extract(IMPORT_RES, readFileSync(absFiles[i]!, "utf8"))) {
        const r = resolveSpecifier(spec, rel);
        if (r) addRef(r, `import:${rel}`);
      }
    }
  }

  const files: FileEntry[] = [];
  for (let i = 0; i < absFiles.length; i++) {
    const abs = absFiles[i]!;
    const rel = relPaths[i]!;
    const buf = readFileSync(abs);
    const size = statSync(abs).size;
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const declaredType = TYPE_BY_EXT[ext(rel)] ?? "binary";

    const refs = [...(referencedBy.get(rel) ?? [])].sort();
    if (rel === "manifest.json") refs.push("manifest:self");

    files.push({
      path: rel,
      size_bytes: size,
      sha256,
      type: declaredType,
      referenced_by: refs,
      provenance: { known: false },
      anomalies: anomaliesFor(rel, buf, declaredType, refs.length > 0),
    });
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, missingReferences: [...missing].sort() };
}

function anomaliesFor(rel: string, buf: Buffer, declaredType: string, referenced: boolean): string[] {
  const anomalies: string[] = [];
  const isVendor = VENDOR_RE.test(rel);

  const magic = MAGIC.find((m) => m.bytes.every((b, i) => buf[i] === b));
  if (declaredType.startsWith("image/") || declaredType.startsWith("font/")) {
    if (magic && magic.type !== declaredType) anomalies.push(`magic-byte mismatch: looks like ${magic.type}, named ${declaredType}`);
    if (magic) {
      const trailing = trailingBytesAfterImageEnd(buf, magic.type);
      if (trailing > 0) anomalies.push(`${trailing} bytes appended after the ${magic.type} end-of-image marker (hidden from decoders, readable at runtime)`);
    }
  } else if (magic && (declaredType === "javascript" || declaredType === "json" || declaredType === "css" || declaredType === "html")) {
    anomalies.push(`magic-byte mismatch: binary content in a ${declaredType} file (${magic.type})`);
  }

  if (declaredType === "javascript" || declaredType === "css" || declaredType === "html") {
    const text = buf.toString("utf8");
    const maxLine = text.split("\n").reduce((m, l) => Math.max(m, l.length), 0);
    if (maxLine > 1000 && !isVendor) anomalies.push("very long line outside vendor path (possible minification)");
    if (hasLongBase64Run(text, 4096)) anomalies.push("large base64 blob (>4KB)");
  }

  if (!referenced && rel !== "manifest.json") anomalies.push("present but unreferenced from manifest, HTML, or JS imports");
  return anomalies.sort();
}

// Linear scan for a contiguous run of >= minLen base64 characters. Replaces a
// regex (`[A-Za-z0-9+/]{minLen,}`) whose greedy quantifier overflows V8's
// backtracking engine on very long runs (e.g. a ~10MB+ base64 blob in a
// de-minified bundle throws "Maximum call stack size exceeded").
function hasLongBase64Run(text: string, minLen: number): boolean {
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // A-Z, a-z, 0-9, '+', '/'
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47) {
      if (++run >= minLen) return true;
    } else {
      run = 0;
    }
  }
  return false;
}
