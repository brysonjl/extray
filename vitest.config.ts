import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    // Real fetches are offline by default across EVERY test file, including
    // caught/degraded provider failures. Literal loopback servers remain usable.
    setupFiles: ["./test/setup-network.ts"],
    // Several tests run the real static-analysis pipeline (analyze/analyzeCorpus),
    // which is ~6s per corpus pass. Under parallel load that exceeds the 5s
    // default, so raise the per-test timeout. Pure-function tests are unaffected.
    testTimeout: 30_000,
    // Never pick up test files from:
    //  - Claude Code agent worktrees under .claude/worktrees/ — separate working
    //    copies whose tests resolve fixtures relative to THEIR root, not ours.
    //  - .out/ — private experiment copies and release-rehearsal snapshots can
    //    contain duplicate tests or third-party extension tests.
    //  - example_crxs/ and corpus/ — UNPACKED real-world extensions, some of
    //    which bundle their authors' own *.test.js files; vitest would otherwise
    //    try to run those and fail on browser globals / unresolved imports.
    exclude: [...configDefaults.exclude, "**/.claude/**", "**/.out/**", "example_crxs/**", "corpus/**"],
  },
});
