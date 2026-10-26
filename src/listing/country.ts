// Country derivation for store-listing addresses (improvement 008b).
//
// CWS trader addresses render the country as the LAST line of the address
// block — usually an ISO 3166-1 alpha-2 code ("DE") or an English country
// name ("United States"). The heuristic only maps what it can recognize and
// returns null otherwise: a wrong country is worse than no country, so we
// never guess (e.g. an unrecognized last line stays null rather than fuzzy-
// matching). The high-risk list is a DATA file, not code — policy reviewable
// and swappable per deployment without touching this module.

import { createRequire } from "node:module";

// JSON data file loaded via createRequire (same pattern schema.ts uses for
// CJS interop) so tsx/vitest and tsc agree without import-attribute churn.
const require = createRequire(import.meta.url);

export interface HighRiskData {
  version: number;
  note: string;
  countries: string[];
}

const HIGH_RISK = require("../pipeline/data/high-risk-countries.json") as HighRiskData;

// All ISO 3166-1 alpha-2 codes (officially assigned), so an explicit
// two-letter country line passes through verbatim but stray abbreviations
// ("ON", "TX") fall out as unrecognized.
const ISO_ALPHA2 = new Set(
  (
    "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
    "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
    "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
    "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT " +
    "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
    "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG " +
    "UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
  ).split(" "),
);

// English names + common variants → alpha-2, covering countries that show up
// in CWS developer addresses. Keys are lowercase with punctuation stripped
// (see normalizeName). Not exhaustive — unrecognized maps to null by design.
const NAME_TO_CODE: Record<string, string> = {
  "united states": "US",
  "united states of america": "US",
  "usa": "US",
  "us": "US",
  "america": "US",
  "united kingdom": "GB",
  "great britain": "GB",
  "uk": "GB",
  "england": "GB",
  "scotland": "GB",
  "wales": "GB",
  "northern ireland": "GB",
  "canada": "CA",
  "germany": "DE",
  "deutschland": "DE",
  "france": "FR",
  "spain": "ES",
  "españa": "ES",
  "portugal": "PT",
  "italy": "IT",
  "italia": "IT",
  "netherlands": "NL",
  "the netherlands": "NL",
  "holland": "NL",
  "belgium": "BE",
  "luxembourg": "LU",
  "switzerland": "CH",
  "austria": "AT",
  "ireland": "IE",
  "denmark": "DK",
  "sweden": "SE",
  "norway": "NO",
  "finland": "FI",
  "iceland": "IS",
  "poland": "PL",
  "polska": "PL",
  "czech republic": "CZ",
  "czechia": "CZ",
  "slovakia": "SK",
  "hungary": "HU",
  "romania": "RO",
  "bulgaria": "BG",
  "greece": "GR",
  "croatia": "HR",
  "slovenia": "SI",
  "serbia": "RS",
  "estonia": "EE",
  "latvia": "LV",
  "lithuania": "LT",
  "ukraine": "UA",
  "belarus": "BY",
  "russia": "RU",
  "russian federation": "RU",
  "turkey": "TR",
  "türkiye": "TR",
  "turkiye": "TR",
  "cyprus": "CY",
  "malta": "MT",
  "israel": "IL",
  "united arab emirates": "AE",
  "uae": "AE",
  "saudi arabia": "SA",
  "qatar": "QA",
  "egypt": "EG",
  "south africa": "ZA",
  "nigeria": "NG",
  "kenya": "KE",
  "morocco": "MA",
  "india": "IN",
  "pakistan": "PK",
  "bangladesh": "BD",
  "sri lanka": "LK",
  "nepal": "NP",
  "china": "CN",
  "peoples republic of china": "CN",
  "prc": "CN",
  "hong kong": "HK",
  "taiwan": "TW",
  "republic of china taiwan": "TW",
  "japan": "JP",
  "south korea": "KR",
  "korea": "KR",
  "republic of korea": "KR",
  "korea republic of": "KR",
  "north korea": "KP",
  "singapore": "SG",
  "malaysia": "MY",
  "indonesia": "ID",
  "thailand": "TH",
  "vietnam": "VN",
  "viet nam": "VN",
  "philippines": "PH",
  "the philippines": "PH",
  "australia": "AU",
  "new zealand": "NZ",
  "mexico": "MX",
  "méxico": "MX",
  "brazil": "BR",
  "brasil": "BR",
  "argentina": "AR",
  "chile": "CL",
  "colombia": "CO",
  "peru": "PE",
  "uruguay": "UY",
  "venezuela": "VE",
  "iran": "IR",
  "islamic republic of iran": "IR",
  "iraq": "IQ",
  "syria": "SY",
  "cuba": "CU",
  "armenia": "AM",
  "georgia": "GE",
  "azerbaijan": "AZ",
  "kazakhstan": "KZ",
  "uzbekistan": "UZ",
  "kyrgyzstan": "KG",
  "moldova": "MD",
  "republic of moldova": "MD",
};

