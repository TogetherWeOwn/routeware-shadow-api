#!/usr/bin/env node
/**
 * One-command config preflight (gap O3).
 *
 * Chains check:devvars + check:vars-parity + check:d1-drift (local-only,
 * credential-free — the read-only remote journal compare stays a
 * deploy-time concern behind `check:d1-drift --remote`) and prints one
 * pass/fail summary. Exit 0 when every leg passes, exit 1 otherwise.
 *
 * Pure logic lives in `./lib/verifyConfig.mjs` and is unit-tested; this
 * wrapper is intentionally thin.
 *
 * Usage:
 *   npm run verify:config
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { argv, exit } from "node:process";

import { CHECKS, CHECK_NAME, formatSummary, summarizeResults } from "./lib/verifyConfig.mjs";
import { handleHelpFlag } from "./lib/usage.mjs";

function usage() {
  return [
    "Usage: node scripts/verify-config.mjs",
    "",
    "One-command config preflight: chains check:devvars + check:vars-parity + check:d1-drift (local-only) with one summary.",
    "",
    "  -h, --help  Print this usage and exit 0.",
    "",
    "Exit codes:",
    "  0  Every leg passes.",
    "  1  Any leg fails.",
    "",
    "Example:",
    "  node scripts/verify-config.mjs",
  ].join("\n");
}

handleHelpFlag(argv.slice(2), usage());

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

const results = [];
for (const { name, script, args } of CHECKS) {
  process.stdout.write(`--- ${name} ---\n`);
  try {
    execFileSync("node", [script, ...args], { cwd: root, stdio: "inherit" });
    results.push({ name, ok: true });
  } catch {
    // The leg already printed its own detail; record the failure for the
    // single summary below. Never print values — legs name keys only.
    results.push({ name, ok: false });
  }
}

const summary = summarizeResults(results);
console.log(`\n${formatSummary(summary)}`);
exit(summary.ok ? 0 : 1);
