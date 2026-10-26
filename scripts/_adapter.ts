// Shared LlmClient factory for the RECORD path of the assess/scorecard/reports/
// pilot CLIs.
//
// Two ways to get a client, in precedence order:
//   1. LLM_ADAPTER=<module> — the escape hatch for a custom adapter. A
//      relative/absolute path is resolved against the cwd (and turned into a
//      file URL so tsx/ESM can import it); a bare specifier is imported as a
//      package. The module's default export must be an LlmClient.
//   2. the provider presets in src/llm/provider.ts — any OpenAI-compatible
//      endpoint (base URL + API key), which is the v1 required shape. This is
//      the path a stranger takes: no repo-internal file path required.
//
// Before (2) existed, RECORD mode refused to run without
// LLM_ADAPTER=src/llm/providers/ollama-cloud.ts — a file path into the repo,
// which is a dev affordance rather than user configuration.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { LlmClient } from "../src/llm/client.ts";
import { createProviderClient, ProviderConfigError, resolveApiKey, resolveProvider, type ProviderOverrides } from "../src/llm/provider.ts";
import { ScorecardError } from "../src/scorecard/index.ts";
import { providerProvenance, type ProviderProvenance } from "../src/llm/provenance.ts";

export async function loadAdapter(
  overrides: ProviderOverrides = {},
  onProvider?: (provider: ProviderProvenance | null) => void,
): Promise<LlmClient> {
  const spec = process.env.LLM_ADAPTER;
  if (spec) {
    const ref = /^[./]|[\\/]/.test(spec) ? pathToFileURL(resolve(spec)).href : spec;
    const mod = (await import(ref)) as { default?: LlmClient };
    if (!mod.default || typeof mod.default.complete !== "function") {
      throw new ScorecardError(`LLM_ADAPTER module "${spec}" must export an LlmClient (with a complete() method) as default`);
    }
    onProvider?.(null); // arbitrary adapters own their endpoint; do not infer it from env
    return mod.default;
  }

  try {
    const provider = resolveProvider(overrides);
    // Fail fast on a hosted preset with no key: the alternative is a 401 after
    // the static pipeline has already run.
    resolveApiKey(provider);
    const client = createProviderClient(provider);
    onProvider?.(providerProvenance({ id: provider.id, baseUrl: provider.baseUrl }));
    return client;
  } catch (e) {
    // A provider misconfiguration is a config/usage error (exit 2), same class
    // as a bad flag — not an analysis failure.
    if (e instanceof ProviderConfigError) throw new ScorecardError(e.message);
    throw e;
  }
}
