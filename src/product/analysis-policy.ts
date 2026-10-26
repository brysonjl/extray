import type { DataSource } from "./datasource.ts";

export interface AnalysisDiscoveryQuery {
  source: "extpose" | "webstore";
  collection?: string;
  category?: string;
  limit?: number;
}
export interface AnalysisPolicy {
  version: 1;
  paused: boolean;
  maxConcurrent: 1;
  discoveryEnabled: boolean;
  discoveryEveryHours: number;
  discoveryLimit: number;
  minInstalls: number;
  excludeAnalyzed: boolean;
  retryLimit: number;
  retryBackoffMinutes: number;
  sessionCapSeconds: number;
  weeklyCapSeconds: number;
  discoveryQueries: AnalysisDiscoveryQuery[];
}
export const DEFAULT_ANALYSIS_POLICY: AnalysisPolicy = {
  version: 1, paused: false, maxConcurrent: 1, discoveryEnabled: true,
  discoveryEveryHours: 24, discoveryLimit: 15, minInstalls: 0, excludeAnalyzed: true,
  retryLimit: 8, retryBackoffMinutes: 30, sessionCapSeconds: 2700, weeklyCapSeconds: 72000,
  discoveryQueries: [{ source: "extpose", collection: "new", limit: 10 }, { source: "extpose", collection: "top-installed", limit: 5 }],
};
export class AnalysisPolicyError extends Error {}
const KEY = "analysis_policy";
const bounds = {
  discoveryEveryHours: [1, 8760], discoveryLimit: [1, 200], minInstalls: [0, 10_000_000_000],
  retryLimit: [0, 20], retryBackoffMinutes: [1, 1440], sessionCapSeconds: [1, 86400], weeklyCapSeconds: [1, 604800],
} as const;
export function validateAnalysisPolicy(input: unknown, current: AnalysisPolicy = DEFAULT_ANALYSIS_POLICY): AnalysisPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AnalysisPolicyError("runner policy must be an object");
  const raw = input as Record<string, unknown>;
  const allowed = new Set(Object.keys(DEFAULT_ANALYSIS_POLICY));
  for (const key of Object.keys(raw)) if (!allowed.has(key)) throw new AnalysisPolicyError(`unknown runner policy field "${key}"`);
  if (raw.version !== undefined && raw.version !== 1) throw new AnalysisPolicyError("unsupported runner policy version");
  if (raw.maxConcurrent !== undefined && raw.maxConcurrent !== 1) throw new AnalysisPolicyError("this executor supports one concurrent analysis");
  const next = { ...current, discoveryQueries: current.discoveryQueries.map((query) => ({ ...query })) };
  for (const key of ["paused", "discoveryEnabled", "excludeAnalyzed"] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "boolean") throw new AnalysisPolicyError(`${key} must be a boolean`);
      next[key] = raw[key];
    }
  }
  for (const key of Object.keys(bounds) as (keyof typeof bounds)[]) {
    const value = raw[key];
    if (value === undefined) continue;
    const [min, max] = bounds[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) throw new AnalysisPolicyError(`${key} must be a whole number from ${min} to ${max}`);
    next[key] = value;
  }
  if (raw.discoveryQueries !== undefined) {
    if (!Array.isArray(raw.discoveryQueries) || raw.discoveryQueries.length > 20) throw new AnalysisPolicyError("discoveryQueries must be an array of at most 20 queries");
    next.discoveryQueries = raw.discoveryQueries.map((query, index) => {
      if (!query || typeof query !== "object" || Array.isArray(query)) throw new AnalysisPolicyError(`discovery query ${index + 1} must be an object`);
      for (const key of Object.keys(query)) if (!["source", "collection", "category", "limit"].includes(key)) throw new AnalysisPolicyError(`unknown discovery query field "${key}"`);
      if (query.source !== "extpose" && query.source !== "webstore") throw new AnalysisPolicyError("discovery source must be extpose or webstore");
      const parsed: AnalysisDiscoveryQuery = { source: query.source };
      for (const key of ["collection", "category"] as const) {
        if (query[key] !== undefined && query[key] !== "") {
          if (typeof query[key] !== "string" || query[key].length > 120 || !/^[a-zA-Z0-9_/-]+$/.test(query[key])) throw new AnalysisPolicyError(`${key} must be a collection/category identifier`);
          parsed[key] = query[key];
        }
      }
      if (query.limit !== undefined) {
        if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > 200) throw new AnalysisPolicyError("query limit must be a whole number from 1 to 200");
        parsed.limit = query.limit;
      }
      return parsed;
    });
  }
  if (next.discoveryEnabled && !next.discoveryQueries.length) throw new AnalysisPolicyError("add a discovery query or disable scheduled discovery");
  return next;
}
/** Null means the runner's existing file/CLI policy remains in charge. */
export async function loadAnalysisPolicy(ds: DataSource): Promise<AnalysisPolicy | null> {
  const row = await ds.get("SELECT value FROM runner_state WHERE key=?", KEY);
  if (!row) return null;
  try { return validateAnalysisPolicy(JSON.parse(String(row.value))); }
  catch { throw new AnalysisPolicyError("Saved runner policy is invalid. Save a valid policy in Settings before resuming."); }
}
export async function readAnalysisPolicy(ds: DataSource): Promise<AnalysisPolicy> {
  const policy = await loadAnalysisPolicy(ds) ?? validateAnalysisPolicy({});
  const manual = await ds.get("SELECT value FROM runner_state WHERE key='manual_pause'");
  return manual?.value === "1" || manual?.value === "0" ? { ...policy, paused: manual.value === "1" } : policy;
}
export async function updateAnalysisPolicy(ds: DataSource, input: unknown): Promise<AnalysisPolicy> {
  let current: AnalysisPolicy;
  try { current = await readAnalysisPolicy(ds); } catch { current = DEFAULT_ANALYSIS_POLICY; }
  const next = validateAnalysisPolicy(input, current);
  await ds.run("INSERT INTO runner_state (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at", KEY, JSON.stringify(next), new Date().toISOString());
  await ds.run("DELETE FROM runner_state WHERE key='manual_pause'");
  return next;
}
