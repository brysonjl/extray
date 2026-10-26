import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FixtureContext } from "../fixture-context.ts";

/** A sibling sidecar keeps fixture context and answer-key paths outside the
 * extension source that an investigator can read. No network requests. */
export function loadFixtureContext(extDir: string): FixtureContext | undefined {
  const path = `${resolve(extDir)}.fixture.json`;
  if (!existsSync(path)) return undefined;
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    !("kind" in value) || value.kind !== "synthetic" ||
    !("family" in value) || typeof value.family !== "string" || !value.family.trim()
  ) {
    throw new Error(`invalid fixture context in ${path}: expected kind=synthetic and a nonempty family`);
  }
  return { kind: "synthetic", family: value.family };
}
