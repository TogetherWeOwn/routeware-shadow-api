#!/usr/bin/env node
/**
 * Reject direct console method access in src/. Logging must go through the
 * structured helper; its one computed severity dispatch is the sole exception.
 *
 * Pure logic lives in `./lib/consoleUsageCheck.mjs` and is unit-tested
 * there; this wrapper is intentionally thin.
 *
 * `CONSOLE_USAGE_ROOT` overrides the repo root under test so the suite can
 * run the wrapper against a fixture tree (fail-closed paths) instead of the
 * real `src/`.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";

import {
  LOGGER_PATH,
  findConsoleViolations,
  formatPassLog,
  formatViolationLine,
} from "./lib/consoleUsageCheck.mjs";
import { handleHelpFlag } from "./lib/usage.mjs";

function usage() {
  return [
    "Usage: node scripts/check-console-usage.mjs",
    "",
    "Console lint: rejects direct console method access in src/; logging must go through the structured helper.",
    "",
    "  -h, --help  Print this usage and exit 0.",
    "",
    "Env:",
    "  CONSOLE_USAGE_ROOT  Override the repo root under test (fixture trees).",
    "",
    "Exit codes:",
    "  0  No violations.",
    "  1  Violations found, or cannot read src/.",
    "",
    "Example:",
    "  node scripts/check-console-usage.mjs",
  ].join("\n");
}

handleHelpFlag(argv.slice(2), usage());

const root = process.env.CONSOLE_USAGE_ROOT
  ? path.resolve(process.env.CONSOLE_USAGE_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(root, "src");

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(fullPath));
    } else if (entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

let files;
try {
  files = sourceFiles(srcRoot);
} catch (error) {
  console.error(`console lint: cannot read src/: ${error.message}`);
  process.exitCode = 1;
}

const entries = (files ?? []).map((filePath) => ({
  path: path.relative(root, filePath).replaceAll("\\", "/"),
  text: readFileSync(filePath, "utf8"),
}));
const violations = findConsoleViolations(entries, { loggerPath: LOGGER_PATH });

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(formatViolationLine(violation));
  }
  process.exitCode = 1;
} else if (files) {
  console.log(formatPassLog(files.length));
}
