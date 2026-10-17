import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { isReadAuthorized, readAccessToken } from "../src/lib/auth";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";

/**
 * Read-only bearer role.
 *
 * `SHADOW_API_READ_TOKEN`, when set, grants GET-only access to non-privileged
 * reads: the outer gate (`src/app.ts`) accepts it on GET requests. Everything
 * else 401s — non-GET requests fail at the outer gate, and privileged routes
 * (sync/import, GET exports, `/api/v1/data/*` reads) reject it at the inner
 * `requireSnapshotAuth` check, which accepts only the sync secret. Unset or
 * blank means unconfigured: the role fails closed.
 *
 * What this pins (mirrors the card acceptance):
 * 1. Unit: `readAccessToken`/`isReadAuthorized` — GET-only, fail-closed.
 * 2. HTTP: a GET with the read token returns 200 on a general route.
 * 3. HTTP: a POST with the read token returns 401 (outer gate).
 * 4. HTTP: no privileged route accepts the read token — GET privileged
 *    routes 401 with the inner detail, non-GET privileged routes 401 with
 *    the outer detail.
 * 5. HTTP (synthetic env without the read token): the role fails closed.
 */

// Matches wrangler.toml [env.test.vars].
const READ_TOKEN = "test-read-token";
const API_TOKEN = "test-api-token";
const SYNC_SECRET = "test-sync-secret";

const UNAUTHORIZED_TYPE = `${PROBLEM_TYPE_BASE}unauthorized`;
const OUTER_DETAIL =
  "Send Authorization: Bearer <SHADOW_API_TOKEN>. See docs/PROBLEMS.md#unauthorized.";
const INNER_DETAIL =
  "Send Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>. See docs/PROBLEMS.md#unauthorized.";

type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
};

function reqWith(auth?: string): { header: (n: string) => string | undefined } {
  return {
    header: (n: string) => (n.toLowerCase() === "authorization" ? auth : undefined)
  };
}

function envWithReadToken(readToken: unknown): Env {
  return {
    SHADOW_API_TOKEN: API_TOKEN,
    CUSTOMER_SNAPSHOT_SYNC_SECRET: SYNC_SECRET,
    SHADOW_API_READ_TOKEN: readToken
  } as unknown as Env;
}

describe("read-only role units", () => {
  it("readAccessToken returns the configured token, trimmed", () => {
    expect(readAccessToken(envWithReadToken("  read-xyz  "))).toBe("read-xyz");
  });

  it("readAccessToken is undefined when unset or blank (fail closed)", () => {
    expect(readAccessToken(envWithReadToken(undefined))).toBeUndefined();
    expect(readAccessToken(envWithReadToken(""))).toBeUndefined();
    expect(readAccessToken(envWithReadToken("   "))).toBeUndefined();
  });

  it("authorizes the read token on GET", () => {
    expect(
      isReadAuthorized(envWithReadToken(READ_TOKEN), reqWith(`Bearer ${READ_TOKEN}`), "GET")
    ).toBe(true);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])(
    "never authorizes the read token on %s",
    (method) => {
      expect(
        isReadAuthorized(envWithReadToken(READ_TOKEN), reqWith(`Bearer ${READ_TOKEN}`), method)
      ).toBe(false);
    }
  );

  it("rejects wrong, missing, and full-privilege bearers (read check is read-token-only)", () => {
    const env = envWithReadToken(READ_TOKEN);
    expect(isReadAuthorized(env, reqWith("Bearer nope"), "GET")).toBe(false);
    expect(isReadAuthorized(env, reqWith(undefined), "GET")).toBe(false);
    expect(isReadAuthorized(env, reqWith(`Bearer ${API_TOKEN}`), "GET")).toBe(false);
    expect(isReadAuthorized(env, reqWith(`Bearer ${SYNC_SECRET}`), "GET")).toBe(false);
  });

  it("rejects the read-token string when no read token is configured", () => {
    const env = envWithReadToken(undefined);
    expect(isReadAuthorized(env, reqWith(`Bearer ${READ_TOKEN}`), "GET")).toBe(false);
  });
});

// Distinct TEST-NET-1 IPs per HTTP case so per-IP throttle buckets never leak
// state between cells (or into authThrottle/authGateSweep/throttleBurst).
const IP_BASE = "203.0.113.40";
let ipSeq = 1;
function freshIp(): string {
  return `${IP_BASE}${ipSeq++}`;
}

async function call(method: string, path: string, token: string | null): Promise<Response> {
  const headers = new Headers();
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  headers.set("CF-Connecting-IP", freshIp());
  return exports.default.fetch(`http://test.local${path}`, { method, headers });
}

// General route needing no upstream or D1: proves outer-gate passage with a 200.
const GENERAL_GET = "/api/v1/shadow/health";
// Non-GET general route: the read token must fail at the outer gate before any
// upstream call, so no stub body is needed beyond the hermetic throw below.
const GENERAL_POST = "/api/v1/routeware/customer/customers-read";

