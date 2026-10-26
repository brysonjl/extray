// One submission path for public requests, configured admin jobs and durable batches.
import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { parseStoreInput } from "@jobs/validate";
import type { AnalysisOptions } from "../../../../src/product/analysis-config";
import { validateAnalysisOptions } from "../../../../src/product/analysis-config";
import { AnalysisOptionsFields, analysisOptionsForMethodology } from "../components/AnalysisOptionsFields";
import { AnalysisProfiles } from "../components/AnalysisProfiles";
import { AnalysisEstimate } from "../components/AnalysisEstimate";
import { apiGet, apiPost } from "../api";
import { useRole } from "../role";
import { ErrorNote, PiCaveat, Ring, ScanFrame, Spinner } from "../components/ui";
import { Freshness, StatusBadge, Timestamp } from "../components/analysis";
import type { BatchStatus, SettingsPayload, Submission, SubmissionExists } from "../types";

const QUEUED_SETTLED_MS = 2 * 60 * 1000;
const SETTLED_POLL_MS = 60 * 1000;
type Configuration = { methodology: string; model: string; options: AnalysisOptions };
type SubmitRequest = { input: string; force?: boolean; configuration?: Configuration };

function queuedSettled(job: Submission | undefined): boolean {
  return job?.status === "queued" && Date.now() - new Date(job.createdAt).getTime() > QUEUED_SETTLED_MS;
}

function JobStatus({ jobId, storeId }: { jobId: string; storeId: string | null }) {
  const { role, canAnalyses } = useRole();
  const navigate = useNavigate();
  const pollUrl = `/api/submissions/${encodeURIComponent(jobId)}${storeId ? `?storeId=${encodeURIComponent(storeId)}` : ""}`;
  const { data: job, error, refetch } = useQuery({
    queryKey: ["submission", role, jobId, storeId],
    queryFn: () => apiGet<Submission>(pollUrl, role),
    refetchInterval: (q) => {
      const j = q.state.data;
      if (j?.status === "running") return 1000;
      if (j?.status === "queued") return queuedSettled(j) ? SETTLED_POLL_MS : 5000;
      return false;
    },
    refetchIntervalInBackground: true,
  });
  useEffect(() => {
    if (!canAnalyses && job?.status === "succeeded" && job.resultStoreId) {
      const timer = setTimeout(() => navigate(`/ext/${encodeURIComponent(job.resultStoreId!)}`), 800);
      return () => clearTimeout(timer);
    }
  }, [canAnalyses, job?.status, job?.resultStoreId, navigate]);
  if (error) return <><ErrorNote error={error} /><button type="button" className="btn secondary" onClick={() => void refetch()}>Refresh status</button></>;
  if (!job) return <Spinner label="Loading submitted analysis…" />;
  const settled = queuedSettled(job);
  const labels: Record<Submission["status"], string> = {
    queued: settled ? "Recorded in the queue. This page will update when execution status changes." : "Queued — waiting for execution.",
    running: "Execution started.", succeeded: canAnalyses ? "Execution finished. Open the workspace to review this run." : "Done — opening the assessment…", failed: "Analysis failed",
  };
  const statusLine = <div className={`status-line status-${job.status}`}>
    {job.status === "running" ? <Ring /> : <span className="status-dot" />}
    <span>Job #{job.jobId} — {labels[job.status]}</span>
  </div>;
  return <div className="job-status" aria-live="polite">
    {job.status === "running" ? <ScanFrame style={{ padding: "18px 20px" }}>{statusLine}</ScanFrame> : statusLine}
    {job.status === "failed" && job.error ? <ErrorNote error={new Error(job.error)} /> : null}
    {canAnalyses ? <p><Link to={`/analyses/${job.jobId}`}>Open analysis workspace →</Link></p> : job.status === "succeeded" && job.resultStoreId ? <p><Link to={`/ext/${encodeURIComponent(job.resultStoreId)}`}>View the assessment →</Link></p> : null}
    {job.costUsd != null && role === "admin" ? <p className="faint">Analysis cost: ${job.costUsd.toFixed(3)}</p> : null}
  </div>;
}

