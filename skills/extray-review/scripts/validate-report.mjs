#!/usr/bin/env node
// No dependencies, network, imports of sample code, or writes. Node.js 18+.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const schema = JSON.parse(readFileSync(new URL("../references/report.schema.json", import.meta.url), "utf8"));

// Implements only the keywords used by the bundled schema. Fail closed if the
// schema evolves beyond this subset; do not silently stop enforcing a constraint.
const keywords = new Set(["$schema", "title", "description", "type", "const", "enum", "minLength",
  "minimum", "properties", "required", "additionalProperties", "items", "minItems", "maxItems", "uniqueItems"]);
function checkSchema(s) {
  for (const key of Object.keys(s)) if (!keywords.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  for (const child of Object.values(s.properties ?? {})) checkSchema(child);
  if (s.items) checkSchema(s.items);
}
checkSchema(schema);

function matchesType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

function check(value, s, path, errors) {
  if (s.type && ![s.type].flat().some((t) => matchesType(value, t))) {
    errors.push(`${path}: expected ${[s.type].flat().join(" or ")}`);
    return;
  }
  if ("const" in s && value !== s.const) errors.push(`${path}: must equal ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(value)) errors.push(`${path}: invalid enum value`);
  if (typeof value === "string" && s.minLength && value.trim().length < s.minLength) errors.push(`${path}: must not be empty`);
  if (typeof value === "number" && s.minimum !== undefined && value < s.minimum) errors.push(`${path}: below minimum ${s.minimum}`);
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) errors.push(`${path}: too few items`);
    if (s.maxItems !== undefined && value.length > s.maxItems) errors.push(`${path}: too many items`);
    if (s.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) errors.push(`${path}: duplicate items`);
    if (s.items) value.forEach((v, i) => check(v, s.items, `${path}[${i}]`, errors));
  } else if (value !== null && typeof value === "object") {
    for (const key of s.required ?? []) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
    for (const [key, v] of Object.entries(value)) {
      if (Object.hasOwn(s.properties ?? {}, key)) check(v, s.properties[key], `${path}.${key}`, errors);
      else if (s.additionalProperties === false) errors.push(`${path}.${key}: unexpected field`);
    }
  }
}

function sourcePath(root, file) {
  // Use portable slash-separated relative paths, including on Windows.
  if (isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.includes("\\") || file.includes("\0") ||
      file.split("/").some((p) => p === ".." || p === "." || p === "")) throw new Error("not a portable source-relative path");
  const actual = realpathSync(resolve(root, file));
  const rel = relative(root, actual);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("source path escapes root (including symlinks)");
  if (!statSync(actual).isFile()) throw new Error("source reference is not a regular file");
  return actual;
}

export function validateReport(report, sourceDir) {
  const errors = [];
  check(report, schema, "$", errors);
  if (errors.length) return errors;
  let root;
  try {
    root = realpathSync(sourceDir);
    if (!statSync(root).isDirectory()) throw new Error("not a directory");
    sourcePath(root, "manifest.json");
  } catch (error) { return [`Invalid source directory: ${error.message}`]; }

  const ids = new Set();
  const sourceTexts = new Map();
  for (const f of report.findings) {
    if (ids.has(f.id)) errors.push(`Duplicate finding id: ${f.id}`);
    ids.add(f.id);
    if (f.claim_type === "inferred-behavior") {
      if (!f.claimed_mechanism.trim()) errors.push(`${f.id}: inferred behavior needs a mechanism`);
      if (!f.evidence_refs.some((r) => r.location !== null)) errors.push(`${f.id}: inferred behavior needs line-level evidence`);
    } else {
      if (f.claimed_mechanism !== "") errors.push(`${f.id}: observed capability must not carry a mechanism`);
      if (f.finding_type === "malicious") errors.push(`${f.id}: malicious requires inferred-behavior`);
    }
    for (const ref of f.evidence_refs) {
      try {
        const file = sourcePath(root, ref.file);
        if (ref.location !== null || ref.sink_or_string !== null) {
          if (!sourceTexts.has(file)) {
            if (statSync(file).size > 64 * 1024 * 1024) throw new Error("file exceeds the validator's 64 MiB text-read limit");
            sourceTexts.set(file, readFileSync(file, "utf8"));
          }
          const contents = sourceTexts.get(file);
          if (ref.location !== null) {
            const lines = contents.split("\n");
            if (ref.location.line > lines.length) throw new Error("line is outside the file");
            if (ref.location.column !== undefined && ref.location.column > lines[ref.location.line - 1].replace(/\r$/, "").length + 1) {
              throw new Error("column is outside the cited line");
            }
          }
          if (ref.sink_or_string !== null && !contents.includes(ref.sink_or_string)) throw new Error("exact sink_or_string token not found in source file");
        }
      } catch (error) { errors.push(`${f.id}: ${ref.file}: ${error.message}`); }
    }
  }
  const dimensions = new Set();
  const accounted = new Set();
  for (const c of report.coverage) {
    if (dimensions.has(c.dimension)) errors.push(`Duplicate coverage dimension: ${c.dimension}`);
    dimensions.add(c.dimension);
    for (const id of c.finding_ids) {
      if (!ids.has(id)) errors.push(`${c.dimension}: unknown finding id ${id}`);
      accounted.add(id);
    }
    if (c.status === "findings" && !c.finding_ids.length) errors.push(`${c.dimension}: findings status needs finding_ids`);
    if (c.status === "cleared" && c.finding_ids.length) errors.push(`${c.dimension}: cleared status cannot carry findings`);
    if (c.status !== "inconclusive" && !c.checks_run.length) errors.push(`${c.dimension}: findings/cleared needs checks_run`);
    if (c.status === "inconclusive" && report.investigation !== "incomplete") errors.push(`${c.dimension}: inconclusive coverage requires incomplete investigation`);
  }
  for (const id of ids) if (!accounted.has(id)) errors.push(`${id}: not referenced by coverage`);
  return errors;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[1] !== "--source") {
    console.log("Usage: node validate-report.mjs REPORT.json --source UNPACKED_DIRECTORY\nChecks structure and source references only; does not verify claims or assign a tier.");
    process.exitCode = args.length === 1 && args[0] === "--help" ? 0 : 2;
  } else {
    try {
      const report = JSON.parse(readFileSync(args[0], "utf8"));
      const errors = validateReport(report, args[2]);
      if (errors.length) {
        console.error(errors.join("\n"));
        process.exitCode = 1;
      } else console.log(`Valid candidate report (${report.investigation}); structure and source references checked, claims unverified.`);
    } catch (error) {
      console.error(`Cannot validate report: ${error.message}`);
      process.exitCode = 2;
    }
  }
}
