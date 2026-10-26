// scripts/_locale-filter.ts: the local-source English-origin filter that
// export-d1.ts and backfill-catalog.ts both use. The regression this guards
// is real: Chrome's _locales dirs are underscore-separated (en_US, zh_CN) but
// passesEnglishFilter (built for extpose's hyphenated en-US form) missed that
// separator, so en_US-only extensions like Adblock Plus misread as non-English.

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isEnglishOk, localesOnDisk } from "../scripts/_locale-filter.ts";

let root: string;

function withLocales(storeId: string, locales: string[]): void {
  for (const l of locales) mkdirSync(join(root, storeId, "_locales", l), { recursive: true });
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("localesOnDisk / isEnglishOk", () => {
  it("returns [] and passes when there is no _locales dir at all", () => {
    root = mkdtempSync(join(tmpdir(), "locale-"));
    mkdirSync(join(root, "no-locales-ext"), { recursive: true });
    expect(localesOnDisk("no-locales-ext", root)).toEqual([]);
    expect(isEnglishOk("no-locales-ext", root)).toBe(true);
  });

  it("passes Chrome's underscore-separated en_US form (the normalization bug)", () => {
    root = mkdtempSync(join(tmpdir(), "locale-"));
    withLocales("adblock-like", ["en_US"]);
    expect(isEnglishOk("adblock-like", root)).toBe(true);
  });

  it("passes a large underscore-separated locale set that includes en_GB/en_US", () => {
    root = mkdtempSync(join(tmpdir(), "locale-"));
    withLocales("multi-locale", ["ar", "de", "en_GB", "en_US", "ja", "zh_CN"]);
    expect(isEnglishOk("multi-locale", root)).toBe(true);
  });

  it("drops a declared locale set with no English variant", () => {
    root = mkdtempSync(join(tmpdir(), "locale-"));
    withLocales("ru-only", ["ru"]);
    expect(isEnglishOk("ru-only", root)).toBe(false);
  });

  it("drops multiple non-English locales with none in English", () => {
    root = mkdtempSync(join(tmpdir(), "locale-"));
    withLocales("zh-only", ["zh_CN", "zh_TW"]);
    expect(isEnglishOk("zh-only", root)).toBe(false);
  });
});
