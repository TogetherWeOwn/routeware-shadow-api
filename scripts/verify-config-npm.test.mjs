import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHECKS, buildDryRunResult } from "./lib/verifyConfig.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const contributing = readFileSync(path.join(root, "CONTRIBUTING.md"), "utf8");

// Exercise the advertised npm transport with real wrapper/library copies, but
// synthetic checks only: no .dev.vars, Wrangler, network, or credentials.
function fixture(t, failedCheck) {
  const cwd = mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "verify-config-npm-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, "scripts", "lib"), { recursive: true });
  for (const file of [
    "package.json",
    "scripts/verify-config.mjs",
    "scripts/lib/verifyConfig.mjs",
    "scripts/lib/verifyConfigRunner.mjs",
    "scripts/lib/usage.mjs",
  ]) {
    copyFileSync(path.join(root, file), path.join(cwd, file));
  }
  const log = path.join(cwd, "checks.log");
  writeFileSync(log, "");
  for (const check of CHECKS) {
    writeFileSync(
      path.join(cwd, check.script),
      [
        'import { appendFileSync } from "node:fs";',
        `appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${check.name}\n`)});`,
        'console.log("synthetic child stdout");',
        'console.error("synthetic child stderr");',
        `process.exit(${check.name === failedCheck ? 3 : 0});`,
        "",
      ].join("\n"),
    );
  }
  return { cwd, calls: () => readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

function advertised(name, cwd, expectedStatus) {
  const match = contributing.match(new RegExp("`(npm(?: --silent)? run " + name + ")`"));
  assert.ok(match, `CONTRIBUTING.md must advertise an npm command for ${name}`);
  const [command, ...args] = match[1].split(" ");
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    // Do not let a parent's npm --silent mask a missing flag in the docs.
    env: { ...process.env, npm_config_loglevel: "notice" },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expectedStatus, result.stderr);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.endsWith("\n"));
  const lines = result.stdout.slice(0, -1).split("\n");
  assert.equal(lines.length, 1, `${match[1]} must emit exactly one JSON line, without npm banners`);
  const parsed = JSON.parse(lines[0]);
  assert.equal(lines[0], JSON.stringify(parsed));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.command, "verify:config");
  return { parsed, stdout: result.stdout };
}

test("advertised npm JSON command: green checks, one compact object, exit 0", (t) => {
  const f = fixture(t);
  const { parsed } = advertised("verify:config:json", f.cwd, 0);
  assert.equal(parsed.mode, "run");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.checks.map((c) => c.outcome), CHECKS.map(() => "passed"));
  assert.deepEqual(f.calls(), CHECKS.map((c) => c.name));
});

test("advertised npm JSON command: failed check, one compact object, exit 1", (t) => {
  const f = fixture(t, CHECKS[0].name);
  const { parsed } = advertised("verify:config:json", f.cwd, 1);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.checks[0].outcome, "nonzero_exit");
  assert.equal(parsed.checks[0].exitCode, 3);
  assert.deepEqual(f.calls(), CHECKS.map((c) => c.name));
});

test("advertised npm dry-run command: identical one-line plans, no checks, exit 0", (t) => {
  const f = fixture(t);
  const a = advertised("verify:config:dry-run", f.cwd, 0);
  const b = advertised("verify:config:dry-run", f.cwd, 0);
  assert.deepEqual(a.parsed, buildDryRunResult());
  assert.equal(a.stdout, b.stdout);
  assert.deepEqual(f.calls(), []);
});
