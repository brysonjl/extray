import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditCorpusFixtures, assertFixtureManifest, fingerprintSample, fixtureCredentialFindings } from "../src/llm/fixture-audit.ts";

describe("published LLM recordings", () => {
  it("replays and grades every current synthetic sample with only accounted-for recordings", async () => {
    const { manifest } = await auditCorpusFixtures();
    assertFixtureManifest(manifest, JSON.parse(readFileSync("corpus/fixtures/manifest.json", "utf8")));
    expect(Object.keys(manifest.samples)).toHaveLength(11);
    for (const fixture of Object.values(manifest.fixtures)) {
      expect(fixture.used_by.length).toBeGreaterThan(0);
      expect(fixture.used_by.every(sample => Object.hasOwn(manifest.samples, sample))).toBe(true);
    }
  }, 180_000);

  it("detects source bytes and newly added sidecars changing after a recording", () => {
    const corpus = mkdtempSync(join(tmpdir(), "fixture-provenance-"));
    const sample = join(corpus, "sample");
    mkdirSync(join(sample, "extension"), { recursive: true });
    const source = join(sample, "extension", "manifest.json");
    writeFileSync(source, '{"name":"Synthetic example","version":"1"}');
    try {
      const original = fingerprintSample(corpus, "sample");
      writeFileSync(source, '{"name":"Synthetic example","version":"2"}');
      expect(fingerprintSample(corpus, "sample").source_sha256).not.toBe(original.source_sha256);
      writeFileSync(join(sample, "extension.host-enrichment.json"), "{}");
      expect(fingerprintSample(corpus, "sample").inputs).not.toEqual(original.inputs);
    } finally { rmSync(corpus, { recursive: true, force: true }); }
  });

  it("flags credential literals inside source excerpts without returning their values", () => {
    const token = "A7b9C2d5".repeat(4);
    const hits = fixtureCredentialFindings(`fetch(endpoint, {headers: {apiKey:"${token}"}})`);
    expect(hits).toEqual(["credential assignment"]);
    expect(fixtureCredentialFindings(JSON.stringify({ snippet: `apiKey:"${token}"` }))).toEqual(["credential assignment"]);
    expect(JSON.stringify(hits)).not.toContain(token);
    expect(fixtureCredentialFindings(`Authorization: Bearer ${token}`)).toContain("bearer credential");
    expect(fixtureCredentialFindings('apiKey: process.env.API_KEY; Authorization: `Bearer ${token}`')).toEqual([]);
    expect(fixtureCredentialFindings(`{"key":"${"a".repeat(64)}","sha256":"${"b".repeat(64)}"}`)).toEqual([]);
  });
});
