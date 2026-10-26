# Fixture provenance

ExtRay Demo Cookie Manager is a fictional identity for local analysis fixtures.
It is not published in the Chrome Web Store, endorsed by upstream, or a finding
against any published extension. All planted harmful behaviors are ExtRay test
mutations. The benign-control label concerns this fixture snapshot only.

The underlying source was obtained from **EditThisCookie (V3), version 3.0.5**,
store ID `ojfebgpkimhlhcblbalbfjblapadhbol`. Its shipped `License.txt` credits
Francesco Capano and modification and maintenance by mr.Fani. Those files and
the bundled `GNU_GPL_V3.txt` remain unchanged in every copy. Upstream attribution
is retained here and in [NOTICE](../NOTICE); it is not the public identity of
our modified samples.

On 2026-10-16, all fixture variants, including the benign control, were renamed
to **ExtRay Demo Cookie Manager**, version **1.0.0**. Shared modifications replace
product names, localized branding, icons, and operational upstream support,
source, and store links. Demo links use `demo-cookies.example`. The new
flask icon is authored for ExtRay; its vector source is [fixture-icon.svg](./fixture-icon.svg).
The hidden PNG trailers in variants I and J are preserved independently of the
replacement icon artwork. Real enrichment records for the old support domain
are removed, rather than attributed to the fictional demo domain.

The control is in `demo-cookie-manager/`; `base/` is an alias. Each `mutant-*/`
directory adds the behaviors described in its sibling `label.yaml`. License
files and third-party library notices retain their original terms. Renaming
these derived fixtures does not make the upstream source Apache-2.0.

The upstream `package.json` and `package-lock.json` contain an inherited `ISC`
package metadata field. It is inconsistent with the source's `License.txt` and
`GNU_GPL_V3.txt`; it does not relicense the extension. These files are retained
as analysis inputs so the recorded source hashes remain reproducible. Treat
the extension source as GPLv3-or-later, with bundled libraries governed by
their own notices, rather than relying on that package metadata field.

Recordings affected by this migration are obsolete because source hashes and
model prompts changed. Replacements must be captured from the rebranded source;
old responses must not be rewritten to appear to have analyzed different bytes.
