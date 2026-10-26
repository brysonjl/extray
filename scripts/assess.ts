#!/usr/bin/env -S npx tsx
import { recordAssessStage } from "../src/runner/progress-node.ts";
import { ContextCapacityError } from "../src/llm/context.ts";
import { outcomeFromStructured, outcomeNotice } from "../src/report/outcome.ts";
import type { AnalysisOutcome } from "../src/report/contract.ts";
// CLI: run an analysis methodology end-to-end on a SINGLE extension (outside the
// labeled corpus) so you can eyeball what a methodology produces on a real CRX.
//
//   npm run assess -- <id-or-url>        [--out <dir>] [--model <id>] ...
//   npm run assess -- --dir <ext-dir>    [--out <dir>] [--model <id>] ...
//   npm run assess -- --ids-file <list>  [--out <dir>] [--model <id>] ...
//
// Three input modes:
//   • <id-or-url>      — fetch + unpack the CRX (via fetch-crx) into
//                        --crx-out/<id>/, then assess it.
//   • --dir <path>     — assess an already-unpacked extension directory (e.g. one
//                        a previous `npm run fetch-crx` produced under example_crxs/).
//   • --ids-file <list> — batch: one ID or Chrome Web Store URL per line (blank
//                        lines and #-comments ignored), assessed in turn. One bad
//                        entry is logged and skipped; the batch continues and exits
//                        1 if any entry failed.
//
// Pipeline: static analyze() → evidence pack → methodology.run() (generation →
// verification → synthesis) → risk report, written as <id>.md + <id>.json +
// <id>.html under --out.
//
// --methodology accepts a comma-separated list (monolith,dag,agentic) to compare
// methodologies side by side in one run: the CRX is fetched and statically
// analyzed once, then each methodology runs against the shared evidence pack and
// writes <id>.<methodology>.{md,json,html} (the bare <id>.* names are kept when a
// single methodology is requested). Each methodology is recorded to the bake-off
// DB separately for cross-run comparison.
//
// Store listing (008b): when a developer-listing.json artifact exists beside
// the extension dir it feeds the report's Developer section and the
// stated-purpose comparison. In id/url RECORD mode a missing artifact is
// fetched automatically (best-effort — a fetch failure degrades the report,
// it never aborts the assessment); --replay never touches the network.
//
// LLM mode: RECORD by default, because a never-before-seen extension has no
// committed fixture — it needs a live call (set LLM_ADAPTER + provider creds in
// .env). RECORD is record-on-miss, so re-running the same extension reuses the
// cached response for free. Pass --replay to serve only from the cache.
//
// Headroom (token compression): --headroom routes the `pi` arm's model traffic
// through a headroom compression proxy (a separate, already-running process) so
// tool outputs / file reads are compressed before the model sees them. It is
// recorded to the bake-off DB (run.headroom) so on/off runs can be compared for
// token savings AND finding quality. Only the pi arm is affected — the other arms
// call the model via the injected LlmClient, which the proxy does not sit in front
// of. The proxy URL comes from --headroom-url or $HEADROOM_URL.

import "./_env.ts"; // load .env before the adapter reads process.env
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Command } from "commander";
import { analyze, HardError } from "../src/pipeline/index.ts";
import { deminifyExtensionDir, CorpusMutationError } from "../src/pipeline/deminify.ts";
import { validatePack } from "../src/pipeline/schema.ts";
import { createMonolith, parseThink, serializePackForPrompt, type MonolithTrace } from "../src/methodologies/monolith.ts";
import { createDag } from "../src/methodologies/dag/index.ts";
import { createAgentic } from "../src/methodologies/agentic/index.ts";
import { createPi, effectiveSubagentModels, isSharded } from "../src/methodologies/pi/index.ts";
import { DIMENSIONS, type Dimension } from "../src/methodologies/pi/runner.ts";
import type { Methodology } from "../src/methodologies/types.ts";
import { listingCandidatePaths, parseDeveloperListing, ListingError, type DeveloperListing } from "../src/listing/types.ts";
import { loadEnrichmentBeside } from "../src/enrichment/load.ts";
import type { HostEnrichment } from "../src/enrichment/types.ts";
import { enrichExtension } from "./enrich-hosts.ts";
import { renderReportMarkdown } from "../src/report/render-md.ts";
import { renderReportHtml } from "../src/report/render-html.ts";
import { RecordReplayClient, FixtureMissError, type ReplayMode } from "../src/llm/record-replay.ts";
import { UsageTracker, parseCostRates, renderUsageTable, CostRatesError, type CostSummary } from "../src/llm/usage.ts";
import { resolveEffectiveRates } from "../src/llm/model-pricing.ts";
import type { Usage } from "../src/llm/client.ts";
import { ScorecardError } from "../src/scorecard/index.ts";
import { fetchAndUnpack, readListFile, FetchError } from "./fetch-crx.ts";
import { fetchListing } from "./fetch-listing.ts";
import { loadAdapter } from "./_adapter.ts";
import { recordLedgerEventSafe, recordRunSafe } from "./_db.ts";
import { isRateLimitError } from "../src/llm/rate-limit.ts";
import { runInputFromAssess } from "../src/db/adapters.ts";
import { warnIfSelfVerify } from "../src/methodologies/claim-verifier.ts";
import { warnUntestedModel } from "../src/llm/model-table.ts";
import { describeProvider, ProviderConfigError, resolveProvider } from "../src/llm/provider.ts";
import { PI_INJECTION_CAVEAT } from "../src/methodologies/pi/caveat.ts";
import {
  BudgetedClient,
  enforceBudget,
  estimatePreflight,
  needsConfirmation,
  renderPreflight,
  TokenBudgetError,
} from "../src/llm/preflight.ts";
import { createInterface } from "node:readline/promises";
import { addProviderOptions, providerHelpText, type ProviderFlags } from "./_provider-flags.ts";
import { applySettingsApiKey, loadSettingsIfPresent } from "../src/server/settings-node.ts";
import { providerProvenance, withProviderProvenance } from "../src/llm/provenance.ts";
import { analysisOptionsForMethodology } from "../src/product/analysis-config.ts";

