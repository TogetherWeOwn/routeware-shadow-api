import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";
const FOREIGN_ORIGIN = "https://app.example.com";

// Every registered /api/v1 route; preflight never reaches a handler, so any concrete params work.
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
    routes.push({ method: r.method, path: r.path.replace(/\{[^}]+\}/g, "sample") });
  }
  return routes;
}

/**
 * Call the Worker through the same `exports.default.fetch()` surface the
 * acceptance check uses. Adds `Authorization: Bearer <token>` unless `token`
 * is null (used to prove preflight needs no credentials).
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

/** Headers every /api/v1/* response must carry when called from a browser. */
function expectHardened(res: Response): void {
  expect(res.headers.get("access-control-allow-origin")).toBeTruthy();
  expect(res.headers.get("vary")).toMatch(/origin/i);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
}

describe("CORS preflight + security headers on /api/v1/* (TOG-5809)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // No upstream fetch expected: preflight short-circuits, and the
    // non-preflight cases below hit local handlers (health, 404, 401).
    // Fail loudly if anything tries to leave the Worker instead.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("Unexpected upstream fetch in CORS test");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("answers OPTIONS from a foreign Origin with 204 + ACAO headers, no token", async () => {
    const response = await call(
      "/api/v1/routeware/customer/customers-read",
      {
        method: "OPTIONS",
        headers: {
          Origin: FOREIGN_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization, content-type"
        }
      },
      null
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(FOREIGN_ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-methods")).toContain("OPTIONS");
    expect(response.headers.get("access-control-allow-headers")).toMatch(
      /authorization/i
    );
    expect(response.headers.get("access-control-max-age")).toBe("86400");
  });

  it("echoes the request Origin on a real GET and hardens the response", async () => {
    const response = await call(
      "/api/v1/health",
      { headers: { Origin: FOREIGN_ORIGIN } },
      null
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(FOREIGN_ORIGIN);
    expectHardened(response);
  });

  it("stamps ACAO + hardening headers on the 401 gate response", async () => {
    const response = await call(
      "/api/v1/routeware/home/index",
      { headers: { Origin: FOREIGN_ORIGIN } },
      null
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe(FOREIGN_ORIGIN);
    expectHardened(response);
  });

  it("stamps ACAO + hardening headers on a 404", async () => {
    const response = await call(
      "/api/v1/does-not-exist",
      { headers: { Origin: FOREIGN_ORIGIN } }
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBe(FOREIGN_ORIGIN);
    expectHardened(response);
  });

  it("returns wildcard ACAO when no Origin is sent (non-browser client)", async () => {
    const response = await call("/api/v1/health", {}, null);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expectHardened(response);
  });

  it("strips non-allowlisted request headers from the preflight grant (TOG-8368)", async () => {
    const response = await call(
      "/api/v1/routeware/customer/customers-read",
      {
        method: "OPTIONS",
        headers: {
          Origin: FOREIGN_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers":
            "authorization, content-type, x-custom-evil, X-Another-Nope"
        }
      },
      null
    );
    expect(response.status).toBe(204);
    const allowHeaders =
      response.headers.get("access-control-allow-headers") ?? "";
    expect(allowHeaders).toMatch(/authorization/i);
    expect(allowHeaders).toMatch(/content-type/i);
    expect(allowHeaders.toLowerCase()).not.toContain("x-custom-evil");
    expect(allowHeaders.toLowerCase()).not.toContain("x-another-nope");
  });

  it("permits If-None-Match for conditional reads of the ETag cache (TOG-8368)", async () => {
    const response = await call(
      "/api/v1/data/customer",
      {
        method: "OPTIONS",
        headers: {
          Origin: FOREIGN_ORIGIN,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization, if-none-match"
        }
      },
      null
    );
    expect(response.status).toBe(204);
    expect(
      response.headers.get("access-control-allow-headers")
    ).toMatch(/if-none-match/i);
  });

  it("falls back to the default pair when nothing allowlisted is requested (TOG-8368)", async () => {
    const response = await call(
      "/api/v1/routeware/customer/customers-read",
      {
        method: "OPTIONS",
        headers: {
          Origin: FOREIGN_ORIGIN,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "x-only-junk"
        }
      },
      null
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Authorization, Content-Type"
    );
  });

  it("does not set Access-Control-Allow-Credentials (bearer auth, no cookies)", async () => {
    const response = await call(
      "/api/v1/health",
      { headers: { Origin: FOREIGN_ORIGIN } },
      null
    );
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("does not relay upstream Set-Cookie on a proxied GET from a foreign Origin", async () => {
    globalThis.fetch = vi.fn(
      async (): Promise<Response> =>
        new Response("mock-index", {
          status: 200,
          headers: {
            "content-type": "text/plain",
            "set-cookie": ".WebRW=super-secret-session; Path=/; HttpOnly"
          }
        })
    ) as typeof fetch;
    const response = await call("/api/v1/routeware/home/index", {
      headers: { Origin: FOREIGN_ORIGIN }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(FOREIGN_ORIGIN);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("pins the preflight sweep to every registered /api/v1 route", () => {
    expect(apiRoutes()).toHaveLength(42);
  });

  describe.each(apiRoutes())("preflight $method $path", ({ method, path }) => {
    it("answers without a token with 204, CORS and hardening headers", async () => {
      const response = await call(
        path,
        {
          method: "OPTIONS",
          headers: {
            Origin: FOREIGN_ORIGIN,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "authorization, content-type, x-custom-evil"
          }
        },
        null
      );
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(FOREIGN_ORIGIN);
      expect(response.headers.get("access-control-allow-methods")).toContain(method);
      expect(response.headers.get("access-control-allow-methods")).toContain("OPTIONS");
      expect(response.headers.get("access-control-allow-headers")).toBe(
        "authorization, content-type"
      );
      expect(response.headers.get("access-control-max-age")).toBe("86400");
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expectHardened(response);
    });
  });
});
