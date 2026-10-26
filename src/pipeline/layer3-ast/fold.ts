// Conservative constant-folding for network destinations (Gap 7). Recovers URLs
// assembled from constants — string concatenation, atob(), String.fromCharCode,
// Array.join, and intra-file const string bindings — so a host hidden behind
// `"https://" + h` or `atob("...")` is not lost. Anything that does not fold is
// represented by a placeholder, so the caller can tell "fully resolved" from
// "partly dynamic" from "entirely unknown".
//
// Folding is purely structural over literals/constants — it NEVER executes
// source (no eval/Function). atob/fromCharCode are computed with safe built-ins.

import type { File, Node } from "@babel/types";
import { memberChain, stripGlobalReceiver, traverse } from "./util.ts";

/** Marker for a sub-expression that could not be folded (matches templateSkeleton). */
export const PLACEHOLDER = "${…}";

const MAX_DEPTH = 12;

const EMPTY_CONSTS = new Map<string, string>();

/**
 * Decoder tables for the split-array string-table obfuscation (improvement 020).
 * Recovers a host hidden behind an indexed lookup, e.g.
 *   Vb = "https:// api64 .com …".split(" ");  g = a => Vb[a];
 *   fetch(g(0) + g(1) + g(2) + "/upd2")        // → https://api64.com/upd2
 * `arrays` maps a string-array binding to its elements; `accessors` maps a
 * trivial `f(i){ return Arr[i] }` accessor to the array it indexes. Both are
 * recovered purely structurally by collectDecoders() — no source is executed.
 */
export interface DecoderTables {
  arrays: Map<string, string[]>;
  accessors: Map<string, string>;
}

/** Resolve `Arr[<int-literal>]` against a decoder table; null if not resolvable. */
function arrayIndex(
  decoders: DecoderTables | undefined,
  arrName: string | undefined,
  idxNode: Node | null | undefined,
): string | null {
  if (!decoders || !arrName || !idxNode) return null;
  const arr = decoders.arrays.get(arrName);
  const idx = numericValue(idxNode);
  if (!arr || idx === null || !Number.isInteger(idx) || idx < 0 || idx >= arr.length) return null;
  return arr[idx]!;
}

function safeAtob(s: string): string | null {
  if (!/^[A-Za-z0-9+/=\s]*$/.test(s)) return null;
  try {
    return Buffer.from(s, "base64").toString("latin1");
  } catch {
    return null;
  }
}

function numericValue(node: Node): number | null {
  if (node.type === "NumericLiteral") return node.value;
  if (node.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "NumericLiteral") {
    return -node.argument.value;
  }
  return null;
}

/**
 * Fold a node to a string skeleton: resolved parts inline, unresolvable parts as
 * PLACEHOLDER. Always returns a string. A result without PLACEHOLDER is fully
 * resolved (a concrete constant); one with PLACEHOLDER is partly dynamic.
 */
export function foldSkeleton(
  node: Node | null | undefined,
  consts: Map<string, string>,
  depth = 0,
  decoders?: DecoderTables,
): string {
  if (!node || depth > MAX_DEPTH) return PLACEHOLDER;
  switch (node.type) {
    case "StringLiteral":
      return node.value;
    case "NumericLiteral":
      return String(node.value);
    case "TemplateLiteral": {
      let out = "";
      node.quasis.forEach((q, i) => {
        out += q.value.cooked ?? q.value.raw;
        if (i < node.expressions.length) out += foldSkeleton(node.expressions[i] as Node, consts, depth + 1, decoders);
      });
      return out;
    }
    case "BinaryExpression":
      if (node.operator !== "+") return PLACEHOLDER;
      return foldSkeleton(node.left as Node, consts, depth + 1, decoders) +
        foldSkeleton(node.right, consts, depth + 1, decoders);
    case "Identifier":
      return consts.has(node.name) ? consts.get(node.name)! : PLACEHOLDER;
    case "MemberExpression": {
      // Arr[<int-literal>] — direct index into a recovered string table.
      if (node.computed && node.object.type === "Identifier") {
        const el = arrayIndex(decoders, node.object.name, node.property as Node);
        if (el !== null) return el;
      }
      return PLACEHOLDER;
    }
    case "CallExpression": {
      // [..].join(sep) — array literal joined by a (foldable) separator.
      if (
        node.callee.type === "MemberExpression" && !node.callee.computed &&
        node.callee.property.type === "Identifier" && node.callee.property.name === "join" &&
        node.callee.object.type === "ArrayExpression"
      ) {
        const sepArg = node.arguments[0] as Node | undefined;
        const sep = sepArg ? foldSkeleton(sepArg, consts, depth + 1, decoders) : ",";
        return node.callee.object.elements
          .map((el) => (el ? foldSkeleton(el as Node, consts, depth + 1, decoders) : ""))
          .join(sep);
      }
      // Accessor call g(<int-literal>) where g(i){ return Arr[i] } (improvement 020).
      if (node.callee.type === "Identifier" && node.arguments.length === 1) {
        const el = arrayIndex(decoders, decoders?.accessors.get(node.callee.name), node.arguments[0] as Node);
        if (el !== null) return el;
      }
      const chain = stripGlobalReceiver(memberChain(node.callee) ?? "");
      if (chain === "atob") {
        const inner = foldSkeleton(node.arguments[0] as Node, consts, depth + 1, decoders);
        if (inner.includes(PLACEHOLDER)) return PLACEHOLDER;
        const decoded = safeAtob(inner);
        return decoded ?? PLACEHOLDER;
      }
      if (chain === "String.fromCharCode") {
        const codes = node.arguments.map((a) => numericValue(a as Node));
        if (codes.some((c) => c === null)) return PLACEHOLDER;
        return String.fromCharCode(...(codes as number[]));
      }
      return PLACEHOLDER;
    }
    default:
      return PLACEHOLDER;
  }
}

