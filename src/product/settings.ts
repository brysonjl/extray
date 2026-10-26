// Explorer settings: the methodology / model / provider the local install uses
// for its NEXT analysis. Two readers — the Explorer UI (src/server/app.ts) and
// the CLI (scripts/assess.ts) — so a stranger who picks a model in the browser
// gets the same arm from the command line, and vice versa.
//
// Why a file and not localStorage: settings carry an API key. A key in
// localStorage is readable by any script that ever lands on the page and is
// exactly the thing the prompt-injection caveat warns about. It stays on the
// server side, in a gitignored file, and the API never sends it back — the UI
// is told only whether a key is SET (see redactSettings).
//
// This module is runtime-portable on purpose (no node:fs): app.ts also boots on
// Cloudflare Workers, so the persistence half lives in src/server/settings-node.ts
// and arrives as an injected capability.

import { analysisOptionsArgs, analysisOptionsForMethodology, validateAnalysisOptions, type AnalysisOptions } from "./analysis-config.ts";
import { KNOWN_MODELS, modelStatus, type ModelStatus } from "../llm/model-table.ts";
import { PROVIDER_IDS, normalizeProviderId, type ProviderId } from "../llm/provider.ts";

/** A rejected settings write. Carries a message meant for the user's screen. */
export class SettingsError extends Error {}

/** The methodologies a stranger can pick from the UI. Ground-truth is an eval
 *  oracle, not a product arm, and is deliberately absent. */
export const SETTABLE_METHODOLOGIES = ["pi", "monolith", "dag", "agentic"] as const;

export interface ProviderSettings {
  id: ProviderId;
  /** OpenAI-compatible root, including /v1. Absent = use the preset default. */
  baseUrl?: string;
  /** Never leaves the server. Absent = fall back to the environment. */
  apiKey?: string;
}

export interface ExplorerSettings {
  methodology: string;
  model: string;
  provider: ProviderSettings;
  /** Saved defaults; an absent object preserves the original CLI defaults. */
  options?: AnalysisOptions;
}

/** Matches the locked default arm (docs/decisions.md § OSS product, 2026-09-09):
 *  pi is the default methodology, glm-5.2 is a measured-good model. */
export const DEFAULT_SETTINGS: ExplorerSettings = {
  methodology: "pi",
  model: "glm-5.2:cloud",
  provider: { id: "ollama" },
};

/** What the API returns. Same shape minus the secret, plus everything the UI
 *  needs to render its pickers without hardcoding a second copy of the table. */
export interface PublicSettings {
  options?: AnalysisOptions;
  methodology: string;
  model: string;
  provider: { id: ProviderId; baseUrl: string | null };
  /** Whether a key is stored here. The key itself is never serialized. */
  apiKeySet: boolean;
  /** True when a key is coming from the environment instead of this file, so
   *  the UI can say "configured elsewhere" rather than "missing". */
  apiKeyFromEnv: boolean;
  modelStatus: ModelStatus;
  choices: {
    methodologies: readonly string[];
    providers: readonly ProviderId[];
    models: readonly { family: string; status: string; note: string }[];
  };
}

export function redactSettings(s: ExplorerSettings, env: Record<string, string | undefined> = process.env): PublicSettings {
  return {
    methodology: s.methodology,
    ...(s.options ? { options: validateAnalysisOptions(s.options, s.methodology) } : {}),
    model: s.model,
    provider: { id: s.provider.id, baseUrl: s.provider.baseUrl ?? null },
    apiKeySet: Boolean(s.provider.apiKey),
    apiKeyFromEnv: !s.provider.apiKey && Boolean(env.EXTRAY_LLM_API_KEY || env.OLLAMA_API_KEY || env.OPENAI_API_KEY || env.NVIDIA_API_KEY),
    modelStatus: modelStatus(s.model),
    choices: {
      methodologies: SETTABLE_METHODOLOGIES,
      providers: PROVIDER_IDS,
      models: KNOWN_MODELS.map((m) => ({ family: m.family, status: m.status, note: m.note, unavailable: m.unavailable })),
    },
  };
}

function asString(v: unknown, field: string): string {
  if (typeof v !== "string") throw new SettingsError(`${field} must be a string`);
  return v.trim();
}

/**
 * Validate an untrusted settings body against `current`. Absent fields keep
 * their current value, so the UI can PUT a partial update; an explicitly empty
 * baseUrl/apiKey CLEARS the stored value and falls back to the preset default /
 * the environment (there has to be a way to un-set a key without editing files).
 */
