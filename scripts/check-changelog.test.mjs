import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// --files avoids git/network; the wrapper still reads real changelog files.
function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "changelog-wrapper-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  for (const name of ["check-changelog.mjs", "lib/changelogCheck.mjs", "lib/usage.mjs"]) {
    copyFileSync(new URL(name, import.meta.url), path.join(root, "scripts", name));
  }
  writeFileSync(path.join(root, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n\n## [1.0.0]\n- #987654: Already released.\n");
  const fragmentDir = path.join(root, "changelog", "unreleased");
  const fragment = (name, text) => {
    mkdirSync(fragmentDir, { recursive: true });
    writeFileSync(path.join(fragmentDir, name), text);
  };
  const run = () => spawnSync(process.execPath, [path.join(root, "scripts", "check-changelog.mjs"),
    "--files=src/lib/snapshotNextLink.ts", "--card=#987654"], {
    cwd: tmpdir(), encoding: "utf8", timeout: 10_000,
  });
  return { fragment, run };
}

test("a referencing fragment on disk satisfies the real gate with empty Unreleased", (t) => {
  const { fragment, run } = fixture(t);
  fragment("987654-synthetic.md", "- #987654: Synthetic consumer-visible change.\n");
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /changelog: PASS/);
  assert.match(result.stdout, /#987654/);
});

test("README examples and non-markdown files do not satisfy the gate", (t) => {
  const { fragment, run } = fixture(t);
  fragment("README.md", "- #987654: Example only.\n");
  fragment("987654.txt", "- #987654: Not a markdown fragment.\n");
  const result = run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /changelog: FAIL/);
});

test("missing fragment directory fails closed for an uncovered contract change", (t) => {
  const { run } = fixture(t);
  const result = run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /changelog: FAIL/);
});

test("an unrelated fragment cannot cover the claimed change", (t) => {
  const { fragment, run } = fixture(t);
  fragment("123-unrelated.md", "- #123: Different change.\n");
  const result = run();
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /not this change's reference/);
});
