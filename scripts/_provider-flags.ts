// The provider/model flags every LLM-spending CLI shares, in one place so
// assess / scorecard / reports cannot drift apart on how an endpoint is chosen.
// The flags are thin: they only override what src/llm/provider.ts already
// resolves from env, and they drive BOTH the LlmClient arms and the pi arm.

import type { Command } from "commander";
import { PROVIDER_IDS } from "../src/llm/provider.ts";
import { renderModelTable } from "../src/llm/model-table.ts";

/** The shape commander parses these flags into. */
export interface ProviderFlags {
  provider?: string;
  baseUrl?: string;
}

/** Defaults from the Explorer Settings file, for the callers that read it (only
 *  `assess` does; `scorecard` and `reports` deliberately do not, so their runs
 *  stay reproducible from flags + env alone). Passing them as commander defaults
 *  keeps the precedence honest: an explicit flag still wins, and an unset flag
 *  falls through to env inside resolveProvider. */
export interface ProviderDefaults {
  /** True only for a CLI that reads the Settings file; it makes --help say so. */
  fromSettings?: boolean;
  provider?: string;
  baseUrl?: string;
}

export function addProviderOptions(program: Command, defaults: ProviderDefaults = {}): Command {
  return program
    .option(
      "--provider <id>",
      `LLM provider preset: ${PROVIDER_IDS.join(" | ")} (aliases: ollama-cloud, nim, nvidia-nim, custom); ` +
        (defaults.fromSettings ? "falls back to the Explorer Settings file, then " : "falls back to ") +
        "$EXTRAY_LLM_PROVIDER, then whichever credentials are present",
      defaults.provider,
    )
    .option(
      "--base-url <url>",
      "OpenAI-compatible base URL (the root ending in /v1), overriding the preset's; " +
        (defaults.fromSettings ? "falls back to the Explorer Settings file, then " : "falls back to ") +
        "$EXTRAY_LLM_BASE_URL / the preset's own $*_BASE_URL. A preset's env API key is only sent to that preset's own host; a custom host needs $EXTRAY_LLM_API_KEY",
      defaults.baseUrl,
    );
}

/** The known-good model table, appended to --help. */
export function providerHelpText(): string {
  return (
    `\n${renderModelTable()}\n\n` +
    "Provider config (any OpenAI-compatible endpoint):\n" +
    "  --provider ollama              $OLLAMA_API_KEY          (default when set)\n" +
    "  --provider openai              $OPENAI_API_KEY\n" +
    "  --provider nvidia              $NVIDIA_API_KEY (NVIDIA NIM; optional $NVIDIA_BASE_URL)\n" +
    "  --provider openai-compatible   $OPENAI_BASE_URL + $OPENAI_API_KEY (key optional for a local endpoint)\n" +
    "  $EXTRAY_LLM_PROVIDER / $EXTRAY_LLM_BASE_URL / $EXTRAY_LLM_API_KEY override any preset.\n" +
    "  LLM_ADAPTER=<module> stays the escape hatch for a custom adapter and wins over all of the above.\n"
  );
}
