#!/usr/bin/env node
/**
 * Reject direct console method access in src/. Logging must go through the
 * structured helper; its one computed severity dispatch is the sole exception.
 *
 * Pure logic lives in `./lib/consoleUsageCheck.mjs` and is unit-tested
 * (TOG-19019); this wrapper is intentionally thin.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  LOGGER_PATH,
  findConsoleViolations,
  formatPassLog,
  formatViolationLine,
} from "./lib/consoleUsageCheck.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
