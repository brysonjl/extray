// W2.3 — cost preflight and the --max-tokens ceiling.
//
// Without this, a user's first `--llm` run on a 50 MB minified extension spends
// 700k–1.2M input tokens with no warning, and pi (the default arm) is the
// expensive one. Two mechanisms, because one is not enough:
//
//   1. PREFLIGHT (all arms). An estimate printed BEFORE any spend, derived from
//      the evidence pack's size and a per-arm factor measured from real runs.
//      Over a threshold it asks for confirmation on an interactive terminal.
//   2. BudgetedClient (LlmClient arms). A running total that aborts cleanly the
//      moment the ceiling is crossed, so the ceiling is real and not advisory.
//
// The honest limit: the pi arm drives its own agent loop and reports usage only
// when a session ends, so it does not pass through the LlmClient seam and cannot
// be interrupted mid-session. For pi, --max-tokens is enforced at the preflight
// and checked again after the fact. renderPreflight() says so rather than
// implying a guarantee we cannot keep.

import type { LlmClient, LlmRequest, LlmResponse } from "./client.ts";
import { costOf, type CostRates } from "./usage.ts";

/** A run refused because its estimate (or its running total) exceeds the ceiling. */
export class TokenBudgetError extends Error {}

/**
 * Per-arm input-token multiplier over the evidence pack's own token count,
 * calibrated against measured bake-off runs. The pack is the one input we can
 * size before spending anything, so it is the basis — but note what drives each
 * arm's real cost:
 *
 *  - monolith / dag / agentic re-send the pack (or slices of it) a bounded number
 *    of times, so the pack really is the dominant term and the estimate is good.
 *  - pi's cost is dominated by context re-sent every turn: once N files are read,
 *    every later turn re-pays for all N. That grows ~quadratically with turns and
 *    is only loosely coupled to pack size, so its estimate is an order of
 *    magnitude, not a number. Measured: 1.19M input tokens on a ~27k-token pack
 *    (corpus mutant-i), 762k on a real extension with a much larger pack.
 */
export interface ArmCostModel {
  inputFactor: number;
  /** Output tokens as a fraction of input — small for every measured arm. */
  outputFactor: number;
  /** Half-width of the expected range, as a multiplier (2 = "within 2x"). */
  uncertainty: number;
  basis: string;
}

export const ARM_COST_MODELS: Record<string, ArmCostModel> = {
  // 29.5k input tokens against a 26.9k-token pack (mutant-i, glm-5.2).
  monolith: { inputFactor: 1.1, outputFactor: 0.13, uncertainty: 1.5, basis: "measured 29.5k input tokens on a 27k-token pack (monolith, glm-5.2)" },
  // 10 review nodes, each re-sending a pack slice, plus verification.
  dag: { inputFactor: 8, outputFactor: 0.1, uncertainty: 2, basis: "10 review nodes each re-sending a pack slice, plus the shared verifier" },
  agentic: { inputFactor: 8, outputFactor: 0.1, uncertainty: 2, basis: "superseded arm; scaled from the dag fan-out" },
  // 1.19M input tokens against a 26.9k-token pack (mutant-i, glm-5.2).
  pi: {
    inputFactor: 44,
    outputFactor: 0.03,
    uncertainty: 2,
    basis: "measured 1.19M input tokens on a 27k-token pack (pi monolithic session, glm-5.2); pi cost is driven by turns, not pack size",
  },
};

const DEFAULT_ARM_COST_MODEL: ArmCostModel = {
  inputFactor: 8,
  outputFactor: 0.1,
  uncertainty: 3,
  basis: "unknown arm — scaled from the dag fan-out, very approximate",
};

/** How much cheaper the cheapest useful arm is, for the over-budget hint. */
const MONOLITH_VS_PI = Math.round(ARM_COST_MODELS.pi!.inputFactor / ARM_COST_MODELS.monolith!.inputFactor);

/** ~4 chars per token is the anchor used throughout this codebase. */
export const CHARS_PER_TOKEN = 4;

/** Spend above which an interactive run asks before proceeding. */
export const CONFIRM_THRESHOLD_TOKENS = 500_000;

export interface PreflightInput {
  methodology: string;
  model: string;
  /** Serialized size of the evidence pack, in characters. */
  packChars: number;
  rates?: CostRates;
}

export interface Preflight {
  methodology: string;
  model: string;
  packTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  /** Total tokens the --max-tokens ceiling is compared against. */
  estimatedTotalTokens: number;
  /** null when the model has no rate in the table. */
  estimatedUsd: number | null;
  /** [low, high] total-token range at the arm's uncertainty. */
  range: [number, number];
  basis: string;
  /** True when the ceiling can be enforced mid-run rather than only up front. */
  enforceable: boolean;
}

