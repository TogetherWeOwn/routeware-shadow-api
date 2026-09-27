import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TOG-5937: the per-customer `GetCustomerDetailFull` fetch is unbounded by
 * design — upstream takes no paging parameters — so the sync path carries
 * explicit size guards instead. Past the guard the fetch/sync throws BEFORE
 * buffering the graph into the 128 MB isolate or fanning out D1/cache ops;
 * the POST handlers already catch sync errors and fall back to coarse cache
 * invalidation, so an oversized graph degrades to "D1 refresh skipped".
 *
 * Limits are 10x the proven-lossless 500-address x 8-container scale pinned in
 * `test/detailFullScaleSync.test.ts`. These tests pin the guard behaviour at
 * and just past each ceiling.
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
  DETAIL_FULL_MAX_ADDRESSES,
  DETAIL_FULL_MAX_CONTAINERS,
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
  it("fetches and syncs a graph exactly at the address ceiling", async () => {
    // Arrange
    behavior.responses = [() => json(addressOnlyGraph(DETAIL_FULL_MAX_ADDRESSES))];

    // Act
    const result = await syncCustomerDetailFullToD1(env, sessionStub, 5);

    // Assert — the ceiling itself is still a servable graph.
    expect(result.addressIds).toHaveLength(DETAIL_FULL_MAX_ADDRESSES);
    expect(calls.customers).toHaveLength(1);
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

  it("refuses a graph past the address ceiling without writing a partial graph", async () => {
    // Arrange
    behavior.responses = [() => json(addressOnlyGraph(DETAIL_FULL_MAX_ADDRESSES + 1))];

    // Act — the mapper throws before the first upsert, so D1 keeps the last
    // good snapshot instead of a truncated one.
    const error = (await syncCustomerDetailFullToD1(env, sessionStub, 5).catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("too large");
    expect(calls.customers).toEqual([]);
    expect(calls.addresses).toEqual([]);
    expect(calls.containers).toEqual([]);
  });

  it("refuses a graph past the container ceiling", async () => {
    // Arrange — one address carrying one container past the ceiling.
    const containers: Array<Record<string, unknown>> = [];
    for (let k = 1; k <= DETAIL_FULL_MAX_CONTAINERS + 1; k += 1) {
      containers.push({ ContainerID: k, PickupAddressID: 1001 });
    }
    behavior.responses = [
      () =>
        json({
          currentCustomer: { CustomerID: 5 },
          data: [{ PickupAddressID: 1001, CustomerID: 5, Containers: containers }]
        })
    ];

    // Act
    const error = (await syncCustomerDetailFullToD1(env, sessionStub, 5).catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("too large");
    expect(calls.customers).toEqual([]);
  });
});
