import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TOG-5937 / R2-18: upstream `GetCustomerDetailFull` takes no paging
 * parameters, so the sync path guards three things. The response byte cap bounds
 * isolate memory before parsing. The D1 op budget bounds write fan-out and the
 * cache-invalidation budget bounds the per-id `caches.default.delete` fan-out
 * every caller runs after the sync — both are checked before the first write,
 * so an over-budget graph leaves D1 untouched rather than half-written. Row
 * counts alone do not refuse a graph.
 */

const calls: {
  customers: unknown[][];
  addresses: unknown[][];
  containers: unknown[][];
} = { customers: [], addresses: [], containers: [] };

const behavior: { responses: Array<() => Response> } = { responses: [] };

vi.mock("../src/lib/sessionState", () => ({
  readSessionState: async () => ({
    cookieHeader: "ASP.NET_SessionId=guard",
    expiresAtMs: null,
    refreshing: false
  })
}));

vi.mock("../src/lib/establishSession", () => ({
  establishSession: async () => {}
}));

vi.mock("../src/lib/upstreamForward", () => ({
  forwardToUpstream: async () => {
    const next = behavior.responses.shift();
    return next ? next() : new Response("{}", { status: 200 });
  }
}));

vi.mock("../src/lib/snapshot/upsert", () => ({
  reconcileCustomerChildren: async () => ({ addressIds: [], containerIds: [] })
}));

vi.mock("../src/lib/d1SnapshotSync", () => ({
  upsertCustomerSnapshotRows: async (_db: unknown, rows: unknown[]) => {
    calls.customers.push(rows);
    return { upserted: rows.length };
  },
  upsertAddressSnapshotRows: async (_db: unknown, rows: unknown[]) => {
    calls.addresses.push(rows);
    return { upserted: rows.length };
  },
  upsertContainerSnapshotRows: async (_db: unknown, rows: unknown[]) => {
    calls.containers.push(rows);
    return { upserted: rows.length };
  }
}));

const {
  DETAIL_FULL_MAX_CACHE_INVALIDATIONS,
  DETAIL_FULL_MAX_D1_OPS,
  DETAIL_FULL_MAX_RESPONSE_BYTES,
  detailFullCacheInvalidations,
  detailFullD1Ops,
  fetchGetCustomerDetailFull,
  syncCustomerDetailFullToD1
} = await import("../src/lib/detailFullSync");

const env = {
  TARGET_ORIGIN: "https://killeen.example.test",
  TARGET_BASE_PATH: "/WebRW",
  LOGIN_URL: "https://killeen.example.test/WebRW/Account/Login",
  CUSTOMER_DB: {} as unknown as D1Database
} as unknown as Env;

const sessionStub = {} as unknown as DurableObjectStub;

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

/** One address carrying `n` containers. */
function containerGraph(n: number) {
  const containers: Array<Record<string, unknown>> = [];
  for (let k = 1; k <= n; k += 1) {
    containers.push({ ContainerID: k, PickupAddressID: 1001 });
  }
  return {
    currentCustomer: { CustomerID: 5 },
    data: [{ PickupAddressID: 1001, CustomerID: 5, Containers: containers }]
  };
}

/** Minimal graph of `n` addresses with no containers. */
function addressOnlyGraph(n: number) {
  const data = [];
  for (let a = 1; a <= n; a += 1) {
    data.push({ PickupAddressID: 1000 + a, CustomerID: 5 });
  }
  return {
    currentCustomer: { CustomerID: 5, CompanyName: "Guard Co", Enabled: true },
    data
  };
}

beforeEach(() => {
  calls.customers = [];
  calls.addresses = [];
  calls.containers = [];
  behavior.responses = [];
});

