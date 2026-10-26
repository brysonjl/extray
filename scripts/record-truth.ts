#!/usr/bin/env -S npx tsx
// CLI: record a hand-authored "ground-truth" risk assessment into the bake-off DB
// as its own methodology, so a deep manual/Claude evaluation of an extension can
// be COMPARED against the automated arms (monolith/dag/pi) the same way they are
// compared against each other.
//
//   npm run record-truth -- <risk-report.json> --store-id <id> --source-dir <dir>
//   npm run record-truth -- <risk-report.json> --sample <name> --source-dir <dir> \
//                           --label-kind malicious --expected-tier high-risk
//
// The input JSON is a RiskReport (src/report/contract.ts) — the SAME structured
// shape the monolith/dag/pi arms emit at `structured.risk_report`. Because the
// recorder feeds it through the identical recordRun() seam, the ground-truth run
// lands one `run` row (methodology="ground-truth"), one `target`, one `report`,
// and one `finding` row per asserted/excluded finding — directly joinable
// against the automated arms on (store_id | sample).
//
// It is a thin recorder, not an evaluator: producing the RiskReport is the deep
// read (done by a Claude Code subagent per docs/ground-truth-protocol.md); this
// just lands it in the DB. Idempotent like every other recordRun caller — keyed
// by knobs + started_at, so re-recording replaces rather than duplicates.

import "./_env.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { REPORT_SCHEMA_VERSION, TIERS, type RiskReport } from "../src/report/contract.ts";
import { CATEGORIES, CONFIDENCES, FINDING_TYPES, SEVERITIES } from "../src/methodologies/findings.ts";
import { ANALYZER_VERSION } from "../src/pipeline/schema.ts";
import { resolveGitSha, type DbTargetInput, type RunInput } from "../src/db/index.ts";
import { recordRunSafe } from "./_db.ts";

