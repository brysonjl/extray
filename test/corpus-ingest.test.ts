// W3.6 — one-click ingest of the labeled synthetic corpus, and the invariant
// that hangs off it: everything that reaches the catalog from `corpus/` is
// marked synthetic, all the way to the browser. A mutant we wrote being read
// as a real extension is the worst outcome this product has, so the marking is
// asserted at the SQL layer, the DTO layer, and the API.
//
// The ingest itself is REPLAY-only, so this test is offline and free.

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { openDb, recordRun } from "../src/db/index.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";
import { CORPUS_INGEST_ARM, ingestCorpus, type CorpusIngestResult } from "../src/product/corpus-ingest.ts";
import { canonicalReport, canonicalReports, includesCorpus, isCorpusKey } from "../src/product/canonical.ts";
import { searchCatalog } from "../src/product/catalog.ts";
import { createApp } from "../src/server/app.ts";
import type { AppEnv } from "../src/server/role.ts";

let db: DatabaseSync;
let ds: SqliteDataSource;
let result: CorpusIngestResult;

beforeAll(async () => {
  db = openDb(join(mkdtempSync(join(tmpdir(), "corpus-ingest-")), "db.sqlite"));
  ds = new SqliteDataSource(db);
  result = await ingestCorpus({ record: (input) => recordRun(db, input) });
}, 180000);

describe("ingestCorpus", () => {
  it("records samples offline, and reports the ones it could not replay", () => {
    // The shipped demo must stay complete through corpus and prompt migrations.
    expect(result.ingested).toHaveLength(11);
    expect(result.skipped).toEqual([]);
    // Custom corpus imports can report skips. The shipped baseline above must
    // always remain complete; partial demo coverage is a release regression.
    for (const s of result.skipped) expect(s.reason).toMatch(/no committed .* fixture/);
    expect(new Set([...result.ingested, ...result.skipped.map((s) => s.sample)]).size).toBe(
      result.ingested.length + result.skipped.length,
    );
  });

  it("records them as corpus targets with no store id — the DB does not invent one", () => {
    const rows = db.prepare("SELECT sample, store_id, is_corpus FROM target").all() as {
      sample: string | null;
      store_id: string | null;
      is_corpus: number;
    }[];
    expect(rows.length).toBe(result.ingested.length);
    for (const r of rows) {
      expect(r.is_corpus).toBe(1);
      expect(r.sample).toBeTruthy();
      expect(r.store_id).toBeNull();
    }
  });

  it("does not spend: the replay client has no live fallback", () => {
    const run = db.prepare("SELECT mode, methodology, model FROM run").get() as Record<string, unknown>;
    expect(run.mode).toBe("REPLAY");
    expect(run.methodology).toBe(CORPUS_INGEST_ARM.methodology);
    expect(run.model).toBe(CORPUS_INGEST_ARM.model);
  });
});

describe("synthetic rows in the catalog", () => {
  it("is gated by the profile, and the default profile lets them in", () => {
    expect(includesCorpus(DEFAULT_PROFILE)).toBe(true);
    expect(includesCorpus({ ...DEFAULT_PROFILE, requireStoreBacked: true })).toBe(false);
  });

  it("addresses each sample by a corpus: key, never a fake store id", async () => {
    const rows = await canonicalReports(ds, "user", DEFAULT_PROFILE);
    expect(rows.length).toBe(result.ingested.length);
    for (const r of rows) {
      expect(r.synthetic).toBe(true);
      expect(isCorpusKey(r.storeId)).toBe(true);
      expect(r.storeId).toBe(`corpus:${r.sample}`);
      // A synthetic key must never be mistakable for a Chrome Web Store id.
      expect(r.storeId).not.toMatch(/^[a-p]{32}$/);
    }
  });

  it("shows them whatever arm produced them — the pinned-arm rule would hide them all", async () => {
    // The committed fixtures are a measured-POOR model, deliberately not in
    // any role's preference list. Store-backed selection would drop these.
    const rows = await canonicalReports(ds, "user", DEFAULT_PROFILE);
    expect(rows.every((r) => r.model === CORPUS_INGEST_ARM.model)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("disappears entirely under a store-backed-only profile", async () => {
    const strict = { ...DEFAULT_PROFILE, requireStoreBacked: true };
    expect(await canonicalReports(ds, "user", strict)).toEqual([]);
    const one = (await canonicalReports(ds, "user", DEFAULT_PROFILE))[0]!;
    expect(await canonicalReport(ds, "user", one.storeId, strict)).toBeNull();
    expect(await canonicalReport(ds, "user", one.storeId, DEFAULT_PROFILE)).not.toBeNull();
  });

  it("carries synthetic:true into every catalog row the UI renders", async () => {
    const res = await searchCatalog(ds, "user", DEFAULT_PROFILE, {});
    expect(res.rows.length).toBeGreaterThan(0);
    for (const row of res.rows) expect(row.synthetic).toBe(true);
    for (const row of res.rows) expect(row.name).toBe("ExtRay Demo Cookie Manager");
  });
});

describe("synthetic rows over the API", () => {
  const app = () => createApp({ ds, profile: DEFAULT_PROFILE }) as Hono<AppEnv>;
  const get = (path: string) => app().request(path, { headers: { "x-explorer-role": "user" } });

  it("serves a detail page for a corpus key, marked synthetic and named by sample", async () => {
    const key = (await canonicalReports(ds, "user", DEFAULT_PROFILE))[0]!.storeId;
    const res = await get(`/api/extensions/${key}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: { synthetic: boolean; sample: string; storeId: string } };
    expect(body.identity.synthetic).toBe(true);
    expect(body.identity.sample).toBe(key.slice("corpus:".length));
  });

  it("rejects a malformed corpus key the same way it rejects a malformed store id", async () => {
    expect((await get("/api/extensions/corpus:../../etc/passwd")).status).toBe(404);
    expect((await get("/api/extensions/corpus:")).status).toBe(404);
    expect((await get("/api/extensions/corpus:UPPER")).status).toBe(404);
    expect((await get("/api/extensions/not-an-id")).status).toBe(404);
  });

  it("404s corpus detail under a store-backed-only profile", async () => {
    const strict = createApp({ ds, profile: { ...DEFAULT_PROFILE, requireStoreBacked: true } }) as Hono<AppEnv>;
    const key = (await canonicalReports(ds, "user", DEFAULT_PROFILE))[0]!.storeId;
    const res = await strict.request(`/api/extensions/${key}`, { headers: { "x-explorer-role": "user" } });
    expect(res.status).toBe(404);
  });

  it("404s the ingest route where the capability was not injected", async () => {
    const res = await app().request("/api/corpus/ingest", {
      method: "POST",
      headers: { "x-explorer-role": "admin", "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
  });
});
