export type FindingProseBlock =
  | { type: "paragraph"; text: string }
  | { type: "ordered-list"; items: string[] };

type Span = { start: number; end: number };

/** Lists inside quoted source or backticks are evidence, not prose structure. */
function quotedSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char !== "`" && char !== '"' && char !== "'" && char !== "“" && char !== "‘") continue;
    // Apostrophes in words must not consume the rest of the explanation.
    if (char === "'" && /[\p{L}\p{N}]/u.test(text[i - 1] ?? "")) continue;
    let delimiter = char === "“" ? "”" : char === "‘" ? "’" : char;
    if (char === "`") {
      while (text[i + delimiter.length] === "`") delimiter += "`";
    }
    let end = text.indexOf(delimiter, i + delimiter.length);
    while (end !== -1 && text[end - 1] === "\\") end = text.indexOf(delimiter, end + delimiter.length);
    // An unfinished code span also stays untouched. Ordinary unmatched quotes
    // do not hide subsequent prose (for example an apostrophe in a name).
    if (end === -1 && char !== "`") continue;
    const spanEnd = end === -1 ? text.length : end + delimiter.length;
    spans.push({ start: i, end: spanEnd });
    i = spanEnd - 1;
  }
  return spans;
}

function isQuoted(index: number, spans: Span[]): boolean {
  return spans.some((span) => index >= span.start && index < span.end);
}

/** Add visual breathing room to long legacy prose without rewriting it.
 * Intl supplies sentence boundaries; source literals and balanced expressions
 * remain indivisible. Ambiguous or mostly quoted source stays unchanged.
 */
export function splitFindingParagraph(text: string): string[] {
  if (text.length <= 800 || /[\r\n]/.test(text)) return [text];
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") return [text];
  const spans = quotedSpans(text);
  if (spans.reduce((length, span) => length + span.end - span.start, 0) > text.length * 0.45) return [text];

  const sentenceEnds = new Set(
    [...new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)]
      .map((sentence) => sentence.index + sentence.segment.length)
      // Segmenter can see a sentence boundary at '?' inside a URL. Only
      // existing whitespace can become a new visual paragraph boundary.
      .filter((end) => end < text.length && /\s/.test(text[end - 1] ?? "")),
  );
  const safeEnds: number[] = [];
  const stack: string[] = [];
  const opening: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  for (let i = 0; i < text.length; i++) {
    if (isQuoted(i, spans)) continue;
    const char = text[i]!;
    if (opening[char]) stack.push(opening[char]!);
    else if (char === ")" || char === "]" || char === "}") {
      if (stack.pop() !== char) return [text];
    }
    if (!stack.length && sentenceEnds.has(i + 1)) safeEnds.push(i + 1);
  }
  if (stack.length || !safeEnds.length) return [text];

  const chunks: string[] = [];
  let start = 0;
  while (text.length - start > 700) {
    const candidates = safeEnds.filter((end) => end - start >= 300 && text.length - end >= 300);
    if (!candidates.length) break;
    // Aim for 500 characters; a long indivisible sentence can exceed this.
    const end = candidates.reduce((best, candidate) => (
      Math.abs(candidate - start - 500) < Math.abs(best - start - 500) ? candidate : best
    ));
    const chunk = text.slice(start, end).trimEnd();
    chunks.push(start ? chunk.trimStart() : chunk);
    start = end;
  }
  if (!chunks.length) return [text];
  chunks.push(text.slice(start).trimStart());
  return chunks;
}

function inlineBlocks(text: string): FindingProseBlock[] {
  const spans = quotedSpans(text);
  const markers = [...text.matchAll(/(?:^|\s)\(([1-9]\d*)\)(?:[ \t]+|$)/g)]
    .map((match) => ({
      start: match.index + match[0].indexOf("("),
      end: match.index + match[0].length,
      number: Number(match[1]),
    }))
    .filter((marker) => !isQuoted(marker.start, spans));

  // Require a complete sequence and sentence/list boundaries. Parenthesized
  // counts, citations, call arguments, and partial numbering remain text.
  if (markers.length < 2 || markers.some((marker, index) => marker.number !== index + 1)) {
    return [{ type: "paragraph", text }];
  }
  if (markers.some((marker) => {
    const preceding = text.slice(0, marker.start).trimEnd();
    return preceding.length > 0 && !/[.!?:;]$/.test(preceding);
  })) return [{ type: "paragraph", text }];

  const items = markers.map((marker, index) => text.slice(marker.end, markers[index + 1]?.start).trim());
  if (items.some((item) => !item)) return [{ type: "paragraph", text }];
  const intro = text.slice(0, markers[0]!.start).trim();
  return [
    ...(intro ? [{ type: "paragraph" as const, text: intro }] : []),
    { type: "ordered-list", items },
  ];
}

/** Format only explicit structure; never summarize, split sentences, or emit HTML.
 * Single newlines remain in paragraph text for a pre-wrap/pre-line renderer.
 */
export function parseFindingProse(value: string): FindingProseBlock[] {
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (!text) return [];
  const blocks: FindingProseBlock[] = [];
  const spans = quotedSpans(text);
  const lines = text.split("\n");
  let offset = 0;
  let paragraph: string[] = [];
  const flushParagraph = () => {
    const prose = paragraph.join("\n").trim();
    if (prose) blocks.push(...inlineBlocks(prose));
    paragraph = [];
  };
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (!line.trim() && !isQuoted(offset, spans)) {
      flushParagraph();
      offset += line.length + 1;
      i++;
      continue;
    }
    const run: { number: number; text: string }[] = [];
    let endOffset = offset;
    let end = i;
    while (end < lines.length && !isQuoted(endOffset, spans)) {
      const match = /^[ \t]{0,3}([1-9]\d*)\.(?:[ \t]+(.*)|$)/.exec(lines[end]!);
      if (!match) break;
      run.push({ number: Number(match[1]), text: match[2] ?? "" });
      endOffset += lines[end]!.length + 1;
      end++;
    }
    if (run.length >= 2 && run.every((item, index) => item.number === index + 1 && item.text.trim())) {
      flushParagraph();
      blocks.push({ type: "ordered-list", items: run.map((item) => item.text) });
      offset = endOffset;
      i = end;
    } else {
      // Consume an invalid run together so its tail cannot become a new list.
      const length = Math.max(run.length, 1);
      paragraph.push(...lines.slice(i, i + length));
      for (let j = i; j < i + length; j++) offset += lines[j]!.length + 1;
      i += length;
    }
  }
  flushParagraph();
  return blocks;
}
