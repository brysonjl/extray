// Detail — the decision console (plan §8). Inverted pyramid: verdict →
// signals → summaries → evidence → limits. Everything below the fold is
// drill-down. The Admin-only footer band (other analyses, cost, tokens)
// renders from fields the User API never returns.

import { useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { apiGet, apiPost } from "../api";
import { AdminOnly, useRole } from "../role";
import {
  ErrorNote,
  LevelLegend,
  PiCaveat,
  RiskVerdict,
  SafeLink,
  Section,
  SignalMeter,
  Spinner,
  SyntheticBadge,
  TierBadge,
  formatDate,
  formatTokens,
  formatUsd,
} from "../components/ui";
import type { ExtensionDetail, Submission, SubmissionExists } from "../types";
import { FindingProse, FindingRow } from "../components/Findings";
import { ResultWorkbench } from "../components/ResultWorkbench";

function Summaries({ d }: { d: ExtensionDetail }) {
  const [tab, setTab] = useState<"layperson" | "technical">("layperson");
  const text = d.summaries[tab];
  const baseId = useId();
  return (
    <div className="glance">
      <div className="tabs" role="tablist" aria-label="Summary audience">
        <button
          role="tab"
          id={`${baseId}-tab-layperson`}
          aria-selected={tab === "layperson"}
          aria-controls={`${baseId}-panel`}
          className={tab === "layperson" ? "active" : ""}
          onClick={() => setTab("layperson")}
        >
          For a non-technical reader
        </button>
        <button
          role="tab"
          id={`${baseId}-tab-technical`}
          aria-selected={tab === "technical"}
          aria-controls={`${baseId}-panel`}
          className={tab === "technical" ? "active" : ""}
          onClick={() => setTab("technical")}
        >
          Technical
        </button>
      </div>
      <div className="summary-text" role="tabpanel" id={`${baseId}-panel`} aria-labelledby={`${baseId}-tab-${tab}`}>
        {text || <span className="faint">No summary recorded.</span>}
      </div>
    </div>
  );
}

function boolFlag(v: boolean | null) {
  if (v === null) return <span className="faint">unknown</span>;
  return v ? <span className="flag-yes">yes</span> : <span className="ok">no</span>;
}

export default function DetailPage() {
  const { storeId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { role, canAnalyses } = useRole();
  const navigate = useNavigate();
  const reportId = params.get("report"); // admin: viewing a non-canonical analysis

  const { data: d, error, isPending } = useQuery({
    queryKey: ["detail", role, storeId, reportId],
    queryFn: () =>
      apiGet<ExtensionDetail>(reportId ? `/api/reports/${reportId}` : `/api/extensions/${storeId}`, role),
  });

  const reanalyze = useMutation({
    mutationFn: () => apiPost<Submission | SubmissionExists>("/api/submissions", role, { input: storeId, force: true }),
    onSuccess: (res) => {
      if ("jobId" in res) navigate(canAnalyses ? `/analyses/${res.jobId}` : `/submit?job=${res.jobId}&store=${storeId}`);
    },
  });

  if (isPending) return <Spinner label="Loading assessment…" />;
  if (error) {
    return (
      <div>
        <ErrorNote error={error} />
        <p className="muted">
          This extension may not have been assessed yet. <Link to={`/submit?input=${storeId}`}>Submit it for analysis</Link>{" "}
          or go <Link to="/">back to the catalog</Link>.
        </p>
      </div>
    );
  }
  if (!d) return null;
  if (d.identity.storeId !== storeId) return <ErrorNote error={new Error("This report does not belong to the extension in the URL.")} />;
  const resolvedReportId = d.provenance.reportId ? String(d.provenance.reportId) : reportId;

  const pipeline = d.provenance.pipeline;
  const provenanceLine = pipeline
    ? `${pipeline.methodology} · ${pipeline.model}${pipeline.isFallback ? " (fallback)" : ""}${pipeline.think ? ` · think ${pipeline.think}` : ""}${pipeline.mode ? ` · ${pipeline.mode}` : ""}`
    : `analysis engine ${d.provenance.engineVersion ? `v${d.provenance.engineVersion}` : ""}`.trim();

  return (
    <div>
      <p>
        <Link to="/">‹ Back to catalog</Link>
      </p>

      {reportId ? (
        <div className="banner info">
          Viewing an exact report.{" "}
          <a
            href={`/ext/${storeId}`}
            onClick={(e) => {
              e.preventDefault();
              const next = new URLSearchParams(params);
              next.delete("report");
              setParams(next);
            }}
          >
            Back to the canonical verdict
          </a>
        </div>
      ) : null}

      <div className="detail-head">
        <div className="head-main">
          <h1>
            {d.identity.name}
            {d.identity.synthetic ? <SyntheticBadge sample={d.identity.sample} /> : null}
          </h1>
          <div className="head-meta">
            <span className="mono">{d.identity.storeId}</span>
            {d.identity.version ? <span>v{d.identity.version}</span> : null}
            {d.identity.manifestVersion ? <span>MV{d.identity.manifestVersion}</span> : null}
            <span>
              {provenanceLine} · assessed {formatDate(d.provenance.assessedAt)}
            </span>
            {/* No store link for a synthetic sample — there is nothing there. */}
            {d.identity.synthetic ? null : (
              <span>
                <SafeLink href={`https://chromewebstore.google.com/detail/${encodeURIComponent(d.identity.storeId)}`}>
                  Chrome Web Store ↗
                </SafeLink>
              </span>
            )}
          </div>
          {d.verdict.headline ? <p className="head-headline">“{d.verdict.headline}”</p> : null}
        </div>
        {d.skillReview ? <span className="banner warn">Unverified review</span> : <TierBadge tier={d.verdict.tier} large />}
      </div>

      {d.identity.synthetic ? (
        <div className="banner warn">
          <strong>ExtRay test fixture.</strong> Harmful behaviors in modified variants were deliberately introduced
          for evaluation. Findings apply only to this fixture, not to any published extension. Sample:{" "}
          <span className="mono">corpus/{d.identity.sample}</span>.
        </div>
      ) : d.identity.version ? (
        <div className="banner notice">
          Assessed against v{d.identity.version}; the current store version may differ.
        </div>
      ) : null}
      {d.outcome?.investigation === "incomplete" ? (
        <div className="banner warn" role="alert">
          <strong>Incomplete investigation — provisional assessment.</strong> Report generated;
          final submission {d.outcome.final_submission}. Individual verified findings remain useful;
          full investigation coverage is not established.
          {d.outcome.reasons.length > 0 ? <p>{d.outcome.reasons.join("; ")}</p> : null}
        </div>
      ) : null}
      {d.unparsedFiles.length > 0 ? (
        <div className="banner notice">
          ⚠ Partial analysis: {d.unparsedFiles.length} file{d.unparsedFiles.length === 1 ? "" : "s"} couldn't be parsed
          ({d.unparsedFiles.slice(0, 3).join(", ")}
          {d.unparsedFiles.length > 3 ? ", …" : ""}) — treat gaps warily.
        </div>
      ) : null}

      {!d.skillReview ? <div className="glance">
        <h2>Risk at a glance</h2>
        <RiskVerdict signals={d.verdict.signals} tier={d.verdict.tier} />
        <SignalMeter signals={d.verdict.signals} describe />
        <LevelLegend />
        {d.verdict.signals.some((s) => s.note && s.level !== "none") ? (
          <div style={{ marginTop: 14, display: "grid", gap: 4 }}>
            {d.verdict.signals
              .filter((s) => s.note && s.level !== "none")
              .map((s) => (
                <div key={s.area} style={{ fontSize: 12.5 }}>
                  <span className={`lvl-${s.level}`} style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    {s.area}
                  </span>
                  <span className="chip-note"> — {s.note}</span>
                </div>
              ))}
          </div>
        ) : null}
        {d.verdict.rationale && d.verdict.rationale !== d.verdict.headline ? (
          <p className="muted" style={{ marginBottom: 0, fontFamily: "var(--sans)" }}>{d.verdict.rationale}</p>
        ) : null}
      </div> : null}

      <Summaries d={d} />

      {d.skillReview ? (
        <>
          <div className="banner warn">
            <strong>Imported agent review — unverified candidates.</strong> Source references and report structure
            were validated; the independent claim verifier and risk engine were not run.
            Investigation reported as {d.skillReview.investigation} by {d.skillReview.harness} ({d.skillReview.model}).
            The inconclusive tier is a placeholder, not an engine risk verdict.
          </div>
          <Section title="Candidate findings (unverified)" count={d.skillReview.candidates.length} defaultOpen>
            <p className="faint">Severity and confidence below are the reviewing agent's assessments.</p>
            {d.skillReview.candidates.map((f) => <FindingRow key={f.id} f={f} storeId={storeId} reportId={resolvedReportId} />)}
            {d.skillReview.candidates.length === 0 ? <p>No candidates were submitted; this does not establish safety.</p> : null}
          </Section>
          <Section title="Agent-reported coverage" count={d.skillReview.coverage.length}>
            {d.skillReview.coverage.map((c) => (
              <div key={c.dimension} style={{ marginBottom: 12 }}>
                <strong>{c.dimension}: {c.status}</strong><p>{c.note}</p>
                <div className="faint">{c.checksRun.join("; ")}</div>
              </div>
            ))}
            <p className="faint">Skill v{d.skillReview.skillVersion} · session {d.skillReview.sessionId ?? "not recorded"}</p>
            <p className="mono faint" style={{ overflowWrap: "anywhere" }}>Source SHA-256: {d.skillReview.sourceSha256}</p>
            <p className="mono faint" style={{ overflowWrap: "anywhere" }}>Review SHA-256: {d.skillReview.reviewSha256}</p>
          </Section>
        </>
      ) : null}

      {d.descriptionDeviation?.deviates ? (
        <div className="banner danger">
          ⚠ Behavior deviates from the extension's stated purpose:{" "}
          <span className="muted">“{d.descriptionDeviation.statedPurpose.slice(0, 200)}…”</span>
        </div>
      ) : null}

      <Section title="Findings" count={d.findings.length} defaultOpen={d.findings.length > 0}>
        {d.findings.length === 0 ? (
          <p className="muted">No findings were asserted against source.</p>
        ) : (
          d.findings.map((f) => <FindingRow key={`${f.id}-${f.number}`} f={f} storeId={storeId} reportId={resolvedReportId} />)
        )}
      </Section>

      <Section
        title="Permissions"
        count={`${d.permissions.api.length} API · ${d.permissions.hostsRequired.length} host`}
      >
        {d.permissions.hostsPlain ? <p>{d.permissions.hostsPlain}</p> : null}
        {d.permissions.hostsRequired.length > 0 ? (
          <p className="mono muted">{d.permissions.hostsRequired.join("  ")}</p>
        ) : null}
        {d.permissions.dangerousCombinations.length > 0 ? (
          <div className="banner danger">
            ⚠ Dangerous combinations:{" "}
            {d.permissions.dangerousCombinations.map((c) => c.kind).join(", ")}
          </div>
        ) : null}
        {d.permissions.api.length > 0 ? (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Permission</th>
                  <th>Status</th>
                  <th>Use sites</th>
                  <th>What it allows</th>
                </tr>
              </thead>
              <tbody>
                {d.permissions.api.map((p) => (
                  <tr key={p.permission}>
                    <td className="perm-name mono">
                      {p.docUrl ? <SafeLink href={p.docUrl}>{p.permission}</SafeLink> : p.permission}
                      {p.optional ? <span className="faint"> (optional)</span> : null}
                    </td>
                    <td>{p.status}</td>
                    <td>{p.totalUsage}</td>
                    <td className="muted">
                      {p.usagePlain ?? p.description ?? ""}
                      {p.installWarning ? <div className="warn-text">{p.installWarning}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No API permissions declared.</p>
        )}
      </Section>

      <Section
        title="Network destinations"
        count={`${d.destinations.rows.length} hosts · ${d.destinations.unresolvedCount} unresolved`}
      >
        {d.destinations.rows.length === 0 ? (
          <p className="muted">No static network destinations found.</p>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Host</th>
                  <th>Refs</th>
                  <th>Dynamic?</th>
                  <th>Party</th>
                  <th>Reached via</th>
                </tr>
              </thead>
              <tbody>
                {d.destinations.rows.map((row) => (
                  <tr key={row.host}>
                    <td className="mono">{row.host}</td>
                    <td>{row.references}</td>
                    <td>{row.anyDynamic ? <span className="warn-text">yes</span> : "no"}</td>
                    <td>{row.party ?? <span className="faint">—</span>}</td>
                    <td className="muted" style={{ maxWidth: 380, overflowWrap: "anywhere" }}>
                      {row.reachedVia.slice(0, 4).join(", ")}
                      {row.reachedVia.length > 4 ? ` +${row.reachedVia.length - 4} more` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d.destinations.unresolvedCount > 0 ? (
          <p className="faint">
            {d.destinations.unresolvedCount} destination expression{d.destinations.unresolvedCount === 1 ? "" : "s"}{" "}
            could not be resolved statically (dynamic URLs).
          </p>
        ) : null}
      </Section>

      {d.obfuscation.flagged.length > 0 ? (
        <Section title="Obfuscation signals" count={d.obfuscation.flagged.length}>
          <ul>
            {d.obfuscation.flagged.map((f) => (
              <li className="mono" key={f.path}>{f.path}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Developer">
        <dl className="kv">
          <dt>Name</dt>
          <dd>{d.developer.name ?? <span className="faint">unknown</span>}</dd>
          <dt>Website</dt>
          <dd>{d.developer.website ? <SafeLink href={d.developer.website} /> : <span className="faint">—</span>}</dd>
          <dt>Country</dt>
          <dd>
            {d.developer.country ?? <span className="faint">unknown</span>}
            {d.developer.highRiskCountry ? <span className="flag-yes"> (high-risk)</span> : null}
          </dd>
          <dt>Registered trader</dt>
          <dd>{boolFlag(d.developer.isTrader)}</dd>
          <dt>Non-store update URL</dt>
          <dd>{boolFlag(d.developer.nonStoreUpdate)}</dd>
        </dl>
      </Section>

      {d.excludedClaims.length > 0 ? (
        <Section title="Considered & excluded" count={d.excludedClaims.length}>
          <p className="faint">Claims the analysis raised and then ruled out — shown so you can see what was checked.</p>
          {d.excludedClaims.map((c) => (
            <div className="finding" key={c.id}>
              <div className="finding-static-heading">
                <h3 className="finding-title">{c.title}</h3>
                <div className="finding-meta"><span className="sev sev-unknown">{c.reason || "excluded"}</span></div>
              </div>
              {c.detail ? <div className="finding-detail finding-body"><FindingProse text={c.detail} /></div> : null}
            </div>
          ))}
        </Section>
      ) : null}

      {d.dismissals.length > 0 ? (
        <Section title="Checked & cleared" count={d.dismissals.length}>
          <p className="faint">Dimensions the analysis examined and found nothing in.</p>
          <ul>
            {d.dismissals.map((dm, i) => (
              <li key={i} style={{ marginBottom: 8 }}>
                <b>{dm.concern}</b>
                {dm.note ? <span className="muted"> — {dm.note}</span> : null}
                {dm.checksRun.length > 0 ? (
                  <div className="faint" style={{ fontSize: 12 }}>checks: {dm.checksRun.join("; ")}</div>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Limits of this analysis" count={d.structuralLimits.length} defaultOpen={false}>
        <p className="faint">
          Static review cannot see remote configuration, time-delayed payloads, or server-side behavior. Known
          structural limits of this assessment:
        </p>
        <ul>
          {d.structuralLimits.map((l, i) => (
            <li key={i} className="muted">{l}</li>
          ))}
        </ul>
      </Section>

      <div className="actions">
        <button className="btn secondary" onClick={() => window.print()}>
          Export (print / PDF)
        </button>
        <button
          className="btn secondary"
          onClick={() => void navigator.clipboard.writeText(window.location.href)}
        >
          Copy link
        </button>
        <button className="btn" disabled={reanalyze.isPending} onClick={() => reanalyze.mutate()}>
          {reanalyze.isPending ? "Queueing…" : "Re-analyze"}
        </button>
        {reanalyze.error ? <ErrorNote error={reanalyze.error} /> : null}
      </div>
      <PiCaveat />

      <AdminOnly>
        <ResultWorkbench storeId={storeId} reportId={resolvedReportId} />
        {d.cost || (d.otherAnalyses && d.otherAnalyses.length > 0) ? (
          <div className="admin-band">
            <h2>Admin</h2>
            {d.cost ? (
              <p className="muted">
                Analysis cost {formatUsd(d.cost.usd)} · {formatTokens(d.cost.inputTokens)} in /{" "}
                {formatTokens(d.cost.outputTokens)} out tokens
              </p>
            ) : null}
            {d.otherAnalyses && d.otherAnalyses.length > 1 ? (
              <div className="analyses-list">
                {d.otherAnalyses.map((a) => (
                  <div className={`analysis-row ${!reportId && a.isCanonical ? "current" : ""}`} key={a.reportId}>
                    <TierBadge tier={a.tier} />
                    <span className="mono">
                      {a.methodology} · {a.model}
                    </span>
                    <span className="faint">{formatDate(a.assessedAt)}</span>
                    <span style={{ flex: 1 }} />
                    {a.isCanonical ? <span className="faint">canonical</span> : null}
                    {(reportId ? String(a.reportId) !== reportId : !a.isCanonical) ? (
                      <a
                        href={`/ext/${storeId}?report=${a.reportId}`}
                        onClick={(e) => {
                          e.preventDefault();
                          setParams({ report: String(a.reportId) });
                        }}
                      >
                        view
                      </a>
                    ) : (
                      <span className="faint">viewing</span>
                    )}
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </AdminOnly>
    </div>
  );
}
