#!/usr/bin/env node
/**
 * R2 snapshot-manifest verifier (gap R3-06).
 *
 * Re-downloads one UTC date's archived CSVs from R2, re-hashes the bytes,
 * and compares against the sidecar `snapshots/<date>.manifest.json` written
 * by `src/lib/r2SnapshotArchive.ts`. A tampered (or truncated, or dropped)
 * CSV fails loudly by name with both hashes — `FAIL <table>.csv ...`.
 *
 * Credential-free in local mode (Miniflare R2 under a `--persist-to` dir);
 * remote mode issues read-only GETs and needs `CLOUDFLARE_API_TOKEN` in the
 * environment, never a flag. Object bytes are hashed in memory and never
 * printed: failures name keys and hex hashes only, never row data
 * (CONVENTIONS.md §4–5).
 *
 * Pure logic lives in `./lib/r2ManifestVerify.mjs` and is unit-tested; this
 * wrapper is intentionally thin (fetch + exit code).
 *
 * Usage:
 *   node scripts/verify-r2-manifest.mjs [--date=YYYY-MM-DD] [--bucket=<name>]
 *       [--persist-to=<dir>] [--remote]
 *
 * Reviewer acceptance path (local-miniflare fixture, no credentials):
 *
 *   export FIX="$PAPERCLIP_RUN_SCRATCH_DIR/r2fix"  # or any scratch dir
 *   mkdir -p "$FIX" && cd <repo>
 *   printf 'CustomerID,Name\n1,ExampleCo\n' > "$FIX/customer.csv"
 *   cp "$FIX/customer.csv" "$FIX/address.csv"
 *   npx wrangler r2 object put --local --persist-to "$FIX/persist" \
 *     routeware-csv-snapshots/snapshots/2026-09-28/customer.csv --file "$FIX/customer.csv"
 *   npx wrangler r2 object put --local --persist-to "$FIX/persist" \
 *     routeware-csv-snapshots/snapshots/2026-09-28/address.csv --file "$FIX/address.csv"
 *   # write the sidecar with real hashes (node one-liner prints JSON):
 *   node -e 'const {readFileSync}=require("node:fs");const {createHash}=require("node:crypto");const h=f=>createHash("sha256").update(readFileSync(f)).digest("hex");const s=f=>readFileSync(f).length;console.log(JSON.stringify({version:1,date:"2026-09-28",files:{...Object.fromEntries(["customer.csv","address.csv"].map(n=>[n,{key:`snapshots/2026-09-28/${n}`,sha256:h(`${process.env.FIX}/${n}`),bytes:s(`${process.env.FIX}/${n}`)}]))}},null,2))' > "$FIX/manifest.json"
 *   npx wrangler r2 object put --local --persist-to "$FIX/persist" \
 *     routeware-csv-snapshots/snapshots/2026-09-28.manifest.json --file "$FIX/manifest.json" \
 *     --content-type 'application/json; charset=utf-8'
 *   node scripts/verify-r2-manifest.mjs --date=2026-09-28 --persist-to "$FIX/persist"
 *   # → r2-manifest: PASS … 2 passed, 0 mismatched, 0 missing (exit 0)
 *
 *   # Tamper one byte and re-upload only the CSV (the manifest still pins the old hash):
 *   printf 'CustomerID,Name\n1,ExampleCoX\n' > "$FIX/customer.csv"
 *   npx wrangler r2 object put --local --persist-to "$FIX/persist" \
 *     routeware-csv-snapshots/snapshots/2026-09-28/customer.csv --file "$FIX/customer.csv"
 *   node scripts/verify-r2-manifest.mjs --date=2026-09-28 --persist-to "$FIX/persist"
 *   # → FAIL customer.csv … sha256 mismatch … (exit 1)
 *
 * Exit 0 when every manifest entry verifies; exit 1 on any mismatch, missing
 * object, or unreadable manifest; exit 2 on flag/usage errors.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { argv, env, exit } from "node:process";

import {
  CHECK_NAME,
  formatVerifyReport,
  parseManifest,
  sha256HexBytes,
  verifyManifestHashes,
} from "./lib/r2ManifestVerify.mjs";
import { handleHelpFlag } from "./lib/usage.mjs";

// Same bucket the Worker's `SNAPSHOTS` binding targets (see wrangler.toml
// `[[r2_buckets]]`). Read-only here: local runs read a scratch persist dir,
// remote runs issue GETs only.
const DEFAULT_BUCKET = "routeware-csv-snapshots";

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

function usage() {
  return [
    `Usage: node scripts/verify-r2-manifest.mjs [--date=YYYY-MM-DD] [--bucket=<name>] [--persist-to=<dir>] [--remote]`,
    ``,
    `R2 snapshot-manifest verifier: re-downloads one date's archived CSVs, re-hashes bytes, and compares to the sidecar manifest.`,
    ``,
    `  --date=<YYYY-MM-DD>  archive date (default: today, UTC).`,
    `  --bucket=<name>      R2 bucket (default ${DEFAULT_BUCKET}).`,
    `  --persist-to=<dir>   local Miniflare persist dir (local mode only).`,
    `  --remote             read remote R2 (needs CLOUDFLARE_API_TOKEN in env);`,
    `                       default is --local (credential-free).`,
    `  -h, --help           print this usage and exit 0.`,
    ``,
    `  Value flags accept either spelling: --persist-to=<dir> or --persist-to <dir>.`,
    ``,
    `Exit codes:`,
    `  0  Every manifest entry verifies.`,
    `  1  Mismatch, missing object, or unreadable manifest.`,
    `  2  Flag or usage error.`,
    ``,
    `Example:`,
    `  node scripts/verify-r2-manifest.mjs --date=2026-09-28 --persist-to=/tmp/r2fix/persist`,
  ].join("\n");
}

handleHelpFlag(argv.slice(2), usage());

// Value flags accept `--name=value` and `--name value` alike (the reviewer
// path in the header comment uses the space form; `=` keeps wrangler-style
// one-token flags working).
const VALUE_FLAGS = new Set(["date", "bucket", "persist-to"]);
const values = {};
let remote = false;

const rawArgs = argv.slice(2);
for (let i = 0; i < rawArgs.length; i++) {
  const arg = rawArgs[i];
  if (arg === "--remote") {
    remote = true;
    continue;
  }
  const eq = arg.indexOf("=");
  const name = (eq === -1 ? arg : arg.slice(0, eq)).replace(/^--/, "");
  if (!arg.startsWith("--") || !VALUE_FLAGS.has(name)) {
    console.error(`${CHECK_NAME}: unknown flag: ${arg}\n\n${usage()}`);
    exit(2);
  }
  if (eq === -1) {
    const next = rawArgs[i + 1];
    if (next === undefined || next.startsWith("--")) {
      console.error(`${CHECK_NAME}: ${arg} needs a value\n\n${usage()}`);
      exit(2);
    }
    values[name] = next;
    i++;
  } else {
    values[name] = arg.slice(eq + 1);
  }
}

const dateFlag = values.date ?? null;
const date = dateFlag ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`${CHECK_NAME}: --date must be YYYY-MM-DD, got ${JSON.stringify(dateFlag)}\n\n${usage()}`);
  exit(2);
}
const bucket = values.bucket ?? DEFAULT_BUCKET;
const persistTo = values["persist-to"] ?? null;

if (remote && persistTo) {
  console.error(`${CHECK_NAME}: --persist-to is local-only; drop it with --remote\n\n${usage()}`);
  exit(2);
}
if (remote && !env.CLOUDFLARE_API_TOKEN?.trim()) {
  console.error(
    `${CHECK_NAME}: --remote needs CLOUDFLARE_API_TOKEN in the environment (never a flag or log).`
  );
  exit(1);
}

/** Raw object bytes via `wrangler r2 object get --pipe`; null when the key is absent. */
function getObjectBytes(key) {
  const args = ["r2", "object", "get", "--pipe", remote ? "--remote" : "--local", `${bucket}/${key}`];
  if (persistTo) args.push("--persist-to", persistTo);
  try {
    return execFileSync("npx", ["wrangler", ...args], {
      cwd: root,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = String(error.stderr?.toString() ?? error.message);
    if (/does not exist/i.test(stderr)) return null;
    console.error(`${CHECK_NAME}: FAIL — wrangler r2 object get ${key} failed:\n${stderr.slice(0, 2000)}`);
    exit(1);
  }
}

function fail(msg) {
  console.error(`${CHECK_NAME}: FAIL — ${msg}`);
  exit(1);
}

const manifestKey = `snapshots/${date}.manifest.json`;
const manifestBytes = getObjectBytes(manifestKey);
if (manifestBytes === null) {
  fail(`manifest ${manifestKey} not found in bucket ${bucket} — nothing archived for ${date} (or wrong --date/--bucket).`);
}
const parsed = parseManifest(manifestBytes.toString("utf8"), manifestKey);
if (!parsed.ok) {
  fail(parsed.error);
}

const actual = [];
const missing = [];
for (const entry of parsed.manifest.files) {
  const bytes = getObjectBytes(entry.key);
  if (bytes === null) {
    missing.push(entry.name);
    continue;
  }
  actual.push({ name: entry.name, key: entry.key, sha256: sha256HexBytes(bytes), bytes: bytes.byteLength });
}

const result = verifyManifestHashes(parsed.manifest.files, actual, missing);
console.log(formatVerifyReport(manifestKey, result));
if (!result.ok) exit(1);