/** Pi-only extras resolved from CLI flags (provider/headroom base URL + shard config). */
interface PiExtra {
  provider?: string;
  baseUrl?: string;
  shard?: boolean;
  subagentModel?: string;
  subagentModels?: Partial<Record<Dimension, string>>;
  synthesisModel?: string;
  /** Explore the extension cold — no evidence pack fed to the investigator (016 fix 4). */
  noPack?: boolean;
  maxTurns?: number;
  subagentMaxTurns?: number;
}

function makeMethodology(id: string, model: string, thinkRaw?: string, verifierModel?: string, piExtra?: PiExtra, agenticMaxSteps?: number): Methodology {
  // Loud when self-verifying, mirroring the judge's self-grading warning —
  // measured ~77% confirm-rate leniency bias (018).
  warnIfSelfVerify(id, model, verifierModel ?? model);
  // Model choice is a correctness variable, not a cost variable: we have measured
  // arms silently returning zero findings on weak models (src/llm/model-table.ts).
  warnUntestedModel(model);
  try {
    if (id === "monolith") return createMonolith(model, { think: parseThink(thinkRaw), verifierModel });
    if (id === "dag") return createDag(model, { verifierModel });
    if (id === "agentic") return createAgentic(model, { verifierModel, maxStepsPerDimension: agenticMaxSteps });
    // piExtra.baseUrl, when set, points Pi's OpenAI-compatible provider at the
    // headroom compression proxy (--headroom); the shard fields fan investigation
    // out across one sub-session per dimension with per-dimension models. Only the
    // Pi arm honors any of this.
    if (id === "pi") return createPi(model, { verifierModel, ...piExtra });
    throw new ScorecardError(`unknown methodology "${id}" (expected "monolith", "dag", "agentic", or "pi")`);
  } catch (e) {
    if (e instanceof ScorecardError) throw e;
    throw new ScorecardError((e as Error).message);
  }
}

// Parse --pi-subagent-models: a comma list of dimension=model pairs, e.g.
// "exfiltration=glm-5.2:cloud,obfuscation=gemma4:cloud". Unspecified dimensions
// fall back to --model inside the arm. Unknown dimension names are a hard error.
function parseSubagentModels(spec: string): Partial<Record<Dimension, string>> {
  const out: Partial<Record<Dimension, string>> = {};
  for (const pair of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq < 0) throw new ScorecardError(`--pi-subagent-models: "${pair}" is not in dimension=model form`);
    const dim = pair.slice(0, eq).trim();
    const m = pair.slice(eq + 1).trim();
    if (!(DIMENSIONS as readonly string[]).includes(dim)) {
      throw new ScorecardError(`--pi-subagent-models: unknown dimension "${dim}" (expected one of: ${DIMENSIONS.join(", ")})`);
    }
    if (!m) throw new ScorecardError(`--pi-subagent-models: empty model for dimension "${dim}"`);
    out[dim as Dimension] = m;
  }
  return out;
}

function parseMaxTokens(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ScorecardError(`--max-tokens must be a positive integer (got "${raw}")`);
  return n;
}

/**
 * Ask before a large spend. A daemon or CI run must never block on stdin, so
 * when there is no terminal this returns true (proceed) without asking.
 */
