// Ollama Cloud session pacing, shared by the batch analysis drivers
// (scripts/discover.ts --run and scripts/drain-submissions.ts).
//
// Ollama Cloud exposes NO quota/usage over its API — no rate-limit headers, no
// usage endpoint (ollama/ollama#15663, #16448). Usage is metered by GPU-time and
// resets on a multi-HOUR session clock (~5h free tier) plus a weekly clock. So
// we cannot read a remaining balance; we can only:
//
//   1. WAIT-AND-RESUME (the safeguard): when an analysis fails because the
//      session is rate-limited, don't drop the extension — sleep, then send one
//      cheap probe request; a 200 means the window has reset, so resume. Because
//      successful LLM calls are cached (RECORD mode), the re-run resumes mostly
//      from cache. Sessions reset in hours, so probing is INFREQUENT by design
//      (default every 30 min) — a tight poll would just burn quota on probes.
//
//   2. USAGE READOUT (a gauge, not a meter): sum the server-reported generation
//      time (usage.wall_clock_ms, from Ollama's total_duration) over a rolling
//      window from the bake-off DB. This is LOCAL ACTIVITY, an under-count of
//      true GPU-time (the pi arm's sub-agent traffic isn't all attributed), and
//      is NOT Ollama's balance — treat it as "how heavy have we been lately".

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db/index.ts";
import { registerExecutorChild } from "../src/runner/ownership.ts";

export const DEFAULT_HOST = "https://ollama.com";
/** Ollama's free-tier session clock is ~5h; the usage window mirrors it. */
export const DEFAULT_WINDOW_HOURS = 5;
/** Probe every 30 min while waiting — sessions reset in hours, not seconds. */
export const DEFAULT_POLL_MINUTES = 30;
/** Give up waiting after this long (covers one full ~5h session reset + slack). */
export const DEFAULT_MAX_WAIT_HOURS = 6;

// The rate-limit signature lives in src/llm/rate-limit.ts (shared with
// assess's error classification → exit code 5); re-exported for existing
// consumers of this module.
export { RATE_LIMIT_RE, looksRateLimited } from "../src/llm/rate-limit.ts";
import { looksRateLimited } from "../src/llm/rate-limit.ts";

/** assess exits with this code when a run died on a provider rate limit —
 *  the structured signal; the stderr regex below is the fallback. */
export const EXIT_RATE_LIMITED = 5;

/** The --model value assess would use, for the probe to hit the same session
 *  bucket. Commander is last-wins, so scan from the end. */
export function modelFromAssessArgs(args: string[]): string | undefined {
  const i = args.lastIndexOf("--model");
  return i >= 0 ? args[i + 1] : undefined;
}

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---- usage readout -----------------------------------------------------------

export interface SessionUsage {
  windowHours: number;
  since: string;
  /** Analysis runs recorded in the window. */
  runs: number;
  /** Extension reports produced in the window. */
  analyses: number;
  /** Server-reported generation seconds (under-counts pi sub-agent time). */
  serverSeconds: number;
  inputTokens: number;
  outputTokens: number;
}

/** Roll up recorded activity over the last `windowHours` from the bake-off DB.
 *  `nowMs` is injectable for tests. */
export function sessionUsageWindow(dbPath: string, windowHours = DEFAULT_WINDOW_HOURS, nowMs = Date.now()): SessionUsage {
  const since = new Date(nowMs - windowHours * 3_600_000).toISOString();
  const db = openDb(dbPath);
  try {
    const runs = (db.prepare("SELECT COUNT(*) n FROM run WHERE started_at >= ?").get(since) as { n: number }).n;
    const ms = (
      db
        .prepare("SELECT COALESCE(SUM(u.wall_clock_ms),0) ms FROM usage u JOIN run r ON u.run_id = r.id WHERE r.started_at >= ?")
        .get(since) as { ms: number }
    ).ms;
    const rep = db
      .prepare(
        "SELECT COUNT(*) n, COALESCE(SUM(input_tokens),0) it, COALESCE(SUM(output_tokens),0) ot " +
          "FROM report rp JOIN run r ON rp.run_id = r.id WHERE r.started_at >= ?",
      )
      .get(since) as { n: number; it: number; ot: number };
    return {
      windowHours,
      since,
      runs,
      analyses: rep.n,
      serverSeconds: Math.round(ms / 1000),
      inputTokens: rep.it,
      outputTokens: rep.ot,
    };
  } finally {
    db.close();
  }
}

export function formatUsage(u: SessionUsage): string {
  const mins = (u.serverSeconds / 60).toFixed(1);
  return (
    `last ${u.windowHours}h: ${u.analyses} analyses (${u.runs} runs), ~${mins} min server-time, ` +
    `${u.outputTokens.toLocaleString()} output tokens ` +
    `[local activity, not Ollama's balance — Ollama exposes no quota API]`
  );
}

// ---- probe + wait ------------------------------------------------------------

