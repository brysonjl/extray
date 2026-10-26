// Content-addressed Layer-3 cache backed by Node's built-in node:sqlite.
// Key = (file sha256, pass version, config hash). A no-op edit keeps the same
// sha256 -> cache hit; a heuristic-config change flips the config hash ->
// automatic invalidation without a manual pass-version bump.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ScriptEntry } from "../pipeline/schema.ts";

export class Layer3Cache {
  #db: DatabaseSync;
  #get;
  #put;
  readonly stats = { hits: 0, misses: 0 };

  constructor(cacheDir: string) {
    mkdirSync(cacheDir, { recursive: true });
    this.#db = new DatabaseSync(join(cacheDir, "analyzer-cache.sqlite"));
    // Concurrent assess processes share this file; without these pragmas a
    // second writer gets an immediate "database is locked" and the whole run dies.
    this.#db.exec("PRAGMA busy_timeout = 10000");
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.prepare("CREATE TABLE IF NOT EXISTS layer3 (key TEXT PRIMARY KEY, json TEXT NOT NULL)").run();
    this.#get = this.#db.prepare("SELECT json FROM layer3 WHERE key = ?");
    this.#put = this.#db.prepare("INSERT OR REPLACE INTO layer3 (key, json) VALUES (?, ?)");
  }

  key(sha256: string, passVersion: string, configHash: string): string {
    return `${sha256}:${passVersion}:${configHash}`;
  }

  /** Returns the cached entry relabeled to `path` (content-addressed), or null. */
  get(key: string, path: string): ScriptEntry | null {
    const row = this.#get.get(key) as { json: string } | undefined;
    if (!row) { this.stats.misses += 1; return null; }
    this.stats.hits += 1;
    return { ...(JSON.parse(row.json) as ScriptEntry), path };
  }

  set(key: string, entry: ScriptEntry): void {
    this.#put.run(key, JSON.stringify(entry));
  }

  close(): void {
    this.#db.close();
  }
}
