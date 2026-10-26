// Generic auth seam (OSS release plan 2026-08-21-001 §B.3.4, W2.2). The
// Cloudflare-specific contract is already regression-tested by
// test/explorer-access.test.ts (the preset) and test/worker-role.test.ts (mode
// selection + the dev-shim loopback guard); this file covers what W2.2 added:
// generic OIDC issuers, the shared-token mode, mode selection, and the rule
// that keeps mode "none" safe — no auth means no non-loopback bind.
//
// Keys are generated locally and injected via jose's createLocalJWKSet, the
// same JWTVerifyGetKey interface a deployment fills from a remote JWKS, so
// nothing here touches the network.

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { JWK, JWTVerifyGetKey } from "jose";
import {
  assertBindAllowed,
  AuthConfigError,
  isLoopbackHost,
  jwtRoleResolver,
  selectAuth,
  sharedTokenRoleResolver,
} from "../src/server/auth.ts";
import { roleMiddleware, type AppEnv, type RoleResolver } from "../src/server/role.ts";

const ISSUER = "https://idp.example.com/realms/extray";
const AUD = "extray";
const ADMIN = "admin@example.com";
const USER = "user@example.com";

let keySource: JWTVerifyGetKey;
let privateKey: CryptoKey;
let publicJwk: JWK;

async function sign(
  claims: Record<string, unknown>,
  opts: { issuer?: string; audience?: string } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUD)
    .setExpirationTime("10m")
    .sign(privateKey);
}

/** Minimal app: the resolver's whole contract is the role it lands on the
 *  context (plus the email it attributes submissions with) or the Response it
 *  returns instead. */
