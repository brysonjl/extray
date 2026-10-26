import "./analysis-operations.css";
import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "react-router-dom";
import type { AnalysisDetail, AnalysisEvent } from "../../../../src/product/analysis-contract";
import type { SubmissionConfig } from "../../../../src/product/submission-config";
import { apiGet } from "../api";
import { useRole } from "../role";
import { ErrorNote, Spinner, formatUsd } from "../components/ui";
import { AnalysisAccess, AnalysisControls, Freshness, StatusBadge, Timestamp, waitingReason } from "../components/analysis";

const OPTION_LABELS: Record<string, string> = {
  verifierModel: "Independent verifier", think: "Reasoning effort", maxTokens: "Token limit", enrich: "Host registration enrichment", forceFresh: "Fresh package download", useCache: "Static cache", replay: "Replay mode", piShard: "Pi dimension shards", piSubagentModel: "Default shard model", piSubagentModels: "Dimension model overrides", piSynthesisModel: "Synthesis model", piNoPack: "Omit evidence pack from agent input", piMaxTurns: "Pi investigator turn limit", piSubagentMaxTurns: "Pi shard turn limit", agenticMaxStepsPerDimension: "Agentic steps per dimension",
};

function Configuration({ config }: { config: SubmissionConfig | null }) {
  if (!config) return <div className="workspace-not-recorded"><strong>Configuration not recorded</strong><p>This historical job has no submitted configuration snapshot. Current defaults cannot tell us which settings it used.</p></div>;
  const options = Object.entries(config.options ?? {});
  return <><p className="workspace-panel-description">Settings captured when this job was submitted. Provider credentials stay on the server.</p><dl className="analysis-config"><dt>Methodology</dt><dd>{config.methodology}</dd><dt>Primary model</dt><dd>{config.model}</dd><dt>Provider</dt><dd>{config.provider.id}</dd><dt>Endpoint</dt><dd>{config.provider.baseUrl || "Provider default"}</dd>{options.map(([key, value]) => <Fragment key={key}><dt>{OPTION_LABELS[key] ?? key}</dt><dd>{typeof value === "boolean" ? value ? "Enabled" : "Disabled" : typeof value === "object" && value !== null ? <ul className="config-overrides">{Object.entries(value).map(([dimension, model]) => <li key={dimension}><span>{dimension}</span> {String(model)}</li>)}</ul> : String(value)}</dd></Fragment>)}</dl><p className="workspace-footnote">{options.length ? "Known execution defaults were resolved when submitted." : "No options were recorded for this historical snapshot."} Snapshot format v{config.version}.</p></>;
}

export default function AnalysisPage() {
  return <AnalysisAccess><AnalysisWorkspace /></AnalysisAccess>;
}

