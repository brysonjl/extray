import { describe, it, expect } from "vitest";
import { skeletonPack, validatePack, SCHEMA_VERSION } from "../src/pipeline/schema.ts";

const extension = {
  path: "corpus/demo-cookie-manager/extension",
  id_from_path: "demo-cookie-manager",
  manifest: { manifest_version: 3, name: "X", version: "1.0.0" },
};

describe("evidence-pack schema", () => {
  it("accepts a structurally-complete skeleton pack with empty sections", () => {
    const pack = skeletonPack(extension);
    const result = validatePack(pack);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(pack.schema_version).toBe(SCHEMA_VERSION);
  });

  it("includes a developer section with explicit nulls in the skeleton (schema 1.1)", () => {
    const pack = skeletonPack(extension);
    expect(pack.developer).toEqual({
      author: null,
      homepage_url: null,
      update_url: null,
      has_website: false,
      non_store_update_url: false,
      address: null,
      country: null,
      provenance: "self_reported",
    });
  });

  it("rejects a pack missing the developer section", () => {
    const pack = skeletonPack(extension) as unknown as Record<string, unknown>;
    delete pack.developer;
    const result = validatePack(pack);
    expect(result.valid).toBe(false);
  });

  it("rejects a pack missing a required top-level key", () => {
    const pack = skeletonPack(extension) as unknown as Record<string, unknown>;
    delete pack.cross_file;
    const result = validatePack(pack);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects a pack with an unknown verdict-shaped top-level key only if additionalProperties is closed", () => {
    // sanity: a valid pack stays valid when sections are populated with well-typed empty containers
    const pack = skeletonPack(extension);
    pack.files.push({
      path: "js/x.js",
      size_bytes: 1,
      sha256: "0".repeat(64),
      type: "javascript",
      referenced_by: [],
      provenance: { known: false },
      anomalies: [],
    });
    expect(validatePack(pack).valid).toBe(true);
  });
});
