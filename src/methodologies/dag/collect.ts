// The collector — where the DAG front-end rejoins the shared backend. It gathers
// every node's findings/verdicts/dismissals, dedups across nodes, then hands the
// assembled finding set to the SAME pipeline the monolith uses: classifyFindings
// → computeVerdict → synthesize → assembleRiskReport → renderReportMarkdown. The
// tier is owned by the deterministic verdict engine, never by an LLM, so all arms
// stay scorecard-comparable (docs/dag-methodology.md, decision 1).
//
// Dedup is verdict-aware: a CONFIRMED inferred-behavior subsumes bare
// observed-capabilities at the same source site (the verified mechanism is the
// stronger statement). A non-confirmed inferred claim subsumes nothing — it will
// be excluded by classifyFindings, so the capability at that site must survive.

import { isHighRiskCountry } from "../../listing/country.ts";
import type { LlmClient, Usage } from "../../llm/client.ts";
import { statedPurposeOf, assembleRiskReport } from "../../report/assemble.ts";
import { buildCoverage, buildDestinations, buildDeveloper, buildObfuscation, buildPermissions } from "../../report/build.ts";
import { auditIocConsistency, classifyFindings } from "../../report/classify.ts";
import type { RiskReport } from "../../report/contract.ts";
import { computeVerdict } from "../../report/verdict.ts";
import { adjustFindingHarm } from "../../report/harm-adjust.ts";
import { renderReportMarkdown } from "../../report/render-md.ts";
import type { VerificationResult, VerifierVerdict } from "../claim-verifier.ts";
import { resolveEvidenceRefs, SEVERITY_ORDER, type Finding, type FindingsReport, type RefResolution } from "../findings.ts";
import { synthesize, type Synthesis } from "../synthesize.ts";
import type { MethodologyOutput, MethodologySample } from "../types.ts";
import { addUsage, ZERO_USAGE, type DagNode, type Dismissal, type NodeOutputs, type NodeStatus } from "./node.ts";

export interface DagNodeTrace {
  id: string;
  version: string;
  status: NodeStatus;
  reason?: string;
  findings: number;
  dismissals: number;
  usage: Usage;
}

export interface DagTrace {
  nodes: DagNodeTrace[];
  /** The deduped finding set fed to classification. */
  findings: Finding[];
  verdicts: VerifierVerdict[];
  dismissals: Dismissal[];
  synthesis: Synthesis;
  risk_report: RiskReport;
}

/** Source site of a finding = its first evidence ref carrying a concrete line. */
function siteKey(f: Finding): string | null {
  const ref = f.evidence_refs.find((r) => r.location?.line != null);
  return ref ? `${ref.file}:${ref.location!.line}` : null;
}

function strongest(findings: Finding[]): Finding {
  return findings.reduce((best, f) => (SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[best.severity] ? f : best));
}

/**
 * Dedup across nodes. Findings with no concrete site are kept as-is. Within a
 * site, a CONFIRMED inferred-behavior subsumes the observed-capabilities there
 * (drop them); otherwise everything at the site is kept and classification sorts
 * out which inferred claims survive.
 */
export function dedupeFindings(findings: Finding[], verdicts: Map<string, VerifierVerdict>): Finding[] {
  const groups = new Map<string, Finding[]>();
  const loners: Finding[] = [];
  for (const f of findings) {
    const k = siteKey(f);
    if (k === null) {
      loners.push(f);
      continue;
    }
    const g = groups.get(k);
    if (g) g.push(f);
    else groups.set(k, [f]);
  }

  const kept: Finding[] = [];
  for (const group of groups.values()) {
    // A confirmed inferred-behavior subsumes co-sited capabilities ONLY when it
    // will actually be ASSERTED. A confirmed claim the verifier then harm-cleared
    // (harm_supported === false) is routed to dismissals by classifyFindings, not
    // asserted — so letting it subsume would erase a floor-eligible capability at
    // the same site into nothing (neither finding nor dismissal), silently
    // dropping the tier signal (018 follow-up: the minified remote-loader class).
    const confirmedBehavior = group.some((f) => {
      const v = verdicts.get(f.id);
      return f.claim_type === "inferred-behavior" && v?.verdict === "confirmed" && v.harm_supported !== false;
    });
    if (confirmedBehavior) {
      // Keep inferred-behavior findings (the confirmed one is asserted; any
      // refuted siblings are excluded downstream); drop subsumed capabilities.
      kept.push(...group.filter((f) => f.claim_type === "inferred-behavior"));
    } else {
      kept.push(...group);
    }
  }
  return [...kept, ...loners];
}

