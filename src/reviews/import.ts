// Local, offline import of an external agent's candidate review. No LLM calls.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { validateReport } from "../../skills/extray-review/scripts/validate-report.mjs";
import { openDb, recordRun, resolveGitSha, type RunInput } from "../db/index.ts";
import { runStaticScan } from "../scan.ts";
import { assembleRiskReport, statedPurposeOf } from "../report/assemble.ts";
import { REPORT_SCHEMA_VERSION, type RiskReport } from "../report/contract.ts";
import { renderReportMarkdown } from "../report/render-md.ts";
import type { ImportedSkillReview, PortableReview } from "./types.ts";

export const SKILL_METHODOLOGY = "skill:extray-review";
export const SKILL_IMPORT_NOTICE = "Imported agent review — candidate findings have not been independently verified. No engine risk verdict has been assigned.";
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Preserve repo-relative paths for the Explorer's confined source reader. */
export function sourcePathForExplorer(sourceDir: string): string {
  const repoRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
  const rel = relative(repoRoot, sourceDir);
  return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    ? rel.split(sep).join("/") : sourceDir;
}

/** Fingerprint all bytes without following symlinks or executing sample code. */
export function fingerprintTree(directory: string): string {
  const root = realpathSync(directory);
  const files: Array<{ file: string; sha256: string }> = [];
  function walk(dir: string, prefix: string): void {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Source/skill tree contains a symlink: ${relative}`);
      if (stat.isDirectory()) walk(path, relative);
      else if (stat.isFile()) files.push({ file: relative, sha256: sha256(readFileSync(path)) });
      else throw new Error(`Source/skill tree contains a non-regular file: ${relative}`);
    }
  }
  walk(root, "");
  files.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
  return sha256(JSON.stringify(files));
}

export interface ImportReviewOptions {
  sourceDir: string;
  storeId: string;
  harness: string;
  model: string;
  sessionId?: string;
  reviewedAt?: string;
  skillDir?: string;
  sourceSha256?: string;
}

export function prepareReviewImport(file: string, opts: ImportReviewOptions): { report: RiskReport; input: RunInput } {
  if (!/^[a-p]{32}$/.test(opts.storeId)) throw new Error("--store-id must be a 32-character Chrome Web Store id");
  if (!opts.harness.trim() || !opts.model.trim()) throw new Error("--harness and --model must identify the reviewing agent");
  const reportPath = realpathSync(file);
  const sourceDir = realpathSync(opts.sourceDir);
  const bytes = readFileSync(reportPath);
  const candidate: unknown = JSON.parse(bytes.toString("utf8"));
  const errors = validateReport(candidate, sourceDir);
  if (errors.length) throw new Error(`Invalid candidate review:\n${errors.join("\n")}`);
  const review = candidate as PortableReview;
  const sourceHash = fingerprintTree(sourceDir);
  if (opts.sourceSha256 && sourceHash !== opts.sourceSha256) throw new Error("Source snapshot changed: --source-sha256 does not match the current package");
  const manifest = JSON.parse(readFileSync(join(sourceDir, "manifest.json"), "utf8")) as { version?: unknown };
  if (review.target.version !== manifest.version) throw new Error("Review target version does not match the source manifest");
  const skillDir = opts.skillDir ?? fileURLToPath(new URL("../../skills/extray-review/", import.meta.url));
  const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
  const metadata = parseYaml(skill.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "") as { name?: string; metadata?: { version?: string } } | null;
  if (metadata?.name !== "extray-review" || typeof metadata.metadata?.version !== "string") throw new Error("--skill-dir must contain a versioned extray-review skill");
  const reviewedAt = opts.reviewedAt ?? statSync(reportPath).mtime.toISOString();
  if (!Number.isFinite(Date.parse(reviewedAt))) throw new Error("--reviewed-at must be a valid timestamp");
  const provenance: ImportedSkillReview["provenance"] = {
    harness: opts.harness, model: opts.model, session_id: opts.sessionId ?? null,
    skill_version: metadata.metadata.version, skill_sha256: fingerprintTree(skillDir),
    review_sha256: sha256(bytes), source_sha256: sourceHash,
    reviewed_at: new Date(reviewedAt).toISOString(), verification: "not-run",
  };
  const { pack } = runStaticScan(sourceDir, { analyzedAt: provenance.reviewed_at });
  if (pack.fixture) throw new Error("This store-backed importer does not accept synthetic fixtures");
  if (fingerprintTree(sourceDir) !== sourceHash) throw new Error("Source package changed during import");
  const report = assembleRiskReport({
    pack, methodology: SKILL_METHODOLOGY, model: opts.model, storeId: opts.storeId,
    classified: { findings: [], excluded: [], dismissals: [] },
    // Compatibility placeholder, never computeVerdict over unverified candidates.
    verdict: { tier: "inconclusive", rationale: SKILL_IMPORT_NOTICE, per_area: [] },
    synthesis: { layperson_summary: `Agent review (unverified): ${review.summary}`,
      technical_summary: `${review.findings.length} candidate findings imported from ${opts.harness}; source references and coverage structure validated. Claim verification was not run.`,
      description_deviation: { deviates: null, note: "Not adjudicated by the shared verification pipeline." } },
    statedPurpose: statedPurposeOf(pack, null),
  });
  report.skill_review = { provenance, review };
  report.coverage.structural_limits = [...report.coverage.structural_limits, SKILL_IMPORT_NOTICE, ...review.limitations];
  // Preserve the original report, all candidates and coverage outcomes in JSON.
  // No outcome.accepted marker: structural validation is not Pi critic acceptance.
  const input: RunInput = {
    kind: "assess", methodology: SKILL_METHODOLOGY, model: opts.model, mode: "SKILL_IMPORT",
    analyzerVersion: pack.analyzer_version, reportSchemaVersion: REPORT_SCHEMA_VERSION,
    gitSha: resolveGitSha(), startedAt: provenance.reviewed_at,
    sourcePath: `skill-review:${sha256(JSON.stringify(provenance))}`,
    extra: { provenance, originalReportPath: reportPath },
    targets: [{ storeId: opts.storeId, sourceDir: sourcePathForExplorer(sourceDir), isCorpus: false,
      tier: "inconclusive", tierSource: "unverified-skill-import",
      riskReport: report as unknown as Record<string, unknown>, structured: { risk_report: report },
      report: renderReportMarkdown(report), usage: null }],
  };
  return { report, input };
}

/** Return the same record on repeat import; failures propagate to the agent. */
export function saveReviewImport(dbPath: string, input: RunInput): { runId: number; reportId: number; duplicate: boolean } {
  const db = openDb(dbPath);
  try {
    const existing = db.prepare(`SELECT r.id AS runId, rep.id AS reportId FROM run r JOIN report rep ON rep.run_id = r.id
      JOIN target t ON t.id = rep.target_id WHERE r.mode = 'SKILL_IMPORT' AND r.source_path = ? AND t.store_id = ?`)
      .get(input.sourcePath!, input.targets[0]!.storeId!) as { runId: number; reportId: number } | undefined;
    if (existing) return { ...existing, duplicate: true };
    const runId = recordRun(db, input);
    const row = db.prepare("SELECT id FROM report WHERE run_id = ?").get(runId) as { id: number };
    return { runId, reportId: row.id, duplicate: false };
  } finally { db.close(); }
}
