// W2.3 — the cost preflight and the --max-tokens ceiling. The factors here are
// calibrated against measured bake-off runs, so the tests pin the calibration
// (an estimate that drifts away from the measurement is a silent regression)
// as well as the refusal behavior.

import { describe, it, expect } from "vitest";
import {
  ARM_COST_MODELS,
  BudgetedClient,
  CHARS_PER_TOKEN,
  CONFIRM_THRESHOLD_TOKENS,
  enforceBudget,
  estimatePreflight,
  needsConfirmation,
  renderPreflight,
  TokenBudgetError,
} from "../src/llm/preflight.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import type { LlmClient, LlmRequest, LlmResponse } from "../src/llm/client.ts";

// The corpus mutants' evidence packs are ~107k chars; both measurements the
// factors are calibrated against came from that size.
const PACK_CHARS = 107_645;

const preflight = (methodology: string, model = "glm-5.2:cloud") =>
  estimatePreflight({ methodology, model, packChars: PACK_CHARS, rates: { "glm-5.2:cloud": { input: 1.4, output: 4.4 } } });

describe("estimatePreflight", () => {
  it("reproduces the measured monolith run within its stated uncertainty", () => {
    const p = preflight("monolith");
    expect(p.packTokens).toBe(Math.ceil(PACK_CHARS / CHARS_PER_TOKEN));
    // Measured: 29,471 input tokens on this pack size (bake-off run #667).
    expect(p.estimatedInputTokens).toBeGreaterThan(29_471 / ARM_COST_MODELS.monolith!.uncertainty);
    expect(p.estimatedInputTokens).toBeLessThan(29_471 * ARM_COST_MODELS.monolith!.uncertainty);
  });

  it("reproduces the measured pi run within its stated uncertainty", () => {
    const p = preflight("pi");
    // Measured: 1,185,088 input tokens on this pack size (bake-off run #668).
    expect(p.estimatedInputTokens).toBeGreaterThan(1_185_088 / ARM_COST_MODELS.pi!.uncertainty);
    expect(p.estimatedInputTokens).toBeLessThan(1_185_088 * ARM_COST_MODELS.pi!.uncertainty);
  });

  it("prices the estimate when the model is in the rate table, and reports null when it is not", () => {
    expect(preflight("monolith").estimatedUsd).toBeGreaterThan(0);
    expect(estimatePreflight({ methodology: "pi", model: "mystery", packChars: PACK_CHARS }).estimatedUsd).toBeNull();
  });

  it("makes pi visibly more expensive than monolith — the reason the flag exists", () => {
    expect(preflight("pi").estimatedTotalTokens).toBeGreaterThan(preflight("monolith").estimatedTotalTokens * 10);
  });

  it("falls back to a deliberately wide model for an unknown arm rather than guessing low", () => {
    const p = preflight("some-future-arm");
    expect(p.basis).toMatch(/unknown arm/);
    expect(p.range[1] / p.range[0]).toBeGreaterThan(4);
  });

  it("marks pi as NOT mid-run enforceable, because it bypasses the LlmClient seam", () => {
    expect(preflight("pi").enforceable).toBe(false);
    expect(preflight("monolith").enforceable).toBe(true);
    expect(preflight("dag").enforceable).toBe(true);
  });
});

describe("renderPreflight", () => {
  it("shows the spend, the range, and the basis for the number", () => {
    const text = renderPreflight(preflight("monolith"));
    expect(text).toContain("cost preflight");
    expect(text).toMatch(/estimated spend/);
    expect(text).toMatch(/likely range/);
    expect(text).toMatch(/measured/);
  });

  it("states the pi limitation instead of implying a guarantee it cannot keep", () => {
    expect(renderPreflight(preflight("pi"))).toMatch(/cannot abort mid-session/);
  });
});

describe("enforceBudget", () => {
  it("is a no-op when no ceiling was set", () => {
    expect(() => enforceBudget(preflight("pi"), undefined)).not.toThrow();
  });

  it("refuses BEFORE any spend when the estimate already exceeds the ceiling", () => {
    expect(() => enforceBudget(preflight("pi"), 1000)).toThrow(TokenBudgetError);
    expect(() => enforceBudget(preflight("pi"), 1000)).toThrow(/nothing was spent/);
    // The message points at the cheaper arm rather than just failing.
    expect(() => enforceBudget(preflight("pi"), 1000)).toThrow(/--methodology monolith/);
  });

  it("allows a ceiling above the estimate", () => {
    expect(() => enforceBudget(preflight("monolith"), 10_000_000)).not.toThrow();
  });
});

describe("needsConfirmation", () => {
  it("asks for a pi-sized spend and stays out of the way for a monolith-sized one", () => {
    expect(needsConfirmation(preflight("pi"))).toBe(true);
    expect(needsConfirmation(preflight("monolith"))).toBe(false);
    expect(CONFIRM_THRESHOLD_TOKENS).toBeGreaterThan(preflight("monolith").estimatedTotalTokens);
  });
});

describe("BudgetedClient", () => {
  const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });

  /** A client whose every response reports a fixed cost. */
  const costing = (inputTokens: number, outputTokens: number): LlmClient => ({
    complete: async (_req: LlmRequest): Promise<LlmResponse> => ({ text: "ok", usage: usage(inputTokens, outputTokens) }),
  });

  const req: LlmRequest = { label: "monolith", model: "glm-5.2:cloud", prompt: "p" };

  it("passes calls through and accumulates their tokens", async () => {
    const client = new BudgetedClient(costing(100, 10), 1000);
    await client.complete(req);
    await client.complete(req);
    expect(client.used).toBe(220);
  });

  it("aborts before the NEXT call once the ceiling is crossed", async () => {
    let calls = 0;
    const wrapped: LlmClient = {
      complete: async () => {
        calls++;
        return { text: "ok", usage: usage(600, 0) };
      },
    };
    const client = new BudgetedClient(wrapped, 1000);
    await client.complete(req); // 600 — under
    await client.complete(req); // 1200 — over, but this call already happened
    await expect(client.complete(req)).rejects.toThrow(TokenBudgetError);
    expect(calls).toBe(2); // the third was never made
  });

  it("charges out-of-seam usage (the pi arm's own sessions) to the same ceiling", () => {
    const client = new BudgetedClient(new FakeLlmClient(() => "ok"), 1000);
    client.addExternal(1_200_000);
    expect(() => client.assertWithinBudget()).toThrow(/1,200,000 tokens used/);
  });

  it("names both the usage and the ceiling in the error, so the next run can be sized", async () => {
    const client = new BudgetedClient(costing(5000, 0), 1000);
    await client.complete(req);
    await expect(client.complete(req)).rejects.toThrow(/5,000 tokens used, --max-tokens is 1,000/);
  });
});
