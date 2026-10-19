/**
 * Wrapper assertions for the docs link + anchor check.
 *
 * `scripts/check-docs-links.mjs` shells `git ls-files -z` and splits on NUL:
 * plain `git ls-files` C-quotes non-ASCII paths under the default
 * `core.quotePath`, whose closing quote fails the `.md` suffix filter and
 * silently unscans the file. The `-z`/NUL pair is the fix — and reverting to
 * a newline split keeps every other suite green (no non-ASCII markdown
 * exists in the tree today, and the skip is silent), so this suite pins the
 * framing directly on the wrapper source.
 *
 * Runs under `node --test` (wired into `npm run test:probe`, which CI's
 * always-run hygiene job executes on every PR), not vitest: it spawns the
 * wrapper as a subprocess and shells git, which the workers-pool vitest
 * project cannot do. Credential-free, hermetic, no network.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const wrapperPath = fileURLToPath(new URL("./check-docs-links.mjs", import.meta.url));
const wrapperSource = readFileSync(wrapperPath, "utf8");

test("the wrapper lists tracked files with git ls-files -z", () => {
  assert.match(wrapperSource, /\["ls-files", "-z"\]/);
});

test("the wrapper splits the listing on NUL, never newlines", () => {
  assert.match(wrapperSource, /\.split\("\\0"\)/);
  assert.doesNotMatch(wrapperSource, /\.split\("\\n"\)/);
  // The trailing NUL leaves a trailing empty entry; the filter drops it.
  assert.match(wrapperSource, /\.filter\(\(line\) => line !== ""\)/);
});

test("the enforced wrapper passes on the real tree", () => {
  const output = execFileSync(process.execPath, [wrapperPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(output, /^docs-links: OK — \d+ markdown files, all relative links resolve\n$/);
});
