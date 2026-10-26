// De-minification normalization pass. Runs BEFORE any analysis, rewriting
// minified/bundled JS in place so it has real line breaks.
//
// Why this exists: Vite/Rollup emit vendored libraries (pdf.js, Bluebird,
// lodash, …) as a single 1MB+ line under assets/ with a hashed name. That single
// line defeats line/column-addressable analysis: every sink lands at
// `{line:1, column:<huge>}`, source snippets are the whole file, and the LLM
// verifier — handed a file it cannot navigate by line — rationalizes it as an
// "unauditable blind spot" instead of reading it. Beautifying restores real line
// numbers so the pack AND the verifier's own file reads agree, and a `Function()`
// site in a bundled library can be read in context and cleared (as it already is
// for the multi-line pdf.worker).
//
// Scope: de-minification only. This is a lossless AST round-trip (Babel parses,
// never executes) and is semantics-preserving. It deliberately does NOT reverse
// adversarial obfuscation (string-array decoders, packers): that is signal the
// obfuscation detector is meant to KEEP, and reliable reversal would mean running
// untrusted code — which an analyzer must never do. A minified vendor bundle stops
// being flagged as "obfuscated" purely as a side effect (the only heuristic it
// tripped was the long-line one); a genuinely obfuscated file still flags.

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import type { File } from "@babel/types";
import { parseModule } from "./layer3-ast/parse.ts";
import { OBFUSCATION_THRESHOLDS as T } from "./config.ts";

// @babel/generator is CJS with a default export and ships no bundled types; load
// via require so tsc/runtime agree on the callable (same pattern as traverse in
// layer3-ast/util.ts). We only use the two options we need.
const require = createRequire(import.meta.url);
const generateMod = require("@babel/generator");
type GenerateOpts = { compact?: boolean; concise?: boolean; comments?: boolean; retainLines?: boolean };
const generate = (generateMod.default ?? generateMod) as (ast: File, opts?: GenerateOpts) => { code: string };

// Files this large are not round-tripped — the memory/time cost is not worth it
// and such a file is better left as an explicit unparsed/opaque blind spot than
// silently skipped. (The 1.8MB Meomni bundle round-trips in ~300ms; this is a
// backstop against pathological inputs, not a normal-case limit.)
const MAX_DEMINIFY_BYTES = 8_000_000;

const JS_EXT = /\.(?:js|mjs|cjs)$/i;

/** A source is "minified" when its longest line crosses the same threshold the
 *  obfuscation detector uses to flag single-line bundles. Cheap string scan — no
 *  parse — so re-running over already-beautified trees stays fast (idempotent). */
export function isMinified(source: string): boolean {
  let max = 0;
  let start = 0;
  for (let i = 0; i <= source.length; i++) {
    if (i === source.length || source.charCodeAt(i) === 10 /* \n */) {
      if (i - start > max) max = i - start;
      start = i + 1;
    }
  }
  return max >= T.maxLine;
}

export interface DeminifyResult {
  code: string;
  changed: boolean;
}

/** Beautify one source string. No-op (returns the input unchanged) when the file
 *  is not minified, is too large, or does not parse cleanly. The `parsedOk` guard
 *  is essential: `parseModule` uses errorRecovery, and generating from a partial
 *  AST would silently DROP the un-recovered regions — so a file with any parse
 *  error is left exactly as-is (it remains a genuine blind spot, which is correct). */
export function deminifySource(source: string): DeminifyResult {
  if (source.length > MAX_DEMINIFY_BYTES || !isMinified(source)) {
    return { code: source, changed: false };
  }
  const { ast, parsedOk } = parseModule(source);
  if (!ast || !parsedOk) return { code: source, changed: false };
  try {
    const { code } = generate(ast, { compact: false, concise: false, comments: true, retainLines: false });
    return { code, changed: code !== source };
  } catch {
    return { code: source, changed: false };
  }
}

export interface DeminifiedFile {
  path: string;
  beforeLines: number;
  afterLines: number;
}

export interface DeminifyReport {
  files: DeminifiedFile[];
}

function walkJs(root: string): string[] {
  const out: string[] = [];
  const recurse = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) recurse(abs);
      else if (entry.isFile() && JS_EXT.test(entry.name)) out.push(abs);
    }
  };
  recurse(root);
  return out;
}

/** A labeled corpus sample is exactly a directory whose PARENT holds a
 *  `label.yaml` answer key (see corpus/grading-ground-truth.md). Detecting the
 *  marker rather than matching a path called "corpus" means a checkout, copy,
 *  or worktree at any location is recognised the same way. */
export function isLabeledCorpusSample(root: string): boolean {
  return existsSync(join(dirname(resolve(root)), "label.yaml"));
}

export class CorpusMutationError extends Error {}

/** De-minify every minified JS file under an unpacked extension dir, in place.
 *  Idempotent: already-beautified files are skipped by the cheap `isMinified`
 *  scan, so re-running is safe. Returns which files were rewritten.
 *
 *  REFUSES to run against a labeled corpus sample. The rewrite is in place and
 *  the corpus is committed ground truth, so pointing an arm at
 *  `corpus/<sample>/extension` silently rewrites the sample: it diverges from
 *  its base, every file hash and size changes, and the obfuscation metrics the
 *  labels are calibrated against move underneath them. That happened once
 *  (mutant-i's vendored jquery went 2 lines -> 3,334 and had to be restored
 *  from the base by sha256), and it was caught only by eyeballing a commit's
 *  file list, which is not a control. Set EXTRAY_ALLOW_CORPUS_DEMINIFY=1 to
 *  override deliberately; the honest fix is to analyze a copy. */
export function deminifyExtensionDir(root: string): DeminifyReport {
  if (isLabeledCorpusSample(root) && process.env.EXTRAY_ALLOW_CORPUS_DEMINIFY !== "1") {
    throw new CorpusMutationError(
      `refusing to de-minify in place inside a labeled corpus sample: ${root}\n` +
        `  The corpus is committed ground truth and this pass rewrites files in place.\n` +
        `  Copy it first, then analyze the copy:\n` +
        `    cp -R ${root} /tmp/sample && npm run assess -- --dir /tmp/sample ...\n` +
        `  Or set EXTRAY_ALLOW_CORPUS_DEMINIFY=1 if you really intend to rewrite the sample.`,
    );
  }
  const files: DeminifiedFile[] = [];
  for (const abs of walkJs(root)) {
    const source = readFileSync(abs, "utf8");
    const { code, changed } = deminifySource(source);
    if (!changed) continue;
    writeFileSync(abs, code);
    files.push({
      path: abs.slice(root.length + 1),
      beforeLines: source.split("\n").length,
      afterLines: code.split("\n").length,
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files };
}
