import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { SCHEMA_SQL } from "../src/db/schema.ts";
import { SqliteDataSource, type DataSource } from "../src/product/datasource.ts";
import { D1DataSource, type D1DatabaseLike, type D1PreparedStatementLike } from "../src/product/datasource-d1.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";
import { DEFAULT_SETTINGS } from "../src/product/settings.ts";
import { createSubmission } from "../src/jobs/service.ts";
import { createApp } from "../src/server/app.ts";

const NOW = new Date("2026-10-26T12:00:00Z");
const dbs: DatabaseSync[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const storeId = (i: number) => "a".repeat(30) + String.fromCharCode(97 + Math.floor(i / 16)) + String.fromCharCode(97 + i % 16);

/** Exercise the real D1 adapter's binding/result shape against SQLite SQL.
 * Yield before each statement to model independent in-flight requests; no
 * network or application-level lock serializes the admission check. */
function d1Binding(db: DatabaseSync): D1DatabaseLike {
  const statement = (sql: string, params: SQLInputValue[] = []): D1PreparedStatementLike => ({
    bind: (...values) => statement(sql, values as SQLInputValue[]),
    async all<T>() {
      await Promise.resolve();
      return { results: db.prepare(sql).all(...params) as T[], meta: { last_row_id: 0, changes: 0 } };
    },
    async first<T>() {
      await Promise.resolve();
      return (db.prepare(sql).get(...params) as T | undefined) ?? null;
    },
    async run() {
      await Promise.resolve();
      const result = db.prepare(sql).run(...params);
      return { meta: { last_row_id: Number(result.lastInsertRowid), changes: Number(result.changes) } };
    },
  });
  return { prepare: sql => statement(sql) };
}

function setup(adapter: "sqlite" | "d1", limit: number, configured = false) {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA_SQL);
  dbs.push(db);
  const ds: DataSource = adapter === "sqlite" ? new SqliteDataSource(db) : new D1DataSource(d1Binding(db));
  const runSubmission = vi.fn();
  const app = createApp({
    ds, now: () => NOW, submissionDailyLimit: limit,
    roleResolver: c => { c.set("email", c.req.header("x-test-identity") ?? "one@example.test"); return configured ? "admin" : "user"; },
    ...(configured ? { runSubmission, settings: { path: "unused", read: () => DEFAULT_SETTINGS, write: vi.fn() } } : {}),
  });
  const submit = (id: number, options: { identity?: string; configuration?: { model: string } } = {}) => app.request("/api/submissions", {
    method: "POST", headers: { "content-type": "application/json", ...(options.identity ? { "x-test-identity": options.identity } : {}) },
    body: JSON.stringify({ input: storeId(id), ...(options.configuration ? { configuration: options.configuration } : {}) }),
  });
  return { db, ds, submit, runSubmission };
}

describe.each(["sqlite", "d1"] as const)("atomic submission admission (%s adapter)", adapter => {
  it("admits exactly the daily limit under concurrent distinct requests", async () => {
    const { db, submit } = setup(adapter, 20);
    const responses = await Promise.all(Array.from({ length: 30 }, (_, i) => submit(i)));
    expect(responses.filter(r => r.status === 201)).toHaveLength(20);
    expect(responses.filter(r => r.status === 429)).toHaveLength(10);
    expect(db.prepare("SELECT COUNT(*) n FROM submission").get()?.n).toBe(20);
    expect(db.prepare("SELECT COUNT(*) n FROM analysis_event WHERE kind='submitted'").get()?.n).toBe(20);
  });

  it("joins concurrent duplicate submissions without consuming extra slots", async () => {
    const { db, submit } = setup(adapter, 1);
    const responses = await Promise.all(Array.from({ length: 12 }, () => submit(0)));
    expect(responses.every(r => r.ok)).toBe(true);
    const bodies = await Promise.all(responses.map(r => r.json() as Promise<{ jobId: number }>));
    expect(new Set(bodies.map(body => body.jobId)).size).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM submission").get()?.n).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM analysis_event WHERE kind='submitted'").get()?.n).toBe(1);
    expect((await submit(1)).status).toBe(429);
    expect((await submit(0)).status).toBe(200);
  });

  it("counts only the caller's rolling 24-hour window", async () => {
    const { ds, submit } = setup(adapter, 1);
    await createSubmission(ds, { inputRaw: storeId(0), storeId: storeId(0), profile: DEFAULT_PROFILE, requestedBy: "one@example.test", now: new Date(NOW.getTime() - 25 * 3600000) });
    expect((await submit(1)).status).toBe(201);
    expect((await submit(2)).status).toBe(429);
    expect((await submit(2, { identity: "two@example.test" })).status).toBe(201);
  });

  it("preserves distinct configured analyses and permits joins at a full quota", async () => {
    const { db, submit, runSubmission } = setup(adapter, 2, true);
    const duplicate = await Promise.all(Array.from({ length: 8 }, () => submit(0, { configuration: { model: "model-a" } })));
    expect(duplicate.every(r => r.ok)).toBe(true);
    expect((await submit(0, { configuration: { model: "model-b" } })).status).toBe(201);
    expect((await submit(0, { configuration: { model: "model-c" } })).status).toBe(429);
    expect((await submit(0, { configuration: { model: "model-a" } })).status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) n FROM submission").get()?.n).toBe(2);
    expect(db.prepare("SELECT COUNT(DISTINCT config_key) n FROM submission").get()?.n).toBe(2);
    expect(runSubmission).toHaveBeenCalled();
  });
});
