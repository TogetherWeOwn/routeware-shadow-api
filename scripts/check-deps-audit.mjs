#!/usr/bin/env node
/**
 * Prod dependency audit gate (TOG-8904).
 *
 * Runs `npm audit --omit=dev --json` and fails on any high/critical advisory
 * that is not explicitly allowlisted in `./lib/depsAuditCheck.mjs`.
 * Moderate/low advisories are reported but never block (mostly Hono
 * middleware adapters this Worker never mounts — gating on those would hold
 * the gate permanently red).
 *
 * Prod-only is deliberate: devDependencies never ship to the Worker, and
 * their advisory surface would drown the production signal.
 *
 * Credential-free: reads package-lock.json plus public registry advisory
 * data. Never prints credentials — findings name GHSA ids and packages only.
 *
 * `npm audit` exits 1 when vulnerabilities are found, but still prints the
 * full JSON report to stdout — so stdout is parsed even on nonzero exit.
 * Exit 2 is reserved for "the audit itself could not run" (no network,
 * unparsable output): that is an infrastructure failure, not a FAIL verdict.
 *
 * Pure logic lives in `./lib/depsAuditCheck.mjs` and is unit-tested with
 * fixture audit JSON (the suite never reaches the registry); this wrapper
 * is intentionally thin.
 *
 * Usage:
 *   npm run check:deps-audit [-- --audit-json=<path>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { argv, exit } from "node:process";

import {
  CHECK_NAME,
  evaluateAudit,
  formatFailureLog,
  formatPassLog,
} from "./lib/depsAuditCheck.mjs";

function flagValue(name) {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function usage() {
  return [
    "Usage: node scripts/check-deps-audit.mjs [--audit-json=<path>]",
    "",
    "  --audit-json=<path>  parse a saved `npm audit --json` file instead of",
    "                       running npm (offline debugging; CI always runs npm).",
  ].join("\n");
}

for (const arg of argv.slice(2)) {
  if (!arg.startsWith("--audit-json=")) {
    console.error(`Unknown flag: ${arg}\n\n${usage()}`);
    exit(2);
  }
}

let raw;
const fixture = flagValue("audit-json");
if (fixture) {
  try {
    raw = readFileSync(path.resolve(fixture), "utf8");
  } catch (error) {
    console.error(`${CHECK_NAME}: cannot read audit fixture ${fixture}: ${error.message}`);
    exit(2);
  }
} else {
  try {
    raw = execFileSync("npm", ["audit", "--omit=dev", "--json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    raw = error?.stdout ? String(error.stdout) : "";
    if (!raw) {
      console.error(
        `${CHECK_NAME}: npm audit did not run (no JSON on stdout): ${error?.message ?? error}`,
      );
      exit(2);
    }
    // else: npm exits 1 when vulns are found — the JSON below is the verdict input.
  }
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (error) {
  console.error(`${CHECK_NAME}: could not parse npm audit JSON: ${error.message}`);
  exit(2);
}

const outcome = evaluateAudit(parsed);

if (outcome.ok) {
  console.log(formatPassLog(outcome));
  exit(0);
}

console.error(formatFailureLog(outcome));
exit(1);
