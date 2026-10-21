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

test("NUL framing keeps a newline-containing .md filename intact (alternate index)", () => {
  // Hermetic scratch repo: the alternate GIT_INDEX_FILE proves the exact
  // `git ls-files -z` + NUL-split pipeline the wrapper uses survives a
  // newline in the filename, where a newline split fragments it.
  const dir = mkdtempSync(path.join(tmpdir(), "docs-links-nul-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    const newlineName = "probe-newline-\n-file.md";
    writeFileSync(path.join(dir, newlineName), "# Probe\n\nNo links.\n", "utf8");
    const altIndex = path.join(dir, "alt.index");
    const env = { ...process.env, GIT_INDEX_FILE: altIndex };
    execFileSync("git", ["add", newlineName], {
      cwd: dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const raw = execFileSync("git", ["ls-files", "-z"], {
      cwd: dir,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const entries = raw
      .split("\0")
      .map((line) => line.replace(/\\/g, "/"))
      .filter((line) => line !== "");
    assert.deepStrictEqual(entries, [newlineName]);
    // The wrapper's `.md` suffix filter must still see it as one markdown file.
    assert.deepStrictEqual(
      entries.filter((p) => p.endsWith(".md")),
      [newlineName],
    );
    // A newline split would fragment it — proving this case is adversarial.
    assert.ok(raw.split("\n").length > 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
