// Runs the static pipeline over every corpus sample and writes a real
// evidence-pack.json per sample. These packs supersede the hand-authored
// fixtures (idea #6) and feed the bake-off (#2) / scorecard (#4).
//
//   npx tsx scripts/analyze-corpus.ts
//
// The analyzeCorpus helper now lives in src/corpus.ts (so library code under
// src/ never imports upward into scripts/); it is re-exported here for
// back-compat with existing test imports.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { analyzeCorpus, CORPUS, type CorpusResult } from "../src/corpus.ts";

export { analyzeCorpus, CORPUS, type CorpusResult };

function main(): void {
  const results = analyzeCorpus();
  for (const r of results) {
    const out = join(CORPUS, r.sample, "evidence-pack.json");
    writeFileSync(out, JSON.stringify(r.pack, null, 2) + "\n");
    const verdict = r.valid ? "ok" : `INVALID (${r.errors.length})`;
    process.stdout.write(`${r.sample.padEnd(38)} ${verdict}  (${r.pack.scripts.length} scripts, ${r.pack.files.length} files)\n`);
  }
  const bad = results.filter((r) => !r.valid);
  if (bad.length) { process.stderr.write(`\n${bad.length} sample(s) produced invalid packs\n`); process.exit(1); }
  process.stdout.write(`\n${results.length} evidence packs written.\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
