// Sink extraction: catalog calls to high-signal APIs (code-exec, cookies/storage,
// network, privilege, messaging, clipboard/contextMenus side-channels).
// NOTE: API names like the document HTML-writers are *detection targets* here,
// not calls this analyzer makes; some are assembled from constants to avoid
// naive source scanners mis-flagging this detector file.

import type { File, Node } from "@babel/types";
import type { Location, Sink } from "../schema.ts";
import {
  memberChain, locOf, snippetFor, firstStringArg, traverse,
  stripGlobalReceiver, isGlobalReceiverChain, expandAlias,
  normalizeChain, collectAliases,
} from "./util.ts";

const DOC = "document";
const HTML_WRITERS = [`${DOC}.write`, `${DOC}.writeln`];
const DOM_COOKIE = `${DOC}.cookie`;
const EXEC_COMMAND = `${DOC}.execCommand`;
const INNER = "inner" + "HTML";
const OUTER = "outer" + "HTML";

const PRIVILEGE_PREFIXES = [
  "chrome.webRequest.", "chrome.declarativeNetRequest.", "chrome.proxy.",
  "chrome.debugger.", "chrome.management.", "chrome.identity.",
  "chrome.downloads.", "chrome.nativeMessaging.", "chrome.tabCapture.",
  "chrome.desktopCapture.", "chrome.scripting.executeScript",
  "chrome.tabs.executeScript", "chrome.userScripts.",
];
const MESSAGING = [
  "chrome.runtime.onMessage", "chrome.runtime.onMessageExternal",
  "chrome.runtime.sendMessage", "chrome.runtime.connect",
  "chrome.runtime.connectExternal", "postMessage", // window. stripped by normalization
];

const NAV_CALLS = ["location.assign", "location.replace", "open"]; // open = window.open, normalized

// executeScript variants whose `code` payload is injected source (normalized chains).
const EXECUTE_SCRIPT = new Set(["chrome.scripting.executeScript", "chrome.tabs.executeScript"]);

const isFunctionNode = (n: Node): boolean =>
  n.type === "ArrowFunctionExpression" || n.type === "FunctionExpression";

function classifyCall(chain: string, args: Node[], fnNames: Set<string>): { category: string; api: string } | null {
  if (chain === "fetch" || chain === "navigator.sendBeacon") return { category: "network", api: chain };
  // importScripts loads AND executes remote script; import() loads a remote module.
  // Both are network calls and dynamic-code-exec opaque regions (see ledger.ts).
  if (chain === "importScripts") return { category: "network", api: chain };
  if (chain.endsWith(".createDataChannel")) return { category: "network", api: "RTCDataChannel" };
  // Navigation/URL-leak sinks: data can exfiltrate via the navigation URL.
  if (NAV_CALLS.includes(chain)) return { category: "navigation", api: chain === "open" ? "window.open" : chain };
  if (chain === "eval") return { category: "code-exec", api: chain };
  if (HTML_WRITERS.includes(chain)) return { category: "code-exec", api: chain };
  if (chain.endsWith(".insertAdjacentHTML")) return { category: "code-exec", api: chain };
  if (chain === "setTimeout" || chain === "setInterval") {
    if (typeof firstStringArg(args) === "string") return { category: "code-exec", api: `${chain}(string)` };
    // Non-function first arg that may hold a string (variable, concatenation,
    // template): cannot be ruled out statically — over-flag as dynamic. Known
    // in-file function names are exempt to keep `setTimeout(tick, 1000)` quiet.
    const a0 = args[0];
    if (
      a0 && !isFunctionNode(a0) &&
      (a0.type === "TemplateLiteral" ||
        (a0.type === "BinaryExpression" && a0.operator === "+") ||
        (a0.type === "Identifier" && !fnNames.has(a0.name)))
    ) {
      return { category: "code-exec", api: `${chain}(dynamic)` };
    }
  }
  if (chain.startsWith("chrome.cookies.")) return { category: "cookies", api: chain };
  if (chain.startsWith("chrome.storage.")) return { category: "storage", api: chain };
  if (/^(localStorage|sessionStorage|indexedDB)\b/.test(chain)) return { category: "storage", api: chain };
  if (PRIVILEGE_PREFIXES.some((p) => chain === p || chain.startsWith(p))) return { category: "privilege", api: chain };
  if (MESSAGING.some((m) => chain === m || chain.startsWith(m))) return { category: "messaging", api: chain };
  if (chain.startsWith("chrome.tabs.")) return { category: "tabs", api: chain };
  if (chain.startsWith("navigator.clipboard.")) return { category: "clipboard", api: chain };
  if (chain === EXEC_COMMAND) {
    const arg = firstStringArg(args);
    if (arg === "copy" || arg === "cut") return { category: "clipboard", api: `${EXEC_COMMAND}(copy)` };
  }
  if (chain.startsWith("chrome.contextMenus.")) return { category: "ui", api: chain };
  return null;
}

