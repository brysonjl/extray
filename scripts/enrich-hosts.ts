#!/usr/bin/env -S npx tsx
// CLI: enrich the external hosts an unpacked extension contacts with RDAP-derived
// registration/ownership context, writing a host-enrichment artifact NEXT TO the
// unpacked extension (improvement 015). This is the RDAP analog of fetch-listing
// (008b) and mirrors its record/replay posture: this CLI is the ONLY place the
// network is touched (RECORD); the static pipeline and the report path only ever
// READ the committed artifact.
//
//   npm run enrich-hosts -- <ext-dir...> [--force]
//
// Each <ext-dir> is an unpacked extension root (e.g. example_crxs/<id> or
// corpus/<sample>/extension). The artifact lands as a SIBLING of that dir, never
// inside it (enrichmentPathFor in src/enrichment/types.ts is the single source of
// truth for the mapping) — a file inside would be ingested by the static
// pipeline and contaminate analysis.
//
// Hosts to enrich = the external, non-wildcard destinations the pipeline already
// resolved (buildDestinations rows, minus first-party-extension and `*` hosts).
// NO top-N cap — every external host is enriched, including single-reference
// ones; cost is bounded by the compact per-host payload, not by dropping hosts.
//
// Idempotent + staleness-aware:
//   - A fresh artifact (< 30 days, by fetched_at) covering every current host is
//     reused as-is — zero network requests — unless --force.
//   - A fresh artifact missing some current hosts has ONLY the missing hosts
//     looked up and merged in (record-on-miss).
//   - A stale artifact (or --force) re-enriches every host.
//
// Each host is enriched independently; a single host's lookup failure becomes
// that host's `error` record and never aborts the rest.

import { writeFileSync } from "node:fs";
import { Command } from "commander";
import { analyze } from "../src/pipeline/index.ts";
import { buildDestinations } from "../src/report/build.ts";
import { ARTIFACT_STALE_DAYS, enrichHosts, type EnrichDeps } from "../src/enrichment/rdap.ts";
import { loadEnrichmentBeside } from "../src/enrichment/load.ts";
import { enrichmentPathFor, type HostEnrichment } from "../src/enrichment/types.ts";

/** External, lookup-worthy hosts for an extension dir: the resolved destinations
 *  minus first-party-extension hosts and wildcard/template skeletons. */
export function hostsToEnrich(extDir: string): string[] {
  const pack = analyze(extDir);
  return buildDestinations(pack)
    .rows.filter((r) => r.party !== "first-party-extension" && !r.host.includes("*"))
    .map((r) => r.host);
}

function ageDays(fetchedAt: string): number {
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / 86_400_000;
}

export interface EnrichResult {
  extDir: string;
  artifactPath: string;
  /** Hosts looked up over the network this run (0 when skipped/fully cached). */
  fetched: number;
  /** Total hosts in the written artifact. */
  total: number;
  skipped: boolean;
}

/**
 * Enrich one extension dir and write its sibling artifact. `deps` is injectable
 * so tests exercise every path offline. Throws only on a hard analyze error;
 * per-host RDAP failures are captured as `error` records, never thrown.
 */
export async function enrichExtension(
  extDir: string,
  opts: { force: boolean },
  deps: EnrichDeps = {},
): Promise<EnrichResult> {
  const artifactPath = enrichmentPathFor(extDir);
  const hosts = hostsToEnrich(extDir);
  const existing = loadEnrichmentBeside(extDir);
  const now = new Date().toISOString();

  if (existing && !opts.force && ageDays(existing.fetched_at) <= ARTIFACT_STALE_DAYS) {
    const have = new Set(existing.hosts.map((h) => h.host));
    const missing = hosts.filter((h) => !have.has(h));
    if (missing.length === 0) {
      process.stdout.write(`enrichment artifact fresh at ${artifactPath} (${existing.hosts.length} hosts) — skipping\n`);
      return { extDir, artifactPath, fetched: 0, total: existing.hosts.length, skipped: true };
    }
    // Record-on-miss: look up only the new hosts, keep the still-referenced ones.
    process.stdout.write(`enriching ${missing.length} new host(s) for ${extDir} (merging into fresh artifact) …\n`);
    const fresh = await enrichHosts(missing, now, deps);
    const current = new Set(hosts);
    const merged: HostEnrichment = {
      fetched_at: now,
      source: "rdap",
      hosts: [...existing.hosts.filter((h) => current.has(h.host)), ...fresh.hosts].sort((a, b) =>
        a.host < b.host ? -1 : a.host > b.host ? 1 : 0,
      ),
    };
    writeFileSync(artifactPath, JSON.stringify(merged, null, 2) + "\n");
    process.stdout.write(`wrote ${artifactPath} (${merged.hosts.length} hosts)\n`);
    return { extDir, artifactPath, fetched: missing.length, total: merged.hosts.length, skipped: false };
  }

  process.stdout.write(`enriching ${hosts.length} host(s) for ${extDir} …\n`);
  const artifact = await enrichHosts(hosts, now, deps);
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n");
  const statuses = artifact.hosts.reduce<Record<string, number>>((acc, h) => {
    acc[h.lookup_status] = (acc[h.lookup_status] ?? 0) + 1;
    return acc;
  }, {});
  process.stdout.write(`wrote ${artifactPath} (${artifact.hosts.length} hosts: ${JSON.stringify(statuses)})\n`);
  return { extDir, artifactPath, fetched: hosts.length, total: artifact.hosts.length, skipped: false };
}

function cli(): void {
  const program = new Command();
  program
    .name("enrich-hosts")
    .description("RDAP-enrich an extension's external hosts into <ext-dir>.host-enrichment.json (improvement 015)")
    .argument("<ext-dir...>", "one or more unpacked extension dirs (e.g. example_crxs/<id> or corpus/<sample>/extension)")
    .option("--force", "re-enrich every host, ignoring an existing fresh artifact", false)
    .action(async (extDirs: string[], opts: { force: boolean }) => {
      let ok = 0;
      let skipped = 0;
      const failures: string[] = [];
      for (const dir of extDirs) {
        try {
          const { skipped: wasSkipped } = await enrichExtension(dir, opts);
          if (wasSkipped) skipped++;
          else ok++;
        } catch (e) {
          process.stderr.write(`enrich-hosts: ${dir}: ${(e as Error).message}\n`);
          failures.push(dir);
        }
      }
      if (extDirs.length > 1) {
        process.stdout.write(`\ndone: ${ok} enriched, ${skipped} skipped, ${failures.length} failed\n`);
        if (failures.length > 0) process.stdout.write(`failed: ${failures.join(", ")}\n`);
      }
      if (failures.length > 0) process.exit(2);
    });
  program.parseAsync();
}

if (import.meta.url === `file://${process.argv[1]}`) cli();
