// Self-contained HTML renderer for the RiskReport contract: one static file,
// inline CSS, no scripts, no external assets — shareable as-is. The layperson
// layer (verdict card + plain-language summary) sits on top; the analyst layer
// (tables, findings with code excerpts) follows in native <details> sections.
//
// SECURITY: every interpolated string slot is attacker-controlled (extension
// code, model output derived from extension code, scraped listing fields) and
// flows through esc(). The only non-esc'd interpolations are (a) pipeline-typed
// NUMBERS (counts, line numbers) which cannot be attacker strings, and (b) two
// CSS `background:` slots, which take a value from safeColor() — a guarded
// lookup that emits only a validated #rrggbb hex, never attacker text. A
// malicious extension must not be able to script the report that describes it.
//
// esc/safeUrl/section/yesNo/enrichmentHtml and the stylesheet are exported so
// the static-only report (render-static-html.ts) renders in the same house style
// against the same escaping rules — one page, two entry points, one look.

import type { EvidenceRef } from "../methodologies/findings.ts";
import type { AreaLevel, DestinationRow, ExcludedClaim, ReportDismissal, ReportFinding, RiskReport, Tier } from "./contract.ts";
import { PERMISSIONS_LIST_URL } from "./permission-catalog.ts";
import { FIXTURE_NOTICE } from "../fixture-context.ts";
import { outcomeNotice } from "./outcome.ts";

export function fixtureNoticeHtml(): string {
  return `<aside class="fixture-notice" role="note"><strong>Synthetic test fixture</strong><p>${esc(FIXTURE_NOTICE)}</p></aside>`;
}

export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// RDAP+DNS enrichment (015/017) as one table cell: owner/registrar + registration
// date, then either a CDN label or the resolved/literal IP's owner/ASN/country
// (never both — once a CDN match exists, those IP facts describe the edge
// network, not the destination, so the cell labels it rather than asserting a
// country of origin), then any TRUE descriptive flag. Context, not verdict —
// registration facts are self-reported, so they are shown as facts-with-provenance.
export function enrichmentHtml(enr: DestinationRow["enrichment"]): string {
  if (!enr) return "—";
  if (enr.lookup_status !== "ok") return esc(enr.lookup_status);
  const parts: string[] = [];
  if (enr.domain) {
    const d = enr.domain;
    if (d.registrar || d.registrant_org) parts.push(esc(d.registrar ?? d.registrant_org!));
    if (d.created) parts.push(`reg ${esc(d.created.slice(0, 10))}`);
    if (d.expires) parts.push(`exp ${esc(d.expires.slice(0, 10))}`);
  }
  if (enr.cdn) {
    parts.push(`fronted by ${esc(enr.cdn.provider)}`);
  } else if (enr.ip) {
    const ip = enr.ip;
    if (ip.owner_org || ip.network_name) parts.push(esc(ip.owner_org ?? ip.network_name!));
    if (ip.asn) parts.push(esc(ip.asn));
    if (ip.country) parts.push(esc(ip.country));
  }
  const flags = [
    enr.newly_registered === true ? "newly-registered" : null,
    enr.expired_or_hold === true ? "expired/hold" : null,
    enr.high_risk_country === true ? "high-risk-country" : null,
  ].filter((f): f is string => f !== null);
  if (flags.length > 0) parts.push(`<strong>[${esc(flags.join(", "))}]</strong>`);
  return parts.join(" · ") || "ok";
}

// The ONLY values allowed into a CSS context. A map lookup that drifts off-enum
// would yield undefined; this collapses that (or any non-hex) to a safe default
// so a CSS-context interpolation can never carry attacker text.
const HEX = /^#[0-9a-f]{6}$/i;
function safeColor(c: string | undefined, fallback = "#5f6368"): string {
  return c && HEX.test(c) ? c : fallback;
}

// Doc links are the only outbound hrefs in the report. The contract sources them
// from the trusted permission catalog, but defense-in-depth: only an http(s) URL
// is allowed into an href, so an attacker-controlled value (e.g. javascript:)
// can never become a clickable link. Anything else collapses to the docs index.
export function safeUrl(url: string, fallback = PERMISSIONS_LIST_URL): string {
  return /^https?:\/\//i.test(url) ? url : fallback;
}

