# The runner daemon

The always-on process that operates the analysis pipeline (`scripts/runner.ts`,
`src/runner/`). One supervised process; all scheduling is internal, so the
supervisor (launchd today, systemd on a future Linux box) only keeps it alive.

## What it does, each ~30s tick

1. **Ingest** (every 10 min): pull `queued` submissions from the deployed D1
   (`wrangler d1 execute`) and mirror them into the local `submission` queue
   (`source='remote'`, priority 100). Malformed rows are failed back to D1.
   Remote rows stay `queued` the whole time — `explorer:sync`'s close-loop is
   still the single writer that flips them to `succeeded`.
2. **Discovery** (daily): run the configured scrape queries
   (extpose `new` / `top-installed` by default, English filter always on) and
   enqueue fresh ids at priority 10.
3. **Analyze**: claim the top job (priority DESC, oldest first, `not_before`
   respected) and spawn `scripts/assess.ts` with the pinned arm.
   - **Rate limit** (assess exit 5, or the stderr signature): requeue the job
     with a 30-min backoff, snapshot the usage gauge into `ledger_event`
     (that's what the session cap is learned from), and probe the session
     before resuming any LLM work.
   - **Per-extension failure** (exit 2/3/4): mark the job failed; for remote
     jobs, write the failure back to D1 so the Submit page shows it.
   - **Budget gate**: discovery jobs only start with comfortable headroom
     (session ≥ 1.5× and weekly ≥ 3× the typical job cost); user/remote jobs
     always attempt.
   - **Circuit breaker**: 3 consecutive non-rate-limit failures pause analysis
     for an hour (config/environment problem, not bad extensions); ingest and
     discovery keep running.
4. **Sync**: when results are dirty and the remote-facing queue is drained
   (or the 6h latency bound passes), spawn `explorer:sync` to push D1 + R2 and
   close the remote jobs.

Everything durable is in `.out/bakeoff.sqlite` (`submission`, `runner_state`,
`ledger_event`) — kill the process at any point; boot recovery requeues
orphaned `running` rows.

## Commands

```sh
npm run runner                          # the daemon (foreground)
npm run runner -- --once                # one tick, then exit
npm run runner -- --once --dry-run      # print what a tick would do; no effects
npm run runner -- --no-remote           # keep results local; no Cloudflare reads or writes
npm run runner -- enqueue --ids-file worklists/foo.txt [--priority 50]
npm run runner:status [-- --json]       # queue, stamps, budget, recent events
npm run ollama:usage                    # the raw usage gauge
```

Requirements: `.env` with `OLLAMA_API_KEY` (assess subprocesses load it), and
`npx wrangler login` (or `CLOUDFLARE_API_TOKEN` in the environment for headless
boxes) for the D1 pull + sync.

For a hosted catalog, select the private configuration described in
[Cloudflare hosting](../hosting.md) before starting the runner:

```sh
export EXTRAY_WRANGLER_CONFIG=wrangler.production.jsonc
npm run runner
```

The setting applies to all D1/R2 operations, including progress publishing and
sync subprocesses. Paths are relative to the working directory; an invalid
selected file fails without falling back to the public template. With no
setting, Wrangler uses its normal configuration lookup. For a supervised
runner, set this variable in the service's environment as well.

`--no-remote` (or `ingestRemote: false` in the runner configuration) disables
Cloudflare submission imports, D1/R2 catalog and source uploads, progress
publishing, and failure write-backs, including for previously imported jobs.
Local discovery and model assessments still run and can incur provider charges.
Results remain marked for synchronization; starting later with Cloudflare
integration enabled can upload them. `--local` instead uses the local Wrangler
simulator for Cloudflare operations; it does not disable those operations.

## Configuration

Defaults live in `src/runner/config.ts` (`DEFAULT_RUNNER_CONFIG`). Override any
subset in an optional `runner.config.json` at the repo root (gitignored;
paths resolve relative to the cwd), e.g.:

```json
{
  "discoveryEveryHours": 12,
  "discovery": [
    { "source": "extpose", "collection": "new", "limit": 20 },
    { "source": "webstore", "collection": "sitemap", "limit": 10 }
  ],
  "budget": { "sessionCapSecondsFallback": 3600 }
}
```

## Install under launchd (macOS)

```sh
sed "s|__REPO__|$(pwd)|g; s|__NODE_BIN__|$(dirname "$(command -v node)")|g" \
  ops/launchd/org.extray.runner.plist \
  > ~/Library/LaunchAgents/org.extray.runner.plist
launchctl load ~/Library/LaunchAgents/org.extray.runner.plist

tail -f .out/runner.log                  # watch it
launchctl unload ~/Library/LaunchAgents/org.extray.runner.plist  # stop
```

launchd restarts it on crash (60s throttle) and starts it at login. SIGTERM is
graceful: the current tick finishes, then the process exits.

## Future: systemd unit (Linux VPS)

The daemon is supervisor-agnostic. Equivalent unit for the eventual move —
adjust paths, run `loginctl enable-linger` for a user service:

```ini
# ~/.config/systemd/user/extray-runner.service
[Unit]
Description=ExtRay analysis runner
After=network-online.target

[Service]
WorkingDirectory=%h/extension
ExecStart=%h/extension/node_modules/.bin/tsx scripts/runner.ts
Restart=always
RestartSec=60

[Install]
WantedBy=default.target
```

Migration is: rsync the repo + `.out/bakeoff.sqlite` + `.cache/` +
`example_crxs/` + `.env`, install node, `npm ci`, enable the unit.

## Relationship to the manual tools

- `npm run explorer:drain` still works as a one-shot manual drain; its
  planning/preflight logic now lives in `src/runner/ingest-remote.ts` (shared).
- `npm run assess -- --ids-file …` still runs unpaced batches; prefer
  `runner enqueue --ids-file …` so worklists go through the paced, prioritized
  queue.
- The Explorer's local admin UI (`npm run explorer`) is unchanged.
