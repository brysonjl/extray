# Synthetic corpus

Eleven labeled **ExtRay Demo Cookie Manager** fixtures used to test and grade
analyzers: one benign control and ten deliberately modified variants. All share
a fictional demo identity and version. **Findings concern these fixtures only;
they are not assessments of any published extension.**

The fixture code is derived from an upstream cookie manager, rather than written
entirely from scratch. Original authorship, version, and licensing are documented
in [PROVENANCE.md](./PROVENANCE.md). The planted harmful behaviors are our changes.

> ## WARNING — do not load these into a browser
>
> The `mutant-*` samples are **intentionally malicious synthetic code**. Each one
> has a deliberately injected harmful pattern (data exfiltration, a tampered
> library, an obfuscated decoder, an over-broad `externally_connectable`, a
> binary-asset payload, ...). They are shipped **unpacked** in `extension/`
> directories and are therefore trivially loadable via "Load unpacked" in
> `chrome://extensions`. **Do not do that.** They exist only to be read by
> analyzers.
>
> Injected destinations use reserved `.invalid` names. `npm run validate-corpus`
> checks new destinations against each mutant’s benign base, including base64
> strings and the payload appended to PNG assets. These remain malicious
> samples: reserved destinations do not make their other behavior safe.

## What is here

| Sample | Kind | Injected pattern |
|---|---|---|
| `demo-cookie-manager` | benign control | none (broad permissions, benign behavior: the false-positive trap) |
| `mutant-a-exfil-fetch` | malicious | A — exfiltration via `fetch` |
| `mutant-b-tampered-lib` | malicious | B — tampered vendored jQuery (bellwether) |
| `mutant-c-obfuscated-decoder` | malicious | C — obfuscated decoder |
| `mutant-d-wide-externally-connectable` | malicious | D — wide `externally_connectable` |
| `mutant-e-crossfile-flow` | malicious | E — cross-file data flow (bellwether) |
| `mutant-f-stacked-acd` | malicious | F = A + C + D |
| `mutant-g-stacked-be` | malicious | G = B + E (bellwether) |
| `mutant-h-curveball-clipboard` | malicious | H — out-of-taxonomy generalization probe |
| `mutant-i-png-steganography` | malicious | I — payload hidden in a PNG |
| `mutant-j-png-stego-obfuscated` | malicious | J = I + obfuscated decoder |

`base/` is a symlink alias of `demo-cookie-manager`, the mutation source; it is
not counted as a sample. Shared rebranding changes apply to the control and all
variants. Each mutant adds **exactly one** injected pattern to that control
(stacked mutants combine patterns). All manifests use the same neutral name,
description, and version, so their identities do not reveal the expected answer.

Each sample directory has:

- `extension/` — the unpacked extension tree (the scan target).
- `label.yaml` — the answer key: `expected_tier`, `must_detect` (methodology-neutral
  observable behaviors), `is_bellwether`, and for the benign base `cleared` /
  `must_not_emit`.
- `extension.fixture.json` — presentation context for standalone reports,
  outside the analyzed source tree and excluded from investigator prompts.
- `evidence-pack.json` — regenerable static-analysis output (gitignored).

`fixtures/llm/` holds recorded LLM responses so `npm run eval` can replay offline
(for one exact config only; see the root README).

The label contract, metrics and fairness rules are in
[`grading-ground-truth.md`](./grading-ground-truth.md); the inter-rater pilot is in
[`must-detect-pilot.md`](./must-detect-pilot.md).

## Adding a mutant

One base + exactly one injected pattern + a `label.yaml` and an
`extension.fixture.json`. Retain the neutral family identity; describe the attack
in the answer key, not the manifest. Every injected network
destination must use a reserved name. Run `npm run validate-corpus` for label
and structure checks and injected-destination enforcement. New hosts must end
in `.invalid`, `.example`, or `.test`. Unchanged upstream destinations are
allowed only in unchanged source lines from the corresponding base file. The static check covers literal URLs, bare string hosts, escaped strings,
base64 strings (including split URL components), and `CFG1` PNG payloads; a
new concealment technique must extend the validator and regression tests.

## Licensing

The ExtRay source is Apache-2.0, but **the vendored third-party code inside
`corpus/*/extension/` is not part of that grant.** It keeps its own licenses and
is opaque scan-target data:

- EditThisCookie is **GPLv3** (see the `License.txt` / `GNU_GPL_V3.txt` shipped
  with each copy).
- Vendored libraries (jQuery, jQuery UI, tablesorter, jQuery Jeditable: MIT/BSD;
  Font Awesome Free: MIT / CC BY 4.0 / SIL OFL 1.1; Open Sans: Apache-2.0)
  keep their upstream terms.

See [`NOTICE`](../NOTICE) and [fixture provenance](./PROVENANCE.md) for upstream
attribution, modification notices, and the inherited package-metadata discrepancy.
