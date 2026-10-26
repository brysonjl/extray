// Local run metadata only. This describes the generation endpoint; pi can use
// another endpoint for verifier/judge calls (e.g. generation through headroom).
// Never serialize a ResolvedProvider: it contains the live API key.
import type { RunInput } from "../db/index.ts";

export interface ProviderProvenance {
  id: string;
  endpointOrigin: string;
}

/** Drop credentials, query, fragment AND path (paths can contain tokens too).
 *  Unknown/malformed/non-http endpoints stay null; never fall back to raw text. */
export function providerProvenance(endpoint: { id: string; baseUrl: string } | null): ProviderProvenance | null {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return { id: endpoint.id, endpointOrigin: url.origin };
  } catch {
    return null;
  }
}

/** Schema-free metadata: old writers and historical run hashes remain valid.
 *  The existing D1 export excludes raw_json, keeping operator endpoints local. */
export function withProviderProvenance(input: RunInput, provider: ProviderProvenance | null): RunInput {
  return { ...input, extra: { ...input.extra, provider } };
}
