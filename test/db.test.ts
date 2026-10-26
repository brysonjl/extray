import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, recordRun, extractRiskReport, type RunInput } from "../src/db/index.ts";
import { SCHEMA_VERSION } from "../src/db/schema.ts";
import { runInputFromReports, runInputFromScorecard } from "../src/db/adapters.ts";
import type { ScorecardResult } from "../src/scorecard/index.ts";
import type { GeneratedReport } from "../src/scorecard/reports.ts";
import type { MethodologyOutput } from "../src/methodologies/types.ts";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "bakeoff-")), "db.sqlite");
}

const RISK_REPORT = {
  analyzer_version: "0.1.0",
  report_schema_version: "1.0",
  extension: { name: "Demo", version: "2.1", manifest_version: 3, store_id: "a".repeat(32) },
  verdict: { tier: "concerning", rationale: "broad host perms", per_area: [] },
  summaries: { layperson: "lay", technical: "tech" },
  description_deviation: { deviates: true, note: "n", stated_purpose: null, stated_source: null },
  findings: [
    { id: "f1", title: "exfil", kind: "verified-behavior", severity: "critical", category: "data-exfiltration", confidence: "high", claimed_mechanism: "reads cookies then POSTs", detail: "d", evidence_refs: [{ file: "bg.js" }] },
  ],
  excluded_claims: [{ id: "f2", title: "maybe", reason: "needs-dynamic", detail: "d", claimed_mechanism: null, evidence_refs: [] }],
};

function assessInput(startedAt: string): RunInput {
  return {
    kind: "assess",
    methodology: "monolith",
    model: "test-model",
    mode: "REPLAY",
    analyzerVersion: "0.1.0",
    reportSchemaVersion: "1.0",
    startedAt,
    sourcePath: "/tmp/x.json",
    targets: [
      {
        storeId: "a".repeat(32),
        sourceDir: "/ext",
        isCorpus: false,
        report: "the report text",
        structured: { risk_report: RISK_REPORT },
        usage: { inputTokens: 100, outputTokens: 50 },
        usageByStep: [{ label: "monolith", model: "test-model", calls: 1, inputTokens: 100, outputTokens: 50 }],
        estimatedUsd: 0.01,
      },
    ],
  };
}

