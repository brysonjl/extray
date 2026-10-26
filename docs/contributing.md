# Contributing and repository contents

[Back to documentation](./README.md)

## Contribute a sample

A new mutant is the ideal first contribution: self-contained, testable, and it
requires no understanding of the rest of the pipeline. The recipe is one base
extension plus exactly one injected pattern plus a `label.yaml` answer key —
see [`corpus/README.md`](../corpus/README.md) and
[grading ground truth](../corpus/grading-ground-truth.md). Injected network destinations must use reserved
names. `npm run validate-corpus` checks labels, sample structure, and injected
destinations, including the encoded strings and PNG payloads used by this corpus.
This static check does not prove the behavior of arbitrary JavaScript. Treat
samples as hostile source to analyze and do not execute them.

`npm test`, `npm run typecheck`, `npm run fixtures:check`, and
`npm run eval:replay -- --no-db` must stay green. Tests must not call remote
services. Global setup rejects unmocked remote `fetch` calls, including caught
errors; local server tests use loopback. CLI subprocess tests also disable local
dotenv loading and live credentials.

The Pi SDK and its `pi-ai` companion are pinned to the same tested version.
The root package manifest temporarily overrides only Pi's Undici dependency
to `^8.12.2`, because Pi 1.4.0 pins an older affected version. Remove that
override when upstream uses a patched version, then rerun the containment,
provider, recovery, and full regression tests. Avoid a forced SDK upgrade
solely to satisfy an audit recommendation without checking these boundaries.

## Not committed, deliberately

- **No real-extension analyses ship, in any form** — no results database, no
  ground-truth reads, or per-extension reports. Model assessments can be
  incomplete or wrong; the public project supplies reproducible synthetic
  examples rather than claims about named third-party extensions. Keep local
  assessments and research notes in ignored output directories.
- `.env` and any credential — only `.env.example` ships.
- Regenerable artifacts: `.out/`, `.cache/`, `evidence-pack.json`,
  `scorecard.{json,md}`, `corpus/*/evidence-pack.json`.
- `example_crxs/` — real extensions you fetched. Tests that need one skip
  cleanly when it is absent.
- What *is* committed: the synthetic corpus and its LLM replay fixtures, so the
  suite and `eval` run offline.

## Code layout

```
src/pipeline/        static analysis (Layers 1–5) → evidence pack
src/scan.ts          the static scan core (no LLM may ever enter this import graph)
src/report/          report contract + JSON / Markdown / self-contained HTML renderers
src/llm/             LlmClient seam, provider presets, model table, record/replay, usage
src/llm/providers/   ollama-cloud.ts (native wire) + openai-compatible.ts (everything else)
src/methodologies/   pi (default) · monolith · dag · agentic, + the shared claim-verifier
src/scorecard/       labels, judge, tier-normalizer, metrics, orchestration, pilot
src/server/ web/     Explorer API (Hono) + SPA (React)
scripts/             the CLIs
corpus/              synthetic labeled corpus + answer keys + replay fixtures
docs/                maintained user, architecture, contributor, and operations guides
```

Design rationale is in [architecture](./architecture.md); publication checks
are in [release preparation](./releasing.md).
