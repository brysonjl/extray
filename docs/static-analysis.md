# Static Analysis Pipeline

The pipeline takes an unpacked extension directory and produces a single
**evidence pack** JSON document. It is fully deterministic: same input,
same output. No network calls (other than optional offline hash lookups
against a bundled allowlist). No LLM involvement.

The pipeline is organized as five layers, ordered cheapest → deepest.
Later layers may consume facts produced by earlier ones.

## Pipeline-wide constraints

These rules apply across every layer and to the evidence pack as a
whole. They are the contract between the static pipeline and the DAG.

- **Scope: MV3, unpacked.** v0 analyzes Manifest V3 extensions from an
  unpacked directory. MV2 and CRX/ZIP unpacking are out of scope.
- **Evidence pack size cap: 5 MB.** The pack is a single JSON file
  consumed by downstream renderers and (selectively) by LLM nodes. If
  a run would exceed the cap, the pipeline truncates the noisiest
  arrays (long destination lists, per-file anomaly noise) and records
  the truncation explicitly under `summary_signals` so downstream
  consumers know coverage was bounded.
- **Snippet sizing.** Every finding that references source code
  includes either the relevant AST node (preferred when bounded) or
  ±5 lines around the location. Snippets are literal source bytes,
  never paraphrased. Tier-2 DAG nodes can re-open the file for wider
  context; the evidence pack does not need to ship more.
- **Library skip policy.** Files identified in Layer 2 as known
  third-party libraries (hash match against the bundled allowlist)
  are **skipped by default** in Layer 3 sink and taint analysis. This
  is load-bearing for noise control and a deliberate blind spot —
  the DAG's `library-tamper-deep-dive` node is what catches
  tampered-library exfil. The skip is per-file and overridable.
- **Determinism.** Same input bytes ⇒ identical evidence pack bytes
  (modulo `analyzed_at`). No iteration order leaks, no map-key
  ordering surprises.

---

## Layer 1 — Manifest surface analysis

Goal: describe the extension's declared capabilities and trust posture
from `manifest.json` alone.

Inputs: `manifest.json`.

Extract:

- `manifest_version`, `name`, `version`, `minimum_chrome_version`,
  `update_url`, `key`
- `permissions`, `optional_permissions`, `host_permissions`,
  `optional_host_permissions`
- `content_scripts[]` with their `matches`, `js`, `css`, `run_at`,
  `world`
- `background` (service worker or page), `action`, `devtools_page`,
  `options_page`, `chrome_url_overrides`
- `externally_connectable` (which web origins / extension IDs may
  message in)
- `content_security_policy` (both `extension_pages` and `sandbox`)
- `web_accessible_resources` with their `matches`
- `oauth2`, `nativeMessaging` declarations

Derived:

- **Capability categories.** Map declared permissions to coarse
  categories: `network`, `dom-injection`, `cookies`, `identity`,
  `downloads`, `debugger`, `management`, `proxy`, `native-messaging`,
  `tab-capture`, `desktop-capture`, `web-request`, `declarative-net-request`,
  `storage`, `clipboard`.
- **Dangerous combinations.** Pattern-match high-risk sets:
  - `cookies` + broad host pattern (e.g. `<all_urls>`, `*://*/*`)
  - any `webRequest*` + broad host pattern
  - `debugger`, `management`, `proxy`, `nativeMessaging` (any of these
    alone are noteworthy)
  - `scripting` or `tabs.executeScript` access + broad host pattern
- **CSP weakness.** Flag any `unsafe-eval`, `unsafe-inline`, or remote
  script-src in extension pages.
- **Externally connectable surface.** Flag wildcards or non-empty web
  origins; record the exact set.
- **Update channel.** Flag non-Chrome-Web-Store `update_url` values.
- **Developer identity (self-reported).** A separate `developer` pack
  section built from `author` (string or `{email}` object),
  `homepage_url`, and `update_url`, with derived `has_website` and
  `non_store_update_url` booleans. Provenance is `self_reported`;
  `address`/`country` are explicit nulls in manifest-only input. See the
  [analysis guide](./analysis.md) for independently fetched store-listing
  context.

ExtRay Demo Cookie Manager example yields: `cookies + <all_urls> + tabs`,
`storage`, `clipboardWrite`, no CSP overrides, default update URL,
no externally_connectable, service-worker background as ES module.

