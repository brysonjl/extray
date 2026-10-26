// Corpus analysis helper. Lives in src/ (not scripts/) so library code under
// src/ never imports upward into scripts/. The analyze-corpus CLI re-exports
// these for back-compat.

import { readdirSync, lstatSync, existsSync } from "node:fs";
import { join } from "node:path";
import { analyze, type AnalyzeOptions } from "./pipeline/index.ts";
import { validatePack, type EvidencePack } from "./pipeline/schema.ts";

export const CORPUS = "corpus";

export interface CorpusResult {
  sample: string;
  pack: EvidencePack;
  valid: boolean;
  errors: string[];
}

/** Analyze every corpus sample (excluding the `base` symlink alias). */
export function analyzeCorpus(corpusDir = CORPUS, opts: AnalyzeOptions = {}): CorpusResult[] {
  const results: CorpusResult[] = [];
  for (const name of readdirSync(corpusDir).sort()) {
    const dir = join(corpusDir, name);
    if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) continue; // skip `base` alias + files
    const extDir = join(dir, "extension");
    if (!existsSync(extDir)) continue;
    const pack = analyze(extDir, opts);
    const { valid, errors } = validatePack(pack);
    results.push({ sample: name, pack, valid, errors });
  }
  return results;
}
