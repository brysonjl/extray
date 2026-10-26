// Pipeline orchestrator. Reads the manifest, then runs each layer in order,
// assembling a single evidence pack. Hard failures (missing dir, unreadable or
// unparseable manifest) throw HardError; soft failures are recorded in the pack.

import { existsSync, statSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { skeletonPack, type EvidencePack } from "./schema.ts";
import { analyzeManifest, extractDeveloper } from "./layer1-manifest.ts";
import { localizeManifestIdentity } from "./i18n.ts";
import { analyzeFiles } from "./layer2-files.ts";
import { analyzeScript } from "./layer3-ast/index.ts";
import { shouldSkipLayer3 } from "./skip.ts";
import { analyzeCrossFile } from "./layer4-crossfile.ts";
import { analyzeResources } from "./layer5-resources.ts";
import { buildSummarySignals } from "./summary.ts";
import { buildExternalCallLedger } from "./ledger.ts";
import { enforceSizeCap } from "./cap.ts";
import { LAYER3_PASS_VERSION, layer3ConfigHash } from "./config.ts";
import { Layer3Cache } from "../cache/sqlite.ts";
import { loadFixtureContext } from "./fixture-context.ts";

export class HardError extends Error {}

export interface AnalyzeOptions {
  /** Override analyzed_at (used by determinism tests). */
  analyzedAt?: string;
  /** When set, cache Layer-3 per-file results under this directory. */
  cacheDir?: string;
}

export function analyze(extDir: string, opts: AnalyzeOptions = {}): EvidencePack {
  const root = resolve(extDir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new HardError(`extension directory not found: ${extDir}`);
  }

  const manifestPath = join(root, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new HardError(`manifest.json not found in ${extDir}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new HardError(`manifest.json is not valid JSON: ${(e as Error).message}`);
  }
  // JSON.parse accepts null/arrays/scalars; only an object is a manifest.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HardError(`manifest.json must be a JSON object, got ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}`);
  }
  const manifest = parsed as Record<string, unknown>;

  // Resolve Chrome i18n placeholders in identity fields (name/short_name) against
  // _locales, so a `"name": "__MSG_appName__"` manifest reports its real name.
  localizeManifestIdentity(root, manifest);

  // Extension ID from the path. Convention: <id>/ directly, or <id>/extension/
  // (the corpus layout) — in which case the parent dir names the sample.
  const id = basename(root) === "extension" ? basename(dirname(root)) : basename(root);

  const pack = skeletonPack({
    // extension.path is normalized to the id so output is machine-independent
    // (see determinism decision); it is excluded from the determinism
    // comparison alongside analyzed_at regardless.
    path: id,
    id_from_path: id,
    manifest,
  });
  if (opts.analyzedAt) pack.analyzed_at = opts.analyzedAt;
  try {
    const fixture = loadFixtureContext(root);
    if (fixture) pack.fixture = fixture;
  } catch (e) {
    throw new HardError(`could not load fixture context: ${(e as Error).message}`);
  }

  // Layers populate the pack in place. Wired incrementally as units land.
  pack.manifest_analysis = analyzeManifest(manifest); // L1
  pack.developer = extractDeveloper(manifest); // L1 — self-reported developer identity

  const { files, missingReferences } = analyzeFiles(root, manifest); // L2
  pack.files = files;
  for (const ref of missingReferences) {
    pack.summary_signals.high.push({ kind: "missing-referenced-asset", path: ref });
  }
  // L3 — per first-party JS file, build a ScriptEntry (consulting the cache).
  const cache = opts.cacheDir ? new Layer3Cache(opts.cacheDir) : null;
  const configHash = layer3ConfigHash();
  for (const file of pack.files) {
    if (file.type !== "javascript") continue;
    if (shouldSkipLayer3(file)) continue;
    let entry = cache?.get(cache.key(file.sha256, LAYER3_PASS_VERSION, configHash), file.path) ?? null;
    if (!entry) {
      entry = analyzeScript(file.path, readFileSync(join(root, file.path), "utf8"));
      cache?.set(cache.key(file.sha256, LAYER3_PASS_VERSION, configHash), entry);
    }
    pack.scripts.push(entry);
  }
  cache?.close();
  // L5 — resources. Inline scripts are extracted here and run through Layer 3
  // so they participate in the cross-file views below.
  const { resources, inlineScripts } = analyzeResources(root, pack.files, manifest);
  pack.resources = resources;
  for (const inline of inlineScripts) pack.scripts.push(analyzeScript(inline.path, inline.source));

  // L4 — cross-file linkage (recomputed from all assembled Layer-3 facts).
  pack.cross_file = analyzeCrossFile(manifest, pack.scripts, pack.manifest_analysis.externally_connectable);

  // External-call soundness ledger (records where analysis is blind).
  buildExternalCallLedger(pack);

  // summary_signals rollup (pointer list for the DAG's gates).
  buildSummarySignals(pack);

  // Enforce the 5 MB cap last (after all arrays are assembled and sorted).
  enforceSizeCap(pack);

  return pack;
}
