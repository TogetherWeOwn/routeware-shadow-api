import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const wrapper = fileURLToPath(new URL("./smoke-readiness.mjs", import.meta.url));
const TOKEN = "smoke-fixture-token-not-a-secret";
const BASE = "https://smoke-fixture.example";
const fixture = `
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    console.log('FIXTURE_FETCH ' + url.origin + url.pathname + ' ' + (init.method || 'GET') +
      ' ' + (init.headers?.authorization ? 'authenticated' : 'public'));
    if (process.env.SMOKE_FIXTURE_MODE === 'network-error') throw new TypeError('fixture network failure');
    if (url.pathname === '/api/v1/health') {
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    }
    if (url.pathname === '/api/v1/readiness') {
      if (!init.headers?.authorization) return new Response(JSON.stringify({ status: 'error' }), { status: 401 });
      const body = {
        status: 'ok',
        checks: {
          d1: { ok: true },
          r2: { ok: true, bound: true, enabled: true },
          config: { ok: true, customer: 'c', address: 'a', container: 'ct' },
          cron: { stale: false, lastRunAt: '2026-10-01T07:00:00.000Z', tables: {} },
        },
      };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  };
`;

function run(args = [], env = {}) {
  const result = spawnSync(process.execPath, [
    `--import=data:text/javascript,${encodeURIComponent(fixture)}`, wrapper,
    "--timeout-ms=1000", ...args,
  ], {
    cwd: root,
    // Do not inherit real tokens or Node preload hooks.
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

test("--help works without env and makes no requests", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Usage:/);
  assert.doesNotMatch(result.output, /FIXTURE_FETCH/);
});

test("an invalid flag fails with usage before env is checked", () => {
  // Pins parse-before-env order: with no env at all this must still be the
  // flag error (exit 2 with usage), never a missing-env error.
  const result = run(["--timeout-ms=abc"]);
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /Invalid --timeout-ms value/);
  assert.match(result.output, /Usage:/);
  assert.doesNotMatch(result.output, /FIXTURE_FETCH/);
});

test("missing base fails with usage and makes no requests", () => {
  const result = run([], { SHADOW_API_TOKEN: TOKEN });
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /Missing SHADOW_API_BASE/);
  assert.match(result.output, /Usage:/);
  assert.doesNotMatch(result.output, /FIXTURE_FETCH/);
  assert.doesNotMatch(result.output, new RegExp(TOKEN));
});

test("missing token fails with usage and makes no requests", () => {
  const result = run([], { SHADOW_API_BASE: BASE });
  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /Missing SHADOW_API_TOKEN/);
  assert.match(result.output, /Usage:/);
  assert.doesNotMatch(result.output, /FIXTURE_FETCH/);
});

test("healthy run sends auth only on the authenticated readiness probe", () => {
  const result = run([], { SHADOW_API_BASE: BASE, SHADOW_API_TOKEN: TOKEN });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, new RegExp(`FIXTURE_FETCH ${BASE.replace(/\./g, "\\.")}/api/v1/health GET public`));
  const readiness = result.output.match(/FIXTURE_FETCH \S+\/api\/v1\/readiness GET \w+/g) ?? [];
  assert.deepEqual(readiness, [
    `FIXTURE_FETCH ${BASE}/api/v1/readiness GET public`,
    `FIXTURE_FETCH ${BASE}/api/v1/readiness GET authenticated`,
  ]);
  assert.match(result.output, /PASS liveness/);
  assert.match(result.output, /PASS auth gate/);
  assert.match(result.output, /PASS readiness/);
  assert.doesNotMatch(result.output, new RegExp(TOKEN));
});

test("a network failure exits 1 with a one-line FAIL, no stack, no token", () => {
  const result = run([], {
    SHADOW_API_BASE: BASE,
    SHADOW_API_TOKEN: TOKEN,
    SMOKE_FIXTURE_MODE: "network-error",
  });
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /FAIL liveness: GET \/api\/v1\/health -> network-error/);
  assert.doesNotMatch(result.output, new RegExp(TOKEN));
  assert.doesNotMatch(result.output, /at /);
  assert.doesNotMatch(result.output, /TypeError: /);
});
