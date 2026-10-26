// Boots the dashboard server on an ephemeral port against a TEMP DB seeded via
// recordRun (mirroring test/db.test.ts) — never the real .out/bakeoff.sqlite,
// which may be empty in CI. Hits every endpoint and asserts HTTP 200 + shape.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openDb, recordRun, type RunInput } from "../src/db/index.ts";
import { createDashboardServer } from "../scripts/dashboard.ts";

const RISK_REPORT = {
  extension: { name: "Demo", version: "2.1", manifest_version: 3, store_id: "a".repeat(32) },
  verdict: { tier: "concerning", rationale: "broad host perms" },
  summaries: { layperson: "lay", technical: "tech" },
  findings: [
    { id: "f1", title: "exfil", kind: "verified-behavior", severity: "critical", category: "data-exfiltration", confidence: "high", claimed_mechanism: "reads cookies", detail: "d" },
  ],
  excluded_claims: [{ id: "f2", title: "maybe", reason: "needs-dynamic", detail: "d" }],
  dismissals: [{ concern: "obfuscation", checks_run: ["entropy scan of all scripts"], note: "No obfuscation or dynamic code execution found." }],
  permissions: {
    api: [
      {
        permission: "cookies",
        optional: false,
        status: "used",
        usage: [{ path: "bg.js", line: 3, api: "chrome.cookies.getAll" }],
        total_usage: 1,
        description: "Read and change the cookies stored for the sites you visit.",
        doc_url: "https://developer.chrome.com/docs/extensions/reference/api/cookies",
        install_warning: null,
        usage_plain: "Reads all your cookies (1 call site).",
      },
    ],
    hosts: { required: ["<all_urls>"], optional: [] },
    hosts_plain: "Can read and change your data on ALL websites you visit.",
    dangerous_combinations: [{ kind: "cookies+broad-host", evidence: ["cookies", "<all_urls>"] }],
  },
};

function assessInput(startedAt: string): RunInput {
  return {
    kind: "assess",
    methodology: "monolith",
    model: "test-model",
    mode: "REPLAY",
    startedAt,
    targets: [
      {
        storeId: "a".repeat(32),
        sourceDir: "/ext",
        isCorpus: false,
        report: "# the report text",
        structured: { risk_report: RISK_REPORT },
        usage: { inputTokens: 100, outputTokens: 50 },
        usageByStep: [{ label: "monolith", model: "test-model", calls: 1, inputTokens: 100, outputTokens: 50, estimatedUsd: 0.01 }],
        estimatedUsd: 0.01,
      },
    ],
  };
}

function scorecardInput(startedAt: string): RunInput {
  return {
    kind: "scorecard",
    methodology: "dag",
    model: "test-model",
    judgeModel: "judge-model",
    runs: 1,
    startedAt,
    targets: [{ sample: "mutant-a", isCorpus: true, labelKind: "malicious", expectedTier: "high-risk", tier: "high-risk", tierSource: "native" }],
    scorecard: {
      coverageKnownShapes: 0.78,
      coverageOpenWorld: 1,
      tierRecall: 1,
      unsafeMisses: 0,
      falseAlarmCount: 0,
      stability: "not measured (replay)",
      estimatedUsd: 0.02,
      samples: [{ sample: "mutant-a", labelKind: "malicious", expectedTier: "high-risk", normalizedTier: "high-risk", coverage: 1 }],
    },
  };
}

let baseUrl: string;
let server: ReturnType<typeof createDashboardServer>;
let reportId: number;

