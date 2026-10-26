import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlmClient } from "../src/llm/fake.ts";
import {
  UsageTracker,
  parseCostRates,
  summarizeCost,
  costOf,
  renderUsageTable,
  CostRatesError,
  type UsageEntry,
} from "../src/llm/usage.ts";
import { DEFAULT_MODEL_PRICING, resolveEffectiveRates } from "../src/llm/model-pricing.ts";

const entry = (over: Partial<UsageEntry> = {}): UsageEntry => ({
  label: "monolith",
  model: "m1",
  calls: 1,
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  wallClockMs: 0,
  ...over,
});

describe("UsageTracker", () => {
  it("aggregates calls per (label, model) and passes responses through untouched", async () => {
    const fake = new FakeLlmClient((req) => ({
      text: "ok",
      usage: { inputTokens: 10, outputTokens: 5, wallClockMs: 100 },
    }));
    const tracker = new UsageTracker(fake);
    await tracker.complete({ label: "monolith", model: "arm", prompt: "p1" });
    await tracker.complete({ label: "verify:claim", model: "arm", prompt: "p2" });
    await tracker.complete({ label: "verify:claim", model: "arm", prompt: "p3" });
    await tracker.complete({ label: "verify:claim", model: "other", prompt: "p4" });

    expect(tracker.breakdown()).toEqual([
      { label: "monolith", model: "arm", calls: 1, inputTokens: 10, outputTokens: 5, wallClockMs: 100 },
      { label: "verify:claim", model: "arm", calls: 2, inputTokens: 20, outputTokens: 10, wallClockMs: 200 },
      { label: "verify:claim", model: "other", calls: 1, inputTokens: 10, outputTokens: 5, wallClockMs: 100 },
    ]);
    // The summary totals cover every step.
    const s = tracker.summary();
    expect(s.totals).toEqual({ calls: 4, inputTokens: 40, outputTokens: 20, wallClockMs: 400 });
    expect(s.estimatedUsd).toBeNull(); // no rates → token counts only
  });

  it("breakdown returns copies — later calls don't mutate an earlier snapshot", async () => {
    const tracker = new UsageTracker(new FakeLlmClient(() => ({ text: "x", usage: { inputTokens: 1, outputTokens: 1 } })));
    await tracker.complete({ label: "a", model: "m", prompt: "p" });
    const snap = tracker.breakdown();
    await tracker.complete({ label: "a", model: "m", prompt: "p2" });
    expect(snap[0]!.calls).toBe(1);
    expect(tracker.breakdown()[0]!.calls).toBe(2);
  });
});

describe("parseCostRates", () => {
  it("returns undefined for absent/empty input (token counts only)", () => {
    expect(parseCostRates(undefined)).toBeUndefined();
    expect(parseCostRates("")).toBeUndefined();
    expect(parseCostRates("  ")).toBeUndefined();
  });

  it("parses inline JSON rates (USD per 1M tokens)", () => {
    expect(parseCostRates('{"m1": {"input": 0.3, "output": 1.2}, "default": {"input": 1, "output": 2}}')).toEqual({
      m1: { input: 0.3, output: 1.2 },
      default: { input: 1, output: 2 },
    });
  });

  it("loads rates from a JSON file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "rates-"));
    try {
      const path = join(dir, "rates.json");
      writeFileSync(path, '{"m1": {"input": 0.5, "output": 1.5}}');
      expect(parseCostRates(path)).toEqual({ m1: { input: 0.5, output: 1.5 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws clear errors for bad JSON, bad shapes, negative rates, and missing files", () => {
    expect(() => parseCostRates("{nope")).toThrow(CostRatesError);
    expect(() => parseCostRates('{"m": {"input": "free"}}')).toThrow(/must be {"input"/);
    expect(() => parseCostRates('{"m": {"input": -1, "output": 0}}')).toThrow(CostRatesError);
    expect(() => parseCostRates("/no/such/rates.json")).toThrow(/could not read cost-rates file/);
  });
});

describe("resolveEffectiveRates", () => {
  it("returns the committed price table when no override is given", () => {
    expect(resolveEffectiveRates(undefined)).toEqual(DEFAULT_MODEL_PRICING);
    expect(resolveEffectiveRates("")).toEqual(DEFAULT_MODEL_PRICING);
  });

  it("overlays a --cost-rates override on the table without restating it", () => {
    const rates = resolveEffectiveRates('{"minimax-m3:cloud": {"input": 0.6, "output": 2.4}}');
    expect(rates["minimax-m3:cloud"]).toEqual({ input: 0.6, output: 2.4 }); // overridden
    expect(rates["glm-5.2:cloud"]).toEqual(DEFAULT_MODEL_PRICING["glm-5.2:cloud"]); // kept
  });

  it("never mutates the shared default table", () => {
    const rates = resolveEffectiveRates(undefined);
    rates["glm-5.2:cloud"] = { input: 0, output: 0 };
    expect(DEFAULT_MODEL_PRICING["glm-5.2:cloud"]).toEqual({ input: 1.4, output: 4.4 });
  });
});

describe("costOf / summarizeCost", () => {
  const rates = { m1: { input: 0.3, output: 1.2 }, default: { input: 1, output: 2 } };

  it("computes USD from per-1M rates, using the model rate then the default fallback", () => {
    expect(costOf(entry(), rates)).toBeCloseTo(0.3 + 0.6, 10); // 1M in @0.3 + 0.5M out @1.2
    expect(costOf(entry({ model: "unlisted" }), rates)).toBeCloseTo(1 + 1, 10); // default
    expect(costOf(entry({ model: "unlisted" }), { m1: rates.m1 })).toBeNull(); // no rate, no default
  });

  it("surfaces uncosted models instead of silently undercounting the total", () => {
    const s = summarizeCost([entry(), entry({ label: "verify:claim", model: "mystery" })], { m1: { input: 0.3, output: 1.2 } });
    expect(s.estimatedUsd).toBeCloseTo(0.9, 10); // only m1's cost
    expect(s.uncostedModels).toEqual(["mystery"]);
    const table = renderUsageTable(s);
    expect(table).toContain("no cost rate for: mystery");
    expect(table).toContain("NOT included");
  });

  it("renders a per-step table with totals", () => {
    const s = summarizeCost([entry(), entry({ label: "verify:claim", calls: 4, inputTokens: 2_000_000, outputTokens: 0 })], {
      m1: { input: 0.3, output: 1.2 },
    });
    const table = renderUsageTable(s);
    expect(table).toContain("| monolith | m1 | 1 | 1000000 | 500000 | $0.9000 |");
    expect(table).toContain("| verify:claim | m1 | 4 | 2000000 | 0 | $0.6000 |");
    expect(table).toContain("| **total** | | 5 | 3000000 | 500000 | $1.5000 |");
  });
});
