// Submission input validation: accept a bare 32-char [a-p] extension ID or a
// Chrome Web Store detail URL, reject everything else at the edge (plan §9).
// Same extraction rule as scripts/fetch-crx.ts: match the LAST 32-char a–p run
// so a store slug containing such a run can't shadow the real ID.

const MAX_INPUT_LENGTH = 2048;

/** The extracted store id, or null when the input is not a valid ID/URL. */
export function parseStoreInput(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed === "" || trimmed.length > MAX_INPUT_LENGTH) return null;
  // A URL must at least look like a Web Store link or a bare ID — refuse
  // arbitrary text that merely embeds an ID-shaped run.
  const isBareId = /^[a-p]{32}$/.test(trimmed);
  const isStoreUrl = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com)\//.test(trimmed);
  if (!isBareId && !isStoreUrl) return null;
  const matches = trimmed.match(/[a-p]{32}/g);
  return matches && matches.length > 0 ? matches[matches.length - 1]! : null;
}
