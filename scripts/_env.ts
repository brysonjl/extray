// Loads a local .env (gitignored) into process.env for RECORD runs, using Node's
// built-in loader — no dependency. Imported for its side effect at the top of the
// scorecard/pilot CLIs, before option defaults and the provider adapter read env.
//
// Skipped when SKIP_DOTENV is set (the test suite sets it) so a developer's local
// .env can never perturb fixture keys or CLI exit codes during tests.

import { existsSync } from "node:fs";

if (!process.env.SKIP_DOTENV && existsSync(".env")) {
  process.loadEnvFile();
}