/**
 * One privileged route per class: the read token must 401 on every one.
 * GET entries expect the inner detail (outer gate passed, inner check
 * rejected); non-GET entries expect the outer detail (never reached the
 * handler).
 *
 * Deliberately main-compatible: every path here exists on `origin/main`.
 * The `DELETE /api/v1/customer-snapshot/{customerId}` erasure route
 * (sibling work not yet on `main`) is NOT probed here — its
 * registration + API-token rejection are pinned by `test/snapshotAuth.test.ts`,
 * and a non-GET read-token rejection follows the same outer-gate path pinned
 * by the POST cases below. A follow-up may add a read-token case for it.
 */
const PRIVILEGED_ROUTES: Array<{ method: string; path: string; inner: boolean }> = [
  { method: "POST", path: "/api/v1/customer-snapshot/sync", inner: false },
  { method: "POST", path: "/api/v1/customer-snapshot/import", inner: false },
  { method: "GET", path: "/api/v1/customer-snapshot/export", inner: true },
  { method: "POST", path: "/api/v1/data-snapshot/sync", inner: false },
  { method: "GET", path: "/api/v1/data/customer?id=1", inner: true },
  { method: "GET", path: "/api/v1/data/address?id=1", inner: true },
  { method: "GET", path: "/api/v1/data/container?id=1", inner: true },
  { method: "POST", path: "/api/v1/data/customer", inner: false }
];

describe("read-only role HTTP (test env)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // No request below may reach upstream: 200s answer directly, 401s stop at
    // the gates. A throw turns any future gate leak into a loud failure.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in read-only role test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("GET with the read token returns 200 on a general route (acceptance curl 1)", async () => {
    // Arrange / Act
    const res = await call("GET", GENERAL_GET, READ_TOKEN);

    // Assert
    expect(res.status).toBe(200);
  });

  it("POST with the read token returns 401 at the outer gate (acceptance curl 2)", async () => {
    // Arrange / Act
    const res = await call("POST", GENERAL_POST, READ_TOKEN);

    // Assert — outer wording, not the inner sync-secret detail.
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(UNAUTHORIZED_TYPE);
    expect(body.detail).toBe(OUTER_DETAIL);
  });

  it("GET with the read token still 401s on a privileged read (inner check)", async () => {
    // Arrange / Act — passes the outer gate on GET, then hits the sync-secret check.
    const res = await call("GET", "/api/v1/data/customer?id=1", READ_TOKEN);

    // Assert
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(UNAUTHORIZED_TYPE);
    expect(body.detail).toBe(INNER_DETAIL);
  });

  for (const route of PRIVILEGED_ROUTES) {
    it(`no privileged route accepts the read token: ${route.method} ${route.path}`, async () => {
      // Arrange / Act
      const res = await call(route.method, route.path, READ_TOKEN);

      // Assert
      expect(res.status).toBe(401);
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(UNAUTHORIZED_TYPE);
      expect(body.detail).toBe(route.inner ? INNER_DETAIL : OUTER_DETAIL);
    });
  }

  it("sanity: the full token still passes the outer gate on POST (control)", async () => {
    // Arrange / Act — the API token on a general POST clears the gate and
    // reaches the stubbed upstream, which throws → 500 via the error handler.
    const res = await call("POST", GENERAL_POST, API_TOKEN);

    // Assert — 500 proves gate passage (a 401 here would mean the gate broke).
    expect(res.status).toBe(500);
  });
});

/**
 * Fail-closed contract under a synthetic env without `SHADOW_API_READ_TOKEN`
 * (the `test/authModeValidation.test.ts` seam): the read-token string must
 * 401 at the outer gate, proving an unconfigured deploy does not honor it.
 */
const MATRIX_CTX = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

function envWithoutReadToken(): Env {
  const stub = {
    fetch: async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
      if (url.includes("/throttle/failure")) {
        return Response.json({ blocked: false, retryAfterSec: 0 });
      }
      if (url.includes("/throttle/clear")) {
        return new Response("OK");
      }
      throw new Error(`Unexpected AUTH_SESSION fetch in read-only fail-closed test: ${url}`);
    }
  };
  const AUTH_SESSION = {
    idFromName: (name: string) => name,
    get: (_id: string) => stub
  };
  return {
    SHADOW_API_TOKEN: API_TOKEN,
    CUSTOMER_SNAPSHOT_SYNC_SECRET: SYNC_SECRET,
    AUTH_SESSION
  } as unknown as Env;
}

let matrixIpSeq = 1;

describe("read-only role fails closed without the secret", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in read-only fail-closed test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("GET with the read-token string 401s when the secret is unconfigured", async () => {
    // Arrange
    const headers = new Headers();
    headers.set("authorization", `Bearer ${READ_TOKEN}`);
    headers.set("CF-Connecting-IP", `198.51.100.${matrixIpSeq++}`);

    // Act
    const res = await app.fetch(
      new Request("http://test.local/api/v1/shadow/health", { method: "GET", headers }),
      envWithoutReadToken(),
      MATRIX_CTX
    );

    // Assert
    expect(res.status).toBe(401);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(UNAUTHORIZED_TYPE);
    expect(body.detail).toBe(OUTER_DETAIL);
  });
});
