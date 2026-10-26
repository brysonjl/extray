// The agentic investigation loop. A single agent works a fixed checklist of risk
// DIMENSIONS, one tool action per step, until every dimension is closed (a
// finding or a dismissal) or the step budget is exhausted. A budget-exhausted
// dimension is closed as an explicit `inconclusive` dismissal — never a silent
// omission.
//
// The agent never sets a tier. It records findings; an inferred-behavior finding
// is adjudicated against real source by the SHARED verifyClaim the moment it is
// recorded (the only path to a verified-behavior). The accumulated finding set is
// handed to the deterministic backend by index.ts.
//
// Determinism: temperature 0, every call through the injected client, stable
// `agentic:step` label. Each tool result re-enters the next prompt only through
// buildPrompt/wrapUntrustedBlock — the agent reads adversarial source, so the
// whole transcript is framed as untrusted data.

import type { LlmClient, Usage } from "../../llm/client.ts";
import { buildPrompt, type UntrustedBlock } from "../../llm/envelope.ts";
import { newSourceCaches, reachabilityContextFromPack, verifyClaim, type VerifierVerdict } from "../claim-verifier.ts";
import { statedPurposeOf } from "../../report/assemble.ts";
import {
  isGrounded,
  parseFindingsReport,
  resolveEvidenceRefs,
  type Finding,
} from "../findings.ts";
import type { DataFlow } from "../../pipeline/schema.ts";
import { lastObjectWith } from "../../scorecard/parse.ts";
import { addUsage, ZERO_USAGE, type Dismissal } from "../dag/node.ts";
import { AgenticTools } from "./tools.ts";

