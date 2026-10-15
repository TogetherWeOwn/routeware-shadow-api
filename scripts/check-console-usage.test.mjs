/**
 * Fixture-driven unit tests for the console-usage lint (TOG-19019).
 *
 * `scripts/check-console-usage.mjs` (landed by TOG-8898, enforced in
 * `ci.yml` build as `npm run lint`) was the only check script with zero
 * unit tests while every other check lib maps to a test file. The pure
 * logic now lives in `scripts/lib/consoleUsageCheck.mjs`; this suite feeds
 * it synthetic `{ path, text }` fixtures — no real source, values, or
 * PII (CONVENTIONS.md sections 4-5).
 *
 * Runs under `node --test` (wired as `npm run test:console-usage`, part of
 * `npm test`, and imported by `scripts/post-deploy-probe.test.mjs` so the
 * always-run `ci.yml` hygiene job executes it on every PR), not vitest:
 * the `typescript` compiler bundle is far too large to load inside the
 * workers-pool vitest project.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  LOGGER_PATH,
  VIOLATION_HINT,
  findConsoleViolations,
  formatPassLog,
  formatViolationLine,
} from "./lib/consoleUsageCheck.mjs";

const LOGGER_DISPATCH = [
  "export function logEvent(event: { level: string }): void {",
  "  console[level](event);",
  "}",
  "",
].join("\n");

test("fails a fixture with one bare console.log", () => {
  assert.deepEqual(findConsoleViolations([{ path: "src/routes/orders.ts", text: 'console.log("hello");\n' }]), [
    { file: "src/routes/orders.ts", line: 1, column: 1 },
  ]);
});

test("flags every console method, not just log", () => {
  const violations = findConsoleViolations([
    {
      path: "src/routes/orders.ts",
      text: 'console.warn("w");\nconsole.error("e");\nconsole.debug("d");\nconsole.info("i");\n',
    },
  ]);
  assert.deepEqual(
    violations.map((v) => v.line),
    [1, 2, 3, 4],
  );
  for (const violation of violations) assert.equal(violation.file, "src/routes/orders.ts");
});

test('flags globalThis.console and globalThis["console"]', () => {
  const violations = findConsoleViolations([
    {
      path: "src/routes/orders.ts",
      text: 'globalThis.console.warn("w");\nglobalThis["console"].error("e");\n',
    },
  ]);
  assert.ok(violations.length > 0);
  assert.deepEqual(new Set(violations.map((v) => v.line)), new Set([1, 2]));
  for (const violation of violations) assert.equal(violation.file, "src/routes/orders.ts");
});

test("allows the computed-severity dispatch in src/lib/logger.ts", () => {
  assert.deepEqual(findConsoleViolations([{ path: LOGGER_PATH, text: LOGGER_DISPATCH }]), []);
});

test("flags the same computed dispatch outside the logger", () => {
  assert.deepEqual(findConsoleViolations([{ path: "src/routes/orders.ts", text: LOGGER_DISPATCH }]), [
    { file: "src/routes/orders.ts", line: 2, column: 3 },
  ]);
});

test("still flags other console uses inside the logger", () => {
  assert.deepEqual(
    findConsoleViolations([{ path: LOGGER_PATH, text: `${LOGGER_DISPATCH}console.log("debug");\n` }]),
    [{ file: LOGGER_PATH, line: 4, column: 1 }],
  );
});

test("pins the logger exception to console[level](...) calls only", () => {
  // The index must be the identifier `level`: any other computed access in
  // the logger is a violation.
  assert.deepEqual(
    findConsoleViolations([
      {
        path: LOGGER_PATH,
        text: "export function f(o: { other: string }): void {\n  console[other](o);\n}\n",
      },
    ]),
    [{ file: LOGGER_PATH, line: 2, column: 3 }],
  );
  // The access must be the callee of a call: a bare `console[level]`
  // alias in the logger is a violation.
  assert.deepEqual(findConsoleViolations([{ path: LOGGER_PATH, text: "const f = console[level];\n" }]), [
    { file: LOGGER_PATH, line: 1, column: 11 },
  ]);
});

test("passes a clean module with no console reference", () => {
  assert.deepEqual(
    findConsoleViolations([
      { path: "src/routes/orders.ts", text: 'export function ok(): string {\n  return "fine";\n}\n' },
    ]),
    [],
  );
});

test("ignores an object property merely named console", () => {
  assert.deepEqual(
    findConsoleViolations([{ path: "src/routes/orders.ts", text: "const x = { console: 1 };\n" }]),
    [],
  );
});

test("reports rows sorted by file, line, column", () => {
  assert.deepEqual(
    findConsoleViolations([
      { path: "src/routes/b.ts", text: 'console.log("b");\n' },
      { path: "src/routes/a.ts", text: 'console.log("a1");\nconsole.log("a2");\n' },
    ]),
    [
      { file: "src/routes/a.ts", line: 1, column: 1 },
      { file: "src/routes/a.ts", line: 2, column: 1 },
      { file: "src/routes/b.ts", line: 1, column: 1 },
    ],
  );
});

test("formats violation lines exactly like the enforced script", () => {
  assert.equal(
    formatViolationLine({ file: "src/routes/orders.ts", line: 3, column: 5 }),
    `src/routes/orders.ts:3:5: ${VIOLATION_HINT}`,
  );
});

test("formats the pass log exactly like the enforced script", () => {
  assert.equal(formatPassLog(72), "console lint passed (72 TypeScript files)");
});

const wrapperPath = fileURLToPath(new URL("./check-console-usage.mjs", import.meta.url));

test("the enforced wrapper still passes on the real tree", () => {
  const output = execFileSync(process.execPath, [wrapperPath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(output, /^console lint passed \(\d+ TypeScript files\)\n$/);
});

test("the enforced wrapper fails closed on violations in a fixture tree", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-usage-"));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "x.ts"), 'console.log("bad");\n');
  const result = spawnSync(process.execPath, [wrapperPath], {
    // Deliberately not the repo root: the wrapper resolves its script by
    // absolute URL and its tree from CONSOLE_USAGE_ROOT, never from cwd.
    cwd: dir,
    env: { ...process.env, CONSOLE_USAGE_ROOT: dir },
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, new RegExp(`^src/x\\.ts:1:1: ${VIOLATION_HINT}$`, "m"));
});

test("the enforced wrapper fails closed when src/ is missing", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-usage-"));
  const result = spawnSync(process.execPath, [wrapperPath], {
    cwd: dir,
    env: { ...process.env, CONSOLE_USAGE_ROOT: dir },
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /console lint: cannot read src\//);
});
