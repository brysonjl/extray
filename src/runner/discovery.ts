// Scheduled discovery: run the configured Chrome-Web-Store scrape queries
// (scripts/discover.ts — its main() is import-guarded) and enqueue fresh store
// ids as low-priority submissions. Scraping is network-only, so this runs even
// while LLM work is backed off; whether an enqueued discovery job may START is
// the budget ledger's call (src/runner/ledger.ts), not discovery's.

import { discover, loadAnalyzedIds, planWorklist, type Candidate, type DiscoverOpts } from "../../scripts/discover.ts";
import type { AnalysisPolicy } from "../product/analysis-policy.ts";
import type { SubmissionConfig } from "../product/submission-config.ts";
import type { DataSource } from "../product/datasource.ts";
import type { ProductionProfile } from "../product/profile.ts";
import { createSubmission, findActiveSubmission } from "../jobs/service.ts";
import type { DiscoveryQueryConfig, RunnerConfig } from "./config.ts";

/** Fill a configured query out to a full DiscoverOpts. English filter is
 *  always on (the D1 export drops non-English unconditionally — analyzing them
 *  would spend budget on reports that never ship); scrape pacing stays at
 *  discover's polite defaults. */
export function toDiscoverOpts(q: DiscoveryQueryConfig): DiscoverOpts {
  return {
    source: q.source,
    collection: q.collection,
    category: q.category,
    pages: 1,
    filters: {},
    sort: "none",
    limit: q.limit ?? 10,
    enrich: q.source === "webstore",
    excludeNonEnglish: true,
    concurrency: 4,
    delay: 250,
  };
}

export interface DiscoveryDeps {
  ds: DataSource;
  cfg: RunnerConfig;
  profile: ProductionProfile;
  /** Injectable for tests; defaults to the real scraper. */
  discoverImpl?: (opts: DiscoverOpts, analyzed: Set<string>) => Promise<Candidate[]>;
  loadAnalyzedImpl?: (dbPath: string) => Set<string>;
  now?: () => Date;
  log?: (msg: string) => void;
  policy?: AnalysisPolicy;
  configuration?: SubmissionConfig;
}

export interface DiscoveryResult {
  enqueued: number;
  skippedAnalyzed: number;
  skippedActive: number;
  queriesFailed: number;
}

/** One discovery pass over every configured query. A failing query (network,
 *  markup drift) is logged and skipped — discovery is best-effort background
 *  work and must never take the daemon down. */
export async function discoverAndEnqueue(deps: DiscoveryDeps): Promise<DiscoveryResult> {
  const doDiscover = deps.discoverImpl ?? discover;
  const loadAnalyzed = deps.loadAnalyzedImpl ?? loadAnalyzedIds;
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const analyzed = deps.policy?.excludeAnalyzed === false ? new Set<string>() : loadAnalyzed(deps.cfg.db);

  const result: DiscoveryResult = { enqueued: 0, skippedAnalyzed: 0, skippedActive: 0, queriesFailed: 0 };
  for (const q of deps.cfg.discovery) {
    let cands: Candidate[];
    try {
      const opts = toDiscoverOpts(q);
      if (deps.policy) opts.filters.minInstalls = deps.policy.minInstalls;
      cands = await doDiscover(opts, analyzed);
    } catch (e) {
      result.queriesFailed++;
      log(`discovery: query ${q.source}/${q.collection ?? q.category ?? "?"} failed: ${(e as Error).message}`);
      continue;
    }
    const plan = planWorklist(cands, analyzed, q.limit ?? 10);
    result.skippedAnalyzed += plan.skippedAnalyzed.length;
    for (const storeId of plan.selected.map((c) => c.storeId!)) {
      if (await findActiveSubmission(deps.ds, storeId)) {
        result.skippedActive++;
        continue;
      }
      await createSubmission(deps.ds, {
        inputRaw: storeId,
        storeId,
        profile: deps.profile,
        requestedBy: "runner:discovery",
        source: "discovery",
        priority: deps.cfg.priorities.discovery,
        now: now(),
        configuration: deps.configuration,
      });
      // Later queries in the same pass must not re-enqueue the same id.
      analyzed.add(storeId);
      result.enqueued++;
      log(`discovery: enqueued ${storeId} (${q.source}/${q.collection ?? q.category ?? "?"})`);
    }
  }
  return result;
}
