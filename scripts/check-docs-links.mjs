#!/usr/bin/env node
/**
 * Docs link + anchor check (TOG-18936). Resolves every relative `](path)`
 * and `](path#anchor)` link in tracked `*.md` files: the target must be a
 * tracked file (or a directory containing tracked files), and any `#anchor`
 * must match a heading slug (GitHub rules) or an `<a name>` anchor in the
 * target file.
 *
 * Credential-free: walks the git index and reads text files, no network.
 * Pure logic lives in `./lib/docsLinks.mjs` and is unit-tested; this
 * wrapper is intentionally thin.
 *
 * Usage:
 *   npm run check:docs-links
 *
 * Exit codes: 0 when clean, 1 listing `file: link (reason)` findings,
 * 2 when an input cannot be read. Findings print link text only, never
 * file contents.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { exit } from "node:process";

import {
  CHECK_NAME,
  checkDocsLinks,
  formatReport,
  parseGitignore,
} from "./lib/docsLinks.mjs";

const root = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

function readInput(label, fn) {
  try {
    return fn();
  } catch (error) {
    console.error(`${CHECK_NAME}: FAIL — cannot read ${label}: ${error.message}`);
    exit(2);
  }
}

// `-z` NUL framing: plain `git ls-files` C-quotes non-ASCII paths under the
// default `core.quotePath` (e.g. `"docs/R\303\251sum\303\251.md"`), whose
// closing quote fails the `.md` suffix filter and silently unscans the file.
const tracked = readInput("git index", () =>
  execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .map((line) => line.replace(/\\/g, "/"))
    .filter((line) => line !== ""),
);

const gitignore = readInput(".gitignore", () =>
  readFileSync(path.join(root, ".gitignore"), "utf8"),
);

const mdPaths = tracked.filter((p) => p.endsWith(".md"));
const files = readInput("markdown files", () =>
  mdPaths.map((p) => ({ path: p, text: readFileSync(path.join(root, p), "utf8") })),
);

const findings = checkDocsLinks(files, {
  trackedPaths: tracked,
  ignoreRules: parseGitignore(gitignore),
});

if (findings.length > 0) {
  for (const line of formatReport(findings)) console.error(line);
  exit(1);
}
console.log(`${CHECK_NAME}: OK — ${files.length} markdown files, all relative links resolve`);