const MAX_SITES_IN_CELL = 4;
const STATED_PURPOSE_CHARS = 600;

const TIER_COLORS: Record<Tier, string> = {
  clean: "#1b7a3d",
  "low-risk": "#4f8a2e",
  concerning: "#c46a00",
  "high-risk": "#b3261e",
  inconclusive: "#5f6368",
};

const TIER_LABELS: Record<Tier, string> = {
  clean: "Clean",
  "low-risk": "Low risk",
  concerning: "Concerning",
  "high-risk": "High risk",
  inconclusive: "Inconclusive",
};

const LEVEL_COLORS: Record<AreaLevel, string> = {
  none: "#1b7a3d",
  low: "#4f8a2e",
  notable: "#c46a00",
  high: "#b3261e",
};

const EXCLUSION_LABELS: Record<ExcludedClaim["reason"], string> = {
  refuted: "Refuted against source",
  "needs-dynamic": "Needs dynamic analysis",
  inconclusive: "Verification inconclusive",
  "unresolvable-evidence": "Evidence does not resolve",
  "not-verified": "Not verified",
};

export const CSS = `
  .fixture-notice { border: 1px solid #c69b2e; border-left: 4px solid #a67916; border-radius: 8px; padding: 14px 18px; margin: 16px 0 22px; background: #fff8e5; color: #493914; }
  .fixture-notice p { margin: 6px 0 0; }
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
         margin: 0; background: #f6f7f9; color: #1f2328; line-height: 1.55; }
  main { max-width: 920px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  .meta { color: #57606a; font-size: 0.85rem; margin-bottom: 24px; }
  .meta code { background: #eef0f3; padding: 1px 5px; border-radius: 4px; }
  .card { background: #fff; border: 1px solid #d8dde3; border-radius: 10px; padding: 20px 24px; margin-bottom: 20px; }
  .verdict { display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap; }
  .tier-badge { font-size: 1.05rem; font-weight: 700; color: #fff; padding: 8px 18px; border-radius: 8px;
                text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
  .verdict-body { flex: 1; min-width: 260px; }
  .areas { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .area { border: 1px solid #d8dde3; border-radius: 6px; padding: 6px 10px; font-size: 0.82rem; background: #fafbfc; max-width: 240px; }
  .area b { display: block; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.05em; color: #57606a; }
  .area .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; }
  .area-note { color: #57606a; font-size: 0.76rem; margin-top: 3px; font-weight: 400; }
  .conf { color: #57606a; font-size: 0.78rem; margin: 6px 0 0; }
  .summary p { font-size: 1.02rem; margin: 0; }
  details { background: #fff; border: 1px solid #d8dde3; border-radius: 10px; margin-bottom: 14px; }
  details > summary { cursor: pointer; padding: 14px 20px; font-weight: 600; font-size: 1rem; list-style: none; }
  details > summary::before { content: "▸ "; color: #57606a; }
  details[open] > summary::before { content: "▾ "; }
  details > .body { padding: 0 20px 18px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.88rem; margin: 6px 0 10px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #e6e9ed; vertical-align: top; }
  th { color: #57606a; font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.85em;
         background: #eef0f3; padding: 1px 5px; border-radius: 4px; word-break: break-all; }
  pre { background: #0f1419; color: #e6edf3; padding: 12px 14px; border-radius: 8px; overflow-x: auto;
        font-size: 0.8rem; line-height: 1.45; }
  pre code { background: none; padding: 0; color: inherit; }
  .finding { border-top: 1px solid #e6e9ed; padding: 14px 0 4px; }
  .finding:first-of-type { border-top: none; }
  .finding h3 { font-size: 0.98rem; margin: 0 0 8px; }
  .pill { display: inline-block; font-size: 0.7rem; font-weight: 700; padding: 2px 8px; border-radius: 999px;
          text-transform: uppercase; letter-spacing: 0.04em; vertical-align: 2px; margin-left: 8px; }
  .pill.verified { background: #fde7e5; color: #b3261e; }
  .pill.observed { background: #e7eef9; color: #1d4f91; }
  .pill.excluded { background: #efefef; color: #5f6368; }
  .label { font-size: 0.78rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
           color: #57606a; margin: 10px 0 2px; }
  ul.refs { margin: 4px 0; padding-left: 20px; font-size: 0.86rem; }
  .note { color: #57606a; font-size: 0.85rem; font-style: italic; }
  .empty { color: #57606a; font-style: italic; }
  .deviates-yes { color: #b3261e; font-weight: 700; }
  .deviates-no { color: #1b7a3d; font-weight: 700; }
`;

