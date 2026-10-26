# DAG Methodology (implementation design)

This is the **implementation** companion to [`analysis-dag.md`](./analysis-dag.md).
That doc describes the conceptual node topology; this one describes how the DAG
is built as a third **`Methodology` arm** alongside the monolith, what code it
reuses, the node/scheduler/collector contracts, the cost model, and the boundary
between the **v1 vertical slice** (built now) and the **full graph** (documented,
built later).

## Position in the system

The DAG is **additive, not a replacement.** The monolith
(`src/methodologies/monolith.ts`) and its claim-verifier validation layer
(`src/methodologies/claim-verifier.ts`) are untouched and remain selectable. The
DAG is a sibling arm behind the same `Methodology` seam
(`src/methodologies/types.ts`), selected with `--methodology dag`. Both run on
the corpus and are graded identically by the scorecard, so the bake-off is
empirical: which front-end has better coverage / false-alarm / cost.

```
                           ┌─ monolith front-end ──────┐
  evidence pack ──┬───────►│ 1 generation call + the   │──┐
                  │        │ claim-verifier post-pass   │  │
                  │        └────────────────────────────┘  │   shared backend
                  │        ┌─ DAG front-end ───────────┐    ├─► classifyFindings
                  └───────►│ gated node graph →         │──┘   → computeVerdict
                           │ collector                  │      → synthesize
                           └────────────────────────────┘      → assembleRiskReport
                                                                → renderReportMarkdown
```

Everything downstream of the finding set is **already methodology-agnostic** and
is reused verbatim:

- `classifyFindings` (`src/report/classify.ts`) — the promotion rule.
- `computeVerdict` (`src/report/verdict.ts`) — the deterministic tier owner.
- `buildPermissions` / `buildDestinations` / `buildObfuscation` /
  `buildDeveloper` / `buildCoverage` (`src/report/build.ts`) — deterministic
  sections from the pack.
- `synthesize` (`src/methodologies/synthesize.ts`) — prose only, narrates the
  decided verdict, cannot change the tier.
- `assembleRiskReport` (`src/report/assemble.ts`) + `renderReportMarkdown`.

## Design decisions (locked)

1. **The deterministic verdict engine owns the tier.** The DAG does **not** have
   an LLM "verdict node." Its synthesizer-equivalent (the *collector*) only
   combines / ranks / dedups findings; `computeVerdict` assigns the tier. This
   preserves the system invariant (no LLM decides the verdict) and keeps all
   three arms scorecard-comparable. `analysis-dag.md`'s `risk-synthesizer` is
   narrowed to this collector role.

2. **Build a vertical slice first, document the full graph.** The slice exercises
   every structural piece (deterministic + LLM nodes, gating, fan-out, targeted
   source reads, collection) on a few node types before scaling to all ~16. The
   full graph below is the checklist for finishing.

3. **Defer the node-output cache store; build the cache *key* now.** Reproducibility
   already comes from the per-LLM-call `RecordReplayClient`. The node contract
   carries `version` + input-hashing from day one so v2 node-caching is a drop-in.

4. **The collector reuses `classifyFindings`.** Nodes emit exactly the pair it
   already consumes — a `Finding` (with `claim_type`) and, for grounded nodes, a
   `VerifierVerdict`. The `verified-behavior` vs `observed-capability` distinction
   then comes out identical to the monolith, with zero divergence risk.

## The reuse seam: nodes converge on `classifyFindings`

`classifyFindings(report: FindingsReport, result: VerificationResult, sampleDir?)`
already encodes the promotion rule:

- `claim_type: "observed-capability"` + grounded → **observed-capability**
  (asserted from pack facts; no causal story, no verification).
- `claim_type: "inferred-behavior"` + verifier `confirmed` + not manifest-only →
  **verified-behavior**.
- `refuted` / `needs-dynamic` / `inconclusive` / `not-verified` /
  `unresolvable-evidence` → **excluded claim** with its reason.

So DAG nodes emit `Finding` + (for grounded nodes) `VerifierVerdict`, and the
collector calls `classifyFindings` verbatim. The capability rule that falls out:

> **A node may mint a `verified-behavior` only if it has
> `sourceAccess: "targeted-reads"` and produces a grounding quote.** Pack-only
> nodes top out at `observed-capability`.

This is the monolith's invariant (a confirmed mechanism must be grounded in real
source) re-expressed as a node-capability constraint. The deep-dive nodes **are**
the validation layer, inlined — instead of a post-pass over claims a separate
generation call happened to produce.

| Node | emits | becomes |
|---|---|---|
| `permission-justification` (pack facts) | `Finding{claim_type:"observed-capability"}` | observed-capability |
| `destination-reviewer` ("suspicious") | `Finding{claim_type:"observed-capability"}` | observed-capability |
| `taint-flow-reviewer` (reads source, confirms) | `Finding{claim_type:"inferred-behavior"}` + `VerifierVerdict{confirmed, grounding, quote}` | **verified-behavior** |
| `taint-flow-reviewer` (reads source, refutes) | same `Finding` + `VerifierVerdict{refuted}` | excluded claim |

