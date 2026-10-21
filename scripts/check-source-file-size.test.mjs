/**
 * Wrapper tests for the source-file-size guard.
 *
 * The pure logic in `scripts/lib/sourceFileSize.mjs` is pinned by
 * `test/sourceFileSize.test.ts`; this suite pins the thin CLI wrapper in
 * `scripts/check-source-file-size.mjs` instead: flag parsing, exit codes,
 * and log shapes. Unlike the console-usage wrapper, this one resolves the
 * repo root from its own URL (no root override), so every case runs against
 * the real tree — the same tree CI lints.
 *
 * Runs under `node --test` (wired into `npm run test:probe`, part of
 * `npm test`), not vitest.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { CHECK_NAME, DEFAULT_LIMIT } from "./lib/sourceFileSize.mjs";

const wrapperPath = fileURLToPath(new URL("./check-source-file-size.mjs", import.meta.url));

function runWrapper(args) {
  return spawnSync(process.execPath, [wrapperPath, ...args], { encoding: "utf8" });
}

test("passes on the real tree with the default limit", () => {
  const result = runWrapper([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    new RegExp(`^${CHECK_NAME}: PASS \\S+ \\d+ file\\(s\\) under src/ at or under ${DEFAULT_LIMIT} lines\\n$`),
  );
});

test("a tiny limit fails naming the offenders", () => {
  const result = runWrapper(["--limit=1"]);
  assert.equal(result.status, 1, result.stdout);
  assert.match(
    result.stderr,
    new RegExp(`^${CHECK_NAME}: FAIL \\S+ \\d+ file\\(s\\) under src/ exceed 1 lines:$`, "m"),
  );
  assert.match(result.stderr, /^  src\/.+ \(\d+ lines\)$/m);
  assert.match(result.stderr, /worker-configuration\.d\.ts is the only exemption/);
});

test("a huge limit passes and the ceiling shows in the log", () => {
  // Pins that --limit is applied, not just accepted: the ceiling echoes.
  const result = runWrapper(["--limit=1000000"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /at or under 1000000 lines/);
});

test("rejects limits that are not positive integers", () => {
  for (const bad of ["abc", "0", "-5", "2.5"]) {
    const escaped = bad.replaceAll(".", "\\.");
    const result = runWrapper([`--limit=${bad}`]);
    assert.equal(result.status, 1, bad);
    assert.match(
      result.stderr,
      new RegExp(`^${CHECK_NAME}: --limit must be a positive integer \\(got ${escaped}\\)$`, "m"),
      bad,
    );
  }
});

test("rejects unknown flags with usage", () => {
  const result = runWrapper(["--bogus"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^Unknown flag: --bogus$/m);
  assert.match(result.stderr, /^Usage: node scripts\/check-source-file-size\.mjs/m);
});

test("--help and -h print usage and exit zero", () => {
  for (const flag of ["--help", "-h"]) {
    const result = runWrapper([flag]);
    assert.equal(result.status, 0, flag);
    assert.equal(result.stderr, "", flag);
    assert.match(result.stdout, /^Usage: node scripts\/check-source-file-size\.mjs/m, flag);
    assert.match(result.stdout, new RegExp(`default ${DEFAULT_LIMIT}`, "m"), flag);
  }
});