function refItem(r: EvidenceRef): string {
  const loc = r.location ? `:${r.location.line}${r.location.column !== undefined ? `:${r.location.column}` : ""}` : "";
  const extras = [r.symbol ? `symbol <code>${esc(r.symbol)}</code>` : "", r.sink_or_string ? `cites <code>${esc(r.sink_or_string)}</code>` : ""]
    .filter(Boolean)
    .join(", ");
  return `<li><code>${esc(r.file)}${esc(loc)}</code>${extras ? ` (${extras})` : ""}</li>`;
}

function findingHtml(f: ReportFinding): string {
  const pill = f.kind === "verified-behavior" ? `<span class="pill verified">verified behavior</span>` : `<span class="pill observed">observed capability</span>`;
  const parts = [`<div class="finding"><h3>${f.number}. ${esc(f.title)}${pill}</h3>`];
  if (f.detail) parts.push(`<p>${esc(f.detail)}</p>`);
  if (f.claimed_mechanism) parts.push(`<div class="label">Mechanism</div><p>${esc(f.claimed_mechanism)}</p>`);
  parts.push(`<p class="conf">Confidence (as generated): ${esc(f.confidence)}</p>`);
  if (f.evidence_refs.length > 0) parts.push(`<div class="label">Evidence</div><ul class="refs">${f.evidence_refs.map(refItem).join("")}</ul>`);
  if (f.verification) {
    const v = f.verification;
    const at = v.grounding ? ` at <code>${esc(v.grounding.file)}${v.grounding.line !== null ? `:${v.grounding.line}` : ""}</code>` : "";
    parts.push(`<div class="label">Source verification</div><p><b>confirmed</b>${at}.${v.rationale ? ` ${esc(v.rationale)}` : ""}</p>`);
    if (v.evidence_quote) parts.push(`<pre><code>${esc(v.evidence_quote)}</code></pre>`);
  }
  parts.push("</div>");
  return parts.join("\n");
}

// Mirror render-md's excludedBlock: every excluded claim keeps its evidence
// refs and an explicit "why it is not asserted" line, so the HTML audit trail
// matches the Markdown one. All dynamic strings flow through esc()/refItem();
// the explanatory sentences are constants.
function excludedHtml(e: ExcludedClaim): string {
  const parts = [`<div class="finding"><h3>${esc(e.title)}<span class="pill excluded">${esc(EXCLUSION_LABELS[e.reason])}</span></h3>`];
  if (e.detail) parts.push(`<p>${esc(e.detail)}</p>`);
  if (e.claimed_mechanism) parts.push(`<div class="label">Mechanism (claimed)</div><p>${esc(e.claimed_mechanism)}</p>`);
  if (e.evidence_refs.length > 0) parts.push(`<div class="label">Evidence (as cited)</div><ul class="refs">${e.evidence_refs.map(refItem).join("")}</ul>`);
  if (e.reason === "unresolvable-evidence") {
    parts.push(
      `<p class="note">${
        e.evidence_refs.length === 0
          ? "Not asserted: the claim cites no evidence at all."
          : "Not asserted: none of the cited evidence files exist in the extension — the citation does not resolve and the claim is likely invalid."
      }</p>`,
    );
  } else if (e.reason === "not-verified") {
    parts.push(`<p class="note">Not asserted: this behavioral claim was not verified against source.</p>`);
  } else if (e.verifier_rationale) {
    parts.push(`<div class="label">Source verification</div><p><b>${esc(e.reason)}</b>. ${esc(e.verifier_rationale)}</p>`);
    if (e.verifier_quote) parts.push(`<pre><code>${esc(e.verifier_quote)}</code></pre>`);
  }
  parts.push("</div>");
  return parts.join("\n");
}

