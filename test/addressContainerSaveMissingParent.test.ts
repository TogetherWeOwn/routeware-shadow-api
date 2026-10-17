import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";

// Verbatim literal, never problemType() output: recomputing the expected
// value with the function under test would let a base-URL change pass
// silently (same rule as test/problemAnchors.test.ts).
const BAD_REQUEST_TYPE =
  "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";

/**
 * A missing parent id on the create path is a client error.
 *
 * `POST /api/v1/routeware/address/save-address-form` with `PickupAddressID=0`
 * and no `CustomerID` key (and the analogous container case) threw inside
 * `prepareSave*FormBody` before any upstream fetch and fell into the generic
 * anti-forgery catch, surfacing as 502 bad-gateway. No upstream step failed,
 * so the 502 misdirected operators toward upstream-health investigation and
 * polluted bad-gateway alerting. Both routes now map these two throws to 400
 * bad-request problem+json, matching how GET load-long-modal validates
 * `customerID` to a 400.
 *
 * No explicit `__RequestVerificationToken` is posted, so the throw fires on
 * the modal path — the same path a real token-less client hits. The fetch
 * mock counts calls to prove zero upstream traffic happened.
 */

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${API_TOKEN}`);
  return exports.default.fetch(`http://test.local${path}`, { ...init, headers });
}

function tokenHtml(token: string): string {
  return `<form><input name="__RequestVerificationToken" type="hidden" value="${token}" /></form>`;
}

function isModalFetch(init?: RequestInit): boolean {
  if (!init || typeof init !== "object" || !("headers" in init) || !init.headers) {
    return false;
  }
  return (
    new Headers(init.headers as HeadersInit).get("X-Routeware-Shadow-Internal") ===
    "anti-forgery-modal"
  );
}

type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
};

const FORM = "application/x-www-form-urlencoded; charset=UTF-8";

describe("address/container save create without parent id", () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;

  beforeEach(() => {
    upstreamCalls = 0;
    // Rejects on ANY call: the missing-parent throw must fire before the
    // first upstream fetch. Edit-path tests below override this mock.
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      upstreamCalls += 1;
      throw new Error("Unexpected upstream fetch in test: none should happen");
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("address create without CustomerID → 400 with zero upstream calls", async () => {
    // Act — PickupAddressID=0 marks a create; no CustomerID key at all.
    const response = await call("/api/v1/routeware/address/save-address-form", {
      method: "POST",
      body: "PickupAddressID=0&Address=1+Main+St",
      headers: { "content-type": FORM }
    });

    // Assert — full problem+json contract, not just the status.
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const body = (await response.json()) as ProblemBody;
    expect(body.type).toBe(BAD_REQUEST_TYPE);
    expect(body.title).toBe("Bad Request");
    expect(body.status).toBe(400);
    expect(body.detail).toContain("New address requires CustomerID in POST body");
    expect(body.detail).toContain("docs/PROBLEMS.md#bad-request");
    expect(body.instance).toBe("/api/v1/routeware/address/save-address-form");
    expect(upstreamCalls).toBe(0);
  });

  it("container create without PickupAddressID → 400 with zero upstream calls", async () => {
    // Act — ContainerID=0 marks a create; no PickupAddressID key at all.
    const response = await call("/api/v1/routeware/container/save-container-form", {
      method: "POST",
      body: "ContainerID=0&Size=96",
      headers: { "content-type": FORM }
    });

    // Assert
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const body = (await response.json()) as ProblemBody;
    expect(body.type).toBe(BAD_REQUEST_TYPE);
    expect(body.title).toBe("Bad Request");
    expect(body.status).toBe(400);
    expect(body.detail).toContain("New container requires PickupAddressID in POST body");
    expect(body.detail).toContain("docs/PROBLEMS.md#bad-request");
    expect(body.instance).toBe("/api/v1/routeware/container/save-container-form");
    expect(upstreamCalls).toBe(0);
  });

  it("address empty body → 400 bad-request with zero upstream calls", async () => {
    // Act — empty urlencoded body; the guard must fire before the modal path.
    const response = await call("/api/v1/routeware/address/save-address-form", {
      method: "POST",
      body: "",
      headers: { "content-type": FORM }
    });

    // Assert — matches the customer save-long-form empty-body contract.
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const body = (await response.json()) as ProblemBody;
    expect(body.type).toBe(BAD_REQUEST_TYPE);
    expect(body.title).toBe("Bad Request");
    expect(body.status).toBe(400);
    expect(body.detail).toContain("SaveAddressForm fields");
    expect(body.instance).toBe("/api/v1/routeware/address/save-address-form");
    expect(upstreamCalls).toBe(0);
  });

  it("container empty body → 400 bad-request with zero upstream calls", async () => {
    // Act — empty urlencoded body; the guard must fire before the modal path.
    const response = await call("/api/v1/routeware/container/save-container-form", {
      method: "POST",
      body: "",
      headers: { "content-type": FORM }
    });

    // Assert
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const body = (await response.json()) as ProblemBody;
    expect(body.type).toBe(BAD_REQUEST_TYPE);
    expect(body.title).toBe("Bad Request");
    expect(body.status).toBe(400);
    expect(body.detail).toContain("SaveContainerForm fields");
    expect(body.instance).toBe("/api/v1/routeware/container/save-container-form");
    expect(upstreamCalls).toBe(0);
  });

  it("address edit without CustomerID still reaches upstream (400 is create-only)", async () => {
    // Arrange — the modal fetch is stubbed, so a token-less edit flows:
    // modal fetch → inject → forward → 200.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isModalFetch(init)) {
        return new Response(tokenHtml("MODAL-TOKEN"), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/WebRW/PickupAddress/SaveAddressForm")) {
        return new Response('{"success":true}', {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`Unexpected upstream fetch in test: ${url}`);
    }) as typeof fetch;

    // Act — PickupAddressID=10 marks an edit; CustomerID is not required.
    const response = await call("/api/v1/routeware/address/save-address-form", {
      method: "POST",
      body: "PickupAddressID=10&Address=1+Main+St",
      headers: { "content-type": FORM }
    });

    // Assert — the 400 mapping did not overreach into the edit path.
    expect(response.status).toBe(200);
  });

  it("container edit without PickupAddressID still reaches upstream (400 is create-only)", async () => {
    // Arrange — same stubbed modal flow for the container route.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (isModalFetch(init)) {
        return new Response(tokenHtml("MODAL-TOKEN"), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/WebRW/Container/SaveContainerForm")) {
        return new Response('{"success":true}', {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error(`Unexpected upstream fetch in test: ${url}`);
    }) as typeof fetch;

    // Act — ContainerID=100 marks an edit; PickupAddressID is not required.
    const response = await call("/api/v1/routeware/container/save-container-form", {
      method: "POST",
      body: "ContainerID=100&Size=96",
      headers: { "content-type": FORM }
    });

    // Assert
    expect(response.status).toBe(200);
  });
});
