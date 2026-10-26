/** Portable, exact-report analysis workbench. Only sanitized product DTOs leave this seam. */
import { reportById } from "./canonical.ts";
import { buildExtensionDetail, type ExtensionDetail, type Finding } from "./dto.ts";
import type { DataSource } from "./datasource.ts";
import type { ProductionProfile } from "./profile.ts";
import { parseSubmissionConfig, type SubmissionConfig } from "./submission-config.ts";

export interface ResultUsageStep {
  label: string;
  model: string;
  scope: "target" | "shared-run";
  calls: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  wallClockMs: number | null;
  costUsd: number | null;
}
export interface ResultWorkbench {
  reportId: number;
  runId: number;
  detail: ExtensionDetail;
  execution: {
    methodology: string;
    model: string;
    verifierModel: string | null;
    reasoning: string | null;
    mode: string | null;
    gitSha: string | null;
    engineVersion: string | null;
    compressionProxy: boolean | null;
    modelAllocation: Record<string, string> | null;
  };
  submission: { jobId: number; configuration: SubmissionConfig | null } | null;
  usage: {
    steps: ResultUsageStep[];
    available: boolean;
    truncated: boolean;
    unpricedSteps: number;
    pricedStepsUsd: number | null;
    /** The report's own total; shared run costs are never attributed to one target. */
    reportCostUsd: number | null;
    reportInputTokens: number | null;
    reportOutputTokens: number | null;
  };
  artifacts: {
    source: "lookup-available" | "not-recorded" | "not-served";
    exports: ("json" | "markdown")[];
  };
}
export type FindingChange = "added" | "removed" | "changed" | "unchanged";
export interface FindingDifference {
  key: string;
  change: FindingChange;
  before: Finding | null;
  after: Finding | null;
}
export interface ResultComparison {
  storeId: string;
  left: ResultWorkbench;
  right: ResultWorkbench;
  differentVersion: boolean | null;
  findings: FindingDifference[];
  counts: Record<FindingChange, number>;
  matching: string;
}

const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: unknown): string | null => typeof value === "string" && value ? value.slice(0, 500) : null;
async function columns(ds: DataSource, table: "run" | "usage" | "submission" | "target"): Promise<Set<string>> {
  return new Set((await ds.all(`PRAGMA table_info(${table})`)).map((row) => String(row.name)));
}
function models(value: unknown): Record<string, string> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed).filter(([key, model]) => /^[a-z_-]{1,60}$/i.test(key) && typeof model === "string" && model.length < 201);
    return entries.length ? Object.fromEntries(entries) : null;
  } catch { return null; }
}

