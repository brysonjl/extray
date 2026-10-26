// The Pi methodology — a secondary agentic arm that uses the open-source Pi
// coding agent as its investigator (runner.ts), then rejoins the SAME
// deterministic backend the other arms use. Pi generates findings by exploring
// real source read-only; this file coerces them into the Finding contract, runs
// the shared adversarial claim-verifier (via the injected LlmClient, so the
// verifier is identical across arms), and hands the result to collectAndAssemble
// — the verdict tier stays owned by report/verdict.ts and scorecard-comparable.
// See docs/pi-methodology-exploration-2026-06-23.md.

import { summarizeSourceCoverage } from "./file-tools.ts";
import type { AnalysisOutcome } from "../../report/contract.ts";
import type { LlmClient, Usage } from "../../llm/client.ts";
import { buildPrompt } from "../../llm/envelope.ts";
import { statedPurposeOf } from "../../report/assemble.ts";
import { buildDestinations, buildObfuscation, buildPermissions } from "../../report/build.ts";
import { renderReportMarkdown } from "../../report/render-md.ts";
import { recordsByHost } from "../../enrichment/types.ts";
import { projectHostEnrichment } from "../../enrichment/project.ts";
import type { EvidencePack, Location } from "../../pipeline/schema.ts";
import type { Tier } from "../../report/contract.ts";
import { reachabilityContextFromPack, verifyFindings } from "../claim-verifier.ts";
import { collectAndAssemble, type DagTrace } from "../dag/collect.ts";
import { addUsage, okResult, ZERO_USAGE, type DagNode, type Dismissal, type NodeOutputs } from "../dag/node.ts";
import {
  CATEGORIES,
  CLAIM_TYPES,
  CONFIDENCES,
  FINDING_TYPES,
  SEVERITIES,
  type Category,
  type ClaimType,
  type Confidence,
  type EvidenceRef,
  type Finding,
  type FindingType,
  type Severity,
} from "../findings.ts";
import type { ExtraUsageLine, Methodology, MethodologyOutput, MethodologySample } from "../types.ts";
import {
  coverageGaps,
  DIMENSIONS,
  runPiAgent,
  runPiShards,
  type Dimension,
  type PiPassUsage,
  type RawFinding,
  type ReviewSubmission,
} from "./runner.ts";

// Higher than the old default because the coverage floor (5 dimensions) and the
// completeness critic can legitimately need several extra investigation turns.
const DEFAULT_MAX_TURNS = 50;
// Shards are short by design (each owns one dimension over few files), so their
// per-session turn ceiling is much lower than the monolith's.
const DEFAULT_SHARD_TURNS = 20;

export interface PiOptions {
  /** Hard ceiling on Pi agent turns. Default 50 (monolith) / 20 per shard. */
  maxTurns?: number;
  /** Model for the claim-verifier post-pass (via the injected client). Defaults to the arm's own model. */
  verifierModel?: string;
  /** Provider preset id or alias (ollama | openai | nvidia | openai-compatible); resolved
   *  by src/llm/provider.ts, the same seam the LlmClient arms use. */
  provider?: string;
  /** OpenAI-compatible base URL for Pi's model, overriding the preset's. */
  baseUrl?: string;
  /** API key for Pi's model, overriding the preset's env var. */
  apiKey?: string;
  /** Fan investigation out across one Pi sub-session per dimension + a synthesis
   *  pass, instead of one monolithic session. Implied when subagentModels or
   *  synthesisModel is set. Default false → unchanged monolithic behavior. */
  shard?: boolean;
  /** General model for ALL dimension shards (not the synthesis pass), so the whole
   *  fleet can be tiered down while the verifier/synthesis stay on the primary
   *  model. Per-dimension overrides beat it; it beats the primary fallback. Setting
   *  it enables sharding. */
  subagentModel?: string;
  /** Per-dimension model override; unspecified dimensions fall back to the general
   *  subagent model, then the primary model — so default fan-out never regresses
   *  recall. Setting any value enables sharding. */
  subagentModels?: Partial<Record<Dimension, string>>;
  /** Model for the cross-cutting synthesis pass. Defaults to the primary model. */
  synthesisModel?: string;
  /** Per-shard turn ceiling. Default 20. */
  subagentMaxTurns?: number;
  /** Run the Pi investigator WITHOUT the static evidence pack — no orientation
   *  map in the prompt and no read_pack tool, so it explores the unpacked
   *  extension cold (read/grep/find/ls only). Default false (pack on). The
   *  pack-on/pack-off A/B lever from improvement 016 (fix 4). The deterministic
   *  backend (sections, verdict) still consumes the pack — only the investigator's
   *  inputs change — so runs stay scorecard-comparable. */
  noPack?: boolean;
}

