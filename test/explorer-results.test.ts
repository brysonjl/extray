import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { openDb, recordRun } from "../src/db/index.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";
import { createApp } from "../src/server/app.ts";
import { compareFindings, type ResultComparison, type ResultWorkbench } from "../src/product/result-workbench.ts";
import type { Finding } from "../src/product/dto.ts";

const STORE = "a".repeat(32);
let db: DatabaseSync, ds: SqliteDataSource, dir: string, sequence: number;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "explorer-results-")); db = openDb(join(dir, "test.sqlite")); ds = new SqliteDataSource(db); sequence = 0; });
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
const finding = (title: string, detail = "Source-grounded behavior", severity = "medium") => ({ id: title, title, detail, severity, confidence: "high", category: "network", kind: "verified-behavior", evidence_refs: [{ file: "background.js", location: { line: 3 }, sink_or_string: "fetch" }] });
function record(options: { store?: string; version?: string; model?: string; findings?: ReturnType<typeof finding>[]; incomplete?: boolean; source?: boolean; usage?: boolean } = {}) {
  const runId = recordRun(db, { kind: "assess", methodology: "pi", model: options.model ?? "custom-model", verifierModel: "separate-verifier", think: "high", mode: "RECORD", gitSha: "fixture-commit", headroom: true, subagentModels: { network: "network-model" }, startedAt: `2026-10-18T10:${String(sequence++).padStart(2, "0")}:00.000Z`, targets: [{
    storeId: options.store ?? STORE, name: "Workbench fixture", version: options.version ?? "1.0", sourceDir: options.source === false ? null : `fixture-${sequence}`, isCorpus: false,
    structured: { risk_report: { extension: { name: "Workbench fixture", version: options.version ?? "1.0", store_id: options.store ?? STORE }, verdict: { tier: "low-risk", rationale: "Fixture assessment" }, findings: options.findings ?? [], outcome: { artifact_generated: true, investigation: options.incomplete ? "incomplete" : "complete", final_submission: options.incomplete ? "not-accepted" : "accepted", reasons: options.incomplete ? ["Turn limit reached"] : [] } }, privateProviderResponse: { apiKey: "raw-provider-secret" } },
    ...(options.usage ? { usageByStep: [{ label: "investigate:network", model: "custom-model", inputTokens: 1200, outputTokens: 300, calls: 2, estimatedUsd: .12 }, { label: "verify:claim", model: "unpriced-model", inputTokens: 200, outputTokens: 30, calls: 1 }] } : {}),
  }] });
  const report = db.prepare("SELECT id,target_id FROM report WHERE run_id=?").get(runId)!;
  return { reportId: Number(report.id), runId, targetId: Number(report.target_id) };
}
function app(withSource = false) { return createApp({ ds, profile: DEFAULT_PROFILE, ...(withSource ? { sourceReader: (source: string) => `${source}\nline two\nreport-specific source` } : {}) }); }
function get(path: string, role = "admin", withSource = false) { return app(withSource).request(path, { headers: { "x-explorer-role": role } }); }
async function result(id: number, withSource = false): Promise<ResultWorkbench> { return (await get(`/api/results/${id}`, "admin", withSource)).json() as Promise<ResultWorkbench>; }

