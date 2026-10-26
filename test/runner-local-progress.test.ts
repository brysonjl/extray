import { afterEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { startProgressPublisher } from "../scripts/explorer-progress.ts";
import { d1Query, d1Write } from "../scripts/_d1.ts";

vi.mock("../scripts/_d1.ts", () => ({ d1Query: vi.fn(), d1Write: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it("performs no initial, periodic or shutdown progress publishing when disabled", async () => {
  vi.useFakeTimers();
  const db = new DatabaseSync(":memory:");
  try {
    const stop = startProgressPublisher({ db, database: "unused", mode: "--remote", enabled: false });
    await vi.advanceTimersByTimeAsync(90_000);
    stop();
    expect(d1Query).not.toHaveBeenCalled();
    expect(d1Write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { db.close(); }
});
