// Cloudflare Access adapter (deploy plan 2026-07-06-001 §D).
//
// This file used to hold the whole auth story. OSS release plan
// 2026-08-21-001 §B.3.4 (locked decision 4) demotes Cloudflare to one adapter
// among several, so the verification itself — JWT over JWKS, issuer + audience
// check, email claim → role, fail-closed 401 — moved to src/server/auth.ts and
// Access became a preset over it (`cloudflareAccessRoleResolver`): the team
// hostname is the issuer, the keys live at the fixed /cdn-cgi/access/certs
// path, and the token arrives in Cf-Access-Jwt-Assertion instead of a Bearer
// header. Nothing about the contract changed — same roles, same downgrade
// lens, same 401s — which is why test/explorer-access.test.ts is unmodified.
//
// The module stays under its historical name and signature because the deploy
// docs, wrangler.jsonc vars, and that test all reference it.

import type { JWTVerifyGetKey } from "jose";
import { cloudflareAccessRoleResolver } from "./auth.ts";
import type { RoleResolver } from "./role.ts";

export interface AccessConfig {
  /** Zero Trust team slug: https://<team>.cloudflareaccess.com */
  ACCESS_TEAM?: string;
  /** The Access application's AUD tag. */
  ACCESS_AUD?: string;
  /** Comma-separated emails that resolve to the admin role. */
  ADMIN_EMAILS?: string;
}

/** `keySource` is injectable for tests (jose.createLocalJWKSet); production
 *  uses the team's JWKS endpoint, cached by jose between requests. */
export function accessRoleResolver(env: AccessConfig, keySource?: JWTVerifyGetKey): RoleResolver {
  return cloudflareAccessRoleResolver(env, keySource);
}