---

## Layer 2 — File inventory and provenance

Goal: enumerate every file shipped in the extension and identify which
ones are known third-party libraries versus first-party code.

Inputs: full directory tree.

For every file:

- Relative path, size, SHA-256
- Detected type (by extension + magic bytes for binary assets)
- Whether the file is referenced from `manifest.json` directly or
  transitively from a referenced HTML

Library identification:

- Maintain a bundled allowlist mapping SHA-256 → `{library, version,
  source-url}` for popular vendored libs (jQuery, jQuery UI, lodash,
  underscore, moment, React, Vue, Angular, common minified UI kits).
- For each file under `lib/`, `vendor/`, or `node_modules/` (or any
  file whose contents match a library fingerprint), record a
  `provenance` block: `{known: true, library, version, hash-match: exact|fuzzy}`.
- First-party files (no hash match, not under a vendor path) are
  marked `{known: false}`. These are the files later layers focus on.

Anomaly flags at this layer:

- Minified files outside `lib/`/`vendor/` paths
- Files referenced by manifest that are missing on disk
- Files present but unreferenced from manifest or any HTML
- Files whose extension does not match magic bytes (e.g. `.png`
  containing JS)
- Files with very long single lines outside vendor paths
- Files containing large base64 blobs (> 4 KB contiguous)
- Files with unusually high byte entropy for their declared type

Optional: cross-check `_metadata/verified_contents.json` against actual
file hashes when present; flag any mismatch.

---

## Layer 3 — JavaScript AST analysis

Goal: for each first-party JS file, build a structured summary of what
the code does. This is the core layer.

Tooling: Babel parser (`@babel/parser`) with `errorRecovery: true` and
all syntax plugins enabled; traversal via `@babel/traverse`. Acorn is a
viable alternative. Files identified as known libraries in Layer 2 are
**skipped by default** to reduce noise; this can be overridden.

For each script, extract:

### Sinks (capability usage)

Catalog all calls to high-signal APIs. For each call, record file,
line, column, the receiver chain, and a quoted snippet.

- **Code execution.** `eval`, dynamic function construction via the
  `Function` constructor, `setTimeout` / `setInterval` invoked with a
  string first argument, direct-stream HTML writers
  (`document.write`/`writeln`), assignments to `innerHTML` /
  `outerHTML` / `insertAdjacentHTML`, `chrome.scripting.executeScript`,
  `chrome.tabs.executeScript`, `chrome.userScripts.*`
- **Cookies / storage.** `chrome.cookies.*`, `document.cookie` reads
  and writes, `chrome.storage.*`, `localStorage`, `sessionStorage`,
  `indexedDB`
- **Network.** `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
  `navigator.sendBeacon`, `Image.src` with non-data URLs,
  `<script>.src` assignments
- **Privilege APIs.** `chrome.webRequest.*`, `chrome.declarativeNetRequest.*`,
  `chrome.proxy.*`, `chrome.debugger.*`, `chrome.management.*`,
  `chrome.identity.*`, `chrome.downloads.*`, `chrome.nativeMessaging.*`,
  `chrome.tabCapture.*`, `chrome.desktopCapture.*`
- **Message channels.** `chrome.runtime.onMessage`/`onMessageExternal`,
  `chrome.runtime.sendMessage`, `chrome.runtime.connect`/`connectExternal`,
  `window.postMessage` and `addEventListener('message', …)` listeners

### Network destinations

Every string literal that resolves to a URL or hostname, plus the AST
context where it appears (passed to `fetch`? assigned to `script.src`?
just a comment-like constant?). For template literals where some parts
are dynamic, record the static skeleton (e.g.
`https://api.example.com/v1/${dynamic}`) and the dynamic source if
trivially derivable.

For each destination: file, line, the AST role, the resolved string (or
skeleton), and whether it is fully static, template, or fully dynamic.

### Shallow data-flow taint sketches

For each network sink and each code-execution sink, walk the AST 1–3
hops backward through local bindings to see whether the argument is:

- a static constant
- derived from a source we care about: `chrome.cookies.getAll`,
  `document.cookie`, `chrome.storage.*`, page DOM reads,
  `chrome.tabs.query`, message payloads from `onMessage*`
- fully dynamic / unknowable from static analysis

Record the chain as a short list of `{kind, location}` steps. This is
intentionally shallow — full taint requires a real flow analyzer. Even
two hops catches "read cookies, fetch external URL" patterns.

