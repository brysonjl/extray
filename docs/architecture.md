# ExtRay design and implementation

A tool for analyzing unpacked Chrome extensions to surface security risks
and identify potentially malicious behavior. Intended both for end-user
risk summaries ("what does this extension actually do, and is that what
it claims?") and for deeper review by analysts.

## Approach

The analysis is split into two distinct phases with a stable contract
between them:

1. **Static analysis pipeline** — deterministic, language-aware passes
   over the unpacked extension that produce a single structured JSON
   document, the **evidence pack**. No LLM is involved here. See
   [`static-analysis.md`](./static-analysis.md).

2. **Optional LLM analysis** — a methodology consumes the evidence pack,
   investigates source, and proposes findings. Source-grounded claim
   verification checks behavioral claims; a deterministic verdict engine
   produces the **risk report**. The default arm is **pi**; monolith, DAG,
   and the older agentic arm are alternatives. See
   [`analysis-dag.md`](./analysis-dag.md) for the shared node architecture and
   [`risk-report-schema.md`](./risk-report-schema.md) for the output contract.

```
unpacked extension ──▶ [static pipeline] ──▶ evidence-pack.json ──▶ [optional LLM arm] ──▶ risk report
                       (free, offline)                                 (verification + verdict)
```

## Design philosophy

- **Do the boring work statically.** LLMs are bad at re-finding facts
  ("does this extension import jQuery?", "what URLs are referenced?")
  and great at judging structured evidence in context. The static
  pipeline answers every question that can be answered without
  inference, so the DAG never has to.

- **Measured methodologies.** Pi is the default investigation method; the
  monolith offers a cheaper generation-and-verification pass, and the DAG
  offers a fixed set of review nodes. The labeled synthetic corpus measures
  each arm against the same answer keys. Model choice affects correctness.
  Pi's read-only tools are confined to the extension directory and automatic
  context/configuration loading is disabled. Prompt injection remains possible;
  process sandboxing and network egress isolation are not shipped. See [LLM configuration](./configuration.md) for the containment caveat and model guidance.

- **Over-flag with rationale, let the LLM dismiss.** Static heuristics
  should err toward false positives. Each finding carries source
  location and a quoted snippet so an LLM node can quickly judge
  intent rather than re-derive evidence.

- **Snippets, not source dumps.** The evidence pack contains structured
  facts plus the exact code excerpts those facts came from. LLM nodes
  receive snippets; only specialized deep-dive nodes ever read whole
  files. Extensions get huge and most files are uninteresting.

- **Stable schema.** The evidence-pack JSON is a versioned contract.
  Pipeline and DAG evolve independently as long as the schema is
  honored. Schema changes are explicit and bump the version.

## Repository layout

```
docs/                         this directory
src/pipeline/                 deterministic static analysis
src/methodologies/            pi, monolith, DAG, agentic, claim verification
src/report/                   contract, verdict engine, HTML/Markdown renderers
src/scorecard/                labeled-corpus evaluation and report generation
src/server/                   Explorer API
web/explorer/                 Explorer SPA (root npm install includes build dependencies)
corpus/                       synthetic samples, answer keys, committed replay fixtures
example_crxs/                 local fetched extensions (gitignored)
```

The repository uses one root install and lockfile. The Explorer workspace is
an internal build convenience, not a separately published package. Only the
synthetic corpus ships; local real-extension analyses remain gitignored.

## Available components

The project includes the static pipeline, risk reports, four methodology arms,
scorecard, provider adapters, and local Explorer. `scan` produces
a static HTML report without a key. The Explorer can ingest all 11 synthetic
samples from committed monolith fixtures without making live model calls.

The exact baseline evaluation is available as `npm run eval:replay`. Other
model/prompt configurations require their own fixtures; pi investigations are
live-only. See [analysis](./analysis.md) and [evaluation](./evaluation.md) for commands and flags.

See [configuration](./configuration.md) for supported providers and isolation
limits, and [contributing](./contributing.md) for development checks.
