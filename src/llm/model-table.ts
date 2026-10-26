// The known-good model table (discovery B.3.2). Model choice is a CORRECTNESS
// variable here, not a cost variable, and that is measured rather than asserted:
// on the Great Suspender disclosure-gap test glm-5.2 and qwen3.5 classified the
// undisclosed remote script load correctly, gemma4 regressed to "analytics",
// minimax-m3 produced literally nothing (0 tool calls, 0 tokens), and kimi-k2.7
// thrashed to the turn ceiling with 18 invalid submissions and 4.8M input tokens.
//
// Shipping a security tool that silently returns zero findings on a weak model is
// how we get "your tool said my malware was clean", so every CLI that takes
// --model routes it through modelAdvisory() and prints the warning to stderr.
// This is advice, never a gate: an unknown model still runs.

/** How much we know about a model, from our own measurements. */
export type ModelStatus = "recommended" | "caution" | "untested";

export interface KnownModel {
  /** Family id, matched against a --model value with its provider tag stripped. */
  family: string;
  status: "recommended" | "caution";
  /** What we measured. Printed verbatim in the warning and the help table. */
  note: string;
  /** Set when the model has been withdrawn from a provider. The measurement
   *  still stands (so the entry is kept), but it is no longer offered as a
   *  recommendation. `since` is the date we last verified it gone. */
  unavailable?: { provider: string; since: string };
}

/**
 * Measured models, most-recommended first. `family` is compared with the
 * tag-stripped model id ("glm-5.2:cloud" and "glm-5.2" both resolve). The match
 * differs by status: a RECOMMENDED entry matches the exact id only — we measured
 * that model, not its siblings, so "qwen3.5:0.8b" keeps the tag-stripped id
 * but "glm-5.2-flash" is untested. A CAUTION entry matches by family prefix
 * ("kimi-k2.7-code" is covered by "kimi-k2.7"), because warning too broadly is
 * the safe direction.
 */
export const KNOWN_MODELS: readonly KnownModel[] = [
  {
    family: "glm-5.2",
    status: "recommended",
    note: "classified the undisclosed remote-script load correctly on the disclosure-gap test; the pinned production arm",
  },
  {
    family: "qwen3.5",
    status: "recommended",
    note: "classified the undisclosed remote-script load correctly on the disclosure-gap test",
    // GET ollama.com/api/tags no longer lists it (verified 2026-10-03).
    unavailable: { provider: "ollama", since: "2026-10-03" },
  },
  {
    family: "minimax-m3",
    status: "caution",
    note: "produced LITERALLY NOTHING on the disclosure-gap test (0 tool calls, 0 tokens) and omits prompt_eval_count on ~half its responses, so token accounting degrades to an estimate",
  },
  {
    family: "gemma4",
    status: "caution",
    note: 'regressed the undisclosed remote-script load to "analytics" — a false negative on the exact pattern the tool exists to catch',
  },
  {
    family: "kimi-k2.7",
    status: "caution",
    note: "thrashed to the turn ceiling on the pi arm with 18 schema-invalid submissions and 4.8M input tokens, returning no findings",
  },
] as const;

/** Model ids the CLIs use as a stand-in when no --model was passed. */
const PLACEHOLDER_MODELS = new Set(["unspecified", "unspecified-2", "test-model"]);

/**
 * Strip the provider tag from a model id so one table entry covers every way a
 * family is addressed: "glm-5.2:cloud" → "glm-5.2", "gemma4:31b-cloud" →
 * "gemma4", "openai/gpt-5.1" → "gpt-5.1" (OpenRouter-style vendor prefixes).
 */
export function modelFamily(model: string): string {
  const withoutVendor = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return withoutVendor.split(":")[0]!.trim().toLowerCase();
}

/**
 * The id a RECOMMENDED entry must equal. Only the provider-routing tags
 * (":cloud", ":latest") are dropped; a size tag such as ":0.8b" or ":9b" names a
 * different model than the one we measured, so it is kept and fails to match.
 */
function exactModelId(model: string): string {
  const withoutVendor = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return withoutVendor.trim().toLowerCase().replace(/:(cloud|latest)$/, "");
}

/**
 * The table entry covering this model id, or undefined when it is untested.
 * Exported so the web UI classifies models with the same rule as the CLIs.
 * Recommended entries match exactly; caution entries match by family prefix.
 */
export function lookupModel(model: string): KnownModel | undefined {
  const family = modelFamily(model);
  const exact = exactModelId(model);
  // Longest family first so "kimi-k2.7" cannot shadow a future "kimi-k2.7-max".
  return [...KNOWN_MODELS]
    .sort((a, b) => b.family.length - a.family.length)
    .find((m) =>
      m.status === "recommended" ? exact === m.family : family === m.family || family.startsWith(`${m.family}-`),
    );
}

/** Recommended family ids still obtainable, for the "Recommended: …" hints. */
export function recommendedFamilies(): string[] {
  return KNOWN_MODELS.filter((m) => m.status === "recommended" && !m.unavailable).map((m) => m.family);
}

export function modelStatus(model: string): ModelStatus {
  return lookupModel(model)?.status ?? "untested";
}

/**
 * The stderr line to print for a model, or null when it is recommended (or a
 * CLI placeholder — warning about "unspecified" is noise, and the run has no
 * real model to warn about yet).
 */
export function modelAdvisory(model: string): string | null {
  if (!model || PLACEHOLDER_MODELS.has(model)) return null;
  const known = lookupModel(model);
  if (known?.status === "recommended") return null;
  const recommended = recommendedFamilies().join(", ");
  if (known) {
    return (
      `WARNING: model "${model}" is a MEASURED-POOR arm for this tool — ${known.note}. ` +
      `A clean verdict from it is not evidence of a clean extension. Recommended: ${recommended}.`
    );
  }
  return (
    `WARNING: model "${model}" is UNTESTED against the labeled corpus. We have measured arms silently ` +
    `returning zero findings on weak models, so treat a clean verdict as unverified until you score this ` +
    `model yourself (\`npm run eval -- --model ${model}\`). Recommended: ${recommended}.`
  );
}

/** Print modelAdvisory() to stderr. Called by the CLIs, not the arms, so
 *  hermetic unit tests stay quiet (mirrors warnIfSelfVerify). */
export function warnUntestedModel(model: string): void {
  const advisory = modelAdvisory(model);
  if (advisory) console.warn(advisory);
}

/** The table as help text, for `--help` and the README. */
export function renderModelTable(): string {
  const lines = ["Measured models (model choice is a correctness variable — see docs):"];
  for (const m of KNOWN_MODELS) {
    const gone = m.unavailable ? ` [no longer available on ${m.unavailable.provider} as of ${m.unavailable.since}]` : "";
    lines.push(`  ${m.status === "recommended" && !m.unavailable ? "OK  " : "WARN"} ${m.family.padEnd(12)} ${m.note}${gone}`);
  }
  lines.push("  Any other model is UNTESTED: it runs, but score it with `eval` before trusting a clean verdict.");
  return lines.join("\n");
}
