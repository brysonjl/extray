import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { analyze } from "../src/pipeline/index.ts";
import { describeSignals, groupFileAnomalies, renderStaticReportHtml } from "../src/report/render-static-html.ts";
import { skeletonPack, type EvidencePack, type FileEntry } from "../src/pipeline/schema.ts";

/** Minimal pack; tests override only the slice they exercise. */
function makePack(over: (p: EvidencePack) => void = () => {}): EvidencePack {
  const pack = skeletonPack({ path: "sample", id_from_path: "sample", manifest: { name: "Sample", version: "1.0.0", manifest_version: 3 } });
  pack.analyzed_at = "2026-01-01T00:00:00Z";
  pack.manifest_analysis.manifest_version = 3;
  over(pack);
  return pack;
}

function file(path: string, anomalies: string[]): FileEntry {
  return { path, size_bytes: 1, sha256: "x", type: "other", referenced_by: [], provenance: { known: false }, anomalies };
}

describe("describeSignals", () => {
  it("renders each known signal kind as a sentence, in high→medium→low order", () => {
    const pack = makePack((p) => {
      p.summary_signals.high.push({ kind: "dangerous-combination", detail: "cookies+broad-host" });
      p.summary_signals.high.push({
        kind: "binary-asset-read-as-data",
        path: "img/icon.png",
        detail: "56 bytes appended after the image/png end-of-image marker",
        read_via: "chrome.runtime.getURL",
      });
      p.summary_signals.medium.push({ kind: "unused-permission", permission: "alarms" });
      p.summary_signals.low.push({ kind: "coverage-gap", opaque_regions: 0, unresolved_destinations: 3, unparsed_files: 0 });
    });
    const lines = describeSignals(pack);
    expect(lines.map((l) => l.level)).toEqual(["high", "high", "medium", "low"]);
    expect(lines[0]!.text).toBe("Dangerous permission combination: cookies+broad-host.");
    expect(lines[1]!.text).toContain("bundled code reads that exact file via chrome.runtime.getURL");
    expect(lines[2]!.text).toContain("alarms is declared but no use of it was found");
    expect(lines[3]!.text).toContain("3 unresolved destination(s)");
  });

  // A signal kind this module has no phrase for must still reach the reader —
  // a stale phrase map is a wording bug, never a dropped signal.
  it("falls back to key=value for an unknown signal kind rather than dropping it", () => {
    const pack = makePack((p) => p.summary_signals.high.push({ kind: "some-future-signal", path: "a.js", weight: 7 }));
    const [line] = describeSignals(pack);
    expect(line!.kind).toBe("some-future-signal");
    expect(line!.text).toBe("path=a.js, weight=7");
  });
});

describe("groupFileAnomalies", () => {
  it("groups by class with notable classes first and every file counted", () => {
    const groups = groupFileAnomalies([
      file("_locales/en/messages.json", ["present but unreferenced from manifest, HTML, or JS imports"]),
      file("_locales/fr/messages.json", ["present but unreferenced from manifest, HTML, or JS imports"]),
      file("img/icon.png", ["56 bytes appended after the image/png end-of-image marker (hidden from decoders, readable at runtime)"]),
      file("a.min.css", ["very long line outside vendor path (possible minification)"]),
    ]);
    expect(groups.map((g) => g.id)).toEqual(["hidden-bytes", "long-line", "unreferenced"]);
    expect(groups[0]!.concern).toBe("notable");
    expect(groups[0]!.files).toEqual([
      { path: "img/icon.png", detail: "56 bytes appended after the image/png end-of-image marker (hidden from decoders, readable at runtime)" },
    ]);
    expect(groups[2]!.concern).toBe("context");
    expect(groups[2]!.files).toHaveLength(2);
  });

  it("buckets an unrecognised anomaly into 'other' instead of discarding it", () => {
    const groups = groupFileAnomalies([file("weird.bin", ["something the file layer learned to say later"])]);
    expect(groups.map((g) => g.id)).toEqual(["other"]);
  });
});

