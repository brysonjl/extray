import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectRelease, prepareRelease } from "../scripts/prepare-release.mjs";

const temporary = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const put = (root, path, content = "fixture\n") => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });

function fixture() {
  const temp = mkdtempSync(join(tmpdir(), "extray-release-test-"));
  temporary.push(temp);
  const root = join(temp, "source");
  mkdirSync(root);
  git(root, "init", "-q");
  for (const file of ["README.md", "LICENSE", "NOTICE"]) put(root, file);
  for (const file of ["package.json", "package-lock.json"]) put(root, file, "{}\n");
  put(root, "wrangler.jsonc", JSON.stringify({ workers_dev: false, preview_urls: false, vars: { ACCESS_TEAM: "your-access-team", ACCESS_AUD: "your-access-application-audience" }, d1_databases: [{ database_id: "00000000-0000-0000-0000-000000000000" }] }));
  put(root, ".gitignore", ".private-patterns\nnode_modules/\n.env\n");
  git(root, "add", ".");
  return { root, temp, out: join(temp, "public") };
}

describe("sanitized release export", () => {
  it("omits historical research tools and their dedicated tests while retaining maintained tools", () => {
    const { root, out } = fixture();
    const privateFiles = [
      "scripts/smoke-pi-large-files.ts", "scripts/run-e2.ts", "scripts/audit-e1.ts",
      "scripts/talk-stats.ts", "scripts/verdict-replay.ts",
      "test/run-e2.test.ts", "test/audit-e1.test.ts", "test/talk-stats.test.ts",
    ];
    for (const path of privateFiles) put(root, path, "private experiment implementation\n");
    put(root, "scripts/scan.ts", "export {};\n");
    put(root, "test/pi-large-files.test.ts", "// synthetic source-access regression\n");
    put(root, "package.json", JSON.stringify({ scripts: { scan: "tsx scripts/scan.ts" } }));
    git(root, "add", "scripts", "test", "package.json");
    const result = prepareRelease(root, { out });
    for (const path of privateFiles) expect(existsSync(join(out, path)), path).toBe(false);
    expect(existsSync(join(out, "scripts/scan.ts"))).toBe(true);
    expect(existsSync(join(out, "test/pi-large-files.test.ts"))).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects a public npm command that still references an omitted research tool", () => {
    const { root, out } = fixture();
    put(root, "scripts/talk-stats.ts", "// private research tool\n");
    put(root, "package.json", JSON.stringify({ scripts: { stats: "node --import tsx ./scripts/talk-stats.ts --json" } }));
    expect(() => prepareRelease(root, { out })).toThrow("script stats references an absent release file: scripts/talk-stats.ts");
    expect(existsSync(out)).toBe(false);
  });

  it("copies current source and untracked additions, omits private/history files, and hashes the exact export", () => {
    const { root, out } = fixture();
    put(root, "src/current.ts", "export const current = true;\n");
    put(root, "src/deleted.ts");
    git(root, "add", "src");
    unlinkSync(join(root, "src/deleted.ts"));
    put(root, "src/new.ts", "export const newFeature = true;\n");
    for (const path of ["docs/plans/old.md", "docs/reference/research.md", "docs/decisions.md", "docs/talk.pptx", "web/explorer/handoff/README.md", "scratch_ev.txt", ".env", "node_modules/pkg/index.js"]) put(root, path, "private content");
    put(root, "docs/analysis.md", "[implementation](../src/new.ts)\n");
    const result = prepareRelease(root, { out });
    expect(readFileSync(join(out, "src/new.ts"), "utf8")).toContain("newFeature");
    expect(existsSync(join(out, ".git"))).toBe(false);
    for (const path of ["docs/plans", "docs/reference", "docs/decisions.md", "docs/talk.pptx", "web/explorer/handoff", "scratch_ev.txt", ".env", "node_modules", "src/deleted.ts"]) expect(existsSync(join(out, path)), path).toBe(false);
    const manifest = JSON.parse(readFileSync(result.manifest, "utf8"));
    expect(JSON.stringify(manifest)).not.toContain(root);
    for (const file of manifest.files) expect(file.sha256).toBe(createHash("sha256").update(readFileSync(join(out, file.path))).digest("hex"));
  });

  it("preserves an internal corpus directory alias and validates links through it", () => {
    const { root, out } = fixture();
    put(root, "corpus/demo-cookie-manager/extension/manifest.json", "{}\n");
    symlinkSync("demo-cookie-manager", join(root, "corpus/base"));
    put(root, "docs/analysis.md", "[sample](../corpus/base/extension/manifest.json)\n");
    const result = prepareRelease(root, { out });
    expect(lstatSync(join(out, "corpus/base")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(out, "corpus/base"))).toBe("demo-cookie-manager");
    expect(readFileSync(join(out, "corpus/base/extension/manifest.json"), "utf8")).toBe("{}\n");
    expect(result.entries.find(e => e.path === "corpus/base")).toMatchObject({ type: "symlink", target: "demo-cookie-manager" });
  });

  it.each(["outside", "excluded", "symlinked-parent"])("rejects unsafe symlinks (%s)", mode => {
    const { root, temp, out } = fixture();
    put(root, "src/nested/code.ts");
    if (mode === "symlinked-parent") {
      git(root, "add", "src/nested/code.ts");
      rmSync(join(root, "src/nested"), { recursive: true });
      put(temp, "elsewhere/code.ts", "private");
      symlinkSync(join(temp, "elsewhere"), join(root, "src/nested"));
    } else if (mode === "outside") {
      put(temp, "private.txt", "private");
      symlinkSync("../../private.txt", join(root, "src/leak"));
    } else {
      put(root, "docs/plans/private.md", "private");
      symlinkSync("../docs/plans", join(root, "src/leak"));
    }
    expect(() => prepareRelease(root, { out })).toThrow(/symlink/);
    expect(existsSync(out)).toBe(false);
  });

  it("never reuses a destination, overwrites a manifest, or exports into the source", () => {
    const { root, out } = fixture();
    mkdirSync(out);
    put(out, "keep.txt", "keep");
    expect(() => prepareRelease(root, { out })).toThrow(/already exists/);
    expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("keep");
    const another = out + "-another";
    writeFileSync(another + ".manifest.json", "keep");
    expect(() => prepareRelease(root, { out: another })).toThrow(/already exists/);
    expect(existsSync(another)).toBe(false);
    expect(() => prepareRelease(root, { out: join(root, "export") })).toThrow(/outside the source/);
  });

  it("rejects selected tracked files that bypass ignore rules", () => {
    const { root } = fixture();
    put(root, ".gitignore", "src/credentials.json\n");
    put(root, "src/credentials.json", "{}");
    git(root, "add", "-f", "src/credentials.json");
    expect(inspectRelease(root).errors).toContain("src/credentials.json: selected file is tracked despite an ignore rule");
  });

  it("rejects links to omitted content, including references and HTML assets", () => {
    const { root } = fixture();
    put(root, "docs/plans/private.md");
    put(root, "docs/analysis.md", "[notes][private]\n\n[private]: plans/private.md\n\n<img src=\"assets/missing.png\">\n\n[missing](../src/missing.ts)\n");
    const errors = inspectRelease(root).errors.join("\n");
    expect(errors).toContain("plans/private.md");
    expect(errors).toContain("assets/missing.png");
    expect(errors).toContain("../src/missing.ts");
  });

  it("checks optional private patterns without copying or disclosing them", () => {
    const { root } = fixture();
    const pattern = "deployment-only-marker";
    put(root, ".private-patterns", pattern);
    put(root, "src/endpoint.ts", `// ${pattern}\n`);
    const result = inspectRelease(root, { privatePatterns: join(root, ".private-patterns") });
    expect(result.errors).toContain("src/endpoint.ts: matched private pattern 1");
    expect(result.errors.join("\n")).not.toContain(pattern);
    expect(result.entries.some(e => e.path === ".private-patterns")).toBe(false);
  });

  it("refuses live deployment metadata in the public template", () => {
    const { root } = fixture();
    put(root, "wrangler.jsonc", JSON.stringify({ workers_dev: false, preview_urls: false, routes: [{ pattern: "service.example.test", custom_domain: true }], vars: { ACCESS_TEAM: "operator-team", ACCESS_AUD: "operator-audience" }, d1_databases: [{ database_id: "12345678-1234-1234-1234-123456789abc" }] }));
    const errors = inspectRelease(root).errors.join("\n");
    expect(errors).toContain("operator account/routes");
    expect(errors).toContain("Access team");
    expect(errors).toContain("Access audience");
    expect(errors).toContain("D1 database ID");
  });
});
