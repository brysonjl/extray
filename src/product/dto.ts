// Role-scoped view models (plan §14.3). DTOs are BUILT per role — an
// admin-only field is absent from a User payload, never nulled or CSS-hidden.
// This module is the server-side redaction mechanism; everything it emits is
// derived from the stored risk_report_json (shape verified in plan §14.2),
// read defensively because arms differ in which optional fields they emit.

import type { AnalysisOutcome } from "../report/contract.ts";
import type { DataSource } from "./datasource.ts";
import {
  allReportsFor,
  canonicalReport,
  riskReportOf,
  type CanonicalRow,
} from "./canonical.ts";
import { allowedArms, armKey, type ProductionProfile, type Role } from "./profile.ts";

export type Tier = "clean" | "low-risk" | "concerning" | "high-risk" | "inconclusive";
export type Severity = "critical" | "high" | "medium" | "low" | "info" | "positive";
export type Level = "none" | "low" | "notable" | "high";

export interface Signal {
  area: string;
  level: Level;
  note?: string;
}

export interface CatalogRow {
  storeId: string;
  /** A labeled corpus sample, not a real extension. The UI MUST badge these:
   *  a synthetic finding read as a real one is the worst outcome this product
   *  has. Always present so a missing badge is a visible bug, not a silent
   *  absence. */
  synthetic: boolean;
  name: string;
  version: string | null;
  tier: Tier | null;
  headline: string;
  signals: Signal[];
  developerName: string | null;
  flags: { isTrader?: boolean; highRiskCountry?: boolean; nonStoreUpdate?: boolean };
  access: string[]; // derived capability facets (see ACCESS_FACETS in catalog.ts)
  findingTypes: string[]; // threat-class facets present (see FINDING_TYPE_FACETS)
  assessedAt: string;
  outcome?: AnalysisOutcome;
  // admin-only:
  pipeline?: { methodology: string; model: string; isFallback: boolean };
  costUsd?: number | null;
  tokens?: { input: number; output: number };
}

export interface Finding {
  id: string;
  number: number | null;
  severity: Severity | "";
  confidence: string | null;
  category: string;
  kind: string;
  title: string;
  detail: string;
  claimedMechanism: string | null;
  evidence: { file: string; line: number | null; symbolOrSink: string | null }[];
}

export interface ExtensionDetail {
  skillReview?: {
    harness: string;
    model: string;
    sessionId: string | null;
    skillVersion: string;
    sourceSha256: string;
    reviewSha256: string;
    investigation: string;
    candidates: Finding[];
    coverage: { dimension: string; status: string; note: string; checksRun: string[] }[];
  };
  identity: {
    storeId: string;
    name: string;
    version: string | null;
    manifestVersion: number | null;
    /** See CatalogRow.synthetic — a corpus sample, not a real extension. */
    synthetic: boolean;
    /** Corpus sample directory, so the page can point at its answer key. */
    sample: string | null;
  };
  verdict: { tier: Tier | null; headline: string; rationale: string; signals: Signal[] };
  provenance: {
    reportId: number;
    assessedAt: string;
    engineVersion: string | null;
    pipeline?: { methodology: string; model: string; think: string | null; mode: string | null; gitSha: string | null; isFallback: boolean };
  };
  partialAnalysis: boolean;
  outcome?: AnalysisOutcome;
  unparsedFiles: string[];
  summaries: { layperson: string; technical: string };
  descriptionDeviation: { statedPurpose: string; deviates: boolean | null } | null;
  findings: Finding[];
  permissions: {
    api: {
      permission: string;
      optional: boolean;
      status: string;
      totalUsage: number;
      description?: string;
      usagePlain?: string;
      docUrl?: string;
      installWarning?: string;
    }[];
    hostsRequired: string[];
    hostsOptional: string[];
    hostsPlain?: string;
    dangerousCombinations: { kind: string; evidence: string[] }[];
  };
  destinations: {
    rows: {
      host: string;
      references: number;
      anyDynamic: boolean;
      reachedVia: string[];
      party?: string;
      exampleSites?: { path: string; line: number | null; role: string | null }[];
    }[];
    unresolvedCount: number;
  };
  obfuscation: { flagged: { path: string }[] };
  developer: {
    name: string | null;
    website: string | null;
    country: string | null;
    isTrader: boolean | null;
    highRiskCountry: boolean | null;
    nonStoreUpdate: boolean | null;
  };
  excludedClaims: { id: string; title: string; reason: string; detail: string }[];
  dismissals: { concern: string; note: string | null; checksRun: string[] }[];
  structuralLimits: string[];
  // admin-only:
  cost?: { usd: number | null; inputTokens: number | null; outputTokens: number | null };
  otherAnalyses?: { reportId: number; methodology: string; model: string; tier: Tier | null; assessedAt: string; isCanonical: boolean }[];
}

