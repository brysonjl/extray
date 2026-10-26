// The pure planning half of scripts/drain-submissions.ts: which queued rows
// become assess runs vs. immediate failures, the failure UPDATEs pushed back
// to D1, and the arm-visibility preflight that keeps a drain from running
// analyses the sync close-loop could never use. The wrangler/assess-driving
// half is exercised end-to-end against local D1.

import { describe, expect, it } from "vitest";
import {
  armVisibilityError,
  DEFAULT_ASSESS_ARGS,
  pinnedArmWarning,
  planDrain,
  planFailureUpdates,
  type QueuedRow,
} from "../scripts/drain-submissions.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";

const NOW = "2026-07-07T12:00:00.000Z";
const ID_A = "a".repeat(32);
const ID_B = "b".repeat(32);

describe("planDrain", () => {
  it("plans one assess run per distinct store_id, oldest first", () => {
    const plan = planDrain([
      { id: 1, store_id: ID_A },
      { id: 2, store_id: ID_B },
    ]);
    expect(plan.work).toEqual([
      { storeId: ID_A, submissionIds: [1] },
      { storeId: ID_B, submissionIds: [2] },
    ]);
    expect(plan.rejected).toEqual([]);
  });

  it("dedups multiple queued jobs for the same extension onto one run", () => {
    const plan = planDrain([
      { id: 1, store_id: ID_A },
      { id: 2, store_id: ID_B },
      { id: 3, store_id: ID_A },
    ]);
    expect(plan.work).toEqual([
      { storeId: ID_A, submissionIds: [1, 3] },
      { storeId: ID_B, submissionIds: [2] },
    ]);
  });

  it("rejects rows without a store id, mirroring the worker tick", () => {
    const plan = planDrain([{ id: 4, store_id: null }]);
    expect(plan.work).toEqual([]);
    expect(plan.rejected).toEqual([{ id: 4, reason: "no store id extracted from input" }]);
  });

  it("rejects malformed store ids instead of passing them to a child process", () => {
    const plan = planDrain([{ id: 5, store_id: "--not-an-id" }]);
    expect(plan.work).toEqual([]);
    expect(plan.rejected[0]).toMatchObject({ id: 5 });
  });

  it("throws on a non-integer id (nothing unvalidated may reach the SQL)", () => {
    expect(() => planDrain([{ id: 1.5, store_id: ID_A } as QueuedRow])).toThrow(/non-integer/);
  });
});

describe("planFailureUpdates", () => {
  it("marks every job of a failed extension, with a status guard", () => {
    const stmts = planFailureUpdates([{ ids: [7, 9], error: "fetch failed: 404" }], NOW);
    expect(stmts).toEqual([
      `UPDATE submission SET status = 'failed', error = 'fetch failed: 404', finished_at = '${NOW}' ` +
        `WHERE id IN (7, 9) AND status = 'queued';`,
    ]);
  });

  it("escapes quotes, collapses whitespace, and truncates the message", () => {
    const stmt = planFailureUpdates([{ ids: [1], error: `it's\n  broken ${"x".repeat(400)}` }], NOW)[0]!;
    expect(stmt).toContain("it''s broken");
    expect(stmt).not.toContain("\n");
    // 300 chars of message, with each escaped quote allowed to add one more.
    expect(/error = '((?:[^']|'')*)'/.exec(stmt)![1]!.length).toBeLessThanOrEqual(301);
  });

  it("throws on a non-integer id", () => {
    expect(() => planFailureUpdates([{ ids: [1, NaN], error: "x" }], NOW)).toThrow(/non-integer/);
  });
});

describe("armVisibilityError", () => {
  it("accepts the default assess args under the default profile", () => {
    expect(armVisibilityError(DEFAULT_ASSESS_ARGS, DEFAULT_PROFILE, {})).toBeNull();
  });

  it("accepts a user-fallback arm", () => {
    expect(armVisibilityError(["--methodology", "monolith", "--model", "glm-5.2:cloud"], DEFAULT_PROFILE, {})).toBeNull();
  });

  it("accepts a comma list when any listed methodology forms a visible arm", () => {
    expect(armVisibilityError(["--methodology", "agentic,pi", "--model", "glm-5.2:cloud"], DEFAULT_PROFILE, {})).toBeNull();
  });

  it("rejects an arm no user can see (the analyses could never close a job)", () => {
    const err = armVisibilityError(["--methodology", "pi", "--model", "some-other-model"], DEFAULT_PROFILE, {});
    expect(err).toMatch(/never close/);
  });

  it("applies assess's own defaults: monolith methodology, $SCORECARD_MODEL model", () => {
    expect(armVisibilityError([], DEFAULT_PROFILE, { SCORECARD_MODEL: "glm-5.2:cloud" })).toBeNull();
    expect(armVisibilityError([], DEFAULT_PROFILE, {})).toMatch(/monolith\|unspecified/);
  });

  it("honors commander's last-occurrence-wins for repeated flags", () => {
    const args = ["--model", "glm-5.2:cloud", "--methodology", "monolith", "--methodology", "pi"];
    expect(armVisibilityError(args, DEFAULT_PROFILE, {})).toBeNull();
  });
});

describe("pinnedArmWarning", () => {
  it("is silent when the flags run the pinned arm (the default set does)", () => {
    expect(pinnedArmWarning(DEFAULT_ASSESS_ARGS, DEFAULT_PROFILE, {})).toBeNull();
  });

  it("warns on a fallback arm — it cannot outrank an existing pinned verdict", () => {
    const args = ["--methodology", "monolith", "--model", "glm-5.2:cloud"];
    expect(pinnedArmWarning(args, DEFAULT_PROFILE, {})).toMatch(/stay open/);
  });
});
