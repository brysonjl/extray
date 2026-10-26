// The Explorer API: one Hono app, two runtimes (Node now via scripts/serve.ts,
// Cloudflare Workers later). Every response is role-scoped by the middleware —
// DTOs are built per role in src/product/dto.ts, so no admin-only byte reaches
// a User (plan §5, §11). Inherited posture from scripts/dashboard.ts: all reads
// are parameterized SQL, sort/filter names resolve against allowlists, a
// missing/empty DB degrades to empty results, and POST /api/submissions is the
// one mutation.

import { Hono } from "hono";
import { registerResultRoutes } from "./result-routes.ts";
import { registerAnalysisManagementRoutes } from "./analysis-management.ts";
import { registerAnalysisOperations } from "./analysis-operations.ts";
import { analysisDetail, AnalysisQueryError, listAnalyses, runnerSnapshot, sanitizeAnalysisDiagnostic } from "../product/analyses.ts";
import type { DataSource } from "../product/datasource.ts";
import { canonicalReport, reportById } from "../product/canonical.ts";
import { catalogMeta, catalogStats, searchCatalog } from "../product/catalog.ts";
import { buildExtensionDetail, extensionDetailFor, reportVisibleTo } from "../product/dto.ts";
import { resolveProfile, type ProductionProfile, type Role } from "../product/profile.ts";
import { redactSettings, SettingsError, validateSettings, type SettingsStore, type ExplorerSettings } from "../product/settings.ts";
import { snapshotSettings, type SubmissionConfig } from "../product/submission-config.ts";
import { parseStoreInput } from "../jobs/validate.ts";
import {
  createSubmission,
  findActiveSubmission,
  findConfiguredSubmission,
  getSubmission,
  SubmissionQuotaError,
  type SubmissionRow,
} from "../jobs/service.ts";
import { devRoleResolver, roleMiddleware, type AppEnv, type RoleResolver } from "./role.ts";
import type { MiddlewareHandler } from "hono";

export interface AppDeps {
  ds: DataSource;
  profile?: ProductionProfile;
  roleResolver?: RoleResolver;
  now?: () => Date;
  sourceReader?: SourceReader;
  /** Rolling 24h submission cap per authenticated caller (plan §12: the one
   *  paid/abuse surface). Only metered when the resolver attached an email —
   *  the local dev shim has no identity and stays uncapped. Default 20. */
  submissionDailyLimit?: number;
  /** LOCAL-ONLY admin capabilities (scripts/explorer-capabilities.ts), injected
   *  by scripts/serve.ts and absent on the Cloudflare Worker — the routes 404
   *  when missing, exactly like sourceReader. They spawn processes / scrape the
   *  web, which app.ts must stay portable of, so they arrive as opaque deps. */
  discover?: DiscoverCapability;
  analyzeBatch?: AnalyzeBatchCapability;
  /** LOCAL-ONLY settings persistence (src/server/settings-node.ts). Holds an
   *  API key, so like the capabilities above it is injected only for a loopback
   *  bind and the routes 404 without it. */
  settings?: SettingsStore;
  /** Resolve environment/provider defaults before freezing a local job. */
  resolveSubmissionSettings?: (settings?: ExplorerSettings) => ExplorerSettings;
  /** LOCAL-ONLY: one-click ingest of the labeled synthetic corpus, so a fresh
   *  database is not an empty page. Offline (committed replay fixtures). */
  ingestCorpus?: () => Promise<unknown>;
  /** LOCAL-ONLY: drains the submission queue in-process. Without it a
   *  submission is only RECORDED — which is correct for the deployed Worker
   *  (a separate drain runs the analysis) and wrong for a laptop. */
  runSubmission?: () => void;
  /** Set by scripts/serve.ts when the listener is bound to loopback. Turns on
   *  the DNS-rebinding defense (Host allowlist) and the cross-site Origin
   *  check. Absent on the Cloudflare Worker, whose Host/Origin are public. */
  loopbackGuard?: LoopbackGuard;
}

