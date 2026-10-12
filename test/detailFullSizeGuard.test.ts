import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TOG-5937 / R2-18: upstream `GetCustomerDetailFull` takes no paging
 * parameters, so the sync path guards two things. The response byte cap bounds
 * isolate memory before parsing. The D1 op budget bounds write fan-out and is
 * checked before the first write, so an over-budget graph leaves D1 untouched
 * rather than half-written. Row counts alone do not refuse a graph.
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
  DETAIL_FULL_MAX_D1_OPS,
  DETAIL_FULL_MAX_RESPONSE_BYTES,
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
  it("syncs a large-but-legit graph past the old address ceiling in full", async () => {
    // Arrange
    behavior.responses = [() => json(addressOnlyGraph(5_001))];

    // Act
    const result = await syncCustomerDetailFullToD1(env, sessionStub, 5);

    // Assert — 5,001 addresses are 65 ops (customer + 63 address batches + reconcile).
    expect(result.addressIds).toHaveLength(5_001);
    expect(calls.addresses.flat()).toHaveLength(5_001);
    expect(calls.customers).toHaveLength(1);
  });

  it("syncs a graph past the old container ceiling in full", async () => {
    // Arrange — 40,001 containers is 804 ops, inside the budget.
    behavior.responses = [() => json(containerGraph(40_001))];

    // Act
    const result = await syncCustomerDetailFullToD1(env, sessionStub, 5);

    // Assert
    expect(result.containerIds).toHaveLength(40_001);
    expect(calls.containers.flat()).toHaveLength(40_001);
  });

  it("syncs the largest graph that fits the D1 op budget", async () => {
    // Arrange — 1 customer + 1 address batch + 897 container batches + 1 reconcile = 900 ops.
    behavior.responses = [() => json(containerGraph(44_850))];

    // Act
    const result = await syncCustomerDetailFullToD1(env, sessionStub, 5);

    // Assert
    expect(DETAIL_FULL_MAX_D1_OPS).toBe(900);
    expect(result.containerIds).toHaveLength(44_850);
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
