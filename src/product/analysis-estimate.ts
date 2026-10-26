import type { DataSource, Row } from "./datasource.ts";
import { configurationKey, type SubmissionConfig } from "./submission-config.ts";

export interface AnalysisEstimate {
  basis: "exact-configuration" | "same-methodology-model" | "unavailable";
  sampleSize: number;
  costSampleSize: number;
  tokenSampleSize: number;
  durationSampleSize: number;
  targets: number;
  cost: { medianUsd: number; lowUsd: number; highUsd: number; batchMedianUsd: number } | null;
  tokens: { median: number; low: number; high: number } | null;
  durationSeconds: { median: number; low: number; high: number } | null;
  latestAt: string | null;
  note: string;
}
function stats(values: number[]): { median: number; low: number; high: number } | null {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const quantile = (p: number) => {
    const index = (sorted.length - 1) * p, lo = Math.floor(index), hi = Math.ceil(index);
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (index - lo);
  };
  return { median: quantile(.5), low: quantile(.1), high: quantile(.9) };
}
const numbers = (rows: Row[], key: string) => rows.flatMap((row) => typeof row[key] === "number" && Number.isFinite(row[key]) && (row[key] as number) >= 0 ? [row[key] as number] : []);
/** Historical ranges, not a quote: no model calls, extension download, or assumed price table. */
export async function estimateAnalysis(ds: DataSource, configuration: SubmissionConfig, targets = 1): Promise<AnalysisEstimate> {
  if (!Number.isSafeInteger(targets) || targets < 1 || targets > 100) throw new Error("targets must be a whole number from 1 to 100");
  let rows = await ds.all(`SELECT r.estimated_usd AS cost, r.input_tokens+r.output_tokens AS tokens,
    (julianday(s.finished_at)-julianday(s.started_at))*86400 AS duration, s.finished_at AS observed
    FROM submission s JOIN report r ON r.id=s.result_report_id
    WHERE s.status='succeeded' AND s.config_key=? ORDER BY s.finished_at DESC LIMIT 100`, configurationKey(configuration));
  let basis: AnalysisEstimate["basis"] = "exact-configuration";
  if (!rows.length) {
    rows = await ds.all(`SELECT r.estimated_usd AS cost, r.input_tokens+r.output_tokens AS tokens,
      (SELECT SUM(u.wall_clock_ms)/1000.0 FROM usage u WHERE u.run_id=run.id) AS duration, run.started_at AS observed
      FROM report r JOIN run ON run.id=r.run_id JOIN target t ON t.id=r.target_id
      WHERE run.kind='assess' AND run.methodology=? AND run.model=? AND t.is_corpus=0 AND COALESCE(run.mode,'RECORD')=?
      ORDER BY run.started_at DESC LIMIT 100`, configuration.methodology, configuration.model, configuration.options?.replay ? "REPLAY" : "RECORD");
    basis = rows.length ? "same-methodology-model" : "unavailable";
  }
  const cost = stats(numbers(rows, "cost"));
  return {
    basis, sampleSize: rows.length, targets,
    costSampleSize: numbers(rows, "cost").length, tokenSampleSize: numbers(rows, "tokens").length, durationSampleSize: numbers(rows, "duration").length,
    cost: cost ? { medianUsd: cost.median, lowUsd: cost.low, highUsd: cost.high, batchMedianUsd: cost.median * targets } : null,
    tokens: stats(numbers(rows, "tokens")), durationSeconds: stats(numbers(rows, "duration")),
    latestAt: rows.length ? String(rows[0]!.observed) : null,
    note: basis === "unavailable" ? "No matching recorded analyses yet. No cost or duration estimate is available."
      : basis === "exact-configuration" ? "Observed median and 10th–90th percentile range for this configuration. Extension size, caching, model changes and investigation depth can change the result."
        : "No exact configuration history. These observations share the methodology and primary model; provider, options and extension sizes may differ. Duration is summed reported model time, not elapsed queue time.",
  };
}