describe("bake-off DB", () => {
  it("creates the schema and stamps a version", () => {
    const db = openDb(tmpDb());
    const v = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string };
    expect(Number(v.value)).toBeGreaterThanOrEqual(1);
    db.close();
  });

  it("records a run with target, report, findings, and usage", () => {
    const db = openDb(tmpDb());
    const runId = recordRun(db, assessInput("2026-06-17T00:00:00Z"));
    expect(runId).toBeGreaterThan(0);

    const run = db.prepare("SELECT * FROM run").get() as Record<string, unknown>;
    expect(run.methodology).toBe("monolith");
    expect(run.mode).toBe("REPLAY");

    const target = db.prepare("SELECT * FROM target").get() as Record<string, unknown>;
    // identity pulled from the embedded risk_report when not passed explicitly
    expect(target.name).toBe("Demo");
    expect(target.manifest_version).toBe(3);
    expect(target.is_corpus).toBe(0);

    const report = db.prepare("SELECT * FROM report").get() as Record<string, unknown>;
    expect(report.tier).toBe("concerning"); // derived from verdict.tier
    expect(report.layperson_summary).toBe("lay");
    expect(report.description_deviates).toBe(1);
    expect(report.num_findings).toBe(1);
    expect(report.num_excluded).toBe(1);

    const findings = db.prepare("SELECT * FROM finding ORDER BY is_verified DESC").all() as Record<string, unknown>[];
    expect(findings).toHaveLength(2);
    expect(findings[0]!.is_verified).toBe(1);
    expect(findings[0]!.severity).toBe("critical");
    expect(findings[1]!.is_verified).toBe(0);
    expect(findings[1]!.exclusion_reason).toBe("needs-dynamic");

    const usage = db.prepare("SELECT * FROM usage").all() as Record<string, unknown>[];
    expect(usage).toHaveLength(1);
    expect(usage[0]!.input_tokens).toBe(100);
    db.close();
  });

  it("is idempotent: re-recording the same run replaces, not duplicates", () => {
    const db = openDb(tmpDb());
    recordRun(db, assessInput("2026-06-17T00:00:00Z"));
    recordRun(db, assessInput("2026-06-17T00:00:00Z"));
    expect((db.prepare("SELECT COUNT(*) c FROM run").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM finding").get() as { c: number }).c).toBe(2);
    // a different started_at is a genuinely distinct run
    recordRun(db, assessInput("2026-06-17T01:00:00Z"));
    expect((db.prepare("SELECT COUNT(*) c FROM run").get() as { c: number }).c).toBe(2);
    db.close();
  });

  it("records a scorecard rollup with per-sample scores", () => {
    const db = openDb(tmpDb());
    recordRun(db, {
      kind: "scorecard",
      methodology: "dag",
      model: "test-model",
      judgeModel: "judge-model",
      runs: 1,
      tierRecall: true,
      startedAt: "2026-06-17T00:00:00Z",
      targets: [{ sample: "mutant-a", isCorpus: true, labelKind: "malicious", expectedTier: "high-risk", tier: "high-risk", tierSource: "native" }],
      scorecard: {
        coverageKnownShapes: 0.78,
        unsafeMisses: 0,
        stability: "not measured (replay)",
        bellwether: { B: 1, E: 0.5, G: 0, per_arm_missed: true },
        h: { detected: true, coverage: 1, tier_masked: false },
        samples: [{ sample: "mutant-a", labelKind: "malicious", expectedTier: "high-risk", normalizedTier: "high-risk", coverage: 1, missKind: null }],
      },
    });
    const sc = db.prepare("SELECT * FROM scorecard").get() as Record<string, unknown>;
    expect(sc.coverage_known_shapes).toBeCloseTo(0.78);
    expect(sc.per_arm_missed).toBe(1);
    const ss = db.prepare("SELECT * FROM sample_score").get() as Record<string, unknown>;
    expect(ss.sample).toBe("mutant-a");
    // sample_score links back to the target row created for that sample
    expect(ss.target_id).not.toBeNull();
    db.close();
  });

  it("scorecard run populates finding rows when per-sample outputs are supplied", () => {
    const db = openDb(tmpDb());

    // Minimal scored result for one malicious sample.
    const result = {
      methodology: "dag",
      model: "test-model",
      judge_model: "judge-model",
      runs: 1,
      caveats: [],
      accounting: { entries: [], totals: { calls: 0, inputTokens: 0, outputTokens: 0, wallClockMs: 0 }, estimatedUsd: null, uncostedModels: [] },
      per_sample: [
        {
          sample: "mutant-a",
          kind: "malicious",
          expected_tier: "high-risk",
          normalized_tier: "high-risk",
          tier_source: "native",
          must_detect: [{ behavior: "exfil", satisfied: true, rationale: "" }],
          coverage: 1,
          usage: { inputTokens: 100, outputTokens: 50, wallClockMs: 0 },
        },
      ],
      totals: {
        coverage_known_shapes: 1,
        coverage_open_world: null,
        tier_recall: 1,
        false_alarm_samples: [],
        unsafe_misses: 0,
        false_dismissals: 0,
        hedged_misses: 0,
        stability: "not measured (replay)",
        cost: { inputTokens: 100, outputTokens: 50, wallClockMs: 0 },
      },
      bellwether: { B: null, E: null, G: null, per_arm_missed: false },
      generalization_H: { detected: false, coverage: null, tier_masked: false },
    } as unknown as ScorecardResult;

    // The arm's full structured trace for that sample (dag nesting).
    const outputs = new Map<string, MethodologyOutput>([
      [
        "mutant-a",
        {
          report: "the report",
          usage: { inputTokens: 100, outputTokens: 50 },
          tier: "high-risk",
          structured: { dag: { risk_report: RISK_REPORT } },
        },
      ],
    ]);

    recordRun(db, runInputFromScorecard({ knobs: { methodology: "dag", model: "test-model" }, startedAt: "2026-06-17T00:00:00Z", result, outputs }));

    // findings now flow from the embedded risk_report …
    const findings = db.prepare("SELECT is_verified, severity FROM finding ORDER BY is_verified DESC").all() as Record<string, unknown>[];
    expect(findings).toHaveLength(2);
    expect(findings[0]!.severity).toBe("critical");
    // … while the report row keeps the GRADED (normalized) tier, not the native one
    const report = db.prepare("SELECT tier, tier_source, num_findings FROM report").get() as Record<string, unknown>;
    expect(report.tier).toBe("high-risk");
    expect(report.tier_source).toBe("native");
    expect(report.num_findings).toBe(1);
    // and the scorecard rollup + sample_score still land
    expect((db.prepare("SELECT COUNT(*) c FROM scorecard").get() as { c: number }).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) c FROM sample_score").get() as { c: number }).c).toBe(1);
    db.close();
  });

  it("reports run records per-sample usage rows + report estimated_usd from the accounting", () => {
    const db = openDb(tmpDb());
    const reports: GeneratedReport[] = [
      {
        sample: "mutant-a",
        kind: "malicious",
        expected_tier: "high-risk",
        methodology: "monolith",
        model: "glm-5.2:cloud",
        report: "the report",
        usage: { inputTokens: 100, outputTokens: 50 },
        accounting: {
          entries: [
            { label: "monolith", model: "glm-5.2:cloud", calls: 1, inputTokens: 100, outputTokens: 50, wallClockMs: 0, estimatedUsd: 0.00036 },
          ],
          totals: { calls: 1, inputTokens: 100, outputTokens: 50, wallClockMs: 0 },
          estimatedUsd: 0.00036,
          uncostedModels: [],
        },
      },
    ];
    recordRun(db, runInputFromReports({ knobs: { methodology: "monolith", model: "glm-5.2:cloud" }, startedAt: "2026-06-17T00:00:00Z", reports }));
    // The per-step accounting lands as a target-attributed usage row …
    const usage = db.prepare("SELECT target_id, label, estimated_usd FROM usage").all() as Record<string, unknown>[];
    expect(usage).toHaveLength(1);
    expect(usage[0]!.target_id).not.toBeNull();
    expect(usage[0]!.label).toBe("monolith");
    expect(usage[0]!.estimated_usd).toBeCloseTo(0.00036, 10);
    // … and the report row carries the summed estimate.
    const report = db.prepare("SELECT estimated_usd FROM report").get() as { estimated_usd: number };
    expect(report.estimated_usd).toBeCloseTo(0.00036, 10);
    db.close();
  });

  it("scorecard run without outputs records metrics only (no findings)", () => {
    const db = openDb(tmpDb());
    recordRun(db, {
      kind: "scorecard",
      methodology: "dag",
      model: "test-model",
      startedAt: "2026-06-17T00:00:00Z",
      targets: [{ sample: "mutant-a", isCorpus: true, tier: "high-risk" }],
      scorecard: { coverageKnownShapes: 1, samples: [{ sample: "mutant-a" }] },
    });
    expect((db.prepare("SELECT COUNT(*) c FROM finding").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM scorecard").get() as { c: number }).c).toBe(1);
    db.close();
  });

  it("records the headroom knob and makes on/off runs distinct", () => {
    const db = openDb(tmpDb());
    const piRun = (headroom: boolean | undefined, startedAt: string): RunInput => ({
      ...assessInput(startedAt),
      methodology: "pi",
      headroom,
    });
    // same started_at, differing only by headroom → two distinct rows (run-hash includes it)
    recordRun(db, piRun(false, "2026-06-17T00:00:00Z"));
    recordRun(db, piRun(true, "2026-06-17T00:00:00Z"));
    const rows = db.prepare("SELECT headroom FROM run ORDER BY headroom").all() as Array<{ headroom: number }>;
    expect(rows.map((r) => r.headroom)).toEqual([0, 1]);
    // omitted → NULL (not 0), so legacy/other-arm runs stay unmarked
    recordRun(db, piRun(undefined, "2026-06-17T02:00:00Z"));
    const nul = db.prepare("SELECT headroom FROM run WHERE started_at='2026-06-17T02:00:00Z'").get() as { headroom: number | null };
    expect(nul.headroom).toBeNull();
    db.close();
  });

  it("migrates a v2 DB forward by adding the run.headroom column", () => {
    const path = tmpDb();
    let db = openDb(path); // fresh v3 DB has the column
    // simulate a pre-headroom (v2) file: drop the column and roll the stamp back
    db.exec("ALTER TABLE run DROP COLUMN headroom");
    db.prepare("UPDATE schema_meta SET value='2' WHERE key='schema_version'").run();
    db.close();
    db = openDb(path); // reopen → migrate() must re-add headroom and re-stamp current
    const cols = db.prepare("PRAGMA table_info(run)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "headroom")).toBe(true);
    const v = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string };
    expect(Number(v.value)).toBe(SCHEMA_VERSION);
    // and a headroom run still records cleanly post-migration
    recordRun(db, { ...assessInput("2026-06-17T03:00:00Z"), methodology: "pi", headroom: true });
    const run = db.prepare("SELECT headroom FROM run").get() as { headroom: number };
    expect(run.headroom).toBe(1);
    db.close();
  });

  it("migrates a v3 DB forward by adding the run.subagent_models column", () => {
    const path = tmpDb();
    let db = openDb(path); // fresh DB has the column
    // simulate a pre-shard (v3) file: drop the column and roll the stamp back
    db.exec("ALTER TABLE run DROP COLUMN subagent_models");
    db.prepare("UPDATE schema_meta SET value='3' WHERE key='schema_version'").run();
    db.close();
    db = openDb(path); // reopen → migrate() must re-add subagent_models and re-stamp current
    const cols = db.prepare("PRAGMA table_info(run)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "subagent_models")).toBe(true);
    const v = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string };
    expect(Number(v.value)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("migrates a v5 DB forward: queue columns on submission + runner tables", () => {
    const path = tmpDb();
    let db = openDb(path); // fresh v6 DB has everything
    // simulate a v5 file: drop the queue columns + runner tables, roll back
    db.exec("DROP INDEX IF EXISTS idx_submission_claim");
    for (const col of ["source", "priority", "origin_id", "attempts", "not_before"]) {
      db.exec(`ALTER TABLE submission DROP COLUMN ${col}`);
    }
    db.exec("DROP TABLE ledger_event");
    db.exec("DROP TABLE runner_state");
    db.prepare(
      `INSERT INTO submission (input_raw, store_id, status, created_at) VALUES ('x', ?, 'queued', '2026-08-01T00:00:00Z')`,
    ).run("a".repeat(32));
    db.prepare("UPDATE schema_meta SET value='5' WHERE key='schema_version'").run();
    db.close();

    db = openDb(path); // reopen → migrate() adds columns, SCHEMA_SQL recreates tables/index
    const cols = db.prepare("PRAGMA table_info(submission)").all() as Array<{ name: string }>;
    for (const col of ["source", "priority", "origin_id", "attempts", "not_before"]) {
      expect(cols.some((c) => c.name === col)).toBe(true);
    }
    // pre-existing rows are backfilled as Explorer submissions with defaults
    const row = db.prepare("SELECT source, priority, attempts FROM submission").get() as Record<string, unknown>;
    expect(row.source).toBe("user");
    expect(row.priority).toBe(50);
    expect(row.attempts).toBe(0);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ledger_event','runner_state')")
      .all();
    expect(tables).toHaveLength(2);
    const v = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string };
    expect(Number(v.value)).toBe(SCHEMA_VERSION);
    db.close();
  });

  it("records the Pi subagent_models map as queryable JSON (NULL when monolithic)", () => {
    const db = openDb(tmpDb());
    const models = { exfiltration: "glm-5.2:cloud", obfuscation: "gemma4:cloud", synthesis: "glm-5.2:cloud" };
    recordRun(db, { ...assessInput("2026-06-18T00:00:00Z"), methodology: "pi", subagentModels: models });
    recordRun(db, { ...assessInput("2026-06-18T01:00:00Z"), methodology: "pi" }); // monolithic → NULL
    const sharded = db.prepare("SELECT subagent_models FROM run WHERE started_at='2026-06-18T00:00:00Z'").get() as { subagent_models: string };
    expect(JSON.parse(sharded.subagent_models)).toEqual(models);
    const mono = db.prepare("SELECT subagent_models FROM run WHERE started_at='2026-06-18T01:00:00Z'").get() as { subagent_models: string | null };
    expect(mono.subagent_models).toBeNull();
    db.close();
  });

  it("extractRiskReport finds the report under monolith and dag nesting", () => {
    expect(extractRiskReport({ risk_report: { a: 1 } })).toEqual({ a: 1 });
    expect(extractRiskReport({ dag: { risk_report: { b: 2 } } })).toEqual({ b: 2 });
    expect(extractRiskReport({ nothing: true })).toBeNull();
  });
});

describe("incomplete investigation metadata", () => {
  it("retains the original trace while adding historical pi completion facts to the DB report", () => {
    const structured = { risk_report: RISK_REPORT, pi: { sharded: false, incomplete: true, aborted: true, submitted: false, uncovered_dimensions: [] } };
    const rr = extractRiskReport(structured)!;
    expect(rr.outcome).toMatchObject({ artifact_generated: true, investigation: "incomplete", final_submission: "not-accepted" });
    expect(RISK_REPORT).not.toHaveProperty("outcome");
    expect(rr.findings).toEqual(RISK_REPORT.findings);
    expect(extractRiskReport({ risk_report: RISK_REPORT })).not.toHaveProperty("outcome");
  });
});