beforeAll(async () => {
  const path = join(mkdtempSync(join(tmpdir(), "dash-")), "db.sqlite");
  const db = openDb(path);
  recordRun(db, assessInput("2026-06-17T00:00:00Z"));
  recordRun(db, scorecardInput("2026-06-17T01:00:00Z"));
  reportId = (db.prepare("SELECT id FROM report ORDER BY id LIMIT 1").get() as { id: number }).id;
  db.close();

  server = createDashboardServer(path);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(baseUrl + path);
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

describe("dashboard server", () => {
  it("serves the HTML at /", async () => {
    const res = await fetch(baseUrl + "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Bake-off dashboard");
  });

  it("GET /api/meta returns distinct filter values", async () => {
    const { status, body } = await get("/api/meta");
    expect(status).toBe(200);
    expect(body.methodologies).toEqual(expect.arrayContaining(["monolith", "dag"]));
    expect(body.models).toContain("test-model");
    expect(body.kinds).toEqual(expect.arrayContaining(["assess", "scorecard"]));
    expect(body.tiers).toEqual(expect.arrayContaining(["high-risk", "clean"]));
    expect(body.severities).toContain("critical");
    expect(body.categories).toContain("data-exfiltration");
  });

  it("GET /api/performance returns one row per (methodology, model)", async () => {
    const { status, body } = await get("/api/performance");
    expect(status).toBe(200);
    expect(Array.isArray(body.rows)).toBe(true);
    const row = body.rows.find((r: any) => r.methodology === "dag");
    expect(row).toBeTruthy();
    expect(row.coverage_known_shapes).toBeCloseTo(0.78);
    expect(row.run_count).toBe(1);
  });

  it("GET /api/runs lists runs and filters by kind", async () => {
    const all = await get("/api/runs");
    expect(all.status).toBe(200);
    expect(all.body.rows.length).toBe(2);
    const filtered = await get("/api/runs?kind=scorecard");
    expect(filtered.body.rows.length).toBe(1);
    expect(filtered.body.rows[0].kind).toBe("scorecard");
    expect(filtered.body.rows[0].num_targets).toBe(1);
  });

  it("GET /api/runs carries the analyzed extension, tier, findings + token totals", async () => {
    const { body } = await get("/api/runs?kind=assess");
    const run = body.rows[0];
    expect(run.target_name).toBe("Demo"); // the single analyzed extension's name
    expect(run.tiers).toBe("concerning"); // verdict tier(s) for the run
    expect(run.num_findings).toBe(1); // asserted findings rolled up from reports
    expect(run.num_excluded).toBe(1);
    // tokens come from report.* (authoritative), not the sparse usage table.
    expect(run.input_tokens).toBe(100);
    expect(run.output_tokens).toBe(50);
    expect(run.finding_types).toBeTypeOf("object");
  });

  it("GET /api/rollup aggregates every run per (methodology, model)", async () => {
    const { status, body } = await get("/api/rollup");
    expect(status).toBe(200);
    // monolith assess + dag scorecard => two methodology×model groups.
    expect(body.rows.length).toBe(2);
    const mono = body.rows.find((r: any) => r.methodology === "monolith");
    expect(mono.num_runs).toBe(1);
    expect(mono.total_findings).toBe(1);
    expect(mono.input_tokens).toBe(100);
    expect(mono.tiers).toMatchObject({ concerning: 1 }); // per-tier verdict distribution
  });

  it("GET /api/pricing exposes the active rate card + a disclosure note", async () => {
    const { status, body } = await get("/api/pricing");
    expect(status).toBe(200);
    expect(body.rates["glm-5.2:cloud"]).toMatchObject({ input: 1.4, output: 4.4 });
    expect(body.note).toMatch(/per-token/i);
  });

  it("estimates cost from token counts at the rate card (test-model is unpriced)", async () => {
    // test-model has no rate, so priced_usd stays null (never a guessed $0).
    const runs = await get("/api/runs?kind=assess");
    expect(runs.body.rows[0].priced_usd).toBeNull();
    // A known model + tokens prices deterministically: 100/1e6*1.4 + 50/1e6*4.4.
    const path2 = join(mkdtempSync(join(tmpdir(), "dash2-")), "db.sqlite");
    const db2 = openDb(path2);
    const priced: RunInput = { ...assessInput("2026-06-18T00:00:00Z"), model: "glm-5.2:cloud" };
    // Two steps on DIFFERENT models: the detail view must price each usage row
    // at ITS OWN model, not the run's headline one.
    priced.targets[0]!.usageByStep = [
      { label: "monolith", model: "glm-5.2:cloud", calls: 1, inputTokens: 100, outputTokens: 50 },
      { label: "verify:claim", model: "test-model", calls: 1, inputTokens: 10, outputTokens: 5 },
    ];
    recordRun(db2, priced);
    // A priced scorecard run written WITHOUT estimated_usd: the performance view
    // falls back to pricing its stored token totals.
    recordRun(db2, {
      kind: "scorecard",
      methodology: "dag",
      model: "glm-5.2:cloud",
      startedAt: "2026-06-17T23:00:00Z",
      targets: [{ sample: "mutant-a", isCorpus: true }],
      scorecard: { coverageKnownShapes: 1, totalInputTokens: 1_000_000, totalOutputTokens: 100_000 },
    });
    db2.close();
    const srv2 = createDashboardServer(path2);
    await new Promise<void>((resolve) => srv2.listen(0, "127.0.0.1", resolve));
    const addr2 = srv2.address() as AddressInfo;
    const get2 = async (p: string) => (await (await fetch(`http://127.0.0.1:${addr2.port}${p}`)).json()) as any;
    const b = await get2("/api/runs?kind=assess");
    expect(b.rows[0].priced_usd).toBeCloseTo((100 / 1e6) * 1.4 + (50 / 1e6) * 4.4, 10);
    const perf = await get2("/api/performance");
    expect(perf.rows[0].priced_usd).toBeCloseTo(1.4 + 0.1 * 4.4, 10); // 1M in + 100k out at glm rates
    const reports = await get2("/api/reports?methodology=monolith");
    const detail = await get2("/api/report/" + reports.rows[0].id);
    const byLabel = Object.fromEntries(detail.usage.map((u: any) => [u.label, u.priced_usd]));
    expect(byLabel["monolith"]).toBeCloseTo((100 / 1e6) * 1.4 + (50 / 1e6) * 4.4, 10);
    expect(byLabel["verify:claim"]).toBeNull(); // test-model stays unpriced
    await new Promise<void>((resolve) => srv2.close(() => resolve()));
  });

  it("GET /api/extension returns identity, reports and a finding breakdown", async () => {
    const { status, body } = await get("/api/extension?store_id=" + "a".repeat(32));
    expect(status).toBe(200);
    expect(body.identity.name).toBe("Demo");
    expect(body.identity.num_runs).toBe(1);
    expect(Array.isArray(body.reports)).toBe(true);
    expect(body.reports[0]).toHaveProperty("methodology");
    expect(body.reports[0]).toHaveProperty("tier");
    expect(body.findingSummary.some((f: any) => f.severity === "critical")).toBe(true);
  });

  it("GET /api/extension 404s for an unknown identifier", async () => {
    const { status } = await get("/api/extension?store_id=nope");
    expect(status).toBe(404);
  });

  it("GET /api/extensions groups by identifier", async () => {
    const { status, body } = await get("/api/extensions");
    expect(status).toBe(200);
    expect(body.rows.length).toBe(2); // one store ext + one corpus sample
    const sample = body.rows.find((r: any) => r.identifier === "mutant-a");
    expect(sample.is_corpus).toBe(1);
    expect(sample.label_kind).toBe("malicious");
    // search narrows
    const search = await get("/api/extensions?q=mutant");
    expect(search.body.rows.length).toBe(1);
  });

  it("GET /api/reports joins run+target and filters", async () => {
    const { status, body } = await get("/api/reports");
    expect(status).toBe(200);
    expect(body.rows.length).toBe(2);
    expect(body.rows[0]).toHaveProperty("methodology");
    expect(body.rows[0]).toHaveProperty("tier");
    const byTier = await get("/api/reports?tier=high-risk");
    expect(byTier.body.rows.length).toBe(1);
  });

  it("GET /api/findings returns findings with context and filters", async () => {
    const { status, body } = await get("/api/findings");
    expect(status).toBe(200);
    expect(body.rows.length).toBeGreaterThanOrEqual(1);
    expect(body.rows[0]).toHaveProperty("methodology");
    const asserted = await get("/api/findings?verified=1&severity=critical");
    expect(asserted.body.rows.length).toBeGreaterThanOrEqual(1);
    expect(asserted.body.rows.every((f: any) => f.is_verified === 1)).toBe(true);
  });

  it("GET /api/report/:id returns full detail", async () => {
    const { status, body } = await get("/api/report/" + reportId);
    expect(status).toBe(200);
    expect(body.report).toHaveProperty("methodology");
    expect(body.report).toHaveProperty("report_text");
    expect(Array.isArray(body.findings)).toBe(true);
    expect(Array.isArray(body.usage)).toBe(true);
    // The structured permissions section is lifted out of risk_report_json for
    // the detail view, and the raw json column is not shipped.
    expect(body.permissions.api[0]).toMatchObject({
      permission: "cookies",
      doc_url: "https://developer.chrome.com/docs/extensions/reference/api/cookies",
      usage_plain: "Reads all your cookies (1 call site).",
    });
    // The checked-and-cleared dimensions are lifted too, so the detail view can
    // show a thorough benign run's negative results rather than reading as empty.
    expect(Array.isArray(body.dismissals)).toBe(true);
    expect(body.dismissals[0]).toMatchObject({ concern: "obfuscation" });
    expect(body.report).not.toHaveProperty("risk_report_json");
  });

  it("GET /api/report/:id 404s for an unknown id", async () => {
    const { status } = await get("/api/report/999999");
    expect(status).toBe(404);
  });

  it("rejects non-GET as read-only", async () => {
    const res = await fetch(baseUrl + "/api/meta", { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("parameterizes filters (no SQL injection)", async () => {
    const { status, body } = await get("/api/reports?tier=" + encodeURIComponent("' OR 1=1 --"));
    expect(status).toBe(200);
    expect(body.rows.length).toBe(0); // bound value matches nothing; not interpolated
  });
});
