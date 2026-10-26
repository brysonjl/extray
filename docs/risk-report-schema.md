# Risk Report Schema

`risk-report.json` is the output of the `risk-synthesizer` node. It is
the machine-readable verdict consumed by `user-facing-summary`,
`analyst-report`, and any future API surface. Like the evidence pack,
it is a versioned contract.

This document defines the schema, walks through a worked example, and
records the design tradeoffs.

The executable contract is [`src/report/contract.ts`](../src/report/contract.ts).
Version 1.2 adds optional `extension.fixture` context for locally designated
synthetic fixtures. HTML and Markdown exports display that context prominently;
JSON exports retain it alongside identity. It does not change a verdict or
enter investigator prompts. The older JSONC proposal below is illustrative.

## Design goals

- **Auditability.** Every finding traces back to (a) the specific
  evidence-pack facts it rests on and (b) the upstream node(s) that
  contributed the judgment. There is no orphaned conclusion.
- **Stable identifiers.** Findings, fact references, and nodes are
  addressable by stable IDs so downstream renderers and diffs across
  runs work.
- **Explicit unknowns.** Failed or skipped nodes are surfaced as
  first-class entries — a consumer can tell the difference between
  "we looked and found nothing" and "we never looked."
- **Positive findings supported.** When an LLM node dismisses a
  statically-flagged concern ("flagged dynamic `fetch`, but the only
  caller is a whitelist-bound update check"), that dismissal is a
  finding too, with its own evidence and contributing node.
- **Render-twice friendly.** The same JSON drives both a long-form
  analyst markdown report and a short non-technical summary. Two
  fields (`title`/`narrative_short` and `narrative`) split that load;
  no consumer should have to re-parse prose.
- **Honest about coverage.** The report distinguishes "we checked and
  found nothing" from "we never checked." Positive findings name the
  checks they rest on and the blind spots that could invalidate them;
  the verdict carries structured coverage so the user-facing summary
  can refuse to make clean claims when coverage is weak.

## Epistemic limits

Static analysis can confirm what code *does* contain; it can rarely
prove what code *does not* do. Several structural blind spots always
apply, regardless of how thoroughly the pipeline runs:

- **Library files are skipped from sink and taint analysis by default.**
  Hash-matched vendor libraries (jQuery, lodash, etc.) are excluded
  from Layer 3 to reduce noise. A network sink inside a library file
  is invisible unless `library-tamper-deep-dive` fires.
- **Taint sketches are shallow.** 1–3 hops backward through local
  bindings inside a single file. Cookie reads that get staged into
  `chrome.storage` and read by a different listener look unconnected.
  Cross-file flows (background read → content-script fetch via
  message passing) are not tracked.
- **Indirect sinks are partial.** `fetch`, `XMLHttpRequest`, and
  `WebSocket` are tracked as taint sinks; `Image.src`, redirects,
  `<a href>` clicks, `navigator.sendBeacon`, WebRTC data channels,
  and native messaging are catalogued but not necessarily linked into
  taint chains.
- **Dynamic code is opaque unless deobfuscated.** `eval`, `Function`
  constructors, runtime string assembly, and remote config fetches
  hide behavior from static review. `obfuscation-deobfuscator` is a
  best-effort recovery; its absence means dynamic dispatch is
  invisible.
- **Runtime state is invisible.** Remotely-fetched configuration,
  time-bombed activation, A/B-gated payloads — none of these are
  observable from the bundled code alone.

Consequence for the schema: a finding like *"no exfiltration found"*
is not a positive verdict — it is a scoped negative ("we ran checks
X, Y, Z and none fired"). Positive findings must carry
`coverage_caveats[]` naming the blind spots that apply, and the
`user-facing-summary` node must consult `verdict.coverage` before
surfacing them. The default for the non-technical summary is to
*not* render positive findings unless coverage is strong, to avoid
false reassurance.

## Schema (JSONC)

```jsonc
{
  // Contract version. Breaking changes bump major.
  "schema_version": "1.0",

  // Versions of the producing system. Useful for cache invalidation
  // and for diffing reports across analyzer revisions.
  "analyzer_version": "0.1.0",
  "synthesizer_node_version": "1.0",
  "synthesizer_model_id": "claude-sonnet-4-6",

  // Pointer back to the inputs this report was synthesized from.
  // The evidence pack is referenced by content hash so a report can
  // be re-verified against its source.
  "inputs": {
    "evidence_pack": {
      "schema_version": "1.0",
      "analyzer_version": "0.1.0",
      "sha256": "<hex>"
    },
    "node_outputs_dir": "node-outputs/"  // relative path, optional
  },

  "analyzed_at": "2026-05-22T14:03:17Z",

  // Quick identification — duplicated from the evidence pack so a
  // report is self-describing without forcing a join.
  "extension": {
    "id_from_path": "demo-cookie-manager",
    "name": "ExtRay Demo Cookie Manager",
    "version": "1.0.0",
    "manifest_version": 3
  },

  // High-level verdict. Computed by the synthesizer from the
  // distribution of finding severities. Deliberately coarse.
  "verdict": {
    // overall: "clean" | "low-risk" | "concerning" | "high-risk" | "inconclusive"
    // "inconclusive" is used when too many critical nodes failed.
    "overall": "concerning",

    // One-sentence headline. Safe for the user-facing summary.
    "headline": "Reads cookies on every site you visit; we did not find evidence of exfiltration, but the broad access remains.",

    // Severity counts across `findings[]`. Computed, but included so
    // downstream renderers don't have to re-tally.
    "counts": {
      "critical": 0,
      "high": 1,
      "medium": 2,
      "low": 1,
      "info": 3,
      "positive": 1   // dismissals / "we looked and it's fine"
    },

    // True iff any node in `node_status[].status == "error"` AND the
    // failed node is on the critical path for the verdict (defined
    // per-node in the DAG spec). Consumers should warn the user.
    "coverage_degraded": false,

    // Structured coverage. Positive findings and the user-facing
    // summary must consult this before making clean claims. The
    // `structural_limits` list is constant across runs (it reflects
    // pipeline design) and is duplicated here so a single report is
    // self-describing without forcing a join against the analyzer
    // version.
    "coverage": {
      // Node invocations that ran to completion. Format: `node_id`
      // or `node_id:fan_out_key`.
      "checks_completed": [
        "risk-classifier",
        "library-provenance-checker",
        "permission-justification:cookies",
        "destination-summary-reviewer"
      ],
      // Gated-out nodes. Skipping is normal but it is also a blind
      // spot — a skipped `taint-flow-reviewer` means no LLM ever
      // looked at flows.
      "checks_skipped": [
        { "node_id": "obfuscation-deobfuscator",
          "reason": "no scripts flagged as obfuscated" }
      ],
      // Node failures. These are the dangerous gaps — the gate
      // fired, the node was supposed to run, and it didn't.
      "checks_failed": [
        { "node_id": "taint-flow-reviewer",
          "reason": "model_timeout after 60s" }
      ],
      // Always-applicable blind spots of the pipeline itself. See
      // the Epistemic limits section above for the canonical list.
      // Duplicated into every report so consumers don't need to
      // resolve against the analyzer version.
      "structural_limits": [
        "library files skipped from sink/taint analysis by default",
        "taint sketches limited to 1-3 hops within a single file",
        "no cross-file data-flow tracking",
        "dynamic code (eval, Function, runtime string assembly) opaque unless deobfuscator fires",
        "remotely-fetched configuration and runtime state not observable"
      ]
    }
  },

  // Lifecycle status of every node in the DAG that was expected to
  // run. The synthesizer uses this to (a) surface unevaluated
  // questions and (b) gate its own confidence. Even successful nodes
  // appear here so a consumer can render coverage at a glance.
  "node_status": [
    {
      "node_id": "risk-classifier",
      "node_version": "1.0",
      "status": "ok",                  // "ok" | "skipped" | "error" | "timeout"
      "skipped_reason": null,          // e.g. "gate condition not met"
      "error": null,                   // {message, kind} when status="error"
      "duration_ms": 14,
      "output_ref": "node-outputs/risk-classifier.json"
    },
    {
      "node_id": "permission-justification",
      "fan_out_key": "cookies",        // present iff the node spec fans out
      "status": "ok",
      "output_ref": "node-outputs/permission-justification.cookies.json"
    },
    {
      "node_id": "obfuscation-deobfuscator",
      "status": "skipped",
      "skipped_reason": "no scripts flagged as obfuscated",
      "output_ref": null
    },
    {
      "node_id": "taint-flow-reviewer",
      "status": "error",
      "error": {
        "kind": "model_timeout",
        "message": "model invocation exceeded 60s budget"
      },
      "output_ref": null
    }
    // ... one entry per planned node invocation
  ],

  // The ranked findings list. Order is significant: synthesizer
  // emits in descending order of (severity, confidence). Stable
  // within ties.
  "findings": [
    {
      // Stable within a single run. Format: `F-<short-hash>` so the
      // same logical finding produced from the same inputs has the
      // same ID across re-runs (helpful for diffing).
      "id": "F-7c3a91",

      // "critical" | "high" | "medium" | "low" | "info" | "positive"
      // "positive" is reserved for explicit dismissals / clean
      // findings ("we checked X and it's fine").
      "severity": "high",

      // Synthesizer's confidence in this finding as stated.
      // "high" | "medium" | "low". Independent from severity:
      // a high-severity finding can be low-confidence if it rests
      // on a single LLM judgment with weak evidence.
      "confidence": "high",

      // Coarse category for grouping in the UI. Closed enum. Says WHERE — which
      // surface — the finding sits.
      // "permissions" | "data-exfiltration" | "code-execution"
      // | "obfuscation" | "supply-chain" | "messaging-surface"
      // | "remote-resources" | "claim-mismatch" | "anomaly" | "other"
      "category": "permissions",

      // Threat-class. Closed enum, ORTHOGONAL to category: category says which
      // surface, finding_type says what KIND of problem it is, so two findings
      // in one category (a web-exposed handler any page can abuse vs. a covert
      // exfil to an attacker host) are distinguishable. A neutral classification
      // of the mechanism, NOT a verdict on author intent.
      //   "vulnerability"     — exploitable weakness a third party could abuse;
      //                         the extension is the vector/victim.
      //   "malicious"         — harms/deceives the user by design. Intent-laden:
      //                         assign only to a confirmed mechanism with strong
      //                         evidence; when unsure use "unknown".
      //   "unwanted"          — privacy-invasive but a common business model
      //                         (tracking, fingerprinting, adware, telemetry).
      //   "risky-capability"  — a powerful/broad capability consistent with a
      //                         plausible purpose; the capability, not an abuse.
      //   "benign"            — a cleared concern / scoped negative (pairs with
      //                         severity: "positive").
      //   "unknown"           — nature undetermined. The conservative default.
      "finding_type": "risky-capability",

      // Stable taxonomy ID. Synthesizer maps from upstream rule_ids
      // and node outputs to a closed set. Lets us track recurrence
      // across extensions. Format: `<category>.<slug>`.
      "rule_id": "permissions.cookies-with-broad-host",

      // For the user-facing summary. One sentence, no jargon.
      "title": "Can read cookies from every site you visit",

      // For the analyst report. Markdown allowed. Multi-paragraph
      // narrative. Synthesizer composes this from upstream node
      // outputs; it is NOT free-form invention.
      "narrative": "The manifest requests the `cookies` permission together with the `<all_urls>` host pattern. This grants the extension the ability to read and write cookies for any site the user visits, including authentication cookies for banking, email, and SSO providers. The `permission-justification` node assessed this combination as 'justified' given the extension's stated purpose (a cookie editor), but the breadth of access remains a meaningful trust ask.",

      // Short form for cards / summaries. <= 240 chars.
      "narrative_short": "Manifest grants `cookies` + `<all_urls>`. The permission is consistent with the extension's stated purpose (cookie editor), but the access is broad.",

      // What can a user / analyst do about it? Optional but
      // recommended for medium+ severity. Markdown allowed.
      "recommendation": "Only install if you actively use cookie editing. Disable the extension when not in use to limit its access window.",

      // === AUDITABILITY ===

      // Pointers into the evidence pack. Each ref is a JSONPath-like
      // string plus an optional human-readable label. Renderers can
      // resolve these to show the exact fact.
      "evidence_refs": [
        {
          "path": "manifest_analysis.dangerous_combinations[0]",
          "label": "cookies + broad-host combination"
        },
        {
          "path": "manifest_analysis.capability_categories",
          "label": "declared capability categories"
        },
        {
          "path": "cross_file.permission_usage.cookies",
          "label": "all cookie API call sites"
        }
      ],

      // Pointers into specific code locations. Lifted from evidence
      // pack so renderers don't have to traverse to find them.
      "code_refs": [
        {
          "path": "js/background.js",
          "line": 42,
          "column": 4,
          "snippet": "chrome.cookies.getAll({url: tab.url}, (cookies) => { ... })",
          "label": "primary cookie read"
        }
      ],

      // Which upstream nodes contributed to this finding. The
      // synthesizer never invents findings; every one has at least
      // one contributing node (which may be `risk-classifier` for
      // deterministic findings).
      "contributing_nodes": [
        {
          "node_id": "risk-classifier",
          "fan_out_key": null,
          "rule_id": "RC.cookies-broad-host",          // upstream's own ID
          "contribution": "flagged"                    // "flagged" | "judged" | "dismissed" | "corroborated"
        },
        {
          "node_id": "permission-justification",
          "fan_out_key": "cookies",
          "contribution": "judged"
        }
      ],

      // Cross-references to other findings. Optional. Used when one
      // finding subsumes or contradicts another (e.g. a positive
      // finding dismissing a flag).
      "related_findings": [
        { "id": "F-d12e04", "relation": "dismisses" }   // "dismisses" | "supports" | "duplicates"
      ],

      // Blind spots that could invalidate this finding. REQUIRED on
      // `severity: "positive"` findings (a positive finding without
      // declared caveats is rejected at synthesis time). Optional
      // elsewhere — useful when a negative finding rests on partial
      // coverage. Phrased as plain-English limitations a reader can
      // weigh, not internal node IDs.
      "coverage_caveats": [],

      // Tags for filtering. Free-form but should reuse vocabulary
      // from `manifest_analysis.capability_categories` where it
      // applies.
      "tags": ["cookies", "broad-host", "all_urls"]
    }
    // ... more findings
  ],

  // Free-form notes the synthesizer wants to surface but that don't
  // rise to the level of a finding. Optional. Useful for "we noticed
  // X but it didn't seem actionable."
  "notes": [
    {
      "text": "Extension declares `clipboardWrite` but it is never invoked. Likely vestigial.",
      "evidence_refs": [
        { "path": "cross_file.unused_permissions", "label": "unused permissions list" }
      ],
      "contributing_nodes": [{ "node_id": "risk-classifier" }]
    }
  ]
}
```

### Field rules

- All IDs (`finding.id`, `rule_id`, `node_id`) are ASCII, stable
  within a run. `finding.id` is derived from a hash of
  `(rule_id, sorted(evidence_refs))` so the same logical finding
  re-runs to the same ID.
- `evidence_refs[].path` uses dotted JSONPath syntax against the
  evidence pack root. Arrays are indexed numerically. The synthesizer
  must not emit paths that don't resolve.
- `code_refs` are optional but encouraged whenever a finding rests on
  a specific call site. They are 1-indexed, matching the evidence
  pack convention.
- `contributing_nodes[].contribution`:
  - `flagged` — node raised this concern
  - `judged` — node provided the qualitative assessment (severity,
    narrative)
  - `dismissed` — node explicitly cleared this (used in positive
    findings)
  - `corroborated` — node independently agreed
- A finding with `severity: "positive"` must have at least one
  `contributing_nodes[].contribution == "dismissed"` AND a non-empty
  `coverage_caveats[]`. A positive finding without caveats is rejected
  at synthesis time — the schema refuses to let the synthesizer claim
  cleanness without naming what was not checked.
- A finding with `severity: "positive"` should be phrased as a scoped
  negative ("No statically-detectable cookie → network flow"), not as
  a positive verdict ("No exfiltration"). The title and narrative
  must make the methodology visible.
- A finding with `coverage_degraded: true` on its run means the
  consumer should render a "partial analysis" banner.
- The `user-facing-summary` node must consult `verdict.coverage`
  before surfacing any positive finding. Default behavior: omit
  positive findings from the non-technical summary unless
  `checks_failed` is empty and the relevant `structural_limits` are
  acknowledged in the headline.

---

## Worked example: ExtRay Demo Cookie Manager

The reference extension declares `cookies`, `<all_urls>`, `tabs`,
`storage`, `clipboardWrite`. Hypothetical run output:

```jsonc
{
  "schema_version": "1.0",
  "analyzer_version": "0.1.0",
  "synthesizer_node_version": "1.0",
  "synthesizer_model_id": "claude-sonnet-4-6",
  "inputs": {
    "evidence_pack": {
      "schema_version": "1.0",
      "analyzer_version": "0.1.0",
      "sha256": "9f4b...e1c2"
    },
    "node_outputs_dir": "node-outputs/"
  },
  "analyzed_at": "2026-05-22T14:03:17Z",
  "extension": {
    "id_from_path": "demo-cookie-manager",
    "name": "ExtRay Demo Cookie Manager",
    "version": "1.0.0",
    "manifest_version": 3
  },
  "verdict": {
    "overall": "concerning",
    "headline": "Can read and modify cookies on every site you visit. Broad access is the main risk; static checks did not surface exfiltration, with the usual caveats.",
    "counts": {
      "critical": 0, "high": 1, "medium": 1, "low": 1,
      "info": 2, "positive": 1
    },
    "coverage_degraded": false,
    "coverage": {
      "checks_completed": [
        "risk-classifier",
        "library-provenance-checker",
        "extension-intent-summarizer",
        "permission-justification:cookies",
        "permission-justification:tabs",
        "permission-justification:storage",
        "permission-justification:clipboardWrite",
        "destination-summary-reviewer",
        "message-surface-reviewer",
        "claim-vs-capability-checker"
      ],
      "checks_skipped": [
        { "node_id": "obfuscation-deobfuscator",
          "reason": "no scripts flagged as obfuscated" },
        { "node_id": "taint-flow-reviewer",
          "reason": "no taint sketches with risky classification" },
        { "node_id": "externally-connectable-reviewer",
          "reason": "manifest.externally_connectable is null" },
        { "node_id": "remote-resource-reviewer",
          "reason": "no remote resources in HTML" },
        { "node_id": "library-tamper-deep-dive",
          "reason": "no suspicious library files" },
        { "node_id": "anomaly-investigator",
          "reason": "no file anomalies detected by the heuristic set" }
      ],
      "checks_failed": [],
      "structural_limits": [
        "library files skipped from sink/taint analysis by default",
        "taint sketches limited to 1-3 hops within a single file",
        "no cross-file data-flow tracking",
        "dynamic code (eval, Function, runtime string assembly) opaque unless deobfuscator fires",
        "remotely-fetched configuration and runtime state not observable"
      ]
    }
  },

  "node_status": [
    { "node_id": "risk-classifier", "status": "ok", "duration_ms": 12,
      "output_ref": "node-outputs/risk-classifier.json" },
    { "node_id": "library-provenance-checker", "status": "ok", "duration_ms": 88,
      "output_ref": "node-outputs/library-provenance-checker.json" },
    { "node_id": "extension-intent-summarizer", "status": "ok", "duration_ms": 1420,
      "output_ref": "node-outputs/extension-intent-summarizer.json" },
    { "node_id": "permission-justification", "fan_out_key": "cookies",
      "status": "ok", "output_ref": "node-outputs/permission-justification.cookies.json" },
    { "node_id": "permission-justification", "fan_out_key": "tabs",
      "status": "ok", "output_ref": "node-outputs/permission-justification.tabs.json" },
    { "node_id": "permission-justification", "fan_out_key": "storage",
      "status": "ok", "output_ref": "node-outputs/permission-justification.storage.json" },
    { "node_id": "permission-justification", "fan_out_key": "clipboardWrite",
      "status": "ok", "output_ref": "node-outputs/permission-justification.clipboardWrite.json" },
    { "node_id": "destination-summary-reviewer", "status": "ok",
      "output_ref": "node-outputs/destination-summary-reviewer.json" },
    { "node_id": "message-surface-reviewer", "status": "ok",
      "output_ref": "node-outputs/message-surface-reviewer.json" },
    { "node_id": "obfuscation-deobfuscator", "status": "skipped",
      "skipped_reason": "no scripts flagged as obfuscated" },
    { "node_id": "taint-flow-reviewer", "status": "skipped",
      "skipped_reason": "no taint sketches with risky classification" },
    { "node_id": "externally-connectable-reviewer", "status": "skipped",
      "skipped_reason": "manifest.externally_connectable is null" },
    { "node_id": "remote-resource-reviewer", "status": "skipped",
      "skipped_reason": "no remote resources in HTML" },
    { "node_id": "library-tamper-deep-dive", "status": "skipped",
      "skipped_reason": "no suspicious library files" },
    { "node_id": "anomaly-investigator", "status": "skipped",
      "skipped_reason": "no file anomalies" },
    { "node_id": "claim-vs-capability-checker", "status": "ok",
      "output_ref": "node-outputs/claim-vs-capability-checker.json" }
  ],

  "findings": [
    {
      "id": "F-7c3a91",
      "severity": "high",
      "confidence": "high",
      "category": "permissions",
      "rule_id": "permissions.cookies-with-broad-host",
      "title": "Can read cookies from every site you visit",
      "narrative": "The manifest requests `cookies` together with the `<all_urls>` host pattern, which grants read/write access to cookies for every site the user visits — including authentication cookies for email, banking, and SSO providers. The `permission-justification` node found the combination *consistent* with the extension's stated purpose as a cookie editor, but the access scope itself is the risk regardless of intent: a future malicious update or a compromised distribution channel would inherit this surface immediately.",
      "narrative_short": "Manifest grants `cookies` + `<all_urls>`. Consistent with a cookie editor's purpose, but the access is broad and high-trust.",
      "recommendation": "Only install if you actively edit cookies. Consider disabling the extension when not in use to shrink the exposure window.",
      "evidence_refs": [
        { "path": "manifest_analysis.dangerous_combinations[0]",
          "label": "cookies + broad-host combination" },
        { "path": "manifest_analysis.capability_categories",
          "label": "declared capability categories" },
        { "path": "cross_file.permission_usage.cookies",
          "label": "all cookie API call sites" }
      ],
      "code_refs": [
        { "path": "js/background.js", "line": 42, "column": 4,
          "snippet": "chrome.cookies.getAll({url: tab.url}, ...)",
          "label": "primary cookie read" },
        { "path": "js/popup.js", "line": 17, "column": 6,
          "snippet": "chrome.cookies.set({url, name, value, ...})",
          "label": "cookie write from popup" }
      ],
      "contributing_nodes": [
        { "node_id": "risk-classifier", "rule_id": "RC.cookies-broad-host",
          "contribution": "flagged" },
        { "node_id": "permission-justification", "fan_out_key": "cookies",
          "contribution": "judged" }
      ],
      "tags": ["cookies", "broad-host", "all_urls"]
    },

    {
      "id": "F-d12e04",
      "severity": "positive",
      "confidence": "medium",
      "category": "data-exfiltration",
      "rule_id": "data-exfiltration.no-static-cookie-network-flow",
      "title": "No statically-detectable cookie → network flow",
      "narrative": "Shallow taint sketches did not connect any cookie-read sink to a network sink within the 1–3 hop window the pipeline examines. `destination-summary-reviewer` saw no external destinations beyond the default Chrome Web Store update URL. `taint-flow-reviewer` was gated out because no risky chains were present for it to deep-dive on.\n\nThis is a scoped negative, not a clean bill of health: the checks listed under `coverage_caveats` are not performed and any of them could hide exfiltration. A hostile update could also introduce exfiltration without changing the permission surface.",
      "narrative_short": "Checks that ran did not link cookie reads to any network request. See caveats for what was not examined.",
      "evidence_refs": [
        { "path": "cross_file.destination_summary",
          "label": "all network destinations" },
        { "path": "scripts[*].taint_sketches",
          "label": "data-flow sketches (none risky)" }
      ],
      "contributing_nodes": [
        { "node_id": "risk-classifier", "contribution": "dismissed" },
        { "node_id": "destination-summary-reviewer", "contribution": "corroborated" }
      ],
      "related_findings": [
        { "id": "F-7c3a91", "relation": "dismisses" }
      ],
      "coverage_caveats": [
        "library files were not scanned for network sinks (default skip)",
        "taint analysis limited to 1-3 hops within a single file; longer or cross-file flows would be missed",
        "indirect exfiltration channels (Image.src, redirects, sendBeacon, native messaging) not linked into taint chains",
        "no deobfuscation ran — dynamically-constructed fetch URLs would be invisible",
        "behavior driven by remote configuration or time-delayed activation not observable from static review"
      ],
      "tags": ["cookies", "scoped-negative"]
    },

    {
      "id": "F-44b1a2",
      "severity": "medium",
      "confidence": "high",
      "category": "permissions",
      "rule_id": "permissions.broad-tabs-access",
      "title": "Can see every tab's URL and title",
      "narrative": "The `tabs` permission combined with `<all_urls>` gives the extension visibility into every open tab's URL and title. `permission-justification` rated this 'weakly-justified': the cookie editor UI needs the current tab's URL, but iterating across all tabs is not strictly required.",
      "narrative_short": "Extension can read URLs and titles of every open tab. Marginally needed for the stated purpose.",
      "evidence_refs": [
        { "path": "manifest_analysis.capability_categories",
          "label": "tab-related capabilities" },
        { "path": "cross_file.permission_usage.tabs",
          "label": "tabs API call sites" }
      ],
      "code_refs": [
        { "path": "js/background.js", "line": 88, "column": 4,
          "snippet": "chrome.tabs.query({}, (tabs) => { ... })" }
      ],
      "contributing_nodes": [
        { "node_id": "risk-classifier", "rule_id": "RC.broad-tabs",
          "contribution": "flagged" },
        { "node_id": "permission-justification", "fan_out_key": "tabs",
          "contribution": "judged" }
      ],
      "tags": ["tabs", "broad-host"]
    },

    {
      "id": "F-9e07c1",
      "severity": "low",
      "confidence": "high",
      "category": "permissions",
      "rule_id": "permissions.unused-declared",
      "title": "Declares `clipboardWrite` but never uses it",
      "narrative": "The `clipboardWrite` permission is declared in the manifest but no call site in any first-party script invokes it. This is usually leftover from a removed feature; occasionally it signals a permission reserved for a later update. Not a risk on its own, but worth noting in any review.",
      "narrative_short": "`clipboardWrite` is declared but never used.",
      "evidence_refs": [
        { "path": "cross_file.unused_permissions",
          "label": "unused permissions" }
      ],
      "contributing_nodes": [
        { "node_id": "permission-justification", "fan_out_key": "clipboardWrite",
          "contribution": "judged" }
      ],
      "tags": ["unused-permission"]
    },

    {
      "id": "F-31aa08",
      "severity": "info",
      "confidence": "high",
      "category": "supply-chain",
      "rule_id": "supply-chain.libraries-verified",
      "title": "Bundled libraries match known hashes",
      "narrative": "All vendored library files under `lib/` matched expected SHA-256 hashes in the bundled allowlist. No tamper detected.",
      "narrative_short": "Bundled libraries are unmodified.",
      "evidence_refs": [
        { "path": "files[*].provenance", "label": "library provenance per file" }
      ],
      "contributing_nodes": [
        { "node_id": "library-provenance-checker", "contribution": "corroborated" }
      ],
      "tags": ["libraries"]
    },

    {
      "id": "F-2b4f7c",
      "severity": "info",
      "confidence": "high",
      "category": "claim-mismatch",
      "rule_id": "claim-mismatch.none-detected",
      "title": "No mismatch detected between stated purpose and observed capabilities",
      "narrative": "The `claim-vs-capability-checker` did not flag a mismatch between the extension's stated purpose (cookie editing) and its declared permissions and observed call sites. The check compares manifest description and locale strings against the permission surface; it does not validate runtime behavior.",
      "narrative_short": "No purpose-vs-capability mismatch flagged by the static checker.",
      "evidence_refs": [],
      "contributing_nodes": [
        { "node_id": "claim-vs-capability-checker", "contribution": "judged" }
      ],
      "tags": ["claim-vs-capability"]
    }
  ],

  "notes": []
}
```

---

## Alternatives considered

### SARIF (Static Analysis Results Interchange Format)

SARIF is the OASIS standard for static-analysis output, used by
CodeQL, Semgrep, and most enterprise SAST tools. We considered
aligning.

**Why it tempts:** Pre-existing tooling (VS Code SARIF viewer, GitHub
code scanning ingestion, jq cookbooks), a defined notion of `result`
with `locations`, `ruleId`, `level`, and a `relatedLocations` array
that loosely matches our `evidence_refs`.

**Why we declined:**

1. **SARIF has no concept of contributing analyzers per finding.**
   It assumes one tool emits one result. We have a DAG of nodes where
   a single finding is jointly produced by a deterministic classifier
   *and* one or more LLM judgments. Modelling that in SARIF requires
   either custom property bags (defeats the point of the standard) or
   emitting the same logical finding from multiple `runs[]` and
   asking consumers to merge them (defeats auditability).
2. **No first-class failed-node concept.** SARIF has
   `invocations[].toolExecutionNotifications`, which is for tool
   warnings, not "this analyzer was supposed to run and didn't." We'd
   bend it.
3. **No positive findings.** SARIF results are by construction
   problems. Our "we looked and it's fine" findings — which are
   important for the user-facing summary — would need a custom
   `kind: "informational"` plus prose conventions, which existing
   SARIF viewers won't render usefully.
4. **Verbosity cost.** SARIF nests `runs[].results[].locations[]
   .physicalLocation.artifactLocation.uri`. For an output that's
   already going to be re-rendered through our own templates, that
   nesting buys nothing.
5. **No downstream that needs SARIF.** Code scanning ingestion would
   matter for a CI tool; this is an extension review tool whose
   primary consumers are our own renderers. Aligning to a standard
   when nobody downstream speaks it is cost without benefit.

### npm audit / OSV-style flat reports

Too narrow — they assume a vulnerability database and CVE-style
records. We don't have a CVE space for "extension over-requests
cookies."

### Custom shape (chosen)

A purpose-built schema that mirrors the DAG's node-centric structure.
Each finding lists its `contributing_nodes[]` directly, failed nodes
are first-class in `node_status[]`, and positive findings share the
same structure as negative ones with `severity: "positive"`. We pay
the cost of inventing our own taxonomy (`category`, `rule_id`
namespaces) but keep a direct fit with the upstream DAG.

If a future integration needs SARIF, a one-way transform is
straightforward: each finding becomes a SARIF result, `evidence_refs`
become `locations` and `relatedLocations`, and node attribution
collapses into a property bag. The reverse (SARIF → our schema) is
lossy, which is the right direction for the transform asymmetry.
