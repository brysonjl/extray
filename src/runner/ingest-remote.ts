// Remote submission ingest: pull queued rows from the deployed D1 and mirror
// them into the LOCAL unified queue (submission rows with source='remote' +
// origin_id), where the runner claims and analyzes them. The drain invariant
// is preserved: remote rows stay `queued` the whole time — explorer:sync's
// close-loop is the single writer that flips them to succeeded; only outright
// failures (malformed input, per-extension assess failures) are written back
// here so the remote queue converges.
//
// The pure planning half (planDrain, planIngest, the failure-update SQL, the
// arm preflights) moved here from scripts/drain-submissions.ts, which now
// imports it back — the manual drain and the daemon share one implementation.

import type { DataSource } from "../product/datasource.ts";
import { allowedArms, armKey, type ProductionProfile } from "../product/profile.ts";
import { createSubmission, findActiveSubmission, findByOriginId, findConfiguredSubmission, getSubmission } from "../jobs/service.ts";
import type { SubmissionConfig } from "../product/submission-config.ts";

export interface QueuedRow {
  id: number;
  store_id: string | null;
}

export interface DrainPlan {
  /** One analysis per distinct store_id, oldest submission first; closing is
   *  per-row, so every queued job sharing the id rides one assess run. */
  work: { storeId: string; submissionIds: number[] }[];
  /** Rows the API should never produce (missing/malformed store_id) — failed
   *  outright rather than analyzed. */
  rejected: { id: number; reason: string }[];
}

const STORE_ID_RE = /^[a-p]{32}$/;

export function planDrain(rows: QueuedRow[]): DrainPlan {
  const byStore = new Map<string, number[]>();
  const rejected: DrainPlan["rejected"] = [];
  for (const r of rows) {
    if (!Number.isInteger(r.id)) throw new Error(`non-integer submission id: ${String(r.id)}`);
    if (!r.store_id) rejected.push({ id: r.id, reason: "no store id extracted from input" });
    else if (!STORE_ID_RE.test(r.store_id)) rejected.push({ id: r.id, reason: `invalid store id ${JSON.stringify(r.store_id)}` });
    else byStore.set(r.store_id, [...(byStore.get(r.store_id) ?? []), r.id]);
  }
  return { work: [...byStore].map(([storeId, submissionIds]) => ({ storeId, submissionIds })), rejected };
}

/** UPDATE statements that mark submissions failed. Interpolated values are
 *  integers we validate, a generated ISO timestamp, and an error message we
 *  escape + truncate (it is shown verbatim on the Submit page). The status
 *  guard keeps a concurrent sync/worker safe. */
