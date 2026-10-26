/** Suite-wide guard for the actual default provider/RDAP/listing network seam.
 * Install before test imports so clients capturing ambient fetch get the guard.
 * Injected fetch stubs, vi.spyOn and vi.stubGlobal remain ordinary mocks.
 *
 * Scope: ambient fetch in this Vitest worker. This is not a process sandbox:
 * raw node:http/net/DNS and child processes are not intercepted. Preserve the
 * CLI tests' explicit empty credentials / SKIP_DOTENV and enrichment DNS mock.
 * There is no live-network opt-out for the normal test suite.
 */
import { afterEach, expect } from "vitest";
import { isIP } from "node:net";

export function isLoopbackUrl(url: URL): boolean {
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return hostname === "localhost" || hostname === "localhost." || hostname === "::1" || (isIP(hostname) === 4 && hostname.startsWith("127."));
}

export function createOfflineFetchGuard(transport: typeof fetch) {
  const attempts: string[] = [];
  const guardedFetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    // These protocols are in-memory in Node and cannot reach a remote provider.
    if (url.protocol === "data:" || url.protocol === "blob:") return transport(input, init);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopbackUrl(url)) {
      // Retain enough context to find the mistaken call, without logging URL
      // credentials, query tokens, headers, or request bodies.
      const safeUrl = `${url.origin}${url.pathname}`;
      attempts.push(safeUrl);
      throw new Error(`offline test suite: real network fetch attempted (${safeUrl}). Inject a fetch stub instead.`);
    }
    // Native fetch follows redirects inside its own implementation, bypassing
    // this wrapper. Reject automatic redirects so a loopback test server cannot
    // accidentally forward a request (or credentials) to a remote destination.
    const manual = init?.redirect === "manual" || (init?.redirect === undefined && input instanceof Request && input.redirect === "manual");
    return transport(input, { ...init, redirect: manual ? "manual" : "error" });
  }) as typeof fetch;
  return {
    fetch: guardedFetch,
    takeAttempts: () => attempts.splice(0),
    peekAttempts: () => [...attempts],
  };
}

const guard = createOfflineFetchGuard(globalThis.fetch);
globalThis.fetch = guard.fetch;

/** Intentional guard regression tests must consume their expected attempts;
 * unexpected attempts still fail even if production catches the exception.
 */
export const takeBlockedNetworkAttempts = guard.takeAttempts;
export const peekBlockedNetworkAttempts = guard.peekAttempts;
afterEach(() => {
  expect(takeBlockedNetworkAttempts(), "a test attempted an unmocked remote fetch; inject a fetch stub").toEqual([]);
});
