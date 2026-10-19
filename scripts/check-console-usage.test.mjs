/**
 * Fixture-driven unit tests for the console-usage lint.
 *
 * `scripts/check-console-usage.mjs` (enforced in
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
  // Each call-position conjunct is pinned alone: `foo(console[level])`
  // is flagged only by `parent.expression === node`, and
  // `console[level].call(null, x)` only by `isCallExpression(parent)`.
  assert.deepEqual(findConsoleViolations([{ path: LOGGER_PATH, text: "foo(console[level]);\n" }]), [
    { file: LOGGER_PATH, line: 1, column: 5 },
  ]);
  assert.deepEqual(
    findConsoleViolations([{ path: LOGGER_PATH, text: "console[level].call(null, x);\n" }]),
    [{ file: LOGGER_PATH, line: 1, column: 1 }],
  );
});

test("passes a clean module with no console reference", () => {
  assert.deepEqual(
    findConsoleViolations([
      { path: "src/routes/orders.ts", text: 'export function ok(): string {\n  return "fine";\n}\n' },
    ]),
    [],
  );
});

test("exempts the property name but still flags the property value", () => {
  assert.deepEqual(
    findConsoleViolations([{ path: "src/routes/orders.ts", text: "const x = { console: 1 };\n" }]),
    [],
  );
  // The `name === node` conjunct: only the name side is exempt. Narrowing
  // `isConsoleReference` to `ts.isPropertyAssignment(node.parent)` lets this
  // value-side `console` through, so it must stay flagged (column 19).
  assert.deepEqual(
    findConsoleViolations([{ path: "src/routes/orders.ts", text: "const o = { sink: console };\n" }]),
    [{ file: "src/routes/orders.ts", line: 1, column: 19 }],
  );
});

test("flags the template-literal globalThis[`console`] form", () => {
  // Pins `isStringLiteralLike` over `isStringLiteral`: a no-substitution
  // template is StringLiteralLike, so narrowing the check lets this through.
  assert.deepEqual(
    findConsoleViolations([
      { path: "src/routes/orders.ts", text: "globalThis[`console`].log(1);\n" },
    ]),
    [{ file: "src/routes/orders.ts", line: 1, column: 1 }],
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
  mkdirSync(path.join(dir, "src", "routes"), { recursive: true });
  // Nested file pins the recursive walk; every matched extension pins the
  // `ts|tsx|mts|cts` filter. `ok.txt` pins the filter the other way: a
  // console call in a non-TS file must be ignored, not flagged.
  const bad = 'console.log("bad");\n';
  writeFileSync(path.join(dir, "src", "x.ts"), bad);
  writeFileSync(path.join(dir, "src", "routes", "nested.ts"), bad);
  writeFileSync(path.join(dir, "src", "a.mts"), bad);
  writeFileSync(path.join(dir, "src", "b.cts"), bad);
  writeFileSync(path.join(dir, "src", "c.tsx"), bad);
  writeFileSync(path.join(dir, "src", "ok.txt"), bad);
  const result = spawnSync(process.execPath, [wrapperPath], {
    // Deliberately not the repo root: the wrapper resolves its script by
    // absolute URL and its tree from CONSOLE_USAGE_ROOT, never from cwd.
    cwd: dir,
    env: { ...process.env, CONSOLE_USAGE_ROOT: dir },
    encoding: "utf8",
  });
  assert.equal(result.status, 1, result.stderr);
  for (const rel of ["src/x.ts", "src/routes/nested.ts", "src/a.mts", "src/b.cts", "src/c.tsx"]) {
    const escaped = rel.replaceAll(".", "\\.");
    assert.match(result.stderr, new RegExp(`^${escaped}:1:1: ${VIOLATION_HINT}$`, "m"), rel);
  }
  assert.doesNotMatch(result.stderr, /ok\.txt/);
});

test("the enforced wrapper counts nested and filtered extensions in a clean fixture tree", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-usage-"));
  mkdirSync(path.join(dir, "src", "routes"), { recursive: true });
  const clean = "export const ok = 1;\n";
  writeFileSync(path.join(dir, "src", "a.ts"), clean);
  writeFileSync(path.join(dir, "src", "routes", "nested.ts"), clean);
  writeFileSync(path.join(dir, "src", "b.mts"), clean);
  writeFileSync(path.join(dir, "src", "c.cts"), clean);
  writeFileSync(path.join(dir, "src", "d.tsx"), clean);
  // Not a matched extension, so neither counted nor flagged.
  writeFileSync(path.join(dir, "src", "ok.txt"), 'console.log("ignored");\n');
  const result = spawnSync(process.execPath, [wrapperPath], {
    cwd: dir,
    env: { ...process.env, CONSOLE_USAGE_ROOT: dir },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "console lint passed (5 TypeScript files)\n");
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