/** True if a folded skeleton is a concrete constant (no unresolved parts). */
export function isFullyResolved(skeleton: string): boolean {
  return !skeleton.includes(PLACEHOLDER);
}

/** Recover a constant string array from `["a","b",…]` or `"a b c".split(sep)`. */
function stringArrayFrom(node: Node): string[] | null {
  if (node.type === "ArrayExpression") {
    const out: string[] = [];
    for (const el of node.elements) {
      if (!el || el.type !== "StringLiteral") return null;
      out.push(el.value);
    }
    return out.length ? out : null;
  }
  if (
    node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" && !node.callee.computed &&
    node.callee.property.type === "Identifier" && node.callee.property.name === "split"
  ) {
    // Receiver and separator must fold to concrete strings (literal in practice).
    const recv = foldSkeleton(node.callee.object as Node, EMPTY_CONSTS);
    if (!isFullyResolved(recv)) return null;
    const sepArg = node.arguments[0] as Node | undefined;
    const sep = sepArg ? foldSkeleton(sepArg, EMPTY_CONSTS) : ",";
    if (!isFullyResolved(sep)) return null;
    return recv.split(sep);
  }
  return null;
}

/** For a trivial accessor `function(i){ return Arr[i] }` / `i => Arr[i]`, return
 *  the indexed array's name; null for anything more complex. */
function accessorArrayName(fn: Node): string | null {
  if (fn.type !== "FunctionExpression" && fn.type !== "ArrowFunctionExpression" && fn.type !== "FunctionDeclaration") {
    return null;
  }
  if (fn.params.length !== 1 || fn.params[0]!.type !== "Identifier") return null;
  const param = fn.params[0]!.name;
  let ret: Node | null | undefined;
  if (fn.body.type === "BlockStatement") {
    if (fn.body.body.length !== 1 || fn.body.body[0]!.type !== "ReturnStatement") return null;
    ret = fn.body.body[0]!.argument;
  } else {
    ret = fn.body; // arrow expression body
  }
  if (!ret || ret.type !== "MemberExpression" || !ret.computed) return null;
  if (ret.object.type !== "Identifier") return null;
  if (ret.property.type !== "Identifier" || ret.property.name !== param) return null;
  return ret.object.name;
}

/**
 * Recover split-array string tables and their accessor functions (improvement
 * 020), so a host assembled by `g(9)+g(11)+g(0)` folds instead of collapsing to
 * a placeholder. Structural only — never executes source. Intra-file and
 * scope-insensitive, matching collectConstStrings.
 */
export function collectDecoders(ast: File): DecoderTables {
  const arrays = new Map<string, string[]>();
  const fnDecls: Array<{ name: string; fn: Node }> = [];
  traverse(ast, {
    VariableDeclarator(path) {
      const node = path.node as Extract<Node, { type: "VariableDeclarator" }>;
      if (node.id.type !== "Identifier" || !node.init) return;
      const arr = stringArrayFrom(node.init);
      if (arr) {
        arrays.set(node.id.name, arr);
      } else if (node.init.type === "FunctionExpression" || node.init.type === "ArrowFunctionExpression") {
        fnDecls.push({ name: node.id.name, fn: node.init });
      }
    },
    FunctionDeclaration(path) {
      const node = path.node as Extract<Node, { type: "FunctionDeclaration" }>;
      if (node.id) fnDecls.push({ name: node.id.name, fn: node });
    },
  });
  const accessors = new Map<string, string>();
  for (const { name, fn } of fnDecls) {
    const arrName = accessorArrayName(fn);
    if (arrName && arrays.has(arrName)) accessors.set(name, arrName);
  }
  return { arrays, accessors };
}

/**
 * Collect intra-file `NAME = <string-ish>` bindings, mapping each to its folded
 * value (or skeleton). Two fully-resolved passes first so static chains
 * (`const b = a + "/x"`) resolve across declaration order; then one skeleton
 * pass records partly-dynamic bindings (`const u = `…${x}…``) so a later
 * `fetch(u)` resolves to a template rather than a false "unknown". Intra-file
 * and scope-insensitive by design.
 */
export function collectConstStrings(ast: File, decoders?: DecoderTables): Map<string, string> {
  const consts = new Map<string, string>();
  const decls: Array<{ name: string; init: Node }> = [];
  traverse(ast, {
    VariableDeclarator(path) {
      const node = path.node as Extract<Node, { type: "VariableDeclarator" }>;
      if (node.id.type === "Identifier" && node.init) decls.push({ name: node.id.name, init: node.init });
    },
  });
  for (let pass = 0; pass < 2; pass++) {
    for (const { name, init } of decls) {
      if (consts.has(name)) continue;
      const folded = foldSkeleton(init, consts, 0, decoders);
      if (isFullyResolved(folded)) consts.set(name, folded);
    }
  }
  // Skeleton pass: record what is left, placeholders and all.
  for (const { name, init } of decls) {
    if (!consts.has(name)) consts.set(name, foldSkeleton(init, consts, 0, decoders));
  }
  return consts;
}
