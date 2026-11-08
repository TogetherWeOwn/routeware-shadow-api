#!/usr/bin/env node
import { runRehearsal } from "./lib/deployRehearsal.mjs";

// Fixed Actions-only entrypoint: no user-supplied command or remote option.
const receipt = process.argv.length === 2 ? runRehearsal({
  root: process.cwd(), scratch: process.env.REHEARSAL_SCRATCH,
  candidateSha: process.env.CANDIDATE_SHA, actions: process.env.GITHUB_ACTIONS,
}) : { schemaVersion: 1, scope: "offline", conclusion: "FAIL", errorCode: "invalid_arguments" };
console.log(JSON.stringify(receipt));
process.exitCode = receipt.conclusion === "PASS" ? 0 : 1;
