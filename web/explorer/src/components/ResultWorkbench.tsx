import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { ResultWorkbench as ResultData } from "../../../../src/product/result-workbench";
import { apiGet } from "../api";
import { useRole } from "../role";
import { ErrorNote, Spinner, formatTokens, formatUsd } from "./ui";
import { Timestamp } from "./analysis";
import "../results.css";

export function ResultExports({ reportId }: { reportId: number }) {
  const { role } = useRole();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  async function download(format: "json" | "markdown") {
    setPending(format); setError(null);
    try {
      const response = await fetch(`/api/results/${reportId}/export?format=${format}`, { headers: { "x-explorer-role": role } });
      if (!response.ok) throw new Error(`Could not export report (${response.status}). Refresh the report and try again.`);
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `extray-report-${reportId}.${format === "json" ? "json" : "md"}`;
      anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause : new Error(String(cause))); }
    finally { setPending(null); }
  }
  return <div className="result-exports"><div><button className="btn secondary" type="button" disabled={pending !== null} onClick={() => void download("json")}>{pending === "json" ? "Exporting…" : "Export JSON"}</button><button className="btn secondary" type="button" disabled={pending !== null} onClick={() => void download("markdown")}>{pending === "markdown" ? "Exporting…" : "Export Markdown"}</button></div>{error ? <ErrorNote error={error} /> : null}</div>;
}

