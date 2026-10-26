// Phase-1 verification (plan §13): role-scoped canonical-verdict selection.
// Seeds a temp DB via recordRun (the same writer live runs use) with several
// arms per extension and asserts: the pinned arm wins, fallbacks fill coverage
// gaps, newest-of-arm wins, ground-truth NEVER reaches a User, and corpus
// targets never surface.

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, recordRun } from "../src/db/index.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { canonicalReport, canonicalReports } from "../src/product/canonical.ts";
import { DEFAULT_PROFILE, allowedArms } from "../src/product/profile.ts";

const A = "a".repeat(32); // assessed by pi + monolith + ground-truth
const B = "b".repeat(32); // fallback-only: monolith
const C = "c".repeat(32); // ground-truth only — invisible to User
const E = "e".repeat(32); // two pi runs — newest must win

function riskReport(storeId: string, tier: string, rationale: string) {
  return {
    extension: { name: `ext-${storeId[0]}`, version: "1.0", manifest_version: 3, store_id: storeId },
    verdict: { tier, rationale, per_area: [{ area: "permissions", level: "low", note: "n" }] },
    summaries: { layperson: "lay", technical: "tech" },
    findings: [],
    excluded_claims: [],
    permissions: { api: [], hosts: { required: [], optional: [] }, dangerous_combinations: [] },
    destinations: { rows: [], unresolved: [] },
    obfuscation: { flagged: [] },
    developer: { name: "Dev", is_trader: false, high_risk_country: false },
    coverage: { unparsed_files: [], structural_limits: ["static only"] },
  };
}

function seed(db: ReturnType<typeof openDb>): void {
  const assess = (methodology: string, model: string, storeId: string, tier: string, startedAt: string) =>
    recordRun(db, {
      kind: "assess",
      methodology,
      model,
      startedAt,
      targets: [
        {
          storeId,
          isCorpus: false,
          structured: { risk_report: riskReport(storeId, tier, `${methodology} verdict for ${storeId[0]}.`) },
          usage: { inputTokens: 10, outputTokens: 5 },
          estimatedUsd: 0.01,
        },
      ],
    });

  assess("pi", "glm-5.2:cloud", A, "concerning", "2026-06-01T00:00:00Z");
  assess("monolith", "glm-5.2:cloud", A, "high-risk", "2026-06-20T00:00:00Z");
  assess("ground-truth", "claude-opus-4-8", A, "clean", "2026-06-25T00:00:00Z");

  assess("monolith", "glm-5.2:cloud", B, "low-risk", "2026-06-10T00:00:00Z");

  assess("ground-truth", "claude-opus-4-8", C, "high-risk", "2026-06-11T00:00:00Z");

  assess("pi", "glm-5.2:cloud", E, "clean", "2026-06-05T00:00:00Z");
  assess("pi", "glm-5.2:cloud", E, "concerning", "2026-06-15T00:00:00Z");

  // Corpus target: never product-visible even for Admin.
  recordRun(db, {
    kind: "assess",
    methodology: "pi",
    model: "glm-5.2:cloud",
    startedAt: "2026-06-16T00:00:00Z",
    targets: [
      {
        sample: "mutant-x",
        storeId: "f".repeat(32),
        isCorpus: true,
        labelKind: "malicious",
        structured: { risk_report: riskReport("f".repeat(32), "high-risk", "corpus.") },
      },
    ],
  });
}

describe("canonical-verdict selection", () => {
  let ds: SqliteDataSource;

  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "explorer-canonical-"));
    const db = openDb(join(dir, "test.sqlite"));
    seed(db);
    ds = new SqliteDataSource(db);
  });

  it("role preference lists: ground-truth is admin-only", () => {
    expect(allowedArms(DEFAULT_PROFILE, "user").map((a) => a.methodology)).toEqual(["pi", "monolith", "dag"]);
    expect(allowedArms(DEFAULT_PROFILE, "admin").map((a) => a.methodology)).toEqual([
      "pi", "monolith", "dag", "ground-truth",
    ]);
  });

  it("the pinned arm beats a newer fallback and a newer ground-truth (both roles)", async () => {
    for (const role of ["user", "admin"] as const) {
      const row = await canonicalReport(ds, role, A, DEFAULT_PROFILE);
      expect(row?.methodology).toBe("pi");
      expect(row?.tier).toBe("concerning");
      expect(row?.prefRank).toBe(0);
    }
  });

  it("falls back to monolith·glm-5.2 when pi has not assessed", async () => {
    const row = await canonicalReport(ds, "user", B, DEFAULT_PROFILE);
    expect(row?.methodology).toBe("monolith");
    expect(row?.prefRank).toBe(1); // honest fallback marker
  });

  it("newest report of the winning arm wins", async () => {
    const row = await canonicalReport(ds, "user", E, DEFAULT_PROFILE);
    expect(row?.tier).toBe("concerning");
    expect(row?.assessedAt).toBe("2026-06-15T00:00:00Z");
  });

  it("ground-truth-only extension: User canonical is none, Admin sees it", async () => {
    expect(await canonicalReport(ds, "user", C, DEFAULT_PROFILE)).toBeNull();
    const admin = await canonicalReport(ds, "admin", C, DEFAULT_PROFILE);
    expect(admin?.methodology).toBe("ground-truth");
    expect(admin?.tier).toBe("high-risk");
  });

  it("catalog sets are role-scoped, and a store-backed profile excludes corpus targets", async () => {
    // Pinned to requireStoreBacked: true. The DEFAULT now admits the synthetic
    // corpus into the catalog (W3.6, profile.ts) — that direction, and the
    // synthetic badging that goes with it, is asserted in corpus-ingest.test.ts.
    // This test is about role scoping among real store-backed targets.
    const storeOnly = { ...DEFAULT_PROFILE, requireStoreBacked: true };
    const userIds = (await canonicalReports(ds, "user", storeOnly)).map((r) => r.storeId).sort();
    expect(userIds).toEqual([A, B, E].sort());
    const adminIds = (await canonicalReports(ds, "admin", storeOnly)).map((r) => r.storeId).sort();
    expect(adminIds).toEqual([A, B, C, E].sort());
    // The corpus target ("f".repeat(32)) appears for neither role.
  });

  it("a User's canonical methodology is never ground-truth, for any extension", async () => {
    for (const row of await canonicalReports(ds, "user", DEFAULT_PROFILE)) {
      expect(row.methodology).not.toBe("ground-truth");
    }
  });
});
