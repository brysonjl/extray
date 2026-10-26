# Recorded model responses

`llm/` contains the genuine responses used by the one supported offline
baseline: monolith on `glm-5.2:cloud`, `think=high`, claim verification on
`gpt-oss:120b`, and grading on `minimax-m3.1-flash:cloud`. These responses describe the
current synthetic corpus. They are test data, not assessments of published
extensions. Other models and methodologies require their own recordings.

The MiniMax judge was selected on 2026-10-26 and belongs to a different model
family from the generator and claim verifier. That separation does not establish
grading accuracy: this small synthetic baseline is not an independent human
validation study or a model-quality ranking. Scores are reproducible outputs
of this configuration. See [evaluation](../../docs/evaluation.md).

## What validation establishes

Run `npm run fixtures:check`. It never loads credentials or constructs a model
provider. It performs the full 11-sample generation, verification, synthesis,
and grading replay, checks every stored request's full SHA-256 and filename,
rejects likely credential literals, and requires every published recording to
be reached by that exact replay. Missing completions fail rather than fall
back to a live call.

`manifest.json` records a digest of every sample's source tree, hashes of its
labels and context sidecars, and the byte hash, request hash, and consuming
samples for each response file. This detects changed source and edited
responses; hashes establish consistency, not proof of who produced a response.
Historical recordings did not store a provider-signed receipt.

`recording-receipts.json` contains unsigned capture receipts for the new judge
batch: provider endpoint, timestamps, output cap, actual usage, and hashes of
each saved request and response file. Validation checks these against the
recordings. The batch used 67,047 input and 5,808 output tokens, with no retries
and a 2,048-token output cap per call.

The 2026-10-26 cleanup preserved the 54 reachable generation, verification,
and synthesis recordings byte-for-byte. It removed unused older recordings
and the excluded real-extension golden test and its recordings from the
published set. Removed files were archived privately. The 17 grading responses
were captured from the selected judge against the current rendered reports;
no old response was relabeled or rewritten to represent a different request.

## Refreshing the baseline

1. Freeze source, labels, prompts, report rendering, and model settings.
2. Run the offline validator first. Inspect missing requests; capture only
   the genuinely missing responses through the chosen provider. Source and
   reports are sent to that provider, and calls can incur charges.
3. Review response quality, provenance, and possible credentials. Archive
   recordings no longer reached by the supported baseline outside the public
   tree; never change old response text to match new source or hashes.
4. Run `node --import tsx scripts/validate-llm-fixtures.ts --write-manifest`
   after reviewing those changes. This regenerates provenance only if the
   complete offline replay and content checks pass. Review the manifest diff.
5. Run `npm run fixtures:check` and `npm run eval:replay -- --no-db` from the
   final release tree. Commit the recordings and manifest together.

Keep experiments, real-extension recordings, and provider credentials outside
this directory. A passing regex scan alone does not make an arbitrary recording
safe to publish; reachability from the synthetic baseline is also required.
