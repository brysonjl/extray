import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, HardError } from "../src/pipeline/index.ts";

const CLI = ["tsx", "src/cli.ts"];

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("npx", [...CLI, ...args], {
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { status: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

describe("analyze CLI", () => {
  it("emits a schema-valid pack with extension identity for ExtRay Demo Cookie Manager (exit 0)", () => {
    const out = join(mkdtempSync(join(tmpdir(), "pack-")), "pack.json");
    const r = run(["corpus/demo-cookie-manager/extension", "--out", out]);
    expect(r.status).toBe(0);
    const pack = JSON.parse(readFileSync(out, "utf8"));
    expect(pack.extension.id_from_path).toBe("demo-cookie-manager");
    expect(pack.extension.manifest.manifest_version).toBe(3);
    expect(pack.schema_version).toBeDefined();
  });

  it("exits non-zero when the directory is missing", () => {
    const r = run(["/no/such/extension/dir"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it("exits non-zero on a malformed manifest.json (hard fail)", () => {
    const dir = mkdtempSync(join(tmpdir(), "badext-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "manifest.json"), "{ this is not json ");
    const r = run([dir]);
    rmSync(dir, { recursive: true, force: true });
    expect(r.status).not.toBe(0);
  });

  // Valid JSON that isn't an object (null/array/scalar) must take the same
  // HardError path as unparseable JSON, not crash with a raw TypeError.
  it("raises HardError (not TypeError) for non-object manifest JSON", () => {
    for (const body of ["null", "[1,2]", '"str"', "42"]) {
      const dir = mkdtempSync(join(tmpdir(), "badext-"));
      writeFileSync(join(dir, "manifest.json"), body);
      expect(() => analyze(dir)).toThrow(HardError);
      expect(() => analyze(dir)).toThrow(/must be a JSON object/);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
