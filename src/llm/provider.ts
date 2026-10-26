// One place that answers "which endpoint, which key" for EVERY arm.
//
// Before this existed the two LLM paths were configured differently and could
// not be pointed at the same endpoint: the LlmClient arms (monolith, DAG, the
// claim-verifier) were selected by LLM_ADAPTER=<a file path into the repo> — a
// dev affordance, not user configuration — and the pi arm hard-defaulted to
// https://ollama.com/v1 + OLLAMA_API_KEY with no way to override from the CLI.
// Since pi is the default arm (docs/decisions.md § OSS product, 2026-09-09),
// both must honor the same knobs.
//
// The v1 required shape is ANY OpenAI-compatible endpoint: base URL + API key.
// Ollama Cloud, OpenAI, NVIDIA NIM and a custom endpoint are PRESETS of that shape, not
// separate adapters — adding a hosted provider should be a table entry, never a
// new code path. Native Anthropic (Messages API) is deliberately out of v1.
//
// Resolution order, most specific first:
//   1. explicit argument (a CLI flag: --provider / --base-url / --api-key)
//   2. the cross-provider env override (EXTRAY_LLM_*)
//   3. the preset's own env vars (OLLAMA_* / OPENAI_* / NVIDIA_*)
//   4. the preset default
// LLM_ADAPTER remains the escape hatch for a custom adapter and wins over all of
// it (see scripts/_adapter.ts).

import type { LlmClient } from "./client.ts";
import { createOllamaCloudClient } from "./providers/ollama-cloud.ts";
import { createOpenAiCompatibleClient } from "./providers/openai-compatible.ts";

/** A misconfigured provider: unknown preset, missing base URL, missing key. */
export class ProviderConfigError extends Error {}

export type ProviderId = "ollama" | "openai" | "nvidia" | "openai-compatible";

export const PROVIDER_IDS: readonly ProviderId[] = ["ollama", "openai", "nvidia", "openai-compatible"];

/** Accepted aliases, so `--provider custom` and `--provider ollama-cloud` work. */
const PROVIDER_ALIASES: Record<string, ProviderId> = {
  ollama: "ollama",
  "ollama-cloud": "ollama",
  openai: "openai",
  nvidia: "nvidia",
  nim: "nvidia",
  "nvidia-nim": "nvidia",
  "openai-compatible": "openai-compatible",
  compatible: "openai-compatible",
  custom: "openai-compatible",
};

interface ProviderPreset {
  id: ProviderId;
  label: string;
  /** OpenAI-compatible base URL used when nothing overrides it. */
  defaultBaseUrl?: string;
  /** Preset-specific base-URL env vars, consulted in order. */
  baseUrlEnv: readonly string[];
  /** Preset-specific API-key env vars, consulted in order. */
  apiKeyEnv: readonly string[];
  /** Where to create a key, for the missing-key error message. */
  keyHint: string;
  /** Hosted endpoints always need auth; a custom endpoint may legitimately be
   *  keyless (vLLM / LM Studio / llama.cpp on localhost), so a missing key there
   *  is a valid configuration rather than an error. */
  keyRequired: boolean;
  /** Ollama Cloud speaks its own /api/chat as well as /v1 — see `wire` below. */
  wire: "openai-completions" | "ollama-native";
}

const PRESETS: Record<ProviderId, ProviderPreset> = {
  // Ollama Cloud keeps the NATIVE wire format even though it also serves /v1.
  // The native /api/chat body carries `num_ctx`, and Ollama silently truncates
  // any prompt past a small default context window; /v1 has no equivalent field,
  // so routing Ollama through the generic adapter would quietly truncate the
  // 200k-token assess prompts. Same knobs, different wire.
  ollama: {
    id: "ollama",
    label: "Ollama Cloud",
    defaultBaseUrl: "https://ollama.com/v1",
    baseUrlEnv: ["OLLAMA_BASE_URL"],
    apiKeyEnv: ["OLLAMA_API_KEY"],
    keyHint: "create one at https://ollama.com/settings/keys",
    keyRequired: true,
    wire: "ollama-native",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    baseUrlEnv: ["OPENAI_BASE_URL"],
    apiKeyEnv: ["OPENAI_API_KEY"],
    keyHint: "create one at https://platform.openai.com/api-keys",
    keyRequired: true,
    wire: "openai-completions",
  },
  nvidia: {
    id: "nvidia",
    label: "NVIDIA NIM",
    defaultBaseUrl: "https://integrate.api.nvidia.com/v1",
    baseUrlEnv: ["NVIDIA_BASE_URL"],
    apiKeyEnv: ["NVIDIA_API_KEY"],
    keyHint: "create one at https://build.nvidia.com/",
    keyRequired: true,
    wire: "openai-completions",
  },
  // No default base URL: "custom" means the user supplies the endpoint. Covers
  // vLLM, LM Studio, llama.cpp, OpenRouter, Groq, Together, local Ollama.
  "openai-compatible": {
    id: "openai-compatible",
    label: "custom OpenAI-compatible endpoint",
    baseUrlEnv: ["OPENAI_BASE_URL"],
    apiKeyEnv: ["OPENAI_API_KEY"],
    keyHint: "whatever your endpoint issues; some self-hosted endpoints need no key at all",
    keyRequired: false,
    wire: "openai-completions",
  },
};

