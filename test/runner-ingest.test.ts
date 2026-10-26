// Remote ingest (src/runner/ingest-remote.ts): mirroring remote queued rows
// into the local unified queue with origin/active dedup, malformed-row failure
// write-back, and the store-keyed failure-update SQL. (planDrain,
// planFailureUpdates, and the arm preflights keep their coverage in
// test/drain-submissions.test.ts via the drain's re-exports.)

import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { SqliteDataSource, type DataSource } from "../src/product/datasource.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";
import { createSubmission } from "../src/jobs/service.ts";
import { ingestRemote, planFailureUpdatesByStore } from "../src/runner/ingest-remote.ts";

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);

let ds: DataSource;

beforeEach(() => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "ingest-")), "db.sqlite"));
  ds = new SqliteDataSource(db);
});

function deps(rows: Array<Record<string, unknown>>, d1Write = vi.fn()) {
  return {
    ds,
    profile: DEFAULT_PROFILE,
    d1Query: vi.fn().mockReturnValue(rows),
    d1Write,
    priority: 100,
    now: () => new Date("2026-08-11T00:00:00Z"),
  };
}

describe("ingestRemote", () => {
  it("mirrors fresh remote rows and dedups repeats across passes", async () => {
    const d = deps([
      { id: 7, store_id: ID_A },
      { id: 9, store_id: ID_A }, // same store — one mirror serves both
      { id: 11, store_id: ID_B },
    ]);
    const first = await ingestRemote(d);
    expect(first).toMatchObject({ pulled: 2, mirrored: 2, alreadyMirrored: 0, rejected: 0 });

    const rowA = await ds.get("SELECT * FROM submission WHERE store_id = ?", ID_A);
    expect(rowA).toMatchObject({ source: "remote", priority: 100, origin_id: 7, requested_by: "runner:ingest" });

    // Second pass: everything already mirrored, nothing inserted.
    const second = await ingestRemote(d);
    expect(second).toMatchObject({ pulled: 2, mirrored: 0, alreadyMirrored: 2 });
    expect((await ds.all("SELECT id FROM submission")).length).toBe(2);
  });

  it("skips stores with any live local job (origin aside)", async () => {
    await createSubmission(ds, {
      inputRaw: ID_A,
      storeId: ID_A,
      profile: DEFAULT_PROFILE,
      source: "discovery",
      priority: 10,
    });
    const r = await ingestRemote(deps([{ id: 7, store_id: ID_A }]));
    expect(r).toMatchObject({ mirrored: 0, alreadyMirrored: 1 });
  });

  it("writes malformed rows back to D1 as failed and mirrors nothing for them", async () => {
    const d1Write = vi.fn();
    const r = await ingestRemote(deps([{ id: 3, store_id: null }, { id: 4, store_id: "NOT-AN-ID" }], d1Write));
    expect(r).toMatchObject({ pulled: 0, rejected: 2 });
    expect(d1Write).toHaveBeenCalledTimes(1);
    const statements = d1Write.mock.calls[0]![0] as string[];
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("WHERE id IN (3)");
    expect(statements[0]).toContain("status = 'queued'"); // status guard survives
  });

  it("separates a new remote request from an older completed request still awaiting sync", async () => {
    await ingestRemote(deps([{id:7,store_id:ID_A}]));
    const original = await ds.get("SELECT id FROM submission WHERE origin_id=7");
    await ds.run("UPDATE submission SET status='succeeded' WHERE id=?",Number(original!.id));
    const mixed = deps([{id:7,store_id:ID_A},{id:8,store_id:ID_A}]);
    const result = await ingestRemote(mixed);
    expect(result).toMatchObject({mirrored:1,alreadyMirrored:0});
    const links = await ds.all("SELECT remote_id,submission_id FROM analysis_remote_origin ORDER BY remote_id");
    expect(links).toHaveLength(2);
    expect(links[0]!.submission_id).toBe(original!.id);
    expect(links[1]!.submission_id).not.toBe(original!.id);
    expect((await ds.get("SELECT status FROM submission WHERE id=?",Number(links[1]!.submission_id)))!.status).toBe("queued");
    await ingestRemote(mixed);
    expect(await ds.all("SELECT id FROM submission")).toHaveLength(2);
  });

  it("dedups against a completed-but-unsynced mirror via origin_id", async () => {
    const d = deps([{ id: 7, store_id: ID_A }]);
    await ingestRemote(d);
    // Simulate the runner finishing the job before sync closes the remote row.
    await ds.run("UPDATE submission SET status = 'succeeded' WHERE store_id = ?", ID_A);
    const r = await ingestRemote(d);
    expect(r).toMatchObject({ mirrored: 0, alreadyMirrored: 1 });
  });
});

describe("planFailureUpdatesByStore", () => {
  it("keys on the validated store id with the status guard", () => {
    const [sql] = planFailureUpdatesByStore([{ storeId: ID_A, error: "it's broken" }], "2026-08-11T00:00:00Z");
    expect(sql).toContain(`WHERE store_id = '${ID_A}' AND status = 'queued'`);
    expect(sql).toContain("it''s broken"); // quote-escaped
  });

  it("rejects anything that is not a bare store id", () => {
    expect(() => planFailureUpdatesByStore([{ storeId: "x'; DROP TABLE submission;--", error: "e" }], "t")).toThrow(
      /invalid store id/,
    );
  });
});
