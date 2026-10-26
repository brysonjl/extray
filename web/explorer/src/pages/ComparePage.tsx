import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { FindingDifference, ResultComparison, ResultWorkbench as ResultData } from "../../../../src/product/result-workbench";
import type { Finding } from "../types";
import { apiGet } from "../api";
import { useRole } from "../role";
import { AnalysisAccess, Timestamp } from "../components/analysis";
import { ErrorNote, Spinner, SyntheticBadge, TierBadge } from "../components/ui";
import { ResultExports, ResultProvenance, ResultUsage } from "../components/ResultWorkbench";
import { FindingBody } from "../components/Findings";
import "../results.css";

function ComparedFinding({ finding, result }: { finding: Finding | null; result: ResultData }) {
  if (!finding) return <div className="compare-finding absent">Not reported in this analysis.</div>;
  return (
    <article className="compare-finding">
      <h3>{finding.title || "Untitled finding"}</h3>
      <div className="finding-meta">
        <span className={`sev sev-${finding.severity || "unknown"}`}>{finding.severity || "Unknown severity"}</span>
        {finding.category ? <span>{finding.category}</span> : null}
        <span>{finding.confidence ? `${finding.confidence} confidence` : "Confidence unknown"}</span>
      </div>
      <FindingBody f={finding} storeId={result.detail.identity.storeId} reportId={String(result.reportId)} />
      <Link className="result-small-link" to={`/ext/${encodeURIComponent(result.detail.identity.storeId)}?report=${result.reportId}`}>Open report #{result.reportId} →</Link>
    </article>
  );
}

function ReportSummary({ label, result }: { label: string; result: ResultData }) {
  const detail = result.detail;
  return <section className="compare-report-summary"><div className="workspace-eyebrow">{label} · Report #{result.reportId}</div><h2>{result.execution.methodology} <span>{result.execution.model}</span></h2><div className="compare-report-meta"><TierBadge tier={detail.verdict.tier} /><span>Version {detail.identity.version ?? "unknown"}</span></div><p>{detail.verdict.headline || "No rationale recorded"}</p><div className={`compare-outcome ${detail.outcome?.investigation === "incomplete" ? "incomplete" : ""}`}><strong>{detail.outcome ? `${detail.outcome.investigation} investigation` : "Investigation completeness unknown"}</strong>{detail.outcome ? <span>Final submission: {detail.outcome.final_submission}</span> : null}{detail.outcome?.reasons.length ? <ul>{detail.outcome.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul> : null}</div><details className="result-configuration"><summary>Coverage and limitations</summary><p className="result-note">{detail.partialAnalysis ? "Static analysis was partial." : "No partial static analysis flag recorded."} {detail.excludedClaims.length} excluded claims · {detail.dismissals.length} dismissals.</p>{detail.structuralLimits.length || detail.unparsedFiles.length ? <ul className="result-note">{detail.structuralLimits.map((limit, index) => <li key={`limit-${index}`}>{limit}</li>)}{detail.unparsedFiles.map((file) => <li key={file}>Unparsed: {file}</li>)}</ul> : <p className="result-note">No structural limits or unparsed files were recorded.</p>}</details><p className="result-note"><Timestamp value={detail.provenance.assessedAt} /></p><ResultExports reportId={result.reportId} /></section>;
}

export default function ComparePage() { return <AnalysisAccess><CompareWorkspace /></AnalysisAccess>; }

