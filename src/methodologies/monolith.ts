// Arm (b) of the bake-off, reframed by improvement 013 into generation →
// verification. The whole evidence pack is serialized into a single prompt and
// the model returns STRUCTURED findings, each tagged `observed-capability`
// (something is present in the evidence) vs `inferred-behavior` (a causal story
// about what the code does). Inferred-behavior claims are then adjudicated by
// the claim-verifier (claim-verifier.ts) against the real source on disk, and
// the report the scorecard consumes is a RENDER of the verified finding set
// (render.ts) — a behavioral claim is asserted only when `confirmed`.
//
// Hard requirements from the plan/review (unchanged by 013):
//  - Untrusted-content envelope (src/llm/envelope.ts): the pack carries strings
//    from a potentially-malicious extension, so it is wrapped as data with
//    instructions first — prompt injection here corrupts the eval's validity.
//  - Determinism guard at the serialization layer: volatile pack fields
//    (analyzed_at, analyzer_version) are dropped BEFORE they enter the prompt,
//    so the fixture key is stable across machines, dates, and analyzer releases.
//    (runScorecard additionally pins analyzedAt when producing the pack.)
//  - Label-leak guard at the same layer: extension.path / extension.id_from_path
//    carry the corpus sample's directory name (a ground-truth hint), so they are
//    stripped too — the model must never see them (improvement 001). The same
//    guard applies to the verifier: sample.sampleDir is used for fs reads only.

import type { LlmClient } from "../llm/client.ts";
import { buildPrompt } from "../llm/envelope.ts";
import { fixtureFileName, stableStringify } from "../llm/record-replay.ts";
import type { EvidencePack } from "../pipeline/schema.ts";
import { isHighRiskCountry } from "../listing/country.ts";
import { recordsByHost, type HostEnrichment } from "../enrichment/types.ts";
import { projectHostEnrichment } from "../enrichment/project.ts";
import { assembleRiskReport, statedPurposeOf } from "../report/assemble.ts";
import { buildCoverage, buildDestinations, buildDeveloper, buildObfuscation, buildPermissions } from "../report/build.ts";
import { classifyFindings } from "../report/classify.ts";
import type { RiskReport } from "../report/contract.ts";
import { computeVerdict } from "../report/verdict.ts";
import { adjustFindingHarm } from "../report/harm-adjust.ts";
import { renderReportMarkdown } from "../report/render-md.ts";
import type { Methodology, MethodologySample, MethodologyOutput } from "./types.ts";
import { FindingsParseError, parseFindingsReport, type EvidenceRef, type FindingsReport } from "./findings.ts";
import { reachabilityContextFromPack, verifyFindings, type VerifierVerdict } from "./claim-verifier.ts";
import { synthesize, type Synthesis } from "./synthesize.ts";

/**
 * Pack fields that must not enter the prompt. Top-level names are volatile
 * (vary run-to-run / release-to-release and would destabilize the fixture key);
 * dotted entries strip a key inside a top-level object field. extension.path /
 * extension.id_from_path carry the corpus directory name (src/pipeline/index.ts
 * derives both from it), and sample names like "mutant-a-exfil-fetch" are
 * ground-truth hints — leaking them invalidates the eval.
 * Local fixture context is presentation metadata, so it is stripped as well.
 */
const STRIPPED = new Set([
  "fixture",
  "analyzed_at",
  "analyzer_version",
  "extension.path",
  "extension.id_from_path",
]);

// Large inventories use a lossless column table. Small packs retain their exact
// historical prompt/fixture keys. Undefined/missing cells use an explicit bitmap
// so missing and null remain distinguishable; all future fields are retained.
export function compactInventory(files: EvidencePack["files"]) {
  const columns = [...new Set(files.flatMap((file) => Object.keys(file).filter((key) => (file as unknown as Record<string, unknown>)[key] !== undefined)))].sort();
  const rows: unknown[][] = files.map((file) => columns.map((key) => (file as unknown as Record<string, unknown>)[key] ?? null));
  const dictionaries: Record<string, unknown[]> = Object.create(null);
  for (const [i, key] of columns.entries()) {
    const values: unknown[] = [];
    const indices = new Map<string, number>();
    const encoded = rows.map((row) => {
      const serialized = stableStringify(row[i]);
      let index = indices.get(serialized);
      if (index === undefined) { index = values.length; indices.set(serialized, index); values.push(row[i]); }
      return index;
    });
    // Dictionary only where it actually saves space; hashes/paths remain literal.
    if (stableStringify({ values, encoded }).length < stableStringify(rows.map((row) => row[i])).length) {
      dictionaries[key] = values;
      rows.forEach((row, r) => { row[i] = encoded[r]!; });
    }
  }
  const present = files.map((file) => columns.map((key) => Object.hasOwn(file, key) && (file as unknown as Record<string, unknown>)[key] !== undefined ? "1" : "0").join(""));
  return { encoding: "column-table-v1", columns, dictionaries, rows,
    ...(present.some((bits) => bits.includes("0")) ? { present } : {}) };
}

