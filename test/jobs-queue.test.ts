// The unified queue's claiming semantics (schema v6): priority ordering,
// not_before backoff, rate-limit requeue, boot-time crash recovery, and the
// origin_id dedup lookup the remote ingest relies on.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { SqliteDataSource, type DataSource } from "../src/product/datasource.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";
import {
  claimNextSubmission,
  completeSubmission,
  createSubmission,
  findByOriginId,
  requeueSubmission,
  resetRunning,
} from "../src/jobs/service.ts";

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const ID_C = "c".repeat(32);

let ds: DataSource;

beforeEach(() => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "queue-")), "db.sqlite"));
  ds = new SqliteDataSource(db);
});

function enqueue(
  storeId: string,
  opts: Partial<Parameters<typeof createSubmission>[1]> = {},
) {
  return createSubmission(ds, {
    inputRaw: storeId,
    storeId,
    profile: DEFAULT_PROFILE,
    ...opts,
  });
}

describe("unified queue claiming", () => {
  it("claims by priority DESC, then created_at ASC", async () => {
    await enqueue(ID_A, { source: "discovery", priority: 10, now: new Date("2026-08-01T00:00:00Z") });
    await enqueue(ID_B, { source: "remote", priority: 100, now: new Date("2026-08-01T01:00:00Z") });
    await enqueue(ID_C, { source: "remote", priority: 100, now: new Date("2026-08-01T02:00:00Z") });

    const first = (await claimNextSubmission(ds))!;
    expect(first.storeId).toBe(ID_B); // highest priority, oldest within it
    const second = (await claimNextSubmission(ds))!;
    expect(second.storeId).toBe(ID_C);
    const third = (await claimNextSubmission(ds))!;
    expect(third.storeId).toBe(ID_A); // discovery backfill last
    expect(await claimNextSubmission(ds)).toBeNull();
  });

  it("legacy rows without queue fields claim at the default priority", async () => {
    // A row written by the v5-shaped INSERT (Explorer submit path).
    await enqueue(ID_A, { now: new Date("2026-08-01T00:00:00Z") });
    await enqueue(ID_B, { source: "discovery", priority: 10, now: new Date("2026-07-01T00:00:00Z") });
    const first = (await claimNextSubmission(ds))!;
    expect(first.storeId).toBe(ID_A); // default 50 beats discovery's 10 despite being newer
    expect(first.priority).toBe(50);
    expect(first.source).toBeNull();
  });

  it("skips rows whose not_before backoff has not elapsed", async () => {
    const job = await enqueue(ID_A, { source: "remote", priority: 100 });
    const claimed = (await claimNextSubmission(ds))!;
    await requeueSubmission(ds, claimed.id, { notBefore: new Date("2026-08-11T12:30:00Z") });

    // Before the backoff elapses: nothing claimable.
    expect(await claimNextSubmission(ds, new Date("2026-08-11T12:00:00Z"))).toBeNull();
    // After: the same job comes back with the attempt counted.
    const retried = (await claimNextSubmission(ds, new Date("2026-08-11T13:00:00Z")))!;
    expect(retried.id).toBe(job.id);
    expect(retried.attempts).toBe(1);
  });

  it("requeue only touches running rows", async () => {
    const job = await enqueue(ID_A);
    // not claimed → still queued → requeue is a no-op
    await requeueSubmission(ds, job.id, { notBefore: new Date("2026-08-11T12:30:00Z") });
    const row = (await claimNextSubmission(ds, new Date("2026-08-11T00:00:00Z")))!;
    expect(row.id).toBe(job.id);
    expect(row.attempts).toBe(0);
  });

  it("resetRunning requeues orphaned running rows at boot", async () => {
    await enqueue(ID_A, { priority: 100 });
    await enqueue(ID_B, { priority: 100 });
    const claimed = (await claimNextSubmission(ds))!;
    await completeSubmission(ds, claimed.id, { status: "succeeded" });
    await claimNextSubmission(ds); // second job left running (simulated crash)

    const recovered = await resetRunning(ds);
    expect(recovered).toBe(1);
    const next = (await claimNextSubmission(ds))!;
    expect(next.storeId).toBe(ID_B); // the orphan is claimable again
  });

  it("findByOriginId resolves the local mirror of a remote row", async () => {
    await enqueue(ID_A, { source: "remote", priority: 100, originId: 77 });
    const hit = await findByOriginId(ds, 77);
    expect(hit?.storeId).toBe(ID_A);
    expect(hit?.originId).toBe(77);
    expect(await findByOriginId(ds, 78)).toBeNull();
  });
});
