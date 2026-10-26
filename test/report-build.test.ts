import { describe, it, expect } from "vitest";
import { skeletonPack } from "../src/pipeline/schema.ts";
import type { EvidencePack } from "../src/pipeline/schema.ts";
import { buildDestinations, buildDeveloper, buildIdentity, buildPermissions, looksLikeHost, type ListingInput } from "../src/report/build.ts";
import { destinationHostOf } from "../src/pipeline/layer4-crossfile.ts";
import { statedPurposeOf } from "../src/report/assemble.ts";

function pack(): EvidencePack {
  const p = skeletonPack({
    path: "sample",
    id_from_path: "sample",
    manifest: {
      name: "Test Ext",
      version: "9.0",
      manifest_version: 3,
      description: "Does a thing.",
      permissions: ["cookies", "alarms", "tabs", "https://example.com/*"],
      optional_permissions: ["downloads"],
    },
  });
  p.cross_file.permission_usage = { cookies: [{ path: "bg.js", line: 3, api: "chrome.cookies.getAll" }] };
  p.cross_file.unused_permissions = ["alarms"];
  p.cross_file.cannot_determine_statically = ["tabs"];
  p.manifest_analysis.host_permissions = { required: ["<all_urls>"], optional: [] };
  p.cross_file.destination_summary = [
    { host: "b.example.com", references: 1, any_dynamic: false, reached_via: ["fetch.url"] },
    { host: "a.example.com", references: 3, any_dynamic: true, reached_via: ["fetch.url", "xhr-open"] },
  ];
  p.cross_file.data_flows = [
    { source_kind: "cookie", file: "bg.js", sink_api: "fetch", sink_location: { line: 9 }, dest_host: "a.example.com", dest_party: "external" },
  ];
  p.scripts = [
    {
      path: "bg.js",
      parsed_ok: true,
      sinks: [],
      network_destinations: [
        { value: "https://a.example.com/v1/collect", kind: "static", ast_role: "fetch.url", location: { line: 9, column: 2 } },
      ],
      taint_sketches: [],
      listeners: [],
      obfuscation: null,
    },
  ];
  return p;
}

describe("buildPermissions", () => {
  it("tables every declared API permission with its usage status and call sites", () => {
    const s = buildPermissions(pack());
    expect(s.api.map((r) => [r.permission, r.status])).toEqual([
      ["cookies", "used"],
      ["alarms", "unused"],
      ["tabs", "undetermined"],
      ["downloads", "undetermined"],
    ]);
    expect(s.api[0]!.usage).toEqual([{ path: "bg.js", line: 3, api: "chrome.cookies.getAll" }]);
    expect(s.api[0]!.total_usage).toBe(1);
    // Optional permissions are flagged distinctly from required ones.
    expect(s.api.find((r) => r.permission === "downloads")!.optional).toBe(true);
    expect(s.api.find((r) => r.permission === "cookies")!.optional).toBe(false);
    // Host patterns in `permissions` (MV2 style) are not API rows.
    expect(s.api.find((r) => r.permission.includes("example.com"))).toBeUndefined();
    expect(s.hosts.required).toEqual(["<all_urls>"]);
  });

  it("enriches each row from the permission catalog (description, doc link, usage prose)", () => {
    const s = buildPermissions(pack());
    const cookies = s.api.find((r) => r.permission === "cookies")!;
    expect(cookies.description).toMatch(/cookies/i);
    expect(cookies.doc_url).toBe("https://developer.chrome.com/docs/extensions/reference/api/cookies");
    expect(cookies.usage_plain).toContain("Reads all your cookies");
    // Unused permission says so in plain language.
    expect(s.api.find((r) => r.permission === "alarms")!.usage_plain).toMatch(/no use of it was found/i);
    // Undetermined permission states the static limit.
    expect(s.api.find((r) => r.permission === "tabs")!.usage_plain).toMatch(/could not confirm/i);
    // tabs carries Chrome's verbatim install warning; broad host access is summarized.
    expect(s.api.find((r) => r.permission === "tabs")!.install_warning).toBe("Read your browsing history.");
    expect(s.hosts_plain).toMatch(/ALL websites/);
  });

  it("reports the TRUE call-site count even when usage is capped for display", () => {
    const p = pack();
    p.cross_file.permission_usage = {
      cookies: Array.from({ length: 12 }, (_, i) => ({ path: "bg.js", line: i + 1, api: "chrome.cookies.get" })),
    };
    const s = buildPermissions(p);
    const cookies = s.api.find((r) => r.permission === "cookies")!;
    expect(cookies.usage.length).toBe(8); // capped for display
    expect(cookies.total_usage).toBe(12); // honest count preserved
  });
});

describe("buildDestinations", () => {
  it("sorts by reference count and joins example call sites + party adjudication", () => {
    const s = buildDestinations(pack());
    expect(s.rows.map((r) => r.host)).toEqual(["a.example.com", "b.example.com"]);
    expect(s.rows[0]).toMatchObject({
      party: "external",
      example_sites: [{ path: "bg.js", line: 9, role: "fetch.url" }],
    });
    expect(s.rows[1]!.party).toBeNull();
  });
});

