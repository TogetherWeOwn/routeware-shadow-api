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
    // Fail fast if the wrapper already blew the per-request timeout: with a
    // dropped timeoutMs the abort fires in ~1ms, so a healthy instant fixture
    // would otherwise never observe it.
    if (init.signal?.aborted) throw new DOMException('fixture: signal already aborted', 'AbortError');
    if (process.env.SMOKE_FIXTURE_MODE === 'network-error') throw new TypeError('fixture network failure');
    if (process.env.SMOKE_FIXTURE_MODE === 'hang') {
      // Never answers: only the wrapper's per-request abort ends this, so the
      // elapsed time pins the exact --timeout-ms value plumbed through.
      await new Promise((_, reject) => {
        init.signal?.addEventListener('abort',
          () => reject(new DOMException('fixture: hung request aborted', 'AbortError')),
          { once: true });
      });
    }
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

// Canonical RegExp escape: escaping only "." is an incomplete sanitization
// (CodeQL js/incomplete-sanitization) — every metacharacter must be escaped.
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function run(args = [], env = {}, timeoutMs = 1000) {
  const result = spawnSync(process.execPath, [
    `--import=data:text/javascript,${encodeURIComponent(fixture)}`, wrapper,
    `--timeout-ms=${timeoutMs}`, ...args,
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

test("escapeRegExp escapes every RegExp metacharacter", () => {
  // Pins the full escape directly: the probe assertions below only ever
  // escape BASE (whose sole metacharacter is ".") through an unanchored
  // match, so without this a dots-only revert would stay green.
  assert.equal(
    escapeRegExp(".*+?^${}()|[]\\"),
    "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\",
  );
});

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
  assert.match(result.output, new RegExp(`FIXTURE_FETCH ${escapeRegExp(BASE)}/api/v1/health GET public`));
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

test("--timeout-ms bounds a hanging server through the wrapper", () => {
  // Pins the wrapper's timeoutMs plumbing end to end: the fixture never
  // answers, so the elapsed time is 3x the plumbed per-request timeout.
  // A dropped timeoutMs aborts in ~1ms (below the floor); a hardcoded
  // default takes 3x15s (above the ceiling). Node timers never fire early,
  // so the floor is not flaky under runner load.
  const timeoutMs = 200;
  const started = Date.now();
  const result = run([], {
    SHADOW_API_BASE: BASE,
    SHADOW_API_TOKEN: TOKEN,
    SMOKE_FIXTURE_MODE: "hang",
  }, timeoutMs);
  const elapsed = Date.now() - started;
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /FAIL liveness: GET \/api\/v1\/health -> timeout/);
  assert.match(result.output, /FAIL auth gate: unauthenticated readiness -> timeout/);
  assert.match(result.output, /FAIL readiness: GET \/api\/v1\/readiness -> timeout/);
  assert.doesNotMatch(result.output, /MISSING/);
  assert.doesNotMatch(result.output, /degraded/);
  assert.doesNotMatch(result.output, new RegExp(TOKEN));
  assert.ok(elapsed >= 300, `expected ~3x${timeoutMs}ms of timeout waits, took ${elapsed}ms: ${result.output}`);
  assert.ok(elapsed < 5_000, `expected --timeout-ms=${timeoutMs} to bound the run, took ${elapsed}ms: ${result.output}`);
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
