# Security policy

## Report a vulnerability privately

Report suspected vulnerabilities in ExtRay through GitHub's
[Report a vulnerability form](https://github.com/brysonjl/extray/security/advisories/new).
Do not publish exploit details, credentials, or private analysis data in a public
issue or pull request.

The private form is available when private vulnerability reporting is enabled
for the public repository. If it is unavailable, open an issue requesting a
private security contact **without including vulnerability details**. Wait for
a private channel before sending the report.

## What to include

- The affected commit or version, Node.js version, and operating system.
- The affected component and relevant configuration, with secrets removed.
- Expected behavior, observed behavior, and the security impact.
- Minimal reproduction steps, preferably using a synthetic fixture.
- Relevant logs or screenshots with credentials and personal or private data
  removed.

Use local test instances, synthetic inputs, and resources you control. Do not
include live credentials, private extension packages, or unrelated research
data. Reproducing the issue on the current `master` branch helps us investigate;
include the original affected version even if you cannot reproduce it there.

## Scope and documented boundaries

This policy covers ExtRay's CLI, analysis pipeline, Explorer, hosted API, runner,
and bundled review skill. Examples include authorization bypasses, access
outside documented file boundaries, unintended execution, and disclosure of
credentials or private data.

The corpus intentionally contains harmful patterns for static analysis. Those
patterns alone are expected test data; an input that causes unintended behavior
in ExtRay or bypasses its documented boundaries is relevant to a security report.
Do not install or execute the corpus extensions.

ExtRay assessments can be incomplete or incorrect. The Pi analysis arm does not
provide process sandboxing or network isolation. See
[configuration and containment](docs/configuration.md) and
[analysis methodologies](docs/methodologies.md) for the supported boundaries.

Ordinary bugs and analysis-quality issues can use
[GitHub issues](https://github.com/brysonjl/extray/issues) with synthetic or
sanitized examples. Use the private reporting channel if the issue could expose
users or their data to harm, or if you are unsure whether it is a vulnerability.

## Coordinated disclosure

Please coordinate disclosure with the maintainers through the private report so
we can investigate the issue and prepare a fix before exploit details are made
public.
