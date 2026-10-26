// Cloudflare Worker entry: the same Hono app as scripts/serve.ts, booted
// from request bindings — D1 for data, configurable authentication for
// role resolution, and the R2-backed source reader when the SOURCE bucket is
// bound (without it the source endpoint degrades to 404, same as before).
// Static assets (web/explorer/dist) are served by the assets pipeline in
// wrangler.jsonc; only /api/* reaches this script (run_worker_first).
//
// Role resolution picks by configuration (src/server/auth.ts — shared with the
// Node launcher so both runtimes select modes identically), failing closed:
//   any auth mode configured    → that mode's resolver (Cloudflare Access,
//                                 generic JWT/OIDC, or a shared token).
//   EXPLORER_DEV_ROLES = "1"    → header-asserted roles, LOCAL `wrangler dev`
//                                 ONLY — never set this on a deployment.
//   neither                     → every request 401s (misconfigured deploy
//                                 exposes nothing).

import { createApp } from "./app.ts";
import { selectAuth, type AuthEnv } from "./auth.ts";
import { devRoleResolver, type RoleResolver } from "./role.ts";
import { D1DataSource, type D1DatabaseLike } from "../product/datasource-d1.ts";
import { r2SourceReader, type R2BucketLike } from "./source-r2.ts";
import { resolveProfile } from "../product/profile.ts";

interface Env extends AuthEnv {
  DB: D1DatabaseLike;
  SOURCE?: R2BucketLike;
  EXPLORER_PROFILE?: string;
  SUBMISSION_DAILY_LIMIT?: string;
  EXPLORER_DEV_ROLES?: string;
}

/** Exported for tests (test/worker-role.test.ts). */
export function roleResolverFor(env: Env): RoleResolver {
  // A configured mode always wins over the dev shim: `npm run explorer:cf:dev`
  // passes EXPLORER_DEV_ROLES alongside wrangler.jsonc's ACCESS_* vars, and
  // .dev.vars blanks those to opt into the shim — never the other way round.
  // A half-configured mode throws here, which 500s every request rather than
  // silently falling through to something weaker.
  const { resolver } = selectAuth(env);
  if (resolver) return resolver;
  if (env.EXPLORER_DEV_ROLES === "1") {
    // Defense in depth: the dev shim asserts roles from a header, so even if
    // EXPLORER_DEV_ROLES leaks onto a deployment it only answers on loopback
    // hostnames — `wrangler dev` serves localhost/127.0.0.1, a real deploy
    // never does.
    const dev = devRoleResolver({ EXPLORER_ROLE: "admin" });
    return (c) => {
      const hostname = new URL(c.req.url).hostname;
      if (hostname !== "localhost" && hostname !== "127.0.0.1") {
        return c.json({ error: "auth not configured" }, 401);
      }
      return dev(c);
    };
  }
  return (c) => c.json({ error: "auth not configured" }, 401);
}

export default {
  fetch(req: Request, env: Env): Response | Promise<Response> {
    // Binding-only updates can reuse this isolate. Construct request state from
    // the current bindings so revoked credentials and replaced storage/config
    // take effect immediately; auth.ts separately reuses public signing keys.
    const app = createApp({
      ds: new D1DataSource(env.DB),
      profile: resolveProfile({ EXPLORER_PROFILE: env.EXPLORER_PROFILE }),
      roleResolver: roleResolverFor(env),
      submissionDailyLimit: Number(env.SUBMISSION_DAILY_LIMIT) || undefined,
      sourceReader: env.SOURCE ? r2SourceReader(env.SOURCE) : undefined,
    });
    return app.fetch(req, env);
  },
};
