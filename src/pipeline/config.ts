// Layer-3 pass version + tunable heuristic config. Hashed into the cache key so
// that changing a threshold invalidates affected cache entries automatically.

import { createHash } from "node:crypto";

// "2": receiver normalization + intra-file alias resolution + network-indirect
// flagging (docs/reference/external_calls/, step 1).
// "3": importScripts, dynamic import(), WebRTC, navigation sinks (step 2).
// "4": destination constant-folding + unknown-destination emission (step 3).
// "5": shared callee normalization (browser.→chrome., document.location),
// await/.then taint sources, XHR/sendBeacon/location taint sinks, xhr-open
// destinations, executeScript code payloads, setTimeout(dynamic) (improvement 007).
// "6": call-accessor chrome globals (x().management.* → chrome.management.*) so
// minified webextension-polyfill bundles stop reporting used permissions as
// "unused"; network-sink argument summaries (improvement 010, 011).
export const LAYER3_PASS_VERSION = "6";

export const OBFUSCATION_THRESHOLDS = {
  hexIdRatio: 0.3,
  hexEscapeDensityPerKb: 20,
  maxLine: 1000,
  minStringArrayElements: 3,
};

export function layer3ConfigHash(): string {
  return createHash("sha256")
    .update(JSON.stringify({ pass: LAYER3_PASS_VERSION, obf: OBFUSCATION_THRESHOLDS }))
    .digest("hex")
    .slice(0, 16);
}
