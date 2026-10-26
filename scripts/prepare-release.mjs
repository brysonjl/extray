#!/usr/bin/env node
// Copy a reviewed working tree into a fresh public snapshot. Git history and
// local state never enter the copy. Build/test/secret-scan the resulting tree
// separately before creating its public root commit.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const policy = JSON.parse(readFileSync(new URL("./release-policy.json", import.meta.url), "utf8"));
const privateDirectories = new Set([".git", "node_modules", ".cache", ".out", ".tmp", ".extray", ".wrangler", ".cursor", ".claude", ".agents", ".codex", ".context"]);
const isWithin = (root, path) => path === root || path.startsWith(root + sep);
const hasPath = (set, path) => set.has(path) || [...set].some(p => p.startsWith(path + "/"));
const hash = value => createHash("sha256").update(value).digest("hex");
const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const gitPaths = (root, args) => git(root, ["ls-files", "-z", ...args]).split("\0").filter(Boolean);

function selected(path) {
  const parts = path.split("/");
  const leaf = parts.at(-1);
  if (parts.some(p => privateDirectories.has(p))) return false;
  if (leaf === ".DS_Store" || leaf === ".dev.vars" || leaf === "CLAUDE.md" || /\.(?:key|pem|p12|log|sqlite(?:-wal|-shm)?)$/i.test(leaf)) return false;
  if ((leaf === ".env" || leaf.startsWith(".env.")) && path !== ".env.example") return false;
  if (policy.excludedFiles.includes(path)) return false;
  if (policy.excludedDirectories.some(p => path === p || path.startsWith(p + "/"))) return false;
  if (parts.length === 1) return policy.rootFiles.includes(path);
  if (parts[0] === "docs") {
    const doc = parts.slice(1).join("/");
    return policy.documentation.includes(doc) || policy.documentationDirectories.some(p => doc.startsWith(p + "/"));
  }
  return policy.sourceDirectories.includes(parts[0]);
}

function parseJsonc(text) {
  // Preserve quoted strings (including URL //) while removing comments.
  const plain = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (match, string) => string ?? "");
  return JSON.parse(plain.replace(/("(?:\\.|[^"\\])*")|,\s*(?=[}\]])/g, (match, string) => string ?? ""));
}

function checkWrangler(text, errors) {
  let config;
  try { config = parseJsonc(text); }
  catch { errors.push("wrangler.jsonc: invalid JSONC"); return; }
  const inspect = (value, path) => {
    if (value.account_id || value.routes?.length || value.route) errors.push(`${path}: operator account/routes must stay in private configuration`);
    if (value.workers_dev === true || value.preview_urls === true) errors.push(`${path}: public template must disable workers.dev and preview URLs`);
    for (const db of value.d1_databases ?? []) {
      if (db.database_id !== "00000000-0000-0000-0000-000000000000") errors.push(`${path}: D1 database ID must use the zero UUID placeholder`);
    }
    const vars = value.vars ?? {};
    if (vars.ACCESS_TEAM && vars.ACCESS_TEAM !== "your-access-team") errors.push(`${path}: replace Access team with its public placeholder`);
    if (vars.ACCESS_AUD && vars.ACCESS_AUD !== "your-access-application-audience") errors.push(`${path}: replace Access audience with its public placeholder`);
    for (const [key, secret] of Object.entries(vars)) {
      if (/(?:TOKEN|API_KEY|SECRET|PASSWORD|ADMIN_EMAILS)/i.test(key) && secret) errors.push(`${path}: ${key} must be supplied privately`);
    }
    for (const [name, env] of Object.entries(value.env ?? {})) inspect(env, `${path} env ${name}`);
  };
  inspect(config, "wrangler.jsonc");
  if (config.workers_dev !== false || config.preview_urls !== false) errors.push("wrangler.jsonc: explicitly disable workers.dev and preview URLs");
}

/** Inline links, image links, reference definitions and HTML assets. Code
 * fences are examples, not document navigation, and are deliberately skipped. */
