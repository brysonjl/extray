import { useEffect, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiPost } from "../api";
import { Link, useNavigate } from "react-router-dom";
import type { AnalysisDetail, AnalysisRow, RunnerSnapshot } from "../../../../src/product/analysis-contract";
import { useRole } from "../role";
import { ErrorNote, Spinner } from "./ui";

export function AnalysisAccess({ children }: { children: ReactNode }) {
  const { canAnalyses, canAdmin, role, isRoleLoading } = useRole();
  if (isRoleLoading) return <Spinner label="Checking workspace access…" />;
  if (!canAnalyses && canAdmin && role === "admin") return <main className="workspace-empty"><h1>Restart the API to enable the analysis queue</h1><p>The running Explorer API does not advertise queue support. Stop the existing API process, start it again with the current code and your chosen database, then reload this page.</p><p>For the default local setup, <code>npm run explorer</code> starts both the API and UI.</p><Link to="/">Go to the catalog →</Link></main>;
  if (!canAnalyses) return <main className="workspace-empty"><h1>Analysis workspace unavailable</h1><p>This workspace requires the admin lens and queue access from this server.</p><Link to="/">Go to the catalog →</Link></main>;
  return <>{children}</>;
}

export function dateTime(value: string | null | undefined): string {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function Timestamp({ value }: { value: string | null | undefined }) {
  return value ? <time dateTime={value} title={value}>{dateTime(value)}</time> : <>Not recorded</>;
}

export function Freshness({ updatedAt, fetching, failed = false, polling = true }: { updatedAt: number; fetching: boolean; failed?: boolean; polling?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 10_000); return () => window.clearInterval(timer); }, []);
  const age = updatedAt ? Math.max(0, Math.floor((now - updatedAt) / 1000)) : null;
  const stale = failed || (polling && age !== null && age > 45);
  return <span className={`workspace-freshness ${stale ? "is-stale" : ""}`} role="status">
    <span aria-hidden="true">{stale ? "◷" : "↻"}</span>{" "}
    {fetching ? "Refreshing…" : stale ? "Refresh delayed" : age === null ? "Waiting for snapshot" : `Updated ${age < 10 ? "just now" : age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`}`}
    <span className="freshness-detail"> · {polling ? "refreshes every 10s" : "recorded analysis"}</span>
  </span>;
}

export function StatusBadge({ status, eligibility }: Pick<AnalysisRow, "status" | "eligibility">) {
  const delayed = status === "queued" && eligibility === "retry-delay";
  return <span className={`analysis-status state-${delayed ? "delayed" : status}`}>
    <span aria-hidden="true">{status === "succeeded" ? "✓" : status === "failed" ? "!" : delayed ? "◷" : status === "running" ? "◉" : "○"}</span>
    {delayed ? "Retry delay" : status === "succeeded" ? "Finished" : status.charAt(0).toUpperCase() + status.slice(1)}
  </span>;
}

export function waitingReason(row: AnalysisRow): string {
  if (row.status === "cancelled") return "Cancellation acknowledged";
  if (row.status === "running" && row.cancelRequestedAt) return "Cancellation requested · awaiting process exit";
  if (row.status === "running") return row.currentStage ? row.currentStage.replaceAll("-", " ") : "Executor starting analysis";
  if (row.status === "succeeded") return row.resultReportId ? "Recorded result" : "Execution finished · result unavailable";
  if (row.status === "failed") return row.error || "Execution failed · no diagnostic recorded";
  if (row.eligibility === "retry-delay") return `Eligible after ${dateTime(row.notBefore)}`;
  if (row.eligibility === "ready") return "Eligible for the next available executor";
  return "Recorded in queue · execution status unavailable";
}

export function RunnerSummary({ runner }: { runner: RunnerSnapshot }) {
  const paused = runner.paused || runner.pausedUntil && new Date(runner.pausedUntil).getTime() > new Date(runner.observedAt).getTime();
  const backoff = runner.backoffUntil && new Date(runner.backoffUntil).getTime() > new Date(runner.observedAt).getTime();
  return <section className="runner-summary" aria-label="Runner snapshot">
    <div className="runner-summary-title"><span className="workspace-eyebrow">Execution snapshot</span><strong>{paused ? "Runner pause recorded" : backoff ? "Rate-limit backoff" : runner.mode === "local" ? "Local execution" : "External execution"}</strong><span className="runner-unknown">{runner.liveness === "online" ? "Executor online" : runner.liveness === "stale" ? "Heartbeat stale" : runner.liveness === "offline" ? "Executor idle / stopped" : "Worker liveness unknown"}</span></div>
    <dl className="runner-facts">
      <div><dt>Scheduling</dt><dd>{paused ? runner.paused ? <>Paused by operator</> : <>Paused until <Timestamp value={runner.pausedUntil} /></> : backoff ? <>Backoff until <Timestamp value={runner.backoffUntil} /></> : runner.stateAvailable ? "No pause or backoff recorded" : "State unavailable"}</dd></div>
      <div><dt>Last catalog sync</dt><dd><Timestamp value={runner.lastSyncAt} />{runner.dirtyForSync === true ? <span className="sync-pending">Changes pending</span> : null}</dd></div>
      <div><dt>Last remote ingest</dt><dd><Timestamp value={runner.lastIngestAt} /></dd></div>
    </dl>
    <p className="runner-caption">Snapshot <Timestamp value={runner.observedAt} />. {runner.heartbeatAt ? <>Last executor heartbeat <Timestamp value={runner.heartbeatAt} />.</> : "No authoritative executor heartbeat recorded."}{runner.progressSyncedAt ? <> Hosted progress received <Timestamp value={runner.progressSyncedAt} />.</> : null}</p>
  </section>;
}


export function AnalysisControls({ job, enabled, onUpdated }: { job: AnalysisDetail; enabled: boolean; onUpdated: () => void }) {
  const { role } = useRole();
  const navigate = useNavigate();
  const [priority, setPriority] = useState(String(job.priority ?? 50));
  const operation = useMutation({ mutationFn: async (action: "cancel" | "retry" | "priority") => {
    if (action !== "priority") return apiPost<{ jobId: number }>(`/api/analyses/${job.jobId}/${action}`, role, {});
    const response = await fetch(`/api/analyses/${job.jobId}`, { method: "PATCH", headers: { "content-type": "application/json", "x-explorer-role": role }, body: JSON.stringify({ priority: Number(priority) }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not change priority");
    return body as { jobId: number };
  }, onSuccess: (result, action) => { onUpdated(); if (action === "retry") navigate(`/analyses/${result.jobId}`); } });
  if (!enabled || job.jobId < 0) return null;
  const terminal = ["succeeded", "failed", "cancelled"].includes(job.status);
  return <section className="analysis-operation-panel" aria-label="Analysis controls">
    <div className="analysis-operation-actions">
      {!terminal ? <button type="button" className="btn secondary" disabled={operation.isPending || Boolean(job.cancelRequestedAt)} onClick={() => operation.mutate("cancel")}>{job.cancelRequestedAt ? "Cancellation requested" : job.status === "queued" ? "Cancel queued analysis" : "Stop analysis"}</button> : <button type="button" className="btn secondary" disabled={operation.isPending || !job.configuration} onClick={() => operation.mutate("retry")}>Retry with the same configuration</button>}
      {job.status === "queued" ? <form className="analysis-priority-form" onSubmit={(event) => { event.preventDefault(); operation.mutate("priority"); }}><label>Queue priority<input aria-label="Queue priority" type="number" min="0" max="1000" step="1" value={priority} onChange={(event) => setPriority(event.target.value)} required /></label><button className="btn secondary" type="submit" disabled={operation.isPending}>Apply priority</button></form> : null}
    </div>
    {job.cancelRequestedAt && job.status === "running" ? <p role="status">Waiting for the analysis process to exit. The job remains running until cancellation is acknowledged.</p> : null}
    {operation.error ? <ErrorNote error={operation.error} /> : null}
  </section>;
}

export function RunnerControls({ paused, enabled, onUpdated }: { paused: boolean; enabled: boolean; onUpdated: () => void }) {
  const { role } = useRole();
  const operation = useMutation({ mutationFn: () => apiPost(`/api/runner/${paused ? "resume" : "pause"}`, role, {}), onSuccess: onUpdated });
  if (!enabled) return null;
  return <div className="analysis-operation-panel"><button type="button" className="btn secondary" disabled={operation.isPending} onClick={() => operation.mutate()}>{paused ? "Resume queue" : "Pause queue"}</button><span>{paused ? "New analyses will wait until resumed." : "Pausing lets the current analysis finish."}</span>{operation.error ? <ErrorNote error={operation.error} /> : null}</div>;
}
