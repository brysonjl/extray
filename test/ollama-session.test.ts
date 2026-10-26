// The Ollama session pacer (scripts/_ollama-session.ts): rate-limit detection,
// the reset probe, wait-and-resume, the paced assess driver, and the rolling
// usage rollup. Network / processes / timers are all injected so these run
// instantly and deterministically.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatUsage,
  looksRateLimited,
  modelFromAssessArgs,
  probeSession,
  runAssessPaced,
  sessionUsageWindow,
  waitForSessionReset,
} from "../scripts/_ollama-session.ts";
import { openDb, recordRun } from "../src/db/index.ts";

describe("looksRateLimited", () => {
  it("matches provider rate-limit signatures", () => {
    expect(looksRateLimited("ollama-cloud: 429 Too Many Requests for model glm-5.2:cloud")).toBe(true);
    expect(looksRateLimited("Error: rate limit exceeded")).toBe(true);
    expect(looksRateLimited("RESOURCE_EXHAUSTED: quota")).toBe(true);
    expect(looksRateLimited("you are out of usage for this session")).toBe(true);
  });
  it("does not match ordinary failures", () => {
    expect(looksRateLimited("analyze: manifest.json is not valid JSON")).toBe(false);
    expect(looksRateLimited("download failed: HTTP 404")).toBe(false); // 404, not 429
    expect(looksRateLimited(null)).toBe(false);
  });
});

describe("modelFromAssessArgs", () => {
  it("reads the last --model (commander is last-wins)", () => {
    expect(modelFromAssessArgs(["--think", "high", "--model", "a", "--model", "glm-5.2:cloud"])).toBe("glm-5.2:cloud");
    expect(modelFromAssessArgs(["--think", "high"])).toBeUndefined();
  });
});

describe("probeSession", () => {
  const base = { model: "glm-5.2:cloud", apiKey: "k", host: "https://ollama.test" };
  it("returns ok on 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"message":{"content":"hi"}}', { status: 200 }));
    expect(await probeSession({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch })).toBe("ok");
  });
  it("returns limited on 429", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("rate limit", { status: 429 }));
    expect(await probeSession({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch })).toBe("limited");
  });
  it("returns limited on a 200 body carrying a quota error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{"error":"usage limit reached"}', { status: 200 }));
    expect(await probeSession({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch })).toBe("limited");
  });
  it("returns error on a network failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    expect(await probeSession({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch })).toBe("error");
  });
});

describe("waitForSessionReset", () => {
  it("polls until a probe reports capacity, then resolves", async () => {
    // limited, limited, ok
    const statuses = [429, 429, 200];
    let call = 0;
    const fetchImpl = vi.fn().mockImplementation(() => Promise.resolve(new Response("", { status: statuses[call++] })));
    const sleeps: number[] = [];
    await waitForSessionReset({
      model: "m",
      apiKey: "k",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      pollMs: 1000,
      sleep: async (ms) => void sleeps.push(ms),
      log: () => {},
    });
    expect(call).toBe(3); // probed three times
    expect(sleeps).toEqual([1000, 1000, 1000]); // slept before each probe
  });

  it("throws once maxWait elapses without a reset", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 429 }));
    let clock = 0;
    await expect(
      waitForSessionReset({
        model: "m",
        apiKey: "k",
        fetchImpl: fetchImpl as unknown as typeof fetch,
        pollMs: 1000,
        maxWaitMs: 2500,
        sleep: async (ms) => void (clock += ms),
        now: () => clock,
        log: () => {},
      }),
    ).rejects.toThrow(/did not reset/);
  });
});

