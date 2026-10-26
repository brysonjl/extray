// Static-only HTML report: the evidence pack rendered as one self-contained
// page, with NO LLM anywhere in the path and no network access. This is the
// free/offline on-ramp (discovery B.3.1) — `analyze --html` produces it in
// seconds from an unpacked directory, with no API key, no token spend, and no
// outbound request of any kind.
//
// WHAT THIS REPORT DELIBERATELY DOES NOT DO: it assigns no risk tier, no score,
// and no verdict. Adjudication is the LLM layer's job (src/report/verdict.ts
// rolls up ASSERTED findings, which only exist after generation + verification).
// A static pass sees capability and structure, not intent, so this renderer
// presents facts and the pack's own pointer list and lets the reader judge.
// Inventing a score here would be exactly the "your tool said my malware was
// clean" failure the project's philosophy rejects.
//
// SECURITY: the same rule as render-html.ts — every interpolated string slot is
// attacker-controlled (paths, manifest fields, code snippets, URLs lifted out of
// extension source) and flows through esc(). The only non-esc'd interpolations
// are pipeline-typed NUMBERS. There are no scripts and no external assets, so a
// malicious extension cannot script the report that describes it.

import type { EvidencePack, FileEntry } from "../pipeline/schema.ts";
import type { HostEnrichment } from "../enrichment/types.ts";
import { buildCoverage, buildDestinations, buildDeveloper, buildIdentity, buildObfuscation, buildPermissions } from "./build.ts";
import { isHardObfuscation } from "../pipeline/obfuscation.ts";
import { CSS, esc, enrichmentHtml, fixtureNoticeHtml, safeUrl, section, yesNo } from "./render-html.ts";

// Display caps. Every capped list states the true total so a truncated view is
// never mistaken for a complete one.
const MAX_SITES_IN_CELL = 4;
const MAX_CONTEXT_ANOMALY_FILES = 5;
const MAX_RUNTIME_DESTINATIONS = 10;
const MAX_DYNAMIC_EXEC_SITES = 10;

// Additions to the shared report stylesheet: the fact strip and the signal
// list, neither of which exists in the LLM report's layout.
const STATIC_CSS = `
  ul.facts { display: flex; gap: 10px; flex-wrap: wrap; margin: 0; padding: 0; list-style: none; }
  ul.facts li { border: 1px solid #d8dde3; border-radius: 6px; padding: 8px 12px; background: #fafbfc;
                font-size: 0.8rem; color: #57606a; min-width: 108px; }
  ul.facts b { display: block; font-size: 1.3rem; line-height: 1.25; color: #1f2328; }
  .sig { border-left: 4px solid #d8dde3; padding: 4px 0 4px 12px; margin: 10px 0; font-size: 0.94rem; }
  .sig.high { border-left-color: #b3261e; }
  .sig.medium { border-left-color: #c46a00; }
  .sig.low { border-left-color: #57606a; }
  .sig .kind { display: block; font-size: 0.68rem; font-weight: 700; text-transform: uppercase;
               letter-spacing: 0.05em; color: #57606a; }
  .group { margin: 0 0 16px; }
  .group h3 { margin: 0 0 2px; font-size: 0.95rem; }
`;

// ---------------------------------------------------------------------------
// summary_signals → sentences
// ---------------------------------------------------------------------------

export type SignalLevel = "high" | "medium" | "low";

export interface SignalLine {
  level: SignalLevel;
  kind: string;
  text: string;
}

/** Pack signals are `unknown[]` by contract; read fields defensively. */
function str(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}

/**
 * One plain-language sentence per signal kind the pipeline emits
 * (src/pipeline/summary.ts, index.ts, cap.ts). A kind with no entry here falls
 * back to a key=value rendering rather than being dropped — a new signal must
 * never vanish from the report just because this map is stale.
 */
