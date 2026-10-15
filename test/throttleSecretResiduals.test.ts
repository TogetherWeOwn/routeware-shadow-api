import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_THROTTLE_ALLOWED_FAILURES,
  AUTH_THROTTLE_BLOCK_MS,
  AUTH_THROTTLE_MAX_FAILURES,
  AUTH_THROTTLE_WINDOW_MS,
  clearAuthFailures,
  recordAuthFailure,
  resetAuthThrottleFailOpenLogForTests
} from "../src/lib/authThrottle";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";
import { releaseRefreshLock } from "../src/lib/sessionRefreshLock";

// R9-24 re-verification of the TOG-6278 throttle-burst + secret-residual audit
// (2026-09-27, docs/TOG-6278-throttle-burst-audit.md) against everything that
// landed after it: the XFF gate (#155), the 429 `X-RateLimit-*` headers (#216),
// structured logging via `logEvent` (#226, docs/LOGGING.md), per-IP bucket
// isolation (R3-20) and the fail-open alarm. Companion auth-login log sites
// (`auth.login`, `auth.browser`) are pinned in test/authLogResiduals.test.ts.
//
// TOG-6278 pattern: every probe below is a distinct, unmistakable string
// submitted through a real input channel (bearer, extra header, DO error,
// DO response body, lock clientIpFromRequest; assertions then demand ZERO occurrences of
// every probe in (a) every structured log line emitted, (b) every response
// body, and (c) every response header value. A probe appearing anywhere in
// those blobs fails the test by name.

// Matches wrangler.toml [env.test.vars]. The valid token is itself a probe:
// a correct gate must never write it to logs or echo it back either.
const API_TOKEN = "test-api-token";

const PROBE_BEARER_401 = "probe-bearer401-r9-5f2c91";
const PROBE_BEARER_429 = "probe-bearer429-r9-8a41d7";
const PROBE_BEARER_INBLOCK = "probe-bearerinblock-r9-3e77b0";
const PROBE_PII_EMAIL = "probe-pii-r9-41c2@example.invalid";
const PROBE_COOKIE = ".WebRW=probe-cookie-r9-6d09e3";
const PROBE_PASSWORD = "probe-password-r9-27f5aa";
const PROBE_LOCK_TOKEN = "probe-locktoken-r9-91b8c4";

// Fresh TEST-NET-3 IPs, never used by authThrottle.test.ts
// (203.0.113.7/.99/.200), throttleBurst.test.ts (.211-.217),
// authThrottleFailOpenAlarm.test.ts (.210) or throttleResetIsolation /
// authGateSweep (.140, .231, .232, .250), so per-IP DO buckets never leak
// state between suites.
const BURST_IP = "203.0.113.218";
const FAILOPEN_IP = "203.0.113.219";

const HOME_INDEX = "/api/v1/routeware/home/index";
const SHADOW_HEALTH = "/api/v1/shadow/health";
const RATE_LIMITED_TYPE = `${PROBLEM_TYPE_BASE}rate-limited`;

type LogLine = { level: string; record: unknown };

// Direct console assignment, not vi.spyOn: under
// `@cloudflare/vitest-pool-workers` the console methods are bound accessors,
// so reading them back does not return an installed spy (same pattern as
// test/authThrottleFailOpenAlarm.test.ts). `logEvent` (src/lib/logger.ts:155)
// is the only permitted console caller, and it dispatches one structured
// object to console[level] — capturing all three levels captures every
// structured log line the worker can emit.
const realConsole = {
  info: console.info,
  warn: console.warn,
  error: console.error
};
const logLines: LogLine[] = [];

function captureLogs(): void {
  logLines.length = 0;
  for (const level of ["info", "warn", "error"] as const) {
    console[level] = (...args: unknown[]) => {
      logLines.push({ level, record: args[0] });
    };
  }
}

function restoreLogs(): void {
  console.info = realConsole.info;
  console.warn = realConsole.warn;
  console.error = realConsole.error;
}

function expectNoProbes(blob: string, probes: readonly string[], where: string): void {
  for (const probe of probes) {
    expect(blob, `${where} must not contain probe ${JSON.stringify(probe)}`).not.toContain(probe);
  }
}

function expectLogsClean(probes: readonly string[]): void {
  expectNoProbes(JSON.stringify(logLines), probes, "structured logs");
}

type SeenResponse = {
  status: number;
  headers: Headers;
  text: string;
};

