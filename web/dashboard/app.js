// Bake-off dashboard frontend — plain ES module, no framework, no build step.
// Fetches the read-only JSON API exposed by scripts/dashboard.ts and renders five
// tabs (Performance, Runs, Extensions, Findings, Report detail). All HTML is built
// via DOM/text nodes (never innerHTML with API data) so values are inert.
//
// State lives in the URL query string (?tab=…&… ) so filtered views are linkable
// and the back button works between a list and a report detail.

const $ = (sel) => document.querySelector(sel);

// ---- tiny DOM helpers (text-only; never inject API strings as HTML) ---------

function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  if (opts.class) node.className = opts.class;
  if (opts.text != null) node.textContent = String(opts.text);
  if (opts.title != null) node.title = String(opts.title);
  for (const [k, v] of Object.entries(opts.attrs || {})) node.setAttribute(k, v);
  for (const c of children) node.append(c);
  return node;
}

function fmtNum(v) {
  if (v == null || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString() : String(v);
}
function fmtPct(v) {
  if (v == null) return "";
  const n = Number(v);
  return Number.isFinite(n) ? (n * 100).toFixed(1) + "%" : "";
}
function fmtUsd(v) {
  if (v == null) return "";
  const n = Number(v);
  return Number.isFinite(n) ? "$" + n.toFixed(4) : "";
}
function fmtDate(v) {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().replace("T", " ").slice(0, 19);
}
function chip(value, prefix) {
  if (value == null || value === "") return el("span", { class: "muted", text: "—" });
  const cls = "chip " + prefix + String(value).replace(/[^a-z0-9-]/gi, "");
  return el("span", { class: cls, text: value });
}
// A comma-joined GROUP_CONCAT string ("high-risk,concerning") → a row of chips.
function concatChips(str, prefix) {
  const items = String(str || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!items.length) return el("span", { class: "muted", text: "—" });
  const wrap = el("span", { class: "chips" });
  for (const t of items) wrap.append(chip(t, prefix));
  return wrap;
}
// A { label: count } distribution → count-prefixed chips, busiest first.
function distChips(map, prefix) {
  const entries = Object.entries(map || {}).filter(([, n]) => Number(n) > 0);
  if (!entries.length) return el("span", { class: "muted", text: "—" });
  entries.sort((a, b) => b[1] - a[1]);
  const wrap = el("span", { class: "chips" });
  for (const [k, n] of entries) {
    const c = chip(k, prefix);
    c.textContent = `${n} ${k}`;
    wrap.append(c);
  }
  return wrap;
}
// "445,387 in / 4,092 out" with the grand total as the visible figure + a
// breakdown tooltip — the headline "total tokens" the dashboard was missing.
function tokenCell(inTok, outTok) {
  const i = Number(inTok) || 0;
  const o = Number(outTok) || 0;
  if (i + o === 0) return el("span", { class: "muted", text: "—" });
  return el("span", { class: "num", text: fmtNum(i + o), title: `${fmtNum(i)} in / ${fmtNum(o)} out` });
}

async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

function showError(container, e) {
  container.replaceChildren(el("div", { class: "error", text: "Failed to load: " + e.message }));
}

function emptyState(msg) {
  return el("div", { class: "empty", text: msg || "No data." });
}

// Build a table. columns: [{ key, label, sortable?, cell(row) -> Node|string }].
// onSort(key) wires sortable headers; onRow(row) makes rows clickable.
function buildTable(rows, columns, { onSort, onRow, cap } = {}) {
  if (!rows || rows.length === 0) return emptyState();
  const table = el("table");
  const thead = el("thead");
  const htr = el("tr");
  for (const c of columns) {
    const th = el("th", { text: c.label });
    if (c.sortable && onSort) {
      th.classList.add("sortable");
      th.addEventListener("click", () => onSort(c.sortKey || c.key));
    }
    htr.append(th);
  }
  thead.append(htr);
  table.append(thead);
  const tbody = el("tbody");
  for (const row of rows) {
    const tr = el("tr");
    if (onRow) {
      tr.classList.add("clickable");
      tr.addEventListener("click", () => onRow(row));
    }
    for (const c of columns) {
      const td = el("td");
      if (c.class) td.className = c.class;
      const v = c.cell ? c.cell(row) : row[c.key];
      if (v instanceof Node) td.append(v);
      else td.textContent = v == null ? "" : String(v);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  const wrap = el("div");
  wrap.append(table);
  if (cap && rows.length >= cap) {
    wrap.append(el("div", { class: "cap-note", text: `Showing first ${cap} rows (capped). Narrow the filters or raise ?limit.` }));
  }
  return wrap;
}

// ---- URL-backed state -------------------------------------------------------

function getState() {
  return new URLSearchParams(location.search);
}
function setState(params, { replace = false } = {}) {
  const url = location.pathname + (params.toString() ? "?" + params.toString() : "");
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
}
function patchState(patch) {
  const p = getState();
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === "") p.delete(k);
    else p.set(k, v);
  }
  return p;
}

// ---- meta (dropdown options), loaded once -----------------------------------

let META = null;

function fillSelect(sel, values, { includeAny = true, anyLabel = "any" } = {}) {
  sel.replaceChildren();
  if (includeAny) sel.append(el("option", { text: anyLabel, attrs: { value: "" } }));
  for (const v of values) sel.append(el("option", { text: v, attrs: { value: v } }));
}

// ---- Performance tab --------------------------------------------------------

function covClass(v) {
  if (v == null) return "";
  const n = Number(v);
  if (n >= 0.85) return "cov-good";
  if (n >= 0.6) return "cov-mid";
  return "cov-low";
}

// Cost basis disclosure + the active rate card. Appended under the rollup so a
// $ figure is never read as a real bill. Fetched once, then cached.
let PRICING = null;
async function renderPricingNote(container) {
  try {
    if (!PRICING) PRICING = await getJson("/api/pricing");
  } catch { return; }
  const wrap = el("div", { class: "pricing-note" });
  wrap.append(el("div", { class: "muted", text: "Est. cost — " + (PRICING.note || "") }));
  const rates = PRICING.rates || {};
  // Collapse the base/`:cloud` aliases (same rate) to one chip per model.
  const seen = new Set();
  const ul = el("span", { class: "chips" });
  for (const [model, r] of Object.entries(rates)) {
    const tag = model.replace(/:cloud$/, "");
    if (seen.has(tag)) continue;
    seen.add(tag);
    ul.append(el("span", { class: "chip mono", text: `${tag}: $${r.input}/$${r.output} per 1M` }));
  }
  wrap.append(ul);
  container.append(wrap);
}

// All-runs rollup: every methodology×model across all runs (not just scored
// corpus ones), so pi and plain assess work is visible alongside cost/tokens.
async function renderRollup() {
  const container = $("#rollup-table");
  container.replaceChildren(emptyState("Loading…"));
  try {
    const { rows } = await getJson("/api/rollup");
    const columns = [
      { key: "methodology", label: "Methodology", cell: (r) => el("span", { class: "mono", text: r.methodology }) },
      { key: "model", label: "Model", cell: (r) => el("span", { class: "mono", text: r.model }) },
      { key: "num_runs", label: "Runs", class: "num", cell: (r) => fmtNum(r.num_runs) },
      { key: "num_reports", label: "Reports", class: "num", cell: (r) => fmtNum(r.num_reports) },
      { key: "avg_findings", label: "Avg findings", class: "num", cell: (r) => (r.avg_findings == null ? "" : Number(r.avg_findings).toFixed(1)) },
      { key: "total_findings", label: "Total findings", class: "num", cell: (r) => fmtNum(r.total_findings) },
      { key: "tiers", label: "Verdict tiers", cell: (r) => distChips(r.tiers, "tier-") },
      { key: "tokens", label: "Tokens", class: "num", cell: (r) => tokenCell(r.input_tokens, r.output_tokens) },
      { key: "cost", label: "Est. cost", class: "num", cell: (r) => fmtUsd(r.priced_usd ?? r.estimated_usd) },
    ];
    container.replaceChildren(buildTable(rows, columns) || emptyState("No runs recorded yet."));
    renderPricingNote(container);
  } catch (e) {
    showError(container, e);
  }
}

async function renderPerformance() {
  renderRollup();
  const container = $("#performance-table");
  container.replaceChildren(emptyState("Loading…"));
  try {
    const { rows } = await getJson("/api/performance");
    const columns = [
      { key: "methodology", label: "Methodology", cell: (r) => el("span", { class: "mono", text: r.methodology }) },
      { key: "model", label: "Model", cell: (r) => el("span", { class: "mono", text: r.model }) },
      { key: "cov_ag", label: "Coverage A–G", class: "num", cell: (r) => el("span", { class: covClass(r.coverage_known_shapes), text: fmtPct(r.coverage_known_shapes) }) },
      { key: "cov_h", label: "Coverage H", class: "num", cell: (r) => fmtPct(r.coverage_open_world) },
      { key: "tier_recall", label: "Tier recall", class: "num", cell: (r) => fmtPct(r.tier_recall) },
      {
        key: "unsafe", label: "Unsafe misses", class: "num",
        cell: (r) => {
          const td = el("span", { text: r.unsafe_misses == null ? "" : String(r.unsafe_misses) });
          if (Number(r.unsafe_misses) > 0) td.className = "cell-warn";
          return td;
        },
      },
      { key: "false_alarms", label: "False alarms", class: "num", cell: (r) => (r.false_alarm_count == null ? "" : String(r.false_alarm_count)) },
      { key: "stability", label: "Stability", cell: (r) => el("span", { class: "mono muted", text: r.stability ?? "" }) },
      { key: "cost", label: "Est. cost", class: "num", cell: (r) => fmtUsd(r.priced_usd ?? r.estimated_usd) },
      {
        key: "runs", label: "Runs", class: "num",
        cell: (r) => {
          const n = el("span", { text: String(r.run_count) });
          if (r.multiple_runs) n.title = "Multiple scorecard runs exist; showing the most recent.";
          if (r.multiple_runs) n.textContent = r.run_count + "*";
          return n;
        },
      },
    ];
    container.replaceChildren(
      buildTable(rows, columns, { onRow: (r) => openRunReports(r.run_id) }) || emptyState("No scorecard runs yet."),
    );
  } catch (e) {
    showError(container, e);
  }
}

// ---- Runs tab ---------------------------------------------------------------

async function renderRuns() {
  const container = $("#runs-table");
  container.replaceChildren(emptyState("Loading…"));
  const st = getState();
  const qs = new URLSearchParams();
  for (const k of ["kind", "methodology", "model"]) {
    const v = st.get("runs_" + k);
    if (v) qs.set(k, v);
    const sel = $("#runs-" + k);
    if (sel) sel.value = v || "";
  }
  if (st.get("sort_runs")) qs.set("sort", st.get("sort_runs"));
  if (st.get("dir_runs")) qs.set("dir", st.get("dir_runs"));
  try {
    const { rows, cap } = await getJson("/api/runs?" + qs.toString());
    const columns = [
      { key: "id", label: "ID", class: "num", cell: (r) => el("span", { class: "mono", text: r.id }) },
      { key: "kind", label: "Kind", sortable: true, cell: (r) => el("span", { class: "mono", text: r.kind }) },
      { key: "methodology", label: "Methodology", sortable: true, cell: (r) => el("span", { class: "mono", text: r.methodology }) },
      { key: "model", label: "Model", sortable: true, cell: (r) => el("span", { class: "mono", text: r.model }) },
      {
        key: "extension", label: "Extension",
        cell: (r) => {
          // Single-target (assess) runs name the analyzed extension; multi-target
          // (corpus) runs show how many targets they covered instead.
          if (r.num_targets > 1) return el("span", { class: "muted", text: `${r.num_targets} targets` });
          return el("span", { class: "truncate", text: r.target_name || "—", title: r.target_name || "" });
        },
      },
      { key: "tiers", label: "Tier", cell: (r) => concatChips(r.tiers, "tier-") },
      {
        key: "num_findings", label: "Findings", sortable: true, class: "num",
        cell: (r) => {
          const span = el("span", { text: fmtNum(r.num_findings) });
          if (r.num_excluded > 0) span.append(el("span", { class: "muted", text: ` (+${fmtNum(r.num_excluded)} excl)` }));
          return span;
        },
      },
      { key: "types", label: "Types", cell: (r) => distChips(r.finding_types, "ftype-") },
      { key: "input_tokens", label: "Tokens", sortable: true, class: "num", cell: (r) => tokenCell(r.input_tokens, r.output_tokens) },
      { key: "cost", label: "Est. cost", class: "num", cell: (r) => fmtUsd(r.priced_usd ?? r.estimated_usd) },
      { key: "started_at", label: "Started", sortable: true, cell: (r) => el("span", { class: "muted", text: fmtDate(r.started_at) }) },
    ];
    container.replaceChildren(
      buildTable(rows, columns, {
        cap,
        onSort: (key) => toggleSort("runs", key),
        onRow: (r) => openRunReports(r.id),
      }) || emptyState("No runs."),
    );
  } catch (e) {
    showError(container, e);
  }
}

// Clicking a run (or a Performance pair) opens that run's reports in the detail
// pane. A single-report run goes straight to the report detail; a multi-report
// (corpus) run lists its reports, each one click from detail.
async function openRunReports(runId) {
  showReportTab();
  switchTab("report", { push: false });
  setState(patchState({ tab: "run_reports", run: String(runId) }));
  const container = $("#report-detail");
  container.replaceChildren(emptyState("Loading…"));
  try {
    const { rows } = await getJson("/api/reports?run=" + encodeURIComponent(runId));
    if (rows.length === 1) { openReportDetail(rows[0].id); return; }
    container.replaceChildren(renderRunReportList(runId, rows));
  } catch (e) {
    showError(container, e);
  }
}

function renderRunReportList(runId, rows) {
  const wrap = el("div");
  const head = el("div", { class: "detail-head" });
  const back = el("button", { class: "back-btn", text: "← Runs" });
  back.addEventListener("click", () => switchTab("runs"));
  head.append(back);
  head.append(el("h2", { text: "Run #" + runId }));
  wrap.append(head);
  const card = el("div", { class: "card" });
  card.append(el("h3", { text: `Reports in this run (${rows.length})` }));
  const columns = [
    { key: "identifier", label: "Extension", cell: (r) => el("span", { class: "mono truncate", text: r.identifier ?? r.name ?? "", title: r.identifier ?? "" }) },
    { key: "name", label: "Name", cell: (r) => el("span", { class: "truncate", text: r.name || "", title: r.name || "" }) },
    { key: "tier", label: "Tier", cell: (r) => chip(r.tier, "tier-") },
    { key: "num_findings", label: "#Findings", class: "num", cell: (r) => fmtNum(r.num_findings) },
  ];
  card.append(buildTable(rows, columns, { onRow: (r) => openReportDetail(r.id) }) || emptyState("No reports in this run."));
  wrap.append(card);
  return wrap;
}

// ---- Extensions tab ---------------------------------------------------------

let extQTimer = null;

async function renderExtensions() {
  const container = $("#extensions-table");
  container.replaceChildren(emptyState("Loading…"));
  const st = getState();
  const q = st.get("ext_q") || "";
  $("#extensions-q").value = q;
  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  try {
    const { rows, cap } = await getJson("/api/extensions?" + qs.toString());
    const columns = [
      { key: "name", label: "Name", cell: (r) => el("span", { class: "truncate", text: r.name || "(unnamed)", title: r.name || "" }) },
      { key: "identifier", label: "Identifier", cell: (r) => el("span", { class: "mono truncate", text: r.identifier, title: r.identifier }) },
      { key: "version", label: "Version", cell: (r) => el("span", { class: "muted mono", text: r.version || "" }) },
      { key: "is_corpus", label: "Source", cell: (r) => el("span", { class: "muted", text: r.is_corpus ? "corpus" : "store" }) },
      { key: "label_kind", label: "Label", cell: (r) => (r.label_kind ? chip(r.label_kind, "chip ") : el("span", { class: "muted", text: "—" })) },
      { key: "expected_tier", label: "Expected", cell: (r) => (r.expected_tier ? chip(r.expected_tier, "tier-") : el("span", { class: "muted", text: "—" })) },
      { key: "methodologies", label: "Methodologies", cell: (r) => el("span", { class: "mono muted truncate", text: r.methodologies || "", title: r.methodologies || "" }) },
      { key: "num_runs", label: "#Runs", class: "num", cell: (r) => String(r.num_runs) },
      { key: "total_findings", label: "Findings", class: "num", cell: (r) => fmtNum(r.total_findings) },
      { key: "tiers", label: "Tiers seen", cell: (r) => concatChips(r.tiers, "tier-") },
      { key: "last_assessed", label: "Last assessed", cell: (r) => el("span", { class: "muted", text: fmtDate(r.last_assessed) }) },
    ];
    container.replaceChildren(
      buildTable(rows, columns, { cap, onRow: (r) => openExtension(r) }) || emptyState("No extensions."),
    );
  } catch (e) {
    showError(container, e);
  }
}

// Row click → a rich per-extension detail: identity, how each methodology tiered
// it, an asserted-findings breakdown, and the full per-run report list (each row
// one click from the report detail). The query key mirrors how the list grouped
// the row: store id, corpus sample, or name-only (backfilled) targets.
function extKey(row) {
  if (row.is_corpus) return { key: "sample", val: row.identifier };
  // A name-only target's identifier IS its name (store_id/sample both null).
  if (row.identifier === row.name) return { key: "name", val: row.identifier };
  return { key: "store_id", val: row.identifier };
}

function openExtension(row) {
  const { key, val } = extKey(row);
  return openExtensionByKey(key, val);
}

async function openExtensionByKey(key, val) {
  showReportTab();
  switchTab("report", { push: false });
  setState(patchState({ tab: "extension", ext_key: key, ext: val }));
  const container = $("#report-detail");
  container.replaceChildren(emptyState("Loading…"));
  try {
    const data = await getJson("/api/extension?" + key + "=" + encodeURIComponent(val));
    container.replaceChildren(renderExtensionDetail(data));
  } catch (e) {
    showError(container, e);
  }
}

function renderExtensionDetail(data) {
  const id = data.identity;
  const reports = data.reports || [];
  const wrap = el("div");

  const head = el("div", { class: "detail-head" });
  const back = el("button", { class: "back-btn", text: "← Extensions" });
  back.addEventListener("click", () => switchTab("extensions"));
  head.append(back);
  head.append(el("h2", { text: id.name || id.store_id || id.sample || "(unnamed)" }));
  if (id.store_id) head.append(el("span", { class: "chip mono", text: id.store_id }));
  wrap.append(head);

  // Identity / provenance
  const idCard = el("div", { class: "card" });
  idCard.append(el("h3", { text: "Identity" }));
  idCard.append(kvList([
    ["Identifier", el("span", { class: "mono", text: id.store_id || id.sample || id.name || "" })],
    ["Version", id.version],
    ["MV", id.manifest_version],
    ["Source", id.is_corpus ? "corpus sample" : "store"],
    ["Label", id.label_kind && chip(id.label_kind, "chip ")],
    ["Expected tier", id.expected_tier && chip(id.expected_tier, "tier-")],
    ["Assessed", `${fmtNum(id.num_runs)} run${id.num_runs === 1 ? "" : "s"}`],
  ]));
  wrap.append(idCard);

  // Verdict per methodology — the cross-arm "how did each arm tier it" matrix.
  const tierCard = el("div", { class: "card" });
  tierCard.append(el("h3", { text: "Verdict by methodology" }));
  const byMeth = new Map();
  for (const r of reports) {
    if (!byMeth.has(r.methodology)) byMeth.set(r.methodology, []);
    byMeth.get(r.methodology).push(r);
  }
  const matrixRows = [...byMeth.entries()].map(([methodology, list]) => ({
    methodology,
    tiers: list.map((r) => r.tier).filter(Boolean),
    findings: list.reduce((s, r) => s + (Number(r.num_findings) || 0), 0),
    runs: list.length,
  }));
  tierCard.append(buildTable(matrixRows, [
    { key: "methodology", label: "Methodology", cell: (r) => el("span", { class: "mono", text: r.methodology }) },
    { key: "tiers", label: "Tier(s)", cell: (r) => concatChips(r.tiers.join(","), "tier-") },
    { key: "findings", label: "Findings", class: "num", cell: (r) => fmtNum(r.findings) },
    { key: "runs", label: "Runs", class: "num", cell: (r) => fmtNum(r.runs) },
  ]) || emptyState("No verdicts."));
  wrap.append(tierCard);

  // Asserted findings, summarized by type × severity across every run.
  const fSum = data.findingSummary || [];
  if (fSum.length) {
    const sumCard = el("div", { class: "card" });
    const total = fSum.reduce((s, r) => s + (Number(r.n) || 0), 0);
    sumCard.append(el("h3", { text: `Findings summary — ${total} asserted across runs` }));
    sumCard.append(buildTable(fSum, [
      { key: "finding_type", label: "Type", cell: (r) => (r.finding_type ? chip(r.finding_type, "ftype-") : el("span", { class: "muted", text: "—" })) },
      { key: "severity", label: "Severity", cell: (r) => chip(r.severity, "sev-") },
      { key: "n", label: "Count", class: "num", cell: (r) => fmtNum(r.n) },
    ]));
    wrap.append(sumCard);
  }

  // Per-run reports — the table the user clicks through to a report detail.
  const repCard = el("div", { class: "card" });
  repCard.append(el("h3", { text: `Reports across runs (${reports.length})` }));
  repCard.append(buildTable(reports, [
    { key: "methodology", label: "Methodology", cell: (r) => el("span", { class: "mono", text: r.methodology }) },
    { key: "model", label: "Model", cell: (r) => el("span", { class: "mono", text: r.model }) },
    { key: "kind", label: "Kind", cell: (r) => el("span", { class: "muted mono", text: r.kind }) },
    { key: "tier", label: "Tier", cell: (r) => chip(r.tier, "tier-") },
    {
      key: "num_findings", label: "Findings", class: "num",
      cell: (r) => {
        const span = el("span", { text: fmtNum(r.num_findings) });
        if (r.num_excluded > 0) span.append(el("span", { class: "muted", text: ` (+${fmtNum(r.num_excluded)} excl)` }));
        return span;
      },
    },
    { key: "tokens", label: "Tokens", class: "num", cell: (r) => tokenCell(r.input_tokens, r.output_tokens) },
    { key: "cost", label: "Est. cost", class: "num", cell: (r) => fmtUsd(r.priced_usd ?? r.estimated_usd) },
    { key: "started_at", label: "Started", cell: (r) => el("span", { class: "muted", text: fmtDate(r.started_at) }) },
  ], { onRow: (r) => openReportDetail(r.id) }) || emptyState("No reports for this extension."));
  wrap.append(repCard);

  return wrap;
}

// ---- Findings tab -----------------------------------------------------------

async function renderFindings() {
  const container = $("#findings-table");
  container.replaceChildren(emptyState("Loading…"));
  const st = getState();
  const qs = new URLSearchParams();
  for (const k of ["severity", "category", "finding_type", "verified", "methodology", "model", "sample", "store_id"]) {
    const v = st.get("find_" + k);
    if (v) qs.set(k, v);
    const sel = $("#findings-" + k);
    if (sel) sel.value = v || "";
  }
  if (st.get("sort_find")) qs.set("sort", st.get("sort_find"));
  if (st.get("dir_find")) qs.set("dir", st.get("dir_find"));
  try {
    const { rows, cap } = await getJson("/api/findings?" + qs.toString());
    const columns = [
      { key: "severity", label: "Severity", sortable: true, cell: (r) => chip(r.severity, "sev-") },
      { key: "category", label: "Category", sortable: true, cell: (r) => el("span", { class: "mono", text: r.category ?? "" }) },
      { key: "finding_type", label: "Type", sortable: true, cell: (r) => (r.finding_type ? chip(r.finding_type, "ftype-") : el("span", { class: "muted", text: "—" })) },
      { key: "title", label: "Title", sortable: true, cell: (r) => el("span", { class: "truncate", text: r.title || "", title: r.title || "" }) },
      { key: "verified", label: "Verified", cell: (r) => el("span", { class: r.is_verified ? "cov-good" : "muted", text: r.is_verified ? "asserted" : "excluded" }) },
      { key: "identifier", label: "Extension", cell: (r) => el("span", { class: "mono truncate", text: r.identifier ?? "", title: r.identifier ?? "" }) },
      { key: "methodology", label: "Methodology", sortable: true, cell: (r) => el("span", { class: "mono", text: r.methodology }) },
      { key: "model", label: "Model", sortable: true, cell: (r) => el("span", { class: "mono", text: r.model }) },
      { key: "tier", label: "Tier", cell: (r) => chip(r.tier, "tier-") },
    ];
    container.replaceChildren(
      buildTable(rows, columns, {
        cap,
        onSort: (key) => toggleSort("find", key),
        onRow: (r) => openReportDetail(r.report_id),
      }) || emptyState("No findings."),
    );
  } catch (e) {
    showError(container, e);
  }
}

// ---- Report detail ----------------------------------------------------------

async function openReportDetail(reportId) {
  showReportTab();
  setState(patchState({ tab: "report", report: reportId }));
  const container = $("#report-detail");
  container.replaceChildren(emptyState("Loading…"));
  try {
    const data = await getJson("/api/report/" + reportId);
    container.replaceChildren(renderReportDetail(data));
  } catch (e) {
    showError(container, e);
  }
}

// Headline numbers as a row of tiles. items: [label, value][].
function statBand(items) {
  const band = el("div", { class: "stat-band" });
  for (const [label, value] of items) {
    const tile = el("div", { class: "stat" });
    const v = el("div", { class: "stat-val" });
    if (value instanceof Node) v.append(value);
    else v.textContent = value == null ? "—" : String(value);
    tile.append(v);
    tile.append(el("div", { class: "stat-label", text: label }));
    band.append(tile);
  }
  return band;
}

function kvList(pairs) {
  const dl = el("dl", { class: "kv" });
  for (const [k, v] of pairs) {
    if (v == null || v === "") continue;
    dl.append(el("dt", { text: k }));
    const dd = el("dd");
    if (v instanceof Node) dd.append(v);
    else dd.textContent = String(v);
    dl.append(dd);
  }
  return dl;
}

function renderReportDetail(data) {
  const rep = data.report;
  const wrap = el("div");

  const head = el("div", { class: "detail-head" });
  const back = el("button", { class: "back-btn", text: "← Back" });
  back.addEventListener("click", () => history.back());
  head.append(back);
  head.append(el("h2", { text: rep.name || rep.store_id || rep.sample || "Report #" + rep.id }));
  head.append(chip(rep.tier, "tier-"));
  if (rep.tier_source) head.append(el("span", { class: "muted", text: "(" + rep.tier_source + ")" }));
  // The methodology×model that produced this verdict, right in the header.
  head.append(el("span", { class: "chip mono", text: `${rep.methodology} · ${rep.model}` }));
  wrap.append(head);

  // Headline numbers — scannable stat tiles instead of buried in a long list.
  const totalTok = (Number(rep.input_tokens) || 0) + (Number(rep.output_tokens) || 0);
  const clearedCount = Array.isArray(data.dismissals) ? data.dismissals.length : 0;
  wrap.append(statBand([
    ["Asserted findings", fmtNum(rep.num_findings)],
    ["Excluded", fmtNum(rep.num_excluded)],
    // Concerns checked and cleared — distinguishes "investigated, nothing found"
    // from "didn't run" so a thorough benign run doesn't read as empty.
    ["Cleared", fmtNum(clearedCount)],
    ["Total tokens", totalTok ? fmtNum(totalTok) : "—"],
    ["Est. cost", fmtUsd(rep.priced_usd ?? rep.estimated_usd) || "—"],
  ]));

  // Run + target knobs, split into two compact columns rather than one long dl.
  const identCard = el("div", { class: "card" });
  const grid = el("div", { class: "kv-grid" });
  const runCol = el("div");
  runCol.append(el("h3", { text: "Run" }));
  runCol.append(kvList([
    ["Methodology", el("span", { class: "mono", text: rep.methodology })],
    ["Model", el("span", { class: "mono", text: rep.model })],
    ["Verifier", rep.verifier_model && el("span", { class: "mono", text: rep.verifier_model })],
    ["Judge", rep.judge_model && el("span", { class: "mono", text: rep.judge_model })],
    ["Think", rep.think],
    ["Mode", rep.mode],
    ["Kind", rep.kind],
    ["Analyzer", rep.analyzer_version],
    ["git", rep.git_sha && el("span", { class: "mono", text: rep.git_sha })],
    ["Tokens", totalTok ? `${fmtNum(rep.input_tokens)} in / ${fmtNum(rep.output_tokens)} out` : null],
    ["Started", fmtDate(rep.started_at)],
  ]));
  const tgtCol = el("div");
  tgtCol.append(el("h3", { text: "Target" }));
  tgtCol.append(kvList([
    ["Identifier", el("span", { class: "mono", text: rep.store_id || rep.sample || "" })],
    ["Version", rep.version],
    ["MV", rep.manifest_version],
    ["Source", rep.is_corpus ? "corpus sample" : "store"],
    ["Label", rep.label_kind && chip(rep.label_kind, "chip ")],
    ["Expected tier", rep.expected_tier && chip(rep.expected_tier, "tier-")],
  ]));
  grid.append(runCol);
  grid.append(tgtCol);
  identCard.append(grid);
  wrap.append(identCard);

  // Verdict + summaries
  if (rep.overall_rationale || rep.layperson_summary || rep.technical_summary) {
    const sumCard = el("div", { class: "card" });
    sumCard.append(el("h3", { text: "Verdict & summaries" }));
    if (rep.overall_rationale) { sumCard.append(el("div", { class: "muted", text: "Rationale" })); sumCard.append(el("div", { class: "summary", text: rep.overall_rationale })); }
    if (rep.layperson_summary) { sumCard.append(el("div", { class: "muted", text: "Layperson" })); sumCard.append(el("div", { class: "summary", text: rep.layperson_summary })); }
    if (rep.technical_summary) { sumCard.append(el("div", { class: "muted", text: "Technical" })); sumCard.append(el("div", { class: "summary", text: rep.technical_summary })); }
    wrap.append(sumCard);
  }

  // Permissions — the consistent, methodology-independent manifest analysis:
  // what each permission allows (layperson), how this extension uses it, and a
  // link to the official Chrome docs. Rendered from the structured RiskReport.
  if (data.permissions) wrap.append(renderPermissionsCard(data.permissions));

  // External hosts — the network destinations this extension's code reaches out
  // to (fetch/XHR/beacon/etc.), lifted from the structured RiskReport. Shows the
  // host, how often and how it's reached, whether the URL is built dynamically,
  // the adjudicated party relationship, and example call sites.
  if (data.destinations) wrap.append(renderDestinationsCard(data.destinations));

  // Findings (asserted then excluded)
  const asserted = data.findings.filter((f) => f.is_verified);
  const excluded = data.findings.filter((f) => !f.is_verified);

  const fCard = el("div", { class: "card" });
  fCard.append(el("h3", { text: `Findings — ${asserted.length} asserted` }));
  fCard.append(buildTable(asserted, [
    { key: "severity", label: "Severity", cell: (r) => chip(r.severity, "sev-") },
    { key: "category", label: "Category", cell: (r) => el("span", { class: "mono", text: r.category ?? "" }) },
    { key: "finding_type", label: "Type", cell: (r) => (r.finding_type ? chip(r.finding_type, "ftype-") : el("span", { class: "muted", text: "—" })) },
    { key: "title", label: "Title", cell: (r) => r.title || "" },
    { key: "confidence", label: "Conf.", cell: (r) => el("span", { class: "muted", text: r.confidence ?? "" }) },
    { key: "detail", label: "Detail", cell: (r) => el("span", { class: "wrap", text: r.detail || "" }) },
  ]) || emptyState("No asserted findings."));
  wrap.append(fCard);

  if (excluded.length) {
    const eCard = el("div", { class: "card" });
    eCard.append(el("h3", { text: `Excluded claims — ${excluded.length}` }));
    eCard.append(buildTable(excluded, [
      { key: "title", label: "Title", cell: (r) => r.title || "" },
      { key: "exclusion_reason", label: "Reason", cell: (r) => el("span", { class: "mono", text: r.exclusion_reason ?? "" }) },
      { key: "detail", label: "Detail", cell: (r) => el("span", { class: "wrap", text: r.detail || "" }) },
    ]));
    wrap.append(eCard);
  }

  // Dimensions checked and cleared — the investigation's negative results (DAG
  // nodes / Pi shards). Shown only when present, so it adds nothing for arms that
  // record no dismissals; when present it keeps a thorough benign run from
  // looking like it did nothing.
  if (Array.isArray(data.dismissals) && data.dismissals.length) {
    wrap.append(renderDismissalsCard(data.dismissals));
  }

  // Usage
  if (data.usage && data.usage.length) {
    const uCard = el("div", { class: "card" });
    uCard.append(el("h3", { text: "Usage by step" }));
    uCard.append(buildTable(data.usage, [
      { key: "label", label: "Step", cell: (r) => el("span", { class: "mono", text: r.label }) },
      { key: "model", label: "Model", cell: (r) => el("span", { class: "mono", text: r.model }) },
      { key: "calls", label: "Calls", class: "num", cell: (r) => fmtNum(r.calls) },
      { key: "input_tokens", label: "Input", class: "num", cell: (r) => fmtNum(r.input_tokens) },
      { key: "output_tokens", label: "Output", class: "num", cell: (r) => fmtNum(r.output_tokens) },
      { key: "wall_clock_ms", label: "ms", class: "num", cell: (r) => fmtNum(r.wall_clock_ms) },
      { key: "estimated_usd", label: "Cost", class: "num", cell: (r) => fmtUsd(r.priced_usd ?? r.estimated_usd) },
    ]));
    wrap.append(uCard);
  }

  // Rendered report text (markdown shown as preformatted; no HTML injection).
  if (rep.report_text) {
    const rCard = el("div", { class: "card" });
    rCard.append(el("h3", { text: "Rendered report" }));
    rCard.append(el("div", { class: "report-text", text: rep.report_text }));
    wrap.append(rCard);
  }

  return wrap;
}

// Build the Permissions card for a report detail. `perms` is the structured
// PermissionsSection (api rows, host scope, dangerous combinations). Doc links
// are rendered as real anchors, but only http(s) URLs are allowed into href so
// an ingested report can never smuggle a javascript: link.
function docLink(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return el("span", { class: "muted", text: "—" });
  return el("a", { text: "docs", attrs: { href: url, target: "_blank", rel: "nofollow noreferrer noopener" } });
}

function renderPermissionsCard(perms) {
  const card = el("div", { class: "card" });
  const api = Array.isArray(perms.api) ? perms.api : [];
  const hosts = perms.hosts && typeof perms.hosts === "object" ? perms.hosts : { required: [], optional: [] };
  const required = Array.isArray(hosts.required) ? hosts.required : [];
  const optional = Array.isArray(hosts.optional) ? hosts.optional : [];
  card.append(el("h3", { text: `Permissions — ${api.length} API, ${required.length + optional.length} host` }));

  // API permission table. buildTable returns its own "No data." empty state for an
  // empty array, so branch explicitly to state the meaningful empty case (and so
  // an extension whose only access is host-based does not read as "no permissions").
  card.append(el("div", { class: "muted", text: "API permissions" }));
  card.append(
    api.length
      ? buildTable(api, [
          { key: "permission", label: "Permission", cell: (r) => el("span", { class: "mono", text: r.permission + (r.optional ? " (optional)" : "") }) },
          { key: "description", label: "What it allows", cell: (r) => r.description || "" },
          { key: "status", label: "Status", cell: (r) => chip(r.status, "status-") },
          { key: "usage_plain", label: "How this extension uses it", cell: (r) => el("span", { text: r.usage_plain || "" }) },
          { key: "total_usage", label: "Sites", class: "num", cell: (r) => fmtNum(r.total_usage) },
          { key: "doc_url", label: "Docs", cell: (r) => docLink(r.doc_url) },
        ])
      : emptyState("No API permissions are declared."),
  );

  // Chrome's verbatim install-time warnings — the official layperson wording.
  const warned = api.filter((r) => r.install_warning);
  if (warned.length) {
    card.append(el("div", { class: "muted", text: "Chrome's install-time warnings" }));
    const ul = el("ul", { class: "refs" });
    for (const r of warned) ul.append(el("li", {}, [el("span", { class: "mono", text: r.permission }), el("span", { text: ": " + r.install_warning })]));
    card.append(ul);
  }

  // Host access — for many extensions this IS the consequential permission, so
  // show the patterns prominently rather than only as a one-line description.
  card.append(el("div", { class: "muted", text: "Host access" }));
  if (required.length || optional.length) {
    const ul = el("ul", { class: "refs" });
    for (const h of required) ul.append(el("li", {}, [el("span", { class: "mono", text: h })]));
    for (const h of optional) ul.append(el("li", {}, [el("span", { class: "mono", text: h }), el("span", { class: "muted", text: " (optional)" })]));
    card.append(ul);
  } else {
    card.append(emptyState("No host access requested."));
  }
  if (perms.hosts_plain) card.append(el("p", { class: "muted", text: perms.hosts_plain }));

  if (Array.isArray(perms.dangerous_combinations) && perms.dangerous_combinations.length) {
    card.append(el("div", { class: "muted", text: "Dangerous combinations" }));
    const ul = el("ul", { class: "refs" });
    for (const d of perms.dangerous_combinations) ul.append(el("li", {}, [el("span", { class: "mono", text: d.kind }), el("span", { text: " — " + (Array.isArray(d.evidence) ? d.evidence.join("; ") : "") })]));
    card.append(ul);
  }

  return card;
}

// Build the External hosts card for a report detail. `dest` is the structured
// DestinationsSection (rows of hosts + unresolved calls). Each row shows how the
// host is reached and example call sites so a reviewer can jump to the code.
// RDAP+DNS enrichment (improvements 015/017) for one destination row:
// owner/registrar, registration age, the resolved network target (the actual
// IP a domain host points to, via forward DNS), and DESCRIPTIVE flag badges.
// Context, NOT a verdict — registration facts are self-reported and
// attacker-influenceable, so the cell shows them as facts-with-provenance and
// never asserts risk alone. When the resolved/literal IP matches a known CDN
// (cdn-providers.json), the cell labels it "fronted by <provider>" instead of
// showing that IP's owner/ASN/country as the destination's own — edge-network
// registration data is the CDN operator's, not the origin's.
function enrichmentCell(enr) {
  if (!enr) return el("span", { class: "muted", text: "—" });
  if (enr.lookup_status !== "ok") return chip(enr.lookup_status, "status-");
  const d = enr.domain;
  const ip = enr.ip;
  const cdn = enr.cdn;
  // Primary line: domain registrar/registrant, then either the CDN label or
  // the resolved/literal IP's owner · ASN · country (never both).
  const primaryParts = [];
  if (d && (d.registrar || d.registrant_org)) primaryParts.push(d.registrar || d.registrant_org);
  if (cdn) primaryParts.push("fronted by " + cdn.provider);
  else if (ip) primaryParts.push([ip.owner_org || ip.network_name, ip.asn, ip.country].filter(Boolean).join(" · "));
  const primary = primaryParts.filter(Boolean).join(" · ");
  // Tooltip: the full dated provenance the compact cell omits.
  const detail = [];
  if (d?.created) detail.push("registered " + d.created.slice(0, 10));
  if (d?.expires) detail.push("expires " + d.expires.slice(0, 10));
  if (d?.registrar) detail.push("registrar " + d.registrar);
  if (d?.registrant_org) detail.push("registrant " + d.registrant_org);
  if (enr.resolved_addresses && enr.resolved_addresses.length) detail.push("resolves to " + enr.resolved_addresses.join(", "));
  if (enr.cname_chain && enr.cname_chain.length) detail.push("CNAME chain " + enr.cname_chain.join(" → "));
  if (d && enr.dns_status && enr.dns_status !== "ok" && enr.dns_status !== "not_applicable") detail.push("dns " + enr.dns_status);
  if (!cdn && ip?.network_name) detail.push("network " + ip.network_name);
  if (!cdn && ip?.allocated) detail.push("allocated " + ip.allocated.slice(0, 10));
  const span = el("span", { class: "chips" });
  span.append(el("span", { class: "mono wrap", text: primary || "ok", title: detail.join("\n") || primary || "ok" }));
  for (const [cond, label] of [
    [enr.newly_registered, "newly-registered"],
    [enr.expired_or_hold, "expired/hold"],
    [enr.high_risk_country, "high-risk-country"],
  ]) {
    if (cond === true) span.append(chip(label, "status-"));
  }
  return span;
}

function renderDestinationsCard(dest) {
  const card = el("div", { class: "card" });
  const rows = Array.isArray(dest.rows) ? dest.rows : [];
  const unresolved = Array.isArray(dest.unresolved) ? dest.unresolved : [];
  card.append(el("h3", { text: `External hosts — ${rows.length} contacted` }));

  card.append(
    buildTable(rows, [
      { key: "host", label: "Host", cell: (r) => el("span", { class: "mono", text: r.host || "" }) },
      { key: "party", label: "Party", cell: (r) => chip(r.party, "party-") },
      { key: "references", label: "Refs", class: "num", cell: (r) => fmtNum(r.references) },
      { key: "reached_via", label: "Reached via", cell: (r) => el("span", { class: "mono", text: Array.isArray(r.reached_via) ? r.reached_via.join(", ") : "" }) },
      { key: "any_dynamic", label: "Dynamic", cell: (r) => (r.any_dynamic ? chip("dynamic", "status-") : el("span", { class: "muted", text: "—" })) },
      { key: "enrichment", label: "Owner / network (RDAP+DNS)", cell: (r) => enrichmentCell(r.enrichment) },
      {
        key: "example_sites",
        label: "Example call sites",
        cell: (r) => {
          const sites = Array.isArray(r.example_sites) ? r.example_sites : [];
          if (!sites.length) return el("span", { class: "muted", text: "—" });
          return el("span", { class: "mono wrap", text: sites.map((s) => `${s.path}:${s.line}`).join(", "), title: sites.map((s) => `${s.path}:${s.line} (${s.role})`).join("\n") });
        },
      },
    ]) || emptyState("No external hosts were contacted."),
  );

  // Soundness footnote: statically unresolvable destinations (e.g. URLs built at
  // runtime) — surfaced so a clean host list isn't mistaken for "talks to nobody".
  if (unresolved.length) {
    card.append(el("div", { class: "muted", text: `${unresolved.length} call${unresolved.length === 1 ? "" : "s"} with an unresolved destination` }));
    const ul = el("ul", { class: "refs" });
    for (const u of unresolved.slice(0, 25)) {
      const loc = u.location && u.location.path ? `${u.location.path}:${u.location.line ?? "?"}` : (u.path || "");
      ul.append(el("li", {}, [el("span", { class: "mono", text: u.ast_role || u.path || "call" }), el("span", { text: " — " + loc })]));
    }
    card.append(ul);
  }

  return card;
}

// Build the "Dimensions checked / cleared" card: concerns the investigation
// examined and cleared, each with the concrete checks it ran. These are the
// negative results of a deliberate look (not refuted findings) — surfacing them
// is what keeps a thoroughly-investigated benign extension from rendering empty.
function renderDismissalsCard(dismissals) {
  const card = el("div", { class: "card" });
  card.append(el("h3", { text: `Dimensions checked / cleared — ${dismissals.length}` }));
  card.append(el("p", { class: "muted", text: "Concerns examined and cleared, with the checks run. Negative results — nothing here is asserted as a behavior." }));
  for (const d of dismissals) {
    const block = el("div", { class: "finding" });
    block.append(el("h4", {}, [
      el("span", { text: d.concern || "(concern)" }),
      el("span", { class: "chip", text: "checked, cleared" }),
    ]));
    if (d.note) block.append(el("p", { text: d.note }));
    const checks = Array.isArray(d.checks_run) ? d.checks_run : [];
    if (checks.length) {
      block.append(el("div", { class: "muted", text: "Checks run" }));
      const ul = el("ul", { class: "refs" });
      for (const c of checks) ul.append(el("li", { text: c }));
      block.append(ul);
    }
    card.append(block);
  }
  return card;
}

// ---- sorting via URL state --------------------------------------------------

function toggleSort(ns, key) {
  const st = getState();
  const curKey = st.get("sort_" + ns);
  const curDir = st.get("dir_" + ns) || "DESC";
  let dir = "DESC";
  if (curKey === key) dir = curDir === "DESC" ? "ASC" : "DESC";
  setState(patchState({ ["sort_" + ns]: key, ["dir_" + ns]: dir }), { replace: true });
  if (ns === "runs") renderRuns();
  else if (ns === "find") renderFindings();
}

// ---- tab switching ----------------------------------------------------------

const TABS = ["performance", "runs", "extensions", "findings", "report"];

function showReportTab() {
  $('button[data-tab="report"]').hidden = false;
}

function switchTab(tab, { push = true } = {}) {
  if (!TABS.includes(tab)) tab = "performance";
  for (const t of TABS) {
    const panel = $("#panel-" + t);
    if (panel) panel.hidden = t !== tab;
    const btn = $(`button[data-tab="${t}"]`);
    if (btn) btn.classList.toggle("active", t === tab);
  }
  if (tab === "report") showReportTab();
  if (push) setState(patchState({ tab }), { replace: true });

  if (tab === "performance") renderPerformance();
  else if (tab === "runs") renderRuns();
  else if (tab === "extensions") renderExtensions();
  else if (tab === "findings") renderFindings();
}

// ---- wiring -----------------------------------------------------------------

function wireFilters() {
  // Runs
  for (const k of ["kind", "methodology", "model"]) {
    $("#runs-" + k).addEventListener("change", (e) => {
      setState(patchState({ ["runs_" + k]: e.target.value }), { replace: true });
      renderRuns();
    });
  }
  // Extensions search (debounced)
  $("#extensions-q").addEventListener("input", (e) => {
    clearTimeout(extQTimer);
    const v = e.target.value;
    extQTimer = setTimeout(() => {
      setState(patchState({ ext_q: v }), { replace: true });
      renderExtensions();
    }, 200);
  });
  // Findings
  for (const k of ["severity", "category", "finding_type", "verified", "methodology", "model"]) {
    $("#findings-" + k).addEventListener("change", (e) => {
      setState(patchState({ ["find_" + k]: e.target.value }), { replace: true });
      renderFindings();
    });
  }
  // Tabs
  for (const btn of document.querySelectorAll("#tabs button")) {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  }
}

function applyStateToControls() {
  const st = getState();
  // Findings + runs dropdowns get their saved values when their tab renders.
  // Restore a deep-linked report detail or extension report list on load.
  const tab = st.get("tab") || "performance";
  if (tab === "report" && st.get("report")) {
    showReportTab();
    switchTab("report", { push: false });
    openReportDetail(Number(st.get("report")));
    return;
  }
  if (tab === "extension" && st.get("ext") && st.get("ext_key")) {
    openExtensionByKey(st.get("ext_key"), st.get("ext"));
    return;
  }
  if (tab === "run_reports" && st.get("run")) {
    openRunReports(Number(st.get("run")));
    return;
  }
  switchTab(tab, { push: false });
}

async function init() {
  try {
    META = await getJson("/api/meta");
  } catch (e) {
    document.querySelector("main").prepend(el("div", { class: "error", text: "Could not load /api/meta: " + e.message }));
    META = { methodologies: [], models: [], kinds: [], tiers: [], severities: [], categories: [], findingTypes: [] };
  }
  fillSelect($("#runs-kind"), META.kinds);
  fillSelect($("#runs-methodology"), META.methodologies);
  fillSelect($("#runs-model"), META.models);
  fillSelect($("#findings-severity"), META.severities);
  fillSelect($("#findings-category"), META.categories);
  fillSelect($("#findings-finding_type"), META.findingTypes);
  fillSelect($("#findings-methodology"), META.methodologies);
  fillSelect($("#findings-model"), META.models);

  wireFilters();
  applyStateToControls();

  window.addEventListener("popstate", () => applyStateToControls());
}

init();