export type ProbeResult = "ok" | "limited" | "error";

export interface ProbeOpts {
  model: string;
  host?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** One cheap /api/chat call to test whether the session has capacity again.
 *  Kept to a single output token so it barely touches the quota. */
export async function probeSession(opts: ProbeOpts): Promise<ProbeResult> {
  const host = opts.host ?? process.env.OLLAMA_HOST ?? DEFAULT_HOST;
  const apiKey = opts.apiKey ?? process.env.OLLAMA_API_KEY;
  const doFetch = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await doFetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: opts.model,
        messages: [{ role: "user", content: "ping" }],
        stream: false,
        options: { num_ctx: 512, num_predict: 1, temperature: 0 },
      }),
      signal: controller.signal,
    });
    if (res.status === 429) return "limited";
    const text = await res.text().catch(() => "");
    if (!res.ok) return looksRateLimited(text) ? "limited" : "error";
    // A 200 can still carry an in-body error (some gateways return quota errors 200).
    return looksRateLimited(text) ? "limited" : "ok";
  } catch {
    return "error"; // network/abort — unknown, keep waiting
  } finally {
    clearTimeout(timer);
  }
}

export interface WaitOpts extends ProbeOpts {
  pollMs?: number;
  maxWaitMs?: number;
  /** Injected for tests; defaults to real timers / clock. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
  /** Optional one-line usage gauge printed on each poll. */
  usageLine?: () => string;
}

/**
 * Block until a probe reports the session has capacity again, or throw once
 * `maxWaitMs` elapses. Probes on a slow cadence (default 30 min) because Ollama
 * sessions reset over hours.
 */
export async function waitForSessionReset(opts: WaitOpts): Promise<void> {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MINUTES * 60_000;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_HOURS * 3_600_000;
  const sleep = opts.sleep ?? sleepReal;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((m) => process.stderr.write(m + "\n"));
  const deadline = now() + maxWaitMs;
  const pollMin = Math.round(pollMs / 60_000);

  log(`⏸  Ollama session rate-limited. Waiting for reset (probing every ${pollMin} min, up to ${Math.round(maxWaitMs / 3_600_000)}h)…`);
  if (opts.usageLine) log(`   ${opts.usageLine()}`);
  while (now() < deadline) {
    await sleep(pollMs);
    const status = await probeSession(opts);
    if (status === "ok") {
      log("▶  Ollama session has capacity again — resuming.");
      return;
    }
    log(`   still ${status === "limited" ? "rate-limited" : "unreachable"} at +${pollMin}m; continuing to wait…`);
  }
  throw new Error(`Ollama session did not reset within ${Math.round(maxWaitMs / 3_600_000)}h — aborting.`);
}

// ---- paced assess driver -----------------------------------------------------

export interface AssessOutcome {
  code: number | null;
  /** Last non-empty stderr line — assess's classified per-extension error. */
  lastStderrLine: string | null;
  /** Whether the last (failed) attempt looked rate-limited. */
  rateLimited: boolean;
  resultReportId?: number;
  cancelled?: boolean;
}

/** Spawn one assess run, streaming stdout live and keeping a stderr tail. */
export type SpawnAssess = (storeId: string, assessArgs: string[], env?: NodeJS.ProcessEnv) => Promise<{ code: number | null; tail: string; resultReportId?: number; cancelled?: boolean }>;

