# Agentic Methodology (implementation design)

This is the third **`Methodology` arm**, alongside the monolith
(`src/methodologies/monolith.ts`) and the DAG (`src/methodologies/dag/`). It is
**purely additive**: neither of the other arms is touched. Selected with
`--methodology agentic`.

Where the monolith dumps the whole pack into one generation call and the DAG
runs a fixed gated node graph, the agentic arm runs a **goal-driven investigation
loop**: a single agent that reads the unpacked source tree directly through a set
of read/reason/record tools, working a fixed **checklist of risk dimensions**
until each one ends in either a grounded finding, an explicit dismissal, or an
honest budget-exhausted inconclusive.

## Position in the system

```
                          ┌─ agentic front-end ────────────┐
  evidence pack (map) ───►│ goal-driven tool loop over the  │──┐
  + unpacked tree (fs)    │ unpacked source tree            │  │   shared backend
                          │  → findings + verifier verdicts │  ├─► collectAndAssemble
                          └─────────────────────────────────┘  │     (dag/collect.ts)
                                                                │   → classifyFindings
                                                                │   → computeVerdict
                                                                │   → synthesize
                                                                │   → assembleRiskReport
                                                                └─► renderReportMarkdown
```

The pack is a **starting map, not a cage.** It seeds the agent's orientation
(manifest intent, declared permissions, observed destinations, flagged files,
the file list), but the agent grounds every behavioral claim against the **real
source on disk**, not the lossy pack.

## Locked design decisions (mirror the DAG's invariants)

1. **The deterministic verdict engine owns the tier.** The agent gathers and
   grounds findings; it never sets a tier. The accumulated finding set is handed
   to the exact same backend tail the DAG collector uses
   (`collectAndAssemble` in `dag/collect.ts`): `classifyFindings →
   computeVerdict → synthesize → assembleRiskReport → renderReportMarkdown`. All
   three arms stay scorecard-comparable.

2. **A `verified-behavior` is minted only by an `inferred-behavior` finding +
   a `confirmed` `VerifierVerdict`.** When the agent records an
   inferred-behavior finding, the recorder immediately adjudicates it against
   real source via the shared `verifyClaim` (claim-verifier.ts) — the same
   adversarial, source-grounded reader the monolith and the DAG use. Pack-only /
   observed-capability findings top out at observed-capability.

3. **Untrusted-content envelope on every tool result.** The agent reads
   adversarial extension source in a loop — a prime prompt-injection target.
   Every tool result that re-enters a prompt flows through `buildPrompt` /
   `wrapUntrustedBlock`; tool results are framed as data, never instructions.

4. **Sandbox + label-leak guard.** All file reads route through
   `safeSourcePath(sampleDir, …)` — no `..` traversal, no absolute paths, files
   only. `sampleDir` is fs-only and never enters a prompt (its name is a corpus
   ground-truth hint). `read_pack` strips the same volatile/identity fields the
   monolith strips (`analyzed_at`, `analyzer_version`, `extension.path`,
   `extension.id_from_path`).

5. **Determinism.** `temperature: 0`, every LLM call through the injected
   `LlmClient`, stable `agentic:*` labels. With `RecordReplayClient`, the fixture
   key is a hash of the full request, so the growing transcript yields stable,
   reproducible per-step fixtures.

## The loop

Dimensions (the checklist the agent must resolve):

| dimension | question |
|---|---|
| `exfiltration` | does sensitive data (cookies, storage, identity) leave to a network/external party? |
| `code-execution` | is there remote or dynamic code execution (eval, remote scripts, injected code)? |
| `stated-purpose-deviation` | does the extension do materially more/other than it claims? |
| `permission-justification` | are the requested permissions explained by the stated purpose + usage? |
| `obfuscation` | is first-party code obfuscated/packed in a way that hides behavior? |

Each dimension is investigated by its **own short sub-loop**, and the five
sub-loops **run concurrently** (`Promise.all`) — they are independent, sharing
only a read-only tools instance (whose file-read cache is populated once and
reused). A sub-loop's steps are `label: "agentic:step:<dimension>"`. Each step is
one LLM call given the dimension's question, the orientation map, the tool
catalogue, and a **bounded sliding window** of its own recent observations
(the last `TRANSCRIPT_WINDOW = 6`). It emits ONE action as JSON:

