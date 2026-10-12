import { exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { AUTH_THROTTLE_MAX_FAILURES } from "../src/lib/authThrottle";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * TOG-22087 — authenticated API responses carry `Cache-Control: no-store`.
 *
 * Every `/api/v1/*` response with no handler-set `Cache-Control` must leave
 * with `no-store`; a handler-set value is preserved. Pinned through the real
 * app (`exports.default.fetch`), the same surface `test/cors.test.ts` uses.
 */

const SYNC_SECRET = "test-sync-secret";
const API_TOKEN = "test-api-token";
// Distinct TEST-NET IP so the throttle bucket never collides with other suites.
const THROTTLE_IP = "203.0.113.217";

const CUSTOMER_HEADER =
  "CustomerID,CustomerTypeID,CompanyName,FirstName,MiddleInitial,LastName,NameSuffix," +
  "CustomerNumber,SubCustomerNumber,Phone1,Phone2,Comments,Enabled";
const CUSTOMER_ROW = "77001,,Cache Co,,,,,,,,,,true";

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(`http://test.local${path}`, init);
}

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${SYNC_SECRET}`);
  return call(path, { ...init, headers });
}

describe("Cache-Control: no-store on /api/v1/* (TOG-22087)", () => {
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

  it("sends no-store on a snapshot list 200", async () => {
    const res = await authed("/api/v1/customer-snapshot");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("sends no-store on a CSV export 200 and keeps 304 empty", async () => {
    const first = await authed("/api/v1/customer-snapshot/export");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    await first.text();

    const notModified = await authed("/api/v1/customer-snapshot/export", {
      headers: { "if-none-match": etag as string }
    });
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
  });

  it("sends no-store on the public health 200", async () => {
    const res = await call("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("sends no-store on the 401 gate response", async () => {
    const res = await call("/api/v1/customer-snapshot");
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("sends no-store on the 429 throttle response", async () => {
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
        "CF-Connecting-IP": THROTTLE_IP
      }
    });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("cache-control")).toBe("no-store");
  });

  it("sends no-store on a 404", async () => {
    const res = await call("/api/v1/does-not-exist", {
      headers: { authorization: `Bearer ${API_TOKEN}` }
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("keeps private, max-age=60 on a data-entity 200", async () => {
    const res = await authed("/api/v1/data/customer?id=77001");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=60");
  });

  it("leaves preflight without Cache-Control (no body, own Max-Age)", async () => {
    const res = await call("/api/v1/customer-snapshot", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization, content-type"
      }
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("cache-control")).toBeNull();
  });

  it("leaves /openapi.json and /docs without Cache-Control", async () => {
    for (const path of ["/openapi.json", "/docs"]) {
      const res = await call(path);
      expect(res.headers.get("cache-control")).toBeNull();
    }
  });
});
