import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import {
  AUTH_THROTTLE_ALLOWED_FAILURES,
  AUTH_THROTTLE_BLOCK_MS,
  AUTH_THROTTLE_MAX_FAILURES,
  AUTH_THROTTLE_WINDOW_MS
} from "../src/lib/authThrottle";
import { InvalidAuthModeError } from "../src/lib/establishSession";
import * as upstreamTimeout from "../src/lib/upstreamTimeout";

/**
 * Acceptance: standard RateLimit fields on 429s + Retry-After on transient
 * 502s (R16-03, M5). Test Author card TOG-37151; build card TOG-37154.
 *
 * Wire contract (research: `draft-ietf-httpapi-ratelimit-headers` — still a
 * draft, not an RFC; RFC 9651 is the Structured Fields syntax it uses):
 * - 429s add `RateLimit: "auth-burst";r=0;t=<retryAfterSec>` and
 *   `RateLimit-Policy: "auth-burst";q=<ALLOWED_FAILURES>;w=60`, computed
 *   from the `AUTH_THROTTLE_*` single source of truth. Existing `Retry-After`
 *   and `X-RateLimit-*` stay byte-identical.
 * - Transient 502s (the `isUpstreamTimeout` onError backstop ONLY) add a
 *   fixed `Retry-After` from one named constant,
 *   `UPSTREAM_TIMEOUT_RETRY_AFTER_SEC` exported from
 *   `src/lib/upstreamTimeout.ts`. No other status gains `Retry-After`.
 * - CORS exposes the new fields.
 *
 * RED on main by design: the 5 standard-field assertions fail (no `RateLimit`
 * / `RateLimit-Policy` on 429s, no named constant, no 502 `Retry-After`)
 * while the 10 compat/negative controls pass. The Builder (TOG-37154) bases
 * on this card's pushed branch and MUST NOT edit this file.
 *
 * Expectations use math from the `AUTH_THROTTLE_*` constants and observed
 * compat headers — never hardcoded quota/window literals. The only literals
 * are the wire contract itself (`"auth-burst"`, parameter names, structure).
 *
 * IPs are TEST-NET-1 octets no other suite uses (203.0.113.210-219 taken by
 * the throttle/isolation suites, .231+ by audit suites), so per-IP DO buckets
 * never leak state between suites.
 */

const API_TOKEN = "test-api-token";

const THROTTLE_IP_RATE_LIMIT = "203.0.113.220";
const THROTTLE_IP_POLICY = "203.0.113.221";
const THROTTLE_IP_COMPAT = "203.0.113.222";
const THROTTLE_IP_BODY = "203.0.113.223";
const THROTTLE_IP_CORS = "203.0.113.224";
const FRESH_401_IP = "203.0.113.225";
const NEGATIVE_IP = "203.0.113.226";

const ORIGIN = "https://killeen.example.test";
const BASE = "/WebRW";
const LOGIN_URL = `${ORIGIN}${BASE}/Account/Login`;

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

/**
 * The Builder's named constant for the backstop-502 backoff. Read off the
 * module namespace (not a static import) so a missing export fails as a
 * plain assertion — RED with a clear message — instead of an import error.
 */
function upstreamRetryAfterSec(): unknown {
  return (upstreamTimeout as unknown as Record<string, unknown>)
    .UPSTREAM_TIMEOUT_RETRY_AFTER_SEC;
}

