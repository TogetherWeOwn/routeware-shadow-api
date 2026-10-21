#!/usr/bin/env node
/**
 * Coverage ratchet check.
 *
 * Enforces the upward half of the coverage ratchet that Vitest thresholds
 * cannot express: thresholds fail the run when coverage REGRESSES below a
 * floor, while this check fails when coverage IMPROVES a full point above
 * a floor without raising it. Together they keep floors pinned just under
 * the measurement ("raise floors when the number goes up").
 *
 * Reads:
 *   coverage/coverage-summary.json  (istanbul json-summary reporter;
 *                                     emitted by `npm run test:coverage`)
 *   vitest.config.ts                (`thresholds` block = floors)
 *
 * Flags (default to the repo layout; redirect both sides so the acceptance
 * proof — a bumped measurement demanding raised floors — can run without
 * touching the real tree):
 *   --summary=<path>   coverage summary (default coverage/coverage-summary.json)
 *   --config=<path>    vitest config (default vitest.config.ts)
 *
 * Exit 0 when every floor matches its measurement. Exit 1 with the
 * suggested `thresholds` block when any measurement implies a higher floor,
 * or when a measurement sits below its floor (regression vitest should
 * already have failed). Exit 2 when an input is missing/unparseable —
 * never report a missing report as a pass.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { argv, exit } from "node:process";

import { CHECK_NAME, runRatchet } from "./lib/coverageRatchet.mjs";
import { handleHelpFlag } from "./lib/usage.mjs";

function usage() {
  return [
    "Usage: node scripts/check-coverage-ratchet.mjs [--summary=<path> --config=<path>]",
    "",
    "Coverage ratchet: fails when coverage improves a full point above a floor without raising it.",
    "",
    "  --summary=<path>  Coverage summary (default coverage/coverage-summary.json).",
    "  --config=<path>   Vitest config (default vitest.config.ts).",
    "  -h, --help        Print this usage and exit 0.",
    "",
    "Exit codes:",
    "  0  Every floor matches its measurement.",
    "  1  A measurement implies a higher floor, or sits below it.",
    "  2  An input is missing or unparseable.",
    "",
    "Example:",
    "  node scripts/check-coverage-ratchet.mjs --summary=coverage/coverage-summary.json --config=vitest.config.ts",
  ].join("\n");
}

handleHelpFlag(argv.slice(2), usage());

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
const configPath = path.resolve(root, flagValue("config") ?? "vitest.config.ts");

const configText = readOrDie(configPath, "vitest config");
const summaryText = readOrDie(summaryPath, "coverage summary");

let outcome;
try {
  outcome = runRatchet(configText, summaryText);
} catch (error) {
  // Lib errors already carry the `coverage-ratchet:` prefix; prefix only
  // unexpected ones so the message never stutters.
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.startsWith(`${CHECK_NAME}:`) ? message : `${CHECK_NAME}: ${message}`);
  exit(2);
}

if (outcome.ok) {
  const at = Object.entries(outcome.floors)
    .map(([metric, floor]) => `${metric} ${floor}`)
    .join(", ");
  console.log(`${CHECK_NAME}: OK — floors match measurements (${at})`);
  exit(0);
}

// The suggested `thresholds` block is one multi-line entry: print it verbatim
// so it stays paste-ready instead of wearing a stray prefix on its first line.
for (const line of outcome.lines) {
  if (line.includes("\n")) console.error(line);
  else console.error(`${CHECK_NAME}: ${line}`);
}
exit(1);