export function estimatePreflight(input: PreflightInput): Preflight {
  const arm = ARM_COST_MODELS[input.methodology] ?? DEFAULT_ARM_COST_MODEL;
  const packTokens = Math.ceil(input.packChars / CHARS_PER_TOKEN);
  const estimatedInputTokens = Math.round(packTokens * arm.inputFactor);
  const estimatedOutputTokens = Math.round(estimatedInputTokens * arm.outputFactor);
  const estimatedTotalTokens = estimatedInputTokens + estimatedOutputTokens;
  return {
    methodology: input.methodology,
    model: input.model,
    packTokens,
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedTotalTokens,
    estimatedUsd: input.rates
      ? costOf({ model: input.model, inputTokens: estimatedInputTokens, outputTokens: estimatedOutputTokens }, input.rates)
      : null,
    range: [Math.round(estimatedTotalTokens / arm.uncertainty), Math.round(estimatedTotalTokens * arm.uncertainty)],
    basis: arm.basis,
    // pi bypasses the LlmClient seam, so only the preflight can stop it.
    enforceable: input.methodology !== "pi",
  };
}

const fmt = (n: number): string => (n >= 1_000_000 ? `${(n / 1e6).toFixed(2)}M` : n >= 1_000 ? `${Math.round(n / 1000)}k` : String(n));

export function renderPreflight(p: Preflight): string {
  const cost = p.estimatedUsd === null ? "unpriced model — no cost estimate" : `~$${p.estimatedUsd.toFixed(2)}`;
  const lines = [
    `cost preflight — methodology="${p.methodology}" model="${p.model}"`,
    `  evidence pack:   ~${fmt(p.packTokens)} tokens (chars/4 estimate; not a context-fit check)`,
    `  estimated spend: ${fmt(p.estimatedInputTokens)} in / ${fmt(p.estimatedOutputTokens)} out · ${cost}`,
    `  likely range:    ${fmt(p.range[0])}–${fmt(p.range[1])} total tokens (${p.basis})`,
  ];
  if (!p.enforceable) {
    lines.push(
      `  note:            the ${p.methodology} arm runs its own agent loop and reports tokens only when a session ends,`,
      "                   so --max-tokens is checked here and after the run, but cannot abort mid-session.",
    );
  }
  return lines.join("\n");
}

/** Refuse before spending anything when the estimate already exceeds the ceiling. */
export function enforceBudget(p: Preflight, maxTokens: number | undefined): void {
  if (maxTokens === undefined) return;
  if (p.estimatedTotalTokens > maxTokens) {
    throw new TokenBudgetError(
      `estimated ${p.estimatedTotalTokens.toLocaleString()} tokens exceeds --max-tokens ${maxTokens.toLocaleString()} — ` +
        `nothing was spent. Raise the ceiling, or use a cheaper arm: --methodology monolith is ~${MONOLITH_VS_PI}x cheaper than pi.`,
    );
  }
}

/** Does this estimate warrant an interactive confirmation? */
export function needsConfirmation(p: Preflight, threshold = CONFIRM_THRESHOLD_TOKENS): boolean {
  return p.estimatedTotalTokens > threshold;
}

/**
 * An LlmClient that keeps a running token total and throws TokenBudgetError the
 * moment the ceiling is crossed. Wraps the record/replay client, so a REPLAY run
 * (which spends nothing) is also bounded — deliberately: the ceiling is about
 * tokens, and a caller who set one wants the same behavior either way.
 *
 * The check is post-response: a single call cannot be interrupted, so the ceiling
 * is "stop before the NEXT call", which is the only thing an HTTP client can
 * honestly promise.
 */
export class BudgetedClient implements LlmClient {
  #wrapped: LlmClient;
  #maxTokens: number;
  #used = 0;

  constructor(wrapped: LlmClient, maxTokens: number) {
    this.#wrapped = wrapped;
    this.#maxTokens = maxTokens;
  }

  get used(): number {
    return this.#used;
  }

  /** Fold in tokens spent outside the seam (the pi arm's own sessions). */
  addExternal(tokens: number): void {
    this.#used += tokens;
  }

  /** Throw if the ceiling has already been crossed. Callers may use this to check
   *  a post-run total for an arm that bypasses the seam. */
  assertWithinBudget(): void {
    if (this.#used > this.#maxTokens) {
      throw new TokenBudgetError(
        `token ceiling reached: ${this.#used.toLocaleString()} tokens used, --max-tokens is ${this.#maxTokens.toLocaleString()}. ` +
          "Aborted before the next call; partial output was discarded.",
      );
    }
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.assertWithinBudget();
    const res = await this.#wrapped.complete(req);
    this.#used += res.usage.inputTokens + res.usage.outputTokens;
    return res;
  }
}
