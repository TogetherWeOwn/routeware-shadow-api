import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TOG-5819: mocked-upstream proof that the `GetCustomerDetailFull` sync path
 * (`src/lib/detailFullSync.ts`) handles large customer graphs without loss.
 *
 * The shadow `detail-full` route itself is a byte passthrough (pinned in
 * `test/customersReadPagination.test.ts`). This file pins the OTHER consumer
 * of the same upstream endpoint: `fetchGetCustomerDetailFull`, which every
 * POST to `/api/v1/data/*` calls to refresh D1 after a write, and
 * `mapDetailFullToRows`, which decides what the shadow copy contains.
 *
 * Neither function takes a page/window parameter — the graph for one customer
 * is fetched and mapped whole — so "truncation" here would look like dropped
 * addresses/containers or a silent partial upsert. The tests below generate
 * graphs an order of magnitude above the fixtures used elsewhere (500
 * addresses x 8 containers) and assert full counts end to end.
 */

type ForwardCall = { url: string; body: string | null };

const calls: {
  forwards: ForwardCall[];
  customers: unknown[][];
  addresses: unknown[][];
  containers: unknown[][];
} = { forwards: [], customers: [], addresses: [], containers: [] };

const behavior: { responses: Array<() => Response> } = { responses: [] };

vi.mock("../src/lib/sessionState", () => ({
  readSessionState: async () => ({
    cookieHeader: "ASP.NET_SessionId=scale",
    expiresAtMs: null,
    refreshing: false
  })
}));

vi.mock("../src/lib/establishSession", () => ({
  establishSession: async () => {}
}));

vi.mock("../src/lib/upstreamForward", () => ({
  forwardToUpstream: async (
    _incoming: Request,
    upstreamUrl: URL,
    _session: unknown,
    bodyBuffer: ArrayBuffer | null
  ) => {
    calls.forwards.push({
      url: upstreamUrl.toString(),
      body: bodyBuffer ? new TextDecoder().decode(bodyBuffer) : null
    });
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
  fetchGetCustomerDetailFull,
  syncCustomerDetailFullToD1,
  mapDetailFullToRows
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

/** A customer graph far above the 2-address fixtures used elsewhere. */
function largeGraph(addresses: number, containersPerAddress: number) {
  const data = [];
  let containerId = 1;
  for (let a = 1; a <= addresses; a += 1) {
    const containers = [];
    for (let k = 0; k < containersPerAddress; k += 1) {
      containers.push({
        ContainerID: containerId,
        PickupAddressID: 1000 + a,
        SerialNumber: `SN-${containerId}`
      });
      containerId += 1;
    }
    data.push({
      PickupAddressID: 1000 + a,
      CustomerID: 5,
      Address: `${a} Scale Ave`,
      Containers: containers
    });
  }
  return {
    currentCustomer: { CustomerID: 5, CompanyName: "Scale Co", Enabled: true },
    data
  };
}

beforeEach(() => {
  calls.forwards = [];
  calls.customers = [];
  calls.addresses = [];
  calls.containers = [];
  behavior.responses = [];
});

describe("detail-full sync at scale", () => {
  it("fetches one unpaged graph per customer id (no start/limit sent upstream)", async () => {
    // Arrange
    behavior.responses = [() => json(largeGraph(3, 2))];

    // Act
    await fetchGetCustomerDetailFull(env, sessionStub, 5, true);

    // Assert — the sync path sends only the id + flag; any paging of a large
    // graph would have to happen here, and it does not.
    expect(calls.forwards).toHaveLength(1);
    expect(calls.forwards[0].body).toBe('{"customerID":5,"showDisabled":true}');
  });

  it("maps a 500-address x 8-container graph with no dropped rows", async () => {
    // Arrange
    const payload = largeGraph(500, 8);
    behavior.responses = [() => json(payload)];

    // Act
    const full = await fetchGetCustomerDetailFull(env, sessionStub, 5, true);
    const { customer, addresses, containers } = mapDetailFullToRows(full);

    // Assert
    expect(customer.customerId).toBe(5);
    expect(addresses).toHaveLength(500);
    expect(containers).toHaveLength(4000);
    expect(addresses[499].pickupAddressId).toBe(1500);
    expect(containers[3999].containerId).toBe(4000);
  });

  it("upserts the whole graph to D1 and returns every id for cache invalidation", async () => {
    // Arrange — `syncCustomerDetailFullToD1` feeds `invalidateCustomerGraph`;
    // a truncated id list would leave stale rows cached after a write.
    behavior.responses = [() => json(largeGraph(500, 8))];

    // Act
    const result = await syncCustomerDetailFullToD1(env, sessionStub, 5);

    // Assert
    expect(calls.customers).toHaveLength(1);
    expect(calls.addresses.flat()).toHaveLength(500);
    expect(calls.containers.flat()).toHaveLength(4000);
    expect(result.addressIds).toHaveLength(500);
    expect(result.containerIds).toHaveLength(4000);
    expect(result.addressIds[0]).toBe(1001);
    expect(result.containerIds[3999]).toBe(4000);
  });
});
