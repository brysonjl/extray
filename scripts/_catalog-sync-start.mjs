// Loaded before a catalog writer's entrypoint and its later --import modules.
// This deliberately has no target imports, arguments, or filesystem work.
// Only the spawning parent's private IPC channel can authorize target startup.
import { isMainThread } from "node:worker_threads";

// Node can preload this module again in worker threads using its original
// internal option list. A thread can only be created after the parent process
// has passed this gate; it shares that registered process's lifetime/PID.
if (isMainThread) await new Promise((resolve) => {
  const stop = () => process.exit(1);
  if (!process.connected || !process.send) stop();
  process.once("disconnect", stop);
  process.once("message", (message) => {
    if (message?.type !== "catalog-sync-start") stop();
    process.removeListener("disconnect", stop);
    resolve();
  });
  if (!process.connected) stop();
  process.send({ type: "catalog-sync-ready" }, (error) => { if (error) stop(); });
});

// child_process.fork uses process.execArgv. Descendants remain in the registered
// process group and must not wait for a second permit. Remove only this preload
// before later loaders or the entrypoint can fork.
for (let i = 0; i < process.execArgv.length - 1; i++) {
  if (process.execArgv[i] === "--import" && process.execArgv[i + 1] === import.meta.url) {
    process.execArgv.splice(i, 2);
    break;
  }
}
if (isMainThread && process.connected) process.disconnect();
