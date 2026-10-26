// Worker role-resolver selection (src/server/worker.ts): the EXPLORER_DEV_ROLES
// header-asserted shim must only answer on loopback hostnames (`wrangler dev`),
// so setting it on a real deployment is inert — every request fails closed.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { roleResolverFor } from "../src/server/worker.ts";
import { roleMiddleware, type AppEnv } from "../src/server/role.ts";

type WorkerEnv = Parameters<typeof roleResolverFor>[0];

function appWith(env: WorkerEnv): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", roleMiddleware(roleResolverFor(env)));
  app.get("/whoami", (c) => c.json({ role: c.get("role") }));
  return app;
}

// The resolver never touches the DB binding.
const DB = {} as WorkerEnv["DB"];

describe("worker role resolver selection", () => {
  it("dev shim answers on loopback hostnames only", async () => {
    const app = appWith({ DB, EXPLORER_DEV_ROLES: "1" });
    const local = await app.request("http://localhost:8787/whoami");
    expect(local.status).toBe(200);
    expect(await local.json()).toEqual({ role: "admin" });
    expect((await app.request("http://127.0.0.1:8787/whoami")).status).toBe(200);
    // Same env leaked onto a deployed hostname: fail closed.
    expect((await app.request("https://extray.example.com/whoami")).status).toBe(401);
  });

  it("unconfigured env fails closed everywhere", async () => {
    const app = appWith({ DB });
    expect((await app.request("http://localhost/whoami")).status).toBe(401);
  });

  // W2.2 (OSS release plan §B.3.4): the Worker is now one of several auth
  // adapters, so a configured mode must beat the dev shim even where the shim
  // would have answered — otherwise a leaked EXPLORER_DEV_ROLES would *widen*
  // access on a box that had deliberately configured a credential.
  it("a configured mode outranks the dev shim, even on loopback", async () => {
    const app = appWith({ DB, EXTRAY_TOKEN: "s3cret", EXPLORER_DEV_ROLES: "1" });
    expect((await app.request("http://localhost:8787/whoami")).status).toBe(401);
    const authed = await app.request("http://localhost:8787/whoami", {
      headers: { authorization: "Bearer s3cret" },
    });
    expect(authed.status).toBe(200);
    expect(await authed.json()).toEqual({ role: "admin" });
  });
});
