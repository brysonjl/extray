import type { SubmissionConfig } from "./submission-config.ts";

/** Portable, admin-only projections. Unknown metadata is null, never invented. */
export type AnalysisStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";
export type AnalysisSource = "user" | "remote" | "discovery" | "admin";
export interface AnalysisCounts {
  queued: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled?: number;
  ready: number | null;
  delayed: number | null;
}
export interface AnalysisRow {
  jobId: number;
  batchId: string | null;
  storeId: string | null;
  name: string | null;
  status: AnalysisStatus;
  source: AnalysisSource | null;
  priority: number | null;
  /** Automatic requeues after transient failures or rate limits, not total executions. */
  retryCount: number | null;
  notBefore: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  resultReportId: number | null;
  cancelRequestedAt?: string | null;
  retryOf?: number | null;
  currentStage?: string | null;
  eligibility: "ready" | "retry-delay" | "unknown" | "not-applicable";
}
export interface AnalysisList {
  rows: AnalysisRow[];
  total: number;
  page: number;
  pageSize: number;
  observedAt: string;
  /** All jobs, independent of list filters. */
  counts: AnalysisCounts;
  queueMetadataAvailable: boolean;
}
export interface AnalysisEvent {
  id: number; sequence: number; attemptId: number | null; kind: string; stage: string | null; message: string; createdAt: string;
}
export interface AnalysisAttempt {
  id: number; status: string; startedAt: string; finishedAt: string | null; error: string | null;
}
export interface AnalysisDetail extends AnalysisRow {
  attempts?: AnalysisAttempt[];
  events?: AnalysisEvent[];
  /** Historical catalog pin; this is not an effective execution configuration. */
  profile: { methodology: string; model: string } | null;
  configuration: SubmissionConfig | null;
  /** Only present when the recorded report remains navigable. */
  result: {
    reportId: number;
    storeId: string;
    methodology: string;
    model: string;
    tier: string | null;
    costUsd: number | null;
    assessedAt: string;
    outcome?: { investigation: "complete" | "incomplete"; final_submission: "accepted" | "not-accepted"; reasons: string[] };
  } | null;
}
export interface RunnerSnapshot {
  mode: "local" | "external";
  observedAt: string;
  liveness: "online" | "stale" | "offline" | "unknown";
  heartbeatAt?: string | null;
  paused?: boolean;
  progressObservedAt?: string | null;
  progressSyncedAt?: string | null;
  stateAvailable: boolean;
  queueMetadataAvailable: boolean;
  counts: AnalysisCounts;
  backoffUntil: string | null;
  pausedUntil: string | null;
  lastSyncAt: string | null;
  lastIngestAt: string | null;
  dirtyForSync: boolean | null;
}