export function ResultProvenance({ result }: { result: ResultData }) {
  const execution = result.execution;
  const submitted = result.submission?.configuration;
  return <section className="result-workbench-section"><h3>Recorded provenance</h3><dl className="result-provenance"><dt>Report / run</dt><dd>#{result.reportId} / #{result.runId}</dd><dt>Extension version</dt><dd>{result.detail.identity.version ?? "Not recorded"}</dd><dt>Assessed</dt><dd><Timestamp value={result.detail.provenance.assessedAt} /></dd><dt>Methodology</dt><dd>{execution.methodology}</dd><dt>Primary model</dt><dd>{execution.model}</dd><dt>Verifier model</dt><dd>{execution.verifierModel ?? "Not recorded"}</dd><dt>Reasoning / mode</dt><dd>{execution.reasoning ?? "Not recorded"} / {execution.mode ?? "Not recorded"}</dd><dt>Engine</dt><dd>{execution.engineVersion ?? "Not recorded"}</dd><dt>Git revision</dt><dd>{execution.gitSha ?? "Not recorded"}</dd>{execution.compressionProxy !== null ? <><dt>Compression proxy</dt><dd>{execution.compressionProxy ? "Enabled" : "Disabled"}</dd></> : null}{execution.modelAllocation ? <><dt>Model allocation</dt><dd>{Object.entries(execution.modelAllocation).map(([dimension, model]) => <div key={dimension}>{dimension}: {model}</div>)}</dd></> : null}</dl>
    {result.submission ? <Link className="result-small-link" to={`/analyses/${result.submission.jobId}`}>Submitted analysis #{result.submission.jobId} →</Link> : <p className="result-note">No submitted job is associated with this report.</p>}
    <details className="result-configuration"><summary>Submitted configuration {submitted ? "snapshot" : "not recorded"}</summary>{submitted ? <><p className="result-note">Submitted settings are preserved separately from recorded execution metadata. Unspecified options use execution defaults.</p><pre>{JSON.stringify(submitted, null, 2)}</pre></> : <p className="result-note">Current defaults cannot reconstruct this historical run’s settings.</p>}</details>
  </section>;
}

export function ResultUsage({ result }: { result: ResultData }) {
  const usage = result.usage;
  return <section className="result-workbench-section"><h3>Usage by step</h3><div className="result-usage-totals"><span>Recorded report cost <strong>{usage.reportCostUsd === null ? "Unknown" : formatUsd(usage.reportCostUsd)}</strong></span><span>Input / output tokens <strong>{usage.reportInputTokens === null ? "Unknown" : formatTokens(usage.reportInputTokens)} / {usage.reportOutputTokens === null ? "Unknown" : formatTokens(usage.reportOutputTokens)}</strong></span></div>
    {usage.steps.length ? <><div className="result-usage-scroll"><table className="result-usage-table"><thead><tr><th scope="col">Step / model</th><th scope="col">Calls</th><th scope="col">In / out tokens</th><th scope="col">Time</th><th scope="col">USD</th></tr></thead><tbody>{usage.steps.map((step, index) => <tr key={index}><td><strong>{step.label}</strong><span>{step.model}</span>{step.scope === "shared-run" ? <em>Shared run accounting</em> : null}</td><td>{step.calls ?? "—"}</td><td>{step.inputTokens == null ? "—" : formatTokens(step.inputTokens)} / {step.outputTokens == null ? "—" : formatTokens(step.outputTokens)}</td><td>{step.wallClockMs == null ? "—" : `${(step.wallClockMs / 1000).toFixed(1)}s`}</td><td>{step.costUsd == null ? <span className="result-unpriced">Unpriced</span> : formatUsd(step.costUsd)}</td></tr>)}</tbody></table></div><p className="result-note">{usage.unpricedSteps ? `${usage.unpricedSteps} steps have no recorded price. ` : ""}Unpriced usage is unknown, not zero. Step accounting can be partial; shared run costs are not assigned to this extension.</p>{usage.truncated ? <p className="result-note warn-text">Only the first 2,000 recorded steps are shown and exported.</p> : null}</> : <p className="result-note">{usage.available ? "No per-step accounting was recorded for this report." : "Per-step accounting is unavailable on this server."} The report total, when present, remains available above.</p>}
  </section>;
}

export function ResultWorkbench({ storeId, reportId }: { storeId: string; reportId: string | null }) {
  const { role } = useRole();
  const result = useQuery({ queryKey: ["result-workbench", role, storeId, reportId], queryFn: () => apiGet<ResultData>(reportId ? `/api/results/${encodeURIComponent(reportId)}` : `/api/extensions/${encodeURIComponent(storeId)}/result`, role), enabled: role === "admin" });
  if (role !== "admin") return null;
  if (result.isPending) return <Spinner label="Loading exact-report workbench…" />;
  if (result.error) return <div className="result-workbench"><ErrorNote error={result.error} /><button className="btn secondary" type="button" onClick={() => void result.refetch()}>Reload workbench</button></div>;
  if (!result.data || result.data.detail.identity.storeId !== storeId) return <div className="error-note">This report does not belong to the extension in the URL.</div>;
  const data = result.data;
  const other = data.detail.otherAnalyses?.find((report) => report.reportId !== data.reportId);
  return <section className="result-workbench" aria-label="Exact-report workbench"><div className="result-workbench-heading"><div><div className="workspace-eyebrow">Exact-report workbench</div><h2>Report #{data.reportId}</h2><p>Inspect execution, compare investigations, and export this result.</p></div><Link className="btn" to={`/compare/${encodeURIComponent(storeId)}?left=${data.reportId}${other ? `&right=${other.reportId}` : ""}`}>Compare reports →</Link></div>
    <div className="result-workbench-columns"><ResultProvenance result={data} /><ResultUsage result={data} /></div>
    <div className="result-artifacts"><div><h3>Report artifacts</h3><p className="result-note">Exports contain this exact assessment, recorded provenance, findings, and accounting.</p><p className="result-note">{data.artifacts.source === "lookup-available" ? "Source lookup is available for report-scoped citations. Individual files may be missing or changed since analysis." : data.artifacts.source === "not-served" ? "Source files are not served by this deployment. Recorded citations remain in the report." : "No source location was recorded for this report. Citations remain available."}</p></div><ResultExports reportId={data.reportId} /></div>
  </section>;
}