describe("looksLikeHost — filters comment-string fragments out of the destinations table", () => {
  it("keeps real hosts, IPs, localhost, and templated wildcards", () => {
    for (const h of ["a.example.com", "sub.a.example.com", "evil.example:8443", "1.2.3.4", "1.2.3.4:8080", "localhost", "localhost:27077", "*.example.com"]) {
      expect(looksLikeHost(h), h).toBe(true);
    }
  });
  it("drops the Netscape cookie-file template fragments and other non-host noise", () => {
    for (const junk of ["Details: http:", "Example: http:", "Semicolon separated Cookie File", "This file was generated by ExtRay Demo Cookie Manager", "", "nodot", "http:"]) {
      expect(looksLikeHost(junk), junk).toBe(false);
    }
  });
  it("buildDestinations filters junk hosts out of the rows", () => {
    const p = pack();
    p.cross_file.destination_summary = [
      { host: "a.example.com", references: 2, any_dynamic: false, reached_via: ["fetch.url"] },
      { host: "This file was generated by ExtRay Demo Cookie Manager", references: 1, any_dynamic: false, reached_via: [] },
    ];
    expect(buildDestinations(p).rows.map((r) => r.host)).toEqual(["a.example.com"]);
  });
});

describe("destinationHostOf (shared with layer 4 — keys the example-site join)", () => {
  it("keeps port/case/template exactly as layer 4 does, so the join never misses", () => {
    expect(destinationHostOf("https://a.example.com/v1")).toBe("a.example.com");
    // Port and case preserved — must match the row host byte-for-byte.
    expect(destinationHostOf("wss://Sock.Example.com:8443/x")).toBe("Sock.Example.com:8443");
    expect(destinationHostOf("http://1.2.3.4:8080/collect")).toBe("1.2.3.4:8080");
    expect(destinationHostOf("https://${api}/x")).toBe("*");
    // Bare host with no scheme and relative paths do not resolve a host.
    expect(destinationHostOf("a.example.com/path")).toBeNull();
    expect(destinationHostOf("/relative/path")).toBeNull();
  });

  it("populates example_sites for a host carrying an explicit port (the old keying dropped these)", () => {
    const p = pack();
    p.scripts[0]!.network_destinations = [
      { value: "http://1.2.3.4:8080/collect", kind: "static", ast_role: "fetch.url", location: { line: 5, column: 1 } },
    ];
    p.cross_file.destination_summary = [{ host: "1.2.3.4:8080", references: 1, any_dynamic: false, reached_via: ["fetch.url"] }];
    const s = buildDestinations(p);
    expect(s.rows[0]!.example_sites).toEqual([{ path: "bg.js", line: 5, role: "fetch.url" }]);
  });
});

describe("buildDeveloper", () => {
  const listing: ListingInput = {
    fetched_at: "2026-06-01T00:00:00Z",
    source: "chrome-web-store",
    developer: { name: "Store Name", address: "1 Street\nBerlin\nDE", email: "d@example.com", website: "https://site.example", is_trader: true },
    description: "Store description.",
    country: "DE",
  };

  it("merges listing fields over manifest self-reported fields", () => {
    const p = pack();
    p.developer.author = { name: "Manifest Name", email: null };
    const d = buildDeveloper(p.developer, listing, false);
    expect(d).toMatchObject({
      name: "Store Name",
      email: "d@example.com",
      address: "1 Street\nBerlin\nDE",
      country: "DE",
      is_trader: true,
      high_risk_country: false,
      sources: ["manifest", "store_listing"],
      listing_available: true,
    });
  });

  it("distinguishes never-fetched (null) from fetched-but-unavailable (false)", () => {
    const p = pack();
    expect(buildDeveloper(p.developer, null, null).listing_available).toBeNull();
    const gone: ListingInput = { ...listing, source: "unavailable", developer: { name: null, address: null, email: null, website: null, is_trader: null }, description: null, country: null };
    const d = buildDeveloper(p.developer, gone, null);
    expect(d.listing_available).toBe(false);
    expect(d.name).toBeNull();
  });
});

describe("statedPurposeOf", () => {
  it("prefers the store listing description, falls back to the manifest, else null", () => {
    const p = pack();
    const listing: ListingInput = {
      fetched_at: "t",
      source: "chrome-web-store",
      developer: { name: null, address: null, email: null, website: null, is_trader: null },
      description: "Store says.",
      country: null,
    };
    expect(statedPurposeOf(p, listing)).toEqual({ text: "Store says.", source: "store_listing" });
    expect(statedPurposeOf(p, null)).toEqual({ text: "Does a thing.", source: "manifest" });
    const bare = pack();
    delete (bare.extension.manifest as Record<string, unknown>).description;
    expect(statedPurposeOf(bare, null)).toBeNull();
  });

  it("buildIdentity carries name/version and the caller-supplied store id", () => {
    expect(buildIdentity(pack(), "abc")).toEqual({ name: "Test Ext", version: "9.0", manifest_version: 3, store_id: "abc" });
  });
});
