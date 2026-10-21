#!/usr/bin/env node
/**
 * Read-only daily-alias verifier. Local by default; remote execution requires an
 * injected token, not a flag. Dry-run never launches Wrangler or touches objects.
 * See docs/R2-MANIFEST-VERIFY.md for the v1 JSON contract and recovery actions.
 */
import { execFileSync } from "node:child_process";
import { writeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { argv, env, exit } from "node:process";
import {
  ARCHIVE_TABLES, CHECK_NAME, formatVerifyReport, isArchiveDate,
  parseManifest, sha256HexBytes, verifyManifestHashes,
} from "./lib/r2ManifestVerify.mjs";
import { handleHelpFlag } from "./lib/usage.mjs";

const DEFAULT_BUCKET = "routeware-csv-snapshots";
const root = fileURLToPath(new URL("../", import.meta.url));
const rawArgs = argv.slice(2);

function usage() {
  return [
    "Usage: node scripts/verify-r2-manifest.mjs [--date=YYYY-MM-DD] [--bucket=<name>]",
    "       [--persist-to=<dir>] [--remote] [--expect=customer,address,container] [--dry-run] [--json]",
    "",
    "Verify daily CSV object identity, SHA-256 and byte size against the requested sidecar.",
    "  --date=<YYYY-MM-DD>  canonical UTC calendar date (default: today, UTC).",
    `  --bucket=<name>      R2 bucket (default ${DEFAULT_BUCKET}).`,
    "  --persist-to=<dir>   local Miniflare persistence only; forbidden with --remote.",
    "  --remote            read remote R2; requires CLOUDFLARE_API_TOKEN in env.",
    "                      Default is credential-free local mode; no remote grant is implied.",
    "  --expect=<tables>   nonempty unique subset of customer,address,container (bare names).",
    "                      Missing expected entries fail even when omitted from the sidecar.",
    "                      Default: listed-only (partial), not proof that all tables exist.",
    "  --dry-run           validate and print the plan; zero child processes, reads or writes.",
    "  --json              one bounded schemaVersion:1 result on stdout, stderr empty.",
    "  -h, --help          print usage with zero execution.",
    "",
    "Value flags accept --name=value or --name value; duplicate flags are errors.",
    "Exit codes: 0 = verification PASS or valid dry-run; 1 = verification/credential failure; 2 = invalid arguments.",
    "Example (full-chain local audit):",
    "  node scripts/verify-r2-manifest.mjs --date=2026-09-28 --persist-to=fixture-state --expect=customer,address,container --json",
    "Hermetic acceptance check: npm run check:r2-manifest",
  ].join("\n");
}
handleHelpFlag(rawArgs, usage());

// Fixed messages/actions, never interpolated driver errors, manifest values,
// flag values, persistence paths or credentials. At most three table findings.
const ERRORS = {
  R2_ARGUMENT_INVALID: ["Invalid arguments.", "Use --help; choose one real YYYY-MM-DD date and unique recognized --expect tables; do not combine --remote and --persist-to."],
  R2_REMOTE_CREDENTIAL_REQUIRED: ["Remote execution requires CLOUDFLARE_API_TOKEN in the environment.", "Use local mode, or obtain authorized environment injection of CLOUDFLARE_API_TOKEN. Never pass or print the token."],
  R2_OBJECT_MISSING: ["Required object is missing or unreadable; absence is not confirmed.", "Stop recovery. Confirm the authorized bucket/date, object availability and reader access privately; do not switch credentials or synthesize a manifest."],
  R2_MANIFEST_INVALID: ["Daily sidecar does not match the requested identity or supported schema.", "Stop recovery. Select a known-good daily archive; investigate publication privately. Never rewrite the sidecar to make verification pass."],
  R2_EXPECTED_TABLE_MISSING: ["An explicitly expected table is absent from the manifest.", "Stop full-chain recovery. Select an archive containing every expected table; do not narrow --expect without an approved partial-recovery plan."],
  R2_HASH_MISMATCH: ["Object identity, hash or byte size differs from the manifest.", "Stop recovery. Treat the archive as suspect and select a known-good archive; do not overwrite data or regenerate its integrity record."],
};
const json = rawArgs.includes("--json");
const report = {
  schemaVersion: 1, checkId: CHECK_NAME, ok: false,
  date: null, mode: rawArgs.includes("--remote") ? "remote" : "local",
  dryRun: rawArgs.includes("--dry-run"),
  coverage: { kind: "listed-only", expectedTables: [], verifiedTables: [] },
  checks: [], findings: [],
};
function check(id, status) {
  report.checks.push({ id: `${CHECK_NAME}.${id}`, status });
}
function finding(id, code, table = null) {
  const [message, next_action] = ERRORS[code];
  report.findings.push({ id: `${CHECK_NAME}.${id}`, code, message, retryable: false, next_action, ...(table ? { table } : {}) });
}
function finish(code, detail = "") {
  report.ok = code === 0;
  const text = json ? JSON.stringify(report) : [
    detail,
    ...report.findings.map((f) => `${CHECK_NAME}: FAIL ${f.table ? `${f.table}.csv: ` : ""}${f.code}: ${f.message} Next: ${f.next_action}`),
    `Coverage: ${report.coverage.kind === "listed-only" ? "listed-only (partial): not proof that all tables were archived" : `expected-tables: ${report.coverage.expectedTables.join(",")}`}.`,
  ].filter(Boolean).join("\n");
  // Synchronous bounded output also works for piped machine consumers.
  writeSync(1, `${text}\n`);
  exit(code);
}
function invalidArguments() {
  check("arguments", "fail");
  finding("arguments", "R2_ARGUMENT_INVALID");
  finish(2);
}

const VALUE_FLAGS = new Set(["date", "bucket", "persist-to", "expect"]);
const BOOL_FLAGS = new Set(["remote", "dry-run", "json"]);
const values = {};
const seenFlags = new Set();
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  const eq = arg.indexOf("=");
  const name = (eq < 0 ? arg : arg.slice(0, eq)).slice(2);
  if (!arg.startsWith("--") || seenFlags.has(name)) invalidArguments();
  seenFlags.add(name);
  if (BOOL_FLAGS.has(name) && eq < 0) continue;
  if (!VALUE_FLAGS.has(name)) invalidArguments();
  const value = eq < 0 ? rawArgs[++i] : arg.slice(eq + 1);
  if (!value || value.startsWith("-") || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) invalidArguments();
  values[name] = value;
}
const date = values.date ?? new Date().toISOString().slice(0, 10);
const bucket = values.bucket ?? DEFAULT_BUCKET;
const persistTo = values["persist-to"] ?? null;
const remote = report.mode === "remote";
if (!isArchiveDate(date) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) || (remote && persistTo)) invalidArguments();
let expectedTables = [];
if (values.expect !== undefined) {
  expectedTables = values.expect.split(",");
  if (expectedTables.some((table) => !ARCHIVE_TABLES.includes(table)) ||
      new Set(expectedTables).size !== expectedTables.length) invalidArguments();
  expectedTables.sort();
}
report.date = date;
report.coverage.kind = expectedTables.length ? "expected-tables" : "listed-only";
report.coverage.expectedTables = expectedTables;
check("arguments", "pass");
const manifestKey = `snapshots/${date}.manifest.json`;
if (report.dryRun) {
  check("plan", "pass");
  finish(0, `${CHECK_NAME}: DRY-RUN ${date} ${report.mode}; would read ${manifestKey} then validate listed keys before CSV reads. No objects verified.`);
}
if (remote && !env.CLOUDFLARE_API_TOKEN?.trim()) {
  check("credentials", "fail");
  finding("credentials", "R2_REMOTE_CREDENTIAL_REQUIRED");
  finish(1);
}
check("credentials", "pass");

