# Optional ExtRay evidence preparation

Use this route only with a trusted ExtRay checkout and its dependencies installed.
The portable skill itself needs neither. ExtRay requires Node.js 24+ and git;
do not install dependencies from the extension under review.

Run from the ExtRay checkout, with absolute paths for input and output. For an
unpacked extension, static scanning makes no model call and needs no API key:

```sh
npm run scan -- --dir /samples/extension --out /analysis/extension.evidence-pack.json --html /analysis/extension.html --no-cache
```

For a Chrome Web Store ID or URL, ExtRay can fetch and unpack the package:

```sh
npm run scan -- 'CHROME_WEB_STORE_URL_OR_ID' --crx-out /analysis/packages --out /analysis/extension.evidence-pack.json --html /analysis/extension.html --no-cache
```

Fetching uses the network. Use the unpacked path printed by the CLI as the source
directory. Do not substitute a website summary for the downloaded source.
Use distinct output names for different extensions to avoid overwriting reviews.

Inspect `manifest`, `scripts`, `cross_file`, `resources`, `summary_signals`, and
`external_call_ledger` in the pack as available; confirm its paths and content
match the package being reviewed. The ledger's opaque regions, unresolved
destinations, indirect calls, and unparsed files are investigation leads.

The host agent still performs the review and emits the portable candidate report.
Running `npm run assess` instead starts a separate model-backed ExtRay assessment
(Pi by default), requires provider configuration, and can incur API charges. It
does not validate or import the host agent's candidate report. For local Explorer
storage, use [import-review](import-review.md); it preserves unverified candidates
without running the shared claim-verifier or verdict engine.
