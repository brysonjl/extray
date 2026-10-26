// Shared tolerant JSON extraction for LLM verdicts. A reasoning model may emit
// scratch-pad JSON before the result object, so the old greedy /\{[\s\S]*\}/
// (first "{" to last "}") captured everything between two objects and failed to
// parse. The replacement flat-object regex /\{[^{}]*\}/ then broke the opposite
// case: a verdict whose rationale quotes code (e.g. `getAll({})`) contains braces
// INSIDE a string value, which the regex can't span — it matched only the inner
// `{}` and missed the real object. So we scan for balanced top-level objects with
// a string-literal-aware walker (braces inside quotes don't count), collect each,
// and let the caller pick the last one carrying the field it needs.

/** All parseable top-level JSON objects in `text`, in order of appearance. */
export function extractJsonObjects(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1)) as unknown;
          if (obj && typeof obj === "object" && !Array.isArray(obj)) out.push(obj as Record<string, unknown>);
        } catch {
          /* skip balanced spans that aren't valid JSON */
        }
        start = -1;
      }
    }
  }
  return out;
}

/** Parse one balanced top-level object starting at `text[start] === "{"`, or null. */
function parseObjectAt(text: string, start: number): Record<string, unknown> | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1)) as unknown;
          if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj as Record<string, unknown>;
        } catch {
          /* balanced but not valid JSON */
        }
        return null;
      }
    }
  }
  return null;
}

/**
 * All objects containing `key`, in order of appearance. When the balanced walk
 * finds none — a stray unmatched `{` in judge prose leaves the walker stuck at
 * depth>0 and swallows the real object — fall back to a targeted rescue scan:
 * try a parse from each `{"<key>"` occurrence to its matching close.
 */
export function objectsWith(text: string, key: string): Array<Record<string, unknown>> {
  const objs = extractJsonObjects(text).filter((o) => key in o);
  if (objs.length > 0) return objs;

  const rescued: Array<Record<string, unknown>> = [];
  const re = new RegExp(`\\{\\s*"${key}"`, "g");
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const obj = parseObjectAt(text, m.index);
    if (obj && key in obj) rescued.push(obj);
  }
  return rescued;
}

/** The last extracted object that contains `key`, or null. */
export function lastObjectWith(text: string, key: string): Record<string, unknown> | null {
  const objs = objectsWith(text, key);
  return objs.length > 0 ? objs[objs.length - 1]! : null;
}
