#!/usr/bin/env node
/**
 * Prod dependency audit gate (TOG-8904, extended to tools/api-discovery in
 * TOG-25334).
 *
 * Audits TWO lockfiles and fails on any high/critical advisory that is not
 * explicitly allowlisted in `./lib/depsAuditCheck.mjs`:
 *
 * - root `package-lock.json` via `npm audit --omit=dev` (prod-only: the
 *   Worker ships prod dependencies; devDependencies would drown the signal);
 * - `tools/api-discovery/package-lock.json` via `npm audit --include=dev`
 *   (that package has no prod dependencies — playwright/tsx are its tool
 *   runtime — so omitting dev would audit an empty tree and pass silently
 *   forever). The include is explicit so ambient `NODE_ENV=production` /
 *   `npm_config_omit=dev` can never empty the discovery tree.
 *
 * The two reports are merged (`combineAuditJson`) into a single allowlist
 * verdict: one shared allowlist, one staleness rule. `npm audit` exits 1
 * when vulnerabilities are found, but still prints the full JSON report to
 * stdout — so stdout is parsed even on nonzero exit. Each parsed report is
 * validated with `auditReportProblem` before it can feed the verdict: npm
 * prints error JSON (e.g. ENOLOCK for a missing lockfile) on stdout with
 * the same exit 1, and that must never read as a clean report. Exit 2 is
 * reserved for "an audit itself could not run" (no network, unparsable
 * output, npm error report): that is an infrastructure failure, not a
 * FAIL verdict.
 *
 * Credential-free: reads package-lock.json files plus public registry
 * advisory data. Never prints credentials — findings name GHSA ids and
 * packages only.
 *
 * Pure logic lives in `./lib/depsAuditCheck.mjs` and is unit-tested with
 * fixture audit JSON (the suite never reaches the registry); this wrapper's
 * flag parsing, exit codes and scope attribution are pinned by
 * `test/checkDepsAudit.test.ts`, which spawns it against offline fixtures.
 *
 * Usage:
 *   npm run check:deps-audit [-- --audit-json=<path> --discovery-audit-json=<path>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { argv, cwd, exit } from "node:process";

import {
  auditReportProblem,
  CHECK_NAME,
  combineAuditJson,
  evaluateAudit,
  extractAdvisories,
  formatFailureLog,
  formatPassLog,
} from "./lib/depsAuditCheck.mjs";

/** Lockfile scopes the gate evaluates, in log order. */
const SCOPES = [
  {
    key: "audit-json",
    lockfile: "package-lock.json",
    auditArgs: ["audit", "--omit=dev", "--json"],
    auditCwd: null, // repo root (this wrapper's cwd)
    auditHelp: "parse a saved root `npm audit --omit=dev --json` file instead of",
  },
  {
    key: "discovery-audit-json",
    lockfile: "tools/api-discovery/package-lock.json",
    // Explicit --include=dev: the package ships only devDependencies, and
    // ambient NODE_ENV=production / npm_config_omit=dev would otherwise
    // make npm audit an empty tree and pass vacuously.
    auditArgs: ["audit", "--include=dev", "--json"],
    auditCwd: "tools/api-discovery",
    auditHelp: "parse a saved discovery `npm audit --include=dev --json` file instead of",
  },
];

function flagValue(name) {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function usage() {
  return [
    "Usage: node scripts/check-deps-audit.mjs [--audit-json=<path>] [--discovery-audit-json=<path>]",
    "",
    ...SCOPES.flatMap((scope) => [
      `  --${scope.key}=<path>  ${scope.auditHelp}`,
      "                       running npm (offline debugging; CI always runs npm).",
    ]),
  ].join("\n");
}

for (const arg of argv.slice(2)) {
  if (!SCOPES.some((scope) => arg.startsWith(`--${scope.key}=`))) {
    console.error(`Unknown flag: ${arg}\n\n${usage()}`);
    exit(2);
  }
}

function readScope(scope) {
  const fixture = flagValue(scope.key);
  if (fixture !== null) {
    if (!fixture.trim()) {
      console.error(`${CHECK_NAME}: audit fixture path for --${scope.key} must not be empty`);
      exit(2);
    }
    try {
      return readFileSync(path.resolve(fixture), "utf8");
    } catch (error) {
      console.error(`${CHECK_NAME}: cannot read audit fixture ${fixture}: ${error.message}`);
      exit(2);
    }
  }
  try {
    return execFileSync("npm", scope.auditArgs, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      cwd: scope.auditCwd ? path.resolve(cwd(), scope.auditCwd) : undefined,
    });
  } catch (error) {
    const raw = error?.stdout ? String(error.stdout) : "";
    if (!raw) {
      console.error(
        `${CHECK_NAME}: npm audit did not run for ${scope.lockfile} ` +
          `(no JSON on stdout): ${error?.message ?? error}`,
      );
      exit(2);
    }
    // else: npm exits 1 when vulns are found — the JSON below is the verdict input.
    return raw;
  }
}

const parsedByScope = new Map();
for (const scope of SCOPES) {
  let parsed;
  try {
    parsed = JSON.parse(readScope(scope));
  } catch (error) {
    console.error(
      `${CHECK_NAME}: could not parse npm audit JSON for ${scope.lockfile}: ${error.message}`,
    );
    exit(2);
  }
  const problem = auditReportProblem(parsed);
  if (problem) {
    console.error(`${CHECK_NAME}: npm audit did not produce a usable report for ${scope.lockfile}: ${problem}`);
    exit(2);
  }
  parsedByScope.set(scope.lockfile, parsed);
}

const advisoriesByScope = new Map(
  [...parsedByScope].map(([lockfile, parsed]) => [lockfile, extractAdvisories(parsed)]),
);
const outcome = evaluateAudit(combineAuditJson([...parsedByScope.values()]));

function scopeSummary() {
  return SCOPES.map(
    (scope) =>
      `${scope.lockfile}: ${advisoriesByScope.get(scope.lockfile)?.size ?? 0} advisories`,
  ).join("; ");
}

/** Name the lockfile(s) that reported a blocking advisory (scope proof). */
function scopeOf(advisoryId) {
  return SCOPES.filter((scope) => advisoriesByScope.get(scope.lockfile)?.has(advisoryId)).map(
    (scope) => scope.lockfile,
  );
}

if (outcome.ok) {
  console.log(formatPassLog(outcome));
  console.log(`${CHECK_NAME}: scopes — ${scopeSummary()}`);
  exit(0);
}

console.error(formatFailureLog(outcome));
for (const advisory of outcome.blocking) {
  console.error(`  scope: ${advisory.id} reported by ${scopeOf(advisory.id).join(", ") || "?"}`);
}
console.error(`${CHECK_NAME}: scopes — ${scopeSummary()}`);
exit(1);