function markdownTargets(text) {
  const prose = text.replace(/^([ \t]*)(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[^\n]*$/gm, "");
  const matches = [];
  const patterns = [
    /\]\(\s*(?:<([^>]+)>|((?:[^\s()\\]|\\.|\([^()]*\))+))(?:\s+[^)]*)?\)/g,
    /^\s{0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm,
    /\b(?:href|src)=["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) for (const match of prose.matchAll(pattern)) matches.push(match[1] ?? match[2]);
  return matches;
}

function checkLinks(path, content, paths, aliases, errors) {
  for (const raw of markdownTargets(content)) {
    if (/^(?:https?:|mailto:|tel:|data:|#|\/\/)/i.test(raw)) continue;
    if (/^[a-z][a-z\d+.-]*:/i.test(raw)) { errors.push(`${path}: unsupported local link ${raw}`); continue; }
    let target;
    try { target = decodeURIComponent(raw.split(/[?#]/, 1)[0]).replace(/\\([ ()])/g, "$1"); }
    catch { errors.push(`${path}: malformed link ${raw}`); continue; }
    if (!target) continue;
    target = posix.normalize(target.startsWith("/") ? target.slice(1) : posix.join(posix.dirname(path), target));
    if (target === ".") continue;
    // Resolve an internal directory alias such as corpus/base before checking.
    for (let i = 0; i <= aliases.size; i++) {
      const alias = [...aliases.keys()].find(a => target === a || target.startsWith(a + "/"));
      if (!alias) break;
      target = posix.normalize(posix.join(aliases.get(alias), target.slice(alias.length)));
    }
    if (target.startsWith("../") || !hasPath(paths, target)) errors.push(`${path}: local link is absent from release: ${raw}`);
  }
}

export function inspectRelease(source, options = {}) {
  const root = realpathSync(source);
  if (realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== root) throw new Error("Run release preparation at the repository root");
  const candidates = [...new Set(gitPaths(root, ["--cached", "--others", "--exclude-standard"]))].sort();
  const ignored = new Set(gitPaths(root, ["--cached", "--ignored", "--exclude-standard"]));
  const paths = new Set();
  const entries = [];
  const errors = [];
  const aliases = new Map();
  const patterns = options.privatePatterns ? readFileSync(options.privatePatterns, "utf8").split(/\r?\n/).map(p => p.trim()).filter(p => p && !p.startsWith("#")) : [];
  const patternPath = options.privatePatterns ? realpathSync(options.privatePatterns) : null;
  for (const path of candidates) {
    if (!selected(path)) continue;
    const absolute = join(root, path);
    let stat;
    try { stat = lstatSync(absolute); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; } // tracked deletion
    if (patternPath && absolute === patternPath) continue;
    if (ignored.has(path)) { errors.push(`${path}: selected file is tracked despite an ignore rule`); continue; }
    if (path.includes("\\") || path.split("/").some(p => p === ".." || p === ".")) { errors.push(`${path}: nonportable path`); continue; }
    let unsafeParent = false;
    for (let parent = dirname(absolute); parent !== root; parent = dirname(parent)) {
      if (!isWithin(root, parent) || lstatSync(parent).isSymbolicLink()) { unsafeParent = true; break; }
    }
    if (unsafeParent) { errors.push(`${path}: symlinked parent is not permitted`); continue; }
    if (!stat.isFile() && !stat.isSymbolicLink()) { errors.push(`${path}: unsupported file type`); continue; }
    let data, target;
    if (stat.isSymbolicLink()) {
      target = readlinkSync(absolute);
      if (isAbsolute(target) || target.includes("\\") || !isWithin(root, resolve(dirname(absolute), target))) {
        errors.push(`${path}: symlink escapes the release or uses an absolute target`); continue;
      }
      try { if (!isWithin(root, realpathSync(absolute))) throw new Error("escape"); }
      catch { errors.push(`${path}: symlink is broken, cyclic or escapes the source`); continue; }
      aliases.set(path, posix.normalize(posix.join(posix.dirname(path), target)));
      data = Buffer.from(target);
    } else data = readFileSync(absolute);
    for (const [i, pattern] of patterns.entries()) {
      if ((path + "\n" + data.toString("utf8")).toLowerCase().includes(pattern.toLowerCase())) errors.push(`${path}: matched private pattern ${i + 1}`);
    }
    paths.add(path);
    entries.push({ path, type: target === undefined ? "file" : "symlink", sha256: hash(data), ...(target === undefined ? {} : { target }), executable: Boolean(stat.mode & 0o111) });
  }
  for (const [path, target] of aliases) if (!hasPath(paths, target)) errors.push(`${path}: symlink target is excluded from the release`);
  for (const entry of entries) {
    if (entry.type === "file" && entry.path.endsWith(".md")) checkLinks(entry.path, readFileSync(join(root, entry.path), "utf8"), paths, aliases, errors);
  }
  for (const required of ["README.md", "LICENSE", "NOTICE", "package.json", "package-lock.json", "wrangler.jsonc"]) {
    if (!paths.has(required)) errors.push(`${required}: required release file is missing`);
  }
  if (paths.has("package.json")) {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    // Public npm entrypoints must not point at a private research tool that
    // the export deliberately omits. These are literal repository paths,
    // not an attempt to interpret arbitrary shell expressions.
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
      if (typeof command !== "string") continue;
      for (const match of command.matchAll(/\bscripts\/[\w./-]+\.(?:[cm]?js|ts)\b/g)) {
        if (!paths.has(match[0])) errors.push(`package.json: script ${name} references an absent release file: ${match[0]}`);
      }
    }
  }
  if (paths.has("wrangler.jsonc")) checkWrangler(readFileSync(join(root, "wrangler.jsonc"), "utf8"), errors);
  return { root, entries, errors, excludedCount: candidates.length - entries.length };
}

export function prepareRelease(source, options = {}) {
  const audit = inspectRelease(source, options);
  if (audit.errors.length) throw new Error(`Release checks failed:\n${audit.errors.map(e => `- ${e}`).join("\n")}`);
  if (!options.out) return audit;
  const out = resolve(options.out);
  const parent = realpathSync(dirname(out));
  const realOut = join(parent, basename(out));
  if (isWithin(audit.root, realOut) || isWithin(realOut, audit.root)) throw new Error("Release destination must be outside the source checkout");
  const manifest = `${out}.manifest.json`;
  if (existsSync(out) || existsSync(manifest)) throw new Error("Release destination or sibling manifest already exists; choose a new path");
  // mkdir is exclusive: even an existing empty directory is never reused.
  mkdirSync(out);
  for (const entry of audit.entries) {
    const destination = join(out, entry.path);
    mkdirSync(dirname(destination), { recursive: true });
    if (entry.type === "symlink") symlinkSync(entry.target, destination);
    else copyFileSync(join(audit.root, entry.path), destination, constants.COPYFILE_EXCL);
    const copied = entry.type === "symlink" ? Buffer.from(readlinkSync(destination)) : readFileSync(destination);
    if (hash(copied) !== entry.sha256) throw new Error(`Source changed during export: ${entry.path}; retain this incomplete destination for inspection and use a new path`);
  }
  writeFileSync(manifest, JSON.stringify({ format: 1, files: audit.entries }, null, 2) + "\n", { flag: "wx" });
  return { ...audit, out, manifest };
}

function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check") continue;
    if ((args[i] === "--out" || args[i] === "--private-patterns") && args[i + 1] && !args[i + 1].startsWith("--")) {
      options[args[i] === "--out" ? "out" : "privatePatterns"] = args[++i];
    } else throw new Error("Usage: node scripts/prepare-release.mjs [--check] [--out NEW_DIRECTORY] [--private-patterns FILE]");
  }
  const result = prepareRelease(process.cwd(), options);
  console.log(`Release checks passed: ${result.entries.length} files selected; ${result.excludedCount} private/unselected paths omitted.`);
  if (result.out) console.log(`Snapshot: ${result.out}\nManifest: ${result.manifest}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
