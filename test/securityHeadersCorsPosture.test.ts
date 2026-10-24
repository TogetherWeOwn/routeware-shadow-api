import { exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { AUTH_THROTTLE_MAX_FAILURES } from "../src/lib/authThrottle";
import { InvalidAuthModeError } from "../src/lib/establishSession";
import { LoginPageUnavailableError } from "../src/lib/loginPageError";
import { MissingSetCookieCapabilityError } from "../src/lib/setCookieCapabilityError";
import { UpstreamTimeoutError } from "../src/lib/upstreamTimeout";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * R9-08 acceptance: security-header and CORS posture on API routes.
 *
 * Pins the recorded posture in `docs/cors-security-headers-audit.md` (last
 * full audit 2026-09-28) plus `Cache-Control: no-store` on authenticated
 * responses (PR #249), covering the current route set. The paired Builder
 * card runs the delta audit and fixes gaps; it must never edit this file.
 *
 * Route-level tests via the app's fetch surface with synthetic requests; no
 * network (upstream fetch is stubbed to throw), no real credentials (test
 * bindings only). `exports.default.fetch` exercises the workerd path with
 * `[env.test.vars]`; `app.fetch` with a synthetic env covers the 5xx paths
 * that need controlled missing bindings.
 *
 * If you add a route and this file fails: that is the point. Verify the new
 * route carries the posture below (it does automatically when it flows
 * through the `/api/v1/*` middleware / `withCors`), then update the pinned
 * route count.
 */

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";
const SYNC_SECRET = "test-sync-secret";
const FOREIGN_ORIGIN = "https://app.example.com";
// Distinct TEST-NET-3 IP so the throttle bucket never collides with other suites.
const THROTTLE_IP = "203.0.113.234";

const CUSTOMER_HEADER =
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix," +
  "CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled";
const CUSTOMER_ROW = "77001,,Cache Co,,,,,,,,,,true";

// Every registered /api/v1 method+path pair; the bearer gate rejects before
// routing, so any concrete params work for the 401 sweep.
function apiRoutes(): Array<{ method: string; path: string }> {
  const seen = new Set<string>();
  const routes: Array<{ method: string; path: string }> = [];
  for (const r of app.routes) {
    if (r.method === "ALL" || !r.path.startsWith("/api/v1/")) {
      continue;
    }
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    routes.push({ method: r.method, path: r.path.replace(/:[^/]+/g, "sample") });
  }
  return routes;
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(`http://test.local${path}`, init);
}

function authed(path: string, init: RequestInit = {}, token = SYNC_SECRET): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return call(path, { ...init, headers });
}

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

/** Hardening trio every API, spec and docs response must carry. */
function expectHardened(res: Response): void {
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
}

/** CORS grant every /api/v1/* response must carry when called from a browser. */
function expectCorsGrant(res: Response, origin = FOREIGN_ORIGIN): void {
  expect(res.headers.get("access-control-allow-origin")).toBe(origin);
  expect(res.headers.get("vary")).toMatch(/origin/i);
  expect(res.headers.get("access-control-allow-credentials")).toBeNull();
}

/**
 * Exposed headers: the audit trio (conditional reads, throttle backoff,
 * CSV-download filename) plus the rate-limit trio that landed with the
 * throttle 429 headers (the delta since the 09-28 audit) plus the request
 * correlation id.
 */
function expectExposedHeaders(res: Response): void {
  const tokens = new Set(
    (res.headers.get("access-control-expose-headers") ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0)
  );
  for (const h of [
    "etag",
    "retry-after",
    "content-disposition",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-request-id"
  ]) {
    expect(tokens.has(h)).toBe(true);
  }
}

describe("security-header + CORS posture acceptance (R9-08)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // No upstream fetch expected: the gate rejects unauthenticated calls
    // before routing, and the authenticated cases below hit local handlers
    // (health, snapshots, data-entity, import validation, docs). Fail loudly
    // if anything tries to leave the Worker instead.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in posture test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  beforeAll(async () => {
    await ensureD1TestTables();
    const seed = await call("/api/v1/customer-snapshot/import", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SYNC_SECRET}`,
        "content-type": "text/csv"
      },
      body: `${CUSTOMER_HEADER}\n${CUSTOMER_ROW}\n`
    });
    expect(seed.status).toBe(200);
  });

  it("pins the swept route set so a new route without coverage fails", () => {
    const routes = apiRoutes();
    // 42 prior + GET /api/v1/snapshots/:table/latest (R2 latest-pointer readback).
    expect(routes).toHaveLength(43);
    for (const { path } of routes) {
      expect(path).not.toMatch(/[:{}]/);
    }
  });

  describe.each(apiRoutes().map((r, i) => ({ ...r, index: i })))(
    "gate $method $path",
    ({ method, path, index }) => {
      it("rejects without a token with 401 posture (or 200 for public health)", async () => {
        // Distinct TEST-NET-2 IP per route: 42 gate failures from one IP would
        // trip the brute-force throttle and turn later 401s into 429s.
        const ip = `198.51.100.${(index % 250) + 1}`;
        const res = await call(path, {
          method,
          headers: { Origin: FOREIGN_ORIGIN, "CF-Connecting-IP": ip }
        });
        const isPublicHealth = method === "GET" && path === "/api/v1/health";
        expect(res.status).toBe(isPublicHealth ? 200 : 401);
        expect(res.headers.get("cache-control")).toBe("no-store");
        expectHardened(res);
        expectCorsGrant(res);
        expectExposedHeaders(res);
      });
    }
  );

  it("sends no-store + hardening on authenticated snapshot list 200", async () => {
    const res = await authed("/api/v1/customer-snapshot", {
      headers: { Origin: FOREIGN_ORIGIN }
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expectHardened(res);
    expectCorsGrant(res);
    expectExposedHeaders(res);
  });

  it("sends no-store + hardening on CSV export 200 and 304", async () => {
    const first = await authed("/api/v1/customer-snapshot/export", {
      headers: { Origin: FOREIGN_ORIGIN }
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expectHardened(first);
    expectCorsGrant(first);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    await first.text();

    const notModified = await authed("/api/v1/customer-snapshot/export", {
      headers: { "if-none-match": etag as string, Origin: FOREIGN_ORIGIN }
    });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    expect(notModified.headers.get("cache-control")).toBe("no-store");
    expectHardened(notModified);
    expectCorsGrant(notModified);
  });

  it("preserves private, max-age=60 + hardening on data-entity 200 and 304", async () => {
    const first = await authed("/api/v1/data/customer?id=77001", {
      headers: { Origin: FOREIGN_ORIGIN }
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, max-age=60");
    expectHardened(first);
    expectCorsGrant(first);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    await first.text();

    const notModified = await authed("/api/v1/data/customer?id=77001", {
      headers: { "if-none-match": etag as string, Origin: FOREIGN_ORIGIN }
    });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("cache-control")).toBe("private, max-age=60");
    expectHardened(notModified);
  });

  it("sends no-store + hardening on shadow health and readiness 200s", async () => {
    for (const path of ["/api/v1/shadow/health", "/api/v1/readiness"]) {
      const res = await authed(path, {
        headers: { Origin: FOREIGN_ORIGIN }
      }, API_TOKEN);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expectHardened(res);
      expectCorsGrant(res);
      expectExposedHeaders(res);
    }
  });

  it("sends no-store + hardening + backoff headers on the 429 throttle response", async () => {
    for (let i = 0; i < AUTH_THROTTLE_MAX_FAILURES; i++) {
      await call("/api/v1/routeware/home/index", {
        headers: {
          authorization: "Bearer guess-wrong",
          "CF-Connecting-IP": THROTTLE_IP
        }
      });
    }
    const throttled = await call("/api/v1/routeware/home/index", {
      headers: {
        authorization: "Bearer guess-wrong",
        "CF-Connecting-IP": THROTTLE_IP,
        Origin: FOREIGN_ORIGIN
      }
    });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("cache-control")).toBe("no-store");
    expectHardened(throttled);
    expectCorsGrant(throttled);
    expectExposedHeaders(throttled);
    expect(throttled.headers.get("retry-after")).toBeTruthy();
  });

  it("sends no-store + hardening on 404s (unknown route and missing archive)", async () => {
    const unknown = await authed("/api/v1/does-not-exist", {
      headers: { Origin: FOREIGN_ORIGIN }
    }, API_TOKEN);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("cache-control")).toBe("no-store");
    expectHardened(unknown);
    expectCorsGrant(unknown);

    const archive = await authed("/api/v1/snapshots/customer/2099-01-01", {
      headers: { Origin: FOREIGN_ORIGIN }
    });
    expect(archive.status).toBe(404);
    expect(archive.headers.get("cache-control")).toBe("no-store");
    expectHardened(archive);
  });

  it("sends no-store + hardening on 400/405/415 validation responses", async () => {
    const badHeader = await authed("/api/v1/customer-snapshot/import", {
      method: "POST",
      headers: { "content-type": "text/csv", Origin: FOREIGN_ORIGIN },
      body: "BadHeader1,BadHeader2\n1,2\n"
    });
    expect(badHeader.status).toBe(400);
    expect(badHeader.headers.get("cache-control")).toBe("no-store");
    expectHardened(badHeader);

    const wrongType = await authed("/api/v1/customer-snapshot/import", {
      method: "POST",
      headers: { "content-type": "application/json", Origin: FOREIGN_ORIGIN },
      body: "{}"
    });
    expect(wrongType.status).toBe(415);
    expect(wrongType.headers.get("cache-control")).toBe("no-store");
    expectHardened(wrongType);

    const noDelete = await authed("/api/v1/routeware/customer", {
      method: "DELETE",
      headers: { Origin: FOREIGN_ORIGIN }
    }, API_TOKEN);
    expect(noDelete.status).toBe(405);
    expect(noDelete.headers.get("cache-control")).toBe("no-store");
    expectHardened(noDelete);
  });

  it("sends no-store + hardening on 5xx via synthetic env (500 and 503)", async () => {
    // Missing AUTH_SESSION binding: the gate's throttle-clear throws, the
    // app's onError answers 500. Must still carry the posture, not a bare
    // 500, so browsers surface the real status instead of a CORS error.
    const brokenEnv = {
      OPENAPI_DOCS_ENABLED: "true",
      SHADOW_API_TOKEN: "tok",
      CUSTOMER_SNAPSHOT_SYNC_SECRET: "sec"
    } as unknown as Env;
    const fiveHundred = await app.fetch(
      new Request("http://test.local/api/v1/customer-snapshot", {
        headers: { authorization: "Bearer sec", Origin: FOREIGN_ORIGIN }
      }),
      brokenEnv,
      ctx
    );
    expect(fiveHundred.status).toBe(500);
    expect(fiveHundred.headers.get("cache-control")).toBe("no-store");
    expectHardened(fiveHundred);
    expectCorsGrant(fiveHundred);

    // Missing D1 binding: readiness reports 503 with per-dependency status.
    const noDbEnv = {
      ...brokenEnv,
      AUTH_SESSION: {
        idFromName: () => "x",
        get: () => ({ fetch: async () => new Response("{}") })
      }
    } as unknown as Env;
    const fiveOhThree = await app.fetch(
      new Request("http://test.local/api/v1/readiness", {
        headers: { authorization: "Bearer tok", Origin: FOREIGN_ORIGIN }
      }),
      noDbEnv,
      ctx
    );
    expect(fiveOhThree.status).toBe(503);
    expect(fiveOhThree.headers.get("cache-control")).toBe("no-store");
    expectHardened(fiveOhThree);
  });

  it("answers preflight 204 before the bearer gate with the method allowlist", async () => {
    for (const path of [
      "/api/v1/health",
      "/api/v1/customer-snapshot",
      "/api/v1/data/customer",
      "/api/v1/shadow/health"
    ]) {
      const res = await call(path, {
        method: "OPTIONS",
        headers: {
          Origin: FOREIGN_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization, content-type"
        }
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("access-control-allow-origin")).toBe(FOREIGN_ORIGIN);
      expect(res.headers.get("access-control-allow-methods")).toBe(
        "GET, POST, DELETE, OPTIONS"
      );
      expect(res.headers.get("access-control-max-age")).toBe("86400");
      // Preflight carries no body or data: CORS grant only, never cached.
      expect(res.headers.get("cache-control")).toBeNull();
      expectHardened(res);
      expectExposedHeaders(res);
    }
  });

  it("pins the preflight header allowlist (permit, strip, fall back)", async () => {
    const allowlisted = await call("/api/v1/data/customer", {
      method: "OPTIONS",
      headers: {
        Origin: FOREIGN_ORIGIN,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization, if-none-match"
      }
    });
    expect(allowlisted.status).toBe(204);
    expect(allowlisted.headers.get("access-control-allow-headers")).toMatch(
      /if-none-match/i
    );

    const stripped = await call("/api/v1/customer-snapshot", {
      method: "OPTIONS",
      headers: {
        Origin: FOREIGN_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization, x-custom-evil"
      }
    });
    expect(stripped.status).toBe(204);
    expect(
      (stripped.headers.get("access-control-allow-headers") ?? "").toLowerCase()
    ).not.toContain("x-custom-evil");

    const fallback = await call("/api/v1/customer-snapshot", {
      method: "OPTIONS",
      headers: {
        Origin: FOREIGN_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-only-junk"
      }
    });
    expect(fallback.status).toBe(204);
    expect(fallback.headers.get("access-control-allow-headers")).toBe(
      "Authorization, Content-Type, X-Request-Id"
    );
  });

  it("stamps hardening without CORS or cache policy on /openapi.json and /docs", async () => {
    for (const value of ["true", "false"]) {
      const env = { OPENAPI_DOCS_ENABLED: value } as unknown as Env;
      for (const path of ["/openapi.json", "/docs"]) {
        const res = await app.fetch(
          new Request(`http://test.local${path}`, {
            headers: { Origin: FOREIGN_ORIGIN }
          }),
          env,
          ctx
        );
        expectHardened(res);
        // Docs surfaces use withSecurityHeaders, never withCors: no ACAO even
        // when the request carries an Origin, and no Cache-Control.
        expect(res.headers.get("access-control-allow-origin")).toBeNull();
        expect(res.headers.get("cache-control")).toBeNull();
      }
    }
  });

  describe("onError branch withCors pins (direct errorHandler, no middleware)", () => {
    // The /api/v1/* middleware wraps every downstream response (including
    // onError results) with withCors, so app.fetch header asserts alone stay
    // green when an onError branch drops its own withCors. These direct
    // errorHandler probes isolate each named branch: removing its withCors
    // turns the matching test red. Each constructs the branch's exact error
    // type so the probe provably reaches the named if-branch.
    function mockContext(path: string): unknown {
      const url = `http://test.local${path}`;
      const raw = new Request(url, { headers: { Origin: FOREIGN_ORIGIN } });
      return {
        // No middleware ran in these direct probes: `get` yields no request
        // id, and `header` reads the raw inbound headers (no X-Request-Id
        // here, so onError mints).
        get: (_key: string) => undefined,
        req: {
          raw,
          url,
          method: "GET",
          header: (name: string) => raw.headers.get(name)
        },
        env: {}
      };
    }

    async function onErrorRes(err: unknown, path: string): Promise<Response> {
      const handler = (app as unknown as { errorHandler: (e: unknown, c: unknown) => Response | Promise<Response> }).errorHandler;
      return await handler(err, mockContext(path));
    }

    function expectOnErrorPosture(res: Response): void {
      expect(res.headers.get("cache-control")).toBe("no-store");
      expectHardened(res);
      expectCorsGrant(res);
      expectExposedHeaders(res);
    }

    it("missing getSetCookie 503 carries posture via its own withCors", async () => {
      const res = await onErrorRes(
        new MissingSetCookieCapabilityError(),
        "/api/v1/routeware/home/index"
      );
      expect(res.status).toBe(503);
      expectOnErrorPosture(res);
      const body = (await res.json()) as { type: string; title: string; status: number; detail?: string };
      expect(body.type).toContain("misconfigured");
      expect(body.title).toBe("Service Unavailable");
      expect(body.status).toBe(503);
      expect(body.detail).toContain("getSetCookie");
    });

    it("invalid AUTH_MODE 503 carries posture via its own withCors", async () => {
      const res = await onErrorRes(
        new InvalidAuthModeError("browserr"),
        "/api/v1/routeware/home/index"
      );
      expect(res.status).toBe(503);
      expectOnErrorPosture(res);
      const body = (await res.json()) as { type: string; title: string; status: number; detail?: string };
      expect(body.type).toContain("misconfigured");
      expect(body.title).toBe("Service Unavailable");
      expect(body.status).toBe(503);
      expect(body.detail).toContain("browserr");
    });

    it("upstream timeout 502 carries posture via its own withCors", async () => {
      const res = await onErrorRes(
        new UpstreamTimeoutError(50),
        "/api/v1/routeware/account/login-page"
      );
      expect(res.status).toBe(502);
      expectOnErrorPosture(res);
      const body = (await res.json()) as { type: string; title: string; status: number; detail?: string };
      expect(body.type).toContain("bad-gateway");
      expect(body.title).toBe("Upstream timed out");
      expect(body.status).toBe(502);
      expect(body.detail).toContain("50ms");
    });

    it("login-page 502 carries posture via its own withCors", async () => {
      const res = await onErrorRes(
        new LoginPageUnavailableError(403, "login page"),
        "/api/v1/routeware/home/index"
      );
      expect(res.status).toBe(502);
      expectOnErrorPosture(res);
      const body = (await res.json()) as { type: string; title: string; status: number; detail?: string };
      expect(body.type).toContain("bad-gateway");
      expect(body.title).toBe("Upstream login unavailable");
      expect(body.status).toBe(502);
      expect(body.detail).toContain("403");
    });
  });
});