export async function resultWorkbench(ds: DataSource, id: number, profile: ProductionProfile, sourceReaderAvailable = false): Promise<ResultWorkbench | null> {
  const row = await reportById(ds, id, profile);
  if (!row) return null;
  const detail = await buildExtensionDetail(ds, row, "admin", profile);
  if (!detail) return null;
  const [runColumns, usageColumns, submissionColumns, targetColumns] = await Promise.all([
    columns(ds, "run"), columns(ds, "usage"), columns(ds, "submission"), columns(ds, "target"),
  ]);
  const optional = ["verifier_model", "headroom", "subagent_models"].map((key) => runColumns.has(key) ? `r.${key}` : `NULL AS ${key}`).join(",");
  const actual = await ds.get(`SELECT rep.run_id, rep.target_id, ${optional}, ${targetColumns.has("source_dir") ? "t.source_dir" : "NULL AS source_dir"}
    FROM report rep JOIN run r ON r.id=rep.run_id JOIN target t ON t.id=rep.target_id WHERE rep.id=?`, id);
  if (!actual) return null;
  let submission: ResultWorkbench["submission"] = null;
  if (["id", "result_report_id"].every((key) => submissionColumns.has(key))) {
    const job = await ds.get(`SELECT id, ${submissionColumns.has("config_json") ? "config_json" : "NULL AS config_json"} FROM submission WHERE result_report_id=? ORDER BY id DESC LIMIT 1`, id);
    if (job) submission = { jobId: Number(job.id), configuration: parseSubmissionConfig(job.config_json) };
  }
  const available = ["run_id", "target_id", "label", "model"].every((key) => usageColumns.has(key));
  const fields = ["calls", "input_tokens", "output_tokens", "wall_clock_ms", "estimated_usd"].map((key) => usageColumns.has(key) ? key : `NULL AS ${key}`).join(",");
  const usageRows = available ? await ds.all(`SELECT label,model,target_id,${fields} FROM usage WHERE run_id=? AND (target_id=? OR target_id IS NULL) ORDER BY ${usageColumns.has("id") ? "id" : "label"} LIMIT 2001`, actual.run_id as number, actual.target_id as number) : [];
  const steps: ResultUsageStep[] = usageRows.slice(0, 2000).map((step) => ({
    label: text(step.label) ?? "Unlabeled step", model: text(step.model) ?? "Unknown model", scope: step.target_id == null ? "shared-run" : "target",
    calls: number(step.calls), inputTokens: number(step.input_tokens), outputTokens: number(step.output_tokens), wallClockMs: number(step.wall_clock_ms), costUsd: number(step.estimated_usd),
  }));
  const targetSteps = steps.filter((step) => step.scope === "target");
  const priced = targetSteps.filter((step) => step.costUsd !== null);
  return {
    reportId: id, runId: Number(actual.run_id), detail,
    execution: { methodology: row.methodology, model: row.model, verifierModel: text(actual.verifier_model), reasoning: row.think, mode: row.mode, gitSha: row.gitSha, engineVersion: row.analyzerVersion, compressionProxy: actual.headroom === 0 ? false : actual.headroom === 1 ? true : null, modelAllocation: models(actual.subagent_models) },
    submission,
    usage: { steps, available, truncated: usageRows.length > 2000, unpricedSteps: steps.filter((step) => step.costUsd === null).length, pricedStepsUsd: priced.length ? priced.reduce((sum, step) => sum + step.costUsd!, 0) : null, reportCostUsd: row.estimatedUsd, reportInputTokens: row.inputTokens, reportOutputTokens: row.outputTokens },
    artifacts: { source: !sourceReaderAvailable ? "not-served" : typeof actual.source_dir === "string" && actual.source_dir ? "lookup-available" : "not-recorded", exports: ["json", "markdown"] },
  };
}

const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
/** IDs often restart at f1 across methodologies. Match by title/category instead
 * of pretending ordinal identifiers establish semantic correspondence. */