/** Lowercased tokens of the CORS expose line (full-token compare only). */
function exposedTokens(res: Response): string[] {
  return (res.headers.get("access-control-expose-headers") ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

function expectNoRetryHeaders(res: Response, where: string): void {
  expect(res.headers.get("retry-after"), `${where}: no Retry-After`).toBeNull();
  expect(res.headers.get("ratelimit"), `${where}: no RateLimit`).toBeNull();
  expect(
    res.headers.get("ratelimit-policy"),
    `${where}: no RateLimit-Policy`
  ).toBeNull();
}

/**
 * Drive one IP's throttle bucket to its first 429: the first
 * `MAX_FAILURES - 1` failures stay 401, the next is 429. The gate rejects
 * before any session/upstream work, so the fetch-throw stub below must never
 * fire.
 */
async function driveToFirst429(ip: string): Promise<Response> {
  const path = "/api/v1/routeware/home/index";
  for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES - 1; i++) {
    const res = await exports.default.fetch(`http://test.local${path}`, {
      headers: {
        authorization: `Bearer guess-${i}`,
        "CF-Connecting-IP": ip
      }
    });
    expect(res.status, `failure ${i + 1} stays 401`).toBe(401);
  }
  return exports.default.fetch(`http://test.local${path}`, {
    headers: {
      authorization: "Bearer guess-final",
      "CF-Connecting-IP": ip
    }
  });
}

/** A fetch mock that never settles — the hung-upstream shape. */
function hangForever(): void {
  globalThis.fetch = vi.fn(
    (_input: unknown, _init?: RequestInit) => new Promise<Response>(() => {})
  ) as unknown as typeof fetch;
}

/**
 * Synthetic env for direct `app.fetch` calls to the sessionless login-page
 * probe (copied from test/upstreamTimeoutRoutes.test.ts): drives the full
 * route → direct forward → onError path with a hung upstream on a 50ms
 * override budget. The probe never touches the session lock; the AUTH_SESSION
 * stub only serves the bearer gate's throttle-clear and the middleware's
 * sessionStub placeholder.
 */
function timeoutAppEnv(): Env {
  const stub = {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const path = new URL(typeof input === "string" ? input : String(input))
        .pathname;
      if (path === "/throttle/clear" || path === "/throttle/failure") {
        return Response.json({ blocked: false, retryAfterSec: 0 });
      }
      if (path === "/get") {
        return Response.json({
          cookieHeader: null,
          expiresAtMs: null,
          refreshing: false
        });
      }
      return new Response("Not Found", { status: 404 });
    }
  };
  const AUTH_SESSION = {
    idFromName: (name: string) => name,
    get: (_id: string) => stub
  };
  return {
    LOGIN_URL,
    UPSTREAM_TIMEOUT_MS: "50",
    TARGET_ORIGIN: ORIGIN,
    TARGET_BASE_PATH: BASE,
    SHADOW_API_TOKEN: API_TOKEN,
    AUTH_SESSION
  } as unknown as Env;
}

async function loginPageProbe(): Promise<Response> {
  return app.fetch(
    new Request("http://test.local/api/v1/routeware/account/login-page", {
      headers: { authorization: `Bearer ${API_TOKEN}` }
    }),
    timeoutAppEnv(),
    ctx
  );
}

/**
 * Direct onError-branch probe (house pattern from
 * test/securityHeadersCorsPosture.test.ts): isolates one named onError
 * branch without env surgery. The branch's own withCors output is what ships
 * in production for that error type.
 */
async function onErrorRes(err: unknown, path: string): Promise<Response> {
  const handler = (
    app as unknown as {
      errorHandler: (e: unknown, c: unknown) => Response | Promise<Response>;
    }
  ).errorHandler;
  const url = `http://test.local${path}`;
  return await handler(err, {
    req: { raw: new Request(url), url, method: "GET" },
    env: {}
  });
}

