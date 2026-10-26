import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createConfinedFileTools, sourceCoverage, summarizeSourceCoverage, type SourceAccess } from "../src/methodologies/pi/file-tools.ts";
import { CHUNK_BYTES, SCAN_BYTES } from "../src/methodologies/pi/source-stream.ts";

let root: string;
let reads: Set<string>;
let coverage: ReturnType<typeof sourceCoverage>;
let tools: ToolDefinition[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-large-")); reads = new Set(); coverage = sourceCoverage();
  tools = createConfinedFileTools(root, reads, coverage);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
async function call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  const result = await tools.find((t) => t.name === name)!.execute("offline", args, signal, undefined, undefined as never);
  const text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
  expect(text).not.toContain("\uFFFD");
  return { text, access: (result.details as { sourceAccess: SourceAccess }).sourceAccess };
}
function largeFile(name: string, bytes: number, chunk = "x".repeat(1024 * 1024)) {
  const fd = openSync(join(root, name), "w");
  try { for (let n = 0; n < bytes; n += chunk.length) writeSync(fd, chunk.slice(0, Math.min(chunk.length, bytes - n))); }
  finally { closeSync(fd); }
}

describe("bounded source access", () => {
  it("reads and searches a >5 MiB file near EOF, retaining accurate line/byte coordinates", async () => {
    const line = `${"x".repeat(999)}\n`;
    const pre = line.repeat(6000);
    writeFileSync(join(root, "bundle.js"), pre + "const TAIL_SINK = 'é😀';\nfinal();");
    const read = await call("read", { path: "bundle.js", offset: 6001, limit: 1 });
    expect(read.text).toContain("TAIL_SINK"); expect(read.text).not.toContain("final();");
    expect(read.access).toMatchObject({ start: { byte: pre.length, line: 6001, column: 1 }, entireFileDisplayed: false });
    const search = await call("grep", { pattern: "TAIL_[A-Z]+", path: "bundle.js" });
    expect(search.text).toContain("bundle.js:6001:const TAIL_SINK");
    expect(search.access).toMatchObject({ status: "complete", matches: 1, skippedCount: 0 });
    expect(reads).toEqual(new Set(["bundle.js"]));
  });

  it("reads late portions of a >5 MiB single line and follows byte and column continuations without gaps", async () => {
    const pre = "x".repeat(6 * 1024 * 1024 - 2) + "é😀";
    const tail = "TAIL_MINIFIED" + "y".repeat(80_000);
    writeFileSync(join(root, "min.js"), pre + tail);
    const first = await call("read", { path: "min.js", column: pre.length + 1 });
    expect(first.text.startsWith("TAIL_MINIFIED")).toBe(true);
    expect(first.access.start).toEqual({ byte: Buffer.byteLength(pre), line: 1, column: pre.length + 1 });
    expect(first.access.outputTruncated).toBe(true);
    const second = await call("read", first.access.continuation!);
    expect(second.access.start).toEqual(first.access.end);
    expect(second.access.entireFileDisplayed).toBe(false);
    expect(second.access.scannedBytes).toBeLessThan(100_000); // trusted continuation checkpoint
    const third = await call("read", { path: "min.js", byteOffset: Buffer.byteLength(pre) });
    expect(third.access.start).toEqual(first.access.start);
    const found = await call("grep", { path: "min.js", literal: true, pattern: "tail_minified", ignoreCase: true });
    expect(found.text).toContain("TAIL_MINIFIED");
    expect(found.text).toContain(`"match":{"byte":${Buffer.byteLength(pre)},"line":1,"column":${pre.length + 1}}`);
    expect(found.access).toMatchObject({ status: "complete", matches: 1, outputTruncated: true });
  });

  it("preserves UTF-8 and literal matches across IO and long-line search window boundaries", async () => {
    // UTF-8 straddles the first 16 KiB IO boundary; the needle straddles the
    // first long-line window (five IO chunks, adjusted by UTF-8 carry).
    const pre = "a".repeat(CHUNK_BYTES - 1) + "😀";
    const between = "b".repeat(5 * CHUNK_BYTES - Buffer.byteLength(pre) - 6);
    const needle = "é😀CROSS_BOUNDARY";
    const text = pre + between + needle + "z".repeat(6 * 1024 * 1024);
    writeFileSync(join(root, "boundary.js"), text);
    const matchByte = Buffer.byteLength(pre + between);
    const found = await call("grep", { path: "boundary.js", literal: true, pattern: needle });
    expect(found.text).toContain(needle);
    expect(found.text).toContain(`"match":{"byte":${matchByte},"line":1,"column":${(pre + between).length + 1}}`);
    expect(found.access.matches).toBe(1);
    const read = await call("read", { path: "boundary.js", byteOffset: CHUNK_BYTES });
    expect(read.access.start).toEqual({ byte: CHUNK_BYTES + 3, line: 1, column: CHUNK_BYTES + 2 });
    expect(read.text.startsWith("b")).toBe(true);
  });

  it("finds a boundary-crossing literal even after a wholly overlapping carry match", async () => {
    const boundary = 5 * CHUNK_BYTES;
    writeFileSync(join(root, "overlap.js"), "x".repeat(boundary - 3) + "aaaaX");
    const search = await call("grep", { path: "overlap.js", literal: true, pattern: "aaa" });
    expect(search.access.matches).toBe(2);
    expect(search.text).toContain(`"match":{"byte":${boundary - 2},"line":1,"column":${boundary - 1}}`);
  });

  it("preserves UTF-8 BOMs as source bytes, including BOMs at chunk boundaries", async () => {
    const text = "\uFEFF" + "x".repeat(CHUNK_BYTES - 3) + "\uFEFFneedle";
    writeFileSync(join(root, "bom.js"), text);
    const read = await call("read", { path: "bom.js" });
    expect(read.text).toBe(text);
    expect(read.access.end?.byte).toBe(Buffer.byteLength(text));
    const search = await call("grep", { path: "bom.js", literal: true, pattern: "needle" });
    expect(search.text).toContain(`"match":{"byte":${CHUNK_BYTES + 3},"line":1,"column":${CHUNK_BYTES}}`);
  });

  it("matches regexes across an IO boundary while keeping full-line anchor semantics", async () => {
    const pre = "x".repeat(CHUNK_BYTES - 4);
    writeFileSync(join(root, "normal.js"), pre + "café😀END\nother\n");
    const found = await call("grep", { pattern: "café😀END$", path: "normal.js" });
    expect(found.text).toContain("café😀END");
    expect(found.access).toMatchObject({ status: "complete", matches: 1 });
    expect((await call("grep", { pattern: "^café", path: "normal.js" })).access.matches).toBe(0);
  });

  it("reports skipped long regex lines and continues recursive searches into useful files", async () => {
    largeFile("a-min.js", 6 * 1024 * 1024);
    writeFileSync(join(root, "z.js"), "before\nconst Needle = 1;\nafter\n");
    const search = await call("grep", { pattern: "needle", ignoreCase: true, glob: "*.js", context: 1 });
    expect(search.text).toContain("z.js:1:before"); expect(search.text).toContain("z.js:3:after");
    expect(search.access).toMatchObject({ status: "partial", matches: 1, filesScanned: 2, skippedCount: 1 });
    expect(search.access.skipped?.[0]?.reason).toContain("use literal");
    const none = await call("grep", { pattern: "absent" });
    expect(none.text).toContain("searched portions; search incomplete");
    expect(none.text).not.toContain("No matches found.");
    const complete = await call("grep", { pattern: "absent", literal: true, glob: "*.js" });
    expect(complete.text).toContain("No matches found."); expect(complete.access.status).toBe("complete");
  });

  it("bounds output, distinguishes excerpt truncation from incomplete scan, and preserves matches", async () => {
    writeFileSync(join(root, "many.js"), (`hit ${"x".repeat(3000)}\n`).repeat(100));
    const search = await call("grep", { pattern: "hit", limit: 1000 });
    expect(search.access).toMatchObject({ status: "partial", outputTruncated: true, reason: "output limit" });
    expect(search.access.matches).toBeGreaterThan(1);
    expect(search.access.continuation?.offset).toBeGreaterThan(1);
    const limited = await call("grep", { pattern: "hit", literal: true, limit: 1, context: 1 });
    expect(limited.access).toMatchObject({ status: "partial", reason: "Match limit reached", matches: 1 });
    expect(limited.text).toContain("many.js:2:");
  });

  it("bounds scan work and can resume a read past its scan budget", async () => {
    largeFile("huge.js", SCAN_BYTES + 1024);
    const partial = await call("read", { path: "huge.js", byteOffset: SCAN_BYTES + 10 });
    expect(partial.access).toMatchObject({ status: "partial", reason: "byte limit", entireFileDisplayed: false });
    // A checkpoint is stored even while scanning to the requested position.
    const resumed = await call("read", { path: "huge.js", byteOffset: SCAN_BYTES + 10 });
    expect(resumed.access.start?.byte).toBe(SCAN_BYTES + 10);
    expect(resumed.access.scannedBytes).toBeLessThan(20_000);
    const search = await call("grep", { path: "huge.js", pattern: "ABSENT", literal: true });
    expect(search.access).toMatchObject({ status: "partial", reason: "byte limit", matches: 0 });
    expect(search.text).not.toContain("No matches found.");
  }, 15_000);

  it("isolates pathological regexes, reports timeout and supports cancellation", async () => {
    writeFileSync(join(root, "regex.js"), "a".repeat(1000) + "!");
    const start = Date.now();
    const timed = await call("grep", { path: "regex.js", pattern: "(a+)+$" });
    expect(Date.now() - start).toBeLessThan(3000);
    expect(timed.access).toMatchObject({ status: "partial", reason: "regex time limit" });
    const controller = new AbortController();
    const pending = call("grep", { path: "regex.js", pattern: "(a+)+$" }, controller.signal);
    const timer = setTimeout(() => controller.abort(), 50);
    try { expect((await pending).access.status).toBe("cancelled"); }
    finally { clearTimeout(timer); }
  });

  it.each(["read", "grep"])("reports pre-cancelled %s as cancelled, never a negative or full review", async (tool) => {
    writeFileSync(join(root, "cancel.js"), "source");
    const controller = new AbortController(); controller.abort();
    const result = await call(tool, { path: "cancel.js", pattern: "absent", literal: true }, controller.signal);
    expect(result.access.status).toBe("cancelled");
    expect(result.text).not.toContain("No matches found.");
    expect(result.access.entireFileDisplayed).not.toBe(true);
  });

  it("keeps processed search results on cancellation between files", async () => {
    writeFileSync(join(root, "a.js"), "confirmed_hit");
    largeFile("z.js", 6 * 1024 * 1024);
    const controller = new AbortController();
    const originalAdd = reads.add.bind(reads);
    reads.add = (path) => { if (path === "z.js") controller.abort(); return originalAdd(path); };
    const result = await call("grep", { pattern: "confirmed_hit", literal: true }, controller.signal);
    expect(result.access.status).toBe("cancelled");
    expect(result.access.matches).toBe(1);
    expect(result.text).toContain("a.js:1:confirmed_hit");
  });

  it("cancels a read while scanning toward a late line and retains its audit", async () => {
    largeFile("cancel.js", 8 * 1024 * 1024, "line\n".repeat(1000));
    const controller = new AbortController();
    const pending = call("read", { path: "cancel.js", offset: 1_500_000 }, controller.signal);
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      const result = await pending;
      expect(result.access.status).toBe("cancelled");
      expect(result.access.scannedBytes).toBeGreaterThan(0);
      expect(result.access.entireFileDisplayed).toBe(false);
      expect(reads.has("cancel.js")).toBe(true);
    } finally { clearTimeout(timer); }
  });

  it("reports binary and symlink skips, keeps exact filenames, and invalidates stale checkpoints", async () => {
    writeFileSync(join(root, "binary"), Buffer.from([0, 1, 2]));
    writeFileSync(join(root, "invalid-utf8"), Buffer.from([0xc3, 0x28]));
    writeFileSync(join(root, "@source.js"), "x".repeat(100_000));
    symlinkSync(join(root, "@source.js"), join(root, "link.js"));
    const first = await call("read", { path: "@source.js", byteOffset: 90_000 });
    expect(first.access.start?.column).toBe(90_001);
    writeFileSync(join(root, "@source.js"), "\n" + "y".repeat(99_999));
    const next = await call("read", { path: "@source.js", byteOffset: 90_000 });
    expect(next.access.start).toEqual({ byte: 90_000, line: 2, column: 90_000 });
    const search = await call("grep", { pattern: "absent", literal: true });
    expect(search.access).toMatchObject({ status: "partial", skippedCount: 3 });
    expect(search.access.skipped?.map((s) => s.reason).join(" ")).toMatch(/symlink.*binary|binary.*symlink/);
    await expect(call("read", { path: "link.js" })).rejects.toThrow(/denied/);
    await expect(call("read", { path: "../outside.js" })).rejects.toThrow(/denied/);
  });

  it("never marks an out-of-range empty excerpt as a whole-file display", async () => {
    writeFileSync(join(root, "short.js"), "one\ntwo");
    for (const args of [{ offset: 100 }, { byteOffset: 100 }, { offset: 1, column: 100 }]) {
      const read = await call("read", { path: "short.js", ...args });
      expect(read.access.entireFileDisplayed).toBe(false);
      expect(read.access.status).toBe("partial");
      expect(read.access.start).toBeUndefined();
    }
  });

  it("records displayed ranges separately from scan audit and bounds reviewer context", async () => {
    writeFileSync(join(root, "source.js"), "first();\nsecond();\n");
    await call("read", { path: "source.js", limit: 1 });
    await call("grep", { path: "source.js", pattern: "second" });
    expect(coverage.events[0]).toMatchObject({ entireFileDisplayed: false, start: { byte: 0 }, end: { byte: 9 } });
    expect(coverage.events[1]?.entireFileDisplayed).toBeUndefined();
    for (let i = 0; i < 260; i++) await call("read", { path: "source.js", limit: 1 });
    expect(coverage.events).toHaveLength(256); expect(coverage.droppedEvents).toBe(6);
    const summary = summarizeSourceCoverage(coverage);
    expect(Buffer.byteLength(summary)).toBeLessThan(25 * 1024);
    expect(JSON.parse(summary).omittedEvents).toBeGreaterThan(6);
  });
});
