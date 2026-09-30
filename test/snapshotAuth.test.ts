import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockedFunction } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";

/**
 * The snapshot and data-entity routes carry a second, narrower auth check on
 * top of the app-wide `/api/v1/*` bearer gate: they require the bearer to be
 * `CUSTOMER_SNAPSHOT_SYNC_SECRET` specifically, because they read and write
 * customer PII.
 *
 * `wrangler.toml` [env.test.vars] sets SHADOW_API_TOKEN = "test-api-token" and
 * CUSTOMER_SNAPSHOT_SYNC_SECRET = "test-sync-secret". `isApiAuthorized` accepts
 * either, so sending the API token passes the outer gate and is then rejected
 * by the inner check — which is exactly the path these tests exercise.
 *
 * The inner 401 body is canonical (TOG-7030): one detail naming the sync
 * secret and the remedy doc, plus `instance` for the request path. Per-route
 * wording drift was unified in `requireSnapshotAuth` itself.
 */

const API_TOKEN = "test-api-token";
const SYNC_SECRET = "test-sync-secret";

const UNAUTHORIZED_TYPE = problemType("unauthorized");
const INNER_DETAIL =
  "Send Authorization: Bearer <CUSTOMER_SNAPSHOT_SYNC_SECRET>. See docs/PROBLEMS.md#unauthorized.";

type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
};

async function call(
  method: string,
  path: string,
  token: string | null = API_TOKEN
): Promise<Response> {
  const headers = new Headers();
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return exports.default.fetch(`http://test.local${path}`, { method, headers });
}

/**
 * Every route guarded by the narrower snapshot-secret check. All 17 share the
 * canonical inner 401 body. The cross-check below compares ROUTER paths (Hono
 * `:param` syntax); concrete probe paths are registered separately so a
 * parametrized route is both listed and exercised.
 */
const GUARDED_ROUTES: Array<{ method: string; path: string; probe?: false }> = [
  { method: "POST", path: "/api/v1/customer-snapshot/sync" },
  { method: "POST", path: "/api/v1/customer-snapshot/import" },
  { method: "GET", path: "/api/v1/customer-snapshot/export" },
  { method: "POST", path: "/api/v1/data-snapshot/sync" },
  { method: "POST", path: "/api/v1/address-snapshot/sync" },
  { method: "POST", path: "/api/v1/address-snapshot/import" },
  { method: "GET", path: "/api/v1/address-snapshot/export" },
  { method: "POST", path: "/api/v1/container-snapshot/sync" },
  { method: "POST", path: "/api/v1/container-snapshot/import" },
  { method: "GET", path: "/api/v1/container-snapshot/export" },
  { method: "GET", path: "/api/v1/data/customer?id=1" },
  { method: "GET", path: "/api/v1/data/address?id=1" },
  { method: "GET", path: "/api/v1/data/container?id=1" },
  { method: "POST", path: "/api/v1/data/customer" },
  { method: "POST", path: "/api/v1/data/address" },
  { method: "POST", path: "/api/v1/data/container" },
  // TOG-9202: R2 archive readback (sync secret only, 404 when the key is
  // absent). The router renders the path in Hono `:param` syntax; the
  // list/entry comparison below strips the data-route `?id=1`, so this entry
  // reads as the router's own path while `call()` below cannot fetch it
  // verbatim — its dedicated cells live in `test/snapshotArchive.test.ts`.
  { method: "GET", path: "/api/v1/snapshots/:table/:date", probe: false }
];