describe("standard RateLimit fields on 429s", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Plain function, not vi.fn(): the spy wrapper records each call's
    // settled result, which turns a deliberate rejection into an unhandled
    // rejection under @cloudflare/vitest-pool-workers (house pattern).
    globalThis.fetch = (async () => {
      throw new Error("Unexpected upstream fetch in standard-ratelimit test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("429 carries RateLimit r/t from the throttle verdict", async () => {
    // Arrange — drive this IP to its first 429.
    const res = await driveToFirst429(THROTTLE_IP_RATE_LIMIT);
    expect(res.status).toBe(429);

    // Act — remaining quota and backoff come from the compat headers on this
    // same response, so the standard field is cross-pinned to them.
    const retryAfter = res.headers.get("retry-after");
    const remaining = res.headers.get("x-ratelimit-remaining");
    expect(retryAfter, "compat Retry-After present").toMatch(/^\d+$/);
    expect(remaining, "compat X-RateLimit-Remaining present").toMatch(/^\d+$/);

    // Assert — exact Structured Fields shape, byte-pinned (no whitespace
    // tolerance): RED on main, which sends no RateLimit field.
    expect(res.headers.get("ratelimit")).toBe(
      `"auth-burst";r=${remaining};t=${retryAfter}`
    );
  });

  it("429 carries RateLimit-Policy q/w from AUTH_THROTTLE_*", async () => {
    // Arrange — quota is the failures-per-window budget (the next failure
    // past it is the first 429); the window is pinned in seconds by division,
    // never a literal.
    expect(AUTH_THROTTLE_ALLOWED_FAILURES).toBe(
      AUTH_THROTTLE_MAX_FAILURES - 1
    );
    const windowSec = AUTH_THROTTLE_WINDOW_MS / 1000;
    expect(Number.isInteger(windowSec)).toBe(true);

    // Act
    const res = await driveToFirst429(THROTTLE_IP_POLICY);
    expect(res.status).toBe(429);

    // Assert — RED on main, which sends no RateLimit-Policy field.
    expect(res.headers.get("ratelimit-policy")).toBe(
      `"auth-burst";q=${AUTH_THROTTLE_ALLOWED_FAILURES};w=${windowSec}`
    );
  });

  it("compat: Retry-After and X-RateLimit-* byte-identical to main", async () => {
    // Arrange — wall-clock bounds around the drive for the Reset pin.
    const beforeSec = Math.floor(Date.now() / 1000);
    const res = await driveToFirst429(THROTTLE_IP_COMPAT);
    const afterSec = Math.ceil(Date.now() / 1000);
    expect(res.status).toBe(429);

    // Assert — every compat header pinned to the constants' math: limit is
    // the allowed-failures budget, remaining is exhausted, backoff clears
    // within one block window, and reset ≈ observation time + backoff (both
    // derive from the same blockedUntilMs).
    const retryAfter = res.headers.get("retry-after");
    expect(retryAfter).toMatch(/^\d+$/);
    const retryAfterSec = Number(retryAfter);
    expect(retryAfterSec).toBeGreaterThan(0);
    expect(retryAfterSec).toBeLessThanOrEqual(
      Math.ceil(AUTH_THROTTLE_BLOCK_MS / 1000)
    );
    expect(res.headers.get("x-ratelimit-limit")).toBe(
      String(AUTH_THROTTLE_ALLOWED_FAILURES)
    );
    expect(res.headers.get("x-ratelimit-remaining")).toBe("0");
    const reset = res.headers.get("x-ratelimit-reset");
    expect(reset).toMatch(/^\d+$/);
    const resetSec = Number(reset);
    expect(resetSec).toBeGreaterThanOrEqual(beforeSec + retryAfterSec - 2);
    expect(resetSec).toBeLessThanOrEqual(afterSec + retryAfterSec + 1);
  });

  it("compat: 429 problem body unchanged", async () => {
    const res = await driveToFirst429(THROTTLE_IP_BODY);
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as {
      type: string;
      title: string;
      status: number;
    };
    expect(body.type).toContain("rate-limited");
    expect(body.title).toBe("Too Many Requests");
    expect(body.status).toBe(429);
  });

  it("CORS exposes the standard fields on the 429", async () => {
    const res = await driveToFirst429(THROTTLE_IP_CORS);
    expect(res.status).toBe(429);
    // Full-token compare: `x-ratelimit-limit` contains `ratelimit` as a
    // substring, so a substring check would pass on main for the wrong reason.
    const tokens = exposedTokens(res);
    expect(tokens).toContain("retry-after");
    expect(tokens).toContain("ratelimit");
    expect(tokens).toContain("ratelimit-policy");
  });
});

