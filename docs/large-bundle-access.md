# Bounded source access for Pi investigations

[Back to documentation](./README.md)

Pi's confined source tools stream UTF-8 text through 16 KiB buffers, so reading a small section of a large bundle does not require loading the whole file. A read exposes at most 40 KiB of source and supplies an exclusive end coordinate and a continuation. It accepts a 1-based line `offset`, a 1-based UTF-16 `column`, or a zero-based UTF-8 `byteOffset`. A byte offset inside a code point advances to the next boundary; a column inside a surrogate pair advances past the pair. Coordinates always refer to the file on disk, including normalized source when that is the investigation root. They do not claim to map normalized code back to the original package.

Small text files retain plain text results; image reads retain the SDK's attachment/resizing support and the existing 5 MiB image limit. Source paths are checked before opening, all source symlink components are rejected, the final open uses `O_NOFOLLOW`, and descriptor identity is checked against the validated path. No source code, shell command, ambient extension instructions, or configuration is executed. The existing independent session containment audit remains in place.

## Design choices

Increasing the whole-file limit would retain unbounded allocation and still fail on huge single lines. A persistent text index would add build cost, invalidation, and artifact management before the first useful read. Streaming offers immediate access and bounded allocations. A bounded in-memory cache of 1,024 trusted position checkpoints speeds repeated reads and continuations; checkpoints are invalidated by file identity, size, mtime, and ctime. No sidecar files are written. A cold late-file read scans its prefix to calculate accurate coordinates. If that exceeds the scan budget, it reports partial progress and retains a checkpoint; repeating the original request can advance from there.

Literal grep streams all text, including minified lines, using overlapping bounded windows. It returns the first match per ordinary line or long-line window, with an excerpt around the hit, actual match coordinates, and a `read` location. Ordinary line context, literal/regex mode, case handling, path globs, and match limits remain supported. Context on very long lines is measured in bounded fragments; repeated hits inside one window are not enumerated.

Arbitrary JavaScript regexes cannot safely be evaluated on truncated windows without changing anchor, lookaround, and quantifier semantics. Regex grep therefore assembles complete lines up to 64 KiB (including the newline), runs batches in an isolated worker, and explicitly skips longer lines. Those searches are **partial**, even if other files were searched successfully. The response identifies the file and line and recommends literal search. Regexes are never evaluated on a fabricated long-line prefix. A worker timeout terminates regex processing without blocking the agent's event loop.

## Limits and status

| Resource | Limit |
| --- | --- |
| Text IO buffer | 16 KiB |
| Source excerpt per read / grep output content | 40 KiB |
| Total rendered tool text | 50 KiB |
| Default read line limit / maximum explicit line limit | 2,000 / 20,000 |
| Bytes read per call, including navigation | 64 MiB |
| Cooperative wall time per call | 10 seconds |
| Regex batch execution timeout | 500 ms |
| Regex worker old-generation heap / stack | 32 MiB / 2 MiB |
| Regex line size / pattern size | 64 KiB / 1,024 UTF-8 bytes |
| Traversal entries / maximum matches | 20,000 / 20,000 |
| Default matches / maximum context | 100 / 20 lines or long-line fragments |
| Audit events per session | 256; omitted events counted |
| Coverage summary for a critic or each synthesis shard | 24 KiB of events; omissions counted |

These are execution bounds, not guarantees of investigation completeness. Regex timeout can add up to one batch to the cooperative deadline. Filesystem operations remain subject to OS latency. Search does not support multiline patterns. Binary NULs, invalid UTF-8, unsafe paths, and unreadable entries are reported as skips, rather than silently treated as clean text. A stopped recursive scan must be retried with narrower paths; its continuation is a **read location**, not a token that resumes the whole recursive grep.

Every search returns `complete`, `partial`, or `cancelled`, with separate output-truncation, match-count, skip-count, and reason fields. Skip details are bounded and the total count is retained. Match/output/byte/time/entry limits retain earlier results. Only a complete zero-hit search says “No matches found.” A partial zero-hit scan explicitly qualifies the searched portions. `complete` with `outputTruncated=true` means the scan completed but displayed excerpts were shortened; it is distinct from an output limit that stopped the scan.

## Coverage and evidence

`filesRead` is a containment/access audit, including grep reads. It does not establish review. `sourceCoverage` reaches the completeness critic and persisted monolithic, shard, and synthesis traces. Read records include file size, the displayed byte/line/column range, whether the entire file was displayed, continuation, and limits/cancellation. Grep records describe searches and their gaps without claiming that scanned bytes were reviewed. Omitted audit events are explicitly unknown. Source display itself does not prove understanding or security review.

The critic receives range and search status evidence to assess whether relevant behavior remains unexplained; a filename in the access set alone does not establish coverage. Tool coordinates use one-based UTF-16 columns; optional submitted evidence columns are converted to the shared AST contract's zero-based columns. Existing line-only evidence remains compatible.

## Separate wind-down limitation

The submission-only recovery phase disables exploration tools. If the completeness critic requests another source read during that phase, the investigation can remain incomplete even though the source tools could read the file. Bounded file access does not extend the exploration budget or override a rejected submission. See [analysis outcomes](./analysis-robustness.md) for the incomplete-result and exit-code contract.

Coverage summaries also have a size limit. A summary can omit an access event that exists in the full trace; declared omissions must not be interpreted as proof that the file was never accessed. Inspect the full trace when assessing coverage gaps.

## Offline validation

Regression tests generate their own synthetic large files in temporary directories.
They cover late reads and matches beyond 5 MiB, long minified lines, UTF-8 and
match boundaries, byte/column continuation, checkpoint invalidation, regex
anchors/timeouts, partial and cancelled results, output/scan bounds, ordinary
context/globs/case behavior, image reads, and traversal/symlink/session containment.
Recovery tests verify that range coverage reaches the critic and trace and that
rejection/incomplete behavior persists.

```sh
npm run typecheck
npx vitest run test/pi-large-files.test.ts test/pi-source-coverage.test.ts test/pi-containment.test.ts test/pi-shard.test.ts
```

These checks require neither downloaded extensions nor model credentials. A passing
source-access test establishes the tool's behavior on its synthetic input; it does
not establish the completeness or accuracy of an extension investigation.