describe("exact-report workbench", () => {
  it("uses exact report identity with execution provenance, safe submitted settings and no raw artifacts", async () => {
    const old = record({ model: "custom-model", usage: true });
    record({ model: DEFAULT_PROFILE.pinned.model, version: "2.0" });
    db.prepare("INSERT INTO submission(input_raw,store_id,status,created_at,result_report_id,config_json) VALUES (?,?,?,?,?,?)").run(STORE, STORE, "succeeded", "2026-10-18", old.reportId, JSON.stringify({ version: 1, methodology: "pi", model: "custom-model", provider: { id: "ollama", apiKey: "never-export-secret" }, options: { verifierModel: "separate-verifier", piShard: true } }));
    const body = await result(old.reportId);
    expect(body).toMatchObject({ reportId: old.reportId, execution: { model: "custom-model", verifierModel: "separate-verifier", compressionProxy: true, modelAllocation: { network: "network-model" } }, detail: { identity: { version: "1.0" }, provenance: { reportId: old.reportId } }, submission: { configuration: { model: "custom-model", options: { piShard: true } } } });
    const wire = JSON.stringify(body);
    expect(wire).not.toContain("raw-provider-secret"); expect(wire).not.toContain("never-export-secret"); expect(wire).not.toContain("source_dir"); expect(wire).not.toContain("structured_json");
    const canonical = await (await get(`/api/extensions/${STORE}/result`)).json() as ResultWorkbench;
    expect(canonical.reportId).not.toBe(old.reportId);
  });
  it("compares only the chosen reports, preserving versions and investigation incompleteness", async () => {
    const left = record({ findings: [finding("Changed"), finding("Removed"), finding("Same")] });
    const right = record({ version: "2.0", incomplete: true, findings: [finding("Changed", "Different evidence interpretation", "high"), finding("Added"), finding("Same")] });
    const response = await get(`/api/results/compare?left=${left.reportId}&right=${right.reportId}`);
    expect(response.status).toBe(200);
    const body = await response.json() as ResultComparison;
    expect(body.counts).toEqual({ added: 1, removed: 1, changed: 1, unchanged: 1 });
    expect(body.differentVersion).toBe(true);
    expect(body.right.detail.outcome).toMatchObject({ investigation: "incomplete", final_submission: "not-accepted" });
    expect(body.findings.find((item) => item.change === "changed")?.after?.severity).toBe("high");
    expect(body.matching).toContain("not proof");
  });
  it("rejects cross-extension, same-report, missing, held and malformed comparisons", async () => {
    const a = record(), other = record({ store: "b".repeat(32) });
    expect((await get(`/api/results/compare?left=${a.reportId}&right=${other.reportId}`)).status).toBe(404);
    expect((await get(`/api/results/compare?left=${a.reportId}&right=${a.reportId}`)).status).toBe(400);
    expect((await get(`/api/results/compare?left=garbage&right=${a.reportId}`)).status).toBe(400);
    expect((await get(`/api/results/compare?left=9999&right=${a.reportId}`)).status).toBe(404);
    const hash = db.prepare("SELECT run_hash FROM run WHERE id=?").get(a.runId)!.run_hash;
    db.prepare("INSERT INTO ledger_event(kind,ts,detail) VALUES (?,?,?)").run("canonical_hold", "2026-10-18", JSON.stringify({ runHash: hash }));
    expect((await get(`/api/results/${a.reportId}`)).status).toBe(404);
    expect((await get(`/api/results/${a.reportId}/export`)).status).toBe(404);
  });
  it("enforces server admin role on metadata, comparison and every export format", async () => {
    const a = record(), b = record();
    const routes = [`/api/results/${a.reportId}`, `/api/extensions/${STORE}/result`, `/api/results/compare?left=${a.reportId}&right=${b.reportId}`, `/api/results/${a.reportId}/export?format=json`, `/api/results/${a.reportId}/export?format=markdown`];
    const locked = createApp({ ds, profile: DEFAULT_PROFILE, roleResolver: () => "user" });
    for (const route of routes) {
      expect((await get(route, "user")).status).toBe(404);
      expect((await locked.request(route, { headers: { "x-explorer-role": "admin" } })).status).toBe(404);
    }
  });
  it("keeps unpriced and shared-run accounting separate from report totals", async () => {
    const a = record({ usage: true });
    db.prepare("INSERT INTO usage(run_id,target_id,label,model,calls,estimated_usd) VALUES (?,NULL,?,?,?,?)").run(a.runId, "shared preparation", "shared-model", 1, .9);
    const body = await result(a.reportId);
    expect(body.usage.reportCostUsd).toBeNull();
    expect(body.usage.pricedStepsUsd).toBeCloseTo(.12);
    expect(body.usage.unpricedSteps).toBe(1);
    expect(body.usage.steps).toHaveLength(3);
    expect(body.usage.steps.find((step) => step.label === "shared preparation")?.scope).toBe("shared-run");
    expect(body.usage.steps.find((step) => step.label === "verify:claim")?.costUsd).toBeNull();
  });
  it("degrades historical configuration and missing accounting/source honestly", async () => {
    const a = record({ source: false });
    db.exec("DROP TABLE usage");
    const body = await result(a.reportId, true);
    expect(body.submission).toBeNull();
    expect(body.usage).toMatchObject({ available: false, steps: [], reportCostUsd: null });
    expect(body.artifacts.source).toBe("not-recorded");
    expect((await result(a.reportId)).artifacts.source).toBe("not-served");
    expect((await get(`/api/extensions/${STORE}/source?report=${a.reportId}&path=missing.js`, "admin", true)).status).toBe(404);
  });
  it("keeps evidence source tied to the selected report even when canonical selection changes", async () => {
    const a = record({ model: DEFAULT_PROFILE.pinned.model });
    const b = record({ model: DEFAULT_PROFILE.pinned.model });
    const source = await (await get(`/api/extensions/${STORE}/source?report=${a.reportId}&path=background.js&line=3`, "admin", true)).json() as { lines: string[] };
    expect(source.lines[0]).toBe("fixture-1");
    expect((await result(a.reportId, true)).artifacts.source).toBe("lookup-available");
    expect((await result(b.reportId)).detail.provenance.reportId).toBe(b.reportId);
  });
  it("exports sanitized exact report JSON and Markdown with bound citations and unknown prices", async () => {
    const a = record({ findings: [finding("<script>unsafe text</script>")], incomplete: true, usage: true });
    const jsonResponse = await get(`/api/results/${a.reportId}/export?format=json`);
    expect(jsonResponse.headers.get("content-disposition")).toContain(`extray-report-${a.reportId}.json`);
    expect(jsonResponse.headers.get("cache-control")).toContain("no-store");
    expect((await jsonResponse.json() as ResultWorkbench).reportId).toBe(a.reportId);
    const markdown = await (await get(`/api/results/${a.reportId}/export?format=markdown`)).text();
    expect(markdown).toContain(`Report ${a.reportId} · background.js:3`);
    expect(markdown).toContain("incomplete"); expect(markdown).toContain("unpriced"); expect(markdown).not.toContain("<script>"); expect(markdown).not.toContain("raw-provider-secret");
    expect((await get(`/api/results/${a.reportId}/export?format=html`)).status).toBe(400);
  });
  it("does not mistake reused ordinal finding IDs for semantic matches", () => {
    const a: Finding = { id: "f1", number: 1, severity: "high", confidence: "high", category: "network", kind: "behavior", title: "Exfiltration", detail: "One", claimedMechanism: null, evidence: [] };
    const b: Finding = { ...a, title: "Benign update", detail: "Two" };
    expect(compareFindings([a], [b]).map((difference) => difference.change)).toEqual(["removed", "added"]);
  });
});