### Obfuscation indicators

Per-file metrics:

- Mean and max identifier length
- Identifier entropy (Shannon, base-26 over a–z lowercased)
- `\x` / `\u` hex-escape density per KB
- Presence of a string-array decoder pattern (large array of strings +
  small decoder function indexing it)
- Ratio of statements per line (single-line packed code)
- Known packer signatures (jsfuck, obfuscator.io defaults, packer.js)

Threshold each into a boolean flag plus the raw metric.

### Listener registrations

Record every `addEventListener`, `chrome.*.addListener`, and
`onMessage*` callback with: event type, file, line, and whether the
handler validates origin / sender (heuristic: does the handler body
mention `sender.id`, `event.origin`, or compare against a constant?).

---

## Layer 4 — Cross-file linkage

Goal: connect per-file facts into whole-extension views.

### Permission-to-usage map

For each declared permission in the manifest, list every call site
across all scripts that uses it.

- Unused permissions → flag (over-declared / leftover / cover for
  something else)
- Permissions used in unexpected files (e.g. a content script reading
  `chrome.cookies` when it could have asked the background) → flag
- Permissions used exclusively inside library files → flag for review

### Message-passing graph

Nodes: scripts (background, content scripts grouped by `matches`,
popup, options, devtools panel).

Edges: `sendMessage` / `connect` calls connected to corresponding
`onMessage` / `onConnect` handlers. Include `externally_connectable`
edges originating from outside origins.

For each edge, record the shape of the payload if statically
derivable, and whether the receiver validates the sender.

### Content-script reach

For each content script, list its `matches` patterns together with the
sinks it uses on those pages. This answers: "on which sites does this
extension touch the DOM / read cookies / send data?"

### Destination summary

Deduplicated list of all network destinations across all first-party
files, each annotated with: hostnames, count of references, whether any
reference is dynamic, and which sinks they reach (fetch, script.src,
WebSocket, …).

---

## Layer 5 — Resource and asset checks

Goal: surface non-JS risks.

- **HTML files.** Inline `<script>` blocks (extract and run through
  Layer 3), remote `<script src>`, remote `<link rel="stylesheet">`,
  remote `<iframe>`, remote fonts/images that could fingerprint.
- **CSS files.** Remote `url(...)` references, `@import` of remote
  stylesheets.
- **Locales.** `_locales/*/messages.json` — record all message keys
  and values so downstream review can compare claimed purpose against
  permission surface.
- **Web-accessible resources.** For each declared resource, identify
  what it contains and whether exposing it leaks anything.
- **Binary assets.** Files whose magic bytes don't match their
  extension (already flagged in Layer 2 but re-confirmed here).

---

## Evidence pack schema

Output is a single JSON document. Versioned. Top-level shape:

