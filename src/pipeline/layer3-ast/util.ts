// Shared AST helpers for Layer 3.

import { createRequire } from "node:module";
import type { Node, File } from "@babel/types";
import type { Location } from "../schema.ts";

// @babel/traverse is CJS with a default export; load via require so tsc/runtime
// agree on the callable (same pattern as ajv).
const require = createRequire(import.meta.url);
const traverseMod = require("@babel/traverse");
type Visitor = Record<string, (path: { node: Node; parent: Node }) => void>;
export const traverse = (traverseMod.default ?? traverseMod) as (ast: File, visitors: Visitor) => void;

/** Flatten a non-computed member/identifier chain to a dotted string, else null. */
export function memberChain(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "ThisExpression") return "this";
  if (node.type === "MemberExpression" && !node.computed) {
    const obj = memberChain(node.object);
    const prop = node.property.type === "Identifier" ? node.property.name : null;
    if (obj && prop) return `${obj}.${prop}`;
  }
  // Zero-arg call root: `x()` (webextension-polyfill / webpack module accessor)
  // and member chains hung off it (`x().management.setEnabled`). Emit a `name()`
  // root token so normalizeChain can rewrite the call-accessor form to chrome.*
  // when the next segment is a chrome namespace. Calls with args are not
  // accessors and stay null.
  if (node.type === "CallExpression" && node.arguments.length === 0) {
    const callee = memberChain(node.callee);
    return callee ? `${callee}()` : null;
  }
  return null;
}

// Chrome/WebExtensions API namespaces. Used to recognize a call-accessor root
// (`x().management.*`) as the chrome global even when the accessor is obtained
// through webpack/polyfill plumbing that static alias resolution can't follow.
const CHROME_NAMESPACES = new Set([
  "cookies", "storage", "tabs", "scripting", "webRequest", "webNavigation",
  "declarativeNetRequest", "management", "identity", "downloads", "proxy",
  "debugger", "nativeMessaging", "tabCapture", "desktopCapture", "contextMenus",
  "runtime", "alarms", "windows", "action", "offscreen", "permissions",
]);

/**
 * Rewrite a zero-arg call-accessor root to the chrome global when the segment
 * after it is a chrome namespace: `x().management.setEnabled` →
 * `chrome.management.setEnabled`. Gated on the chrome-namespace check so an
 * unrelated `getThing().tabs` (some user object) is left untouched. Over-flags
 * only on the unlikely `<call>().<chromeNamespace>` shape (consistent with the
 * over-flag-by-design posture elsewhere in Layer 3).
 */
function rewriteCallAccessorRoot(chain: string): string {
  const m = chain.match(/^[^.]*\(\)\.(.+)$/);
  const rest = m?.[1];
  if (!rest) return chain;
  const dot = rest.indexOf(".");
  const ns = dot === -1 ? rest : rest.slice(0, dot);
  return CHROME_NAMESPACES.has(ns) ? `chrome.${rest}` : chain;
}

// Global-object receivers that transparently alias the global scope. `window.fetch`
// and `fetch` are the same call; stripping these canonicalizes both forms so
// receiver-sensitive matching does not miss `window.`/`self.`/`globalThis.` calls.
const GLOBAL_RECEIVERS = new Set(["window", "self", "globalThis", "frames", "top"]);

/** Strip leading global-object receivers from a dotted chain (window.fetch → fetch). */
export function stripGlobalReceiver(chain: string): string {
  let c = chain;
  let dot = c.indexOf(".");
  while (dot !== -1 && GLOBAL_RECEIVERS.has(c.slice(0, dot))) {
    c = c.slice(dot + 1);
    dot = c.indexOf(".");
  }
  return c;
}

/** True if every segment of a chain is a global-object receiver (window, self.frames, …). */
export function isGlobalReceiverChain(chain: string): boolean {
  return chain.split(".").every((seg) => GLOBAL_RECEIVERS.has(seg));
}

/**
 * Expand the head identifier of a chain through an intra-file alias map, so
 * `const f = fetch; f()` and `const c = chrome.cookies; c.getAll()` resolve to
 * the underlying API. Cycle-guarded; returns the chain unchanged if not aliased.
 */
