import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";

/**
 * `POST /api/v1/routeware/customer/save-long-form` used to forward
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

describe("save-long-form silent-failure guard", () => {
  const originalFetch = globalThis.fetch;
  let saveBody = '{"success":true}';
  let saveStatus = 200;
  let saveContentType = "application/json";
  let saveCalled = false;

  beforeEach(() => {
    saveBody = '{"success":true}';
    saveStatus = 200;
    saveContentType = "application/json";
    saveCalled = false;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/WebRW/Customer/SaveCustomerLongForm")) {
        saveCalled = true;
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

  it("preserves a loud upstream status but replaces its body", async () => {
    // Arrange — loud errors retain their status, never their upstream bytes.
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
    expect(response.headers.get("content-type")).toContain("problem+json");
    expect(await response.json()).toMatchObject({ title: "Upstream request failed", status: 503 });
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

  it("rejects an empty urlencoded body with 400 without calling upstream", async () => {
    // Act — 0-byte body, parity with handlePostDataCustomer (/data/customer).
    const response = await call("/api/v1/routeware/customer/save-long-form", {
      method: "POST",
      body: "",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert — fail fast at the gate: no session/modal round-trip, no junk row.
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("problem+json");
    const body = (await response.json()) as { title: string; status: number };
    expect(body.title).toBe("Bad Request");
    expect(body.status).toBe(400);
    expect(saveCalled).toBe(false);
  });
});

function staleTokenHtml(token: string): string {
  return `<form><input name="__RequestVerificationToken" type="hidden" value="${token}" /></form>`;
}

function isAntiForgeryModalFetch(init?: RequestInit): boolean {
  if (!init || typeof init !== "object" || !("headers" in init) || !init.headers) {
    return false;
  }
  return (
    new Headers(init.headers as HeadersInit).get("X-Routeware-Shadow-Internal") ===
    "anti-forgery-modal"
  );
}

describe("stale-token eviction", () => {
  const originalFetch = globalThis.fetch;
  let modalCalls = 0;
  let saveBodies: string[] = [];

  beforeEach(() => {
    modalCalls = 0;
    saveBodies = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (isAntiForgeryModalFetch(init)) {
        modalCalls += 1;
        return new Response(staleTokenHtml(`STALE-TOKEN-${modalCalls}`), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
      if (url.includes("/WebRW/Customer/SaveCustomerLongForm")) {
        const raw = new TextDecoder().decode(
          (init?.body as ArrayBuffer | undefined) ?? new ArrayBuffer(0)
        );
        saveBodies.push(raw);
        // Routeware's silent-failure shape: HTML 200, save rejected (CONVENTIONS.md §1).
        return new Response(
          "<!DOCTYPE html><html><body>Object reference not set to an instance of an object (save failed)</body></html>",
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }
        );
      }
      throw new Error(`Unexpected upstream fetch in test: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("evicts the rejected token so the next token-less save refetches instead of 502-looping", async () => {
    // Arrange — the issue repro: token-less create, upstream rejects the save
    // silently. Pre-fix this made exactly 1 modal GET and 2 save POSTs carrying
    // the same cached token (sticky 502 until the 5-minute TTL expired).
    const headers = { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" };
    const body = "CustomerID=0&CompanyName=Acme&Enabled=true";

    // Act — two consecutive token-less saves.
    const first = await call("/api/v1/routeware/customer/save-long-form", {
      method: "POST",
      body,
      headers
    });
    const second = await call("/api/v1/routeware/customer/save-long-form", {
      method: "POST",
      body,
      headers
    });

    // Assert — both saves still surface the silent failure as 502 (the save
    // itself is not retried: the POST is not idempotent), but the rejected
    // token was evicted: the second save paid one modal GET for a fresh token
    // instead of replaying the known-rejected one.
    expect(first.status).toBe(502);
    expect(second.status).toBe(502);
    expect(saveBodies).toHaveLength(2);
    expect(modalCalls).toBe(2);
    expect(saveBodies[0]).toContain("__RequestVerificationToken=STALE-TOKEN-1");
    expect(saveBodies[1]).toContain("__RequestVerificationToken=STALE-TOKEN-2");
  });
});
