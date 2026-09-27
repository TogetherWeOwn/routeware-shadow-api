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
        if (
          internalTokenFetch &&
          url.includes("killeen.routeware.com") &&
          url.includes("/WebRW/PickupAddress/LoadAddressModal")
        ) {
          return new Response(
            '<input name="__RequestVerificationToken" type="hidden" value="INTEGRATION-ADDRESS-TOKEN" />',
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
          );
        }
        if (
          internalTokenFetch &&
          url.includes("killeen.routeware.com") &&
          url.includes("/WebRW/PickupAddress/CreateBlankAddress")
        ) {
          return new Response(
            '<input name="__RequestVerificationToken" type="hidden" value="INTEGRATION-ADDRESS-NEW-TOKEN" />',
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
          );
        }
        if (
          internalTokenFetch &&
          url.includes("killeen.routeware.com") &&
          url.includes("/WebRW/Container/LoadContainerModal")
        ) {
          return new Response(
            '<input name="__RequestVerificationToken" type="hidden" value="INTEGRATION-CONTAINER-TOKEN" />',
            { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
          );
        }
        if (
          internalTokenFetch &&
          url.includes("killeen.routeware.com") &&
          url.includes("/WebRW/Container/CreateBlankContainer")
        ) {
          return new Response(
            '<input name="__RequestVerificationToken" type="hidden" value="INTEGRATION-CONTAINER-NEW-TOKEN" />',
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
    expect(doc.paths["/api/v1/routeware/address/save-address-form"]).toBeDefined();
    expect(doc.paths["/api/v1/routeware/container/save-container-form"]).toBeDefined();
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

  it("GET /api/v1/routeware/reports/query-request-is-complete forwards allowlisted query params", async () => {
    const response = await call(
      "/api/v1/routeware/reports/query-request-is-complete?requestID=abc-123&_=1776969836738"
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { url: string };
    expect(body.url).toContain("requestID=abc-123");
    expect(body.url).toContain("_=1776969836738");
  });

  it("GET /api/v1/routeware/reports/query-request-is-complete drops unknown query params upstream", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const response = await call(
      "/api/v1/routeware/reports/query-request-is-complete?requestID=abc-123&evil=1&requestid=lower&REQUESTID=upper"
    );
    expect(response.status).toBe(200);
    const upstreamCall = fetchMock.mock.calls.find(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("/WebRW/Reports/QueryRequestIsComplete")
    );
    expect(upstreamCall).toBeDefined();
    const upstreamUrl = new URL(upstreamCall![0] as string);
    expect(upstreamUrl.searchParams.get("requestID")).toBe("abc-123");
    expect(upstreamUrl.searchParams.has("evil")).toBe(false);
    // Allowlist matching is case-sensitive: differently-cased lookalikes stay client-side.
    expect(upstreamUrl.searchParams.has("requestid")).toBe(false);
    expect(upstreamUrl.searchParams.has("REQUESTID")).toBe(false);
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

  it("POST /api/v1/routeware/address/save-address-form forwards to SaveAddressForm", async () => {
    const response = await call("/api/v1/routeware/address/save-address-form", {
      method: "POST",
      body: "PickupAddressID=10&CustomerID=5&Address=1+Main+St",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mocked: boolean; url: string };
    expect(body.mocked).toBe(true);
    expect(body.url).toContain("/WebRW/PickupAddress/SaveAddressForm");
  });

  it("POST save-address-form injects anti-forgery token when omitted (edit flow)", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const response = await call("/api/v1/routeware/address/save-address-form", {
      method: "POST",
      body: "PickupAddressID=10&CustomerID=5&Address=1+Main+St",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });
    expect(response.status).toBe(200);
    const saveCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("/WebRW/PickupAddress/SaveAddressForm")
    );
    expect(saveCalls.length).toBeGreaterThanOrEqual(1);
    const saveInit = saveCalls[saveCalls.length - 1][1] as RequestInit;
    const forwarded = saveInit.body as ArrayBuffer;
    const text = new TextDecoder().decode(forwarded);
    expect(text).toContain("__RequestVerificationToken=INTEGRATION-ADDRESS-TOKEN");
    expect(text).toContain("PickupAddressID=10");
  });

  it("POST save-address-form uses the blank-address modal for a create (PickupAddressID=0)", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const response = await call("/api/v1/routeware/address/save-address-form", {
      method: "POST",
      body: "PickupAddressID=0&CustomerID=5&Address=1+Main+St",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });
    expect(response.status).toBe(200);
    const modalCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("/WebRW/PickupAddress/CreateBlankAddress")
    );
    expect(modalCalls.length).toBeGreaterThanOrEqual(1);
    expect(modalCalls[0][0] as string).toContain("customerID=5");
  });

  it("POST /api/v1/routeware/container/save-container-form forwards to SaveContainerForm", async () => {
    const response = await call("/api/v1/routeware/container/save-container-form", {
      method: "POST",
      body: "ContainerID=100&PickupAddressID=10&Size=96",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { mocked: boolean; url: string };
    expect(body.mocked).toBe(true);
    expect(body.url).toContain("/WebRW/Container/SaveContainerForm");
  });

  it("POST save-container-form injects anti-forgery token when omitted (edit flow)", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const response = await call("/api/v1/routeware/container/save-container-form", {
      method: "POST",
      body: "ContainerID=100&PickupAddressID=10&Size=96",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });
    expect(response.status).toBe(200);
    const saveCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("/WebRW/Container/SaveContainerForm")
    );
    expect(saveCalls.length).toBeGreaterThanOrEqual(1);
    const saveInit = saveCalls[saveCalls.length - 1][1] as RequestInit;
    const forwarded = saveInit.body as ArrayBuffer;
    const text = new TextDecoder().decode(forwarded);
    expect(text).toContain("__RequestVerificationToken=INTEGRATION-CONTAINER-TOKEN");
    expect(text).toContain("ContainerID=100");
  });

  it("POST save-container-form uses the blank-container modal for a create (ContainerID=0)", async () => {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const response = await call("/api/v1/routeware/container/save-container-form", {
      method: "POST",
      body: "ContainerID=0&PickupAddressID=10&Size=96",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });
    expect(response.status).toBe(200);
    const modalCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("/WebRW/Container/CreateBlankContainer")
    );
    expect(modalCalls.length).toBeGreaterThanOrEqual(1);
    expect(modalCalls[0][0] as string).toContain("pickupAddressID=10");
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
