# Analyzing an extension

[Back to documentation](./README.md)

## Static scan

Accept a Chrome Web Store ID, its detail URL, or an unpacked directory:

```bash
npm run scan -- '<chrome-web-store-id>'
npm run scan -- '<chrome-web-store-detail-url>'
npm run scan -- --dir ./some-unpacked-extension
```

IDs and URLs download the package; directory analysis is offline. ExtRay reads
the package without loading the extension into a browser. Static signals describe
access, code patterns, destinations, and data relationships; they are not a verdict.

Default output is `.out/scans/<id>.html` and
`.out/scans/<id>.evidence-pack.json`. For a directory, `<id>` is its basename.
Use explicit paths when scanning several directories with the same basename:

```bash
npm run scan -- --dir ./corpus/mutant-i-png-steganography/extension \
  --html .out/scans/mutant-i.html --out .out/scans/mutant-i.evidence-pack.json
```

The HTML is self-contained. `--html` alone writes only HTML; `--out` alone writes
only JSON. `--force` downloads a fresh copy of a store package. Static scan exit
codes are `0` success, `2` input/fetch error, and `3` analysis/schema error.
Static scans do not add assessments to the Explorer catalog; model assessments
are recorded in its database by default.

## Add a model assessment

Configure an endpoint using [LLM configuration](./configuration.md), then:

```bash
npm run assess -- <id> --methodology monolith        # cheaper arm
npm run assess -- <id> --model glm-5.2:cloud --think high
npm run assess -- <id> --methodology monolith --replay # replay cached LLM calls offline
npm run assess -- --dir ./some-unpacked-extension
```

Default methodology is **`pi`**, which chooses source reads during its investigation.
Alternatives are `monolith` (one generation pass + source-grounded verification),
`dag` (gated specialist checks), and the older `agentic` arm. Comma-separate to run
several against one shared evidence pack. See [methodologies](./methodologies.md).

For replayable arms (monolith, DAG, and agentic), RECORD mode caches LLM
responses in `.cache/assess-llm/`; `--replay` uses that cache without live LLM
calls. Pi generation is live-only and `--replay` with pi is rejected. Exit codes:
`0` ok, `2` config/usage error, `3` static analysis failed,
`4` replay cache miss, `5` provider rate limit, `6` incomplete investigation with
salvaged artifacts. See [analysis outcomes](./analysis-robustness.md).

Results land in `.out/reports/<id>.html` (easiest to read: verdict card,
plain-language summary, then the tables and findings), plus `.md` with a
token/cost accounting table and `.json` with the machine-readable `risk_report`
contract and the full generation/verification trace. The unpacked source it
downloaded stays in `example_crxs/<id>/` so you can check findings against the
actual code. With `--dir`, the source remains at the supplied path and `<id>` is
the directory basename. Use `--out <directory>` to choose a report destination.
Assessment preparation can deminify source files in the supplied tree. Use a
working copy if you need to preserve the original package bytes.

## Commands

| Command | What it does |
|---|---|
| `npm run scan -- <id \| url \| --dir <dir>>` | Static analysis → self-contained HTML report. Free, no key. |
| `npm run assess -- <id \| url \| --dir <dir>>` | Static analysis + an LLM verdict → `.out/reports/<id>.{html,md,json}`. |
| `npm run explorer` | Local web app (Explorer): API on `127.0.0.1:8788` plus the UI dev server on **http://localhost:5173**. |
| `npm run eval -- [options]` | Grade an arm against the labeled corpus → `scorecard.{json,md}`. |

Everything else is a contributor tool: `npm test`, `npm run typecheck`,
`npm run fetch-crx`, `npm run analyze` (dir-only `scan`),
`npm run analyze-corpus`, `npm run reports`, `npm run pilot`,
`npm run validate-corpus`.

## Reading the output

Start with the summary, then read the findings and their cited source. Review
permissions and destinations in the context of the extension's stated purpose.
Check excluded claims, dismissals, and coverage limits before making a decision.
A source-supported mechanism has been checked against code; it has not been
observed running in a browser. A favorable report does not prove safety.

See the [Explorer walkthrough](./explorer.md) for an illustrated example and the
[risk-report schema](./risk-report-schema.md) for the machine-readable contract.
