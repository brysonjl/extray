import { describe, it, expect } from "vitest";
import { skeletonPack, type EvidencePack } from "../src/pipeline/schema.ts";
import { adjustFindingHarm, webMessageReachable } from "../src/report/harm-adjust.ts";
import type { ReportFinding } from "../src/report/contract.ts";
import type { Category, FindingType, Severity } from "../src/methodologies/findings.ts";

function pack(over: (p: EvidencePack) => void = () => {}): EvidencePack {
  const p = skeletonPack({ path: "x", id_from_path: "x", manifest: { manifest_version: 3, name: "x", version: "1" } });
  over(p);
  return p;
}

const finding = (over: Partial<ReportFinding> & { category: Category; finding_type: FindingType; severity: Severity }): ReportFinding => ({
  number: 1,
  id: "f1",
  kind: "observed-capability",
  claim_type: "observed-capability",
  title: "Finding",
  detail: "",
  claimed_mechanism: null,
  confidence: "high",
  evidence_refs: [],
  verification: null,
  ...over,
});

describe("adjustFindingHarm — Rule A (messaging reachability)", () => {
  it("downgrades an unvalidated-sender messaging vulnerability when there is no web-reachable surface", () => {
    const f = finding({ category: "messaging-surface", finding_type: "vulnerability", severity: "medium", title: "onMessage does not validate sender" });
    const { findings, notes } = adjustFindingHarm([f], pack()); // externally_connectable null by default
    expect(findings[0]!.severity).toBe("low");
    expect(findings[0]!.finding_type).toBe("risky-capability");
    expect(notes).toHaveLength(1);
  });

  it("KEEPS the finding when the extension is web-message-reachable (externally_connectable web origin)", () => {
    const p = pack((p) => { p.manifest_analysis.externally_connectable = { matches: ["https://*.example.com/*"] }; });
    expect(webMessageReachable(p)).toBe(true);
    const f = finding({ category: "messaging-surface", finding_type: "vulnerability", severity: "medium" });
    expect(adjustFindingHarm([f], p).findings[0]!.severity).toBe("medium");
  });

  it("does not touch a non-vulnerability messaging finding", () => {
    const f = finding({ category: "messaging-surface", finding_type: "risky-capability", severity: "medium" });
    expect(adjustFindingHarm([f], pack()).findings[0]!.severity).toBe("medium");
  });
});

describe("adjustFindingHarm — Rule B (first-party / known-analytics exfil)", () => {
  const withFlow = (host: string, party: "first-party-extension" | "external") =>
    pack((p) => { (p.cross_file as any).data_flows = [{ file: "bg.js", dest_host: host, dest_party: party }]; });

  it("downgrades data-exfiltration to a known analytics endpoint", () => {
    const f = finding({ category: "data-exfiltration", finding_type: "unwanted", severity: "medium", detail: "POSTs to https://www.google-analytics.com/mp/collect" });
    expect(adjustFindingHarm([f], pack()).findings[0]!.severity).toBe("low");
  });

  it("downgrades data-exfiltration whose only host is first-party", () => {
    const f = finding({ category: "data-exfiltration", finding_type: "unwanted", severity: "high", detail: "sends to https://api.myext.com/sync" });
    expect(adjustFindingHarm([f], withFlow("api.myext.com", "first-party-extension")).findings[0]!.severity).toBe("low");
  });

  it("KEEPS exfil to a non-allowlisted lookalike host (recall guard vs evil-analytics-cdn.com)", () => {
    const f = finding({ category: "data-exfiltration", finding_type: "unwanted", severity: "high", detail: "POSTs cookies to https://collect.evil-analytics-cdn.com/c" });
    expect(adjustFindingHarm([f], pack()).findings[0]!.severity).toBe("high");
  });

  it("KEEPS exfil when a host cannot be identified (fail-safe)", () => {
    const f = finding({ category: "data-exfiltration", finding_type: "unwanted", severity: "medium", detail: "exfiltrates cookies to a remote server" });
    expect(adjustFindingHarm([f], pack()).findings[0]!.severity).toBe("medium");
  });

  it("KEEPS exfil when one of several hosts is external/unknown", () => {
    const f = finding({ category: "data-exfiltration", finding_type: "unwanted", severity: "high", detail: "sends to https://www.google-analytics.com/collect and https://evil.example/x" });
    expect(adjustFindingHarm([f], pack()).findings[0]!.severity).toBe("high");
  });

  it("downgrades exfil to non-Google analytics on the strict allowlist (Mixpanel)", () => {
    const f = finding({ category: "data-exfiltration", finding_type: "unwanted", severity: "medium", detail: "POSTs events to https://api.mixpanel.com/track" });
    expect(adjustFindingHarm([f], pack()).findings[0]!.severity).toBe("low");
  });
});

describe("adjustFindingHarm — Rule C (DOM injection is not remote code)", () => {
  it("downgrades an innerHTML 'code-execution vulnerability'", () => {
    const f = finding({ category: "code-execution", finding_type: "vulnerability", severity: "medium", title: "Unsanitized innerHTML assignment in popup" });
    const { findings, notes } = adjustFindingHarm([f], pack());
    expect(findings[0]!.severity).toBe("low");
    expect(findings[0]!.finding_type).toBe("risky-capability");
    expect(notes).toHaveLength(1);
  });

  it("KEEPS a genuine eval/Function code-execution vulnerability", () => {
    const f = finding({ category: "code-execution", finding_type: "vulnerability", severity: "high", title: "Remote code execution via new Function(data.data)" });
    expect(adjustFindingHarm([f], pack()).findings[0]!.severity).toBe("high");
  });

  it("KEEPS an innerHTML finding that ALSO involves eval (real code-exec present)", () => {
    const f = finding({ category: "code-execution", finding_type: "vulnerability", severity: "high", title: "innerHTML sink", detail: "value is eval'd then written to innerHTML" });
    expect(adjustFindingHarm([f], pack()).findings[0]!.severity).toBe("high");
  });
});
