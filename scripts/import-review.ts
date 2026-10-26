// Intentionally does not load .env: importing a candidate review never calls a model.
import { Command } from "commander";
import { prepareReviewImport, saveReviewImport, type ImportReviewOptions } from "../src/reviews/import.ts";

const program = new Command();
program.name("import-review").description("Validate and save an unverified portable skill review in the local Explorer DB")
  .argument("<candidate.json>")
  .requiredOption("--source-dir <dir>", "original unpacked extension source")
  .requiredOption("--store-id <id>", "Chrome Web Store id")
  .requiredOption("--harness <name>", "reviewing harness, e.g. codex or claude-code")
  .requiredOption("--model <id>", "actual model used for the review")
  .option("--session-id <id>", "reviewing agent's session id")
  .option("--reviewed-at <iso>", "review timestamp; defaults to candidate file modification time")
  .option("--skill-dir <dir>", "exact skill copy used by the reviewer; defaults to this repo's skill")
  .option("--source-sha256 <hash>", "expected source-tree fingerprint; refuse changed source")
  .option("--db <file>", "local Explorer database", ".out/bakeoff.sqlite")
  .option("--dry-run", "validate and prepare without opening or writing the DB")
  .addHelpText("after", "\nNo model calls. Candidates remain unverified and do not replace the canonical assessment.\nExit 0: success; exit 2: validation, source, configuration, or DB error.\n")
  .action((file: string, opts: ImportReviewOptions & { db: string; dryRun?: boolean }) => {
    try {
      const prepared = prepareReviewImport(file, opts);
      const common = { methodology: prepared.input.methodology, verification: "not-run",
        candidates: prepared.report.skill_review!.review.findings.length,
        provenance: prepared.report.skill_review!.provenance };
      if (opts.dryRun) console.log(JSON.stringify({ dryRun: true, ...common }, null, 2));
      else {
        const saved = saveReviewImport(opts.db, prepared.input);
        console.log(JSON.stringify({ ...saved, ...common, db: opts.db,
          explorerPath: `/ext/${opts.storeId}?report=${saved.reportId}`, access: "admin" }, null, 2));
      }
    } catch (error) {
      console.error(`import-review: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    }
  });
program.parse();
