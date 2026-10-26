#!/usr/bin/env node
/**
 * D1 migration drift check.
 *
 * Verifies `migrations/d1/*.sql` applied state matches between local and
 * remote D1 (file list + sha256 checksum compare). Read-only everywhere:
 * the only write is applying migrations to a throwaway local database under
 * a scratch `--persist-to` directory, never to local dev state or remote.
 *
 * Modes:
 *   node scripts/check-d1-drift.mjs            local check (credential-free,
 *                                              safe for CI hygiene/build)
 *   node scripts/check-d1-drift.mjs --remote   also compares the remote
 *                                              journal (read-only SELECT);
 *                                              requires CLOUDFLARE_API_TOKEN
 *                                              in the environment, never a
 *                                              CLI flag, and its value is
 *                                              never printed.
 *
 * Testability flags (default to the repo layout). These redirect the
 * file/manifest side of the check so synthetic drift fixtures can be
 * exercised without touching the real tree; the local-apply stage always
 * uses the repo's wrangler.toml, so a fixture must be a full copy of the
 * real migrations dir for the journal compare to be meaningful:
 *   --migrations-dir=<path>   directory holding *.sql (default migrations/d1)
 *   --manifest=<path>         sha256sum manifest (default <dir>/.sha256sum)
 *
 * Exit 0 when everything matches; exit 1 with a drift report otherwise.
 * When CLOUDFLARE_API_TOKEN is absent, the remote compare is skipped with an
 * explicit note — never reported as a pass.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { argv, env, exit } from "node:process";

import {
  CHECK_NAME,
  compareAppliedState,
  formatDriftReport,
  parseManifest,
  parseWranglerExecuteJson,
  verifyFileHashes,
} from "./lib/d1DriftCheck.mjs";
import { handleHelpFlag } from "./lib/usage.mjs";

function usage() {
  return [
    "Usage: node scripts/check-d1-drift.mjs [--remote] [--migrations-dir=<path> --manifest=<path>]",
    "",
    "D1 migration drift check: verifies migration files, manifest, and applied journal all match (read-only).",
    "",
    "  --remote                 Also compare the remote journal (read-only SELECT; needs CLOUDFLARE_API_TOKEN).",
    "  --migrations-dir=<path>  Directory holding *.sql (default migrations/d1).",
    "  --manifest=<path>        sha256sum manifest (default <dir>/.sha256sum).",
    "  -h, --help               Print this usage and exit 0.",
    "",
    "Exit codes:",
    "  0  Everything matches; remote skipped with a note when no --remote flag.",
    "  1  Drift report, or remote requested without CLOUDFLARE_API_TOKEN.",
    "",
    "Example:",
    "  node scripts/check-d1-drift.mjs --remote",
  ].join("\n");
}

handleHelpFlag(argv.slice(2), usage());

// Same database the `db:migrate:*` npm scripts target (see wrangler.toml
// `[[d1_databases]]`). Read-only here: local runs use a scratch persist dir,
// remote runs issue a single SELECT.
const DATABASE = "routeware-customer-snapshot";
const JOURNAL_SQL = "SELECT name FROM d1_migrations ORDER BY id;";

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

function flagValue(name) {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

const remote = argv.includes("--remote");
const migrationsDir = path.resolve(root, flagValue("migrations-dir") ?? "migrations/d1");
const manifestPath = path.resolve(root, flagValue("manifest") ?? path.join(migrationsDir, ".sha256sum"));

function fail(lines) {
  for (const line of lines) console.error(`${CHECK_NAME}: ${line}`);
  exit(1);
}

function shaFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath), "utf8").digest("hex");
}

// 1. Files on disk vs checked-in manifest (catches post-apply edits).
let manifestEntries;
try {
  manifestEntries = parseManifest(readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail([`cannot read manifest ${manifestPath}: ${error.message}`]);
}
const sqlFiles = readdirSync(migrationsDir)
  .filter((n) => n.endsWith(".sql"))
  .sort();
const actual = sqlFiles.map((name) => ({ name, sha: shaFile(path.join(migrationsDir, name)) }));
const hashCheck = verifyFileHashes(actual, manifestEntries);
if (!hashCheck.ok) {
  fail([
    `migration files do not match ${path.relative(root, manifestPath)}:`,
    ...formatDriftReport({ hashCheck, stateCheck: null }),
    "If you added/removed/edited a migration, regenerate the manifest:",
    "  sha256sum migrations/d1/*.sql | sed 's|migrations/d1/||' > migrations/d1/.sha256sum",
  ]);
}

function runWrangler(args, persistDir) {
  const fullArgs = [...args];
  if (persistDir) fullArgs.push("--persist-to", persistDir);
  try {
    return execFileSync("npx", ["wrangler", ...fullArgs], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String(error.stderr ?? error.message).slice(0, 2000);
    fail([`wrangler ${args.join(" ")} failed:`, stderr]);
  }
}

function readJournal(applyArgs, persistDir) {
  const stdout = runWrangler(
    ["d1", "execute", DATABASE, ...applyArgs, "--command", JOURNAL_SQL, "--json"],
    persistDir
  );
  try {
    return parseWranglerExecuteJson(stdout);
  } catch (error) {
    fail([error.message]);
  }
}

// 2. Fresh local apply, then compare its journal to the file list.
const scratchBase = env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir();
const persistDir = mkdtempSync(path.join(scratchBase, `${CHECK_NAME}-`));
runWrangler(["d1", "migrations", "apply", DATABASE, "--local"], persistDir);
const localApplied = readJournal(["--local"], persistDir);
const localCheck = compareAppliedState(sqlFiles, localApplied);
if (!localCheck.ok) {
  fail([
    "local D1 journal does not match migration files after a fresh apply:",
    ...formatDriftReport({ hashCheck: null, stateCheck: localCheck }),
  ]);
}
console.log(
  `${CHECK_NAME}: local OK — ${sqlFiles.length} file(s), manifest match, fresh local apply journal match`
);

// 3. Remote journal compare (read-only SELECT), only when asked and credentialed.
if (!remote) {
  console.log(
    `${CHECK_NAME}: remote compare SKIPPED (no --remote flag; set CLOUDFLARE_API_TOKEN and pass --remote for the read-only remote check)`
  );
  exit(0);
}
if (!env.CLOUDFLARE_API_TOKEN?.trim()) {
  fail([
    "remote compare requested but CLOUDFLARE_API_TOKEN is absent.",
    "Provide it via the environment (never a flag or log) or run without --remote.",
  ]);
}
const remoteApplied = readJournal(["--remote"], null);
const remoteCheck = compareAppliedState(sqlFiles, remoteApplied);
if (!remoteCheck.ok) {
  fail([
    "remote D1 journal does not match migration files:",
    ...formatDriftReport({ hashCheck: null, stateCheck: remoteCheck }),
    "Apply pending migrations (npm run db:migrate:remote) or restore the missing file; never edit an applied migration in place.",
  ]);
}
console.log(`${CHECK_NAME}: remote OK — journal matches ${sqlFiles.length} migration file(s)`);
