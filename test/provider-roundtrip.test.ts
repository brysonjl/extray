// W2.1 verification criterion: "a non-Ollama OpenAI-compatible base URL
// round-trips against a recorded fixture for both pi and monolith".
//
// monolith is exercised end-to-end here: a real arm run whose every model call
// goes over the generic /chat/completions adapter pointed at a base URL that is
// NOT ollama.com, recorded to fixtures, then replayed with no client at all.
//
// pi cannot be exercised the same way — it drives its own agent loop and is
// live-only by design (never record/replay), so the equivalent assertion for pi
// is that the same knobs resolve the same endpoint. That lives in
// llm-provider.test.ts; the piece verified here is that the provider seam hands
// pi and the LlmClient arms the identical resolution.

import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeCorpus } from "../scripts/analyze-corpus.ts";
import { createMonolith, type MonolithTrace } from "../src/methodologies/monolith.ts";
import { RecordReplayClient, FixtureMissError } from "../src/llm/record-replay.ts";
import { createOpenAiCompatibleClient } from "../src/llm/providers/openai-compatible.ts";
import { createProviderClient, resolveProvider } from "../src/llm/provider.ts";
import { resolveConnection } from "../src/methodologies/pi/runner.ts";

const BASE_URL = "https://llm.internal.example/v1";
const SAMPLE = "mutant-a-exfil-fetch";
const SAMPLE_DIR = `corpus/${SAMPLE}/extension`;

const pack = new Map(analyzeCorpus("corpus", { analyzedAt: "2026-01-01T00:00:00Z" }).map((r) => [r.sample, r.pack])).get(SAMPLE)!;

const FINDINGS_JSON = JSON.stringify({
  summary: "A cookie manager that also exfiltrates cookies.",
  overall_risk: "high",
  findings: [
    {
      id: "f1",
      title: "Cookie exfiltration to collect.evil-analytics-cdn.invalid",
      claim_type: "inferred-behavior",
      severity: "high",
      category: "data-exfiltration",
      confidence: "high",
      claimed_mechanism: "reads cookies and POSTs them to an external host",
      evidence_refs: [{ file: "js/background.js", location: null, symbol: null, sink_or_string: "fetch" }],
      detail: "cookies sent to collect.evil-analytics-cdn.invalid",
    },
  ],
});

const CONFIRMED_JSON = JSON.stringify({
  verdict: "confirmed",
  grounding_line: { file: "js/background.js", line: 30 },
  rationale: "the fetch call sends cookie data to the external host",
  evidence_quote: 'fetch("https://collect.evil-analytics-cdn.invalid", …)',
});

const SYNTHESIS_JSON = JSON.stringify({
  layperson_summary: "This extension manages cookies but also sends them to an outside server.",
  technical_summary: "Verified cookie exfiltration via fetch.",
  description_deviation: { deviates: true, note: "A cookie manager should not transmit cookie data externally." },
});

/**
 * A stand-in OpenAI-compatible server. It answers by which pass is asking
 * (the envelope tags are the discriminator), records the URLs it was called on,
 * and returns bodies in the /chat/completions shape — so the adapter's parsing,
 * not a fake, is what the arm consumes.
 */
function fakeEndpoint() {
  const urls: string[] = [];
  const sawJsonSchema = { value: false };
  const fetchImpl = (async (url: string | URL, init: RequestInit) => {
    urls.push(String(url));
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }>; response_format?: { type?: string; json_schema?: { name?: unknown; schema?: unknown } } };
    // OpenAI and compatible servers REJECT a json_schema response_format that is
    // not wrapped as { name, schema }, so the fake enforces it like they do.
    if (body.response_format?.type === "json_schema") {
      const js = body.response_format.json_schema;
      if (typeof js?.name !== "string" || typeof js.schema !== "object") {
        return new Response(JSON.stringify({ error: { message: "invalid response_format.json_schema: expected { name, schema }" } }), { status: 400 });
      }
      sawJsonSchema.value = true;
    }
    const prompt = body.messages[0]!.content;
    const content = prompt.includes("<source>") ? CONFIRMED_JSON : prompt.includes("<assessment_digest>") ? SYNTHESIS_JSON : FINDINGS_JSON;
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { urls, fetchImpl, sawJsonSchema };
}

afterEach(() => vi.unstubAllEnvs());

describe("monolith over a non-Ollama OpenAI-compatible endpoint", () => {
  it("records against the custom base URL, then replays with no provider at all", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "provider-rt-"));
    const endpoint = fakeEndpoint();

    const recorder = new RecordReplayClient({
      mode: "RECORD",
      fixtureDir,
      wrapped: createOpenAiCompatibleClient({ baseUrl: BASE_URL, apiKey: "k", fetchImpl: endpoint.fetchImpl }),
    });
    const recorded = await createMonolith("glm-5.2").run({ sampleDir: SAMPLE_DIR, pack }, recorder);

    // Every model call went to the custom endpoint, not to ollama.com.
    expect(endpoint.urls.length).toBeGreaterThanOrEqual(3);
    for (const url of endpoint.urls) expect(url).toBe(`${BASE_URL}/chat/completions`);
    // The monolith sends a schema-constrained format; the fake only accepts the wrapped shape.
    expect(endpoint.sawJsonSchema.value).toBe(true);
    expect(recorded.tier).toBe("high-risk");
    expect(recorded.report).toContain("collect.evil-analytics-cdn.invalid");
    // Usage came off the /v1 `usage` block, so cost accounting survives the hop.
    expect(recorded.usage.inputTokens).toBeGreaterThan(0);
    expect(readdirSync(fixtureDir).length).toBe(endpoint.urls.length);

    // REPLAY needs no wrapped client: the fixtures alone reproduce the run.
    const replayed = await createMonolith("glm-5.2").run({ sampleDir: SAMPLE_DIR, pack }, new RecordReplayClient({ mode: "REPLAY", fixtureDir }));
    expect(replayed.report).toBe(recorded.report);
    expect((replayed.structured as MonolithTrace).risk_report.verdict.tier).toBe("high-risk");
  });

  it("REPLAY off an empty fixture dir still misses loudly (the fixtures, not the endpoint, are the cache)", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "provider-rt-empty-"));
    await expect(createMonolith("glm-5.2").run({ sampleDir: SAMPLE_DIR, pack }, new RecordReplayClient({ mode: "REPLAY", fixtureDir }))).rejects.toThrow(
      FixtureMissError,
    );
  });

  it("createProviderClient builds that same adapter from the custom preset's env alone", async () => {
    vi.stubEnv("EXTRAY_LLM_PROVIDER", "openai-compatible");
    vi.stubEnv("EXTRAY_LLM_BASE_URL", BASE_URL);
    vi.stubEnv("EXTRAY_LLM_API_KEY", "k");
    const resolved = resolveProvider();
    expect(resolved.baseUrl).toBe(BASE_URL);
    expect(resolved.wire).toBe("openai-completions");
    // The client is constructible from config alone; it is not exercised here
    // (that would need a live endpoint) — the adapter itself is covered above.
    expect(typeof createProviderClient(resolved).complete).toBe("function");
    // …and pi is handed the very same endpoint by the very same env.
    expect(resolveConnection({})).toEqual({ provider: "openai-compatible", baseUrl: BASE_URL, apiKey: "k" });
  });
});
