import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { type DatabaseSync, type SQLInputValue } from "node:sqlite";
import { openDb, recordRun } from "../src/db/index.ts";
import type { D1DatabaseLike, D1PreparedStatementLike } from "../src/product/datasource-d1.ts";
import worker from "../src/server/worker.ts";

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const databases: DatabaseSync[] = [];
const ADMIN = "admin@example.test";
const USER = "user@example.test";
const ISSUER = "https://worker-idp.example.test";
const AUD = "worker-bindings";
let privateKey: CryptoKey;
let jwk: JWK;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwk = { ...await exportJWK(pair.publicKey), alg: "RS256" };
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.close();
});

async function token(email = ADMIN, issuer = ISSUER, audience = AUD) {
  return new SignJWT({ email, email_verified: true }).setProtectedHeader({ alg: "RS256" })
    .setIssuer(issuer).setAudience(audience).setExpirationTime("10m").sign(privateKey);
}
function fetchKeys() {
  return vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [jwk] })));
}
function request(env: WorkerEnv, credential: string, path = "/api/meta", body?: unknown) {
  return worker.fetch(new Request(`https://worker.example.test${path}`, {
    headers: { authorization: `Bearer ${credential}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
  }), env);
}

/** Real SQL and the production D1 adapter; only the platform binding is local. */
function database(): { db: DatabaseSync; binding: D1DatabaseLike } {
  const db = openDb(":memory:");
  databases.push(db);
  const statement = (sql: string, params: SQLInputValue[] = []): D1PreparedStatementLike => ({
    bind: (...values) => statement(sql, values as SQLInputValue[]),
    async all<T>() { return { results: db.prepare(sql).all(...params) as T[], meta: { last_row_id: 0, changes: 0 } }; },
    async first<T>() { return (db.prepare(sql).get(...params) as T | undefined) ?? null; },
    async run() {
      const result = db.prepare(sql).run(...params);
      return { meta: { last_row_id: Number(result.lastInsertRowid), changes: Number(result.changes) } };
    },
  });
  return { db, binding: { prepare: sql => statement(sql) } };
}

describe("Worker binding updates within one module instance", () => {
  it("immediately rotates and removes shared credentials even when the env object is reused", async () => {
    const env: WorkerEnv = { DB: database().binding, EXTRAY_TOKEN: "before" };
    expect((await request(env, "before")).status).toBe(200);
    env.EXTRAY_TOKEN = "after";
    expect((await request(env, "before")).status).toBe(401);
    expect((await request(env, "after")).status).toBe(200);
    delete env.EXTRAY_TOKEN;
    expect((await request(env, "after")).status).toBe(401);
  });

  it("refreshes administrator membership and JWT configuration while reusing unchanged public keys", async () => {
    fetchKeys();
    const env: WorkerEnv = {
      DB: database().binding, EXTRAY_JWT_ISSUER: ISSUER, EXTRAY_JWT_AUDIENCE: AUD,
      EXTRAY_JWT_JWKS_URL: `${ISSUER}/keys`, ADMIN_EMAILS: ADMIN,
    };
    const credential = await token();
    expect(await (await request(env, credential)).json()).toMatchObject({ roles: ["user", "admin"] });
    env.ADMIN_EMAILS = USER;
    expect(await (await request(env, credential)).json()).not.toHaveProperty("roles");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    env.EXTRAY_JWT_AUDIENCE = "replacement-audience";
    expect((await request(env, credential)).status).toBe(401);
    expect((await request(env, await token(ADMIN, ISSUER, env.EXTRAY_JWT_AUDIENCE))).status).toBe(200);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    env.EXTRAY_JWT_ISSUER = "https://replacement-idp.example.test";
    env.EXTRAY_JWT_JWKS_URL = `${env.EXTRAY_JWT_ISSUER}/keys`;
    expect((await request(env, credential)).status).toBe(401);
    const replacement = await token(USER, env.EXTRAY_JWT_ISSUER, env.EXTRAY_JWT_AUDIENCE);
    expect(await (await request(env, replacement)).json()).toMatchObject({ roles: ["user", "admin"] });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("uses the current database, source bucket, and profile without leaking cached rows from another database", async () => {
    const storeId = "a".repeat(32);
    const seeded = (name: string) => {
      const result = database();
      recordRun(result.db, {
        kind: "assess", methodology: "monolith", model: "test-model", startedAt: "2026-01-01T00:00:00Z",
        targets: [{ storeId, isCorpus: false, sourceDir: `corpus/${name}`, structured: { risk_report: {
          extension: { name, version: "1", manifest_version: 3, store_id: storeId },
          verdict: { tier: "clean", rationale: name, per_area: [] },
          summaries: { layperson: name, technical: name }, findings: [], excluded_claims: [],
          permissions: { api: [], hosts: { required: [], optional: [] }, dangerous_combinations: [] },
          destinations: { rows: [], unresolved: [] }, obfuscation: { flagged: [] },
          developer: { name: "Synthetic" }, coverage: { unparsed_files: [], structural_limits: [] },
        } } }],
      });
      return result;
    };
    const first = seeded("First");
    const second = seeded("Second");
    expect(first.db.prepare("SELECT id FROM report").get()?.id).toBe(second.db.prepare("SELECT id FROM report").get()?.id);
    const profile = JSON.stringify({ pinned: { methodology: "monolith", model: "test-model" } });
    const env: WorkerEnv = { DB: first.binding, EXTRAY_TOKEN: "operator", EXPLORER_PROFILE: profile };
    expect(await (await request(env, "operator", "/api/catalog")).json()).toMatchObject({ rows: [{ name: "First" }] });
    env.DB = second.binding;
    expect(await (await request(env, "operator", "/api/catalog")).json()).toMatchObject({ rows: [{ name: "Second" }] });
    env.SOURCE = { get: async () => ({ size: 3, text: async () => "one" }) };
    const path = `/api/extensions/${storeId}/source?path=source.js`;
    expect(await (await request(env, "operator", path)).json()).toMatchObject({ lines: ["one"] });
    env.SOURCE = { get: async () => ({ size: 3, text: async () => "two" }) };
    expect(await (await request(env, "operator", path)).json()).toMatchObject({ lines: ["two"] });
    delete env.SOURCE;
    expect((await request(env, "operator", path)).status).toBe(404);
    env.EXPLORER_PROFILE = JSON.stringify({ pinned: { methodology: "monolith", model: "not-assessed" } });
    expect(await (await request(env, "operator", "/api/catalog")).json()).toMatchObject({ rows: [], total: 0 });
  });

  it("applies a changed submission limit on the next request", async () => {
    fetchKeys();
    const env: WorkerEnv = {
      DB: database().binding, EXTRAY_JWT_ISSUER: ISSUER, EXTRAY_JWT_AUDIENCE: AUD,
      EXTRAY_JWT_JWKS_URL: `${ISSUER}/quota-keys`, SUBMISSION_DAILY_LIMIT: "1",
    };
    const credential = await token(USER);
    expect((await request(env, credential, "/api/submissions", { input: "b".repeat(32) })).status).toBe(201);
    expect((await request(env, credential, "/api/submissions", { input: "c".repeat(32) })).status).toBe(429);
    env.SUBMISSION_DAILY_LIMIT = "2";
    expect((await request(env, credential, "/api/submissions", { input: "c".repeat(32) })).status).toBe(201);
  });
});
