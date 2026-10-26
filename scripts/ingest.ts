#!/usr/bin/env -S npx tsx
// CLI: backfill the bake-off DB from analysis JSON already written to disk. It
// walks a set of paths (files or dirs), classifies each .json by its SHAPE, and
// records it via the same recordRun() seam the live CLIs use.
//
//   npm run ingest -- [paths...] [--db <path>] [--reset]
//
// With no paths it scans the conventional output locations:
//   .out/reports/        single-extension `assess` outputs (id + structured)
//   .out/eval-reports/   corpus `reports` outputs (one file per sample)
//   ./scorecard*.json    scored `scorecard` rollups
//   abcid_agentic/, abcid_dag/   ad-hoc assess outputs
//
// Classification (duck-typed, tolerant):
//   per_sample[] + totals + methodology → a scorecard run (file = one run)
//   sample + methodology                → a corpus reports sample (grouped by dir)
//   id + methodology                    → a single-extension assess run (file = one run)
//
// Idempotent: each run is keyed by a hash that includes the source path + file
// mtime, so re-ingesting unchanged files replaces rather than duplicates.

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Command } from "commander";
import { openDb, recordRun, resolveGitSha, type DbTargetInput, type RunInput, type UsageLine } from "../src/db/index.ts";
import { localizeManifestIdentity } from "../src/pipeline/i18n.ts";

const DEFAULT_PATHS = [".out/reports", ".out/eval-reports", "scorecard.json", "scorecard-dag.json", "abcid_agentic", "abcid_dag"];

function readJson(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function mtimeIso(path: string): string {
  return statSync(path).mtime.toISOString();
}

/** Expand each input into a flat list of .json file paths (dirs are scanned one level). */
function expandInputs(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const f of readdirSync(p)) if (f.endsWith(".json")) out.push(join(p, f));
    } else if (p.endsWith(".json")) {
      out.push(p);
    }
  }
  return out;
}

function normUsageLines(v: unknown): UsageLine[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
    .map((e) => ({
      label: String(e.label ?? ""),
      model: String(e.model ?? ""),
      calls: typeof e.calls === "number" ? e.calls : null,
      inputTokens: typeof e.inputTokens === "number" ? e.inputTokens : null,
      outputTokens: typeof e.outputTokens === "number" ? e.outputTokens : null,
      wallClockMs: typeof e.wallClockMs === "number" ? e.wallClockMs : null,
      estimatedUsd: typeof e.estimatedUsd === "number" ? e.estimatedUsd : null,
    }));
}

