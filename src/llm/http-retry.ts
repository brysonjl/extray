// Retry policy shared by every HTTP provider adapter. Extracted from the
// Ollama Cloud adapter when the second (OpenAI-compatible) adapter landed: a
// long RECORD run makes hundreds of calls against a cloud API, and the rules for
// "is this failure worth another attempt" are a property of HTTP, not of a
// vendor. Both adapters import this so a fix here fixes both.

/** Cap a server-supplied Retry-After so a hostile/buggy header can't stall a
 *  RECORD run for minutes per attempt. */
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * A non-2xx status worth retrying: server-side 5xx, plus 429 (rate limiting —
 * the most likely failure on a long RECORD run) and 408 (request timeout).
 * Other 4xx (bad model, bad auth) are deterministic and NOT retried.
 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into ms, capped. */
export function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  let ms: number;
  if (Number.isFinite(seconds)) {
    ms = seconds * 1000;
  } else {
    const date = Date.parse(header);
    if (Number.isNaN(date)) return undefined;
    ms = date - Date.now();
  }
  if (ms < 0) return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Flags an adapter attaches to a thrown error to steer the retry decision. */
export interface RetryHints {
  /** false = deterministic (bad model / bad auth / in-body API error): never retried. */
  retryable?: boolean;
  /** Honor a server-supplied Retry-After instead of linear backoff. */
  retryAfterMs?: number;
}

export interface RetryOptions {
  /** Extra attempts after the first. Default 2 (3 tries total). */
  retries?: number;
  /** Linear backoff base between retries, in ms. Default 500. */
  retryBaseMs?: number;
}

/**
 * Run `attempt` until it succeeds or the retry budget is spent.
 *
 * An error with no explicit `retryable` flag is a network/abort failure (fetch
 * rejected or a timeout fired) — transient by nature, so it IS retried. Only an
 * explicit `retryable: false` short-circuits.
 */
export async function withRetries<T>(attempt: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const retryBaseMs = opts.retryBaseMs ?? 500;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await attempt();
    } catch (e) {
      lastErr = e;
      const flagged = (e as RetryHints)?.retryable;
      const transient = flagged === true || flagged === undefined;
      if (!transient || i === retries) throw e;
      await sleep((e as RetryHints)?.retryAfterMs ?? retryBaseMs * (i + 1));
    }
  }
  throw lastErr; // unreachable; the loop either returns or throws
}
