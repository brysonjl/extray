// Per-step token + cost accounting. Wraps any LlmClient and aggregates usage
// by (request label, model) — i.e. by pipeline step: "monolith" (generation),
// "verify:claim" (013's verifier fan-out), "judge:*", "normalize:tier". This is
// the full-run accounting the summed MethodologyOutput.usage cannot give: it
// separates what verification costs from what generation costs, and it counts
// the judge/normalize calls that the scorecard's arm-cost metric deliberately
// excludes (previously a documented undercount).
//
// Cost rates are user-supplied (USD per **1 million tokens**, per model id,
// with an optional "default" fallback) because provider pricing changes and
// must not be baked into code. Models with no rate are surfaced loudly in the
// result (`uncostedModels`) instead of silently contributing $0 — a partial
// total that LOOKS complete is worse than no total.
//
// Works identically in RECORD and REPLAY: fixtures persist the live call's
// token counts, so replayed runs report the same usage (wall-clock reads 0).

import { readFileSync } from "node:fs";
import type { LlmClient, LlmRequest, LlmResponse } from "./client.ts";

export interface UsageEntry {
  /** Request label = pipeline step ("monolith", "verify:claim", "judge:must_detect", …). */
  label: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Summed live wall-clock; 0 under replay. */
  wallClockMs: number;
}

/** USD per 1M tokens. */
export interface CostRate {
  input: number;
  output: number;
}

/** Model id → rate; the "default" key is the fallback for unlisted models. */
export type CostRates = Record<string, CostRate>;

export class CostRatesError extends Error {}

/**
 * Parse a --cost-rates / $LLM_COST_RATES value: inline JSON (starts with "{")
 * or a path to a JSON file. Shape: {"<model-id>": {"input": <usd/1M>, "output": <usd/1M>}, "default": {...}?}.
 * Absent/empty → undefined (token counts only, no $ estimates).
 */
