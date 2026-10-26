import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localizeManifestIdentity } from "../src/pipeline/i18n.ts";

/** Build a throwaway unpacked-extension dir with a manifest + locale messages. */
function fixture(manifest: Record<string, unknown>, locales: Record<string, Record<string, { message: string }>>): string {
  const root = mkdtempSync(join(tmpdir(), "i18n-"));
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest));
  for (const [locale, messages] of Object.entries(locales)) {
    mkdirSync(join(root, "_locales", locale), { recursive: true });
    writeFileSync(join(root, "_locales", locale, "messages.json"), JSON.stringify(messages));
  }
  return root;
}

describe("localizeManifestIdentity", () => {
  it("resolves __MSG_*__ name/short_name from the default locale", () => {
    const m: Record<string, unknown> = { name: "__MSG_appName__", short_name: "__MSG_short__", default_locale: "en" };
    const root = fixture(m, { en: { appName: { message: "Real Name" }, short: { message: "Real" } } });
    localizeManifestIdentity(root, m);
    expect(m.name).toBe("Real Name");
    expect(m.short_name).toBe("Real");
  });

  it("looks message keys up case-insensitively (Chrome semantics)", () => {
    const m: Record<string, unknown> = { name: "__MSG_appName__", default_locale: "en" };
    const root = fixture(m, { en: { APPNAME: { message: "Cased Name" } } });
    localizeManifestIdentity(root, m);
    expect(m.name).toBe("Cased Name");
  });

  it("falls back to en, then the first locale, when default_locale is absent/unmatched", () => {
    const m: Record<string, unknown> = { name: "__MSG_appName__" }; // no default_locale
    const root = fixture(m, { en: { appName: { message: "From EN" } } });
    localizeManifestIdentity(root, m);
    expect(m.name).toBe("From EN");
  });

  it("does NOT touch description (kept raw to preserve fixture stability)", () => {
    const m: Record<string, unknown> = { name: "__MSG_appName__", description: "__MSG_desc__", default_locale: "en" };
    const root = fixture(m, { en: { appName: { message: "Real Name" }, desc: { message: "Real desc" } } });
    localizeManifestIdentity(root, m);
    expect(m.name).toBe("Real Name");
    expect(m.description).toBe("__MSG_desc__");
  });

  it("leaves the value untouched when the key, locale, or _locales tree is missing", () => {
    // missing key
    const m1: Record<string, unknown> = { name: "__MSG_missing__", default_locale: "en" };
    const r1 = fixture(m1, { en: { other: { message: "x" } } });
    localizeManifestIdentity(r1, m1);
    expect(m1.name).toBe("__MSG_missing__");

    // no _locales at all
    const root = mkdtempSync(join(tmpdir(), "i18n-"));
    const m2: Record<string, unknown> = { name: "__MSG_appName__", default_locale: "en" };
    writeFileSync(join(root, "manifest.json"), JSON.stringify(m2));
    localizeManifestIdentity(root, m2);
    expect(m2.name).toBe("__MSG_appName__");
  });

  it("is a no-op for a plain (non-placeholder) name", () => {
    const m: Record<string, unknown> = { name: "Plain Name", default_locale: "en" };
    const root = fixture(m, { en: { appName: { message: "unused" } } });
    localizeManifestIdentity(root, m);
    expect(m.name).toBe("Plain Name");
  });
});
