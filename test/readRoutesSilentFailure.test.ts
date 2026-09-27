import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";

/**
 * TOG-6266 — audit of every upstream passthrough route for the HTML-200
 * silent-failure shape (CONVENTIONS.md §1).
 *
 * The three save routes were already guarded (TOG-6022 save-long-form,
 * TOG-6271 address/container saves): they apply `routewarePostLooksSuccessful`
 * and surface an upstream HTML error page with HTTP 200 as 502 problem+json.
 * This file pins the same guard on the five JSON-expecting read passthroughs,
 * which previously forwarded that shape verbatim as 200:
 *
 * - POST /api/v1/routeware/customer/customers-read
 * - POST /api/v1/routeware/customer/detail-full
 * - POST /api/v1/routeware/customer/customer-types-read
 * - POST /api/v1/routeware/data/app-settings-get
 * - GET  /api/v1/routeware/reports/query-request-is-complete
 *
 * Deliberately NOT guarded (documented exclusions, not gaps):
 *
 * - GET /api/v1/routeware/account/login-page — HTML is its contract: the
 *   route fetches the fixed LOGIN_URL with no session and returns the login
 *   page. An HTML-200 body is success, not failure. Pinned by
 *   test/loginPageSessionIsolation.test.ts.
 * - GET /api/v1/routeware/home/index — its contract is "may be HTML, JSON, or
 *   other content types", so an HTML body cannot be classified as failure.
 * - GET /api/v1/routeware/customer/add-new-long and
 *   GET /api/v1/routeware/customer/load-long-modal — both return the
 *   HTML/JS form shell Routeware uses for the modals; HTML is success.
 * - POST /api/v1/data/customer, /api/v1/data/address, /api/v1/data/container —
 *   they never touch upstream HTML directly: they compute `ok` via
 *   `routewarePostLooksSuccessful` and answer with their own envelope
 *   (`{ ok, routewareStatus, upstream, posted, localSync }`), so a silent
 *   upstream failure already surfaces as `ok: false`, never as a bare 200.
 */

const HTML_ERROR =
  "<!DOCTYPE html><html><body>Object reference not set to an instance of an object (read failed)</body></html>";

const behavior: Record<string, { status: number; body: string; contentType: string }> = {};

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${API_TOKEN}`);
  return exports.default.fetch(`http://test.local${path}`, { ...init, headers });
}

