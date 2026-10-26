import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { analyzeManifest, extractDeveloper } from "../src/pipeline/layer1-manifest.ts";

function manifest(sample: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`corpus/${sample}/extension/manifest.json`, "utf8"));
}

describe("Layer 1 — manifest surface analysis", () => {
  it("derives capability categories for ExtRay Demo Cookie Manager", () => {
    const a = analyzeManifest(manifest("demo-cookie-manager"));
    expect(a.capability_categories).toContain("cookies");
    expect(a.capability_categories).toContain("storage");
    expect(a.capability_categories).toContain("clipboard");
  });

  it("flags the cookies + broad-host dangerous combination", () => {
    const a = analyzeManifest(manifest("demo-cookie-manager"));
    const kinds = a.dangerous_combinations.map((c) => c.kind);
    expect(kinds).toContain("cookies+broad-host");
  });

  it("records a default Chrome Web Store update channel as non_default=false", () => {
    const a = analyzeManifest(manifest("demo-cookie-manager"));
    expect(a.non_default_update_url).toBe(false);
  });

  it("captures background service worker as an ES module", () => {
    const a = analyzeManifest(manifest("demo-cookie-manager"));
    expect(a.background).toEqual({ kind: "service_worker", script: "/js/background.js", module: true });
  });

  it("flags mutant D's widened externally_connectable wildcard", () => {
    const a = analyzeManifest(manifest("mutant-d-wide-externally-connectable"));
    expect(a.externally_connectable).not.toBeNull();
    expect(a.externally_connectable?.wildcards).toBe(true);
  });

  it("reports no CSP weaknesses and empty externally_connectable for the base", () => {
    const a = analyzeManifest(manifest("demo-cookie-manager"));
    expect(a.csp.weaknesses).toEqual([]);
    expect(a.externally_connectable).toBeNull();
  });

  it("MV2: host patterns in `permissions` yield network category + dangerous combination", () => {
    const a = analyzeManifest({ manifest_version: 2, permissions: ["cookies", "<all_urls>"] });
    expect(a.capability_categories).toContain("network");
    expect(a.capability_categories).toContain("cookies");
    expect(a.dangerous_combinations.map((c) => c.kind)).toContain("cookies+broad-host");
    expect(a.host_permissions).toEqual({ required: ["<all_urls>"], optional: [] });
  });

  it("MV2: scheme-wildcard patterns (*://*/*) are treated as host permissions", () => {
    const a = analyzeManifest({ manifest_version: 2, permissions: ["webRequest", "*://*/*"] });
    expect(a.dangerous_combinations.map((c) => c.kind)).toContain("webRequest+broad-host");
    expect(a.host_permissions?.required).toEqual(["*://*/*"]);
  });

  it("surfaces optional_host_permissions distinguishably (no dangerous combo from optional alone)", () => {
    const a = analyzeManifest({
      manifest_version: 3,
      permissions: ["cookies"],
      host_permissions: ["https://example.com/*"],
      optional_host_permissions: ["<all_urls>"],
    });
    expect(a.host_permissions).toEqual({ required: ["https://example.com/*"], optional: ["<all_urls>"] });
    expect(a.capability_categories).toContain("network");
    // Broad host is only optional — must not fire the standing dangerous combo.
    expect(a.dangerous_combinations.map((c) => c.kind)).not.toContain("cookies+broad-host");
  });
});

describe("Layer 1 — developer extraction (self-reported, improvement 008)", () => {
  it("normalizes a string author into {name, email: null}", () => {
    const d = extractDeveloper({ author: "Jane Dev" });
    expect(d.author).toEqual({ name: "Jane Dev", email: null });
  });

  it("normalizes an MV3 object author ({email}) into {name: null, email}", () => {
    const d = extractDeveloper({ author: { email: "dev@example.com" } });
    expect(d.author).toEqual({ name: null, email: "dev@example.com" });
  });

  it("derives has_website only for an http(s) homepage_url", () => {
    expect(extractDeveloper({ homepage_url: "https://example.com" }).has_website).toBe(true);
    expect(extractDeveloper({ homepage_url: "http://example.com" }).has_website).toBe(true);
    // Present but not a web URL — surfaced verbatim, but it is not a website.
    const d = extractDeveloper({ homepage_url: "chrome://extensions" });
    expect(d.homepage_url).toBe("chrome://extensions");
    expect(d.has_website).toBe(false);
  });

  it("flags a non-store update_url and keeps the official store URL unflagged", () => {
    const off = extractDeveloper({ update_url: "https://updates.shady-cdn.example/crx" });
    expect(off.non_store_update_url).toBe(true);
    const store = extractDeveloper({ update_url: "https://clients2.google.com/service/update2/crx" });
    expect(store.non_store_update_url).toBe(false);
  });

  it("emits explicit nulls/false (never missing keys) when the manifest declares nothing", () => {
    const d = extractDeveloper({ manifest_version: 3, name: "X", version: "1" });
    expect(d).toEqual({
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

  it("ExtRay Demo Cookie Manager: no self-reported author/homepage, default store update channel", () => {
    const d = extractDeveloper(manifest("demo-cookie-manager"));
    expect(d.author).toBeNull();
    expect(d.has_website).toBe(false);
    expect(d.non_store_update_url).toBe(false);
    expect(d.provenance).toBe("self_reported");
  });
});