export const COMPACT_INVENTORY_MIN_FILES = 1_000;

/**
 * Serialize a pack for the prompt, dropping stripped fields and stabilizing key
 * order. When a host-enrichment artifact (015) is supplied, a COMPACT projection
 * of each matching host is folded onto cross_file.destination_summary — the
 * registration/ownership context the model provably cannot derive from source
 * bytes. Ages in the projection are relative to the pack's analyzed_at (pinned
 * for corpus/bakeoff runs, so the projection is deterministic there); the
 * volatile fetched_at never enters the prompt. Empty/null/redacted fields are
 * omitted, so a pack with no artifact serializes byte-for-byte as before.
 */
export function serializePackForPrompt(pack: EvidencePack, enrichment?: HostEnrichment | null): string {
  const stripped: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(pack)) {
    if (STRIPPED.has(k)) continue;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const inner: Record<string, unknown> = {};
      for (const [ik, iv] of Object.entries(v)) {
        if (!STRIPPED.has(`${k}.${ik}`)) inner[ik] = iv;
      }
      stripped[k] = inner;
    } else {
      stripped[k] = v;
    }
  }

  const byHost = recordsByHost(enrichment);
  if (byHost.size > 0) {
    const cross = stripped.cross_file as Record<string, unknown> | undefined;
    const summary = cross?.destination_summary;
    if (cross && Array.isArray(summary)) {
      cross.destination_summary = summary.map((entry) => {
        const host = (entry as { host?: unknown }).host;
        const record = typeof host === "string" ? byHost.get(host) : undefined;
        return record ? { ...(entry as object), enrichment: projectHostEnrichment(record, pack.analyzed_at) } : entry;
      });
    }
  }

  if (pack.files.length >= COMPACT_INVENTORY_MIN_FILES) {
    stripped.files = compactInventory(pack.files);
    stripped.prompt_representation = "inventory-column-table-v1: files.rows cells follow files.columns; a column listed in files.dictionaries uses zero-based indices into that dictionary, otherwise literal values. Optional present bitmaps distinguish absent fields from null (all present if omitted). All inventory entries and values are retained.";
  }
  return stableStringify(stripped);
}

/**
 * Provider-neutral reasoning/effort setting for the model call. A plain boolean
 * toggles thinking on/off; the graded levels ("low"|"medium"|"high") are honored
 * by models that support them (e.g. gpt-oss). The adapter maps this to whatever
 * the provider expects (Ollama's top-level `think` field).
 */
export type ThinkSetting = boolean | "low" | "medium" | "high";

/**
 * Parse a raw --think / $SCORECARD_THINK value into a ThinkSetting. An absent or
 * empty value returns undefined, which means "omit the knob entirely" — so the
 * request (and thus the fixture key) is byte-for-byte the no-think default.
 */
export function parseThink(raw: string | undefined): ThinkSetting | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "") return undefined;
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "low" || v === "medium" || v === "high") return v;
  throw new Error(`invalid think value "${raw}" — use true, false, low, medium, or high`);
}