// Names bound to in-file functions (declarations + function-valued bindings):
// used to exempt `setTimeout(knownFn, ms)` from the dynamic-arg over-flag.
function collectFunctionNames(ast: File): Set<string> {
  const names = new Set<string>();
  traverse(ast, {
    FunctionDeclaration(path) {
      const node = path.node as Extract<Node, { type: "FunctionDeclaration" }>;
      if (node.id) names.add(node.id.name);
    },
    VariableDeclarator(path) {
      const node = path.node as Extract<Node, { type: "VariableDeclarator" }>;
      if (node.id.type === "Identifier" && node.init && isFunctionNode(node.init)) names.add(node.id.name);
    },
    AssignmentExpression(path) {
      const node = path.node as Extract<Node, { type: "AssignmentExpression" }>;
      if (node.operator === "=" && node.left.type === "Identifier" && isFunctionNode(node.right)) {
        names.add(node.left.name);
      }
    },
  });
  return names;
}

export interface ExecuteScriptPayload {
  /** Normalized api the payload belongs to, suffixed `(code)`. */
  api: string;
  /** Injected source when the payload is a string literal; null when dynamic. */
  source: string | null;
  location: Location;
  node: Node;
}

/**
 * `code` payloads of chrome.scripting/tabs.executeScript calls: injected
 * source strings (a string-literal arg or a string `code:` property). The
 * caller parses literal payloads as nested scripts; dynamic payloads are
 * opaque (the `(code)` sink feeds the external-call ledger). `func:` payloads
 * are plain AST function nodes — the normal traversal already covers them.
 */
export function executeScriptCodePayloads(ast: File, aliases = collectAliases(ast)): ExecuteScriptPayload[] {
  const payloads: ExecuteScriptPayload[] = [];
  traverse(ast, {
    CallExpression(path) {
      const node = path.node as Extract<Node, { type: "CallExpression" }>;
      const chain = memberChain(node.callee);
      if (!chain) return;
      const norm = normalizeChain(chain, aliases);
      if (!EXECUTE_SCRIPT.has(norm)) return;
      const add = (payload: Node) =>
        payloads.push({
          api: `${norm}(code)`,
          source: payload.type === "StringLiteral" ? payload.value : null,
          location: locOf(payload),
          node: payload,
        });
      for (const arg of node.arguments as Node[]) {
        if (arg.type === "StringLiteral") add(arg);
        else if (arg.type === "ObjectExpression") {
          for (const prop of arg.properties) {
            if (prop.type !== "ObjectProperty" || prop.computed) continue;
            const key = prop.key.type === "Identifier" ? prop.key.name : prop.key.type === "StringLiteral" ? prop.key.value : null;
            if (key === "code") add(prop.value as Node);
          }
        }
      }
    },
  });
  return payloads;
}

// A computed call/new whose receiver resolves to the global object —
// `window["fet"+"ch"](…)`, `self["XMLHttpRequest"]` — defeats name matching.
// We cannot resolve the property, but we must not be silent: flag it.
function indirectGlobalCallee(callee: Node, aliases: Map<string, string>): boolean {
  if (callee.type !== "MemberExpression" || !callee.computed) return false;
  const obj = memberChain(callee.object);
  if (!obj) return false;
  return isGlobalReceiverChain(stripGlobalReceiver(expandAlias(obj, aliases)));
}

