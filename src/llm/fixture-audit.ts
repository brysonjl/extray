// Publication checks for the one supported offline corpus baseline. This module
// never constructs a provider: a missing completion is always a hard failure.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { LlmClient } from "./client.ts";
import { fixtureFileName, readFixtureFile, RecordReplayClient, stableStringify } from "./record-replay.ts";
import { createMonolith } from "../methodologies/monolith.ts";
import { CORPUS_INGEST_ARM } from "../product/corpus-ingest.ts";
import { loadCorpusLabels } from "../scorecard/labels.ts";
import { runScorecard } from "../scorecard/index.ts";
import { listingCandidatePaths } from "../listing/types.ts";
import { enrichmentCandidatePaths } from "../enrichment/types.ts";

export const FIXTURE_BASELINE = { ...CORPUS_INGEST_ARM, judgeModel: "minimax-m3.1-flash:cloud", runs: 1 } as const;
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Report rule names only; never echo a possible credential into CI output.
 * This supplements the repository secret scanner and request hashes: quoted
 * third-party source can contain credentials even when a fixture hash is valid. */
export function fixtureCredentialFindings(text: string): string[] {
  const rules: [string, RegExp][] = [
    ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
    ["provider token", /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{20,}|AKIA[A-Z0-9]{16})\b/],
    ["credential assignment", /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|secret[_-]?key|password)["'\\\s]*[:=]["'\\\s]*[A-Za-z0-9_+\/=.-]{20,}/i],
    ["bearer credential", /\bBearer\s+[A-Za-z0-9._~+\/=-]{24,}/i],
    ["signed token", /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/],
    ["URL credentials", /https?:\/\/[^/\s:@]+:[^/\s@]{5,}@/i],
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function filesIn(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`fixture source must not contain symlinks: ${relative(root, path)}`);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`fixture source contains a non-file: ${relative(root, path)}`);
    }
  };
  visit(root);
  return files.sort();
}

export function fingerprintSample(corpusDir: string, sample: string) {
  const sampleDir = join(corpusDir, sample);
  const sourceDir = join(sampleDir, "extension");
  const sources = filesIn(sourceDir).map(path => [relative(sourceDir, path).replaceAll("\\", "/"), sha256(readFileSync(path))]);
  // Include all candidates, including null for absent sidecars: adding one can
  // change a prompt/report just as surely as modifying an existing artifact.
  const paths = [join(sampleDir, "label.yaml"), `${sourceDir}.fixture.json`,
    ...listingCandidatePaths(sourceDir), ...enrichmentCandidatePaths(sourceDir)];
  const inputs = Object.fromEntries([...new Set(paths)].sort().map(path => [
    relative(sampleDir, path).replaceAll("\\", "/"),
    existsSync(path) ? sha256(readFileSync(path)) : null,
  ]));
  return { source_sha256: sha256(stableStringify(sources)), source_file_count: sources.length, inputs };
}

export interface FixtureManifest {
  schema_version: 1;
  baseline: typeof FIXTURE_BASELINE;
  recording_receipts_sha256: string;
  samples: Record<string, ReturnType<typeof fingerprintSample>>;
  fixtures: Record<string, { sha256: string; request_sha256: string; label: string; model: string; used_by: string[] }>;
}

/** Derive a manifest from real REPLAY requests; unreferenced recordings fail.
 * No name/ID heuristics can establish that data is synthetic. Instead every
 * published completion must be reached from current labeled synthetic source. */
