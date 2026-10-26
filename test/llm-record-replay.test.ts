import { describe, it, expect } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlmClient } from "../src/llm/fake.ts";
import {
  RecordReplayClient,
  FixtureMissError,
  FixtureIntegrityError,
  fixtureKey,
  fixtureFileName,
  canonicalizeRequest,
} from "../src/llm/record-replay.ts";
import type { LlmRequest } from "../src/llm/client.ts";

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  label: "judge:must_detect",
  model: "test-model",
  prompt: "is the behavior asserted?",
  params: { temperature: 0 },
  ...over,
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "fixtures-"));
}

describe("RecordReplayClient", () => {
  it("RECORD writes a fixture that REPLAY then serves without touching the wrapped client", async () => {
    const dir = tmp();
    const live = new FakeLlmClient(() => "RECORDED ANSWER");
    const recorder = new RecordReplayClient({ mode: "RECORD", fixtureDir: dir, wrapped: live });
    const recorded = await recorder.complete(req());
    expect(recorded.text).toBe("RECORDED ANSWER");
    expect(live.calls.length).toBe(1);

    // A fresh REPLAY client with no wrapped client must still serve the fixture.
    const replay = new RecordReplayClient({ mode: "REPLAY", fixtureDir: dir });
    const served = await replay.complete(req());
    expect(served.text).toBe("RECORDED ANSWER");
    expect(replay.stats.hits).toBe(1);
  });

  it("RECORD is record-on-miss: an existing fixture is reused, not clobbered (idempotent)", async () => {
    const dir = tmp();
    const first = new FakeLlmClient(() => "FIRST GENERATION");
    await new RecordReplayClient({ mode: "RECORD", fixtureDir: dir, wrapped: first }).complete(req());

    // A second RECORD pass with the same key must reuse the fixture, NOT re-call.
    const second = new FakeLlmClient(() => "SECOND GENERATION");
    const recorder2 = new RecordReplayClient({ mode: "RECORD", fixtureDir: dir, wrapped: second });
    const got = await recorder2.complete(req());
    expect(got.text).toBe("FIRST GENERATION");
    expect(second.calls.length).toBe(0);
    expect(recorder2.stats.hits).toBe(1);
    expect(recorder2.stats.recorded).toBe(0);
  });

  it("REPLAY throws a loud, descriptive error on a fixture miss (never a live call)", async () => {
    const replay = new RecordReplayClient({ mode: "REPLAY", fixtureDir: tmp() });
    await expect(replay.complete(req())).rejects.toBeInstanceOf(FixtureMissError);
    await expect(replay.complete(req())).rejects.toThrow(/judge:must_detect/);
  });

  it("canonicalization: key ignores param key order but a changed prompt forces a new key", () => {
    const a = fixtureKey(req({ params: { temperature: 0, top_p: 1 } }));
    const b = fixtureKey(req({ params: { top_p: 1, temperature: 0 } }));
    expect(a).toBe(b); // key order does not change the hash

    const c = fixtureKey(req({ prompt: "a different prompt" }));
    expect(c).not.toBe(a); // prompt edit forces a re-record
  });

  it("canonicalizeRequest is stable across object key ordering", () => {
    expect(canonicalizeRequest(req({ params: { a: 1, b: 2 } }))).toBe(
      canonicalizeRequest(req({ params: { b: 2, a: 1 } })),
    );
  });

  it("canonicalization preserves literal prototype-named JSON parameters", () => {
    const params = JSON.parse('{"temperature":0,"__proto__":{"value":"test"}}');
    expect(fixtureKey(req({ params }))).not.toBe(fixtureKey(req()));
    expect(canonicalizeRequest(req({ params }))).toContain('"__proto__":{"value":"test"}');
  });

  it("RECORD mode requires a wrapped client", () => {
    expect(() => new RecordReplayClient({ mode: "RECORD", fixtureDir: tmp() })).toThrow(/requires a wrapped/);
  });

  it("fixtureFileName matches the file RECORD actually writes (error paths can name it)", async () => {
    const dir = tmp();
    await new RecordReplayClient({ mode: "RECORD", fixtureDir: dir, wrapped: new FakeLlmClient(() => "x") }).complete(req());
    expect(readdirSync(dir)).toEqual([fixtureFileName(req())]);
  });

  it("a run index in params changes the fixture key (distinct samples per --runs iteration)", () => {
    const base = fixtureKey(req());
    expect(fixtureKey(req({ params: { temperature: 0, run: 0 } }))).not.toBe(base);
    expect(fixtureKey(req({ params: { temperature: 0, run: 0 } }))).not.toBe(
      fixtureKey(req({ params: { temperature: 0, run: 1 } })),
    );
  });

  for (const mode of ["REPLAY", "RECORD"] as const) {
    it(`${mode} rejects a modified stored request instead of trusting the filename or calling live`, async () => {
      const dir = tmp();
      await new RecordReplayClient({ mode: "RECORD", fixtureDir: dir, wrapped: new FakeLlmClient(() => "original") }).complete(req());
      const path = join(dir, fixtureFileName(req()));
      const fixture = JSON.parse(readFileSync(path, "utf8"));
      fixture.request.prompt = "changed after recording";
      writeFileSync(path, JSON.stringify(fixture));
      const live = new FakeLlmClient(() => "must not be called");
      const client = new RecordReplayClient({ mode, fixtureDir: dir, wrapped: live });
      await expect(client.complete(req())).rejects.toBeInstanceOf(FixtureIntegrityError);
      expect(live.calls).toHaveLength(0);
      expect(readFileSync(path, "utf8")).toContain("changed after recording");
    });
  }

  it("rejects malformed response accounting without logging recorded content", async () => {
    const dir = tmp();
    await new RecordReplayClient({ mode: "RECORD", fixtureDir: dir, wrapped: new FakeLlmClient(() => "private response text") }).complete(req());
    const path = join(dir, fixtureFileName(req()));
    const fixture = JSON.parse(readFileSync(path, "utf8"));
    fixture.response.usage.inputTokens = -1;
    writeFileSync(path, JSON.stringify(fixture));
    const client = new RecordReplayClient({ mode: "REPLAY", fixtureDir: dir });
    await expect(client.complete(req())).rejects.toThrow(/invalid inputTokens/);
    await expect(client.complete(req())).rejects.not.toThrow(/private response text/);
  });
});

describe("FakeLlmClient", () => {
  it("serves canned replies by label and records calls", async () => {
    const fake = new FakeLlmClient({ "judge:must_detect": "satisfied" });
    const r = await fake.complete(req());
    expect(r.text).toBe("satisfied");
    expect(fake.calls[0]!.label).toBe("judge:must_detect");
  });

  it("throws when no canned reply exists for a label", async () => {
    const fake = new FakeLlmClient({ other: "x" });
    await expect(fake.complete(req())).rejects.toThrow(/no canned reply/);
  });
});
