// The pi arm's prompt-injection caveat, in ONE place because it has to appear
// verbatim in three (locked 2026-09-09): `--help`, the README, and the Explorer
// UI. pi is the default LLM arm, so a user hits this surface without opting in.
//
// Stage 1 confines file tools and disables automatic resource discovery. Source
// can still inject instructions into model context; process isolation is Stage 2.

/** One sentence, for a UI badge or a tooltip. */
export const PI_INJECTION_CAVEAT_SHORT =
  "pi analyzes untrusted extension source with confined read-only tools. Injected instructions can still influence findings; process sandboxing is not shipped.";

/** The paragraph form, for --help, the README and the Explorer UI. */
export const PI_INJECTION_CAVEAT_TEXT = [
  "The pi arm analyzes attacker-controlled extension source. Its read-only file tools",
  "are confined to the extension directory, including symlink checks, and automatic",
  "loading of AGENTS.md, CLAUDE.md, and pi configuration/resources is disabled.",
  "Prompt injection remains possible: instructions embedded in source can still",
  "influence findings. Source-grounded verification checks those claims, but a pi",
  "verdict is evidence to check, never an authority. Pi runs in-process with NO process",
  "sandbox or network egress isolation. Container execution is planned but NOT shipped;",
  "provide that isolation yourself for at-scale or adversarial work. The static `scan`",
  "path never runs an agent and is not affected.",
].join("\n");

/** Pre-formatted block appended to a CLI's --help output. */
export const PI_INJECTION_CAVEAT = `\nprompt-injection caveat (pi arm, the default):\n${PI_INJECTION_CAVEAT_TEXT.replace(/^/gm, "  ")}\n`;
