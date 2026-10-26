// Evidence-pack contract: TypeScript types + ajv JSON Schema + helpers.
// This file is the single source of truth for the pack shape (mirrors
// docs/static-analysis.md). Layers populate the sections; the schema enforces
// the top-level structure and is tightened as layers land.

import { createRequire } from "node:module";
import type { ValidateFunction } from "ajv";
import type { FixtureContext } from "../fixture-context.ts";

// ajv is CJS; under NodeNext its default export isn't seen as constructable by
// tsc. Load it via require with an explicit constructor type (runtime-correct).
const require = createRequire(import.meta.url);
const Ajv = require("ajv") as new (opts?: Record<string, unknown>) => {
  compile: (schema: unknown) => ValidateFunction;
};

// 1.2: optional local `fixture` presentation context, excluded from LLM evidence.
// 1.1: additive `developer` section (improvement 008). Breaking changes bump
// the major component; additive sections bump the minor.
export const SCHEMA_VERSION = "1.2";
export const ANALYZER_VERSION = "0.1.0";

// ---- Types (documentation + author-time safety) ----

export interface Location {
  line: number;
  column?: number;
}

export interface FileEntry {
  path: string;
  size_bytes: number;
  sha256: string;
  type: string;
  referenced_by: string[];
  provenance: { known: false } | { known: true; library: string; version: string; hash_match: "exact" | "fuzzy" };
  anomalies: string[];
}

export interface Sink {
  category: string;
  api: string;
  location: Location;
  snippet: string;
  arguments_summary?: unknown[];
}

export interface NetworkDestination {
  // "unknown" is reserved for destinations a call makes but whose host could not
  // be statically resolved (populated once constant-folding lands; see
  // docs/reference/external_calls/detection-gaps.md, Gap 7).
  value: string;
  kind: "static" | "template" | "dynamic" | "unknown";
  ast_role: string;
  location: Location;
}

export interface TaintSketch {
  sink: { api: string; location: Location };
  chain: Array<{ kind: string; name?: string; api?: string; location?: Location }>;
  classification: string;
}

export interface Listener {
  kind: string;
  location: Location;
  validates_sender: boolean;
  snippet: string;
}

export interface Obfuscation {
  mean_identifier_length: number;
  identifier_entropy: number;
  hex_escape_density_per_kb: number;
  string_array_decoder_detected: boolean;
  packer_signature: string | null;
  flagged: boolean;
}

export interface ScriptEntry {
  path: string;
  parsed_ok: boolean;
  sinks: Sink[];
  network_destinations: NetworkDestination[];
  taint_sketches: TaintSketch[];
  listeners: Listener[];
  obfuscation: Obfuscation | null;
}

export interface ManifestAnalysis {
  manifest_version: number;
  capability_categories: string[];
  /** Host match patterns, merged across MV3 fields and MV2-style `permissions`
   *  entries; required vs optional kept distinguishable. Additive (optional)
   *  so existing packs/skeletons remain valid. */
  host_permissions?: { required: string[]; optional: string[] };
  dangerous_combinations: Array<{ kind: string; evidence: string[] }>;
  csp: { extension_pages: string | null; weaknesses: string[] };
  externally_connectable: { matches?: string[]; ids?: string[]; wildcards?: boolean } | null;
  update_url: string | null;
  non_default_update_url: boolean;
  content_scripts: unknown[];
  background: { kind: string; script: string | null; module: boolean } | null;
}

// Soundness ledger for external-call coverage. Records where the analysis is
// blind so the risk report can state bounded coverage instead of silently
// omitting calls it could not see. See docs/reference/external_calls/.
export interface OpaqueRegion {
  kind: "obfuscated" | "dynamic-code-exec";
  path: string;
  api?: string;
  location?: Location;
}

export interface IndirectCall {
  path: string;
  api: string;
  location: Location;
}

export interface UnresolvedDestination {
  path: string;
  ast_role: string;
  location: Location;
}

export interface ExternalCallLedger {
  /** Files/sites beyond which static analysis cannot see calls (obfuscated, eval'd). */
  opaque_regions: OpaqueRegion[];
  /** Calls reached through unresolved indirection (aliased / computed-global callee). */
  indirect_calls: IndirectCall[];
  /** Network calls whose destination host could not be statically resolved. */
  unresolved_destinations: UnresolvedDestination[];
  /** Files that failed to parse and were therefore not sink-scanned. */
  unparsed_files: string[];
  counts: {
    opaque_regions: number;
    indirect_calls: number;
    unresolved_destinations: number;
    unparsed_files: number;
  };
}

// Developer identity (improvement 008). Phase 1 carries only what the extension
// files self-report (manifest fields); absent fields are explicit nulls/false so
// the MVP questions ("has address? has website?") are always answerable. The
// future store-listing fetcher (008b) produces a sibling artifact with
// provenance "store_listing"; this section's provenance stays "self_reported".
export interface Developer {
  /** Normalized manifest `author` — MV3 allows a plain string (name) or an
   *  `{ email }` object; null when the manifest declares neither. */
  author: { name: string | null; email: string | null } | null;
  homepage_url: string | null;
  update_url: string | null;
  /** homepage_url present and http(s) — answers the MVP's "has website?". */
  has_website: boolean;
  /** update_url present and not the official Chrome Web Store endpoint —
   *  a non-store update channel is itself a signal. */
  non_store_update_url: boolean;
  /** Placeholders populated by the future store-listing fetcher (008b). */
  address: string | null;
  country: string | null;
  provenance: "self_reported";
}

