import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { AUTH_THROTTLE_MAX_FAILURES } from "../src/lib/authThrottle";

/**
 * R16-02 RED acceptance: X-Request-Id propagation forward-port (TOG-37150).
 *
 * Behaviour forward-ported from the unmerged R3-23 slice `8a6816f8`
 * (`test/integration.test.ts` request-ID block, still applies in shape):
 * adopt a valid inbound `X-Request-Id`, mint a UUID when it is absent or
 * invalid (overlong / non-token chars), echo it on every response, carry it
 * as `requestId` in problem bodies and `app.onError` log events, and
 * allow/expose the header for browser clients.
 *
 * RED on main, which is grep-clean for `x-request` handling: every test below
 * asserts the `X-Request-Id` response header and fails until the build lands.
 * The Builder builds on this card's branch and must never edit this file —
 * return incorrect tests to TOG-37150 instead.
 *
 * Conventions: distinct TEST-NET-3 throttle IPs per gate test (no other suite
 * uses 203.0.113.171-173); no test reaches the network (the fetch stub fails
 * loudly, and the 502 trigger overrides it with a stubbed upstream).
 */

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";
const FOREIGN_ORIGIN = "https://app.example.com";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Validity rule per the build card: 1-128 chars of RFC 7230 token chars
// (the reference slice used hono/request-id defaults: <=255 of [A-Za-z0-9_\-=]).
// Test inputs stay in the agreed zone: clearly-valid IDs echo, clearly-overlong
// (300 chars) and clearly-non-token inputs mint — no boundary pinning.
const OVERLONG_ID = "a".repeat(300);
const NONTOKEN_ID = "trace id/with.special:chars@x";
// Distinct TEST-NET-3 IPs so throttle buckets never collide with other suites.
const THROTTLE_IP_429 = "203.0.113.171";
const GATE_IP_401_ECHO = "203.0.113.172";
const GATE_IP_401_MINT = "203.0.113.173";

/**
 * Call the Worker. Adds `Authorization: Bearer <token>` unless `token` is null
 * (used to assert the public/unauthenticated behaviour of the gate).
 */
async function call(
  path: string,
  init: RequestInit = {},
  token: string | null = API_TOKEN
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return exports.default.fetch(`http://test.local${path}`, { ...init, headers });
}

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

const ORIGIN = "https://killeen.routeware.com";
const LOGIN_URL = `${ORIGIN}/WebRW/Account/Login`;
const UPSTREAM = `${ORIGIN}/WebRW/Home/Index`;

function baseEnv(extra: Record<string, unknown> = {}): Env {
  return {
    AUTH_MODE: "auto",
    LOGIN_URL,
    TARGET_ORIGIN: ORIGIN,
    TARGET_BASE_PATH: "/WebRW",
    SESSION_TTL_SECONDS: 1800,
    LOGIN_USERNAME: "operator",
    LOGIN_PASSWORD: "FAKE-PASSWORD-STAND-IN",
    SHADOW_API_TOKEN: "test-api-token",
    ...extra
  } as unknown as Env;
}

/**
 * Synthetic env driving the full route → forward → reactive re-login →
 * onError path with a stubbed upstream (mirrors the blocked-login fixture in
 * `test/loginPageUnavailable.test.ts`).
 */