/** Is sharded fan-out requested? (Explicit --shard, or any tiered-model config.) */
export function isSharded(opts: PiOptions): boolean {
  return (
    opts.shard === true ||
    opts.subagentModel !== undefined ||
    opts.subagentModels !== undefined ||
    opts.synthesisModel !== undefined
  );
}

/** Resolve the effective per-dimension + synthesis model map. Each shard resolves
 *  per-dimension override → general subagent model → primary model; the synthesis
 *  pass resolves its own override → primary model (the general subagent model does
 *  NOT cheapen synthesis). Used both to drive the shards and to record the truthful
 *  subagent_models map in the bake-off DB. */
export function effectiveSubagentModels(primaryModel: string, opts: PiOptions): Record<Dimension | "synthesis", string> {
  const map = {} as Record<Dimension | "synthesis", string>;
  for (const dim of DIMENSIONS) map[dim] = opts.subagentModels?.[dim] ?? opts.subagentModel ?? primaryModel;
  map.synthesis = opts.synthesisModel ?? primaryModel;
  return map;
}

// The two dimensions runner.ts itself documents as needing a "capable" model —
// the OWA covert-remote-load pattern is both. Sharding without per-dimension
// overrides silently runs EVERY dimension (these included) on the general
// subagent model, defeating that documented intent (improvement 016, fix 3).
const CAPABLE_FLOOR_DIMENSIONS: Dimension[] = ["exfiltration", "code-execution"];

/**
 * Warn when a high-signal dimension is being silently downtiered: it resolves to
 * a NON-primary model purely via the general `subagentModel` fallback, with no
 * explicit `subagentModels[dim]` decision. Fires exactly the traced-run case
 * (every shard on one cheap model, no per-dimension overrides); silent when the
 * dimension is on the primary model or was explicitly assigned. Returns the
 * human-readable warning lines (empty when nothing is downtiered). */
export function capableFloorWarnings(primaryModel: string, opts: PiOptions): string[] {
  const warnings: string[] = [];
  for (const dim of CAPABLE_FLOOR_DIMENSIONS) {
    const explicit = opts.subagentModels?.[dim];
    if (explicit !== undefined) continue; // an explicit decision was made — trust it
    const resolved = opts.subagentModel ?? primaryModel;
    if (resolved === primaryModel) continue; // not downtiered
    warnings.push(
      `pi: high-signal dimension "${dim}" is running on "${resolved}" via the general ` +
        `subagent-model fallback, not an explicit decision — runner.ts documents this ` +
        `dimension as needing a capable model. Pass subagentModels["${dim}"] to assign it deliberately.`,
    );
  }
  return warnings;
}

/**
 * The incompleteness marker (018 follow-up): non-empty coverage gaps WITHHOLD a
 * confident benign tier — clean/low-risk becomes inconclusive with a rationale
 * naming the uncovered dimensions. "We never looked" must not read as "we looked
 * and found nothing" (the tier is withheld, not cleared). Recall-safe by the
 * house rule: concerning/high-risk/inconclusive are NEVER touched (a confirmed
 * finding stands regardless of missing coverage) → null, no change.
 */
