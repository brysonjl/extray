import { describe, it, expect } from "vitest";
import { analyzeCorpus } from "../scripts/analyze-corpus.ts";
import type { EvidencePack } from "../src/pipeline/schema.ts";

const results = analyzeCorpus("corpus", { analyzedAt: "2026-01-01T00:00:00Z" });
const bySample = new Map(results.map((r) => [r.sample, r.pack]));
const pack = (s: string): EvidencePack => bySample.get(s)!;

const hosts = (p: EvidencePack) => p.cross_file.destination_summary.map((d) => d.host);
const allSinkApis = (p: EvidencePack) => p.scripts.flatMap((s) => s.sinks.map((x) => x.api));

describe("corpus run", () => {
  it("emits a schema-valid pack for all 11 samples (base symlink excluded)", () => {
    expect(results.length).toBe(11);
    expect(results.every((r) => r.valid)).toBe(true);
    expect(results.map((r) => r.sample)).not.toContain("base");
  });

  it("every pack carries a self-reported developer section with explicit placeholders", () => {
    for (const r of results) {
      expect(r.pack.developer.provenance, r.sample).toBe("self_reported");
      // Store-listing fields are explicit nulls until 008b lands.
      expect(r.pack.developer.address, r.sample).toBeNull();
      expect(r.pack.developer.country, r.sample).toBeNull();
    }
  });

  it("uses the same fictional identity for the control and all mutations", () => {
    for (const { pack, sample } of results) {
      expect(pack.extension.manifest.name, sample).toBe("ExtRay Demo Cookie Manager");
      expect(pack.extension.manifest.version, sample).toBe("1.0.0");
      expect(pack.fixture, sample).toEqual({ kind: "synthetic", family: "ExtRay Demo Cookie Manager" });
    }
  });
});

describe("ExtRay Demo Cookie Manager acceptance criteria (v0 brief)", () => {
  const p = pack("demo-cookie-manager");
  it("flags the cookies + broad-host combination", () => {
    expect(p.manifest_analysis.dangerous_combinations.map((c) => c.kind)).toContain("cookies+broad-host");
  });
  it("lists every chrome.cookies.* call site under permission_usage.cookies", () => {
    expect(p.cross_file.permission_usage.cookies!.length).toBeGreaterThan(0);
    expect(p.cross_file.permission_usage.cookies!.every((s) => s.api.startsWith("chrome.cookies.") || s.api === "document.cookie")).toBe(true);
  });
  it("does not falsely report used permissions as unused", () => {
    expect(p.cross_file.unused_permissions).not.toContain("clipboardWrite");
    expect(p.cross_file.unused_permissions).not.toContain("tabs");
    expect(p.cross_file.unused_permissions).not.toContain("cookies");
  });
});

describe("per-mutant static signals", () => {
  it("A: exfil destination present", () => {
    expect(hosts(pack("mutant-a-exfil-fetch"))).toContain("collect.evil-analytics-cdn.invalid");
  });
  it("B: tampered jQuery diverges from base and its injected sink is visible", () => {
    const base = pack("demo-cookie-manager").files.find((f) => f.path === "lib/jquery-3.3.1.min.js")!;
    const tampered = pack("mutant-b-tampered-lib").files.find((f) => f.path === "lib/jquery-3.3.1.min.js")!;
    expect(tampered.sha256).not.toBe(base.sha256);
    expect(hosts(pack("mutant-b-tampered-lib"))).toContain("cdn-jq-telemetry.invalid");
  });
  it("C: obfuscated decoder is flagged", () => {
    const c = pack("mutant-c-obfuscated-decoder").scripts.find((s) => s.path === "js/_locale_pack.js")!;
    expect(c.obfuscation!.flagged).toBe(true);
  });
  it("D: widened external surface + unvalidated edge", () => {
    const p = pack("mutant-d-wide-externally-connectable");
    expect(p.manifest_analysis.externally_connectable?.wildcards).toBe(true);
    const edges = p.cross_file.message_graph.edges as Array<Record<string, unknown>>;
    expect(edges.some((e) => e.from === "external" && e.receiver_validates_sender === false)).toBe(true);
  });
  it("E: cross-file sinks present but NOT linked in a single file (blind spot)", () => {
    const p = pack("mutant-e-crossfile-flow");
    const bg = p.scripts.find((s) => s.path === "js/background.js")!;
    const cu = p.scripts.find((s) => s.path === "js/common-utils.js")!;
    // background reads cookies (via the imported storage helper, not chrome.storage directly);
    // common-utils holds both the chrome.storage write/read and the network sink.
    expect(bg.sinks.some((x) => x.category === "cookies")).toBe(true);
    expect(cu.sinks.some((x) => x.category === "storage")).toBe(true);
    expect(cu.sinks.some((x) => x.category === "network")).toBe(true);
    // The blind spot: no single file links a cookie source to a network sink.
    expect(p.scripts.some((s) => s.taint_sketches.some((t) => /cookie-source-to-network/.test(t.classification)))).toBe(false);
  });
  it("F: stacked A+C+D signals all present", () => {
    const p = pack("mutant-f-stacked-acd");
    expect(hosts(p)).toContain("collect.evil-analytics-cdn.invalid");
    expect(p.scripts.some((s) => s.obfuscation?.flagged && s.path === "js/_locale_pack.js")).toBe(true);
    expect(p.manifest_analysis.externally_connectable?.wildcards).toBe(true);
  });
  it("G: stacked B+E signals present", () => {
    const p = pack("mutant-g-stacked-be");
    const base = pack("demo-cookie-manager").files.find((f) => f.path === "lib/jquery-3.3.1.min.js")!;
    const tampered = p.files.find((f) => f.path === "lib/jquery-3.3.1.min.js")!;
    expect(tampered.sha256).not.toBe(base.sha256);
    expect(p.scripts.find((s) => s.path === "js/common-utils.js")!.sinks.some((x) => x.category === "network")).toBe(true);
  });
  it("H: out-of-taxonomy clipboard + contextMenus channel present", () => {
    const apis = allSinkApis(pack("mutant-h-curveball-clipboard"));
    expect(apis).toContain("navigator.clipboard.writeText");
    expect(apis).toContain("chrome.contextMenus.create");
  });
});
