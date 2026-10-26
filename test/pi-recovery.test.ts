import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DIMENSIONS, runPiAgent, type PiRunOptions, type RawFinding } from "../src/methodologies/pi/runner.ts";
import { createPi, parseReview } from "../src/methodologies/pi/index.ts";
import { skeletonPack } from "../src/pipeline/schema.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import type { RiskReport } from "../src/report/contract.ts";

vi.mock("@earendil-works/pi-coding-agent", async (original) => {
  const actual = await original<typeof import("@earendil-works/pi-coding-agent")>();
  return { ...actual, createAgentSession: vi.fn() };
});

let root: string;
let options: PiRunOptions;
let emit: Parameters<AgentSession["subscribe"]>[0];
let tools: ToolDefinition[];
let stopped = false;
let promptCount = 0;
const setActive = vi.fn();
const dispose = vi.fn();
const acceptedPayload = (): { summary: string; findings: RawFinding[]; dismissals: { concern: string; checks_run: string[]; note: string }[] } => ({ summary: "Synthetic investigation", findings: [],
  dismissals: DIMENSIONS.map((concern) => ({ concern, checks_run: ["source inspected"], note: "No concern in synthetic source" })) });
const finding: RawFinding = { title: "Synthetic observation", claim_type: "observed-capability", severity: "info", category: "permissions", finding_type: "unknown", confidence: "high", claimed_mechanism: "", evidence_refs: [], detail: "test" };
function turn() { emit({ type: "turn_start" }); return !stopped; }
async function submit(payload = acceptedPayload()) {
  emit({ type: "tool_execution_start", toolCallId: "submit", toolName: "submit_findings", args: payload });
  if (stopped) return;
  const result = await tools.find((t) => t.name === "submit_findings")!.execute("submit", payload, undefined, undefined, undefined as never);
  emit({ type: "tool_execution_end", toolCallId: "submit", toolName: "submit_findings", isError: false, result });
  return result;
}
function script(fn: (n: number) => Promise<void>) {
  vi.mocked(pi.createAgentSession).mockImplementation(async (opts) => {
    tools = opts!.customTools!;
    return { session: {
      subscribe: (listener: typeof emit) => { emit = listener; return () => {}; },
      prompt: async () => { stopped = false; await fn(++promptCount); },
      abort: async () => { stopped = true; },
      setActiveToolsByName: setActive,
      getSessionStats: () => ({ tokens: { input: 10 * promptCount, output: 3 * promptCount, cacheRead: 2 * promptCount, cacheWrite: 1 * promptCount } }),
      dispose,
    } as unknown as AgentSession, extensionsResult: opts!.resourceLoader!.getExtensions() };
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pi-recovery-")); promptCount = 0; stopped = false;
  options = { provider: "openai-compatible", baseUrl: "https://synthetic.invalid/v1", apiKey: "offline",
    model: "synthetic", sampleDir: root, orientation: "", maxTurns: 2, noPack: true,
    pack: skeletonPack({ path: root, id_from_path: "synthetic", manifest: {} }) };
});
afterEach(() => { vi.clearAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe("bounded pi submission recovery", () => {
  it("recovers a critic reopening at the turn ceiling with two submit-only turns, preserves usage and marks bounded coverage", async () => {
    const reviewer = vi.fn().mockResolvedValueOnce({ accept: false, gaps: ["Inspect synthetic worker"] }).mockResolvedValue({ accept: true, gaps: [] });
    script(async (n) => {
      if (n === 1) { turn(); turn(); await submit(); turn(); }
      else { turn(); await submit(); }
    });
    const run = await runPiAgent({ ...options, reviewSubmission: reviewer });
    expect(setActive).toHaveBeenCalledWith(["submit_findings"]);
    expect(run.trace).toMatchObject({ submitted: true, aborted: true, salvaged: "wind-down", abortReason: "turn-ceiling" });
    expect(run.trace.submissionEvents?.[0]).toMatchObject({ status: "critic-reopened", reasons: ["Inspect synthetic worker"] });
    expect(run.incomplete).toBe(true);
    expect(run.usage).toEqual({ inputTokens: 26, outputTokens: 6 });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("blocks exploration during wind-down even if the model still calls a hidden tool", async () => {
    script(async (n) => {
      if (n === 1) { turn(); turn(); turn(); }
      else {
        turn();
        await expect(tools.find((t) => t.name === "read")!.execute("read", { path: "missing.js" }, undefined, undefined, undefined as never)).rejects.toThrow("exploration is disabled");
        await submit();
      }
    });
    const run = await runPiAgent(options);
    expect(run.trace.filesRead).toEqual([]);
    expect(run.trace.submitted).toBe(true);
  });

  it("never accepts a fifth coverage-rejected attempt and preserves a richer earlier rejected payload", async () => {
    script(async () => {
      for (let i = 0; i < 5; i++) await submit({ summary: "partial", findings: i === 0 ? [finding] : [], dismissals: [] });
    });
    const run = await runPiAgent({ ...options, maxTurns: 20 });
    expect(run.trace.submitted).toBe(false);
    expect(run.incomplete).toBe(true);
    expect(run.findings).toEqual([finding]);
    expect(run.trace.salvaged).toBe("submit-rejected");
    expect(run.trace.stopReason).toBe("submission-recovery-exhausted");
    expect(promptCount).toBe(1);
  });

  it("caps recurring critic rejection without declaring an accepted submission", async () => {
    const reviewer = vi.fn(async () => ({ accept: false, gaps: ["synthetic gap"] }));
    script(async () => { for (let i = 0; i < 3; i++) await submit(); });
    const run = await runPiAgent({ ...options, reviewSubmission: reviewer });
    expect(run.trace.submitted).toBe(false);
    expect(run.trace.criticReopens).toBe(2);
    expect(run.trace.submissionEvents?.some((e) => e.status === "critic-rejected")).toBe(true);
    expect(promptCount).toBe(1);
  });

  it("records schema errors that bypass execute, bounds invalid-call loops and skips wind-down", async () => {
    script(async () => {
      turn();
      for (let i = 0; i < 8; i++) {
        emit({ type: "tool_execution_start", toolCallId: `bad-${i}`, toolName: "submit_findings", args: {} });
        emit({ type: "tool_execution_end", toolCallId: `bad-${i}`, toolName: "submit_findings", isError: true,
          result: { content: [{ type: "text", text: "Required field findings missing" }] } });
      }
    });
    const run = await runPiAgent(options);
    expect(run.trace).toMatchObject({ submitCalls: 8, submitAttempts: 0, submitted: false, abortReason: "submit-ceiling" });
    expect(run.trace.toolErrors?.join(" ")).toContain("Required field findings missing");
    expect(promptCount).toBe(1);
    expect(setActive).not.toHaveBeenCalled();
  });

  it("treats unavailable critics as incomplete, retaining valid-shaped work", async () => {
    script(async () => { turn(); await submit(); });
    const run = await runPiAgent({ ...options, reviewSubmission: async () => { throw new Error("synthetic reviewer failure"); } });
    expect(run.trace.submitted).toBe(false);
    expect(run.trace.submissionEvents?.[0]).toMatchObject({ status: "critic-error", reasons: ["Completeness review failed: synthetic reviewer failure"] });
    expect(run.dismissals).toHaveLength(5);
  });

  it.each([true, false])("reports incomplete independently of empty uncovered_dimensions (review accepted: %s)", async (accept) => {
    script(async () => { turn(); await submit(); });
    const client = new FakeLlmClient({
      "pi:critic": { text: JSON.stringify({ adequate: accept, gaps: accept ? [] : ["synthetic unread file"] }), usage: { inputTokens: 5, outputTokens: 2 } },
      synthesize: { text: JSON.stringify({ layperson_summary: "Synthetic summary", technical_summary: "Synthetic summary", description_deviation: { deviates: null, note: "" } }), usage: { inputTokens: 4, outputTokens: 2 } },
    });
    const output = await createPi("synthetic", options).run({ sampleDir: root, pack: options.pack }, client);
    const structured = output.structured as { risk_report: RiskReport; pi: { uncovered_dimensions: string[] } };
    expect(structured.pi.uncovered_dimensions).toEqual([]);
    expect(structured.risk_report.outcome).toMatchObject({ investigation: accept ? "complete" : "incomplete", final_submission: accept ? "accepted" : "not-accepted" });
    expect(output.report.includes("Incomplete investigation")).toBe(!accept);
    if (!accept) expect(output.tier).toBe("inconclusive");
  });

  it.each(["", "{}", '{"adequate":false,"gaps":"bad"}'])("does not fail open for malformed critic output %j", (text) => {
    expect(() => parseReview(text)).toThrow();
  });
});
