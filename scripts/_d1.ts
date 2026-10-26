// Shared wrangler/child-process plumbing for the Explorer sync + drain scripts:
// run a build step with live output, and read/write a D1 database (--local or
// --remote) through the wrangler CLI.

import { spawnSync } from "node:child_process";
import { wranglerArgs } from "./_wrangler.ts";

export type D1Mode = "--local" | "--remote";

/** Run a step with live output; non-zero exit aborts the caller. */
export function runStep(cmd: string, args: string[]): void {
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${res.status}`);
}

/** wrangler d1 execute … --json, parsed. "no such table" degrades to null so a
 *  fresh database reads as empty, same posture as src/product/datasource.ts. */
export function d1Query(database: string, mode: D1Mode, sql: string): Record<string, unknown>[] | null {
  const res = spawnSync(
    "node_modules/.bin/wrangler",
    wranglerArgs(["d1", "execute", database, mode, "--json", "--command", sql]),
    { encoding: "utf8" },
  );
  const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  if (res.status !== 0) {
    if (/no such table/i.test(combined)) return null;
    throw new Error(`d1 query failed: ${combined.trim().split("\n").slice(-5).join(" ")}`);
  }
  const stdout = res.stdout ?? "";
  const start = stdout.indexOf("[");
  const parsed: unknown = JSON.parse(stdout.slice(start));
  if (!Array.isArray(parsed)) throw new Error("unexpected d1 --json output shape");
  return parsed.flatMap((r) => ((r as { results?: unknown }).results as Record<string, unknown>[]) ?? []);
}

export function d1Write(database: string, mode: D1Mode, args: string[]): void {
  runStep("node_modules/.bin/wrangler", wranglerArgs(["d1", "execute", database, mode, "-y", ...args]));
}