function BatchProgress({ batchId }: { batchId: string }) {
  const { role, canAnalyses } = useRole();
  const batch = useQuery({ queryKey: ["analysis-batch", role, batchId], queryFn: () => apiGet<BatchStatus>(`/api/analyze-batch/${encodeURIComponent(batchId)}`, role), refetchInterval: (query) => query.state.data?.done ? false : 10_000 });
  if (batch.isPending) return <Spinner label="Loading batch…" />;
  if (!batch.data) return <><ErrorNote error={batch.error} /><button type="button" className="btn secondary" onClick={() => void batch.refetch()}>Refresh batch</button></>;
  const done = batch.data.items.filter((item) => item.status === "succeeded" || item.status === "failed").length;
  return <section className="composer-batch" aria-label="Submitted batch">
    <div className="workspace-panel-heading"><h2>{batch.data.done ? "Batch execution finished" : "Batch in progress"}</h2><span>{done} / {batch.data.items.length} finished</span></div>
    <p className="hint">Each extension has its own durable analysis record. Save this page to return to the batch.</p>
    <div className="workspace-update"><Freshness updatedAt={batch.dataUpdatedAt} fetching={batch.isFetching} failed={batch.isError} polling={!batch.data.done} /><button type="button" className="btn secondary" disabled={batch.isFetching} onClick={() => void batch.refetch()}>Refresh</button></div>
    {batch.error ? <ErrorNote error={batch.error} /> : null}
    <ul className="composer-batch-list">{batch.data.items.map((item, index) => <li key={`${item.storeId}-${index}`}><div>{canAnalyses && item.jobId ? <Link to={`/analyses/${item.jobId}`}>#{item.jobId} · {item.storeId}</Link> : <span>{item.storeId}</span>}<StatusBadge status={item.status} eligibility="unknown" /></div>{item.error ? <p className="warn-text">{item.error}</p> : null}</li>)}</ul>
    <p className="workspace-footnote">Submitted <Timestamp value={batch.data.startedAt} /> · Batch {batchId}</p>
    {canAnalyses ? <Link className="btn secondary" to="/analyses">Open analysis queue →</Link> : null}
  </section>;
}

export default function SubmitPage() {
  const { role } = useRole();
  // Switching lenses discards in-memory configuration and admin mutation results.
  return <SubmissionComposer key={role} />;
}

function SubmissionComposer() {
  const { role, canAnalyses, canConfigureAnalyses, canDiscover, isRoleLoading } = useRole();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const jobId = params.get("job");
  const batchId = params.get("batch");
  const canBatch = role === "admin" && canDiscover;
  const [mode, setMode] = useState<"single" | "batch">("single");
  const [input, setInput] = useState(params.get("input") ?? "");
  const [batchInput, setBatchInput] = useState("");
  const [config, setConfig] = useState<Configuration | null>(null);
  const [exists, setExists] = useState<{ result: SubmissionExists; request: SubmitRequest } | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const defaults = useQuery({ queryKey: ["settings", role], queryFn: () => apiGet<SettingsPayload & { options?: AnalysisOptions }>("/api/settings", role), enabled: canConfigureAnalyses, staleTime: 0 });
  useEffect(() => {
    if (defaults.data) setConfig((current) => current ?? { methodology: defaults.data.methodology, model: defaults.data.model, options: defaults.data.options ?? {} });
  }, [defaults.data]);
  const invalidateQueue = () => { void qc.invalidateQueries({ queryKey: ["analyses"] }); void qc.invalidateQueries({ queryKey: ["runner"] }); };
  const submit = useMutation({
    mutationFn: (body: SubmitRequest) => apiPost<Submission | SubmissionExists>("/api/submissions", role, body),
    onSuccess: (res, request) => {
      if ("existing" in res) setExists({ result: res, request });
      else { setExists(null); invalidateQueue(); navigate(canAnalyses ? `/analyses/${res.jobId}` : `/submit?job=${res.jobId}${res.storeId ? `&store=${encodeURIComponent(res.storeId)}` : ""}`); }
    },
  });
  const batch = useMutation({
    mutationFn: (body: { storeIds: string[]; configuration?: Configuration }) => apiPost<{ batchId: string }>("/api/analyze-batch", role, body),
    onSuccess: (res) => { invalidateQueue(); navigate(`/submit?batch=${encodeURIComponent(res.batchId)}`); },
  });
  const busy = submit.isPending || batch.isPending;
  const blocked = busy || isRoleLoading || (canConfigureAnalyses && (!defaults.data || !config));
  const lines = batchInput.split(/\r?\n/).map((value, index) => ({ value: value.trim(), line: index + 1 })).filter(({ value }) => value);
  const validIds = lines.map(({ value }) => parseStoreInput(value)).filter((id): id is string => id !== null);
  const uniqueIds = [...new Set(validIds)];
  const duplicateCount = validIds.length - uniqueIds.length;
  const updateConfig = (next: Configuration) => { setConfig(next); setExists(null); setClientError(null); };
  const resetFeedback = () => { setExists(null); setClientError(null); submit.reset(); batch.reset(); };
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (blocked) return;
    resetFeedback();
    let configuration: Configuration | undefined;
    if (canConfigureAnalyses && config) {
      try {
        if (!config.model.trim() || config.model.trim().length > 200) throw new Error("Enter a primary model ID of at most 200 characters.");
        configuration = { ...config, model: config.model.trim(), options: validateAnalysisOptions(config.options, config.methodology) };
      } catch (error) { setClientError(error instanceof Error ? error.message : String(error)); return; }
    }
    if (mode === "batch" && canBatch) {
      if (!lines.length) { setClientError("Enter at least one extension ID or Web Store URL, one per line."); return; }
      if (lines.length > 100) { setClientError("A batch accepts at most 100 entries. Split this list into smaller batches."); return; }
      const invalid = lines.filter(({ value }) => !parseStoreInput(value));
      if (invalid.length) { setClientError(`Invalid extension input on ${invalid.length === 1 ? "line" : "lines"} ${invalid.map(({ line }) => line).join(", ")}. Every entry must be a 32-character extension ID (a–p) or a Chrome Web Store URL. Nothing was submitted.`); return; }
      batch.mutate({ storeIds: uniqueIds, ...(configuration ? { configuration } : {}) });
    } else {
      if (!parseStoreInput(input)) { setClientError("Enter a 32-character extension ID (a–p) or a Chrome Web Store URL."); return; }
      submit.mutate({ input: input.trim(), ...(configuration ? { configuration } : {}) });
    }
  }

  return <main className={`submit-card ${canConfigureAnalyses ? "composer-card" : ""}`}>
    <div className="workspace-eyebrow">{canConfigureAnalyses ? "Configure · submit · inspect" : "Extension analysis"}</div>
    <h1>{canConfigureAnalyses ? "Start a new analysis" : "Analyze an extension"}</h1>
    <p className="hint">{canConfigureAnalyses ? "Choose the targets and investigation settings for this submission. The queue keeps the configuration and results together." : "Paste a Chrome Web Store URL or a 32-character extension ID. The analysis records an assessment in the catalog."}</p>
    {canAnalyses ? <Link className="composer-queue-link" to="/analyses">View analysis queue →</Link> : null}
    <form className="composer-form" onSubmit={onSubmit}>
      <fieldset disabled={busy || isRoleLoading} className="composer-fieldset">
        <legend className="composer-step">01 <span>Choose targets</span></legend>
        {canBatch ? <div className="composer-mode" aria-label="Submission mode"><button type="button" className={mode === "single" ? "active" : ""} aria-pressed={mode === "single"} onClick={() => { setMode("single"); resetFeedback(); }}>One extension</button><button type="button" className={mode === "batch" ? "active" : ""} aria-pressed={mode === "batch"} onClick={() => { setMode("batch"); resetFeedback(); }}>Batch of extensions</button></div> : null}
        {mode === "batch" && canBatch ? <><label className="field"><span>Extension IDs or Web Store URLs</span><textarea value={batchInput} rows={6} onChange={(e) => { setBatchInput(e.target.value); resetFeedback(); }} spellCheck={false} placeholder="One extension ID or Chrome Web Store URL per line" aria-describedby="batch-hint" /></label><p className="composer-help" id="batch-hint">Up to 100 entries. {uniqueIds.length} unique valid {uniqueIds.length === 1 ? "target" : "targets"}{duplicateCount > 0 ? ` · ${duplicateCount} duplicate ${duplicateCount === 1 ? "entry" : "entries"} will be combined` : ""}. Every target is submitted for analysis, including extensions already in the catalog.</p></> : <label className="field"><span>Extension ID or Web Store URL</span><input value={input} onChange={(e) => { setInput(e.target.value); resetFeedback(); }} placeholder="https://chromewebstore.google.com/detail/…" spellCheck={false} maxLength={2048} /></label>}
      </fieldset>
      {canConfigureAnalyses ? <fieldset disabled={busy} className="composer-fieldset"><legend className="composer-step">02 <span>Configure investigation</span></legend>
        {defaults.isPending ? <Spinner label="Loading analysis defaults…" /> : null}
        {defaults.error ? <><ErrorNote error={defaults.error} /><button type="button" className="btn secondary" onClick={() => void defaults.refetch()}>Reload defaults</button></> : null}
        {config && defaults.data ? <>
          <AnalysisProfiles configuration={config} onApply={updateConfig} />
          <div className="composer-essentials"><label className="field"><span>Methodology</span><select value={config.methodology} onChange={(e) => updateConfig({ ...config, methodology: e.target.value, options: analysisOptionsForMethodology(config.options, e.target.value) })}>{defaults.data.choices.methodologies.map((methodology) => <option key={methodology} value={methodology}>{methodology}</option>)}</select></label><label className="field"><span>Primary model</span><input value={config.model} onChange={(e) => updateConfig({ ...config, model: e.target.value })} maxLength={200} spellCheck={false} /></label></div>
          <p className="composer-help">Connection: <strong>{defaults.data.provider.id}</strong>{defaults.data.provider.baseUrl ? ` · ${defaults.data.provider.baseUrl}` : " · provider default endpoint"}. <Link to="/settings">Manage connection and defaults</Link></p>
          <details className="composer-advanced"><summary>Advanced analysis options <span>{Object.keys(config.options).length ? `${Object.keys(config.options).length} configured` : "Methodology defaults"}</span></summary><AnalysisOptionsFields methodology={config.methodology} value={config.options} onChange={(options) => updateConfig({ ...config, options })} /></details>
          <p className="composer-help">Changes here apply only to this submission. Queued jobs keep their submitted configuration.</p>
        </> : null}
      </fieldset> : null}
      {(!canConfigureAnalyses || config?.methodology === "pi") ? <PiCaveat /> : null}
      {canConfigureAnalyses && config ? <AnalysisEstimate configuration={config} targets={mode === "batch" ? uniqueIds.length : 1} /> : null}
      <div className="composer-review">
        {canConfigureAnalyses && config ? <div><span className="workspace-eyebrow">Submission summary</span><strong>{mode === "batch" ? `${uniqueIds.length} ${uniqueIds.length === 1 ? "extension" : "extensions"}` : "1 extension"} · {config.methodology}</strong><p>{config.model || "Choose a model"}{config.options.verifierModel ? ` · verifier ${config.options.verifierModel}` : " · primary model verifies"}{config.options.replay ? " · replay" : config.methodology === "pi" ? " · live investigation" : " · live with response caching"}</p><p className="composer-help">{config.options.maxTokens ? `Token limit: ${config.options.maxTokens.toLocaleString()}. ` : ""}Cost depends on the extension and investigation.</p></div> : null}
        <button className="btn" type="submit" disabled={blocked}>{busy ? "Submitting…" : mode === "batch" && canBatch ? `Queue ${uniqueIds.length || ""} ${uniqueIds.length === 1 ? "analysis" : "analyses"}` : "Submit analysis"}</button>
      </div>
    </form>
    {clientError ? <ErrorNote error={new Error(clientError)} /> : null}
    {submit.error ? <ErrorNote error={submit.error} /> : null}
    {batch.error ? <ErrorNote error={batch.error} /> : null}
    {exists ? <div className="job-status"><p>This extension already has an assessment. <Link to={`/ext/${exists.result.storeId}`}>View the existing verdict →</Link></p><p className="composer-help">Reanalysis runs the submitted configuration again. Fetching a fresh extension package is a separate analysis option.</p><button className="btn secondary" disabled={blocked} onClick={() => submit.mutate({ ...exists.request, force: true })}>Re-analyze anyway</button></div> : null}
    {jobId ? <JobStatus jobId={jobId} storeId={params.get("store")} /> : null}
    {batchId && canBatch ? <BatchProgress batchId={batchId} /> : null}
  </main>;
}
