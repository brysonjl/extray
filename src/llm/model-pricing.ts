// Default per-model API list pricing, in the same shape as --cost-rates / the
// CostRates type (USD per 1 MILLION tokens, split input/output). Originally
// read-time-only (the dashboard pricing stored token counts retroactively); the
// write paths (assess / scorecard / reports) now also default to this table via
// resolveEffectiveRates(), so usage/report rows land with estimated_usd instead
// of NULL. The effective table is persisted per run in run.cost_rates_json, so
// a stored $ figure stays auditable after these snapshot rates drift.
//
// IMPORTANT — what these numbers are and are NOT:
//   - The models run on **Ollama Cloud**, which bills by SUBSCRIPTION / GPU-time,
//     NOT per token. There is therefore no per-token Ollama price to read back.
//   - These rates are instead the published pay-per-token **API list prices** of
//     the underlying open-weight models (z.ai / Moonshot / MiniMax). They answer
//     "what would this exact token usage have cost at the model's own API?" — a
//     useful, provider-neutral yardstick for comparing methodologies, not a bill.
//   - They are a snapshot (see dates below) and WILL drift. Override anytime with
//     `--cost-rates <json|file>` or $LLM_COST_RATES; the dashboard prefers those.
//
// Sources (fetched 2026-06):
//   glm-5.2        z.ai, live 2026-06-16  — $1.40 in / $4.40 out per 1M (cached in $0.26)
//                    https://openrouter.ai/z-ai/glm-5.2
//   kimi-k2.7-code Moonshot, 2026-06-12   — $0.95 in / $4.00 out per 1M (cached in $0.19)
//                    https://openrouter.ai/moonshotai/kimi-k2.7-code
//   minimax-m3     MiniMax, from 2026-05-31 — $0.30 in / $1.20 out per 1M (≤512K context,
//                    a "permanent 50% off"; standard list is $0.60 / $2.40)
//                    https://openrouter.ai/minimax/minimax-m3
//
// Keyed by the model ids exactly as they appear in the DB (the `:cloud` Ollama
// tags) plus their bare base ids, so a lookup hits whether or not the tag is
// present. Unlisted models stay UNPRICED (shown as "—") rather than guessed.

import { parseCostRates, type CostRates } from "./usage.ts";

export const DEFAULT_MODEL_PRICING: CostRates = {
  "glm-5.2:cloud": { input: 1.4, output: 4.4 },
  "glm-5.2": { input: 1.4, output: 4.4 },
  "kimi-k2.7-code:cloud": { input: 0.95, output: 4.0 },
  "kimi-k2.7-code": { input: 0.95, output: 4.0 },
  "minimax-m3:cloud": { input: 0.3, output: 1.2 },
  "minimax-m3": { input: 0.3, output: 1.2 },
};

/** The effective rate card: the default table overlaid with any --cost-rates /
 *  $LLM_COST_RATES override, so one model can be re-priced without restating the
 *  whole card. Always returns a table (never undefined) — models absent from it
 *  still cost out to null and surface in `uncostedModels`, never a guessed $0. */
export function resolveEffectiveRates(raw?: string): CostRates {
  const override = parseCostRates(raw);
  return override ? { ...DEFAULT_MODEL_PRICING, ...override } : { ...DEFAULT_MODEL_PRICING };
}
