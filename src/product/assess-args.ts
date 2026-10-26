// THE single source of truth for the pinned production analysis invocation —
// the assess flags every batch driver (runner, discover --run, explorer:drain,
// the local admin UI) hands to scripts/assess.ts. Its --methodology/--model
// must match DEFAULT_PROFILE.pinned (src/product/profile.ts): an arm mismatch
// would burn real analysis money on reports the deployed Explorer never shows
// and that never close a submission. armVisibilityError() guards this at
// runtime; test/assess-args.test.ts guards it at CI time.
//
// Callers append their own flags after these (commander is last-wins), so
// --db etc. override cleanly.

export const DEFAULT_ASSESS_ARGS = [
  "--think", "high",
  "--methodology", "pi",
  "--force",
  "--enrich",
  "--pi-subagent-model", "minimax-m2.7:cloud",
  "--model", "glm-5.2:cloud",
];

/** The value the last occurrence of `flag` carries, mirroring commander's
 *  last-wins parse. Null when absent or valueless. */
export function lastFlagValue(args: string[], flag: string): string | null {
  const i = args.lastIndexOf(flag);
  if (i < 0 || i + 1 >= args.length) return null;
  const v = args[i + 1]!;
  return v.startsWith("--") ? null : v;
}
