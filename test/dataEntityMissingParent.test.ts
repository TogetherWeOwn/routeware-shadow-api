import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Matches wrangler.toml [env.test.vars]. Data-tier routes carry a narrower
// inner gate on top of the app-wide bearer check: they require
// CUSTOMER_SNAPSHOT_SYNC_SECRET specifically.
const SYNC_SECRET = "test-sync-secret";

// Verbatim literal, never problemType() output: recomputing the expected
// value with the function under test would let a base-URL change pass
// silently (same rule as test/problemAnchors.test.ts).
const BAD_REQUEST_TYPE =
  "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";

/**
 * TOG-8463 — a missing parent id on the data-tier create path is a client
 * error, not a gateway error.
 *
 * `POST /api/v1/data/address` with `PickupAddressID=0` and no `CustomerID`
 * key (and the analogous container case) threw inside `prepareSave*FormBody`
 * before any upstream fetch and fell into the data-entity catch that maps
 * ALL prep throwns to 502 bad-gateway. The routeware tier already maps these
 * two fixed messages to 400 (`src/routes/address.ts`, `src/routes/container.ts`,
 * pinned by `test/addressContainerSaveMissingParent.test.ts` TOG-8148); the
 * data tier now matches. Other prep failures (modal fetch down, missing
 * token in modal HTML) stay 502.
 *
 * No explicit `__RequestVerificationToken` is posted, so the throw fires on
 * the modal path — the same path a real token-less client hits. The fetch
 * mock counts calls to prove zero upstream traffic happened.
 */

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${SYNC_SECRET}`);
  return exports.default.fetch(`http://test.local${path}`, { ...init, headers });
}

type ProblemBody = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
};

const FORM = "application/x-www-form-urlencoded; charset=UTF-8";

describe("data-tier save create without parent id (TOG-8463)", () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;

  beforeEach(() => {
    upstreamCalls = 0;
    // Rejects on ANY call: the missing-parent throw must fire before the
    // first upstream fetch. The 502-control test below overrides this mock.
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
    const response = await call("/api/v1/data/address", {
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
    expect(body.instance).toBe("/api/v1/data/address");
    expect(upstreamCalls).toBe(0);
  });

  it("container create without PickupAddressID → 400 with zero upstream calls", async () => {
    // Act — ContainerID=0 marks a create; no PickupAddressID key at all.
    const response = await call("/api/v1/data/container", {
      method: "POST",
      body: "ContainerID=0&SerialNumber=X",
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
    expect(body.instance).toBe("/api/v1/data/container");
    expect(upstreamCalls).toBe(0);
  });

  it("other prep failures still → 502 (the 400 mapping is message-scoped)", async () => {
    // Arrange — an edit-shaped body gets past the missing-parent guard, then
    // the modal fetch fails: that throw must stay a gateway error.
    globalThis.fetch = vi.fn(async (): Promise<Response> => {
      upstreamCalls += 1;
      return new Response("upstream down", { status: 500 });
    }) as typeof fetch;

    // Act — PickupAddressID=10 marks an edit; CustomerID is not required.
    const response = await call("/api/v1/data/address", {
      method: "POST",
      body: "PickupAddressID=10&Address=1+Main+St",
      headers: { "content-type": FORM }
    });

    // Assert — the 400 mapping did not swallow a genuine upstream failure.
    expect(response.status).toBe(502);
    const body = (await response.json()) as ProblemBody;
    expect(body.title).toBe("Bad Gateway");
    expect(body.status).toBe(502);
    expect(upstreamCalls).toBeGreaterThan(0);
  });
});
