import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeFiles } from "../src/pipeline/layer2-files.ts";
import { shouldSkipLayer3 } from "../src/pipeline/skip.ts";

function manifest(sample: string) {
  return JSON.parse(readFileSync(`corpus/${sample}/extension/manifest.json`, "utf8"));
}
const root = (sample: string) => `corpus/${sample}/extension`;

describe("Layer 2 — file inventory", () => {
  it("lists every file with sha256 + type; vendored jQuery has stubbed provenance", () => {
    const { files } = analyzeFiles(root("demo-cookie-manager"), manifest("demo-cookie-manager"));
    const jq = files.find((f) => f.path === "lib/jquery-3.3.1.min.js");
    expect(jq).toBeDefined();
    expect(jq!.type).toBe("javascript");
    expect(jq!.provenance).toEqual({ known: false });
    expect(jq!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(files.find((f) => f.path === "manifest.json")).toBeDefined();
  });

  it("resolves JS import edges: background.js imports are referenced, not orphaned", () => {
    const { files } = analyzeFiles(root("demo-cookie-manager"), manifest("demo-cookie-manager"));
    const cu = files.find((f) => f.path === "js/common-utils.js")!;
    expect(cu.referenced_by.some((r) => r.startsWith("import:"))).toBe(true);
    expect(cu.anomalies).not.toContain("present but unreferenced from manifest, HTML, or JS imports");
  });

  it("does NOT flag mutant C's imported _locale_pack.js as unreferenced", () => {
    const { files } = analyzeFiles(root("mutant-c-obfuscated-decoder"), manifest("mutant-c-obfuscated-decoder"));
    const pack = files.find((f) => f.path === "js/_locale_pack.js")!;
    expect(pack.referenced_by).toContain("import:js/background.js");
    expect(pack.anomalies).not.toContain("present but unreferenced from manifest, HTML, or JS imports");
  });

  it("records a manifest-referenced-but-missing file as a soft missing reference", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-"));
    mkdirSync(join(dir, "js"), { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ manifest_version: 3, name: "x", version: "1", background: { service_worker: "js/missing.js" } }),
    );
    const { missingReferences } = analyzeFiles(dir, JSON.parse(require("node:fs").readFileSync(join(dir, "manifest.json"), "utf8")));
    expect(missingReferences).toContain("js/missing.js");
  });

  it("resolves './'-prefixed manifest refs to the on-disk file (no missing ref, no orphan flag)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-"));
    mkdirSync(join(dir, "js"), { recursive: true });
    const m = { manifest_version: 3, name: "x", version: "1", background: { service_worker: "./js/bg.js" } };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    writeFileSync(join(dir, "js", "bg.js"), "export {};\n");
    const { files, missingReferences } = analyzeFiles(dir, m);
    expect(missingReferences).toEqual([]);
    const bg = files.find((f) => f.path === "js/bg.js")!;
    expect(bg.referenced_by).toContain("manifest:background.service_worker");
    expect(bg.anomalies).not.toContain("present but unreferenced from manifest, HTML, or JS imports");
  });

  it("normalizes redundant 'a/./b' segments in manifest refs", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-"));
    mkdirSync(join(dir, "js"), { recursive: true });
    const m = { manifest_version: 3, name: "x", version: "1", options_page: "js/./options.html" };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    writeFileSync(join(dir, "js", "options.html"), "<html></html>");
    const { files, missingReferences } = analyzeFiles(dir, m);
    expect(missingReferences).toEqual([]);
    expect(files.find((f) => f.path === "js/options.html")!.referenced_by).toContain("manifest:options_page");
  });

  it("does not flag web_accessible_resources glob patterns as missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-"));
    mkdirSync(join(dir, "assets"), { recursive: true });
    const m = {
      manifest_version: 3, name: "x", version: "1",
      web_accessible_resources: [{ resources: ["assets/*", "*.png"], matches: ["<all_urls>"] }],
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    const { missingReferences } = analyzeFiles(dir, m);
    expect(missingReferences).not.toContain("assets/*");
    expect(missingReferences).not.toContain("*.png");
  });

  it("flags bytes appended after a PNG's IEND marker (mutant I binary-asset abuse)", () => {
    const { files } = analyzeFiles(root("mutant-i-png-steganography"), manifest("mutant-i-png-steganography"));
    const icon = files.find((f) => f.path === "img/icon_128x128.png")!;
    expect(icon.anomalies.some((a) => /bytes appended after the image\/png end-of-image marker/.test(a))).toBe(true);
    // The file must still be a well-formed PNG by magic bytes — the whole point
    // of the technique is that it renders normally.
    expect(icon.anomalies.some((a) => a.includes("magic-byte mismatch"))).toBe(false);
  });

  it("does NOT flag clean images — no end-of-image anomaly anywhere in the base sample", () => {
    const { files } = analyzeFiles(root("demo-cookie-manager"), manifest("demo-cookie-manager"));
    const images = files.filter((f) => f.type.startsWith("image/"));
    expect(images.length).toBeGreaterThan(0);
    expect(images.flatMap((f) => f.anomalies).filter((a) => a.includes("end-of-image marker"))).toEqual([]);
  });

  it("shouldSkipLayer3 returns false for every file in v0", () => {
    const { files } = analyzeFiles(root("demo-cookie-manager"), manifest("demo-cookie-manager"));
    expect(files.every((f) => shouldSkipLayer3(f) === false)).toBe(true);
  });
});
