#!/usr/bin/env -S npx tsx
// Find extensions with a ground-truth (admin-only) report but no report from
// the pinned production arm or its User fallbacks, and write them as an
// --ids-file worklist for scripts/assess.ts.
//
// src/product/profile.ts deliberately keeps ground-truth out of a User's arm
// preference list (it's the eval oracle, not a production verdict source), so
// an extension analyzed only for ground truth is invisible on the User side of
// the Explorer no matter how long it's been in the corpus. The fix is running
// it through the pinned arm — same as any other new extension — not a profile
// change.
//
// Non-English extensions are skipped (see scripts/_locale-filter.ts) so this
// never re-introduces via the backfill what scripts/export-d1.ts filters back
// out at export time.
//
//   npm run backfill-catalog -- [--db .out/bakeoff.sqlite] [--out <file>] [--dry-run]
//
// Then run the printed command, which mirrors discover.ts's DEFAULT_ASSESS_ARGS
// (the pinned pi/glm-5.2:cloud arm) so results land as first-class, non-fallback
// canonical reports.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { canonicalReports } from "../src/product/canonical.ts";
import { DEFAULT_PROFILE } from "../src/product/profile.ts";
import { DEFAULT_ASSESS_ARGS } from "./discover.ts";
import { isEnglishOk } from "./_locale-filter.ts";

interface Args {
  db: string;
  out: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const program = new Command();
  program
    .name("backfill-catalog")
    .description("Queue ground-truth-only extensions for the pinned arm so they enter the User catalog")
    .option("--db <path>", "bake-off DB", ".out/bakeoff.sqlite")
    .option("--out <file>", "worklist output path", "worklists/missing-from-user.txt")
    .option("--dry-run", "print the plan; write nothing", false)
    .parse(argv, { from: "user" });
  return program.opts() as Args;
}

// ---- pure planning (unit-tested) --------------------------------------------

export interface CanonicalIdRow {
  storeId: string;
  name: string | null;
}

/** Store ids with an admin-visible (ground-truth) canonical report but no
 *  User-visible one — the catalog gap this script exists to close. */
export function missingFromUserCatalog(adminRows: CanonicalIdRow[], userRows: CanonicalIdRow[]): CanonicalIdRow[] {
  const userSet = new Set(userRows.map((r) => r.storeId));
  return adminRows.filter((r) => !userSet.has(r.storeId));
}

// ---- process plumbing --------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const db = new DatabaseSync(args.db, { readOnly: true });
  const ds = new SqliteDataSource(db);
  const [adminRows, userRows] = await Promise.all([
    canonicalReports(ds, "admin", DEFAULT_PROFILE),
    canonicalReports(ds, "user", DEFAULT_PROFILE),
  ]);
  db.close();

  const gap = missingFromUserCatalog(adminRows, userRows);
  const queued = gap.filter((r) => isEnglishOk(r.storeId));
  const skippedNonEnglish = gap.length - queued.length;

  process.stdout.write(
    `backfill-catalog: ${adminRows.length} ground-truth-visible, ${userRows.length} user-visible, ` +
      `${gap.length} missing from the user catalog (${skippedNonEnglish} skipped as non-English) → ${queued.length} to queue\n`,
  );

  if (args.dryRun) {
    for (const r of queued.slice(0, 25)) process.stdout.write(`  ${r.storeId}  ${r.name ?? ""}\n`);
    if (queued.length > 25) process.stdout.write(`  … +${queued.length - 25} more\n`);
    process.stdout.write("backfill-catalog: --dry-run, nothing written\n");
    return;
  }
  if (queued.length === 0) {
    process.stdout.write("backfill-catalog: nothing to queue\n");
    return;
  }

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, queued.map((r) => r.storeId).join("\n") + "\n");
  const sidecar = {
    generatedAt: new Date().toISOString(),
    db: args.db,
    count: queued.length,
    skippedNonEnglish,
    ids: queued,
  };
  writeFileSync(`${args.out}.json`, JSON.stringify(sidecar, null, 2) + "\n");

  const assessCmd = ["npm run assess --", "--ids-file", args.out, ...DEFAULT_ASSESS_ARGS, "--db", args.db].join(" ");
  process.stdout.write(`backfill-catalog: wrote ${args.out} (+ .json)\n\nRun it with:\n  ${assessCmd}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => {
    process.stderr.write(`backfill-catalog: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
