#!/usr/bin/env -S npx tsx
// Offline measurement of fix 1 (deterministic harm-adjust): for every stored
// monolith/dag report with a GT anchor and on-disk source, re-run the real
// static pipeline to get the pack, apply adjustFindingHarm to the STORED
// findings, and recompute the tier. Pure static + deterministic — no LLM.
import "./_env.ts";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { analyze } from "../src/pipeline/index.ts";
import { computeVerdict, type VerdictSections } from "../src/report/verdict.ts";
import { adjustFindingHarm } from "../src/report/harm-adjust.ts";
import type { ReportFinding } from "../src/report/contract.ts";

const ROOT = process.cwd(); // run from the repo root
const db = new DatabaseSync(`${ROOT}/.out/bakeoff.sqlite`);
const RANK: Record<string, number> = { clean: 0, "low-risk": 1, concerning: 2, "high-risk": 3, inconclusive: 9 };

const gt = new Map<string, string>();
for (const r of db.prepare(`SELECT COALESCE(t.store_id,t.sample) k, rep.tier FROM run r JOIN report rep ON rep.run_id=r.id JOIN target t ON rep.target_id=t.id WHERE r.methodology='ground-truth'`).all() as any[]) if (r.k) gt.set(r.k, r.tier);

const rows = db.prepare(`
  SELECT r.id run_id, r.methodology, t.store_id, t.name, rep.risk_report_json rj
  FROM run r JOIN report rep ON rep.run_id=r.id JOIN target t ON rep.target_id=t.id
  WHERE r.methodology IN ('monolith','dag') AND r.model='glm-5.2:cloud' AND rep.risk_report_json IS NOT NULL AND t.store_id IS NOT NULL
  ORDER BY r.id`).all() as any[];

// latest run per (methodology, store_id)
const latest = new Map<string, any>();
for (const row of rows) { const k = `${row.methodology}|${row.store_id}`; const p = latest.get(k); if (!p || row.run_id > p.run_id) latest.set(k, row); }

const packCache = new Map<string, any>();
function packFor(dir: string) { if (!packCache.has(dir)) packCache.set(dir, analyze(dir, { cacheDir: `${ROOT}/.cache` })); return packCache.get(dir); }

interface Rec { methodology: string; name: string; gt: string; before: string; after: string; changed: boolean; notes: string[] }
const recs: Rec[] = [];
for (const row of [...latest.values()]) {
  const g = gt.get(row.store_id); if (!g) continue;
  const dir = `${ROOT}/example_crxs/${row.store_id}`; if (!existsSync(dir)) continue;
  let rj: any; try { rj = JSON.parse(row.rj); } catch { continue; }
  if (!rj.permissions) continue;
  const sections: VerdictSections = { permissions: rj.permissions, destinations: rj.destinations, obfuscation: rj.obfuscation, developer: rj.developer, coverage: rj.coverage };
  const findings: ReportFinding[] = rj.findings ?? [];
  const before = computeVerdict(findings, sections).tier;
  let pack; try { pack = packFor(dir); } catch (e) { continue; }
  const adj = adjustFindingHarm(findings, pack);
  const after = computeVerdict(adj.findings, sections).tier;
  recs.push({ methodology: row.methodology, name: row.name ?? row.store_id, gt: g, before, after, changed: before !== after, notes: adj.notes });
}

function tally(pick: (r: Rec) => string, label: string) {
  const b: Record<string, { n: number; exact: number; over: number; under: number; inc: number }> = {};
  for (const r of recs) {
    const bucket = r.gt === "low-risk" || r.gt === "clean" ? "GT benign" : r.gt === "high-risk" ? "GT high-risk" : `GT ${r.gt}`;
    const x = (b[bucket] ??= { n: 0, exact: 0, over: 0, under: 0, inc: 0 });
    x.n++; const t = pick(r);
    if (t === "inconclusive") x.inc++; else if (t === r.gt) x.exact++; else if ((RANK[t] ?? 9) > (RANK[r.gt] ?? 9)) x.over++; else x.under++;
  }
  console.log(`\n=== ${label} ===`);
  for (const [k, x] of Object.entries(b)) console.log(`  ${k}: n=${x.n} exact=${x.exact} over=${x.over} under=${x.under} inconclusive=${x.inc}`);
}

console.log(`Measured ${recs.length} latest monolith/dag reports (store-id keyed, GT-anchored, source on disk).`);
tally((r) => r.before, "BEFORE harm-adjust (verdict engine only)");
tally((r) => r.after, "AFTER harm-adjust (fix 1)");
console.log(`\n=== tier changes from harm-adjust ===`);
for (const r of recs.filter((r) => r.changed)) console.log(`  ${r.methodology.padEnd(9)} ${r.name.slice(0,26).padEnd(26)} GT=${r.gt.padEnd(11)} ${r.before} -> ${r.after}`);
db.close();