/** Cross-provider env overrides: they beat the preset's own vars. */
const ENV_PROVIDER = "EXTRAY_LLM_PROVIDER";
const ENV_BASE_URL = "EXTRAY_LLM_BASE_URL";
const ENV_API_KEY = "EXTRAY_LLM_API_KEY";

export interface ProviderOverrides {
  /** Preset id or alias. */
  provider?: string;
  /** OpenAI-compatible base URL, INCLUDING any /v1 suffix. */
  baseUrl?: string;
  apiKey?: string;
}

/** A fully-resolved endpoint. This is what both the LlmClient factory and the pi
 *  runner's provider registry consume, so the two can never drift. */
export interface ResolvedProvider {
  id: ProviderId;
  label: string;
  /** OpenAI-compatible base URL. Always set. */
  baseUrl: string;
  /** Absent only for an endpoint that needs no auth. */
  apiKey?: string;
  /** True when the base URL was redirected away from the preset's host, so the
   *  preset's env key was deliberately not attached (error-message hint only). */
  keyWithheld?: boolean;
  wire: ProviderPreset["wire"];
  /** Where the values came from, for the run banner (never includes the key). */
  origin: { provider: string; baseUrl: string; apiKey: string };
}

type Env = Record<string, string | undefined>;

const firstEnv = (env: Env, names: readonly string[]): { value: string; name: string } | undefined => {
  for (const name of names) {
    const value = env[name];
    if (value) return { value, name };
  }
  return undefined;
};

const trimUrl = (u: string): string => u.replace(/\/+$/, "");

export function normalizeProviderId(raw: string): ProviderId {
  const id = PROVIDER_ALIASES[raw.trim().toLowerCase()];
  if (!id) {
    throw new ProviderConfigError(
      `unknown provider "${raw}" (expected one of: ${PROVIDER_IDS.join(", ")}; aliases: ollama-cloud, nim, nvidia-nim, custom)`,
    );
  }
  return id;
}

/**
 * Which preset to use when nothing asked for one. Inferred from whichever
 * credentials are actually present so a stranger who exports OPENAI_API_KEY and
 * nothing else does not have to learn a flag; falls back to `ollama`, which
 * keeps the historical default (and therefore the historical error message)
 * when the environment is empty.
 */
function inferProviderId(env: Env): { id: ProviderId; origin: string } {
  if (env.OLLAMA_API_KEY) return { id: "ollama", origin: "inferred from OLLAMA_API_KEY" };
  if (env.OPENAI_BASE_URL) return { id: "openai-compatible", origin: "inferred from OPENAI_BASE_URL" };
  if (env.OPENAI_API_KEY) return { id: "openai", origin: "inferred from OPENAI_API_KEY" };
  // Preserve existing inference precedence when several providers are configured.
  if (env.NVIDIA_API_KEY) return { id: "nvidia", origin: "inferred from NVIDIA_API_KEY" };
  return { id: "ollama", origin: "default" };
}

/** Resolve flags + env + preset defaults into one endpoint. Throws
 *  ProviderConfigError on an unknown preset or a custom preset with no base URL. */
