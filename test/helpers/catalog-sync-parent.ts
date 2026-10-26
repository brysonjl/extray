// Test-only parent process for fault injection around durable registration.
// Writers below touch only the test's private directory; no provider/CLI runs.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../../src/db/index.ts";
import { acquireCatalogSync } from "../../src/runner/catalog-sync-ownership.ts";
import { runCatalogStep } from "../../scripts/_catalog-sync-process.ts";

const [mode, directory] = process.argv.slice(2);
if (!directory) throw new Error("Missing test directory");
const db = openDb(join(directory, "catalog.sqlite"));
const lease = acquireCatalogSync(db);
if (!lease) throw new Error("Test could not acquire catalog ownership");
const register = lease.registerChild.bind(lease);
lease.registerChild = (pid, group) => {
  writeFileSync(join(directory, "group-pid"), String(pid));
  if (mode === "before-registration") process.kill(process.pid, "SIGKILL");
  const clear = register(pid, group);
  if (mode === "after-registration") process.kill(process.pid, "SIGKILL");
  return clear;
};
const marker = JSON.stringify(join(directory, "writer-started"));
const writer = `require('node:fs').writeFileSync(${marker}, String(process.pid));setInterval(()=>{},1000);`;
const target = mode === "descendant"
  ? `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:'ignore'}).unref();`
  : writer;
try {
  await runCatalogStep(lease, process.execPath, ["-e", target]);
} catch (error) {
  writeFileSync(join(directory, "failure"), (error as Error).message);
  process.exitCode = 1;
} finally {
  lease.release();
  db.close();
}
