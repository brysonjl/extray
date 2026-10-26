// Layer 5 — resource and asset checks. HTML (inline scripts + every element
// attribute that triggers an external request), CSS remote refs, locale message
// counts, web-accessible resources. Inline scripts are returned so the
// orchestrator can run them through Layer 3.
//
// `remote_refs` is the comprehensive declarative external-call surface (Gap 8):
// not just <script src>/<link>/<iframe> but img/source/video/audio/track src &
// srcset, object/embed, <a ping>, <form action>, and <meta refresh>. The legacy
// remote_scripts/remote_styles/remote_iframes fields are retained.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileEntry, Resources } from "./schema.ts";

const REMOTE = /^(https?:)?\/\//i;
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
// `type` values that mean executable JavaScript (missing/empty type included).
// Anything else (application/json, text/template, …) is data, not a script.
const JS_SCRIPT_TYPES = new Set(["", "module", "text/javascript", "application/javascript", "text/ecmascript", "application/ecmascript"]);
const SCRIPT_SRC = /<script[^>]+src=['"]([^'"]+)['"]/gi;
const LINK_HREF = /<link[^>]+href=['"]([^'"]+)['"]/gi;
const IFRAME_SRC = /<iframe[^>]+src=['"]([^'"]+)['"]/gi;
const CSS_URL = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
const CSS_IMPORT = /@import\s+['"]([^'"]+)['"]/gi;
const LOCALE_RE = /^_locales\/([^/]+)\/messages\.json$/;

function remotes(re: RegExp, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(re)) if (m[1] && REMOTE.test(m[1])) out.push(m[1]);
  return out;
}

/** All opening tags `<name ...>` in the text. */
function openTags(name: string, text: string): string[] {
  return [...text.matchAll(new RegExp(`<${name}\\b[^>]*>`, "gi"))].map((m) => m[0]);
}

/** Value of a quoted attribute within a single tag string, or null. */
function attrOf(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*['"]([^'"]+)['"]`, "i"));
  return m ? (m[1] ?? null) : null;
}

/** First URL of each srcset candidate ("a.jpg 1x, b.jpg 2x" → ["a.jpg","b.jpg"]). */
function srcsetUrls(v: string | null): string[] {
  if (!v) return [];
  return v.split(",").map((s) => s.trim().split(/\s+/)[0] ?? "").filter(Boolean);
}

// Element/attribute pairs whose value is a single resource URL.
const SRC_ELEMENTS: Array<[tag: string, attr: string, kind: string]> = [
  ["img", "src", "img.src"], ["source", "src", "source.src"],
  ["video", "src", "video.src"], ["audio", "src", "audio.src"],
  ["track", "src", "track.src"], ["object", "data", "object.data"],
  ["embed", "src", "embed.src"], ["form", "action", "form.action"],
  ["iframe", "src", "iframe.src"], ["script", "src", "script.src"],
];

/** Every element attribute in the HTML that triggers a remote request. */
function remoteRefs(text: string): Array<{ kind: string; url: string }> {
  const refs: Array<{ kind: string; url: string }> = [];
  const add = (kind: string, url: string | null) => {
    if (url && REMOTE.test(url)) refs.push({ kind, url });
  };

  for (const [tag, attr, kind] of SRC_ELEMENTS) {
    for (const t of openTags(tag, text)) add(kind, attrOf(t, attr));
  }
  // srcset (multiple URLs) on img/source.
  for (const tag of ["img", "source"]) {
    for (const t of openTags(tag, text)) for (const u of srcsetUrls(attrOf(t, "srcset"))) add(`${tag}.srcset`, u);
  }
  // <a ping="url url"> — space-separated list.
  for (const t of openTags("a", text)) for (const u of (attrOf(t, "ping") ?? "").split(/\s+/).filter(Boolean)) add("a.ping", u);
  // <link rel=...> — tag by rel so preload/preconnect/dns-prefetch/stylesheet are distinct.
  for (const t of openTags("link", text)) {
    const rel = (attrOf(t, "rel") ?? "").toLowerCase().replace(/\s+/g, "-");
    add(`link.${rel || "href"}`, attrOf(t, "href"));
  }
  // <meta http-equiv="refresh" content="0; url=...">
  for (const t of openTags("meta", text)) {
    if ((attrOf(t, "http-equiv") ?? "").toLowerCase() !== "refresh") continue;
    const m = (attrOf(t, "content") ?? "").match(/url\s*=\s*(.+)$/i);
    if (m && m[1]) add("meta.refresh", m[1].trim());
  }
  return refs;
}

export interface Layer5Result {
  resources: Resources;
  inlineScripts: Array<{ path: string; source: string }>;
}

export function analyzeResources(root: string, files: FileEntry[], manifest: Record<string, unknown>): Layer5Result {
  const html: Array<Record<string, unknown>> = [];
  const css: Array<Record<string, unknown>> = [];
  const locales: Resources["locales"] = {};
  const inlineScripts: Array<{ path: string; source: string }> = [];

  for (const f of files) {
    if (f.type === "html") {
      const text = readFileSync(join(root, f.path), "utf8");
      const inline = [...text.matchAll(INLINE_SCRIPT)]
        .filter((m) => JS_SCRIPT_TYPES.has((attrOf(m[1] ?? "", "type") ?? "").trim().toLowerCase()))
        .map((m) => m[2] ?? "")
        .filter((s) => s.trim().length > 0);
      inline.forEach((src, i) => inlineScripts.push({ path: `${f.path}#inline-${i + 1}`, source: src }));
      html.push({
        path: f.path,
        inline_scripts: inline.length,
        remote_scripts: remotes(SCRIPT_SRC, text),
        remote_styles: remotes(LINK_HREF, text),
        remote_iframes: remotes(IFRAME_SRC, text),
        remote_refs: remoteRefs(text),
      });
    } else if (f.type === "css") {
      const text = readFileSync(join(root, f.path), "utf8");
      const remoteRefs = [...remotes(CSS_URL, text), ...remotes(CSS_IMPORT, text)];
      if (remoteRefs.length > 0) css.push({ path: f.path, remote_refs: remoteRefs });
    } else {
      const m = f.path.match(LOCALE_RE);
      if (m && m[1]) {
        try {
          const obj = JSON.parse(readFileSync(join(root, f.path), "utf8")) as Record<string, unknown>;
          locales[m[1]] = { message_count: Object.keys(obj).length };
        } catch {
          locales[m[1]] = { message_count: 0 };
        }
      }
    }
  }

  html.sort((a, b) => (String(a.path) < String(b.path) ? -1 : 1));
  css.sort((a, b) => (String(a.path) < String(b.path) ? -1 : 1));

  const war = Array.isArray(manifest.web_accessible_resources) ? manifest.web_accessible_resources : [];

  return { resources: { html, css, locales, web_accessible_resources: war }, inlineScripts };
}
