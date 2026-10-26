// Assembles the RiskReport from its three input classes: the evidence pack
// (deterministic sections), the classified finding set (post-verification),
// and the synthesis (verdict + summaries). The assembly itself adds nothing —
// it is the one place the contract's provenance rules are enforced by
// construction: deterministic sections take only the pack, synthesized fields
// take only the synthesis.

import type { EvidencePack } from "../pipeline/schema.ts";
import type { HostEnrichment } from "../enrichment/types.ts";
import { describeDeviation, type Synthesis, type SynthesisInput } from "../methodologies/synthesize.ts";
import {
  buildCoverage,
  buildDestinations,
  buildDeveloper,
  buildIdentity,
  buildObfuscation,
  buildPermissions,
  type ListingInput,
} from "./build.ts";
import type { ClassifiedFindings } from "./classify.ts";
import { REPORT_SCHEMA_VERSION, type ReportDismissal, type RiskReport, type Verdict } from "./contract.ts";

export interface AssembleOptions {
  pack: EvidencePack;
  methodology: string;
  model: string;
  classified: ClassifiedFindings;
  /** The verdict the analysis layer already decided (report/verdict.ts). */
  verdict: Verdict;
  synthesis: Synthesis;
  statedPurpose: SynthesisInput["statedPurpose"];
  listing?: ListingInput | null;
  highRiskCountry?: boolean | null;
  /** Host-enrichment artifact (015), when one exists beside the extension dir.
   *  Folded onto the destination rows as DESCRIPTIVE context — never the tier. */
  enrichment?: HostEnrichment | null;
  /** Web Store id, when the caller knows it (assess path only — never corpus). */
  storeId?: string | null;
  /** Concerns the investigation checked and cleared (DAG nodes / Pi shards).
   *  Defaults to none — single-shot arms record no dismissals. */
  dismissals?: ReportDismissal[];
}

/**
 * The stated purpose to compare behavior against: the store listing
 * description when one was fetched, else the manifest description. Null when
 * neither exists — the deviation field then renders "not assessable".
 */
export function statedPurposeOf(
  pack: EvidencePack,
  listing: ListingInput | null | undefined,
): SynthesisInput["statedPurpose"] {
  if (listing?.source === "chrome-web-store" && listing.description) {
    return { text: listing.description, source: "store_listing" };
  }
  const desc = pack.extension.manifest.description;
  // An unresolved MV3 i18n placeholder (`__MSG_key__`) is not a stated purpose —
  // comparing behavior against a localization key is meaningless. Treat it as
  // "no stated purpose" so the deviation verdict is null rather than junk.
  if (typeof desc === "string" && desc.trim() !== "" && !/^__MSG_.+__$/.test(desc.trim())) {
    return { text: desc, source: "manifest" };
  }
  return null;
}

export function assembleRiskReport(opts: AssembleOptions): RiskReport {
  const { pack, synthesis } = opts;
  return {
    report_schema_version: REPORT_SCHEMA_VERSION,
    analyzer_version: pack.analyzer_version,
    methodology: opts.methodology,
    model: opts.model,
    generated_at: pack.analyzed_at,
    extension: buildIdentity(pack, opts.storeId ?? null),
    // The verdict is the analysis layer's, computed deterministically; synthesis
    // only narrated it. They cannot disagree.
    verdict: opts.verdict,
    summaries: {
      layperson: synthesis.layperson_summary,
      technical: synthesis.technical_summary,
    },
    description_deviation: describeDeviation(synthesis, opts.statedPurpose),
    permissions: buildPermissions(pack),
    destinations: buildDestinations(pack, opts.enrichment),
    obfuscation: buildObfuscation(pack),
    developer: buildDeveloper(pack.developer, opts.listing, opts.highRiskCountry ?? null),
    findings: opts.classified.findings,
    excluded_claims: opts.classified.excluded,
    dismissals: opts.dismissals ?? [],
    coverage: buildCoverage(pack),
  };
}