/** A nonzero reader exit means unavailable, not proof of absence. Never emit stderr. */
function getObjectBytes(key, maxBuffer) {
  const args = ["--no-install", "wrangler", "r2", "object", "get", "--pipe", remote ? "--remote" : "--local", `${bucket}/${key}`];
  if (persistTo) args.push("--persist-to", persistTo);
  try {
    return execFileSync("npx", args, {
      cwd: root, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"],
      maxBuffer, timeout: 120_000,
    });
  } catch {
    return null;
  }
}
const manifestBytes = getObjectBytes(manifestKey, 64 * 1024);
if (manifestBytes === null) {
  check("manifest", "fail");
  finding("manifest-read", "R2_OBJECT_MISSING");
  finish(1);
}
const parsed = parseManifest(manifestBytes.toString("utf8"), manifestKey);
if (!parsed.ok) {
  check("manifest", "fail");
  finding("manifest-schema", "R2_MANIFEST_INVALID");
  finish(1);
}
check("manifest", "pass");
const files = parsed.manifest.files;
const absent = expectedTables.filter((table) => !files.some((file) => file.name === `${table}.csv`));
check("coverage", absent.length ? "fail" : "pass");
for (const table of absent) finding(`expected.${table}`, "R2_EXPECTED_TABLE_MISSING", table);
// A coverage failure stops before any CSV read. A deliberately partial manifest
// still verifies when no missing expectation was declared.
if (absent.length) finish(1);
const actual = [];
const missing = [];
for (const entry of files) {
  const bytes = getObjectBytes(entry.key, 256 * 1024 * 1024);
  if (bytes === null) missing.push(entry.name);
  else actual.push({ name: entry.name, key: entry.key, sha256: sha256HexBytes(bytes), bytes: bytes.byteLength });
}
const result = verifyManifestHashes(files, actual, missing);
report.coverage.verifiedTables = result.passed.map((name) => name.slice(0, -4));
for (const entry of files) {
  const table = entry.name.slice(0, -4);
  const passed = result.passed.includes(entry.name);
  check(`object.${table}`, passed ? "pass" : "fail");
  if (!passed) finding(`object.${table}`, missing.includes(entry.name) ? "R2_OBJECT_MISSING" : "R2_HASH_MISMATCH", table);
}
finish(result.ok ? 0 : 1, formatVerifyReport(manifestKey, result));
