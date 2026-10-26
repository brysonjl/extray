// Rate-limit / quota-exhaustion detection, shared by the LLM seam's error
// classification (scripts/assess.ts → exit code 5) and the batch pacing layer
// (scripts/_ollama-session.ts). One regex, one place: the pi arm bypasses the
// LlmClient seam entirely and surfaces 429s as plain Errors, so detection has
// to work on message text, not error types.

// A rate-limit / quota-exhaustion signature across the providers the pi arm
// and monolith can reach (Ollama 429, OpenAI-compatible "rate_limit",
// Google-style RESOURCE_EXHAUSTED, generic quota wording).
export const RATE_LIMIT_RE =
  /\b429\b|rate[ _-]?limit|too many requests|quota|resource[ _]?exhausted|usage limit|out of (?:requests|usage|credits)/i;

export function looksRateLimited(text: string | null | undefined): boolean {
  return !!text && RATE_LIMIT_RE.test(text);
}

/** Whether an error (or anything in its `cause` chain) reads as a rate limit.
 *  Depth-capped: a pathological self-referencing cause chain must not spin. */
export function isRateLimitError(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof cur === "string") return looksRateLimited(cur);
    if (!(cur instanceof Error)) return false;
    if (looksRateLimited(cur.message)) return true;
    cur = cur.cause;
  }
  return false;
}
