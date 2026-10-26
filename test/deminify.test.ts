import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deminifySource,
  isMinified,
  deminifyExtensionDir,
  isLabeledCorpusSample,
  CorpusMutationError,
} from "../src/pipeline/deminify.ts";
import { analyzeScript } from "../src/pipeline/layer3-ast/index.ts";

// A single-line "bundle" long enough to trip the minified heuristic, containing a
// dynamic-code-exec site (new Function) like a real vendored library would.
const MIN = `var g=Function("return this")();function tpl(a){${"var pad=1;".repeat(120)}return new Function("_","return _")(a)}export{tpl};`;

describe("deminify — de-minification normalization", () => {
  it("detects a minified single line and expands it to many lines", () => {
    expect(isMinified(MIN)).toBe(true);
    const { code, changed } = deminifySource(MIN);
    expect(changed).toBe(true);
    expect(code.split("\n").length).toBeGreaterThan(5);
    expect(isMinified(code)).toBe(false);
  });

  it("is semantics-preserving: same sinks extracted, but with real line numbers", () => {
    const before = analyzeScript("bundle.js", MIN);
    const after = analyzeScript("bundle.js", deminifySource(MIN).code);
    // Same set of sink APIs before and after (the round-trip changes formatting, not behavior).
    expect(after.sinks.map((s) => s.api).sort()).toEqual(before.sinks.map((s) => s.api).sort());
    // Before: every sink collapses onto line 1. After: the Function site has a real line > 1.
    const fnBefore = before.sinks.find((s) => s.api.startsWith("Function"))!;
    const fnAfter = after.sinks.find((s) => s.api.startsWith("Function"))!;
    expect(fnBefore.location.line).toBe(1);
    expect(fnAfter.location.line).toBeGreaterThan(1);
  });

  it("is idempotent — a second pass changes nothing", () => {
    const once = deminifySource(MIN).code;
    const twice = deminifySource(once);
    expect(twice.changed).toBe(false);
    expect(twice.code).toBe(once);
  });

  it("no-ops on already-readable multi-line source", () => {
    const readable = "function a() {\n  return 1;\n}\n";
    expect(isMinified(readable)).toBe(false);
    expect(deminifySource(readable).changed).toBe(false);
  });

  it("leaves unparseable source untouched (stays a genuine blind spot)", () => {
    const broken = "function ( { " + "x;".repeat(600); // long line, but does not parse
    expect(isMinified(broken)).toBe(true);
    const { code, changed } = deminifySource(broken);
    expect(changed).toBe(false);
    expect(code).toBe(broken);
  });

  it("rewrites only the minified files in an extension dir, in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "deminify-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "bundle.js"), MIN);
    const readable = "export const x = 1;\n";
    writeFileSync(join(dir, "readable.js"), readable);
    writeFileSync(join(dir, "data.json"), MIN); // non-JS: never touched

    const report = deminifyExtensionDir(dir);
    expect(report.files.map((f) => f.path)).toEqual([join("assets", "bundle.js")]);
    const only = report.files[0]!;
    expect(only.afterLines).toBeGreaterThan(only.beforeLines);

    expect(isMinified(readFileSync(join(dir, "assets", "bundle.js"), "utf8"))).toBe(false);
    expect(readFileSync(join(dir, "readable.js"), "utf8")).toBe(readable);
    expect(readFileSync(join(dir, "data.json"), "utf8")).toBe(MIN); // untouched
  });
});

// The rewrite is in place, and the corpus is committed ground truth: pointing an
// arm at corpus/<sample>/extension once silently rewrote the sample's vendored
// libs (jquery 2 lines -> 3,334), diverging it from its base and moving the very
// obfuscation metrics its labels are calibrated against.
describe("deminify — labeled-corpus guard", () => {
  const sampleLike = () => {
    const parent = mkdtempSync(join(tmpdir(), "corpusish-"));
    const ext = join(parent, "extension");
    mkdirSync(ext);
    writeFileSync(join(ext, "bundle.js"), MIN);
    writeFileSync(join(parent, "label.yaml"), "sample_id: fake\nkind: malicious\n");
    return { parent, ext };
  };

  it("detects a labeled sample by its label.yaml sibling, not by a path named corpus", () => {
    const { ext } = sampleLike();
    expect(isLabeledCorpusSample(ext)).toBe(true); // no "corpus" anywhere in the path
    expect(isLabeledCorpusSample(mkdtempSync(join(tmpdir(), "plain-")))).toBe(false);
  });

  it("refuses to rewrite a labeled sample, and leaves it byte-identical", () => {
    const { ext } = sampleLike();
    const before = readFileSync(join(ext, "bundle.js"), "utf8");
    expect(() => deminifyExtensionDir(ext)).toThrow(CorpusMutationError);
    expect(readFileSync(join(ext, "bundle.js"), "utf8")).toBe(before);
  });

  it("the real corpus is protected", () => {
    expect(isLabeledCorpusSample("corpus/mutant-i-png-steganography/extension")).toBe(true);
    expect(() => deminifyExtensionDir("corpus/mutant-i-png-steganography/extension")).toThrow(CorpusMutationError);
  });

  it("EXTRAY_ALLOW_CORPUS_DEMINIFY=1 is a deliberate override", () => {
    const { ext } = sampleLike();
    const prev = process.env.EXTRAY_ALLOW_CORPUS_DEMINIFY;
    process.env.EXTRAY_ALLOW_CORPUS_DEMINIFY = "1";
    try {
      expect(deminifyExtensionDir(ext).files.map((f) => f.path)).toEqual(["bundle.js"]);
    } finally {
      if (prev === undefined) delete process.env.EXTRAY_ALLOW_CORPUS_DEMINIFY;
      else process.env.EXTRAY_ALLOW_CORPUS_DEMINIFY = prev;
    }
  });
});
