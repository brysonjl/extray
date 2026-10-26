// The known-good model table (W2.1). Model choice is a measured correctness
// variable here; the table's job is to make a weak model LOUD rather than to
// block it, so these tests pin the wording as much as the classification.

import { describe, it, expect, vi } from "vitest";
import { KNOWN_MODELS, lookupModel, modelAdvisory, modelFamily, modelStatus, renderModelTable, warnUntestedModel } from "../src/llm/model-table.ts";

describe("modelFamily", () => {
  it("strips the provider tag so one entry covers every way a family is addressed", () => {
    expect(modelFamily("glm-5.2:cloud")).toBe("glm-5.2");
    expect(modelFamily("glm-5.2")).toBe("glm-5.2");
    expect(modelFamily("gemma4:31b-cloud")).toBe("gemma4");
    expect(modelFamily("  QWEN3.5:Cloud ")).toBe("qwen3.5");
  });

  it("strips an OpenRouter-style vendor prefix", () => {
    expect(modelFamily("zhipu/glm-5.2")).toBe("glm-5.2");
  });
});

describe("modelStatus", () => {
  it("recommends the two models measured correct on the disclosure-gap test", () => {
    expect(modelStatus("glm-5.2:cloud")).toBe("recommended");
    expect(modelStatus("qwen3.5:cloud")).toBe("recommended");
  });

  it("cautions the three models measured to fail, including via a suffixed variant", () => {
    expect(modelStatus("minimax-m3:cloud")).toBe("caution");
    expect(modelStatus("gemma4:31b-cloud")).toBe("caution");
    // kimi ships as kimi-k2.7-code; the family prefix must still match.
    expect(modelStatus("kimi-k2.7-code:cloud")).toBe("caution");
    expect(lookupModel("kimi-k2.7-code")?.family).toBe("kimi-k2.7");
  });

  it("matches RECOMMENDED entries by exact model id, so a sibling size or variant is untested", () => {
    expect(modelStatus("glm-5.2:cloud")).toBe("recommended");
    expect(modelStatus("glm-5.2")).toBe("recommended");
    expect(modelStatus("glm-5.2:9b")).toBe("untested"); // a size tag is a different model
    expect(modelStatus("glm-5.2-flash")).toBe("untested");
    expect(modelStatus("qwen3.5:0.8b")).toBe("untested");
    expect(modelStatus("qwen3.5-mini")).toBe("untested");
  });

  it("treats anything unmeasured as untested", () => {
    expect(modelStatus("some-new-model:latest")).toBe("untested");
  });
});

describe("unavailable models", () => {
  it("marks qwen3.5 as gone from Ollama Cloud (verified 2026-10-03) but keeps its measurement", () => {
    const q = lookupModel("qwen3.5:cloud")!;
    expect(q.unavailable).toEqual({ provider: "ollama", since: "2026-10-03" });
    expect(q.note).toMatch(/disclosure-gap/);
  });

  it("never lists an unavailable model as Recommended in a warning or the help table", () => {
    const advisory = modelAdvisory("brand-new-model")!;
    expect(advisory).toMatch(/Recommended: glm-5\.2\./);
    expect(advisory).not.toMatch(/Recommended:[^.]*qwen3\.5/);
    expect(renderModelTable()).toMatch(/qwen3\.5.*no longer available on ollama/i);
  });
});

describe("modelAdvisory", () => {
  it("says nothing for a recommended model", () => {
    expect(modelAdvisory("glm-5.2:cloud")).toBeNull();
  });

  it("says nothing for the CLIs' placeholder model ids (there is no real model yet)", () => {
    expect(modelAdvisory("unspecified")).toBeNull();
    expect(modelAdvisory("")).toBeNull();
  });

  it("quotes what we measured for a caution model and recommends alternatives", () => {
    const advisory = modelAdvisory("minimax-m3")!;
    expect(advisory).toMatch(/LITERALLY NOTHING/);
    expect(advisory).toMatch(/not evidence of a clean extension/);
    expect(advisory).toMatch(/Recommended: glm-5\.2/);
  });

  it("warns loudly on an untested model and points at the eval harness", () => {
    const advisory = modelAdvisory("brand-new-model")!;
    expect(advisory).toMatch(/UNTESTED/);
    expect(advisory).toMatch(/npm run eval -- --model brand-new-model/);
  });
});

describe("warnUntestedModel", () => {
  it("writes the advisory to console.warn, and stays quiet for a recommended model", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnUntestedModel("glm-5.2:cloud");
    expect(warn).not.toHaveBeenCalled();
    warnUntestedModel("gemma4:31b-cloud");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("gemma4"));
    warn.mockRestore();
  });
});

describe("renderModelTable", () => {
  it("lists every measured model and states that anything else is untested", () => {
    const table = renderModelTable();
    for (const m of KNOWN_MODELS) expect(table).toContain(m.family);
    expect(table).toMatch(/UNTESTED/);
  });
});
