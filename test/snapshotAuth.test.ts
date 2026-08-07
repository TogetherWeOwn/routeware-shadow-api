import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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
 * The `detail` strings are asserted verbatim. They are inconsistent between
 * routes today (some omit `detail` entirely); that is pre-existing, and pinning
 * it here is deliberate, so a later DRY pass cannot quietly change the wording
 * a client sees.
 */

const API_TOKEN = "test-api-token";
const SYNC_SECRET = "test-sync-secret";

const UNAUTHORIZED_TYPE =
  "https://github.com/rick7c2/routeware-shadow-api/blob/main/docs/PROBLEMS.md#unauthorized";

type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
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

/** Every route guarded by the narrower snapshot-secret check, with its exact 401 detail. */
const GUARDED_ROUTES: Array<{ method: string; path: string; detail?: string }> = [
  {
    method: "POST",
    path: "/api/v1/customer-snapshot/sync",
    detail: "Set CUSTOMER_SNAPSHOT_SYNC_SECRET and send Authorization: Bearer <secret>."
  },
  {
    method: "POST",
    path: "/api/v1/customer-snapshot/import",
    detail: "Bearer token mismatch or CUSTOMER_SNAPSHOT_SYNC_SECRET unset."
  },
  {
    method: "POST",
    path: "/api/v1/data-snapshot/sync",
    detail: "Set CUSTOMER_SNAPSHOT_SYNC_SECRET and send Authorization: Bearer <secret>."
  },
  { method: "POST", path: "/api/v1/address-snapshot/sync", detail: "Bearer token required." },
  { method: "POST", path: "/api/v1/address-snapshot/import" },
  { method: "POST", path: "/api/v1/container-snapshot/sync" },
  { method: "POST", path: "/api/v1/container-snapshot/import" },
  {
    method: "GET",
    path: "/api/v1/data/customer?id=1",
    detail: "Set CUSTOMER_SNAPSHOT_SYNC_SECRET and send Authorization: Bearer <secret>."
  },
  {
    method: "GET",
    path: "/api/v1/data/address?id=1",
    detail: "Bearer required (same as snapshot sync secret)."
  },
  {
    method: "GET",
    path: "/api/v1/data/container?id=1",
    detail: "Bearer required (same as snapshot sync secret)."
  },
  { method: "POST", path: "/api/v1/data/customer", detail: "Bearer required." },
  { method: "POST", path: "/api/v1/data/address" },
  { method: "POST", path: "/api/v1/data/container" }
];

describe("snapshot-secret auth gate", () => {
  it("guards exactly 13 routes", () => {
    expect(GUARDED_ROUTES).toHaveLength(13);
  });

  for (const route of GUARDED_ROUTES) {
    it(`rejects the API token on ${route.method} ${route.path} with problem+json 401`, async () => {
      // Arrange / Act — a valid app token that is NOT the sync secret.
      const response = await call(route.method, route.path);

      // Assert
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("problem+json");
      const body = (await response.json()) as ProblemBody;
      expect(body.type).toBe(UNAUTHORIZED_TYPE);
      expect(body.title).toBe("Unauthorized");
      expect(body.status).toBe(401);
      expect(body.detail).toBe(route.detail);
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

    // Assert — 503 (report path not configured in the test env), not 401.
    expect(response.status).not.toBe(401);
  });
});
