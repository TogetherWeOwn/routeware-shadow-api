import { describe, expect, it, vi } from "vitest";

/**
 * TOG-8374: `detailFullD1Ops` must equal the real number of `db.batch()` calls
 * `syncCustomerDetailFullToD1` issues — sharing the batch-size constants is
 * not enough, because the calls-per-chunk fan-out lives inside the upsert
 * functions. This suite runs the real upserts (no `d1SnapshotSync` /
 * `snapshot/upsert` mocks) against a counting fake D1 and asserts the count
 * matches the model for several in-budget shapes. A mutant that changes the
 * real batching without updating the model fails here.
 */

const behavior: { responses: Array<() => Response> } = { responses: [] };

vi.mock("../src/lib/sessionState", () => ({
  readSessionState: async () => ({
    cookieHeader: "ASP.NET_SessionId=opmodel",
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

const { detailFullD1Ops, syncCustomerDetailFullToD1 } = await import(
  "../src/lib/detailFullSync"
);

type FakeStmt = { sql: string; args: unknown[] };

function countingD1() {
  const state = { batchCalls: 0, stmtCount: 0 };
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]): FakeStmt => ({ sql, args }),
      all: async () => ({ results: [] }),
      first: async () => null,
      run: async () => ({ success: true, meta: {} })
    }),
    batch: async (stmts: FakeStmt[]) => {
      state.batchCalls += 1;
      state.stmtCount += stmts.length;
      return stmts.map(() => ({ results: [], success: true, meta: {} }));
    }
  };
  return { db: db as unknown as D1Database, state };
}

const env = (db: D1Database) =>
  ({
    TARGET_ORIGIN: "https://killeen.example.test",
    TARGET_BASE_PATH: "/WebRW",
    LOGIN_URL: "https://killeen.example.test/WebRW/Account/Login",
    CUSTOMER_DB: db
  }) as unknown as Env;

const sessionStub = {} as unknown as DurableObjectStub;

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

/** `n` addresses with no containers. */
function addressOnlyGraph(n: number) {
  const data = [];
  for (let a = 1; a <= n; a += 1) {
    data.push({ PickupAddressID: 1000 + a, CustomerID: 5 });
  }
  return {
    currentCustomer: { CustomerID: 5, CompanyName: "Op Co", Enabled: true },
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

describe("detail-full D1 op model matches real batch calls", () => {
  it.each([
    { name: "empty graph", addresses: 0, containers: 0, make: () => addressOnlyGraph(0) },
    { name: "single address", addresses: 1, containers: 0, make: () => addressOnlyGraph(1) },
    {
      name: "400 addresses",
      addresses: 400,
      containers: 0,
      make: () => addressOnlyGraph(400)
    },
    {
      name: "one address with 320 containers",
      addresses: 1,
      containers: 320,
      make: () => containerGraph(320)
    }
  ])("$name issues exactly detailFullD1Ops(addresses, containers) batch calls", async ({
    addresses,
    containers,
    make
  }) => {
    // Arrange — real upserts, counting fake D1.
    const { db, state } = countingD1();
    behavior.responses = [() => json(make())];

    // Act
    const result = await syncCustomerDetailFullToD1(env(db), sessionStub, 5);

    // Assert — model and reality agree, and every row really landed.
    expect(state.batchCalls).toBe(detailFullD1Ops(addresses, containers));
    expect(result.addressIds).toHaveLength(addresses);
    expect(result.containerIds).toHaveLength(containers);
  });
});
