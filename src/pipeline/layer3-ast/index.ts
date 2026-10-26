// Layer 3 per-file driver. Parses one JS file and assembles its ScriptEntry.
// Sinks + destinations land in Unit 4; taint, obfuscation, and listeners are
// added in Unit 5.

import type { ScriptEntry, Sink, NetworkDestination } from "../schema.ts";
import { parseModule } from "./parse.ts";
import { extractSinks, executeScriptCodePayloads } from "./sinks.ts";
import { extractDestinations } from "./destinations.ts";
import { extractTaintSketches } from "./taint.ts";
import { computeObfuscation } from "./obfuscation.ts";
import { extractListeners } from "./listeners.ts";

const byLoc = (a: { location: { line: number; column?: number } }, b: { location: { line: number; column?: number } }) =>
  a.location.line - b.location.line || (a.location.column ?? 0) - (b.location.column ?? 0);

export function analyzeScript(path: string, source: string): ScriptEntry {
  const { ast, parsedOk } = parseModule(source);
  if (!ast) {
    return { path, parsed_ok: false, sinks: [], network_destinations: [], taint_sketches: [], listeners: [], obfuscation: null };
  }
  const sinks: Sink[] = extractSinks(ast, source);
  const destinations: NetworkDestination[] = extractDestinations(ast, source);

  // executeScript string `code` payloads are scripts in their own right: parse
  // each literal payload as a nested script and fold its sinks/destinations
  // into this entry. Nested locations point at the embedding payload literal
  // so findings stay addressable in the host file. Dynamic payloads stay
  // opaque — the `(code)` sink emitted by extractSinks feeds the ledger.
  for (const p of executeScriptCodePayloads(ast)) {
    if (p.source === null) continue;
    const nested = parseModule(p.source);
    if (!nested.ast) continue;
    for (const s of extractSinks(nested.ast, p.source)) sinks.push({ ...s, location: p.location });
    for (const d of extractDestinations(nested.ast, p.source)) destinations.push({ ...d, location: p.location });
  }
  sinks.sort(byLoc);
  destinations.sort(byLoc);

  return {
    path,
    parsed_ok: parsedOk,
    sinks,
    network_destinations: destinations,
    taint_sketches: extractTaintSketches(ast, source),
    listeners: extractListeners(ast, source),
    obfuscation: computeObfuscation(ast, source),
  };
}
