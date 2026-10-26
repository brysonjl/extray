// The Explorer's one seam between product queries and a concrete database.
// Locally this wraps node:sqlite; on Cloudflare it wraps a D1 binding. The
// interface is async because D1 is async-only — the Node impl resolves
// immediately, and product code (src/product, src/jobs, src/server) awaits the
// interface, never a driver, so each runtime is an implementation swap.

import type { DatabaseSync, SQLInputValue } from "node:sqlite";

export type Row = Record<string, unknown>;
export type SqlParam = SQLInputValue;

export interface DataSource {
  all(sql: string, ...params: SqlParam[]): Promise<Row[]>;
  get(sql: string, ...params: SqlParam[]): Promise<Row | undefined>;
  /** The one write path (submission jobs). Reads must stay parameterized SELECTs. */
  run(sql: string, ...params: SqlParam[]): Promise<{ lastInsertRowid: number; changes: number }>;
}

export class SqliteDataSource implements DataSource {
  constructor(private readonly db: DatabaseSync) {}

  async all(sql: string, ...params: SqlParam[]): Promise<Row[]> {
    return this.db.prepare(sql).all(...params) as Row[];
  }

  async get(sql: string, ...params: SqlParam[]): Promise<Row | undefined> {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }

  async run(sql: string, ...params: SqlParam[]): Promise<{ lastInsertRowid: number; changes: number }> {
    const res = this.db.prepare(sql).run(...params);
    return { lastInsertRowid: Number(res.lastInsertRowid), changes: Number(res.changes) };
  }
}

/** Missing-table errors (empty or pre-schema DB) degrade to "no data" rather
 *  than a 500 — same posture as scripts/dashboard.ts. Anything else rethrows. */
export async function safe<T>(fn: () => T | Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Error && /no such table/i.test(e.message)) return fallback;
    throw e;
  }
}
