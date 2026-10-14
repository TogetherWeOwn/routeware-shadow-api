import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TOG-24257 acceptance pin for PR #255 (TOG-8374): detail-full graphs are
 * sized by the D1 op budget, not by row count.
 *
 * Failing-first contract: every budget test below is RED on the pre-#255
 * row-count implementation (`DETAIL_FULL_MAX_ADDRESSES` /
 * `DETAIL_FULL_MAX_CONTAINERS` throws in `mapDetailFullToRows`, no
 * `detailFullD1Ops` export) and GREEN on the PR head (op-budget pre-write
 * guard, mapper without row-count ceilings). The control test is green on
 * both and proves the harness itself works.
 *
 * Test files only; no production code is touched.
 */

const calls: {
  customers: unknown[][];
  addresses: unknown[][];
  containers: unknown[][];
} = { customers: [], addresses: [], containers: [] };

const behavior: { responses: Array<() => Response> } = { responses: [] };

vi.mock("../src/lib/sessionState", () => ({
  readSessionState: async () => ({
    cookieHeader: "ASP.NET_SessionId=op-budget-acceptance",
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

const syncModule = await import("../src/lib/detailFullSync");
const {
  DETAIL_FULL_MAX_D1_OPS,
  detailFullD1Ops,
  mapDetailFullToRows,
  syncCustomerDetailFullToD1
} = syncModule as typeof import("../src/lib/detailFullSync") & {
  DETAIL_FULL_MAX_ADDRESSES?: number;
  DETAIL_FULL_MAX_CONTAINERS?: number;
};

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
    currentCustomer: { CustomerID: 5, CompanyName: "Budget Co", Enabled: true },
    data
  };
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

beforeEach(() => {
  calls.customers = [];
  calls.addresses = [];
  calls.containers = [];
  behavior.responses = [];
});

describe("detail-full D1 op-budget sizing acceptance (PR #255)", () => {
  it("exports the D1 op budget and no row-count ceilings", () => {
    // Arrange / Act — row-count sizing exposes MAX_ADDRESSES / MAX_CONTAINERS
    // and no op-budget export; budget sizing is the reverse.

    // Assert
    expect(DETAIL_FULL_MAX_D1_OPS).toBe(900);
    expect(typeof detailFullD1Ops).toBe("function");
    expect(
      (syncModule as Record<string, unknown>).DETAIL_FULL_MAX_ADDRESSES
    ).toBeUndefined();
    expect(
      (syncModule as Record<string, unknown>).DETAIL_FULL_MAX_CONTAINERS
    ).toBeUndefined();
  });

  it("prices a 5,001-address graph inside the D1 op budget", () => {
    // Arrange — 5,001 addresses trip the old 5,000 row-count ceiling, but at
    // 80 rows per batch they cost 1 (customer) + 63 (address batches) + 1
    // (reconcile) = 65 D1 ops: inside the 900-op budget.

    // Act
    const ops = detailFullD1Ops(5_001, 0);

    // Assert
    expect(ops).toBe(65);
    expect(ops).toBeLessThanOrEqual(DETAIL_FULL_MAX_D1_OPS);
  });

  it("maps a 5,001-address graph without a row-count refusal", () => {
    // Arrange — one address past the old ceiling.

    // Act
    const { addresses } = mapDetailFullToRows(addressOnlyGraph(5_001));

    // Assert — budget sizing maps first and lets the pre-write guard decide.
    expect(addresses).toHaveLength(5_001);
  });

  it("refuses a 901-op graph before the first write with D1 untouched", async () => {
    // Arrange — one address carrying 44,851 containers costs
    // 1 + 1 (address batch) + 898 (container batches) + 1 = 901 D1 ops:
    // one batch past the budget.
    behavior.responses = [() => json(containerGraph(44_851))];

    // Act — the budget is checked before the first upsert, so D1 keeps the
    // last good snapshot instead of a truncated one.
    const error = (await syncCustomerDetailFullToD1(env, sessionStub, 5).catch(
      (e: unknown) => e
    )) as Error;

    // Assert — the refusal is worded in budget terms, not row-count terms.
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("too large");
    expect(error.message).toContain("901 D1 ops");
    expect(calls.customers).toEqual([]);
    expect(calls.addresses).toEqual([]);
    expect(calls.containers).toEqual([]);
  });

  it("control: syncs a 400-address graph in full on either sizing model", async () => {
    // Arrange — 400 addresses fit the old 5,000 row cap (7 D1 ops,
    // 802 cache invalidations: inside both PR budgets), so this is green
    // before and after #255 and proves the harness works.
    behavior.responses = [() => json(addressOnlyGraph(400))];

    // Act
    const result = await syncCustomerDetailFullToD1(env, sessionStub, 5);

    // Assert
    expect(result.addressIds).toHaveLength(400);
    expect(calls.customers).toHaveLength(1);
    expect(calls.addresses.flat()).toHaveLength(400);
  });
});
