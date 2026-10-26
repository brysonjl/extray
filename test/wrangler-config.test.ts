import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/db/index.ts";
import { SCHEMA_VERSION } from "../src/db/schema.ts";
import { wranglerArgs } from "../scripts/_wrangler.ts";

const root = resolve(import.meta.dirname, "..");
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// The real CLIs and their child processes run in an isolated working directory.
// Its only Wrangler executable is this offline stub; no Cloudflare CLI runs.
function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "extray-wrangler-config-"));
  dirs.push(dir);
  for (const name of ["node_modules/.bin", "scripts", ".out", "corpus/example"])
    mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, "scripts/package.json"), '{"type":"module"}');
  symlinkSync(join(root, "node_modules/tsx"), join(dir, "node_modules/tsx"), "dir");
  const dbPath = join(dir, ".out/catalog.sqlite");
  openDb(dbPath).close();
  const config = "private config/operator.jsonc";
  mkdirSync(dirname(join(dir, config)), { recursive: true });
  writeFileSync(join(dir, config), "{}");
  for (const script of ["export-d1.ts", "upload-source-r2.ts"]) {
    const source = join(root, "scripts", script);
    writeFileSync(join(dir, "scripts", script), `process.argv[1] = ${JSON.stringify(source)}; await import(${JSON.stringify(source)});`);
  }
  const logPath = join(dir, "wrangler-calls.jsonl");
  writeFileSync(join(dir, "node_modules/.bin/wrangler"), `#!/usr/bin/env node
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const kind = args.includes("r2") ? "r2" : args.includes("--json") ? "query" : value("--file")?.endsWith("progress.sql") ? "progress" : "catalog";
fs.appendFileSync(process.env.TEST_WRANGLER_LOG, JSON.stringify({ args, kind, inheritedConfig: process.env.EXTRAY_WRANGLER_CONFIG }) + "\\n");
if (!args.includes("--config") || value("--config") !== process.env.EXTRAY_WRANGLER_CONFIG) {
  console.error("private config was not forwarded"); process.exit(2);
}
if (!fs.existsSync(value("--config")) || process.env.TEST_WRANGLER_FAIL === kind) {
  console.error("selected Wrangler configuration cannot be loaded"); process.exit(1);
}
if (args.includes("--file") && !fs.existsSync(value("--file"))) {
  console.error("input file does not exist"); process.exit(2);
}
if (kind === "query") {
  const sql = value("--command");
  let results = [];
  if (sql.includes("schema_version")) results = [{ value: ${SCHEMA_VERSION} }];
  if (sql.includes("SELECT source_id")) {
    const db = new DatabaseSync(process.env.TEST_WRANGLER_DB, { readOnly: true });
    const source = db.prepare("SELECT value FROM runner_state WHERE key='progress_source_id'").get();
    if (source) results = [{ source_id: source.value }];
    db.close();
  }
  console.log(JSON.stringify([{ results }]));
}
`, { mode: 0o755 });
  const run = (script: string, args: string[], fail = "", selectedConfig = config, account = "") => spawnSync(
    process.execPath,
    ["--import", "tsx", join(root, "scripts", script), ...args],
    { cwd: dir, encoding: "utf8", timeout: 20_000, env: {
      ...process.env, SKIP_DOTENV: "1", CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: account,
      EXTRAY_WRANGLER_CONFIG: selectedConfig, TEST_WRANGLER_LOG: logPath,
      TEST_WRANGLER_DB: dbPath, TEST_WRANGLER_FAIL: fail,
    } },
  );
  const calls = () => readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as {
    args: string[]; kind: string; inheritedConfig: string;
  });
  return { dir, dbPath, config, run, calls };
}

function evidenceDatabase(dir: string): string {
  const evidenceDb = join(dir, ".out/evidence.sqlite");
  const db = new DatabaseSync(evidenceDb);
  db.exec(`CREATE TABLE target(id,source_dir,is_corpus,store_id);
    CREATE TABLE run(id,kind); CREATE TABLE report(id,run_id,target_id,risk_report_json);
    CREATE TABLE finding(report_id,evidence_json);
    INSERT INTO target VALUES(1,'corpus/example',0,'example'); INSERT INTO run VALUES(1,'assess');
    INSERT INTO report VALUES(1,1,1,'{}');
    INSERT INTO finding VALUES(1,'[{"file":"source.js"}]');`);
  db.close();
  writeFileSync(join(dir, "corpus/example/source.js"), "// evidence\n");
  return evidenceDb;
}

