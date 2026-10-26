// Humanization, NOT decision. Runs LAST, after the deterministic verdict engine
// (report/verdict.ts) has already decided the tier and per-area breakdown. This
// node receives that verdict as a given and writes the human-readable prose
// (layperson + technical summaries) plus the description-deviation observation.
// It is structurally incapable of changing the verdict — the tier it is told is
// the tier the report ships and the scorecard grades. (Earlier this node DECIDED
// the tier; that conflated the analysis layer's judgment with its narration and
// let an LLM re-read sway the result. The analysis layer is now king.)
//
// It still sees ONLY the asserted finding set + the deterministic digests + the
// decided verdict, and is told NEVER to re-assert an excluded claim. The
// description-deviation field is an OBSERVATION surfaced to the reader; it does
// not feed back into the (already-computed) tier.

import type { LlmClient, Usage } from "../llm/client.ts";
import { buildPrompt } from "../llm/envelope.ts";
import { fixtureFileName } from "../llm/record-replay.ts";
import { lastObjectWith } from "../scorecard/parse.ts";
import type {
  DescriptionDeviation,
  DestinationsSection,
  DeveloperSection,
  ExcludedClaim,
  ObfuscationSection,
  PermissionsSection,
  ReportDismissal,
  ReportFinding,
  Verdict,
} from "../report/contract.ts";

export class SynthesisParseError extends Error {}

export interface Synthesis {
  layperson_summary: string;
  technical_summary: string;
  description_deviation: { deviates: boolean | null; note: string };
}

export interface SynthesisInput {
  /** The verdict the analysis layer already decided. Narrated, never changed. */
  verdict: Verdict;
  findings: ReportFinding[];
  excluded: ExcludedClaim[];
  /** Concerns checked and cleared (node/shard checks, verifier harm-clears). */
  dismissals?: ReportDismissal[];
  permissions: PermissionsSection;
  destinations: DestinationsSection;
  obfuscation: ObfuscationSection;
  developer: DeveloperSection;
  /** The stated purpose to compare behavior against, when one is available. */
  statedPurpose: { text: string; source: "store_listing" | "manifest" } | null;
}

// The dismissed-concerns rule is injected ONLY when the digest actually carries
// dismissals (see instructionsFor): a report with none must keep a byte-identical
// prompt so its committed fixture still replays (the fixture key hashes the whole
// prompt) — the same byte-stability the conditional digest field preserves.
const DISMISSAL_RULE =
  "- The digest carries \"dismissed_concerns\": concerns that were explicitly checked and CLEARED. NEVER assert one as a finding or risk; you may note it was checked and cleared.";

const BASE_INSTRUCTIONS = [
  "You are writing the human-readable summary of a Chrome extension security assessment. The risk tier and per-area breakdown have ALREADY been decided by a separate deterministic step and are given to you in the digest under \"decided_verdict\". Your job is to NARRATE that verdict for a reader — you do NOT decide or change the tier.",
  "You are given (a) the decided verdict (tier + rationale + per-area levels); (b) the ASSERTED findings — behavioral claims verified against real source, plus observed capabilities present in the evidence; (c) EXCLUDED claims that were checked and did NOT survive verification; and (d) deterministic analysis digests (permissions, destinations, obfuscation, developer).",
  "Rules:",
  "- Write summaries CONSISTENT with the decided tier. Do not argue for a different tier or imply the risk is higher/lower than decided.",
  "- Base everything ONLY on the asserted findings and the digests. NEVER assert or imply an excluded claim — they were checked and are not findings. You may note that a claim was checked and excluded.",
  "- Report mechanisms neutrally. Do not vouch for intent in either direction; do not call behavior 'legitimate' or 'malicious'. State what the extension can do and does do, so the user can decide.",
  "- Never claim the absence of a behavior as fact — static analysis has structural blind spots. Scope any negative ('no X was found by the checks that ran').",
  "Produce a JSON object with:",
  '- "layperson_summary": 2-4 plain-language sentences for a non-technical user: what the extension does, what it can access, and the single most important thing to weigh. No jargon, no API names, no file paths.',
  '- "technical_summary": 2-5 sentences for an analyst: actual behavior, capability surface, notable mechanisms with their finding numbers (e.g. "finding 3").',
  '- "description_deviation": {"deviates": true|false|null, "note": one or two sentences}. Compare the asserted behavior against the stated purpose; null when no stated purpose was provided. Deviation means doing materially more or different than stated — not merely using technical means the description does not mention. This is an observation for the reader; it does not change the tier.',
  "Respond with ONLY the JSON object.",
];

/** Instructions with the dismissed-concerns rule spliced in (after the excluded
 *  rule) only when the report has dismissals — else byte-identical to before. */
function instructionsFor(hasDismissals: boolean): string {
  if (!hasDismissals) return BASE_INSTRUCTIONS.join("\n");
  const out = [...BASE_INSTRUCTIONS];
  const at = out.findIndex((l) => l.startsWith("- Base everything ONLY"));
  out.splice(at + 1, 0, DISMISSAL_RULE);
  return out.join("\n");
}