describe("renderStaticReportHtml", () => {
  it("is self-contained: no external assets and no scripts", () => {
    const html = renderStaticReportHtml(makePack());
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/src\s*=/i);
    // The only outbound hrefs are permission doc links on developer.chrome.com.
    for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
      expect(href).toMatch(/^https:\/\/developer\.chrome\.com\//);
    }
  });

  // The static pass sees capability, not intent. Presenting a tier here would
  // claim an adjudication no LLM ever made.
  it("presents no risk tier, score, or verdict", () => {
    const html = renderStaticReportHtml(makePack());
    expect(html).toContain("no risk score and no verdict");
    // (the shared stylesheet still *defines* .tier-badge; nothing may use it)
    expect(html).not.toContain('class="tier-badge"');
    expect(html).not.toMatch(/\b(high-risk|low-risk|Concerning|Inconclusive)\b/);
  });

  it("escapes attacker-controlled strings from the extension", () => {
    const pack = makePack((p) => {
      p.extension.manifest.name = '<img src=x onerror="alert(1)">';
      p.summary_signals.high.push({ kind: "missing-referenced-asset", path: "<script>alert(2)</script>" });
    });
    const html = renderStaticReportHtml(pack);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)");
    expect(html).toContain("&lt;script&gt;alert(2)");
  });

  // Improvement 018, fix 2: `flagged` is dominated by a line-length heuristic,
  // so a report that says "N obfuscated files" makes every bundled extension
  // look hostile. The report must separate minification from concealment.
  it("separates minification from real concealment in the obfuscation section", () => {
    const pack = makePack((p) => {
      p.scripts.push({
        path: "lib/jquery.min.js",
        parsed_ok: true,
        sinks: [],
        network_destinations: [],
        taint_sketches: [],
        listeners: [],
        obfuscation: {
          mean_identifier_length: 6.9,
          identifier_entropy: 4.2,
          hex_escape_density_per_kb: 0.14,
          string_array_decoder_detected: false,
          packer_signature: null,
          flagged: true,
        },
      });
      p.scripts.push({
        path: "js/packed.js",
        parsed_ok: true,
        sinks: [],
        network_destinations: [],
        taint_sketches: [],
        listeners: [],
        obfuscation: {
          mean_identifier_length: 1.4,
          identifier_entropy: 2.1,
          hex_escape_density_per_kb: 90,
          string_array_decoder_detected: true,
          packer_signature: null,
          flagged: true,
        },
      });
    });
    const html = renderStaticReportHtml(pack);
    expect(html).toContain("Obfuscation (2 flagged, 1 showing concealment)");
    expect(html).toContain("consistent with minification");
    expect(html).toContain("shows concealment");
  });

  // The enrichment column exists only when an artifact was committed beside the
  // extension. Absent, the report says so rather than looking clean or fetching.
  it("degrades gracefully with no host-enrichment artifact", () => {
    const html = renderStaticReportHtml(makePack());
    expect(html).toContain("No host-enrichment artifact was found");
  });
});

describe("renderStaticReportHtml against the committed mutant-i source", () => {
  // Evidence packs are ignored build output; a clean clone regenerates from
  // the shipped source so this test also covers the current static pipeline.
  const pack = analyze("corpus/mutant-i-png-steganography/extension", { analyzedAt: "2026-01-01T00:00:00Z" });
  const enrichment = JSON.parse(readFileSync("corpus/mutant-i-png-steganography/extension.host-enrichment.json", "utf8"));
  const html = renderStaticReportHtml(pack, { enrichment });

  // The whole point of the static report: the planted PNG payload must be
  // impossible to miss without an LLM in the loop (W1.1a).
  it("surfaces the binary-asset high signal and the PNG anomaly", () => {
    expect(html).toContain("binary-asset-read-as-data");
    expect(html).toContain("img/icon_128x128.png");
    expect(html).toContain("Bytes hidden after an image&#39;s end-of-image marker (1)");
    expect(html).toContain("chrome.runtime.getURL");
  });

  it("keeps fixture context in the standalone report beside the findings", () => {
    expect(html).toContain("Static analysis: ExtRay Demo Cookie Manager");
    expect(html).toContain("Synthetic test fixture");
    expect(html).toContain("Harmful behaviors in modified variants were deliberately introduced");
    expect(html).toContain("not to any published extension");
    expect(html).not.toContain("EditThisCookie");
  });

  // The exfil call is recorded as a `template` destination, so it never enters
  // external_call_ledger.unresolved_destinations (the W1.1 accounting gap). The
  // runtime-destination list is what keeps that visible to a reader.
  it("lists the runtime-assembled exfil destination the ledger does not count", () => {
    expect(html).toContain("Destinations assembled at runtime");
    expect(html).toContain("js/background.js:212");
  });

  it("collapses the unreferenced-file long tail instead of burying the report", () => {
    expect(html).toContain("Present but unreferenced from the manifest, HTML, or JS imports (94)");
    expect(html).toContain("and 89 more files");
  });

  it("renders RDAP context from the committed artifact", () => {
    expect(html).toContain("demo-cookies.example");
    expect(html).toContain("MarkMonitor Inc.");
    expect(html).toContain("Google LLC");
  });
});
