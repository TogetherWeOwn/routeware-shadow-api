#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { env, argv, exit } from "node:process";
import {
  CHECK_NAME,
  evaluateGate,
  formatSkipLog,
  requireToken,
} from "./lib/shadowApiV1Gate.mjs";

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