const SYNTHESIS_FORMAT = {
  type: "object",
  required: ["layperson_summary", "technical_summary", "description_deviation"],
  properties: {
    layperson_summary: { type: "string" },
    technical_summary: { type: "string" },
    description_deviation: {
      type: "object",
      required: ["deviates", "note"],
      properties: {
        deviates: { type: ["boolean", "null"] },
        note: { type: "string" },
      },
    },
  },
} as const;

/** Compact, prompt-safe digest of the deterministic sections. Derived from pack
 *  fields only (already stripped of sample-path identity upstream). */
function digest(input: SynthesisInput): string {
  return JSON.stringify(
    {
      decided_verdict: {
        tier: input.verdict.tier,
        rationale: input.verdict.rationale,
        per_area: input.verdict.per_area,
      },
      asserted_findings: input.findings.map((f) => ({
        number: f.number,
        kind: f.kind,
        severity: f.severity,
        category: f.category,
        title: f.title,
        confidence: f.confidence,
        mechanism: f.claimed_mechanism,
        detail: f.detail,
      })),
      excluded_claims: input.excluded.map((e) => ({ title: e.title, reason: e.reason })),
      // Present only when non-empty, so dismissal-free digests stay byte-identical.
      ...((input.dismissals?.length ?? 0) > 0
        ? { dismissed_concerns: input.dismissals!.map((d) => ({ concern: d.concern, note: d.note })) }
        : {}),
      permissions: {
        api: input.permissions.api.map((p) => ({ permission: p.permission, optional: p.optional, status: p.status, call_sites: p.total_usage })),
        hosts: input.permissions.hosts,
        dangerous_combinations: input.permissions.dangerous_combinations.map((d) => d.kind),
      },
      destinations: {
        hosts: input.destinations.rows.map((r) => ({
          host: r.host,
          references: r.references,
          any_dynamic: r.any_dynamic,
          reached_via: r.reached_via,
          party: r.party,
        })),
        unresolved_count: input.destinations.unresolved.length,
      },
      obfuscation: {
        flagged_files: input.obfuscation.flagged.map((f) => f.path),
        opaque_region_count: input.obfuscation.opaque_regions.length,
      },
      developer: {
        name: input.developer.name,
        has_website: input.developer.website !== null,
        has_address: input.developer.address !== null,
        country: input.developer.country,
        high_risk_country: input.developer.high_risk_country,
        non_store_update_url: input.developer.non_store_update_url,
        listing_available: input.developer.listing_available,
      },
      // Bounded: store descriptions can run long; the comparison only needs
      // the stated purpose, not the full marketing copy.
      stated_purpose: input.statedPurpose
        ? { ...input.statedPurpose, text: input.statedPurpose.text.slice(0, 2000) }
        : null,
    },
    null,
    1,
  );
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

export function parseSynthesis(text: string): Synthesis {
  // Anchor on layperson_summary — the field this humanization step always
  // emits (the tier no longer lives here; it is decided upstream).
  const obj = lastObjectWith(text, "layperson_summary") ?? lastObjectWith(text, "technical_summary");
  if (!obj) {
    throw new SynthesisParseError(
      `could not parse a synthesis from model output (${text.length} chars; no JSON object with a summary field)`,
    );
  }
  const dd = (obj.description_deviation ?? {}) as Record<string, unknown>;
  return {
    layperson_summary: str(obj.layperson_summary),
    technical_summary: str(obj.technical_summary),
    description_deviation: {
      deviates: typeof dd.deviates === "boolean" ? dd.deviates : null,
      note: str(dd.note),
    },
  };
}

export interface SynthesisRun {
  synthesis: Synthesis;
  usage: Usage;
}

export async function synthesize(
  input: SynthesisInput,
  opts: { client: LlmClient; model: string },
): Promise<SynthesisRun> {
  const prompt = buildPrompt(instructionsFor((input.dismissals?.length ?? 0) > 0), [
    { tag: "assessment_digest", content: digest(input) },
  ]);
  const req = {
    label: "synthesize",
    model: opts.model,
    prompt,
    params: { temperature: 0, format: SYNTHESIS_FORMAT } as Record<string, unknown>,
  };
  const res = await opts.client.complete(req);
  try {
    return { synthesis: parseSynthesis(res.text), usage: res.usage };
  } catch (e) {
    if (e instanceof SynthesisParseError) {
      throw new SynthesisParseError(
        `${e.message} — recorded fixture: ${fixtureFileName(req)}; delete it from the fixture dir to force a re-record`,
      );
    }
    throw e;
  }
}

/** Build the DescriptionDeviation report field from the synthesis + the stated purpose it saw. */
export function describeDeviation(
  synthesis: Synthesis,
  statedPurpose: SynthesisInput["statedPurpose"],
): DescriptionDeviation {
  return {
    stated_purpose: statedPurpose?.text ?? null,
    stated_source: statedPurpose?.source ?? null,
    deviates: statedPurpose ? synthesis.description_deviation.deviates : null,
    note: synthesis.description_deviation.note,
  };
}
