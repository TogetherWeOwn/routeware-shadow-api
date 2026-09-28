import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Matches wrangler.toml [env.test.vars]. Save routes sit behind the outer
// gate only (API token); snapshot import + data-entity routes sit behind the
// narrower sync-secret check on top of it.
const API_TOKEN = "test-api-token";
const SYNC_SECRET = "test-sync-secret";

// Verbatim literals, never problemType() output: recomputing the expected
// value with the function under test would let a base-URL change pass
// silently (same rule as test/addressContainerSaveNegativePath.test.ts).
const BAD_GATEWAY_TYPE =
  "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-gateway";
const BAD_REQUEST_TYPE =
  "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";

/**
 * TOG-6524 — save/snapshot negative-path sweep.
 *
 * Closes the gaps the issue lists, end to end through `src/app.ts`:
 *
 * - `integration.test.ts:227-257` pins saves only with an upstream JSON 200,
 *   never the CONVENTIONS.md §1 silent-failure shape (HTML page + HTTP 200).
 *   The dedicated `*SilentFailure` files pin the mapping at the route level;
 *   this file pins the 502 problem+json contract (anchored `type`,
 *   route-naming `detail`, `instance`) for all three save routes in one place.
 * - `shadowNegativePath` covers only `/shadow/*`; nothing asserted
 *   `GET …-snapshot/abc` → 400, `POST …/import` with an empty body → 400, or
 *   `GET /api/v1/data/customer` with no id → 400.
 * - The spoof test in `integration.test.ts:259` covers only `customers-read`;
 *   nothing asserted a client-supplied `X-Routeware-Shadow-Internal` is
 *   stripped on the three save routes (where the marker drives the
 *   anti-forgery modal fetch).
 *
 * Wording-drift note: this branch predates main's PROBLEMS.md-suffix pass,
 * so three titles/details differ between the two (`Upstream save failed` vs
 * `Bad Gateway`; `Empty body` vs `Bad Request`; `Bad request` vs
 * `Bad Request` + suffix). Assertions below accept both known wordings and
 * pin the stable core (status, anchored `type`, route-naming `detail`
 * substring, save `instance`) so the file is green on this branch AND after
 * the reviewer cherry-picks it onto `main`. The reviewer may tighten titles
 * to main's wording in the PR.
 *
 * Fixtures are synthetic (`ExampleCo`, fixed error strings) — no PII, no
 * secrets, no customer data. Explicit `__RequestVerificationToken` values
 * skip the anti-forgery modal fetch except where the modal flow itself is
 * the point.
 */

type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** No test in this file may reach upstream: throw instead of hitting net. */
function stubNoUpstream(): void {
  globalThis.fetch = vi.fn(async () => {
    throw new Error("Unexpected upstream fetch in negative-path sweep");
  }) as typeof fetch;
}

async function callApp(
  path: string,
  init: RequestInit = {},
  token: string = API_TOKEN
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return exports.default.fetch(`http://test.local${path}`, { ...init, headers });
}

// Routeware's silent-failure shape (CONVENTIONS.md §1). Synthetic fixture.
const HTML_200 =
  "<!DOCTYPE html><html><body>Object reference not set to an instance of an object (save failed)</body></html>";

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

describe("snapshot by-id rejects a non-numeric id with 400 (TOG-6524)", () => {
  beforeEach(() => {
    stubNoUpstream();
  });

  it.each([
    "/api/v1/customer-snapshot/abc",
    "/api/v1/address-snapshot/abc",
    "/api/v1/container-snapshot/abc"
  ])("GET %s → 400 without touching upstream or D1", async (path) => {
    // Act — the zod param schema rejects before any D1 query runs, and the
    // throwing fetch stub proves no upstream call was attempted either.
    // Status only: the validator answers before the handler's problem+json
    // shape, and its envelope is pinned at module level by
    // test/snapshotRoutes.test.ts.
    const res = await callApp(path);

    // Assert
    expect(res.status).toBe(400);
  });
});

describe("snapshot import rejects an empty body with 400 problem+json (TOG-6524)", () => {
  beforeEach(() => {
    stubNoUpstream();
  });

  it.each([
    {
      path: "/api/v1/customer-snapshot/import",
      detailCore: "POST the CSV file as the raw request body."
    },
    {
      path: "/api/v1/address-snapshot/import",
      detailCore: "POST the CSV as raw body."
    },
    {
      path: "/api/v1/container-snapshot/import",
      detailCore: "POST the CSV as raw body."
    }
  ])("POST $path with no body → 400 naming the missing CSV body", async (spec) => {
    // Act — sync secret clears both gates; the empty-body guard fires first.
    const res = await callApp(spec.path, { method: "POST" }, SYNC_SECRET);

    // Assert — title accepts both wordings (see drift note above).
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(BAD_REQUEST_TYPE);
    expect(["Bad Request", "Empty body"]).toContain(body.title);
    expect(body.status).toBe(400);
    // The container import on this branch omits `detail` entirely (main
    // carries it); pin the wording only where a detail is served. The
    // reviewer tightens this to main's wording in the PR.
    if (body.detail !== undefined) {
      expect(body.detail).toContain(spec.detailCore);
    }
  });
});

