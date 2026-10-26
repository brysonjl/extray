import { describe, it, expect } from "vitest";
import { analyze } from "../src/pipeline/index.ts";
import { analyzeCrossFile } from "../src/pipeline/layer4-crossfile.ts";
import type { ScriptEntry } from "../src/pipeline/schema.ts";

describe("Layer 4 — cross-file linkage (via full pipeline)", () => {
  it("lists cookie call sites and does NOT mark clipboardWrite unused for ExtRay Demo Cookie Manager", () => {
    const pack = analyze("corpus/demo-cookie-manager/extension");
    expect(Object.keys(pack.cross_file.permission_usage)).toContain("cookies");
    expect(pack.cross_file.permission_usage.cookies!.length).toBeGreaterThan(0);
    expect(pack.cross_file.unused_permissions).not.toContain("clipboardWrite");
  });

  it("summarizes the exfil destination for mutant A", () => {
    const pack = analyze("corpus/mutant-a-exfil-fetch/extension");
    const d = pack.cross_file.destination_summary.find((x) => x.host === "collect.evil-analytics-cdn.invalid");
    expect(d).toBeDefined();
    expect(d!.reached_via).toContain("fetch.url");
  });

  it("shows an unvalidated externally_connectable edge for mutant D", () => {
    const pack = analyze("corpus/mutant-d-wide-externally-connectable/extension");
    const edges = pack.cross_file.message_graph.edges as Array<Record<string, unknown>>;
    const ext = edges.find((e) => e.from === "external");
    expect(ext).toBeDefined();
    expect(ext!.receiver_validates_sender).toBe(false);
  });
});

describe("Layer 4 — permission classification (unit)", () => {
  const scripts: ScriptEntry[] = [
    {
      path: "js/bg.js", parsed_ok: true,
      sinks: [{ category: "cookies", api: "chrome.cookies.getAll", location: { line: 1, column: 0 }, snippet: "" }],
      network_destinations: [], taint_sketches: [], listeners: [], obfuscation: null,
    },
  ];

  it("flags a mapped permission with zero call sites as unused", () => {
    const cf = analyzeCrossFile({ permissions: ["cookies", "webRequest"] }, scripts, null);
    expect(cf.unused_permissions).toContain("webRequest");
    expect(cf.unused_permissions).not.toContain("cookies");
  });

  it("buckets a no-JS-API permission as cannot_determine_statically, not unused", () => {
    const cf = analyzeCrossFile({ permissions: ["unlimitedStorage"] }, scripts, null);
    expect(cf.cannot_determine_statically).toContain("unlimitedStorage");
    expect(cf.unused_permissions).not.toContain("unlimitedStorage");
  });

  it("dedupes a permission listed in both permissions and optional_permissions", () => {
    const cf = analyzeCrossFile({ permissions: ["cookies", "tabs"], optional_permissions: ["tabs"] }, scripts, null);
    expect(cf.unused_permissions.filter((p) => p === "tabs").length).toBe(1);
  });

  // Improvement 010 — a call-accessor sink (already normalized to chrome.* at
  // Layer 3) maps onto its permission instead of being reported unused.
  it("does not mark management/scripting/webRequest unused when used via call accessor", () => {
    const accessorScripts: ScriptEntry[] = [
      {
        path: "background.js", parsed_ok: true,
        sinks: [
          { category: "privilege", api: "chrome.management.setEnabled", location: { line: 1, column: 0 }, snippet: "" },
          { category: "privilege", api: "chrome.scripting.executeScript", location: { line: 1, column: 40 }, snippet: "" },
          { category: "privilege", api: "chrome.webRequest.onHeadersReceived", location: { line: 1, column: 80 }, snippet: "" },
        ],
        network_destinations: [], taint_sketches: [], listeners: [], obfuscation: null,
      },
    ];
    const cf = analyzeCrossFile({ permissions: ["management", "scripting", "webRequest"] }, accessorScripts, null);
    expect(cf.unused_permissions).toEqual([]);
    expect(Object.keys(cf.permission_usage)).toEqual(expect.arrayContaining(["management", "scripting", "webRequest"]));
  });

  // Improvement 007 — chrome-API matching normalizes browser.* spellings too.
  it("maps a browser.cookies.* sink onto the cookies permission", () => {
    const browserScripts: ScriptEntry[] = [
      {
        path: "js/bg.js", parsed_ok: true,
        sinks: [{ category: "cookies", api: "browser.cookies.getAll", location: { line: 3, column: 0 }, snippet: "" }],
        network_destinations: [], taint_sketches: [], listeners: [], obfuscation: null,
      },
    ];
    const cf = analyzeCrossFile({ permissions: ["cookies"] }, browserScripts, null);
    expect(cf.unused_permissions).not.toContain("cookies");
    expect(cf.permission_usage.cookies!.length).toBe(1);
  });
});

// Improvement 012 — tainted source → network sink joined to destination party.
describe("Layer 4 — data-flow party classification (012)", () => {
  const flowScript = (destValue: string, destCol: number): ScriptEntry => ({
    path: "tac/merchant.js", parsed_ok: true,
    sinks: [],
    network_destinations: [{ value: destValue, kind: "static", ast_role: "fetch.url", location: { line: 1, column: destCol } }],
    taint_sketches: [{
      sink: { api: "fetch", location: { line: 1, column: 10 } },
      chain: [{ kind: "source", api: "document.cookie", name: "c" }, { kind: "sink", api: "fetch", location: { line: 1, column: 10 } }],
      classification: "cookie-source-to-network-sink",
    }],
    listeners: [], obfuscation: null,
  });

  it("classifies cookie egress to the publisher domain as first-party-extension", () => {
    const cf = analyzeCrossFile({}, [flowScript("https://api.publisher.example/collect", 16)], { matches: ["https://publisher.example/*", "https://www.publisher.example/*"] });
    expect(cf.data_flows).toHaveLength(1);
    expect(cf.data_flows![0]).toMatchObject({ source_kind: "cookie", dest_host: "api.publisher.example", dest_party: "first-party-extension" });
  });

  it("classifies cookie egress to an unrelated host as external (not demoted, not publisher)", () => {
    const cf = analyzeCrossFile({}, [flowScript("https://secure-gateway.farfetch.com/orders", 16)], { matches: ["https://publisher.example/*"] });
    expect(cf.data_flows?.[0]?.dest_party).toBe("external");
    expect(cf.data_flows?.[0]?.dest_host).toBe("secure-gateway.farfetch.com");
  });

  it("returns unknown when no destination sits within the sink's column window (minified collision guard)", () => {
    const cf = analyzeCrossFile({}, [flowScript("https://api.publisher.example/x", 500)], { matches: ["https://publisher.example/*"] });
    expect(cf.data_flows?.[0]?.dest_party).toBe("unknown");
    expect(cf.data_flows?.[0]?.dest_host).toBeNull();
  });
});
