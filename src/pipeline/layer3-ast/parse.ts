// Babel parse wrapper. errorRecovery + a broad plugin set so partially-obfuscated
// or modern source still yields a usable AST. sourceType 'unambiguous' so both
// MV3 ES-module service workers and classic scripts parse.

import { parse, type ParserPlugin } from "@babel/parser";
import type { File } from "@babel/types";

const PLUGINS: ParserPlugin[] = [
  "jsx",
  "classProperties",
  "classPrivateProperties",
  "classPrivateMethods",
  "optionalChaining",
  "nullishCoalescingOperator",
  "dynamicImport",
  "topLevelAwait",
  "importMeta",
  ["decorators", { decoratorsBeforeExport: true }],
];

export interface ParseResult {
  ast: File | null;
  /** True when the source parsed with zero syntax errors (errorRecovery off-path). */
  parsedOk: boolean;
}

export function parseModule(source: string): ParseResult {
  try {
    const ast = parse(source, {
      sourceType: "unambiguous",
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      plugins: PLUGINS,
    });
    return { ast, parsedOk: (ast.errors?.length ?? 0) === 0 };
  } catch {
    return { ast: null, parsedOk: false };
  }
}
