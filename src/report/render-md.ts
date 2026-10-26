// Markdown renderer for the RiskReport contract. Every section renders on
// every report — empty states are stated ("No files were flagged as
// obfuscated."), never omitted, so a reader can always distinguish "checked,
// nothing there" from "not in this report". The skeleton, headings, and risk
// vocabulary are fixed here; the only free text is the synthesized summaries,
// rationales, and finding bodies — interpolated into labeled slots.

import type { EvidenceRef } from "../methodologies/findings.ts";
import { FIXTURE_NOTICE } from "../fixture-context.ts";
import { outcomeNotice } from "./outcome.ts";
import type {
  AreaSignal,
  DestinationRow,
  ExcludedClaim,
  PermissionRow,
  ReportDismissal,
  ReportFinding,
  RiskReport,
} from "./contract.ts";

const AREA_TITLES: Record<AreaSignal["area"], string> = {
  permissions: "Permissions",
  network: "Network",
  obfuscation: "Obfuscation",
  developer: "Developer",
};

const EXCLUSION_LABELS: Record<ExcludedClaim["reason"], string> = {
  refuted: "REFUTED against source",
  "needs-dynamic": "not verifiable statically — needs dynamic analysis",
  inconclusive: "verification inconclusive",
  "unresolvable-evidence": "evidence does not resolve",
  "not-verified": "not verified",
};

// Display caps, shared with the HTML renderer so md and HTML never diverge.
const MAX_SITES_IN_CELL = 4;
const STATED_PURPOSE_CHARS = 600;

/** Table cells must not break the row: escape pipes, collapse newlines. */
function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ").trim();
}