export function planFailureUpdates(failures: { ids: number[]; error: string }[], nowIso: string): string[] {
  return failures.map((f) => {
    for (const id of f.ids) {
      if (!Number.isInteger(id)) throw new Error(`non-integer submission id: ${String(id)}`);
    }
    const msg = f.error.replace(/\s+/g, " ").trim().slice(0, 300).replace(/'/g, "''");
    return (
      `UPDATE submission SET status = 'failed', error = '${msg}', finished_at = '${nowIso}' ` +
      `WHERE id IN (${f.ids.join(", ")}) AND status = 'queued';`
    );
  });
}

/** Store-keyed variant for the runner: the local mirror carries one origin_id,
 *  but every remote row for the store must converge — key the write-back on
 *  the (validated) store id instead of enumerating remote ids. */
export function planFailureUpdatesByStore(failures: { storeId: string; error: string }[], nowIso: string): string[] {
  return failures.map((f) => {
    if (!STORE_ID_RE.test(f.storeId)) throw new Error(`invalid store id ${JSON.stringify(f.storeId)}`);
    const msg = f.error.replace(/\s+/g, " ").trim().slice(0, 300).replace(/'/g, "''");
    return (
      `UPDATE submission SET status = 'failed', error = '${msg}', finished_at = '${nowIso}' ` +
      `WHERE store_id = '${f.storeId}' AND status = 'queued';`
    );
  });
}

/** The arm keys these assess flags would record, mirroring assess's own flag
 *  defaults ($SCORECARD_MODEL / monolith) and commander's last-wins semantics
 *  for repeated options. */
function effectiveArmKeys(assessArgs: string[], env: Record<string, string | undefined>): string[] {
  const flagValue = (flag: string): string | undefined => {
    const i = assessArgs.lastIndexOf(flag);
    return i >= 0 ? assessArgs[i + 1] : undefined;
  };
  const model = flagValue("--model") ?? env.SCORECARD_MODEL ?? "unspecified";
  return (flagValue("--methodology") ?? "monolith")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((methodology) => armKey({ methodology, model }));
}

/** Why analyzing with these assess flags would be pointless, or null when they
 *  are fine: the recorded (methodology, model) arm must be user-visible under
 *  the active profile, or the sync close-loop can never close the jobs the
 *  analyses were run for. */
export function armVisibilityError(
  assessArgs: string[],
  profile: ProductionProfile,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const arms = effectiveArmKeys(assessArgs, env);
  const visible = new Set(allowedArms(profile, "user").map(armKey));
  if (arms.some((a) => visible.has(a))) return null;
  return (
    `assess would record arm(s) ${arms.join(", ")}, but none is user-visible under the active profile ` +
    `(pinned ${armKey(profile.pinned)}) — the analyses would run yet never close a job. Align ` +
    `--methodology/--model with the profile, or set EXPLORER_PROFILE to match the deployment's.`
  );
}

/** Loud-but-not-fatal: a fallback arm closes jobs only for extensions with no
 *  pinned-arm report yet — canonical selection ranks the pinned arm first, so
 *  a re-analysis job for an already-assessed extension stays open until a
 *  genuinely new PINNED-arm report lands. Null when the flags run the pinned
 *  arm (or the visibility check already failed). */
export function pinnedArmWarning(
  assessArgs: string[],
  profile: ProductionProfile,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const arms = effectiveArmKeys(assessArgs, env);
  if (arms.includes(armKey(profile.pinned))) return null;
  return (
    `assess arm(s) ${arms.join(", ")} are user-visible but NOT the pinned arm ` +
    `(${armKey(profile.pinned)}) — jobs for extensions that already have a pinned-arm report will ` +
    `stay open (a fallback arm never outranks the pinned verdict).`
  );
}

// ---- ingest (mirror remote rows into the local queue) ------------------------

export interface IngestDeps {
  ds: DataSource;
  profile: ProductionProfile;
  /** wrangler-backed reads/writes — injectable for tests. */
  d1Query: (sql: string) => Record<string, unknown>[] | null;
  d1Write: (statements: string[]) => void;
  priority: number;
  configuration?: SubmissionConfig;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface IngestResult {
  pulled: number;
  mirrored: number;
  alreadyMirrored: number;
  rejected: number;
}

/** One ingest pass: pull remote queued rows, fail malformed ones back to D1,
 *  and mirror each fresh store id as a local queued submission
 *  (source='remote', origin_id = the oldest remote row's id). Dedup: a local
 *  row with the same origin_id, or ANY live local job for the store id
 *  (user/admin/discovery included — one analysis serves them all; the sync
 *  close-loop converges every remote row for the store). */
export async function ingestRemote(deps: IngestDeps): Promise<IngestResult> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const rows = deps.d1Query(
    "SELECT id, store_id FROM submission WHERE status = 'queued' AND id > 0 ORDER BY created_at ASC, id ASC",
  );
  const plan = planDrain((rows ?? []) as unknown as QueuedRow[]);

  if (plan.rejected.length > 0) {
    const statements = planFailureUpdates(
      plan.rejected.map((r) => ({ ids: [r.id], error: r.reason })),
      now().toISOString(),
    );
    deps.d1Write(statements);
    for (const r of plan.rejected) log(`ingest: remote job ${r.id} marked failed (${r.reason})`);
  }

  let mirrored = 0;
  let alreadyMirrored = 0;
  for (const w of plan.work) {
    // Resolve every already-mirrored request separately. A completed request
    // still queued remotely must not swallow a newer request for the same store.
    const freshIds: number[] = [];
    for (const id of w.submissionIds) {
      const membership = await deps.ds.get("SELECT submission_id FROM analysis_remote_origin WHERE remote_id = ?", id);
      const previous = membership ? await getSubmission(deps.ds, Number(membership.submission_id)) : await findByOriginId(deps.ds, id);
      if (previous) await deps.ds.run("INSERT OR IGNORE INTO analysis_remote_origin(remote_id,submission_id) VALUES(?,?)", id, previous.id);
      else freshIds.push(id);
    }
    if (!freshIds.length) { alreadyMirrored++; continue; }
    const active = deps.configuration
      ? await findConfiguredSubmission(deps.ds, w.storeId, deps.configuration)
      : await findActiveSubmission(deps.ds, w.storeId);
    if (active) {
      for (const id of freshIds) await deps.ds.run("INSERT OR IGNORE INTO analysis_remote_origin(remote_id,submission_id) VALUES(?,?)", id, active.id);
      alreadyMirrored++;
      continue;
    }
    const originId = Math.min(...freshIds);
    const created = await createSubmission(deps.ds, {
      inputRaw: w.storeId,
      storeId: w.storeId,
      profile: deps.profile,
      requestedBy: "runner:ingest",
      source: "remote",
      priority: deps.priority,
      originId,
      configuration: deps.configuration,
      now: now(),
    });
    for (const id of freshIds) await deps.ds.run("INSERT OR IGNORE INTO analysis_remote_origin(remote_id,submission_id) VALUES(?,?)", id, created.id);
    mirrored++;
    log(`ingest: mirrored ${w.storeId} (remote job ${freshIds.join(", ")})`);
  }
  return { pulled: plan.work.length, mirrored, alreadyMirrored, rejected: plan.rejected.length };
}
