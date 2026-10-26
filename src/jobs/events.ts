import type { DataSource } from "../product/datasource.ts";
import { safe } from "../product/datasource.ts";

/** Fixed stage names describe boundaries actually reached by assess. */
export const ANALYSIS_STAGES = ["preparation", "static-analysis", "investigation", "report-recording"] as const;
export type AnalysisStage = typeof ANALYSIS_STAGES[number];
export async function appendAnalysisEvent(ds: DataSource, jobId: number, event: {
  kind: string; stage?: string | null; message: string; attemptId?: number | null; now?: Date;
}): Promise<void> {
  await safe(() => ds.run(`INSERT INTO analysis_event (submission_id,attempt_id,sequence,kind,stage,message,created_at)
    SELECT ?, ?, COALESCE(MAX(sequence),0)+1, ?, ?, ?, ? FROM analysis_event WHERE submission_id=?`,
    jobId, event.attemptId ?? null, event.kind, event.stage ?? null, event.message.slice(0, 500), (event.now ?? new Date()).toISOString(), jobId), { changes: 0, lastInsertRowid: 0 });
}
