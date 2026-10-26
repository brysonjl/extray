#!/usr/bin/env -S node --import tsx
// No dotenv/provider imports: this command is strictly offline.
import { readFileSync, writeFileSync } from "node:fs";
import { auditCorpusFixtures, assertFixtureManifest } from "../src/llm/fixture-audit.ts";

const args = process.argv.slice(2);
if (args.some(arg => arg !== "--write-manifest")) {
  console.error("usage: node --import tsx scripts/validate-llm-fixtures.ts [--write-manifest]");
  process.exit(2);
}
try {
  const { manifest, result } = await auditCorpusFixtures();
  const path = "corpus/fixtures/manifest.json";
  if (args.includes("--write-manifest")) writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  else assertFixtureManifest(manifest, JSON.parse(readFileSync(path, "utf8")));
  console.log(`LLM fixtures verified: ${Object.keys(manifest.samples).length} synthetic samples, ${Object.keys(manifest.fixtures).length} reachable recordings; full offline scorecard replay passed (${result.totals.unsafe_misses} unsafe misses).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "LLM fixture validation failed");
  process.exitCode = 1;
}
