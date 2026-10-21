#!/usr/bin/env node
/**
 * One-command config preflight (gap O3).
 *
 * Chains check:devvars + check:vars-parity + check:d1-drift (local-only,
 * credential-free — the read-only remote journal compare stays a
 * deploy-time concern behind `check:d1-drift --remote`) and prints one
 * pass/fail summary. Exit 0 when every leg passes, exit 1 otherwise,
 * exit 2 on unsupported arguments.
 *
 * `--json` prints exactly one versioned JSON object instead of human output;
 * `--dry-run` prints the check plan without spawning anything. Each leg is
 * bounded by CHECK_TIMEOUT_MS (see `./lib/verifyConfig.mjs`); a timed-out
 * leg aborts its child and the run continues with the remaining legs.
 *
 * Pure logic and CLI orchestration live in `./lib/verifyConfig.mjs` and are
 * unit-tested with injected fake runners; the real spawn runner lives in
 * `./lib/verifyConfigRunner.mjs`. This wrapper is intentionally thin.
 *
 * Usage:
 *   node scripts/verify-config.mjs [--json] [--dry-run]
 */
import path from "node:path";
import { argv, exit } from "node:process";

import { buildUsage, runCli } from "./lib/verifyConfig.mjs";
import { createSpawnRunner } from "./lib/verifyConfigRunner.mjs";
import { handleHelpFlag } from "./lib/usage.mjs";

handleHelpFlag(argv.slice(2), buildUsage());

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const runner = createSpawnRunner({ cwd: root });

const code = await runCli(argv.slice(2), {
  runner,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
exit(code);