async function confirmSpend(): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question("proceed with this spend? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** pi never goes through the record/replay client, so --replay cannot be offline
 *  for it: refuse rather than quietly spending. Checked before any fetch. */
function assertReplayable(methodologies: string[], replay: boolean | undefined): void {
  if (replay && methodologies.includes("pi")) {
    throw new ScorecardError("pi is live-only; use --methodology monolith for an offline replay (--replay never makes a request, and the pi arm always does)");
  }
}

/** The endpoint this methodology's requests will go to, or null when it makes none. */
function resolveRunProvider(methodologyId: string, mode: ReplayMode, opts: AssessOptions, piBaseUrl: string | undefined): { id: string; baseUrl: string; line: string } | null {
  // The LlmClient arms call out only in RECORD, and LLM_ADAPTER hands them a
  // custom client that owns its own endpoint. pi ignores LLM_ADAPTER entirely.
  if (methodologyId !== "pi" && (mode !== "RECORD" || process.env.LLM_ADAPTER)) return null;
  const p = resolveProvider({ provider: opts.provider, baseUrl: methodologyId === "pi" ? piBaseUrl : opts.baseUrl });
  // Strip any user:pass@ from the URL before it reaches stdout or a report.
  const safe = (u: string) => {
    try {
      const url = new URL(u);
      url.username = "";
      url.password = "";
      return url.toString().replace(/\/+$/, "");
    } catch {
      return u;
    }
  };
  return { id: p.id, baseUrl: safe(p.baseUrl), line: describeProvider({ ...p, baseUrl: safe(p.baseUrl) }) };
}

interface ReportMeta {
  outcome?: AnalysisOutcome;
  id: string;
  methodology: string;
  model: string;
  mode: ReplayMode;
  sourceDir: string;
  usage: Usage;
  /** Where the requests went (provider id + base URL, never a key); null when no
   *  request was made (REPLAY) or a custom LLM_ADAPTER owns the endpoint. */
  provider: { id: string; baseUrl: string } | null;
}

// The header carries only run provenance (source, mode, usage); methodology,
// model, and timestamps live in the report body's own provenance line now.
function renderMarkdown(meta: ReportMeta, report: string, accounting: CostSummary): string {
  return [
    "<!-- generated by `npm run assess` — do not hand-edit; regenerate from the source dir -->",
    `> **${meta.id}** · source: \`${meta.sourceDir}\` · mode: ${meta.mode} · usage: ${meta.usage.inputTokens}/${meta.usage.outputTokens} tokens`,
    "",
    report,
    "",
    "---",
    "",
    "## Run accounting (tokens & cost by step)",
    "",
    renderUsageTable(accounting),
    "",
  ].join("\n");
}

/**
 * Load the 008b listing artifact beside the extension dir, when one exists.
 * In id/url RECORD mode a missing artifact is fetched first (best-effort).
 */
async function loadListing(sourceDir: string, storeId: string | null, opts: Options): Promise<DeveloperListing | null> {
  const mode: ReplayMode = opts.replay ? "REPLAY" : "RECORD";
  let path = listingCandidatePaths(sourceDir).find(existsSync);
  if (!path && storeId && mode === "RECORD") {
    try {
      const fetched = await fetchListing(storeId, { outDir: opts.crxOut, force: false });
      path = fetched.artifactPath;
    } catch (e) {
      if (!(e instanceof FetchError)) throw e;
      process.stderr.write(`assess: listing fetch failed (${e.message}) — developer section will be manifest-only\n`);
      return null;
    }
  }
  if (!path) return null;
  try {
    return parseDeveloperListing(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    if (e instanceof ListingError || e instanceof SyntaxError) {
      process.stderr.write(`assess: ignoring malformed listing artifact at ${path}: ${(e as Error).message}\n`);
      return null;
    }
    throw e;
  }
}

function renderJson(meta: ReportMeta, report: string, accounting: CostSummary, structured?: unknown): string {
  return (
    JSON.stringify(
      {
        ...meta,
        usage_by_step: accounting.entries,
        estimated_cost_usd: accounting.estimatedUsd,
        uncosted_models: accounting.uncostedModels,
        report,
        ...(structured !== undefined ? { structured } : {}),
      },
      null,
      2,
    ) + "\n"
  );
}

interface Options {
  dir?: string;
  idsFile?: string;
  out: string;
  crxOut: string;
  model: string;
  think?: string;
  verifierModel?: string;
  methodology: string;
  replay?: boolean;
  cache: string | false;
  fixtures: string;
  force?: boolean;
  enrich?: boolean;
  costRates?: string;
  db: string | false;
  headroom?: boolean;
  headroomUrl: string;
  piShard?: boolean;
  piSubagentModel?: string;
  piSubagentModels?: string;
  piSynthesisModel?: string;
  piNoPack?: boolean;
  piMaxTurns?: string;
  piSubagentMaxTurns?: string;
  agenticMaxStepsPerDimension?: string;
  /** Raw flag value; parseMaxTokens turns it into the number the run uses. */
  maxTokens?: string;
  yes?: boolean;
}

type AssessOptions = Options & ProviderFlags;

// Parse the --methodology value, which may be a single id or a comma-separated
// list ("monolith,dag,agentic"). Order is preserved; duplicates are dropped.
function parseMethodologyList(raw: string): string[] {
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  if (out.length === 0) throw new ScorecardError("--methodology is empty (expected one or more of: monolith, dag, agentic, pi)");
  return out;
}

// Shared per-extension context: resolved once (fetch + static analyze + listing),
// then reused across every methodology so the evidence pack is identical and the
// CRX is fetched / analyzed a single time.
interface ExtensionContext {
  id: string;
  sourceDir: string;
  storeId: string | null;
  pack: ReturnType<typeof analyze>;
  listing: DeveloperListing | null;
  enrichment: HostEnrichment | null;
}

// Run one methodology against an already-resolved extension context and write
// its report. When `multi` is true the report files are namespaced by
// methodology (<id>.<methodology>.{md,json,html}) so concurrent methodologies on
// the same extension don't clobber each other; in single mode the historical
// <id>.{md,json,html} names are kept.
async function assessOne(
  methodologyId: string,
  ctx: ExtensionContext,
  opts: AssessOptions,
  client: RecordReplayClient,
  rates: ReturnType<typeof parseCostRates>,
  mode: ReplayMode,
  multi: boolean,
): Promise<boolean> {
  const startedAt = new Date().toISOString();
  const { id, sourceDir, storeId, pack, listing, enrichment } = ctx;

  // The UsageTracker wraps the shared client so every step (generation, verifier
  // fan-out) is accounted per label — fresh per methodology so accounting and
  // cost are reported separately for each.
  //
  // --max-tokens sits BELOW the tracker: a fresh BudgetedClient per methodology,
  // so the ceiling is per-analysis rather than shared across a comma-separated
  // list (a two-arm run should not have the first arm starve the second).
  const maxTokens = parseMaxTokens(opts.maxTokens);
  const budgeted = maxTokens !== undefined ? new BudgetedClient(client, maxTokens) : null;
  const tracker = new UsageTracker(budgeted ?? client);
  // headroom + shard config only affect the Pi arm (the others use the injected LlmClient).
  const piViaHeadroom = methodologyId === "pi" && opts.headroom === true;
  const piExtra: PiExtra | undefined =
    methodologyId === "pi"
      ? {
          provider: opts.provider,
          // --headroom points pi at a local compression proxy, which IS an
          // OpenAI-compatible endpoint — so it is just a base-URL override that
          // beats --base-url when both are given.
          baseUrl: piViaHeadroom ? opts.headroomUrl : opts.baseUrl,
          shard: opts.piShard,
          subagentModel: opts.piSubagentModel,
          subagentModels: opts.piSubagentModels ? parseSubagentModels(opts.piSubagentModels) : undefined,
          synthesisModel: opts.piSynthesisModel,
          noPack: opts.piNoPack,
          maxTurns: positiveLimit(opts.piMaxTurns, "pi-max-turns"),
          subagentMaxTurns: positiveLimit(opts.piSubagentMaxTurns, "pi-subagent-max-turns"),
        }
      : undefined;
  const piSharded = piExtra !== undefined && isSharded(piExtra);
  const subagentModels = piSharded ? effectiveSubagentModels(opts.model, piExtra!) : undefined;
  const methodology = makeMethodology(methodologyId, opts.model, opts.think, opts.verifierModel, piExtra, positiveLimit(opts.agenticMaxStepsPerDimension, "agentic-max-steps-per-dimension"));
  process.stdout.write(
    `assessing ${id} with methodology="${methodology.id}" model="${methodology.model}" (${mode}${listing ? ", with store listing" : ""}${piViaHeadroom ? `, via headroom ${opts.headroomUrl}` : ""}${piSharded ? ", sharded fan-out" : ""}${piExtra?.noPack ? ", pack-off (cold)" : ""}) …\n`,
  );
  // Where the requests go, before any spend. Never prints the key.
  const endpoint = resolveRunProvider(methodologyId, mode, opts, piExtra?.baseUrl);
  if (process.env.LLM_ADAPTER && methodologyId !== "pi" && mode === "RECORD") {
    process.stdout.write(`requests go to: custom adapter LLM_ADAPTER=${process.env.LLM_ADAPTER}\n`);
  } else if (endpoint) {
    process.stdout.write(`requests go to: ${endpoint.line}\n`);
  }
  // Cost preflight (W2.3): print the estimate BEFORE any spend, refuse outright
  // when it already exceeds --max-tokens, and ask on an interactive terminal
  // when the estimate is large. Non-interactive callers (the runner daemon, CI)
  // are never prompted — they get the estimate on stdout and proceed.
  const preflight = estimatePreflight({
    methodology: methodology.id,
    model: methodology.model,
    packChars: methodology.id === "monolith" ? serializePackForPrompt(pack, enrichment).length : JSON.stringify(pack).length,
    rates,
  });
  process.stdout.write(`${renderPreflight(preflight)}\n`);
  enforceBudget(preflight, maxTokens);
  if (mode === "RECORD" && !opts.yes && needsConfirmation(preflight) && !(await confirmSpend())) {
    throw new ScorecardError("aborted at the cost preflight — nothing was spent");
  }

  await recordAssessStage("investigation", "started", `Running ${methodology.id} investigation`);
  const result = await methodology.run({ sampleDir: sourceDir, pack, listing, enrichment, onProgress: recordAssessStage }, tracker);
  // Fold in usage from passes that bypassed the tracker (the Pi arm's own model
  // sessions) so per-step accounting reconciles to the report aggregate.
  for (const l of result.usageByStep ?? []) tracker.addExternal(l);
  // Those same passes bypassed the ceiling too, so charge them to it and check
  // the total — after the fact is the best an out-of-seam arm allows.
  if (budgeted) {
    for (const l of result.usageByStep ?? []) budgeted.addExternal(l.inputTokens + l.outputTokens);
    budgeted.assertWithinBudget();
  }
  const accounting = tracker.summary(rates);

  // Write the report (.md + .json + .html) to the output directory. The
  // single-extension path knows the store id, which the methodology (shared
  // with corpus eval runs, where ids are ground-truth hints) must not — so it
  // is injected here and the report re-rendered from the contract.
  let report = result.report;
  let html: string | null = null;
  const trace = result.structured as MonolithTrace | undefined;
  if (trace?.risk_report) {
    trace.risk_report.extension.store_id = storeId;
    report = renderReportMarkdown(trace.risk_report);
    html = renderReportHtml(trace.risk_report, {
      rows: [
        { label: "Source", value: sourceDir },
        { label: "Methodology", value: methodology.id },
        { label: "Mode", value: mode },
        { label: "Tokens (in/out)", value: `${result.usage.inputTokens} / ${result.usage.outputTokens}` },
        ...(accounting.estimatedUsd !== null ? [{ label: "Est. cost (USD)", value: `$${accounting.estimatedUsd.toFixed(4)}` }] : []),
      ],
    });
  }

  const outcome = outcomeFromStructured(result.structured);
  const meta: ReportMeta = {
    outcome,
    id,
    methodology: methodology.id,
    model: methodology.model,
    mode,
    sourceDir,
    usage: result.usage,
    provider: endpoint ? { id: endpoint.id, baseUrl: endpoint.baseUrl } : null,
  };
  const stem = multi ? `${id}.${methodology.id}` : id;
  mkdirSync(opts.out, { recursive: true });
  const mdPath = join(opts.out, `${stem}.md`);
  const jsonPath = join(opts.out, `${stem}.json`);
  writeFileSync(mdPath, renderMarkdown(meta, report, accounting));
  writeFileSync(jsonPath, renderJson(meta, report, accounting, result.structured));
  const written = [mdPath, jsonPath];
  if (html !== null) {
    const htmlPath = join(opts.out, `${stem}.html`);
    writeFileSync(htmlPath, html);
    written.push(htmlPath);
  }
  const cost = accounting.estimatedUsd !== null ? `, est. $${accounting.estimatedUsd.toFixed(4)}` : "";
  process.stdout.write(`report written to ${written.join(", ")} (${result.usage.inputTokens}/${result.usage.outputTokens} tokens${cost})\n`);

  // Record the run to the bake-off DB (secondary sink; never aborts on failure).
  await recordAssessStage("investigation", "finished", "Investigation returned; preparing recorded report");
  await recordAssessStage("report-recording", "started", "Recording assessment and accounting");
  const receipt = recordRunSafe(
    opts.db,
    withProviderProvenance(runInputFromAssess({
      knobs: { methodology: methodology.id, model: methodology.model, verifierModel: opts.verifierModel, think: opts.think, mode, headroom: piViaHeadroom, subagentModels, costRates: rates },
      startedAt,
      storeId,
      sourceDir,
      result,
      reportText: report,
      accounting,
    }), providerProvenance(endpoint)),
  );
  if (process.env.EXTRAY_ASSESS_RECEIPT && receipt) {
    writeFileSync(process.env.EXTRAY_ASSESS_RECEIPT, JSON.stringify(receipt), { mode: 0o600 });
  }
  if (receipt) await recordAssessStage("report-recording", "finished", "Assessment and accounting recorded");
  const notice = outcomeNotice(outcome);
  if (notice) {
    process.stderr.write(`assess: ${notice}\n`);
    process.exitCode = 6; // artifacts and accounting saved; investigation incomplete
  }
  return !notice;
}

// When --headroom is set, the Pi arm's model traffic is sent to a headroom proxy
// (a separate, user-launched process) instead of Ollama Cloud directly. We don't
// manage its lifecycle; preflight that it is reachable so the run fails fast with
// guidance instead of deep inside Pi's session. Any HTTP response (even a 404)
// means the proxy is up; only a transport error means it is not.
async function preflightHeadroom(url: string): Promise<void> {
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    throw new ScorecardError(`--headroom-url is not a valid URL: ${url}`);
  }
  try {
    await fetch(origin, { method: "GET", signal: AbortSignal.timeout(3000) });
  } catch {
    throw new ScorecardError(
      `headroom proxy not reachable at ${origin} (from --headroom-url ${url}). ` +
        `Start it first (e.g. \`headroom proxy --port 8787\`, configured to forward to Ollama Cloud), ` +
        `or pass --headroom-url / set HEADROOM_URL to the right address.`,
    );
  }
}

async function run(input: string | undefined, opts: AssessOptions): Promise<boolean> {
  const methodologies = parseMethodologyList(opts.methodology);
  assertReplayable(methodologies, opts.replay);

  // 0. headroom preflight + scope warning. It only routes the Pi arm; flagging it
  // without `pi` in the list is almost certainly a mistake, so say so loudly.
  if (opts.headroom) {
    if (!methodologies.includes("pi")) {
      process.stderr.write("assess: --headroom only affects the pi arm, but pi is not in --methodology — it will have no effect\n");
    } else {
      await preflightHeadroom(opts.headroomUrl);
    }
  }

  await recordAssessStage("preparation", "started", "Downloading and preparing extension package");
  // 1. Resolve the unpacked extension directory (fetch it, or use --dir).
  let id: string;
  let sourceDir: string;
  let fetchedNow = false;
  if (opts.dir) {
    if (input) throw new ScorecardError("pass either an <id-or-url> or --dir, not both");
    sourceDir = opts.dir;
    id = basename(resolve(sourceDir));
  } else {
    if (!input) throw new ScorecardError("nothing to assess — pass an <id-or-url> or --dir <ext-dir>");
    const fetched = await fetchAndUnpack(input, { out: opts.crxOut, keepCrx: false, force: opts.force ?? false });
    id = fetched.id;
    sourceDir = fetched.destDir;
    fetchedNow = true;
  }

  // 1.5 De-minify bundled/minified JS in place before anything reads it, so the
  // evidence pack AND the LLM arms (which read the same sourceDir) see real line
  // numbers instead of a single 1MB+ line that reads as an opaque blind spot.
  // Semantics-preserving and idempotent; no-op on already-readable trees.
  const deminified = deminifyExtensionDir(sourceDir);
  if (deminified.files.length) {
    process.stdout.write(`de-minified ${deminified.files.length} bundled file(s) before analysis\n`);
  }

  await recordAssessStage("preparation", "finished", "Extension package prepared");
  await recordAssessStage("static-analysis", "started", "Building and validating static evidence pack");
  // 2. Static pipeline → evidence pack (computed once, shared across methodologies).
  const pack = analyze(sourceDir, { cacheDir: opts.cache === false ? undefined : opts.cache });
  const { valid, errors } = validatePack(pack);
  if (!valid) {
    throw new ScorecardError(`static analysis produced an invalid evidence pack:\n${errors.map((x) => "  - " + x).join("\n")}`);
  }

  // 3. Resolve the store listing once. Auto-fetch only when we fetched the CRX
  // (id/url mode); in --dir mode a sibling artifact is still loaded if present,
  // but a missing one is not fetched (the dir's basename may not be a real id).
  const storeId = /^[a-p]{32}$/.test(id) ? id : null;
  const listing = await loadListing(sourceDir, fetchedNow ? storeId : null, opts);
  // 015: host enrichment. By default the pipeline only READS a committed
  // host-enrichment artifact (a missing one just leaves hosts un-enriched —
  // enrichment is a deliberate RECORD step). `--enrich` makes assess RECORD it
  // here first, mirroring how it auto-fetches the store listing: the enricher
  // writes/refreshes the sibling artifact (idempotent; skips fresh, fills new
  // hosts), then we load it. It only touches the network in RECORD mode —
  // `--enrich --replay` is a no-op (replay must stay hermetic).
  if (opts.enrich) {
    if (opts.replay) {
      process.stderr.write("assess: --enrich is ignored under --replay (replay never touches the network)\n");
    } else {
      try {
        const r = await enrichExtension(sourceDir, { force: opts.force ?? false });
        process.stderr.write(`assess: host enrichment ${r.skipped ? "reused" : "recorded"} (${r.total} host(s)) → ${r.artifactPath}\n`);
      } catch (e) {
        process.stderr.write(`assess: host enrichment failed (${(e as Error).message}) — destinations will be un-enriched\n`);
      }
    }
  }
  let enrichment: HostEnrichment | null = null;
  try {
    enrichment = loadEnrichmentBeside(sourceDir);
  } catch (e) {
    process.stderr.write(`assess: ignoring malformed host-enrichment artifact (${(e as Error).message})\n`);
  }

  await recordAssessStage("static-analysis", "finished", "Static evidence and available enrichment loaded");
  // 4. Run each methodology against the shared evidence pack. The live adapter
  // (RECORD mode) is loaded once and shared, as is the record/replay cache.
  // Rates default to the committed price table (overlaid with any --cost-rates /
  // $LLM_COST_RATES override) so estimated_usd lands non-null at write time;
  // unlisted models still cost out to null and surface in uncostedModels.
  const rates = resolveEffectiveRates(opts.costRates ?? process.env.LLM_COST_RATES);
  const mode: ReplayMode = opts.replay ? "REPLAY" : "RECORD";
  const client = new RecordReplayClient({
    mode,
    fixtureDir: opts.fixtures,
    wrapped: mode === "RECORD" ? await loadAdapter({ provider: opts.provider, baseUrl: opts.baseUrl }) : undefined,
  });
  const ctx: ExtensionContext = { id, sourceDir, storeId, pack, listing, enrichment };
  const multi = methodologies.length > 1;
  let complete = true;
  for (const methodologyId of methodologies) {
    const accepted = await assessOne(methodologyId, ctx, opts, client, rates, mode, multi);
    complete = complete && accepted;
  }
  return complete;
}

// Map a known assess error to the exit code the single-run path uses, or null
// if it is unexpected (a programmer bug) and should bubble up / abort the batch.
// Rate limits get their own code (5) so batch drivers can back off + retry
// instead of failing the extension: the check runs on message text (after the
// definitively-not-rate-limit types) because the pi arm bypasses the LlmClient
// seam and surfaces provider 429s as plain Errors.
function classifyError(e: unknown): { code: number; message: string } | null {
  if (e instanceof FixtureMissError) return { code: 4, message: e.message };
  if (e instanceof HardError) return { code: 3, message: e.message };
  // Config/usage error, not an analysis failure: the caller pointed an arm at
  // committed corpus ground truth, which the de-minify pass would rewrite.
  if (e instanceof CorpusMutationError) return { code: 2, message: e.message };
  if (isRateLimitError(e)) return { code: 5, message: (e as Error).message ?? String(e) };
  // A refused/aborted budget is a config/usage outcome, not an analysis failure:
  // by contract nothing was charged past the ceiling.
  if (e instanceof TokenBudgetError || e instanceof ContextCapacityError) return { code: 2, message: e.message };
  // A misconfigured provider (missing key, unknown preset, no base URL) is a
  // config error like a bad flag — and must not escape as a raw stack trace.
  if (e instanceof FetchError || e instanceof ScorecardError || e instanceof CostRatesError || e instanceof ProviderConfigError) {
    return { code: 2, message: e.message };
  }
  return null;
}

/** On a rate-limited exit, leave a breadcrumb the runner's budget ledger learns
 *  caps from. Best-effort, same never-abort posture as recordRunSafe. */
function recordRateLimitEvent(opts: Options, input: string | undefined, message: string): void {
  const storeId = input && /^[a-p]{32}$/.test(input) ? input : null;
  recordLedgerEventSafe(opts.db, {
    kind: "rate_limit",
    source: "assess",
    storeId,
    model: opts.model,
    detail: message.slice(0, 500),
  });
}

// Batch mode (--ids-file): assess each ID/URL in turn. A known per-item failure
// is logged and skipped so one bad entry never aborts the run; an unexpected
// error still bubbles up. Exits 1 for failures, 6 for incomplete artifacts, otherwise 0.
async function runBatch(inputs: string[], opts: AssessOptions): Promise<void> {
  const failures: { input: string; code: number; message: string }[] = [];
  const incomplete: string[] = [];
  for (const [i, input] of inputs.entries()) {
    process.stdout.write(`\n[${i + 1}/${inputs.length}] ${input}\n`);
    try {
      if (!(await run(input, opts))) incomplete.push(input);
    } catch (e) {
      const classified = classifyError(e);
      if (!classified) throw e; // unexpected — abort the whole batch
      if (classified.code === 5) recordRateLimitEvent(opts, input, classified.message);
      failures.push({ input, ...classified });
      process.stderr.write(`assess: [${input}] ${classified.message}\n`);
    }
  }
  const ok = inputs.length - failures.length - incomplete.length;
  process.stdout.write(`\nbatch complete: ${ok} completed, ${incomplete.length} incomplete with artifacts, ${failures.length} failed (of ${inputs.length})\n`);
  for (const input of incomplete) process.stdout.write(`  INCOMPLETE ${input} (exit 6): artifacts saved; investigation not complete\n`);
  if (failures.length > 0) {
    for (const f of failures) process.stdout.write(`  FAILED ${f.input} (exit ${f.code}): ${f.message}\n`);
    process.exit(1);
  }
}

// The Explorer Settings file (chosen in the `serve` UI, or hand-written) supplies
// the DEFAULTS for the arm flags, so the arm picked in the browser is the arm the
// CLI runs. Precedence stays: explicit flag > env > settings file > built-in.
// The stored API key goes into the environment rather than onto the command line.
const settings = process.env.EXTRAY_IGNORE_SETTINGS === "1" ? null : loadSettingsIfPresent();

function positiveLimit(raw: string | undefined, field: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new ScorecardError(`--${field} must be a positive integer`);
  return value;
}

function applySavedOptions(opts: AssessOptions): void {
  if (!settings?.options) return;
  const saved = analysisOptionsForMethodology(settings.options, opts.methodology);
  const mapped: Record<string, unknown> = { ...saved,
    ...(saved.think !== undefined ? { think: String(saved.think) } : {}),
    ...(saved.maxTokens !== undefined ? { maxTokens: String(saved.maxTokens) } : {}),
    ...(saved.piMaxTurns !== undefined ? { piMaxTurns: String(saved.piMaxTurns) } : {}),
    ...(saved.piSubagentMaxTurns !== undefined ? { piSubagentMaxTurns: String(saved.piSubagentMaxTurns) } : {}),
    ...(saved.agenticMaxStepsPerDimension !== undefined ? { agenticMaxStepsPerDimension: String(saved.agenticMaxStepsPerDimension) } : {}),
    ...(saved.piSubagentModels ? { piSubagentModels: Object.entries(saved.piSubagentModels).map(([k, v]) => `${k}=${v}`).join(",") } : {}),
  };
  if (saved.forceFresh !== undefined) mapped.force = saved.forceFresh;
  if (saved.useCache === false) mapped.cache = false;
  delete mapped.forceFresh; delete mapped.useCache;
  for (const [key, value] of Object.entries(mapped)) {
    if (program.getOptionValueSource(key) === "cli") continue;
    if (key === "think" && process.env.SCORECARD_THINK !== undefined) continue;
    if (key === "verifierModel" && process.env.SCORECARD_VERIFIER_MODEL !== undefined) continue;
    (opts as unknown as Record<string, unknown>)[key] = value;
  }
}

const program = new Command();
addProviderOptions(program, { fromSettings: true, provider: settings?.provider.id, baseUrl: settings?.provider.baseUrl })
  .name("assess")
  .description("Run an analysis methodology on a single extension (CRX id/url or unpacked dir) and write its risk report")
  .argument("[id-or-url]", "extension ID or Chrome Web Store URL to fetch and assess")
  .option("--dir <path>", "assess an already-unpacked extension directory instead of fetching")
  .option("--ids-file <list>", "batch: assess every ID/URL in a file (one per line; # comments ok)")
  .option("--out <dir>", "directory for the <id>.md + <id>.json report", ".out/reports")
  .option("--crx-out <dir>", "where fetched CRXs are unpacked (id/url mode)", "example_crxs")
  .option(
    "--methodology <ids>",
    "methodology to run; comma-separate to run several (pi,monolith,dag,agentic). Default pi — the most effective measured arm",
    settings?.methodology ?? "pi",
  )
  .option("--model <id>", "model id (drives fixture keys); falls back to $SCORECARD_MODEL, then the Explorer Settings file", process.env.SCORECARD_MODEL || settings?.model || "unspecified")
  .option("--think <level>", "model reasoning effort: true|false|low|medium|high (drives fixture keys); falls back to $SCORECARD_THINK", process.env.SCORECARD_THINK)
  .option("--verifier-model <id>", "claim-verifier model (013); defaults to --model; falls back to $SCORECARD_VERIFIER_MODEL", process.env.SCORECARD_VERIFIER_MODEL)
  .option("--cost-rates <json-or-file>", 'USD per 1M tokens by model: {"<model>":{"input":N,"output":N},"default":{…}}; falls back to $LLM_COST_RATES', process.env.LLM_COST_RATES)
  .option("--enrich", "RECORD RDAP host enrichment (015) for the extension's external hosts before assessing, writing the sibling host-enrichment.json (idempotent; RECORD mode only)")
  .option("--replay", "serve the LLM call from cache only (default is RECORD: live + cache)")
  .option("--fixtures <dir>", "LLM record/replay cache directory", ".cache/assess-llm")
  .option("--cache <dir>", "Layer-3 static cache directory", ".cache")
  .option("--no-cache", "disable the Layer-3 static cache")
  .option("--db <path>", "bake-off DB to record this run into (for cross-run comparison)", ".out/bakeoff.sqlite")
  .option("--no-db", "do not record this run to the bake-off DB")
  .option("--headroom", "route the pi arm's model traffic through a headroom compression proxy (must be running); recorded to the DB for on/off comparison")
  .option("--headroom-url <url>", "headroom proxy base URL (OpenAI-compatible); falls back to $HEADROOM_URL", process.env.HEADROOM_URL || "http://localhost:8787/v1")
  .option("--pi-shard", "pi arm: fan investigation out across one sub-session per dimension + a synthesis pass (parallel, lower token growth) instead of one monolithic session")
  .option(
    "--pi-subagent-model <id>",
    "pi arm: one model for ALL dimension shards (implies --pi-shard); leaves the verifier and synthesis on --model. Per-dimension overrides still win",
  )
  .option(
    "--pi-subagent-models <spec>",
    'pi arm: per-dimension model overrides (implies --pi-shard), e.g. "exfiltration=glm-5.2:cloud,obfuscation=gemma4:cloud"; unspecified dimensions use --pi-subagent-model then --model',
  )
  .option("--pi-synthesis-model <id>", "pi arm: model for the cross-cutting synthesis pass (implies --pi-shard); defaults to --model")
  .option("--pi-no-pack", "pi arm: run the investigator WITHOUT the evidence pack (no orientation map, no read_pack tool) — explore the unpacked extension cold; for pack-on/pack-off A/B (016). The backend still uses the pack")
  .option("--pi-max-turns <n>", "Pi investigator turn limit (default 50)")
  .option("--pi-subagent-max-turns <n>", "Pi turn limit per dimension shard (default 20)")
  .option("--agentic-max-steps-per-dimension <n>", "Agentic tool-call budget per dimension (default 8)")
  // Parsed as a string and validated inside the action: a commander coercion
  // callback throws during argv parsing, outside the try/catch that owns this
  // CLI's exit-code contract, and would surface as exit 1 instead of 2.
  .option(
    "--max-tokens <n>",
    "hard ceiling on tokens for ONE methodology run; refuses up front when the preflight estimate exceeds it, and aborts cleanly if a run crosses it",
  )
  .option("--yes", "skip the interactive confirmation above the cost-preflight threshold", false)
  .option("--force", "re-fetch even if already unpacked (id/url mode)", false)
  .addHelpText(
    "after",
    "\nExit codes:\n  0  reports generated, with no reported incomplete investigation\n  1  batch (--ids-file): one or more entries failed\n" +
      "  2  config/usage error (bad flag, no input, no adapter, fetch failure)\n" +
      "  3  static analysis failed or produced an invalid pack\n  4  REPLAY cache miss (drop --replay to record it live)\n" +
      "  5  provider rate limit / quota exhausted (retry after the session resets)\n" +
      "  6  report artifacts saved; investigation incomplete (provisional assessment)\n" +
      providerHelpText() +
      PI_INJECTION_CAVEAT,
  )
  // The stored key is applied only once the flags are parsed, because it is bound
  // to the provider + base URL it was saved for: --provider / --base-url pointing
  // elsewhere must not receive it.
  .hook("preAction", (cmd) => {
    if (!settings) return;
    const o = cmd.opts<ProviderFlags>();
    const keyVars = ["OLLAMA_API_KEY", "OPENAI_API_KEY", "NVIDIA_API_KEY"];
    const before = keyVars.map((k) => process.env[k]);
    applySettingsApiKey(settings, process.env, { provider: o.provider, baseUrl: o.baseUrl });
    if (keyVars.some((k, i) => process.env[k] !== before[i])) {
      process.stderr.write("assess: using the API key saved in Explorer Settings\n");
    }
  })
  .action(async (input: string | undefined, opts: AssessOptions) => {
    try {
      applySavedOptions(opts);
      positiveLimit(opts.piMaxTurns, "pi-max-turns");
      positiveLimit(opts.piSubagentMaxTurns, "pi-subagent-max-turns");
      positiveLimit(opts.agenticMaxStepsPerDimension, "agentic-max-steps-per-dimension");
      assertReplayable(parseMethodologyList(opts.methodology), opts.replay);
      if (opts.idsFile) {
        if (input) throw new ScorecardError("pass either an <id-or-url> or --ids-file, not both");
        if (opts.dir) throw new ScorecardError("--ids-file cannot be combined with --dir (batch fetches by id/url)");
        const inputs = readListFile(opts.idsFile);
        if (inputs.length === 0) throw new ScorecardError(`--ids-file ${opts.idsFile} has no IDs or URLs (all lines blank or comments)`);
        await runBatch(inputs, opts);
      } else {
        await run(input, opts);
      }
    } catch (e) {
      const classified = classifyError(e);
      if (!classified) throw e;
      if (classified.code === 5) recordRateLimitEvent(opts, input, classified.message);
      process.stderr.write(`assess: ${classified.message}\n`);
      process.exit(classified.code);
    }
  });

program.parseAsync();
