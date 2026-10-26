# Screenshots and example outputs

[Back to documentation](../README.md)

The PNGs in this directory are actual local-app captures from 2026-10-26 at
1440 pixels wide, 100% zoom, and device scale factor 1. The expanded finding uses
a taller capture to keep its fixture context and evidence together. The Explorer
uses an isolated database containing all 11 synthetic samples and their monolith
replay responses. No live model calls, real-extension assessments, API keys, or
personal settings are shown.
Displayed costs describe the recorded analysis, not the cost of replaying it.

All assessment views use the rebranded **ExtRay Demo Cookie Manager** fixtures
and source-matched replay responses. The synthetic marker must remain visible
in those captures. Upstream authorship remains in the [fixture provenance](../../corpus/PROVENANCE.md).

Corpus ingest records assessments without submitting jobs. The catalog queue
preview and dedicated queue view therefore show zero jobs and an empty history.

| File | Size | View / sample |
|---|---|---|
| [explorer-catalog.png](./explorer-catalog.png) | 1440 × 1120 | Current navigation, queue preview, and synthetic catalog |
| [explorer-queue.png](./explorer-queue.png) | 1440 × 1300 | Empty analysis queue, execution snapshot, controls, filters, and history tabs |
| [explorer-detail.png](./explorer-detail.png) | 1440 × 1242 | Summary, signals, and finding headings for `mutant-a-exfil-fetch` |
| [explorer-finding.png](./explorer-finding.png) | 1440 × 1410 | Expanded finding with claimed mechanism, analysis, and source references |
| [static-report.png](./static-report.png) | 1440 × 1060 | Static scan of `mutant-i-png-steganography`, showing hidden PNG bytes |

## Reproduce the Explorer views

From the repo root after `npm install`, start the API with a new database and
settings path in one terminal and the UI in another. These commands assume
ports 8788 and 5173 are free. If using another API port, also change the Vite
proxy target as described in the [Explorer guide](../explorer.md#local-configuration-and-operation).

```bash
# Terminal 1: create fresh, isolated state and skip the project's .env.
mkdir -p .out
capture_dir=$(mktemp -d "$PWD/.out/readme-demo.XXXXXX")
SKIP_DOTENV=1 EXTRAY_SETTINGS_PATH="$capture_dir/settings.json" \
  npm run serve -- --db "$capture_dir/demo.sqlite"

# Terminal 2
npm run dev -w web/explorer
```

1. Use a fresh browser profile at 100% zoom and a 1440-pixel-wide viewport.
   Open http://localhost:5173, select the **admin** lens, and click
   **Ingest the synthetic corpus**. Confirm all 11 samples were ingested.
2. Capture the catalog with its **Analysis queue** preview. Each visible catalog
   row must have the synthetic badge.
3. Open **View full queue** (`/analyses`) and capture the metrics, execution
   snapshot, controls, filters, and empty state. No submission is needed.
4. Open http://localhost:5173/ext/corpus:mutant-a-exfil-fetch and capture the summary.
5. Expand **All cookies exfiltrated to external host** and capture its **Claimed
   mechanism**, **Analysis**, and both **Source references**. Keep the fixture
   notice, severity, and confidence in frame; use the taller viewport above.

Wait for fonts and API responses to finish loading before each capture. Capture
from the top of each page; the screenshots are viewport captures, not full-page
exports. Do not run Discover or submit live analyses for this offline example.

The screenshot shows the finding from the fixture, including its severity and
confidence. Preserve those labels when refreshing captures. Source citations
can be opened where the analyzed tree is available; do not imply a live-browser
observation. The samples deliberately contain malicious patterns and must not
be installed or executed.

## Reproduce the static report

```bash
npm run scan -- --dir ./corpus/mutant-i-png-steganography/extension \
  --html .out/scans/mutant-i.html --out .out/scans/mutant-i.evidence-pack.json
```

Open `.out/scans/mutant-i.html` in a browser. The captured version shows 3 high
and 2 low signals, including **60 appended bytes** after the PNG end marker and
bundled code reading the same image as bytes. It has no verdict and makes no
model calls. The JSON contains the structured evidence for downstream tools.

Generated reports and databases remain gitignored. Only these synthetic example
screenshots are checked in. When fixtures or pipeline behavior change, rerun the
examples and capture the actual output rather than editing findings in an image.
