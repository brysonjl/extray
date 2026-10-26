import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import type { AgentSession, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DIMENSIONS, runPiAgent, type PiRunOptions, type RawFinding } from "../src/methodologies/pi/runner.ts";
import { createPi } from "../src/methodologies/pi/index.ts";
import { skeletonPack } from "../src/pipeline/schema.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";

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
  root = mkdtempSync(join(tmpdir(), "pi-source-coverage-")); promptCount = 0; stopped = false;
  options = { provider: "openai-compatible", baseUrl: "https://synthetic.invalid/v1", apiKey: "offline",
    model: "synthetic", sampleDir: root, orientation: "", maxTurns: 2, noPack: true,
    pack: skeletonPack({ path: root, id_from_path: "synthetic", manifest: {} }) };
});
afterEach(() => { vi.clearAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe("Pi source coverage integration", () => {
  it("passes excerpt coverage to the critic and persists it without treating grep as full review", async () => {
    writeFileSync(join(root, "bundle.js"), "first();\nsecond();\n");
    const reviewer = vi.fn(async () => ({ accept: true, gaps: [] }));
    script(async () => {
      turn();
      await tools.find((t) => t.name === "read")!.execute("read", { path: "bundle.js", limit: 1 }, undefined, undefined, undefined as never);
      await tools.find((t) => t.name === "grep")!.execute("grep", { pattern: "second", literal: true }, undefined, undefined, undefined as never);
      await submit();
    });
    const run = await runPiAgent({ ...options, reviewSubmission: reviewer });
    const input = (reviewer.mock.calls as unknown as [[Parameters<NonNullable<PiRunOptions["reviewSubmission"]>>[0]]])[0][0];
    expect(input.filesRead).toEqual(["bundle.js"]);
    expect(input.sourceCoverage?.events).toMatchObject([
      { tool: "read", entireFileDisplayed: false, start: { byte: 0, line: 1 }, end: { byte: 9, line: 2 } },
      { tool: "grep", status: "complete", matches: 1 },
    ]);
    expect(input.sourceCoverage?.events[1]?.entireFileDisplayed).toBeUndefined();
    expect(run.trace.sourceCoverage).toEqual(input.sourceCoverage);
  });

  it("instructs the real critic to assess displayed ranges rather than filename membership", async () => {
    writeFileSync(join(root, "bundle.js"), "first();\nsecond();\n");
    script(async () => {
      turn();
      await tools.find((t) => t.name === "read")!.execute("read", { path: "bundle.js", limit: 1 }, undefined, undefined, undefined as never);
      await submit();
    });
    const client = new FakeLlmClient({
      "pi:critic": '{"adequate":true,"gaps":[]}',
      synthesize: JSON.stringify({ layperson_summary: "Synthetic", technical_summary: "Synthetic", description_deviation: { deviates: null, note: "" } }),
    });
    await createPi("synthetic", options).run({ sampleDir: root, pack: options.pack }, client);
    const prompt = client.calls.find((call) => call.label === "pi:critic")!.prompt;
    expect(prompt).toContain("Membership does not establish whole-file review");
    expect(prompt).toContain("source_access_coverage");
    expect(prompt).toContain("entireFileDisplayed");
    expect(prompt).toContain("bundle.js");
  });

  it("preserves minified evidence columns in the shared finding contract", async () => {
    writeFileSync(join(root, "bundle.js"), "const x = '😀'; second();");
    script(async () => {
      turn();
      const payload = acceptedPayload();
      payload.findings = [{ ...finding, evidence_refs: [{ file: "bundle.js", line: 1, column: 17, sink_or_string: "second" }] }];
      await submit(payload);
    });
    const client = new FakeLlmClient({
      "pi:critic": '{"adequate":true,"gaps":[]}',
      synthesize: JSON.stringify({ layperson_summary: "Synthetic", technical_summary: "Synthetic", description_deviation: { deviates: null, note: "" } }),
    });
    const result = await createPi("synthetic", options).run({ sampleDir: root, pack: options.pack }, client);
    const structured = result.structured as { findings: { evidence_refs: { location: { line: number; column: number } }[] }[] };
    expect(structured.findings[0]?.evidence_refs[0]?.location).toEqual({ line: 1, column: 16 });
  });

});
