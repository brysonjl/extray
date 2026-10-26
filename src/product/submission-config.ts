import { resolveAnalysisDefaults } from "./analysis-config.ts";
import { validateSettings, type ExplorerSettings } from "./settings.ts";

/** Immutable non-secret settings recorded when an analysis is submitted. */
export interface SubmissionConfig extends Omit<ExplorerSettings, "provider"> {
  version: 1;
  /** Absent on legacy snapshots whose implicit defaults cannot be recovered. */
  defaultsVersion?: 1;
  defaultSemantics?: { maxTokens: "unlimited" | "explicit"; think: "provider-default" | "explicit" };
  provider: Omit<ExplorerSettings["provider"], "apiKey">;
}

export function snapshotSettings(settings: ExplorerSettings): SubmissionConfig {
  const s = validateSettings(settings);
  return {
    version: 1,
    defaultsVersion: 1,
    defaultSemantics: { maxTokens: s.options?.maxTokens === undefined ? "unlimited" : "explicit", think: s.options?.think === undefined ? "provider-default" : "explicit" },
    methodology: s.methodology,
    model: s.model,
    provider: { id: s.provider.id, ...(s.provider.baseUrl ? { baseUrl: s.provider.baseUrl } : {}) },
    options: resolveAnalysisDefaults(s.options ?? {}, s.methodology, s.model),
  };
}

/** Historical/invalid configurations remain unknown. Never echo raw JSON. */
export function parseSubmissionConfig(raw: unknown): SubmissionConfig | null {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || value.version !== 1 || typeof value.methodology !== "string" || typeof value.model !== "string" ||
      !value.provider || typeof value.provider.id !== "string") return null;
    if (value.defaultsVersion !== undefined && value.defaultsVersion !== 1) return null;
    const clean = validateSettings({
      methodology: value.methodology,
      model: value.model,
      provider: { id: value.provider.id, ...(value.provider.baseUrl ? { baseUrl: value.provider.baseUrl } : {}) },
      ...(value.options !== undefined ? { options: value.options } : {}),
    });
    if (value.defaultsVersion === 1) return snapshotSettings(clean);
    // Preserve the absence of historical defaults instead of inventing them.
    return { version: 1, methodology: clean.methodology, model: clean.model, provider: clean.provider, ...(clean.options ? { options: clean.options } : {}) };
  } catch {
    return null;
  }
}

/** Stable field ordering makes equivalent configurations share a dedup key. */
export function configurationKey(config: SubmissionConfig): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) :
    v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
  return JSON.stringify(canonical(config));
}
