# Methodology improvement playbook

[Back to documentation](./README.md)

Use this workflow to improve monolith, DAG, or Pi while keeping measurements
comparable. The [comparison guide](./methodology-comparison-loop.md) describes
how to collect reports and independent reference assessments.

## Establish a baseline

Begin with `npm run fixtures:check` and `npm run eval:replay -- --no-db`. Those
commands exercise the committed synthetic baseline without provider credentials.
A change to a prompt, source representation, model, or generation parameters may
require genuinely new recordings; do not relabel existing responses to make a
changed request appear replayable.

For live evaluation, choose a small set of samples that exercises the suspected
failure and the behavior that must remain intact. Include benign inputs when
measuring false positives and labeled mutants when measuring missed mechanisms.
Choose models, methods, limits, and comparison criteria before spending tokens.
Record the exact source and configuration in ignored local artifacts.

## Diagnose a discrepancy

Compare individual findings with source-grounded reference assessments. Separate:

- a false positive from a capability that is correctly reported as unconfirmed;
- a missed mechanism from a source-access or context-capacity limitation;
- an incorrect verdict from an incomplete or rejected investigation;
- a methodology defect from a provider/model/configuration difference.

Give independent reviewers only the extension subtree, without corpus answer
keys. Cross-check their reference against the label afterward. Neither the
reference opinion nor the automated judge can establish correctness by itself.

## Change and measure

1. Preserve a baseline report, configuration, source hashes, and a concise
   description of the failure under `.out/comparisons/` or another ignored path.
2. Locate the code, prompt, gate, or reporting rule responsible. Add a minimized
   synthetic regression that captures the behavior, including any nearby behavior
   that must continue to work.
3. Make the focused change and run its tests plus the relevant corpus checks.
   If an LLM request changes, capture new responses through the configured
   provider only after reviewing the inputs and expected usage.
4. Compare the changed result with the baseline using the same source and
   reference. Count corrected false positives and missed mechanisms, inspect
   evidence quality, and record usage and incomplete outcomes. A lower finding
   count alone does not demonstrate an improvement.
5. Retain the minimized synthetic test and maintained design explanation in the
   repository. Keep third-party extension packages, assessment reports, private
   worklists, and per-extension research notes outside the public export.

## Example: destination classification

A destination string can identify a first-party service, CDN, documentation URL,
namespace, or an actual network recipient. If a reviewer reports every unknown
string as exfiltration, a useful regression supplies synthetic examples of these
roles and checks their evidence and classification. Preserve a separate example
with a demonstrated sensitive-data flow so that reducing noise cannot conceal
that mechanism. The test should validate behavior, not a historical result count.

## Repeat deliberately

Use a varied set of inputs and record the limits of each comparison. A result on
one sample or model does not establish general accuracy. For additional reference
assessments, use the [reference corpus workflow](./corpus-build-loop.md); for the
public replay contract, use [evaluation](./evaluation.md).