export async function collectAndAssemble(
  nodes: DagNode[],
  outputs: NodeOutputs,
  sample: MethodologySample,
  model: string,
  client: LlmClient,
): Promise<MethodologyOutput> {
  const pack = sample.pack!;
  const versionById = new Map(nodes.map((n) => [n.id, n.version]));

  // 1. Gather across all nodes.
  const allFindings: Finding[] = [];
  const allVerdicts: VerifierVerdict[] = [];
  const dismissals: Dismissal[] = [];
  let nodeUsage = ZERO_USAGE;
  const nodeTraces: DagNodeTrace[] = [];
  for (const [id, r] of outputs) {
    allFindings.push(...r.findings);
    allVerdicts.push(...r.verdicts);
    dismissals.push(...r.dismissals);
    nodeUsage = addUsage(nodeUsage, r.usage);
    nodeTraces.push({
      id,
      version: versionById.get(id) ?? "?",
      status: r.status,
      reason: r.reason,
      findings: r.findings.length,
      dismissals: r.dismissals.length,
      usage: r.usage,
    });
  }

  // Merge verdicts with REFUTATION PRECEDENCE: a single claim can receive more
  // than one verdict — the producing node confirms it, and the finding-challenger
  // (an independent adversarial pass) may then refute it. Only an explicit
  // "refuted" vetoes a confirmation; the finding is then excluded. A challenger
  // "inconclusive"/"needs-dynamic" does NOT veto — it means the skeptic could not
  // refute, so a finding that survives the challenge is upheld (the whole point).
  // This is node-agnostic (any skeptic can veto any producer). Same claim, same
  // verdict ⇒ no-op.
  const verdictById = new Map<string, VerifierVerdict>();
  for (const v of allVerdicts) {
    const prev = verdictById.get(v.claim_id);
    if (!prev) verdictById.set(v.claim_id, v);
    else if (prev.verdict === "confirmed" && v.verdict === "refuted") verdictById.set(v.claim_id, v);
  }

  // 2. Dedup across nodes (verdict-aware).
  const deduped = dedupeFindings(allFindings, verdictById);

  // 3. Assemble the inputs classifyFindings already consumes, then classify
  //    VERBATIM — the verified-behavior vs observed-capability split comes out
  //    identical to the monolith.
  const report: FindingsReport = { summary: "", overall_risk: "", findings: deduped };
  const resolutions = new Map<string, RefResolution>();
  for (const f of deduped) resolutions.set(f.id, resolveEvidenceRefs(f, sample.sampleDir));
  const verdicts = new Map<string, VerifierVerdict>();
  for (const f of deduped) {
    const v = verdictById.get(f.id);
    if (v) verdicts.set(f.id, v);
  }
  const verification: VerificationResult = { resolutions, verdicts, usage: ZERO_USAGE };
  const classified = classifyFindings(report, verification, sample.sampleDir);
  // Nodes'/shards' checked-and-cleared concerns + the classifier's harm-cleared
  // findings (confirmed mechanism, claimed harm unsupported) share one channel.
  // Sort by concern (byte order): node dismissals arrive in scheduler completion
  // order (nondeterministic across concurrent levels), and this list now feeds
  // the fixture-keyed synthesize prompt — an unstable order would churn its key.
  const allDismissals = [...dismissals, ...classified.dismissals].sort((a, b) =>
    a.concern < b.concern ? -1 : a.concern > b.concern ? 1 : 0,
  );

  // 4. Shared backend tail (mirrors monolith.run from classify onward).
  const listing = sample.listing ?? null;
  const enrichment = sample.enrichment ?? null;
  const statedPurpose = statedPurposeOf(pack, listing);
  const highRiskCountry = isHighRiskCountry(listing?.country ?? null);
  const sections = {
    permissions: buildPermissions(pack),
    destinations: buildDestinations(pack, enrichment),
    obfuscation: buildObfuscation(pack),
    developer: buildDeveloper(pack.developer, listing, highRiskCountry),
    coverage: buildCoverage(pack),
  };
  // Deterministic harm-level correction (shared with monolith): cap severity on
  // concern findings the pack proves cannot hold the claimed harm, before the
  // tier rolls up. Reassign so verdict, synthesis, and report agree.
  classified.findings = adjustFindingHarm(classified.findings, pack).findings;

  // IOC-consistency tripwire (improvement 020, Fix D): warn when an asserted
  // finding names a host grounded neither in the resolved destinations nor in its
  // own evidence — the hallucinated/mis-decoded-IOC fingerprint. Warn-only; the
  // resolved-host baseline comes from the same destinations section the report uses.
  const resolvedHosts = new Set(sections.destinations.rows.map((r) => r.host));
  for (const w of auditIocConsistency(classified.findings, resolvedHosts)) {
    console.warn(`[ioc-audit] ${w}`);
  }

  const verdict = computeVerdict(classified.findings, sections);

  await sample.onProgress?.("synthesis", "started", "Synthesizing the decided verdict into the report");
  const synthesisRun = await synthesize(
    {
      verdict,
      findings: classified.findings,
      excluded: classified.excluded,
      dismissals: allDismissals,
      permissions: sections.permissions,
      destinations: sections.destinations,
      obfuscation: sections.obfuscation,
      developer: sections.developer,
      statedPurpose,
    },
    { client, model },
  );

  await sample.onProgress?.("synthesis", "finished", "Report synthesis finished");
  const riskReport = assembleRiskReport({
    pack,
    methodology: "dag",
    model,
    classified,
    verdict,
    synthesis: synthesisRun.synthesis,
    statedPurpose,
    listing,
    highRiskCountry,
    enrichment,
    // Surface the nodes'/shards' checked-and-cleared concerns in the report
    // itself, not just the trace, so a thorough benign run does not read as empty.
    dismissals: allDismissals,
  });

  const trace: DagTrace = {
    nodes: nodeTraces,
    findings: deduped,
    verdicts: allVerdicts,
    dismissals: allDismissals,
    synthesis: synthesisRun.synthesis,
    risk_report: riskReport,
  };

  return {
    report: renderReportMarkdown(riskReport),
    tier: verdict.tier,
    usage: addUsage(nodeUsage, synthesisRun.usage),
    structured: trace,
  };
}
