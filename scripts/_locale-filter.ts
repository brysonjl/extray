// Shared local-source English-origin filter. discover.ts's --exclude-non-english
// derives a `languages` signal by scraping the extpose detail page's "Languages"
// row BEFORE an extension enters the corpus. For extensions already analyzed,
// the same signal is free to read locally: the unpacked source lives under
// example_crxs/<store-id>/ (fetch-crx's output dir), and Chrome extensions
// declare their locales as _locales/<code>/ subdirectories. Reusing
// passesEnglishFilter keeps both paths' "English or unknown" semantics identical.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { passesEnglishFilter } from "./discover.ts";

const SOURCE_ROOT = "example_crxs";

/** Locale codes declared in an already-fetched extension's _locales/ dir.
 *  [] when absent — same "unknown, don't penalize" meaning discover.ts uses. */
export function localesOnDisk(storeId: string, root: string = SOURCE_ROOT): string[] {
  const dir = join(root, storeId, "_locales");
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((d) => {
      try {
        return statSync(join(dir, d)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

/** Chrome's _locales directories are underscore-separated (en_US, zh_CN);
 *  passesEnglishFilter expects extpose's hyphenated form (en-US) — normalize
 *  before delegating, or every en_US-only extension misreads as non-English. */
export function isEnglishOk(storeId: string, root: string = SOURCE_ROOT): boolean {
  const normalized = localesOnDisk(storeId, root).map((l) => l.replace(/_/g, "-"));
  return passesEnglishFilter(normalized);
}
