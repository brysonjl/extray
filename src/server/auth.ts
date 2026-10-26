// Authentication shared by the Node server and Cloudflare Worker.
// Modes: local-only unauthenticated use, shared operator token, generic
// JWT/OIDC with a verified email, or the Cloudflare Access preset.
// Missing or invalid credentials fail closed; incomplete configuration throws.
// Roles are resolved on the server. An administrator can request the User
// preview lens, but a user's role header can never grant administrator access.

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { Context } from "hono";
import type { AppEnv, RoleResolver } from "./role.ts";
import type { Role } from "../product/profile.ts";

/** A deployment-shaped mistake, distinct from a rejected credential. Thrown at
 *  resolver-construction time so the process/isolate never serves a request it
 *  cannot authenticate — see assertBindAllowed and scripts/serve.ts. */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

/** Where the bearer credential is read from. Default is `Authorization:
 *  Bearer <jwt>`; forward-auth proxies that stamp a named header instead
 *  (`X-Forwarded-Access-Token`, `Cf-Access-Jwt-Assertion`) set `bearer: false`. */
export interface TokenSource {
  header: string;
  /** Require and strip the `Bearer ` scheme. */
  bearer: boolean;
}

const DEFAULT_TOKEN_SOURCE: TokenSource = { header: "authorization", bearer: true };

export interface JwtAuthConfig {
  /** Expected `iss`. Also the OIDC discovery base when jwksUrl is omitted. */
  issuer: string;
  /** Expected `aud`. Optional here (some issuers audience nothing), but the
   *  env-driven seam below insists on it — an unaudienced token is replayable
   *  across every app sharing the issuer. */
  audience?: string | string[];
  /** Signing keys. Omit to discover them at `<issuer>/.well-known/openid-configuration`. */
  jwksUrl?: string;
  tokenSource?: TokenSource;
  /** Alias for the standard verified email. Defaults to `email`; an alias must
   *  match that claim so email_verified cannot certify a different identity. */
  emailClaim?: string;
  /** Comma-separated emails that resolve to the admin role. */
  adminEmails?: string;
  /** Injectable for tests (jose.createLocalJWKSet) — never hits the network. */
  keySource?: JWTVerifyGetKey;
}

function parseAdmins(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e !== ""),
  );
}

function unauthenticated(c: Context<AppEnv>): Response {
  return c.json({ error: "unauthenticated" }, 401);
}

function readToken(c: Context<AppEnv>, source: TokenSource): string | null {
  const raw = c.req.header(source.header)?.trim();
  if (!raw) return null;
  if (!source.bearer) return raw;
  // Strict about the scheme: a raw token in Authorization is ambiguous with
  // Basic/other schemes, and rejecting it costs a caller one word.
  const m = /^Bearer\s+(\S+)$/i.exec(raw);
  return m?.[1] ?? null;
}

