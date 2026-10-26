import type { AnalysisOutcome } from "./contract.ts";

export function outcomeNotice(outcome: AnalysisOutcome | undefined): string | null {
  if (outcome?.investigation !== "incomplete") return null;
  return `Incomplete investigation — provisional assessment. Report artifact generated; final submission ${outcome.final_submission}. ` +
    `Individual verified findings remain useful; full investigation coverage is not established. ${outcome.reasons.join("; ")}`;
}

/** Read historical pi traces as well as new reports. Missing metadata on other
 * methods establishes neither completion nor incompleteness. */
export function outcomeFromStructured(structured: unknown): AnalysisOutcome | undefined {
  const s = structured as { risk_report?: { outcome?: AnalysisOutcome }; pi?: {
    sharded?: boolean; incomplete?: boolean; aborted?: boolean; submitted?: boolean;
    shards?: { aborted: boolean; submitted: boolean }[]; synthesis?: { aborted: boolean; submitted: boolean };
  } } | undefined;
  if (s?.risk_report?.outcome) return s.risk_report.outcome;
  const pi = s?.pi;
  if (!pi) return undefined;
  const sessions = pi.sharded ? [...(pi.shards ?? []), ...(pi.synthesis ? [pi.synthesis] : [])] : [pi];
  const accepted = sessions.length > 0 && sessions.every((x) => x.submitted === true);
  const incomplete = pi.incomplete === true || !accepted || sessions.some((x) => x.aborted);
  return { artifact_generated: true, investigation: incomplete ? "incomplete" : "complete",
    final_submission: accepted ? "accepted" : "not-accepted",
    reasons: incomplete ? ["Historical pi trace indicates an aborted or unsubmitted investigation; detailed stop reasons may be unavailable."] : [] };
}