function dismissalHtml(d: ReportDismissal): string {
  const parts = [`<div class="finding"><h3>${esc(d.concern)}<span class="pill">checked, cleared</span></h3>`];
  if (d.note) parts.push(`<p>${esc(d.note)}</p>`);
  if (d.checks_run.length > 0) parts.push(`<div class="label">Checks run</div><ul class="refs">${d.checks_run.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>`);
  parts.push("</div>");
  return parts.join("\n");
}

export function section(title: string, bodyHtml: string, open: boolean): string {
  return `<details${open ? " open" : ""}><summary>${esc(title)}</summary><div class="body">${bodyHtml}</div></details>`;
}

export function yesNo(v: boolean | null, nullLabel = "unknown"): string {
  return v === null ? nullLabel : v ? "yes" : "no";
}

/**
 * Optional run provenance (assess CLI only): mode, source dir, token usage,
 * est. cost — the same accounting the .md wrapper appends. Rendered as a footer
 * so the HTML report carries it too. Each value is esc()'d; corpus reports omit
 * it (no HTML is produced there).
 */
export interface RunProvenance {
  rows: Array<{ label: string; value: string }>;
}

export function renderReportHtml(r: RiskReport, provenance?: RunProvenance): string {
  const name = r.extension.name ?? "(unnamed extension)";
  const tierColor = safeColor(TIER_COLORS[r.verdict.tier]);

  const areas = (["permissions", "network", "obfuscation", "developer"] as const)
    .map((area) => {
      const s = r.verdict.per_area.find((a) => a.area === area);
      const color = safeColor(s ? LEVEL_COLORS[s.level] : undefined, "#9aa0a6");
      const level = s ? s.level : "not assessed";
      const note = s ? s.note : "";
      return `<div class="area"><b>${esc(area)}</b><span class="dot" style="background:${color}"></span>${esc(level)}${note ? `<div class="area-note">${esc(note)}</div>` : ""}</div>`;
    })
    .join("");

  const verdictCard = `
  <div class="card verdict">
    <div class="tier-badge" style="background:${tierColor}">${esc(TIER_LABELS[r.verdict.tier])}</div>
    <div class="verdict-body">
      <p>${esc(r.verdict.rationale) || '<span class="empty">No tier rationale was produced.</span>'}</p>
      <div class="areas">${areas}</div>
    </div>
  </div>`;

  const summaryCard = `
  <div class="card summary">
    <p>${esc(r.summaries.layperson) || '<span class="empty">No summary was produced.</span>'}</p>
  </div>`;

  const dd = r.description_deviation;
  const statedBody = dd.stated_purpose
    ? `<p class="note">Stated purpose (from ${dd.stated_source === "store_listing" ? "the store listing" : "the manifest"}):</p>
       <p>“${esc(dd.stated_purpose.length > STATED_PURPOSE_CHARS ? dd.stated_purpose.slice(0, STATED_PURPOSE_CHARS) + "…" : dd.stated_purpose)}”</p>
       <p>Deviation from stated purpose: <span class="${dd.deviates ? "deviates-yes" : dd.deviates === false ? "deviates-no" : ""}">${dd.deviates === null ? "not assessed" : dd.deviates ? "yes" : "no"}</span>.${dd.note ? ` ${esc(dd.note)}` : ""}</p>`
    : `<p class="empty">No stated purpose was available to compare against (no store listing fetched and no manifest description).</p>`;

  const techBody = `<p>${esc(r.summaries.technical) || '<span class="empty">No technical summary was produced.</span>'}</p>`;

  const permRows = r.permissions.api
    .map((p) => {
      const shown = p.usage.slice(0, MAX_SITES_IN_CELL).map((u) => `<code>${esc(u.path)}:${u.line}</code> (${esc(u.api)})`);
      const more = p.total_usage - shown.length;
      const sites = shown.length === 0 ? "—" : shown.join(", ") + (more > 0 ? `, +${more} more` : "");
      const name = `<code>${esc(p.permission)}</code>${p.optional ? ' <span class="note">(optional)</span>' : ""}`;
      const docs = `<a href="${esc(safeUrl(p.doc_url))}" rel="nofollow noreferrer noopener" target="_blank">docs</a>`;
      return `<tr><td>${name}</td><td>${esc(p.description)}</td><td>${esc(p.status)}</td><td>${esc(p.usage_plain)}</td><td>${sites}</td><td>${docs}</td></tr>`;
    })
    .join("");
  const warned = r.permissions.api.filter((p) => p.install_warning);
  const warnLines =
    warned.length > 0
      ? `<div class="label">Chrome's install-time warnings</div><ul class="refs">${warned.map((p) => `<li><code>${esc(p.permission)}</code>: ${esc(p.install_warning!)}</li>`).join("")}</ul>`
      : "";
  const hostLine = `Host access: ${r.permissions.hosts.required.length > 0 ? r.permissions.hosts.required.map((h) => `<code>${esc(h)}</code>`).join(", ") : "none required"}${r.permissions.hosts.optional.length > 0 ? `; optional: ${r.permissions.hosts.optional.map((h) => `<code>${esc(h)}</code>`).join(", ")}` : ""}.`;
  const dangerLines =
    r.permissions.dangerous_combinations.length > 0
      ? `<div class="label">Dangerous combinations</div><ul class="refs">${r.permissions.dangerous_combinations.map((d) => `<li><b>${esc(d.kind)}</b> — ${esc(d.evidence.join("; "))}</li>`).join("")}</ul>`
      : `<p class="note">No dangerous permission combinations were flagged.</p>`;
  const permBody = `${r.permissions.api.length > 0 ? `<table><tr><th>Permission</th><th>What it allows</th><th>Status</th><th>How this extension uses it</th><th>Used at</th><th>Docs</th></tr>${permRows}</table>` : `<p class="empty">No API permissions are declared.</p>`}${warnLines}<p>${hostLine}</p><p class="note">${esc(r.permissions.hosts_plain)}</p>${dangerLines}`;

  const destRows = r.destinations.rows
    .map(
      (d) =>
        `<tr><td><code>${esc(d.host)}</code></td><td>${d.references}</td><td>${esc(d.reached_via.join(", ") || "—")}</td><td>${d.any_dynamic ? "yes" : "no"}</td><td>${esc(d.party ?? "—")}</td><td>${enrichmentHtml(d.enrichment)}</td><td>${d.example_sites.length === 0 ? "—" : d.example_sites.map((s) => `<code>${esc(s.path)}:${s.line}</code> (${esc(s.role)})`).join(", ")}</td></tr>`,
    )
    .join("");
  const unresolved =
    r.destinations.unresolved.length > 0
      ? `<div class="label">Unresolved destinations</div><p class="note">${r.destinations.unresolved.length} network call(s) whose destination could not be statically resolved:</p><ul class="refs">${r.destinations.unresolved.map((u) => `<li><code>${esc(u.path)}:${u.location.line}</code> (${esc(u.ast_role)})</li>`).join("")}</ul>`
      : `<p class="note">All statically visible network calls had resolvable destinations.</p>`;
  const destBody = `${r.destinations.rows.length > 0 ? `<table><tr><th>Host</th><th>Refs</th><th>Reached via</th><th>Dynamic</th><th>Party</th><th>Owner / age (RDAP)</th><th>Example call sites</th></tr>${destRows}</table>` : `<p class="empty">No external destinations were statically resolved.</p>`}${unresolved}`;

  const obfRows = r.obfuscation.flagged
    .map((o) => {
      const indicators = [
        o.string_array_decoder_detected ? "string-array decoder" : null,
        o.packer_signature ? `packer: ${o.packer_signature}` : null,
        `identifier entropy ${o.identifier_entropy.toFixed(2)}`,
        `mean identifier length ${o.mean_identifier_length.toFixed(1)}`,
        o.hex_escape_density_per_kb > 0 ? `hex-escape density ${o.hex_escape_density_per_kb.toFixed(1)}/KB` : null,
      ]
        .filter(Boolean)
        .join(", ");
      return `<tr><td><code>${esc(o.path)}</code></td><td>${esc(indicators)}</td></tr>`;
    })
    .join("");
  const dynExec = r.obfuscation.opaque_regions.filter((o) => o.kind === "dynamic-code-exec");
  const dynExecList =
    dynExec.length > 0
      ? `<div class="label">Dynamic code-execution sites (opaque to static analysis)</div><ul class="refs">${dynExec
          .slice(0, 10)
          .map((o) => `<li><code>${esc(o.path)}${o.location ? `:${o.location.line}` : ""}</code>${o.api ? ` (${esc(o.api)})` : ""}</li>`)
          .join("")}${dynExec.length > 10 ? `<li>… and ${dynExec.length - 10} more</li>` : ""}</ul>`
      : "";
  const obfBody = `${
    r.obfuscation.flagged.length > 0
      ? `<table><tr><th>File</th><th>Indicators</th></tr>${obfRows}</table>`
      : `<p class="empty">No files were flagged as obfuscated.</p>`
  }${dynExecList}`;

  const dev = r.developer;
  const devNote =
    dev.listing_available === null
      ? "Store listing was not fetched for this run — developer identity is limited to what the extension self-reports."
      : dev.listing_available === false
        ? "The Chrome Web Store listing was unavailable when fetched (unlisted or removed extension)."
        : `Store listing fetched ${dev.listing_fetched_at}.`;
  const devBody = `<table>
    <tr><th>Name</th><td>${dev.name ? esc(dev.name) : '<span class="empty">not available</span>'}</td></tr>
    <tr><th>Email</th><td>${dev.email ? esc(dev.email) : '<span class="empty">not available</span>'}</td></tr>
    <tr><th>Website</th><td>${dev.website ? esc(dev.website) : '<span class="empty">not available</span>'}</td></tr>
    <tr><th>Address</th><td>${dev.address ? esc(dev.address) : '<span class="empty">not available</span>'}</td></tr>
    <tr><th>Country</th><td>${dev.country ? esc(dev.country) : '<span class="empty">not available</span>'}</td></tr>
    <tr><th>High-risk country</th><td>${yesNo(dev.high_risk_country)}</td></tr>
    <tr><th>EU trader declaration</th><td>${yesNo(dev.is_trader, "not available")}</td></tr>
    <tr><th>Update channel</th><td>${dev.non_store_update_url ? `<b>non-store</b>: <code>${esc(dev.update_url ?? "")}</code>` : "default (Chrome Web Store)"}</td></tr>
  </table><p class="note">${esc(devNote)}</p>`;

  const findingsBody =
    r.findings.length > 0
      ? `<p class="note">A “verified behavior” was adjudicated against the extension's actual source code and confirmed; an “observed capability” is present in the evidence with no behavioral mechanism asserted.</p>` +
        r.findings.map(findingHtml).join("\n")
      : `<p class="empty">No findings are asserted.</p>`;

  const excludedBody =
    r.excluded_claims.length > 0
      ? `<p class="note">Generated claims that did NOT survive verification, recorded for audit. None of these is asserted as a behavior of this extension.</p>` +
        r.excluded_claims.map(excludedHtml).join("\n")
      : `<p class="empty">${r.skill_review ? "Not run — candidate claims have not been independently verified." : "None — every generated claim survived verification."}</p>`;

  const skillReviewBody = r.skill_review ? (() => {
    const { review, provenance } = r.skill_review;
    const candidates = review.findings.map((f) => excludedHtml({ ...f, reason: "not-verified", verifier_rationale: null, verifier_quote: null })).join("\n");
    const coverage = review.coverage.map((c) => `<li><strong>${esc(c.dimension)}: ${esc(c.status)}</strong> — ${esc(c.note)}<p>${esc(c.checks_run.join("; "))}</p></li>`).join("");
    return `<p><strong>Imported agent review — unverified candidates.</strong> No independent claim verification or engine risk verdict was run.</p>
      <p>${esc(provenance.harness)} · ${esc(provenance.model)} · skill v${esc(provenance.skill_version)} · session ${esc(provenance.session_id ?? "not recorded")}</p>
      <p>Source SHA-256: ${esc(provenance.source_sha256)}<br>Review SHA-256: ${esc(provenance.review_sha256)}</p>
      ${candidates}<h3>Agent-reported coverage (${esc(review.investigation)})</h3><ul>${coverage}</ul>`;
  })() : null;

  const dismissalsBody =
    r.dismissals.length > 0
      ? `<p class="note">Concerns the investigation examined and cleared, with the checks it ran. These are negative results — nothing here is asserted as a behavior — recorded so a thorough review is visible rather than reading as an empty report.</p>` +
        r.dismissals.map(dismissalHtml).join("\n")
      : `<p class="empty">No concerns were recorded as separately checked and cleared in this run.</p>`;

  const coverageBody = `<p>Static coverage gaps in this run: ${r.coverage.opaque_regions} opaque region(s), ${r.coverage.indirect_calls} indirect call(s), ${r.coverage.unresolved_destinations} unresolved destination(s), ${r.coverage.unparsed_files.length} unparsed file(s).</p>
  <div class="label">Structural limits of every static assessment</div>
  <ul class="refs">${r.coverage.structural_limits.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;

  const meta = [
    r.extension.store_id ? `store id <code>${esc(r.extension.store_id)}</code>` : null,
    `manifest v${r.extension.manifest_version}`,
    `analyzed ${esc(r.generated_at)}`,
    `methodology <code>${esc(r.methodology)}</code>`,
    `model <code>${esc(r.model)}</code>`,
    `report schema ${esc(r.report_schema_version)}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Risk report: ${esc(name)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
  <h1>Extension risk report: ${esc(name)}${r.extension.version ? ` <small>v${esc(r.extension.version)}</small>` : ""}</h1>
  ${r.extension.fixture ? fixtureNoticeHtml() : ""}
  <div class="meta">${meta}</div>
  ${outcomeNotice(r.outcome) ? `<aside role="alert" class="card"><strong>${esc(outcomeNotice(r.outcome) ?? "")}</strong></aside>` : ""}
  ${verdictCard}
  ${summaryCard}
  ${skillReviewBody ? section("Candidate findings (unverified)", skillReviewBody, true) : ""}
  ${section("Stated purpose vs. observed behavior", statedBody, true)}
  ${section("Technical summary", techBody, true)}
  ${section(`Permissions (${r.permissions.api.length} API, ${r.permissions.hosts.required.length} host)`, permBody, true)}
  ${section(`External destinations (${r.destinations.rows.length} host${r.destinations.rows.length === 1 ? "" : "s"}, ${r.destinations.unresolved.length} unresolved)`, destBody, true)}
  ${section(`Obfuscation (${r.obfuscation.flagged.length} flagged file${r.obfuscation.flagged.length === 1 ? "" : "s"})`, obfBody, true)}
  ${section("Developer", devBody, true)}
  ${section(`Findings (${r.findings.length})`, findingsBody, true)}
  ${section(`Excluded claims (${r.excluded_claims.length})`, excludedBody, false)}
  ${section(`Dimensions checked / cleared (${r.dismissals.length})`, dismissalsBody, false)}
  ${section("Coverage and limits", coverageBody, false)}
  ${
    provenance && provenance.rows.length > 0
      ? section(
          "Run accounting",
          `<table>${provenance.rows.map((row) => `<tr><th>${esc(row.label)}</th><td>${esc(row.value)}</td></tr>`).join("")}</table>`,
          false,
        )
      : ""
  }
</main>
</body>
</html>
`;
}
