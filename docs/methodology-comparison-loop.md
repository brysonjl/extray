# Comparing analysis methodologies

[Back to documentation](./README.md)

Compare methodologies on the same source and record an independent reference
assessment. Investigate disagreements in findings and cited mechanisms, alongside
overall tiers. A reference assessment is an opinion to verify against source;
it is not an oracle.

## Prepare a comparison

Start with the committed synthetic corpus and the [offline evaluation](./evaluation.md).
For a new live comparison, choose the samples, methodology/model matrix, provider
settings, and usage limits before making calls. Use a separate database and keep
worklists, reports, and analysis notes under an ignored local directory such as
`.out/comparisons/`. No private worklist or historical result is required.

| Step | Tool |
|---|---|
| Generate reports | `npm run assess -- --dir <source-dir> --methodology <arms> --model <model> --db <database>` |
| Create a reference | [Ground-truth protocol](./ground-truth-protocol.md) |
| Validate and record a reference | `npm run record-truth -- <report.json> --strict ... --db <database>` |
| Compare findings | `npm run compare-arms -- --source-dir <source-dir> --db <database>` |

`assess --dir` may prepare normalized source. Use a working copy when original
package bytes must be preserved, and record which representation each reviewer
received. Keep original inputs and their hashes for reproducibility.

## One iteration

1. Select one input and record its source hash and the intended configuration.
   For corpus samples, give each automated arm and independent reviewer only
   `corpus/<sample>/extension/`. The parent directory contains the answer key;
   do not let an independent reviewer read it before forming an assessment.
2. Run the selected methods and models against the same prepared source. Store
   each run in the comparison database. Live runs send source to the configured
   provider; Pi generation has no committed replay mode.
3. Have an independent reviewer follow the ground-truth protocol and save a
   `RiskReport` under `.out/comparisons/`. Validate it with `record-truth --strict`.
   Use `--store-id` for a store package, or `--sample`, `--label-kind`, and
   `--expected-tier` for a corpus reference. Record the exact `--source-dir` used
   by `assess --dir`, and a fixed `--started-at` when replacing the same reference.
4. Run `compare-arms` against the same database and source directory. For runs
   keyed by store ID, `--store-id` is also available. Inspect finding titles,
   evidence, excluded claims, and incomplete outcomes; a tier alone does not
   explain the disagreement. The comparison selects the latest applicable run
   for each methodology/model combination.
5. Classify each confirmed discrepancy as a false positive, false negative,
   tier error, or inaccurate mechanism. Check the source before deciding whether
   the automated arm or reference is wrong. Record the configuration and evidence
   in an ignored comparison note.
6. Mark the worklist item complete or failed. Preserve failures and usage records
   rather than silently replacing a failed attempt with a later success.

For repeated work, use a bounded queue with explicit stop conditions and a
concurrency limit suitable for the provider and local machine. The workflow does
not require a particular agent scheduler or private planning document.

See the [improvement playbook](./methodology-improvement-playbook.md) for turning
these observations into changes and measuring their effect.
