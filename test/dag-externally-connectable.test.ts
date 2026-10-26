import { describe, it, expect } from "vitest";
import { analyzeCorpus } from "../scripts/analyze-corpus.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { externallyConnectableReviewer } from "../src/methodologies/dag/nodes/externally-connectable-reviewer.ts";
import type { NodeContext } from "../src/methodologies/dag/node.ts";
import type { EvidencePack } from "../src/pipeline/schema.ts";

const results = analyzeCorpus("corpus", { analyzedAt: "2026-01-01T00:00:00Z" });
const packs = new Map(results.map((r) => [r.sample, r.pack]));
const pack = (s: string): EvidencePack => packs.get(s)!;

const SAMPLE = "mutant-d-wide-externally-connectable";
const SAMPLE_DIR = `corpus/${SAMPLE}/extension`;

const CONFIRMED_JSON = JSON.stringify({
  verdict: "confirmed",
  grounding_line: { file: "js/background.js", line: 196 },
  rationale: "the onMessageExternal handler returns all cookies to any caller without validating the sender",
  evidence_quote:
    "chrome.runtime.onMessageExternal.addListener((req,sender,sendResponse)=>{ chrome.cookies.getAll({}, c=>sendResponse(c)) })",
});

function fakeClient(): FakeLlmClient {
  return new FakeLlmClient({
    "verify:claim": { text: CONFIRMED_JSON, usage: { inputTokens: 7, outputTokens: 3 } },
  });
}

function ctxFor(p: EvidencePack, sampleDir: string, client: FakeLlmClient): NodeContext {
  return { pack: p, sampleDir, upstream: new Map(), listing: null, enrichment: null, client, model: "test-model", verifierModel: "test-model" };
}

describe("externally-connectable-reviewer node", () => {
  it("fires on a wildcard externally_connectable + onMessageExternal handler, grounds at the handler, and confirms the leak", async () => {
    const fake = fakeClient();
    const ctx = ctxFor(pack(SAMPLE), SAMPLE_DIR, fake);

    expect(externallyConnectableReviewer.gate(ctx)).toBe(true);

    const result = await externallyConnectableReviewer.run(ctx);
    expect(result.status).toBe("ok");

    const finding = result.findings.find((f) => f.category === "messaging-surface");
    expect(finding).toBeTruthy();
    expect(finding!.id).toBe("extconn:0");
    expect(finding!.evidence_refs[0]!.file).toBe("js/background.js");
    expect(finding!.evidence_refs[0]!.location).toEqual({ line: 196 });

    expect(result.verdicts.some((v) => v.verdict === "confirmed")).toBe(true);
  });

  it("does not fire when externally_connectable is null and no onMessageExternal listener exists", () => {
    const bare = {
      manifest_analysis: { externally_connectable: null },
      scripts: [
        { path: "js/background.js", listeners: [{ kind: "onMessage", location: { line: 1 }, validates_sender: false, snippet: "" }] },
      ],
    } as unknown as EvidencePack;

    const ctx = ctxFor(bare, SAMPLE_DIR, fakeClient());
    expect(externallyConnectableReviewer.gate(ctx)).toBe(false);
  });
});