function blockedAppEnv(fetchImpl: typeof fetch): Env {
  const state = { refreshing: false, lockToken: null as string | null };
  const stub = {
    fetch: async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      const path = new URL(typeof input === "string" ? input : String(input))
        .pathname;
      if (path === "/lock" || path === "/takeover") {
        state.refreshing = true;
        state.lockToken = "synthetic-lock-token";
        return Response.json({ lockToken: state.lockToken });
      }
      if (path === "/unlock") {
        if (state.refreshing === true) {
          const body = JSON.parse(
            String((init as RequestInit | undefined)?.body ?? "{}")
          ) as { lockToken?: unknown };
          if (body.lockToken !== state.lockToken) {
            return new Response("Forbidden", { status: 403 });
          }
        }
        state.refreshing = false;
        state.lockToken = null;
        return new Response("OK");
      }
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
  const env = baseEnv({ AUTH_SESSION });
  globalThis.fetch = fetchImpl;
  return env;
}

describe("X-Request-Id propagation acceptance (TOG-37150)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // No upstream fetch expected: success/gate/404/preflight/500 cases below
    // are all local (the 502 trigger overrides this with a stubbed upstream).
    // Fail loudly if anything tries to leave the Worker instead.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in request-ID test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("echoes a valid inbound ID byte-identical on success and exposes the header", async () => {
    const requestId = "Trace-MiXeD_123-ABC";
    const response = await call(
      "/api/v1/health",
      { headers: { "X-Request-Id": requestId } },
      null
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toBe(requestId);
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain(
      "X-Request-Id"
    );
  });

  it("mints a UUID-format ID on success when none is supplied", async () => {
    const response = await call("/api/v1/health", {}, null);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toMatch(UUID_RE);
  });

  it("mints instead of failing when the inbound ID is overlong", async () => {
    const response = await call(
      "/api/v1/health",
      { headers: { "X-Request-Id": OVERLONG_ID } },
      null
    );
    expect(response.status).toBe(200);
    const echoed = response.headers.get("X-Request-Id");
    expect(echoed).toMatch(UUID_RE);
    expect(echoed).not.toBe(OVERLONG_ID);
  });

  it("mints instead of failing when the inbound ID has non-token chars", async () => {
    const response = await call(
      "/api/v1/health",
      { headers: { "X-Request-Id": NONTOKEN_ID } },
      null
    );
    expect(response.status).toBe(200);
    const echoed = response.headers.get("X-Request-Id");
    expect(echoed).toMatch(UUID_RE);
    expect(echoed).not.toBe(NONTOKEN_ID);
  });

  it("echoes the inbound ID on the 401 gate response and its problem body", async () => {
    const requestId = "trace-401-gate";
    const response = await call(
      "/api/v1/routeware/home/index",
      {
        headers: {
          "X-Request-Id": requestId,
          "CF-Connecting-IP": GATE_IP_401_ECHO
        }
      },
      null
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("problem+json");
    expect(response.headers.get("X-Request-Id")).toBe(requestId);
    expect(await response.json()).toMatchObject({ requestId });
  });

  it("mints a correlated ID on the 401 gate response when none is supplied", async () => {
    const response = await call(
      "/api/v1/routeware/home/index",
      { headers: { "CF-Connecting-IP": GATE_IP_401_MINT } },
      null
    );
    expect(response.status).toBe(401);
    const echoed = response.headers.get("X-Request-Id");
    expect(echoed).toMatch(UUID_RE);
    expect(await response.json()).toMatchObject({ requestId: echoed });
  });

  it("echoes the inbound ID on the 429 throttle response and keeps the backoff headers", async () => {
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) {
      const burn = await call(
        "/api/v1/routeware/home/index",
        { headers: { "CF-Connecting-IP": THROTTLE_IP_429 } },
        "gate-guess-wrong"
      );
      expect([401, 429]).toContain(burn.status);
    }
    const requestId = "trace-429-gate";
    const throttled = await call(
      "/api/v1/routeware/home/index",
      {
        headers: {
          "X-Request-Id": requestId,
          "CF-Connecting-IP": THROTTLE_IP_429
        }
      },
      "gate-guess-wrong"
    );
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("content-type")).toContain("problem+json");
    expect(throttled.headers.get("X-Request-Id")).toBe(requestId);
    expect(throttled.headers.get("Retry-After")).toBeTruthy();
    expect(await throttled.json()).toMatchObject({ requestId });
  });

  it("echoes the inbound ID on the 404 problem body", async () => {
    const requestId = "trace-404-check";
    const response = await call("/api/v1/does-not-exist", {
      headers: { "X-Request-Id": requestId }
    });
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("problem+json");
    expect(response.headers.get("X-Request-Id")).toBe(requestId);
    expect(await response.json()).toMatchObject({ requestId });
  });

  it("echoes the ID on the onError 502 (blocked login page) with body + log correlation", async () => {
    const info = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The forward hits a login redirect (drives the reactive re-login),
      // then the login-page GET 403s — the app's onError answers 502.
      // Anything else is an unexpected upstream call: fail loudly, never
      // reach the network.
      const fetchImpl = (async (url: unknown) => {
        const s = String(url);
        if (s === LOGIN_URL) {
          return new Response("WAF block stand-in", { status: 403 });
        }
        if (s === UPSTREAM) {
          return new Response(null, {
            status: 302,
            headers: { location: LOGIN_URL }
          });
        }
        throw new Error(`unexpected upstream URL: ${s}`);
      }) as unknown as typeof fetch;
      const env = blockedAppEnv(fetchImpl);
      const requestId = "trace-502-onerror";
      const res = await app.fetch(
        new Request("http://test.local/api/v1/routeware/home/index", {
          headers: {
            authorization: `Bearer ${API_TOKEN}`,
            Origin: FOREIGN_ORIGIN,
            "X-Request-Id": requestId
          }
        }),
        env,
        ctx
      );
      expect(res.status).toBe(502);
      expect(res.headers.get("content-type")).toContain("problem+json");
      expect(res.headers.get("X-Request-Id")).toBe(requestId);
      const body = (await res.json()) as {
        title?: string;
        requestId?: string;
      };
      expect(body.title).toBe("Upstream login unavailable");
      expect(body.requestId).toBe(requestId);
      const event = info.mock.calls
        .map(([e]) => e as { msg?: string; requestId?: string })
        .find((e) => e.msg === "Routeware login page unavailable");
      expect(event).toMatchObject({ requestId });
    } finally {
      info.mockRestore();
    }
  });

  it("echoes the ID on the onError 500 (missing binding) with body + log correlation", async () => {
    const info = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Missing AUTH_SESSION binding: the gate's throttle-clear throws, the
      // app's onError answers 500 (mirrors the posture suite's 5xx trigger).
      const brokenEnv = {
        OPENAPI_DOCS_ENABLED: "true",
        SHADOW_API_TOKEN: "tok",
        CUSTOMER_SNAPSHOT_SYNC_SECRET: "sec"
      } as unknown as Env;
      const requestId = "trace-500-onerror";
      const res = await app.fetch(
        new Request("http://test.local/api/v1/customer-snapshot", {
          headers: {
            authorization: "Bearer sec",
            Origin: FOREIGN_ORIGIN,
            "X-Request-Id": requestId
          }
        }),
        brokenEnv,
        ctx
      );
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toContain("problem+json");
      expect(res.headers.get("X-Request-Id")).toBe(requestId);
      const body = (await res.json()) as {
        title?: string;
        requestId?: string;
      };
      expect(body.title).toBe("Internal Server Error");
      expect(body.requestId).toBe(requestId);
      const event = info.mock.calls
        .map(([e]) => e as { msg?: string; requestId?: string })
        .find((e) => e.msg === "Unhandled request error");
      expect(event).toMatchObject({ requestId });
    } finally {
      info.mockRestore();
    }
  });

  it("allows X-Request-Id on preflight and stamps the header for browser clients", async () => {
    const response = await call(
      "/api/v1/health",
      {
        method: "OPTIONS",
        headers: {
          Origin: FOREIGN_ORIGIN,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "X-Request-Id"
        }
      },
      null
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Headers")).toMatch(
      /x-request-id/i
    );
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain(
      "X-Request-Id"
    );
    expect(response.headers.get("X-Request-Id")).toMatch(UUID_RE);
  });
});
