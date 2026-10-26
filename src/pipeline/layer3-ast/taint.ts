// Shallow, single-file taint sketches. For each network/code-exec sink, check
// whether its arguments reference a "source" binding (cookie/storage/tabs/message
// data), propagating source-ness through up to 3 local variable hops. Cross-file
// flows are intentionally not tracked (documented blind spot).
//
// Callee chains are normalized (normalizeChain: aliases, global receivers,
// browser.→chrome.) so `window.fetch` / `const f = fetch` cannot evade sketches
// that bare `fetch` would produce. Sources are recognized in both the
// callback-arg form and the await/.then promise form (the standard MV3 idiom).

import type { File, Node } from "@babel/types";
import type { TaintSketch } from "../schema.ts";
import { memberChain, locOf, collectIdentifiers, functionArg, traverse, normalizeChain, collectAliases } from "./util.ts";

const DOM_COOKIE = "document" + ".cookie";

function sourceKind(api: string): string | null {
  if (api.startsWith("chrome.cookies.") || api === DOM_COOKIE) return "cookie";
  if (api.startsWith("chrome.storage.")) return "storage";
  if (api === "chrome.tabs.query") return "tabs";
  if (api.startsWith("chrome.runtime.onMessage")) return "message";
  return null;
}

function isSourceCall(chain: string): boolean {
  return (
    chain === "chrome.cookies.getAll" || chain === "chrome.cookies.get" ||
    chain === "chrome.tabs.query" ||
    (chain.startsWith("chrome.storage.") && chain.endsWith(".get"))
  );
}

function sinkCategory(chain: string): "network" | "code-exec" | "navigation" | null {
  if (chain === "fetch" || chain === "navigator.sendBeacon") return "network";
  // XHR.send / WebSocket.send — receiver type is unknowable statically, so any
  // `<recv>.send(…)` counts (over-flag by design; the sketch carries the api).
  if (chain.endsWith(".send")) return "network";
  if (chain === "eval" || chain === "document".concat(".write") || chain === "document".concat(".writeln")) return "code-exec";
  if (chain.endsWith(".insertAdjacentHTML")) return "code-exec";
  return null;
}

interface SinkRef { api: string; category: string; location: ReturnType<typeof locOf>; ids: Set<string> }

export function extractTaintSketches(ast: File, source: string): TaintSketch[] {
  void source;
  const aliases = collectAliases(ast);
  const norm = (chain: string): string => normalizeChain(chain, aliases);
  const sources = new Map<string, string>(); // name -> source api
  const declarators: Array<{ name: string; idsInInit: Set<string> }> = [];
  const sinks: SinkRef[] = [];

  // Register the first param of a source call's callback as a source binding.
  const registerCallbackParam = (args: Node[], api: string) => {
    const fn = functionArg(args);
    const param = fn && "params" in fn ? (fn.params as Node[])[0] : null;
    if (param && param.type === "Identifier") sources.set(param.name, api);
  };

  traverse(ast, {
    CallExpression(path) {
      const node = path.node as Extract<Node, { type: "CallExpression" }>;
      const chain = memberChain(node.callee);
      if (chain) {
        const c = norm(chain);
        if (isSourceCall(c)) registerCallbackParam(node.arguments as Node[], c);
        const cat = sinkCategory(c);
        if (cat) sinks.push({ api: c, category: cat, location: locOf(node), ids: collectIdentifiers(node.arguments as Node[]) });
      } else if (
        // Promise form: chrome.cookies.getAll({}).then(c => …) — the callee's
        // object is a CallExpression, so memberChain() above yields null.
        node.callee.type === "MemberExpression" && !node.callee.computed &&
        node.callee.property.type === "Identifier" && node.callee.property.name === "then" &&
        node.callee.object.type === "CallExpression"
      ) {
        const inner = memberChain(node.callee.object.callee);
        if (inner && isSourceCall(norm(inner))) registerCallbackParam(node.arguments as Node[], norm(inner));
      }
    },
    NewExpression(path) {
      const node = path.node as Extract<Node, { type: "NewExpression" }>;
      const chain = memberChain(node.callee);
      if (chain && norm(chain) === "Function") {
        sinks.push({ api: "Function", category: "code-exec", location: locOf(node), ids: collectIdentifiers(node.arguments as Node[]) });
      }
    },
    VariableDeclarator(path) {
      const node = path.node as Extract<Node, { type: "VariableDeclarator" }>;
      if (node.id.type !== "Identifier" || !node.init) return;
      // Await form: `const c = await chrome.cookies.getAll({})` binds the
      // resolved source value directly (same for any await'd source call).
      const awaited = node.init.type === "AwaitExpression" ? node.init.argument : null;
      if (awaited && awaited.type === "CallExpression") {
        const c = memberChain(awaited.callee);
        if (c && isSourceCall(norm(c))) { sources.set(node.id.name, norm(c)); return; }
      }
      const chain = memberChain(node.init);
      if (chain && norm(chain) === DOM_COOKIE) sources.set(node.id.name, DOM_COOKIE);
      else declarators.push({ name: node.id.name, idsInInit: collectIdentifiers(node.init) });
    },
    AssignmentExpression(path) {
      const node = path.node as Extract<Node, { type: "AssignmentExpression" }>;
      if (node.operator !== "=") return;
      // Location assignments exfiltrate via the navigation URL.
      let target: string | null = null;
      if (node.left.type === "Identifier" && node.left.name === "location") target = "location =";
      else if (node.left.type === "MemberExpression" && !node.left.computed) {
        const ln = norm(memberChain(node.left) ?? "");
        if (ln === "location" || ln === "location.href") target = `${ln} =`;
      }
      if (target) sinks.push({ api: target, category: "navigation", location: locOf(node), ids: collectIdentifiers(node.right) });
    },
  });

  // Propagate source-ness through up to 3 local variable hops.
  for (let hop = 0; hop < 3; hop++) {
    for (const d of declarators) {
      if (sources.has(d.name)) continue;
      for (const id of d.idsInInit) {
        if (sources.has(id)) { sources.set(d.name, sources.get(id)!); break; }
      }
    }
  }

  const sketches: TaintSketch[] = [];
  for (const sink of sinks) {
    for (const id of sink.ids) {
      const api = sources.get(id);
      if (!api) continue;
      const kind = sourceKind(api) ?? "data";
      sketches.push({
        sink: { api: sink.api, location: sink.location },
        chain: [
          { kind: "source", api, name: id },
          { kind: "sink", api: sink.api, location: sink.location },
        ],
        classification: `${kind}-source-to-${sink.category}-sink`,
      });
      break;
    }
  }

  sketches.sort((a, b) => a.sink.location.line - b.sink.location.line);
  return sketches;
}
