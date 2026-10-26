// Role resolution middleware. Local dev uses a shim (EXPLORER_ROLE default +
// an x-explorer-role override header so the UI's dev switcher can preview the
// User lens); the published app swaps this for Access-JWT verification
// (access.ts) with the SAME contract: every request gets exactly one resolved
// role, and DTOs are built from it server-side (plan §5). A client asserting
// its own role is acceptable only because the local server binds to 127.0.0.1.
//
// A resolver may return a Response instead of a role (401 for a missing or
// invalid credential — fail closed), and may be async (JWT verification).

import type { Context, MiddlewareHandler } from "hono";
import type { Role } from "../product/profile.ts";

export type AppEnv = { Variables: { role: Role; email?: string } };

export type RoleResolver = (c: Context<AppEnv>) => Role | Response | Promise<Role | Response>;

function isRole(v: unknown): v is Role {
  return v === "user" || v === "admin";
}

/** Dev shim: per-request x-explorer-role header wins, else the configured
 *  default (EXPLORER_ROLE, falling back to admin for operator convenience). */
export function devRoleResolver(env: Record<string, string | undefined> = process.env): RoleResolver {
  const configured = env.EXPLORER_ROLE;
  const fallback: Role = isRole(configured) ? configured : "admin";
  return (c) => {
    const header = c.req.header("x-explorer-role");
    return isRole(header) ? header : fallback;
  };
}

export function roleMiddleware(resolve: RoleResolver): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const resolved = await resolve(c);
    if (resolved instanceof Response) return resolved;
    c.set("role", resolved);
    await next();
  };
}
