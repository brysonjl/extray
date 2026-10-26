import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../src/pipeline/index.ts";
import { analyzeResources } from "../src/pipeline/layer5-resources.ts";

describe("Layer 5 — resources + summary_signals (via pipeline)", () => {
  it("inventories HTML and locale message counts for ExtRay Demo Cookie Manager", () => {
    const pack = analyze("corpus/demo-cookie-manager/extension");
    expect(pack.resources.html.length).toBeGreaterThan(0);
    const locales = pack.resources.locales;
    expect(Object.keys(locales).length).toBeGreaterThan(0);
    const someLocale = Object.values(locales)[0];
    expect(someLocale!.message_count).toBeGreaterThan(0);
  });

  it("rolls up the cookies+broad-host dangerous combination into summary_signals.high", () => {
    const pack = analyze("corpus/demo-cookie-manager/extension");
    const hit = (pack.summary_signals.high as Array<Record<string, unknown>>).find(
      (s) => s.kind === "dangerous-combination" && s.detail === "cookies+broad-host",
    );
    expect(hit).toBeDefined();
  });
});

describe("Layer 5 — declarative remote refs (Gap 8)", () => {
  it("captures remote refs across img/srcset/link/meta/form/a-ping/video/object, excluding local", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-"));
    const htmlFile = (name: string, body: string) =>
      writeFileSync(join(dir, name), `<html><head>${body}</head></html>`);
    htmlFile(
      "page.html",
      [
        '<img src="https://cdn.test/p.png">',
        '<img srcset="https://cdn.test/a.png 1x, /local/b.png 2x">',
        '<link rel="preconnect" href="https://track.test">',
        '<link rel="stylesheet" href="local.css">',
        '<meta http-equiv="refresh" content="0; url=https://evil.test/go">',
        '<form action="https://forms.test/submit"></form>',
        '<a ping="https://ping.test/x https://ping.test/y">k</a>',
        '<video src="https://media.test/v.mp4"></video>',
        '<object data="https://obj.test/o.swf"></object>',
      ].join(""),
    );
    const { resources } = analyzeResources(
      dir,
      [{ path: "page.html", size_bytes: 1, sha256: "x", type: "html", referenced_by: [], provenance: { known: false }, anomalies: [] }],
      {},
    );
    const refs = (resources.html[0] as Record<string, unknown>).remote_refs as Array<{ kind: string; url: string }>;
    const kinds = refs.map((r) => r.kind);
    const urls = refs.map((r) => r.url);

    expect(kinds).toEqual(expect.arrayContaining([
      "img.src", "img.srcset", "link.preconnect", "meta.refresh",
      "form.action", "a.ping", "video.src", "object.data",
    ]));
    // Two distinct ping URLs captured.
    expect(refs.filter((r) => r.kind === "a.ping").length).toBe(2);
    // Local/relative refs are excluded.
    expect(urls.some((u) => u.includes("/local/"))).toBe(false);
    expect(urls.some((u) => u === "local.css")).toBe(false);
    expect(urls).toContain("https://evil.test/go");
  });
});

describe("Layer 5 — inline script extraction (unit)", () => {
  it("extracts and reports inline <script> blocks from HTML", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "page.html"), "<html><script>console.log('hi'); fetch('https://x.test/y')</script></html>");
    const { resources, inlineScripts } = analyzeResources(
      dir,
      [{ path: "page.html", size_bytes: 1, sha256: "x", type: "html", referenced_by: [], provenance: { known: false }, anomalies: [] }],
      {},
    );
    expect((resources.html[0] as Record<string, unknown>).inline_scripts).toBe(1);
    expect(inlineScripts.length).toBe(1);
    expect(inlineScripts[0]!.path).toContain("#inline-1");
  });

  it("skips non-JS <script type> blocks (JSON/template) but keeps JS-typed and untyped ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "ext-"));
    writeFileSync(
      join(dir, "page.html"),
      [
        '<html><script type="application/json">{"config": true}</script>',
        '<script type="text/template"><div>{{x}}</div></script>',
        '<script type="module">import("./m.js")</script>',
        '<script type="text/javascript">doWork()</script>',
        "<script>plain()</script></html>",
      ].join(""),
    );
    const { resources, inlineScripts } = analyzeResources(
      dir,
      [{ path: "page.html", size_bytes: 1, sha256: "x", type: "html", referenced_by: [], provenance: { known: false }, anomalies: [] }],
      {},
    );
    // Only the module, text/javascript, and untyped blocks count as scripts.
    expect((resources.html[0] as Record<string, unknown>).inline_scripts).toBe(3);
    expect(inlineScripts.map((s) => s.source)).toEqual(['import("./m.js")', "doWork()", "plain()"]);
    expect(inlineScripts.every((s) => !s.source.includes('"config"'))).toBe(true);
  });
});