// Header/body shape of a network call's options object, captured structurally so
// the security-relevant tail of a request (auth headers, a body referencing a
// source) survives even when the textual snippet truncates (improvement 011).
function networkArgsSummary(node: Node): Record<string, unknown> | null {
  if (node.type !== "CallExpression") return null;
  const args = node.arguments as Node[];
  const opts = args[1];
  if (!opts || opts.type !== "ObjectExpression") return null;
  const summary: Record<string, unknown> = {};
  for (const prop of opts.properties) {
    if (prop.type !== "ObjectProperty" || prop.computed) continue;
    const key = prop.key.type === "Identifier" ? prop.key.name : prop.key.type === "StringLiteral" ? prop.key.value : null;
    const val = prop.value as Node;
    if (key === "method" && val.type === "StringLiteral") summary.method = val.value;
    else if (key === "headers" && val.type === "ObjectExpression") {
      summary.header_keys = val.properties
        .map((p) => (p.type === "ObjectProperty" && !p.computed
          ? (p.key.type === "Identifier" ? p.key.name : p.key.type === "StringLiteral" ? p.key.value : null)
          : null))
        .filter((k): k is string => typeof k === "string");
    } else if (key === "body") {
      // body_kind: a literal/string is static; anything referencing identifiers
      // (cookie/storage values, JSON.stringify(userObj)) is `dynamic` — the taint
      // layer classifies the actual source; here we just mark it present + shape.
      summary.body_present = true;
      summary.body_kind = val.type === "StringLiteral" ? "static" : "dynamic";
    }
  }
  return Object.keys(summary).length ? summary : null;
}

// The static value of a node when it is a fixed string (a string literal or a
// template with no substitutions), else null — i.e. "is this a build-time
// constant?". Capped so a giant eval'd literal cannot bloat the pack.
const ARG_VALUE_CAP = 240;
function staticStringValue(node: Node): string | null {
  if (node.type === "StringLiteral") return node.value.slice(0, ARG_VALUE_CAP);
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked ?? q.value.raw).join("").slice(0, ARG_VALUE_CAP);
  }
  return null;
}

// Code-exec sinks whose executable argument we classify: the Function/eval/
// setTimeout(string)/setInterval(string) family. The HTML writers, innerHTML
// assignments, and executeScript(code) payloads are code-exec too but carry
// their shape elsewhere (snippet / the `(code)` literal-vs-dynamic split), so
// they are left alone here.
const CODE_EXEC_ARG_APIS = /^(?:eval|Function|setTimeout|setInterval)\b/;

// arg0_kind: is the executed string a hardcoded literal or a dynamic expression
// (a variable / concatenation / interpolation that could carry runtime input)?
// This is the fact that separates `new Function("return this")` (a webpack
// global-object shim) from `new Function(userInput)` (improvement 016). For
// `Function` the executable string is the LAST argument (earlier args are
// parameter names); for eval/setTimeout/setInterval it is the first.
function codeExecArgsSummary(category: string, api: string, node: Node): Record<string, unknown> | null {
  if (category !== "code-exec" || !CODE_EXEC_ARG_APIS.test(api)) return null;
  const args =
    node.type === "CallExpression" || node.type === "NewExpression" ? (node.arguments as Node[]) : null;
  if (!args || args.length === 0) return null;
  const codeArg = api.startsWith("Function") ? args[args.length - 1] : args[0];
  if (!codeArg) return null;
  const literal = staticStringValue(codeArg);
  return literal !== null ? { arg0_kind: "literal", arg0_value: literal } : { arg0_kind: "dynamic" };
}

