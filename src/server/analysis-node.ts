import { DEFAULT_SETTINGS, settingsAssessArgs, validateSettings, type ExplorerSettings } from "../product/settings.ts";
import { snapshotSettings, type SubmissionConfig } from "../product/submission-config.ts";
import { resolveProvider } from "../llm/provider.ts";
import { loadSettingsIfPresent } from "./settings-node.ts";

/** Resolve the actual endpoint now so future environment edits cannot retarget queued work. */
export function resolveSubmissionSettings(settings?: ExplorerSettings): ExplorerSettings {
  const saved = settings ?? loadSettingsIfPresent();
  const provider = resolveProvider(saved ? { provider: saved.provider.id, baseUrl: saved.provider.baseUrl } : {});
  return validateSettings({
    ...(saved ?? DEFAULT_SETTINGS),
    model: saved?.model ?? process.env.SCORECARD_MODEL ?? DEFAULT_SETTINGS.model,
    provider: { id: provider.id, baseUrl: provider.baseUrl },
  });
}

export function currentSubmissionConfig(): SubmissionConfig {
  return snapshotSettings(resolveSubmissionSettings());
}

export function configuredExecution(config: SubmissionConfig): { args: string[]; env: NodeJS.ProcessEnv } {
  const saved = loadSettingsIfPresent();
  const current = resolveProvider(saved ? { provider: saved.provider.id, baseUrl: saved.provider.baseUrl } : {});
  if (current.id !== config.provider.id || current.baseUrl !== config.provider.baseUrl) {
    throw new Error("The provider connection changed after this analysis was queued. Restore the original connection or submit a new analysis.");
  }
  let storedKey: string | undefined;
  if (saved?.provider.apiKey) {
    const bound = resolveProvider({ provider: saved.provider.id, baseUrl: saved.provider.baseUrl }, {});
    if (bound.id !== current.id || bound.baseUrl !== current.baseUrl) {
      throw new Error("The saved credential belongs to a different endpoint. Update the provider connection in Settings before analyzing.");
    }
    storedKey = saved.provider.apiKey;
  }
  return {
    args: settingsAssessArgs(config),
    env: {
      EXTRAY_IGNORE_SETTINGS: "1",
      SKIP_DOTENV: "1",
      // The endpoint comparison above binds rotated credentials to the queued connection.
      EXTRAY_LLM_API_KEY: current.apiKey ?? storedKey,
      SCORECARD_THINK: undefined,
      SCORECARD_VERIFIER_MODEL: undefined,
      LLM_ADAPTER: undefined,
    },
  };
}
