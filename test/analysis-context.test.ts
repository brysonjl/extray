import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { compactInventory, serializePackForPrompt } from "../src/methodologies/monolith.ts";
import { skeletonPack, type EvidencePack } from "../src/pipeline/schema.ts";
import { checkContext, ContextCapacityError } from "../src/llm/context.ts";
import { createOllamaCloudClient } from "../src/llm/providers/ollama-cloud.ts";

function pack(n: number) {
  const p = skeletonPack({ path: "/synthetic/label-hint", id_from_path: "secret-label", manifest: {} });
  p.files = Array.from({ length: n }, (_, i) => ({
    path: `rules/data-${i}.json`, size_bytes: i + 1,
    sha256: createHash("sha256").update(String(i)).digest("hex"), type: "json",
    referenced_by: i % 2 ? [] : ["manifest.json"], provenance: { known: false },
    anomalies: ["synthetic repeated diagnostic; retain every entry"],
  }));
  return p;
}

function decode(table: ReturnType<typeof compactInventory>) {
  return table.rows.map((row, i) => Object.fromEntries(table.columns.flatMap((key, j) => {
    if (table.present?.[i]?.[j] === "0") return [];
    const value = table.dictionaries[key] ? table.dictionaries[key]![row[j] as number] : row[j];
    return [[key, value]];
  })));
}

describe("large inventories and request context", () => {
  it("losslessly encodes a huge inventory with arbitrary fields, missing/null cells and repeated diagnostics", () => {
    const p = pack(13_305);
    const files = p.files as unknown as Record<string, unknown>[];
    files[0]!.future_field = { detail: "unknown evidence", values: [null, "λ\n\"\\"] };
    files[1]!.future_field = null;
    const before = JSON.stringify(p);
    const serialized = serializePackForPrompt(p);
    const data = JSON.parse(serialized);
    expect(decode(data.files)).toEqual(p.files);
    expect(serialized.length).toBeLessThan(before.length * 0.65);
    expect(data.prompt_representation).toContain("zero-based indices");
    expect(JSON.stringify(p)).toBe(before);
    expect(serialized).not.toContain("secret-label");
    expect(data.files.rows).toHaveLength(13_305);
    expect(data.files.columns).toContain("sha256");
    expect(serializePackForPrompt(p)).toBe(serialized);
  });

  it("leaves small historical packs as an ordinary inventory array", () => {
    expect(JSON.parse(serializePackForPrompt(pack(2))).files).toEqual(pack(2).files);
    expect(JSON.parse(serializePackForPrompt(pack(2)))).not.toHaveProperty("prompt_representation");
  });

  it("refuses the historical under-estimate shape, even with an oversized requested num_ctx", () => {
    const prompt = "a".repeat(3_769_971);
    expect(Math.ceil(prompt.length / 4)).toBeLessThan(1_048_576);
    expect(() => checkContext({ model: "deepseek-v4.1-flash", prompt, contextTokens: 2_000_000, outputReserve: 32_768 }))
      .toThrow(/estimated.*uncertain.*output reserve.*context 1048576/);
  });

  it("includes UTF-8 bytes, reserve and framing, and accepts an exact count only within capacity", () => {
    const base = { model: "synthetic", prompt: "λ".repeat(1000), contextTokens: 2000, outputReserve: 500 };
    expect(() => checkContext(base)).toThrow(ContextCapacityError);
    expect(checkContext({ ...base, exactInputTokens: 1500 }).exact).toBe(true);
    expect(() => checkContext({ ...base, exactInputTokens: 1501 })).toThrow(/tokenized/);
  });

  it("refuses oversized native requests before fetch or retry, with an actionable error", async () => {
    const fetchImpl = vi.fn();
    const client = createOllamaCloudClient({ apiKey: "offline", fetchImpl, numCtx: 1_000_000, retries: 3 });
    await expect(client.complete({ label: "huge", model: "deepseek-v4.1-flash", prompt: "f".repeat(3_769_971) }))
      .rejects.toThrow(/No request sent.*Preserve the evidence/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("forwards the reserved completion limit and clamps context to the observed model limit", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ message: { content: "{}" }, prompt_eval_count: 50, eval_count: 1 })));
    const client = createOllamaCloudClient({ apiKey: "offline", fetchImpl, numCtx: 2_000_000, outputReserve: 16_384 });
    await client.complete({ label: "small", model: "deepseek-v4.1-flash", prompt: "small" });
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.options).toMatchObject({ num_ctx: 1_048_576, num_predict: 16_384 });
    expect(body.messages[0].content).toBe("small");
  });
});
