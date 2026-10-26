import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { AUTH_THROTTLE_MAX_FAILURES } from "../src/lib/authThrottle";
import { InvalidAuthModeError } from "../src/lib/establishSession";
import { LoginPageUnavailableError } from "../src/lib/loginPageError";
import { InvalidReportQueryDatesError } from "../src/lib/reportQueryDates";
import { ConcurrentRefreshTimeoutError } from "../src/lib/sessionRefreshLock";
import { MissingSetCookieCapabilityError } from "../src/lib/setCookieCapabilityError";
import { UpstreamTimeoutError } from "../src/lib/upstreamTimeout";

/**
 * X-Request-Id propagation acceptance, including PR #338 regression guards.
 *
 * Behaviour forward-ported from the unmerged R3-23 slice `8a6816f8`:
 * adopt a valid inbound `X-Request-Id`, mint a UUID when it is absent or
 * invalid (overlong / non-token chars), echo it on every response, carry it
 * as `requestId` in problem bodies and `app.onError` log events, and
 * allow/expose the header for browser clients.
 *
 * Guard authenticated success separately from public success, mixed CORS
 * grants without the empty-intersection fallback, every error mapping with a
 * minted ID, and the inclusive 128-character inbound boundary. Only test
 * authors edit this acceptance suite; implementation changes must satisfy it.
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
// Contractual boundaries are literal test cases below, independent of the
// implementation's cap: 1-128 RFC 7230 token chars are adopted byte-identical.
const OVERLONG_ID = "a".repeat(300);
const NONTOKEN_ID = "trace id/with.special:chars@x";
const MINTED_ID = "a1111111-1111-4111-8111-111111111111";
const REMINTED_ID = "b2222222-2222-4222-8222-222222222222";
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

const PROBLEM_TYPE_BASE =
  "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#";

const ERROR_BRANCHES = [
  {
    name: "invalid report dates",
    error: () => new InvalidReportQueryDatesError(),
    status: 503,
    kind: "misconfigured",
    title: "Service Unavailable",
    detail: "REPORT_QUERY dates must be real yyyy-MM-dd dates with start <= end. See docs/PROBLEMS.md#misconfigured."
  },
  {
    name: "upstream timeout",
    error: () => new UpstreamTimeoutError(50),
    status: 502,
    kind: "bad-gateway",
    title: "Upstream timed out",
    detail: expect.stringContaining("50ms")
  },
  {
    name: "concurrent refresh timeout",
    error: () => new ConcurrentRefreshTimeoutError(200),
    status: 502,
    kind: "bad-gateway",
    title: "Session refresh timed out",
    detail: expect.stringContaining("200ms")
  },
  {
    name: "invalid auth mode",
    error: () => new InvalidAuthModeError("browserr"),
    status: 503,
    kind: "misconfigured",
    title: "Service Unavailable",
    detail: expect.stringContaining("browserr")
  },
  {
    name: "missing set-cookie capability",
    error: () => new MissingSetCookieCapabilityError(),
    status: 503,
    kind: "misconfigured",
    title: "Service Unavailable",
    detail: expect.stringContaining("getSetCookie")
  },
  {
    name: "login-page unavailable",
    error: () => new LoginPageUnavailableError(403, "login page"),
    status: 502,
    kind: "bad-gateway",
    title: "Upstream login unavailable",
    detail: expect.stringContaining("403")
  },
  {
    name: "generic Error",
    error: () => new Error("Synthetic downstream failure"),
    status: 500,
    kind: "internal",
    title: "Internal Server Error",
    detail: expect.any(String)
  }
];

const MINTING_INPUTS = [
  { name: "missing", inbound: undefined },
  { name: "invalid", inbound: NONTOKEN_ID }
];

describe("X-Request-Id propagation acceptance", () => {
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

  it.each([
    { name: "supplied", inbound: "Authenticated-MiXeD_123" },
    { name: "missing", inbound: undefined }
  ])("correlates authenticated success with a $name ID without changing its body", async ({ inbound }) => {
    // Unlike public health, this succeeds through the authenticated middleware
    // tail. Removing that stamp must not be hidden by notFound or onError.
    const response = await call("/api/v1/shadow/health", {
      headers: inbound === undefined ? {} : { "X-Request-Id": inbound }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      status: "ok",
      service: "routeware-shadow-api",
      version: "v1"
    });
    const echoed = response.headers.get("X-Request-Id");
    if (inbound === undefined) {
      expect(echoed).toMatch(UUID_RE);
    } else {
      expect(echoed).toBe(inbound);
    }
  });

  // A cap raised to 255 must fail at 129; an exclusive comparison must fail
  // at 128. Expectations use the contract, not the implementation constant.
  it.each([
    { length: 0, adopted: false },
    { length: 1, adopted: true },
    { length: 127, adopted: true },
    { length: 128, adopted: true },
    { length: 129, adopted: false }
  ])("pins adoption at length $length (adopted=$adopted)", async ({ length, adopted }) => {
    const inbound = "a".repeat(length);
    const response = await call(
      "/api/v1/health",
      { headers: { "X-Request-Id": inbound } },
      null
    );
    expect(response.status).toBe(200);
    const echoed = response.headers.get("X-Request-Id");
    if (adopted) {
      expect(echoed).toBe(inbound);
    } else {
      expect(echoed).toMatch(UUID_RE);
      expect(echoed).not.toBe(inbound);
    }
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

  describe.each(ERROR_BRANCHES)("onError $name", (branch) => {
    it.each(MINTING_INPUTS)("preserves the context-minted ID with $name inbound ID", async ({ inbound }) => {
      // Invoke the actual registered handler, not a replacement onError or a
      // problem helper. The context models the UUID already minted by request
      // middleware. Re-resolving either inbound input would mint REMINTED_ID.
      const raw = new Request("http://test.local/api/v1/routeware/home/index", {
        headers: {
          Origin: FOREIGN_ORIGIN,
          ...(inbound === undefined ? {} : { "X-Request-Id": inbound })
        }
      });
      const context = {
        get: (key: string) => key === "requestId" ? MINTED_ID : undefined,
        req: {
          raw,
          url: raw.url,
          method: raw.method,
          header: (name: string) => raw.headers.get(name)
        },
        env: {}
      };
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue(REMINTED_ID);
      try {
        const handler = (app as unknown as {
          errorHandler: (error: Error, context: unknown) => Response | Promise<Response>
        }).errorHandler;
        const response = await handler(branch.error(), context);
        expect(response.status).toBe(branch.status);
        expect(response.headers.get("content-type")).toContain("problem+json");
        expect(response.headers.get("X-Request-Id")).toBe(MINTED_ID);
        expect(await response.json()).toMatchObject({
          status: branch.status,
          type: `${PROBLEM_TYPE_BASE}${branch.kind}`,
          title: branch.title,
          detail: branch.detail,
          requestId: MINTED_ID
        });
        const events = log.mock.calls.map(([event]) => event);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ requestId: MINTED_ID });
      } finally {
        uuid.mockRestore();
        log.mockRestore();
      }
    });
  });

  it.each(MINTING_INPUTS)("keeps the middleware-minted ID through a full downstream error with $name inbound ID", async ({ inbound }) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const uuid = vi.spyOn(crypto, "randomUUID")
      .mockReturnValue(REMINTED_ID)
      .mockReturnValueOnce(MINTED_ID);
    try {
      // Real middleware -> route -> forwarding -> re-login -> onError. Only
      // the upstream and session binding are faked, and no network is allowed.
      const env = blockedAppEnv((async (input: unknown) => {
        const url = String(input);
        if (url === UPSTREAM) {
          return new Response(null, { status: 302, headers: { location: LOGIN_URL } });
        }
        if (url === LOGIN_URL) {
          return new Response("WAF block stand-in", { status: 403 });
        }
        throw new Error(`Unexpected upstream URL: ${url}`);
      }) as typeof fetch);
      const response = await app.fetch(new Request(
        "http://test.local/api/v1/routeware/home/index",
        {
          headers: {
            authorization: `Bearer ${API_TOKEN}`,
            Origin: FOREIGN_ORIGIN,
            ...(inbound === undefined ? {} : { "X-Request-Id": inbound })
          }
        }
      ), env, ctx);
      expect(response.status).toBe(502);
      expect(response.headers.get("X-Request-Id")).toBe(MINTED_ID);
      expect(await response.json()).toMatchObject({
        status: 502,
        type: `${PROBLEM_TYPE_BASE}bad-gateway`,
        title: "Upstream login unavailable",
        detail: expect.stringContaining("403"),
        requestId: MINTED_ID
      });
      const events = log.mock.calls.map(([event]) => event as { msg?: string });
      expect(events.filter((event) => event.msg === "Routeware login page unavailable"))
        .toEqual([expect.objectContaining({ requestId: MINTED_ID })]);
    } finally {
      uuid.mockRestore();
      log.mockRestore();
    }
  });

  it("grants exactly authorization and request ID on a mixed-header preflight", async () => {
    // A request-ID-only preflight can be masked by DEFAULT_ALLOW_HEADERS when
    // the allowlist intersection is empty. Authorization keeps it non-empty.
    const response = await call(
      "/api/v1/shadow/health",
      {
        method: "OPTIONS",
        headers: {
          Origin: FOREIGN_ORIGIN,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization, X-Request-Id, x-disallowed"
        }
      },
      null
    );
    expect(response.status).toBe(204);
    const granted = response.headers.get("Access-Control-Allow-Headers");
    expect(granted).not.toBeNull();
    expect(granted!.split(",").map((token) => token.trim().toLowerCase()).sort())
      .toEqual(["authorization", "x-request-id"]);
    expect(response.headers.get("X-Request-Id")).toMatch(UUID_RE);
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
