// Network-destination extraction. Two passes:
//  1. URL/host string & template literals, tagged with the AST role they appear in.
//  2. The URL argument of each recognized network sink: folded through constants
//     (concat / atob / fromCharCode / join / const bindings). A fully-folded URL
//     is "static", a partly-dynamic one a "template" skeleton, and one that does
//     not fold at all is recorded as "unknown" — so a call whose destination we
//     cannot resolve is reported, never silently dropped (feeds the ledger).

import type { File, Node } from "@babel/types";
import type { NetworkDestination } from "../schema.ts";
import { memberChain, locOf, snippetFor, traverse, normalizeChain, collectAliases } from "./util.ts";
import { collectConstStrings, collectDecoders, foldSkeleton, isFullyResolved } from "./fold.ts";

const URLISH = /:\/\//;

/** Chain normalizer bound to the current file's alias map. */
type Norm = (chain: string) => string;

const NAV_ROLE: Record<string, string> = {
  "location.assign": "navigation.url",
  "location.replace": "navigation.url",
  open: "navigation.url", // window.open, normalized
  importScripts: "importScripts.url",
};

// `.open()` receivers that are definitely NOT XHR-style (no URL second arg):
// indexedDB.open(name), caches.open(name), document.open(). Bare `open` is
// window.open (navigation, handled above). Anything else — `xhr.open`,
// `req.open`, a renamed minified receiver — is treated as XHR: over-flag per
// the design philosophy rather than miss a concatenated/atob'd XHR URL.
const NON_XHR_OPEN_HEADS = new Set(["indexedDB", "caches", "document", "chrome"]);

function isXhrOpen(norm: string): boolean {
  if (!norm.endsWith(".open")) return false;
  const head = norm.slice(0, norm.indexOf("."));
  return !NON_XHR_OPEN_HEADS.has(head);
}

function roleOf(parent: Node, normalize: Norm): string {
  if (parent.type === "CallExpression") {
    if (parent.callee.type === "Import") return "import.specifier";
    const callee = memberChain(parent.callee);
    const norm = callee ? normalize(callee) : null;
    if (norm === "fetch") return "fetch.url";
    if (norm === "navigator.sendBeacon") return "sendBeacon.url";
    if (norm && NAV_ROLE[norm]) return NAV_ROLE[norm];
    if (norm && isXhrOpen(norm)) return "xhr-open";
    return norm ? `call-arg:${norm}` : "call-arg";
  }
  if (parent.type === "NewExpression") {
    const callee = memberChain(parent.callee);
    const norm = callee ? normalize(callee) : null;
    return norm ? `new:${norm}` : "new";
  }
  if (parent.type === "AssignmentExpression" && parent.left.type === "MemberExpression") {
    const left = memberChain(parent.left);
    if (left?.endsWith(".src")) return "script.src";
    const norm = left ? normalize(left) : null;
    if (norm === "location" || norm === "location.href") return "navigation.url";
  }
  if (parent.type === "AssignmentExpression" && parent.left.type === "Identifier" && parent.left.name === "location") {
    return "navigation.url";
  }
  if (parent.type === "VariableDeclarator") return "binding";
  return "literal";
}

function templateSkeleton(node: Extract<Node, { type: "TemplateLiteral" }>): string {
  let out = "";
  node.quasis.forEach((q, i) => {
    out += q.value.cooked ?? q.value.raw;
    if (i < node.expressions.length) out += "${…}";
  });
  return out;
}

const isUrlish = (s: string): boolean => URLISH.test(s) || s.startsWith("//");

// Resolvers that produce a URL to the extension's OWN packaged resources — not an
// external destination. A fetch of one of these is internal; don't record it as a
// destination (or as an unresolved/unknown one). The network sink is still cataloged.
// (browser.runtime.getURL normalizes to the chrome. spelling.)
const INTERNAL_RESOLVERS = new Set(["chrome.runtime.getURL", "chrome.extension.getURL"]);

function isInternalResolver(arg: Node, normalize: Norm): boolean {
  if (arg.type !== "CallExpression") return false;
  return INTERNAL_RESOLVERS.has(normalize(memberChain(arg.callee) ?? ""));
}