export interface LoopbackGuard {
  /** Extra Host values to accept (e.g. the public name a same-host reverse
   *  proxy forwards). Hostnames only, no port. */
  extraHosts?: string[];
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** The Vite dev server proxies to this API from these origins. */
const DEV_ORIGINS = new Set(["http://localhost:5173", "http://127.0.0.1:5173"]);

/** Hostname of a Host header value, lower-cased, port stripped; IPv6 keeps brackets. */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0] ?? "";
}

/** DNS-rebinding defense: a page on evil.example that re-points its DNS at
 *  127.0.0.1 still sends `Host: evil.example`, so refuse any Host we did not
 *  expect. */
function hostGuard(guard: LoopbackGuard): MiddlewareHandler {
  const allowed = new Set([...LOOPBACK_HOSTS, ...(guard.extraHosts ?? []).map((h) => h.toLowerCase())]);
  return async (c, next) => {
    // The URL's host is what the Node adapter built from the Host header (or
    // HTTP/2 :authority), so it is the fallback when the header is absent.
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!allowed.has(hostnameOf(host))) return c.json({ error: "forbidden host" }, 403);
    await next();
  };
}

/** CSRF defense for every state-changing request, in one place. Requiring
 *  application/json forces a cross-site caller through a CORS preflight, which
 *  this server never satisfies (Hono's c.req.json() ignores content-type, so
 *  without this a no-cors text/plain POST would be parsed). On a loopback bind
 *  an Origin header, when present, must also be a loopback origin. */
function csrfGuard(guard: LoopbackGuard | undefined): MiddlewareHandler {
  const extra = new Set((guard?.extraHosts ?? []).map((h) => h.toLowerCase()));
  const originOk = (origin: string): boolean => {
    if (DEV_ORIGINS.has(origin)) return true;
    try {
      const u = new URL(origin);
      const host = u.hostname.startsWith("[") || u.hostname.includes(":") ? `[${u.hostname.replace(/^\[|\]$/g, "")}]` : u.hostname;
      return (u.protocol === "http:" || u.protocol === "https:") && (LOOPBACK_HOSTS.has(host) || extra.has(host));
    } catch {
      return false;
    }
  };
  return async (c, next) => {
    const m = c.req.method;
    if (m === "GET" || m === "HEAD" || m === "OPTIONS") return next();
    const ct = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (ct !== "application/json") return c.json({ error: "content-type must be application/json" }, 415);
    const origin = c.req.header("origin");
    if (guard && origin !== undefined && !originOk(origin)) return c.json({ error: "forbidden origin" }, 403);
    await next();
  };
}

/** Run a discovery query and return matching extension candidates as JSON. */
export type DiscoverCapability = (params: Record<string, unknown>) => Promise<unknown>;

/** Start/track a background batch of real analyses over selected store ids. */
export interface AnalyzeBatchCapability {
  start(storeIds: string[], configuration?: SubmissionConfig): { batchId: string } | Promise<{ batchId: string }>;
  status(batchId: string): unknown | null | Promise<unknown | null>;
  /** Still-running batches, for the UI to re-attach to after navigation. */
  active(): unknown[] | Promise<unknown[]>;
}

/** Reads one file from an analyzed source tree, or null when it can't (missing,
 *  oversized, outside the allowed roots). Node injects the fs-backed reader
 *  (source-node.ts); Cloudflare injects the R2-backed one (source-r2.ts); a
 *  deployment with neither omits it and the source endpoint degrades to 404.
 *  May be sync or async. Keeps app.ts runtime-portable (no node:fs here). */
export type SourceReader = (sourceDir: string, relPath: string) => string | null | Promise<string | null>;

const STORE_ID_RE = /^[a-p]{32}$/;
/** A synthetic catalog entry: `corpus:<sample-dir>` (see src/product/canonical.ts).
 *  Kept as strict as the store-id pattern — it reaches SQL as a bound value,
 *  but a loose id would also let a caller probe for arbitrary sample names. */
const CORPUS_KEY_RE = /^corpus:[a-z0-9][a-z0-9-]{0,63}$/;

/** Ids the catalog addresses entries by. Anything else reads as "not found",
 *  the same as an unassessed extension. */
function isCatalogKey(key: string): boolean {
  return STORE_ID_RE.test(key) || CORPUS_KEY_RE.test(key);
}

