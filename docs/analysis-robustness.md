# Analysis capacity and incomplete investigations

[Back to documentation](./README.md)

A generated report, a completed investigation, and an accepted final submission are separate facts. Risk-tier disagreement alone establishes none of these failures. Individual verified findings can survive an incomplete investigation; the whole assessment remains provisional.

## Input representation and context capacity

Monolith inventories of at least 1,000 files use `inventory-column-table-v1`. The `files` object contains ordered `columns`, `rows`, and optional per-column `dictionaries`. A dictionary column's cell is a zero-based index; other cells are literal values. Optional `present` bitmaps distinguish missing fields from null (omitted means every cell is present). File order, paths, hashes, references, anomalies, provenance, and additional JSON fields survive reconstruction. The input pack is not mutated. Repeated diagnostics and provenance are dictionary encoded; unique evidence stays literal. Smaller packs retain their historical serialization and fixture keys.

This changes the representation seen by monolith generation on large inventories. Such runs require new generation fixtures and must be labeled with this representation when compared with historical runs. It does not change pi's source tools/orientation or DAG input slices. Cost preflight is an approximate cumulative spending estimate, not a context-fit guarantee.

The native Ollama adapter screens the actual outgoing messages and schema before HTTP/retries. Effective context is the smallest of requested `num_ctx`, an optional deployment ceiling (`modelContextTokens`), and the observed model ceiling where known. The DeepSeek Flash limit is calibrated from a provider rejection, with exact model/tag matching rather than family guesses. Raising `num_ctx` cannot override it.

The adapter reserves completion/reasoning capacity and sends the same reserve as `num_predict`. An explicit request `num_predict` takes precedence over `outputReserve`; otherwise the reserve defaults to the smaller of 32,768 tokens and half the requested context. Configure these limits for a different workload. A refusal raises non-retryable `ContextCapacityError`; `assess` exits 2 with actionable guidance, without sending that request. Earlier steps in a multi-call run may already have spent tokens.

Without an exact tokenizer, the screening estimate is UTF-8 bytes/2 plus 512 framing tokens. This is intentionally more conservative than chars/4 for JSON/hashes/code, but **is neither exact nor a guaranteed upper bound**. Near-capacity requests announce uncertainty. False refusals and underestimates remain possible; `countInputTokens(request)` allows an adapter owner to supply a matching count including framing/schema. Unknown model maxima remain unknown; their requested/deployment ceiling still applies. There is no prompt truncation or automatic model switch. This guard belongs to the native adapter; pi generation still uses its separate SDK connection, 128,000-token registration and SDK compaction/retry behavior. Custom adapters and other providers retain their own policies.

## Bounded pi submission recovery

Normal exploration keeps its existing turn limit. After a turn-limit abort or silent stop with no accepted submission, the same session receives one forced-submission prompt under two additional turns. Only `submit_findings` is active in this phase; execution guards reject stale exploration calls too. Usage covers both prompts, including cached input accounting. A turn-limit abort remains an incomplete investigation even if this salvage submission succeeds.

Coverage checks apply on every submission. Five valid-shaped attempts cannot bypass missing coverage. The completeness reviewer can reopen twice; a further rejection ends with rejected-work salvage rather than a forced acceptance. Critic outages or malformed verdicts cannot establish completed coverage. Schema-invalid calls, which never reach the submit tool's execute function, remain bounded by the separate eight-call ceiling. Rejected payload retention keeps a richer earlier attempt from being erased by a smaller rejected retry. Accepted payloads remain authoritative. No dismissal is invented.

Traces now retain rejection/acceptance events with reasons, critic gap text, tool/schema errors, and monolithic stop/abort reasons. CLI tracing surfaces these transitions. Historical aggregate traces cannot recover omitted critic reasons, tool arguments, or the exact timing of rejection. Equal turn counts are consistent with the common ceiling but do not prove a shared model failure or schema mismatch.

## Completion contract

Report schema 1.3 adds optional `outcome`:

```json
{
  "artifact_generated": true,
  "investigation": "incomplete",
  "final_submission": "not-accepted",
  "reasons": ["turn-ceiling", "Specific completeness-review gap"]
}
```

New pi reports always carry it. Other methods and historical reports may omit it; absence is not evidence of full investigation. Empty `uncovered_dimensions` means only that the submitted/salvaged payload accounts for the five categories. It does not override an aborted or unsubmitted session. Incomplete clean/low-risk pi assessments withhold that assurance as inconclusive; concerning/high-risk findings keep their tier with a prominent provisional notice. Finding classification rules are unchanged.

`assess` writes JSON/Markdown/HTML and usage/database records before emitting the incomplete notice and exit **6**. Multi-method runs continue the remaining requested methods. Batch summaries separate complete entries, incomplete entries with artifacts, and failures; failures retain exit 1 precedence. Successful complete runs retain exit 0. Exit 2 context/config refusal is distinct from exit 6 salvage. Controllers must inspect this contract instead of treating every nonzero exit as an absence of artifacts.

Database storage retains the trace and stores outcome metadata inside the existing report JSON; no migration is needed. When a historical pi trace is imported, outcome facts can be derived without changing the input artifact. Existing database rows are not rewritten. Comparison bundles label incomplete arms and withhold their tier-match comparison. Explorer DTOs expose outcome to both roles, and the detail page separates investigation incompleteness from unparsed-source warnings. JSON, Markdown and HTML preserve useful findings while displaying the provisional notice. Historical unannotated rows need explicit re-import/backfill into a separate database if they need the new metadata.

## Offline verification

Synthetic regressions cover large-inventory reconstruction, context refusal before
fetch/retry, exact-count boundaries, critic reopening at the turn ceiling, recovery
tool confinement, coverage and critic caps, schema errors bypassing execute,
salvage retention, independent completion flags, legacy DB ingestion, report
notices, DTO metadata, comparison metadata, and CLI exit/accounting through the
installed Pi SDK against a loopback model.

```sh
npm run typecheck
npx vitest run test/analysis-context.test.ts test/analysis-outcome.test.ts test/assess-outcome.test.ts test/pi-recovery.test.ts
npm run eval:replay -- --no-db
npm run explorer:build
```

The tests use the committed synthetic corpus and generated temporary inputs.
Remote fetches are blocked by the test setup; local provider stubs use loopback.
The native monolith baseline has committed replay recordings; Pi generation is
live-only. See [evaluation](./evaluation.md) for the exact replay configuration
and the requirements for capturing a new baseline.
