import { createExtensionRuntime, type ResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

/** No discovery at all: context files, .pi/settings.json, SYSTEM.md, skills,
 * extensions and ambient operator config are data, never analyzer resources.
 * This is stronger than DefaultResourceLoader's noContextFiles option, which
 * still discovers other resources and package configuration before filtering. */
export function createPiResources() {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  const resourceLoader: ResourceLoader = {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  return { resourceLoader, settingsManager: SettingsManager.inMemory() };
}
