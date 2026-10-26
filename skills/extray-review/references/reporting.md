# Candidate report contract

This is a host-agent review, not an ExtRay `RiskReport`. Keep
`verification: "not-run"` even after self-review or successful local validation.
The shared ExtRay claim-verifier and verdict engine have not run. Do not use
`record-truth` to import this as verified evidence or authoritative ground truth.
The optional [import workflow](import-review.md) saves it as unverified candidates.

The bundled JSON Schema is the machine contract. Its finding fields and enums
come from ExtRay's `Finding` contract. Each finding needs a unique `id`, a title,
source evidence, and these independent classifications:

- `claim_type`: `observed-capability` for a present API/permission/string without
  a causal claim; `inferred-behavior` for a proposed mechanism. Only the latter
  carries a nonempty `claimed_mechanism`. Neither means runtime observation.
- `severity`: seriousness if true (`critical`, `high`, `medium`, `low`, `info`).
- `confidence`: strength of support (`low`, `medium`, `high`), separate from severity.
- `category`: use the exact enum in the schema for the affected surface.
- `finding_type`: `vulnerability` for a weakness another party can exploit;
  `malicious` for harmful/deceptive design supported by a mechanism; `unwanted`
  for invasive tracking or monetization; `risky-capability` for powerful access
  with a plausible purpose; `benign` for a scoped positive observation; `unknown`
  when the nature is unresolved. Malicious requires `inferred-behavior`.

The shared investigation reference includes ExtRay's specific classification
policy for concealed third-party remote-code loads. Report the disclosure evidence
and privileged loading context; do not convert that policy into a claim about
an unseen payload. If disclosure or ownership is uncertain, retain that uncertainty.

Every evidence reference uses `file` relative to the unpacked root, `location`
as `{ "line": 12 }` (optional 1-based UTF-16 `column`) or `null` for a whole-file observation,
`symbol` as a string or `null`, and `sink_or_string` as an exact source token or
`null`. Cite original lines if you format/decode a copy. For inferred behavior,
include line-level evidence and explain all links in the mechanism in `detail`.

Include exactly one `coverage` entry for each of the five dimensions, with:

- `status: "findings"`: `finding_ids` refers to relevant findings; `checks_run`
  describes the inspection. This records concerns, not exhaustive coverage.
- `status: "cleared"`: empty `finding_ids`, nonempty `checks_run`, and a scoped
  explanation in `note`. Record why material suspicions were dismissed here.
- `status: "inconclusive"`: explain what is missing in `note`; include any partial
  findings and checks. Never treat a skipped dimension as cleared.

Set `investigation: "incomplete"` if any dimension is inconclusive or a relevant
lead/range remains unreviewed. `complete` means this scoped review finished, not
that every possible behavior was discovered. List remote payloads, opaque regions,
missing listing context, truncation, inaccessible files, and other limits in
`limitations`. Include the static-only limitation even for a completed review.

Top-level shape (values below are illustrative, not a finished report):

```json
{
  "schema_version": "1.0",
  "methodology": "extray-review",
  "verification": "not-run",
  "target": { "name": "Name from manifest", "version": "Version from manifest" },
  "evidence_mode": "source-only",
  "investigation": "incomplete",
  "summary": "Describe the main supported concerns and unresolved work.",
  "findings": [],
  "coverage": [],
  "limitations": ["Static source review; the extension and remote payloads were not executed."]
}
```

Populate all five coverage entries; an empty array is invalid. `evidence_mode`
is `source-only` or `source-and-pack`. The validator permits honest incomplete
reports and rejects silent omissions. It does not assign a tier.

The accompanying human review should lead with the supported assessment, then
explain consequential findings with citations, dismissed concerns, and limits.
Say “no harmful behavior found in the reviewed scope” rather than “safe.”
