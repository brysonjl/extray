import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, recordRun } from "../src/db/index.ts";
import { buildConsistentD1Export } from "../scripts/export-d1.ts";
import { reserveCatalogSource } from "../scripts/sync-explorer.ts";
import { ensureProgressSourceId } from "../scripts/explorer-progress.ts";
import { PROGRESS_SCHEMA } from "../src/product/progress-projection.ts";
const databases: DatabaseSync[] = [];const dirs: string[] = [];
afterEach(() => { for(const db of databases.splice(0)) db.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true}); });
describe("catalog publication snapshot and authority", () => {
  it("exports one consistent SQLite snapshot while an analyzer commits changes", () => {
    const dir=mkdtempSync(join(tmpdir(),"extray-catalog-consistent-"));dirs.push(dir);
    const path=join(dir,"db.sqlite");const writer=openDb(path);databases.push(writer);writer.exec("PRAGMA journal_mode=WAL");
    recordRun(writer,{kind:"assess",methodology:"monolith",model:"test-model",startedAt:"2026-10-18T00:00:00Z",targets:[{storeId:"a".repeat(32),isCorpus:false,estimatedUsd:1}]});
    const reader=new DatabaseSync(path,{readOnly:true});databases.push(reader);
    const exported=buildConsistentD1Export(reader,()=>{writer.exec("UPDATE report SET estimated_usd=9");return true;});
    const restored=new DatabaseSync(":memory:");databases.push(restored);restored.exec(exported.sql);
    expect(writer.prepare("SELECT estimated_usd FROM report").get()?.estimated_usd).toBe(9);
    expect(restored.prepare("SELECT estimated_usd FROM report").get()?.estimated_usd).toBe(1);
  });
  it("reserves a fresh remote source once and rejects replacement before catalog import", async () => {
    const remote=new DatabaseSync(":memory:");databases.push(remote);remote.exec(PROGRESS_SCHEMA);
    const read=()=>remote.prepare("SELECT source_id FROM analysis_projection_source WHERE singleton=1").get()?.source_id;
    const write=vi.fn(async(sql:string)=>{remote.exec(sql);});
    await reserveCatalogSource("first",read,write);
    expect(read()).toBe("first");expect(write).toHaveBeenCalledTimes(1);
    await reserveCatalogSource("first",read,write);expect(write).toHaveBeenCalledTimes(1);
    await expect(reserveCatalogSource("second",read,write)).rejects.toThrow(/another source database/);
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("rejects the loser of a concurrent first-source reservation", async () => {
    let reads=0;const write=vi.fn(async()=>{});
    await expect(reserveCatalogSource("loser",()=>++reads===1?undefined:"winner",write)).rejects.toThrow(/claimed hosted catalog ownership/);
    expect(write).toHaveBeenCalledOnce();
  });
  it("keeps local source identities stable across publisher startup", () => {
    const db=openDb(":memory:");databases.push(db);
    expect(ensureProgressSourceId(db)).toBe(ensureProgressSourceId(db));
  });
});
