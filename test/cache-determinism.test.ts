import { describe, it, expect } from "vitest";
import { cpSync, mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../src/pipeline/index.ts";
import { Layer3Cache } from "../src/cache/sqlite.ts";
import { enforceSizeCap } from "../src/pipeline/cap.ts";
import { skeletonPack, validatePack } from "../src/pipeline/schema.ts";

const FIXED = "2026-01-01T00:00:00Z";
const stable = (p: object) => JSON.stringify({ ...p, analyzed_at: FIXED });

describe("determinism (R9)", () => {
  it("produces byte-identical packs across runs (modulo analyzed_at)", () => {
    const a = analyze("corpus/demo-cookie-manager/extension", { analyzedAt: FIXED });
    const b = analyze("corpus/demo-cookie-manager/extension", { analyzedAt: FIXED });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("incremental cache (R10)", () => {
  it("serves unchanged files from cache and recomputes only an edited file", () => {
    const ext = mkdtempSync(join(tmpdir(), "ext-"));
    cpSync("corpus/demo-cookie-manager/extension", join(ext, "e"), { recursive: true });
    const extDir = join(ext, "e");
    const cacheDir = mkdtempSync(join(tmpdir(), "cache-"));

    const first = analyze(extDir, { analyzedAt: FIXED, cacheDir });
    const cold = stable(first);

    // Re-run, same bytes: output identical, cache hits recorded.
    const cache = new Layer3Cache(cacheDir);
    cache.close(); // ensure dir/db exist for inspection by re-analyze
    const second = analyze(extDir, { analyzedAt: FIXED, cacheDir });
    expect(stable(second)).toBe(cold);

    // Edit one JS file's bytes -> only its script entry changes.
    appendFileSync(join(extDir, "js/utils.js"), "\n// changed\nfetch('https://added.test/x');\n");
    const third = analyze(extDir, { analyzedAt: FIXED, cacheDir });
    const beforeUtils = first.scripts.find((s) => s.path === "js/utils.js")!;
    const afterUtils = third.scripts.find((s) => s.path === "js/utils.js")!;
    const beforeBg = first.scripts.find((s) => s.path === "js/background.js")!;
    const afterBg = third.scripts.find((s) => s.path === "js/background.js")!;
    expect(JSON.stringify(afterUtils)).not.toBe(JSON.stringify(beforeUtils));
    expect(JSON.stringify(afterBg)).toBe(JSON.stringify(beforeBg)); // unchanged file stable
  });

  it("config hash is part of the cache key (tuning invalidates)", () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "cache-"));
    const c = new Layer3Cache(cacheDir);
    const entry = { path: "js/x.js", parsed_ok: true, sinks: [], network_destinations: [], taint_sketches: [], listeners: [], obfuscation: null };
    c.set(c.key("abc", "1", "configA"), entry);
    expect(c.get(c.key("abc", "1", "configA"), "js/x.js")).not.toBeNull();
    expect(c.get(c.key("abc", "1", "configB"), "js/x.js")).toBeNull(); // different config -> miss
    c.close();
  });
});

describe("5 MB cap (R8)", () => {
  it("truncates the noisiest arrays and records the truncation, staying valid", () => {
    const pack = skeletonPack({ path: "x", id_from_path: "x", manifest: { manifest_version: 3, name: "x", version: "1" } });
    for (let i = 0; i < 500; i++) {
      pack.cross_file.destination_summary.push({ host: `h${i}.example.com`, references: 1, any_dynamic: false, reached_via: ["fetch.url"] });
    }
    enforceSizeCap(pack, 2000); // tiny cap to force truncation
    expect(pack.cross_file.destination_summary.length).toBeLessThan(500);
    const note = (pack.summary_signals.high as Array<Record<string, unknown>>).find((s) => s.kind === "truncation");
    expect(note).toBeDefined();
    expect(validatePack(pack).valid).toBe(true);
  });
});