describe("snapshot-secret auth gate", () => {
  // No test in this file should reach the network. The one request that is meant
  // to *clear* the inner gate goes on to run the real sync body, which logs in
  // upstream; unstubbed, that hit killeen.routeware.com and hung to the 30s
  // timeout, so the result depended on the runner's network. Throwing keeps the
  // suite hermetic and turns any future upstream leak into a loud failure.
  const originalFetch = globalThis.fetch;
  // Typed as the real `fetch` rather than a bare `vi.fn`, so `toHaveBeenCalledWith`
  // and `mock.calls[0]` below are signature-checked instead of `any`.
  let upstreamFetch: MockedFunction<typeof fetch>;

  beforeEach(() => {
    upstreamFetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // TOG-6543: the query-id leg polls QueryRequestIsComplete before its
      // download. The poll answers complete so the download attempt is what
      // throws, preserving the "reached the sync body" proof below.
      if (url.includes("/Reports/QueryRequestIsComplete")) {
        return new Response("true", {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`Unexpected upstream fetch in test: ${url}`);
    }) as MockedFunction<typeof fetch>;
    globalThis.fetch = upstreamFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("lists only routes that are actually registered on the app", () => {
    // Arrange — cross-check against the live router rather than against this
    // file's own array, so the list cannot drift from reality unnoticed.
    const registered = new Set(
      app.routes
        .filter((r) => r.method !== "ALL")
        .map((r) => `${r.method} ${r.path}`)
    );

    // Assert
    for (const route of GUARDED_ROUTES) {
      const path = route.path.split("?")[0];
      expect(registered).toContain(`${route.method} ${path}`);
    }
    expect(GUARDED_ROUTES).toHaveLength(17);
  });

  for (const route of GUARDED_ROUTES.filter((r) => r.probe !== false)) {
    it(`rejects the API token on ${route.method} ${route.path} with problem+json 401`, async () => {
      // Arrange / Act — a valid app token that is NOT the sync secret.
      const response = await call(route.method, route.path);

      // Assert — the canonical inner 401: same detail on every route, plus
      // the request path as instance.
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("problem+json");
      const body = (await response.json()) as ProblemBody;
      expect(body.type).toBe(UNAUTHORIZED_TYPE);
      expect(body.title).toBe("Unauthorized");
      expect(body.status).toBe(401);
      expect(body.detail).toBe(INNER_DETAIL);
      expect(body.instance).toBe(route.path.split("?")[0]);
    });
  }

  it("rejects a request with no bearer at the outer gate before the inner check", async () => {
    // Arrange / Act
    const response = await call("POST", "/api/v1/customer-snapshot/sync", null);

    // Assert — the outer gate emits a different problem type than the inner check.
    expect(response.status).toBe(401);
    const body = (await response.json()) as ProblemBody;
    expect(body.type).toContain("unauthorized");
    expect(body.detail).toContain("SHADOW_API_TOKEN");
  });

  it("lets the sync secret past the inner check", async () => {
    // Arrange / Act — the correct secret must NOT produce the inner 401.
    const response = await call("POST", "/api/v1/container-snapshot/sync", SYNC_SECRET);

    // Assert — the request reached the sync body instead of being turned away at
    // the gate. `[env.test.vars]` sets CONTAINER_REPORT_QUERY_ID, so the 503
    // short-circuit does not fire; the attempted upstream call
    // is what proves the inner check was cleared.
    //
    // The status is pinned to 500, not merely `not.toBe(401)`: the stub above makes
    // the one upstream call throw, so the handler fails inside the global error
    // handler. `not.toBe(401)` would also accept the **404** you get by deleting the
    // route outright, which must not read as a passing auth test.
    expect(response.status).toBe(500);
    // Two upstream calls: the TOG-6543 completion poll (answered complete by
    // the stub above), then the report download — which throws. Asserting both
    // URLs, not "some fetch happened", which any future middleware would satisfy.
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
    const requestedUrls = upstreamFetch.mock.calls.map(([requested]) =>
      typeof requested === "string"
        ? requested
        : requested instanceof URL
          ? requested.href
          : requested.url
    );
    expect(requestedUrls[0]).toContain("/Reports/QueryRequestIsComplete");
    expect(requestedUrls[1]).toContain("/Reports/QueryExecuteDownload");
    expect(requestedUrls[1]).toContain("queryID=25");
  });
});
