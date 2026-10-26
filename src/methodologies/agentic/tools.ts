// The agentic arm's tool layer: read + reason + record only — NO write, network,
// or exec. Every file read routes through safeSourcePath(sampleDir, …) so a
// model-cited path (derived from attacker-controlled data) can never escape the
// unpacked extension dir (no `..`, no absolute paths, files only). Tools never
// throw on a bad path/regex: they return { ok: false, content } so the agent can
// recover and so a path-escape attempt is observable in the trace.
//
// Tool results are RAW strings here; the loop wraps every result in the
// untrusted-content envelope (buildPrompt/wrapUntrustedBlock) before it re-enters
// a prompt — the agent reads adversarial source, so this is the injection guard.
// sampleDir is fs-only and never appears in a tool result (label-leak guard); all
// paths surfaced to the agent are extension-relative.

import { readFileSync } from "node:fs";
import type { EvidencePack } from "../../pipeline/schema.ts";
import { safeSourcePath } from "../findings.ts";

/** Volatile + identity pack fields that must never reach a prompt (mirrors the
 *  monolith's STRIPPED set; sample-path fields are corpus ground-truth hints). */
const STRIPPED = new Set(["fixture", "analyzed_at", "analyzer_version", "extension.path", "extension.id_from_path"]);

/** Deep-ish strip: drop volatile top-level fields and dotted identity sub-fields. */
export function strippedPack(pack: EvidencePack): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(pack)) {
    if (STRIPPED.has(k)) continue;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const inner: Record<string, unknown> = {};
      for (const [ik, iv] of Object.entries(v)) {
        if (!STRIPPED.has(`${k}.${ik}`)) inner[ik] = iv;
      }
      out[k] = inner;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface ToolResult {
  ok: boolean;
  content: string;
}

// Byte cap on a single read so one giant minified bundle cannot blow the prompt.
const READ_MAX_BYTES = 12_000;
// Cap on grep matches returned per call.
const GREP_MAX_MATCHES = 60;
// Only scan plausibly-textual files in grep (skip fonts/images/binaries).
const TEXT_EXT = /\.(js|mjs|cjs|ts|json|html?|css|txt|xml|md|yml|yaml)$/i;

export class AgenticTools {
  readonly #pack: EvidencePack;
  readonly #sampleDir: string;
  readonly #stripped: Record<string, unknown>;
  readonly #textCache = new Map<string, string | null>();

  constructor(pack: EvidencePack, sampleDir: string) {
    this.#pack = pack;
    this.#sampleDir = sampleDir;
    this.#stripped = strippedPack(pack);
  }

  /** Read + cache a file's text via the sandbox; null on escape/missing/unreadable. */
  #read(file: string): string | null {
    if (this.#textCache.has(file)) return this.#textCache.get(file)!;
    const abs = safeSourcePath(this.#sampleDir, file);
    let text: string | null = null;
    if (abs) {
      try {
        text = readFileSync(abs, "utf8");
      } catch {
        text = null;
      }
    }
    this.#textCache.set(file, text);
    return text;
  }

  /** The extension-relative file list (from the pack map). */
  listFiles(): ToolResult {
    const paths = this.#pack.files.map((f) => f.path);
    return { ok: true, content: paths.join("\n") };
  }

  /**
   * Read a file (optionally a 1-based line window), byte-capped. A path that
   * escapes the sample dir or does not exist returns ok:false — the sandbox
   * rejection, surfaced to the agent rather than thrown.
   */
  readFile(path: unknown, range?: unknown): ToolResult {
    if (typeof path !== "string" || path.trim() === "") {
      return { ok: false, content: "read_file requires a string `path`" };
    }
    if (safeSourcePath(this.#sampleDir, path) === null) {
      return { ok: false, content: `path "${path}" is not a readable file inside the extension (outside the sandbox or missing)` };
    }
    const text = this.#read(path);
    if (text === null) return { ok: false, content: `could not read "${path}"` };

    let body = text;
    let note = "";
    const r = range as { start_line?: unknown; end_line?: unknown } | undefined;
    if (r && (typeof r.start_line === "number" || typeof r.end_line === "number")) {
      const lines = text.split("\n");
      const start = Math.max(1, typeof r.start_line === "number" ? r.start_line : 1);
      const end = Math.min(lines.length, typeof r.end_line === "number" ? r.end_line : lines.length);
      if (start > end) return { ok: false, content: `invalid range: start_line ${start} > end_line ${end}` };
      // Reproduce the original 1-based line numbers in a gutter so the agent
      // cites real locations.
      body = lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join("\n");
      note = ` (lines ${start}-${end} of ${lines.length})`;
    }
    let truncated = "";
    if (Buffer.byteLength(body, "utf8") > READ_MAX_BYTES) {
      body = body.slice(0, READ_MAX_BYTES);
      truncated = `\n… [truncated at ${READ_MAX_BYTES} bytes; request a narrower line range to see more]`;
    }
    return { ok: true, content: `FILE: ${path}${note}\n----\n${body}${truncated}` };
  }

  /**
   * Regex search over textual source files (or a single file when `path` is
   * given). Returns up to GREP_MAX_MATCHES `file:line: text` hits. An invalid
   * pattern or an out-of-sandbox path returns ok:false.
   */
  grep(pattern: unknown, path?: unknown): ToolResult {
    if (typeof pattern !== "string" || pattern === "") {
      return { ok: false, content: "grep requires a non-empty string `pattern`" };
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      return { ok: false, content: `invalid regex: ${e instanceof Error ? e.message : String(e)}` };
    }
    let files: string[];
    if (typeof path === "string" && path.trim() !== "") {
      if (safeSourcePath(this.#sampleDir, path) === null) {
        return { ok: false, content: `path "${path}" is not a readable file inside the extension (outside the sandbox or missing)` };
      }
      files = [path];
    } else {
      files = this.#pack.files.map((f) => f.path).filter((p) => TEXT_EXT.test(p));
    }

    const matches: string[] = [];
    for (const file of files) {
      if (matches.length >= GREP_MAX_MATCHES) break;
      const text = this.#read(file);
      if (text === null) continue;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && matches.length < GREP_MAX_MATCHES; i++) {
        if (re.test(lines[i]!)) {
          const trimmed = lines[i]!.trim().slice(0, 200);
          matches.push(`${file}:${i + 1}: ${trimmed}`);
        }
      }
    }
    if (matches.length === 0) return { ok: true, content: `(no matches for /${pattern}/)` };
    const capped = matches.length >= GREP_MAX_MATCHES ? `\n… [capped at ${GREP_MAX_MATCHES} matches]` : "";
    return { ok: true, content: matches.join("\n") + capped };
  }

  /**
   * Navigate the STRIPPED pack by a dotted JSONPath (e.g.
   * "manifest_analysis.permissions" or "cross_file.destination_summary").
   * Numeric segments index arrays. Returns the subtree as JSON, length-capped.
   */
  readPack(path: unknown): ToolResult {
    if (typeof path !== "string") return { ok: false, content: "read_pack requires a string `path`" };
    let node: unknown = this.#stripped;
    const segments = path.split(".").map((s) => s.trim()).filter((s) => s !== "");
    for (const seg of segments) {
      if (node === null || typeof node !== "object") {
        return { ok: false, content: `path "${path}" does not resolve (stopped at "${seg}")` };
      }
      const idx = /^\d+$/.test(seg) ? Number(seg) : seg;
      node = (node as Record<string | number, unknown>)[idx];
      if (node === undefined) return { ok: false, content: `path "${path}" does not resolve (no "${seg}")` };
    }
    let json = JSON.stringify(node, null, 1);
    if (json.length > READ_MAX_BYTES) json = json.slice(0, READ_MAX_BYTES) + "\n… [truncated]";
    return { ok: true, content: json };
  }
}