// ---- defensive readers -------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function strArr(v: unknown): string[] {
  return arr(v).filter((x): x is string => typeof x === "string");
}

/** First sentence of the rationale — the ten-second decision line. */
export function headlineOf(rationale: string | null): string {
  const r = (rationale ?? "").trim();
  if (!r) return "";
  const m = r.match(/^.*?[.!?](?=\s|$)/);
  return m ? m[0] : r;
}

const SEVERITY_ORDER: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3, info: 4, positive: 5,
};

// ---- derived pieces ----------------------------------------------------------

function signalsOf(rr: Record<string, unknown> | null): Signal[] {
  const verdict = isObj(rr?.verdict) ? rr.verdict : null;
  return arr(verdict?.per_area)
    .filter(isObj)
    .map((a) => ({ area: str(a.area), level: (str(a.level) || "none") as Level, note: strOrNull(a.note) ?? undefined }));
}

const ALL_SITES_PATTERNS = new Set(["<all_urls>", "*://*/*", "http://*/*", "https://*/*"]);

// Any of these declared permissions means the extension can observe, block, or
// redirect the user's network traffic — one "intercepts-network" facet.
const NETWORK_INTERCEPT_PERMS = new Set([
  "webRequest",
  "webRequestBlocking",
  "declarativeNetRequest",
  "declarativeNetRequestWithHostAccess",
  "proxy",
]);

/** Capability facets a reviewer filters on, computed from the canonical report.
 *  Order mirrors ACCESS_FACETS (catalog.ts) so the dropdown reads consistently. */
export function accessFacetsOf(rr: Record<string, unknown> | null): string[] {
  if (!rr) return [];
  const out: string[] = [];
  const perms = isObj(rr.permissions) ? rr.permissions : null;
  const apiNames = new Set(arr(perms?.api).filter(isObj).map((p) => str(p.permission)));
  if (apiNames.has("cookies")) out.push("cookies");
  const hosts = isObj(perms?.hosts) ? perms.hosts : null;
  if (strArr(hosts?.required).some((h) => ALL_SITES_PATTERNS.has(h))) out.push("all-sites");
  if (apiNames.has("scripting")) out.push("injects-code");
  if ([...NETWORK_INTERCEPT_PERMS].some((p) => apiNames.has(p))) out.push("intercepts-network");
  if (apiNames.has("nativeMessaging")) out.push("native-messaging");
  if (apiNames.has("downloads")) out.push("downloads");
  if (apiNames.has("history")) out.push("reads-history");
  const findings = arr(rr.findings).filter(isObj);
  if (findings.some((f) => str(f.category) === "code-execution")) out.push("remote-code");
  const obf = isObj(rr.obfuscation) ? rr.obfuscation : null;
  if (arr(obf?.flagged).length > 0) out.push("obfuscated");
  return out;
}

// Concern-bearing threat classes a reviewer filters on. Deliberately excludes
// "benign" and "unknown" — filtering "has a cleared/undetermined finding" isn't
// a useful lens (nearly everything would match). Mirrors src/methodologies/findings.ts.
export const FINDING_TYPE_FACETS = ["malicious", "vulnerability", "unwanted", "risky-capability"] as const;

