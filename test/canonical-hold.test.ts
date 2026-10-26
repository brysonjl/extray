import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA_SQL } from "../src/db/schema.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";
import {
  allReportsFor, canonicalReport, canonicalReports, reportById, riskReportOf, riskReportsFor,
} from "../src/product/canonical.ts";
import { buildD1Export } from "../scripts/export-d1.ts";

const databases: DatabaseSync[] = [];
const STORE = "a".repeat(32);
function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec(SCHEMA_SQL);
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function seed(db: DatabaseSync, id: number, held: boolean, corpus = false, storeId = STORE): void {
  db.prepare(`INSERT INTO run (id,run_hash,kind,methodology,model,started_at)
              VALUES (?,?,'assess','pi','glm-5.2:cloud',?)`)
    .run(id, `hash-${id}`, `2026-10-${String(id).padStart(2, "0")}T00:00:00Z`);
  db.prepare("INSERT INTO target (id,run_id,store_id,sample,is_corpus,name) VALUES (?,?,?,?,?,?)")
    .run(id, id, corpus ? null : storeId, corpus ? "synthetic-hold" : null, corpus ? 1 : 0, `target-${id}`);
  db.prepare("INSERT INTO report (id,run_id,target_id,risk_report_json,tier) VALUES (?,?,?,?,?)")
    .run(id, id, id, JSON.stringify({ marker: `report-${id}` }), held ? "high-risk" : "clean");
  db.prepare("INSERT INTO finding (report_id,title,is_verified) VALUES (?,?,1)").run(id, `finding-${id}`);
  db.prepare("INSERT INTO usage (run_id,target_id,label,model,input_tokens,output_tokens) VALUES (?,?,'analysis','test',1,1)")
    .run(id, id);
  if (held) hold(db, "canonical_hold", JSON.stringify({ runHash: `hash-${id}`, reason: "research" }));
}
function hold(db: DatabaseSync, kind: string, detail: string | null): void {
  db.prepare("INSERT INTO ledger_event (ts,kind,detail) VALUES ('2026-10-04',?,?)").run(kind, detail);
}

describe("canonical research holds", () => {
  it("falls back to eligible older reports in both store and corpus catalogs, and withholds explicit details", async () => {
    const db = database();
    seed(db, 1, false); seed(db, 2, true);
    seed(db, 3, false, true); seed(db, 4, true, true);
    seed(db, 5, true, false, "b".repeat(32));
    const ds = new SqliteDataSource(db);
    for (const role of ["user", "admin"] as const) {
      expect((await canonicalReport(ds, role, STORE, DEFAULT_PROFILE))?.reportId).toBe(1);
      expect((await canonicalReport(ds, role, "corpus:synthetic-hold", DEFAULT_PROFILE))?.reportId).toBe(3);
      expect((await canonicalReports(ds, role, DEFAULT_PROFILE)).map(r => r.reportId).sort()).toEqual([1, 3]);
    }
    expect((await allReportsFor(ds, STORE)).map(r => r.report_id)).toEqual([1]);
    expect(await reportById(ds, 2, DEFAULT_PROFILE)).toBeNull();
    expect(await reportById(ds, 4, DEFAULT_PROFILE)).toBeNull();
    expect(await riskReportOf(ds, 2)).toBeNull();
    expect([...await riskReportsFor(ds, [1, 2, 3, 4])].map(([id]) => id)).toEqual([1, 3]);
    expect((await reportById(ds, 1, DEFAULT_PROFILE))?.reportId).toBe(1);
    expect((db.prepare("SELECT COUNT(*) n FROM report").get() as { n: number }).n).toBe(5);
  });

  it("ignores malformed JSON, non-string/missing runHash, and other event kinds without breaking selection", async () => {
    const db = database(); seed(db, 1, false);
    for (const detail of [null, "{broken", "null", "[]", "{}", '{"runHash":1}', '{"runHash":null}', '{"runHash":""}']) {
      hold(db, "canonical_hold", detail);
    }
    hold(db, "job_done", '{"runHash":"hash-1"}');
    hold(db, "canonical_hold", '{"run_hash":"hash-1"}');
    expect((await canonicalReport(new SqliteDataSource(db), "user", STORE, DEFAULT_PROFILE))?.reportId).toBe(1);
    const exported = buildD1Export(db, () => true);
    expect(exported.counts.run).toBe(1);
  });

  it("exports no held run or dependent rows and imports with valid foreign keys, preserving the source", () => {
    const source = database();
    seed(source, 1, false); seed(source, 2, true); seed(source, 3, true, true);
    seed(source, 4, false, false, "d".repeat(32));
    // Non-English filtering and holds must compose rather than overwrite each other.
    const before = source.prepare("SELECT COUNT(*) n FROM usage").get();
    const { sql, counts } = buildD1Export(source, storeId => storeId === STORE);
    expect(counts).toMatchObject({ run: 2, target: 1, report: 1, finding: 1 });
    expect(sql).not.toContain("hash-2"); expect(sql).not.toContain("hash-3");
    expect(sql).not.toContain("target-2"); expect(sql).not.toContain("finding-2");
    const dest = database(); dest.exec(sql);
    expect(dest.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    for (const table of ["target", "report", "finding"]) {
      expect((dest.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n).toBe(1);
    }
    expect((dest.prepare("SELECT COUNT(*) n FROM usage").get() as { n: number }).n).toBe(1);
    for (const table of ["scorecard", "sample_score", "ledger_event"]) {
      expect((dest.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
    expect(source.prepare("SELECT COUNT(*) n FROM usage").get()).toEqual(before);
    expect((source.prepare("SELECT COUNT(*) n FROM run").get() as { n: number }).n).toBe(4);
  });
});