const SIGNAL_PHRASES: Record<string, (s: Record<string, unknown>) => string> = {
  "dangerous-combination": (s) => `Dangerous permission combination: ${str(s.detail)}.`,
  "obfuscation-flagged": (s) => `${str(s.path)} trips the obfuscation heuristic (see Obfuscation below for whether that is concealment or minification).`,
  "data-flow": (s) => `Data flow in ${str(s.path)}: ${str(s.classification).replace(/-/g, " ")}.`,
  "data-egress-to-publisher": (s) => `${str(s.source_kind)} data read in ${str(s.path)} reaches the publisher's own domain (${str(s.dest_host)}).`,
  "binary-asset-read-as-data": (s) => `${str(s.path)}: ${str(s.detail)} — and bundled code reads that exact file via ${str(s.read_via)}.`,
  "binary-asset-hidden-bytes": (s) => `${str(s.path)}: ${str(s.detail)}. No script was seen reading it by literal path.`,
  "missing-referenced-asset": (s) => `${str(s.path)} is referenced but is not present in the package.`,
  "remote-resource": (s) => `${str(s.path)} loads a remote resource (${str(s.ref_kind)}): ${str(s.url)}`,
  "unused-permission": (s) => `${str(s.permission)} is declared but no use of it was found in the bundled code.`,
  "external-surface": (s) => `External messaging surface: ${str(s.detail)}.`,
  "indirect-external-call": (s) => `Indirect call to ${str(s.api)} in ${str(s.path)} — name-based detection cannot follow it.`,
  "permission-undetermined": (s) => `${str(s.permission)} is declared; static analysis could not determine where it is used.`,
  "coverage-gap": (s) =>
    `Coverage gap: ${str(s.opaque_regions)} opaque region(s), ${str(s.unresolved_destinations)} unresolved destination(s), ${str(s.unparsed_files)} unparsed file(s).`,
  truncation: (s) => `The evidence pack hit its size cap: ${str(s.removed)} entries removed from ${str(s.array)}.`,
};

function describeSignal(raw: unknown): { kind: string; text: string } {
  const s = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const kind = str(s.kind) || "signal";
  const phrase = SIGNAL_PHRASES[kind];
  if (phrase) return { kind, text: phrase(s) };
  const rest = Object.entries(s)
    .filter(([k]) => k !== "kind")
    .map(([k, v]) => `${k}=${str(v)}`)
    .join(", ");
  return { kind, text: rest || kind };
}

/** The pack's own pointer list, flattened into ordered, readable lines. */
export function describeSignals(pack: EvidencePack): SignalLine[] {
  const levels: SignalLevel[] = ["high", "medium", "low"];
  return levels.flatMap((level) => pack.summary_signals[level].map((raw) => ({ level, ...describeSignal(raw) })));
}

// ---------------------------------------------------------------------------
// files[].anomalies → grouped classes
// ---------------------------------------------------------------------------

/**
 * `notable` anomalies are worth a look on their own; `context` anomalies are
 * common enough (unreferenced locale files, minified bundles) that listing every
 * occurrence buries the rest of the report — a real corpus sample produces ~94
 * "unreferenced" entries against 1 hidden-bytes entry. Context classes are
 * therefore collapsed to a count plus a few examples.
 */
export interface AnomalyGroup {
  id: string;
  label: string;
  concern: "notable" | "context";
  note: string;
  files: Array<{ path: string; detail: string }>;
}

