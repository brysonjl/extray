import type { Hono } from "hono";
import type { AppEnv } from "./role.ts";
import type { DataSource } from "../product/datasource.ts";
import type { ProductionProfile } from "../product/profile.ts";
import { canonicalReport } from "../product/canonical.ts";
import { compareResults, resultMarkdown, resultWorkbench } from "../product/result-workbench.ts";

const reportId = (value: string | undefined): number | null => value && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
/** Register after role middleware. Every workbench endpoint is admin-only. */
export function registerResultRoutes(app: Hono<AppEnv>, deps: { ds: DataSource; profile: ProductionProfile; sourceReaderAvailable?: boolean }): void {
  const { ds, profile, sourceReaderAvailable = false } = deps;
  app.get("/api/results/compare", async (c) => {
    if (c.get("role") !== "admin") return c.json({ error: "not found" }, 404);
    const left = reportId(c.req.query("left")), right = reportId(c.req.query("right"));
    if (left === null || right === null) return c.json({ error: "Two valid report IDs are required" }, 400);
    if (left === right) return c.json({ error: "Choose two different reports" }, 400);
    const result = await compareResults(ds, left, right, profile, sourceReaderAvailable);
    return result ? c.json(result) : c.json({ error: "Reports are unavailable or belong to different extensions" }, 404);
  });
  app.get("/api/results/:id/export", async (c) => {
    if (c.get("role") !== "admin") return c.json({ error: "not found" }, 404);
    const id = reportId(c.req.param("id"));
    if (id === null) return c.json({ error: "not found" }, 404);
    const format = c.req.query("format") ?? "json";
    if (format !== "json" && format !== "markdown") return c.json({ error: "Export format must be json or markdown" }, 400);
    const result = await resultWorkbench(ds, id, profile, sourceReaderAvailable);
    if (!result) return c.json({ error: "not found" }, 404);
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Disposition", `attachment; filename="extray-report-${id}.${format === "json" ? "json" : "md"}"`);
    return format === "json" ? c.json(result) : c.body(resultMarkdown(result), 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });
  app.get("/api/results/:id", async (c) => {
    if (c.get("role") !== "admin") return c.json({ error: "not found" }, 404);
    const id = reportId(c.req.param("id"));
    const result = id === null ? null : await resultWorkbench(ds, id, profile, sourceReaderAvailable);
    return result ? c.json(result) : c.json({ error: "not found" }, 404);
  });
  app.get("/api/extensions/:storeId/result", async (c) => {
    if (c.get("role") !== "admin") return c.json({ error: "not found" }, 404);
    const row = await canonicalReport(ds, "admin", c.req.param("storeId"), profile);
    const result = row ? await resultWorkbench(ds, row.reportId, profile, sourceReaderAvailable) : null;
    return result ? c.json(result) : c.json({ error: "not found" }, 404);
  });
}
