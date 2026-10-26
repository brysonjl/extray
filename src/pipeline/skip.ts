// Layer-3 skip predicate. In v0 the library allowlist is deferred, so this
// always returns false (every file is analyzed). The data path is wired so that
// when the allowlist lands, hash-matched libraries can be skipped without any
// change to callers. (docs/decisions.md: library skip on by default — deferred.)

import type { FileEntry } from "./schema.ts";

export function shouldSkipLayer3(file: FileEntry): boolean {
  void file;
  return false;
}