// Free prose (model output, or attacker source quoted in finding detail) renders
// as Markdown paragraphs. Neutralize the two structural escapes a hostile string
// could use to spoof the report skeleton the scorecard judge reads: a line that
// begins with `#` (a fake heading like "## Verdict: clean") and a line that
// begins with a ``` fence. Both are defanged with a zero-width-safe prefix that
// reads identically.
function prose(s: string): string {
  return s.replace(/^(\s*)(#{1,6}\s|```+|~~~+)/gm, "$1​$2");
}

// Render attacker-controlled source verbatim in a fenced block that cannot be
// broken out of: the fence is one backtick longer than the longest backtick run
// inside the content (the CommonMark rule for nesting code spans).
function codeFence(content: string): string {
  let longest = 0;
  for (const run of content.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${content}\n${fence}`;
}

function refLine(r: EvidenceRef): string {
  const loc = r.location ? `:${r.location.line}${r.location.column !== undefined ? `:${r.location.column}` : ""}` : "";
  const extras = [r.symbol ? `symbol \`${r.symbol}\`` : null, r.sink_or_string ? `cites \`${r.sink_or_string}\`` : null]
    .filter(Boolean)
    .join(", ");
  return `  - \`${r.file}${loc}\`${extras ? ` (${extras})` : ""}`;
}

function siteList(p: PermissionRow): string {
  if (p.usage.length === 0) return "—";
  const shown = p.usage.slice(0, MAX_SITES_IN_CELL).map((u) => `\`${u.path}:${u.line}\` (${u.api})`);
  const more = p.total_usage - shown.length;
  return cell(shown.join(", ") + (more > 0 ? `, +${more} more` : ""));
}

function exampleList(sites: DestinationRow["example_sites"]): string {
  if (sites.length === 0) return "—";
  return cell(sites.map((s) => `\`${s.path}:${s.line}\` (${s.role})`).join(", "));
}

// RDAP+DNS enrichment (015/017) as one table cell: owner/registrar + registration
// date, then either a CDN label or the resolved/literal IP's owner/ASN/country
// (never both — once a CDN match exists, those IP facts describe the edge
// network, not the destination, so the cell labels it rather than asserting a
// country of origin), then any TRUE descriptive flag. Context, not verdict.
function enrichmentCell(enr: DestinationRow["enrichment"]): string {
  if (!enr) return "—";
  if (enr.lookup_status !== "ok") return enr.lookup_status;
  const parts: string[] = [];
  if (enr.domain) {
    const d = enr.domain;
    if (d.registrar || d.registrant_org) parts.push(d.registrar ?? d.registrant_org!);
    if (d.created) parts.push(`reg ${d.created.slice(0, 10)}`);
    if (d.expires) parts.push(`exp ${d.expires.slice(0, 10)}`);
  }
  if (enr.cdn) {
    parts.push(`fronted by ${enr.cdn.provider}`);
  } else if (enr.ip) {
    const ip = enr.ip;
    if (ip.owner_org || ip.network_name) parts.push(ip.owner_org ?? ip.network_name!);
    if (ip.asn) parts.push(ip.asn);
    if (ip.country) parts.push(ip.country);
  }
  const flags = [
    enr.newly_registered === true ? "newly-registered" : null,
    enr.expired_or_hold === true ? "expired/hold" : null,
    enr.high_risk_country === true ? "high-risk-country" : null,
  ].filter((f): f is string => f !== null);
  if (flags.length > 0) parts.push(`[${flags.join(", ")}]`);
  return cell(parts.join(" · ") || "ok");
}

function findingBlock(f: ReportFinding): string {
  const lines = [`### ${f.number}. ${cell(f.title)} — ${f.kind === "verified-behavior" ? "verified behavior" : "observed capability"}`, ""];
  if (f.detail) lines.push(prose(f.detail), "");
  if (f.claimed_mechanism) lines.push(`Mechanism: ${prose(f.claimed_mechanism)}`, "");
  lines.push(`Confidence (as generated): ${f.confidence}.`, "");
  if (f.evidence_refs.length > 0) lines.push("Evidence:", ...f.evidence_refs.map(refLine), "");
  if (f.verification) {
    const v = f.verification;
    const at = v.grounding ? (v.grounding.line !== null ? ` at \`${v.grounding.file}:${v.grounding.line}\`` : ` in \`${v.grounding.file}\``) : "";
    lines.push(`Source verification: **confirmed**${at}.${v.rationale ? ` ${prose(v.rationale)}` : ""}`);
    if (v.evidence_quote) lines.push("", codeFence(v.evidence_quote));
    lines.push("");
  }
  return lines.join("\n");
}

function excludedBlock(e: ExcludedClaim): string {
  const lines = [`### ${cell(e.title)} — ${EXCLUSION_LABELS[e.reason]}`, ""];
  if (e.detail) lines.push(prose(e.detail), "");
  if (e.claimed_mechanism) lines.push(`Mechanism (claimed): ${prose(e.claimed_mechanism)}`, "");
  if (e.evidence_refs.length > 0) lines.push("Evidence (as cited):", ...e.evidence_refs.map(refLine), "");
  if (e.reason === "unresolvable-evidence") {
    lines.push(
      e.evidence_refs.length === 0
        ? "Not asserted: the claim cites no evidence at all."
        : "Not asserted: none of the cited evidence files exist in the extension — the citation does not resolve and the claim is likely invalid.",
      "",
    );
  } else if (e.reason === "not-verified") {
    lines.push("Not asserted: this behavioral claim was not verified against source.", "");
  } else if (e.verifier_rationale) {
    lines.push(`Source verification: **${e.reason === "refuted" ? "refuted" : e.reason}**. ${prose(e.verifier_rationale)}`);
    if (e.verifier_quote) lines.push("", codeFence(e.verifier_quote));
    lines.push("");
  }
  return lines.join("\n");
}

function dismissalBlock(d: ReportDismissal): string {
  const lines = [`### ${cell(d.concern)} — checked, cleared`, ""];
  if (d.note) lines.push(prose(d.note), "");
  if (d.checks_run.length > 0) {
    lines.push("Checks run:", "");
    for (const c of d.checks_run) lines.push(`- ${prose(c)}`);
    lines.push("");
  }
  return lines.join("\n");
}

function yesNo(v: boolean | null, nullLabel = "unknown"): string {
  return v === null ? nullLabel : v ? "yes" : "no";
}

export function renderReportMarkdown(r: RiskReport): string {
  const lines: string[] = [];
  const title = r.extension.name ?? "(unnamed extension)";
  lines.push(
    `# Extension risk report: ${title}${r.extension.version ? ` v${r.extension.version}` : ""}`,
    "",
    ...(r.extension.fixture ? [`> **Synthetic test fixture.** ${FIXTURE_NOTICE}`, ""] : []),
    `> ${[
      r.extension.store_id ? `store id \`${r.extension.store_id}\`` : null,
      `manifest v${r.extension.manifest_version}`,
      `analyzed ${r.generated_at}`,
      `methodology \`${r.methodology}\``,
      `model \`${r.model}\``,
      `report schema ${r.report_schema_version}`,
    ]
      .filter(Boolean)
      .join(" · ")}`,
    "",
  );

  // ---- Verdict ----
  if (r.skill_review) {
    const { review, provenance } = r.skill_review;
    lines.push(
      "> **Imported agent review — unverified candidates.** No independent claim verification or engine verdict was run.", "",
      `Harness: ${cell(provenance.harness)} · model: ${cell(provenance.model)} · skill: ${cell(provenance.skill_version)} · session: ${cell(provenance.session_id ?? "not recorded")}`,
      `Source SHA-256: ${provenance.source_sha256}`, `Review SHA-256: ${provenance.review_sha256}`, "",
      "## Candidate findings (unverified)", "",
    );
    for (const f of review.findings) {
      lines.push(`### ${cell(f.title)}`, "", `Agent assessment: ${cell(f.severity)} / ${cell(f.finding_type)} / ${cell(f.confidence)} confidence.`, "", prose(f.detail), "");
      if (f.claimed_mechanism) lines.push(`Mechanism (unverified): ${prose(f.claimed_mechanism)}`, "");
      lines.push(...f.evidence_refs.map(refLine), "");
    }
    lines.push(`## Agent-reported coverage (${review.investigation})`, "");
    for (const c of review.coverage) lines.push(`- **${c.dimension}: ${c.status}** — ${cell(c.note)} Checks: ${cell(c.checks_run.join("; "))}`);
    lines.push("");
  }
  const notice = outcomeNotice(r.outcome);
  if (notice) lines.push(`> **${prose(notice)}**`, "");
  lines.push(`## Verdict: ${r.verdict.tier}`, "");
  lines.push(r.verdict.rationale ? prose(r.verdict.rationale) : "_No tier rationale was produced._", "");
  lines.push("| Area | Signal | Note |", "|---|---|---|");
  for (const area of ["permissions", "network", "obfuscation", "developer"] as const) {
    const s = r.verdict.per_area.find((a) => a.area === area);
    lines.push(s ? `| ${AREA_TITLES[area]} | ${s.level} | ${cell(s.note)} |` : `| ${AREA_TITLES[area]} | — | not assessed |`);
  }
  lines.push("");

  // ---- Summaries ----
  lines.push("## Summary", "", r.summaries.layperson ? prose(r.summaries.layperson) : "_No summary was produced._", "");
  lines.push("### Technical summary", "", r.summaries.technical ? prose(r.summaries.technical) : "_No technical summary was produced._", "");

  // ---- Stated purpose vs observed behavior ----
  lines.push("## Stated purpose vs. observed behavior", "");
  const dd = r.description_deviation;
  if (dd.stated_purpose) {
    const stated = dd.stated_purpose.length > STATED_PURPOSE_CHARS ? dd.stated_purpose.slice(0, STATED_PURPOSE_CHARS) + "…" : dd.stated_purpose;
    lines.push(`Stated purpose (from ${dd.stated_source === "store_listing" ? "the store listing" : "the manifest"}):`, "", `> ${cell(stated)}`, "");
    lines.push(`Deviation from stated purpose: **${dd.deviates === null ? "not assessed" : dd.deviates ? "yes" : "no"}**.${dd.note ? ` ${prose(dd.note)}` : ""}`, "");
  } else {
    lines.push("No stated purpose was available to compare against (no store listing fetched and no manifest description).", "");
  }

  // ---- Permissions ----
  lines.push("## Permissions", "");
  if (r.permissions.api.length === 0) {
    lines.push("No API permissions are declared.", "");
  } else {
    lines.push(
      "| Permission | What it allows | Status | How this extension uses it | Used at | Docs |",
      "|---|---|---|---|---|---|",
    );
    for (const p of r.permissions.api) {
      lines.push(
        `| \`${p.permission}\`${p.optional ? " (optional)" : ""} | ${cell(p.description)} | ${p.status} | ${cell(p.usage_plain)} | ${siteList(p)} | [docs](${p.doc_url}) |`,
      );
    }
    lines.push("");
    // Chrome's verbatim install-time warnings — the official layperson wording.
    const warned = r.permissions.api.filter((p) => p.install_warning);
    if (warned.length > 0) {
      lines.push("At install, Chrome warns users about these permissions (Chrome's own wording):", "");
      for (const p of warned) lines.push(`- \`${p.permission}\`: ${cell(p.install_warning!)}`);
      lines.push("");
    }
  }
  const hosts = r.permissions.hosts;
  lines.push(
    `Host access: ${hosts.required.length > 0 ? hosts.required.map((h) => `\`${h}\``).join(", ") : "none required"}` +
      `${hosts.optional.length > 0 ? `; optional: ${hosts.optional.map((h) => `\`${h}\``).join(", ")}` : ""}.`,
    "",
    `_${cell(r.permissions.hosts_plain)}_`,
    "",
  );
  if (r.permissions.dangerous_combinations.length > 0) {
    lines.push("Dangerous combinations flagged by static analysis:", "");
    for (const d of r.permissions.dangerous_combinations) lines.push(`- **${d.kind}** — ${d.evidence.join("; ")}`);
    lines.push("");
  } else {
    lines.push("No dangerous permission combinations were flagged.", "");
  }

  // ---- External destinations ----
  lines.push("## External destinations", "");
  if (r.destinations.rows.length === 0) {
    lines.push("No external destinations were statically resolved.", "");
  } else {
    lines.push(
      "| Host | References | Reached via | Dynamic | Party | Owner / age (RDAP) | Example call sites |",
      "|---|---|---|---|---|---|---|",
    );
    for (const d of r.destinations.rows) {
      lines.push(
        `| \`${cell(d.host)}\` | ${d.references} | ${cell(d.reached_via.join(", ") || "—")} | ${d.any_dynamic ? "yes" : "no"} | ${d.party ?? "—"} | ${enrichmentCell(d.enrichment)} | ${exampleList(d.example_sites)} |`,
      );
    }
    lines.push("");
  }
  if (r.destinations.unresolved.length > 0) {
    lines.push(`${r.destinations.unresolved.length} network call(s) have statically unresolvable destinations:`, "");
    for (const u of r.destinations.unresolved) lines.push(`- \`${u.path}:${u.location.line}\` (${u.ast_role})`);
    lines.push("");
  } else {
    lines.push("All statically visible network calls had resolvable destinations.", "");
  }

  // ---- Obfuscation ----
  lines.push("## Obfuscation", "");
  if (r.obfuscation.flagged.length === 0) {
    lines.push("No files were flagged as obfuscated.", "");
  } else {
    lines.push("| File | Indicators |", "|---|---|");
    for (const o of r.obfuscation.flagged) {
      const indicators = [
        o.string_array_decoder_detected ? "string-array decoder" : null,
        o.packer_signature ? `packer: ${o.packer_signature}` : null,
        `identifier entropy ${o.identifier_entropy.toFixed(2)}`,
        `mean identifier length ${o.mean_identifier_length.toFixed(1)}`,
        o.hex_escape_density_per_kb > 0 ? `hex-escape density ${o.hex_escape_density_per_kb.toFixed(1)}/KB` : null,
      ]
        .filter(Boolean)
        .join(", ");
      lines.push(`| \`${cell(o.path)}\` | ${cell(indicators)} |`);
    }
    lines.push("");
  }
  const dynExec = r.obfuscation.opaque_regions.filter((o) => o.kind === "dynamic-code-exec");
  if (dynExec.length > 0) {
    lines.push(`${dynExec.length} dynamic code-execution site(s) (e.g. eval, Function) are opaque to static analysis:`, "");
    for (const o of dynExec.slice(0, 10)) lines.push(`- \`${o.path}${o.location ? `:${o.location.line}` : ""}\`${o.api ? ` (${o.api})` : ""}`);
    if (dynExec.length > 10) lines.push(`- … and ${dynExec.length - 10} more`);
    lines.push("");
  }

  // ---- Developer ----
  lines.push("## Developer", "");
  const dev = r.developer;
  lines.push("| Field | Value |", "|---|---|");
  lines.push(`| Name | ${dev.name ? cell(dev.name) : "not available"} |`);
  lines.push(`| Email | ${dev.email ? cell(dev.email) : "not available"} |`);
  lines.push(`| Website | ${dev.website ? cell(dev.website) : "not available"} |`);
  lines.push(`| Address | ${dev.address ? cell(dev.address) : "not available"} |`);
  lines.push(`| Country | ${dev.country ? cell(dev.country) : "not available"} |`);
  lines.push(`| High-risk country | ${yesNo(dev.high_risk_country)} |`);
  lines.push(`| EU trader declaration | ${yesNo(dev.is_trader, "not available")} |`);
  lines.push(`| Update channel | ${dev.non_store_update_url ? `**non-store**: \`${cell(dev.update_url ?? "")}\`` : "default (Chrome Web Store)"} |`);
  lines.push("");
  if (dev.listing_available === null) {
    lines.push("_Store listing was not fetched for this run — developer identity is limited to what the extension self-reports._", "");
  } else if (dev.listing_available === false) {
    lines.push("_The Chrome Web Store listing was unavailable when fetched (unlisted or removed extension)._", "");
  } else {
    lines.push(`_Store listing fetched ${dev.listing_fetched_at}._`, "");
  }

  // ---- Findings ----
  lines.push(
    "## Findings",
    "",
    'The asserted findings of this report. A "verified behavior" was adjudicated against the extension\'s actual source code and CONFIRMED; an "observed capability" is an API/permission/string/destination present in the evidence, with no behavioral mechanism asserted.',
    "",
  );
  if (r.findings.length > 0) {
    for (const f of r.findings) lines.push(findingBlock(f));
  } else {
    lines.push("No findings are asserted.", "");
  }

  // ---- Excluded claims (always present) ----
  lines.push(
    "## Excluded claims (checked, NOT findings)",
    "",
    "Generated claims that did NOT survive verification, recorded for audit with the reason each was excluded. None of these is asserted as a behavior of this extension.",
    "",
  );
  if (r.excluded_claims.length > 0) {
    for (const e of r.excluded_claims) lines.push(excludedBlock(e));
  } else {
    lines.push(r.skill_review ? "Not run — candidate claims have not been independently verified." : "None — every generated claim survived verification.", "");
  }

  // ---- Dimensions checked (cleared) ----
  // The investigation's negative results: concerns examined and cleared, with the
  // concrete checks run. Distinct from excluded claims (refuted findings) — a
  // dismissal is "we looked here and found nothing to assert". Present for the
  // multi-node DAG and sharded Pi arms; empty for single-shot arms.
  lines.push(
    "## Dimensions checked (cleared)",
    "",
    "Concerns the investigation examined and cleared, with the checks it ran. These are negative results — nothing here is asserted as a behavior — recorded so a thorough review is visible rather than reading as an empty report.",
    "",
  );
  if (r.dismissals.length > 0) {
    for (const d of r.dismissals) lines.push(dismissalBlock(d));
  } else {
    lines.push("No concerns were recorded as separately checked and cleared in this run.", "");
  }

  // ---- Coverage & limits ----
  lines.push("## Coverage and limits", "");
  lines.push(
    `Static coverage gaps in this run: ${r.coverage.opaque_regions} opaque region(s), ${r.coverage.indirect_calls} indirect call(s), ${r.coverage.unresolved_destinations} unresolved destination(s), ${r.coverage.unparsed_files.length} unparsed file(s)${r.coverage.unparsed_files.length > 0 ? ` (${r.coverage.unparsed_files.map((f) => `\`${f}\``).join(", ")})` : ""}.`,
    "",
    "Structural limits that apply to every static assessment:",
    "",
  );
  for (const l of r.coverage.structural_limits) lines.push(`- ${l}`);
  lines.push("");

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
