// Builds the external-call soundness ledger from assembled Layer-3 facts.
// The ledger records where analysis is blind (obfuscated files, dynamically
// generated/eval'd code), calls reached through unresolved indirection, network
// destinations whose host could not be resolved, and files that failed to parse.
// It is what lets the risk report make a bounded coverage claim instead of
// silently omitting calls it could not see. See docs/reference/external_calls/.

import type { EvidencePack } from "./schema.ts";
import { isHardObfuscation } from "./obfuscation.ts";

const VENDOR_RE = /(^|\/)(lib|vendor|node_modules)\//;

// Code-exec APIs that execute dynamically built or remotely-loaded source: calls
// inside them are not visible to static analysis. (document.write / innerHTML are
// DOM injection, not remote code, and are excluded here.)
//
// import() is intentionally NOT here: MV3 forbids remote ES modules, so a bundled
// dynamic import resolves to a local chunk analysis can see — it is not a blind
// spot the way eval'd code is. Counting it (like literal-argument shims below)
// was pushing benign minified bundles over the "inconclusive" opacity threshold.
// setTimeout(dynamic)/setInterval(dynamic) are intentionally NOT here either:
// a dynamic FIRST ARG is overwhelmingly a function reference (`setTimeout(fn, 0)`,
// the normal deferred-call idiom), not eval'd source. Only the (string) forms —
// `setTimeout("code", 0)` — actually execute a string and are opaque. The
// dynamic-callback forms are still recorded as sinks for detection; they just do
// not count as static blind spots. (They remain in the taint/exfil analysis.)
const DYNAMIC_CODE_EXEC = new Set([
  "eval", "Function", "setTimeout(string)", "setInterval(string)",
  "importScripts",
  "chrome.scripting.executeScript(code)", "chrome.tabs.executeScript(code)",
]);

// A code-exec sink is only opaque when its executed argument is dynamic. A
// literal body — the ubiquitous webpack `new Function("return this")()` global
// shim — is fully visible source, so it is not a blind region. (011/016 capture
// arg0_kind precisely so this call site can consult it.)
function hasLiteralCodeArg(sink: { arguments_summary?: unknown[] }): boolean {
  const a = sink.arguments_summary?.[0] as { arg0_kind?: string } | undefined;
  return a?.arg0_kind === "literal";
}

// An opaque region is a place analysis is genuinely BLIND. Real concealment — a
// string-array decoder, a packer, or a dense run of hex/unicode escapes — hides
// behavior the parser cannot recover. Plain minification (the `flagged` boolean
// also trips on a >1000-char line) does NOT: the file parses, its sinks are
// extracted, it is fully visible. Counting every minified webpack chunk as
// opaque is what pushed benign bundle-heavy extensions past the >=3 opacity
// threshold into a spurious "inconclusive". Threshold mirrors config.ts.
export function buildExternalCallLedger(pack: EvidencePack): void {
  const led = pack.external_call_ledger;

  for (const s of pack.scripts) {
    if (!s.parsed_ok) led.unparsed_files.push(s.path);
    if (s.obfuscation && isHardObfuscation(s.obfuscation) && !VENDOR_RE.test(s.path)) {
      led.opaque_regions.push({ kind: "obfuscated", path: s.path });
    }
    const vendored = VENDOR_RE.test(s.path);
    for (const sink of s.sinks) {
      if (sink.category === "network-indirect") {
        led.indirect_calls.push({ path: s.path, api: sink.api, location: sink.location });
      } else if (DYNAMIC_CODE_EXEC.has(sink.api) && !hasLiteralCodeArg(sink) && !vendored) {
        // Skip literal-body shims and vendored-library code-exec: neither is a
        // blind spot (parity with the obfuscated-file branch above, which also
        // excludes VENDOR_RE). A dynamic-argument, first-party eval/Function
        // still records an opaque region.
        led.opaque_regions.push({ kind: "dynamic-code-exec", path: s.path, api: sink.api, location: sink.location });
      }
    }
    for (const d of s.network_destinations) {
      if (d.kind === "unknown") {
        led.unresolved_destinations.push({ path: s.path, ast_role: d.ast_role, location: d.location });
      }
    }
  }

  led.unparsed_files.sort();
  led.opaque_regions.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : (a.location?.line ?? 0) - (b.location?.line ?? 0)));
  led.indirect_calls.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.location.line - b.location.line));

  led.counts = {
    opaque_regions: led.opaque_regions.length,
    indirect_calls: led.indirect_calls.length,
    unresolved_destinations: led.unresolved_destinations.length,
    unparsed_files: led.unparsed_files.length,
  };
}
