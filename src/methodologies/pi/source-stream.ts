// Bounded UTF-8 source streaming. Never evaluate extension code.
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { Worker } from "node:worker_threads";

export const CHUNK_BYTES = 16 * 1024;
export const SCAN_BYTES = 64 * 1024 * 1024;
export const SCAN_MS = 10_000;
export const REGEX_LINE_BYTES = 64 * 1024;
export interface Position { byte: number; line: number; column: number }
export interface Fragment { text: string; start: Position; end: Position; lineEnd: boolean }
export class ScanStopped extends Error {}
export interface Budget { bytes: number; deadline: number }
export function checkBudget(budget: Budget, signal?: AbortSignal) {
  if (signal?.aborted) throw new ScanStopped("cancelled");
  if (Date.now() >= budget.deadline) throw new ScanStopped("time limit");
}

export async function openSource(path: string): Promise<FileHandle> {
  // The caller checks every path component as well. O_NOFOLLOW closes the final
  // symlink replacement window; compare the descriptor to the checked path there.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Path denied: not a regular file");
    return handle;
  } catch (error) { await handle.close(); throw error; }
}

/** End at a UTF-8 code point boundary. Invalid UTF-8 is rejected by the decoder. */
export function utf8End(bytes: Buffer, end = bytes.length): number {
  if (!end) return 0;
  let lead = end - 1;
  while (lead > 0 && (bytes[lead]! & 0xc0) === 0x80) lead--;
  const b = bytes[lead]!;
  const length = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
  return lead + length > end ? lead : end;
}

export function advance(start: Position, text: string): Position {
  const last = text.lastIndexOf("\n");
  return { byte: start.byte + Buffer.byteLength(text),
    line: start.line + (text.match(/\n/g)?.length ?? 0),
    column: last < 0 ? start.column + text.length : text.length - last };
}

export async function* fragments(handle: FileHandle, size: number, budget: Budget, signal?: AbortSignal,
  start: Position = { byte: 0, line: 1, column: 1 }): AsyncGenerator<Fragment> {
  let pos = { ...start };
  const buffer = Buffer.alloc(CHUNK_BYTES + 4);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  while (pos.byte < size) {
    checkBudget(budget, signal);
    if (budget.bytes >= SCAN_BYTES) throw new ScanStopped("byte limit");
    const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, size - pos.byte, SCAN_BYTES - budget.bytes), pos.byte);
    if (!bytesRead) throw new ScanStopped("file changed during scan");
    budget.bytes += bytesRead;
    const end = pos.byte + bytesRead === size ? bytesRead : utf8End(buffer, bytesRead);
    if (!end) throw new ScanStopped("byte limit at UTF-8 boundary");
    let from = 0;
    while (from < end) {
      checkBudget(budget, signal);
      const nl = buffer.indexOf(10, from);
      const to = nl >= 0 && nl < end ? nl + 1 : end;
      const text = decoder.decode(buffer.subarray(from, to));
      const next = advance(pos, text);
      yield { text, start: { ...pos }, end: next, lineEnd: text.endsWith("\n") || next.byte === size };
      pos = next;
      from = to;
    }
  }
}

// User-supplied regexes must not block the agent's event loop. The worker has no
// filesystem access code; only bounded strings and a pattern are sent to it.
const MATCH_WORKER = `
const {parentPort, workerData} = require('node:worker_threads');
const regex = new RegExp(workerData.pattern, workerData.ignoreCase ? 'i' : '');
parentPort.on('message', lines => parentPort.postMessage(lines.map(line => {
  const match = regex.exec(line);
  return match ? match.index : -1;
})));
`;
export class RegexMatcher {
  private worker: Worker;
  private failure?: string;
  constructor(pattern: string, ignoreCase: boolean) {
    new RegExp(pattern, ignoreCase ? "i" : ""); // validate before starting
    this.worker = new Worker(MATCH_WORKER, { eval: true, workerData: { pattern, ignoreCase },
      resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 } });
    this.worker.on("error", (error) => { this.failure = error instanceof Error ? error.message : String(error); });
    this.worker.on("exit", (code) => { if (code) this.failure ??= `exit ${code}`; });
  }
  async match(lines: string[], signal?: AbortSignal): Promise<number[]> {
    if (signal?.aborted) throw new ScanStopped("cancelled");
    if (this.failure) throw new ScanStopped(`regex worker: ${this.failure}`);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", aborted);
        this.worker.removeListener("message", done);
        this.worker.removeListener("error", failed);
        this.worker.removeListener("exit", exited);
      };
      const failed = (error: Error) => { cleanup(); reject(new ScanStopped(`regex worker: ${error.message}`)); };
      const exited = () => failed(new Error("exited"));
      const aborted = () => { cleanup(); reject(new ScanStopped("cancelled")); };
      const done = (matches: number[]) => { cleanup(); resolve(matches); };
      const timer = setTimeout(() => { cleanup(); reject(new ScanStopped("regex time limit")); }, 500);
      signal?.addEventListener("abort", aborted, { once: true });
      this.worker.once("message", done);
      this.worker.once("error", failed);
      this.worker.once("exit", exited);
      this.worker.postMessage(lines);
    });
  }
  async close() { await this.worker.terminate(); }
}
