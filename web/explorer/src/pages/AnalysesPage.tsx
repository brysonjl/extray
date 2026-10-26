import "./analysis-operations.css";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import type { AnalysisList, RunnerSnapshot } from "../../../../src/product/analysis-contract";
import { apiGet } from "../api";
import { useRole } from "../role";
import { ErrorNote, Spinner } from "../components/ui";
import { AnalysisAccess, Freshness, RunnerControls, RunnerSummary, StatusBadge, Timestamp, waitingReason } from "../components/analysis";

const STATUSES = ["active", "history", "all", "queued", "running", "succeeded", "failed", "cancelled"];
const SOURCES = ["all", "user", "remote", "discovery", "admin", "unknown"];
const SORTS = ["queue", "newest", "oldest"];

export default function AnalysesPage() {
  return <AnalysisAccess><AnalysisWorkspace /></AnalysisAccess>;
}

function AnalysisWorkspace() {
  const { role } = useRole();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const batchId = params.get("batchId") ?? "";
  const capabilities = useQuery({ queryKey: ["analysis-controls", role], queryFn: () => apiGet<{ analysisOperations?: boolean }>("/api/meta", role) });
  const status = STATUSES.includes(params.get("status") ?? "") ? params.get("status")! : "active";
  const source = SOURCES.includes(params.get("source") ?? "") ? params.get("source")! : "all";
  const sort = SORTS.includes(params.get("sort") ?? "") ? params.get("sort")! : "queue";
  const rawPage = Number(params.get("page") ?? 1);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const queryString = new URLSearchParams({ q, batchId, status, source, sort, page: String(page), pageSize: "25" }).toString();
  const list = useQuery({ queryKey: ["analyses", role, queryString], queryFn: () => apiGet<AnalysisList>(`/api/analyses?${queryString}`, role), placeholderData: keepPreviousData, refetchInterval: 10_000 });
  const runner = useQuery({ queryKey: ["runner", role], queryFn: () => apiGet<RunnerSnapshot>("/api/runner", role), refetchInterval: 10_000 });
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next, { replace: key === "q" });
  };
  const counts = list.data?.counts;
  const totalJobs = counts ? counts.queued + counts.running + counts.succeeded + counts.failed + (counts.cancelled ?? 0) : 0;
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  const activeTab = ["active", "queued", "running"].includes(status) ? "active" : ["history", "succeeded", "failed", "cancelled"].includes(status) ? "history" : "all";
  const filtered = Boolean(q || batchId || source !== "all" || !["active", "history", "all"].includes(status));
  const refresh = () => { void list.refetch(); void runner.refetch(); };
  const backTo = `/analyses?${params.toString()}`;

  return <main className="analysis-workspace">
    <div className="workspace-heading"><div><div className="workspace-eyebrow">Analysis workspace</div><h1>Analysis queue</h1><p>Follow queued work, inspect execution history, and open the exact results.</p></div><Link className="btn" to="/submit">+ New analysis</Link></div>
    <div className="workspace-update"><Freshness updatedAt={list.dataUpdatedAt} fetching={list.isFetching} failed={list.isError} /><button type="button" className="btn secondary" onClick={refresh} disabled={list.isFetching || runner.isFetching}>Refresh</button></div>
    <section className="queue-metrics" aria-label="All analysis counts">
      {([
        { key: "queued", label: "Queued", value: counts?.queued, detail: counts?.ready != null ? `${counts.ready} eligible · ${counts.delayed ?? 0} delayed` : "Eligibility unavailable" },
        { key: "running", label: "Running", value: counts?.running, detail: "Recorded execution state" },
        { key: "succeeded", label: "Finished", value: counts?.succeeded, detail: "Review results for coverage" },
        { key: "failed", label: "Failed", value: counts?.failed, detail: "Execution needs attention" },
      ]).map((metric) => <button type="button" key={metric.key} className={`queue-metric metric-${metric.key} ${status === metric.key ? "selected" : ""}`} aria-pressed={status === metric.key} onClick={() => setParam("status", metric.key)}><span className="metric-label">{metric.label}</span><strong>{metric.value?.toLocaleString() ?? "—"}</strong><span className="metric-detail">{metric.detail}</span></button>)}
    </section>
    <div className="workspace-section-label">All jobs · counts are independent of filters</div>
    {runner.data ? <RunnerSummary runner={runner.data} /> : runner.isPending ? <div className="runner-loading">Loading execution snapshot…</div> : null}
    {runner.data ? <RunnerControls paused={runner.data.paused ?? false} enabled={capabilities.data?.analysisOperations ?? false} onUpdated={refresh} /> : null}
    {runner.error ? <div className="workspace-inline-error"><span>Execution snapshot unavailable.</span><ErrorNote error={runner.error} /></div> : null}
    {list.data && !list.data.queueMetadataAvailable ? <div className="banner info">This server exposes recorded submissions. Queue eligibility and live execution details are unavailable.</div> : null}

    <details className="queue-runtime-help">
      <summary>What needs to be running?</summary>
      <p><strong>Local Explorer:</strong> <code>npm run explorer</code> starts the UI, API, and executor for jobs submitted with Analyze or Discover. Keep it running and configure a model provider in <Link to="/settings">Settings</Link>. If you use a local model endpoint, keep that service running too.</p>
      <p><strong>Automatic discovery:</strong> the separately configured <code>npm run runner</code> discovers and queues extensions on a schedule. Adding <code>-- --no-remote</code> skips hosted submission imports; result sync still uses the configured Cloudflare destination. The runner and local Explorer share one executor per database; stop the local Explorer API, start the runner, then restart Explorer to monitor it. Use the same database for both.</p>
      <p><strong>Hosted Explorer:</strong> the hosted app records submissions; a separately configured <code>npm run runner</code> process imports them, runs analyses, and syncs progress and results. The hosted app alone does not execute analyses.</p>
      <p>This queue tracks submitted jobs. Standalone command-line assessments do not appear here.</p>
    </details>

    <section className="queue-panel" aria-label="Analysis queue and history">
      <div className="queue-panel-head"><div className="workspace-tabs" aria-label="Analysis views">{(["active", "history", "all"] as const).map((tab) => <button type="button" key={tab} aria-pressed={activeTab === tab} className={activeTab === tab ? "active" : ""} onClick={() => setParam("status", tab)}>{tab === "active" ? "Active queue" : tab === "history" ? "History" : "All analyses"}{counts ? <span>{tab === "active" ? counts.queued + counts.running : tab === "history" ? counts.succeeded + counts.failed + (counts.cancelled ?? 0) : totalJobs}</span> : null}</button>)}</div><span className="queue-order">{sort === "queue" ? "Running, priority, then oldest" : sort === "newest" ? "Newest first" : "Oldest first"}</span></div>
      <div className="queue-filters">
        <label className="field queue-search"><span>Find an analysis</span><input type="search" maxLength={200} value={q} onChange={(e) => setParam("q", e.target.value)} placeholder="Extension ID or Web Store URL" /></label>
        <label className="field"><span>Status</span><select value={status} onChange={(e) => setParam("status", e.target.value)}><option value="active">Active</option><option value="history">History</option><option value="all">All statuses</option><option value="queued">Queued</option><option value="running">Running</option><option value="succeeded">Finished</option><option value="failed">Failed</option><option value="cancelled">Cancelled</option></select></label>
        <label className="field"><span>Source</span><select value={source} onChange={(e) => setParam("source", e.target.value)}>{SOURCES.map((value) => <option key={value} value={value}>{value === "all" ? "All sources" : value === "unknown" ? "Not recorded" : value.charAt(0).toUpperCase() + value.slice(1)}</option>)}</select></label>
        <label className="field"><span>Batch ID</span><input aria-label="Batch ID filter" value={batchId} maxLength={100} placeholder="All batches" onChange={(event) => setParam("batchId", event.target.value)} /></label>
        <label className="field"><span>Sort</span><select value={sort} onChange={(e) => setParam("sort", e.target.value)}><option value="queue">Queue order</option><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></label>
      </div>
      {list.error ? <div className="queue-message"><ErrorNote error={list.error} />{list.data ? <p className="muted">Showing the last successful snapshot.</p> : <button type="button" className="btn secondary" onClick={refresh}>Try again</button>}</div> : null}
      {list.isPending ? <Spinner label="Loading analyses…" /> : null}
      {list.data && list.data.rows.length === 0 ? <div className="workspace-empty"><span className="empty-symbol" aria-hidden="true">{filtered ? "⌕" : "○"}</span><h2>{filtered ? "No matching analyses" : page > 1 ? "No analyses on this page" : totalJobs === 0 ? "Your analysis workspace starts here" : activeTab === "active" ? "The active queue is clear" : "No analysis history yet"}</h2><p>{filtered ? "Try a different search or broaden your filters." : page > 1 ? "The queue changed since this page was opened." : totalJobs === 0 ? "Submit an extension to track its execution and keep a durable link to its results." : activeTab === "active" ? "Finished work stays available in history." : "Completed and failed executions will appear here."}</p>{filtered || page > 1 ? <button type="button" className="btn secondary" onClick={() => setParams({ status: activeTab })}>Reset filters</button> : <Link className="btn secondary" to={totalJobs > 0 && activeTab === "active" ? "/analyses?status=history" : "/submit"}>{totalJobs > 0 && activeTab === "active" ? "View history" : "Start an analysis"}</Link>}</div> : null}
      {list.data && list.data.rows.length > 0 ? <div className="queue-table-wrap" aria-busy={list.isFetching}><table className="queue-table"><thead><tr><th scope="col">Analysis</th><th scope="col">State</th><th scope="col">Source / priority</th><th scope="col">Submitted</th><th scope="col">Automatic requeues</th></tr></thead><tbody>{list.data.rows.map((row) => <tr key={row.jobId}><td className="queue-identity"><Link to={`/analyses/${row.jobId}`} state={{ backTo }}><span className="queue-job-number">#{row.jobId}</span><strong>{row.name || row.storeId || "Unknown extension"}</strong></Link><span className="queue-store-id">{row.name ? row.storeId : "Extension analysis"}</span></td><td className="queue-state"><StatusBadge status={row.status} eligibility={row.eligibility} /><span className="queue-reason" title={waitingReason(row)}>{waitingReason(row)}</span></td><td><span className="queue-source">{row.source ?? "Not recorded"}</span><span className="queue-secondary">{row.priority === null ? "Priority unknown" : `Priority ${row.priority}`}</span></td><td className="queue-time"><Timestamp value={row.createdAt} /></td><td className="queue-retries">{row.retryCount ?? "—"}</td></tr>)}</tbody></table></div> : null}
      {list.data ? <div className="queue-pagination"><span>{list.isPlaceholderData ? "Updating results…" : `${list.data.total.toLocaleString()} matching ${list.data.total === 1 ? "analysis" : "analyses"} · ${list.data.rows.length} shown`}</span><div className="pager"><button type="button" aria-label="Previous page" disabled={page <= 1 || list.isPlaceholderData} onClick={() => setParam("page", String(page - 1))}>←</button><span>Page {page} of {pages}</span><button type="button" aria-label="Next page" disabled={page >= pages || list.isPlaceholderData} onClick={() => setParam("page", String(page + 1))}>→</button></div></div> : null}
    </section>
  </main>;
}
