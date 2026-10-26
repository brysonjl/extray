import { describe, it, expect } from "vitest";
import { analyzeCorpus } from "../scripts/analyze-corpus.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { makeFindingChallenger } from "../src/methodologies/dag/nodes/finding-challenger.ts";
import { collectAndAssemble } from "../src/methodologies/dag/collect.ts";
import { okResult, ZERO_USAGE, type DagNode, type NodeContext, type NodeOutputs } from "../src/methodologies/dag/node.ts";
import type { Finding } from "../src/methodologies/findings.ts";
import type { VerifierVerdict } from "../src/methodologies/claim-verifier.ts";
import type { EvidencePack } from "../src/pipeline/schema.ts";

const results = analyzeCorpus("corpus", { analyzedAt: "2026-01-01T00:00:00Z" });
const packs = new Map(results.map((r) => [r.sample, r.pack]));
const pack = (s: string): EvidencePack => packs.get(s)!;
const SAMPLE = "mutant-a-exfil-fetch";
const SAMPLE_DIR = `corpus/${SAMPLE}/extension`;

// A confirmed inferred-behavior finding grounded at the real exfil sink, as a
// deep dive would emit it.
function confirmedFinding(): { finding: Finding; verdict: VerifierVerdict } {
  const finding: Finding = {
    id: "taint:0",
    title: "cookie value reaches collect.evil-analytics-cdn.invalid",
    claim_type: "inferred-behavior",
    severity: "high",
    category: "data-exfiltration",
    finding_type: "unknown",
    confidence: "medium",
    claimed_mechanism: "A cookie value is read and POSTed via fetch to collect.evil-analytics-cdn.invalid.",
    evidence_refs: [{ file: "js/background.js", location: { line: 197 }, symbol: null, sink_or_string: "fetch" }],
    detail: "cookie→fetch to external host",
  };
  const verdict: VerifierVerdict = {
    claim_id: "taint:0",
    verdict: "confirmed",
    grounding_line: { file: "js/background.js", line: 197 },
    rationale: "producer confirmed",
    evidence_quote: "fetch(...)",
    harm_supported: null,
    harm_rationale: "",
    corrected_facts: [],
  };
  return { finding, verdict };
}

/** A fake producer node that emits one confirmed finding. */
function producerNode(): DagNode {
  const { finding, verdict } = confirmedFinding();
  return {
    id: "taint-flow-reviewer",
    version: "t",
    kind: "llm",
    sourceAccess: "targeted-reads",
    upstream: [],
    gate: () => true,
    run: async () => okResult({ findings: [finding], verdicts: [verdict], usage: ZERO_USAGE }),
  };
}

function ctxWithProducer(client: FakeLlmClient): { ctx: NodeContext; producerOut: NodeOutputs } {
  const { finding, verdict } = confirmedFinding();
  const producerOut: NodeOutputs = new Map([
    ["taint-flow-reviewer", okResult({ findings: [finding], verdicts: [verdict], usage: ZERO_USAGE })],
  ]);
  const ctx: NodeContext = {
    pack: pack(SAMPLE),
    sampleDir: SAMPLE_DIR,
    upstream: producerOut,
    listing: null, enrichment: null,
    client,
    model: "test-model",
    verifierModel: "test-model",
  };
  return { ctx, producerOut };
}

const UPHOLD_JSON = JSON.stringify({
  verdict: "confirmed",
  grounding_line: { file: "js/background.js", line: 197 },
  rationale: "tried to refute; the fetch genuinely sends the cookie",
  evidence_quote: "fetch(...)",
});
const REFUTE_JSON = JSON.stringify({
  verdict: "refuted",
  grounding_line: { file: "js/background.js", line: 197 },
  rationale: "the cited code does not actually send a cookie",
  evidence_quote: "// no cookie in body",
});

describe("finding-challenger node", () => {
  it("gates on a confirmed inferred-behavior and challenges it with its own label", async () => {
    const fake = new FakeLlmClient({ "dag:finding-challenger": { text: UPHOLD_JSON, usage: { inputTokens: 5, outputTokens: 2 } } });
    const challenger = makeFindingChallenger(["taint-flow-reviewer"]);
    const { ctx } = ctxWithProducer(fake);

    expect(challenger.gate(ctx)).toBe(true);
    const res = await challenger.run(ctx);
    expect(res.status).toBe("ok");
    // It used its OWN label (not verify:claim) — independence from the producer.
    expect(fake.calls.map((c) => c.label)).toEqual(["dag:finding-challenger"]);
    // Upholding emits a confirmed verdict and no dismissal.
    expect(res.verdicts).toHaveLength(1);
    expect(res.verdicts[0]!.verdict).toBe("confirmed");
    expect(res.dismissals).toHaveLength(0);
  });

  it("does not gate when nothing was confirmed", () => {
    const fake = new FakeLlmClient({});
    const challenger = makeFindingChallenger(["taint-flow-reviewer"]);
    const empty: NodeOutputs = new Map([["taint-flow-reviewer", okResult({ usage: ZERO_USAGE })]]);
    const ctx: NodeContext = { pack: pack(SAMPLE), sampleDir: SAMPLE_DIR, upstream: empty, listing: null, enrichment: null, client: fake, model: "m", verifierModel: "m" };
    expect(challenger.gate(ctx)).toBe(false);
  });

  it("a refutation records a dismissal and (via the collector) vetoes the confirmation", async () => {
    // The challenger refutes; collectAndAssemble must drop the finding from the
    // asserted set (refutation precedence) and surface it as an excluded claim.
    const fake = new FakeLlmClient({
      "dag:finding-challenger": { text: REFUTE_JSON, usage: { inputTokens: 5, outputTokens: 2 } },
      synthesize: {
        text: JSON.stringify({
          layperson_summary: "x",
          technical_summary: "y",
          description_deviation: { deviates: null, note: "" },
        }),
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    });
    const producer = producerNode();
    const challenger = makeFindingChallenger(["taint-flow-reviewer"]);
    const nodes = [producer, challenger];

    // Run producer, then challenger (mirrors the scheduler's topological order).
    const outputs: NodeOutputs = new Map();
    outputs.set("taint-flow-reviewer", await producer.run({ pack: pack(SAMPLE), sampleDir: SAMPLE_DIR, upstream: new Map(), listing: null, enrichment: null, client: fake, model: "m", verifierModel: "m" }));
    outputs.set("finding-challenger", await challenger.run({ pack: pack(SAMPLE), sampleDir: SAMPLE_DIR, upstream: outputs, listing: null, enrichment: null, client: fake, model: "m", verifierModel: "m" }));

    const out = await collectAndAssemble(nodes, outputs, { sampleDir: SAMPLE_DIR, pack: pack(SAMPLE) }, "m", fake);
    // The refuted finding must NOT be asserted as a verified behavior.
    expect(out.report).not.toContain("— verified behavior");
    // It is recorded as an excluded claim instead (never silently dropped).
    expect(out.report).toContain("## Excluded claims (checked, NOT findings)");
    expect(out.report).toContain("collect.evil-analytics-cdn.invalid");
  });
});
