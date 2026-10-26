# Corpus Grading Ground Truth

This document is the contract between the labeled test corpus and the two tools
that consume it — the architecture bake-off (idea #2) and the eval scorecard
(idea #4). It defines the label fields, the metrics, the fairness rules, and the
non-gating interpretation guide. It is **not** itself a scorer.

Origin: `docs/plans/2026-05-26-001-feat-labeled-test-corpus-plan.md`.

> **POC posture.** This corpus is for *learning and architecture selection*, not
> production validation. The output is a comparative ranking with a non-gating
> interpretation guide — there is no hard pass/fail gate (R10).

## Corpus contents

| Sample | kind | pattern | tier | bellwether |
|--------|------|---------|------|------------|
| `demo-cookie-manager` | benign | — | concerning | — |
| `mutant-a-exfil-fetch` | malicious | A exfil via fetch | high-risk | no |
| `mutant-b-tampered-lib` | malicious | B tampered jQuery | high-risk | **yes** |
| `mutant-c-obfuscated-decoder` | malicious | C obfuscated decoder | high-risk | no |
| `mutant-d-wide-externally-connectable` | malicious | D wide externally_connectable | high-risk | no |
| `mutant-e-crossfile-flow` | malicious | E cross-file flow | high-risk | **yes** |
| `mutant-f-stacked-acd` | malicious | F = A+C+D | high-risk | no |
| `mutant-g-stacked-be` | malicious | G = B+E | high-risk | **yes** |
| `mutant-h-curveball-clipboard` | malicious | H out-of-taxonomy | concerning | no (generalization probe) |
| `mutant-i-png-steganography` | malicious | I binary-asset abuse | high-risk | no |
| `mutant-j-png-stego-obfuscated` | malicious | J = I + obfuscated decoder | high-risk | no |

`base/` is a symlink alias of `demo-cookie-manager` used as the mutation source; it is
**excluded** from the sample set. All `extension/` trees have
`_metadata/verified_contents.json` stripped (see Fairness rules).

## Label contract (`<sample>/label.yaml`)

| Field | Applies to | Meaning |
|-------|-----------|---------|
| `sample_id` | all | must equal the directory name |
| `kind` | all | `benign` \| `malicious` |
| `base_ref` | all | source sample for mutants; `null` otherwise |
| `injected_pattern_id` | malicious | one of `A`–`H`; `null` for benign |
| `expected_tier` | all | ground-truth risk, from the risk-report verdict enum (`clean` \| `low-risk` \| `concerning` \| `high-risk` \| `inconclusive`) |
| `is_bellwether` | all | `true` for B, E, G — drives the no-build signal |
| `is_generalization_probe` | H only | `true` — reported prominently though non-bellwether |
| `source` | all | `{id, version}` provenance |
| `must_detect` | malicious | methodology-neutral observable behaviors (no node names / rule_ids) |
| `cleared` | benign | `true` = analyzer must emit no behavioral high-severity finding |
| `must_not_emit` | benign | finding classes that, if emitted, count as a false alarm |

`expected_tier` is **ground-truth risk, not expected detectability.** Mutant E is
`high-risk` even though it exploits a documented static blind spot; that is the
point — recall and false-dismissal then measure which arm overcomes it.

## Metrics (computed by the scorecard, per methodology)

1. **`must_detect` coverage — PRIMARY.** Fraction of a sample's `must_detect`
   behaviors the methodology surfaced, judged by LLM-judge match (see below).
   This is the headline detection metric.
2. **Tier-recall — SECONDARY, insufficient alone.** Fraction of malicious samples
   the methodology rated at `expected_tier` (or higher). Reported but *subordinate*
   to coverage: every mutant inherits the base's `cookies + <all_urls>` high-risk
   surface, so an arm that blanket-rates everything high-risk scores perfect recall
   while detecting nothing specific. Recall without coverage is not detection.
3. **False-alarm — per-sample boolean, not a rate.** For each benign sample,
   `cleared` iff the methodology emits none of its `must_not_emit` finding classes.
   With so few benign samples a "rate" is meaningless; report per-sample pass/fail.
4. **False-dismissal.** A malicious sample receiving a confident `clean`/`low-risk`
   verdict. This is the riskiest-assumption test (it means the analyzer actively
   hides a real attack); report it as its own count, not folded into recall.
5. **Run-to-run stability.** Variance of the *structured* findings (verdict tier,
   detected behavior set) across N repeated runs on the same sample. Prose may vary;
   structure should not.
6. **Cost.** Tokens / wall-clock per sample per methodology.

### LLM-judge match (assumed grading mechanism)

A `must_detect` behavior is "covered" if a judge prompt, given the behavior string
and the methodology's free-form output, confirms the output asserts that behavior.
`must_detect` strings are therefore authored as observable-behavior claims, not
keyword bait. The judge implementation belongs to the scorecard (#4); this corpus
only commits to authoring strings gradeable under it. The phrasings are validated
for inter-rater agreement in `corpus/must-detect-pilot.md` before grading.

## Fairness rules (so the 3-way bake-off is meaningful)

- **Tier normalization is required and must be neutral.** The verdict-tier enum is
  the DAG's native severity rollup; the agentic raw-source pass and the monolith
  emit free-form output. Before scoring tier-recall, each methodology's raw output
  must be normalized to a tier by a documented mapping that does **not** advantage
  the DAG's output shape. This normalization is owned by the scorecard (#4); flag it
  as the top fairness risk. (If a neutral mapping proves hard, prefer dropping
  tier-recall and ranking on `must_detect` coverage alone.)
- **Discount signature-only verdicts.** `_metadata/verified_contents.json` is
  stripped from every tree precisely so no arm can score by detecting a signed-hash
  mismatch it never reasoned about. If any arm reintroduces such a check, a verdict
  derived solely from a `verified_contents` mismatch must be discounted.
- **No rule_id / node-name labels.** `must_detect` is behavior-only so no arm is
  graded on another arm's internal vocabulary.

## No-build signal (concrete, non-gating)

The ranking has a failing branch even without a hard gate:

> **If all three methodologies completely miss either bellwether behavior — B
> (tampered library) or E (cross-file flow), whether in the isolated mutant or in
> stacked G — record an explicit BUILD/NO-BUILD flag.** A static-evidence + LLM
> approach that cannot surface a tampered dependency or a cross-file exfil chain in
> *any* architecture is weak evidence for proceeding.

This is guidance for the decision-maker, not an automatic gate.

## Generalization probe

Mutant **H** is out-of-taxonomy (clipboard + contextMenus covert channel; no
network sink). Report H detection **prominently** even though H is non-bellwether:
it is the only signal of whether an arm generalizes beyond the threat patterns the
designers already anticipated. A strong score on A–G with a miss on H means the
bake-off measured closed-world recall, not open-world detection.

## Interpretation guide — residual validity

Read the ranking with these limits stated up front:

- **Closed-world.** Patterns A–E mirror the signals `docs/static-analysis.md` was
  designed to surface. A high ranking proves detection of *designer-anticipated*
  injections; H is the only counter-probe and it is a single sample.
- **Correlated samples (N=1 base).** Every mutant is the same base plus one (or a
  few) diffs, sharing identical permissions, libraries, and intent strings. The
  samples are not independent trials; treat the ranking as **directional**, not
  statistically conclusive.
- **Synthetic.** These are hand-authored injections, not real-world malware. They
  may carry "obviously inserted" tells that real adversarial code would hide. A
  strong ranking does not generalize to real-world obfuscation.
- **Grading dependency.** `must_detect` coverage depends on the LLM-judge mechanism
  (#4); until that exists and is shown stable, coverage numbers are provisional.

The corpus's honest claim: it can show whether a methodology detects known attack
shapes cheaply and which architecture does so best — not that the winner is
production-ready.
