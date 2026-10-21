#!/usr/bin/env node
/**
 * Verifies `.dev.vars` exists beside wrangler.toml and defines the required
 * keys (does not print values).
 *
 * Parsing and validation live in `./lib/devVarsCheck.mjs` so the regression
 * tests in `test/devVarsCheck.test.ts` exercise the same code this CLI runs.
 */
import fs from "node:fs";
import path from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import {
  checkDevVarsValues,
  mergeEffectiveVars,
  parseDevVarsText,
  parseWranglerVarsSection
} from "./lib/devVarsCheck.mjs";
import { handleHelpFlag } from "./lib/usage.mjs";

function usage() {
  return [
    "Usage: node scripts/check-devvars.mjs",
    "",
    "Verifies .dev.vars exists beside wrangler.toml and defines the required keys (never prints values).",
    "",
    "  -h, --help  Print this usage and exit 0.",
    "",
    "Exit codes:",
    "  0  Effective dev vars define every required key.",
    "  1  Missing file or invalid values.",
    "",
    "Example:",
    "  node scripts/check-devvars.mjs",
  ].join("\n");
}

handleHelpFlag(argv.slice(2), usage());

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const devVarsPath = path.join(root, ".dev.vars");
const wranglerPath = path.join(root, "wrangler.toml");

if (!fs.existsSync(wranglerPath)) {
  console.error("Expected wrangler.toml at", wranglerPath);
  process.exit(1);
}

if (!fs.existsSync(devVarsPath)) {
  console.error(
    "Missing .dev.vars at:\n  " +
      devVarsPath +
      "\n\nCreate it (see .dev.vars.example). `wrangler secret put` does not apply to `wrangler dev`."
  );
  process.exit(1);
}

const raw = fs.readFileSync(devVarsPath, "utf8").replace(/^﻿/, "");
const devVars = parseDevVarsText(raw);

// `wrangler dev` overlays `.dev.vars` on the top-level `[vars]` defaults, so
// keys like TARGET_ORIGIN / LOGIN_URL / SESSION_TTL_SECONDS / AUTH_MODE that
// already have defaults do not need repeating in `.dev.vars`. Validate the
// effective values, not just the file under test.
const wranglerText = fs.readFileSync(wranglerPath, "utf8").replace(/^﻿/, "");
const effective = mergeEffectiveVars(parseWranglerVarsSection(wranglerText), devVars);

const { ok, errors } = checkDevVarsValues(effective);

if (!ok) {
  for (const error of errors) {
    console.error(error);
  }
  console.error("\nFix .dev.vars (one KEY=value per line; values may be quoted, `export`-prefixed, or carry trailing # comments — the checker parses them exactly as `wrangler dev` does).");
  console.error("Run from repo root: node scripts/check-devvars.mjs");
  process.exit(1);
}

console.log(
  "OK: effective dev vars define LOGIN_USERNAME, LOGIN_PASSWORD, SESSION_TTL_SECONDS, " +
    "TARGET_ORIGIN, LOGIN_URL, a valid AUTH_MODE, valid REPORT_QUERY_* dates/ids/poll " +
    "overrides, a well-shaped SHADOW_API_PUBLIC_BASE, and a client auth token (values not shown)."
);
console.log("Restart `wrangler dev` after editing .dev.vars.");
