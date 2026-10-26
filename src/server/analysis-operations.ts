import type { Hono } from "hono";
import type { AppEnv } from "./role.ts";
import type { DataSource } from "../product/datasource.ts";
import { analysisEvents } from "../product/analyses.ts";
import { cancelSubmission, retrySubmission, reprioritizeSubmission, getSubmission, AnalysisOperationError } from "../jobs/service.ts";

/** Registered after the shared role/CSRF middleware. Hosted reads are allowed;
 * execution controls exist only when a local executor capability is injected. */
export function registerAnalysisOperations(app: Hono<AppEnv>, deps: { ds: DataSource; now?: () => Date; runSubmission?: () => void }): void {
  const now = deps.now ?? (() => new Date());
  app.get("/api/analyses/:id/events", async (c) => {
    if (c.get("role") !== "admin") return c.json({ error: "not found" }, 404);
    const raw = c.req.param("id"), after = c.req.query("after") ?? "0";
    if (!/^-?[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) return c.json({ error: "not found" }, 404);
    if (!/^\d+$/.test(after) || !Number.isSafeInteger(Number(after))) return c.json({ error: "invalid event cursor" }, 400);
    if (!(await getSubmission(deps.ds, Number(raw)))) return c.json({ error: "not found" }, 404);
    return c.json(await analysisEvents(deps.ds, Number(raw), Number(after)));
  });
  for (const action of ["cancel", "retry"] as const) app.post(`/api/analyses/:id/${action}`, async (c) => {
    if (c.get("role") !== "admin" || !deps.runSubmission) return c.json({ error: "not found" }, 404);
    const raw = c.req.param("id");
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) return c.json({ error: "not found" }, 404);
    try {
      const job = await (action === "cancel" ? cancelSubmission(deps.ds, Number(raw), now()) : retrySubmission(deps.ds, Number(raw), now()));
      deps.runSubmission();
      return c.json({ jobId: job.id, status: job.status, cancelRequestedAt: job.cancelRequestedAt ?? null, retryOf: job.retryOf ?? null }, action === "retry" ? 201 : 200);
    } catch (error) {
      if (error instanceof AnalysisOperationError) return c.json({ error: error.message }, 409);
      throw error;
    }
  });
  app.patch("/api/analyses/:id", async (c) => {
    if (c.get("role") !== "admin" || !deps.runSubmission) return c.json({ error: "not found" }, 404);
    const raw = c.req.param("id");
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) return c.json({ error: "not found" }, 404);
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ error: "expected JSON" }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "priority")) return c.json({ error: "expected {priority}" }, 400);
    const priority = (body as { priority?: unknown }).priority;
    if (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 1000) return c.json({ error: "priority must be an integer from 0 to 1000" }, 400);
    try { await reprioritizeSubmission(deps.ds, Number(raw), priority, now()); deps.runSubmission(); return c.json({ jobId: Number(raw), priority }); }
    catch (error) { if (error instanceof AnalysisOperationError) return c.json({ error: error.message }, 409); throw error; }
  });
  for (const action of ["pause", "resume"] as const) app.post(`/api/runner/${action}`, async (c) => {
    if (c.get("role") !== "admin" || !deps.runSubmission) return c.json({ error: "not found" }, 404);
    const paused = action === "pause";
    await deps.ds.run(`INSERT INTO runner_state(key,value,updated_at) VALUES('manual_pause',?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, paused ? "1" : "0", now().toISOString());
    deps.runSubmission();
    return c.json({ paused });
  });
}
