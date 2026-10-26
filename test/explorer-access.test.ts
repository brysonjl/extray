// Access-JWT role resolution (deploy plan 2026-07-06-001 §D): the Worker
// re-verifies Cf-Access-Jwt-Assertion and fails closed. Uses a locally
// generated RS256 key pair via jose's createLocalJWKSet — the same key-source
// interface production fills with the team's remote JWKS.

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { openDb } from "../src/db/index.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";
import { createApp } from "../src/server/app.ts";
import { accessRoleResolver } from "../src/server/access.ts";
import type { AppEnv } from "../src/server/role.ts";

const TEAM = "testteam";
const ISSUER = `https://${TEAM}.cloudflareaccess.com`;
const AUD = "aud-tag-1234";
const ADMIN = "admin@example.com";
const USER = "user@example.com";

let app: Hono<AppEnv>;
let ds: SqliteDataSource;
let privateKey: CryptoKey;

async function sign(
  claims: Record<string, unknown>,
  opts: { issuer?: string; audience?: string; expired?: boolean } = {},
): Promise<string> {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUD)
    .setIssuedAt(opts.expired ? "-2h" : undefined)
    .setExpirationTime(opts.expired ? "-1h" : "10m");
  return jwt.sign(privateKey);
}

function get(path: string, headers: Record<string, string>): Promise<Response> {
  return Promise.resolve(app.request(path, { headers }));
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  const keySource = createLocalJWKSet({ keys: [{ ...jwk, alg: "RS256" }] });

  const dir = mkdtempSync(join(tmpdir(), "explorer-access-"));
  ds = new SqliteDataSource(openDb(join(dir, "test.sqlite")));
  app = createApp({
    ds,
    profile: DEFAULT_PROFILE,
    roleResolver: accessRoleResolver({ ACCESS_TEAM: TEAM, ACCESS_AUD: AUD, ADMIN_EMAILS: ` ${ADMIN} , ` }, keySource),
    submissionDailyLimit: 2,
  });
});

describe("access role resolution", () => {
  it("no JWT → 401 (fail closed, nothing behind a bypassed edge)", async () => {
    const res = await get("/api/meta", {});
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unauthenticated");
  });

  it("verified admin email resolves to the admin role", async () => {
    const res = await get("/api/meta", { "cf-access-jwt-assertion": await sign({ email: ADMIN }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { roles?: string[] }).roles).toEqual(["user", "admin"]);
  });

  it("rejects an explicitly unverified Access identity while allowing its normal absent claim", async () => {
    for (const email_verified of [false, "true", null]) {
      const res = await get("/api/meta", { "cf-access-jwt-assertion": await sign({ email: ADMIN, email_verified }) });
      expect(res.status).toBe(401);
    }
  });

  it("admin match is case-insensitive", async () => {
    const res = await get("/api/meta", { "cf-access-jwt-assertion": await sign({ email: ADMIN.toUpperCase() }) });
    expect(((await res.json()) as { roles?: string[] }).roles).toEqual(["user", "admin"]);
  });

  it("any other verified email resolves to user", async () => {
    const res = await get("/api/meta", { "cf-access-jwt-assertion": await sign({ email: USER }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { roles?: string[] }).roles).toBeUndefined();
  });

  it("an admin may preview the User lens via x-explorer-role", async () => {
    const res = await get("/api/meta", {
      "cf-access-jwt-assertion": await sign({ email: ADMIN }),
      "x-explorer-role": "user",
    });
    expect(((await res.json()) as { roles?: string[] }).roles).toBeUndefined();
  });

  it("a user asserting x-explorer-role: admin stays a user", async () => {
    const res = await get("/api/meta", {
      "cf-access-jwt-assertion": await sign({ email: USER }),
      "x-explorer-role": "admin",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { roles?: string[] }).roles).toBeUndefined();
  });

  it("wrong audience → 401", async () => {
    const res = await get("/api/meta", {
      "cf-access-jwt-assertion": await sign({ email: ADMIN }, { audience: "other-app" }),
    });
    expect(res.status).toBe(401);
  });

  it("wrong issuer → 401", async () => {
    const res = await get("/api/meta", {
      "cf-access-jwt-assertion": await sign({ email: ADMIN }, { issuer: "https://evil.example" }),
    });
    expect(res.status).toBe(401);
  });

  it("expired JWT → 401", async () => {
    const res = await get("/api/meta", {
      "cf-access-jwt-assertion": await sign({ email: ADMIN }, { expired: true }),
    });
    expect(res.status).toBe(401);
  });

  it("garbage JWT → 401", async () => {
    const res = await get("/api/meta", { "cf-access-jwt-assertion": "not.a.jwt" });
    expect(res.status).toBe(401);
  });

  it("verified but email-less (service token) → 401", async () => {
    const res = await get("/api/meta", { "cf-access-jwt-assertion": await sign({ sub: "svc-token" }) });
    expect(res.status).toBe(401);
  });
});

describe("authenticated submissions (deploy plan §E)", () => {
  const submit = async (id: string): Promise<Response> =>
    app.request("/api/submissions", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": await sign({ email: USER }),
        "content-type": "application/json",
      },
      body: JSON.stringify({ input: id }),
    });

  it("attributes the job to the verified email, then caps at the daily limit", async () => {
    const first = await submit("g".repeat(32));
    expect(first.status).toBe(201);
    const job = (await first.json()) as { jobId: number };
    const row = await ds.get("SELECT requested_by FROM submission WHERE id = ?", job.jobId);
    expect(row?.requested_by).toBe(USER);

    expect((await submit("h".repeat(32))).status).toBe(201);
    // Third distinct extension in 24h exceeds the limit of 2.
    const over = await submit("i".repeat(32));
    expect(over.status).toBe(429);
    // Joining an in-flight job is not a new submission — never quota-blocked.
    expect((await submit("g".repeat(32))).status).toBe(200);
  });
});
