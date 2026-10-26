/** Presentation metadata supplied beside a local scan target. It is never an
 * answer key and must not enter the investigator's evidence prompt. */
export interface FixtureContext {
  kind: "synthetic";
  family: string;
}

export const FIXTURE_NOTICE =
  "ExtRay test fixture. Harmful behaviors in modified variants were deliberately introduced for evaluation. Findings apply only to this fixture, not to any published extension.";