export function resolveProvider(overrides: ProviderOverrides = {}, env: Env = process.env): ResolvedProvider {
  let id: ProviderId;
  let providerOrigin: string;
  if (overrides.provider) {
    id = normalizeProviderId(overrides.provider);
    providerOrigin = "--provider";
  } else if (env[ENV_PROVIDER]) {
    id = normalizeProviderId(env[ENV_PROVIDER]!);
    providerOrigin = `$${ENV_PROVIDER}`;
  } else {
    const inferred = inferProviderId(env);
    id = inferred.id;
    providerOrigin = inferred.origin;
  }
  const preset = PRESETS[id];

  let baseUrl: string | undefined;
  let baseUrlOrigin: string;
  // True when the URL was chosen by an override that is independent of the
  // preset's own credentials (see the key rule below).
  let baseUrlOverridden = false;
  if (overrides.baseUrl) {
    baseUrl = overrides.baseUrl;
    baseUrlOrigin = "--base-url";
    baseUrlOverridden = true;
  } else if (env[ENV_BASE_URL]) {
    baseUrl = env[ENV_BASE_URL];
    baseUrlOrigin = `$${ENV_BASE_URL}`;
    baseUrlOverridden = true;
  } else {
    const fromPreset = firstEnv(env, preset.baseUrlEnv);
    // OLLAMA_HOST predates this module and names the NATIVE host (no /v1), so it
    // is upgraded rather than ignored — an existing .env keeps working.
    const ollamaHost = id === "ollama" && env.OLLAMA_HOST ? { value: `${env.OLLAMA_HOST.replace(/\/+$/, "")}/v1`, name: "OLLAMA_HOST" } : undefined;
    const chosen = fromPreset ?? ollamaHost;
    baseUrl = chosen?.value ?? preset.defaultBaseUrl;
    baseUrlOrigin = chosen ? `$${chosen.name}` : "preset default";
  }
  if (!baseUrl) {
    throw new ProviderConfigError(
      `provider "${id}" has no base URL — pass --base-url, or set $${ENV_BASE_URL} / $${preset.baseUrlEnv[0]} ` +
        `to your endpoint's OpenAI-compatible root (the URL ending in /v1).`,
    );
  }

  // KEY RULE: a preset's own env key (OLLAMA_API_KEY / OPENAI_API_KEY / NVIDIA_API_KEY) is a
  // credential for THAT provider, so it is attached only when the request goes
  // to that provider: the preset's default URL, or a URL that came from the
  // preset's own env vars (OLLAMA_BASE_URL / OPENAI_BASE_URL / NVIDIA_BASE_URL — the same user
  // deliberately pairing a host with its key). When the URL was redirected by
  // --base-url or $EXTRAY_LLM_BASE_URL to any other host, the preset key is NOT
  // sent — otherwise a stray override (or a shared .env) would ship the hosted
  // key to an arbitrary server. A custom host needs an explicit key: an argument
  // or $EXTRAY_LLM_API_KEY.
  const toPresetHost = !baseUrlOverridden || (preset.defaultBaseUrl !== undefined && trimUrl(baseUrl) === trimUrl(preset.defaultBaseUrl));
  let apiKey: string | undefined;
  let apiKeyOrigin: string;
  if (overrides.apiKey) {
    apiKey = overrides.apiKey;
    apiKeyOrigin = "argument";
  } else if (env[ENV_API_KEY]) {
    apiKey = env[ENV_API_KEY];
    apiKeyOrigin = `$${ENV_API_KEY}`;
  } else {
    const chosen = toPresetHost ? firstEnv(env, preset.apiKeyEnv) : undefined;
    apiKey = chosen?.value;
    apiKeyOrigin = chosen ? `$${chosen.name}` : "unset";
  }

  return {
    id,
    label: preset.label,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    ...(apiKey ? { apiKey } : {}),
    ...(!toPresetHost && !apiKey && firstEnv(env, preset.apiKeyEnv) ? { keyWithheld: true } : {}),
    wire: preset.wire,
    origin: { provider: providerOrigin, baseUrl: baseUrlOrigin, apiKey: apiKeyOrigin },
  };
}

/**
 * The key to send, enforcing the preset's requirement. A hosted preset with no
 * key is a hard configuration error (fail fast with guidance rather than a 401
 * deep inside a session); a custom endpoint with no key returns "" and sends no
 * Authorization header. Called at the point of first spend, so a static/offline
 * run never trips it.
 */
export function resolveApiKey(p: ResolvedProvider): string {
  if (p.apiKey) return p.apiKey;
  const preset = PRESETS[p.id];
  if (!preset.keyRequired) return "";
  if (p.keyWithheld) {
    throw new ProviderConfigError(
      `no API key for provider "${p.id}" (${p.label}) at ${p.baseUrl} — that is not the provider's own endpoint, so $${preset.apiKeyEnv[0]} ` +
        `is not sent there; pass this endpoint's key explicitly with $${ENV_API_KEY}.`,
    );
  }
  throw new ProviderConfigError(
    `no API key for provider "${p.id}" (${p.label}) at ${p.baseUrl} — set $${preset.apiKeyEnv[0]} or $${ENV_API_KEY} (${preset.keyHint}).`,
  );
}

/** The native host for an Ollama base URL: strip the OpenAI-compatible /v1 tail. */
export function ollamaNativeHost(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** Build the LlmClient for a resolved endpoint. The wire format is the preset's
 *  business; every caller sees only the LlmClient seam. */
export function createProviderClient(p: ResolvedProvider): LlmClient {
  if (p.wire === "ollama-native") {
    return createOllamaCloudClient({ apiKey: p.apiKey, host: ollamaNativeHost(p.baseUrl) });
  }
  return createOpenAiCompatibleClient({ baseUrl: p.baseUrl, apiKey: p.apiKey, name: p.id });
}

/** One-line, key-free description for the run banner. */
export function describeProvider(p: ResolvedProvider): string {
  return `${p.id} @ ${p.baseUrl} (${p.origin.provider}, base URL ${p.origin.baseUrl}, key ${p.apiKey ? p.origin.apiKey : "unset"})`;
}