// URL-argument positions of recognized network sinks. Receiver-normalized chains.
function urlArgsOf(node: Node, normalize: Norm): Array<{ arg: Node; role: string }> {
  if (node.type === "CallExpression") {
    if (node.callee.type === "Import") {
      const a = node.arguments[0] as Node | undefined;
      return a ? [{ arg: a, role: "import.specifier" }] : [];
    }
    const norm = normalize(memberChain(node.callee) ?? "");
    const a0 = node.arguments[0] as Node | undefined;
    if (norm === "fetch" && a0) return [{ arg: a0, role: "fetch.url" }];
    if (norm === "navigator.sendBeacon" && a0) return [{ arg: a0, role: "sendBeacon.url" }];
    if (norm === "importScripts") return (node.arguments as Node[]).map((arg) => ({ arg, role: "importScripts.url" }));
    if ((norm === "location.assign" || norm === "location.replace" || norm === "open") && a0) {
      return [{ arg: a0, role: "navigation.url" }];
    }
    // <xhrVar>.open(method, url): the URL is the SECOND argument.
    if (isXhrOpen(norm)) {
      const a1 = node.arguments[1] as Node | undefined;
      return a1 ? [{ arg: a1, role: "xhr-open" }] : [];
    }
    return [];
  }
  if (node.type === "NewExpression") {
    const norm = normalize(memberChain(node.callee) ?? "");
    const a0 = node.arguments[0] as Node | undefined;
    if ((norm === "WebSocket" || norm === "EventSource") && a0) return [{ arg: a0, role: `new:${norm}` }];
    return [];
  }
  if (node.type === "AssignmentExpression" && node.operator === "=") {
    const left = node.left;
    if (left.type === "MemberExpression" && !left.computed) {
      const ln = normalize(memberChain(left) ?? "");
      if (ln.endsWith(".src")) return [{ arg: node.right, role: "script.src" }];
      if (ln === "location" || ln === "location.href") return [{ arg: node.right, role: "navigation.url" }];
    }
    if (left.type === "Identifier" && left.name === "location") return [{ arg: node.right, role: "navigation.url" }];
  }
  return [];
}

export function extractDestinations(ast: File, source: string): NetworkDestination[] {
  const dests: NetworkDestination[] = [];
  const seen = new Set<string>();
  const pushRole = (value: string, kind: NetworkDestination["kind"], node: Node, role: string) => {
    const loc = locOf(node);
    const key = `${value}@${loc.line}:${loc.column}`;
    if (seen.has(key)) return;
    seen.add(key);
    dests.push({ value, kind, ast_role: role, location: loc });
  };
  const decoders = collectDecoders(ast);
  const consts = collectConstStrings(ast, decoders);
  const aliases = collectAliases(ast);
  const normalize: Norm = (chain) => normalizeChain(chain, aliases);

  // Pass 2 handler: fold a sink's URL argument and classify the destination.
  const handleSinkArg = (arg: Node, role: string) => {
    // Direct literals/templates are recorded by pass 1; only fold the rest.
    if (arg.type === "StringLiteral" || arg.type === "TemplateLiteral") return;
    if (isInternalResolver(arg, normalize)) return; // fetch of own packaged resource — not external
    const sk = foldSkeleton(arg, consts, 0, decoders);
    if (isUrlish(sk)) {
      pushRole(sk, isFullyResolved(sk) ? "static" : "template", arg, role);
    } else if (sk.startsWith("/") || isFullyResolved(sk)) {
      // Relative path (same-origin) or a concrete non-URL string — not an external
      // destination, so not an unresolved one either. The sink is still cataloged.
      return;
    } else {
      // Could not establish even a scheme/path: genuinely unresolved (feeds ledger).
      pushRole(snippetFor(arg, source, 80), "unknown", arg, role);
    }
  };

  traverse(ast, {
    StringLiteral(path) {
      const node = path.node as Extract<Node, { type: "StringLiteral" }>;
      const v = node.value;
      if (isUrlish(v)) pushRole(v, "static", node, roleOf(path.parent, normalize));
    },
    TemplateLiteral(path) {
      const node = path.node as Extract<Node, { type: "TemplateLiteral" }>;
      const skeleton = templateSkeleton(node);
      if (isUrlish(skeleton)) {
        pushRole(skeleton, node.expressions.length > 0 ? "template" : "static", node, roleOf(path.parent, normalize));
      }
    },
    // A URL assembled by `+` concatenation (improvement 020): recover it wherever
    // it appears, not only as the argument of a recognized sink — the exfil host
    // in Click&Clean reaches fetch through a user-defined wrapper H(...), so a
    // sink-only Pass 2 never folds it. Fold only the TOP of a `+` chain so the
    // full URL is recorded once, and only when the result is URL-ish.
    BinaryExpression(path) {
      const node = path.node as Extract<Node, { type: "BinaryExpression" }>;
      if (node.operator !== "+") return;
      if (path.parent.type === "BinaryExpression" && path.parent.operator === "+") return;
      const sk = foldSkeleton(node, consts, 0, decoders);
      if (isUrlish(sk)) pushRole(sk, isFullyResolved(sk) ? "static" : "template", node, roleOf(path.parent, normalize));
    },
    CallExpression(path) {
      for (const { arg, role } of urlArgsOf(path.node, normalize)) handleSinkArg(arg, role);
    },
    NewExpression(path) {
      for (const { arg, role } of urlArgsOf(path.node, normalize)) handleSinkArg(arg, role);
    },
    AssignmentExpression(path) {
      for (const { arg, role } of urlArgsOf(path.node, normalize)) handleSinkArg(arg, role);
    },
  });

  dests.sort((a, b) => a.location.line - b.location.line || (a.location.column ?? 0) - (b.location.column ?? 0));
  return dests;
}
