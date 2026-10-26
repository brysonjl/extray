import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { normalizeContext } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPiRegistry, createConfinedPiSession } from "../src/methodologies/pi/runner.ts";

const modelId = "nvidia/synthetic-tool-model";
const hostedBaseUrl = "https://integrate.api.nvidia.com/v1";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** Feed the real SDK a tool call split across SSE chunks, then a final answer. */
function response(toolCall: boolean): Response {
  const chunk = (delta: unknown, finish_reason: string | null) => ({
    id: "offline-completion", object: "chat.completion.chunk", created: 1, model: modelId,
    choices: [{ index: 0, delta, finish_reason }],
  });
  const chunks = toolCall ? [
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_observation", type: "function",
      function: { name: "record_observation", arguments: '{"observation":' } }] }, null),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '"source checked"}' } }] }, null),
    chunk({}, "tool_calls"),
  ] : [chunk({ role: "assistant", content: "Investigation finished." }, null), chunk({}, "stop")];
  // NIM may include usage even when stream_options was omitted. Preserve it.
  const usage = { id: "offline-completion", object: "chat.completion.chunk", created: 1, model: modelId,
    choices: [], usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 } };
  return new Response([...chunks, usage].map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Pi NVIDIA request compatibility", () => {
  it.each([
    { provider: "nvidia", baseUrl: hostedBaseUrl, nvidia: true },
    { provider: "openai-compatible", baseUrl: hostedBaseUrl, nvidia: true },
    { provider: "openai-compatible", baseUrl: "https://custom.invalid/v1", nvidia: false },
  ])("round-trips streamed tool calls through $provider at $baseUrl", async ({ provider, baseUrl, nvidia }) => {
    const root = mkdtempSync(join(tmpdir(), "pi-nvidia-"));
    const requests: Array<{ url: string; headers: Headers; body: Record<string, any> }> = [];
    const execute = vi.fn(async (_id: string, _params: { observation: string }) => ({ content: [{ type: "text" as const, text: "Observation recorded." }], details: {} }));
    const tool = defineTool({
      name: "record_observation", label: "Record Observation", description: "Record a source observation.",
      parameters: Type.Object({ observation: Type.String() }), execute,
    });
    vi.stubEnv("PI_CACHE_RETENTION", "long");
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const req = new Request(input, init);
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(await req.text()) });
      if (requests.length > 2) throw new Error("Unexpected extra model request");
      return response(requests.length === 1);
    }));
    const { session } = await createConfinedPiSession(
      { provider, baseUrl, apiKey: "offline-nvidia-key" }, modelId, root, [tool], new Set(),
    );
    try {
      await session.prompt("Record that the source was checked, then finish.");
      expect(requests).toHaveLength(2);
      expect(execute).toHaveBeenCalledOnce();
      expect(execute.mock.calls[0]?.[1]).toEqual({ observation: "source checked" });
      for (const request of requests) {
        expect(request.url).toBe(`${baseUrl}/chat/completions`);
        expect(request.headers.get("authorization")).toBe("Bearer offline-nvidia-key");
        expect(request.body).toMatchObject({ model: modelId, stream: true });
        if (nvidia) {
          expect(request.body.max_tokens).toBe(8192);
          for (const key of ["max_completion_tokens", "store", "stream_options", "prompt_cache_key", "prompt_cache_retention", "reasoning_effort"]) {
            expect(request.body).not.toHaveProperty(key);
          }
          for (const tool of request.body.tools) expect(tool.function).not.toHaveProperty("strict");
          expect(request.body.messages.some((m: { role: string }) => m.role === "developer")).toBe(false);
        } else {
          expect(request.body).not.toHaveProperty("max_tokens");
          expect(request.body.max_completion_tokens).toBe(8192);
          expect(request.body.store).toBe(false);
          expect(request.body.stream_options).toEqual({ include_usage: true });
          // Pi 1.4 defaults unknown compatible endpoints to no strict-tool field.
          for (const tool of request.body.tools) expect(tool.function).not.toHaveProperty("strict");
        }
      }
      const history = requests[1]!.body.messages;
      expect(history).toContainEqual(expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({
        id: "call_observation", function: { name: "record_observation", arguments: '{"observation":"source checked"}' },
      })] }));
      expect(history).toContainEqual(expect.objectContaining({ role: "tool", tool_call_id: "call_observation", content: "Observation recorded." }));
      expect(session.getSessionStats().tokens).toMatchObject({ input: 22, output: 10 });
    } finally {
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves an explicit NVIDIA stream token cap", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-nvidia-cap-"));
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      body = JSON.parse(await new Request(input, init).text());
      return response(false);
    }));
    const { session } = await createConfinedPiSession(
      { provider: "nvidia", baseUrl: hostedBaseUrl, apiKey: "offline-nvidia-key" }, modelId, root, [], new Set(),
    );
    try {
      const stream = await session.agent.streamFunction(session.model!, normalizeContext({
        messages: [{ role: "user", content: "Finish.", timestamp: 1 }],
      }), { maxTokens: 321 });
      await stream.result();
      expect(body?.max_tokens).toBe(321);
      expect(body).not.toHaveProperty("max_completion_tokens");
    } finally {
      session.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not match an unrelated hostname containing NVIDIA's hostname", async () => {
    const { model } = await buildPiRegistry({ provider: "openai-compatible", baseUrl: "https://integrate.api.nvidia.com.other.invalid/v1", apiKey: "offline" }, modelId);
    expect(model.compat).toBeUndefined();
  });
});
