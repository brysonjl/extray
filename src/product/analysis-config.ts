// Portable, shared validation for saved defaults and individual submissions.
// No credentials, filesystem paths, or arbitrary CLI arguments belong here.
import { DIMENSIONS, type Dimension } from "../methodologies/pi/guidance.ts";

export { DIMENSIONS as ANALYSIS_DIMENSIONS };
export type AnalysisDimension = Dimension;
export type AnalysisThink = boolean | "low" | "medium" | "high";

export interface AnalysisOptions {
  verifierModel?: string;
  think?: AnalysisThink;
  maxTokens?: number;
  enrich?: boolean;
  forceFresh?: boolean;
  useCache?: boolean;
  replay?: boolean;
  piShard?: boolean;
  piSubagentModel?: string;
  piSubagentModels?: Partial<Record<Dimension, string>>;
  piSynthesisModel?: string;
  piNoPack?: boolean;
  piMaxTurns?: number;
  piSubagentMaxTurns?: number;
  agenticMaxStepsPerDimension?: number;
}

export class AnalysisOptionsError extends Error {}
const BOOLEAN_FIELDS = ["enrich", "forceFresh", "useCache", "replay", "piShard", "piNoPack"] as const;
const NUMBER_FIELDS = ["maxTokens", "piMaxTurns", "piSubagentMaxTurns", "agenticMaxStepsPerDimension"] as const;
const MODEL_FIELDS = ["verifierModel", "piSubagentModel", "piSynthesisModel"] as const;
const KNOWN_FIELDS = new Set<string>([...BOOLEAN_FIELDS, ...NUMBER_FIELDS, ...MODEL_FIELDS, "think", "piSubagentModels"]);

function model(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.trim().startsWith("-") || value.trim().length > 200 || /[\n\r\0]/.test(value)) {
    throw new AnalysisOptionsError(`${field} must be a nonempty model ID of at most 200 characters, without a leading dash`);
  }
  return value.trim();
}

function supports(field: string, methodology: string): boolean {
  if (field.startsWith("pi")) return methodology === "pi";
  if (field === "think") return methodology === "monolith";
  if (field === "agenticMaxStepsPerDimension") return methodology === "agentic";
  if (field === "replay") return methodology !== "pi";
  return true;
}

/** Preserve general options when the operator selects another methodology. */
export function analysisOptionsForMethodology(options: AnalysisOptions, methodology: string): AnalysisOptions {
  return Object.fromEntries(Object.entries(options).filter(([field]) => supports(field, methodology))) as AnalysisOptions;
}

/** An options object replaces the previous object; null resets all overrides.
 * Null individual values also reset to the CLI default. Reject unknown keys so
 * a misspelled or unsupported setting cannot silently look as though it works. */
