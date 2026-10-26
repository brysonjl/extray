// The pure planning half of scripts/sync-explorer.ts: what the import step
// must do given the remote schema version, and which UPDATE statements close
// the submission loop after a snapshot import. The wrangler-driving half is
// exercised end-to-end against local D1 (plan 2026-07-06-001 verification).

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  planSubmissionUpdates,
  schemaAction,
  type CanonicalRef,
  type RemoteSubmission,
} from "../scripts/sync-explorer.ts";

const NOW = "2026-07-07T12:00:00.000Z";

function sub(over: Partial<RemoteSubmission>): RemoteSubmission {
  return {
    id: 1,
    store_id: "a".repeat(32),
    status: "queued",
    result_report_id: null,
    created_at: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

const ref = (reportId: number, assessedAt: string): CanonicalRef => ({ reportId, assessedAt });

describe("schemaAction", () => {
  it("imports into a fresh database (no schema_meta)", () => {
    expect(schemaAction(null, 5)).toEqual({ kind: "import" });
  });

  it("imports when versions match", () => {
    expect(schemaAction(5, 5)).toEqual({ kind: "import" });
  });

  it("resets when the remote is older", () => {
    expect(schemaAction(4, 5)).toEqual({ kind: "reset", remoteVersion: 4 });
  });

  it("migrates v5+ queues additively", () => {
    expect(schemaAction(5, 8)).toEqual({ kind: "migrate", remoteVersion: 5 });
    expect(schemaAction(7, 8)).toEqual({ kind: "migrate", remoteVersion: 7 });
  });

  it("refuses when the remote is newer", () => {
    const action = schemaAction(6, 5);
    expect(action.kind).toBe("refuse");
  });
});

describe("planSubmissionUpdates", () => {
  it("closes a queued job whose report post-dates it, with a status guard", () => {
    const plan = planSubmissionUpdates(
      [sub({ id: 7 })],
      () => ref(42, "2026-07-05T00:00:00.000Z"),
      NOW,
    );
    expect(plan.closed).toEqual([{ id: 7, storeId: "a".repeat(32), reportId: 42 }]);
    expect(plan.statements).toEqual([
      `UPDATE submission SET status = 'succeeded', result_report_id = 42, finished_at = '${NOW}' ` +
        `WHERE id = 7 AND status = 'queued' AND COALESCE(progress_revision,0)=0 AND EXISTS(SELECT 1 FROM report WHERE id=42);`,
    ]);
    expect(plan.pending).toEqual([]);
  });

  it("rechecks hosted ownership and report presence when executing a legacy completion", () => {
    const remote = new DatabaseSync(":memory:");
    try {
      remote.exec(`PRAGMA foreign_keys=ON;
        CREATE TABLE report(id INTEGER PRIMARY KEY);
        CREATE TABLE submission(id INTEGER PRIMARY KEY,status TEXT,result_report_id INTEGER REFERENCES report(id),finished_at TEXT,progress_revision INTEGER DEFAULT 0);
        INSERT INTO submission(id,status) VALUES(7,'queued');`);
      const plan = planSubmissionUpdates([sub({ id: 7 })], () => ref(42, "2026-07-05T00:00:00.000Z"), NOW);
      // A canonical report recorded after the export has not arrived remotely.
      expect(() => remote.exec(plan.statements.join("\n"))).not.toThrow();
      expect(remote.prepare("SELECT status,result_report_id FROM submission").get()).toEqual({status:"queued",result_report_id:null});
      // The progress publisher can claim this request after the initial pull.
      remote.exec("INSERT INTO report VALUES(42); UPDATE submission SET progress_revision=10");
      remote.exec(plan.statements.join("\n"));
      expect(remote.prepare("SELECT status,result_report_id FROM submission").get()).toEqual({status:"queued",result_report_id:null});
      // A genuinely unowned legacy request still closes once its report arrives.
      remote.exec("UPDATE submission SET progress_revision=0");
      remote.exec(plan.statements.join("\n"));
      expect(remote.prepare("SELECT status,result_report_id FROM submission").get()).toEqual({status:"succeeded",result_report_id:42});
      expect(remote.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { remote.close(); }
  });

  it("keeps a queued job pending when the only report pre-dates it (force re-analysis)", () => {
    const plan = planSubmissionUpdates(
      [sub({ id: 8, created_at: "2026-07-06T00:00:00.000Z" })],
      () => ref(42, "2026-07-05T00:00:00.000Z"),
      NOW,
    );
    expect(plan.statements).toEqual([]);
    expect(plan.pending).toEqual([{ id: 8, storeId: "a".repeat(32) }]);
  });

  it("keeps a queued job pending when no canonical report exists", () => {
    const plan = planSubmissionUpdates([sub({ id: 9 })], () => null, NOW);
    expect(plan.statements).toEqual([]);
    expect(plan.pending).toEqual([{ id: 9, storeId: "a".repeat(32) }]);
  });

  it("does not replace a lost exact result with an unrelated canonical report", () => {
    const plan = planSubmissionUpdates(
      [sub({ id: 3, status: "succeeded", result_report_id: null })],
      () => ref(42, "2026-06-01T00:00:00.000Z"),
      NOW,
    );
    expect(plan.relinked).toEqual([]);
    expect(plan.statements).toEqual([]);
  });

  it("leaves an already-linked succeeded job alone", () => {
    const plan = planSubmissionUpdates(
      [sub({ status: "succeeded", result_report_id: 40 })],
      () => ref(42, "2026-06-01T00:00:00.000Z"),
      NOW,
    );
    expect(plan.statements).toEqual([]);
    expect(plan.closed).toEqual([]);
    expect(plan.relinked).toEqual([]);
  });

  it("leaves running and failed jobs alone", () => {
    const plan = planSubmissionUpdates(
      [sub({ status: "running" }), sub({ id: 2, status: "failed" })],
      () => ref(42, "2026-07-05T00:00:00.000Z"),
      NOW,
    );
    expect(plan.statements).toEqual([]);
  });

  it("lists a queued job with no store_id as pending", () => {
    const plan = planSubmissionUpdates(
      [sub({ id: 4, store_id: null })],
      () => ref(42, "2026-07-05T00:00:00.000Z"),
      NOW,
    );
    expect(plan.statements).toEqual([]);
    expect(plan.pending).toEqual([{ id: 4, storeId: null }]);
  });

  it("rejects non-integer ids rather than interpolating them", () => {
    expect(() =>
      planSubmissionUpdates([sub({ id: 1.5 })], () => ref(42, "2026-07-05T00:00:00.000Z"), NOW),
    ).toThrow(/non-integer submission id/);
    expect(() =>
      planSubmissionUpdates([sub({ id: 7 })], () => ref(4.2, "2026-07-05T00:00:00.000Z"), NOW),
    ).toThrow(/non-integer report id/);
  });
});
