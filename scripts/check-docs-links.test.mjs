/**
 * Wrapper assertions for the docs link + anchor check.
 *
 * `scripts/check-docs-links.mjs` shells `git ls-files -z` and splits on NUL:
 * plain `git ls-files` C-quotes non-ASCII paths under the default
 * `core.quotePath`, whose closing quote fails the `.md` suffix filter and
 * silently unscans the file. The `-z`/NUL pair is the fix — and reverting to
 * a newline split keeps every other suite green (no non-ASCII markdown
 * exists in the tree today, and the skip is silent), so this suite pins the
 * framing directly on the wrapper source. A final behavioral test runs the
 * real wrapper against a newline-named fixture (broken link, alternate
 * `GIT_INDEX_FILE`), so a wrapper change that silently unscans the file
 * fails there too, not just in the source pins.
 *
 * Runs under `node --test` (wired into `npm run test:probe`, which CI's
 * always-run hygiene job executes on every PR), not vitest: it spawns the
 * wrapper as a subprocess and shells git, which the workers-pool vitest
 * project cannot do. Credential-free, hermetic, no network.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

test(
  "the wrapper scans a newline-containing .md filename (alternate index)",
  {
    skip:
      process.platform === "win32"
        ? "POSIX-only: Windows cannot create newline filenames (repo CI is ubuntu-latest)"
        : false,
  },
  () => {
    // Behavioral bind on the real wrapper: stage ONLY a newline-named .md
    // fixture carrying a broken relative link into an alternate
    // GIT_INDEX_FILE, then spawn the wrapper with that env (it inherits env
    // into its `git ls-files` call). Exit 1 naming the missing target proves
    // the fixture was scanned as one entry; the failure modes this guards
    // against exit differently (a newline split fragments the name, so the
    // markdown read fails at exit 2; a newline-dropping filter exits 0 with
    // nothing scanned). The real index is untouched — the fixture is never
    // staged there — so concurrent suites keep seeing the real tree.
    const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const newlineName = "probe-newline-\n-file.md";
    const fixturePath = path.join(repoRoot, newlineName);
    const scratchDir = mkdtempSync(path.join(tmpdir(), "docs-links-nul-"));
    const env = {
      ...process.env,
      GIT_INDEX_FILE: path.join(scratchDir, "alt.index"),
    };
    try {
      writeFileSync(fixturePath, "# Probe\n\n[broken](./does-not-exist-probe.md)\n", "utf8");
      execFileSync("git", ["add", newlineName], {
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let failure = null;
      try {
        execFileSync(process.execPath, [wrapperPath], {
          cwd: repoRoot,
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        failure = error;
      }
      assert.ok(failure, "expected the wrapper to exit nonzero on the broken link");
      assert.equal(
        failure.status,
        1,
        `expected wrapper exit 1, got ${failure.status}: ${failure.stderr ?? failure.message}`,
      );
      const stderr = String(failure.stderr ?? "");
      assert.match(stderr, /^docs-links: FAIL/m);
      assert.match(stderr, /missing file: does-not-exist-probe\.md/);
      assert.ok(
        stderr.includes("probe-newline-"),
        "expected the finding to name the newline fixture",
      );
    } finally {
      rmSync(fixturePath, { force: true });
      rmSync(scratchDir, { recursive: true, force: true });
    }
  },
);
