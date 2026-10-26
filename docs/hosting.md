# Cloudflare hosting

[Back to documentation](./README.md)

Cloudflare hosting is optional. The Worker serves the Explorer UI and API,
D1 holds the published catalog, and R2 holds source files for the evidence
viewer. Analysis execution requires a separate runner; deploying the Worker
does not run a model or synchronize the local catalog.

## Keep operator configuration private

The committed `wrangler.jsonc` is a portable template. Its Access values and
D1 ID are placeholders, and it enables no public hostname. Copy it to the
gitignored `wrangler.production.jsonc` and configure your own resources there:

```bash
cp wrangler.jsonc wrangler.production.jsonc
# Edit the private copy with your own D1 ID, R2 bucket, and authentication.
```

Keep `main` and `assets.directory` relative to the project root. Create your
D1 database and R2 bucket in your own Cloudflare account, then set their
bindings to `DB` and `SOURCE`. Use a custom domain protected by Cloudflare
Access, set its `ACCESS_TEAM` and `ACCESS_AUD`, and configure allowed identities
in Access. Keep `workers_dev` and `preview_urls` disabled so an alternate
hostname cannot bypass your Access application. The Worker verifies the JWT
and enforces roles itself as well.

Set `ADMIN_EMAILS` as a Worker secret containing comma-separated administrator
addresses. A generic JWT/OIDC issuer or shared-token authentication is also
supported; see [operations](./operations.md#authentication-for-shared-hosting).
Store credentials as secrets, not plaintext configuration variables.

The Worker resolves authentication, storage, profile, and submission limits
from each request's current bindings. Binding-only changes can reuse an
existing isolate, so these values are not captured in a global application.
Public signing keys are cached separately with bounded reuse and refresh;
administrator lists and shared tokens are not cached across requests.

```bash
npx wrangler secret put ADMIN_EMAILS --config wrangler.production.jsonc
npm run explorer:build
npx wrangler deploy --config wrangler.production.jsonc
```

For Cloudflare's local simulator, a gitignored `.dev.vars` can blank
`ACCESS_TEAM` and `ACCESS_AUD`. `npm run explorer:cf:dev` enables the development
role shim only on loopback. Do not enable that shim in a hosted deployment.

## Optional continuous deployment

The CI workflow validates code, corpus and replay fixtures, runs tests and the
full offline scorecard, builds the Explorer, checks the public export, and
audits dependencies. Its dependent deploy job runs only for a successful push
to `master` when the repository variable `ENABLE_CLOUDFLARE_DEPLOY` is `true`.

Configure these repository secrets before enabling it:

- `CLOUDFLARE_API_TOKEN`: a token scoped to the account/resources needed for
  Worker deployment.
- `CLOUDFLARE_ACCOUNT_ID`: the target account.
- `CLOUDFLARE_DEPLOY_CONFIG`: the complete private Wrangler configuration as
  valid JSON, without comments. Do not put API tokens in this object.

The reusable deploy workflow writes the private configuration to an ignored
file, masks its string values in logs, deploys the same commit that passed CI,
and removes the file afterward. It has no independent push or manual trigger.
Source and report synchronization is never part of this workflow.

## Publish data deliberately

Use [runner configuration](./ops/runner.md) to decide whether a runner integrates
with a hosted catalog. `--no-remote` prevents hosted import, synchronization,
progress and failure writebacks; it does not disable explicitly configured
model calls or public-store discovery. Standalone synchronization requires an
explicit local or remote mode. Review the database and source tree selected
for a remote sync before running it: these are separate from the code release.

Select your private configuration for runner, synchronization, and source-upload
commands by exporting its path from the project root:

```bash
export EXTRAY_WRANGLER_CONFIG=wrangler.production.jsonc
npm run explorer:sync -- --remote
```

The scripts pass this path to every D1 and R2 Wrangler command, including
progress publishing and subprocesses. Relative paths resolve from the working
directory. An invalid selected configuration fails without falling back to the
public template. When unset, Wrangler uses its normal configuration lookup.
Direct Wrangler commands still require `--config` as shown above.

R2 upload caches are separate for each selected config path, its contents, and
the explicit `CLOUDFLARE_ACCOUNT_ID`. If you change the account selected by
`wrangler login` without changing that configuration or account variable,
force a source upload before syncing:

```bash
npm run explorer:r2:upload -- --remote --force
npm run explorer:sync -- --remote
```

`--force` belongs to the source-upload command; the sync command does not
forward it. Without an explicit config override, the upload cache retains its
normal bucket/local-or-remote scope, so also force an upload after changing
accounts or configuration through Wrangler's default lookup.

Cloudflare documents [Workers configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
and [Access application setup](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/).
