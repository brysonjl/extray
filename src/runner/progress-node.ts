import { openDb } from "../db/index.ts";
import { SqliteDataSource } from "../product/datasource.ts";
import { appendAnalysisEvent } from "../jobs/events.ts";

/** Only queue-owned invocations carry these identities. CLI runs stay standalone. */
export async function recordAssessStage(stage: string, phase: "started" | "finished" | "skipped" | "failed", message: string): Promise<void> {
  if (!/^[a-z0-9:_-]{1,100}$/.test(stage)) return;
  const id = Number(process.env.EXTRAY_ANALYSIS_JOB_ID);
  const attempt = Number(process.env.EXTRAY_ANALYSIS_ATTEMPT_ID);
  const path = process.env.EXTRAY_ANALYSIS_DB;
  if (!path || !Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(attempt) || attempt <= 0) return;
  const db = openDb(path);
  try {
    const active = db.prepare("SELECT id FROM submission WHERE id=? AND current_attempt_id=? AND status='running'").get(id, attempt);
    if (!active) return;
    await appendAnalysisEvent(new SqliteDataSource(db), id, { kind: `stage-${phase}`, stage, message, attemptId: attempt });
  } finally { db.close(); }
}
