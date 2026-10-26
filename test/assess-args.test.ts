// Drift guard: DEFAULT_ASSESS_ARGS (the flags every batch driver hands to
// scripts/assess.ts) must run the arm DEFAULT_PROFILE pins — the arm the
// deployed Explorer serves as "the verdict". armVisibilityError() catches a
// mismatch at runtime; this catches it at CI time, before money is spent.

import { describe, expect, it } from "vitest";
import { DEFAULT_ASSESS_ARGS, lastFlagValue } from "../src/product/assess-args.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";

describe("pinned assess args", () => {
  it("run the profile's pinned arm", () => {
    expect(lastFlagValue(DEFAULT_ASSESS_ARGS, "--methodology")).toBe(DEFAULT_PROFILE.pinned.methodology);
    expect(lastFlagValue(DEFAULT_ASSESS_ARGS, "--model")).toBe(DEFAULT_PROFILE.pinned.model);
  });

  it("lastFlagValue mirrors commander's last-wins parse", () => {
    expect(lastFlagValue(["--model", "a", "--model", "b"], "--model")).toBe("b");
    expect(lastFlagValue(["--force"], "--model")).toBeNull();
    expect(lastFlagValue(["--model", "--force"], "--model")).toBeNull();
    expect(lastFlagValue(["--model"], "--model")).toBeNull();
  });
});
