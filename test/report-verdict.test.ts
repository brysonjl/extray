import { describe, it, expect } from "vitest";
import { computeVerdict, type VerdictSections } from "../src/report/verdict.ts";
import { STRUCTURAL_LIMITS, type Area, type AreaLevel, type ReportFinding } from "../src/report/contract.ts";
import type { Category, Severity } from "../src/methodologies/findings.ts";

function finding(over: Partial<ReportFinding> & { kind: ReportFinding["kind"]; severity: Severity; category: Category }): ReportFinding {
  return {
    number: 1,
    id: "f1",
    claim_type: over.kind === "verified-behavior" ? "inferred-behavior" : "observed-capability",
    title: "Finding",
    finding_type: "unknown",
    detail: "d",
    claimed_mechanism: null,
    confidence: "high",
    evidence_refs: [],
    verification: over.kind === "verified-behavior" ? { verdict: "confirmed", grounding: null, rationale: "", evidence_quote: null, corrections: [] } : null,
    ...over,
  };
}

function sections(over: Partial<VerdictSections> = {}): VerdictSections {
  return {
    permissions: { api: [], hosts: { required: [], optional: [] }, hosts_plain: "", dangerous_combinations: [] },
    destinations: { rows: [], unresolved: [] },
    obfuscation: { flagged: [], opaque_regions: [] },
    developer: {
      name: "Dev", email: null, website: "https://x.example", address: "1 St", country: null, is_trader: null,
      high_risk_country: null, update_url: null, non_store_update_url: false, sources: ["manifest"], listing_available: null, listing_fetched_at: null,
    },
    coverage: { opaque_regions: 0, indirect_calls: 0, unresolved_destinations: 0, unparsed_files: [], structural_limits: STRUCTURAL_LIMITS },
    ...over,
  };
}

const levelOf = (per: ReturnType<typeof computeVerdict>["per_area"], area: Area): AreaLevel => per.find((a) => a.area === area)!.level;