export function validateAnalysisOptions(input: unknown, methodology: string): AnalysisOptions {
  if (input === null || input === undefined) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new AnalysisOptionsError("options must be an object or null");
  const raw = input as Record<string, unknown>;
  const out: AnalysisOptions = {};
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) throw new AnalysisOptionsError(`unknown analysis option "${key}"`);
  }
  for (const field of BOOLEAN_FIELDS) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "boolean") throw new AnalysisOptionsError(`${field} must be a boolean`);
    out[field] = value;
  }
  for (const field of NUMBER_FIELDS) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new AnalysisOptionsError(`${field} must be a positive integer`);
    }
    out[field] = value;
  }
  for (const field of MODEL_FIELDS) {
    if (raw[field] !== undefined && raw[field] !== null) out[field] = model(raw[field], field);
  }
  if (raw.think !== undefined && raw.think !== null) {
    if (typeof raw.think !== "boolean" && !["low", "medium", "high"].includes(raw.think as string)) {
      throw new AnalysisOptionsError("think must be true, false, low, medium, or high");
    }
    out.think = raw.think as AnalysisThink;
  }
  if (raw.piSubagentModels !== undefined && raw.piSubagentModels !== null) {
    const models = raw.piSubagentModels;
    if (typeof models !== "object" || Array.isArray(models)) throw new AnalysisOptionsError("piSubagentModels must be an object");
    const parsed: Partial<Record<Dimension, string>> = {};
    for (const [dim, value] of Object.entries(models)) {
      if (!(DIMENSIONS as readonly string[]).includes(dim)) throw new AnalysisOptionsError(`unknown analysis dimension "${dim}"`);
      if (value !== null && value !== undefined) {
        const id = model(value, `piSubagentModels.${dim}`);
        if (id.includes(",")) throw new AnalysisOptionsError(`piSubagentModels.${dim} must not contain commas`);
        parsed[dim as Dimension] = id;
      }
    }
    if (Object.keys(parsed).length) out.piSubagentModels = parsed;
  }
  for (const [field, value] of Object.entries(out)) {
    if (!supports(field, methodology)) {
      // A false switch is the default and harmless on another methodology.
      if (value === false) delete (out as Record<string, unknown>)[field];
      else throw new AnalysisOptionsError(field === "replay"
        ? "pi is live-only; replay requires monolith, dag, or agentic"
        : `${field} is not supported by methodology "${methodology}"`);
    }
  }
  const sharded = Boolean(out.piShard || out.piSubagentModel || out.piSubagentModels || out.piSynthesisModel);
  if (out.piMaxTurns !== undefined && sharded) {
    throw new AnalysisOptionsError("piMaxTurns applies only to a single Pi investigator; use piSubagentMaxTurns for sharding");
  }
  if (out.piSubagentMaxTurns !== undefined && !out.piShard && !out.piSubagentModel && !out.piSubagentModels && !out.piSynthesisModel) {
    throw new AnalysisOptionsError("piSubagentMaxTurns requires Pi sharding or a shard model override");
  }
  return out;
}

/** Convert validated options to the same flags accepted by the assess CLI. */
export function analysisOptionsArgs(options: AnalysisOptions): string[] {
  const args: string[] = [];
  const values = [
    ["verifierModel", "--verifier-model"], ["think", "--think"], ["maxTokens", "--max-tokens"],
    ["piSubagentModel", "--pi-subagent-model"], ["piSynthesisModel", "--pi-synthesis-model"],
    ["piMaxTurns", "--pi-max-turns"], ["piSubagentMaxTurns", "--pi-subagent-max-turns"],
    ["agenticMaxStepsPerDimension", "--agentic-max-steps-per-dimension"],
  ] as const;
  for (const [field, flag] of values) if (options[field] !== undefined) args.push(flag, String(options[field]));
  for (const [field, flag] of [["enrich", "--enrich"], ["forceFresh", "--force"], ["replay", "--replay"], ["piShard", "--pi-shard"], ["piNoPack", "--pi-no-pack"]] as const) {
    if (options[field]) args.push(flag);
  }
  if (options.useCache === false) args.push("--no-cache");
  if (options.piSubagentModels && Object.keys(options.piSubagentModels).length) {
    args.push("--pi-subagent-models", DIMENSIONS.filter((dim) => options.piSubagentModels![dim]).map((dim) => `${dim}=${options.piSubagentModels![dim]}`).join(","));
  }
  return args;
}

/** Defaults version 1 is frozen: queued work must not acquire new defaults as
 * the app evolves. Null values explicitly describe provider-default reasoning
 * and an unlimited token budget in the snapshot's default semantics. */
export function resolveAnalysisDefaults(options: AnalysisOptions, methodology: string, primaryModel: string): AnalysisOptions {
  const specific: AnalysisOptions = {};
  if (methodology === "pi") {
    const sharded = Boolean(options.piShard || options.piSubagentModel || options.piSubagentModels || options.piSynthesisModel);
    Object.assign(specific, { piShard: sharded, piNoPack: false });
    if (sharded) Object.assign(specific, { piSubagentModel: primaryModel, piSynthesisModel: primaryModel, piSubagentMaxTurns: 20 });
    else specific.piMaxTurns = 50;
  }
  if (methodology === "agentic") specific.agenticMaxStepsPerDimension = 8;
  if (methodology !== "pi") specific.replay = false;
  return validateAnalysisOptions({ verifierModel: primaryModel, enrich: false, forceFresh: false, useCache: true, ...specific, ...options }, methodology);
}