## Node contract

```ts
// src/methodologies/dag/node.ts (planned)
interface NodeContext {
  pack: EvidencePack;            // full pack; nodes read only their declared subset
  sampleDir: string;            // fs reads ONLY (label-leak guard); never into a prompt
  upstream: NodeOutputs;        // outputs of declared upstream nodes
  client: LlmClient;
  model: string;
}

interface NodeResult {
  findings: Finding[];                       // claim_type-tagged
  verdicts?: Map<string, VerifierVerdict>;   // keyed by finding id; grounded nodes only
  dismissals?: Dismissal[];                  // "checked, not present" + checks_run
  status: "ok" | "skipped" | "error";
  reason?: string;                           // for skipped/error
  usage: Usage;
}

interface DagNode {
  id: string;
  version: string;                           // part of the (future) cache key
  inputs: { packPaths: string[]; upstream: string[] };
  gate(pack: EvidencePack, upstream: NodeOutputs): boolean;
  kind: "deterministic" | "llm";
  model?: string;                            // tier-appropriate; null for deterministic
  sourceAccess: "none" | "snippets-only" | "targeted-reads";
  run(ctx: NodeContext): Promise<NodeResult>;
  fanOut?(pack: EvidencePack): unknown[];    // optional: one logical unit per item
}
```

Hard requirements inherited from the monolith (non-negotiable, same rationale):

- **Untrusted-content envelope.** Every extension-derived string entering a
  prompt goes through `buildPrompt` / `wrapUntrustedBlock`. Nodes read adversarial
  code; an injection here corrupts the eval.
- **Determinism guard.** Volatile pack fields (`analyzed_at`, `analyzer_version`)
  and identity fields (`extension.path`, `extension.id_from_path`) are stripped
  before they reach any prompt — reuse `serializePackForPrompt` (or a per-node
  slice equivalent). Keeps fixture keys stable.
- **Label-leak guard.** `sampleDir` is for fs reads only and must never enter a
  prompt; sample directory names are ground-truth hints.

## Scheduler

```
src/methodologies/dag/scheduler.ts (planned)
```

- Topological order over `inputs.upstream`. Independent nodes run concurrently.
- A node whose `gate` returns false is recorded `status:"skipped"` (with reason)
  and never invoked.
- A node failure is recorded `status:"error"` (reason) rather than crashing the
  run; the collector surfaces it in coverage so the analyst knows what was not
  evaluated. (Mirrors `analysis-dag.md` "Execution model.")
- Fan-out: a node with `fanOut` produces one logical unit per item. Whether those
  units are issued as separate LLM calls or batched into one is a **physical**
  decision (see cost model) — the logical unit stays the audit/caching boundary.
- The (future) per-node cache is keyed on `(node_id, version, hash(input_subset),
  model_id)`. v1 builds the key, skips the store, and leans on `RecordReplayClient`.

## Collector

```
src/methodologies/dag/collect.ts (planned)
```

1. Gather every node's `findings` into one list; build the `verdicts` map from
   grounded nodes' `VerifierVerdict`s; gather `dismissals`.
2. **Dedup** by `(file, line, mechanism)` — multiple nodes legitimately surface
   the same underlying behavior (a permission node and a taint node pointing at
   the same cookie→network flow). Dedup happens *before* classification so the
   verdict rollup never double-counts. Keep the strongest variant (prefer a
   grounded `inferred-behavior` over a pack-only `observed-capability` for the
   same site).
3. Assemble a `FindingsReport` + `VerificationResult` and call
   `classifyFindings(...)` verbatim.
4. Hand `classified.findings` + the deterministic sections to `computeVerdict`,
   then `synthesize`, `assembleRiskReport`, `renderReportMarkdown` — the exact
   tail of `monolith.run`.

The collector emits a `MethodologyOutput` with `tier: verdict.tier` (native, so
the scorecard grades it directly) and a `structured` DAG trace (every node's
inputs, gate result, output, and usage — this is the audit trail that answers
"why did the DAG look at X").

## Cost model

Cost is a first-class constraint. There are **three distinct "caches"** — only
the third is per-run, and the current provider does not expose it:

1. **Record/replay fixtures** (`RecordReplayClient`, exists) — zero cost in
   eval/CI; a determinism/offline tool, *not* a production lever.
2. **Node-output cache** (v2) — saves tokens **only on re-runs** with unchanged
   inputs (a new *version* of an extension; or editing one node → only it +
   descendants re-run). Saves nothing on a cold first run.
