// The production profile: which (methodology, model) arm is "the verdict".
// Config, not code — EXPLORER_PROFILE (a JSON string) overrides the default —
// and role-scoped: the ground-truth reference arm is Admin-only and can never
// be a User's verdict source (docs/reference/frontend/001-explorer-plan.md §4).

export type Role = "user" | "admin";

export interface Arm {
  methodology: string;
  model: string;
}

export interface ProductionProfile {
  /** The pinned production pipeline — the verdict a User sees. */
  pinned: Arm;
  /** User-visible fallbacks, used only when the pinned arm hasn't assessed an
   *  extension yet. Ground-truth is deliberately NOT here. */
  userFallback: Arm[];
  /** Admin-only reference arms (the eval oracle). Never in a User payload. */
  adminReference: Arm[];
  /** When true, ONLY store-backed targets are product-visible. When false the
   *  labeled synthetic corpus joins the catalog, every row badged synthetic
   *  (src/product/canonical.ts). Default false: a fresh clone has no real
   *  analyses, and an empty catalog teaches a newcomer nothing. */
  requireStoreBacked: boolean;
}

export const DEFAULT_PROFILE: ProductionProfile = {
  pinned: { methodology: "pi", model: "glm-5.2:cloud" },
  userFallback: [
    { methodology: "monolith", model: "glm-5.2:cloud" },
    { methodology: "dag", model: "glm-5.2:cloud" },
  ],
  adminReference: [{ methodology: "ground-truth", model: "claude-opus-4-8" }],
  requireStoreBacked: false,
};

/** The active profile: EXPLORER_PROFILE (JSON) when set and parseable, else the
 *  default. Malformed JSON is a loud startup error, not a silent fallback —
 *  a mis-set profile must not quietly serve the wrong verdicts. */
export function resolveProfile(env: Record<string, string | undefined> = process.env): ProductionProfile {
  const raw = env.EXPLORER_PROFILE;
  if (!raw) return DEFAULT_PROFILE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`EXPLORER_PROFILE is not valid JSON: ${(e as Error).message}`);
  }
  const p = parsed as Partial<ProductionProfile>;
  if (!p.pinned?.methodology || !p.pinned?.model) {
    throw new Error("EXPLORER_PROFILE must define pinned.methodology and pinned.model");
  }
  return {
    pinned: p.pinned,
    userFallback: p.userFallback ?? [],
    adminReference: p.adminReference ?? [],
    requireStoreBacked: p.requireStoreBacked ?? false,
  };
}

export function armKey(a: Arm): string {
  return `${a.methodology}|${a.model}`;
}

/** Ordered preference list for a role. Index in this list IS the pref_rank the
 *  canonical-selection query binds; a User's list never contains a reference arm. */
export function allowedArms(profile: ProductionProfile, role: Role): Arm[] {
  const base = [profile.pinned, ...profile.userFallback];
  return role === "admin" ? [...base, ...profile.adminReference] : base;
}
