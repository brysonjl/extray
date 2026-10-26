# Operations

[Back to documentation](./README.md)

## Local use

`npm run explorer` starts the API on `127.0.0.1:8788` and the UI on
`http://localhost:5173`. `npm run serve` starts only the API. The default database
is `.out/bakeoff.sqlite`; use a separate database for a demo or experiment:

```bash
# Terminal 1
npm run serve -- --db .out/demo.sqlite

# Terminal 2
npm run dev -w web/explorer
```

The local server runs submitted analysis jobs in-process. See the
[Explorer guide](./explorer.md) for settings and ports, and the
[runner guide](./ops/runner.md) for batch work and resource limits.

## Authentication for shared hosting

Binding off loopback requires authentication and refuses to start without it.
Use `EXTRAY_TOKEN=<secret>` for shared-token authentication, or `EXTRAY_AUTH=jwt`
with `EXTRAY_JWT_ISSUER` and `EXTRAY_JWT_AUDIENCE` behind a proxy supplying a
verified JWT. Generic JWT identities must include a nonempty standard `email`
claim and boolean `email_verified: true`; absent, false, or string values are
rejected for all users. Configure the issuer to certify control of that address
before issuing the token. `ADMIN_EMAILS` grants administrator privileges only
after those checks. If `EXTRAY_JWT_EMAIL_CLAIM` selects an alias, its value must
match the standard verified email case-insensitively; an arbitrary username
cannot substitute for it. Issuers that previously supplied an email without
verification must update their claim mapping before using generic JWT mode.

The Cloudflare Access preset accepts its edge-authenticated email when the
OIDC verification claim is absent, while rejecting an explicitly false or
malformed value. Keep the Access application restricted to intended identities.
Admin process-spawning capabilities are disabled outside the local single-user
mode; authenticated access does not automatically enable them.

Local settings are written to `.extray/settings.json` (gitignored, mode 0600).
Source views depend on the analyzed tree being retained on the host. The browser's
admin/user lens is a preview; roles are enforced by the server.

## Optional Cloudflare mirror

Cloudflare deployment is optional. It is not needed for installation, static
scans, or the local Explorer. The hosted shape serves the UI and API with D1 and
R2, and uses a separate local worker to drain analysis submissions. We do not
operate a hosted deployment for other users.

Follow the [Cloudflare hosting guide](./hosting.md)
for deployment, Access authentication, source uploads, and data refreshes.
Automatic deployment is opt-in: set the GitHub repository variable
`ENABLE_CLOUDFLARE_DEPLOY=true` and the `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_DEPLOY_CONFIG` secrets after configuring
your own deployment. The deploy job runs only after CI succeeds for that commit.
