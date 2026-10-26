import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PI_INJECTION_CAVEAT_TEXT } from "../src/methodologies/pi/caveat.ts";

// caveat.ts is the single source for the pi injection caveat, and the README must
// quote it verbatim. It drifted the first time the constant was edited, so the
// README is checked here rather than trusted: a README that understates the risk
// of the default arm is the one doc bug a security tool cannot ship.
describe("README quotes the pi injection caveat verbatim", () => {
  it("contains every line of PI_INJECTION_CAVEAT_TEXT as a block quote", () => {
    const readme = readFileSync("README.md", "utf8");
    const quoted = PI_INJECTION_CAVEAT_TEXT.split("\n").map((l) => `> ${l}`).join("\n");
    expect(readme).toContain(quoted);
  });
});
