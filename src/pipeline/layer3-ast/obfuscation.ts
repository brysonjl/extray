// Per-file obfuscation metrics + a boolean flag. First-party obfuscation (e.g.
// a string-array decoder) is a real signal; vendored minified libraries also
// flag — that is expected noise, reconciled at the cross-file/baseline layer.

import type { File, Node } from "@babel/types";
import type { Obfuscation } from "../schema.ts";
import { collectIdentifiers, traverse } from "./util.ts";
import { OBFUSCATION_THRESHOLDS as T } from "../config.ts";

const HEX_ID = /^_0x[0-9a-f]+$/i;
const PACKER = /eval\(function\(p,a,c,k,e,[dr]\)/;

function shannonEntropy(s: string): number {
  if (!s.length) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of freq.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function computeObfuscation(ast: File, source: string): Obfuscation {
  const names = [...collectIdentifiers(ast)];
  const meanLen = names.length ? names.reduce((a, n) => a + n.length, 0) / names.length : 0;
  const hexIds = names.filter((n) => HEX_ID.test(n));
  const hexIdRatio = names.length ? hexIds.length / names.length : 0;
  const entropy = shannonEntropy(names.join("").toLowerCase().replace(/[^a-z]/g, ""));

  const sizeKb = Math.max(source.length / 1024, 0.001);
  const hexEscapes = (source.match(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/g) ?? []).length;
  const hexEscapeDensity = hexEscapes / sizeKb;

  const maxLine = source.split("\n").reduce((m, l) => Math.max(m, l.length), 0);

  let stringArray = false;
  traverse(ast, {
    ArrayExpression(path) {
      const els = (path.node as Extract<Node, { type: "ArrayExpression" }>).elements;
      const strs = els.filter((e) => e && e.type === "StringLiteral");
      if (strs.length >= T.minStringArrayElements && strs.length === els.length) stringArray = true;
    },
  });
  const usesAtob = /\batob\s*\(/.test(source);
  const stringArrayDecoder = stringArray && (usesAtob || hexIdRatio > T.hexIdRatio);

  const packerSignature = PACKER.test(source) ? "packer(p,a,c,k,e,d)" : null;

  const flagged =
    stringArrayDecoder ||
    packerSignature !== null ||
    hexIdRatio > T.hexIdRatio ||
    hexEscapeDensity > T.hexEscapeDensityPerKb ||
    maxLine > T.maxLine;

  return {
    mean_identifier_length: Number(meanLen.toFixed(2)),
    identifier_entropy: Number(entropy.toFixed(2)),
    hex_escape_density_per_kb: Number(hexEscapeDensity.toFixed(2)),
    string_array_decoder_detected: stringArrayDecoder,
    packer_signature: packerSignature,
    flagged,
  };
}
