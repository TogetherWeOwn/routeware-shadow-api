import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Matches wrangler.toml [env.test.vars].
const API_TOKEN = "test-api-token";

/**
 * Parity with the customer guard.
 *
 * `POST /api/v1/routeware/address/save-address-form` and
 * `POST /api/v1/routeware/container/save-container-form` auto-inject
 * `__RequestVerificationToken` from the Routeware modal (same as
 * `save-long-form`), but unlike `save-long-form` they forwarded an upstream
 * HTML error page with HTTP 200 verbatim, so the client saw 200 and no signal
 * the save failed. Both routes now apply the same
 * `routewarePostLooksSuccessful` heuristic and surface that silent-failure
 * shape as 502 problem+json.
 *
 * The modal fetch is stubbed here (token HTML on the internal-marker
 * requests), so posting *without* a token exercises the full path: modal
 * fetch → inject → forward → guard.
 */

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${API_TOKEN}`);
  return exports.default.fetch(`http://test.local${path}`, { ...init, headers });
}

function tokenHtml(token: string): string {
  return `<form><input name="__RequestVerificationToken" type="hidden" value="${token}" /></form>`;
}

const behavior = {
  saveStatus: 200,
  saveBody: '{"success":true}',
  saveContentType: "application/json",
  modalStatus: 200,
  modalBody: tokenHtml("MODAL-TOKEN")
};

function isModalFetch(init?: RequestInit): boolean {
  if (!init || typeof init !== "object" || !("headers" in init) || !init.headers) {
    return false;
  }
  return (
    new Headers(init.headers as HeadersInit).get("X-Routeware-Shadow-Internal") ===
    "anti-forgery-modal"
  );
}

describe("address/container save silent-failure guard", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    behavior.saveStatus = 200;
    behavior.saveBody = '{"success":true}';
    behavior.saveContentType = "application/json";
    behavior.modalStatus = 200;
    behavior.modalBody = tokenHtml("MODAL-TOKEN");
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (isModalFetch(init)) {
        return new Response(behavior.modalBody, {
          status: behavior.modalStatus,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
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

  function forwardedSaveBody(savePath: string): string {
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const saveCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes(savePath)
    );
    expect(saveCalls.length).toBeGreaterThanOrEqual(1);
    const saveInit = saveCalls[saveCalls.length - 1][1] as RequestInit;
    return new TextDecoder().decode(saveInit.body as ArrayBuffer);
  }

  it("posts an address save without a token and succeeds (edit flow)", async () => {
    // Act — no __RequestVerificationToken in the posted form.
    const response = await call("/api/v1/routeware/address/save-address-form", {
      method: "POST",
      body: "PickupAddressID=10&CustomerID=5&Address=1+Main+St",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert — the modal token was injected before forwarding, and the
    // upstream JSON success passes through as 200.
    expect(response.status).toBe(200);
    const forwarded = forwardedSaveBody("/WebRW/PickupAddress/SaveAddressForm");
    expect(forwarded).toContain("__RequestVerificationToken=MODAL-TOKEN");
    expect(forwarded).toContain("PickupAddressID=10");
  });

  it("surfaces an upstream address HTML-200 error page as 502 problem+json", async () => {
    // Arrange — Routeware's normal silent-failure shape (CONVENTIONS.md §1).
    behavior.saveBody =
      "<!DOCTYPE html><html><body>Object reference not set to an instance of an object (save failed)</body></html>";
    behavior.saveContentType = "text/html; charset=utf-8";

    // Act — explicit token skips the modal fetch; only the save matters.
    const response = await call("/api/v1/routeware/address/save-address-form", {
      method: "POST",
      body: "PickupAddressID=10&CustomerID=5&__RequestVerificationToken=client-token",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("problem+json");
    const body = (await response.json()) as { title: string; status: number; detail: string };
    expect(body.title).toBe("Bad Gateway");
    expect(body.status).toBe(502);
    expect(body.detail).toContain("SaveAddressForm");
  });

  it("surfaces a failed address token fetch as 502 naming the token step", async () => {
    // Arrange — the modal itself is unreachable.
    behavior.modalStatus = 500;
    behavior.modalBody = "gone";

    // Act — no token posted, so the route must fetch one first.
    const response = await call("/api/v1/routeware/address/save-address-form", {
      method: "POST",
      body: "PickupAddressID=10&CustomerID=5&Address=1+Main+St",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert — 502, not a silent 200, and the detail names the modal step.
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("problem+json");
    const body = (await response.json()) as { title: string; status: number; detail: string };
    expect(body.title).toBe("Bad Gateway");
    expect(body.detail).toContain("LoadAddressModal");
    expect(body.detail).toContain("HTTP 500");
  });

  it("posts a container save without a token and succeeds (create flow)", async () => {
    // Act — ContainerID=0 marks a create, so the blank-container modal is used.
    const response = await call("/api/v1/routeware/container/save-container-form", {
      method: "POST",
      body: "ContainerID=0&PickupAddressID=10&Size=96",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert
    expect(response.status).toBe(200);
    const forwarded = forwardedSaveBody("/WebRW/Container/SaveContainerForm");
    expect(forwarded).toContain("__RequestVerificationToken=MODAL-TOKEN");
    expect(forwarded).toContain("ContainerID=0");
  });

  it("surfaces an upstream container HTML-200 error page as 502 problem+json", async () => {
    // Arrange
    behavior.saveBody =
      "<!DOCTYPE html><html><body>Object reference not set to an instance of an object (save failed)</body></html>";
    behavior.saveContentType = "text/html; charset=utf-8";

    // Act
    const response = await call("/api/v1/routeware/container/save-container-form", {
      method: "POST",
      body: "ContainerID=100&PickupAddressID=10&__RequestVerificationToken=client-token",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("problem+json");
    const body = (await response.json()) as { title: string; status: number; detail: string };
    expect(body.title).toBe("Bad Gateway");
    expect(body.status).toBe(502);
    expect(body.detail).toContain("SaveContainerForm");
  });

  it("surfaces a tokenless container modal as 502 naming the token step", async () => {
    // Arrange — the modal answers 200 but carries no token (layout change).
    behavior.modalBody = "<form></form>";

    // Act — no token posted, so the route must parse one from the modal HTML.
    const response = await call("/api/v1/routeware/container/save-container-form", {
      method: "POST",
      body: "ContainerID=100&PickupAddressID=10&Size=96",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("problem+json");
    const body = (await response.json()) as { title: string; status: number; detail: string };
    expect(body.title).toBe("Bad Gateway");
    expect(body.detail).toContain("__RequestVerificationToken");
  });
});
