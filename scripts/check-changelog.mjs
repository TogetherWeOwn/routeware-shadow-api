#!/usr/bin/env node
/**
 * CHANGELOG gate (TOG-8385, gap G9). Fails when consumer-visible contract
 * paths changed without a `TOG-1234` bullet under `## [Unreleased]`.
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
 *   npm run check:changelog [-- --base=<ref> --card=<TOG-1234> --files=<a,b>]
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
    "Usage: node scripts/check-changelog.mjs [--base=<ref> --card=<TOG-1234> --files=<a,b>]",
    "",
    "  --base=<ref>    Diff base for changed paths (default origin/main).",
    "  --card=<id>     Card id claimed for this change (repeatable).",
    "  --files=<a,b>   Changed paths (default: git diff --name-only <base>...HEAD).",
  ].join("\n");
}

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
    changedPaths = execFileSync("git", ["diff", "--name-only", `${base}...HEAD`], {
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
