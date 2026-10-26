import { describe, it, expect } from "vitest";
import { analyze } from "../src/pipeline/index.ts";

const pack = (sample: string) => analyze(`corpus/${sample}/extension`, { analyzedAt: "2026-01-01T00:00:00Z" });
const kinds = (p: ReturnType<typeof analyze>, bucket: "high" | "medium") =>
  (p.summary_signals[bucket] as Array<{ kind?: string }>).map((s) => s.kind);

describe("summary_signals — binary-asset abuse", () => {
  it("promotes a hidden-payload image to high when a script reads it via a literal getURL()", () => {
    const p = pack("mutant-i-png-steganography");
    expect(kinds(p, "high")).toContain("binary-asset-read-as-data");

    const sig = (p.summary_signals.high as Array<Record<string, unknown>>).find(
      (s) => s.kind === "binary-asset-read-as-data",
    )!;
    expect(sig.path).toBe("img/icon_128x128.png");
    expect(sig.read_via).toBe("chrome.runtime.getURL");
    expect(String(sig.detail)).toMatch(/bytes appended after the image\/png end-of-image marker/);
  });

  it("emits no binary-asset signal for a sample whose images are clean", () => {
    const p = pack("demo-cookie-manager");
    for (const bucket of ["high", "medium"] as const) {
      expect(kinds(p, bucket).filter((k) => String(k).startsWith("binary-asset"))).toEqual([]);
    }
  });
});