async function discoverJwks(issuer: string): Promise<JWTVerifyGetKey> {
  // OIDC Discovery 1.0 §4: the document lives at the issuer plus the well-known
  // path, with the issuer treated as a directory.
  const url = new URL(".well-known/openid-configuration", `${issuer.replace(/\/+$/, "")}/`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery failed: ${url} → HTTP ${res.status}`);
  const doc = (await res.json()) as { jwks_uri?: unknown };
  if (typeof doc.jwks_uri !== "string" || doc.jwks_uri === "") {
    throw new Error(`OIDC discovery document has no jwks_uri: ${url}`);
  }
  return createRemoteJWKSet(new URL(doc.jwks_uri));
}

/** Resolving the key source can require a network round trip (discovery), which
 *  a Worker may not do at isolate construction — so it is deferred to the first
 *  request and memoized. A failed discovery clears the memo so a transient
 *  outage does not poison the isolate; until it succeeds every request 401s. */
function lazyKeySource(cfg: JwtAuthConfig): () => Promise<JWTVerifyGetKey> {
  if (cfg.keySource) {
    const injected = cfg.keySource;
    return () => Promise.resolve(injected);
  }
  if (cfg.jwksUrl) {
    // createRemoteJWKSet does not fetch until first use and caches thereafter.
    const remote = createRemoteJWKSet(new URL(cfg.jwksUrl));
    return () => Promise.resolve(remote);
  }
  const issuer = cfg.issuer;
  let pending: Promise<JWTVerifyGetKey> | null = null;
  return () =>
    (pending ??= discoverJwks(issuer).catch((e: unknown) => {
      pending = null;
      throw e;
    }));
}

// Share only signing-key discovery/cache state across request-specific
// resolvers. Roles, tokens, identity policy and Worker bindings are never cached
// here. jose retains its normal key refresh/cooldown behavior for each source.
const keySources = new Map<string, { expiresAt: number; get: () => Promise<JWTVerifyGetKey> }>();
const KEY_SOURCE_MAX_AGE_MS = 5 * 60_000;
function reusableKeySource(cfg: JwtAuthConfig): () => Promise<JWTVerifyGetKey> {
  if (cfg.keySource) return lazyKeySource(cfg);
  const { issuer, jwksUrl } = cfg;
  const key = JSON.stringify([issuer, jwksUrl ?? null]);
  return () => {
    let source = keySources.get(key);
    keySources.delete(key);
    // Refresh discovery too, so an issuer's changed jwks_uri is not pinned
    // indefinitely. Cached values contain key resolvers, never HTTP Responses.
    if (!source || source.expiresAt <= Date.now()) {
      source = { expiresAt: Date.now() + KEY_SOURCE_MAX_AGE_MS, get: lazyKeySource({ issuer, jwksUrl }) };
    }
    keySources.set(key, source);
    if (keySources.size > 16) keySources.delete(keySources.keys().next().value!);
    return source.get();
  };
}

/** Generic JWT-over-JWKS role resolution. Every mode below is this function
 *  plus configuration. */
export function jwtRoleResolver(cfg: JwtAuthConfig): RoleResolver {
  return verifiedJwtRoleResolver(cfg, false);
}

/** Access authenticates the email at its edge and omits the OIDC verification
 * claim. This exception is private to its preset, never a generic JWT option. */
function verifiedJwtRoleResolver(cfg: JwtAuthConfig, accessIdentity: boolean): RoleResolver {
  if (!cfg.issuer) throw new AuthConfigError("jwtRoleResolver requires an issuer");
  const { issuer, audience } = cfg;
  const emailClaim = cfg.emailClaim ?? "email";
  const source = cfg.tokenSource ?? DEFAULT_TOKEN_SOURCE;
  const admins = parseAdmins(cfg.adminEmails);
  const keys = reusableKeySource(cfg);

  return async (c) => {
    const jwt = readToken(c, source);
    if (!jwt) return unauthenticated(c);
    let email: string | null = null;
    try {
      const { payload } = await jwtVerify(jwt, await keys(), { issuer, audience });
      if (payload.email_verified !== true && !(accessIdentity && payload.email_verified === undefined)) {
        return unauthenticated(c);
      }
      const claim = payload[emailClaim];
      email = typeof claim === "string" && claim !== "" ? claim.toLowerCase() : null;
      // A verification bit certifies the standard email, not an arbitrary
      // user-editable username selected by configuration.
      if (!accessIdentity && emailClaim !== "email" &&
          (typeof payload.email !== "string" || email !== payload.email.toLowerCase())) {
        return unauthenticated(c);
      }
    } catch {
      return unauthenticated(c);
    }
    // Machine credentials (Access service tokens, client-credentials grants)
    // authenticate without an identity claim; the explorer has no machine
    // callers, so anything identity-less is refused rather than defaulted.
    if (!email) return unauthenticated(c);
    c.set("email", email);
    const role: Role = admins.has(email) ? "admin" : "user";
    if (role === "admin" && c.req.header("x-explorer-role") === "user") return "user";
    return role;
  };
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Constant-time over the digests rather than the strings, so neither the
 *  length nor the first differing byte of EXTRAY_TOKEN leaks through timing.
 *  Works on both runtimes (WebCrypto is present in Node 24 and Workers). */
async function tokenMatches(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** One shared secret, presented as `Authorization: Bearer <token>` or
 *  `X-ExtRay-Token: <token>` (the SPA has no login UI in v1, so the header form
 *  is what curl and proxy users actually have).
 *
 *  The holder is the operator — they configured the secret — so they get admin,
 *  with the same downgrade lens as a verified admin. No email is attached:
 *  there is exactly one identity here, so the per-caller submission quota has
 *  nothing to meter, exactly as with the local dev shim. */
export function sharedTokenRoleResolver(token: string): RoleResolver {
  if (!token) throw new AuthConfigError("sharedTokenRoleResolver requires a non-empty token");
  return async (c) => {
    const presented = readToken(c, DEFAULT_TOKEN_SOURCE) ?? c.req.header("x-extray-token")?.trim();
    if (!presented) return unauthenticated(c);
    if (!(await tokenMatches(presented, token))) return unauthenticated(c);
    return c.req.header("x-explorer-role") === "user" ? "user" : "admin";
  };
}

/** Cloudflare Access, expressed as configuration rather than as code: Access
 *  protects the hostname at the edge and stamps each request with a
 *  Cf-Access-Jwt-Assertion JWT, issued by the Zero Trust team's hostname and
 *  signed by keys at a fixed non-OIDC path. Access authenticates its email
 *  identity before issuing this assertion; the preset permits its absent
 *  email_verified claim, but never an explicitly unverified value.
 *  (src/server/access.ts re-exports this under its historical name.) */
export function cloudflareAccessRoleResolver(env: AuthEnv, keySource?: JWTVerifyGetKey): RoleResolver {
  if (!env.ACCESS_TEAM || !env.ACCESS_AUD) {
    throw new AuthConfigError("cloudflare-access auth requires ACCESS_TEAM and ACCESS_AUD");
  }
  const issuer = `https://${env.ACCESS_TEAM}.cloudflareaccess.com`;
  return verifiedJwtRoleResolver({
    issuer,
    audience: env.ACCESS_AUD,
    jwksUrl: `${issuer}/cdn-cgi/access/certs`,
    tokenSource: { header: "cf-access-jwt-assertion", bearer: false },
    adminEmails: env.ADMIN_EMAILS,
    keySource,
  }, true);
}

export type AuthMode = "none" | "token" | "jwt" | "cloudflare-access";

/** Every knob the auth seam reads, from `process.env` (Node) or the Worker's
 *  bindings. Cloudflare's two keep their historical names — they are already
 *  deployed and documented. */
export interface AuthEnv {
  /** Pin the mode. Omit to infer it from what is configured. */
  EXTRAY_AUTH?: string;
  EXTRAY_TOKEN?: string;
  EXTRAY_JWT_ISSUER?: string;
  EXTRAY_JWT_AUDIENCE?: string;
  /** Skips OIDC discovery when set. */
  EXTRAY_JWT_JWKS_URL?: string;
  /** Named header carrying the JWT; default `Authorization: Bearer`. */
  EXTRAY_JWT_HEADER?: string;
  EXTRAY_JWT_EMAIL_CLAIM?: string;
  /** Roles source of truth for now; the D1 `app_user` table is a later phase. */
  ADMIN_EMAILS?: string;
  /** Cloudflare Access preset (src/server/access.ts). */
  ACCESS_TEAM?: string;
  ACCESS_AUD?: string;
}

export interface AuthSelection {
  mode: AuthMode;
  /** null only for mode "none" — the caller decides what unauthenticated means
   *  in its runtime (the Node server's dev shim, the Worker's flat 401). */
  resolver: RoleResolver | null;
}

function jwtSelection(env: AuthEnv, keySource?: JWTVerifyGetKey): AuthSelection {
  if (!env.EXTRAY_JWT_ISSUER) throw new AuthConfigError("EXTRAY_AUTH=jwt requires EXTRAY_JWT_ISSUER");
  if (!env.EXTRAY_JWT_AUDIENCE) {
    throw new AuthConfigError(
      "EXTRAY_AUTH=jwt requires EXTRAY_JWT_AUDIENCE — a token with no audience is replayable against every app sharing the issuer",
    );
  }
  const header = env.EXTRAY_JWT_HEADER?.trim();
  return {
    mode: "jwt",
    resolver: jwtRoleResolver({
      issuer: env.EXTRAY_JWT_ISSUER,
      audience: env.EXTRAY_JWT_AUDIENCE,
      jwksUrl: env.EXTRAY_JWT_JWKS_URL,
      tokenSource: header ? { header: header.toLowerCase(), bearer: false } : undefined,
      emailClaim: env.EXTRAY_JWT_EMAIL_CLAIM,
      adminEmails: env.ADMIN_EMAILS,
      keySource,
    }),
  };
}

/**
 * Pick the auth mode from configuration, failing closed: a mode that is asked
 * for but under-configured throws (AuthConfigError) instead of degrading to a
 * weaker mode. `keySource` is injectable for tests only.
 *
 * Inference order when EXTRAY_AUTH is unset puts Cloudflare first, matching the
 * pre-W2.2 behavior of the deployed Worker.
 */
export function selectAuth(env: AuthEnv, keySource?: JWTVerifyGetKey): AuthSelection {
  const explicit = env.EXTRAY_AUTH?.trim().toLowerCase();
  switch (explicit) {
    case undefined:
    case "":
      break;
    case "none":
      return { mode: "none", resolver: null };
    case "token":
      if (!env.EXTRAY_TOKEN) throw new AuthConfigError("EXTRAY_AUTH=token requires EXTRAY_TOKEN");
      return { mode: "token", resolver: sharedTokenRoleResolver(env.EXTRAY_TOKEN) };
    case "jwt":
      return jwtSelection(env, keySource);
    case "cloudflare-access":
      return { mode: "cloudflare-access", resolver: cloudflareAccessRoleResolver(env, keySource) };
    default:
      throw new AuthConfigError(`unknown EXTRAY_AUTH=${explicit} (expected none, token, jwt, or cloudflare-access)`);
  }
  // Inferred.
  if (env.ACCESS_TEAM || env.ACCESS_AUD) {
    return { mode: "cloudflare-access", resolver: cloudflareAccessRoleResolver(env, keySource) };
  }
  if (env.EXTRAY_JWT_ISSUER || env.EXTRAY_JWT_AUDIENCE) return jwtSelection(env, keySource);
  if (env.EXTRAY_TOKEN) return { mode: "token", resolver: sharedTokenRoleResolver(env.EXTRAY_TOKEN) };
  return { mode: "none", resolver: null };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "0:0:0:0:0:0:0:1"]);

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return LOOPBACK.has(h) || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * The one rule that makes mode "none" safe to keep as the default: it is only
 * reachable from the machine it runs on. Binding anywhere else without auth
 * (0.0.0.0 on a VPS being the obvious foot-gun) refuses to start rather than
 * publishing an admin-by-default API to the network.
 */
export function assertBindAllowed(host: string, mode: AuthMode): void {
  if (mode !== "none" || isLoopbackHost(host)) return;
  throw new AuthConfigError(
    `refusing to bind ${host} with no authentication configured. ` +
      `Set EXTRAY_TOKEN=<secret> for a shared-token deployment, or EXTRAY_JWT_ISSUER + ` +
      `EXTRAY_JWT_AUDIENCE to verify tokens from an identity provider / forward-auth proxy. ` +
      `Without either, bind a loopback address (--host 127.0.0.1).`,
  );
}
