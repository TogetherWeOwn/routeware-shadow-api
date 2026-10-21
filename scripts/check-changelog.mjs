#!/usr/bin/env node
/**
 * CHANGELOG gate (TOG-8385, gap G9). Fails when consumer-visible contract
 * paths changed without a referencing bullet (`#123`, or a legacy
 * `TOG-1234`) under `## [Unreleased]`.
 *
 * Contract-visible: `src/routes/**`, `src/app.ts`, `src/worker.ts`,
 * top-level `src/lib/*.ts` response shapes, `wrangler.toml` routes/vars,
 * `migrations/d1/**`. Docs-only, test-only, script-only and CI-only changes
 * skip the gate.
 *
 * Credential-free: reads the git diff and one text file, no network.
 * Pure logic lives in `./lib/changelogCheck.mjs` and is unit-tested; this
 * wrapper is intentionally thin.
 *
 * Usage:
 *   npm run check:changelog [-- --base=<ref> --card=<#123|TOG-1234> --files=<a,b>]
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { argv, exit } from "node:process";

import {
  CHECK_NAME,
  evaluateChangelogGate,
  formatFailureLog,
  formatPassLog,
} from "./lib/changelogCheck.mjs";
import { handleHelpFlag } from "./lib/usage.mjs";

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

function flagValue(name) {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function flagValues(name) {
  const prefix = `--${name}=`;
  return argv
    .filter((a) => a.startsWith(prefix))
    .flatMap((a) => a.slice(prefix.length).split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

function usage() {
  return [
    "Usage: node scripts/check-changelog.mjs [--base=<ref> --card=<#123|TOG-1234> --files=<a,b>]",
    "",
    "CHANGELOG gate: fails when consumer-visible contract paths changed without a referencing bullet under ## [Unreleased].",
    "",
    "  --base=<ref>    Diff base for changed paths (default origin/main).",
    "  --card=<ref>    Reference claimed for this change, e.g. #123 (repeatable).",
    "  --files=<a,b>   Changed paths (default: git diff --name-only --no-renames <base>...HEAD).",
    "  -h, --help      Print this usage and exit 0.",
    "",
    "Exit codes:",
    "  0  Gate passes (or no contract paths changed).",
    "  1  Contract paths changed without a referencing bullet.",
    "  2  Cannot diff base, cannot read CHANGELOG.md, or unknown flag.",
    "",
    "Example:",
    "  node scripts/check-changelog.mjs --base=origin/main --card=#123",
  ].join("\n");
}

handleHelpFlag(argv.slice(2), usage());

for (const arg of argv.slice(2)) {
  if (!arg.startsWith("--base=") && !arg.startsWith("--card=") && !arg.startsWith("--files=")) {
    console.error(`Unknown flag: ${arg}\n\n${usage()}`);
    exit(2);
  }
}

const base = flagValue("base") ?? "origin/main";
const cards = flagValues("card");
const filesFlag = flagValue("files");

let changedPaths;
if (filesFlag !== null) {
  changedPaths = filesFlag.split(",").map((s) => s.trim()).filter(Boolean);
} else {
  try {
    // --no-renames: with rename detection `git mv src/routes/x.ts docs/x.ts`
    // lists only the new path, so the deleted contract path would never reach
    // the gate. A rename is a delete plus an add; both sides must show.
    changedPaths = execFileSync("git", ["diff", "--name-only", "--no-renames", `${base}...HEAD`], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (error) {
    console.error(`${CHECK_NAME}: cannot diff ${base}...HEAD: ${error.message}`);
    exit(2);
  }
}

let changelogText;
try {
  changelogText = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
} catch (error) {
  console.error(`${CHECK_NAME}: cannot read CHANGELOG.md: ${error.message}`);
  exit(2);
}

const outcome = evaluateChangelogGate(changedPaths, changelogText, cards);

if (outcome.ok) {
  console.log(formatPassLog(outcome.contractPaths, outcome.cards));
  exit(0);
}

console.error(formatFailureLog(outcome));
exit(1);
