// Listener registrations: addEventListener, chrome.*.addListener, onMessage*.
// Records event kind, location, and a sender/origin-validation heuristic.

import type { File, Node } from "@babel/types";
import type { Listener } from "../schema.ts";
import { memberChain, locOf, snippetFor, firstStringArg, functionArg, traverse, normalizeChain, collectAliases } from "./util.ts";

const VALIDATES = /\bsender\s*\.\s*(id|origin|tab|url)\b|\bevent\s*\.\s*origin\b|\borigin\s*===|\bsender\s*===/;

export function extractListeners(ast: File, source: string): Listener[] {
  const listeners: Listener[] = [];
  const aliases = collectAliases(ast);

  traverse(ast, {
    CallExpression(path) {
      const node = path.node as Extract<Node, { type: "CallExpression" }>;
      const raw = memberChain(node.callee);
      if (!raw) return;
      // Normalized so window.addEventListener / browser.runtime.onMessage /
      // aliased registrations all record under their canonical kind.
      const chain = normalizeChain(raw, aliases);

      let kind: string | null = null;
      if (chain === "addEventListener" || chain.endsWith(".addEventListener")) {
        const evt = firstStringArg(node.arguments as Node[]);
        kind = `addEventListener(${evt ?? "?"})`;
      } else if (chain.endsWith(".addListener")) {
        kind = chain.replace(/\.addListener$/, "");
      }
      if (!kind) return;

      const handler = functionArg(node.arguments as Node[]);
      const handlerSrc = handler ? snippetFor(handler, source, 600) : "";
      const validates = VALIDATES.test(handlerSrc);

      listeners.push({ kind, location: locOf(node), validates_sender: validates, snippet: snippetFor(node, source) });
    },
  });

  listeners.sort((a, b) => a.location.line - b.location.line);
  return listeners;
}
