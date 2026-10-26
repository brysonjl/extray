# Bake-off DB

A local SQLite database that collects every analysis run — single-extension
`assess`, corpus `reports`, and scored `scorecard` — into one queryable place, so
methodologies / models / parameters / targets can be **compared with SQL**
instead of by diffing scattered JSON files.

No new dependency: it uses Node's built-in `node:sqlite` (the same engine the
Layer-3 cache uses). The default file is `.out/bakeoff.sqlite` (gitignored).

## Getting data in

**Live (automatic).** `assess`, `reports`, and `scorecard` each record their run
into the DB by default. It is a *secondary* sink: a DB failure warns and is
swallowed, never affecting the report artifacts or the exit code.

```
npm run assess    -- <id-or-url>            # records an 'assess' run
npm run reports   -- --methodology dag      # records a 'reports' run
npm run scorecard -- --methodology agentic  # records a 'scorecard' run
```

Override the path with `--db <path>`; disable with `--no-db`.

All three populate `finding` rows (any arm that emits a structured risk report —
monolith, dag, agentic — does). A `scorecard` run records the scored rollup and
per-sample judged results **and** each sample's full findings, so one scorecard
run gives you both the metrics and the findings; a separate `reports` run is not
required for findings.

**Backfill.** Reconstruct runs from JSON already on disk (auto-classified by
shape). Idempotent — re-running replaces rather than duplicates.

```
npm run ingest                 # scans .out/reports, .out/eval-reports, scorecard*.json, abcid_*
npm run ingest -- <paths...>   # ingest specific files/dirs
npm run ingest -- --reset      # rebuild the DB from scratch
```

## Schema

One row per … (see `src/db/schema.ts` for the full DDL):

| table          | grain |
| -------------- | ----- |
| `run`          | one CLI invocation — every adjustable knob + version stamps + git sha + timestamp |
| `target`       | one extension analyzed within a run (1 for assess, N for corpus) |
| `report`       | the (run × target) risk assessment — verdict tier, summaries, tokens, cost |
| `finding`      | one asserted OR excluded finding (the unit of cross-arm comparison) |
| `usage`        | one per-step token/cost line (label × model) |
| `scorecard`    | corpus-run rollup — coverage A–G/H, tier-recall, unsafe-misses, stability, bellwether |
| `sample_score` | one corpus sample's judged result within a scorecard run |

Hybrid storage: every field you filter/group/rank on is a typed column; the full
source object is also kept in a `*_json` column, so nothing is lost and new
columns can be backfilled later. Each run is keyed by a content hash over its
knobs + provenance, which is what makes ingest idempotent.

## Example bake-off queries

Methodology comparison on the corpus (the headline bake-off):

```sql
SELECT r.methodology, r.model,
       sc.coverage_known_shapes AS cov_AG,
       sc.tier_recall, sc.unsafe_misses, sc.estimated_usd
FROM scorecard sc JOIN run r ON r.id = sc.run_id
ORDER BY cov_AG DESC;
```

Same extension's verdict tier across every config:

```sql
SELECT t.store_id, r.methodology, r.model, rep.tier, rep.num_findings
FROM report rep JOIN run r ON r.id = rep.run_id JOIN target t ON t.id = rep.target_id
WHERE t.store_id = 'abcidfelbbfbijdeilhlgmgejdbappaj'
ORDER BY r.started_at;
```

What one arm catches that another drops, on a given sample:

```sql
SELECT f.category, f.severity, f.title, r.methodology
FROM finding f JOIN report rep ON rep.id = f.report_id
              JOIN run r   ON r.id  = rep.run_id
              JOIN target t ON t.id = rep.target_id
WHERE t.sample = 'mutant-a-exfil-fetch' AND f.is_verified = 1
ORDER BY f.category;
```

Cost by step across runs:

```sql
SELECT r.methodology, u.label, u.model, SUM(u.input_tokens) in_tok,
       SUM(u.output_tokens) out_tok, SUM(u.estimated_usd) usd
FROM usage u JOIN run r ON r.id = u.run_id
GROUP BY r.methodology, u.label, u.model ORDER BY usd DESC;
```

## Dashboard

A read-only local web UI for exploring the DB without writing SQL — the same
bake-off queries above, but filterable and clickable.

```
npm run dashboard                          # serves http://127.0.0.1:8787 against .out/bakeoff.sqlite
npm run dashboard -- --db <path> --port N  # point at another DB / port
```

It opens the DB **read-only**, binds to `127.0.0.1` only, and adds no
dependency (Node's built-in `node:http` + `node:sqlite`; the frontend is
hand-written HTML/CSS/JS that works offline). Five tabs:

- **Performance** — two rollups. An **All assessments** table aggregates EVERY
  run per (methodology × model) — run/report counts, average + total findings,
  verdict-tier distribution, token + cost totals — so plain `assess` and `pi`
  runs are visible, not just scored corpus runs. Below it, the **Scorecard
  metrics** table is the headline corpus comparison: most-recent scored run per
  (methodology × model) with coverage A–G / H, tier-recall, unsafe-misses (red),
  false-alarms, stability, and cost.
- **Runs** — every recorded run, filterable by kind / methodology / model, each
  row showing the analyzed extension (or target count), verdict tier(s), asserted
  finding count + type breakdown, and token/cost totals (summed from `report.*`,
  the authoritative per-target totals). Click a run to list its reports.
- **Extensions** — one row per analyzed extension (by store id, corpus sample,
  or name when neither is recorded) with version, source, the methodologies that
  assessed it, total findings, tiers seen, and when last assessed; search by
  name/id/sample. Click for a detail page: identity, verdict-by-methodology
  matrix, asserted-finding breakdown, and every report across runs.
- **Findings** — every asserted/excluded finding across runs, filterable by
  severity / category / verified / methodology / model; the cross-arm "what did
  X catch that Y missed" view. Click a row to open its report.
- **Report detail** — one report's verdict, summaries, a **permissions** table
  (each declared permission with a layperson description, how this extension
  uses it, Chrome's install-time warning, and a link to the official docs),
  findings, excluded claims, per-step usage, and the rendered report text. The
  permissions table is lifted from the stored structured RiskReport, so it is
  identical regardless of methodology.

Filter and tab state lives in the URL, so a filtered view is linkable. The API
is read-only JSON under `/api/*` (`/api/meta`, `/api/pricing`, `/api/performance`,
`/api/rollup`, `/api/runs`, `/api/extensions`, `/api/extension`, `/api/reports`,
`/api/findings`, `/api/report/:id`); list endpoints cap at 500 rows (raise with
`?limit=`).

**Cost estimates.** The dashboard puts a $ figure next to the token counts it
already has by pricing them at the underlying models' published **per-token API
list pricing** (Ollama Cloud itself bills by subscription / GPU-time, so there is
no per-token Ollama price). The default rate card lives in
`src/llm/model-pricing.ts` (USD per 1M tokens, dated + sourced); it is computed
on the fly from stored tokens, so every existing run is priced without re-running.
Override with `npm run dashboard -- --cost-rates <json|file>` or `$LLM_COST_RATES`
(same `CostRates` shape the `assess` / `scorecard` CLIs accept). Unpriced models
show "—" rather than a guessed $0.