interface Options {
  storeId?: string;
  sample?: string;
  sourceDir?: string;
  labelKind?: string;
  expectedTier?: string;
  model: string;
  methodology: string;
  db: string | false;
  startedAt?: string;
  strict?: boolean;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Strict corpus-quality gate (--strict). For building a trustworthy ground-truth
 * corpus at scale, reject a report that is structurally valid but sloppy: enum
 * typos (which become unjoinable columns) and asserted findings with no
 * evidence — or evidence pointing at a file that isn't in the unpacked source.
 * Throws with a precise message so the caller can retry/flag rather than silently
 * poison the corpus. Returns a list of soft warnings (non-fatal).
 */
function validateStrict(rr: RiskReport, sourceDir: string | undefined): string[] {
  const errs: string[] = [];
  const warns: string[] = [];
  if (!(TIERS as readonly string[]).includes(rr.verdict?.tier)) errs.push(`verdict.tier "${rr.verdict?.tier}" not in ${TIERS.join("|")}`);
  if (!rr.summaries?.layperson || !rr.summaries?.technical) warns.push("missing layperson/technical summary");
  rr.findings.forEach((f, i) => {
    const at = `findings[${i}] "${f.title ?? "?"}"`;
    if (!f.title) errs.push(`${at}: empty title`);
    if (!(SEVERITIES as readonly string[]).includes(f.severity)) errs.push(`${at}: bad severity "${f.severity}"`);
    if (!(CATEGORIES as readonly string[]).includes(f.category)) errs.push(`${at}: bad category "${f.category}"`);
    if (!(FINDING_TYPES as readonly string[]).includes(f.finding_type)) errs.push(`${at}: bad finding_type "${f.finding_type}"`);
    if (!(CONFIDENCES as readonly string[]).includes(f.confidence)) errs.push(`${at}: bad confidence "${f.confidence}"`);
    const refs = Array.isArray(f.evidence_refs) ? f.evidence_refs : [];
    if (refs.length === 0) errs.push(`${at}: no evidence_refs (every asserted finding must cite a file)`);
    // Grounding: cited files must exist in the unpacked source (when we have it).
    if (sourceDir) {
      for (const r of refs) {
        if (r?.file && !existsSync(join(sourceDir, r.file))) errs.push(`${at}: evidence file "${r.file}" not found under ${sourceDir}`);
      }
    }
  });
  if (errs.length) throw new Error(`--strict validation failed:\n  - ${errs.join("\n  - ")}`);
  return warns;
}

/** A compact markdown rendering of the parts ground-truth owns (verdict,
 *  summaries, findings, exclusions). NOT the full pack-oriented renderer
 *  (render-md.ts) — that expects static-pack-derived permission/destination
 *  digests every arm carries but a manual ground-truth read does not. */
function renderText(rr: RiskReport): string | null {
  try {
    const ext = rr.extension ?? ({} as RiskReport["extension"]);
    const L: string[] = [];
    L.push(`# Ground-truth assessment — ${ext.name ?? "?"} ${ext.version ?? ""}`.trim());
    L.push("");
    L.push(`**Verdict: \`${rr.verdict.tier}\`** — ${rr.verdict.rationale ?? ""}`.trim());
    if (rr.summaries?.layperson) L.push("", rr.summaries.layperson);
    if (rr.summaries?.technical) L.push("", `*Technical:* ${rr.summaries.technical}`);
    L.push("", `## Findings (${rr.findings.length})`, "");
    for (const f of rr.findings) {
      const g = f.verification?.grounding;
      const at = g ? ` — \`${g.file}${g.line != null ? `:${g.line}` : ""}\`` : "";
      L.push(`- **${f.title}** · ${f.severity} / ${f.finding_type} / ${f.category} (confidence: ${f.confidence})${at}`);
      if (f.detail) L.push(`  - ${f.detail}`);
    }
    const ex = rr.excluded_claims ?? [];
    if (ex.length) {
      L.push("", `## Excluded claims (${ex.length})`, "");
      for (const c of ex) L.push(`- **${c.title}** — _${c.reason}_: ${c.detail ?? ""}`.trimEnd());
    }
    return L.join("\n") + "\n";
  } catch (e) {
    process.stderr.write(`record-truth: could not render markdown (${(e as Error).message}); report_text left null\n`);
    return null;
  }
}

function run(file: string, opts: Options): void {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  // Accept either a bare RiskReport or a { risk_report } wrapper (what an arm's
  // structured trace nests it under), so either copy-paste works.
  const rr = (isObj(parsed) && isObj(parsed.risk_report) ? parsed.risk_report : parsed) as RiskReport;
  if (!isObj(rr) || !isObj(rr.verdict) || !Array.isArray(rr.findings)) {
    throw new Error(`${file} is not a RiskReport (need .verdict and .findings[]); see docs/ground-truth-protocol.md`);
  }
  if (!opts.storeId && !opts.sample) {
    throw new Error("pass --store-id <id> (extpose/CWS extension) or --sample <name> (corpus dir)");
  }
  if (opts.strict) {
    const warns = validateStrict(rr, opts.sourceDir);
    for (const w of warns) process.stderr.write(`record-truth: warning — ${w}\n`);
  }

  const ext = isObj(rr.extension) ? rr.extension : null;
  const target: DbTargetInput = {
    storeId: opts.storeId ?? null,
    sample: opts.sample ?? null,
    name: ext && typeof ext.name === "string" ? ext.name : null,
    version: ext && typeof ext.version === "string" ? ext.version : null,
    manifestVersion: ext && typeof ext.manifest_version === "number" ? ext.manifest_version : null,
    sourceDir: opts.sourceDir ?? null,
    isCorpus: Boolean(opts.sample),
    labelKind: opts.labelKind ?? null,
    expectedTier: opts.expectedTier ?? null,
    tier: isObj(rr.verdict) && typeof rr.verdict.tier === "string" ? rr.verdict.tier : null,
    report: renderText(rr),
    riskReport: rr as unknown as Record<string, unknown>,
    structured: { risk_report: rr },
    usage: null,
  };

  const input: RunInput = {
    kind: "assess",
    methodology: opts.methodology,
    model: opts.model,
    mode: "GROUND_TRUTH",
    analyzerVersion: ANALYZER_VERSION,
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    gitSha: resolveGitSha(),
    startedAt: opts.startedAt ?? new Date().toISOString(),
    sourcePath: file,
    targets: [target],
  };

  recordRunSafe(opts.db, input);
}

const program = new Command();
program
  .name("record-truth")
  .description("Record a ground-truth RiskReport into the bake-off DB as its own methodology")
  .argument("<risk-report.json>", "RiskReport JSON (or a { risk_report } wrapper) to record")
  .option("--store-id <id>", "Chrome Web Store id this report assesses (extpose/CWS extensions)")
  .option("--sample <name>", "corpus sample dir name (for known-bad corpus mutants)")
  .option("--source-dir <dir>", "the unpacked extension dir the report was produced from")
  .option("--strict", "corpus-quality gate: reject enum typos + asserted findings with no/ungrounded evidence (exit 2) instead of recording")
  .option("--label-kind <kind>", "corpus ground-truth label: benign | malicious")
  .option("--expected-tier <tier>", "corpus expected tier (clean|low-risk|concerning|high-risk)")
  .option("--model <id>", "model/agent that produced the assessment (provenance)", "claude-opus-4-8")
  .option("--methodology <id>", "methodology name to record under", "ground-truth")
  .option("--db <path>", "bake-off DB path", ".out/bakeoff.sqlite")
  .option("--no-db", "do not record (parse/validate only)")
  .option("--started-at <iso>", "override the run timestamp (default: now)")
  .action((file: string, opts: Options) => {
    try {
      run(file, opts);
    } catch (e) {
      process.stderr.write(`record-truth: ${(e as Error).message}\n`);
      process.exit(2);
    }
  });

program.parseAsync();
