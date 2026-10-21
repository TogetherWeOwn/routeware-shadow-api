#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { env, argv, exit } from "node:process";
import {
  CHECK_NAME,
  evaluateGate,
  formatSkipLog,
  requireToken,
} from "./lib/shadowApiV1Gate.mjs";
import { handleHelpFlag } from "./lib/usage.mjs";

function usage() {
  return [
    "Usage: node scripts/check-shadow-api-v1.mjs [--unskip]",
    "",
    "Shadow API v1 gate: READY when CF_TOKEN is present, otherwise skipped until the operator credential card completes.",
    "",
    "  --unskip    Require CF_TOKEN now instead of skipping; fail when absent.",
    "  -h, --help  Print this usage and exit 0.",
    "",
    "Exit codes:",
    "  0  READY or skipped with a logged reason.",
    "  1  --unskip with a missing CF_TOKEN.",
    "",
    "Example:",
    "  node scripts/check-shadow-api-v1.mjs --unskip",
  ].join("\n");
}

handleHelpFlag(argv.slice(2), usage());

const unskip = argv.includes("--unskip");

function setOutput(status) {
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `status=${status}\n`);
}

if (unskip) {
  try {
    requireToken(env.CF_TOKEN);
  } catch (error) {
    console.error(error.message);
    exit(1);
  }
  console.log(`${CHECK_NAME}: READY (CF_TOKEN present; value redacted)`);
  setOutput("ready");
  exit(0);
}

const result = evaluateGate(env.CF_TOKEN);
if (result.status === "skipped") {
  console.log(formatSkipLog(result));
} else {
  console.log(`${CHECK_NAME}: READY (CF_TOKEN present; value redacted)`);
}
setOutput(result.status);