function asObj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function asStr(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** Pull analyzer/report-schema version stamps out of a target's structured trace. */
function versionsFrom(structured: unknown): { analyzer: string | null; schema: string | null } {
  const s = asObj(structured);
  const rr = s ? asObj(s.risk_report) ?? (asObj(s.dag) ? asObj(asObj(s.dag)!.risk_report) : null) : null;
  return { analyzer: rr ? asStr(rr.analyzer_version) : null, schema: rr ? asStr(rr.report_schema_version) : null };
}

// ---- per-shape builders -----------------------------------------------------

/** Resolve the extension's real name from its on-disk dir when the stored name is
 *  a Chrome i18n placeholder (older artifacts predate pipeline-side resolution).
 *  Returns null when the dir is gone or the name isn't resolvable. */
function resolveNameFromDir(sourceDir: string | null): string | null {
  if (!sourceDir || !existsSync(join(sourceDir, "manifest.json"))) return null;
  try {
    const manifest = JSON.parse(readFileSync(join(sourceDir, "manifest.json"), "utf8"));
    if (!manifest || typeof manifest !== "object") return null;
    localizeManifestIdentity(sourceDir, manifest);
    const name = manifest.name;
    return typeof name === "string" && !/^__MSG_/.test(name) ? name : null;
  } catch {
    return null;
  }
}

function assessRun(file: string, j: Record<string, unknown>): RunInput {
  const id = asStr(j.id);
  const storeId = id && /^[a-p]{32}$/.test(id) ? id : null;
  const v = versionsFrom(j.structured);
  const sourceDir = asStr(j.sourceDir);
  const target: DbTargetInput = {
    storeId,
    // Resolve i18n names for older artifacts; null falls back to the (possibly
    // placeholder) name embedded in the structured risk report.
    name: resolveNameFromDir(sourceDir),
    sourceDir,
    isCorpus: false,
    report: asStr(j.report),
    structured: j.structured,
    usage: asObj(j.usage) as DbTargetInput["usage"],
    usageByStep: normUsageLines(j.usage_by_step),
    estimatedUsd: asNum(j.estimated_cost_usd),
  };
  return {
    kind: "assess",
    methodology: String(j.methodology ?? "unknown"),
    model: String(j.model ?? "unknown"),
    mode: asStr(j.mode),
    analyzerVersion: v.analyzer,
    reportSchemaVersion: v.schema,
    gitSha: resolveGitSha(),
    startedAt: mtimeIso(file),
    sourcePath: file,
    targets: [target],
  };
}

function reportsRun(dir: string, files: { file: string; j: Record<string, unknown> }[]): RunInput {
  const first = files[0]!.j;
  const v = versionsFrom(first.structured);
  const startedAt = files.map((f) => mtimeIso(f.file)).sort().at(-1)!;
  return {
    kind: "reports",
    methodology: String(first.methodology ?? "unknown"),
    model: String(first.model ?? "unknown"),
    analyzerVersion: v.analyzer,
    reportSchemaVersion: v.schema,
    gitSha: resolveGitSha(),
    startedAt,
    sourcePath: dir,
    targets: files.map(({ j }) => ({
      sample: asStr(j.sample),
      isCorpus: true,
      labelKind: asStr(j.kind),
      expectedTier: asStr(j.expected_tier),
      tier: asStr(j.tier),
      report: asStr(j.report),
      structured: j.structured,
      usage: asObj(j.usage) as DbTargetInput["usage"],
    })),
  };
}

function scorecardRun(file: string, j: Record<string, unknown>): RunInput {
  const totals = asObj(j.totals) ?? {};
  const perSample = Array.isArray(j.per_sample) ? (j.per_sample as Record<string, unknown>[]) : [];
  const bellwether = asObj(j.bellwether) ?? {};
  const h = asObj(j.generalization_H) ?? {};
  const accounting = asObj(j.accounting);
  const cost = asObj(totals.cost) ?? {};
  const faSamples = Array.isArray(totals.false_alarm_samples) ? totals.false_alarm_samples : [];

  return {
    kind: "scorecard",
    methodology: String(j.methodology ?? "unknown"),
    model: String(j.model ?? "unknown"),
    judgeModel: asStr(j.judge_model),
    runs: asNum(j.runs),
    tierRecall: totals.tier_recall !== null && totals.tier_recall !== undefined,
    gitSha: resolveGitSha(),
    startedAt: mtimeIso(file),
    sourcePath: file,
    targets: perSample.map((s) => ({
      sample: asStr(s.sample),
      isCorpus: true,
      labelKind: asStr(s.kind),
      expectedTier: asStr(s.expected_tier),
      tier: asStr(s.normalized_tier),
      tierSource: asStr(s.tier_source),
      usage: asObj(s.usage) as DbTargetInput["usage"],
    })),
    scorecard: {
      coverageKnownShapes: asNum(totals.coverage_known_shapes),
      coverageOpenWorld: asNum(totals.coverage_open_world),
      tierRecall: asNum(totals.tier_recall),
      unsafeMisses: asNum(totals.unsafe_misses),
      falseDismissals: asNum(totals.false_dismissals),
      hedgedMisses: asNum(totals.hedged_misses),
      falseAlarmCount: faSamples.length,
      stability: totals.stability as string | number | null,
      bellwether: { B: asNum(bellwether.B), E: asNum(bellwether.E), G: asNum(bellwether.G), per_arm_missed: !!bellwether.per_arm_missed },
      h: { detected: !!h.detected, coverage: asNum(h.coverage), tier_masked: !!h.tier_masked },
      totalInputTokens: asNum(cost.inputTokens),
      totalOutputTokens: asNum(cost.outputTokens),
      estimatedUsd: accounting ? asNum(accounting.estimatedUsd) : null,
      usageByStep: accounting ? normUsageLines(accounting.entries) : [],
      raw: { totals, bellwether: j.bellwether, generalization_H: j.generalization_H },
      samples: perSample.map((s) => ({
        sample: String(s.sample ?? ""),
        labelKind: asStr(s.kind),
        expectedTier: asStr(s.expected_tier),
        normalizedTier: asStr(s.normalized_tier),
        tierSource: asStr(s.tier_source),
        coverage: asNum(s.coverage),
        missKind: asStr(s.miss_kind),
        falseAlarm: typeof s.false_alarm === "boolean" ? s.false_alarm : null,
        mustDetect: s.must_detect,
        mustNotEmit: s.must_not_emit ?? null,
        inputTokens: asNum(asObj(s.usage)?.inputTokens),
        outputTokens: asNum(asObj(s.usage)?.outputTokens),
      })),
    },
  };
}

const program = new Command();
program
  .name("ingest")
  .description("Backfill the bake-off DB from analysis JSON already on disk")
  .argument("[paths...]", "files or dirs to ingest (default: conventional output locations)")
  .option("--db <path>", "bake-off DB to write into", ".out/bakeoff.sqlite")
  .option("--reset", "delete the DB file first and rebuild from scratch", false)
  .action((paths: string[], opts: { db: string; reset: boolean }) => {
    if (opts.reset && existsSync(opts.db)) rmSync(opts.db);
    const inputs = paths.length > 0 ? paths : DEFAULT_PATHS;
    const files = expandInputs(inputs);

    const db = openDb(opts.db);
    try {
      const reportGroups = new Map<string, { file: string; j: Record<string, unknown> }[]>();
      const counts = { assess: 0, scorecard: 0, reports: 0, skipped: 0 };

      for (const file of files) {
        const j = readJson(file);
        if (!j || !j.methodology) {
          counts.skipped++;
          continue;
        }
        if (Array.isArray(j.per_sample) && j.totals) {
          recordRun(db, scorecardRun(file, j));
          counts.scorecard++;
        } else if (typeof j.sample === "string") {
          // Group corpus reports per (dir, methodology, model) into one run.
          const key = `${dirname(file)} ${j.methodology} ${j.model}`;
          let group = reportGroups.get(key);
          if (!group) reportGroups.set(key, (group = []));
          group.push({ file, j });
        } else if (typeof j.id === "string") {
          recordRun(db, assessRun(file, j));
          counts.assess++;
        } else {
          counts.skipped++;
        }
      }

      for (const [key, group] of reportGroups) {
        const dir = key.split(" ")[0]!;
        recordRun(db, reportsRun(dir, group));
        counts.reports++;
      }

      // Repair pass: resolve any i18n-placeholder names already in the DB (incl.
      // rows from live runs recorded before pipeline-side resolution), using each
      // target's source dir or its example_crxs/<store_id> fallback.
      const placeholders = db
        .prepare("SELECT id, store_id, source_dir FROM target WHERE name LIKE '\\_\\_MSG\\_%' ESCAPE '\\'")
        .all() as { id: number; store_id: string | null; source_dir: string | null }[];
      const updateName = db.prepare("UPDATE target SET name = ? WHERE id = ?");
      let repaired = 0;
      for (const t of placeholders) {
        const dir = t.source_dir ?? (t.store_id ? join("example_crxs", t.store_id) : null);
        const name = resolveNameFromDir(dir);
        if (name) {
          updateName.run(name, t.id);
          repaired++;
        }
      }

      process.stdout.write(
        `ingested into ${resolve(opts.db)}: ${counts.scorecard} scorecard, ${counts.reports} reports, ${counts.assess} assess run(s)` +
          (repaired ? `, ${repaired} name(s) repaired` : "") +
          (counts.skipped ? `, ${counts.skipped} skipped` : "") +
          "\n",
      );
    } finally {
      db.close();
    }
  });

program.parse();
