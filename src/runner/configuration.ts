import { resolveSubmissionSettings } from "../server/analysis-node.ts";
import { snapshotSettings, type SubmissionConfig } from "../product/submission-config.ts";
import { validateSettings, type ExplorerSettings } from "../product/settings.ts";
import { analysisOptionsForMethodology } from "../product/analysis-config.ts";
import { resolveProvider } from "../llm/provider.ts";

/** Resolve the daemon's supported CLI invocation once at enqueue. Unknown
 * infrastructure flags keep the legacy path rather than silently dropping flags. */
export function resolveRunnerSubmissionConfig(args: string[], base: ExplorerSettings = resolveSubmissionSettings()): SubmissionConfig | undefined {
  const valueFlags: Record<string, string> = { "--methodology": "methodology", "--model": "model", "--provider": "provider", "--base-url": "baseUrl", "--think": "think", "--verifier-model": "verifierModel", "--max-tokens": "maxTokens", "--pi-subagent-model": "piSubagentModel", "--pi-synthesis-model": "piSynthesisModel", "--pi-subagent-models": "piSubagentModels", "--pi-max-turns": "piMaxTurns", "--pi-subagent-max-turns": "piSubagentMaxTurns", "--agentic-max-steps-per-dimension": "agenticMaxStepsPerDimension" };
  const flags: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--db") { i++; continue; }
    const key = valueFlags[flag];
    if (key) { if (!args[i + 1] || args[i + 1]!.startsWith("--")) return undefined; flags[key] = args[++i]; continue; }
    const switches: Record<string, [string, boolean]> = { "--force": ["forceFresh", true], "--enrich": ["enrich", true], "--no-cache": ["useCache", false], "--replay": ["replay", true], "--pi-shard": ["piShard", true], "--pi-no-pack": ["piNoPack", true] };
    if (switches[flag]) { const [k, v] = switches[flag]!; flags[k] = v; } else return undefined;
  }
  const methodology = String(flags.methodology ?? base.methodology);
  const options: Record<string, unknown> = { ...analysisOptionsForMethodology(base.options ?? {}, methodology) };
  for (const [key, value] of Object.entries(flags)) {
    if (["methodology", "model", "provider", "baseUrl"].includes(key)) continue;
    if (key === "think") { if (methodology === "monolith") options[key] = value === "true" ? true : value === "false" ? false : value; }
    else if (["maxTokens", "piMaxTurns", "piSubagentMaxTurns", "agenticMaxStepsPerDimension"].includes(key)) options[key] = Number(value);
    else if (key === "piSubagentModels") options[key] = Object.fromEntries(String(value).split(",").map((part) => part.split("=")));
    else options[key] = value;
  }
  const provider = resolveProvider({ provider: String(flags.provider ?? base.provider.id), baseUrl: typeof flags.baseUrl === "string" ? flags.baseUrl : base.provider.baseUrl });
  return snapshotSettings(validateSettings({ methodology, model: flags.model ?? base.model, provider: { id: provider.id, baseUrl: provider.baseUrl }, options }, base));
}
