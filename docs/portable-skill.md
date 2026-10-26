# Use ExtRay in your coding agent

[Back to documentation](./README.md)

The [extray-review skill](../skills/extray-review/SKILL.md) lets your own coding
agent investigate an unpacked Chrome/Chromium extension. It packages the five
review dimensions, source-evidence requirements, classification guidance, and
coverage accounting used by ExtRay, with a portable candidate-report format.
The host agent does the investigation; it does not launch Pi.

## Install

Copy the **whole `skills/extray-review` directory**, including references and
scripts, into the skills location supported by your harness. The folder is
self-contained: no Pi, provider credentials, npm install, or ExtRay checkout is
required after copying. The optional report validator requires Node.js 18+.

For a new personal installation, run one of these from the ExtRay repo root:

```sh
# Codex
mkdir -p "$HOME/.agents/skills"
test ! -e "$HOME/.agents/skills/extray-review" && cp -R skills/extray-review "$HOME/.agents/skills/extray-review"

# Claude Code
mkdir -p "$HOME/.claude/skills"
test ! -e "$HOME/.claude/skills/extray-review" && cp -R skills/extray-review "$HOME/.claude/skills/extray-review"
```

The existence check leaves an installed copy untouched. For updates, compare
your installed version with this directory and replace it deliberately, keeping
any local customizations. These commands copy rather than symlink, so updates
to this repository do not automatically change your installed skill.

For a shared project, copy into `.agents/skills/` (Codex) or `.claude/skills/`
(Claude Code) in a **trusted analysis project**, not inside the extension being
reviewed. Restart or refresh skill discovery as needed. These paths follow the
[Codex skill documentation](https://learn.chatgpt.com/docs/build-skills) and
[Claude Code skill documentation](https://code.claude.com/docs/en/skills).

Other Agent Skills-compatible harnesses can use the same folder in their own
discovery location. The entrypoint uses standard `name`, `description`, `license`,
and `metadata` fields without harness-specific tool names or permission grants.
`agents/openai.yaml` is optional Codex UI metadata; other hosts can ignore it.
For an agent without skill discovery, explicitly ask it to read the installed
`SKILL.md` and follow its linked references. Tool access and isolation remain
the responsibility of the host; compatibility does not guarantee identical results.

## Review an extension

Start the harness in a trusted workspace outside the sample. Example prompts:

```text
Codex: Use $extray-review to review /samples/extension. Save the human review
and candidate JSON under /analysis/reviews/example. Do not execute the extension.

Claude Code: /extray-review Review /samples/extension and save the human review
and candidate JSON under /analysis/reviews/example. Do not execute the extension.

Other agents: Read /installed/extray-review/SKILL.md and use that workflow to
review /samples/extension. Write results outside the sample directory.
```

For a repo-local example, use the absolute path to
`corpus/mutant-i-png-steganography/extension`. These are synthetic fixtures;
do not install them in a browser. Keep corpus labels and parent-directory answer
keys out of the analyst's context.

The skill can work from source alone. With a trusted ExtRay checkout available,
it can also use `npm run scan` to obtain a static evidence pack without a model
call or API key. See the bundled [optional tools reference](../skills/extray-review/references/extray-tools.md).

## What the result means

The skill produces a human review and JSON with candidate findings, source
references, five coverage outcomes, and explicit limits. Its bundled validator
checks the schema, IDs, coverage accounting, file containment, line bounds, and
whether quoted tokens occur in cited files. It never executes source code or
contacts discovered hosts. An incomplete review is a valid result; silent
coverage omissions are not.

```sh
node skills/extray-review/scripts/validate-report.mjs /analysis/review.json --source /samples/extension
```

Exit codes: `0` valid candidate report (including an honest incomplete review),
`1` invalid report or source references, `2` malformed JSON or CLI/read error.

This validator does **not** prove that a claim follows from the cited source or
that all harmful behavior was found. The report retains `verification: "not-run"`.
It does not receive an ExtRay engine tier. You can import it into the local
Explorer as an unverified review using the command below. Running `npm run assess`
starts a separate assessment with configured models and costs.

The portable workflow also does not recreate Pi's enforced tool confinement,
turn ceilings, or submission critic. Those are runtime controls. Use your host's
permissions and isolation settings; Markdown instructions cannot enforce them.

## Save a review to Explorer

From a trusted ExtRay checkout, validate and preview the local import:

```sh
npm run import-review -- /analysis/candidate.json \
  --source-dir /samples/extension --store-id CHROME_WEB_STORE_ID \
  --harness codex --model ACTUAL_MODEL_ID --session-id ACTUAL_SESSION_ID \
  --skill-dir /installed/extray-review \
  --db .out/bakeoff.sqlite --dry-run
```

Remove `--dry-run` to save. Supply the real model/session and exact installed skill
copy; omit the session flag when unknown. Optional `--reviewed-at` pins the review
timestamp (default: candidate file modification time). `--source-sha256` can check
a previously captured source fingerprint; import always records the current
source, skill, and report hashes. No model calls or remote publication occur.

The returned `explorerPath` opens the review in the **Admin** view, with separate
candidate findings, source citations, coverage, and provenance. Candidate rows
are stored with `kind=candidate`, `is_verified=0`, `exclusion_reason=not-verified`;
they never become asserted findings. The report uses an explicitly labeled
`inconclusive` placeholder, without running the risk engine. The configured
canonical assessment and default User catalog are unchanged.

An extension with an existing catalog entry lists the import among its other
analyses. Without a canonical report, use the direct report link. Reimporting
identical content/provenance returns the existing record. Errors exit `2` and
are not silently swallowed. The original candidate report is preserved inside
the stored report's `skill_review` field.

The CLI currently imports store-backed reviews, not corpus fixtures. It does not
perform independent claim verification or upload to the hosted Explorer.
Inline source viewing requires a snapshot under this checkout's `example_crxs/`
or `corpus/` directory. External source paths remain recorded, but are not served
by Explorer's confined source reader.

## Maintain and validate

The shared Pi dimension briefs and classification rules live in
`src/methodologies/pi/guidance.ts`; the finding enums live in
`src/methodologies/findings.ts`. The generated skill reference and JSON Schema
are committed so installed copies need no build step. After editing either source:

```sh
npm run skill:sync
npm run skill:check
npm test -- test/portable-skill.test.ts test/pi-shard.test.ts
```

The portable-skill test also fails on stale generated files. Keep host workflow
instructions in `SKILL.md` and portable report semantics in `references/reporting.md`.
If the schema adds validation keywords, update the dependency-free validator;
it rejects unsupported keywords rather than silently skipping constraints.

Validation covers copied-package operation and invalid report cases. It does
not establish detection accuracy or successful discovery in every harness. For
behavioral evaluation, compare the same agent with and without the skill and
evidence pack, keeping samples, budgets, and labels controlled; measure findings
and false positives as well as time, cost, and incomplete coverage.