describe("Retry-After on transient 502s (isUpstreamTimeout backstop)", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("backstop 502 carries fixed Retry-After from UPSTREAM_TIMEOUT_RETRY_AFTER_SEC", async () => {
    // Arrange — hung upstream on the 50ms override (the 15s default would
    // blow the elapsed ceiling): the elapsed assertion proves the override
    // branch, not just some timer.
    hangForever();
    const start = Date.now();
    const res = await loginPageProbe();
    expect(Date.now() - start).toBeLessThan(5_000);
    expect(res.status).toBe(502);

    // Assert — the value is the named constant (positive integer seconds),
    // not a per-request computation. RED on main: no such export, no header.
    const retryAfterSec = upstreamRetryAfterSec();
    expect(
      typeof retryAfterSec,
      "named constant UPSTREAM_TIMEOUT_RETRY_AFTER_SEC exported from src/lib/upstreamTimeout.ts"
    ).toBe("number");
    expect(Number.isInteger(retryAfterSec)).toBe(true);
    expect(retryAfterSec as number).toBeGreaterThan(0);
    expect(res.headers.get("retry-after")).toBe(String(retryAfterSec));
  });

  it("502 Retry-After is fixed across backstop responses", async () => {
    hangForever();
    const first = await loginPageProbe();
    const second = await loginPageProbe();
    expect(first.status).toBe(502);
    expect(second.status).toBe(502);
    expect(first.headers.get("retry-after")).toBe(
      String(upstreamRetryAfterSec())
    );
    expect(second.headers.get("retry-after")).toBe(
      first.headers.get("retry-after")
    );
  });

  it("compat: backstop 502 problem body unchanged", async () => {
    hangForever();
    const res = await loginPageProbe();
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as {
      type: string;
      title: string;
      status: number;
      detail?: string;
    };
    expect(body.type).toContain("bad-gateway");
    expect(body.title).toBe("Upstream timed out");
    expect(body.status).toBe(502);
    expect(body.detail).toContain("50ms");
  });

  it("CORS exposes Retry-After on the backstop 502", async () => {
    hangForever();
    const res = await loginPageProbe();
    expect(res.status).toBe(502);
    expect(exposedTokens(res)).toContain("retry-after");
  });
});

describe("no other status gains Retry-After", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = (async () => {
      throw new Error("Unexpected upstream fetch in standard-ratelimit test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("200 public health: no retry headers", async () => {
    const res = await exports.default.fetch("http://test.local/api/v1/health");
    expect(res.status).toBe(200);
    expectNoRetryHeaders(res, "GET /api/v1/health");
  });

  it("200 authed read: no retry headers", async () => {
    const res = await exports.default.fetch(
      "http://test.local/api/v1/shadow/health",
      {
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "CF-Connecting-IP": NEGATIVE_IP
        }
      }
    );
    expect(res.status).toBe(200);
    expectNoRetryHeaders(res, "GET /api/v1/shadow/health");
  });

  it("400 hook rejection: no retry headers", async () => {
    // `limit=0` violates the list query's min(1): the validation hook
    // rejects before any D1 query runs.
    const res = await exports.default.fetch(
      "http://test.local/api/v1/customer-snapshot?limit=0",
      {
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "CF-Connecting-IP": NEGATIVE_IP
        }
      }
    );
    expect(res.status).toBe(400);
    expectNoRetryHeaders(res, "GET /api/v1/customer-snapshot?limit=0");
  });

  it("401 bad token: no retry headers", async () => {
    const res = await exports.default.fetch(
      "http://test.local/api/v1/routeware/home/index",
      {
        headers: {
          authorization: "Bearer wrong-token",
          "CF-Connecting-IP": FRESH_401_IP
        }
      }
    );
    expect(res.status).toBe(401);
    expectNoRetryHeaders(res, "bad-token 401");
  });

  it("404 unknown path: no retry headers", async () => {
    const res = await exports.default.fetch(
      "http://test.local/api/v1/does-not-exist",
      {
        headers: {
          authorization: `Bearer ${API_TOKEN}`,
          "CF-Connecting-IP": NEGATIVE_IP
        }
      }
    );
    expect(res.status).toBe(404);
    expectNoRetryHeaders(res, "unknown-path 404");
  });

  it("503 invalid AUTH_MODE onError branch: no retry headers", async () => {
    const res = await onErrorRes(
      new InvalidAuthModeError("browserr"),
      "/api/v1/routeware/home/index"
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      type: string;
      title: string;
      status: number;
    };
    expect(body.type).toContain("misconfigured");
    expect(body.title).toBe("Service Unavailable");
    expect(body.status).toBe(503);
    expectNoRetryHeaders(res, "invalid AUTH_MODE 503");
  });
});
