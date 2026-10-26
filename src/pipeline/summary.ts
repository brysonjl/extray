// Rolls up summary_signals — a pointer list (not a verdict) the DAG's gating
// nodes consult. Appends to whatever Layer 2 already recorded (e.g. missing refs).

import type { EvidencePack } from "./schema.ts";

const VENDOR_RE = /(^|\/)(lib|vendor|node_modules)\//;

export function buildSummarySignals(pack: EvidencePack): void {
  const { high, medium, low } = pack.summary_signals;

  for (const c of pack.manifest_analysis.dangerous_combinations) {
    high.push({ kind: "dangerous-combination", detail: c.kind });
  }
  for (const s of pack.scripts) {
    if (s.obfuscation?.flagged && !VENDOR_RE.test(s.path)) {
      high.push({ kind: "obfuscation-flagged", path: s.path });
    }
    for (const t of s.taint_sketches) {
      // navigation: location assignments exfiltrate via the navigation URL.
      if (/network|code-exec|navigation/.test(t.classification)) {
        high.push({ kind: "data-flow", path: s.path, classification: t.classification });
      }
    }
  }

  // Tainted source reaching the publisher's own domain is the adjudicated-high
  // case (e.g. a merchant cookie sent to the extension's backend). `external`
  // flows are intentionally not promoted here — already covered by the taint
  // data-flow signal above, and not statically distinguishable from first-party
  // merchant-API calls (improvement 012).
  for (const f of pack.cross_file.data_flows ?? []) {
    if (f.dest_party === "first-party-extension") {
      high.push({ kind: "data-egress-to-publisher", path: f.file, source_kind: f.source_kind, dest_host: f.dest_host });
    }
  }

  for (const p of pack.cross_file.unused_permissions) medium.push({ kind: "unused-permission", permission: p });
  if (pack.manifest_analysis.externally_connectable?.wildcards) {
    medium.push({ kind: "external-surface", detail: "externally_connectable wildcard" });
  }

  for (const p of pack.cross_file.cannot_determine_statically ?? []) {
    low.push({ kind: "permission-undetermined", permission: p });
  }

  // External-call coverage: indirected calls defeat name-based detection and are
  // worth a closer look; opaque regions bound how complete the call surface is.
  const led = pack.external_call_ledger;
  for (const ic of led.indirect_calls) {
    medium.push({ kind: "indirect-external-call", path: ic.path, api: ic.api });
  }
  if (led.counts.opaque_regions > 0 || led.counts.unresolved_destinations > 0 || led.counts.unparsed_files > 0) {
    low.push({
      kind: "coverage-gap",
      opaque_regions: led.counts.opaque_regions,
      unresolved_destinations: led.counts.unresolved_destinations,
      unparsed_files: led.counts.unparsed_files,
    });
  }

  // Binary-asset abuse: bytes hidden after an image's end-of-image marker are
  // invisible to decoders (the file still renders) but readable at runtime via
  // fetch(getURL(...)).arrayBuffer(). On its own that is an oddity; when a
  // script also reads that exact asset by literal path, the pair is the
  // mechanism — so the correlated case is promoted to high. Only literal
  // getURL() arguments correlate; a computed path stays uncorrelated by design.
  const readByGetUrl = new Set<string>();
  for (const s2 of pack.scripts) {
    for (const sink of s2.sinks) {
      for (const m of String(sink.snippet ?? "").matchAll(/getURL\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        if (m[1]) readByGetUrl.add(m[1].replace(/^\.?\//, ""));
      }
    }
  }
  for (const f of pack.files) {
    const hidden = f.anomalies.find((a) => a.includes("end-of-image marker"));
    if (!hidden) continue;
    const read = readByGetUrl.has(f.path);
    (read ? high : medium).push({
      kind: read ? "binary-asset-read-as-data" : "binary-asset-hidden-bytes",
      path: f.path,
      detail: hidden,
      ...(read ? { read_via: "chrome.runtime.getURL" } : {}),
    });
  }

  // Declarative external resource loads (Gap 8): remote <script>/<iframe> are
  // higher signal (remote code / framing); other remote refs are surface to note.
  for (const h of pack.resources.html as Array<Record<string, unknown>>) {
    const refs = (h.remote_refs as Array<{ kind: string; url: string }> | undefined) ?? [];
    for (const r of refs) {
      const bucket = r.kind === "script.src" || r.kind === "iframe.src" ? high : medium;
      bucket.push({ kind: "remote-resource", path: h.path, ref_kind: r.kind, url: r.url });
    }
  }
}
