import { describe, expect, it } from "vitest";
import { isHardObfuscation } from "../src/pipeline/obfuscation.ts";

describe("shared concealment predicate", () => {
  const minified = {
    flagged: true,
    string_array_decoder_detected: false,
    packer_signature: null,
    hex_escape_density_per_kb: 0,
  };

  it("keeps minification and the exact hex-density boundary below the concealment threshold", () => {
    expect(isHardObfuscation(minified)).toBe(false);
    expect(isHardObfuscation({ ...minified, hex_escape_density_per_kb: 19.99 })).toBe(false);
    expect(isHardObfuscation({ ...minified, hex_escape_density_per_kb: 20 })).toBe(false);
    expect(isHardObfuscation({ ...minified, hex_escape_density_per_kb: 20.01 })).toBe(true);
  });

  it("preserves independent decoder and non-null packer signals even at zero hex density", () => {
    expect(isHardObfuscation({ ...minified, string_array_decoder_detected: true })).toBe(true);
    expect(isHardObfuscation({ ...minified, packer_signature: "packer(p,a,c,k,e,d)" })).toBe(true);
    // The existing contract treats every non-null signature as detected.
    expect(isHardObfuscation({ ...minified, packer_signature: "" })).toBe(true);
  });
});
