# Building a reference assessment collection

[Back to documentation](./README.md)

A local collection of independent reference assessments lets you compare new
methodologies against the same source and reasoning. It is separate from the
committed synthetic corpus and its grading labels. Reference assessments remain
opinions to check, not proof of an extension's safety or intent.

## Prepare the collection

Choose a target sample count, reviewer configuration, usage budget, and
concurrency limit appropriate to the task. Begin with a small batch. Keep the
worklist, source inventories, reports, and progress under an ignored directory
such as `.out/reference-assessments/`, with a separate database.

Use the committed synthetic samples to exercise the workflow. If you include
third-party extensions, fetch them deliberately with `npm run fetch-crx -- <id>`
and keep their source under ignored `example_crxs/`. Do not execute them. Give
reviewers only the selected extension subtree and permitted sidecars; exclude
answer keys and instructions embedded in untrusted source.

## Review and record

1. Record each input's identifier, source directory, and immutable source hashes.
   Track pending, completed, and failed status in the local worklist.
2. Have an independent reviewer follow the [ground-truth protocol](./ground-truth-protocol.md).
   Save the resulting `RiskReport` under the ignored collection directory.
3. Validate and record the report with `record-truth --strict`, using `--db` to
   select the collection database. For a store package:

   ```bash
   npm run record-truth -- .out/reference-assessments/report.json \
     --store-id <id> --source-dir example_crxs/<id> --strict \
     --db .out/reference-assessments/catalog.sqlite --started-at <fixed-ISO-timestamp>
   ```

   For a synthetic sample, use `--sample`, `--source-dir
   corpus/<sample>/extension`, `--label-kind`, and `--expected-tier` instead of
   `--store-id`. Consult `npm run record-truth -- --help` for accepted values.
4. Correct validation errors before recording. Preserve the rejected attempt and
   its errors; do not invent evidence or silently omit failed inputs.
5. Reconcile completed items against the database, retain usage and source hashes,
   and stop at the selected sample or spending limit. Use the same fixed timestamp
   when replacing the same reference rather than duplicating it.

`--strict` checks report structure and cited evidence. It does not establish
comprehensive coverage, reviewer independence, or truth. Automated analysis arms
can be run separately and compared using the [comparison workflow](./methodology-comparison-loop.md).
Third-party packages and assessments remain private local artifacts; contribute
minimized synthetic regressions and maintained guidance to the public project.
