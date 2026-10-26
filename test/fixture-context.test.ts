import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyze, HardError } from "../src/pipeline/index.ts";
import { buildIdentity } from "../src/report/build.ts";
import { renderStaticReportHtml } from "../src/report/render-static-html.ts";
import { serializePackForPrompt } from "../src/methodologies/monolith.ts";
import { strippedPack, AgenticTools } from "../src/methodologies/agentic/tools.ts";

function target() {
  const dir = join(mkdtempSync(join(tmpdir(), "fixture-context-")), "extension");
  mkdirSync(dir);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    name: "ExtRay Demo Cookie Manager", version: "1.0.0", manifest_version: 3,
  }));
  return dir;
}

describe("local fixture provenance", () => {
  it("does not infer fixture status from a manifest name", () => {
    const pack = analyze(target());
    expect(pack.fixture).toBeUndefined();
    expect(buildIdentity(pack, "a".repeat(32)).store_id).toBe("a".repeat(32));
    expect(renderStaticReportHtml(pack)).not.toContain('<aside class="fixture-notice"');
  });

  it("exports explicit context without exposing it to the investigator or linking a store identity", () => {
    const dir = target();
    writeFileSync(`${dir}.fixture.json`, JSON.stringify({ kind: "synthetic", family: "presentation-only-marker" }));
    const pack = analyze(dir);
    const identity = buildIdentity(pack, "a".repeat(32));
    expect(identity.store_id).toBeNull();
    expect(identity.fixture).toEqual({ kind: "synthetic", family: "presentation-only-marker" });
    expect(JSON.stringify(pack)).toContain("presentation-only-marker");
    const prompt = serializePackForPrompt(pack);
    expect(prompt).not.toContain("presentation-only-marker");
    expect(prompt).not.toContain('"fixture"');
    expect(JSON.stringify(strippedPack(pack))).not.toContain("presentation-only-marker");
    expect(new AgenticTools(pack, dir).readPack("fixture").ok).toBe(false);
    expect(pack.files.map((f) => f.path)).not.toContain("extension.fixture.json");
    expect(renderStaticReportHtml(pack)).toContain("Findings apply only to this fixture");
  });

  it.each(["{", '{"kind":"malicious","family":"answer"}', '{"kind":"synthetic","family":""}'])(
    "fails explicitly for malformed local context: %s", (text) => {
      const dir = target();
      writeFileSync(`${dir}.fixture.json`, text);
      expect(() => analyze(dir)).toThrow(HardError);
    },
  );
});
