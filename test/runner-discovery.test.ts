// Scheduled discovery (src/runner/discovery.ts): configured queries → fresh
// candidates enqueued at discovery priority, with dedup against the analyzed
// corpus, live jobs, and repeats across queries in one pass. The scraper
// itself is injected — network stays out of the tests.

import { describe, expect, it, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { SqliteDataSource, type DataSource } from "../src/product/datasource.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";
import { createSubmission } from "../src/jobs/service.ts";
import { DEFAULT_RUNNER_CONFIG, type RunnerConfig } from "../src/runner/config.ts";
import { discoverAndEnqueue, toDiscoverOpts } from "../src/runner/discovery.ts";
import type { Candidate } from "../scripts/discover.ts";

const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);
const ID_C = "c".repeat(32);

function cand(storeId: string): Candidate {
  return { storeId, name: storeId.slice(0, 4), installs: 1000, rating: 4, ratingCount: 10, category: null, languages: ["en"], source: "extpose", ref: storeId };
}

let ds: DataSource;

beforeEach(() => {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "disc-")), "db.sqlite"));
  ds = new SqliteDataSource(db);
});

const cfg: RunnerConfig = {
  ...DEFAULT_RUNNER_CONFIG,
  discovery: [
    { source: "extpose", collection: "new", limit: 10 },
    { source: "extpose", collection: "top-installed", limit: 10 },
  ],
};

describe("toDiscoverOpts", () => {
  it("always applies the English filter and polite scrape defaults", () => {
    const opts = toDiscoverOpts({ source: "extpose", collection: "new", limit: 5 });
    expect(opts).toMatchObject({ excludeNonEnglish: true, limit: 5, concurrency: 4, delay: 250 });
    // webstore needs the per-id detail fetch to get any metadata at all
    expect(toDiscoverOpts({ source: "webstore", collection: "sitemap" }).enrich).toBe(true);
    expect(toDiscoverOpts({ source: "extpose", collection: "new" }).enrich).toBe(false);
  });
});

describe("discoverAndEnqueue", () => {
  it("enqueues fresh ids at discovery priority, deduping analyzed / live / cross-query repeats", async () => {
    // ID_C is already a live job; ID_B is already in the analyzed corpus.
    await createSubmission(ds, { inputRaw: ID_C, storeId: ID_C, profile: DEFAULT_PROFILE, source: "user" });
    const discoverImpl = vi
      .fn()
      .mockResolvedValueOnce([cand(ID_A), cand(ID_B), cand(ID_C)]) // query 1
      .mockResolvedValueOnce([cand(ID_A)]); // query 2 repeats ID_A
    const r = await discoverAndEnqueue({
      ds,
      cfg,
      profile: DEFAULT_PROFILE,
      discoverImpl,
      loadAnalyzedImpl: () => new Set([ID_B]),
    });
    // Only ID_A is fresh: B is analyzed, C is live, and query 2's repeat of A
    // is skipped because the pass marks enqueued ids as analyzed.
    expect(r).toMatchObject({ enqueued: 1, queriesFailed: 0 });
    expect(r.skippedAnalyzed).toBe(2); // ID_B on query 1 + ID_A's repeat on query 2

    const rows = await ds.all("SELECT store_id, source, priority, requested_by FROM submission ORDER BY id");
    expect(rows).toHaveLength(2); // the pre-existing user job for C + the new discovery job for A
    const a = rows.find((x) => x.store_id === ID_A)!;
    expect(a).toMatchObject({ source: "discovery", priority: cfg.priorities.discovery, requested_by: "runner:discovery" });
    // ID_C: only the pre-existing user row (skippedActive), no discovery dupe.
    expect(rows.filter((x) => x.store_id === ID_C)).toHaveLength(1);
    expect(r.skippedActive).toBe(1);
  });

  it("a failing query is skipped, the rest still run", async () => {
    const discoverImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 503 for extpose"))
      .mockResolvedValueOnce([cand(ID_A)]);
    const r = await discoverAndEnqueue({
      ds,
      cfg,
      profile: DEFAULT_PROFILE,
      discoverImpl,
      loadAnalyzedImpl: () => new Set(),
    });
    expect(r).toMatchObject({ enqueued: 1, queriesFailed: 1 });
  });
});
