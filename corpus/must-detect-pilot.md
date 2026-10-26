# `must_detect` Inter-Rater Validation Pilot

The measurements below precede the 2026-10-16 fixture rebranding. Sample-path
references now use `demo-cookie-manager`; those historical numbers are not a
measurement of the new recordings. See [provenance](./PROVENANCE.md).

A gate that runs **before** the corpus is used to grade. It confirms the
`must_detect` behaviors are methodology-neutral and that two independent raters
agree on whether a given analysis output satisfies them. If they don't agree, the
phrasing is ambiguous and must be tightened in the sample's `label.yaml`.

Origin: `docs/plans/2026-05-26-001-feat-labeled-test-corpus-plan.md` (Unit 6).

## Why this gate exists

`must_detect` coverage is the corpus's primary metric. It is only trustworthy if
"was this behavior detected?" has the same answer regardless of who asks. Writing
"plain language" does not guarantee that — phrasings like *"sends data to an
external host"* are ambiguous (does a CDN count? an analytics beacon?). This pilot
forces that ambiguity to surface on a small set before it contaminates the whole
ranking.

## Scope of the pilot

Deliberately includes the **judgment-hardest** labels, not just the clean isolated
ones:

| Sample | Why included |
|--------|--------------|
| `demo-cookie-manager` (benign) | The false-positive trap — raters must agree it is "cleared" (no behavioral high-severity), not penalized for `concerning` permissions. |
| `mutant-a-exfil-fetch` | Simplest true positive — calibration baseline. |
| `mutant-e-crossfile-flow` | Bellwether; behavior spans files, so "detected" is subtle. |
| `mutant-g-stacked-be` | Stacked, multiple `must_detect` entries — tests per-pattern partial vs full credit. |
| `mutant-h-curveball-clipboard` | Out-of-taxonomy; "detected" is hardest to judge here. |

## Procedure

1. Produce analyzer-style output for each piloted sample. In a solo POC, use
   hand-written stand-ins for each methodology, or a single real analyzer pass —
   the pilot validates the *labels*, not any methodology.
2. **Two independent raters** score each `must_detect` entry as satisfied /
   not-satisfied against that output. In a solo context, the second rater may be a
   different person or an LLM-judge dry run used as a second-rater proxy (note which
   was used).
3. Record agreement per entry in the table below.
4. For any disagreement, rewrite the `must_detect` (or benign `must_not_emit`)
   phrasing toward a more observable, less interpretable behavior, and re-score.
5. Repeat until the piloted entries reach agreement.

## Running the harness (Unit 8)

The pilot is implemented as `src/scorecard/pilot.ts` + `scripts/pilot.ts`:

```
npm run pilot -- --model <judge-model> --model2 <second-rater-model> \
                 --second-rater <label> [--record] [--write]
```

It produces a methodology-style output per piloted sample (the monolith), scores
each `must_detect` / `must_not_emit` entry with **two independent raters** (the
LLM-judge and a **model-independent** second rater), runs the judge **calibration
gate** (over-crediting / under-crediting / verbosity-parity), and exits non-zero
on any rater disagreement or calibration failure. `--write` fills the table
below. REPLAY is the default and needs committed fixtures; recording them
requires a dev to plug a provider adapter (`LLM_ADAPTER`) and run once with
`--record` — until then the harness is exercised by `test/scorecard-pilot.test.ts`
(fake-client plumbing). **Honest note:** a passing gate demonstrates inter-rater
agreement + inflation-resistance on a small pilot — not external-ground-truth
validity. Coverage stays provisional until it passes.

## Results

> Filled by `npm run pilot -- --write` once fixtures exist. Until then this is the
> template (the harness emits the same columns).

<!-- PILOT:RESULTS:START -->

Second rater: **different-model-family** (model-independent of the judge).

| Sample | entry | Rater 1 (judge) | Rater 2 | Agree? |
|--------|-------|-----------------|---------|--------|
| demo-cookie-manager | data-exfiltration high-severity | no | no | ✓ |
| demo-cookie-manager | code-execution high-severity | no | no | ✓ |
| mutant-a-exfil-fetch | cookie values are read and sent to an external host not t… | yes | yes | ✓ |
| mutant-e-crossfile-flow | cookies read in one file are staged into chrome.storage a… | yes | yes | ✓ |
| mutant-g-stacked-be | a vendored library file (lib/jquery-3.3.1.min.js) has bee… | yes | yes | ✓ |
| mutant-g-stacked-be | cookies read in one file are staged into chrome.storage a… | yes | yes | ✓ |
| mutant-h-curveball-clipboard | cookie values are exfiltrated through a non-network chann… | yes | yes | ✓ |

Judge calibration: PASS (5/5 cases; verbosity-parity consistent).

**Gate: PASS** — inter-rater agreement + inflation-resistance demonstrated (not external-ground-truth validity; coverage stays provisional).

<!-- PILOT:RESULTS:END -->

## Known ambiguity watch-list (tighten if raters split)

- "external host" — clarify it means a destination **not** tied to the stated
  purpose, so a legitimate CDN/update URL does not count as exfil.
- mutant-H "covert channel" — clarify detection requires naming the *non-network*
  exfil path (clipboard / context-menu), not merely flagging broad permissions.
- stacked mutants — confirm raters score **each** constituent behavior separately
  so partial detection is distinguishable from full.

## Exit criterion

The pilot passes when every piloted `must_detect` / `must_not_emit` entry reaches
rater agreement (after any phrasing revisions). Only then are the corpus labels
considered grading-ready for the bake-off.
