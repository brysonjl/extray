// The pure planning half of scripts/backfill-catalog.ts: which store ids are
// ground-truth-visible but not yet user-visible. The DB/CLI half is exercised
// manually against .out/bakeoff.sqlite (no fixture DB is committed).

import { describe, expect, it } from "vitest";
import { missingFromUserCatalog, type CanonicalIdRow } from "../scripts/backfill-catalog.ts";

const row = (storeId: string, name: string | null = null): CanonicalIdRow => ({ storeId, name });

describe("missingFromUserCatalog", () => {
  it("keeps admin-only ids and drops ids already user-visible", () => {
    const admin = [row("a"), row("b"), row("c")];
    const user = [row("b")];
    expect(missingFromUserCatalog(admin, user)).toEqual([row("a"), row("c")]);
  });

  it("returns nothing when every admin id is already user-visible", () => {
    const admin = [row("a"), row("b")];
    expect(missingFromUserCatalog(admin, admin)).toEqual([]);
  });

  it("returns everything when the user set is empty", () => {
    const admin = [row("a"), row("b")];
    expect(missingFromUserCatalog(admin, [])).toEqual(admin);
  });
});
