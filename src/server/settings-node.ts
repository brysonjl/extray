// Node-backed persistence for the Explorer settings (src/product/settings.ts).
// Split out for the same reason as source-node.ts: app.ts boots on Cloudflare
// Workers too and cannot import node:fs, so the store arrives as an injected
// capability and the settings routes 404 where it is absent.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { resolveProvider, type ProviderId } from "../llm/provider.ts";
import {
  DEFAULT_SETTINGS,
  parseSettingsFile,
  serializeSettings,
  type ExplorerSettings,
  type SettingsStore,
} from "../product/settings.ts";

/** Gitignored, repo-local, and NOT under .out/ — .out is routinely deleted and
 *  a stranger's API key should survive a `rm -rf .out`. */
export const DEFAULT_SETTINGS_PATH = ".extray/settings.json";

/** Where the settings file lives. $EXTRAY_SETTINGS_PATH relocates it — needed by
 *  tests (which must not read the developer's real key) and by a self-hoster
 *  keeping state outside the checkout. */
export function settingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.EXTRAY_SETTINGS_PATH || DEFAULT_SETTINGS_PATH;
}

/**
 * A settings file both `serve` and the CLI read. Reads are uncached: the CLI
 * writes the same file, and a long-lived server that cached the first read
 * would serve stale settings for the rest of its life.
 */
export function nodeSettingsStore(path = settingsPath()): SettingsStore {
  const abs = resolve(path);
  return {
    path: abs,
    read(): ExplorerSettings {
      try {
        return parseSettingsFile(readFileSync(abs, "utf8"));
      } catch {
        // No file yet is the normal first-run state, not an error.
        return DEFAULT_SETTINGS;
      }
    },
    write(s: ExplorerSettings): void {
      const dir = dirname(abs);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (basename(dir) === ".extray") chmodSync(dir, 0o700); // ours; never chmod an arbitrary parent
      // The file holds an API key: write a 0600 temp file and rename it into
      // place (atomic — a crash never leaves a truncated settings file), and
      // chmod explicitly because `mode` only applies when a file is created and
      // is filtered by umask. Pre-existing loose permissions get tightened here.
      const tmp = `${abs}.${process.pid}.tmp`;
      writeFileSync(tmp, serializeSettings(s), { encoding: "utf8", mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, abs);
      chmodSync(abs, 0o600);
    },
  };
}

/** The settings the CLI should start from. Never throws — a missing or broken
 *  file yields defaults, so `assess` stays usable with no Explorer at all. */
export function loadSettings(path = settingsPath()): ExplorerSettings {
  return nodeSettingsStore(path).read();
}

/**
 * Settings ONLY if the user actually has a settings file. The CLI needs this
 * distinction: DEFAULT_SETTINGS names a concrete model, and silently adopting
 * it as the `--model` default would change fixture keys for everyone who never
 * opened the Explorer. No file means "the user has not configured anything".
 */
export function loadSettingsIfPresent(path = settingsPath()): ExplorerSettings | null {
  return existsSync(resolve(path)) ? loadSettings(path) : null;
}

/** The preset-specific key variable a provider reads (src/llm/provider.ts). */
const PRESET_KEY_ENV: Record<ProviderId, string> = {
  ollama: "OLLAMA_API_KEY",
  openai: "OPENAI_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
};

const trimSlash = (u: string | undefined): string => (u ?? "").replace(/\/+$/, "");

/**
 * Fold a stored API key into the environment so every provider consumer finds
 * it through the one resolution path (src/llm/provider.ts) — never argv, which
 * is world-readable in `ps`.
 *
 * The stored key belongs to ONE endpoint (settings.provider.id + baseUrl), so
 * it is applied only when that endpoint is the one in effect:
 *   - `flags` (the CLI's --provider / --base-url, when given) must match the
 *     settings, otherwise the key is withheld;
 *   - $EXTRAY_LLM_PROVIDER / $EXTRAY_LLM_BASE_URL, when exported, must match too.
 * And it is written to the settings provider's OWN variable (OLLAMA_API_KEY /
 * OPENAI_API_KEY / NVIDIA_API_KEY) rather than the cross-provider $EXTRAY_LLM_API_KEY, which
 * beats every provider-specific key: with that variable an Ollama key stored in
 * settings was sent to api.openai.com under `--provider openai`. A variable the
 * user already exported is never overwritten.
 */
export function applySettingsApiKey(
  s: ExplorerSettings,
  env: NodeJS.ProcessEnv = process.env,
  flags: { provider?: string; baseUrl?: string } = {},
): void {
  const key = s.provider.apiKey;
  if (!key) return;
  const providerIn = flags.provider ?? env.EXTRAY_LLM_PROVIDER;
  const baseUrlIn = flags.baseUrl ?? env.EXTRAY_LLM_BASE_URL;
  try {
    // Resolve both endpoints so preset-specific URL overrides cannot redirect
    // a stored key either (for example NVIDIA_BASE_URL). The saved endpoint is
    // interpreted without environment overrides; the active one uses them.
    const saved = resolveProvider({ provider: s.provider.id, baseUrl: s.provider.baseUrl }, {});
    const active = resolveProvider({
      provider: providerIn ?? s.provider.id,
      baseUrl: baseUrlIn ?? s.provider.baseUrl,
    }, env);
    if (active.id !== saved.id || trimSlash(active.baseUrl) !== trimSlash(saved.baseUrl)) return;
  } catch {
    return;
  }
  const name = PRESET_KEY_ENV[s.provider.id];
  if (name && !env[name]) env[name] = key;
}
