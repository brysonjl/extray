// The pure planning half of scripts/export-d1.ts: which target ids the
// non-English filter drops from the D1 export. The SQL-generating half is
// exercised manually against .out/bakeoff.sqlite (no fixture DB is committed).

import { describe, expect, it } from "vitest";
import { nonEnglishTargetIds, type TargetRef } from "../scripts/export-d1.ts";

describe("nonEnglishTargetIds", () => {
  it("drops only targets languagesOk rejects", () => {
    const targets: TargetRef[] = [
      { id: 1, storeId: "en-ext" },
      { id: 2, storeId: "ru-ext" },
      { id: 3, storeId: "unknown-ext" },
    ];
    const ok = new Set(["en-ext", "unknown-ext"]);
    const dropped = nonEnglishTargetIds(targets, (storeId) => ok.has(storeId));
    expect(dropped).toEqual(new Set([2]));
  });

  it("drops nothing when every target passes", () => {
    const targets: TargetRef[] = [{ id: 1, storeId: "a" }, { id: 2, storeId: "b" }];
    expect(nonEnglishTargetIds(targets, () => true)).toEqual(new Set());
  });

  it("is empty for an empty target list", () => {
    expect(nonEnglishTargetIds([], () => false)).toEqual(new Set());
  });
});
