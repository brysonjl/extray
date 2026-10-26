import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, recordRun, type RunInput } from "../src/db/index.ts";
import { providerProvenance, withProviderProvenance, type ProviderProvenance } from "../src/llm/provenance.ts";
import { loadAdapter } from "../scripts/_adapter.ts";
import { parse as parseYaml } from "yaml";

const SECRET = "provenance-test-secret";
const tempDirs: string[] = [];
const temporary = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "extray-provenance-"));
  tempDirs.push(dir);
  return dir;
};
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function input(): RunInput {
  return {
    kind: "assess", methodology: "monolith", model: "test-model", mode: "RECORD",
    startedAt: "2026-01-01T00:00:00Z", extra: { note: "preserved" },
    targets: [{ sample: "synthetic-provenance", isCorpus: true, report: "synthetic test report" }],
  };
}

describe("provider origin provenance", () => {
  it("constructs only id/origin, stripping credentials and secret-bearing query, fragment, and path", () => {
    const resolved = {
      id: "openai-compatible", baseUrl: `https://user:${SECRET}@provider.example:9443/${SECRET}/v1?api_key=${SECRET}#${SECRET}`,
      apiKey: SECRET,
    };
    const provider = providerProvenance(resolved);
    expect(provider).toEqual({ id: "openai-compatible", endpointOrigin: "https://provider.example:9443" });
    expect(JSON.stringify(provider)).not.toContain(SECRET);
    expect(JSON.stringify(provider)).not.toContain("user");
  });

  it.each([`not a URL ${SECRET}`, `file:///tmp/${SECRET}`, `ftp://provider.example/${SECRET}`, `javascript:${SECRET}`, "//provider.example/v1"])(
    "drops invalid or unsupported endpoint %s without retaining raw text", (baseUrl) => {
      expect(providerProvenance({ id: "openai-compatible", baseUrl })).toBeNull();
    },
  );

  it("supports local HTTP origins and keeps unknown provenance null", () => {
    expect(providerProvenance({ id: "openai-compatible", baseUrl: "http://127.0.0.1:8080/v1" })).toEqual({
      id: "openai-compatible", endpointOrigin: "http://127.0.0.1:8080",
    });
    expect(providerProvenance(null)).toBeNull();
  });

  it("merges metadata without mutating input or changing historical run identity", () => {
    const db = openDb(join(temporary(), "local.sqlite"));
    try {
      const original = input();
      recordRun(db, original);
      const before = db.prepare("SELECT run_hash FROM run").get() as { run_hash: string };
      const metadata = providerProvenance({ id: "ollama", baseUrl: "https://ollama.com/v1" });
      const withMetadata = withProviderProvenance(original, metadata);
      expect(original.extra).toEqual({ note: "preserved" });
      recordRun(db, withMetadata);
      const rows = db.prepare("SELECT run_hash, raw_json FROM run").all() as { run_hash: string; raw_json: string }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.run_hash).toBe(before.run_hash);
      expect(JSON.parse(rows[0]!.raw_json)).toEqual({ note: "preserved", provider: metadata });
      const origin = db.prepare("SELECT json_extract(raw_json, '$.provider.endpointOrigin') AS origin FROM run").get() as { origin: string };
      expect(origin.origin).toBe("https://ollama.com");
      recordRun(db, withProviderProvenance(original, null));
      expect(JSON.parse((db.prepare("SELECT raw_json FROM run").get() as { raw_json: string }).raw_json)).toEqual({ note: "preserved", provider: null });
    } finally { db.close(); }
  });

  it("keeps raw_json provenance out of the real D1 export without a schema change", () => {
    const dir = temporary();
    const dbPath = join(dir, "local.sqlite");
    const out = join(dir, "export.sql");
    const db = openDb(dbPath);
    try {
      recordRun(db, withProviderProvenance(input(), providerProvenance({
        id: "openai-compatible", baseUrl: `https://private-provider.example/${SECRET}?key=${SECRET}`,
      })));
      const raw = (db.prepare("SELECT raw_json FROM run").get() as { raw_json: string }).raw_json;
      expect(raw).toContain("private-provider.example");
      expect(raw).not.toContain(SECRET);
    } finally { db.close(); }
    execFileSync(process.execPath, [
      "--import", createRequire(import.meta.url).resolve("tsx"),
      fileURLToPath(new URL("../scripts/export-d1.ts", import.meta.url)), "--db", dbPath, "--out", out,
    ], { env: { ...process.env, SKIP_DOTENV: "1" }, timeout: 10_000, encoding: "utf8" });
    const sql = readFileSync(out, "utf8");
    expect(sql).toContain("synthetic-provenance");
    expect(sql).not.toContain("private-provider.example");
    expect(sql).not.toContain("endpointOrigin");
    expect(sql).not.toContain(SECRET);
  });
});