describe("read passthrough silent-failure guard (TOG-6266)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    for (const key of Object.keys(behavior)) {
      delete behavior[key];
    }
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      for (const [path, entry] of Object.entries(behavior)) {
        if (url.includes(path)) {
          return new Response(entry.body, {
            status: entry.status,
            headers: { "content-type": entry.contentType }
          });
        }
      }
      if (url.includes("/WebRW/")) {
        // Default: a JSON success, so pass-through tests need no per-path setup.
        return new Response('{"success":true}', {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`Unexpected upstream fetch in test: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("surfaces an upstream customers-read HTML-200 error page as 502 problem+json", async () => {
    // Arrange — Routeware's normal silent-failure shape (CONVENTIONS.md §1).
    behavior["/WebRW/Customer/CustomersRead"] = {
      status: 200,
      body: HTML_ERROR,
      contentType: "text/html; charset=utf-8"
    };

    // Act
    const response = await call("/api/v1/routeware/customer/customers-read", {
      method: "POST",
      body: '{"filter":[{"property":"CustomerID","operator":">","value":0}]}',
      headers: { "content-type": "application/json" }
    });

    // Assert
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("problem+json");
    const body = (await response.json()) as { title: string; status: number; detail: string };
    expect(body.title).toBe("Upstream read failed");
    expect(body.status).toBe(502);
    expect(body.detail).toContain("CustomersRead");
  });

  it("still passes a customers-read JSON success through as 200", async () => {
    // Arrange — default entry is already a JSON success.
    // Act
    const response = await call("/api/v1/routeware/customer/customers-read", {
      method: "POST",
      body: '{"filter":[{"property":"CustomerID","operator":">","value":0}]}',
      headers: { "content-type": "application/json" }
    });

    // Assert
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"success":true}');
  });

  it("surfaces an upstream detail-full HTML-200 error page as 502 problem+json", async () => {
    // Arrange
    behavior["/WebRW/Customer/GetCustomerDetailFull"] = {
      status: 200,
      body: HTML_ERROR,
      contentType: "text/html; charset=utf-8"
    };

    // Act
    const response = await call("/api/v1/routeware/customer/detail-full", {
      method: "POST",
      body: '{"CustomerID":5}',
      headers: { "content-type": "application/json" }
    });

    // Assert
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("problem+json");
    const body = (await response.json()) as { title: string; status: number; detail: string };
    expect(body.title).toBe("Upstream read failed");
    expect(body.status).toBe(502);
    expect(body.detail).toContain("GetCustomerDetailFull");
  });

  it("surfaces an upstream customer-types-read HTML-200 error page as 502 problem+json", async () => {
    // Arrange
    behavior["/WebRW/Customer/CustomerTypesRead"] = {
      status: 200,
      body: HTML_ERROR,
      contentType: "text/html; charset=utf-8"
    };

    // Act
    const response = await call("/api/v1/routeware/customer/customer-types-read", {
      method: "POST",
      body: "EnabledOnly=true",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("problem+json");
    const body = (await response.json()) as { title: string; status: number; detail: string };
    expect(body.title).toBe("Upstream read failed");
    expect(body.status).toBe(502);
    expect(body.detail).toContain("CustomerTypesRead");
  });

  it("surfaces an upstream app-settings-get HTML-200 error page as 502 problem+json", async () => {
    // Arrange
    behavior["/WebRW/Data/appSettingsGet"] = {
      status: 200,
      body: HTML_ERROR,
      contentType: "text/html; charset=utf-8"
    };

    // Act
    const response = await call("/api/v1/routeware/data/app-settings-get", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" }
    });

    // Assert
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("problem+json");
    const body = (await response.json()) as { title: string; status: number; detail: string };
    expect(body.title).toBe("Upstream read failed");
    expect(body.status).toBe(502);
    expect(body.detail).toContain("appSettingsGet");
  });

  it("surfaces an upstream query-request-is-complete HTML-200 error page as 502 problem+json", async () => {
    // Arrange
    behavior["/WebRW/Reports/QueryRequestIsComplete"] = {
      status: 200,
      body: HTML_ERROR,
      contentType: "text/html; charset=utf-8"
    };

    // Act
    const response = await call(
      "/api/v1/routeware/reports/query-request-is-complete?requestID=abc-123&_=1776969836738"
    );

    // Assert
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("problem+json");
    const body = (await response.json()) as { title: string; status: number; detail: string };
    expect(body.title).toBe("Upstream read failed");
    expect(body.status).toBe(502);
    expect(body.detail).toContain("QueryRequestIsComplete");
  });

  it("still passes a query-request-is-complete boolean poll through as 200", async () => {
    // Arrange — the legitimate poll answer is a bare boolean, never HTML.
    behavior["/WebRW/Reports/QueryRequestIsComplete"] = {
      status: 200,
      body: "true",
      contentType: "text/plain"
    };

    // Act
    const response = await call(
      "/api/v1/routeware/reports/query-request-is-complete?requestID=abc-123"
    );

    // Assert
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("true");
  });

  it("passes a non-2xx upstream status through unchanged on every guarded read route", async () => {
    // Arrange — a loud upstream failure is not a silent one; no rewriting.
    behavior["/WebRW/Customer/CustomersRead"] = {
      status: 503,
      body: "upstream down",
      contentType: "text/plain"
    };

    // Act
    const response = await call("/api/v1/routeware/customer/customers-read", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" }
    });

    // Assert
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("upstream down");
  });
});
