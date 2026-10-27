#!/usr/bin/env node
/**
 * Focused-check runner. Per-feature checks live one file each in `checks/`
 * (`checks/<name>.cmd`, one shell command) instead of `package.json#scripts`,
 * so adding a check adds a file and never edits a shared line.
 *
 * Usage: npm run check:focused -- <name> [<name> ...]
 *        npm run check:focused            (lists available names)
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { argv, exit } from "node:process";

import { handleHelpFlag } from "./lib/usage.mjs";

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const dir = path.join(root, "checks");
const names = readdirSync(dir)
  .filter((f) => f.endsWith(".cmd"))
  .map((f) => f.slice(0, -4))
  .sort();

function usage() {
  return [
    "Usage: node scripts/run-check.mjs <name> [<name> ...]",
    "",
    "Runs focused checks defined as checks/<name>.cmd (one shell command each).",
    "With no names, lists the available checks.",
    "",
    "Exit codes:",
    "  0  Every named check passed (or the list was printed).",
    "  1  A named check failed (first failing exit code is returned).",
    "  2  Unknown check name.",
    "",
    "Example:",
    "  npm run check:focused -- container-note-search",
  ].join("\n");
}

handleHelpFlag(argv.slice(2), usage());

const wanted = argv.slice(2);
if (wanted.length === 0) {
  console.log(names.join("\n"));
  exit(0);
}
for (const name of wanted) {
  if (!names.includes(name)) {
    console.error(`Unknown check: ${name}\n\nAvailable:\n${names.join("\n")}`);
    exit(2);
  }
}
for (const name of wanted) {
  const command = readFileSync(path.join(dir, `${name}.cmd`), "utf8").trim();
  console.log(`> check:focused ${name}\n> ${command}`);
  const { status } = spawnSync(command, { cwd: root, shell: true, stdio: "inherit" });
  if (status !== 0) exit(status ?? 1);
}
