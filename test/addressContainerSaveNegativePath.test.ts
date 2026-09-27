import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";

// Verbatim literal, never problemType() output: recomputing the expected
// value with the function under test would let a base-URL change pass
// silently (same rule as test/problemAnchors.test.ts).
const BAD_GATEWAY_TYPE =
  "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-gateway";

/**
 * TOG-7377 — QA-side pin of the TOG-6514 contract (fixed by TOG-6271).
 *
 * `POST /api/v1/routeware/address/save-address-form` and
 * `POST /api/v1/routeware/container/save-container-form` must surface an
 * upstream HTML error page with HTTP 200 as 502 problem+json — never as a
 * 200 the client would read as a landed save.
 *
 * `test/addressContainerSaveSilentFailure.test.ts` (TOG-6271) covers the
 * mapping itself; this file pins the full problem+json contract (anchored
 * `type`, `instance`) on both routes plus the two adjacent edges a
 * regression sweep needs: explicit-failure JSON is also mapped, while loud
 * non-2xx upstreams still pass through untouched.
 *
 * Explicit `__RequestVerificationToken` values skip the anti-forgery modal
 * fetch, so every case below exercises only the save → guard path.
 */

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${API_TOKEN}`);
  return exports.default.fetch(`http://test.local${path}`, { ...init, headers });
}

const behavior = {
  saveStatus: 200,
  saveBody: '{"success":true}',
  saveContentType: "application/json"
};

// Routeware's silent-failure shape (CONVENTIONS.md §1). Synthetic fixture —
// no PII, no customer data.
const HTML_200 =
  "<!DOCTYPE html><html><body>Object reference not set to an instance of an object (save failed)</body></html>";

type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
};

describe("address/container save negative-path contract (TOG-7377)", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    behavior.saveStatus = 200;
    behavior.saveBody = '{"success":true}';
    behavior.saveContentType = "application/json";
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (
        url.includes("/WebRW/PickupAddress/SaveAddressForm") ||
        url.includes("/WebRW/Container/SaveContainerForm")
      ) {
        return new Response(behavior.saveBody, {
          status: behavior.saveStatus,
          headers: { "content-type": behavior.saveContentType }
        });
      }
      throw new Error(`Unexpected upstream fetch in test: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("address HTML-200 failure → 502 with anchored type + instance", async () => {
    // Arrange
    behavior.saveBody = HTML_200;
    behavior.saveContentType = "text/html; charset=utf-8";

    // Act
    const response = await call("/api/v1/routeware/address/save-address-form", {
      method: "POST",
      body: "PickupAddressID=10&CustomerID=5&__RequestVerificationToken=client-token",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert — full problem+json contract, not just the status.
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const body = (await response.json()) as ProblemBody;
    expect(body.type).toBe(BAD_GATEWAY_TYPE);
    expect(body.title).toBe("Upstream save failed");
    expect(body.status).toBe(502);
    expect(body.detail).toContain("SaveAddressForm");
    expect(body.instance).toBe("/api/v1/routeware/address/save-address-form");
  });

  it("container HTML-200 failure → 502 with anchored type + instance", async () => {
    // Arrange
    behavior.saveBody = HTML_200;
    behavior.saveContentType = "text/html; charset=utf-8";

    // Act
    const response = await call("/api/v1/routeware/container/save-container-form", {
      method: "POST",
      body: "ContainerID=100&PickupAddressID=10&__RequestVerificationToken=client-token",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const body = (await response.json()) as ProblemBody;
    expect(body.type).toBe(BAD_GATEWAY_TYPE);
    expect(body.title).toBe("Upstream save failed");
    expect(body.status).toBe(502);
    expect(body.detail).toContain("SaveContainerForm");
    expect(body.instance).toBe("/api/v1/routeware/container/save-container-form");
  });

  it("address JSON success:false with HTTP 200 → 502 (explicit failure is not success)", async () => {
    // Arrange — an explicit failure flag inside a 200 body also fails the
    // routewarePostLooksSuccessful heuristic.
    behavior.saveBody = '{"success":false}';

    // Act
    const response = await call("/api/v1/routeware/address/save-address-form", {
      method: "POST",
      body: "PickupAddressID=10&CustomerID=5&__RequestVerificationToken=client-token",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const body = (await response.json()) as ProblemBody;
    expect(body.type).toBe(BAD_GATEWAY_TYPE);
  });

  it("address upstream 503 passes through unchanged (loud failures are not rewritten)", async () => {
    // Arrange
    behavior.saveStatus = 503;
    behavior.saveBody = "upstream down";
    behavior.saveContentType = "text/plain";

    // Act
    const response = await call("/api/v1/routeware/address/save-address-form", {
      method: "POST",
      body: "PickupAddressID=10&CustomerID=5&__RequestVerificationToken=client-token",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("upstream down");
  });

  it("container upstream 503 passes through unchanged (loud failures are not rewritten)", async () => {
    // Arrange
    behavior.saveStatus = 503;
    behavior.saveBody = "upstream down";
    behavior.saveContentType = "text/plain";

    // Act
    const response = await call("/api/v1/routeware/container/save-container-form", {
      method: "POST",
      body: "ContainerID=100&PickupAddressID=10&__RequestVerificationToken=client-token",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("upstream down");
  });
});
