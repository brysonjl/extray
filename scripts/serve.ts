#!/usr/bin/env -S npx tsx
// Node launcher for the Explorer API (src/server/app.ts). Defaults to the
// single-user case: binds 127.0.0.1 and resolves roles via the dev shim
// (EXPLORER_ROLE, default admin, per-request x-explorer-role override), which
// is safe only because nothing off this machine can reach it.
//
//   npm run explorer:api -- [--db .out/bakeoff.sqlite] [--port 8788] [--host 127.0.0.1]
//
// --host exists so a self-hoster can put ExtRay on a box rather than a laptop
// (OSS release plan 2026-08-21-001 §B.3.4). Leaving loopback therefore requires
// real auth: EXTRAY_TOKEN, or EXTRAY_JWT_ISSUER + EXTRAY_JWT_AUDIENCE behind a
// forward-auth proxy. assertBindAllowed refuses to start otherwise — an
// admin-by-default API on 0.0.0.0 is the foot-gun this whole seam exists to
// prevent.
//
// The DB is opened via openDb (read-write): reads stay parameterized SELECTs,
// and the one write path is the `submission` job table (schema v5).

import "./_env.ts"; // load cwd .env before auth/profile/provider consumers; exported env wins
import { serve } from "@hono/node-server";
import { openDb, recordRun } from "../src/db/index.ts";
import { SqliteDataSource } from "../src/product/datasource.ts";
import { ingestCorpus } from "../src/product/corpus-ingest.ts";
import { resolveProfile } from "../src/product/profile.ts";
import { createApp } from "../src/server/app.ts";
import { assertBindAllowed, isLoopbackHost, selectAuth, AuthConfigError } from "../src/server/auth.ts";
import type { AuthSelection } from "../src/server/auth.ts";
import { devRoleResolver } from "../src/server/role.ts";
import { nodeSettingsStore } from "../src/server/settings-node.ts";
import { nodeSourceReader } from "../src/server/source-node.ts";
import { makeAnalyzeBatch, makeDiscoverCapability, makeSubmissionRunner } from "./explorer-capabilities.ts";
import { resolveSubmissionSettings } from "../src/server/analysis-node.ts";

interface Args {
  db: string;
  port: number;
  host: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { db: ".out/bakeoff.sqlite", port: 8788, host: "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") out.db = argv[++i] ?? out.db;
    else if (a === "--port") out.port = Number(argv[++i] ?? out.port) || out.port;
    else if (a === "--host") out.host = argv[++i] ?? out.host;
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const local = isLoopbackHost(args.host);

  let auth: AuthSelection;
  try {
    auth = selectAuth(process.env);
    assertBindAllowed(args.host, auth.mode);
  } catch (e) {
    if (!(e instanceof AuthConfigError)) throw e;
    console.error(`[explorer-api] ${e.message}`);
    process.exit(1);
  }

  // Runner-backed capabilities spend the operator's money and spawn processes,
  // so they are tied to auth mode "none" (the single-user laptop) — NOT to
  // loopback alone: a same-host reverse proxy also binds loopback while
  // authenticating many users. EXTRAY_LOCAL_CAPABILITIES=1 opts in explicitly.
  const runnerCaps = local && (auth.mode === "none" || process.env.EXTRAY_LOCAL_CAPABILITIES === "1");

  const profile = resolveProfile();
  const db = openDb(args.db);
  const ds = new SqliteDataSource(db);
  const runSubmission = runnerCaps ? makeSubmissionRunner(args.db, ds, profile) : undefined;
  // Source viewer: serves line windows out of the local analysis trees
  // (example_crxs/, corpus/) — a local-dev affordance; hosted deployments
  // simply omit the reader and the endpoint 404s.
  // Discover & Analyze: local-only admin capabilities (scrape + spawn assess).
  // Injecting them here — never in the Cloudflare entry — is what scopes the
  // /api/discover + /api/analyze-batch routes to local dev. They shell out and
  // scrape the web, so a non-loopback bind drops them too: authenticating a
  // remote caller is not the same as handing them process spawning.
  const app = createApp({
    ds,
    profile,
    roleResolver: auth.resolver ?? devRoleResolver(),
    sourceReader: nodeSourceReader(process.cwd()),
    // DNS-rebinding defense: on a loopback bind only loopback Host values pass.
    // EXTRAY_ALLOWED_HOSTS=name1,name2 admits the name a same-host proxy forwards.
    loopbackGuard: local
      ? {
          extraHosts: (process.env.EXTRAY_ALLOWED_HOSTS ?? "")
            .split(",")
            .map((h) => h.trim())
            .filter(Boolean),
        }
      : undefined,
    discover: runnerCaps ? makeDiscoverCapability(args.db) : undefined,
    analyzeBatch: runnerCaps ? makeAnalyzeBatch(args.db, undefined, runSubmission) : undefined,
    // Settings hold an API key and are written to disk, so they follow the same
    // rule as the capabilities above: local only. Authenticating a remote caller
    // is not the same as letting them rewrite this machine's credentials.
    settings: local ? nodeSettingsStore() : undefined,
    resolveSubmissionSettings: runnerCaps ? resolveSubmissionSettings : undefined,
    // Local serve is its own analysis worker (see makeSubmissionRunner): the
    // deployed queue+drain split would leave a laptop submission stuck at
    // "queued" with no worker to run it.
    runSubmission,
    // Reads the repo's corpus/ and its committed fixtures — inherently local.
    ingestCorpus: runnerCaps ? () => ingestCorpus({ record: (input) => recordRun(db, input) }) : undefined,
  });

  const onListenError = (error: NodeJS.ErrnoException): void => {
    const detail = error.code === "EADDRINUSE"
      ? `Port ${args.port} is already in use on ${args.host}. Stop the existing API before starting another Explorer.`
      : `Cannot listen on ${args.host}:${args.port}: ${error.message}`;
    console.error(`[explorer-api] ${detail} No queued analyses were started by this process.`);
    db.close();
    process.exitCode = 1;
  };

  const server = serve({ fetch: app.fetch, port: args.port, hostname: args.host }, (info) => {
    server.off("error", onListenError);
    console.log(`Explorer API:        http://${args.host}:${info.port}/api`);
    console.log(`DB: ${args.db}`);
    console.log(`Pinned pipeline: ${profile.pinned.methodology} · ${profile.pinned.model}`);
    console.log(`Discover & Analyze: ${runnerCaps ? "enabled (admin, local only)" : "disabled (needs auth mode none on loopback, or EXTRAY_LOCAL_CAPABILITIES=1)"}`);
    console.log(`Analysis:  ${runnerCaps ? "runs here, in this process, as jobs are submitted" : "recorded only — a separate drain runs it"}`);
    if (local) console.log(`Settings: ${nodeSettingsStore().path} (gitignored; holds your API key)`);
    console.log(
      auth.mode === "none"
        ? `Auth: none — default role ${process.env.EXPLORER_ROLE ?? "admin"} (x-explorer-role header overrides per request)`
        : `Auth: ${auth.mode}`,
    );
    // Claim/resume durable work only after this API has successfully bound.
    // A duplicate launcher must not touch the queue before failing to listen.
    runSubmission?.();
  });
  server.once("error", onListenError);
}

main();