function AnalysisWorkspace() {
  const { jobId = "" } = useParams();
  const { role } = useRole();
  const location = useLocation();
  const validId = /^-?[1-9]\d*$/.test(jobId) && Number.isSafeInteger(Number(jobId));
  const analysis = useQuery({
    queryKey: ["analysis", role, jobId],
    queryFn: () => apiGet<AnalysisDetail>(`/api/analyses/${jobId}`, role),
    enabled: validId,
    refetchInterval: (query) => query.state.data && ["succeeded", "failed", "cancelled"].includes(query.state.data.status) ? false : 10_000,
  });
  const backTo = typeof location.state?.backTo === "string" && /^\/analyses(?:\?|$)/.test(location.state.backTo) ? location.state.backTo : "/analyses";
  const job = analysis.data;
  const terminal = job?.status === "succeeded" || job?.status === "failed" || job?.status === "cancelled";
  const capabilities = useQuery({ queryKey: ["analysis-controls", role], queryFn: () => apiGet<{ analysisOperations?: boolean }>("/api/meta", role) });
  const result = job?.result;
  const incomplete = result?.outcome?.investigation === "incomplete";

  return <main className="analysis-workspace">
    <Link className="workspace-back" to={backTo}>← Back to analyses</Link>
    {!validId ? <div className="workspace-empty"><h1>Invalid analysis ID</h1><p>Open an analysis from the queue to view its history.</p></div> : null}
    {validId && analysis.isPending ? <Spinner label="Loading analysis…" /> : null}
    {analysis.error ? <><ErrorNote error={analysis.error} /><button type="button" className="btn secondary" onClick={() => void analysis.refetch()}>Try again</button></> : null}
    {job ? <>
      <div className="workspace-heading analysis-detail-heading"><div><div className="workspace-eyebrow">Analysis #{job.jobId}</div><h1>{job.name || "Extension analysis"}</h1><p className="analysis-target">{job.storeId || "Extension identity unavailable"}</p></div><StatusBadge status={job.status} eligibility={job.eligibility} /></div>
      <div className="workspace-update"><Freshness updatedAt={analysis.dataUpdatedAt} fetching={analysis.isFetching} failed={analysis.isError} polling={!terminal} /><button type="button" className="btn secondary" disabled={analysis.isFetching} onClick={() => void analysis.refetch()}>Refresh</button></div>
      <AnalysisControls key={job.jobId} job={job} enabled={capabilities.data?.analysisOperations ?? false} onUpdated={() => void analysis.refetch()} />
      {job.retryOf ? <p className="workspace-footnote">Retry of <Link to={`/analyses/${job.retryOf}`}>analysis #{job.retryOf}</Link>.</p> : null}
      <section className={`analysis-state-summary summary-${job.status}`} aria-label="Current execution state"><span className="workspace-eyebrow">Execution</span><h2>{job.status === "cancelled" ? "Analysis cancelled" : job.status === "succeeded" ? "Execution finished" : job.status === "failed" ? "Execution failed" : job.status === "running" ? "Analysis is running" : job.eligibility === "retry-delay" ? "Waiting for retry eligibility" : "Waiting in the queue"}</h2><p>{waitingReason(job)}</p>{job.status === "running" ? <p className="workspace-footnote">Stages below are recorded as the executor reaches them. Cancellation is acknowledged only after the process exits.</p> : job.status === "succeeded" ? <p className="workspace-footnote">Execution success and investigation completeness are tracked separately below.</p> : job.status === "queued" && job.eligibility === "ready" ? <p className="workspace-footnote">Eligibility does not guarantee an immediate start. Runner scheduling may also delay work.</p> : null}</section>
      <AnalysisActivity key={job.jobId} job={job} />
      <div className="analysis-detail-grid">
        <section className="workspace-panel"><div className="workspace-panel-heading"><h2>Recorded timeline</h2><span>Job #{job.jobId}</span></div><ol className="analysis-timeline"><li className="recorded"><span>Submitted</span><Timestamp value={job.createdAt} /></li><li className={job.startedAt ? "recorded" : ""}><span>Execution started</span><Timestamp value={job.startedAt} /></li><li className={job.finishedAt ? "recorded" : ""}><span>Execution finished</span><Timestamp value={job.finishedAt} /></li></ol><dl className="analysis-config compact"><dt>Source</dt><dd>{job.source ?? "Not recorded"}</dd><dt>Priority</dt><dd>{job.priority ?? "Not recorded"}</dd><dt>Automatic requeues</dt><dd>{job.retryCount ?? "Not recorded"}</dd>{job.notBefore ? <><dt>Eligible after</dt><dd><Timestamp value={job.notBefore} /></dd></> : null}{job.batchId ? <><dt>Batch</dt><dd><Link to={`/analyses?batchId=${encodeURIComponent(job.batchId)}`}>{job.batchId}</Link></dd></> : null}</dl><p className="workspace-footnote">Automatic requeues count requeues, not total execution attempts.</p></section>
        <section className="workspace-panel"><div className="workspace-panel-heading"><h2>Analysis result</h2>{result ? <span>Report #{result.reportId}</span> : null}</div>{result ? <>
          <div className={`analysis-result-quality ${incomplete ? "is-incomplete" : ""}`}><span className="workspace-eyebrow">Investigation</span><strong>{incomplete ? "Incomplete investigation" : result.outcome?.investigation === "complete" ? "Complete investigation" : "Completeness not recorded"}</strong><p>{incomplete ? "A report was generated, but some investigation work remains incomplete. Review its limitations before using the findings." : !result.outcome ? "This report predates recorded investigation outcomes. Execution success alone does not establish full coverage." : "The report records a completed investigation."}</p></div>
          {result.outcome ? <div className="result-submission">Final submission: <strong>{result.outcome.final_submission === "accepted" ? "accepted" : "not accepted"}</strong>{result.outcome.reasons.length ? <ul>{result.outcome.reasons.map((reason, i) => <li key={i}>{reason}</li>)}</ul> : null}</div> : null}
          <dl className="analysis-config compact"><dt>Methodology</dt><dd>{result.methodology}</dd><dt>Model</dt><dd>{result.model}</dd><dt>Assessment</dt><dd>{result.tier?.replaceAll("-", " ") ?? "Not recorded"}</dd><dt>Recorded</dt><dd><Timestamp value={result.assessedAt} /></dd><dt>Cost</dt><dd>{result.costUsd == null ? "Not recorded" : formatUsd(result.costUsd)}</dd></dl>
          <div className="result-actions"><Link className="btn" to={`/ext/${encodeURIComponent(result.storeId)}?report=${result.reportId}`}>Open this result →</Link><Link className="result-catalog-link" to={`/ext/${encodeURIComponent(result.storeId)}`}>Current catalog assessment</Link><Link className="result-catalog-link" to={`/compare/${encodeURIComponent(result.storeId)}?left=${result.reportId}`}>Compare this result with another report →</Link></div>
        </> : <div className="workspace-not-recorded"><strong>{terminal ? "No navigable result" : "Results will appear here"}</strong><p>{job.status === "failed" ? "The executor did not associate a report with this job. Its recorded error appears above." : job.status === "succeeded" ? "The job finished, but its exact report is unavailable. A current catalog assessment may belong to a different run." : "Keep this page or return from the queue. The analysis remains available after execution finishes."}</p>{terminal && job.storeId ? <Link to={`/ext/${encodeURIComponent(job.storeId)}`}>Check current catalog assessment →</Link> : null}</div>}</section>
        <section className="workspace-panel analysis-configuration-panel"><div className="workspace-panel-heading"><h2>Submitted configuration</h2><span>{job.configuration ? "Captured at submission" : "Historical job"}</span></div><Configuration config={job.configuration} />{job.profile ? <details className="analysis-catalog-pin"><summary>Catalog selection profile</summary><p>{job.profile.methodology} · {job.profile.model}</p><p>This profile controls catalog selection. It is not evidence of this job’s execution settings.</p></details> : null}</section>
      </div>
    </> : null}
  </main>;
}

function AnalysisActivity({ job }: { job: AnalysisDetail }) {
  const { role } = useRole();
  const [after, setAfter] = useState(0);
  const activity = useQuery({ queryKey: ["analysis-events", role, job.jobId, after, job.status, job.events?.at(-1)?.sequence], queryFn: () => apiGet<{ events: AnalysisEvent[]; nextCursor: number }>(`/api/analyses/${job.jobId}/events?after=${after}`, role), refetchInterval: job.status === "running" || job.status === "queued" ? 5000 : false });
  const events = activity.data?.events ?? (after === 0 ? job.events ?? [] : []);
  return <section className="analysis-activity workspace-panel" aria-label="Execution activity"><div className="workspace-panel-heading"><h2>Activity and attempts</h2><span>{job.attempts?.length ?? 0} recorded attempts</span></div>
    {job.attempts?.length ? <div className="analysis-attempts">{job.attempts.map((attempt, index) => <div key={attempt.id}><strong>Attempt {index + 1}</strong><span>{attempt.status.replaceAll("-", " ")}</span><Timestamp value={attempt.startedAt} />{attempt.finishedAt ? <span>Ended <Timestamp value={attempt.finishedAt} /></span> : null}{attempt.error ? <p>{attempt.error}</p> : null}</div>)}</div> : <p className="workspace-footnote">No executor attempt has been recorded.</p>}
    {events.length ? <ol className="analysis-event-list" aria-live="polite">{events.map((event) => <li key={event.sequence}><span className="event-sequence">{event.sequence}</span><div><strong>{event.message}</strong>{event.stage ? <span className="event-stage">{event.stage.replaceAll("-", " ")}</span> : null}</div><Timestamp value={event.createdAt} /></li>)}</ol> : <p>No activity has been recorded for this analysis.</p>}
    {activity.error ? <ErrorNote error={activity.error} /> : null}
    <div className="analysis-event-pager">{after > 0 ? <button className="btn secondary" onClick={() => setAfter(0)}>First activity page</button> : null}{events.length === 200 ? <button className="btn secondary" onClick={() => setAfter(activity.data?.nextCursor ?? events.at(-1)!.sequence)}>Next activity page</button> : null}</div>
  </section>;
}
