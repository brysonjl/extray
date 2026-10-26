// HTML → DeveloperListing parser for chromewebstore.google.com/detail pages
// (improvement 008b). The store serves the DSA developer/trader section
// server-side, so a plain GET carries everything we need — no headless
// browser, no API.
//
// No HTML parser dependency (repo rule: lean deps) — string/regex scanning
// anchored on signals that survive Google's class-name churn:
//   - the row-label texts ("Developer", "Offered by", "Overview") rather than
//     class names like QDHp8e;
//   - the DSA trader sentences ("has [not] identified itself as a trader"),
//     which are legally mandated copy and the most stable text on the page;
//   - og:/meta tags in <head> for the description fallback and for telling a
//     real listing apart from the store's empty-shell page (a removed or
//     never-existing ID returns HTTP 200 with og:url pointing at the store
//     root — og:url containing the extension ID is the availability signal).
//
// Failure posture: a parse miss on any individual field yields null (the
// page changed, the listing simply omits it) — never a throw and never a
// guess. Only empty/non-HTML input throws, because that means the caller fed
// us something that was never a store page.

import { deriveCountry } from "./country.ts";
import { ListingError, unavailableListing, type DeveloperListing } from "./types.ts";

// ---- text utilities ----

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

/** Decode numeric (&#39; &#x27;) and common named (&amp; …) HTML entities. */
export function decodeEntities(s: string): string {
  // Single pass: "&amp;lt;" decodes to the literal text "&lt;", as a browser would.
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const cp = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(cp) ? whole : safeFromCodePoint(cp, whole);
    }
    if (body.startsWith("#")) {
      const cp = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(cp) ? whole : safeFromCodePoint(cp, whole);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function safeFromCodePoint(cp: number, fallback: string): string {
  try {
    return String.fromCodePoint(cp);
  } catch {
    return fallback; // out-of-range numeric entity — keep the literal text
  }
}

/**
 * Tags → plain text. Block-level closes and <br> become newlines so that
 * visually distinct rows ("eyeo GmbH" / "Prinzenstr. 34" / "Website") stay
 * distinct lines; <script>/<style>/<svg> subtrees are dropped wholesale
 * (icon paths and JS blobs are not listing text).
 */
export function stripTags(html: string): string {
  let s = html;
  s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ");
  s = s.replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ");
  s = s.replace(/<svg\b[\s\S]*?<\/svg\s*>/gi, " ");
  s = s.replace(/<\/p\s*>/gi, "\n\n");
  s = s.replace(/<(?:br|hr)\s*\/?\s*>/gi, "\n");
  s = s.replace(/<\/(?:div|li|ul|ol|section|article|h[1-6]|summary|details|a|tr|td|th|table)\s*>/gi, "\n");
  s = s.replace(/<[^>]*>/g, "");
  s = decodeEntities(s);
  // Normalize: collapse intra-line whitespace, trim line ends, cap blank runs.
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function textLines(html: string): string[] {
  return stripTags(html)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** <meta property|name="key" content="…"> — tolerant of attribute order. */
function metaContent(html: string, key: string): string | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const contentAfter = new RegExp(`<meta\\b[^>]*\\b(?:property|name)\\s*=\\s*"${k}"[^>]*\\bcontent\\s*=\\s*"([^"]*)"`, "i");
  const contentBefore = new RegExp(`<meta\\b[^>]*\\bcontent\\s*=\\s*"([^"]*)"[^>]*\\b(?:property|name)\\s*=\\s*"${k}"`, "i");
  const m = contentAfter.exec(html) ?? contentBefore.exec(html);
  if (!m) return null;
  const value = decodeEntities(m[1]!).trim();
  return value.length > 0 ? value : null;
}

// ---- section extraction ----

// DSA statements rendered verbatim on every listing; check the negated form
// first ("has not identified…" contains nothing of "has identified…" but
// belt-and-braces against future copy edits).
const NON_TRADER_SENTENCE = "has not identified itself as a trader";
const TRADER_SENTENCE = "has identified itself as a trader";

/** Rows in the developer block that are field labels, not name/address text. */
const FIELD_LABEL = /^(?:website|email|phone)$/i;

const EMAIL_LINE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']{2,}$/;

/** The HTML of the "Developer" row (label div through its enclosing </li>). */
function developerBlock(html: string): string | null {
  const label = />\s*Developer\s*<\/div>/.exec(html);
  if (!label) return null;
  const start = label.index + label[0].length;
  const end = html.indexOf("</li>", start);
  return html.slice(start, end === -1 ? Math.min(start + 20_000, html.length) : end);
}

/** Anchor whose visible text is "Website" → its href (the developer site). */
function websiteFrom(block: string): string | null {
  const anchorRe = /<a\s[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(block)) !== null) {
    const text = stripTags(m[2]!);
    if (/^website$/i.test(text)) {
      const href = decodeEntities(m[1]!).trim();
      return href.length > 0 ? href : null;
    }
  }
  return null;
}

/** mailto: anchor (historical structure) or a bare email text line. */
function emailFrom(block: string, lines: string[]): string | null {
  const mailto = /<a\s[^>]*\bhref\s*=\s*"mailto:([^"?]+)[^"]*"/i.exec(block);
  if (mailto) {
    const addr = decodeEntities(mailto[1]!).trim();
    if (addr.length > 0) return addr;
  }
  return lines.find((l) => EMAIL_LINE.test(l)) ?? null;
}

