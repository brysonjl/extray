import { describe, it, expect } from "vitest";
import type { PermissionRow } from "../src/report/contract.ts";
import {
  PERMISSION_CATALOG,
  PERMISSIONS_LIST_URL,
  describeHosts,
  describePermission,
  describeUsage,
} from "../src/report/permission-catalog.ts";

/** A PermissionRow with overridable fields for describeUsage tests. */
function row(over: Partial<PermissionRow> = {}): PermissionRow {
  return {
    permission: "cookies",
    optional: false,
    status: "used",
    usage: [],
    total_usage: 0,
    description: "",
    doc_url: "",
    install_warning: null,
    usage_plain: "",
    ...over,
  };
}

describe("PERMISSION_CATALOG", () => {
  it("every entry has a non-empty summary and an absolute Chrome docs URL", () => {
    for (const [name, info] of Object.entries(PERMISSION_CATALOG)) {
      expect(info.summary.length, name).toBeGreaterThan(0);
      expect(info.doc_url, name).toMatch(/^https:\/\/developer\.chrome\.com\//);
      // install_warning is either null or a non-empty string.
      if (info.install_warning !== null) expect(info.install_warning.length, name).toBeGreaterThan(0);
    }
  });

  it("covers the high-signal permissions the pipeline risk-categorizes", () => {
    for (const p of ["cookies", "scripting", "webRequest", "debugger", "management", "proxy", "nativeMessaging", "tabs", "storage", "downloads"]) {
      expect(PERMISSION_CATALOG[p], p).toBeDefined();
    }
  });
});

describe("describePermission", () => {
  it("returns the catalog entry for a known permission", () => {
    expect(describePermission("cookies").summary).toMatch(/cookies/i);
    expect(describePermission("debugger").install_warning).toMatch(/all your data/i);
  });

  it("falls back safely for an unknown / future permission", () => {
    const info = describePermission("someBrandNewPermission");
    expect(info.doc_url).toBe(PERMISSIONS_LIST_URL);
    expect(info.install_warning).toBeNull();
    expect(info.summary.length).toBeGreaterThan(0);
  });
});

describe("describeUsage", () => {
  it("states explicitly when a permission is declared but unused", () => {
    expect(describeUsage(row({ status: "unused" }))).toMatch(/no use of it was found/i);
  });

  it("states the static limit when usage is undetermined", () => {
    expect(describeUsage(row({ status: "undetermined" }))).toMatch(/could not confirm/i);
  });

  it("translates observed API methods into plain language with a site count", () => {
    const text = describeUsage(
      row({
        status: "used",
        total_usage: 3,
        usage: [
          { path: "bg.js", line: 1, api: "chrome.cookies.getAll" },
          { path: "bg.js", line: 2, api: "chrome.cookies.remove" },
        ],
      }),
    );
    expect(text).toContain("Reads all your cookies");
    expect(text).toContain("deletes cookies");
    expect(text).toContain("(3 call sites)");
  });

  it("collapses unmapped methods into a single generic phrase", () => {
    const text = describeUsage(
      row({ permission: "alarms", status: "used", total_usage: 1, usage: [{ path: "bg.js", line: 1, api: "chrome.alarms.create" }] }),
    );
    expect(text).toContain("Uses the `alarms` API");
    expect(text).toContain("(1 call site)");
  });
});

describe("describeHosts", () => {
  it("flags broad host access", () => {
    expect(describeHosts({ required: ["<all_urls>"], optional: [] })).toMatch(/ALL websites/);
  });
  it("lists specific sites", () => {
    expect(describeHosts({ required: ["https://example.com/*"], optional: [] })).toContain("https://example.com/*");
  });
  it("says when no host access is requested", () => {
    expect(describeHosts({ required: [], optional: [] })).toMatch(/No host access/);
  });
});
