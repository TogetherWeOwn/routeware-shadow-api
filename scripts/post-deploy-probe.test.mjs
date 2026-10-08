import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import "./deploy-rehearsal-docs.test.mjs";
import { BASE_ENV, DEFAULT_BASE, SCHEDULED_FLAG, SKIP_FLAG, resolveBase } from "./lib/postDeployProbe.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const probe = fileURLToPath(new URL("./post-deploy-probe.mjs", import.meta.url));
const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const fixture = `
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    console.log('FIXTURE_FETCH ' + url.origin + url.pathname + ' ' + (init.method || 'GET') +
      ' ' + (init.headers?.authorization ? 'authenticated' : 'public'));
    const mode = process.env.PROBE_FIXTURE_MODE;
    if (mode === 'network-error') throw new TypeError('fixture network failure');
    if (mode === 'unauthorized' && init.headers?.authorization) {
      return new Response('{}', { status: 401 });
    }
    let status = 200;
    const body = { status: 'ok', service: 'fixture', version: 'v1' };
    if (url.pathname === '/api/v1/readiness') {
      body.checks = { cron: { stale: mode === 'stale', lastRunAt: '2026-10-08T07:00:00Z' } };
      if (mode === 'degraded') { status = 503; body.status = 'degraded'; }
    }
    if (mode === 'public-failure' && url.pathname === '/api/v1/health') status = 503;
    return new Response(JSON.stringify(body), { status });
  };
`;

function run(args = [], env = {}) {
  const result = spawnSync(process.execPath, [
    `--import=data:text/javascript,${encodeURIComponent(fixture)}`, probe,
    "--token-env=PROBE_FIXTURE_TOKEN", ...args,
  ], {
    cwd: root,
    // Do not inherit real tokens, .dev.vars fallback, or Node preload hooks.
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

function assertConfigurationFailure(result) {
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /post-deploy probe configuration: scheduled probe requires/);
  assert.doesNotMatch(result.output, /FIXTURE_FETCH|(?:PASS|FAIL|SKIP) GET/);
}

test("scheduled npm entry and workflow retain mandatory target validation", () => {
  assert.ok(pkg.scripts["probe:post-deploy:scheduled"].includes(SCHEDULED_FLAG));
  assert.ok(pkg.scripts["probe:post-deploy:scheduled"].includes(SKIP_FLAG));
  const workflow = fs.readFileSync(new URL("../.github/workflows/post-deploy-probe.yml", import.meta.url), "utf8");
  assert.match(workflow, /run: npm run probe:post-deploy:scheduled/);
  assert.match(workflow, /SHADOW_API_BASE: \$\{\{ vars\.SHADOW_API_BASE \}\}/);
  assert.match(pkg.scripts.test, /npm run test:probe && vitest run/);
  assert.match(pkg.scripts["test:coverage"], /npm run test:probe && vitest run --coverage/);
});

test("probe-only changes always run the hermetic CLI suite in CI", () => {
  const workflow = fs.readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const hygiene = workflow.split(/^  hygiene:\s*$/m)[1]?.split(/^  [\w-]+:\s*$/m)[0];
  assert.ok(hygiene, "CI must retain the always-run hygiene job");
  assert.doesNotMatch(hygiene, /^    (?:if|needs):/m);
  const step = hygiene.split(/^      - /m).find((entry) => entry.includes("run: npm run test:probe"));
  assert.ok(step, "hygiene must run the probe CLI suite even when build is skipped");
  assert.doesNotMatch(step, /^\s+(?:if|continue-on-error):/m);
});

test("base resolution keeps positional precedence and the manual local default", () => {
  assert.equal(resolveBase(), DEFAULT_BASE);
  assert.equal(resolveBase({ env: { [BASE_ENV]: "  " } }), DEFAULT_BASE);
  assert.equal(resolveBase({ env: { [BASE_ENV]: " https://staging.example " } }), "https://staging.example");
  assert.equal(resolveBase({ positional: " https://explicit.example ", env: { [BASE_ENV]: "https://env.example" }, scheduled: true }), "https://explicit.example");
  assert.equal(resolveBase({ positional: "https://127.staging.example", scheduled: true }), "https://127.staging.example");
});

for (const value of [undefined, "", " \t\n "]) {
  test(`scheduled CLI rejects missing/blank base (${JSON.stringify(value)}) before fetch`, () => {
    const env = value === undefined ? {} : { [BASE_ENV]: value };
    assertConfigurationFailure(run([SCHEDULED_FLAG, SKIP_FLAG], env));
  });
}

for (const base of [
  "not-a-url", "http://staging.example", "ftp://staging.example",
  "http://localhost:8787", "https://localhost:8787", "https://localhost.",
  "https://worker.localhost", "https://127.0.0.1", "https://127.1",
  "https://2130706433", "https://0.0.0.0", "https://[::1]", "https://[::]",
  "https://[::ffff:127.0.0.1]", "https://fixture-user:fixture-password@staging.example",
]) {
  test(`scheduled CLI rejects unsafe base ${base} without network calls`, () => {
    const result = run([SCHEDULED_FLAG, SKIP_FLAG], { [BASE_ENV]: base });
    assertConfigurationFailure(result);
    assert.doesNotMatch(result.output, /fixture-password/);
  });
}

for (const base of [
  "https://shared.example/staging", "https://shared.example?deployment=staging",
  "https://shared.example#staging", "https://shared.example?", "https://shared.example#",
  "https://shared.example/?", "https://shared.example/#",
]) {
  test(`scheduled CLI rejects non-origin base ${base} before fetch`, () => {
    assertConfigurationFailure(run([SCHEDULED_FLAG, SKIP_FLAG], { [BASE_ENV]: base }));
    assertConfigurationFailure(run([SKIP_FLAG, base], { GITHUB_EVENT_NAME: "schedule" }));
  });
}

test("scheduled CLI accepts a root slash and explicit HTTPS port", () => {
  const result = run([SCHEDULED_FLAG, SKIP_FLAG], { [BASE_ENV]: "https://staging.example:8443/" });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /FIXTURE_FETCH https:\/\/staging\.example:8443\/api\/v1\/health GET public/);
  assert.equal((result.output.match(/FIXTURE_FETCH/g) || []).length, 1);
});

test("manual mode keeps existing path-qualified base behavior", () => {
  const result = run([SKIP_FLAG], { [BASE_ENV]: "https://shared.example/staging?deployment=staging#staging" });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /FIXTURE_FETCH https:\/\/shared\.example\/api\/v1\/health GET public/);
});