export const DIMENSIONS = [
  "exfiltration",
  "code-execution",
  "stated-purpose-deviation",
  "permission-justification",
  "obfuscation",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

const DIMENSION_QUESTIONS: Record<Dimension, string> = {
  exfiltration: "Does sensitive data (cookies, history, storage, identity, form/page content) leave the extension to a network or external party?",
  "code-execution": "Is there remote or dynamic code execution — eval/Function, remotely fetched scripts, injected code, or message-driven code paths?",
  "stated-purpose-deviation": "Does the extension do materially more or other than what it claims (manifest/store description)?",
  "permission-justification": "Are the requested permissions and host access explained by the stated purpose and the observed call sites?",
  obfuscation: "Is first-party code obfuscated, packed, or otherwise written to hide what it does?",
};

export type DimensionStatus = "open" | "finding" | "dismissed" | "inconclusive";

export interface DimensionOutcome {
  dimension: Dimension;
  status: DimensionStatus;
}

export interface ToolCall {
  step: number;
  tool: string;
  dimension: Dimension | null;
  ok: boolean;
  /** Short human-readable outcome for the audit trail. */
  summary: string;
}

export interface AgentRunState {
  findings: Finding[];
  verdicts: VerifierVerdict[];
  dismissals: Dismissal[];
  toolCalls: ToolCall[];
  dimensions: DimensionOutcome[];
  steps: number;
  budgetExhausted: boolean;
  usage: Usage;
}

// ---- pure stop-condition helpers (unit-tested) ----

export function allDimensionsClosed(dims: DimensionOutcome[]): boolean {
  return dims.every((d) => d.status !== "open");
}

/** Why the loop stops, or null to keep going. `budget-exhausted` only when work remains. */
export function stopReason(dims: DimensionOutcome[], step: number, maxSteps: number): null | "all-closed" | "budget-exhausted" {
  if (allDimensionsClosed(dims)) return "all-closed";
  if (step >= maxSteps) return "budget-exhausted";
  return null;
}

// ---- the loop ----

const STATIC_INSTRUCTIONS = [
  "You are a security analyst investigating a Chrome (Manifest V3) browser extension by reading its actual source code through tools.",
  "You are investigating ONE risk dimension (named below). Investigate it with the read tools, then close it by recording EITHER a finding (record_finding) OR a dismissal (record_dismissal) for THIS dimension. Do not leave it open once you have gathered enough evidence; do not investigate other dimensions.",
  "Ground every claim in the real source. An evidence pack is provided as a STARTING MAP (read_pack) — use it to orient, but confirm behavior by reading the actual files (read_file, grep). The map is lossy; the source is the truth.",
  "Findings carry a claim_type:",
  '- "observed-capability": a specific API/permission/string/destination is present. No causal story.',
  '- "inferred-behavior": a claim that the code DOES something (a mechanism / data flow). State it in one line in claimed_mechanism. When you record one, it is IMMEDIATELY checked against the real source by an adversarial verifier; the verdict (confirmed/refuted/needs-dynamic/inconclusive) is returned to you. Cite precisely — file + line + the exact API/string — or it cannot be confirmed.',
  "Severity is decided by the DESTINATION and EFFECT: sensitive data leaving to an EXTERNAL/untrusted party, or remote/obfuscated code execution, is high/critical; a broad capability or a movement to a local/user channel is medium; minor scope is low; neutral context is info.",
  "Findings also carry a finding_type — the NATURE of the issue (a neutral classification of the mechanism, NOT a verdict on intent), one of: \"vulnerability\" (an exploitable weakness a THIRD PARTY could abuse — the extension is the victim/vector), \"malicious\" (harms/deceives the user BY DESIGN — assign ONLY to a confirmed inferred-behavior mechanism with strong evidence; when unsure use \"unknown\"), \"unwanted\" (tracking/fingerprinting/adware/telemetry monetization), \"risky-capability\" (a powerful/broad capability consistent with a plausible purpose), or \"unknown\" (nature undetermined — the default).",
  "Tools (respond with EXACTLY ONE per step):",
  '- {"tool": "list_files", "args": {}} — the extension-relative file list.',
  '- {"tool": "read_file", "args": {"path": "<rel path>", "range": {"start_line": <n>, "end_line": <n>}?}} — a file or line window.',
  '- {"tool": "grep", "args": {"pattern": "<regex>", "path": "<rel path>"?}} — search source; returns file:line: text.',
  '- {"tool": "read_pack", "args": {"path": "<dotted.path>"}} — a subtree of the evidence map.',
  '- {"tool": "record_finding", "args": {"dimension": "<dimension>", "finding": {"title","claim_type","severity","category","finding_type","confidence","claimed_mechanism","detail","evidence_refs": [{"file","location": {"line"}|null,"symbol"|null,"sink_or_string"|null}]}}}',
  '- {"tool": "record_dismissal", "args": {"dimension": "<dimension>", "concern": "<what you checked>", "checks_run": ["..."], "note": "<why it is not a concern>"}}',
  "Respond with ONLY a single JSON object: {\"thought\": \"<one line>\", \"tool\": \"<name>\", \"args\": { ... }}.",
].join("\n");

// Only the last WINDOW observations are re-sent each step. The old single loop
// re-sent the WHOLE transcript every step, so input tokens grew ~quadratically
// (one sample measured 166k input tokens over a 24-step run). A sliding window
// keeps each step's prompt bounded; per-dimension loops are short, so a window
// this size covers the dimension's own recent reads.
const TRANSCRIPT_WINDOW = 6;

function statusBlock(dimension: Dimension, step: number, maxSteps: number): string {
  return [
    `INVESTIGATING DIMENSION: ${dimension}`,
    `QUESTION: ${DIMENSION_QUESTIONS[dimension]}`,
    `STEP ${step + 1} of at most ${maxSteps}. Close this dimension with record_finding or record_dismissal before the budget runs out.`,
  ].join("\n");
}

export interface AgentLoopOptions {
  onProgress?: import("../types.ts").MethodologyProgress;
  pack: import("../../pipeline/schema.ts").EvidencePack;
  sampleDir: string;
  listing: import("../../report/build.ts").ListingInput | null;
  orientation: string;
  client: LlmClient;
  model: string;
  verifierModel: string;
  /** Per-dimension tool-call budget. Each of the 5 dimensions gets its own. */
  maxStepsPerDimension: number;
}

/** One dimension's investigation: a short, bounded-transcript loop. Independent
 *  of the other dimensions, so the caller runs all five concurrently. */
interface DimensionResult {
  outcome: DimensionOutcome;
  findings: Finding[];
  verdicts: VerifierVerdict[];
  dismissals: Dismissal[];
  toolCalls: ToolCall[];
  usage: Usage;
}

async function runDimensionLoop(dimension: Dimension, tools: AgenticTools, opts: AgentLoopOptions): Promise<DimensionResult> {
  const findings: Finding[] = [];
  const verdicts: VerifierVerdict[] = [];
  const dismissals: Dismissal[] = [];
  const toolCalls: ToolCall[] = [];
  const observations: string[] = [];
  const sourceCaches = newSourceCaches();
  const searchFiles = opts.pack.files.map((f) => f.path);
  const dataFlows: DataFlow[] = opts.pack.cross_file.data_flows ?? [];
  const reachability = reachabilityContextFromPack(opts.pack, statedPurposeOf(opts.pack, opts.listing ?? null));
  let usage = ZERO_USAGE;
  let status: DimensionStatus = "open";
  let findingCounter = 0;
  let step = 0;

  const observe = (s: string) => observations.push(s);
  // Findings get a globally-unique, concurrency-safe id (dimension-prefixed) at
  // record time — never rewritten — so the verifier verdict's claim_id stays
  // matched to its finding when the five dimension results are merged.
  const mintId = () => `agentic:${dimension}:${++findingCounter}`;

  while (status === "open" && step < opts.maxStepsPerDimension) {
    const instructions = `${STATIC_INSTRUCTIONS}\n\n${statusBlock(dimension, step, opts.maxStepsPerDimension)}`;
    const blocks: UntrustedBlock[] = [{ tag: "evidence_map", content: opts.orientation }];
    if (observations.length > 0) {
      blocks.push({ tag: "investigation_so_far", content: observations.slice(-TRANSCRIPT_WINDOW).join("\n\n") });
    }

    const res = await opts.client.complete({
      label: `agentic:step:${dimension}`,
      model: opts.model,
      prompt: buildPrompt(instructions, blocks),
      params: { temperature: 0, format: "json" },
    });
    usage = addUsage(usage, res.usage);
    step++;

    const action = lastObjectWith(res.text, "tool");
    const tool = typeof action?.tool === "string" ? action.tool : null;
    const rawArgs = (action?.args ?? {}) as Record<string, unknown>;
    if (!tool) {
      observe(`STEP ${step}: could not parse an action. Respond with ONE JSON object {thought, tool, args}.`);
      toolCalls.push({ step, tool: "(unparseable)", dimension, ok: false, summary: "no parseable action" });
      continue;
    }

    if (tool === "record_finding") {
      let parsed: Finding | null = null;
      try {
        const report = parseFindingsReport(JSON.stringify({ summary: "", overall_risk: "", findings: [rawArgs.finding] }));
        parsed = report.findings[0] ?? null;
      } catch {
        parsed = null;
      }
      if (!parsed) {
        observe(`STEP ${step}: record_finding could not parse the "finding" object — include title, claim_type, severity, category, finding_type, confidence, evidence_refs.`);
        toolCalls.push({ step, tool, dimension, ok: false, summary: "unparseable finding" });
        continue;
      }
      parsed.id = mintId();
      findings.push(parsed);

      let summary: string;
      if (parsed.claim_type === "inferred-behavior") {
        const refRes = resolveEvidenceRefs(parsed, opts.sampleDir);
        if (isGrounded(refRes)) {
          const { verdict, usage: vu } = await verifyClaim(
            parsed,
            refRes.resolved,
            { sampleDir: opts.sampleDir, client: opts.client, model: opts.verifierModel, dataFlows, searchFiles, reachability },
            sourceCaches,
          );
          verdicts.push(verdict);
          usage = addUsage(usage, vu);
          summary = `recorded inferred-behavior "${parsed.title}" → verifier: ${verdict.verdict}`;
          observe(`STEP ${step}: recorded finding ${parsed.id}. Verifier verdict: ${verdict.verdict}. ${verdict.rationale}`);
        } else {
          summary = `recorded inferred-behavior "${parsed.title}" → ungrounded (cited file not on disk)`;
          observe(`STEP ${step}: recorded finding ${parsed.id} but none of its cited files resolve on disk — it cannot be confirmed and will be excluded. Cite a real file/line.`);
        }
      } else {
        summary = `recorded observed-capability "${parsed.title}"`;
        observe(`STEP ${step}: recorded observed-capability ${parsed.id}.`);
      }
      status = "finding";
      toolCalls.push({ step, tool, dimension, ok: true, summary });
      continue;
    }

    if (tool === "record_dismissal") {
      const checks = Array.isArray(rawArgs.checks_run)
        ? rawArgs.checks_run.filter((c): c is string => typeof c === "string")
        : [];
      if (checks.length === 0) {
        observe(`STEP ${step}: a dismissal must list the "checks_run" you actually performed — it is never a clean bill of health.`);
        toolCalls.push({ step, tool, dimension, ok: false, summary: "dismissal without checks_run" });
        continue;
      }
      const concern = typeof rawArgs.concern === "string" ? rawArgs.concern : DIMENSION_QUESTIONS[dimension];
      dismissals.push({ concern, checks_run: checks, note: typeof rawArgs.note === "string" ? rawArgs.note : "" });
      status = "dismissed";
      observe(`STEP ${step}: dismissed ${dimension} after checks: ${checks.join(", ")}.`);
      toolCalls.push({ step, tool, dimension, ok: true, summary: `dismissed (${checks.length} checks)` });
      continue;
    }

    // Read/reason tools.
    let result;
    switch (tool) {
      case "list_files":
        result = tools.listFiles();
        break;
      case "read_file":
        result = tools.readFile(rawArgs.path, rawArgs.range);
        break;
      case "grep":
        result = tools.grep(rawArgs.pattern, rawArgs.path);
        break;
      case "read_pack":
        result = tools.readPack(rawArgs.path);
        break;
      default:
        result = { ok: false, content: `unknown tool "${tool}". Use one of: list_files, read_file, grep, read_pack, record_finding, record_dismissal.` };
    }
    observe(`STEP ${step}: ${tool}(${JSON.stringify(rawArgs)}) →${result.ok ? "" : " ERROR:"}\n${result.content}`);
    toolCalls.push({ step, tool, dimension, ok: result.ok, summary: result.content.slice(0, 120).replace(/\s+/g, " ") });
  }

  // Honest inconclusive: a dimension still open at budget exhaustion is closed as
  // an explicit dismissal listing the tools that ran — never a silent omission.
  if (status === "open") {
    status = "inconclusive";
    const toolsRun = [...new Set(toolCalls.filter((t) => t.ok).map((t) => t.tool))];
    dismissals.push({
      concern: `${dimension}: ${DIMENSION_QUESTIONS[dimension]}`,
      checks_run: toolsRun.length > 0 ? toolsRun : ["(no successful tool calls)"],
      note: `inconclusive: per-dimension step budget (${opts.maxStepsPerDimension}) was exhausted before this dimension was resolved`,
    });
  }

  return { outcome: { dimension, status }, findings, verdicts, dismissals, toolCalls, usage };
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentRunState> {
  // One read-only tools instance shared across the concurrent dimension loops —
  // its file-read cache is populated once and reused (e.g. a big vendored lib is
  // read at most once). Tool dispatch is synchronous, so concurrent loops never
  // interleave inside a single tool call.
  const tools = new AgenticTools(opts.pack, opts.sampleDir);

  // The five dimensions are independent → investigate them concurrently.
  const results = await Promise.all(DIMENSIONS.map(async (d) => {
    await opts.onProgress?.(`agentic:${d}`, "started", `Agentic ${d} investigation started`);
    const result = await runDimensionLoop(d, tools, opts);
    await opts.onProgress?.(`agentic:${d}`, "finished", `Agentic ${d} returned ${result.outcome.status}; ${result.toolCalls.length} tool calls`);
    return result;
  }));

  // Merge in fixed DIMENSIONS order (not completion order) so the trace, ids,
  // and finding order are deterministic regardless of which loop finished first.
  const byDimension = new Map(results.map((r) => [r.outcome.dimension, r]));
  const findings: Finding[] = [];
  const verdicts: VerifierVerdict[] = [];
  const dismissals: Dismissal[] = [];
  const toolCalls: ToolCall[] = [];
  const dimensions: DimensionOutcome[] = [];
  let usage = ZERO_USAGE;
  let steps = 0;
  for (const d of DIMENSIONS) {
    const r = byDimension.get(d)!;
    findings.push(...r.findings);
    verdicts.push(...r.verdicts);
    dismissals.push(...r.dismissals);
    toolCalls.push(...r.toolCalls);
    dimensions.push(r.outcome);
    usage = addUsage(usage, r.usage);
    steps += r.toolCalls.length;
  }
  const budgetExhausted = dimensions.some((d) => d.status === "inconclusive");

  return { findings, verdicts, dismissals, toolCalls, dimensions, steps, budgetExhausted, usage };
}
