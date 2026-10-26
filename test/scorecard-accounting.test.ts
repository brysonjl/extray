import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { runScorecard } from "../src/scorecard/index.ts";
import { runInputFromScorecard } from "../src/db/adapters.ts";
import type { EvidencePack } from "../src/pipeline/schema.ts";
import type { Methodology } from "../src/methodologies/types.ts";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function corpus() {
  const path = mkdtempSync(join(tmpdir(), "scorecard-accounting-"));
  temporary.push(path);
  mkdirSync(join(path, "synthetic", "extension"), { recursive: true });
  writeFileSync(join(path, "synthetic", "label.yaml"), "sample_id: synthetic\nkind: malicious\nexpected_tier: high-risk\nsource:\n  id: synthetic\nmust_detect:\n  - synthetic malicious behavior\n");
  return path;
}

describe("scorecard external generation accounting", () => {
  it.each([1, 2])("counts external passes and tracked calls once for each of %i runs, including price and DB adapter rows", async (runs) => {
    const client = new FakeLlmClient((req) => req.label.startsWith("judge:")
      ? { text: '{"satisfied":true,"rationale":"synthetic behavior present"}', usage: { inputTokens: 3, outputTokens: 2 } }
      : { text: "synthetic synthesis", usage: { inputTokens: 11, outputTokens: 7 } });
    const methodology: Methodology = {
      id: "pi", model: "arm",
      async run(_sample, tracked) {
        const synthesized = await tracked.complete({ label: "synthesize", model: "arm", prompt: "synthetic" });
        return {
          report: synthesized.text, tier: "high-risk",
          // Aggregate includes tracked synthesis AND two external SDK passes.
          usage: { inputTokens: 1311, outputTokens: 247 },
          usageByStep: [
            { label: "pi:gen", model: "arm", inputTokens: 1000, outputTokens: 200 },
            { label: "pi:gen:shard", model: "shard", inputTokens: 300, outputTokens: 40 },
          ],
        };
      },
    };
    const rates = { arm: { input: 2, output: 4 }, shard: { input: 1, output: 3 }, judge: { input: 5, output: 7 } };
    const result = await runScorecard(methodology, { corpusDir: corpus(), client, runs, judgeModel: "judge", packs: new Map([["synthetic", {} as EvidencePack]]), costRates: rates });
    expect(result.totals.cost).toMatchObject({ inputTokens: 1311 * runs, outputTokens: 247 * runs });
    expect(result.accounting.totals).toMatchObject({ inputTokens: 1314 * runs, outputTokens: 249 * runs, calls: 4 * runs });
    expect(result.accounting.entries.map((line) => ({ label: line.label, calls: line.calls }))).toEqual([
      { label: "synthesize", calls: runs }, { label: "pi:gen", calls: runs }, { label: "pi:gen:shard", calls: runs }, { label: "judge:must_detect", calls: runs },
    ]);
    const fullPrice = (1011 * 2 + 207 * 4 + 300 * 1 + 40 * 3 + 3 * 5 + 2 * 7) / 1e6;
    expect(result.accounting.estimatedUsd).toBeCloseTo(fullPrice * runs, 12);
    const dbInput = runInputFromScorecard({ knobs: { methodology: "pi", model: "arm", costRates: rates }, startedAt: "2026-10-03T00:00:00Z", result });
    expect(dbInput.scorecard?.usageByStep?.reduce((sum, line) => sum + (line.inputTokens ?? 0), 0)).toBe(1314 * runs);
    expect(dbInput.scorecard?.estimatedUsd).toBeCloseTo(fullPrice * runs, 12);
  });

  it("also includes normalization without adding the aggregate arm usage a second time", async () => {
    const client = new FakeLlmClient((req) => ({
      text: req.label === "normalize:tier" ? '{"tier":"high-risk"}' : '{"satisfied":true,"rationale":"synthetic"}',
      usage: { inputTokens: 10, outputTokens: 2 },
    }));
    const method: Methodology = { id: "pi", model: "arm", async run() {
      return { report: "synthetic", usage: { inputTokens: 1000, outputTokens: 200 }, usageByStep: [{ label: "pi:gen", model: "arm", inputTokens: 1000, outputTokens: 200 }] };
    } };
    const result = await runScorecard(method, { corpusDir: corpus(), client, judgeModel: "judge", packs: new Map([["synthetic", {} as EvidencePack]]), costRates: { arm: { input: 1, output: 1 }, judge: { input: 2, output: 2 } } });
    expect(result.per_sample[0]?.tier_source).toBe("normalized");
    expect(result.totals.cost).toMatchObject({ inputTokens: 1000, outputTokens: 200 });
    expect(result.accounting.totals).toMatchObject({ inputTokens: 1020, outputTokens: 204 });
    expect(result.accounting.estimatedUsd).toBeCloseTo((1200 + 24 * 2) / 1e6, 12);
  });
});
