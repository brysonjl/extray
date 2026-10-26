// Chrome i18n resolution for manifest identity fields. A manifest may declare
// localizable fields as `__MSG_key__` placeholders (e.g. `"name": "__MSG_appName__"`);
// the real text lives in `_locales/<default_locale>/messages.json`. Without this,
// reports and the bake-off DB show the raw placeholder instead of the extension's
// actual name.
//
// Scope is deliberately narrow: only the IDENTITY fields `name` and `short_name`
// are resolved. `description` is intentionally left as-is — the labeled corpus
// localizes its descriptions, and that text feeds the LLM prompt (and thus the
// committed fixture keys); resolving it would change prompts and break fixtures.
// Identity fields are display-only here and the corpus never localizes them, so
// resolving them is fixture-neutral.
//
// Tolerant by construction: anything unexpected (no _locales, missing key,
// malformed JSON) leaves the value untouched — it never throws.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** A manifest field is localized iff its WHOLE value is a single placeholder.
 *  Chrome also substitutes placeholders mid-string, but manifest identity fields
 *  are whole-field by convention; whole-match keeps resolution unambiguous. */
const PLACEHOLDER_RE = /^__MSG_([A-Za-z0-9_@]+)__$/;

const LOCALIZED_FIELDS = ["name", "short_name"] as const;

/** Load `_locales/<locale>/messages.json` as a lowercased key → message map.
 *  Chrome looks message names up case-insensitively, so keys are lowercased. */
function loadMessages(root: string, locale: string): Map<string, string> | null {
  const path = join(root, "_locales", locale, "messages.json");
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const out = new Map<string, string>();
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const msg = entry && typeof entry === "object" ? (entry as Record<string, unknown>).message : undefined;
    if (typeof msg === "string") out.set(key.toLowerCase(), msg);
  }
  return out;
}

/** Pick the locale to resolve against: the manifest's default_locale, else `en`,
 *  else the first locale directory present. Null when there is no _locales tree. */
function pickLocale(root: string, manifest: Record<string, unknown>): string | null {
  const declared = typeof manifest.default_locale === "string" ? manifest.default_locale : null;
  if (declared && existsSync(join(root, "_locales", declared))) return declared;
  const localesDir = join(root, "_locales");
  if (!existsSync(localesDir)) return null;
  if (existsSync(join(localesDir, "en"))) return "en";
  try {
    const first = readdirSync(localesDir).find((d) => statSync(join(localesDir, d)).isDirectory());
    return first ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve `__MSG_*__` placeholders in the manifest's identity fields IN PLACE,
 * using the unpacked extension's `_locales`. A no-op when no field is a
 * placeholder, or when the locale/key cannot be found.
 */
export function localizeManifestIdentity(root: string, manifest: Record<string, unknown>): void {
  // Cheap pre-check: only touch the filesystem if something actually needs it.
  const needs = LOCALIZED_FIELDS.some((f) => typeof manifest[f] === "string" && PLACEHOLDER_RE.test(manifest[f] as string));
  if (!needs) return;

  const locale = pickLocale(root, manifest);
  if (!locale) return;
  const messages = loadMessages(root, locale);
  if (!messages) return;

  for (const field of LOCALIZED_FIELDS) {
    const value = manifest[field];
    if (typeof value !== "string") continue;
    const m = PLACEHOLDER_RE.exec(value);
    if (!m) continue;
    const resolved = messages.get(m[1]!.toLowerCase());
    if (resolved !== undefined) manifest[field] = resolved;
  }
}