function appWith(resolver: RoleResolver): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", roleMiddleware(resolver));
  app.get("/whoami", (c) => c.json({ role: c.get("role"), email: c.get("email") ?? null }));
  return app;
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), alg: "RS256" };
  keySource = createLocalJWKSet({ keys: [publicJwk] });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("jwtRoleResolver against a generic OIDC issuer", () => {
  const app = (): Hono<AppEnv> =>
    appWith(jwtRoleResolver({ issuer: ISSUER, audience: AUD, adminEmails: ` ${ADMIN} , `, keySource }));

  const whoami = async (headers: Record<string, string>): Promise<Response> =>
    app().request("/whoami", { headers });

  it("verifies a Bearer token and maps the email claim to a role", async () => {
    const res = await whoami({ authorization: `Bearer ${await sign({ email: ADMIN, email_verified: true })}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ role: "admin", email: ADMIN });
  });

  it("any other verified email resolves to user", async () => {
    const res = await whoami({ authorization: `Bearer ${await sign({ email: USER, email_verified: true })}` });
    expect(await res.json()).toEqual({ role: "user", email: USER });
  });

  it.each([undefined, false, "true", 1, null])("rejects identities without boolean verification (%j)", async (verification) => {
    for (const email of [ADMIN, USER]) {
      const claims = { email, sub: "new-user", ...(verification === undefined ? {} : { email_verified: verification }) };
      const res = await whoami({ authorization: `Bearer ${await sign(claims)}` });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated" });
    }
  });

  it("preserves the admin downgrade lens and ignores a user's role header", async () => {
    const down = await whoami({
      authorization: `Bearer ${await sign({ email: ADMIN, email_verified: true })}`,
      "x-explorer-role": "user",
    });
    expect(((await down.json()) as { role: string }).role).toBe("user");

    const up = await whoami({
      authorization: `Bearer ${await sign({ email: USER, email_verified: true })}`,
      "x-explorer-role": "admin",
    });
    expect(((await up.json()) as { role: string }).role).toBe("user");
  });

  it("fails closed on a wrong issuer, wrong audience, missing or malformed credential", async () => {
    expect((await whoami({})).status).toBe(401);
    expect(
      (await whoami({ authorization: `Bearer ${await sign({ email: ADMIN, email_verified: true }, { issuer: "https://evil.example" })}` }))
        .status,
    ).toBe(401);
    expect(
      (await whoami({ authorization: `Bearer ${await sign({ email: ADMIN, email_verified: true }, { audience: "other-app" })}` })).status,
    ).toBe(401);
    expect((await whoami({ authorization: "Bearer not.a.jwt" })).status).toBe(401);
    // A bare token in Authorization is ambiguous with other schemes: rejected.
    expect((await whoami({ authorization: await sign({ email: ADMIN, email_verified: true }) })).status).toBe(401);
    // Verified but identity-less (a machine credential) is refused, not defaulted.
    expect((await whoami({ authorization: `Bearer ${await sign({ sub: "svc" })}` })).status).toBe(401);
  });

  it("reads a named forward-auth header and a non-default email claim", async () => {
    const res = await appWith(
      jwtRoleResolver({
        issuer: ISSUER,
        audience: AUD,
        tokenSource: { header: "x-forwarded-access-token", bearer: false },
        emailClaim: "preferred_username",
        adminEmails: ADMIN,
        keySource,
      }),
    ).request("/whoami", { headers: { "x-forwarded-access-token": await sign({ preferred_username: ADMIN, email: ADMIN, email_verified: true }) } });
    expect(await res.json()).toEqual({ role: "admin", email: ADMIN });
  });

  it("does not let a custom claim substitute an unverified identity for the verified email", async () => {
    const aliasApp = appWith(jwtRoleResolver({
      issuer: ISSUER, audience: AUD, emailClaim: "preferred_username", adminEmails: ADMIN, keySource,
    }));
    for (const claims of [
      { preferred_username: ADMIN, email: USER, email_verified: true },
      { preferred_username: ADMIN, email_verified: true },
    ]) {
      const res = await aliasApp.request("/whoami", { headers: { authorization: `Bearer ${await sign(claims)}` } });
      expect(res.status).toBe(401);
    }
  });
});

describe("public signing-key discovery reuse", () => {
  it("reuses public keys but refreshes changed discovery metadata after expiry", async () => {
    const issuer = "https://discovery-refresh.example.test";
    let keyUrl = `${issuer}/keys-one`;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input); calls.push(url);
      if (url === `${issuer}/.well-known/openid-configuration`) return Response.json({ jwks_uri: keyUrl });
      if (url === keyUrl) return Response.json({ keys: [publicJwk] });
      throw new Error("unexpected mocked key endpoint");
    }));
    const resolver = jwtRoleResolver({ issuer, audience: AUD, adminEmails: ADMIN });
    const headers = { authorization: `Bearer ${await sign({ email: ADMIN, email_verified: true }, { issuer })}` };
    expect((await appWith(resolver).request("/whoami", { headers })).status).toBe(200);
    // A fresh request-specific resolver shares keys, never administrator state.
    expect((await appWith(jwtRoleResolver({ issuer, audience: AUD })).request("/whoami", { headers })).status).toBe(200);
    expect(calls).toEqual([`${issuer}/.well-known/openid-configuration`, `${issuer}/keys-one`]);
    keyUrl = `${issuer}/keys-two`;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000 + 1);
    expect((await appWith(resolver).request("/whoami", { headers })).status).toBe(200);
    expect(calls.slice(2)).toEqual([`${issuer}/.well-known/openid-configuration`, `${issuer}/keys-two`]);
  });

  it("retries discovery after a failed fetch without authenticating the failed request", async () => {
    const issuer = "https://discovery-retry.example.test";
    let unavailable = true;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      if (String(input).endsWith("openid-configuration")) {
        return unavailable ? new Response("unavailable", { status: 503 }) : Response.json({ jwks_uri: `${issuer}/keys` });
      }
      return Response.json({ keys: [publicJwk] });
    }));
    const app = appWith(jwtRoleResolver({ issuer, audience: AUD }));
    const headers = { authorization: `Bearer ${await sign({ email: USER, email_verified: true }, { issuer })}` };
    expect((await app.request("/whoami", { headers })).status).toBe(401);
    unavailable = false;
    expect((await app.request("/whoami", { headers })).status).toBe(200);
  });
});

describe("shared-token mode", () => {
  const app = appWith(sharedTokenRoleResolver("s3cret-token"));
  const whoami = (headers: Record<string, string>): Promise<Response> =>
    Promise.resolve(app.request("/whoami", { headers }));

  it("accepts the configured token as the operator (admin), via either header", async () => {
    expect(await (await whoami({ authorization: "Bearer s3cret-token" })).json()).toEqual({
      role: "admin",
      email: null,
    });
    expect((await whoami({ "x-extray-token": "s3cret-token" })).status).toBe(200);
  });

  it("401s a wrong, absent, or near-miss token", async () => {
    expect((await whoami({})).status).toBe(401);
    expect((await whoami({ authorization: "Bearer wrong-token" })).status).toBe(401);
    expect((await whoami({ "x-extray-token": "s3cret-toke" })).status).toBe(401);
    expect((await whoami({ authorization: "Basic s3cret-token" })).status).toBe(401);
  });

  it("still honours the admin downgrade lens", async () => {
    const res = await whoami({ authorization: "Bearer s3cret-token", "x-explorer-role": "user" });
    expect(((await res.json()) as { role: string }).role).toBe("user");
  });
});

describe("selectAuth mode selection", () => {
  it("infers the mode from what is configured, defaulting to none", () => {
    expect(selectAuth({}).mode).toBe("none");
    expect(selectAuth({ EXTRAY_TOKEN: "t" }).mode).toBe("token");
    expect(selectAuth({ EXTRAY_JWT_ISSUER: ISSUER, EXTRAY_JWT_AUDIENCE: AUD }, keySource).mode).toBe("jwt");
    // Cloudflare first, matching the deployed Worker's pre-W2.2 behavior.
    expect(selectAuth({ ACCESS_TEAM: "t", ACCESS_AUD: "a", EXTRAY_TOKEN: "t" }).mode).toBe("cloudflare-access");
  });

  it("mode none resolves no resolver; every other mode does", () => {
    expect(selectAuth({}).resolver).toBeNull();
    expect(selectAuth({ EXTRAY_TOKEN: "t" }).resolver).not.toBeNull();
  });

  it("an explicit EXTRAY_AUTH wins over inference", () => {
    expect(selectAuth({ EXTRAY_AUTH: "none", EXTRAY_TOKEN: "t" }).mode).toBe("none");
    expect(selectAuth({ EXTRAY_AUTH: "TOKEN", EXTRAY_TOKEN: "t" }).mode).toBe("token");
  });

  it("refuses to construct an under-configured mode rather than degrading", () => {
    // Half-configured: throwing beats silently falling back to something weaker.
    expect(() => selectAuth({ EXTRAY_JWT_ISSUER: ISSUER })).toThrow(AuthConfigError);
    expect(() => selectAuth({ ACCESS_TEAM: "team" })).toThrow(AuthConfigError);
    expect(() => selectAuth({ EXTRAY_AUTH: "token" })).toThrow(AuthConfigError);
    expect(() => selectAuth({ EXTRAY_AUTH: "oauth2" })).toThrow(AuthConfigError);
  });

  it("a jwt issuer without an audience is a config error (replayable token)", () => {
    expect(() => selectAuth({ EXTRAY_AUTH: "jwt", EXTRAY_JWT_ISSUER: ISSUER })).toThrow(/EXTRAY_JWT_AUDIENCE/);
  });

  it("routes the configured JWT mode end to end", async () => {
    const { resolver } = selectAuth(
      { EXTRAY_JWT_ISSUER: ISSUER, EXTRAY_JWT_AUDIENCE: AUD, ADMIN_EMAILS: ADMIN },
      keySource,
    );
    const res = await appWith(resolver!).request("/whoami", {
      headers: { authorization: `Bearer ${await sign({ email: ADMIN, email_verified: true })}` },
    });
    expect(await res.json()).toEqual({ role: "admin", email: ADMIN });
  });
});

describe("bind guard — no auth means no non-loopback bind", () => {
  it("classifies loopback hosts", () => {
    for (const h of ["127.0.0.1", "localhost", "::1", "[::1]", "127.1.2.3"]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ["0.0.0.0", "192.168.1.10", "extray.example.com", "::"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it("refuses to start on a non-loopback bind with no auth configured", () => {
    expect(() => assertBindAllowed("0.0.0.0", selectAuth({}).mode)).toThrow(AuthConfigError);
    expect(() => assertBindAllowed("0.0.0.0", "none")).toThrow(/EXTRAY_TOKEN/);
  });

  it("allows loopback with no auth, and any host once auth is configured", () => {
    expect(() => assertBindAllowed("127.0.0.1", "none")).not.toThrow();
    expect(() => assertBindAllowed("0.0.0.0", selectAuth({ EXTRAY_TOKEN: "t" }).mode)).not.toThrow();
    expect(() => assertBindAllowed("0.0.0.0", "jwt")).not.toThrow();
  });
});