const seenResponses: SeenResponse[] = [];

async function callAndRecord(
  path: string,
  opts: { token?: string; ip?: string; extraHeaders?: Record<string, string> } = {}
): Promise<SeenResponse> {
  const headers = new Headers();
  if (opts.token !== undefined) {
    headers.set("authorization", `Bearer ${opts.token}`);
  }
  if (opts.ip) {
    headers.set("CF-Connecting-IP", opts.ip);
  }
  for (const [name, value] of Object.entries(opts.extraHeaders ?? {})) {
    headers.set(name, value);
  }
  const res = await exports.default.fetch(`http://test.local${path}`, {
    method: "GET",
    headers
  });
  const seen: SeenResponse = { status: res.status, headers: res.headers, text: await res.text() };
  seenResponses.push(seen);
  return seen;
}

function expectResponsesClean(probes: readonly string[]): void {
  for (const [index, seen] of seenResponses.entries()) {
    expectNoProbes(seen.text, probes, `response #${index} (status ${seen.status}) body`);
    seen.headers.forEach((value, name) => {
      expectNoProbes(value, probes, `response #${index} header ${name}`);
    });
  }
}

function rateLimitHeaders(seen: SeenResponse): {
  limit: string | null;
  remaining: string | null;
  reset: number;
  retryAfter: number;
} {
  const reset = Number(seen.headers.get("x-ratelimit-reset"));
  const retryAfter = Number(seen.headers.get("retry-after"));
  expect(Number.isSafeInteger(reset)).toBe(true);
  expect(Number.isSafeInteger(retryAfter)).toBe(true);
  return {
    limit: seen.headers.get("x-ratelimit-limit"),
    remaining: seen.headers.get("x-ratelimit-remaining"),
    reset,
    retryAfter
  };
}

function expectBurst429(seen: SeenResponse, atMs: number): void {
  expect(seen.status).toBe(429);
  expect(seen.headers.get("content-type")).toContain("problem+json");
  const { limit, remaining, reset, retryAfter } = rateLimitHeaders(seen);
  // #216 headers, re-derived from the current constants rather than
  // literals: the limit is the 401 budget per window
  // (AUTH_THROTTLE_ALLOWED_FAILURES = MAX - 1, src/lib/authThrottle.ts:29),
  // and the reset/retry pair must describe the same block end.
  expect(limit).toBe(String(AUTH_THROTTLE_ALLOWED_FAILURES));
  expect(AUTH_THROTTLE_ALLOWED_FAILURES).toBe(AUTH_THROTTLE_MAX_FAILURES - 1);
  expect(remaining).toBe("0");
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(Math.ceil(AUTH_THROTTLE_BLOCK_MS / 1000));
  expect(reset).toBeGreaterThan(Math.floor(atMs / 1000));
  expect(reset).toBeLessThanOrEqual(Math.ceil((atMs + AUTH_THROTTLE_BLOCK_MS) / 1000));
  // Reset and Retry-After name the same instant (1s of ceil slack).
  expect(Math.abs(reset - Math.floor(atMs / 1000) - retryAfter)).toBeLessThanOrEqual(1);
  const exposed = (seen.headers.get("access-control-expose-headers") ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase());
  expect(exposed).toEqual(
    expect.arrayContaining([
      "retry-after",
      "x-ratelimit-limit",
      "x-ratelimit-remaining",
      "x-ratelimit-reset"
    ])
  );
  const body = JSON.parse(seen.text) as { type: string; title: string; status: number };
  expect(body).toMatchObject({ type: RATE_LIMITED_TYPE, title: "Too Many Requests", status: 429 });
}

it("pass-and-pin: throttle constants match the audited 20/60s/60s policy", () => {
  // Literal pins, deliberately not derived: the burst loop below scales
  // with the constants, so only this assertion turns red if a future change
  // retunes the policy without a fresh burst + residual audit.
  expect(AUTH_THROTTLE_MAX_FAILURES).toBe(20);
  expect(AUTH_THROTTLE_ALLOWED_FAILURES).toBe(19);
  expect(AUTH_THROTTLE_WINDOW_MS).toBe(60_000);
  expect(AUTH_THROTTLE_BLOCK_MS).toBe(60_000);
});