export function validateSettings(input: unknown, current: ExplorerSettings = DEFAULT_SETTINGS): ExplorerSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SettingsError("expected a JSON object");
  }
  const raw = input as Record<string, unknown>;
  const next: ExplorerSettings = { ...current, provider: { ...current.provider } };

  if (raw.methodology !== undefined) {
    const m = asString(raw.methodology, "methodology");
    if (!(SETTABLE_METHODOLOGIES as readonly string[]).includes(m)) {
      throw new SettingsError(`unknown methodology "${m}" (expected one of: ${SETTABLE_METHODOLOGIES.join(", ")})`);
    }
    next.methodology = m;
  }

  if (raw.model !== undefined) {
    const m = asString(raw.model, "model");
    // Deliberately NOT restricted to the known-good table: an untested model is
    // warned about, never blocked (a new model must be usable the day it ships).
    if (m === "") throw new SettingsError("model must not be empty");
    if (m.startsWith("-") || /[\n\r\0]/.test(m)) throw new SettingsError("model must not start with a dash or contain control characters");
    if (m.length > 200) throw new SettingsError("model is implausibly long");
    next.model = m;
  }

  // A supplied object replaces options (including {}); null resets to defaults.
  // Changing methodology also discards old methodology-specific overrides.
  try {
    if (raw.options !== undefined) {
      next.options = validateAnalysisOptions(raw.options, next.methodology);
    } else if (current.options) {
      next.options = validateAnalysisOptions(
        next.methodology !== current.methodology ? analysisOptionsForMethodology(current.options, next.methodology) : current.options,
        next.methodology,
      );
    }
  } catch (error) {
    throw new SettingsError((error as Error).message);
  }

  const p = raw.provider;
  if (p !== undefined) {
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new SettingsError("provider must be an object");
    const pr = p as Record<string, unknown>;
    const before = { id: next.provider.id, baseUrl: next.provider.baseUrl };
    if (pr.id !== undefined) {
      try {
        next.provider.id = normalizeProviderId(asString(pr.id, "provider.id"));
      } catch (e) {
        throw new SettingsError((e as Error).message);
      }
    }
    if (pr.baseUrl !== undefined) {
      const url = asString(pr.baseUrl, "provider.baseUrl");
      if (url === "") delete next.provider.baseUrl;
      else next.provider.baseUrl = assertHttpUrl(url);
    }
    if (pr.apiKey !== undefined) {
      const key = asString(pr.apiKey, "provider.apiKey");
      if (key === "") delete next.provider.apiKey;
      else next.provider.apiKey = assertSafeKey(key);
    } else if (next.provider.id !== before.id || next.provider.baseUrl !== before.baseUrl) {
      // A stored key is bound to the endpoint it was entered for. Re-pointing
      // the provider without supplying a key must not carry the old key along,
      // or a forged PUT could aim the operator's key at a host of its choosing.
      delete next.provider.apiKey;
    }
  }
  return next;
}

/** Defense in depth: pi resolves key-shaped config values by running "!cmd"
 *  and expanding "$VAR", so a key that looks like either is never legitimate. */
function assertSafeKey(key: string): string {
  if (key.startsWith("!")) throw new SettingsError("provider.apiKey must not start with \"!\"");
  if (key.includes("$")) throw new SettingsError("provider.apiKey must not contain \"$\"");
  return key;
}

/** A base URL the analyzer will actually be pointed at — so it is checked here
 *  rather than surfacing as an opaque fetch failure mid-analysis. */
function assertHttpUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SettingsError(`provider.baseUrl is not a URL: "${url}"`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SettingsError(`provider.baseUrl must be http(s), got "${parsed.protocol}"`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new SettingsError("provider.baseUrl must not contain credentials, query parameters, or a fragment; use provider.apiKey for credentials");
  }
  return url.replace(/\/+$/, "");
}

/** Coerce a settings file that may have been hand-edited. Anything invalid
 *  falls back to the default rather than taking the server down — a broken
 *  settings file must not make `serve` unbootable. */
export function parseSettingsFile(text: string): ExplorerSettings {
  try {
    return validateSettings(JSON.parse(text), DEFAULT_SETTINGS);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Serialized form. The key IS written here — that is the point of a
 *  server-side, gitignored, user-owned file. */
export function serializeSettings(s: ExplorerSettings): string {
  return `${JSON.stringify(s, null, 2)}\n`;
}

/** The `assess` flags these settings mean. Keys never go on a command line
 *  (argv is world-readable in `ps`); they travel via env — see settingsEnv. */
export function settingsAssessArgs(s: ExplorerSettings): string[] {
  const args = ["--methodology", s.methodology, "--model", s.model, "--provider", s.provider.id];
  if (s.provider.baseUrl) args.push("--base-url", s.provider.baseUrl);
  if (s.options) args.push(...analysisOptionsArgs(validateAnalysisOptions(s.options, s.methodology)));
  return args;
}

/** Env for a spawned analysis, carrying the secret out-of-band from argv. */
export function settingsEnv(s: ExplorerSettings): Record<string, string> {
  return s.provider.apiKey ? { EXTRAY_LLM_API_KEY: s.provider.apiKey } : {};
}

/** Read side of the persistence capability (src/server/settings-node.ts).
 *  Injected, because app.ts must stay free of node:fs. */
export interface SettingsStore {
  read(): ExplorerSettings;
  write(s: ExplorerSettings): void;
  /** Absolute path, shown in the UI so the user knows where their key lives. */
  path: string;
}
