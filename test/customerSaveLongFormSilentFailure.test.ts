import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";

/**
 * TOG-6022 — `POST /api/v1/routeware/customer/save-long-form` used to forward
 * an upstream HTML error page with HTTP 200 verbatim, so the client saw 200 +
 * text/html and no signal the save failed. The route now applies the same
 * `routewarePostLooksSuccessful` heuristic as the /data/* write path and
 * surfaces that silent-failure shape as 502 problem+json.
 */

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${API_TOKEN}`);
  return exports.default.fetch(`http://test.local${path}`, { ...init, headers });
}

describe("save-long-form silent-failure guard (TOG-6022)", () => {
  const originalFetch = globalThis.fetch;
  let saveBody = '{"success":true}';
  let saveStatus = 200;
  let saveContentType = "application/json";

  beforeEach(() => {
    saveBody = '{"success":true}';
    saveStatus = 200;
    saveContentType = "application/json";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/WebRW/Customer/SaveCustomerLongForm")) {
        return new Response(saveBody, {
          status: saveStatus,
          headers: { "content-type": saveContentType }
        });
      }
      throw new Error(`Unexpected upstream fetch in test: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("surfaces an upstream HTML-200 error page as 502 problem+json", async () => {
    // Arrange — Routeware's normal silent-failure shape (CONVENTIONS.md §1).
    saveBody =
      "<!DOCTYPE html><html><body>Object reference not set to an instance of an object (save failed)</body></html>";
    saveContentType = "text/html; charset=utf-8";

    // Act — explicit token skips the anti-forgery modal fetch; only the save matters.
    const response = await call("/api/v1/routeware/customer/save-long-form", {
      method: "POST",
      body: "CustomerID=5&CompanyName=Acme&__RequestVerificationToken=client-token",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("problem+json");
    const body = (await response.json()) as { title: string; status: number };
    expect(body.title).toBe("Bad Gateway");
    expect(body.status).toBe(502);
  });

  it("still passes a JSON success through as 200", async () => {
    // Arrange — default saveBody is already a JSON success.
    // Act
    const response = await call("/api/v1/routeware/customer/save-long-form", {
      method: "POST",
      body: "CustomerID=5&CompanyName=Acme&__RequestVerificationToken=client-token",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe('{"success":true}');
  });

  it("passes a non-2xx upstream status through unchanged", async () => {
    // Arrange — a loud upstream failure is not a silent one; no rewriting.
    saveStatus = 503;
    saveBody = "upstream down";
    saveContentType = "text/plain";

    // Act
    const response = await call("/api/v1/routeware/customer/save-long-form", {
      method: "POST",
      body: "CustomerID=5&CompanyName=Acme&__RequestVerificationToken=client-token",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("upstream down");
  });

  it("surfaces an upstream JSON success:false with HTTP 200 as 502", async () => {
    // Arrange — explicit failure flag inside a 200 body also fails the heuristic.
    saveBody = '{"success":false}';

    // Act
    const response = await call("/api/v1/routeware/customer/save-long-form", {
      method: "POST",
      body: "CustomerID=5&CompanyName=Acme&__RequestVerificationToken=client-token",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("problem+json");
  });
});
