// R2-backed SourceReader (deploy plan 2026-07-06-001, source-viewer follow-up):
// same refusal-reads-as-absence posture as the Node reader, exercised against a
// fake bucket, plus one end-to-end pass through the source endpoint to prove
// app.ts awaits an async reader.

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, recordRun } from "../src/db/index.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";
import { createApp } from "../src/server/app.ts";
import { r2SourceReader, type R2BucketLike } from "../src/server/source-r2.ts";

function fakeBucket(objects: Record<string, string>, log: string[] = []): R2BucketLike {
  return {
    async get(key) {
      log.push(key);
      const body = objects[key];
      if (body === undefined) return null;
      return { size: Buffer.byteLength(body), text: async () => body };
    },
  };
}

const DIR = "example_crxs/" + "a".repeat(32);

describe("r2SourceReader", () => {
  it("serves an object under an allowed root, keyed <source_dir>/<relPath>", async () => {
    const log: string[] = [];
    const read = r2SourceReader(fakeBucket({ [`${DIR}/js/bg.js`]: "fetch('x')" }, log));
    expect(await read(DIR, "js/bg.js")).toBe("fetch('x')");
    expect(log).toEqual([`${DIR}/js/bg.js`]);
  });

  it("missing object reads as null", async () => {
    const read = r2SourceReader(fakeBucket({}));
    expect(await read(DIR, "js/nope.js")).toBeNull();
  });

  it("oversized object reads as null", async () => {
    const bucket: R2BucketLike = {
      async get() {
        return { size: 10_000_001, text: async () => "never" };
      },
    };
    expect(await r2SourceReader(bucket)(DIR, "big.js")).toBeNull();
  });

  it("disallowed roots are refused without touching the bucket", async () => {
    const log: string[] = [];
    const read = r2SourceReader(fakeBucket({ "secrets/key.txt": "x" }, log));
    expect(await read("secrets", "key.txt")).toBeNull();
    expect(await read("example_crxs_evil", "a.js")).toBeNull();
    expect(await read("example_crxs/../secrets", "key.txt")).toBeNull();
    expect(await read(`${DIR}/`, "a.js")).toBeNull();
    expect(log).toEqual([]);
  });

  it("a throwing bucket reads as null", async () => {
    const bucket: R2BucketLike = {
      get(): never {
        throw new Error("r2 down");
      },
    };
    expect(await r2SourceReader(bucket)(DIR, "a.js")).toBeNull();
  });
});

describe("source endpoint with the async R2 reader", () => {
  it("serves a line window end-to-end (app.ts awaits the reader)", async () => {
    const storeId = "a".repeat(32);
    const db = openDb(join(mkdtempSync(join(tmpdir(), "explorer-r2-")), "test.sqlite"));
    recordRun(db, {
      kind: "assess",
      methodology: "pi",
      model: "glm-5.2:cloud",
      startedAt: "2026-07-01T00:00:00Z",
      targets: [
        {
          storeId,
          isCorpus: false,
          sourceDir: `example_crxs/${storeId}`,
          structured: {
            risk_report: {
              extension: { name: "E", version: "1", manifest_version: 3, store_id: storeId },
              verdict: { tier: "clean", rationale: "Fine.", per_area: [] },
              summaries: { layperson: "l", technical: "t" },
              findings: [],
              excluded_claims: [],
              permissions: { api: [], hosts: { required: [], optional: [] }, dangerous_combinations: [] },
              destinations: { rows: [], unresolved: [] },
              obfuscation: { flagged: [] },
              developer: { name: "d" },
              coverage: { unparsed_files: [], structural_limits: [] },
            },
          },
        },
      ],
    });
    const content = Array.from({ length: 300 }, (_, i) => `// line ${i + 1}`).join("\n");
    const app = createApp({
      ds: new SqliteDataSource(db),
      profile: DEFAULT_PROFILE,
      sourceReader: r2SourceReader(fakeBucket({ [`example_crxs/${storeId}/js/bg.js`]: content })),
    });

    const res = await app.request(`/api/extensions/${storeId}/source?path=js/bg.js&line=200`, {
      headers: { "x-explorer-role": "user" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { firstLine: number; lines: string[]; totalLines: number };
    expect(body.totalLines).toBe(300);
    expect(body.firstLine).toBe(140);
    expect(body.lines[200 - body.firstLine]).toBe("// line 200");
  });
});