export function extractSinks(ast: File, source: string): Sink[] {
  const sinks: Sink[] = [];
  const seen = new Set<string>();
  const push = (category: string, api: string, node: Node) => {
    const loc = locOf(node);
    const key = `${api}@${loc.line}:${loc.column}`;
    if (seen.has(key)) return;
    seen.add(key);
    // Network sinks get a larger snippet budget (auth headers / bodies live past
    // the default 240-byte cap) plus a structural argument summary so a truncated
    // text snippet never hides the request shape.
    const isNetwork = category === "network";
    const snippet = snippetFor(node, source, isNetwork ? 1200 : 240);
    const sink: Sink = { category, api, location: loc, snippet };
    // Structural argument capture (improvement 011 for network, 016 for code-exec):
    // whether the code/request payload is a hardcoded literal or a dynamic
    // (attacker-influenceable) expression is a deterministic pack fact, so no
    // model has to re-derive it by reading source.
    const argsSummary = isNetwork ? networkArgsSummary(node) : codeExecArgsSummary(category, api, node);
    if (argsSummary) sink.arguments_summary = [argsSummary];
    sinks.push(sink);
  };

  const aliases = collectAliases(ast);
  const fnNames = collectFunctionNames(ast);
  // Canonicalize a callee chain (alias-expand + receiver-strip + browser.→chrome.).
  const normalize = (chain: string): string => normalizeChain(chain, aliases);

  traverse(ast, {
    CallExpression(path) {
      const node = path.node as Extract<Node, { type: "CallExpression" }>;
      // Dynamic import(): Babel models it as a CallExpression with an Import callee.
      if (node.callee.type === "Import") { push("network", "import()", node); return; }
      const chain = memberChain(node.callee);
      if (chain) {
        const hit = classifyCall(normalize(chain), node.arguments as Node[], fnNames);
        if (hit) push(hit.category, hit.api, node);
      } else if (indirectGlobalCallee(node.callee, aliases)) {
        push("network-indirect", "indirect-global-call", node);
      }
    },
    NewExpression(path) {
      const node = path.node as Extract<Node, { type: "NewExpression" }>;
      const chain = memberChain(node.callee);
      if (chain) {
        const c = normalize(chain);
        if (c === "XMLHttpRequest" || c === "WebSocket" || c === "EventSource") push("network", c, node);
        else if (c === "RTCPeerConnection" || c === "webkitRTCPeerConnection") push("network", c, node);
        else if (c === "Function") push("code-exec", "Function", node);
      } else if (indirectGlobalCallee(node.callee, aliases)) {
        push("network-indirect", "indirect-global-new", node);
      }
    },
    MemberExpression(path) {
      const chain = memberChain(path.node);
      if (chain && normalizeChain(chain, aliases) === DOM_COOKIE) push("cookies", DOM_COOKIE, path.node);
    },
    AssignmentExpression(path) {
      const node = path.node as Extract<Node, { type: "AssignmentExpression" }>;
      // Bare `location = url` (Identifier target) navigates the global location.
      if (node.left.type === "Identifier" && node.left.name === "location") {
        push("navigation", "location =", node);
        return;
      }
      if (node.left.type !== "MemberExpression" || node.left.computed) return;
      const raw = memberChain(node.left);
      if (!raw) return;
      const chain = normalizeChain(raw, aliases);
      if (chain.endsWith("." + INNER) || chain.endsWith("." + OUTER)) push("code-exec", `${raw} =`, node);
      else if (chain.endsWith(".src")) push("network", `${raw} =`, node);
      // Assigning a URL to location / location.href navigates, leaking via the
      // URL. normalizeChain folds document.location.href into location.href.
      else if (chain === "location" || chain === "location.href") push("navigation", `${chain} =`, node);
    },
  });

  // executeScript `code` payloads are dynamically injected source: record each
  // as a code-exec sink (the ledger turns these into opaque regions; literal
  // payloads are additionally parsed as nested scripts by analyzeScript).
  for (const p of executeScriptCodePayloads(ast, aliases)) {
    push("code-exec", p.api, p.node);
  }

  sinks.sort((a, b) => a.location.line - b.location.line || (a.location.column ?? 0) - (b.location.column ?? 0));
  return sinks;
}