3. **Provider prompt caching / cached input tokens** — the per-run lever (shared
   prompt prefix billed at the cached-read rate). **The Ollama Cloud adapter
   exposes no `cache_control` today**; Anthropic supports it natively. Not
   available on the current provider.

The DAG's real cost levers are **architectural and available now**, independent
of any caching:

- **Gating** — expensive deep-dive nodes fire only when their gate trips. A clean
  extension may fire zero. (The monolith pays its verifier on every inferred
  claim regardless.) Biggest lever.
- **Model tiering** — Tier 0 is free (deterministic); Tier 1 narrow nodes on a
  cheap model; only gated deep-dives use an expensive one. (The monolith runs
  everything on one model.)
- **Slicing** — each node ingests only its pack subset (a permission node sees
  ~one permission + its call sites), not the whole ~21k-token pack the monolith
  dumps into one call.

Two disciplines baked in now to capture caching **when it lands**:

- **Prompt-prefix structure.** Every node prompt is
  `[stable prefix: instructions + shared context]` + `[variable suffix: the item]`.
  When an Anthropic adapter (or Ollama caching) arrives, the prefix is
  cache-eligible for free. Fan-out nodes benefit most.
- **Logical fan-out, physical batching.** Until prompt caching exists, a fan-out
  node batches its items into one physical call (one shared-context ingestion
  instead of N). The logical unit remains the audit/cache boundary, so it flips
  to true per-item fan-out for free once prefix caching is available. Applies to
  `permission-justification` in v1.

## Built nodes vs. full graph

**Built** (all green; cover the closed-world corpus shapes A–G):

| Node | tier | kind | source | role |
|---|---|---|---|---|
| `risk-classifier` | 0 | deterministic | none | gating signal for deep dives |
| `permission-justification` | 1 | llm (cheap) | snippets-only | fan-out (logical) + pack-only `observed-capability` |
| `destination-reviewer` | 1 | llm (cheap) | snippets-only | pack-only `observed-capability` |
| `taint-flow-reviewer` | 2 | llm (deep) | targeted-reads | data-flow deep dive → grounded `verified-behavior` (corpus A) |
| `library-tamper-deep-dive` | 2 | llm (deep) | targeted-reads | a `lib/` file with a network sink → tamper `verified-behavior` (corpus B) |
| `obfuscation-exfil-reviewer` | 2 | llm (deep) | targeted-reads | first-party flagged-obfuscated file w/ a network/cookie sink (corpus C) |
| `externally-connectable-reviewer` | 2 | llm (deep) | targeted-reads | web-exposed `onMessageExternal` handler leaking data (corpus D) |
| `cross-file-flow-reviewer` | 2 | llm (deep) | targeted-reads | storage→external flow + a cookie source → cross-file staging `verified-behavior` (corpus E/G) |
| `finding-challenger` | 2.5 | llm (deep) | targeted-reads | independent adversarial refute pass over every confirmed finding |
| `collector` | 3 | deterministic | none | dedup + `classifyFindings` + verdict handoff |

The five Tier-2 deep dives are structural clones: each builds a deterministic
candidate from a distinct pack signal, then runs it through `verifyClaim` against
real source — the validation layer distributed per node. Gated, so each pays LLM
cost only when its signal is present.

> **Gate reality check (important).** The original `analysis-dag.md` assumed a
> `library-provenance-checker` gating tamper on hash mismatches. On the corpus,
> every `lib/` file is `provenance: {known: false}` — the static pipeline never
> resolves library hashes — so a provenance-hash gate is a no-op. The provenance
> checker is therefore **dropped** in favor of gating `library-tamper-deep-dive`
> directly on a real signal: a vendored file that makes network calls. If/when the
> pipeline gains real provenance resolution, the checker can return as a Tier-0
> node that *refines* this gate.

**Documented, not yet built:**

| Node | tier | gate |
|---|---|---|
| `extension-intent-summarizer` | 1 | always |
| `message-surface-reviewer` | 1 | always |
| `remote-resource-reviewer` | 2 | remote scripts/iframes or inline scripts |
| `anomaly-investigator` | 2 | any `files[].anomalies` |
| `claim-vs-capability-checker` | 3 | always |
| `coverage-gap` | 3 | high opaque/unresolved density → escalation signal |

`coverage-gap` is an addition beyond the original `analysis-dag.md` (an explicit
bridge to a future agentic escalation arm). Adding any of these is "add a registry
entry + wire its inputs"; the collector picks it up automatically.

### The adversarial refute pass — `finding-challenger`

The deep dives each both build AND verify their own candidate, so a confirmation
is effectively self-graded. `finding-challenger` is the independent skeptic: it
depends on every producer (wired via `makeFindingChallenger(PRODUCERS.map(id))`,
so it always runs last), collects every **confirmed inferred-behavior** finding,
and re-examines each against the real source with a **distinct, refutation-focused
prompt and label** (`dag:finding-challenger`). The distinct prompt is essential —
replaying the identical `verify:claim` request (temperature 0) would just return
the same "confirmed" fixture and challenge nothing.

