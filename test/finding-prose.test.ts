import { describe, expect, it, vi } from "vitest";
import { parseFindingProse, splitFindingParagraph } from "../web/explorer/src/components/finding-prose.ts";

describe("finding prose formatting", () => {
  it("preserves paragraphs and single line breaks without inventing sentence boundaries", () => {
    expect(parseFindingProse("First sentence. Second sentence.\r\nSame paragraph.\r\n\r\nAnother paragraph."))
      .toEqual([
        { type: "paragraph", text: "First sentence. Second sentence.\nSame paragraph." },
        { type: "paragraph", text: "Another paragraph." },
      ]);
    expect(parseFindingProse(" \n\t ")).toEqual([]);
  });

  it("separates an explicit inline mechanism sequence while retaining technical wording and final caveats", () => {
    const first = "page.js (MAIN world, <all_urls>, document_start) captures URLs (page.js:1).";
    const second = "content.js sends {type:'pip:page-view', url: location.href} (content.js:121–127).";
    const third = "POSTs to https://pipextension.com/api/events/batch. No cookies or page DOM are sent.";
    expect(parseFindingProse(`End-to-end observation. (1) ${first} (2) ${second} (3) ${third}`)).toEqual([
      { type: "paragraph", text: "End-to-end observation." },
      { type: "ordered-list", items: [first, second, third] },
    ]);
  });

  it("supports an inline list with no introductory paragraph", () => {
    expect(parseFindingProse("(1) Reads URLs; (2) Stores them."))
      .toEqual([{ type: "ordered-list", items: ["Reads URLs;", "Stores them."] }]);
  });

  it("separates consecutive line-start steps from surrounding paragraphs", () => {
    expect(parseFindingProse("Observed flow:\n1. Reads URLs (core.js:8).\n2. Sends them to /api.\nScope remains top-frame only."))
      .toEqual([
        { type: "paragraph", text: "Observed flow:" },
        { type: "ordered-list", items: ["Reads URLs (core.js:8).", "Sends them to /api."] },
        { type: "paragraph", text: "Scope remains top-frame only." },
      ]);
  });

  it.each([
    "There are (1) retained cookie and (2) permitted hosts.",
    "Evidence (1) confirms the call. Evidence (2) confirms the sink.",
    "See source (1), (2), and (3).",
    "(1) First observation. (3) Third observation.",
    "(1) First observation. (2) Second observation. (2) Duplicate numbering.",
    "(1) First observation. (2) Second observation. (3)",
    "(1) An isolated parenthesized number.",
    "1. First observation.\n3. Third observation.",
    "2. Second observation.\n3. Third observation.",
    "1. First.\n2. Second.\n4. Fourth.",
    "1. First.\n2. Second.\n3.",
    "Version 1.2.3 uses 0.25 seconds and https://example.test/a(1)?count=2; core.js:219–290.",
    "Calls setTimeout(1), then setTimeout(2), with a numeric argument.",
  ])("leaves ambiguous or nonsequential numbering unchanged: %s", (text) => {
    expect(parseFindingProse(text)).toEqual([{ type: "paragraph", text }]);
  });

  it.each([
    "`Flow: (1) getURL(). (2) sendURL().`",
    '"Flow: (1) getURL(). (2) sendURL()."',
    "'Flow: (1) getURL(). (2) sendURL().'",
    "```text\n1. literal first\n2. literal second\n\nPreserve this blank line.\n```",
    "`unfinished code\n1. literal first\n2. literal second",
  ])("does not interpret numbering within quoted source: %s", (text) => {
    expect(parseFindingProse(text)).toEqual([{ type: "paragraph", text }]);
  });

  it("does not mistake a contraction for an open source quote", () => {
    expect(parseFindingProse("The extension's flow: (1) Reads URLs. (2) Sends URLs."))
      .toEqual([
        { type: "paragraph", text: "The extension's flow:" },
        { type: "ordered-list", items: ["Reads URLs.", "Sends URLs."] },
      ]);
  });

  it("preserves source strings containing nested numbering inside real list items", () => {
    expect(parseFindingProse('(1) Reads "Flow: (1) literal. (2) literal.". (2) Sends the value.'))
      .toEqual([{ type: "ordered-list", items: ['Reads "Flow: (1) literal. (2) literal.".', "Sends the value."] }]);
  });

  it("returns HTML-like evidence as unchanged text", () => {
    const text = '<all_urls> and <script>alert("value")</script> are recorded strings.';
    expect(parseFindingProse(text)).toEqual([{ type: "paragraph", text }]);
  });
});

