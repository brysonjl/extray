/** Context capacity is per request, distinct from cumulative token spend. */
export class ContextCapacityError extends Error {
  readonly retryable = false;
}

// Observed native-provider limit, not a promise that num_ctx extends the model.
// Deliberately exact model matching: sibling models need their own limits.
export function observedContextLimit(model: string): number | undefined {
  return /^deepseek-v4\.1-flash(?::cloud)?$/.test(model) ? 1_048_576 : undefined;
}

export interface ContextCheck {
  inputTokens: number;
  outputReserve: number;
  contextTokens: number;
  exact: boolean;
}

/** A conservative screening estimate, NOT a tokenizer or a guaranteed bound.
 * JSON, hashes, and code invalidate chars/4. Use UTF-8 bytes/2 plus framing,
 * and leave the uncertainty explicit. Adapters may supply an exact tokenizer.
 */
export function checkContext(input: {
  model: string;
  prompt: string;
  contextTokens: number;
  outputReserve: number;
  exactInputTokens?: number;
}): ContextCheck {
  for (const n of [input.contextTokens, input.outputReserve, ...(input.exactInputTokens === undefined ? [] : [input.exactInputTokens])]) {
    if (!Number.isSafeInteger(n) || n <= 0) throw new ContextCapacityError("context limits and token counts must be positive safe integers");
  }
  const contextTokens = Math.min(input.contextTokens, observedContextLimit(input.model) ?? Infinity);
  const exact = input.exactInputTokens !== undefined;
  const inputTokens = input.exactInputTokens ?? Math.ceil(Buffer.byteLength(input.prompt, "utf8") / 2) + 512;
  const result = { inputTokens, outputReserve: input.outputReserve, contextTokens, exact };
  if (inputTokens + input.outputReserve > contextTokens) {
    throw new ContextCapacityError(
      `context capacity refused for model "${input.model}": ${exact ? "tokenized" : "estimated (UTF-8 bytes/2 + 512 framing; uncertain)"} ` +
      `input ${inputTokens} + output reserve ${input.outputReserve} exceeds context ${contextTokens}. ` +
      "No request sent. Preserve the evidence: use a compact inventory or a bounded multi-pass method, " +
      "or configure an exact tokenizer / verified context limit. Raising num_ctx cannot extend the model maximum.",
    );
  }
  return result;
}
