import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Explicit replay only: node --test scripts/post-deploy-probe-review-mutations.test.mjs
// Mutations never touch the checkout. Each runs in a disposable three-file copy
// and only selects baseline-green guard cases, not the known HTTP/body defect.
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = "scripts/post-deploy-probe.mjs";
const oracle = "scripts/post-deploy-probe-json.acceptance.test.mjs";
const inputs = [cli, oracle, "scripts/lib/postDeployProbe.mjs"];

function replay(dir, pattern) {
  const result = spawnSync(process.execPath, [
    "--test", "--test-reporter=tap", `--test-name-pattern=${pattern}`, path.join(dir, oracle),
  ], {
    cwd: dir,
    // Never inherit credentials or Node preload hooks. Child CLI effects are
    // contained by the acceptance oracle's own preload and fetch allowlist.
    env: { PATH: process.env.PATH, PAPERCLIP_RUN_SCRATCH_DIR: dir },
    encoding: "utf8", timeout: 30_000, maxBuffer: 512 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  const output = result.stdout + result.stderr;
  const count = (label) => {
    const match = output.match(new RegExp(`^# ${label} (\\d+)$`, "m"));
    assert.ok(match, `missing ${label} summary: ${output}`);
    return Number(match[1]);
  };
  return { status: result.status, output, tests: count("tests"), pass: count("pass"), fail: count("fail") };
}

for (const mutation of [
  {
    name: "redirect manual removed", before: '      redirect: "manual",\n', after: "",
    pattern: "^redirect invariant:", tests: 1, failures: 1,
  },
  {
    name: "origin cap removed", before: " || origin.length > MAX_ORIGIN_LENGTH", after: "",
    pattern: "^origin cap plan ", tests: 8, failures: 4,
  },
  {
    name: "lower timeout guard weakened", before: "n < 1", after: "n <= 0",
    pattern: "^timeout boundary refusal 0\\.5 ", tests: 2, failures: 2,
  },
  {
    name: "upper timeout guard removed", before: " || n > 2_147_483_647", after: "",
    pattern: "^timeout boundary refusal 2147483648 ", tests: 2, failures: 2,
  },
  {
    name: "fractional timeout floor removed", before: "timeoutMs = Math.floor(n);", after: "timeoutMs = n;",
    pattern: "^timeout fractional value ", tests: 1, failures: 1,
  },
]) {
  test(`guard mutant killed: ${mutation.name}`, (t) => {
    const dir = mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || process.env.PAPERCLIP_SCRATCH_DIR || tmpdir(), "probe-guard-mutant-"));
    try {
      for (const relative of inputs) {
        const target = path.join(dir, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(path.join(root, relative)));
      }
      const control = replay(dir, mutation.pattern);
      assert.equal(control.status, 0, control.output);
      assert.equal(control.tests, mutation.tests, control.output);
      assert.equal(control.pass, mutation.tests, control.output);
      assert.equal(control.fail, 0, control.output);
      const file = path.join(dir, cli);
      const source = readFileSync(file, "utf8");
      assert.equal(source.split(mutation.before).length, 2, `mutation must match exactly once: ${mutation.name}`);
      writeFileSync(file, source.replace(mutation.before, mutation.after));
      const mutant = replay(dir, mutation.pattern);
      assert.equal(mutant.status, 1, mutant.output);
      assert.equal(mutant.tests, mutation.tests, mutant.output);
      assert.equal(mutant.fail, mutation.failures, mutant.output);
      assert.equal(mutant.pass, mutation.tests - mutation.failures, mutant.output);
      assert.doesNotMatch(mutant.output, /SyntaxError|ERR_MODULE_NOT_FOUND/);
      t.diagnostic(`${mutation.name}: control ${control.pass}/${control.tests} pass; mutant ${mutant.fail}/${mutant.tests} fail`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
