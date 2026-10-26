// Scorecard renderers. JSON is the machine record (feeds #2's cross-arm
// comparison); Markdown is the human scorecard. Coverage is shown SPLIT (A–G and
// H co-headline, never blended). Judge `rationale` strings — which may carry
// text influenced by adversarial extension content — are rendered as
// provenance-labeled quoted blocks, never interpolated into scorecard prose.

import { renderUsageTable } from "../llm/usage.ts";
import type { ScorecardResult } from "./index.ts";
import { STABILITY_SENTINEL } from "./metrics.ts";

export function renderJson(result: ScorecardResult): string {
  return JSON.stringify(result, null, 2) + "\n";
}

function pct(n: number | null): string {
  return n === null ? "n/a" : `${(n * 100).toFixed(0)}%`;
}

function stabilityStr(s: number | typeof STABILITY_SENTINEL): string {
  return s === STABILITY_SENTINEL ? STABILITY_SENTINEL : `${(s * 100).toFixed(0)}%`;
}

export function renderMarkdown(result: ScorecardResult): string {
  const t = result.totals;
  const L: string[] = [];
  L.push(`# Scorecard — ${result.methodology} (model: ${result.model}, judge: ${result.judge_model}, runs: ${result.runs})`);
  L.push("");
  L.push("## Headline");
  L.push("| metric | value |");
  L.push("| --- | --- |");
  L.push(`| coverage — known shapes (A–G) **[PRIMARY]** | ${pct(t.coverage_known_shapes)} |`);
  L.push(`| coverage — open world (H) | ${pct(t.coverage_open_world)} |`);
  L.push(`| tier-recall (secondary) | ${pct(t.tier_recall)} |`);
  L.push(`| unsafe misses (dismissals + hedged) | ${t.unsafe_misses} (${t.false_dismissals} confident + ${t.hedged_misses} hedged) |`);
  L.push(`| benign false alarms | ${t.false_alarm_samples.length}${t.false_alarm_samples.length ? ` (${t.false_alarm_samples.join(", ")})` : ""} |`);
  L.push(`| run-to-run stability | ${stabilityStr(t.stability)} |`);
  L.push(`| cost — arm only (in/out tokens) | ${t.cost.inputTokens} / ${t.cost.outputTokens} |`);
  if (result.accounting.estimatedUsd !== null) {
    L.push(`| est. full-run cost (USD) | $${result.accounting.estimatedUsd.toFixed(4)} |`);
  }
  L.push("");

  // Full-run accounting: every LLM call by step, including judge/normalize —
  // the headline `cost` row above is the arm's own usage only.
  L.push("## Run accounting (tokens & cost by step)");
  L.push(renderUsageTable(result.accounting));
  L.push("");

  L.push("## Bellwether (per-arm — NOT a product no-build verdict)");
  L.push(`B (tampered lib): ${pct(result.bellwether.B)} · E (cross-file): ${pct(result.bellwether.E)} · G (stacked B+E): ${pct(result.bellwether.G)}`);
  L.push(result.bellwether.per_arm_missed
    ? "> ⚠️ a bellwether behavior was completely missed by this arm — pending the other two arms before any BUILD/NO-BUILD read (#2)."
    : "> all bellwether behaviors had non-zero coverage for this arm.");
  L.push("");

  L.push("## Generalization probe (H)");
  L.push(`detected: ${result.generalization_H.detected} · coverage: ${pct(result.generalization_H.coverage)}`);
  if (result.generalization_H.tier_masked) {
    L.push("> ⚠️ H rated at its expected tier (`concerning`) but its covert channel was NOT detected — tier-recall masks this open-world miss.");
  }
  L.push("");

  L.push("## Per-sample");
  for (const s of result.per_sample) {
    L.push(`### ${s.sample} (${s.kind}, expected ${s.expected_tier} → ${s.normalized_tier} [${s.tier_source}])`);
    if (s.kind === "malicious") {
      L.push(`coverage ${pct(s.coverage)}${s.miss_kind ? ` · miss: ${s.miss_kind}` : ""}`);
      for (const m of s.must_detect) {
        L.push(`- [${m.satisfied ? "x" : " "}] ${m.behavior}`);
        if (m.rationale) L.push(`  > _judge:_ ${m.rationale}`);
      }
    } else {
      L.push(`cleared: ${!s.false_alarm}${s.false_alarm ? " — FALSE ALARM" : ""}`);
      for (const c of s.must_not_emit ?? []) {
        L.push(`- ${c.asserted ? "⚠️ asserted" : "ok"}: ${c.class}`);
        if (c.rationale) L.push(`  > _judge:_ ${c.rationale}`);
      }
    }
    L.push("");
  }

  L.push("## Caveats (read the ranking with these limits)");
  for (const c of result.caveats) L.push(`- ${c}`);
  L.push("");
  return L.join("\n");
}