describe("private Wrangler configuration", () => {
  it("keeps default lookup when unset and reads the override at call time", () => {
    vi.stubEnv("EXTRAY_WRANGLER_CONFIG", undefined);
    const args = ["d1", "execute", "catalog", "--local"];
    expect(wranglerArgs(args)).toEqual(args);
    vi.stubEnv("EXTRAY_WRANGLER_CONFIG", "private config/production.jsonc");
    expect(wranglerArgs(args)).toEqual(["--config", "private config/production.jsonc", ...args]);
    expect(args).toEqual(["d1", "execute", "catalog", "--local"]);
  });

  it("forwards one config path through sync queries, catalog writes, and progress writes", () => {
    const w = workspace();
    const result = w.run("sync-explorer.ts", ["--remote", "--db", w.dbPath]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const calls = w.calls();
    expect(new Set(calls.map((call) => call.kind))).toEqual(new Set(["query", "catalog", "progress"]));
    for (const call of calls) {
      expect(call.args.slice(0, 2)).toEqual(["--config", w.config]);
      expect(call.inheritedConfig).toBe(w.config);
    }
  });

  it.each(["query", "catalog", "progress"])("stops after a selected config failure during %s without falling back", (kind) => {
    const w = workspace();
    const result = w.run("sync-explorer.ts", ["--remote", "--db", w.dbPath, "--skip-r2"], kind);
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("selected Wrangler configuration cannot be loaded");
    const calls = w.calls();
    expect(calls.at(-1)?.kind).toBe(kind);
    expect(calls.every((call) => call.args[0] === "--config" && call.args[1] === w.config)).toBe(true);
  });

  it("propagates a missing selected config error before attempting any D1 writes", () => {
    const w = workspace();
    const missing = "private config/missing.jsonc";
    const result = w.run("sync-explorer.ts", ["--remote", "--db", w.dbPath], "", missing);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("selected Wrangler configuration cannot be loaded");
    expect(w.calls()).toHaveLength(1);
    expect(w.calls()[0]?.args.slice(0, 2)).toEqual(["--config", missing]);
  });

  it.each([false, true])("forwards config to standalone R2 uploads and reports failure=%s", (fail) => {
    const w = workspace();
    const evidenceDb = evidenceDatabase(w.dir);
    const result = w.run("upload-source-r2.ts", ["--remote", "--db", evidenceDb], fail ? "r2" : "");
    expect(result.status, result.stdout + result.stderr).toBe(fail ? 1 : 0);
    const calls = w.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.slice(0, 2)).toEqual(["--config", w.config]);
    expect(calls[0]?.inheritedConfig).toBe(w.config);
    if (fail) expect(result.stderr).toContain("selected Wrangler configuration cannot be loaded");
  });

  it("caches only within the selected R2 target and never hides a missing config", () => {
    const w = workspace();
    const evidenceDb = evidenceDatabase(w.dir);
    const upload = (config = w.config, account = "") => {
      const result = w.run("upload-source-r2.ts", ["--remote", "--db", evidenceDb], "", config, account);
      expect(result.status, result.stdout + result.stderr).toBe(0);
      return result;
    };
    upload();
    expect(w.calls()).toHaveLength(1);
    expect(upload().stdout).toContain("1 unchanged");
    expect(w.calls()).toHaveLength(1);

    const otherConfig = "private config/other.jsonc";
    writeFileSync(join(w.dir, otherConfig), "{}");
    upload(otherConfig);
    expect(w.calls()).toHaveLength(2);
    writeFileSync(join(w.dir, otherConfig), '{"account_id":"another-account"}');
    upload(otherConfig);
    expect(w.calls()).toHaveLength(3);
    upload(otherConfig, "explicit-account");
    expect(w.calls()).toHaveLength(4);
    expect(upload(otherConfig, "explicit-account").stdout).toContain("1 unchanged");
    expect(w.calls()).toHaveLength(4);

    rmSync(join(w.dir, otherConfig));
    const missing = w.run("upload-source-r2.ts", ["--remote", "--db", evidenceDb], "", otherConfig, "explicit-account");
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("ENOENT");
    expect(w.calls()).toHaveLength(4);
  });
});