test("GitHub schedule event enforces validation without --scheduled", () => {
  assertConfigurationFailure(run([SKIP_FLAG], { GITHUB_EVENT_NAME: "schedule" }));
  assertConfigurationFailure(run([SKIP_FLAG, "https://localhost"], { GITHUB_EVENT_NAME: "schedule" }));
});

test("workflow_dispatch uses the scheduled npm flags even without schedule event", () => {
  const args = pkg.scripts["probe:post-deploy:scheduled"].split(" ").slice(2);
  assertConfigurationFailure(run(args, { GITHUB_EVENT_NAME: "workflow_dispatch" }));
});

test("configured scheduled origin runs public liveness and explicitly skips missing-token probes", () => {
  const result = run([SCHEDULED_FLAG, SKIP_FLAG], { [BASE_ENV]: "https://staging.example" });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /FIXTURE_FETCH https:\/\/staging\.example\/api\/v1\/health GET public/);
  assert.equal((result.output.match(/FIXTURE_FETCH/g) || []).length, 1);
  assert.match(result.output, /2 authed probe\(s\) skipped/);
});

test("manual skip-safe mode still uses localhost for local development", () => {
  const result = run([SKIP_FLAG]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /FIXTURE_FETCH http:\/\/localhost:8787\/api\/v1\/health GET public/);
});

test("scheduled positional override wins and all authenticated checks remain GETs", () => {
  const result = run([SCHEDULED_FLAG, SKIP_FLAG, "https://explicit.example"], {
    [BASE_ENV]: "https://env.example", PROBE_FIXTURE_TOKEN: "fixture-token-not-secret",
  });
  assert.equal(result.status, 0, result.output);
  assert.equal((result.output.match(/FIXTURE_FETCH/g) || []).length, 3);
  assert.match(result.output, /PASS cron freshness/);
  assert.doesNotMatch(result.output, /env\.example|fixture-token-not-secret|POST|PUT|DELETE/);
});

for (const mode of ["degraded", "stale", "unauthorized", "public-failure", "network-error"]) {
  test(`configured scheduled target still fails the existing ${mode} gate`, () => {
    const result = run([SCHEDULED_FLAG, SKIP_FLAG], {
      [BASE_ENV]: "https://staging.example", PROBE_FIXTURE_TOKEN: "fixture-token-not-secret", PROBE_FIXTURE_MODE: mode,
    });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /post-deploy probe: .* probe\(s\) failed/);
    assert.doesNotMatch(result.output, /fixture-token-not-secret/);
  });
}

test("strict manual mode continues to fail without a token", () => {
  const result = run([], { [BASE_ENV]: "https://staging.example" });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /no bearer token found/);
});