describe("actual adapter provenance capture", () => {
  it("captures the selected registry endpoint without calling a provider or serializing its API key", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("provenance capture must be offline"); });
    vi.stubEnv("LLM_ADAPTER", "");
    vi.stubEnv("EXTRAY_LLM_PROVIDER", "openai-compatible");
    vi.stubEnv("EXTRAY_LLM_BASE_URL", `https://provider.example/${SECRET}/v1?key=${SECRET}`);
    vi.stubEnv("EXTRAY_LLM_API_KEY", SECRET);
    let captured: ProviderProvenance | null | undefined;
    const client = await loadAdapter({}, (p) => { captured = p; });
    expect(typeof client.complete).toBe("function");
    expect(captured).toEqual({ id: "openai-compatible", endpointOrigin: "https://provider.example" });
    expect(JSON.stringify(captured)).not.toContain(SECRET);
  });

  it("keeps a custom adapter endpoint unknown instead of guessing from the environment", async () => {
    vi.stubGlobal("fetch", () => { throw new Error("provenance capture must be offline"); });
    const adapter = join(temporary(), "adapter.mjs");
    writeFileSync(adapter, "export default { complete() { throw new Error('must not call custom adapter'); } };\n");
    vi.stubEnv("LLM_ADAPTER", adapter);
    vi.stubEnv("EXTRAY_LLM_PROVIDER", "ollama");
    vi.stubEnv("OLLAMA_API_KEY", SECRET);
    let captured: ProviderProvenance | null | undefined;
    await loadAdapter({}, (p) => { captured = p; });
    expect(captured).toBeNull();
  });
});

describe("scorecard recording provenance", () => {
  it("records null for a real generation/verifier REPLAY even when provider credentials are configured", () => {
    const dir = temporary();
    const dbPath = join(dir, "replay.sqlite");
    // This regression tests provider provenance, not the benchmark's judge.
    // Keep a real committed benign sample and real generation/verifier replay,
    // but omit judge assertions in this isolated test corpus. Report schema
    // presentation changes (1.2 -> 1.3) invalidate judge prompt hashes even
    // when generation and source verification are byte-for-byte unchanged.
    // Never fabricate or relabel a cached judge response for a new request.
    const corpus = join(dir, "corpus");
    const sample = "demo-cookie-manager";
    cpSync(fileURLToPath(new URL(`../corpus/${sample}`, import.meta.url)), join(corpus, sample), { recursive: true });
    const labelPath = join(corpus, sample, "label.yaml");
    const label = parseYaml(readFileSync(labelPath, "utf8")) as Record<string, unknown>;
    writeFileSync(labelPath, JSON.stringify({ ...label, must_not_emit: [] }));
    const cli = new URL("../scripts/scorecard.ts", import.meta.url);
    const args = ["--methodology", "monolith", "--model", "glm-5.2:cloud", "--think", "high",
      "--verifier-model", "gpt-oss:120b", "--judge-model", "gpt-oss:120b", "--corpus", corpus, "--db", dbPath, "--out", join(dir, "scorecard")];
    const code = `globalThis.fetch = () => { throw new Error("REPLAY must not call providers"); }; process.execArgv = []; process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(cli))}, ...${JSON.stringify(args)}]; await import(${JSON.stringify(cli.href)});`;
    const logs = execFileSync(process.execPath, [
      "--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e", code,
    ], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { ...process.env, SKIP_DOTENV: "1", EXTRAY_LLM_PROVIDER: "openai-compatible",
        EXTRAY_LLM_BASE_URL: "https://unused-provider.example/v1", EXTRAY_LLM_API_KEY: SECRET },
      // Full-suite corpus passes share CPU; the replay must stay bounded while
      // allowing the same parallel-load headroom as other real pipeline tests.
      timeout: 60_000, encoding: "utf8",
    });
    expect(logs).not.toContain(SECRET);
    const db = openDb(dbPath);
    try {
      const row = db.prepare("SELECT mode, raw_json FROM run").get() as { mode: string; raw_json: string };
      expect(row.mode).toBe("REPLAY");
      expect(JSON.parse(row.raw_json)).toEqual({ provider: null });
      expect((db.prepare("SELECT COUNT(*) n FROM target WHERE sample = ?").get(sample) as { n: number }).n).toBe(1);
      expect((db.prepare("SELECT COUNT(*) n FROM usage").get() as { n: number }).n).toBeGreaterThan(0);
    } finally { db.close(); }
  }, 65_000);
});