/** Evidence paths come from ingested reports — treat as hostile. Relative,
 *  forward-slash, no empty/dot/dotdot segments; the reader re-checks containment
 *  at the fs layer (symlinks). */
function isSafeRelPath(p: string): boolean {
  if (!p || p.length > 512 || p.includes("\0") || p.includes("\\") || p.startsWith("/")) return false;
  return p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** Window served to the code viewer: enough context to read the finding
 *  without shipping a whole deminified bundle to the browser. */
const SOURCE_WINDOW_LINES = 120;
const MAX_SOURCE_LINE_CHARS = 500;

function sliceSource(path: string, content: string, centerLine: number | null): Record<string, unknown> {
  const all = content.split(/\r?\n/);
  const totalLines = all.length;
  let firstLine = 1;
  if (centerLine != null) {
    const c = Math.min(Math.max(centerLine, 1), totalLines);
    firstLine = Math.max(1, c - Math.floor(SOURCE_WINDOW_LINES / 2));
  }
  const lines = all
    .slice(firstLine - 1, firstLine - 1 + SOURCE_WINDOW_LINES)
    .map((l) => (l.length > MAX_SOURCE_LINE_CHARS ? `${l.slice(0, MAX_SOURCE_LINE_CHARS)} …` : l));
  return { path, firstLine, lines, totalLines };
}

/** Submission DTO (plan §14.3): job status a User can poll; cost is admin-only
 *  and only meaningful once the real pipeline lands. */
async function submissionDto(ds: DataSource, sub: SubmissionRow, role: Role): Promise<Record<string, unknown>> {
  const dto: Record<string, unknown> = {
    jobId: sub.id,
    status: sub.status,
    storeId: sub.storeId,
    createdAt: sub.createdAt,
  };
  if (sub.error) dto.error = sanitizeAnalysisDiagnostic(sub.error);
  if (sub.status === "succeeded" && sub.storeId) dto.resultStoreId = sub.storeId;
  if (role === "admin" && sub.resultReportId != null) {
    const rep = await ds.get("SELECT estimated_usd FROM report WHERE id = ?", sub.resultReportId);
    dto.costUsd = (rep?.estimated_usd as number | null) ?? null;
    dto.resultReportId = sub.resultReportId;
  }
  return dto;
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const { ds } = deps;
  const profile = deps.profile ?? resolveProfile();
  const now = deps.now ?? (() => new Date());
  const submissionDailyLimit = deps.submissionDailyLimit ?? 20;
  const app = new Hono<AppEnv>();

  function submissionConfiguration(raw: unknown): SubmissionConfig | undefined {
    if (!deps.settings || !deps.runSubmission) return undefined;
    if (raw !== undefined && (!raw || typeof raw !== "object" || Array.isArray(raw))) throw new SettingsError("configuration must be an object");
    const patch = (raw ?? {}) as Record<string, unknown>;
    if (Object.keys(patch).some((k) => !["methodology", "model", "options"].includes(k))) {
      throw new SettingsError("configuration accepts methodology, model and options; manage provider connections in Settings");
    }
    const base = deps.resolveSubmissionSettings?.() ?? deps.settings.read();
    const settings = validateSettings(patch, base);
    return snapshotSettings(deps.resolveSubmissionSettings?.(settings) ?? settings);
  }

  if (deps.loopbackGuard) app.use("*", hostGuard(deps.loopbackGuard));
  app.use("/api/*", csrfGuard(deps.loopbackGuard));
  app.use("/api/*", roleMiddleware(deps.roleResolver ?? devRoleResolver()));
  registerResultRoutes(app, { ds, profile, sourceReaderAvailable: Boolean(deps.sourceReader) });
  registerAnalysisManagementRoutes(app, {
    ds, enabled: Boolean(deps.settings && deps.runSubmission), settings: deps.settings,
    resolveSettings: deps.resolveSubmissionSettings, onPolicyChange: deps.runSubmission,
  });
  registerAnalysisOperations(app, { ds, now, runSubmission: deps.runSubmission });
  app.onError((err, c) => {
    console.error("[explorer-api]", err);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/api/meta", (c) => {
    const role = c.get("role");
    const meta = catalogMeta(role);
    if (role === "admin") meta.analyses = true;
    // Advertise the local-only Discover view to admins so the client can show
    // its nav link only where the capability is actually wired.
    if (role === "admin" && deps.discover) meta.discover = true;
    if (role === "admin" && deps.settings) meta.settings = true;
    if (role === "admin" && deps.settings && deps.runSubmission) Object.assign(meta, { analysisConfiguration: true, analysisManagement: true });
    if (role === "admin" && deps.runSubmission) Object.assign(meta, { analysisOperations: true });
    if (role === "admin" && deps.ingestCorpus) meta.corpusIngest = true;
    return c.json(meta);
  });

  // Global operational records are admin-only, regardless of presentation lens.
  app.get("/api/analyses", async (c) => {
    if (c.get("role") !== "admin") return c.json({ error: "not found" }, 404);
    try { return c.json(await listAnalyses(ds, c.req.query(), now())); }
    catch (e) { if (e instanceof AnalysisQueryError) return c.json({ error: e.message }, 400); throw e; }
  });
  app.get("/api/analyses/:id", async (c) => {
    if (c.get("role") !== "admin") return c.json({ error: "not found" }, 404);
    const raw = c.req.param("id");
    if (!/^-?[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) return c.json({ error: "not found" }, 404);
    const detail = await analysisDetail(ds, Number(raw), profile, now());
    return detail ? c.json(detail) : c.json({ error: "not found" }, 404);
  });
  app.get("/api/runner", async (c) => {
    if (c.get("role") !== "admin") return c.json({ error: "not found" }, 404);
    return c.json(await runnerSnapshot(ds, Boolean(deps.runSubmission), now()));
  });

  app.get("/api/stats", async (c) => c.json(await catalogStats(ds, c.get("role"), profile)));

  app.get("/api/catalog", async (c) => {
    const q = c.req.query();
    const result = await searchCatalog(ds, c.get("role"), profile, {
      q: q.q,
      tier: q.tier,
      access: q.access,
      developer: q.developer,
      findingType: q.findingType,
      sort: q.sort,
      page: q.page ? Number(q.page) : undefined,
      pageSize: q.pageSize ? Number(q.pageSize) : undefined,
    });
    return c.json(result);
  });

  app.get("/api/extensions/:storeId", async (c) => {
    const storeId = c.req.param("storeId");
    // Malformed ids read the same as unassessed ones: not found.
    if (!isCatalogKey(storeId)) return c.json({ error: "not found" }, 404);
    const detail = await extensionDetailFor(ds, c.get("role"), storeId, profile);
    return detail ? c.json(detail) : c.json({ error: "not found" }, 404);
  });

  // Evidence source viewer (exploration, plan-less): a line window from the
  // source tree recorded on the report's target. Only meaningful on a host
  // that still has the analyzed tree (example_crxs/ is re-fetchable, not an
  // artifact store) — absence is a normal outcome, served as 404. The report
  // is resolved with the same role scoping as the detail endpoints, so this
  // leaks nothing a caller couldn't already see.
  app.get("/api/extensions/:storeId/source", async (c) => {
    const storeId = c.req.param("storeId");
    if (!isCatalogKey(storeId)) return c.json({ error: "not found" }, 404);
    const role = c.get("role");

    const reportParam = c.req.query("report");
    let reportId: number;
    if (reportParam !== undefined) {
      if (!/^\d+$/.test(reportParam)) return c.json({ error: "not found" }, 404);
      const row = await reportById(ds, Number(reportParam), profile);
      if (!row || row.storeId !== storeId || !reportVisibleTo(row, role, profile)) {
        return c.json({ error: "not found" }, 404);
      }
      reportId = row.reportId;
    } else {
      const row = await canonicalReport(ds, role, storeId, profile);
      if (!row) return c.json({ error: "not found" }, 404);
      reportId = row.reportId;
    }

    const relPath = c.req.query("path") ?? "";
    if (!isSafeRelPath(relPath)) return c.json({ error: "invalid path" }, 400);
    if (!deps.sourceReader) return c.json({ error: "source not available on this deployment" }, 404);

    const srcRow = await ds.get(
      "SELECT t.source_dir AS d FROM report rep JOIN target t ON t.id = rep.target_id WHERE rep.id = ?",
      reportId,
    );
    const sourceDir = typeof srcRow?.d === "string" && srcRow.d !== "" ? srcRow.d : null;
    if (!sourceDir) return c.json({ error: "source not available" }, 404);

    const content = await deps.sourceReader(sourceDir, relPath);
    if (content == null) return c.json({ error: "source not available" }, 404);

    const lineParam = c.req.query("line");
    const line = lineParam !== undefined && /^\d+$/.test(lineParam) ? Number(lineParam) : null;
    return c.json(sliceSource(relPath, content, line));
  });

  app.get("/api/reports/:id", async (c) => {
    const raw = c.req.param("id");
    if (!/^\d+$/.test(raw)) return c.json({ error: "not found" }, 404);
    const role = c.get("role");
    const row = await reportById(ds, Number(raw), profile);
    // Authorization, not just redaction: a report outside the caller's allowed
    // arms is indistinguishable from one that does not exist (plan §11).
    if (!row || !reportVisibleTo(row, role, profile)) return c.json({ error: "not found" }, 404);
    const detail = await buildExtensionDetail(ds, row, role, profile);
    return detail ? c.json(detail) : c.json({ error: "not found" }, 404);
  });

  app.post("/api/submissions", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "expected a JSON body: {input}" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "expected an object" }, 400);
    const input = (body as { input?: unknown }).input;
    const force = (body as { force?: unknown }).force === true;
    const storeId = parseStoreInput(input);
    if (!storeId) {
      return c.json({ error: "input must be a 32-char extension ID or a Chrome Web Store URL" }, 400);
    }
    const role = c.get("role");
    const email = c.get("email");
    const rawConfig = (body as { configuration?: unknown }).configuration;
    if (rawConfig !== undefined && (role !== "admin" || !deps.settings || !deps.runSubmission)) return c.json({ error: "configuration is unavailable" }, 403);
    let configuration: SubmissionConfig | undefined;
    try { configuration = submissionConfiguration(rawConfig); }
    catch (e) { return c.json({ error: (e as Error).message }, 400); }
    // Dedup 1: a queued/running job for this extension — join it.
    const active = configuration ? await findConfiguredSubmission(ds, storeId, configuration) : await findActiveSubmission(ds, storeId);
    if (active) return c.json(await submissionDto(ds, active, role));
    // Dedup 2: an existing verdict — offer "view existing" unless re-analysis
    // was explicitly requested (plan §9).
    if (!force && (await canonicalReport(ds, role, storeId, profile))) {
      return c.json({ existing: true, storeId });
    }
    // The SQL insert enforces quota and dedup together, including concurrent
    // requests. Joining a job or viewing an existing verdict consumes no slot.
    const submittedAt = now();
    let sub: SubmissionRow;
    try {
      sub = await createSubmission(ds, {
        inputRaw: String(input),
        storeId,
        profile,
        requestedBy: email ?? role,
        now: submittedAt,
        deduplicate: true,
        ...(email && submissionDailyLimit > 0 ? { quota: {
          limit: submissionDailyLimit,
          since: new Date(submittedAt.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        } } : {}),
        ...(configuration ? { configuration, source: role === "admin" ? "admin" as const : "user" as const, priority: 100 } : {}),
      });
    } catch (error) {
      if (error instanceof SubmissionQuotaError) return c.json({ error: error.message }, 429);
      throw error;
    }
    // Kick the local runner when one is wired. Fire-and-forget: the response
    // is the job id, and the client polls — an analysis takes minutes.
    deps.runSubmission?.();
    return c.json(await submissionDto(ds, sub, role), 201);
  });

  app.get("/api/submissions/:jobId", async (c) => {
    const raw = c.req.param("jobId");
    if (!/^\d+$/.test(raw)) return c.json({ error: "not found" }, 404);
    const sub = await getSubmission(ds, Number(raw));
    // Ownership: job ids are sequential, so an authed user could otherwise walk
    // other users' jobs. Allow admins, the requester, or a caller who names the
    // job's storeId — possession of the storeId is exactly what the dedup
    // "join an active job" flow already required. Everything else reads as 404
    // (indistinguishable from a job that does not exist).
    const role = c.get("role");
    const email = c.get("email");
    const owns =
      sub != null &&
      (role === "admin" ||
        (email != null && sub.requestedBy === email) ||
        (sub.storeId != null && c.req.query("storeId") === sub.storeId));
    if (!sub || !owns) return c.json({ error: "not found" }, 404);
    return c.json(await submissionDto(ds, sub, role));
  });

  // The corpus is synthetic and every row it creates is badged as such; the
  // route still costs CPU and writes rows, so it is admin + local only.
  app.post("/api/corpus/ingest", async (c) => {
    if (c.get("role") !== "admin" || !deps.ingestCorpus) return c.json({ error: "not found" }, 404);
    try {
      return c.json(await deps.ingestCorpus());
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // ---- local-only admin: Settings -------------------------------------------
  // The stored API key is never in a response: redactSettings reports only
  // whether one is set (plan: no keys in localStorage, none on the wire back).
  // Settings apply to SUBSEQUENT analyses; nothing already recorded changes.

  app.get("/api/settings", (c) => {
    if (c.get("role") !== "admin" || !deps.settings) return c.json({ error: "not found" }, 404);
    return c.json({ ...redactSettings(deps.settings.read()), path: deps.settings.path });
  });

  app.put("/api/settings", async (c) => {
    if (c.get("role") !== "admin" || !deps.settings) return c.json({ error: "not found" }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "expected a JSON body" }, 400);
    }
    try {
      const next = validateSettings(body, deps.settings.read());
      deps.settings.write(next);
      return c.json({ ...redactSettings(next), path: deps.settings.path });
    } catch (e) {
      if (e instanceof SettingsError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  // ---- local-only admin: Discover & Analyze ----------------------------------
  // All three 404 unless the caller is admin AND the (Node-only) capability was
  // injected — so they simply don't exist on the deployed Cloudflare Worker.

  app.post("/api/discover", async (c) => {
    if (c.get("role") !== "admin" || !deps.discover) return c.json({ error: "not found" }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "expected a JSON body" }, 400);
    }
    try {
      return c.json(await deps.discover(body as Record<string, unknown>));
    } catch (e) {
      // Discovery is best-effort scraping — surface the upstream failure.
      return c.json({ error: (e as Error).message }, 502);
    }
  });

  app.post("/api/analyze-batch", async (c) => {
    if (c.get("role") !== "admin" || !deps.analyzeBatch) return c.json({ error: "not found" }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "expected a JSON body: {storeIds}" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ error: "expected an object" }, 400);
    const raw = (body as { storeIds?: unknown }).storeIds;
    const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && STORE_ID_RE.test(x)) : [];
    if (ids.length === 0) return c.json({ error: "storeIds must be a non-empty array of 32-char extension ids" }, 400);
    if (!Array.isArray(raw) || ids.length !== raw.length) return c.json({ error: "every batch input must be a valid extension id" }, 400);
    if (ids.length > 100) return c.json({ error: "batch too large (max 100 per launch)" }, 400);
    if ((body as { configuration?: unknown }).configuration !== undefined && (!deps.settings || !deps.runSubmission)) {
      return c.json({ error: "configuration is unavailable" }, 403);
    }
    try {
      const configuration = submissionConfiguration((body as { configuration?: unknown }).configuration);
      return c.json(await deps.analyzeBatch.start([...new Set(ids)], configuration), 202);
    } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  });

  // Still-running batches — lets the Discover page re-attach to an ongoing run
  // after the user navigated away and back (component state was lost, the
  // server-side batch was not). Declared before the :batchId route.
  app.get("/api/analyze-batch", async (c) => {
    if (c.get("role") !== "admin" || !deps.analyzeBatch) return c.json({ error: "not found" }, 404);
    return c.json({ batches: await deps.analyzeBatch.active() });
  });

  app.get("/api/analyze-batch/:batchId", async (c) => {
    if (c.get("role") !== "admin" || !deps.analyzeBatch) return c.json({ error: "not found" }, 404);
    const status = await deps.analyzeBatch.status(c.req.param("batchId"));
    return status ? c.json(status) : c.json({ error: "not found" }, 404);
  });

  app.notFound((c) => c.json({ error: "unknown endpoint" }, 404));

  return app;
}
