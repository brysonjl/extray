import { describe, expect, it } from "vitest";
import { analysisOptionsArgs, analysisOptionsForMethodology, validateAnalysisOptions } from "../src/product/analysis-config.ts";

describe("analysis option validation", () => {
  it("keeps a plain default configuration backward compatible and supports null resets", () => {
    expect(validateAnalysisOptions(undefined, "pi")).toEqual({});
    expect(validateAnalysisOptions(null, "pi")).toEqual({});
    expect(validateAnalysisOptions({ verifierModel: null, piMaxTurns: null }, "pi")).toEqual({});
  });
  it.each([0, -1, 1.5, "50", Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid numeric budgets (%s)", (value) => {
    expect(() => validateAnalysisOptions({ maxTokens: value }, "monolith")).toThrow(/positive integer/);
    expect(() => validateAnalysisOptions({ piMaxTurns: value }, "pi")).toThrow(/positive integer/);
  });
  it("rejects unsupported and misspelled options rather than silently ignoring them", () => {
    expect(() => validateAnalysisOptions({ replay: true }, "pi")).toThrow(/live-only/);
    expect(() => validateAnalysisOptions({ think: "high" }, "dag")).toThrow(/not supported/);
    expect(() => validateAnalysisOptions({ piShard: true }, "monolith")).toThrow(/not supported/);
    expect(() => validateAnalysisOptions({ agenticMaxStepsPerDimension: 8 }, "pi")).toThrow(/not supported/);
    expect(() => validateAnalysisOptions({ maxToken: 50 }, "pi")).toThrow(/unknown analysis option/);
    expect(() => validateAnalysisOptions({ apiKey: "secret" }, "pi")).toThrow(/unknown analysis option/);
    expect(validateAnalysisOptions({ replay: false, think: false }, "pi")).toEqual({});
  });
  it("validates model strings, booleans and reasoning effort without string coercion", () => {
    expect(() => validateAnalysisOptions({ enrich: "true" }, "pi")).toThrow(/boolean/);
    expect(() => validateAnalysisOptions({ think: "true" }, "monolith")).toThrow(/think must/);
    expect(validateAnalysisOptions({ think: false, verifierModel: " verifier-v1 " }, "monolith")).toEqual({ think: false, verifierModel: "verifier-v1" });
    expect(() => validateAnalysisOptions({ verifierModel: "\n" }, "pi")).toThrow(/model ID/);
    expect(() => validateAnalysisOptions({ verifierModel: "--replay" }, "pi")).toThrow(/leading dash/);
  });
  it("validates per-dimension overrides and requires sharding for per-shard budgets", () => {
    expect(() => validateAnalysisOptions({ piSubagentModels: { unknown: "model" } }, "pi")).toThrow(/unknown analysis dimension/);
    expect(() => validateAnalysisOptions({ piSubagentModels: { obfuscation: "one,exfiltration=two" } }, "pi")).toThrow(/commas/);
    expect(() => validateAnalysisOptions({ piSubagentMaxTurns: 12 }, "pi")).toThrow(/requires Pi sharding/);
    expect(() => validateAnalysisOptions({ piShard: true, piMaxTurns: 50 }, "pi")).toThrow(/single Pi investigator/);
    expect(validateAnalysisOptions({ piSubagentModels: { obfuscation: "model" }, piSubagentMaxTurns: 12 }, "pi")).toEqual({ piSubagentModels: { obfuscation: "model" }, piSubagentMaxTurns: 12 });
  });
  it("clears incompatible options when changing methodology, preserving general defaults", () => {
    expect(analysisOptionsForMethodology({ piShard: true, piMaxTurns: 10, verifierModel: "verify", maxTokens: 500, enrich: true }, "monolith")).toEqual({ verifierModel: "verify", maxTokens: 500, enrich: true });
    expect(analysisOptionsForMethodology({ think: "high", replay: true, useCache: false }, "pi")).toEqual({ useCache: false });
  });
});

describe("analysis CLI arguments", () => {
  it("preserves disabled thinking and cache, and serializes per-dimension models deterministically", () => {
    expect(analysisOptionsArgs({ think: false, maxTokens: 5000, useCache: false, forceFresh: true, enrich: true, replay: true })).toEqual([
      "--think", "false", "--max-tokens", "5000", "--enrich", "--force", "--replay", "--no-cache",
    ]);
    expect(analysisOptionsArgs({ piShard: true, piSubagentMaxTurns: 12, piNoPack: true, piSubagentModel: "shard-model", piSynthesisModel: "synthesis-model", piSubagentModels: { obfuscation: "one", exfiltration: "two" } })).toEqual([
      "--pi-subagent-model", "shard-model", "--pi-synthesis-model", "synthesis-model", "--pi-subagent-max-turns", "12", "--pi-shard", "--pi-no-pack", "--pi-subagent-models", "exfiltration=two,obfuscation=one",
    ]);
    expect(analysisOptionsArgs({ piMaxTurns: 30 })).toEqual(["--pi-max-turns", "30"]);
    expect(analysisOptionsArgs({ agenticMaxStepsPerDimension: 5 })).toEqual(["--agentic-max-steps-per-dimension", "5"]);
    expect(analysisOptionsArgs({ replay: false, enrich: false, forceFresh: false, useCache: true })).toEqual([]);
  });
});
