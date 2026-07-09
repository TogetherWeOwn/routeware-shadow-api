import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";

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

describe("HTTP API", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn(
      async (
        input: RequestInfo | URL,
        init?: RequestInit
      ): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("killeen.routeware.com") && url.includes("/WebRW/Home/Index")) {
          return new Response("mock-index", {
            status: 200,
            headers: { "content-type": "text/plain" }
          });
        }
        if (url.includes("killeen.routeware.com") && url.includes("Account/Login")) {
          return new Response("<html>login</html>", {
            status: 200,
            headers: { "content-type": "text/html" }
          });
        }
        const shadowHdr =
          init && typeof init === "object" && "headers" in init && init.headers
            ? new Headers(init.headers as HeadersInit).get("X-Routeware-Shadow-Internal") ?? ""
            : "";
        const internalTokenFetch = shadowHdr === "anti-forgery-modal";
        if (
          internalTokenFetch &&
          url.includes("killeen.routeware.com") &&
          url.includes("/WebRW/Customer/LoadLongCustomerModal")
        ) {
          return new Response(
            '<input name="__RequestVerificationToken" type="hidden" value="INTEGRATION-MODAL-TOKEN" />',
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
          );
        }
        if (
          internalTokenFetch &&
          url.includes("killeen.routeware.com") &&
          url.includes("/WebRW/Customer/AddNewLong")
        ) {
          return new Response(
            '<input name="__RequestVerificationToken" type="hidden" value="INTEGRATION-NEW-TOKEN" />',
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
          );
        }
        if (url.includes("killeen.routeware.com") && url.includes("/WebRW/")) {
          return new Response(JSON.stringify({ mocked: true, url }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        // Fail loudly on any upstream URL the test did not anticipate instead of
        // silently hitting the network.
        throw new Error(`Unexpected upstream fetch in test: ${url}`);
      }
    ) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("auth gate", () => {
    it("GET /api/v1/health is public (no token)", async () => {
      const response = await call("/api/v1/health", {}, null);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { status: string };
      expect(body.status).toBe("ok");
    });

    it("rejects a proxy route without a token (problem+json 401)", async () => {
      const response = await call("/api/v1/routeware/home/index", {}, null);
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("problem+json");
    });

    it("rejects an unknown path without a token (gate runs before routing)", async () => {
      const response = await call("/api/v1/does-not-exist", {}, null);
      expect(response.status).toBe(401);
    });

    it("returns 404 for an unknown path once authorized", async () => {
      const response = await call("/api/v1/does-not-exist");
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toContain("problem+json");
    });

    it("rejects a wrong token", async () => {
      const response = await call("/api/v1/routeware/home/index", {}, "nope");
      expect(response.status).toBe(401);
    });

    it("snapshot sync passes the gate token but requires the sync secret (two-tier)", async () => {
      const response = await call("/api/v1/customer-snapshot/sync", { method: "POST" });
      expect(response.status).toBe(401);
    });

    it("data-entity read passes the gate token but requires the sync secret", async () => {
      const response = await call("/api/v1/data/customer?id=1");
      expect(response.status).toBe(401);
    });
  });

  it("unknown path returns problem+json 404", async () => {
    const response = await call("/api/v1/does-not-exist");
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("problem+json");
  });

  it("GET /openapi.json returns OpenAPI document", async () => {
    const response = await exports.default.fetch("http://test.local/openapi.json");
    expect(response.status).toBe(200);
    const doc = (await response.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      components?: { securitySchemes?: Record<string, unknown> };
    };
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(doc.paths["/api/v1/health"]).toBeDefined();
    expect(doc.paths["/api/v1/routeware/customer/save-long-form"]).toBeDefined();
    expect(doc.paths["/api/v1/routeware/customer"]).toBeDefined();
    expect(doc.paths["/api/v1/address-snapshot"]).toBeDefined();
    expect(doc.paths["/api/v1/container-snapshot"]).toBeDefined();
    expect(doc.paths["/api/v1/data-snapshot/sync"]).toBeDefined();
    expect(doc.components?.securitySchemes?.bearerAuth).toBeDefined();
  });

  it("GET /api/v1/routeware/home/index forwards to WebRW Home", async () => {
    const response = await call("/api/v1/routeware/home/index");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("mock-index");
  });

  it("GET /api/v1/routeware/account/login-page returns HTML", async () => {
    const response = await call("/api/v1/routeware/account/login-page");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("login");
  });

  it("POST /api/v1/routeware/customer/customers-read forwards to WebRW", async () => {
    const response = await call("/api/v1/routeware/customer/customers-read", {
      method: "POST",
      body: '{"filter":1}',
      headers: { "content-type": "application/json" }
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mocked: boolean; url: string };
    expect(body.mocked).toBe(true);
    expect(body.url).toContain("/WebRW/Customer/CustomersRead");
  });

  it("GET /api/v1/routeware/reports/query-request-is-complete forwards query string", async () => {
    const response = await call(
      "/api/v1/routeware/reports/query-request-is-complete?rid=abc&x=1"
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    expect(body.url).toContain("rid=abc");
  });

  it("POST /api/v1/routeware/customer/save-long-form forwards to SaveCustomerLongForm", async () => {
    const response = await call("/api/v1/routeware/customer/save-long-form", {
      method: "POST",
      body: "CustomerID=0&Enabled=true",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mocked: boolean; url: string };
    expect(body.url).toContain("/WebRW/Customer/SaveCustomerLongForm");
  });

  it("POST save-long-form injects anti-forgery token when omitted (edit flow)", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const response = await call("/api/v1/routeware/customer/save-long-form", {
      method: "POST",
      body: "CustomerTypeID=2&CompanyName=Acme&Enabled=false&CustomerID=84908",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });
    expect(response.status).toBe(200);
    const saveCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("/WebRW/Customer/SaveCustomerLongForm")
    );
    expect(saveCalls.length).toBeGreaterThanOrEqual(1);
    const saveInit = saveCalls[saveCalls.length - 1][1] as RequestInit;
    const forwarded = saveInit.body as ArrayBuffer;
    const text = new TextDecoder().decode(forwarded);
    expect(text).toContain("__RequestVerificationToken=INTEGRATION-MODAL-TOKEN");
    expect(text).toContain("CustomerID=84908");
  });

  it("does not forward a client-supplied X-Routeware-Shadow-Internal marker", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    await call("/api/v1/routeware/customer/customers-read", {
      method: "POST",
      body: '{"filter":1}',
      headers: {
        "content-type": "application/json",
        "X-Routeware-Shadow-Internal": "anti-forgery-modal"
      }
    });
    const upstreamCall = fetchMock.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("/WebRW/Customer/CustomersRead")
    );
    expect(upstreamCall).toBeDefined();
    const init = upstreamCall![1] as RequestInit;
    const forwardedMarker = new Headers(init.headers as HeadersInit).get(
      "X-Routeware-Shadow-Internal"
    );
    expect(forwardedMarker).toBeNull();
  });

  it("GET /api/v1/routeware/customer/load-long-modal forwards customerID query", async () => {
    const response = await call("/api/v1/routeware/customer/load-long-modal?customerID=99");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    expect(body.url).toContain("customerID=99");
    expect(body.url).toContain("LoadLongCustomerModal");
  });

  it("GET /api/v1/routeware/customer/add-new-long forwards to WebRW", async () => {
    const response = await call("/api/v1/routeware/customer/add-new-long");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    expect(body.url).toContain("/WebRW/Customer/AddNewLong");
  });

  it("DELETE /api/v1/routeware/customer returns 405 with guidance", async () => {
    const response = await call("/api/v1/routeware/customer", { method: "DELETE" });
    expect(response.status).toBe(405);
    expect(response.headers.get("content-type")).toContain("problem+json");
    const body = (await response.json()) as { title: string; status: number; detail?: string };
    expect(body.status).toBe(405);
    expect(body.title).toContain("not supported");
    expect(body.detail).toMatch(/save-long-form/i);
  });
});