export function expandAlias(chain: string, aliases: Map<string, string>, seen = new Set<string>()): string {
  const dot = chain.indexOf(".");
  const head = dot === -1 ? chain : chain.slice(0, dot);
  const rest = dot === -1 ? "" : chain.slice(dot);
  if (aliases.has(head) && !seen.has(head)) {
    seen.add(head);
    return expandAlias(aliases.get(head)! + rest, aliases, seen);
  }
  return chain;
}

/**
 * Canonicalize a callee/assignment-target chain: expand intra-file aliases,
 * strip global receivers (`window.fetch` → `fetch`), fold `document.location.*`
 * to `location.*`, and treat the `browser.*` (WebExtensions / polyfill)
 * namespace as `chrome.*`. Every receiver-sensitive matcher (sinks, taint,
 * destinations, listeners, Layer-4 permission mapping) goes through this so
 * the same API spelled differently cannot evade one extractor but not another.
 */
export function normalizeChain(chain: string, aliases?: Map<string, string>): string {
  let c = stripGlobalReceiver(aliases ? expandAlias(chain, aliases) : chain);
  // Call-accessor root (`x().management.*`) → chrome.* before the browser.→chrome.
  // fold, so a `browser`-returning accessor also lands on chrome.
  c = rewriteCallAccessorRoot(c);
  // document.location aliases the global location. This is NOT a general
  // `document.` strip — document.write/document.cookie keep their receiver.
  if (c === "document.location" || c.startsWith("document.location.")) c = c.slice("document.".length);
  if (c === "browser" || c.startsWith("browser.")) c = "chrome" + c.slice("browser".length);
  return c;
}

// Intra-file alias map: `const f = fetch` / `c = chrome.cookies` → name ⇒ target
// chain. Lets later resolution expand `f()` to `fetch` and `c.getAll()` to
// `chrome.cookies.getAll`. Shallow by design — local declarations and simple
// assignments only, no scope tracking.
export function collectAliases(ast: File): Map<string, string> {
  const aliases = new Map<string, string>();
  const record = (id: Node, init: Node | null | undefined) => {
    if (id.type !== "Identifier" || !init) return;
    const target = memberChain(init);
    if (target && target !== id.name) aliases.set(id.name, target);
  };
  traverse(ast, {
    VariableDeclarator(path) {
      const node = path.node as Extract<Node, { type: "VariableDeclarator" }>;
      record(node.id, node.init);
    },
    AssignmentExpression(path) {
      const node = path.node as Extract<Node, { type: "AssignmentExpression" }>;
      if (node.operator === "=") record(node.left, node.right);
    },
  });
  return aliases;
}

export function locOf(node: Node): Location {
  const l = node.loc?.start;
  return l ? { line: l.line, column: l.column } : { line: 0, column: 0 };
}

/** Literal source bytes for a node, capped (AST node, bounded). */
export function snippetFor(node: Node, source: string, cap = 240): string {
  const start = node.start ?? 0;
  const end = node.end ?? start;
  let text = source.slice(start, Math.min(end, start + cap));
  if (end - start > cap) text += " …";
  return text.replace(/\s+/g, " ").trim();
}

/** First string-literal argument value, if any (for setTimeout/execCommand checks). */
export function firstStringArg(args: Node[]): string | null {
  const a = args[0];
  if (a && a.type === "StringLiteral") return a.value;
  return null;
}

/** Recursively collect identifier names within a subtree (or list of subtrees). */
export function collectIdentifiers(input: Node | Node[] | null | undefined): Set<string> {
  const names = new Set<string>();
  const visit = (n: unknown): void => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) visit(x); return; }
    const node = n as Record<string, unknown>;
    if (typeof node.type === "string") {
      if (node.type === "Identifier" && typeof node.name === "string") names.add(node.name);
      for (const k of Object.keys(node)) {
        if (k === "loc" || k === "start" || k === "end" || k === "leadingComments" || k === "trailingComments") continue;
        visit(node[k]);
      }
    }
  };
  visit(input as Node);
  return names;
}

/** Find the first function/arrow argument in a call's argument list. */
export function functionArg(args: Node[]): Node | null {
  return args.find((a) => a.type === "ArrowFunctionExpression" || a.type === "FunctionExpression") ?? null;
}