export function adjustTierForGaps(tier: Tier, gaps: string[]): { tier: Tier; note: string } | null {
  if (gaps.length === 0 || (tier !== "clean" && tier !== "low-risk")) return null;
  return {
    tier: "inconclusive",
    note:
      `Verdict withheld (would be "${tier}"): the investigation never covered ${gaps.join(", ")} — ` +
      `the responsible session(s) aborted or stopped without submitting, and no other pass accounted ` +
      `for the gap. These dimensions are uncovered, not cleared.`,
  };
}

/** Map a Pi-generation pass's usage onto the extra-usage-line shape the CLI merges
 *  into per-step accounting (these tokens bypass the injected client). */
function passToUsageLine(p: PiPassUsage): ExtraUsageLine {
  return { label: p.label, model: p.model, inputTokens: p.inputTokens, outputTokens: p.outputTokens };
}

// Per-section caps so a huge extension cannot blow the context window; the agent
// uses read_pack to fetch anything beyond these. Bounded, not lossy: counts are
// always reported so the agent knows when there is more to pull.
const SINK_FILES_CAP = 60;
const SINKS_PER_FILE_CAP = 25;
const LIST_CAP = 40;
const FLOWS_CAP = 60;

/** Hosts a CSP permits to load EXECUTABLE code into privileged extension pages —
 *  the discriminating fact for the "covert remote-code load" pattern. Parses the
 *  script-src directive (falling back to default-src), keeping http(s) origins. */