describe("throttle burst re-verification + log residuals (R9-24)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    seenResponses.length = 0;
    captureLogs();
    // No request below should reach upstream: 401s/429s stop at the gate,
    // and the one authorized probe uses shadow/health (no proxy). Reaching
    // this stub would mean the gate leaked a request through.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in throttle residual test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreLogs();
  });

  it(
    "pass-and-pin: full burst stays at current constants and emits zero " +
      "bearer/token/PII residuals to logs, bodies or headers",
    async () => {
      const probes = [
        PROBE_BEARER_401,
        PROBE_BEARER_429,
        PROBE_BEARER_INBLOCK,
        PROBE_PII_EMAIL,
        PROBE_COOKIE,
        API_TOKEN
      ];
      // PII/cookie material rides along on ordinary request headers: the
      // gate, throttle and logger must never echo request header values.
      const dirtyHeaders = { "x-customer-email": PROBE_PII_EMAIL, cookie: PROBE_COOKIE };

      // 401 budget: exactly AUTH_THROTTLE_ALLOWED_FAILURES plain 401s.
      const first = await callAndRecord(HOME_INDEX, {
        token: PROBE_BEARER_401,
        ip: BURST_IP,
        extraHeaders: dirtyHeaders
      });
      expect(first.status).toBe(401);
      for (let i = 1; i < AUTH_THROTTLE_ALLOWED_FAILURES; i++) {
        const res = await callAndRecord(HOME_INDEX, { token: `burst-fill-${i}`, ip: BURST_IP });
        expect(res.status).toBe(401);
      }
      // Pass-and-pin at the threshold: 401s carry no rate-limit headers;
      // #216 stamps them on the 429 only (src/app.ts:133-142 vs :145-155).
      for (const seen of seenResponses) {
        expect(seen.headers.get("x-ratelimit-limit")).toBeNull();
        expect(seen.headers.get("x-ratelimit-remaining")).toBeNull();
        expect(seen.headers.get("x-ratelimit-reset")).toBeNull();
        expect(seen.headers.get("retry-after")).toBeNull();
      }

      // The MAX_FAILURES-th failure is the first 429.
      const throttledAt = Date.now();
      const throttled = await callAndRecord(HOME_INDEX, {
        token: PROBE_BEARER_429,
        ip: BURST_IP,
        extraHeaders: dirtyHeaders
      });
      expectBurst429(throttled, throttledAt);

      // In-block failures stay 429; throttleRecordFailure re-arms
      // blockedUntil >= the first block end.
      const inBlockAt = Date.now();
      const inBlock = await callAndRecord(HOME_INDEX, {
        token: PROBE_BEARER_INBLOCK,
        ip: BURST_IP
      });
      expectBurst429(inBlock, inBlockAt);
      expect(rateLimitHeaders(inBlock).reset).toBeGreaterThanOrEqual(
        rateLimitHeaders(throttled).reset
      );

      // The valid token passes during the block and resets the bucket.
      const legit = await callAndRecord(SHADOW_HEALTH, { token: API_TOKEN, ip: BURST_IP });
      expect(legit.status).toBe(200);
      const afterReset = await callAndRecord(HOME_INDEX, { token: "after-reset", ip: BURST_IP });
      expect(afterReset.status).toBe(401);

      // Zero residuals anywhere the probes could have landed.
      expectResponsesClean(probes);
      expectLogsClean(probes);
      // The gate/throttle success-and-failure path is log-silent by design
      // (only fail-open logs): pin that nothing at all was written. If a
      // future call site starts logging this path, this fails and the new
      // site must be added to the residual audit deliberately.
      expect(logLines).toEqual([]);
    }
  );
});

function reqWith(headers: Record<string, string>): {
  header: (n: string) => string | undefined;
} {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return { header: (n: string) => lower[n.toLowerCase()] };
}

function envWithStub(stub: { fetch: typeof fetch }): Env {
  return {
    AUTH_SESSION: {
      idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
      get: () => stub as unknown as DurableObjectStub
    }
  } as unknown as Env;
}

const failOpenEvent = (reason: string) => ({
  level: "error",
  msg: "AUTH THROTTLE FAIL-OPEN",
  route: "authThrottle.failOpen",
  reason,
  ms: null
});

