#!/usr/bin/env node
/**
 * R2 lifecycle proposal shape guard (TOG-25213, R9-05).
 *
 * Validates `docs/r2-lifecycle-proposal.snapshot-history.json` stays a
 * byte-clean S3 `PutBucketLifecycleConfiguration` body: exact rule id,
 * `Filter.Prefix`, and `Expiration`; `Status: Enabled` intent kept; no
 * `Transitions` element and no extra keys at any level. Fails the build on
 * drift so it surfaces here, not at apply time against a live bucket.
 *
 * Credential-free: reads one JSON file and compares shapes. Never prints
 * credentials (the file carries none) and never touches any bucket.
 *
 * Pure logic lives in `./lib/r2LifecycleProposalCheck.mjs` and is
 * unit-tested; this wrapper is intentionally thin.
 *
 * Usage:
 *   npm run check:r2-lifecycle-proposal [-- --file=<path>]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { argv, exit } from "node:process";

import {
  CHECK_NAME,
  evaluateR2LifecycleProposal,
} from "./lib/r2LifecycleProposalCheck.mjs";

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

function flagValue(name) {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function usage() {
  return [
    "Usage: node scripts/check-r2-lifecycle-proposal.mjs [--file=<path>]",
    "",
    "  --file=<path>  Proposal JSON path (default docs/r2-lifecycle-proposal.snapshot-history.json).",
  ].join("\n");
}

for (const arg of argv.slice(2)) {
  if (!arg.startsWith("--file=")) {
    console.error(`Unknown flag: ${arg}\n\n${usage()}`);
    exit(2);
  }
}

const filePath = path.resolve(
  root,
  flagValue("file") ?? "docs/r2-lifecycle-proposal.snapshot-history.json"
);

let raw;
try {
  raw = readFileSync(filePath, "utf8");
} catch (error) {
  console.error(`${CHECK_NAME}: cannot read ${filePath}: ${error.message}`);
  exit(2);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (error) {
  console.error(`${CHECK_NAME}: ${filePath} is not valid JSON: ${error.message}`);
  exit(1);
}

const result = evaluateR2LifecycleProposal(parsed);
if (result.ok) {
  console.log(`${CHECK_NAME}: OK — ${path.relative(root, filePath)} matches the proposed S3 lifecycle shape`);
  exit(0);
}

for (const line of result.errors) console.error(line);
exit(1);
