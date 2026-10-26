// D1 implementation of the DataSource seam (the Workers runtime). Typed
// structurally against the documented D1 client API — no global
// @cloudflare/workers-types pollution in a repo that is otherwise Node — and
// kept in its own module so the local Node path never imports it.

import type { DataSource, Row, SqlParam } from "./datasource.ts";

interface D1Meta {
  last_row_id: number;
  changes: number;
}

export interface D1PreparedStatementLike {
  bind(...params: unknown[]): D1PreparedStatementLike;
  all<T = Row>(): Promise<{ results: T[]; meta: D1Meta }>;
  first<T = Row>(): Promise<T | null>;
  run(): Promise<{ meta: D1Meta }>;
}

export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
}

export class D1DataSource implements DataSource {
  constructor(private readonly db: D1DatabaseLike) {}

  private stmt(sql: string, params: SqlParam[]): D1PreparedStatementLike {
    const prepared = this.db.prepare(sql);
    return params.length > 0 ? prepared.bind(...params) : prepared;
  }

  async all(sql: string, ...params: SqlParam[]): Promise<Row[]> {
    const res = await this.stmt(sql, params).all();
    return res.results;
  }

  async get(sql: string, ...params: SqlParam[]): Promise<Row | undefined> {
    return (await this.stmt(sql, params).first()) ?? undefined;
  }

  async run(sql: string, ...params: SqlParam[]): Promise<{ lastInsertRowid: number; changes: number }> {
    const res = await this.stmt(sql, params).run();
    return { lastInsertRowid: res.meta.last_row_id, changes: res.meta.changes };
  }
}
