import { describe, expect, it } from "vitest";
import { outcomeFromStructured } from "../src/report/outcome.ts";
import { buildExtensionDetail, catalogRowBase } from "../src/product/dto.ts";
import type { CanonicalRow } from "../src/product/canonical.ts";
import type { DataSource } from "../src/product/datasource.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";

describe("incomplete outcome readers", () => {
  it("reads old monolithic/sharded pi traces without assuming empty dimensions prove completion", () => {
    const pi = { submitted: false, aborted: true };
    expect(outcomeFromStructured({ pi: { ...pi, incomplete: true, uncovered_dimensions: [] } })?.investigation).toBe("incomplete");
    expect(outcomeFromStructured({ pi: { sharded: true, shards: [pi], synthesis: { submitted: true, aborted: false } } })?.investigation).toBe("incomplete");
    expect(outcomeFromStructured({ pi: { submitted: true, aborted: false } })?.investigation).toBe("complete");
    expect(outcomeFromStructured({ risk_report: {} })).toBeUndefined();
  });

  it("exposes partial investigation to User DTOs even with no unparsed files, retaining verified findings", async () => {
    const outcome = { artifact_generated: true as const, investigation: "incomplete" as const, final_submission: "not-accepted" as const, reasons: ["synthetic critic gap"] };
    const rr = { outcome, coverage: { unparsed_files: [], structural_limits: ["static only"] },
      verdict: { rationale: "Synthetic rationale" }, findings: [{ id: "f1", title: "Synthetic verified observation", kind: "verified-behavior" }] };
    const row = { reportId: 1, storeId: "a".repeat(32), name: "Synthetic", version: "1", tier: "high-risk", synthetic: true, assessedAt: "2026-01-01", rationale: "Synthetic rationale" } as CanonicalRow;
    const ds: DataSource = { get: async () => ({ j: JSON.stringify(rr) }), all: async () => [], run: async () => ({ lastInsertRowid: 0, changes: 0 }) };
    const detail = await buildExtensionDetail(ds, row, "user", DEFAULT_PROFILE);
    expect(detail?.partialAnalysis).toBe(true);
    expect(detail?.outcome).toEqual(outcome);
    expect(detail?.unparsedFiles).toEqual([]);
    expect(detail?.findings[0]?.title).toBe("Synthetic verified observation");
    expect(detail?.structuralLimits.join(" ")).toContain("Investigation incomplete");
    expect(detail?.provenance.pipeline).toBeUndefined();
    expect(catalogRowBase(row, rr).headline).toContain("Incomplete investigation");
  });
});
