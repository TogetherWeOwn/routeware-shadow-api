#!/usr/bin/env node
/**
 * Validate route-map.json against the executable operation contract.
 *
 * Read-only: validates the route map with the shared library
 * (./lib/routeMapValidation.mjs) and resolves every mapped shadow
 * method+path against the mounted operations — supplied via
 * --mounted-operations=<file with a JSON array of "METHOD /path">, or
 * derived from the repo source (src/routes/*.ts createRoute definitions).
 *
 * Usage: node route-map-validation.mjs [--json] [--mounted-operations=<file>]
 *
 * --json prints exactly one JSON object on stdout (stderr stays empty):
 * `{ schemaVersion, ok, checks, findings, summary }`. Exit 0 when the map
 * is valid, 1 on findings, 2 on an unknown flag or argument. Never prints
 * harvest payloads, credentials, raw exception text or stack traces, and
 * never writes to the filesystem.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHECK_IDS, SCHEMA_VERSION, validateRouteMap } from "./lib/routeMapValidation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mapPath = join(__dirname, "route-map.json");

const USAGE = [
  "Usage: node route-map-validation.mjs [--json] [--mounted-operations=<file>]",
  "",
  "  --json                        Print exactly one JSON validation result on stdout.",
  "  --mounted-operations=<file>    JSON array of \"METHOD /path\"; default: derive from src/routes/*.ts.",
].join("\n");

const rawArgs = process.argv.slice(2);
let json = false;
let mountedOperationsPath = null;
let unknown = null;
for (const arg of rawArgs) {
  if (arg === "--json") {
    json = true;
  } else if (arg.startsWith("--mounted-operations=")) {
    mountedOperationsPath = arg.slice("--mounted-operations=".length);
  } else {
    unknown = arg;
    break;
  }
}

function emit(result, status) {
  if (json) {
    console.log(JSON.stringify(result));
    process.exit(result.ok ? 0 : status);
  }
  if (result.ok) {
    console.log(
      `route-map validation: OK — ${result.summary.entries} entries, all mapping checks pass.`
    );
    process.exit(0);
  }
  for (const finding of result.findings) {
    const entries = finding.entryIndexes.length === 0 ? "map" : `entries ${finding.entryIndexes.join(",")}`;
    console.error(`${finding.code} [${finding.checkId}] ${entries}: ${finding.nextAction}`);
  }
  console.error(`route-map validation: FAIL — ${result.summary.errors} finding(s).`);
  process.exit(status);
}

function cliFinding(code, checkId, nextAction) {
  return {
    id: code,
    checkId,
    code,
    severity: "error",
    entryIndexes: [],
    nextAction,
  };
}

if (unknown !== null) {
  const result = {
    schemaVersion: SCHEMA_VERSION,
    ok: false,
    checks: CHECK_IDS.map((id) => ({ id, status: "skipped" })),
    findings: [
      cliFinding(
        "UNKNOWN_FLAG",
        "cli.arguments",
        "Re-run with only the supported flags: --json and --mounted-operations=<file>."
      ),
    ],
    summary: { entries: 0, errors: 1 },
  };
  if (!json) {
    // The offending value is never echoed: it may carry a token.
    console.error("route-map-validation: unknown flag or argument.");
    console.error(USAGE);
  }
  emit(result, 2);
}

let routeMap;
try {
  routeMap = JSON.parse(readFileSync(mapPath, "utf8"));
} catch {
  // Fixed code only: the file content and the parse error are never echoed.
  emit(
    {
      schemaVersion: SCHEMA_VERSION,
      ok: false,
      checks: CHECK_IDS.map((id) => ({ id, status: id === "route-map.shape" ? "fail" : "skipped" })),
      findings: [
        cliFinding(
          "ROUTE_MAP_UNREADABLE",
          "route-map.shape",
          "Restore route-map.json as a JSON array of { method, upstreamPath, shadowPath } entries."
        ),
      ],
      summary: { entries: 0, errors: 1 },
    },
    1
  );
}

const intrinsic = validateRouteMap(routeMap);

function readMountedOperationsFile(file) {
  const resolved = isAbsolute(file) ? file : join(__dirname, file);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  for (const entry of parsed) {
    if (typeof entry !== "string" || !/^[A-Z]+\s+\/\S*$/.test(entry)) {
      return null;
    }
  }
  return [...new Set(parsed)].sort();
}

// Method-then-path and path-then-method pairs inside createRoute({...}).
const CREATE_ROUTE_PATTERNS = [
  /method:\s*"([A-Za-z]+)"\s*,\s*path:\s*"([^"]+)"/g,
  /path:\s*"([^"]+)"\s*,\s*method:\s*"([A-Za-z]+)"/g,
];

/**
 * Derive the mounted operations from the repo source: the createRoute
 * method/path pairs in <repo>/src/routes/*.ts, where <repo> is two levels
 * above this script. Returns null when the source is unavailable, failing
 * closed instead of silently skipping the mounted-operation check.
 */
function deriveFromRepoSource() {
  const routesDir = resolve(__dirname, "..", "..", "src", "routes");
  let files;
  try {
    files = readdirSync(routesDir);
  } catch {
    return null;
  }
  const operations = new Set();
  for (const file of files.filter((name) => name.endsWith(".ts"))) {
    let text;
    try {
      text = readFileSync(join(routesDir, file), "utf8");
    } catch {
      continue;
    }
    for (const pattern of CREATE_ROUTE_PATTERNS) {
      pattern.lastIndex = 0;
      // The path-first pattern swaps the capture groups.
      const methodGroup = pattern === CREATE_ROUTE_PATTERNS[0] ? 1 : 2;
      const pathGroup = pattern === CREATE_ROUTE_PATTERNS[0] ? 2 : 1;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        operations.add(`${match[methodGroup].toUpperCase()} ${match[pathGroup]}`);
      }
    }
  }
  return operations.size === 0 ? null : [...operations].sort();
}

const mountedOperations =
  mountedOperationsPath !== null ? readMountedOperationsFile(mountedOperationsPath) : deriveFromRepoSource();

if (mountedOperations === null) {
  // A broken map is reported on its own terms first; the mounted set only
  // matters once the map itself is sound.
  if (!intrinsic.ok) {
    emit(intrinsic, 1);
  }
  emit(
    {
      schemaVersion: SCHEMA_VERSION,
      ok: false,
      checks: intrinsic.checks.map((check) =>
        check.id === "route-map.mounted-operation" ? { id: check.id, status: "fail" } : check
      ),
      findings: [
        cliFinding(
          "MOUNTED_OPERATIONS_UNAVAILABLE",
          "route-map.mounted-operation",
          'Supply a JSON array of "METHOD /path" via --mounted-operations=<file>, or run from a checkout with src/routes/*.ts createRoute definitions.'
        ),
      ],
      summary: { entries: routeMap.length, errors: 1 },
    },
    1
  );
}

emit(validateRouteMap(routeMap, { mountedOperations }), 1);