function remoteScriptSources(csp: string | null): string[] {
  if (!csp) return [];
  const byName: Record<string, string[]> = {};
  for (const d of csp.split(";").map((s) => s.trim()).filter(Boolean)) {
    const [name, ...vals] = d.split(/\s+/);
    if (name) byName[name.toLowerCase()] = vals;
  }
  const src = byName["script-src"] ?? byName["script-src-elem"] ?? byName["default-src"] ?? [];
  return [...new Set(src.filter((v) => /^https?:\/\//i.test(v)).map((v) => v.replace(/^https?:\/\//i, "").replace(/\/.*$/, "")))];
}

/** Identity-stripped orientation map: the pack's high-value facts up front
 *  (sinks, data-flows, listeners, blind spots, signals), the rest via read_pack. */
function buildOrientation(sample: MethodologySample): string {
  const pack = sample.pack!;
  const listing = sample.listing ?? null;
  const stated = statedPurposeOf(pack, listing);
  const perms = buildPermissions(pack);
  const dests = buildDestinations(pack, sample.enrichment);
  const obf = buildObfuscation(pack);
  // RDAP context (015) for the agent's starting map — same compact projection
  // the monolith/DAG arms read; omitted per host when no record covers it.
  const enrichmentByHost = recordsByHost(sample.enrichment);
  const ledger = pack.external_call_ledger;

  const sinks_by_file = pack.scripts
    .filter((s) => s.sinks.length > 0)
    .slice(0, SINK_FILES_CAP)
    .map((s) => ({
      file: s.path,
      sinks: s.sinks.slice(0, SINKS_PER_FILE_CAP).map((k) => ({ api: k.api, category: k.category, line: k.location?.line ?? null })),
      ...(s.sinks.length > SINKS_PER_FILE_CAP ? { sinks_truncated: s.sinks.length - SINKS_PER_FILE_CAP } : {}),
    }));

  const message_listeners = pack.scripts
    .flatMap((s) => s.listeners.map((l) => ({ file: s.path, kind: l.kind, line: l.location?.line ?? null, validates_sender: l.validates_sender })))
    .slice(0, LIST_CAP);

  const data_flows = (pack.cross_file.data_flows ?? [])
    .slice(0, FLOWS_CAP)
    .map((df) => ({ source: df.source_kind, file: df.file, sink_api: df.sink_api, line: df.sink_location?.line ?? null, dest_host: df.dest_host, dest_party: df.dest_party }));

  return JSON.stringify(
    {
      stated_purpose: stated ? stated.text.slice(0, 1500) : null,
      permissions: { api: perms.api.map((p) => p.permission), hosts: perms.hosts },
      dangerous_combinations: pack.manifest_analysis.dangerous_combinations,
      externally_connectable: pack.manifest_analysis.externally_connectable,
      // Privileged context + hosts the CSP lets load remote executable code into
      // it — check each against the disclosed text (an undisclosed one is the
      // covert-remote-code-load malware pattern; see CLASSIFYING REMOTE CODE).
      background: pack.manifest_analysis.background,
      remote_script_sources: remoteScriptSources(pack.manifest_analysis.csp.extension_pages),
      csp_weaknesses: pack.manifest_analysis.csp.weaknesses,
      destinations: dests.rows.map((r) => {
        const record = enrichmentByHost.get(r.host);
        return {
          host: r.host,
          party: r.party,
          any_dynamic: r.any_dynamic,
          ...(record ? { enrichment: projectHostEnrichment(record, pack.analyzed_at) } : {}),
        };
      }),
      message_listeners,
      data_flows,
      sinks_by_file,
      // The analyzer's own map of where it went blind — investigate these directly.
      static_analysis_blind_spots: {
        counts: ledger.counts,
        opaque_regions: ledger.opaque_regions.slice(0, LIST_CAP),
        indirect_calls: ledger.indirect_calls.slice(0, LIST_CAP),
        unresolved_destinations: ledger.unresolved_destinations.slice(0, LIST_CAP),
        unparsed_files: ledger.unparsed_files.slice(0, LIST_CAP),
      },
      summary_signals: {
        high: pack.summary_signals.high.slice(0, LIST_CAP),
        medium: pack.summary_signals.medium.slice(0, LIST_CAP),
        low: pack.summary_signals.low.slice(0, LIST_CAP),
      },
      obfuscation_flagged: obf.flagged.map((f) => f.path),
      files: pack.files.map((f) => f.path),
    },
    null,
    1,
  );
}

/** A malformed or unavailable critic cannot establish completeness. */
export function parseReview(text: string): { accept: boolean; gaps: string[] } {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Completeness reviewer returned no JSON verdict");
  const o = JSON.parse(m[0]) as { adequate?: unknown; gaps?: unknown };
  if (typeof o.adequate !== "boolean" || !Array.isArray(o.gaps) ||
      !o.gaps.every((g) => typeof g === "string" && g.trim().length > 0)) {
    throw new Error("Invalid completeness verdict: expected adequate boolean and gaps string array");
  }
  const gaps = o.gaps as string[];
  return { accept: o.adequate && gaps.length === 0, gaps };
}

/**
 * Build the completeness critic (runs on the injected client). It re-opens the
 * Pi loop when a file carrying a static sink, or a static-analysis blind spot,
 * was never read and isn't already explained by a finding/dismissal. Returns the
 * review fn plus a usage accessor so the critic's tokens are accounted for.
 */
function makeReviewSubmission(
  pack: EvidencePack,
  model: string,
  client: LlmClient,
): { review: ReviewSubmission; usage: () => Usage } {
  let acc: Usage = ZERO_USAGE;
  const filesWithSinks = pack.scripts.filter((s) => s.sinks.length > 0).map((s) => s.path);
  const ledger = pack.external_call_ledger;
  const blindSpotFiles = [
    ...ledger.opaque_regions.map((o) => o.path),
    ...ledger.unresolved_destinations.map((u) => u.path),
    ...ledger.indirect_calls.map((i) => i.path),
    ...ledger.unparsed_files,
  ];

  const review: ReviewSubmission = async ({ findings, dismissals, filesRead, sourceCoverage }) => {
    const data = JSON.stringify(
      {
        total_files: pack.files.length,
        files_with_static_sinks: filesWithSinks,
        static_analysis_blind_spot_files: [...new Set(blindSpotFiles)],
        files_accessed: filesRead,
        source_access_coverage: summarizeSourceCoverage(sourceCoverage),
        finding_evidence: findings.map((f) => ({ title: f.title, evidence_refs: f.evidence_refs })),
        dismissals,
      },
      null,
      1,
    );
    const instructions = `You are a COMPLETENESS reviewer for a Chrome-extension security analysis. An agent finished investigating and produced the findings/dismissals in the data block. Decide whether the investigation was thorough, or whether high-signal files were never examined where undisclosed behavior could hide.

Flag a gap when a high-signal file (a statically-detected sink or an analysis blind spot: obfuscated / dynamic-exec / unresolved-destination / unparsed) has relevant behavior that remains unexamined and unexplained by the findings or dismissals. files_accessed is an audit of file access ONLY, including grep scans. Membership does not establish whole-file review. source_access_coverage records displayed read ranges, file sizes, search limits/skips/cancellation, and omitted audit events. A small excerpt or a complete pattern search does not establish review of an entire bundle. Missing or truncated coverage is unknown, not complete. Use these ranges and explicit gaps when judging whether relevant source remains unexamined; do not demand every byte of low-signal code. Be conservative — do not invent gaps; a sufficiently-covered investigation returns adequate=true with an empty list.

Respond with ONLY a JSON object: {"adequate": boolean, "gaps": ["specific file or concern not examined", ...]}.`;
    const prompt = buildPrompt(instructions, [{ tag: "review_data", content: data }]);
    const res = await client.complete({ label: "pi:critic", model, prompt, params: { temperature: 0, format: "json" } });
    acc = addUsage(acc, res.usage);
    return parseReview(res.text);
  };

  return { review, usage: () => acc };
}

/** Coerce a model-supplied string onto a closed enum, falling back when off-list. */
function coerce<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function toLocation(line: number | undefined, column?: number): Location | null {
  if (typeof line !== "number" || !Number.isInteger(line) || line < 1) return null;
  // The shared AST Location uses zero-based columns; tool-facing coordinates
  // are one-based, matching read's column argument and displayed continuations.
  return { line, ...(Number.isInteger(column) && column! >= 1 ? { column: column! - 1 } : {}) };
}

function toEvidenceRef(ref: RawFinding["evidence_refs"][number]): EvidenceRef {
  return {
    file: String(ref.file ?? ""),
    location: toLocation(ref.line, ref.column),
    symbol: ref.symbol ?? null,
    sink_or_string: ref.sink_or_string ?? null,
  };
}

/** Convert a raw Pi finding into the shared Finding contract (id-assigned, enum-coerced). */
function toFinding(raw: RawFinding, index: number): Finding {
  const claim_type = coerce<ClaimType>(raw.claim_type, CLAIM_TYPES, "observed-capability");
  return {
    id: `pi:${index + 1}`,
    title: raw.title?.trim() || "(untitled finding)",
    claim_type,
    severity: coerce<Severity>(raw.severity, SEVERITIES, "info"),
    category: coerce<Category>(raw.category, CATEGORIES, "other"),
    confidence: coerce<Confidence>(raw.confidence, CONFIDENCES, "low"),
    finding_type: coerce<FindingType>(raw.finding_type, FINDING_TYPES, "unknown"),
    // Only inferred-behavior carries a mechanism; an observed-capability has no causal story.
    claimed_mechanism: claim_type === "inferred-behavior" ? (raw.claimed_mechanism ?? "").trim() : "",
    evidence_refs: Array.isArray(raw.evidence_refs) ? raw.evidence_refs.map(toEvidenceRef) : [],
    detail: raw.detail ?? "",
  };
}

// Synthetic node so the Pi findings flow through collectAndAssemble unchanged —
// it is never scheduled (mirrors the agentic arm's AGENT_NODE).
const PI_NODE: DagNode = {
  id: "pi-investigation",
  version: "1.0",
  kind: "llm",
  sourceAccess: "targeted-reads",
  upstream: [],
  gate: () => true,
  run: () => {
    throw new Error("PI_NODE is a collector placeholder and is never run by a scheduler");
  },
};

export function createPi(model: string, opts: PiOptions = {}): Methodology {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const verifierModel = opts.verifierModel ?? model;
  return {
    id: "pi",
    model,
    async run(sample: MethodologySample, client: LlmClient): Promise<MethodologyOutput> {
      if (!sample.pack) {
        throw new Error("pi methodology requires sample.pack (used as the agent's starting map and for the backend sections)");
      }

      const orientation = buildOrientation(sample);

      // 1. Pi explores the source read-only and emits raw findings (its own
      //    model). SHARDED: one short sub-session per dimension (parallel) + a
      //    cross-cutting synthesis pass that carries the global completeness view.
      //    MONOLITH: one long session whose coverage floor (in runner) and
      //    completeness critic (here, on the injected client) keep it comprehensive.
      const sharded = isSharded(opts);
      const noPack = opts.noPack ?? false;
      if (noPack) console.warn("pi: pack-off mode — the investigator runs cold (no orientation, no read_pack); the backend still uses the pack.");
      let rawFindings: RawFinding[];
      let rawDismissals: Dismissal[];
      let summary: string;
      let genUsage: Usage; // Pi-pass tokens + (monolith only) the critic's tokens
      let usageByPass: PiPassUsage[];
      let piTrace: unknown;
      // Dimensions the investigation never covered (dead shard / truncated
      // monolith, nothing else accounting for them) — drives the tier override.
      let uncovered: string[];
      let outcome: AnalysisOutcome;

      if (sharded) {
        const models = effectiveSubagentModels(model, opts);
        for (const w of capableFloorWarnings(model, opts)) console.warn(w);
        const shardRun = await runPiShards({
          sampleDir: sample.sampleDir,
          pack: sample.pack,
          orientation,
          maxTurns: opts.subagentMaxTurns ?? DEFAULT_SHARD_TURNS,
          subagentModels: models,
          synthesisModel: models.synthesis,
          provider: opts.provider,
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey,
          noPack,
          onTrace: (line) => console.warn(`pi: ${line}`),
          onProgress: sample.onProgress,
        });
        rawFindings = shardRun.findings;
        rawDismissals = shardRun.dismissals;
        summary = shardRun.summary;
        genUsage = shardRun.usage; // synthesis tokens already included
        usageByPass = shardRun.usageByPass;
        piTrace = { sharded: true, noPack, ...shardRun.trace };
        uncovered = shardRun.uncoveredDimensions;
        const sessions = [...shardRun.trace.shards, shardRun.trace.synthesis];
        const accepted = sessions.every((s) => s.submitted);
        const incomplete = !accepted || sessions.some((s) => s.aborted) || uncovered.length > 0;
        outcome = { artifact_generated: true, investigation: incomplete ? "incomplete" : "complete",
          final_submission: accepted ? "accepted" : "not-accepted",
          reasons: incomplete ? ["One or more pi shard/synthesis sessions aborted, failed to submit, or left coverage gaps."] : [] };
      } else {
        const critic = makeReviewSubmission(sample.pack, model, client);
        await sample.onProgress?.("pi:investigator", "started", "Pi investigator started");
        const piRun = await runPiAgent({
          sampleDir: sample.sampleDir,
          pack: sample.pack,
          model,
          orientation,
          maxTurns,
          reviewSubmission: critic.review,
          provider: opts.provider,
          baseUrl: opts.baseUrl,
          apiKey: opts.apiKey,
          noPack,
          onTrace: (line) => console.warn(`pi: ${line}`),
          onProgress: sample.onProgress,
        });
        await sample.onProgress?.("pi:investigator", "finished", `Pi investigator returned after ${piRun.trace.turns} turns`);
        rawFindings = piRun.findings;
        rawDismissals = piRun.dismissals;
        summary = piRun.summary;
        // The completeness critic runs on the injected client, so its tokens are
        // already in the per-step accounting; fold them into the node usage too so
        // the report aggregate stays whole.
        genUsage = addUsage(piRun.usage, critic.usage());
        usageByPass = piRun.usageByPass;
        piTrace = { sharded: false, noPack, incomplete: piRun.incomplete, ...piRun.trace };
        // A truncated monolith marks only the dimensions its (possibly salvaged)
        // output still leaves unaccounted for; a complete run marks none.
        uncovered = piRun.incomplete ? coverageGaps(rawFindings, rawDismissals) : [];
        const lastReject = piRun.trace.submissionEvents?.filter((e) => e.status !== "accepted" && e.status !== "attempt-limit").at(-1);
        outcome = { artifact_generated: true, investigation: piRun.incomplete ? "incomplete" : "complete",
          final_submission: piRun.trace.submitted ? "accepted" : "not-accepted",
          reasons: piRun.incomplete ? [piRun.trace.stopReason ?? "no-accepted-submission", ...(!piRun.trace.submitted ? lastReject?.reasons ?? [] : [])] : [] };
      }

      const findings = rawFindings.map(toFinding);

      // 2. Verify inferred-behavior claims against real source via the SHARED
      //    adversarial verifier (injected client) — identical to monolith/dag.
      await sample.onProgress?.("verification", "started", "Verifying Pi findings against source");
      const verification = await verifyFindings(findings, {
        sampleDir: sample.sampleDir,
        client,
        model: verifierModel,
        dataFlows: sample.pack.cross_file.data_flows,
        searchFiles: sample.pack.files.map((f) => f.path),
        reachability: reachabilityContextFromPack(sample.pack, statedPurposeOf(sample.pack, sample.listing ?? null)),
      });

      await sample.onProgress?.("verification", "finished", "Pi claim verification finished");
      // 3. Rejoin the deterministic backend via the synthetic node.
      const outputs: NodeOutputs = new Map([
        [
          PI_NODE.id,
          okResult({
            findings,
            verdicts: [...verification.verdicts.values()],
            dismissals: rawDismissals,
            // Pi generation (+ critic) + verifier tokens.
            usage: addUsage(genUsage, verification.usage),
          }),
        ],
      ]);
      const assembled = await collectAndAssemble([PI_NODE], outputs, sample, model, client);

      // The collector tags its RiskReport "dag"; relabel to this arm and re-render
      // (deterministic, no LLM). Tier/classification/synthesis are reused verbatim.
      const dagTrace = assembled.structured as DagTrace;
      let riskReport = { ...dagTrace.risk_report, methodology: "pi", outcome };

      // ARM-SIDE TIER EXCEPTION (deliberate, documented tradeoff — 018 follow-up):
      // the tier is normally owned by computeVerdict and no arm touches it. But
      // investigation incompleteness is a fact only this arm knows — computeVerdict
      // sees findings, not dead sessions — and without it an all-shards-aborted
      // benign-looking run rolls up to a confident low-risk from zero investigation
      // (bake-off run 452). The override is explicit, rationale-carrying, and
      // trace-recorded; it only ever raises clean/low-risk to inconclusive, and it
      // is applied BEFORE renderReportMarkdown so report text, MethodologyOutput.tier,
      // and the structured trace agree.
      const gapOverride = adjustTierForGaps(riskReport.verdict.tier, uncovered);
      const override = gapOverride ?? (outcome.investigation === "incomplete" &&
        (riskReport.verdict.tier === "clean" || riskReport.verdict.tier === "low-risk")
        ? { tier: "inconclusive" as const, note: `Verdict withheld (would be "${riskReport.verdict.tier}"): the investigation did not complete within its bounds. Accounted-for dimensions alone do not establish completed coverage.` }
        : null);
      if (override) {
        riskReport = {
          ...riskReport,
          verdict: { ...riskReport.verdict, tier: override.tier, rationale: `${riskReport.verdict.rationale} ${override.note}` },
        };
      }

      // Keep risk_report at the TOP LEVEL (like DagTrace) so the assess CLI can
      // inject the store id and render HTML; add the Pi-specific run trace on top.
      const trace = {
        ...dagTrace,
        risk_report: riskReport,
        pi: {
          ...(piTrace as Record<string, unknown>),
          uncovered_dimensions: uncovered,
          tier_overridden: override !== null,
        },
        summary,
      };

      return {
        report: renderReportMarkdown(riskReport),
        tier: override?.tier ?? assembled.tier,
        usage: assembled.usage,
        // Pi-generation passes bypass the injected client, so their tokens never
        // reach the CLI's UsageTracker — surface them here for the CLI to merge
        // into per-step accounting (so usage rows reconcile to the report total).
        usageByStep: usageByPass.map(passToUsageLine),
        structured: trace,
      };
    },
  };
}