describe("computeVerdict — tier rollup", () => {
  it("high-risk requires a CONFIRMED high/critical behavior", () => {
    const v = computeVerdict([finding({ kind: "verified-behavior", severity: "high", category: "data-exfiltration" })], sections());
    expect(v.tier).toBe("high-risk");
    expect(v.rationale).toContain("confirmed against source");
  });

  it("a broad observed capability with a concern type is concerning, NOT high-risk (potential, not confirmed)", () => {
    const v = computeVerdict([finding({ kind: "observed-capability", severity: "high", category: "permissions", finding_type: "unwanted" })], sections());
    expect(v.tier).toBe("concerning");
  });

  it("corroboration gate: a broad observed capability with NO concern finding is low-risk (justified-broad)", () => {
    // finding_type defaults to 'unknown' — capability, not realized risk. GT
    // calibrates powerful-but-unjustified-on-paper capability as low-risk.
    const v = computeVerdict([finding({ kind: "observed-capability", severity: "high", category: "permissions" })], sections());
    expect(v.tier).toBe("low-risk");
    expect(v.rationale).toContain("corroborated");
  });

  it("an UNVERIFIED-but-asserted high claim cannot reach high-risk on its own", () => {
    // observed-capability critical code-exec typed as a concern → its area caps
    // at notable, and (unverified) it must not reach the high-risk floor; the
    // concern type corroborates so the tier is concerning.
    const v = computeVerdict([finding({ kind: "observed-capability", severity: "critical", category: "messaging-surface", finding_type: "unwanted" })], sections());
    expect(v.tier).toBe("concerning");
  });

  it("a confirmed medium behavior is concerning", () => {
    const v = computeVerdict([finding({ kind: "verified-behavior", severity: "medium", category: "messaging-surface" })], sections());
    expect(v.tier).toBe("concerning");
  });

  it("only low-severity signals → low-risk", () => {
    const v = computeVerdict(
      [finding({ kind: "observed-capability", severity: "low", category: "permissions" })],
      sections({ permissions: { api: [{ permission: "alarms", optional: false, status: "used", usage: [], total_usage: 0, description: "", doc_url: "", install_warning: null, usage_plain: "" }], hosts: { required: [], optional: [] }, hosts_plain: "", dangerous_combinations: [] } }),
    );
    expect(v.tier).toBe("low-risk");
  });

  it("nothing notable anywhere → clean", () => {
    expect(computeVerdict([], sections()).tier).toBe("clean");
  });

  it("corroboration gate: a dangerous permission combination ALONE (no concern finding) is low-risk, not concerning", () => {
    // A cookies+broad-host combo is capability, not realized risk. Without a
    // finding-backed concern GT calibrates this (cookie managers, ad blockers)
    // as low-risk. The area level still reflects the combo for the reader.
    const v = computeVerdict([], sections({ permissions: { api: [], hosts: { required: ["<all_urls>"], optional: [] }, hosts_plain: "", dangerous_combinations: [{ kind: "cookies+broad-host", evidence: [] }] } }));
    expect(v.tier).toBe("low-risk");
    expect(levelOf(v.per_area, "permissions")).toBe("high");
  });

  it("a verified risky-capability does NOT corroborate (self-labelled purpose-consistent) — stays low-risk", () => {
    // e.g. a screenshot tool's confirmed executeScript, or a volume booster's
    // tabCapture: verified-behavior, medium, but finding_type risky-capability.
    const v = computeVerdict(
      [finding({ kind: "verified-behavior", severity: "medium", category: "code-execution", finding_type: "risky-capability" })],
      sections({ permissions: { api: [], hosts: { required: ["<all_urls>"], optional: [] }, hosts_plain: "", dangerous_combinations: [{ kind: "scripting+broad-host", evidence: [] }] } }),
    );
    expect(v.tier).toBe("low-risk");
  });

  it("a verified UNWANTED behavior DOES corroborate — concerning", () => {
    const v = computeVerdict(
      [finding({ kind: "verified-behavior", severity: "medium", category: "data-exfiltration", finding_type: "unwanted" })],
      sections({ permissions: { api: [], hosts: { required: ["<all_urls>"], optional: [] }, hosts_plain: "", dangerous_combinations: [{ kind: "cookies+broad-host", evidence: [] }] } }),
    );
    expect(v.tier).toBe("concerning");
  });

  it("a dangerous combination WITH a corroborating concern finding is concerning", () => {
    const v = computeVerdict(
      [finding({ kind: "observed-capability", severity: "medium", category: "data-exfiltration", finding_type: "unwanted" })],
      sections({ permissions: { api: [], hosts: { required: ["<all_urls>"], optional: [] }, hosts_plain: "", dangerous_combinations: [{ kind: "cookies+broad-host", evidence: [] }] } }),
    );
    expect(v.tier).toBe("concerning");
  });

  it("heavy OPAQUE coverage gaps with no verified visibility → inconclusive", () => {
    const v = computeVerdict(
      [finding({ kind: "observed-capability", severity: "info", category: "obfuscation" })],
      sections({ coverage: { opaque_regions: 5, indirect_calls: 0, unresolved_destinations: 0, unparsed_files: ["a.js"], structural_limits: STRUCTURAL_LIMITS } }),
    );
    expect(v.tier).toBe("inconclusive");
  });

  it("unparsed minified libraries are NOT blindness — a clean extension with 3 unparsed files stays clean", () => {
    const v = computeVerdict(
      [],
      sections({ coverage: { opaque_regions: 0, indirect_calls: 0, unresolved_destinations: 0, unparsed_files: ["a.min.js", "b.min.js", "c.min.js"], structural_limits: STRUCTURAL_LIMITS } }),
    );
    expect(v.tier).toBe("clean");
  });

  it("a concrete HIGH area signal blocks inconclusive even under heavy obfuscation (we DID find something)", () => {
    const v = computeVerdict(
      [],
      sections({
        permissions: { api: [], hosts: { required: ["<all_urls>"], optional: [] }, hosts_plain: "", dangerous_combinations: [{ kind: "cookies+broad-host", evidence: [] }] },
        coverage: { opaque_regions: 9, indirect_calls: 0, unresolved_destinations: 0, unparsed_files: [], structural_limits: STRUCTURAL_LIMITS },
      }),
    );
    // permissions=high is a concrete signal, so NOT inconclusive; but with no
    // corroborating concern finding the corroboration gate calibrates it to
    // low-risk (capable-but-justified), not concerning.
    expect(v.tier).toBe("low-risk");
  });

  it("a confirmed behavior overrides coverage degradation (we DID see something)", () => {
    const v = computeVerdict(
      [finding({ kind: "verified-behavior", severity: "high", category: "data-exfiltration" })],
      sections({ coverage: { opaque_regions: 9, indirect_calls: 0, unresolved_destinations: 0, unparsed_files: [], structural_limits: STRUCTURAL_LIMITS } }),
    );
    expect(v.tier).toBe("high-risk");
  });

  // Remotely-hosted / dynamically-injected code judged a HIGH/CRITICAL concern
  // (The Great Suspender's owebanalytics remote code load, rated critical) —
  // high-risk even as an unconfirmed observed capability, because the remote
  // payload is unverifiable by design. The severity gate keeps every corpus
  // true positive (all carry a high/critical remote-code finding) while dropping
  // the benign medium/low vendor-eval + innerHTML findings the model types
  // "vulnerability".
  it("a high-severity remote-resources concern floors the tier at high-risk even unconfirmed", () => {
    const v = computeVerdict([finding({ kind: "observed-capability", severity: "high", category: "remote-resources", finding_type: "unwanted" })], sections());
    expect(v.tier).toBe("high-risk");
    expect(v.rationale).toContain("Remotely-hosted");
    expect(levelOf(v.per_area, "network")).toBe("high");
  });

  it("a critical code-execution concern (dynamically-injected remote script) floors at high-risk", () => {
    const v = computeVerdict([finding({ kind: "verified-behavior", severity: "critical", category: "code-execution", finding_type: "unwanted" })], sections());
    expect(v.tier).toBe("high-risk");
    expect(levelOf(v.per_area, "obfuscation")).toBe("high");
  });

  it("a MEDIUM remote/code-exec concern does NOT floor at high-risk (benign vendor-eval / innerHTML class)", () => {
    const v = computeVerdict([finding({ kind: "observed-capability", severity: "medium", category: "code-execution", finding_type: "vulnerability" })], sections());
    expect(v.tier).toBe("concerning"); // observed medium → notable area, not the high-risk floor
  });

  it("a remote-resources finding WITHOUT a concern type does NOT escalate (guards the .src mislabel class)", () => {
    // e.g. an img.src mislabeled as script.src, finding_type benign/unknown.
    // Neither the high-risk floor (needs a concern type) nor the corroboration
    // gate (needs a concern finding) fires → low-risk.
    const v = computeVerdict([finding({ kind: "observed-capability", severity: "medium", category: "remote-resources", finding_type: "unknown" })], sections());
    expect(v.tier).toBe("low-risk");
  });

  it("a benign code-execution capability (e.g. screenshot executeScript) does NOT escalate", () => {
    // risky-capability is 'consistent with a plausible stated purpose' — not a
    // concern finding, so the corroboration gate keeps it low-risk.
    const v = computeVerdict([finding({ kind: "observed-capability", severity: "medium", category: "code-execution", finding_type: "risky-capability" })], sections());
    expect(v.tier).toBe("low-risk");
  });
});

