# Save a candidate review in the local Explorer

Use when the user asks to save/import this review, with a trusted ExtRay checkout
and local database available. Without that checkout, deliver the portable report
and explain that import was not run. Do not install or run anything from the
untrusted extension directory.

Run from the trusted ExtRay checkout (Node.js 24+, dependencies installed). Supply
the actual harness/model and session ID when available. For a copied skill, pass
its actual directory so the recorded version and hash match the reviewed workflow:

```sh
npm run import-review -- /analysis/candidate.json \
  --source-dir /samples/extension \
  --store-id CHROME_WEB_STORE_ID \
  --harness codex --model ACTUAL_MODEL_ID --session-id ACTUAL_SESSION_ID \
  --skill-dir /installed/extray-review \
  --db /trusted/extray/.out/bakeoff.sqlite --dry-run
```

If validation succeeds and the user requested the save, run the same command
without `--dry-run`. No additional approval step is required by this skill.
Omit the session flag if unavailable; never invent provenance. The review time
defaults to the JSON file's modification time; use `--reviewed-at` to supply a
known ISO timestamp. If a source-tree fingerprint was recorded before analysis,
pass it as `--source-sha256` to reject changes since that snapshot. A fingerprint
taken only at import records current bytes, not proof of which bytes were reviewed.

The CLI validates the candidate JSON and source references, checks the manifest
version, fingerprints the source and skill, and builds static context without
model calls. It then records `methodology=skill:extray-review`, `mode=SKILL_IMPORT`.
Candidate rows have `is_verified=0` and are separate from asserted findings.
The `inconclusive` tier is a compatibility placeholder, not an engine verdict.
Agent-reported coverage and limits remain visible, including incomplete work.

Success prints JSON containing `runId`, `reportId`, and `explorerPath`. Link to
that path in the user's local Explorer and note it needs the Admin view. The
import appears under other analyses for an already-cataloged extension; it does
not replace the configured canonical assessment or appear in the default User
catalog. The direct report link works even when no canonical assessment exists.
Repeated imports with the same content/provenance return the existing record.
Inline source viewing requires the snapshot under the checkout's `example_crxs/`
or `corpus/` tree. Other source paths are recorded but are not served by Explorer.

Exit `2` means the validation, source, configuration, or DB write failed. Report
the error; do not claim the findings were saved. Keep the JSON artifact for retry.
This command does not run independent claim verification, assign an engine risk
tier, or upload anything to a hosted Explorer. Do not use `record-truth` as a shortcut.
