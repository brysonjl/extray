#!/usr/bin/env -S npx tsx
// Print a rolling readout of Ollama analysis activity from the bake-off DB.
//
//   npm run ollama:usage -- [--db .out/bakeoff.sqlite] [--hours 5]
//
// Ollama Cloud exposes no quota/usage API (ollama/ollama#15663), so this is
// LOCAL ACTIVITY — how much analysis we've recorded in the window — not a
// remaining balance. Server-time under-counts the pi arm's sub-agent traffic.
// It's a gauge to sense how heavy we've been against the ~5h session clock.

import "./_env.ts";
import { Command } from "commander";
import { DEFAULT_WINDOW_HOURS, formatUsage, sessionUsageWindow } from "./_ollama-session.ts";

const program = new Command();
program
  .name("ollama-usage")
  .description("Show recorded analysis activity over a rolling window (a gauge, not Ollama's quota)")
  .option("--db <path>", "bake-off DB to read", ".out/bakeoff.sqlite")
  .option("--hours <n>", "window size in hours", (v) => Number(v), DEFAULT_WINDOW_HOURS)
  .action((o: { db: string; hours: number }) => {
    const u = sessionUsageWindow(o.db, o.hours);
    process.stdout.write(formatUsage(u) + "\n");
  });
program.parse();