const INSTRUCTIONS = [
  "You are a security analyst reviewing a Chrome (Manifest V3) browser extension.",
  "You are given the extension's structured evidence pack. Identify what the extension does — its capabilities, data flows, and any suspicious or malicious behaviors — as a set of STRUCTURED findings.",
  "Every finding carries a claim_type:",
  '- "observed-capability": a specific API, permission, string, file, or network destination is present in the evidence. No causal story — only what is verifiably there.',
  '- "inferred-behavior": a claim about what the code DOES (a mechanism, a data flow with intent, a behavior). State the causal story in claimed_mechanism in ONE line. Each such claim will be adversarially checked against the real source code; a claim whose cited code does not implement it is discarded — so cite precisely.',
  "Every finding also carries a severity and a category — these are the structured fields the risk verdict is computed from, so assign them deliberately. Severity is decided by the DESTINATION and EFFECT of a behavior, not merely by whether it touches sensitive data:",
  '- "critical"/"high": a confirmed behavior that harms or deceives the user because data leaves to an EXTERNAL or untrusted party, or code/effects are attacker-controlled — e.g. sensitive data sent over the NETWORK to an external/unknown host, remote or obfuscated code execution, a tampered dependency, affiliate/redirect/cookie hijacking, returning cookies to an arbitrary external caller. Reserve these for inferred-behavior (confirmed-mechanism) claims.',
  '- "medium": a broad or sensitive CAPABILITY (however broad — e.g. cookies + all-sites access), OR a confirmed data movement to a LOCAL or user-controlled channel the user can see or initiates — the system clipboard on an export action, the extension\'s own popup/options UI, extension-local storage. Moving cookies to the user\'s clipboard for an export feature is "medium", not "high": the destination is the user, not an external party.',
  '- "low": minor or narrowly-scoped. "info": neutral context.',
  '- category: one of "permissions", "data-exfiltration" (data leaving to a network/external party — NOT clipboard or local UI), "code-execution", "obfuscation", "supply-chain", "messaging-surface", "remote-resources", "claim-mismatch", "anomaly", "other".',
  'Every finding also carries a finding_type — the NATURE of the issue, orthogonal to category (which says which surface). This is a classification of the mechanism, NOT a verdict on the author\'s intent; stay neutral. One of:',
  '- "vulnerability": an exploitable weakness a THIRD PARTY could abuse — the extension is the vector/victim (an externally_connectable handler that hands data to any page, eval of remote/page input, world-readable web-accessible resources).',
  '- "malicious": code that harms or deceives the user BY DESIGN (covert exfil to an attacker host, silent self-uninstall, cookie/affiliate hijacking). This is the ONLY intent-laden value — assign it only to a confirmed inferred-behavior mechanism with strong evidence. When unsure, use "unknown", never "malicious".',
  '- "unwanted": privacy-invasive but a common business model — tracking, fingerprinting, analytics/telemetry, adware/affiliate monetization.',
  '- "risky-capability": a powerful or broad CAPABILITY, concerning by breadth but consistent with a plausible purpose (cookies + all_urls, MAIN-world injection, broad OAuth scopes) — the capability itself, not a confirmed abuse.',
  '- "unknown": flagged, but the nature cannot be determined from the evidence. The default whenever a finding does not clearly fit the above.',
  "Every finding must carry evidence_refs grounding it in the pack:",
  '- file: the file path exactly as it appears in the pack (e.g. "background.js").',
  '- location: the {line, column} of the cited sink/listener/destination when the pack gives one, else null. (Pack locations on minified files can have small line numbers and very large column numbers — copy them exactly, do not swap.)',
  "- sink_or_string: the exact API call or string the finding relies on, else null.",
  "- symbol: the enclosing function/identifier when known, else null.",
  "Base every claim on the evidence. Do not invent behaviors the evidence does not support. Prefer several narrow findings over one broad one.",
  "Report mechanisms neutrally — do not vouch for intent in either direction. Never label a capability 'legitimate', and never assert the absence of abuse (benign intent is no more statically verifiable than malicious intent). When a mechanism moves sensitive data into any externally readable channel — the network, the clipboard, UI surfaces such as menu items or titles, shared storage — assert that data movement plainly as a finding, even when a product feature explains it; whether it is abuse is downstream analysis's job.",
  "Respond with ONLY a JSON object of this shape:",
  '{"summary": "<2-4 sentences: what the extension actually does>",',
  ' "overall_risk": "<one-line risk characterization>",',
  ' "findings": [',
  '   {"id": "f1", "title": "<short title>", "claim_type": "observed-capability" | "inferred-behavior",',
  '    "severity": "critical" | "high" | "medium" | "low" | "info", "category": "permissions" | "data-exfiltration" | "code-execution" | "obfuscation" | "supply-chain" | "messaging-surface" | "remote-resources" | "claim-mismatch" | "anomaly" | "other",',
  '    "finding_type": "vulnerability" | "malicious" | "unwanted" | "risky-capability" | "unknown",',
  '    "confidence": "low" | "medium" | "high", "claimed_mechanism": "<one line, required for inferred-behavior>",',
  '    "evidence_refs": [{"file": "<path>", "location": {"line": 0, "column": 0} | null, "symbol": "<name>" | null, "sink_or_string": "<exact API/string>" | null}],',
  '    "detail": "<the finding, with concrete evidence>"}',
  " ]}",
].join("\n");