describe("GET /api/v1/data/customer without an id → 400 (TOG-6524)", () => {
  beforeEach(() => {
    stubNoUpstream();
  });

  it("returns 400 problem+json naming the missing id", async () => {
    // Act
    const res = await callApp("/api/v1/data/customer", {}, SYNC_SECRET);

    // Assert — title accepts both wordings (see drift note above).
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(BAD_REQUEST_TYPE);
    expect(["Bad Request", "Bad request"]).toContain(body.title);
    expect(body.detail).toContain("Query `id` or `customerId` (customer_id) is required.");
  });
});

describe("saves surface an upstream HTML-200 error page as 502 (TOG-6524)", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/WebRW/")) {
        return new Response(HTML_200, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        });
      }
      throw new Error(`Unexpected upstream fetch in test: ${url}`);
    }) as typeof fetch;
  });

  it.each([
    {
      path: "/api/v1/routeware/customer/save-long-form",
      body: "CustomerID=5&CompanyName=ExampleCo&__RequestVerificationToken=client-token",
      routeName: "SaveCustomerLongForm"
    },
    {
      path: "/api/v1/routeware/address/save-address-form",
      body: "PickupAddressID=10&CustomerID=5&__RequestVerificationToken=client-token",
      routeName: "SaveAddressForm"
    },
    {
      path: "/api/v1/routeware/container/save-container-form",
      body: "ContainerID=100&PickupAddressID=10&__RequestVerificationToken=client-token",
      routeName: "SaveContainerForm"
    }
  ])("POST $path HTML-200 → 502 with anchored type + instance", async (spec) => {
    // Act — explicit token skips the modal fetch; only the save matters.
    const res = await callApp(spec.path, {
      method: "POST",
      body: spec.body,
      headers: { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" }
    });

    // Assert — title accepts both wordings (see drift note above); the
    // route-naming detail substring + instance are stable on both sides.
    expect(res.status).toBe(502);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(BAD_GATEWAY_TYPE);
    expect(["Bad Gateway", "Upstream save failed"]).toContain(body.title);
    expect(body.status).toBe(502);
    expect(body.detail).toContain(`${spec.routeName} with HTTP 200`);
    expect(body.instance).toBe(spec.path);
  });
});

describe("client-supplied X-Routeware-Shadow-Internal is stripped on saves (TOG-6524)", () => {
  const SAVE_URLS = [
    "/WebRW/Customer/SaveCustomerLongForm",
    "/WebRW/PickupAddress/SaveAddressForm",
    "/WebRW/Container/SaveContainerForm"
  ];

  beforeEach(() => {
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (isModalFetch(init)) {
          return new Response(tokenHtml("SWEEP-MODAL-TOKEN"), {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" }
          });
        }
        if (SAVE_URLS.some((p) => url.includes(p))) {
          return new Response('{"success":true}', {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        if (url.includes("/WebRW/")) {
          return new Response(tokenHtml("SWEEP-MODAL-TOKEN"), {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" }
          });
        }
        throw new Error(`Unexpected upstream fetch in test: ${url}`);
      }
    ) as typeof fetch;
  });

  it.each([
    {
      path: "/api/v1/routeware/customer/save-long-form",
      body: "CustomerID=5&CompanyName=ExampleCo&__RequestVerificationToken=client-token",
      savePath: "/WebRW/Customer/SaveCustomerLongForm"
    },
    {
      path: "/api/v1/routeware/address/save-address-form",
      body: "PickupAddressID=10&CustomerID=5&__RequestVerificationToken=client-token",
      savePath: "/WebRW/PickupAddress/SaveAddressForm"
    },
    {
      path: "/api/v1/routeware/container/save-container-form",
      body: "ContainerID=100&PickupAddressID=10&__RequestVerificationToken=client-token",
      savePath: "/WebRW/Container/SaveContainerForm"
    }
  ])("POST $path never forwards the client marker ($savePath)", async (spec) => {
    // Act — client forges the internal marker alongside a real token.
    await callApp(spec.path, {
      method: "POST",
      body: spec.body,
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Routeware-Shadow-Internal": "anti-forgery-modal"
      }
    });

    // Assert — the save went upstream with no marker on any attempt.
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const saveCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes(spec.savePath)
    );
    expect(saveCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of saveCalls) {
      const init = call[1] as RequestInit;
      expect(
        new Headers(init.headers as HeadersInit).get("X-Routeware-Shadow-Internal")
      ).toBeNull();
    }
  });

  it("spoofed marker does not poison the server-side modal fetch (address edit flow)", async () => {
    // Act — no token posted, so the route fetches the edit modal server-side
    // even though the client forged the marker.
    const res = await callApp("/api/v1/routeware/address/save-address-form", {
      method: "POST",
      body: "PickupAddressID=10&CustomerID=5&Address=1+Main+St",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Routeware-Shadow-Internal": "anti-forgery-modal"
      }
    });

    // Assert — the save succeeded with the server-fetched token, and the save
    // itself carried no marker.
    expect(res.status).toBe(200);
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    const saveCalls = fetchMock.mock.calls.filter(
      (c: unknown[]) =>
        typeof c[0] === "string" &&
        (c[0] as string).includes("/WebRW/PickupAddress/SaveAddressForm")
    );
    expect(saveCalls.length).toBeGreaterThanOrEqual(1);
    const lastInit = saveCalls[saveCalls.length - 1][1] as RequestInit;
    expect(
      new Headers(lastInit.headers as HeadersInit).get("X-Routeware-Shadow-Internal")
    ).toBeNull();
    const forwarded = new TextDecoder().decode(lastInit.body as ArrayBuffer);
    expect(forwarded).toContain("__RequestVerificationToken=SWEEP-MODAL-TOKEN");
  });
});
