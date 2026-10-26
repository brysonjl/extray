import { describe, it, expect } from "vitest";
import { analyzeCorpus } from "../scripts/analyze-corpus.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { crossFileFlowReviewer } from "../src/methodologies/dag/nodes/cross-file-flow-reviewer.ts";
import type { NodeContext } from "../src/methodologies/dag/node.ts";
import type { EvidencePack } from "../src/pipeline/schema.ts";

const results = analyzeCorpus("corpus", { analyzedAt: "2026-01-01T00:00:00Z" });
const packs = new Map(results.map((r) => [r.sample, r.pack]));
const SAMPLE = "mutant-e-crossfile-flow";
const SAMPLE_DIR = `corpus/${SAMPLE}/extension`;
const pack = packs.get(SAMPLE)!;

const CONFIRMED_JSON = JSON.stringify({
  verdict: "confirmed",
  grounding_line: { file: "js/background.js", line: 196 },
  rationale: "cookies staged into _sync_cache then fetched cross-file",
  evidence_quote: "storage.set('_sync_cache', cookies)",
});

function fakeClient(): FakeLlmClient {
  return new FakeLlmClient({
    "verify:claim": { text: CONFIRMED_JSON, usage: { inputTokens: 7, outputTokens: 3 } },
  });
}

function ctxFor(p: EvidencePack, client: FakeLlmClient): NodeContext {
  return { pack: p, sampleDir: SAMPLE_DIR, upstream: new Map(), listing: null, enrichment: null, client, model: "test-model", verifierModel: "test-model" };
}

describe("cross-file-flow-reviewer", () => {
  it("gates on a staged storage→external flow with a cookie source and confirms the cross-file claim", async () => {
    // Structural sanity: the corpus sample has exactly the shape this node targets.
    const staged = (pack.cross_file.data_flows ?? []).filter(
      (f) => f.source_kind === "storage" && f.dest_party !== "first-party-extension",
    );
    expect(staged.length).toBeGreaterThanOrEqual(1);
    const cookieScripts = pack.scripts.filter((s) =>
      s.sinks.some((sink) => /cookies\.(get|getAll)|document\.cookie/.test(sink.api)),
    );
    expect(cookieScripts.some((s) => s.path === "js/background.js")).toBe(true);

    const fake = fakeClient();
    const ctx = ctxFor(pack, fake);

    expect(crossFileFlowReviewer.gate(ctx)).toBe(true);

    const result = await crossFileFlowReviewer.run(ctx);
    expect(result.status).toBe("ok");
    expect(result.findings.length).toBeGreaterThanOrEqual(1);

    const finding = result.findings[0]!;
    expect(finding.category).toBe("data-exfiltration");
    expect(finding.claim_type).toBe("inferred-behavior");
    // PRIMARY ref grounds at the cookie side — a cookie-source file (js/background.js
    // is among them). Asserted structurally against the pack's cookie scripts.
    const cookieFiles = new Set(cookieScripts.map((s) => s.path));
    expect(cookieFiles.has("js/background.js")).toBe(true);
    expect(cookieFiles.has(finding.evidence_refs[0]!.file)).toBe(true);

    expect(result.verdicts.some((v) => v.verdict === "confirmed")).toBe(true);
  });

  it("gates false when the only storage flow is first-party-extension", () => {
    const p = {
      ...pack,
      cross_file: {
        ...pack.cross_file,
        data_flows: [
          {
            source_kind: "storage",
            file: "js/common-utils.js",
            sink_api: "fetch",
            sink_location: { line: 27, column: 2 },
            dest_host: "telemetry-sync.net",
            dest_party: "first-party-extension",
          },
        ],
      },
    } as EvidencePack;
    expect(crossFileFlowReviewer.gate(ctxFor(p, fakeClient()))).toBe(false);
  });

  it("gates false when there is a staged storage→external flow but no cookie source", () => {
    const p = {
      ...pack,
      scripts: [],
      cross_file: {
        ...pack.cross_file,
        data_flows: [
          {
            source_kind: "storage",
            file: "js/common-utils.js",
            sink_api: "fetch",
            sink_location: { line: 27, column: 2 },
            dest_host: "telemetry-sync.net",
            dest_party: "external",
          },
        ],
      },
    } as EvidencePack;
    expect(crossFileFlowReviewer.gate(ctxFor(p, fakeClient()))).toBe(false);
  });
});
