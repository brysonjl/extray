// A failed API bind must leave durable jobs and executor ownership untouched.
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db/index.ts";
import { claimNextSubmission, createSubmission } from "../src/jobs/service.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { resolveProfile } from "../src/product/profile.ts";

const SERVE = new URL("../scripts/serve.ts", import.meta.url);
const TSX = createRequire(import.meta.url).resolve("tsx");

describe("Explorer API startup", () => {
  it("reports a port conflict without recovering, claiming, or launching analyses", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "extray-serve-startup-"));
    const dbPath = join(cwd, "jobs.sqlite");
    const db = openDb(dbPath);
    const occupied = createServer();
    let child: ReturnType<typeof spawn> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const ds = new SqliteDataSource(db);
      const profile = resolveProfile();
      await createSubmission(ds, { inputRaw: "a".repeat(32), storeId: "a".repeat(32), profile });
      await claimNextSubmission(ds); // an interrupted job must also remain untouched
      await createSubmission(ds, { inputRaw: "b".repeat(32), storeId: "b".repeat(32), profile });
      const snapshot = () => ["submission", "analysis_attempt", "analysis_event", "runner_state"].map(
        (table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      );
      const before = snapshot();
      occupied.listen(0, "127.0.0.1");
      await once(occupied, "listening");
      const address = occupied.address();
      if (!address || typeof address === "string") throw new Error("missing test port");
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env)) {
        if (/^(EXTRAY_|EXPLORER_|SCORECARD_|OLLAMA_|OPENAI_|LLM_|NODE_OPTIONS$)/.test(key)) delete env[key];
      }
      Object.assign(env, { SKIP_DOTENV: "1", NODE_NO_WARNINGS: "1", EXTRAY_SETTINGS_PATH: join(cwd, "settings.json") });
      // Block both network access and analysis subprocesses even if startup regresses.
      const code = `
        import childProcess from "node:child_process";
        import { syncBuiltinESMExports } from "node:module";
        childProcess.spawn = () => { throw new Error("unexpected analysis launch during bind failure"); };
        syncBuiltinESMExports();
        globalThis.fetch = () => { throw new Error("unexpected network request during bind failure"); };
        process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(SERVE))}, "--db", ${JSON.stringify(dbPath)}, "--port", "${address.port}"];
        await import(${JSON.stringify(SERVE.href)});
      `;
      child = spawn(process.execPath, ["--import", TSX, "--input-type=module", "-e", code], {
        cwd, env, stdio: ["ignore", "pipe", "pipe"],
      });
      let logs = "";
      child.stdout!.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
      child.stderr!.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
      timer = setTimeout(() => child?.kill("SIGKILL"), 10_000);
      const [exitCode, signal] = await once(child, "close");
      expect({ exitCode, signal }, logs).toEqual({ exitCode: 1, signal: null });
      expect(logs).toContain(`Port ${address.port} is already in use on 127.0.0.1`);
      expect(logs).toContain("No queued analyses were started by this process.");
      expect(logs).not.toContain("Unhandled 'error' event");
      expect(logs).not.toContain("unexpected analysis launch");
      expect(logs).not.toContain("unexpected network request");
      expect(snapshot()).toEqual(before);
    } finally {
      clearTimeout(timer);
      if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (occupied.listening) await new Promise<void>((resolve) => occupied.close(() => resolve()));
      db.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