/** Lowercase, strip periods/commas, collapse whitespace — "U.S.A." → "usa". */
function normalizeName(line: string): string {
  return line
    .toLowerCase()
    .replace(/[.,;]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Derive an ISO 3166-1 alpha-2 code from a listing address. Last-line
 * heuristic: (1) the whole last line as a country name/variant, (2) the whole
 * last line as an explicit alpha-2 code, (3) the last token as an alpha-2
 * code (e.g. "Berlin 10969 DE"). Anything else → null, never guessed.
 */
export function deriveCountry(address: string | null): string | null {
  if (address === null) return null;
  const lines = address
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const last = lines[lines.length - 1];
  if (last === undefined) return null;

  const byName = NAME_TO_CODE[normalizeName(last)];
  if (byName !== undefined) return byName;

  const stripped = last.replace(/[.,;]+$/, "").trim();
  // Whole-line code (e.g. a standalone "DE" line) — the deliberate form; a line
  // that IS just a 2-letter code is a country code, not a city's state suffix.
  if (/^[A-Z]{2}$/.test(stripped) && ISO_ALPHA2.has(stripped)) return stripped;

  // Last-token code (e.g. "Berlin 10969 DE"). Ambiguous: dozens of US state
  // postal codes collide with ISO alpha-2 (CA=California/Canada, DE=Delaware/
  // Germany, IN=Indiana/India, GA=Georgia/Gabon …). The distinguishing signal
  // is the US "City, ST" convention: a 2-letter code that directly follows a
  // comma is a state suffix, not a country, so suppress it (a real US country
  // is named in full — "USA"/"United States" — via the NAME_TO_CODE path).
  // The international postal-then-code form ("Berlin 10969 DE", no comma before
  // the code) is still accepted.
  const tokens = stripped.split(/\s+/);
  const lastToken = tokens[tokens.length - 1] ?? "";
  if (/^[A-Z]{2}$/.test(lastToken) && ISO_ALPHA2.has(lastToken)) {
    const looksLikeUsCityState = US_STATE_CODES.has(lastToken) && /,\s*[A-Z]{2}$/.test(stripped);
    if (!looksLikeUsCityState) return lastToken;
  }

  return null;
}

// US state + territory + DC postal abbreviations that collide with ISO alpha-2
// country codes. Used only to suppress the ambiguous last-token heuristic.
const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN", "IA",
  "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT",
  "VA", "WA", "WV", "WI", "WY", "DC", "PR", "VI", "GU", "AS", "MP",
]);

/**
 * Policy check against the high-risk data file. Three-valued on purpose:
 * null country ⇒ null (unknown), not false — "we couldn't tell" must never
 * read as "not high-risk".
 */
export function isHighRiskCountry(code: string | null, data: HighRiskData = HIGH_RISK): boolean | null {
  if (code === null) return null;
  const upper = code.toUpperCase();
  return data.countries.some((c) => c.toUpperCase() === upper);
}
