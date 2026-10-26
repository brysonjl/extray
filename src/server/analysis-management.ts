import type { Hono, Context } from "hono";
import type { AppEnv } from "./role.ts";
import type { DataSource } from "../product/datasource.ts";
import { DEFAULT_SETTINGS, SettingsError, type ExplorerSettings, type SettingsStore } from "../product/settings.ts";
import { AnalysisProfileError, deleteAnalysisProfile, listAnalysisProfiles, profileConfiguration, saveAnalysisProfile } from "../product/analysis-profiles.ts";
import { AnalysisPolicyError, loadAnalysisPolicy, readAnalysisPolicy, updateAnalysisPolicy } from "../product/analysis-policy.ts";
import { estimateAnalysis } from "../product/analysis-estimate.ts";

export interface AnalysisManagementDeps {
  ds: DataSource;
  enabled: boolean;
  settings?: SettingsStore;
  resolveSettings?: (settings?: ExplorerSettings) => ExplorerSettings;
  onPolicyChange?: () => void;
}
/** Register after role + CSRF middleware. Every response is administrator-only. */
export function registerAnalysisManagementRoutes(app: Hono<AppEnv>, deps: AnalysisManagementDeps): void {
  const allowed = (c: Context<AppEnv>) => deps.enabled && c.get("role") === "admin";
  const current = () => deps.resolveSettings?.() ?? deps.settings?.read() ?? DEFAULT_SETTINGS;
  const failure = (c: Context<AppEnv>, error: unknown) => {
    if (error instanceof AnalysisProfileError) return c.json({ error: error.message }, error.status);
    if (error instanceof SettingsError || error instanceof AnalysisPolicyError || error instanceof SyntaxError) return c.json({ error: error instanceof SyntaxError ? "invalid JSON body" : (error as Error).message }, 400);
    console.error("analysis management failed", error instanceof Error ? error.name : "unknown error");
    return c.json({ error: "Unable to update analysis management data." }, 500);
  };
  app.get("/api/analysis-profiles", async (c) => {
    if (!allowed(c)) return c.json({ error: "not found" }, 404);
    try { return c.json({ profiles: await listAnalysisProfiles(deps.ds) }); } catch (error) { return failure(c, error); }
  });
  app.post("/api/analysis-profiles", async (c) => {
    if (!allowed(c)) return c.json({ error: "not found" }, 404);
    try { return c.json(await saveAnalysisProfile(deps.ds, await c.req.json(), current()), 201); } catch (error) { return failure(c, error); }
  });
  app.put("/api/analysis-profiles/:id", async (c) => {
    if (!allowed(c)) return c.json({ error: "not found" }, 404);
    try { return c.json(await saveAnalysisProfile(deps.ds, await c.req.json(), current(), c.req.param("id"))); } catch (error) { return failure(c, error); }
  });
  app.delete("/api/analysis-profiles/:id", async (c) => {
    if (!allowed(c)) return c.json({ error: "not found" }, 404);
    try { await deleteAnalysisProfile(deps.ds, c.req.param("id")); return c.json({ deleted: true }); } catch (error) { return failure(c, error); }
  });
  app.post("/api/analysis-estimate", async (c) => {
    if (!allowed(c)) return c.json({ error: "not found" }, 404);
    try {
      const body = await c.req.json();
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["configuration", "targets"].includes(key))) throw new AnalysisProfileError("estimate accepts configuration and targets");
      const targets = body.targets ?? 1;
      if (!Number.isSafeInteger(targets) || targets < 1 || targets > 100) throw new AnalysisProfileError("targets must be a whole number from 1 to 100");
      return c.json(await estimateAnalysis(deps.ds, profileConfiguration(body.configuration ?? {}, current()), targets));
    } catch (error) { return failure(c, error); }
  });
  app.get("/api/runner-policy", async (c) => {
    if (!allowed(c)) return c.json({ error: "not found" }, 404);
    try { const stored = await loadAnalysisPolicy(deps.ds); return c.json({ policy: await readAnalysisPolicy(deps.ds), saved: stored !== null, applies: "next-scheduling-tick" }); } catch (error) { return failure(c, error); }
  });
  app.put("/api/runner-policy", async (c) => {
    if (!allowed(c)) return c.json({ error: "not found" }, 404);
    try {
      const policy = await updateAnalysisPolicy(deps.ds, await c.req.json()); deps.onPolicyChange?.();
      return c.json({ policy, saved: true, applies: "next-scheduling-tick" });
    } catch (error) { return failure(c, error); }
  });
}