/** The "Offered by" row from the Details list (non-trader listings carry the
 *  developer display name here instead of in the DSA block). */
function offeredBy(html: string): string | null {
  const m = />\s*Offered by\s*<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>/.exec(html);
  if (!m) return null;
  const name = stripTags(m[1]!);
  return name.length > 0 ? name : null;
}

/** Overview section text (the full listing description, server-rendered). */
function overviewText(html: string): string | null {
  const heading = />\s*Overview\s*<\//.exec(html);
  if (!heading) return null;
  // Slice from just past the anchoring ">" so tag-stripping sees well-formed
  // markup ("Overview</div>…"), then drop the heading's own text line.
  const start = heading.index + 1;
  const end = html.indexOf("</section>", start);
  const section = html.slice(start, end === -1 ? Math.min(start + 100_000, html.length) : end);
  const text = stripTags(section).replace(/^Overview\s*\n?/i, "").trim();
  return text.length > 0 ? text : null;
}

// ---- main entry point ----

export function parseListingHtml(html: string, extensionId: string, fetchedAt: string): DeveloperListing {
  if (typeof html !== "string" || html.trim().length === 0) {
    throw new ListingError("listing HTML is empty — nothing to parse");
  }
  if (!/<[a-z!/]/i.test(html)) {
    throw new ListingError("input does not look like HTML (no tags found) — refusing to parse");
  }

  // Availability: a real detail page's og:url ends with the extension ID; the
  // store answers unknown/removed IDs with HTTP 200 and an og:url pointing at
  // the store root. Listing-specific anchors rescue a page with og: stripped.
  const ogUrl = metaContent(html, "og:url");
  const hasNonTrader = html.includes(NON_TRADER_SENTENCE);
  const hasTrader = !hasNonTrader && html.includes(TRADER_SENTENCE);
  const block = developerBlock(html);
  const available =
    (ogUrl !== null && ogUrl.toLowerCase().includes(extensionId.toLowerCase())) ||
    block !== null ||
    hasNonTrader ||
    hasTrader;
  if (!available) return unavailableListing(extensionId, fetchedAt);

  let name: string | null = null;
  let address: string | null = null;
  let email: string | null = null;
  let website: string | null = null;

  if (block !== null) {
    const lines = textLines(block);
    website = websiteFrom(block);
    email = emailFrom(block, lines);

    // Trader listings render "Name\nstreet\ncity\nCC" before the first field
    // label; non-trader listings start straight at "Email".
    let firstLabel = lines.findIndex((l) => FIELD_LABEL.test(l));
    if (firstLabel === -1) firstLabel = lines.length;
    const preLabel = lines.slice(0, firstLabel).filter((l) => !EMAIL_LINE.test(l));
    if (preLabel.length > 0) {
      name = preLabel[0]!;
      address = preLabel.length > 1 ? preLabel.slice(1).join("\n") : null;
    }
  }

  // Non-trader pages put the display name in the Details list instead.
  if (name === null) name = offeredBy(html);

  const description = overviewText(html) ?? metaContent(html, "og:description") ?? metaContent(html, "description");

  const isTrader: boolean | null = hasNonTrader ? false : hasTrader ? true : null;

  return {
    extension_id: extensionId,
    fetched_at: fetchedAt,
    source: "chrome-web-store",
    developer: { name, address, email, website, is_trader: isTrader },
    description,
    country: deriveCountry(address),
  };
}