/**
 * JSON Schema for the generation output, passed as the request's `format`
 * (Ollama constrains decoding to the schema). Without it, a single unescaped
 * quote inside a 20k-char completion makes the whole findings object
 * unparseable — and at temperature 0 the same broken completion would be
 * re-recorded forever. parseFindingsReport's per-finding rescue remains the
 * backstop for providers that ignore `format`.
 */
const FINDINGS_FORMAT = {
  type: "object",
  required: ["summary", "overall_risk", "findings"],
  properties: {
    summary: { type: "string" },
    overall_risk: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "claim_type", "severity", "category", "finding_type", "confidence", "claimed_mechanism", "evidence_refs", "detail"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          claim_type: { enum: ["observed-capability", "inferred-behavior"] },
          severity: { enum: ["critical", "high", "medium", "low", "info"] },
          category: { enum: ["permissions", "data-exfiltration", "code-execution", "obfuscation", "supply-chain", "messaging-surface", "remote-resources", "claim-mismatch", "anomaly", "other"] },
          finding_type: { enum: ["vulnerability", "malicious", "unwanted", "risky-capability", "benign", "unknown"] },
          confidence: { enum: ["low", "medium", "high"] },
          claimed_mechanism: { type: "string" },
          evidence_refs: {
            type: "array",
            items: {
              type: "object",
              required: ["file"],
              properties: {
                file: { type: "string" },
                location: {
                  anyOf: [
                    { type: "null" },
                    { type: "object", required: ["line"], properties: { line: { type: "number" }, column: { type: "number" } } },
                  ],
                },
                symbol: { type: ["string", "null"] },
                sink_or_string: { type: ["string", "null"] },
              },
            },
          },
          detail: { type: "string" },
        },
      },
    },
  },
} as const;

/** Structured trace of the generation → verification → synthesis pass. */
export interface MonolithTrace {
  generated: FindingsReport;
  resolutions: Record<string, { resolved: EvidenceRef[]; unresolved: EvidenceRef[] }>;
  verdicts: VerifierVerdict[];
  synthesis: Synthesis;
  risk_report: RiskReport;
}

export interface MonolithOptions {
  think?: ThinkSetting;
  /**
   * Model for the claim-verifier post-pass. Defaults to the arm's own model —
   * the verifier is a fresh context with the real source, so self-model is
   * acceptable (unlike the judge); override to use a stronger/cheaper reader.
   */
  verifierModel?: string;
}

