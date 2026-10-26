import { createServer, type Server } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

let dir: string;
let server: Server;
let endpoint: string;
let requests = 0;
const payload = { summary: "Synthetic source inspected", findings: [], dismissals: ["exfiltration", "code-execution", "stated-purpose-deviation", "permission-justification", "obfuscation"].map((concern) => ({ concern, checks_run: ["source inspected"], note: "Synthetic test" })) };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "assess-outcome-"));
  mkdirSync(join(dir, "source"));
  writeFileSync(join(dir, "source", "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Synthetic analysis test", version: "1.0" }));
  const id = "b".repeat(32);
  mkdirSync(join(dir, "cached", id), { recursive: true });
  writeFileSync(join(dir, "cached", id, "manifest.json"), readFileSync(join(dir, "source", "manifest.json")));
  writeFileSync(join(dir, "cached", `${id}.developer-listing.json`), JSON.stringify({ extension_id: id, fetched_at: "2026-01-01", source: "unavailable" }));
  writeFileSync(join(dir, "ids.txt"), id + "\n");
  writeFileSync(join(dir, "adapter.mjs"), `export default { async complete(req) {
    const text = req.label === 'pi:critic' ? JSON.stringify({adequate: process.env.SYNTHETIC_ACCEPT === 'yes', gaps: process.env.SYNTHETIC_ACCEPT === 'yes' ? [] : ['synthetic unread file']}) : JSON.stringify({layperson_summary:'Synthetic summary',technical_summary:'Synthetic summary',description_deviation:{deviates:null,note:''}});
    return {text,usage:{inputTokens:7,outputTokens:3}};
  }};`);
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    expect(data.model).toBe("synthetic-offline");
    const id = `synthetic-${++requests}`;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: unknown, finish_reason: string | null, usage?: unknown) => `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: data.model, choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`;
    res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: "submit_findings", arguments: JSON.stringify(payload) } }] }, null));
    res.write(chunk({}, "tool_calls", { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(dir, { recursive: true, force: true }); });

function cli(accept: boolean, batch = false) {
  const out = join(dir, batch ? "batch" : accept ? "complete" : "partial");
  const db = join(dir, batch ? "batch.sqlite" : accept ? "complete.sqlite" : "partial.sqlite");
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/API_KEY|BASE_URL|LLM_ADAPTER|EXTRAY_LLM|OLLAMA_|HEADROOM/.test(key)) delete env[key];
  Object.assign(env, { SKIP_DOTENV: "1", EXTRAY_SETTINGS_PATH: join(dir, "no-settings.json"), OLLAMA_API_KEY: "offline",
    LLM_ADAPTER: join(dir, "adapter.mjs"), SYNTHETIC_ACCEPT: accept ? "yes" : "no", NODE_NO_WARNINGS: "1" });
  return new Promise<{ code: number | null; stdout: string; stderr: string; out: string; db: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/assess.ts", ...(batch ? ["--ids-file", join(dir, "ids.txt"), "--crx-out", join(dir, "cached")] : ["--dir", join(dir, "source")]), "--methodology", "pi", "--model", "synthetic-offline", "--provider", "openai-compatible", "--base-url", endpoint, "--out", out, "--fixtures", join(out, "fixtures"), "--db", db, "--yes"], { env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", reject); child.on("exit", (code) => resolve({ code, stdout, stderr, out, db }));
  });
}

describe("assess investigation bookkeeping with the real pi SDK and loopback model", () => {
  it("separates incomplete artifacts from complete entries and failures in batch summaries", async () => {
    const run = await cli(false, true);
    expect(run.code, run.stderr).toBe(6);
    expect(run.stdout).toContain("0 completed, 1 incomplete with artifacts, 0 failed");
    expect(run.stdout).toContain("INCOMPLETE");
  });
  it.each([true, false])("writes artifacts and reconciled DB usage, and exits by investigation completion (accepted: %s)", async (accept) => {
    const run = await cli(accept);
    expect(run.code, run.stderr).toBe(accept ? 0 : 6);
    expect(run.stdout).toContain("report written to");
    const output = JSON.parse(readFileSync(join(run.out, "source.json"), "utf8"));
    expect(output.outcome).toMatchObject({ artifact_generated: true, investigation: accept ? "complete" : "incomplete", final_submission: accept ? "accepted" : "not-accepted" });
    expect(output.structured.pi.uncovered_dimensions).toEqual([]);
    expect(run.stderr.includes("Incomplete investigation")).toBe(!accept);
    expect(readFileSync(join(run.out, "source.html"), "utf8").includes("Incomplete investigation")).toBe(!accept);
    const db = new DatabaseSync(run.db);
    const row = db.prepare("SELECT risk_report_json, structured_json, input_tokens, output_tokens FROM report").get()!;
    expect(JSON.parse(row.risk_report_json as string).outcome).toEqual(output.outcome);
    const usage = db.prepare("SELECT SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM usage").get()!;
    expect(usage.i).toBe(row.input_tokens); expect(usage.o).toBe(row.output_tokens);
    db.close();
    const comparison = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "scripts/compare-arms.ts", "--source-dir", join(dir, "source"), "--db", run.db], { encoding: "utf8", env: { ...process.env, SKIP_DOTENV: "1" } }));
    expect(comparison.arms[0].comparison_complete).toBe(accept);
    expect(comparison.arms[0].outcome).toEqual(output.outcome);
    if (!accept) expect(comparison.arms[0].tier_matches_truth).toBeNull();
  });
});