```json
{"thought": "...", "tool": "<name>", "args": { ... }}
```

The sub-loop dispatches the tool, appends a wrapped observation, and repeats. It
closes when the agent records a finding or a dismissal, or when its per-dimension
step budget (`maxStepsPerDimension`) is exhausted — in which case the dimension
is closed as an explicit `inconclusive` dismissal listing the tools that ran
(honest inconclusive, never a silent omission).

**Why this shape.** Resending an expanding transcript at every step increases
input usage as an investigation grows. Per-dimension sub-loops with a bounded
window limit prompt growth, give every dimension a dedicated budget, and let
independent dimensions run concurrently. A bounded loop can still end with
inconclusive dimensions; the trace records that outcome explicitly.

**Determinism.** Findings get a concurrency-safe, dimension-prefixed id at record
time (`agentic:<dimension>:<n>`) that is never rewritten, so a verifier verdict
stays matched to its finding. The five sub-loop results are merged in fixed
dimension order (not completion order), so findings, ids, and the trace are
identical regardless of which sub-loop finishes first.

## Tools (read + reason + record only — no write/network/exec)

| tool | contract | primitive reused |
|---|---|---|
| `list_files` | `{}` → the extension-relative file list | `pack.files[].path` |
| `read_file` | `{path, range?: {start_line, end_line}}` → file (or line window), byte-capped | `safeSourcePath` |
| `grep` | `{pattern, path?}` → up to N `file:line: text` matches over source | `safeSourcePath` |
| `read_pack` | `{path}` → the stripped pack subtree at a dotted JSONPath | local stripper (monolith's STRIPPED set) |
| `record_finding` | `{dimension, finding}` → records a `Finding`; inferred-behavior is verified via `verifyClaim` and the verdict is returned to the agent | `verifyClaim`, `coerceFinding` |
| `record_dismissal` | `{dimension, concern, checks_run, note}` → records a `Dismissal` | — |

Read tools never throw on a bad path: a path outside the sample, a missing file,
or an invalid regex returns `{ok: false, content: "<reason>"}` so the agent can
recover (and so a path-escape attempt is observable in the trace).

## Backend handoff

The agent's accumulated `findings` / `verdicts` / `dismissals` are packed into a
single synthetic `NodeResult` and run through `collectAndAssemble` **verbatim**
(the DAG collector). The verified-behavior vs observed-capability split, the
dedup, the deterministic tier, and the rendered report therefore come out
identical in shape to the other arms. The arm returns a `MethodologyOutput` with
the deterministic `tier` and `structured: AgenticTrace` — the full tool-call
trace, the per-dimension outcome, and the embedded `DagTrace` tail. **The trace
is the answer to "why did the agent look at X."**

## Factory

```ts
createAgentic(model, {
  maxStepsPerDimension?,  // per-dimension tool-call budget (default 8); each of
                          // the 5 dimensions gets its own
  verifierModel?,         // claim-verifier model; defaults to `model`
}): Methodology           // id: "agentic"
```

Wired behind `--methodology agentic` in `scripts/assess.ts`,
`scripts/reports.ts`, and `scripts/scorecard.ts`. The arm emits a native `tier`,
so the judge/normalizer are unchanged. The scorecard additionally gained a
`--concurrency <n>` flag (default 1, sequential) that investigates that many
**samples** in parallel — orthogonal to the per-dimension parallelism inside one
sample; total in-flight LLM calls ≈ `concurrency × 5`, so raise it with provider
rate limits in mind.

## Testing

- **End-to-end** over `mutant-a-exfil-fetch` with a label-keyed `FakeLlmClient`
  driving the loop: the agent discovers the `cookies → fetch →
  collect.evil-analytics-cdn.com` flow at `js/background.js:197`, records it as
  an inferred-behavior finding, `verifyClaim` confirms it (→ verified-behavior),
  the deterministic engine returns `high-risk`, and the tool-call trace is
  captured.
- **Unit**: the loop's stop condition (all-closed vs budget-exhausted →
  inconclusive) and the tool sandbox (path-escape and absolute-path rejection).