export function parseCostRates(raw: string | undefined): CostRates | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const text = raw.trim().startsWith("{") ? raw : readFile(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new CostRatesError(`cost rates are not valid JSON: ${(e as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CostRatesError("cost rates must be a JSON object: {\"<model>\": {\"input\": <usd/1M>, \"output\": <usd/1M>}}");
  }
  const rates: CostRates = {};
  for (const [model, rate] of Object.entries(parsed as Record<string, unknown>)) {
    const r = rate as Record<string, unknown> | null;
    if (!r || typeof r !== "object" || typeof r.input !== "number" || typeof r.output !== "number" || r.input < 0 || r.output < 0) {
      throw new CostRatesError(`cost rate for "${model}" must be {"input": <usd/1M ≥ 0>, "output": <usd/1M ≥ 0>}`);
    }
    rates[model] = { input: r.input, output: r.output };
  }
  return rates;
}

function readFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new CostRatesError(`could not read cost-rates file "${path}": ${(e as Error).message}`);
  }
}

/** USD cost of one entry under `rates`, or null when its model has no rate. */
export function costOf(entry: Pick<UsageEntry, "model" | "inputTokens" | "outputTokens">, rates: CostRates): number | null {
  const rate = rates[entry.model] ?? rates.default;
  if (!rate) return null;
  return (entry.inputTokens / 1e6) * rate.input + (entry.outputTokens / 1e6) * rate.output;
}

export interface CostSummary {
  entries: Array<UsageEntry & { estimatedUsd: number | null }>;
  totals: { calls: number; inputTokens: number; outputTokens: number; wallClockMs: number };
  /** Sum over costed entries; null when no rates were supplied at all. */
  estimatedUsd: number | null;
  /** Models that appeared in the run but have no rate — their cost is NOT in estimatedUsd. */
  uncostedModels: string[];
}

export function summarizeCost(entries: UsageEntry[], rates?: CostRates): CostSummary {
  const costed = entries.map((e) => ({ ...e, estimatedUsd: rates ? costOf(e, rates) : null }));
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0, wallClockMs: 0 };
  for (const e of entries) {
    totals.calls += e.calls;
    totals.inputTokens += e.inputTokens;
    totals.outputTokens += e.outputTokens;
    totals.wallClockMs += e.wallClockMs;
  }
  const uncosted = [...new Set(costed.filter((e) => rates && e.estimatedUsd === null).map((e) => e.model))];
  const estimatedUsd = rates ? costed.reduce((s, e) => s + (e.estimatedUsd ?? 0), 0) : null;
  return { entries: costed, totals, estimatedUsd, uncostedModels: uncosted };
}

/**
 * LlmClient wrapper that aggregates usage per (label, model). Wrap the
 * outermost client (e.g. the RecordReplayClient) so every call — methodology,
 * verifier, judge, normalizer — is counted exactly once.
 */
export class UsageTracker implements LlmClient {
  readonly #wrapped: LlmClient;
  readonly #byStep = new Map<string, UsageEntry>();

  constructor(wrapped: LlmClient) {
    this.#wrapped = wrapped;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.#wrapped.complete(req);
    const key = `${req.label} ${req.model}`;
    let entry = this.#byStep.get(key);
    if (!entry) {
      entry = { label: req.label, model: req.model, calls: 0, inputTokens: 0, outputTokens: 0, wallClockMs: 0 };
      this.#byStep.set(key, entry);
    }
    entry.calls++;
    entry.inputTokens += res.usage.inputTokens;
    entry.outputTokens += res.usage.outputTokens;
    entry.wallClockMs += res.usage.wallClockMs ?? 0;
    return res;
  }

  /** Fold in a usage row for a step that did NOT go through this client (e.g. the
   *  Pi arm's own model session). Merged by (label, model) exactly like a tracked
   *  call, so it appears in the breakdown / table / DB rows and reconciles to the
   *  report aggregate. */
  addExternal(line: { label: string; model: string; inputTokens: number; outputTokens: number; calls?: number; wallClockMs?: number }): void {
    const key = `${line.label} ${line.model}`;
    let entry = this.#byStep.get(key);
    if (!entry) {
      entry = { label: line.label, model: line.model, calls: 0, inputTokens: 0, outputTokens: 0, wallClockMs: 0 };
      this.#byStep.set(key, entry);
    }
    entry.calls += line.calls ?? 1;
    entry.inputTokens += line.inputTokens;
    entry.outputTokens += line.outputTokens;
    entry.wallClockMs += line.wallClockMs ?? 0;
  }

  /** Per-step aggregates, in first-seen order. */
  breakdown(): UsageEntry[] {
    return [...this.#byStep.values()].map((e) => ({ ...e }));
  }

  summary(rates?: CostRates): CostSummary {
    return summarizeCost(this.breakdown(), rates);
  }
}

const fmtUsd = (v: number | null): string => (v === null ? "n/a" : `$${v.toFixed(4)}`);

/** Markdown table of per-step usage (+ $ estimates when rates are supplied). */
export function renderUsageTable(summary: CostSummary): string {
  const L: string[] = [];
  L.push("| step | model | calls | in tokens | out tokens | est. cost |");
  L.push("| --- | --- | ---: | ---: | ---: | ---: |");
  for (const e of summary.entries) {
    L.push(`| ${e.label} | ${e.model} | ${e.calls} | ${e.inputTokens} | ${e.outputTokens} | ${fmtUsd(e.estimatedUsd)} |`);
  }
  const t = summary.totals;
  L.push(`| **total** | | ${t.calls} | ${t.inputTokens} | ${t.outputTokens} | ${fmtUsd(summary.estimatedUsd)} |`);
  if (summary.uncostedModels.length > 0) {
    L.push("");
    L.push(`> ⚠ no cost rate for: ${summary.uncostedModels.join(", ")} — their cost is NOT included in the total.`);
  }
  return L.join("\n");
}
