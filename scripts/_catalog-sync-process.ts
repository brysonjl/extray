import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { CatalogSyncLease } from "../src/runner/catalog-sync-ownership.ts";

const startGate = new URL("./_catalog-sync-start.mjs", import.meta.url).href;

/** Node's close event covers the direct child, not its unref'ed helpers (for
 * example tsx's esbuild service). Keep the lease while they finish shutting
 * down. A deadline never clears ownership: a surviving/unknown group fails. */
async function clearFinishedGroup(clear: () => boolean): Promise<boolean> {
  for (let remaining = 2_000; !clear(); remaining -= 25) {
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

/** A process group keeps descendants covered if the sync process or CLI
 * wrapper crashes. Detachment isolates the group, but the child remains awaited.
 * A Node preload blocks the entrypoint until its PID/group is registered. If
 * the parent dies before authorization, IPC closes and no writer starts.
 * No shell interpolation or timeout takeover is used; we await child shutdown
 * and retain the lease for surviving groups. */
export function runCatalogStep(lease: CatalogSyncLease, command: string, args: string[]): Promise<void> {
  // Every catalog writer is a Node entrypoint. A generic command could bypass
  // the preload and execute before registration, so refuse it rather than
  // silently falling back to the previous unsafe startup path.
  if (command !== process.execPath) return Promise.reject(new Error("Catalog subprocesses must use the current Node executable"));
  return new Promise((resolve, reject) => {
    const group = process.platform !== "win32";
    const child = spawn(command, ["--import", startGate, ...args], {
      stdio: ["inherit", "inherit", "inherit", "ipc"], detached: group,
    });
    let clearChild: (() => boolean) | undefined;
    let failure: unknown;
    let failed = false;
    let finished = false;
    let exited = false;
    let exitCode: number | null = null;
    const finish = async (code: number | null) => {
      if (finished) return;
      finished = true;
      try {
        if (clearChild && !await clearFinishedGroup(clearChild)) {
          reject(failed ? failure : new Error("A catalog subprocess descendant is still running; ownership remains reserved until it exits."));
          return;
        }
        if (failed) reject(failure);
        else if (code !== 0) reject(new Error(`${command} exited ${String(code)}`));
        else resolve();
      } catch (error) { reject(error); }
    };
    const fail = (error: unknown) => {
      if (!failed) { failed = true; failure = error; }
      // A send callback/error may arrive after exit, including when a later
      // disconnect prevents close. Use the already confirmed exit in that case.
      if (exited) void finish(exitCode);
    };
    const disconnect = () => {
      try { if (child.connected) child.disconnect(); }
      catch { /* A concurrent exit has already closed the gate. */ }
    };
    child.once("message", (message) => {
      if (failed || !clearChild || (message as { type?: unknown } | null)?.type !== "catalog-sync-ready") {
        fail(new Error("Catalog subprocess could not confirm its startup gate"));
        disconnect();
        return;
      }
      // Registration is synchronous and has succeeded before this send. Even
      // if the parent dies immediately afterward, recovery sees the live group.
      child.send({ type: "catalog-sync-start" }, (error) => {
        if (error) { fail(error); disconnect(); }
      });
    });
    child.on("error", (error) => {
      fail(error);
      if (!child.pid) reject(error);
    });
    child.on("close", finish);
    child.on("exit", (code) => {
      // Parent-initiated IPC disconnect can prevent Node from emitting close.
      // Failed runs may settle once exit confirms the direct child is gone;
      // stdio is inherited, and finish still checks registered descendants.
      exited = true;
      exitCode = code;
      if (failed) void finish(code);
    });
    if (child.pid) {
      try { clearChild = lease.registerChild(child.pid, group); }
      catch (error) {
        fail(error);
        // No authorization has been sent. Closing IPC makes the preload exit
        // even if signaling the newly created process group fails.
        disconnect();
        try { if (group) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); }
        catch { /* The closed gate exits on EOF; still await confirmed exit. */ }
      }
    }
  });
}

/** Each sync owns an unshared private export; concurrent attempts cannot overwrite it. */
export function createCatalogExport(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "extray-catalog-sync-"));
  return { directory, path: join(directory, "catalog.sql") };
}
