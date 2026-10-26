// Record/replay shim (idea #5). Wraps any LlmClient. REPLAY (the default) serves
// committed fixtures and THROWS LOUDLY on a miss — it never silently falls
// through to a live call, so CI and the test suite can never make a network
// request. RECORD wraps a real client and persists the fixture — but is
// record-on-miss (idempotent): an existing fixture is reused, not clobbered, so
// repeated/overlapping RECORD passes compose instead of desyncing.
//
// Fixture key = sha256 of the canonicalized request (label + model + prompt +
// params). Any prompt edit changes the key and forces a re-record rather than
// serving a stale answer. Volatile EvidencePack fields (analyzed_at,
// analyzer_version) are pinned/stripped at the SERIALIZATION layer (the monolith
// builds the prompt from a pinned pack) — a request-level canonicalizer cannot
// reach fields already embedded in the prompt string, so it is not relied on for
// that. Canonicalization here only stabilizes key ordering of the request object.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { LlmClient, LlmRequest, LlmResponse } from "./client.ts";

export type ReplayMode = "REPLAY" | "RECORD";

export interface RecordReplayOptions {
  mode: ReplayMode;
  fixtureDir: string;
  /** Underlying live client; only required in RECORD mode. */
  wrapped?: LlmClient;
}

export class FixtureMissError extends Error {}
export class FixtureIntegrityError extends Error {}

/** Stable JSON: object keys sorted recursively so key order can't change the hash. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    // Preserve literal JSON keys such as __proto__; using {} would silently
    // drop that key and let different request parameters share a cache hash.
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Canonical view of the request used for hashing (label + model + prompt + params). */
export function canonicalizeRequest(req: LlmRequest): string {
  return stableStringify({ label: req.label, model: req.model, prompt: req.prompt, params: req.params ?? {} });
}

export function fixtureKey(req: LlmRequest): string {
  return createHash("sha256").update(canonicalizeRequest(req)).digest("hex");
}

function safeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60);
}

/**
 * Fixture file basename for a request — exactly how RecordReplayClient names it
 * on disk. Exposed so error paths (e.g. JudgeParseError) can tell the user which
 * fixture file to delete to force a re-record of a poisoned completion.
 */
export function fixtureFileName(req: LlmRequest): string {
  return `${safeLabel(req.label)}-${fixtureKey(req).slice(0, 16)}.json`;
}

export interface FixtureFile {
  key: string;
  label: string;
  model: string;
  request: { prompt: string; params: Record<string, unknown> };
  response: LlmResponse;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate stored requests before trusting their filename as a cache key.
 * Errors deliberately identify the file and field, never prompt/response text. */
export function readFixtureFile(path: string, expected?: LlmRequest): FixtureFile {
  const fail = (reason: string): never => {
    throw new FixtureIntegrityError(`invalid LLM fixture ${basename(path)}: ${reason}`);
  };
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { return fail("unreadable or invalid JSON"); }
  if (!isObject(value) || typeof value.key !== "string" ||
      typeof value.label !== "string" || typeof value.model !== "string" ||
      !isObject(value.request) || typeof value.request.prompt !== "string" ||
      !isObject(value.request.params) || !isObject(value.response) ||
      typeof value.response.text !== "string" || !isObject(value.response.usage)) {
    return fail("invalid request/response shape");
  }
  for (const field of ["inputTokens", "outputTokens"] as const) {
    const amount = value.response.usage[field];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return fail(`invalid ${field}`);
  }
  const stored: LlmRequest = {
    label: value.label, model: value.model,
    prompt: value.request.prompt, params: value.request.params,
  };
  const key = fixtureKey(stored);
  if (value.key !== key) return fail("stored request does not match its full SHA-256 key");
  if (basename(path) !== fixtureFileName(stored)) return fail("filename does not match stored request");
  if (expected && fixtureKey(expected) !== key) return fail("stored request differs from requested completion");
  return value as unknown as FixtureFile;
}

export class RecordReplayClient implements LlmClient {
  readonly mode: ReplayMode;
  readonly #dir: string;
  readonly #wrapped?: LlmClient;
  readonly stats = { hits: 0, recorded: 0 };

  constructor(opts: RecordReplayOptions) {
    this.mode = opts.mode;
    this.#dir = opts.fixtureDir;
    this.#wrapped = opts.wrapped;
    if (this.mode === "RECORD" && !this.#wrapped) {
      throw new Error("RECORD mode requires a wrapped live LlmClient");
    }
  }

  #path(req: LlmRequest): string {
    return join(this.#dir, fixtureFileName(req));
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const key = fixtureKey(req);
    const path = this.#path(req);

    if (this.mode === "REPLAY") {
      if (!existsSync(path)) {
        throw new FixtureMissError(
          `no REPLAY fixture for label="${req.label}" model="${req.model}" (key ${key.slice(0, 16)} -> ${path}). ` +
            `Run in RECORD mode with a provider adapter to capture it.`,
        );
      }
      const fx = readFixtureFile(path, req);
      this.stats.hits++;
      return fx.response;
    }

    // RECORD is record-on-miss (idempotent): a stable prompt reuses its captured
    // response instead of re-calling and clobbering it. This is what lets two
    // RECORD passes compose — e.g. the pilot reuses the scorecard's monolith
    // outputs, so the downstream judge/normalize keys (which hash the monolith
    // output) stay stable and both REPLAY paths remain consistent. A genuine
    // re-record is forced by a prompt change (new key) or by deleting the fixture.
    if (existsSync(path)) {
      const fx = readFixtureFile(path, req);
      this.stats.hits++;
      return fx.response;
    }
    const response = await this.#wrapped!.complete(req);
    mkdirSync(this.#dir, { recursive: true });
    const fixture: FixtureFile = {
      key,
      label: req.label,
      model: req.model,
      request: { prompt: req.prompt, params: req.params ?? {} },
      response,
    };
    writeFileSync(path, JSON.stringify(fixture, null, 2) + "\n");
    this.stats.recorded++;
    return response;
  }
}

/** List committed fixtures (for the fixture-review lint, Unit 1 verification). */
export function listFixtures(fixtureDir: string): FixtureFile[] {
  if (!existsSync(fixtureDir)) return [];
  return readdirSync(fixtureDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readFixtureFile(join(fixtureDir, f)));
}
