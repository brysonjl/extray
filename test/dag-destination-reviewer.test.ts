import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../src/pipeline/index.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { destinationReviewer } from "../src/methodologies/dag/nodes/destination-reviewer.ts";
import { runDag } from "../src/methodologies/dag/scheduler.ts";
import { buildDestinations } from "../src/report/build.ts";
import type { NodeContext } from "../src/methodologies/dag/node.ts";

const usage = { inputTokens: 33394, outputTokens: 65536, wallClockMs: 265608 };
let dir: string;
let context: Omit<NodeContext, "client">;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "destination-reviewer-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    manifest_version: 3, name: "Destination test", version: "1.0", background: { service_worker: "bg.js" },
  }));
  writeFileSync(join(dir, "bg.js"), 'fetch("https://first.example/data");\nfetch("https://second.example/data");\n');
  context = { pack: analyze(dir), sampleDir: dir, upstream: new Map(), listing: null, enrichment: null, model: "test-model", verifierModel: "test-verifier" };
  expect(buildDestinations(context.pack).rows.map((r) => r.host).sort()).toEqual(["first.example", "second.example"]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const host = (name: string, classification: string) => ({ host: name, classification, reasoning: "test rationale" });
const response = (...classifications: unknown[]) => JSON.stringify({ classifications });
async function run(text: string) {
  const client = new FakeLlmClient({ "dag:destination-reviewer": { text, usage } });
  const outputs = await runDag([destinationReviewer], { ...context, client });
  expect(client.calls).toHaveLength(1);
  return outputs.get(destinationReviewer.id)!;
}

describe("destination-reviewer response coverage", () => {
  it.each(["", "   ", "{}", "not JSON", response(), response(null), response(host("unrequested.example", "unknown"))])(
    "records unusable output as error without inventing checked destinations: %j", async (text) => {
      const result = await run(text);
      expect(result.status).toBe("error");
      expect(result.reason).toContain("0/2 requested hosts classified");
      expect(result.usage).toEqual(usage);
      expect(result.findings).toEqual([]);
      expect(result.verdicts).toEqual([]);
      expect(result.dismissals).toEqual([]);
    },
  );
  it.each([
    response(host("first.example", "suspicious")),
    response(host("first.example", "unknown"), host("second.example", "invalid")),
    response(host("first.example", "unknown"), host("first.example", "infrastructure")),
  ])("rejects partial coverage, including invalid or duplicate substitutes: %j", async (text) => {
    const result = await run(text);
    expect(result.status).toBe("error");
    expect(result.reason).toContain("1/2 requested hosts classified");
    expect(result.dismissals).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.usage).toEqual(usage);
  });
  it("allows explicit model unknown for every host in the documented wrapper", async () => {
    const result = await run(response(host("first.example", "unknown"), host("second.example", "unknown")));
    expect(result.status).toBe("ok");
    expect(result.dismissals).toHaveLength(2);
    expect(result.dismissals.every((d) => d.note === "unknown: test rationale")).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.usage).toEqual(usage);
  });
  it.each(["infrastructure", "expected-for-purpose"])("preserves grounded suspicious findings and %s dismissals in fenced JSON", async (classification) => {
    const result = await run('```json\n' + response(host("first.example", "suspicious"), host("second.example", classification)) + '\n```');
    expect(result.status).toBe("ok");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.evidence_refs[0]).toMatchObject({ file: "bg.js", location: { line: 1 }, sink_or_string: "first.example" });
    expect(result.dismissals).toHaveLength(1);
    expect(result.dismissals[0]!.note).toBe(`${classification}: test rationale`);
  });
  it("retains standalone host-object compatibility", async () => {
    const result = await run(JSON.stringify(host("first.example", "unknown")) + '\n' + JSON.stringify(host("second.example", "infrastructure")));
    expect(result.status).toBe("ok");
    expect(result.dismissals).toHaveLength(2);
  });
  it("does not fill gaps in the final wrapper from an earlier complete scratch answer", async () => {
    const result = await run(response(host("first.example", "unknown"), host("second.example", "unknown")) + '\n' + response(host("first.example", "unknown")));
    expect(result.status).toBe("error");
    expect(result.dismissals).toEqual([]);
  });
});