describe("long finding paragraph layout", () => {
  const sentence = "The background process records the complete page URL and retains its original query parameters until the next upload completes.";
  const longProse = Array.from({ length: 14 }, () => sentence).join(" ");

  function expectFaithfulChunks(text: string) {
    const chunks = splitFindingParagraph(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Only whitespace at the new visual paragraph boundaries may change.
    expect(chunks.join(" ").replace(/\s+/g, " ")).toBe(text.replace(/\s+/g, " "));
    return chunks;
  }

  it("groups long prose near the reading target without rewriting any sentences", () => {
    const chunks = expectFaithfulChunks(longProse);
    expect(chunks.every((chunk) => chunk.length >= 300 && chunk.length <= 650)).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith("upload completes."))).toBe(true);
  });

  it("preserves short prose, existing newlines, and an indivisible long sentence", () => {
    for (const text of [sentence, `${longProse}\nAnother line.`, "An indivisible statement " + "continues ".repeat(110)]) {
      expect(splitFindingParagraph(text)).toEqual([text]);
    }
  });

  it("falls back to unchanged text when sentence segmentation is unavailable", () => {
    try {
      for (const replacement of [undefined, {}]) {
        vi.stubGlobal("Intl", replacement);
        expect(splitFindingParagraph(longProse)).toEqual([longProse]);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a short final caveat with its preceding sentences", () => {
    const text = `${longProse} No cookies are sent.`;
    const chunks = expectFaithfulChunks(text);
    expect(chunks.at(-1)).toContain(sentence);
    expect(chunks.at(-1)).toMatch(/No cookies are sent\.$/);
    expect(chunks.at(-1)!.length).toBeGreaterThan(300);
  });

  it("keeps URL paths, file citations, decimal values, and versions intact", () => {
    const technical = "The endpoint is https://pipextension.com/api/events/batch?schema=1.2 and the retry delay is 0.25 seconds (core.js:206–213, content.js:121–127).";
    const text = Array.from({ length: 10 }, () => technical).join(" ");
    const chunks = expectFaithfulChunks(text);
    for (const chunk of chunks) {
      expect(chunk).toMatch(/^The endpoint is https:/);
      expect(chunk).toMatch(/content\.js:121–127\)\.$/);
    }
    expect(chunks.join(" ")).toBe(text);
  });

  it("does not split quoted or backticked source at its internal sentence boundaries", () => {
    for (const quote of ['"', "`", "“"]) {
      const close = quote === "“" ? "”" : quote;
      const literal = `${quote}Literal sentence one. Literal sentence two. Literal sentence three.${close}`;
      const text = `${sentence} ${sentence} The captured string is ${literal} and is sent unchanged. ${longProse}`;
      const chunks = expectFaithfulChunks(text);
      expect(chunks.some((chunk) => chunk.includes(literal))).toBe(true);
    }
  });

  it("does not break a citation or balanced expression containing several sentences", () => {
    const expression = "(core.js:206–213. See also [content.js:121–127. Capture calls {url: location.href}.] The references describe one flow.)";
    const text = `${sentence} ${sentence} Evidence ${expression} supports this observation. ${longProse}`;
    expect(expectFaithfulChunks(text).some((chunk) => chunk.includes(expression))).toBe(true);
  });

  it.each(["(", "[", "{", ")", "}"])("leaves ambiguous unbalanced expressions unchanged: %s", (delimiter) => {
    const text = `${sentence} ${delimiter} ${longProse}`;
    expect(splitFindingParagraph(text)).toEqual([text]);
  });

  it("leaves source-heavy and unterminated backtick text unchanged", () => {
    const literal = `\`${longProse}\``;
    expect(splitFindingParagraph(`Source value: ${literal}. No other data is sent.`)).toEqual([`Source value: ${literal}. No other data is sent.`]);
    const unfinished = `${sentence} \`${longProse}`;
    expect(splitFindingParagraph(unfinished)).toEqual([unfinished]);
  });
});
