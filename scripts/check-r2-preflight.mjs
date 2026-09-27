#!/usr/bin/env node
/**
 * R2 bucket-existence preflight (TOG-6290). Deploy-time, read-only:
 * `wrangler r2 bucket info <name> --json` (a head/lookup, never a write).
 *
 * - `SNAPSHOTS_R2_ENABLED=false` (wrangler.toml `[vars]`, dashboard
 *   Variable, or env) → SKIPPED, exit 0. The archive leg is off by design.
 * - Bucket missing/unreadable → FAIL with the exact fix, exit 1.
 * - Bucket present → PASS, exit 0.
 *
 * Auth comes from the environment (`CLOUDFLARE_API_TOKEN` in CI); the token
 * value is never printed. Pure logic lives in `./lib/r2Preflight.mjs` and is
 * unit-tested; this wrapper is intentionally thin.
 *
 * Usage:
 *   npm run check:r2-preflight [-- --bucket=<name>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { argv, env, exit } from "node:process";
import {
  CHECK_NAME,
  formatMissingBucketError,
  formatNoBucketConfiguredError,
  formatPassLog,
  formatSkipLog,
  resolvePreflightInput,
} from "./lib/r2Preflight.mjs";

function usage() {
  return [
    "Usage: node scripts/check-r2-preflight.mjs [--bucket=NAME]",
    "",
    "  --bucket=NAME  Override the SNAPSHOTS bucket name (default: wrangler.toml",
    "                 [[r2_buckets]] binding, or SNAPSHOTS_BUCKET from the environment).",
    "",
    "Reads SNAPSHOTS_R2_ENABLED from the environment first, then wrangler.toml [vars].",
  ].join("\n");
}

function main() {
  let bucketOverride = null;
  for (const arg of argv.slice(2)) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      exit(0);
    } else if (arg.startsWith("--bucket=")) {
      bucketOverride = arg.slice("--bucket=".length).trim() || null;
    } else {
      console.error(`Unknown flag: ${arg}\n\n${usage()}`);
      exit(1);
    }
  }

  let toml;
  try {
    toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  } catch {
    console.error(`${CHECK_NAME}: FAIL — cannot read wrangler.toml`);
    exit(1);
  }

  const mergedEnv = bucketOverride ? { ...env, SNAPSHOTS_BUCKET: bucketOverride } : env;
  const { enabled, bucket } = resolvePreflightInput({ env: mergedEnv, tomlText: toml });

  if (!enabled) {
    console.log(formatSkipLog());
    exit(0);
  }
  if (!bucket) {
    console.error(formatNoBucketConfiguredError());
    exit(1);
  }

  try {
    // Read-only lookup; auth via CLOUDFLARE_API_TOKEN in the environment.
    execFileSync("npx", ["wrangler", "r2", "bucket", "info", bucket, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch {
    console.error(formatMissingBucketError(bucket));
    exit(1);
  }
  console.log(formatPassLog(bucket));
}

main();
