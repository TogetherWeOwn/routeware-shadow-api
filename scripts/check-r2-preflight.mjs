#!/usr/bin/env node
/**
 * R2 bucket-existence preflight. Deploy-time, read-only:
 * `wrangler r2 bucket info <name> --json` (a head/lookup, never a write).
 *
 * - `SNAPSHOTS_R2_ENABLED="false"` in the deployed config's `[vars]` → SKIPPED.
 * - Bucket missing/unreadable → FAIL with the exact fix, exit 1.
 * - Bucket present → PASS, exit 0.
 *
 * Pass the same top-level TOML config to this command and `wrangler deploy`.
 * Shell variables and dashboard Variables cannot disable this check or replace
 * the configured bucket: they are not deploy-time overrides of Wrangler vars.
 * Auth still comes from CLOUDFLARE_API_TOKEN; the token is never printed.
 *
 * Usage:
 *   npm run check:r2-preflight [-- --config=wrangler.toml]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { argv, exit } from "node:process";
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
    "Usage: node scripts/check-r2-preflight.mjs [--config=FILE]",
    "",
    "  --config=FILE  Top-level TOML config also passed to wrangler deploy.",
    "                 Default: wrangler.toml in the working directory.",
    "",
    'To disable R2, set SNAPSHOTS_R2_ENABLED="false" in that config\'s [vars].',
    "Shell SNAPSHOTS_R2_ENABLED / SNAPSHOTS_BUCKET and --bucket are not deploy overrides.",
  ].join("\n");
}

function main() {
  let config = "wrangler.toml";
  for (const arg of argv.slice(2)) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      exit(0);
    } else if (arg.startsWith("--config=") && arg.slice("--config=".length).trim()) {
      config = arg.slice("--config=".length);
    } else {
      console.error(`Unknown or empty flag: ${arg}\n\n${usage()}`);
      exit(1);
    }
  }

  const configPath = resolve(config);
  let toml;
  try {
    toml = readFileSync(configPath, "utf8");
  } catch {
    console.error(`${CHECK_NAME}: FAIL — cannot read config ${config}`);
    exit(1);
  }

  const { enabled, bucket } = resolvePreflightInput({ tomlText: toml });
  if (!enabled) {
    console.log(formatSkipLog());
    exit(0);
  }
  if (!bucket) {
    console.error(formatNoBucketConfiguredError());
    exit(1);
  }

  try {
    // Use the deploy config for account selection as well as vars/bindings.
    execFileSync("npx", ["wrangler", "r2", "bucket", "info", bucket, "--json", "--config", configPath], {
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
