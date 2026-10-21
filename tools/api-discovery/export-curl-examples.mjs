#!/usr/bin/env node
/** Generate inert local examples; validate the entire plan before touching out/. */
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { curlExampleForEntry, exampleSearch, findHarvestRow } from "./lib/curlExamples.mjs";
import { renderCurlScript } from "./lib/curlRuntime.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, "out");
const bodiesDir = join(outDir, "bodies");
const outSh = join(outDir, "curl-examples.sh");

function validateMap(map) {
  if (!Array.isArray(map)) throw new Error("INVALID_MAP: expected an array");
  const ids = new Set();
  for (const entry of map) {
    if (!entry || typeof entry !== "object" ||
        typeof entry.method !== "string" || !/^[A-Z]+$/.test(entry.method) ||
        typeof entry.upstreamPath !== "string" || !/^\/(?!\/)[^\s?#\\]+$/.test(entry.upstreamPath) ||
        typeof entry.shadowPath !== "string" || !entry.shadowPath.startsWith("/") ||
        entry.shadowPath.startsWith("//") || /[\r\n\x00]/.test(entry.shadowPath) ||
        ["exampleQuery", "exampleContentType", "exampleFile"].some((key) => entry[key] !== undefined && typeof entry[key] !== "string")) {
      throw new Error("INVALID_MAP_ENTRY: method, upstreamPath and shadowPath are required");
    }
    const id = `${entry.method} ${entry.upstreamPath}`;
    if (ids.has(id)) throw new Error("AMBIGUOUS_OPERATION: duplicate method/path identity");
    ids.add(id);
  }
}

async function resolveBody(entry, row) {
  if (entry.method === "GET") return { text: null, row, body: { source: "none" } };
  // Legacy complete captures omitted the flag; an explicit truncation or an
  // invalid flag never qualifies. Bodies are documentation only in either case.
  if (row && (row.requestBodyTruncated === false || row.requestBodyTruncated === undefined) && typeof row.requestBodyPreview === "string") {
    return { text: row.requestBodyPreview, row, body: { source: "harvest" } };
  }
  if (entry.exampleFile) {
    // A fallback is a known repository file, not an arbitrary path supplied by
    // the recording. Resolve symlinks too; fail before replacing any artifacts.
    const file = await realpath(resolve(root, entry.exampleFile));
    if (!file.startsWith(root + sep) || file.startsWith(outDir + sep)) throw new Error("INVALID_EXAMPLE_FILE: use a repository example outside out/");
    const bytes = await readFile(file);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) throw new Error("INVALID_EXAMPLE_ENCODING: use a complete UTF-8 example");
    return { text, row: null, body: { source: "synthetic" } };
  }
  return {
    text: null, row: null,
    body: {
      source: "unavailable",
      code: row?.requestBodyTruncated ? "BODY_TRUNCATED" : "BODY_UNAVAILABLE",
      next_action: "Add a complete repository exampleFile with exampleContentType to route-map.json.",
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--dry-run", "--json", "--help"].includes(arg)) || new Set(args).size !== args.length) {
    throw new Error("INVALID_ARGUMENT: use --help, --dry-run or --json");
  }
  if (args.includes("--help")) {
    console.log("Usage: node export-curl-examples.mjs [--dry-run] [--json]\nPlans validate without network or changes to out/. With no flags, write inert curl-examples.sh and complete documentation bodies.");
    return;
  }
  const map = JSON.parse(await readFile(join(root, "route-map.json"), "utf8"));
  validateMap(map);
  let harvestLines = [];
  try {
    harvestLines = (await readFile(join(outDir, "harvest.ndjson"), "utf8")).split(/\n/).filter((line) => line.trim());
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("HARVEST_READ_FAILED: cannot read harvest.ndjson");
    console.warn("No harvest.ndjson; using example files only.");
  }
  const plan = { schemaVersion: 1, operations: [] };
  const examples = [];
  const files = new Set();
  for (const entry of map) {
    const row = findHarvestRow(harvestLines, entry.method, entry.upstreamPath);
    const resolved = await resolveBody(entry, row);
    const rendered = curlExampleForEntry(entry, resolved.row, resolved.text);
    const body = { ...resolved.body };
    if (rendered.bodyFile) {
      const name = rendered.bodyFile.fileName;
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || files.has(name)) throw new Error("INVALID_BODY_FILENAME: unsafe or colliding artifact name");
      files.add(name);
      body.file = `bodies/${name}`;
    }
    plan.operations.push({
      id: `${entry.method} ${entry.upstreamPath}`,
      method: entry.method, upstreamPath: entry.upstreamPath, shadowPath: entry.shadowPath,
      executable: entry.method === "GET", body,
      urlPath: entry.shadowPath + (entry.method === "GET" ? exampleSearch(entry, row) : ""),
    });
    examples.push(rendered);
  }
  const script = renderCurlScript(plan, examples);
  if (args.includes("--json")) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (args.includes("--dry-run")) {
    for (const op of plan.operations) console.log(`${op.id} — ${op.executable ? "local GET only" : "non-executable documentation"}; body=${op.body.source}${op.body.code ? `; ${op.body.code}: ${op.body.next_action}` : ""}`);
    return;
  }
  await mkdir(outDir, { recursive: true });
  await rm(bodiesDir, { recursive: true, force: true });
  await mkdir(bodiesDir);
  for (const { bodyFile } of examples) {
    if (bodyFile) await writeFile(join(bodiesDir, bodyFile.fileName), bodyFile.text, "utf8");
  }
  await writeFile(outSh, script, "utf8");
  console.log("Wrote", outSh);
  console.log("Body files under", bodiesDir);
  console.log("List (no network): bash", outSh, "--help");
}

try { await main(); }
catch { console.error("CURL_EXAMPLES_FAILED: check arguments, route-map.json identities, readable harvest.ndjson and complete repository examples. Validation is performed before artifact writes; input payload values are not reported."); process.exitCode = 1; }