const ANOMALY_CLASSES: Array<Omit<AnomalyGroup, "files"> & { match: RegExp }> = [
  {
    id: "hidden-bytes",
    match: /end-of-image marker/,
    label: "Bytes hidden after an image's end-of-image marker",
    concern: "notable",
    note: "The image still decodes and still renders, so nothing looks wrong; the trailing bytes are invisible to a viewer and to an image decoder, but a script can read them at runtime via fetch(chrome.runtime.getURL(...)).arrayBuffer(). Concealment in an asset is not visible to a JavaScript obfuscation detector.",
  },
  {
    id: "magic-mismatch",
    match: /^magic-byte mismatch/,
    label: "File contents do not match the file's declared type",
    concern: "notable",
    note: "The bytes say one format and the filename says another. Sometimes a build accident; sometimes a payload wearing an innocuous extension.",
  },
  {
    id: "base64-blob",
    match: /large base64 blob/,
    label: "Large base64 blob embedded in a file",
    concern: "notable",
    note: "Usually an inlined asset, occasionally an encoded payload. Static analysis does not decode it — what the bytes are is not determined here.",
  },
  {
    id: "long-line",
    match: /very long line outside vendor path/,
    label: "Very long line outside a vendor path",
    concern: "context",
    note: "Consistent with ordinary minification, which every modern bundler emits. Minification is not concealment (improvement 018) and is listed here only so the file inventory is complete.",
  },
  {
    id: "unreferenced",
    match: /present but unreferenced/,
    label: "Present but unreferenced from the manifest, HTML, or JS imports",
    concern: "context",
    note: "Common and usually benign: locale catalogues, licences, and build leftovers all land here. Worth a glance only when the file is executable or unusually large.",
  },
];

const OTHER_ANOMALIES: Omit<AnomalyGroup, "files"> = {
  id: "other",
  label: "Other file anomalies",
  concern: "context",
  note: "Anomalies recorded by the file layer that this report has no dedicated explanation for.",
};

/** Group every `files[].anomalies` entry by class, notable classes first. */
export function groupFileAnomalies(files: FileEntry[]): AnomalyGroup[] {
  const groups = new Map<string, AnomalyGroup>();
  const order = [...ANOMALY_CLASSES, OTHER_ANOMALIES];
  for (const f of files) {
    for (const anomaly of f.anomalies) {
      const cls = ANOMALY_CLASSES.find((c) => c.match.test(anomaly)) ?? OTHER_ANOMALIES;
      const group = groups.get(cls.id) ?? { id: cls.id, label: cls.label, concern: cls.concern, note: cls.note, files: [] };
      group.files.push({ path: f.path, detail: anomaly });
      groups.set(cls.id, group);
    }
  }
  return order.map((c) => groups.get(c.id)).filter((g): g is AnomalyGroup => g !== undefined);
}

// ---------------------------------------------------------------------------
// Obfuscation: concealment vs. minification
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export interface StaticReportOptions {
  /**
   * Host-enrichment artifact (015/017) committed beside the extension dir, when
   * one exists. Absent → destination rows render without ownership context; the
   * renderer NEVER fetches one, so the report stays fully offline.
   */
  enrichment?: HostEnrichment | null;
}

function fact(value: number | string, label: string): string {
  return `<li><b>${esc(String(value))}</b>${esc(label)}</li>`;
}

function signalsHtml(lines: SignalLine[]): string {
  if (lines.length === 0) {
    return `<p class="empty">The pipeline recorded no summary signals for this extension.</p>`;
  }
  return lines.map((l) => `<div class="sig ${l.level}"><span class="kind">${esc(l.level)} · ${esc(l.kind)}</span>${esc(l.text)}</div>`).join("\n");
}

function anomalyGroupHtml(g: AnomalyGroup): string {
  const shown = g.concern === "notable" ? g.files : g.files.slice(0, MAX_CONTEXT_ANOMALY_FILES);
  const more = g.files.length - shown.length;
  const items = shown
    .map((f) => `<li><code>${esc(f.path)}</code>${g.concern === "notable" ? ` — ${esc(f.detail)}` : ""}</li>`)
    .join("");
  return `<div class="group"><h3>${esc(g.label)} (${g.files.length})</h3><p class="note">${esc(g.note)}</p><ul class="refs">${items}${
    more > 0 ? `<li>… and ${more} more file${more === 1 ? "" : "s"}</li>` : ""
  }</ul></div>`;
}

/**
 * Render one evidence pack as a standalone HTML page. Pure: same pack bytes ⇒
 * same page bytes, no filesystem read beyond what the caller already loaded, no
 * network.
 */
