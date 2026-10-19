#!/usr/bin/env node
/**
 * Per-file coverage gate.
 *
 * Closes the global-only ratchet hole: `vitest.config.ts` thresholds plus the
 * coverage ratchet guard the aggregate numbers, but a brand-new module with
 * zero tests still passes every global floor behind well-covered files. This
 * check fails when any src file in the coverage report has zero
 * covered statements, unless it is named in the allowlist.
 *
 * Reads:
 *   coverage/coverage-summary.json      (istanbul json-summary reporter;
 *                                         emitted by `npm run test:coverage`)
 *   scripts/per-file-coverage-allowlist.json
 *
 * Flags (default to the repo layout; redirect both sides so the acceptance
 * proof — an uncovered file failing the gate — can run without touching src/):
 *   --summary=<path>    coverage summary (default coverage/coverage-summary.json)
 *   --allowlist=<path>  allowlist JSON (default scripts/per-file-coverage-allowlist.json)
 *
 * Exit 0 when every file is tested or allowlisted. Exit 1 naming the
 * offending files (untested, graduated, or stale allowlist entries). Exit 2
 * when an input is missing/unparseable — never report a missing report as a pass.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { argv, exit } from "node:process";

import { CHECK_NAME, runPerFileCheck } from "./lib/perFileCoverage.mjs";

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

function flagValue(name) {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function readOrDie(resolved, label) {
  try {
    return readFileSync(resolved, "utf8");
  } catch (error) {
    console.error(`${CHECK_NAME}: cannot read ${label} ${resolved}: ${error.message}`);
    exit(2);
  }
}

const summaryPath = path.resolve(root, flagValue("summary") ?? "coverage/coverage-summary.json");
const allowlistPath = path.resolve(
  root,
  flagValue("allowlist") ?? "scripts/per-file-coverage-allowlist.json",
);

const summaryText = readOrDie(summaryPath, "coverage summary");
const allowlistText = readOrDie(allowlistPath, "allowlist");

let outcome;
try {
  outcome = runPerFileCheck(summaryText, allowlistText);
} catch (error) {
  // Lib errors already carry the `per-file-coverage:` prefix; prefix only
  // unexpected ones so the message never stutters.
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.startsWith(`${CHECK_NAME}:`) ? message : `${CHECK_NAME}: ${message}`);
  exit(2);
}

if (outcome.ok) {
  console.log(
    `${CHECK_NAME}: OK — ${outcome.entries.length} src files tested or allowlisted (${outcome.allowlist.length} allowlisted)`,
  );
  exit(0);
}

for (const line of outcome.lines) console.error(`${CHECK_NAME}: ${line}`);
exit(1);
