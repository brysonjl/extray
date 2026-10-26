// Zip Slip guard tests for scripts/fetch-crx.ts (W1.4 — runtime dependencies).
//
// A CRX's embedded ZIP is attacker-controlled content downloaded from the
// internet, so unzipInto() must refuse to extract an entry whose name would
// resolve outside the destination directory — e.g. "../../etc/passwd" — or
// that uses an absolute path — e.g. "/etc/passwd" — BEFORE writing anything
// to disk. These tests build the malicious ZIPs in-process with fflate's
// zipSync (no malicious archive is committed as a fixture) and assert both
// that unzipInto() throws FetchError and that nothing lands outside (or even
// inside) the destination directory.

import { afterEach, describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { zipSync } from "fflate";
import { FetchError, fetchAndUnpack, unzipInto } from "../scripts/fetch-crx.ts";

function makeZip(entries: Record<string, string>): Buffer {
  const encoded: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(entries)) {
    encoded[name] = new TextEncoder().encode(content);
  }
  return Buffer.from(zipSync(encoded));
}

describe("unzipInto — Zip Slip guard", () => {
  it("rejects a relative-traversal entry (../etc/passwd) and writes nothing outside destDir", () => {
    const scratch = mkdtempSync(join(tmpdir(), "fetch-crx-test-"));
    const destDir = join(scratch, "dest");
    // One "../" from destDir lands at `scratch` itself — the spot a
    // successful Zip Slip would land the payload. (Kept to a single "../" so
    // that if the guard ever regresses, the escape still lands inside our
    // own scratch dir instead of wandering further up the real filesystem.)
    const escapeTarget = join(scratch, "etc", "passwd");
    try {
      const zip = makeZip({
        "manifest.json": '{"name":"innocuous"}',
        "../etc/passwd": "pwned",
      });

      expect(() => unzipInto(zip, destDir)).toThrow(FetchError);
      expect(() => unzipInto(zip, destDir)).toThrow(/Zip Slip/);

      // Nothing should have been written anywhere — not the escape target,
      // and not even the benign entry that shared the archive.
      expect(existsSync(escapeTarget)).toBe(false);
      expect(existsSync(destDir)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("rejects an absolute-path entry (/etc/passwd) and writes nothing", () => {
    const scratch = mkdtempSync(join(tmpdir(), "fetch-crx-test-"));
    const destDir = join(scratch, "dest");
    try {
      const zip = makeZip({
        "manifest.json": '{"name":"innocuous"}',
        "/etc/passwd": "pwned",
      });

      expect(() => unzipInto(zip, destDir)).toThrow(FetchError);
      expect(() => unzipInto(zip, destDir)).toThrow(/absolute path/);
      expect(existsSync(destDir)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("still unpacks a benign ZIP normally (control case)", () => {
    const scratch = mkdtempSync(join(tmpdir(), "fetch-crx-test-"));
    const destDir = join(scratch, "dest");
    try {
      const zip = makeZip({
        "manifest.json": '{"name":"fine"}',
        "assets/icon.png": "not-really-a-png",
      });

      unzipInto(zip, destDir);

      expect(readFileSync(join(destDir, "manifest.json"), "utf8")).toBe('{"name":"fine"}');
      expect(readFileSync(join(destDir, "assets", "icon.png"), "utf8")).toBe("not-really-a-png");
      expect(readdirSync(resolve(destDir)).sort()).toEqual(["assets", "manifest.json"]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("fetchAndUnpack download provenance", () => {
  const id = "a".repeat(32);
  afterEach(() => vi.unstubAllGlobals());

  it.each([undefined, "155.0.8059.26"])("requests Chrome target %s and binds provenance to the saved bytes", async (prodversion) => {
    const scratch = mkdtempSync(join(tmpdir(), "fetch-crx-provenance-"));
    const zip = makeZip({ "manifest.json": '{"version":"2.3.4","manifest_version":3}' });
    const response = new Response(new Uint8Array(zip));
    Object.defineProperty(response, "url", {
      value: "https://user:password@download.example/package.crx?token=private#secret",
    });
    const mockFetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", mockFetch);
    try {
      const before = Date.now();
      const result = await fetchAndUnpack(id, { out: scratch, keepCrx: true, force: false, prodversion });
      const after = Date.now();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const url = new URL(mockFetch.mock.calls[0]![0] as string);
      expect(url.origin + url.pathname).toBe("https://clients2.google.com/service/update2/crx");
      expect(url.searchParams.get("prodversion")).toBe(prodversion ?? "131.0.0.0");
      expect(url.searchParams.get("x")).toBe(`id=${id}&installsource=ondemand&uc`);
      expect(mockFetch.mock.calls[0]![1]).toEqual({ redirect: "follow" });
      expect(result.skipped).toBe(false);
      expect(result.provenance).toMatchObject({
        requestedProdversion: prodversion ?? "131.0.0.0",
        downloadUrl: url.toString(),
        finalUrl: "https://download.example/package.crx",
        crxSha256: createHash("sha256").update(zip).digest("hex"),
        crxBytes: zip.length,
      });
      expect(Date.parse(result.provenance!.fetchedAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(result.provenance!.downloadedAt)).toBeGreaterThanOrEqual(Date.parse(result.provenance!.fetchedAt));
      expect(Date.parse(result.provenance!.downloadedAt)).toBeLessThanOrEqual(after);
      expect(readFileSync(join(scratch, `${id}.crx`))).toEqual(zip);
      expect(JSON.parse(readFileSync(join(result.destDir, "manifest.json"), "utf8")).version).toBe("2.3.4");
      expect(JSON.stringify(result.provenance)).not.toMatch(/password|private|secret|user:/);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("does not invent fresh download provenance when reusing an existing tree", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "fetch-crx-existing-"));
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network forbidden"));
    vi.stubGlobal("fetch", mockFetch);
    try {
      mkdirSync(join(scratch, id));
      writeFileSync(join(scratch, id, "manifest.json"), "{}");
      const result = await fetchAndUnpack(id, { out: scratch, keepCrx: true, force: false, prodversion: "155.0.8059.26" });
      expect(result).toEqual({ id, destDir: join(scratch, id), skipped: true });
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.each(["155", "155.0.8059", "155.0.8059.26.1", "155.0.x.26", "155.0.8059.-1", "155.0.8059.26\n", "155.0.8059.26&x=other", ""])("rejects invalid target %j before network or filesystem changes", async (prodversion) => {
    const scratch = mkdtempSync(join(tmpdir(), "fetch-crx-invalid-"));
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network forbidden"));
    vi.stubGlobal("fetch", mockFetch);
    try {
      await expect(fetchAndUnpack(id, { out: scratch, keepCrx: true, force: false, prodversion })).rejects.toThrow(/four numeric components/);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("parses the CLI target flag and refuses malformed values without a download", () => {
    const scratch = mkdtempSync(join(tmpdir(), "fetch-crx-cli-"));
    try {
      const result = spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/fetch-crx.ts"), id,
        "--prodversion", "155.0.bad.26", "--out", scratch], { encoding: "utf8", timeout: 10000 });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--prodversion must contain four numeric components");
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
