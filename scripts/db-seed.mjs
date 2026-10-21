#!/usr/bin/env node
/**
 * Local D1 seed.
 *
 * Loads a minimal synthetic customer → address → container fixture into the
 * LOCAL Miniflare D1 (`wrangler d1 execute ... --local`). Run after
 * `npm run db:migrate:local` on a fresh clone:
 *
 *   npm run db:migrate:local
 *   npm run db:seed
 *
 * Idempotent: the fixture writes are `ON CONFLICT DO UPDATE` UPSERTs pinned
 * to 90000-range PKs, so re-running converges to the same rows (never a
 * duplicate, never touching real synced ids). Synthetic data only — `Seed*`
 * names, the fictional 555-0100 range, zip 00000 (CONVENTIONS.md sections
 * 4-5: no PII in the tree, and this script writes only the fixture above).
 *
 * Local-only by design: there is no `--remote` flag. Never point this at a
 * deployed D1 (`npm run db:migrate:remote` is already CD-owned).
 *
 * Pure logic lives in `./lib/dbSeed.mjs` and is unit-tested in
 * `test/dbSeed.test.ts`; this wrapper is intentionally thin.
 *
 * Usage:
 *   npm run db:seed
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { argv, exit } from "node:process";

import {
  CHECK_NAME,
  DATABASE,
  VERIFY_QUERIES,
  buildSeedStatements,
  formatSeedReport,
  parseWranglerRows,
} from "./lib/dbSeed.mjs";
import { handleHelpFlag } from "./lib/usage.mjs";

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

function usage() {
  return [
    "Usage: node scripts/db-seed.mjs [--persist-to=<dir>]",
    "",
    "Local D1 seed: loads a minimal synthetic customer fixture into local Miniflare D1 (idempotent UPSERTs).",
    "",
    "  --persist-to=<dir>  Scratch persist dir; keeps verification runs off local dev state.",
    "  -h, --help          Print this usage and exit 0.",
    "",
    "Exit codes:",
    "  0  Fixture applied and every row verified.",
    "  1  Wrangler fails or a row count mismatches.",
    "  2  Unknown flag.",
    "",
    "Example:",
    "  node scripts/db-seed.mjs --persist-to=/tmp/d1-verify",
  ].join("\n");
}

handleHelpFlag(argv.slice(2), usage());

// Scratch-dir support (same pattern as check-d1-drift): `--persist-to` keeps
// verification runs off local dev state. Unknown flags are rejected loudly.
const persistArg = argv.find((a) => a.startsWith("--persist-to="));
for (const arg of argv.slice(2).filter((a) => a !== "--")) {
  if (arg !== persistArg) {
    console.error(`${CHECK_NAME}: unknown flag ${arg} (only --persist-to=<dir> is supported)`);
    exit(2);
  }
}
const persistTo = persistArg ? persistArg.slice("--persist-to=".length) : null;

function runWrangler(sql) {
  const args = ["wrangler", "d1", "execute", DATABASE, "--local", "--command", sql, "--json"];
  if (persistTo) args.push("--persist-to", persistTo);
  try {
    return execFileSync("npx", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String(error.stderr ?? error.message).slice(0, 2000);
    console.error(`${CHECK_NAME}: FAIL — wrangler d1 execute --local failed:`);
    console.error(stderr);
    console.error("Run `npm run db:migrate:local` first so the snapshot tables exist.");
    exit(1);
  }
}

// 1. Apply the fixture batch in FK order (customers → addresses → containers).
runWrangler(buildSeedStatements().join("; "));

// 2. Verify each fixture row is present; fail loudly on a half-applied batch.
const counts = {};
for (const { table, sql } of VERIFY_QUERIES) {
  let rows;
  try {
    rows = parseWranglerRows(runWrangler(sql));
  } catch (error) {
    console.error(`${CHECK_NAME}: FAIL — ${error.message}`);
    exit(1);
  }
  const n = Number(rows[0]?.n);
  counts[table] = Number.isFinite(n) ? n : 0;
  if (counts[table] !== 1) {
    console.error(
      `${CHECK_NAME}: FAIL — expected exactly 1 seeded row in ${table}, found ${counts[table]}.`,
    );
    exit(1);
  }
}

console.log(formatSeedReport(counts));