export function renderStaticReportHtml(pack: EvidencePack, opts: StaticReportOptions = {}): string {
  const identity = buildIdentity(pack, null);
  const permissions = buildPermissions(pack);
  const destinations = buildDestinations(pack, opts.enrichment ?? null);
  const obfuscation = buildObfuscation(pack);
  // No store listing is ever fetched on this path, so `listing_available` stays
  // null — "never looked", which the developer section renders distinctly from
  // "looked and the listing is gone". high_risk_country needs the listing's
  // country, so it is null here by construction, not by omission.
  const developer = buildDeveloper(pack.developer, null, null);
  const coverage = buildCoverage(pack);
  const signals = describeSignals(pack);
  const anomalies = groupFileAnomalies(pack.files);

  const name = identity.name ?? "(unnamed extension)";
  const counts = {
    high: pack.summary_signals.high.length,
    medium: pack.summary_signals.medium.length,
    low: pack.summary_signals.low.length,
  };

  const factsCard = `
  <div class="card">
    <ul class="facts">
      ${fact(counts.high, "high signals")}
      ${fact(counts.medium, "medium signals")}
      ${fact(counts.low, "low signals")}
      ${fact(permissions.api.length, "API permissions")}
      ${fact(permissions.hosts.required.length + permissions.hosts.optional.length, "host patterns")}
      ${fact(destinations.rows.length, "external hosts")}
      ${fact(pack.files.length, "files")}
      ${fact(pack.scripts.length, "scripts analyzed")}
    </ul>
    <p class="note">This report is produced by static analysis alone — no code was executed, no model was consulted, and no network request was made. It carries <b>no risk score and no verdict</b>: what follows is what the analyzer could see, and what it could not. The judgement is yours.</p>
  </div>`;

  const signalsBody = `<p class="note">The pipeline's own pointer list (<code>summary_signals</code>) — where a reviewer should look first, ordered high to low. A signal is a place to look, not an accusation.</p>${signalsHtml(
    signals,
  )}`;

  // --- Permissions (mirrors the LLM report's table; same deterministic source) ---
  const permRows = permissions.api
    .map((p) => {
      const shown = p.usage.slice(0, MAX_SITES_IN_CELL).map((u) => `<code>${esc(u.path)}:${u.line}</code> (${esc(u.api)})`);
      const more = p.total_usage - shown.length;
      const sites = shown.length === 0 ? "—" : shown.join(", ") + (more > 0 ? `, +${more} more` : "");
      const label = `<code>${esc(p.permission)}</code>${p.optional ? ' <span class="note">(optional)</span>' : ""}`;
      const docs = `<a href="${esc(safeUrl(p.doc_url))}" rel="nofollow noreferrer noopener" target="_blank">docs</a>`;
      return `<tr><td>${label}</td><td>${esc(p.description)}</td><td>${esc(p.status)}</td><td>${esc(p.usage_plain)}</td><td>${sites}</td><td>${docs}</td></tr>`;
    })
    .join("");
  const warned = permissions.api.filter((p) => p.install_warning);
  const warnLines =
    warned.length > 0
      ? `<div class="label">Chrome's install-time warnings</div><p class="note">Google's own layperson wording for what the user is agreeing to.</p><ul class="refs">${warned
          .map((p) => `<li><code>${esc(p.permission)}</code>: ${esc(p.install_warning!)}</li>`)
          .join("")}</ul>`
      : "";
  const hostLine = `Host access: ${
    permissions.hosts.required.length > 0 ? permissions.hosts.required.map((h) => `<code>${esc(h)}</code>`).join(", ") : "none required"
  }${permissions.hosts.optional.length > 0 ? `; optional: ${permissions.hosts.optional.map((h) => `<code>${esc(h)}</code>`).join(", ")}` : ""}.`;
  const dangerLines =
    permissions.dangerous_combinations.length > 0
      ? `<div class="label">Dangerous combinations</div><p class="note">Permission pairs whose combination grants materially more than either half alone.</p><ul class="refs">${permissions.dangerous_combinations
          .map((d) => `<li><b>${esc(d.kind)}</b> — ${esc(d.evidence.join("; "))}</li>`)
          .join("")}</ul>`
      : `<p class="note">No dangerous permission combinations were flagged.</p>`;
  const permBody = `${
    permissions.api.length > 0
      ? `<table><tr><th>Permission</th><th>What it allows</th><th>Status</th><th>How this extension uses it</th><th>Used at</th><th>Docs</th></tr>${permRows}</table>`
      : `<p class="empty">No API permissions are declared.</p>`
  }${warnLines}<p>${hostLine}</p><p class="note">${esc(permissions.hosts_plain)}</p>${dangerLines}`;

  // --- Destinations ---
  const destRows = destinations.rows
    .map(
      (d) =>
        `<tr><td><code>${esc(d.host)}</code></td><td>${d.references}</td><td>${esc(d.reached_via.join(", ") || "—")}</td><td>${
          d.any_dynamic ? "yes" : "no"
        }</td><td>${esc(d.party ?? "—")}</td><td>${enrichmentHtml(d.enrichment)}</td><td>${
          d.example_sites.length === 0 ? "—" : d.example_sites.map((s) => `<code>${esc(s.path)}:${s.line}</code> (${esc(s.role)})`).join(", ")
        }</td></tr>`,
    )
    .join("");
  const enrichmentNote = opts.enrichment
    ? `<p class="note">Ownership context comes from a host-enrichment artifact committed beside the extension (RDAP registration + DNS/CDN resolution). It was read from disk; nothing was looked up while rendering.</p>`
    : `<p class="note">No host-enrichment artifact was found beside this extension, so the ownership column is empty. This report never performs a lookup — run <code>npm run enrich-hosts</code> separately if you want registration and CDN context.</p>`;

  // Destinations assembled at runtime. These are the calls a reader most needs
  // to know about and the ones a host table can never show: layer 4 records the
  // template/dynamic form, and the actual host is decided at runtime. Note the
  // accounting subtlety — a `template` destination is "resolved to a template",
  // so it is NOT counted in external_call_ledger.unresolved_destinations; listing
  // it here is what keeps the coverage story honest.
  const runtimeDests = pack.scripts.flatMap((s) =>
    s.network_destinations.filter((d) => d.kind !== "static").map((d) => ({ path: s.path, ...d })),
  );
  const runtimeList =
    runtimeDests.length > 0
      ? `<div class="label">Destinations assembled at runtime (${runtimeDests.length})</div><p class="note">The host is built from variables or concatenation, so static analysis records the shape and not the target. Where these calls actually go is <b>not determined by this report</b>.</p><ul class="refs">${runtimeDests
          .slice(0, MAX_RUNTIME_DESTINATIONS)
          .map((d) => `<li><code>${esc(d.path)}:${d.location.line}</code> (${esc(d.ast_role)}, ${esc(d.kind)}) → <code>${esc(d.value)}</code></li>`)
          .join("")}${runtimeDests.length > MAX_RUNTIME_DESTINATIONS ? `<li>… and ${runtimeDests.length - MAX_RUNTIME_DESTINATIONS} more</li>` : ""}</ul>`
      : "";
  const unresolvedList =
    destinations.unresolved.length > 0
      ? `<div class="label">Unresolved destinations (${destinations.unresolved.length})</div><ul class="refs">${destinations.unresolved
          .map((u) => `<li><code>${esc(u.path)}:${u.location.line}</code> (${esc(u.ast_role)})</li>`)
          .join("")}</ul>`
      : `<p class="note">Every statically visible network call carried a destination the analyzer could name.</p>`;
  const destBody = `${
    destinations.rows.length > 0
      ? `<table><tr><th>Host</th><th>Refs</th><th>Reached via</th><th>Dynamic</th><th>Party</th><th>Owner / age (RDAP)</th><th>Example call sites</th></tr>${destRows}</table>`
      : `<p class="empty">No external destinations were statically resolved.</p>`
  }${enrichmentNote}${runtimeList}${unresolvedList}`;

  // --- Obfuscation ---
  const hard = obfuscation.flagged.filter(isHardObfuscation);
  const obfRows = obfuscation.flagged
    .map((o) => {
      const indicators = [
        o.string_array_decoder_detected ? "string-array decoder" : null,
        o.packer_signature ? `packer: ${o.packer_signature}` : null,
        o.hex_escape_density_per_kb > 0 ? `hex-escape density ${o.hex_escape_density_per_kb.toFixed(2)}/KB` : null,
      ]
        .filter(Boolean)
        .join(", ");
      const verdictless = isHardObfuscation(o) ? "shows concealment" : "consistent with minification";
      return `<tr><td><code>${esc(o.path)}</code></td><td>${esc(indicators || "none")}</td><td>${o.identifier_entropy.toFixed(2)}</td><td>${o.mean_identifier_length.toFixed(
        1,
      )}</td><td>${esc(verdictless)}</td></tr>`;
    })
    .join("");
  const dynExec = obfuscation.opaque_regions.filter((o) => o.kind === "dynamic-code-exec");
  const dynExecList =
    dynExec.length > 0
      ? `<div class="label">Dynamic code-execution sites (${dynExec.length})</div><p class="note">Code assembled or evaluated at runtime. Whatever runs there is invisible to this report.</p><ul class="refs">${dynExec
          .slice(0, MAX_DYNAMIC_EXEC_SITES)
          .map((o) => `<li><code>${esc(o.path)}${o.location ? `:${o.location.line}` : ""}</code>${o.api ? ` (${esc(o.api)})` : ""}</li>`)
          .join("")}${dynExec.length > MAX_DYNAMIC_EXEC_SITES ? `<li>… and ${dynExec.length - MAX_DYNAMIC_EXEC_SITES} more</li>` : ""}</ul>`
      : "";
  const obfBody = `<p class="note">The structural scanner flags a file on identifier statistics and line length, so <b>most flagged files are simply minified</b> — the normal output of a bundler. Only a string-array decoder, a packer signature, or a dense run of hex/unicode escapes is affirmative evidence of concealment (improvement 018). Both are shown; the last column says which.</p>${
    obfuscation.flagged.length > 0
      ? `<p>${obfuscation.flagged.length} file${obfuscation.flagged.length === 1 ? "" : "s"} flagged, of which <b>${hard.length}</b> show${
          hard.length === 1 ? "s" : ""
        } concealment rather than minification.</p><table><tr><th>File</th><th>Concealment indicators</th><th>Identifier entropy</th><th>Mean identifier length</th><th>Reading</th></tr>${obfRows}</table>`
      : `<p class="empty">No files were flagged by the obfuscation heuristic.</p>`
  }${dynExecList}<p class="note">This check reads JavaScript only. Concealment can live outside the code — in a bundled image, font, or data file — where a code-level detector cannot reach it; see File anomalies.</p>`;

  // --- File anomalies ---
  const anomalyCount = anomalies.reduce((n, g) => n + g.files.length, 0);
  const anomaliesBody =
    anomalies.length > 0
      ? `<p class="note">Structural oddities recorded per file. Grouped by kind, the ones worth attention first — a long tail of unreferenced locale files should not bury a single hidden payload.</p>${anomalies
          .map(anomalyGroupHtml)
          .join("")}`
      : `<p class="empty">No file anomalies were recorded.</p>`;

  // --- Developer ---
  const devBody = `<table>
    <tr><th>Name</th><td>${developer.name ? esc(developer.name) : '<span class="empty">not declared</span>'}</td></tr>
    <tr><th>Email</th><td>${developer.email ? esc(developer.email) : '<span class="empty">not declared</span>'}</td></tr>
    <tr><th>Website</th><td>${developer.website ? esc(developer.website) : '<span class="empty">not declared</span>'}</td></tr>
    <tr><th>Address</th><td>${developer.address ? esc(developer.address) : '<span class="empty">not declared</span>'}</td></tr>
    <tr><th>Country</th><td>${developer.country ? esc(developer.country) : '<span class="empty">not declared</span>'}</td></tr>
    <tr><th>EU trader declaration</th><td>${yesNo(developer.is_trader, "not available")}</td></tr>
    <tr><th>Update channel</th><td>${
      developer.non_store_update_url ? `<b>non-store</b>: <code>${esc(developer.update_url ?? "")}</code>` : `default (Chrome Web Store)`
    }</td></tr>
  </table><p class="note">Everything above is <b>self-reported by the extension's own manifest</b> — an attacker can write whatever they like there. The Chrome Web Store listing, which carries the verified publisher identity and the EU trader declaration, is fetched over the network and so is deliberately not consulted here.</p>`;

  // --- Coverage ---
  const coverageBody = `<p>Measured coverage gaps in this run: ${coverage.opaque_regions} opaque region(s), ${coverage.indirect_calls} indirect call(s), ${
    coverage.unresolved_destinations
  } unresolved destination(s), ${coverage.unparsed_files.length} unparsed file(s).</p>
  ${
    coverage.unparsed_files.length > 0
      ? `<div class="label">Files that failed to parse (never sink-scanned)</div><ul class="refs">${coverage.unparsed_files
          .map((f) => `<li><code>${esc(f)}</code></li>`)
          .join("")}</ul>`
      : ""
  }
  <div class="label">Structural limits of every static assessment</div>
  <ul class="refs">${coverage.structural_limits.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
  <div class="label">Limits specific to this offline report</div>
  <ul class="refs">
    <li>No code was executed, so behaviour that only appears at runtime — remotely fetched configuration, server-chosen destinations, conditional payloads — is out of reach by construction.</li>
    <li>No network request was made, so nothing here is checked against the Chrome Web Store listing, domain reputation, or a live DNS answer.</li>
    <li>No model reviewed this evidence. Nothing was interpreted, correlated across sections, or judged; only the pipeline's own signals are asserted.</li>
    <li>Absence of a signal is not evidence of safety. It means this pass did not see one.</li>
  </ul>`;

  const meta = [
    `<code>${esc(pack.extension.id_from_path)}</code>`,
    `manifest v${identity.manifest_version}`,
    `analyzed ${esc(pack.analyzed_at)}`,
    `pack schema ${esc(pack.schema_version)}`,
    `analyzer ${esc(pack.analyzer_version)}`,
    `static analysis only — no LLM, no network`,
  ].join(" · ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Static analysis: ${esc(name)}</title>
<style>${CSS}${STATIC_CSS}</style>
</head>
<body>
<main>
  <h1>Static analysis: ${esc(name)}${identity.version ? ` <small>v${esc(identity.version)}</small>` : ""}</h1>
  ${pack.fixture ? fixtureNoticeHtml() : ""}
  <div class="meta">${meta}</div>
  ${factsCard}
  ${section(`Signals (${counts.high} high, ${counts.medium} medium, ${counts.low} low)`, signalsBody, true)}
  ${section(`Permissions (${permissions.api.length} API, ${permissions.hosts.required.length} host)`, permBody, true)}
  ${section(
    `External destinations (${destinations.rows.length} host${destinations.rows.length === 1 ? "" : "s"}, ${runtimeDests.length} assembled at runtime)`,
    destBody,
    true,
  )}
  ${section(`Obfuscation (${obfuscation.flagged.length} flagged, ${hard.length} showing concealment)`, obfBody, true)}
  ${section(`File anomalies (${anomalyCount})`, anomaliesBody, true)}
  ${section("Developer (self-reported)", devBody, true)}
  ${section("Coverage and limits", coverageBody, true)}
</main>
</body>
</html>
`;
}