function CompareWorkspace() {
  const { storeId = "" } = useParams();
  const { role } = useRole();
  const [params, setParams] = useSearchParams();
  const left = params.get("left") ?? "";
  const right = params.get("right") ?? "";
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [section, setSection] = useState<"findings" | "provenance" | "usage">("findings");
  const base = useQuery({ queryKey: ["comparison-options", role, storeId, left], queryFn: () => apiGet<ResultData>(left ? `/api/results/${encodeURIComponent(left)}` : `/api/extensions/${encodeURIComponent(storeId)}/result`, role) });
  const compare = useQuery({ queryKey: ["result-comparison", role, storeId, left, right], queryFn: () => apiGet<ResultComparison>(`/api/results/compare?${new URLSearchParams({ left, right })}`, role), enabled: Boolean(left && right && left !== right) });
  const validBase = base.data?.detail.identity.storeId === storeId ? base.data : undefined;
  const data = compare.data?.storeId === storeId ? compare.data : undefined;
  const options = validBase?.detail.otherAnalyses ?? [];
  function change(side: "left" | "right", value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(side, value); else next.delete(side);
    if (side === "right" && !left && validBase) next.set("left", String(validBase.reportId));
    setParams(next);
  }
  const rows: FindingDifference[] = data?.findings.filter((finding) => showUnchanged || finding.change !== "unchanged") ?? [];
  return <main className="compare-workspace"><Link className="workspace-back" to={`/ext/${encodeURIComponent(storeId)}${left ? `?report=${encodeURIComponent(left)}` : ""}`}>← Back to assessment</Link><div className="workspace-heading"><div><div className="workspace-eyebrow">Results workbench</div><h1>Compare investigations</h1><p>{validBase?.detail.identity.name ?? storeId}{validBase?.detail.identity.synthetic ? <SyntheticBadge sample={validBase.detail.identity.sample} /> : null}</p></div></div>
    <div className="compare-selectors"><label className="field"><span>Baseline report</span><select value={left || String(validBase?.reportId ?? "")} onChange={(event) => change("left", event.target.value)}><option value="">Select a report</option>{options.map((report) => <option key={report.reportId} value={report.reportId}>#{report.reportId} · {report.methodology} · {report.model} · {report.assessedAt.slice(0, 10)}</option>)}{validBase && !options.some((report) => report.reportId === validBase.reportId) ? <option value={validBase.reportId}>#{validBase.reportId} · {validBase.execution.methodology}</option> : null}</select></label><button type="button" className="btn secondary" disabled={!left || !right} onClick={() => setParams({ left: right, right: left })} aria-label="Swap baseline and comparison reports">⇄</button><label className="field"><span>Comparison report</span><select value={right} onChange={(event) => change("right", event.target.value)}><option value="">Select another report</option>{options.map((report) => <option key={report.reportId} value={report.reportId} disabled={String(report.reportId) === (left || String(validBase?.reportId))}>#{report.reportId} · {report.methodology} · {report.model} · {report.assessedAt.slice(0, 10)}</option>)}</select></label></div>
    {base.error ? <ErrorNote error={base.error} /> : null}{compare.error ? <ErrorNote error={compare.error} /> : null}{left && left === right ? <div className="error-note">Choose two different reports.</div> : null}{base.data && !validBase || compare.data && !data ? <div className="error-note">The selected reports do not belong to this extension.</div> : null}
    {base.isPending || (compare.isPending && left && right && left !== right) ? <Spinner label="Loading exact reports…" /> : null}
    {!right && validBase ? <div className="workspace-empty"><h2>Choose an analysis to compare</h2><p>{options.length < 2 ? "Only one report is available. Run another analysis of this extension to compare methodology, configuration, coverage, and findings." : "Select a second report above. Both sides stay attached to their exact report and source references."}</p>{options.length < 2 ? <Link className="btn secondary" to={`/submit?input=${encodeURIComponent(storeId)}`}>Configure another analysis</Link> : null}</div> : null}
    {data ? <>
      {data.differentVersion === true ? <div className="banner warn">These reports analyzed different extension versions. Changes may reflect the package as well as the investigation settings.</div> : data.differentVersion === null ? <div className="banner info">At least one extension version was not recorded. Package equivalence cannot be established.</div> : null}
      <div className="compare-columns"><ReportSummary label="Baseline" result={data.left} /><ReportSummary label="Comparison" result={data.right} /></div>
      <div className="compare-counts">{(["added", "removed", "changed", "unchanged"] as const).map((key) => <div key={key}><strong>{data.counts[key]}</strong><span>{key}</span></div>)}</div>
      <div className="workspace-tabs compare-tabs" aria-label="Comparison sections">{(["findings", "provenance", "usage"] as const).map((tab) => <button type="button" key={tab} className={section === tab ? "active" : ""} aria-pressed={section === tab} onClick={() => setSection(tab)}>{tab === "provenance" ? "Versions & settings" : tab === "usage" ? "Usage & cost" : "Finding differences"}</button>)}</div>
      {section === "findings" ? <><p className="result-note">{data.matching}</p><label className="check compare-unchanged"><input type="checkbox" checked={showUnchanged} onChange={(event) => setShowUnchanged(event.target.checked)} />Show unchanged findings</label>{rows.length ? rows.map((finding) => <section className={`compare-difference change-${finding.change}`} key={finding.key}><div className="compare-change-label">{finding.change}</div><div className="compare-columns"><ComparedFinding finding={finding.before} result={data.left} /><ComparedFinding finding={finding.after} result={data.right} /></div></section>) : <div className="workspace-empty"><h2>No finding differences</h2><p>{data.counts.unchanged ? "All matched findings have the same recorded content. Turn on unchanged findings to inspect the evidence." : "Neither report records findings. Review investigation completeness and limitations on each side."}</p></div>}</> : null}
      {section === "provenance" ? <div className="compare-columns"><ResultProvenance result={data.left} /><ResultProvenance result={data.right} /></div> : null}
      {section === "usage" ? <div className="compare-columns"><ResultUsage result={data.left} /><ResultUsage result={data.right} /></div> : null}
    </> : null}
  </main>;
}