describe("computeVerdict — per-area levels reflect the built sections", () => {
  it("obfuscation flagged files → obfuscation notable", () => {
    const v = computeVerdict([], sections({ obfuscation: { flagged: [{ path: "a.js", identifier_entropy: 5, mean_identifier_length: 2, hex_escape_density_per_kb: 0, string_array_decoder_detected: true, packer_signature: null }], opaque_regions: [] } }));
    expect(levelOf(v.per_area, "obfuscation")).toBe("notable");
  });

  it("high-risk developer country → developer high", () => {
    const v = computeVerdict([], sections({ developer: { ...sections().developer, country: "RU", high_risk_country: true } }));
    expect(levelOf(v.per_area, "developer")).toBe("high");
    expect(v.tier).toBe("concerning"); // developer high alone is a notable+ driver
  });

  it("an unresolved destination alone is a coverage blind spot (low), not an affirmative network signal", () => {
    // A dynamically-built request URL the folder couldn't reduce to a literal —
    // ubiquitous in benign code. It must NOT alone push network to notable / the
    // extension to concerning; affirmative egress signals still do (tested above).
    const v = computeVerdict(
      [],
      sections({ destinations: { rows: [], unresolved: [{ path: "app.js", ast_role: "xhr-open", location: { line: 10 } }] } }),
    );
    expect(levelOf(v.per_area, "network")).toBe("low");
    expect(v.tier).toBe("low-risk");
    expect(v.per_area.find((a) => a.area === "network")!.note).toContain("1 unresolved destination");
  });

  it("a verified exfil finding drives the network area to high and cites the finding number", () => {
    const v = computeVerdict(
      [finding({ number: 3, kind: "verified-behavior", severity: "high", category: "data-exfiltration" })],
      sections({ destinations: { rows: [{ host: "evil.example", references: 1, any_dynamic: false, reached_via: ["fetch.url"], example_sites: [], party: "external" }], unresolved: [] } }),
    );
    expect(levelOf(v.per_area, "network")).toBe("high");
    expect(v.per_area.find((a) => a.area === "network")!.note).toContain("finding 3");
  });

  it("a code-execution finding drives obfuscation high and the note cites it, not the empty fallback", () => {
    // Regression: the obfuscation LEVEL is seeded from findings (code-execution /
    // supply-chain route into this area), but the note was built only from the
    // structural scanner (o.flagged / o.opaque_regions). A high code-execution
    // finding with an empty obfuscation section produced a red HIGH bar whose note
    // read "No obfuscation ... was flagged." — the bar and its note contradicted.
    const v = computeVerdict(
      [finding({ number: 4, kind: "observed-capability", severity: "high", category: "code-execution", finding_type: "malicious" })],
      sections(), // obfuscation: { flagged: [], opaque_regions: [] }
    );
    const obf = v.per_area.find((a) => a.area === "obfuscation")!;
    expect(obf.level).toBe("high");
    expect(obf.note).not.toBe("No obfuscation or dynamic code execution was flagged.");
    expect(obf.note).toContain("finding 4");
  });
});