// A tainted source (cookie/storage/identity) reaching a network/navigation sink,
// joined to the destination's party relationship to the extension publisher. The
// `dest_party` is the discriminator between benign first-party auth and egress to
// the publisher's own infrastructure (improvement 012). `external` deliberately
// is NOT demoted: page-origin for injected scripts is unknown statically, so a
// merchant's own API and a true exfil host both land here — only `first-party-extension`
// (publisher domain) is adjudicated with confidence.
export interface DataFlow {
  source_kind: string;          // cookie | storage | identity | tabs | message | data
  file: string;
  sink_api: string;
  sink_location: Location;
  dest_host: string | null;     // null when no destination resolved on the sink line
  dest_party: "first-party-extension" | "external" | "unknown";
}

export interface CrossFile {
  permission_usage: Record<string, Array<{ path: string; line: number; api: string }>>;
  unused_permissions: string[];
  cannot_determine_statically?: string[];
  message_graph: { nodes: unknown[]; edges: unknown[] };
  content_script_reach: unknown[];
  destination_summary: Array<{ host: string; references: number; any_dynamic: boolean; reached_via: string[] }>;
  data_flows?: DataFlow[];
}

export interface Resources {
  html: unknown[];
  css: unknown[];
  locales: Record<string, { message_count: number }>;
  web_accessible_resources: unknown[];
}

export interface EvidencePack {
  schema_version: string;
  analyzer_version: string;
  analyzed_at: string;
  extension: { path: string; id_from_path: string; manifest: Record<string, unknown> };
  /** Local fixture context for exported reports; excluded from LLM evidence. */
  fixture?: FixtureContext;
  manifest_analysis: ManifestAnalysis;
  developer: Developer;
  files: FileEntry[];
  scripts: ScriptEntry[];
  cross_file: CrossFile;
  resources: Resources;
  external_call_ledger: ExternalCallLedger;
  summary_signals: { high: unknown[]; medium: unknown[]; low: unknown[] };
}

// ---- Skeleton builder ----

export function skeletonPack(extension: EvidencePack["extension"]): EvidencePack {
  const manifest = extension.manifest as Record<string, unknown>;
  return {
    schema_version: SCHEMA_VERSION,
    analyzer_version: ANALYZER_VERSION,
    analyzed_at: new Date().toISOString(),
    extension,
    manifest_analysis: {
      manifest_version: typeof manifest.manifest_version === "number" ? manifest.manifest_version : 0,
      capability_categories: [],
      dangerous_combinations: [],
      csp: { extension_pages: null, weaknesses: [] },
      externally_connectable: null,
      update_url: null,
      non_default_update_url: false,
      content_scripts: [],
      background: null,
    },
    developer: {
      author: null,
      homepage_url: null,
      update_url: null,
      has_website: false,
      non_store_update_url: false,
      address: null,
      country: null,
      provenance: "self_reported",
    },
    files: [],
    scripts: [],
    cross_file: {
      permission_usage: {},
      unused_permissions: [],
      message_graph: { nodes: [], edges: [] },
      content_script_reach: [],
      destination_summary: [],
    },
    resources: { html: [], css: [], locales: {}, web_accessible_resources: [] },
    external_call_ledger: {
      opaque_regions: [],
      indirect_calls: [],
      unresolved_destinations: [],
      unparsed_files: [],
      counts: { opaque_regions: 0, indirect_calls: 0, unresolved_destinations: 0, unparsed_files: 0 },
    },
    summary_signals: { high: [], medium: [], low: [] },
  };
}

// ---- ajv validation ----

const TOP_LEVEL_SCHEMA = {
  type: "object",
  required: [
    "schema_version",
    "analyzer_version",
    "analyzed_at",
    "extension",
    "manifest_analysis",
    "developer",
    "files",
    "scripts",
    "cross_file",
    "resources",
    "external_call_ledger",
    "summary_signals",
  ],
  properties: {
    schema_version: { type: "string" },
    analyzer_version: { type: "string" },
    analyzed_at: { type: "string" },
    fixture: {
      type: "object",
      required: ["kind", "family"],
      additionalProperties: false,
      properties: { kind: { const: "synthetic" }, family: { type: "string", minLength: 1 } },
    },
    extension: {
      type: "object",
      required: ["path", "id_from_path", "manifest"],
      properties: {
        path: { type: "string" },
        id_from_path: { type: "string" },
        manifest: { type: "object" },
      },
    },
    manifest_analysis: {
      type: "object",
      required: ["manifest_version", "capability_categories", "dangerous_combinations", "csp"],
    },
    developer: {
      type: "object",
      required: ["author", "homepage_url", "update_url", "has_website", "non_store_update_url", "address", "country", "provenance"],
    },
    files: { type: "array" },
    scripts: { type: "array" },
    cross_file: {
      type: "object",
      required: ["permission_usage", "unused_permissions", "message_graph", "destination_summary"],
    },
    resources: { type: "object", required: ["html", "css", "locales"] },
    external_call_ledger: {
      type: "object",
      required: ["opaque_regions", "indirect_calls", "unresolved_destinations", "unparsed_files", "counts"],
    },
    summary_signals: {
      type: "object",
      required: ["high", "medium", "low"],
    },
  },
} as const;

const ajv = new Ajv({ allErrors: true, strict: false });
const validator: ValidateFunction = ajv.compile(TOP_LEVEL_SCHEMA);

export function validatePack(pack: unknown): { valid: boolean; errors: string[] } {
  const valid = validator(pack) as boolean;
  const errors = (validator.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim());
  return { valid, errors };
}
