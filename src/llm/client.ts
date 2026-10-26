// Provider-agnostic LLM seam. NO concrete provider is committed in this repo
// (per docs/decisions.md the provider choice is deferred to the bake-off, idea
// #2). Everything downstream — the monolith methodology, the judge, the
// normalizer — depends only on `LlmClient`, never on a vendor SDK. The harness
// runs end-to-end in REPLAY off committed fixtures (see record-replay.ts);
// recording the first fixtures requires a dev to plug an adapter implementing
// this interface and run once in RECORD mode.

/** Token / wall-clock accounting for a single completion. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** Optional; only meaningful for live calls, omitted/zero under replay. */
  wallClockMs?: number;
  /** True when the provider omitted its input count and inputTokens is a
   *  chars-based estimate (minimax-m3 drops prompt_eval_count on ~half its
   *  responses); absent means the count is provider-reported. */
  inputTokensEstimated?: boolean;
}

/**
 * A single completion request. `label` is a short stable tag for the call site
 * (e.g. "monolith", "judge:must_detect") used in fixture keys and progress
 * output; `params` carries provider-neutral knobs (temperature, max tokens).
 */
export interface LlmRequest {
  label: string;
  model: string;
  prompt: string;
  params?: Record<string, unknown>;
}

export interface LlmResponse {
  text: string;
  usage: Usage;
}

/** The one narrow interface every caller and adapter shares. */
export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}
