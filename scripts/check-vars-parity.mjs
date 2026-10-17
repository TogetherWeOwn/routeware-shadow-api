#!/usr/bin/env node
/**
 * wrangler.toml [vars] vs .dev.vars.example parity gate (gap G20).
 *
 * A new var can land in one file but not the other: a fail-closed surprise at
 * deploy (Worker reads wrangler.toml) or a confusing local setup (wrangler
 * dev reads .dev.vars, documented by .dev.vars.example). Fails when keys
 * diverge in either direction; commented `# KEY=` entries in the example
 * count as documented (existing style for keys whose defaults live in
 * wrangler.toml). Secrets (LOGIN_*, SHADOW_API_TOKEN,
 * CUSTOMER_SNAPSHOT_SYNC_SECRET) belong in `.dev.vars` / `wrangler secret`
 * and are expected in the example without a wrangler `[vars]` counterpart.
 *
 * Credential-free: reads two text files and compares key names. Never prints
 * values — only key names.
 *
 * Pure logic lives in `./lib/varsParityCheck.mjs` and is unit-tested; this
 * wrapper is intentionally thin.
 *
 * Usage:
 *   npm run check:vars-parity [-- --wrangler=<path> --example=<path>]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { argv, exit } from "node:process";

import {
  CHECK_NAME,
  compareVarsParity,
  formatFailureLog,
  formatPassLog,
  parseExampleCommentedKeys,
} from "./lib/varsParityCheck.mjs";
import { parseDevVarsText, parseWranglerVarsSection } from "./lib/devVarsCheck.mjs";

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

function flagValue(name) {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function usage() {
  return [
    "Usage: node scripts/check-vars-parity.mjs [--wrangler=<path> --example=<path>]",
    "",
    "  --wrangler=<path>  wrangler.toml path (default <repo>/wrangler.toml).",
    "  --example=<path>   .dev.vars.example path (default <repo>/.dev.vars.example).",
  ].join("\n");
}

for (const arg of argv.slice(2)) {
  if (!arg.startsWith("--wrangler=") && !arg.startsWith("--example=")) {
    console.error(`Unknown flag: ${arg}\n\n${usage()}`);
    exit(2);
  }
}

const wranglerPath = path.resolve(root, flagValue("wrangler") ?? "wrangler.toml");
const examplePath = path.resolve(root, flagValue("example") ?? ".dev.vars.example");

function readOrDie(resolved, label) {
  try {
    return readFileSync(resolved, "utf8").replace(/^﻿/, "");
  } catch (error) {
    console.error(`${CHECK_NAME}: cannot read ${label} ${resolved}: ${error.message}`);
    exit(2);
  }
}

const wranglerText = readOrDie(wranglerPath, "wrangler.toml");
const exampleText = readOrDie(examplePath, ".dev.vars.example");

const wranglerVars = parseWranglerVarsSection(wranglerText);
const exampleActive = parseDevVarsText(exampleText);
const exampleCommented = parseExampleCommentedKeys(exampleText);

const outcome = compareVarsParity(wranglerVars, exampleActive, exampleCommented);

if (outcome.ok) {
  console.log(
    formatPassLog(
      Object.keys(wranglerVars).length,
      new Set([...Object.keys(exampleActive), ...exampleCommented]).size
    )
  );
  exit(0);
}

console.error(formatFailureLog(outcome));
exit(1);