describe("detail-full size guards", () => {
  it("syncs a graph inside both budgets in full", async () => {
    // Arrange — 400 addresses are 7 D1 ops and 802 cache invalidations.
    behavior.responses = [() => json(addressOnlyGraph(400))];

    // Act
    const result = await syncCustomerDetailFullToD1(env, sessionStub, 5);

    // Assert
    expect(result.addressIds).toHaveLength(400);
    expect(calls.addresses.flat()).toHaveLength(400);
    expect(calls.customers).toHaveLength(1);
  });

  it("syncs the largest graph that fits the cache-invalidation budget", async () => {
    // Arrange — 1 address + 448 containers is 449 ids = 898 invalidations
    // (2 passes) and 12 D1 ops, inside both budgets.
    behavior.responses = [() => json(containerGraph(448))];

    // Act
    const result = await syncCustomerDetailFullToD1(env, sessionStub, 5);

    // Assert
    expect(DETAIL_FULL_MAX_CACHE_INVALIDATIONS).toBe(900);
    expect(result.containerIds).toHaveLength(448);
    expect(calls.containers.flat()).toHaveLength(448);
  });

  it("syncs a graph at exactly the cache-invalidation budget", async () => {
    // Arrange — 449 addresses is (1 + 449) * 2 = 900 invalidations: at, not over.
    behavior.responses = [() => json(addressOnlyGraph(449))];

    // Act
    const result = await syncCustomerDetailFullToD1(env, sessionStub, 5);

    // Assert
    expect(result.addressIds).toHaveLength(449);
  });

  it("refuses a graph one id past the cache-invalidation budget without writing", async () => {
    // Arrange — 450 addresses is (1 + 450) * 2 = 902 invalidations.
    behavior.responses = [() => json(addressOnlyGraph(450))];

    // Act
    const error = (await syncCustomerDetailFullToD1(env, sessionStub, 5).catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("too large");
    expect(error.message).toContain("902 cache invalidations");
    expect(calls.customers).toEqual([]);
    expect(calls.addresses).toEqual([]);
    expect(calls.containers).toEqual([]);
  });

  it("refuses a 5,001-address graph on cache fan-out even though its D1 ops fit", async () => {
    // Arrange — 65 D1 ops is inside the D1 budget, but (1 + 5,001) * 2 =
    // 10,004 cache deletes would exhaust the per-request Cache API quota.
    behavior.responses = [() => json(addressOnlyGraph(5_001))];

    // Act
    const error = (await syncCustomerDetailFullToD1(env, sessionStub, 5).catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("too large");
    expect(error.message).toContain("10004 cache invalidations");
    expect(calls.customers).toEqual([]);
    expect(calls.addresses).toEqual([]);
    expect(calls.containers).toEqual([]);
  });

  it("refuses a 40,001-container graph on cache fan-out even though its D1 ops fit", async () => {
    // Arrange — 804 D1 ops is inside the D1 budget, but (1 + 1 + 40,001) * 2 =
    // 80,006 cache deletes would exhaust the per-request Cache API quota.
    behavior.responses = [() => json(containerGraph(40_001))];

    // Act
    const error = (await syncCustomerDetailFullToD1(env, sessionStub, 5).catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("too large");
    expect(error.message).toContain("80006 cache invalidations");
    expect(calls.customers).toEqual([]);
    expect(calls.addresses).toEqual([]);
    expect(calls.containers).toEqual([]);
  });

  it("pins the D1 op model arithmetic used by the pre-write guard", () => {
    // These pure-function pins — including the reviewer's probed shapes (65 ops
    // for 5,001 addresses, 403 for one address carrying 20,000 containers) —
    // kill model-level drift; the through-the-real-upserts pin lives in
    // test/detailFullOpModel.test.ts.
    expect(DETAIL_FULL_MAX_D1_OPS).toBe(900);
    expect(detailFullD1Ops(5_001, 0)).toBe(65);
    expect(detailFullD1Ops(1, 20_000)).toBe(403);
    expect(detailFullD1Ops(1, 44_850)).toBe(900);
    expect(detailFullD1Ops(1, 44_851)).toBe(901);
  });

  it("pins the cache-invalidation model arithmetic used by the pre-write guard", () => {
    // One delete per graph id (customer + addresses + containers), worst case
    // over both retry passes.
    expect(DETAIL_FULL_MAX_CACHE_INVALIDATIONS).toBe(900);
    expect(detailFullCacheInvalidations(0, 0)).toBe(2);
    expect(detailFullCacheInvalidations(449, 0)).toBe(900);
    expect(detailFullCacheInvalidations(450, 0)).toBe(902);
    expect(detailFullCacheInvalidations(5_001, 0)).toBe(10_004);
    expect(detailFullCacheInvalidations(1, 40_001)).toBe(80_006);
  });

  it("refuses an oversized response body before parsing it", async () => {
    // Arrange — one byte past the ceiling; invalid JSON on purpose, to prove
    // the guard fires before JSON.parse ever runs.
    behavior.responses = [
      () => new Response("x".repeat(DETAIL_FULL_MAX_RESPONSE_BYTES + 1), { status: 200 })
    ];

    // Act
    const error = (await fetchGetCustomerDetailFull(env, sessionStub, 5, true).catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("response too large");
    expect(error.message).toContain("customer 5");
  });

  it("refuses a graph one batch past the op budget without writing a partial graph", async () => {
    // Arrange — 44,851 containers is 901 ops: one container batch over the budget.
    behavior.responses = [() => json(containerGraph(44_851))];

    // Act — the budget is checked before the first upsert, so D1 keeps the
    // last good snapshot instead of a truncated one.
    const error = (await syncCustomerDetailFullToD1(env, sessionStub, 5).catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("too large");
    expect(error.message).toContain("901 D1 ops");
    expect(calls.customers).toEqual([]);
    expect(calls.addresses).toEqual([]);
    expect(calls.containers).toEqual([]);
  });
});