It emits a `VerifierVerdict` per challenged claim. The collector merges verdicts
with **refutation precedence**: only an explicit `refuted` from any node vetoes a
prior `confirmed` (the finding is then excluded); a challenger `inconclusive` /
`needs-dynamic` / `confirmed` leaves the finding standing — *a finding that
survives a pass built to kill it is upheld*. So the challenger can only ever
**subtract** a confirmation it can actively disprove; it can never invent one.
This is the validation layer's adversarial skepticism re-applied as an independent
second opinion, not a self-grade.

Check the challenger with both confirmed synthetic mechanisms and minimized
examples of unsupported claims. Its conservative refutation policy must preserve
source-supported findings while removing overclaims. A new DAG recording pass is
required to evaluate changed prompts; the committed public replay baseline is
monolith, not a full DAG scorecard.

### Cross-file storage-staged exfiltration (corpus E/G) — `cross-file-flow-reviewer`

Corpus E/G stage cookies into `chrome.storage` in one file and exfiltrate them
from another. The static pack captures only the **storage→network half** as a
`data_flow` (e.g. `common-utils.js` storage→`telemetry-sync.invalid`); the
**cookie→storage staging write is invisible to Layer 3** — it goes through an
*imported wrapper* (`storage.set('_sync_cache', cookies)`, where `storage` is
imported from another module), so it matches no `chrome.storage.*` sink and
produces no `data_flow`.

**Why source review is needed.** Joining a `cookie→storage[key]` write with a
`storage[key]→network` read into one static `data_flow` would require import/alias
resolution in Layer 3 when the write goes through an imported wrapper. The DAG
node reviews the relevant source across files without changing the shared
evidence-pack contract.

**Reviewer behavior.** `cross-file-flow-reviewer` gates on a reliably-present
signal — a `storage`→non-first-party `data_flow` **and** a cookie-source sink
somewhere — then feeds the verifier the *whole* cookie-source file(s) **and** the
storage→network file (the corpus files are well under the verifier's whole-file
threshold). The LLM confirms the staged flow by matching the shared storage key
(`'_sync_cache'`) across files. This plays to the verifier's strength (reasoning
over real source) instead of brittle static alias resolution, and its
"default to refuted" skepticism requires support for the mechanism: a benign
settings-sync that never stages cookies is refuted. The finding is grounded at
the **cookie** source (not the network sink) so its source site stays distinct
from `taint-flow-reviewer`'s storage finding — no dedup collision.

**Known fragility (follow-up).** Candidate evidence_refs are capped at the
verifier's 4-window limit, filled as `[first cookie source, storage→network sink,
up to 2 more cookie-source files]` in pack order. If an extension has >3
cookie-source files and the actual staging file sorts past the cap, its window is
not shown and the verifier may not confirm. A ranking pass (prefer cookie-source
files that also touch storage) would harden this; deferred until a corpus sample
exercises it.

## Wiring

The `createDag(model)` factory (`src/methodologies/dag/index.ts`, `id: "dag"`) is
wired into `makeMethodology` in the three CLI entry points, returned for
`--methodology dag`:

- `scripts/assess.ts`
- `scripts/reports.ts`
- `scripts/scorecard.ts`

No scorecard/judge/normalizer changes: the DAG emits a native `tier`, so it is
graded on the same path as the monolith. (`scripts/pilot.ts` is a
monolith-specific bake-off harness and is intentionally left alone.)

## Testing

- **Deterministic nodes / scheduler / collector**: unit tests with hand-built
  packs (no LLM). Gate logic, topological order, skipped/error handling, dedup,
  and the `classifyFindings` handoff are all pure.
- **LLM nodes**: deterministic unit tests use injected client responses. A live
  DAG evaluation needs its own genuinely recorded fixtures; the committed public
  baseline is monolith. Each node's `label` namespaces recordings (e.g.
  `dag:permission-justification`, `dag:taint-flow-reviewer`).
- **Parity**: run `--methodology dag` over the corpus and compare the scorecard
  to `monolith` — coverage, false alarms, tier recall, and per-arm token cost.

## Adding a node

1. If the check is a static rule, add it to the static pipeline and emit a pack
   field (bump `schema_version`); a node may then reason about it.
2. If it needs judgment, add a `DagNode` to the registry: pick its tier, gate,
   pack-subset inputs, model, and `sourceAccess`. A node that confirms a mechanism
   against source emits `inferred-behavior` + a `VerifierVerdict`; a pack-only
   node emits `observed-capability`. Wire its `inputs.upstream`. The collector and
   verdict engine require no changes.
</content>
</invoke>