```jsonc
{
  "schema_version": "1.2",
  "analyzer_version": "0.1.0",
  "analyzed_at": "ISO-8601",
  "extension": {
    "path": "...",
    "id_from_path": "demo-cookie-manager",
    "manifest": { /* raw manifest.json */ }
  },
  // Optional local sidecar context, stripped from investigator prompts.
  "fixture": { "kind": "synthetic", "family": "ExtRay Demo Cookie Manager" },

  "manifest_analysis": {
    "manifest_version": 3,
    "capability_categories": ["cookies", "dom-injection", "storage", ...],
    "dangerous_combinations": [
      { "kind": "cookies+broad-host", "evidence": ["cookies", "<all_urls>"] }
    ],
    "csp": { "extension_pages": "...", "weaknesses": [] },
    "externally_connectable": null,
    "update_url": "https://clients2.google.com/service/update2/crx",
    "non_default_update_url": false,
    "content_scripts": [ /* with matches, files */ ],
    "background": { "kind": "service_worker", "script": "/js/background.js", "module": true }
  },

  "developer": {
    "author": { "name": "Example Dev", "email": null },  // null when manifest has no author
    "homepage_url": "https://example.com",
    "update_url": "https://clients2.google.com/service/update2/crx",
    "has_website": true,
    "non_store_update_url": false,
    "address": null,   // explicit nulls; populated by the future
    "country": null,   // store-listing fetcher (provenance "store_listing")
    "provenance": "self_reported"
  },

  "files": [
    {
      "path": "js/background.js",
      "size_bytes": 12345,
      "sha256": "...",
      "type": "javascript",
      "referenced_by": ["manifest:background.service_worker"],
      "provenance": { "known": false },
      "anomalies": []
    },
    {
      "path": "lib/jquery-3.3.1.min.js",
      "size_bytes": 86927,
      "sha256": "...",
      "type": "javascript",
      "provenance": { "known": true, "library": "jquery", "version": "3.3.1", "hash_match": "exact" },
      "anomalies": []
    }
    // ...
  ],

  "scripts": [
    {
      "path": "js/background.js",
      "parsed_ok": true,
      "sinks": [
        {
          "category": "cookies",
          "api": "chrome.cookies.getAll",
          "location": { "line": 42, "column": 4 },
          "snippet": "chrome.cookies.getAll({url: tab.url}, (cookies) => { ... })",
          "arguments_summary": [
            { "kind": "object-literal", "keys": ["url"] },
            { "kind": "callback" }
          ]
        }
      ],
      "network_destinations": [
        {
          "value": "https://api.example.com/sync",
          "kind": "static",
          "ast_role": "fetch.url",
          "location": { "line": 88, "column": 12 }
        }
      ],
      "taint_sketches": [
        {
          "sink": { "api": "fetch", "location": { "line": 88, "column": 12 } },
          "chain": [
            { "kind": "binding", "name": "payload", "location": { "line": 85 } },
            { "kind": "source", "api": "chrome.cookies.getAll", "location": { "line": 42 } }
          ],
          "classification": "cookie-source-to-network-sink"
        }
      ],
      "listeners": [
        {
          "kind": "chrome.runtime.onMessageExternal",
          "location": { "line": 200 },
          "validates_sender": false,
          "snippet": "chrome.runtime.onMessageExternal.addListener((msg, sender) => { ... })"
        }
      ],
      "obfuscation": {
        "mean_identifier_length": 6.4,
        "identifier_entropy": 3.1,
        "hex_escape_density_per_kb": 0.0,
        "string_array_decoder_detected": false,
        "packer_signature": null,
        "flagged": false
      }
    }
    // ...
  ],

  "cross_file": {
    "permission_usage": {
      "cookies": [
        { "path": "js/background.js", "line": 42, "api": "chrome.cookies.getAll" },
        { "path": "js/popup.js", "line": 17, "api": "chrome.cookies.set" }
      ],
      "tabs": [ /* ... */ ],
      "clipboardWrite": []  // declared but unused
    },
    "unused_permissions": ["clipboardWrite"],
    "message_graph": {
      "nodes": [ { "id": "background", "path": "js/background.js" }, ... ],
      "edges": [
        {
          "from": "popup",
          "to": "background",
          "channel": "chrome.runtime.sendMessage",
          "payload_shape": { "keys": ["action", "data"] },
          "receiver_validates_sender": false
        }
      ]
    },
    "content_script_reach": [
      {
        "matches": ["<all_urls>"],
        "files": [ "js/content.js" ],
        "sink_summary": { "dom-injection": 3, "network": 0, "cookies": 0 }
      }
    ],
    "destination_summary": [
      {
        "host": "api.example.com",
        "references": 4,
        "any_dynamic": false,
        "reached_via": ["fetch"]
      }
    ]
  },

  "resources": {
    "html": [
      {
        "path": "popup.html",
        "inline_scripts": 0,
        "remote_scripts": [],
        "remote_styles": [],
        "remote_iframes": []
      }
    ],
    "css": [],
    "locales": { "en": { "message_count": 42 } },
    "web_accessible_resources": []
  },

  "summary_signals": {
    "high": [ /* concise findings the DAG should definitely consider */ ],
    "medium": [],
    "low": []
  }
}
```

`summary_signals` is a convenience rollup — every entry references
specific fact IDs deeper in the document. It is not a verdict; it is a
pointer list for the DAG's gating nodes.

### Schema rules

- Every finding includes `{path, line, column?}` and, where useful, a
  short `snippet` field (the literal source bytes).
- Locations are 1-indexed.
- The document never contains whole-file source — only snippets. DAG
  nodes that need full source open the file directly using `path`.
- The schema is versioned. Breaking changes bump the major component of
  `schema_version`; additive sections bump the minor (e.g. `developer`
  landed as 1.0 → 1.1).