/** Threat-class facets present among a report's asserted findings (from the
 *  finding_type each finding carries), narrowed to the concern-bearing set. */
export function findingTypesOf(rr: Record<string, unknown> | null): string[] {
  if (!rr) return [];
  const present = new Set(arr(rr.findings).filter(isObj).map((f) => str(f.finding_type)));
  return FINDING_TYPE_FACETS.filter((t) => present.has(t));
}

function developerOf(rr: Record<string, unknown> | null) {
  const d = isObj(rr?.developer) ? rr.developer : null;
  return {
    name: strOrNull(d?.name),
    website: strOrNull(d?.website),
    country: strOrNull(d?.country),
    isTrader: boolOrNull(d?.is_trader),
    highRiskCountry: boolOrNull(d?.high_risk_country),
    nonStoreUpdate: boolOrNull(d?.non_store_update_url),
  };
}

function findingsOf(rr: Record<string, unknown> | null): Finding[] {
  const out = arr(rr?.findings)
    .filter(isObj)
    .map((f): Finding => ({
      id: str(f.id),
      number: numOrNull(f.number),
      severity: str(f.severity) as Finding["severity"],
      confidence: strOrNull(f.confidence),
      category: str(f.category),
      kind: str(f.kind),
      title: str(f.title),
      detail: str(f.detail),
      claimedMechanism: strOrNull(f.claimed_mechanism),
      evidence: arr(f.evidence_refs)
        .filter(isObj)
        .map((e) => ({
          file: str(e.file),
          line: isObj(e.location) ? numOrNull(e.location.line) : null,
          symbolOrSink: strOrNull(e.symbol) ?? strOrNull(e.sink_or_string),
        })),
    }));
  // Critical first; unknown/empty severities sink to the bottom, stable by number.
  return out.sort(
    (a, b) =>
      (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
      (a.number ?? 0) - (b.number ?? 0),
  );
}

// ---- catalog -----------------------------------------------------------------

/** The role-independent (User-view) catalog columns for one canonical row.
 *  Pure — the caller supplies the parsed report — so searchCatalog can cache
 *  the result per reportId (report rows and blobs are immutable) instead of
 *  re-fetching and re-parsing every blob on every request. */
export function catalogRowBase(row: CanonicalRow, rr: Record<string, unknown> | null): CatalogRow {
  const dev = developerOf(rr);
  const flags: CatalogRow["flags"] = {};
  if (dev.isTrader != null) flags.isTrader = dev.isTrader;
  if (dev.highRiskCountry != null) flags.highRiskCountry = dev.highRiskCountry;
  if (dev.nonStoreUpdate != null) flags.nonStoreUpdate = dev.nonStoreUpdate;
  return {
    storeId: row.storeId,
    synthetic: row.synthetic,
    name: row.name ?? row.sample ?? row.storeId,
    version: row.version,
    tier: (row.tier as Tier | null) ?? null,
    headline: isObj(rr?.outcome) && rr.outcome.investigation === "incomplete" ? "Incomplete investigation — provisional assessment" : headlineOf(row.rationale),
    ...(isObj(rr?.outcome) ? { outcome: rr.outcome as unknown as AnalysisOutcome } : {}),
    signals: signalsOf(rr),
    developerName: dev.name,
    flags,
    access: accessFacetsOf(rr),
    findingTypes: findingTypesOf(rr),
    assessedAt: row.assessedAt,
  };
}

/** Admin-only catalog columns, appended per request — never into the cached
 *  base, so a base built for an Admin can never leak into a User response. */
export function withAdminCatalogColumns(base: CatalogRow, row: CanonicalRow): CatalogRow {
  return {
    ...base,
    pipeline: { methodology: row.methodology, model: row.model, isFallback: row.prefRank > 0 },
    costUsd: row.estimatedUsd,
    tokens: { input: row.inputTokens ?? 0, output: row.outputTokens ?? 0 },
  };
}

// ---- detail ------------------------------------------------------------------

/** Build the full decision-console DTO for one report row under `role`.
 *  `canonicalId` (when known) marks which report is the role's canonical pick,
 *  so the admin other-analyses index can label it. */
export async function buildExtensionDetail(
  ds: DataSource,
  row: CanonicalRow,
  role: Role,
  profile: ProductionProfile,
): Promise<ExtensionDetail | null> {
  const rr = await riskReportOf(ds, row.reportId);
  if (!rr) return null;

  const verdict = isObj(rr.verdict) ? rr.verdict : null;
  const summaries = isObj(rr.summaries) ? rr.summaries : null;
  const coverage = isObj(rr.coverage) ? rr.coverage : null;
  const devDev = isObj(rr.description_deviation) ? rr.description_deviation : null;
  const perms = isObj(rr.permissions) ? rr.permissions : null;
  const hosts = isObj(perms?.hosts) ? perms.hosts : null;
  const dests = isObj(rr.destinations) ? rr.destinations : null;
  const obf = isObj(rr.obfuscation) ? rr.obfuscation : null;
  const unparsed = strArr(coverage?.unparsed_files);
  const rationale = str(verdict?.rationale, row.rationale ?? "");

  const detail: ExtensionDetail = {
    identity: {
      storeId: row.storeId,
      name: row.name ?? row.sample ?? row.storeId,
      version: row.version,
      manifestVersion: row.manifestVersion,
      synthetic: row.synthetic,
      sample: row.sample,
    },
    verdict: {
      tier: (row.tier as Tier | null) ?? null,
      headline: headlineOf(rationale),
      rationale,
      signals: signalsOf(rr),
    },
    provenance: {
      reportId: row.reportId,
      assessedAt: row.assessedAt,
      engineVersion: row.analyzerVersion,
    },
    partialAnalysis: unparsed.length > 0 || (isObj(rr.outcome) && rr.outcome.investigation === "incomplete"),
    ...(isObj(rr.outcome) ? { outcome: rr.outcome as unknown as AnalysisOutcome } : {}),
    unparsedFiles: unparsed,
    summaries: {
      layperson: str(summaries?.layperson),
      technical: str(summaries?.technical),
    },
    descriptionDeviation: devDev
      ? { statedPurpose: str(devDev.stated_purpose), deviates: boolOrNull(devDev.deviates) }
      : null,
    findings: findingsOf(rr),
    permissions: {
      api: arr(perms?.api)
        .filter(isObj)
        .map((p) => {
          const out: ExtensionDetail["permissions"]["api"][number] = {
            permission: str(p.permission),
            optional: p.optional === true,
            status: str(p.status),
            totalUsage: numOrNull(p.total_usage) ?? 0,
          };
          // Enrichment fields exist only on some arms — omit, don't null.
          const description = strOrNull(p.description);
          if (description) out.description = description;
          const usagePlain = strOrNull(p.usage_plain);
          if (usagePlain) out.usagePlain = usagePlain;
          const docUrl = strOrNull(p.doc_url);
          if (docUrl) out.docUrl = docUrl;
          const installWarning = strOrNull(p.install_warning);
          if (installWarning) out.installWarning = installWarning;
          return out;
        }),
      hostsRequired: strArr(hosts?.required),
      hostsOptional: strArr(hosts?.optional),
      ...(strOrNull(perms?.hosts_plain) ? { hostsPlain: str(perms?.hosts_plain) } : {}),
      dangerousCombinations: arr(perms?.dangerous_combinations)
        .filter(isObj)
        .map((c) => ({ kind: str(c.kind), evidence: strArr(c.evidence) })),
    },
    destinations: {
      rows: arr(dests?.rows)
        .filter(isObj)
        .map((d) => {
          const out: ExtensionDetail["destinations"]["rows"][number] = {
            host: str(d.host),
            references: numOrNull(d.references) ?? 0,
            anyDynamic: d.any_dynamic === true,
            reachedVia: strArr(d.reached_via),
          };
          const party = strOrNull(d.party);
          if (party) out.party = party;
          const sites = arr(d.example_sites).filter(isObj);
          if (sites.length > 0) {
            out.exampleSites = sites.map((s) => ({
              path: str(s.path),
              line: numOrNull(s.line),
              role: strOrNull(s.role),
            }));
          }
          return out;
        }),
      unresolvedCount: arr(dests?.unresolved).length,
    },
    obfuscation: {
      flagged: arr(obf?.flagged)
        .filter(isObj)
        .map((f) => ({ path: str(f.path) })),
    },
    developer: developerOf(rr),
    excludedClaims: arr(rr.excluded_claims)
      .filter(isObj)
      .map((c) => ({ id: str(c.id), title: str(c.title), reason: str(c.reason), detail: str(c.detail) })),
    dismissals: arr(rr.dismissals)
      .filter(isObj)
      .map((d) => ({ concern: str(d.concern), note: strOrNull(d.note), checksRun: strArr(d.checks_run) })),
    structuralLimits: [...strArr(coverage?.structural_limits), ...(isObj(rr.outcome) && rr.outcome.investigation === "incomplete" ? ["Investigation incomplete: provisional assessment; full coverage is not established."] : [])],
  };

  if (role === "admin") {
    const imported = isObj(rr.skill_review) ? rr.skill_review : null;
    const provenance = imported && isObj(imported.provenance) ? imported.provenance : null;
    const review = imported && isObj(imported.review) ? imported.review : null;
    if (provenance && review) {
      detail.skillReview = {
        harness: str(provenance.harness), model: str(provenance.model), sessionId: strOrNull(provenance.session_id),
        skillVersion: str(provenance.skill_version), sourceSha256: str(provenance.source_sha256),
        reviewSha256: str(provenance.review_sha256), investigation: str(review.investigation),
        candidates: findingsOf({ findings: review.findings }).map((f) => ({ ...f, kind: "candidate" })),
        coverage: arr(review.coverage).filter(isObj).map((c) => ({
          dimension: str(c.dimension), status: str(c.status), note: str(c.note), checksRun: strArr(c.checks_run),
        })),
      };
    }
    detail.provenance.pipeline = {
      methodology: row.methodology,
      model: row.model,
      think: row.think,
      mode: row.mode,
      gitSha: row.gitSha,
      isFallback: row.prefRank > 0,
    };
    detail.cost = { usd: row.estimatedUsd, inputTokens: row.inputTokens, outputTokens: row.outputTokens };
    const canonicalId = row.prefRank === -1
      ? (await canonicalReport(ds, role, row.storeId, profile))?.reportId
      : row.reportId;
    detail.otherAnalyses = (row.synthetic ? [] : await allReportsFor(ds, row.storeId)).map((r) => ({
      reportId: r.report_id as number,
      methodology: r.methodology as string,
      model: r.model as string,
      tier: (r.tier as Tier | null) ?? null,
      assessedAt: r.started_at as string,
      isCanonical: (r.report_id as number) === canonicalId,
    }));
  }
  return detail;
}

/** Role authorization for fetching one specific report: an Admin may fetch any
 *  product-visible report; a User only one whose arm is in their allowed list.
 *  Everything else reads as "not found" — existence itself is not leaked. */
export function reportVisibleTo(row: { methodology: string; model: string }, role: Role, profile: ProductionProfile): boolean {
  if (role === "admin") return true;
  const allowed = new Set(allowedArms(profile, "user").map(armKey));
  return allowed.has(armKey({ methodology: row.methodology, model: row.model }));
}

/** Convenience wrapper: the canonical detail for a store id under `role`. */
export async function extensionDetailFor(
  ds: DataSource,
  role: Role,
  storeId: string,
  profile: ProductionProfile,
): Promise<ExtensionDetail | null> {
  const row = await canonicalReport(ds, role, storeId, profile);
  if (!row) return null;
  return buildExtensionDetail(ds, row, role, profile);
}