export function compareFindings(before: Finding[], after: Finding[]): FindingDifference[] {
  const key = (finding: Finding) => JSON.stringify([normalize(finding.category), normalize(finding.title)]);
  const remaining = after.map((finding, index) => ({ finding, index, used: false }));
  const differences: FindingDifference[] = before.map((finding, index) => {
    const match = remaining.find((candidate) => !candidate.used && key(candidate.finding) === key(finding));
    if (!match) return { key: `left-${index}`, change: "removed", before: finding, after: null };
    match.used = true;
    const content = (item: Finding) => JSON.stringify({ severity: item.severity, confidence: item.confidence, kind: item.kind, title: normalize(item.title), category: normalize(item.category), detail: item.detail, claimedMechanism: item.claimedMechanism, evidence: [...item.evidence].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
    return { key: `pair-${index}-${match.index}`, change: content(finding) === content(match.finding) ? "unchanged" : "changed", before: finding, after: match.finding };
  });
  for (const item of remaining) if (!item.used) differences.push({ key: `right-${item.index}`, change: "added", before: null, after: item.finding });
  return differences;
}

export async function compareResults(ds: DataSource, leftId: number, rightId: number, profile: ProductionProfile, sourceReaderAvailable = false): Promise<ResultComparison | null> {
  const [left, right] = await Promise.all([resultWorkbench(ds, leftId, profile, sourceReaderAvailable), resultWorkbench(ds, rightId, profile, sourceReaderAvailable)]);
  if (!left || !right || left.detail.identity.storeId !== right.detail.identity.storeId) return null;
  const findings = compareFindings(left.detail.findings, right.detail.findings);
  const counts = { added: 0, removed: 0, changed: 0, unchanged: 0 };
  for (const finding of findings) counts[finding.change]++;
  return { storeId: left.detail.identity.storeId, left, right, findings, counts,
    differentVersion: left.detail.identity.version !== null && right.detail.identity.version !== null ? left.detail.identity.version !== right.detail.identity.version : null,
    matching: "Findings match by normalized title and category, in recorded order. Wording changes can appear as added and removed. Added/removed means reported in one analysis, not proof the behavior appeared or disappeared.",
  };
}

const mdText = (value: string) => value.replace(/[\\`*_{}\[\]<>#|]/g, "\\$&");
export function resultMarkdown(result: ResultWorkbench): string {
  const { detail, execution, usage } = result;
  const out = [
    `# ${mdText(detail.identity.name)} — report ${result.reportId}`, "",
    ...(detail.identity.synthetic ? ["**Synthetic test fixture. This is not a real extension assessment.**", ""] : []),
    `Extension: ${mdText(detail.identity.storeId)}`, `Version: ${mdText(detail.identity.version ?? "not recorded")}`,
    `Assessed: ${mdText(detail.provenance.assessedAt)}`, `Methodology: ${mdText(execution.methodology)} · Model: ${mdText(execution.model)}`,
    `Investigation: ${detail.outcome?.investigation ?? "not recorded"} · Final submission: ${detail.outcome?.final_submission ?? "not recorded"}`,
    "", "## Assessment", "", mdText(detail.verdict.tier ?? "Not recorded"), "", mdText(detail.verdict.rationale), "", mdText(detail.summaries.technical || detail.summaries.layperson),
    "", "## Findings", "",
  ];
  for (const finding of detail.findings) {
    out.push(`### ${mdText(finding.title || "Untitled finding")}`, "", `Severity: ${mdText(finding.severity || "unknown")} · Confidence: ${mdText(finding.confidence ?? "not recorded")}`, "", mdText(finding.detail), "");
    for (const evidence of finding.evidence) out.push(`- Report ${result.reportId} · ${mdText(evidence.file)}${evidence.line === null ? "" : `:${evidence.line}`}${evidence.symbolOrSink ? ` · ${mdText(evidence.symbolOrSink)}` : ""}`);
    out.push("");
  }
  if (!detail.findings.length) out.push("No findings recorded.", "");
  out.push("## Limitations", "", ...[...(detail.outcome?.reasons ?? []), ...detail.structuralLimits, ...detail.unparsedFiles.map((path) => `Unparsed: ${path}`)].map((reason) => `- ${mdText(reason)}`), "", "Source references identify this exact report. Source files may be unavailable or may have changed on the host.", "", "## Accounting", "", `Recorded report cost: ${usage.reportCostUsd === null ? "unknown" : `$${usage.reportCostUsd.toFixed(6)}`}`, "", "| Step | Model | Scope | Input tokens | Output tokens | USD |", "| --- | --- | --- | ---: | ---: | ---: |");
  for (const step of usage.steps) out.push(`| ${mdText(step.label)} | ${mdText(step.model)} | ${step.scope} | ${step.inputTokens ?? "unknown"} | ${step.outputTokens ?? "unknown"} | ${step.costUsd === null ? "unpriced" : step.costUsd.toFixed(6)} |`);
  out.push("", "Unpriced usage is unknown, not zero. Shared run accounting is not attributed to this extension.", "", "## Recorded execution and submitted configuration", "", "```json", JSON.stringify({ execution, submission: result.submission }, null, 2).replace(/`/g, "\\u0060"), "```", "");
  return out.join("\n");
}
