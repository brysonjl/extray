# ExtRay documentation

Start with the [project README and Quick Start](../README.md#quick-start).
These guides cover the details after your first scan.

## User guides

| Guide | What you will find |
|---|---|
| [Analysis](./analysis.md) | Inputs, CLI commands, output paths, replay, and reading reports |
| [Methodologies](./methodologies.md) | Monolith, DAG, pi, verification, and their tradeoffs |
| [Portable skill](./portable-skill.md) | Use ExtRay's review workflow in Codex, Claude Code, or another coding harness |
| [LLM configuration](./configuration.md) | Providers, model observations, settings, costs, and pi containment |
| [Explorer](./explorer.md) | Illustrated catalog-to-finding walkthrough and live submissions |
| [Evaluation](./evaluation.md) | Offline baseline, live recording, judge calibration, and scorecards |
| [Contributing](./contributing.md) | Synthetic sample recipe, checks, and repository contents |
| [Operations](./operations.md) | Local hosting, authentication, batch running, and optional cloud deployment |
| [Cloudflare hosting](./hosting.md) | Private deployment configuration, access control, and CI deployment |
| [Release preparation](./releasing.md) | Build and verify a public snapshot without private history or artifacts |
| [Screenshots and examples](./assets/README.md) | Capture provenance and steps to reproduce the examples |

## Architecture and contracts

- [Architecture and design philosophy](./architecture.md)
- [Static analysis pipeline](./static-analysis.md)
- [Risk-report schema](./risk-report-schema.md)
- [Conceptual analysis graph](./analysis-dag.md) and [DAG implementation](./dag-methodology.md)
- [Agentic investigation design](./agentic-methodology.md)
- [Bounded source access](./large-bundle-access.md) and [analysis outcomes](./analysis-robustness.md)
- [Bake-off database](./bakeoff-db.md)

## Evaluation and development workflows

- [Corpus and answer keys](../corpus/README.md)
- [Ground-truth protocol](./ground-truth-protocol.md)
- [Methodology comparison loop](./methodology-comparison-loop.md)
- [Methodology improvement playbook](./methodology-improvement-playbook.md)
- [Corpus build loop](./corpus-build-loop.md)

The public snapshot includes maintained guides and architecture references.
Historical planning, private experiment notes, and real-extension assessments
are kept outside that snapshot.
