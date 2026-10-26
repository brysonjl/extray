// Shared per-sample report writer for the corpus CLIs (reports + scorecard).
// Both render the SAME three artifacts from a methodology's structured output —
// machine JSON, human Markdown, and a self-contained HTML report — so whatever
// a developer opens (the HTML) is the same assessment the scorecard graded.
//
// The HTML is rendered from the MonolithTrace.risk_report (the structured
// contract); arms that do not produce one get md/json only.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MethodologyOutput } from "../src/methodologies/types.ts";
import type { MonolithTrace } from "../src/methodologies/monolith.ts";
import { renderReportHtml } from "../src/report/render-html.ts";

export interface SampleArtifactInput {
  sample: string;
  kind?: string;
  expectedTier?: string;
  methodology: string;
  model: string;
  output: MethodologyOutput;
}

function provenanceHeader(meta: SampleArtifactInput): string {
  const label = meta.kind ? `label: ${meta.kind}, expected tier \`${meta.expectedTier}\` · ` : "";
  return [
    "<!-- generated report — do not hand-edit; regenerate with `npm run reports` / `npm run scorecard` -->",
    `> **${meta.sample}** · methodology: \`${meta.methodology}\` · model: \`${meta.model}\``,
    `> ${label}usage: ${meta.output.usage.inputTokens}/${meta.output.usage.outputTokens} tokens`,
    "",
  ].join("\n");
}

/** Write <sample>.{json,md,html} into `dir`. HTML only when the arm produced a
 *  structured risk_report. Returns the paths written. */
export function writeSampleArtifacts(dir: string, meta: SampleArtifactInput): string[] {
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];

  const jsonPath = join(dir, `${meta.sample}.json`);
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        sample: meta.sample,
        ...(meta.kind ? { kind: meta.kind, expected_tier: meta.expectedTier } : {}),
        methodology: meta.methodology,
        model: meta.model,
        tier: meta.output.tier ?? null,
        report: meta.output.report,
        usage: meta.output.usage,
        ...(meta.output.structured !== undefined ? { structured: meta.output.structured } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  written.push(jsonPath);

  const mdPath = join(dir, `${meta.sample}.md`);
  writeFileSync(mdPath, provenanceHeader(meta) + meta.output.report + "\n");
  written.push(mdPath);

  const riskReport = (meta.output.structured as MonolithTrace | undefined)?.risk_report;
  if (riskReport) {
    const htmlPath = join(dir, `${meta.sample}.html`);
    writeFileSync(htmlPath, renderReportHtml(riskReport));
    written.push(htmlPath);
  }
  return written;
}
