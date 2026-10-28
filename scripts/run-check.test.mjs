import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

// Exercise the real wrapper in isolated checkouts, never add probes to checks/.
function fixture(t, prefix = "focused-check-") {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts", "lib"), { recursive: true });
  mkdirSync(path.join(root, "checks"));
  for (const name of ["run-check.mjs", "lib/usage.mjs"]) {
    copyFileSync(new URL(name, import.meta.url), path.join(root, "scripts", name));
  }
  const check = (name, command) => writeFileSync(path.join(root, "checks", `${name}.cmd`), command);
  const run = (...args) => spawnSync(process.execPath, [path.join(root, "scripts", "run-check.mjs"), ...args], {
    cwd: tmpdir(), encoding: "utf8", timeout: 10_000,
  });
  return { root, check, run };
}

test("no arguments lists available names in sorted order", (t) => {
  const { check, run } = fixture(t);
  check("zebra", "exit 9");
  check("alpha", "exit 9");
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "alpha\nzebra\n");
});

test("validates every requested name before executing any check", (t) => {
  const { root, check, run } = fixture(t);
  check("pass", "echo unexpected > ran.txt");
  const result = run("pass", "missing");
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Unknown check: missing/);
  assert.equal(existsSync(path.join(root, "ran.txt")), false);
});

test("returns zero for passing checks and runs them in requested order", (t) => {
  const { check, run } = fixture(t);
  check("first", "echo FIRST");
  check("second", "echo SECOND");
  const result = run("second", "first");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SECOND[\s\S]*FIRST/);
});

test("propagates the first failing exit code and never runs a later check", (t) => {
  const { root, check, run } = fixture(t);
  check("fail", "exit 7");
  check("later", "echo unexpected > ran.txt");
  const result = run("fail", "later");
  assert.equal(result.status, 7, result.stderr);
  assert.equal(existsSync(path.join(root, "ran.txt")), false);
});

test("direct node invocation finds project-local executables without npm's PATH", (t) => {
  const { root, check } = fixture(t);
  const bin = path.join(root, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const windows = process.platform === "win32";
  writeFileSync(path.join(bin, windows ? "focused-fixture.cmd" : "focused-fixture"),
    windows ? "@echo LOCAL_EXECUTABLE\r\n@exit /b 0\r\n" : "#!/bin/sh\nprintf 'LOCAL_EXECUTABLE\\n'\n", { mode: 0o755 });
  check("local", "focused-fixture");
  const env = { ...process.env };
  // Strip npm's injected PATH entries even when this test is itself run by npm.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key];
  }
  env.PATH = windows ? process.env.SystemRoot + "\\System32" : "/usr/bin:/bin";
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "run-check.mjs"), "local"], {
    cwd: tmpdir(), env, encoding: "utf8", timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LOCAL_EXECUTABLE/);
});

test("resolves checkouts with spaces and Unicode in their path", (t) => {
  const { check, run } = fixture(t, "focused space-雪-");
  check("pass", "echo PASS");
  const result = run("pass");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS/);
});
