import type { Finding } from "../methodologies/findings.ts";
import type { Dimension } from "../methodologies/pi/guidance.ts";

export interface PortableReview {
  schema_version: "1.0";
  methodology: "extray-review";
  verification: "not-run";
  target: { name: string; version: string };
  evidence_mode: "source-only" | "source-and-pack";
  investigation: "complete" | "incomplete";
  summary: string;
  findings: Finding[];
  coverage: Array<{
    dimension: Dimension;
    status: "findings" | "cleared" | "inconclusive";
    finding_ids: string[];
    checks_run: string[];
    note: string;
  }>;
  limitations: string[];
}

/** Imported candidates never enter RiskReport.findings or the engine verdict. */
export interface ImportedSkillReview {
  provenance: {
    harness: string;
    model: string;
    session_id: string | null;
    skill_version: string;
    skill_sha256: string;
    review_sha256: string;
    source_sha256: string;
    reviewed_at: string;
    verification: "not-run";
  };
  review: PortableReview;
}