describe("throttle/auth log call-site residuals (R9-24)", () => {
  beforeEach(() => {
    resetAuthThrottleFailOpenLogForTests();
    captureLogs();
  });

  afterEach(() => {
    restoreLogs();
  });

  it(
    "pass-and-pin: fail-open do_error line is the fixed event even when the " +
      "DO error message and request headers carry probes",
    async () => {
      const probes = [PROBE_BEARER_401, PROBE_PASSWORD, PROBE_COOKIE, PROBE_PII_EMAIL, FAILOPEN_IP];
      const env = envWithStub({
        fetch: (async () => {
          throw new Error(`DO unreachable for ${FAILOPEN_IP}: ${probes.join(" ")}`);
        }) as typeof fetch
      });
      const req = reqWith({
        "CF-Connecting-IP": FAILOPEN_IP,
        authorization: `Bearer ${PROBE_BEARER_401}`,
        cookie: PROBE_COOKIE
      });

      const verdict = await recordAuthFailure(env, req, 5_000_000);

      expect(verdict).toEqual({ blocked: false, retryAfterSec: 0 });
      expect(logLines).toEqual([{ level: "error", record: failOpenEvent("do_error") }]);
      expectLogsClean(probes);
    }
  );

  it(
    "pass-and-pin: fail-open do_non_ok line carries only the status even " +
      "when the DO response body carries probes",
    async () => {
      const probes = [PROBE_BEARER_429, PROBE_PASSWORD, PROBE_PII_EMAIL, FAILOPEN_IP];
      const env = envWithStub({
        fetch: (async () =>
          new Response(`upstream exploded: ${probes.join(" ")}`, { status: 503 })) as typeof fetch
      });
      const req = reqWith({
        "CF-Connecting-IP": FAILOPEN_IP,
        authorization: `Bearer ${PROBE_BEARER_429}`
      });

      const verdict = await recordAuthFailure(env, req, 6_000_000);

      expect(verdict).toEqual({ blocked: false, retryAfterSec: 0 });
      expect(logLines).toEqual([
        { level: "error", record: failOpenEvent("do_non_ok status=503") }
      ]);
      expectLogsClean(probes);
    }
  );

  it(
    "pass-and-pin: fail-open do_malformed line stays fixed even when the " +
      "verdict JSON carries probes in extra fields",
    async () => {
      const probes = [PROBE_BEARER_INBLOCK, PROBE_COOKIE, PROBE_PASSWORD, FAILOPEN_IP];
      const env = envWithStub({
        fetch: (async () =>
          Response.json({
            blocked: "yes-ish",
            retryAfterSec: "soon",
            bearer: PROBE_BEARER_INBLOCK,
            cookie: PROBE_COOKIE,
            ip: FAILOPEN_IP
          })) as typeof fetch
      });
      const req = reqWith({ "CF-Connecting-IP": FAILOPEN_IP });

      const verdict = await recordAuthFailure(env, req, 7_000_000);

      expect(verdict).toEqual({ blocked: false, retryAfterSec: 0 });
      expect(logLines).toEqual([{ level: "error", record: failOpenEvent("do_malformed") }]);
      expectLogsClean(probes);
    }
  );

  it(
    "pass-and-pin: clear failures never throw and never log, even when the " +
      "DO error carries probes",
    async () => {
      const probes = [PROBE_BEARER_401, PROBE_PASSWORD, FAILOPEN_IP];
      const env = envWithStub({
        fetch: (async () => {
          throw new Error(`clear failed: ${probes.join(" ")}`);
        }) as typeof fetch
      });
      const req = reqWith({ "CF-Connecting-IP": FAILOPEN_IP });

      await expect(clearAuthFailures(env, req)).resolves.toBeUndefined();
      expect(logLines).toEqual([]);
      expectLogsClean(probes);
    }
  );

  it(
    "pass-and-pin: auth.refreshLock warn is the fixed event and never " +
      "carries the lock token or the DO error",
    async () => {
      const probes = [PROBE_LOCK_TOKEN, PROBE_COOKIE, PROBE_PASSWORD];
      const stub = {
        fetch: async () => {
          throw new Error(`unlock failed for ${PROBE_LOCK_TOKEN}: ${PROBE_COOKIE}`);
        }
      } as unknown as DurableObjectStub;

      await expect(releaseRefreshLock(stub, PROBE_LOCK_TOKEN)).resolves.toBeUndefined();

      expect(logLines).toEqual([
        {
          level: "warn",
          record: {
            level: "warn",
            msg: "Failed to release the auth refresh lock; it will expire via its TTL",
            route: "auth.refreshLock",
            ms: null
          }
        }
      ]);
      expectLogsClean(probes);
    }
  );
});