export function createMonolith(model: string, opts: MonolithOptions = {}): Methodology {
  const verifierModel = opts.verifierModel ?? model;
  return {
    id: "monolith",
    model,
    async run(sample: MethodologySample, client: LlmClient): Promise<MethodologyOutput> {
      if (!sample.pack) {
        throw new Error("monolith methodology requires sample.pack (it consumes the evidence pack)");
      }
      const prompt = buildPrompt(INSTRUCTIONS, [
        { tag: "evidence_pack", content: serializePackForPrompt(sample.pack, sample.enrichment) },
      ]);
      // `think` is added only when configured, so leaving it unset keeps the
      // request — and the fixture key — identical to the no-think calls.
      const params: Record<string, unknown> = { temperature: 0, format: FINDINGS_FORMAT };
      if (opts.think !== undefined) params.think = opts.think;
      const req = { label: "monolith", model, prompt, params };
      await sample.onProgress?.("monolith:generation", "started", "Generating findings from the evidence pack");
      const res = await client.complete(req);
      await sample.onProgress?.("monolith:generation", "finished", `Generation returned ${res.usage.inputTokens} input and ${res.usage.outputTokens} output tokens`);

      let generated: FindingsReport;
      try {
        generated = parseFindingsReport(res.text);
      } catch (e) {
        if (e instanceof FindingsParseError) {
          // In RECORD mode the unparseable completion was already persisted and
          // will replay forever — name the fixture file so it can be deleted.
          throw new FindingsParseError(
            `${e.message} — recorded fixture: ${fixtureFileName(req)}; delete it from the fixture dir to force a re-record`,
          );
        }
        throw e;
      }

      // Verification post-pass: one adversarial source-grounded call per
      // grounded inferred-behavior claim (013). sampleDir is fs-only here.
      // Stated purpose is hoisted above verification so the verifier's harm
      // adjudication (018 residual) sees it in the reachability context.
      const listing = sample.listing ?? null;
      const statedPurpose = statedPurposeOf(sample.pack, listing);
      await sample.onProgress?.("verification", "started", "Verifying inferred claims against source");
      const verification = await verifyFindings(generated.findings, {
        sampleDir: sample.sampleDir,
        client,
        model: verifierModel,
        dataFlows: sample.pack.cross_file.data_flows,
        searchFiles: sample.pack.files.map((f) => f.path),
        reachability: reachabilityContextFromPack(sample.pack, statedPurpose),
      });

      await sample.onProgress?.("verification", "finished", "Claim verification finished");
      // Classify, then DECIDE the verdict deterministically from the asserted
      // set + the built sections (report/verdict.ts) — this is the analysis
      // layer's verdict and the single source of truth for the tier.
      const classified = classifyFindings(generated, verification, sample.sampleDir);
      const highRiskCountry = isHighRiskCountry(listing?.country ?? null);
      const enrichment = sample.enrichment ?? null;
      const sections = {
        permissions: buildPermissions(sample.pack),
        destinations: buildDestinations(sample.pack, enrichment),
        obfuscation: buildObfuscation(sample.pack),
        developer: buildDeveloper(sample.pack.developer, listing, highRiskCountry),
        coverage: buildCoverage(sample.pack),
      };
      // Deterministic harm-level correction: cap severity on concern findings
      // the pack proves cannot hold the claimed harm (an unreachable messaging
      // "vulnerability", first-party/analytics egress mislabeled exfiltration)
      // BEFORE the tier rolls up. Reassign so the verdict, synthesis, and
      // rendered report all use the corrected set.
      classified.findings = adjustFindingHarm(classified.findings, sample.pack).findings;
      const verdict = computeVerdict(classified.findings, sections);

      // Humanization post-pass: prose ONLY. It is told the decided verdict and
      // narrates it; it cannot change the tier.
      await sample.onProgress?.("synthesis", "started", "Synthesizing the decided verdict into the report");
      const synthesisRun = await synthesize(
        {
          verdict,
          findings: classified.findings,
          excluded: classified.excluded,
          dismissals: classified.dismissals,
          permissions: sections.permissions,
          destinations: sections.destinations,
          obfuscation: sections.obfuscation,
          developer: sections.developer,
          statedPurpose,
        },
        { client, model },
      );

      await sample.onProgress?.("synthesis", "finished", "Report synthesis finished");
      const riskReport = assembleRiskReport({
        pack: sample.pack,
        methodology: "monolith",
        model,
        classified,
        verdict,
        synthesis: synthesisRun.synthesis,
        statedPurpose,
        listing,
        highRiskCountry,
        enrichment,
        // Verifier harm-clears (checked-and-cleared concerns) — the monolith's
        // only dismissal source.
        dismissals: classified.dismissals,
      });

      const trace: MonolithTrace = {
        generated,
        resolutions: Object.fromEntries(verification.resolutions),
        verdicts: [...verification.verdicts.values()],
        synthesis: synthesisRun.synthesis,
        risk_report: riskReport,
      };
      return {
        report: renderReportMarkdown(riskReport),
        tier: verdict.tier,
        usage: {
          inputTokens: res.usage.inputTokens + verification.usage.inputTokens + synthesisRun.usage.inputTokens,
          outputTokens: res.usage.outputTokens + verification.usage.outputTokens + synthesisRun.usage.outputTokens,
        },
        structured: trace,
      };
    },
  };
}
