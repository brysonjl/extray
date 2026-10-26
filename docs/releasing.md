# Prepare a public release

[Back to documentation](./README.md)

A public release contains maintained guides, implementation, tests, and the
synthetic corpus. Private analysis outputs, operator configuration, talks,
historical notes, and development Git history are excluded.

## Verify and export

```bash
npm ci
npm run validate-corpus
npm run fixtures:check
npm run typecheck
npm test
npm run eval:replay -- --no-db
npm run explorer:build
npm audit --audit-level=moderate
npm run release:check
npm run release:prepare -- --out /absolute/path/to/new-release-directory
```

The export uses current tracked files and eligible nonignored new files, with
an explicit public-path policy. It does not modify the working repository or
copy `.git`. The destination must be new and outside the source checkout.
Review the adjacent export manifest and scan the exported tree for credentials
and private identifiers. Read selected guides for embedded historical narratives
as well: path allowlisting and literal scans cannot identify private research
prose inside an otherwise maintained document. Historical experiment harnesses
and their dedicated tests are excluded by explicit policy; maintained source
access, fixture, and runtime regression tests remain included. An optional ignored `--private-patterns` text file
can supply additional literal strings that must not appear in the export.

Initialize Git in the exported directory (`git init -b master`) so the release
checker can enumerate its files. Use a fresh install there and repeat the checks. Record
the exact release commit and the verification results. Local tests against an
unfinished working tree are not a substitute for checking that final commit.

## Keep publication history clean

Initialize new publication history from the verified export, using the
maintainer's intended public name and a GitHub noreply email. Do not merge the
private development repository into it or push private branches/tags alongside
the release. Keep private history and omitted notes in their original workspace
or a private archive.

If a proposed public repository already contains private data in earlier
commits, a later deletion does not remove those copies. Branches, tags, pull
request refs, diffs, cached views, Actions logs/artifacts, and forks need separate
review. Replacing branch history alone cannot guarantee that the old objects
are inaccessible. A new repository with a fresh object history avoids carrying
those old repository surfaces into publication.

Any remote history replacement, repository rename, or public visibility change
should name the exact target and verified commit before execution. Follow
[GitHub's history-removal guidance](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)
when cleaning an existing remote; GitHub may retain references that a normal
push cannot remove.