export async function auditCorpusFixtures(corpusDir = "corpus", fixtureDir = join(corpusDir, "fixtures/llm")) {
  const labels = loadCorpusLabels(corpusDir);
  const names = readdirSync(fixtureDir).sort();
  const files = new Map<string, ReturnType<typeof readFixtureFile>>();
  for (const name of names) {
    const path = join(fixtureDir, name);
    if (!name.endsWith(".json") || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      throw new Error(`unexpected entry in LLM fixture directory: ${name}`);
    }
    const fixture = readFixtureFile(path);
    const alerts = fixtureCredentialFindings(`${fixture.request.prompt}\n${fixture.response.text}`);
    if (alerts.length) throw new Error(`possible credential in ${name}: ${alerts.join(", ")}`);
    files.set(name, fixture);
  }

  // New capture receipts are unsigned audit metadata, not proof of origin.
  // They must nevertheless agree exactly with the unchanged saved responses.
  const receiptBytes = readFileSync(join(dirname(fixtureDir), "recording-receipts.json"));
  const receipts: unknown = JSON.parse(receiptBytes.toString("utf8"));
  if (!Array.isArray(receipts)) throw new Error("invalid LLM recording receipts");
  const receipted = new Set<string>();
  for (const receipt of receipts) {
    if (!receipt || typeof receipt !== "object" || typeof receipt.filename !== "string" ||
        typeof receipt.recordedAt !== "string" || !Number.isFinite(Date.parse(receipt.recordedAt)) ||
        typeof receipt.provider !== "string" || typeof receipt.endpoint !== "string" ||
        !Number.isSafeInteger(receipt.outputReserve) || receipt.outputReserve <= 0 ||
        !Number.isSafeInteger(receipt.retries) || receipt.retries < 0) throw new Error("invalid LLM recording receipt shape");
    const fixture = files.get(receipt.filename);
    if (!fixture || receipted.has(receipt.filename) || receipt.recorded !== true ||
        receipt.model !== fixture.model || receipt.requestSha256 !== fixture.key ||
        receipt.fixtureSha256 !== sha256(readFileSync(join(fixtureDir, receipt.filename))) ||
        stableStringify(receipt.usage) !== stableStringify(fixture.response.usage)) {
      throw new Error(`recording receipt does not match saved completion: ${receipt.filename}`);
    }
    if (fixtureCredentialFindings(JSON.stringify(receipt)).length) throw new Error(`possible credential in recording receipt: ${receipt.filename}`);
    receipted.add(receipt.filename);
  }
  for (const [name, fixture] of files) {
    if (fixture.label.startsWith("judge:") && !receipted.has(name)) throw new Error(`judge recording has no capture receipt: ${name}`);
  }

  const samples: FixtureManifest["samples"] = {};
  for (const sample of labels.keys()) {
    const context = JSON.parse(readFileSync(join(corpusDir, sample, "extension.fixture.json"), "utf8")) as { kind?: string };
    if (context.kind !== "synthetic") throw new Error(`sample ${sample} is not explicitly synthetic`);
    samples[sample] = fingerprintSample(corpusDir, sample);
  }
  const used = new Map<string, Set<string>>();
  let currentSample = "";
  const replay = new RecordReplayClient({ mode: "REPLAY", fixtureDir });
  const client: LlmClient = { complete: async req => {
    const name = fixtureFileName(req);
    const response = await replay.complete(req);
    const consumers = used.get(name) ?? new Set<string>();
    consumers.add(currentSample);
    used.set(name, consumers);
    return response;
  } };
  const base = createMonolith(FIXTURE_BASELINE.model, {
    think: FIXTURE_BASELINE.think, verifierModel: FIXTURE_BASELINE.verifierModel,
  });
  const result = await runScorecard({ ...base, run: async (sample, llm) => {
    currentSample = basename(dirname(sample.sampleDir));
    return base.run(sample, llm);
  } }, { corpusDir, client, judgeModel: FIXTURE_BASELINE.judgeModel, runs: 1, concurrency: 1 });
  const unused = names.filter(name => !used.has(name));
  if (unused.length) throw new Error(`unreferenced LLM recordings (archive privately, then remove): ${unused.join(", ")}`);
  const fixtures: FixtureManifest["fixtures"] = {};
  for (const name of names) {
    const fixture = files.get(name)!;
    fixtures[name] = { sha256: sha256(readFileSync(join(fixtureDir, name))), request_sha256: fixture.key,
      label: fixture.label, model: fixture.model, used_by: [...used.get(name)!].sort() };
  }
  return { manifest: { schema_version: 1, baseline: FIXTURE_BASELINE, recording_receipts_sha256: sha256(receiptBytes), samples, fixtures } satisfies FixtureManifest, result };
}

export function assertFixtureManifest(actual: FixtureManifest, expected: unknown): void {
  if (stableStringify(actual) !== stableStringify(expected)) {
    throw new Error("LLM fixture provenance differs from manifest.json; review source, request and response changes before regenerating the manifest");
  }
}