const spawnAssessReal: SpawnAssess = (storeId, assessArgs, env) =>
  new Promise((resolve, reject) => {
    const receiptDir = mkdtempSync(join(tmpdir(), "extray-receipt-"));
    const receiptPath = join(receiptDir, "receipt.json");
    // Track the analyzer itself, not a CLI wrapper that can leave grandchildren.
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/assess.ts", storeId, ...assessArgs], {
      stdio: ["ignore", "inherit", "pipe"],
      env: { ...process.env, ...env, EXTRAY_ASSESS_RECEIPT: receiptPath },
    });
    let unregister: (() => void) | undefined;
    let ownershipDb: ReturnType<typeof openDb> | undefined;
    let registrationError: unknown;
    let cancelled = false;
    let cancelPoll: ReturnType<typeof setInterval> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (cancelPoll) clearInterval(cancelPoll);
      if (killTimer) clearTimeout(killTimer);
      try { unregister?.(); }
      finally {
        unregister = undefined;
        ownershipDb?.close();
        ownershipDb = undefined;
        rmSync(receiptDir, { recursive: true, force: true });
      }
    };
    let tail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
      tail = (tail + chunk.toString()).slice(-4000);
    });
    child.on("error", (error) => {
      registrationError = error;
      // A kill error does not mean a live child has exited. Retain ownership
      // until close; only a failed spawn with no PID can be released now.
      if (!child.pid) { cleanup(); reject(error); }
    });
    child.on("close", (code) => {
      const lines = tail.split("\n").map((l) => l.trim()).filter(Boolean);
      let resultReportId: number | undefined;
      try {
        const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
        const report = receipt.version === 1 && Array.isArray(receipt.reports)
          ? receipt.reports.find((r: { storeId?: string; reportId?: number }) => r.storeId === storeId && Number.isSafeInteger(r.reportId) && Number(r.reportId) > 0)
          : null;
        resultReportId = report?.reportId;
      } catch { /* No receipt means no recorded result; never substitute an older report. */ }
      finally { cleanup(); }
      if (registrationError) { reject(registrationError); return; }
      resolve({ code, tail: lines.at(-1) ?? "", ...(resultReportId ? { resultReportId } : {}), ...(cancelled ? { cancelled: true } : {}) });
    });
    const dbIndex = assessArgs.lastIndexOf("--db");
    const dbPath = dbIndex >= 0 ? assessArgs[dbIndex + 1] : undefined;
    if (child.pid && dbPath) {
      try {
        ownershipDb = openDb(dbPath);
        unregister = registerExecutorChild(ownershipDb, child.pid);
        const jobId = Number(env?.EXTRAY_ANALYSIS_JOB_ID);
        const attemptId = Number(env?.EXTRAY_ANALYSIS_ATTEMPT_ID);
        if (Number.isSafeInteger(jobId) && jobId > 0) {
          const check = () => {
            if (cancelled || !ownershipDb) return;
            const row = ownershipDb.prepare("SELECT cancel_requested_at FROM submission WHERE id=? AND current_attempt_id=? AND status='running'").get(jobId, attemptId);
            if (!row?.cancel_requested_at) return;
            cancelled = true;
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
            killTimer.unref();
          };
          cancelPoll = setInterval(check, 250);
          cancelPoll.unref();
          check();
        }
      } catch (error) {
        // Never continue spending with a child whose ownership could not be saved.
        registrationError = error;
        child.kill("SIGKILL");
        // Keep cleanup attached to close: the child is not gone until then.
      }
    }
  });

export interface PaceOpts {
  /** Analysis flags (assess args), incl. --model; --db should already be appended. */
  assessArgs: string[];
  env?: NodeJS.ProcessEnv;
  /** Enable wait-and-resume on rate limit. When false, a rate-limit is returned as-is. */
  wait?: boolean;
  pollMs?: number;
  maxWaitMs?: number;
  /** Max wait-and-retry cycles for one extension before giving up. Default 4. */
  maxWaitCycles?: number;
  /** Usage gauge printed while waiting (e.g. () => formatUsage(sessionUsageWindow(db))). */
  usageLine?: () => string;
  // Injectable seams (tests):
  spawnImpl?: SpawnAssess;
  waitImpl?: (opts: WaitOpts) => Promise<void>;
  host?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

/**
 * Run assess on one extension, and if it fails because the Ollama session is
 * rate-limited, wait for the session to reset and retry the SAME extension
 * (cheap: prior successful calls are cached). Non-rate-limit failures return
 * immediately for the caller's normal per-extension handling.
 */
export async function runAssessPaced(storeId: string, opts: PaceOpts): Promise<AssessOutcome> {
  const spawnAssess = opts.spawnImpl ?? spawnAssessReal;
  const waitFn = opts.waitImpl ?? waitForSessionReset;
  const wait = opts.wait ?? true;
  const maxCycles = opts.maxWaitCycles ?? 4;
  const model = modelFromAssessArgs(opts.assessArgs) ?? "glm-5.2:cloud";
  const log = opts.log ?? ((m) => process.stderr.write(m + "\n"));

  let cycles = 0;
  for (;;) {
    const { code, tail, resultReportId, cancelled } = await spawnAssess(storeId, opts.assessArgs, opts.env);
    if (cancelled) return { code, lastStderrLine: null, rateLimited: false, cancelled: true, ...(resultReportId ? { resultReportId } : {}) };
    if (code === 0 || code === 6) return { code, lastStderrLine: tail || null, rateLimited: false, ...(resultReportId ? { resultReportId } : {}) };
    // Exit 5 is assess's structured rate-limit signal; the stderr sniff stays
    // as a fallback for older builds / signals that skip classification.
    const rateLimited = code === EXIT_RATE_LIMITED || looksRateLimited(tail);
    if (!rateLimited || !wait) return { code, lastStderrLine: tail || null, rateLimited };
    if (cycles >= maxCycles) {
      log(`✗  ${storeId}: still rate-limited after ${maxCycles} wait cycle(s) — giving up on this extension.`);
      return { code, lastStderrLine: tail || null, rateLimited: true };
    }
    cycles++;
    await waitFn({
      model,
      host: opts.host,
      apiKey: opts.apiKey,
      fetchImpl: opts.fetchImpl,
      pollMs: opts.pollMs,
      maxWaitMs: opts.maxWaitMs,
      usageLine: opts.usageLine,
      log,
    });
    log(`↻  retrying ${storeId} (wait cycle ${cycles}/${maxCycles})…`);
  }
}
