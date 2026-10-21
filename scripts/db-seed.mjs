#!/usr/bin/env node
/**
 * Local D1 seed: synthetic customer → address → container UPSERTs only.
 * Run `npm run db:migrate:local` first; this command never applies migrations.
 *
 * Usage: npm run db:seed -- [--persist-to=<dir>] [--dry-run] [--json]
 * No flag means ordinary local dev state. Explicit targets fail closed.
 * Dry-run is pure intent, not proof of migrations or current row availability.
 * Fixture IDs, ordered SQL and checks live in ./lib/dbSeed.mjs.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { argv, exit } from "node:process";
import { fileURLToPath } from "node:url";

import {
  CHECK_NAME,
  DATABASE,
  VERIFY_QUERIES,
  buildSeedPlan,
  buildSeedStatements,
  formatSeedReport,
  parseWranglerRows,
} from "./lib/dbSeed.mjs";
import { handleHelpFlag } from "./lib/usage.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return [
    "Usage: node scripts/db-seed.mjs [--persist-to=<dir>] [--dry-run] [--json]",
    "",
    "Local D1 seed: synthetic customer fixture, idempotent UPSERTs; always Wrangler --local.",
    "",
    "  --persist-to=<dir>  Non-empty scratch persist dir; absent means local dev state.",
    "                     Specify once; no remote, database, file or SQL overrides.",
    "  --dry-run          Plan only: no subprocesses, credential reads or state changes.",
    "  --json             One JSON stdout object (use npm run --silent for clean JSON).",
    "  -h, --help         Print this usage and exit 0, without executing anything.",
    "",
    "JSON schemaVersion=1: mode=local, database, target.persistTo (null=default),",
    "stage (arguments/plan/apply/verify/complete), outcome (error/planned/success), counts.",
    "Plans add fixtureIds, ordered effects/checks with stable IDs, SQL and limitations.",
    "Dry-run does NOT check migrations or current row availability.",
    "Errors add error: {code: DB_SEED_*, retryable: false, next_action: correction}.",
    "No raw child stdout/stderr or exception messages are included in JSON.",
    "",
    "Exit codes: 0 = verified success, plan or help; 1 = execution/verification failure;",
    "            2 = invalid/duplicate target, remote request or unknown argument.",
    "",
    "Examples:",
    "  npm run db:seed",
    "  npm run --silent db:seed -- --dry-run --json --persist-to=./scratch/d1",
    "  npm run --silent db:seed -- --json --persist-to=./scratch/d1",
  ].join("\n");
}

const args = argv.slice(2);
handleHelpFlag(args, usage());
const json = args.includes("--json");
const targets = args.filter((arg) => arg === "--persist-to" || arg.startsWith("--persist-to="));
let persistTo = null;
const counts = {};

// Only fixed, actionable diagnostics cross the child-process boundary.
const ERRORS = {
  DB_SEED_INVALID_TARGET: [
    "Invalid local persist target.",
    "Use --persist-to=<non-empty-directory>; prefix a leading-dash path with ./.",
  ],
  DB_SEED_DUPLICATE_TARGET: [
    "Repeated or conflicting local persist targets.",
    "Supply exactly one --persist-to=<directory>, or omit it for local dev state.",
  ],
  DB_SEED_REMOTE_FORBIDDEN: [
    "Remote mode is forbidden.",
    "Remove --remote; db:seed supports only local synthetic fixtures.",
  ],
  DB_SEED_UNKNOWN_ARGUMENT: [
    "Unknown argument; command and SQL passthrough are not supported.",
    "Run npm run db:seed -- --help and use only the listed flags.",
  ],
  DB_SEED_APPLY_FAILED: [
    "Wrangler failed while applying the local fixture.",
    "Check the local target and run npm run db:migrate:local for that target before seeding.",
  ],
  DB_SEED_VERIFY_FAILED: [
    "Wrangler failed while verifying the local fixture.",
    "Inspect the selected local database and migrations before rerunning db:seed.",
  ],
  DB_SEED_INVALID_RESULT: [
    "Wrangler returned an invalid result.",
    "Check the installed Wrangler version and its local JSON result format before rerunning.",
  ],
  DB_SEED_COUNT_MISMATCH: [
    "Expected exactly one seeded row in each local fixture table.",
    "Inspect the selected local fixture rows and migrations before rerunning db:seed.",
  ],
};

function result(stage, outcome) {
  return { schemaVersion: 1, mode: "local", database: DATABASE, target: { persistTo }, stage, outcome, counts };
}

function fail(code, stage, status = 1) {
  const [message, next_action] = ERRORS[code];
  if (json) {
    console.log(JSON.stringify({ ...result(stage, "error"), error: { code, retryable: false, next_action } }));
  } else {
    console.error(`${CHECK_NAME}: FAIL — ${code}: ${message}\nNext action: ${next_action}`);
  }
  exit(status);
}

// Validate the entire argv before even planning. A bare -- is tolerated for
// legacy invocations but never enables arbitrary arguments after it.
if (args.some((arg) => arg === "--remote" || arg.startsWith("--remote="))) {
  fail("DB_SEED_REMOTE_FORBIDDEN", "arguments", 2);
}
if (targets.length > 1) fail("DB_SEED_DUPLICATE_TARGET", "arguments", 2);
if (targets.length === 1) {
  const target = targets[0].startsWith("--persist-to=") ? targets[0].slice("--persist-to=".length) : "";
  // A flag-looking value could be reinterpreted by Wrangler's argv parser.
  if (!target.trim() || target.trimStart().startsWith("-") || /[\u0000-\u001f\u007f]/.test(target)) {
    fail("DB_SEED_INVALID_TARGET", "arguments", 2);
  }
  persistTo = target;
}
if (args.some((arg) => !["--", "--dry-run", "--json", ...targets].includes(arg))) {
  fail("DB_SEED_UNKNOWN_ARGUMENT", "arguments", 2);
}

if (args.includes("--dry-run")) {
  const plan = buildSeedPlan(persistTo);
  if (json) console.log(JSON.stringify(plan));
  else {
    console.log(`${CHECK_NAME}: PLAN — ${DATABASE}, local target: ${persistTo ?? "default local dev state"}`);
    for (const effect of plan.effects) console.log(`  ${effect.id}: ${effect.operation} ${effect.table}`);
    for (const check of plan.checks) console.log(`  ${check.id}: expect ${check.expected} fixture row`);
    console.log("No execution. Migrations and current row availability are NOT checked.");
  }
  exit(0);
}

function runWrangler(sql, stage) {
  const flags = ["wrangler", "d1", "execute", DATABASE, "--local", "--command", sql, "--json"];
  if (persistTo !== null) flags.push("--persist-to", persistTo);
  let stdout;
  try {
    stdout = execFileSync("npx", flags, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    fail(stage === "apply" ? "DB_SEED_APPLY_FAILED" : "DB_SEED_VERIFY_FAILED", stage);
  }
  try {
    return parseWranglerRows(stdout);
  } catch {
    fail("DB_SEED_INVALID_RESULT", stage);
  }
}

// Apply once in FK order, then verify each fixture PK. Never accept missing,
// coerced booleans/null, extra rows or failed Wrangler envelopes as counts.
runWrangler(buildSeedStatements().join("; "), "apply");
for (const { table, sql } of VERIFY_QUERIES) {
  const rows = runWrangler(sql, "verify");
  const value = rows[0]?.n;
  const n = typeof value === "number" || (typeof value === "string" && /^\d+$/.test(value)) ? Number(value) : NaN;
  if (rows.length !== 1 || !Number.isSafeInteger(n) || n < 0) fail("DB_SEED_INVALID_RESULT", "verify");
  counts[table] = n;
  if (n !== 1) fail("DB_SEED_COUNT_MISMATCH", "verify");
}

console.log(json ? JSON.stringify(result("complete", "success")) : formatSeedReport(counts));