describe("runAssessPaced", () => {
  it("returns immediately on success", async () => {
    const spawnImpl = vi.fn().mockResolvedValue({ code: 0, tail: "" });
    const res = await runAssessPaced("a".repeat(32), { assessArgs: ["--model", "m"], spawnImpl });
    expect(res.code).toBe(0);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it("passes non-rate-limit failures straight through (no wait)", async () => {
    const spawnImpl = vi.fn().mockResolvedValue({ code: 3, tail: "analyze: static analysis failed" });
    const waitImpl = vi.fn();
    const res = await runAssessPaced("a".repeat(32), { assessArgs: ["--model", "m"], spawnImpl, waitImpl });
    expect(res).toMatchObject({ code: 3, rateLimited: false });
    expect(waitImpl).not.toHaveBeenCalled();
  });

  it("waits then retries the SAME extension on a rate limit, succeeding on retry", async () => {
    const spawnImpl = vi
      .fn()
      .mockResolvedValueOnce({ code: 1, tail: "ollama-cloud: 429 Too Many Requests" })
      .mockResolvedValueOnce({ code: 0, tail: "" });
    const waitImpl = vi.fn().mockResolvedValue(undefined);
    const res = await runAssessPaced("b".repeat(32), { assessArgs: ["--model", "m"], spawnImpl, waitImpl, log: () => {} });
    expect(res.code).toBe(0);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(waitImpl).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxWaitCycles if it stays rate-limited", async () => {
    const spawnImpl = vi.fn().mockResolvedValue({ code: 1, tail: "429 rate limit" });
    const waitImpl = vi.fn().mockResolvedValue(undefined);
    const res = await runAssessPaced("c".repeat(32), {
      assessArgs: ["--model", "m"],
      spawnImpl,
      waitImpl,
      maxWaitCycles: 2,
      log: () => {},
    });
    expect(res.rateLimited).toBe(true);
    expect(waitImpl).toHaveBeenCalledTimes(2);
    expect(spawnImpl).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("treats exit code 5 as rate-limited even without a stderr signature", async () => {
    const spawnImpl = vi
      .fn()
      .mockResolvedValueOnce({ code: 5, tail: "assess: session exhausted" })
      .mockResolvedValueOnce({ code: 0, tail: "" });
    const waitImpl = vi.fn().mockResolvedValue(undefined);
    const res = await runAssessPaced("e".repeat(32), { assessArgs: ["--model", "m"], spawnImpl, waitImpl, log: () => {} });
    expect(res.code).toBe(0);
    expect(waitImpl).toHaveBeenCalledTimes(1);
  });

  it("does not wait when wait:false", async () => {
    const spawnImpl = vi.fn().mockResolvedValue({ code: 1, tail: "429" });
    const waitImpl = vi.fn();
    const res = await runAssessPaced("d".repeat(32), { assessArgs: ["--model", "m"], spawnImpl, waitImpl, wait: false });
    expect(res).toMatchObject({ code: 1, rateLimited: true });
    expect(waitImpl).not.toHaveBeenCalled();
  });
});

describe("sessionUsageWindow", () => {
  let dir: string;
  let dbPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ollama-usage-"));
    dbPath = join(dir, "bakeoff.sqlite");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function record(startedAt: string, wallMs: number, outTok: number): void {
    const db = openDb(dbPath);
    recordRun(db, {
      kind: "assess",
      methodology: "pi",
      model: "glm-5.2:cloud",
      startedAt,
      targets: [
        {
          isCorpus: false,
          storeId: "a".repeat(32),
          usage: { inputTokens: 100, outputTokens: outTok },
          usageByStep: [{ label: "gen", model: "glm-5.2:cloud", wallClockMs: wallMs, outputTokens: outTok }],
        },
      ],
    });
    db.close();
  }

  it("sums only runs inside the rolling window", () => {
    const now = Date.parse("2026-07-11T12:00:00.000Z");
    record("2026-07-11T11:00:00.000Z", 60_000, 500); // 1h ago — inside 5h window
    record("2026-07-11T09:30:00.000Z", 120_000, 700); // 2.5h ago — inside
    record("2026-07-11T04:00:00.000Z", 999_000, 900); // 8h ago — OUTSIDE

    const u = sessionUsageWindow(dbPath, 5, now);
    expect(u.runs).toBe(2);
    expect(u.analyses).toBe(2);
    expect(u.serverSeconds).toBe(180); // (60_000 + 120_000)/1000
    expect(u.outputTokens).toBe(1200);
    expect(formatUsage(u)).toContain("2 analyses");
    expect(formatUsage(u)).toContain("not Ollama's balance");
  });
});
