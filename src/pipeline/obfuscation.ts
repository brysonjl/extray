import type { Obfuscation } from "./schema.ts";

// A flagged file is only affirmative evidence of concealment when it shows a
// string-array decoder, a packer, or dense hex/unicode escapes. A >1000-char
// line also flags ordinary minified bundles, whose parsed behavior is visible.
// Keep the predicate shared by the soundness ledger, verdict and static report
// without pulling a parser, the verdict engine or an LLM into the static path.
// Threshold matches config.ts's OBFUSCATION_THRESHOLDS.hexEscapeDensityPerKb.
const OBF_HEX_DENSITY_PER_KB = 20;

export function isHardObfuscation(o: Pick<Obfuscation,
  "string_array_decoder_detected" | "packer_signature" | "hex_escape_density_per_kb"
>): boolean {
  return o.string_array_decoder_detected || o.packer_signature !== null || o.hex_escape_density_per_kb > OBF_HEX_DENSITY_PER_KB;
}
