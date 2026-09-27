import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The network and D1 half of `src/lib/detailFullSync.ts`, which every POST to
 * `/api/v1/data/*` calls to refresh the shadow copy after a write.
 *
 * The branch that matters is the re-auth retry. Routeware answers an expired
 * session with a redirect or a non-200 rather than a 401, so the first attempt
 * is expected to fail routinely; if the retry were skipped or the session not
 * re-read after `establishSession`, every write would leave D1 stale while the
 * upstream save still succeeded — the exact failure the POST handlers' catch
 * block then papers over.
 */

type ForwardCall = { url: string; body: string | null; cookie: string | null };

const calls: {
  forwards: ForwardCall[];
  established: number;
  sessionReads: number;
  customers: unknown[][];
  addresses: unknown[][];
  containers: unknown[][];
} = {
  forwards: [],
  established: 0,
  sessionReads: 0,
  customers: [],
  addresses: [],
  containers: []
};

const behavior: { responses: Array<() => Response> } = { responses: [] };

vi.mock("../src/lib/sessionState", () => ({
  readSessionState: async () => {
    calls.sessionReads += 1;
    return {
      cookieHeader: `ASP.NET_SessionId=s${calls.sessionReads}`,
      expiresAtMs: null,
      refreshing: false
    };
  }
}));

vi.mock("../src/lib/establishSession", () => ({
  establishSession: async () => {
    calls.established += 1;
  }
}));

vi.mock("../src/lib/upstreamForward", () => ({
  forwardToUpstream: async (
    _incoming: Request,
    upstreamUrl: URL,
    session: { cookieHeader: string | null } | null,
    bodyBuffer: ArrayBuffer | null
  ) => {
    calls.forwards.push({
      url: upstreamUrl.toString(),
      body: bodyBuffer ? new TextDecoder().decode(bodyBuffer) : null,
      cookie: session?.cookieHeader ?? null
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

const { fetchGetCustomerDetailFull, syncCustomerDetailFullToD1 } = await import(
  "../src/lib/detailFullSync"
);

const env = {
  TARGET_ORIGIN: "https://killeen.example.test",
  TARGET_BASE_PATH: "/WebRW",
  LOGIN_URL: "https://killeen.example.test/WebRW/Account/Login",
  CUSTOMER_DB: {} as unknown as D1Database
} as unknown as Env;

const sessionStub = {} as unknown as DurableObjectStub;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

const DETAIL_FULL = {
  currentCustomer: { CustomerID: 5, CompanyName: "Acme", Enabled: true },
  data: [
    {
      PickupAddressID: 10,
      CustomerID: 5,
      Address: "1 Main St",
      Containers: [{ ContainerID: 100 }, { ContainerID: 101 }]
    },
    { PickupAddressID: 11, CustomerID: 5, Address: "2 Side St" }
  ]
};

beforeEach(() => {
  calls.forwards = [];
  calls.established = 0;
  calls.sessionReads = 0;
  calls.customers = [];
  calls.addresses = [];
  calls.containers = [];
  behavior.responses = [];
});

describe("fetchGetCustomerDetailFull", () => {
  it("posts the customer id and showDisabled flag to the WebRW endpoint", async () => {
    // Arrange
    behavior.responses = [() => json(DETAIL_FULL)];

    // Act
    await fetchGetCustomerDetailFull(env, sessionStub, 5, true);

    // Assert
    expect(calls.forwards).toHaveLength(1);
    expect(calls.forwards[0].url).toBe(
      "https://killeen.example.test/WebRW/Customer/GetCustomerDetailFull"
    );
    expect(calls.forwards[0].body).toBe('{"customerID":5,"showDisabled":true}');
  });

  it("passes showDisabled through as false when asked", async () => {
    // Arrange
    behavior.responses = [() => json(DETAIL_FULL)];

    // Act
    await fetchGetCustomerDetailFull(env, sessionStub, 7, false);

    // Assert
    expect(calls.forwards[0].body).toBe('{"customerID":7,"showDisabled":false}');
  });

  it("returns the parsed payload without re-authenticating on a 200", async () => {
    // Arrange
    behavior.responses = [() => json(DETAIL_FULL)];

    // Act
    const result = await fetchGetCustomerDetailFull(env, sessionStub, 5, true);

    // Assert
    expect(result.currentCustomer).toEqual({ CustomerID: 5, CompanyName: "Acme", Enabled: true });
    expect(calls.established).toBe(0);
    expect(calls.forwards).toHaveLength(1);
  });

  it("re-establishes the session and retries once after a non-200", async () => {
    // Arrange — an expired upstream session shows up as a redirect, not a 401.
    behavior.responses = [
      () => new Response("", { status: 302, headers: { location: "/Account/Login" } }),
      () => json(DETAIL_FULL)
    ];

    // Act
    const result = await fetchGetCustomerDetailFull(env, sessionStub, 5, true);

    // Assert
    expect(calls.established).toBe(1);
    expect(calls.forwards).toHaveLength(2);
    expect(result.currentCustomer).toBeTruthy();
  });

  it("re-reads the session after re-authenticating rather than reusing the stale one", async () => {
    // Arrange — reusing the pre-login cookie would make the retry fail exactly
    // like the first attempt.
    behavior.responses = [() => new Response("", { status: 500 }), () => json(DETAIL_FULL)];

    // Act
    await fetchGetCustomerDetailFull(env, sessionStub, 5, true);

    // Assert
    expect(calls.sessionReads).toBe(2);
    expect(calls.forwards[0].cookie).toBe("ASP.NET_SessionId=s1");
    expect(calls.forwards[1].cookie).toBe("ASP.NET_SessionId=s2");
  });

  it("throws with the status and no upstream body when the retry also fails", async () => {
    // Arrange — the upstream error page is untrusted and can be large, so the
    // message keeps the status for diagnosis but never embeds the body: it
    // is logged server-side and POST /api/v1/data/* maps sync failures to a
    // fixed `localSync.code` (TOG-5821, TOG-6535).
    const long = "E".repeat(500);
    behavior.responses = [
      () => new Response(long, { status: 503 }),
      () => new Response(long, { status: 503 })
    ];

    // Act
    const error = (await fetchGetCustomerDetailFull(env, sessionStub, 5, true).catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("GetCustomerDetailFull failed: HTTP 503");
    expect(calls.forwards).toHaveLength(2);
  });
});

describe("syncCustomerDetailFullToD1", () => {
  it("upserts the customer, its addresses and its containers, and returns their ids", async () => {
    // Arrange
    behavior.responses = [() => json(DETAIL_FULL)];

    // Act
    const result = await syncCustomerDetailFullToD1(env, sessionStub, 5);

    // Assert
    expect(result).toEqual({ addressIds: [10, 11], containerIds: [100, 101] });
    expect(calls.customers).toHaveLength(1);
    expect(calls.addresses).toHaveLength(1);
    expect(calls.containers).toHaveLength(1);
  });

  it("always requests disabled records so the shadow copy mirrors upstream", async () => {
    // Arrange — omitting disabled rows would make them look deleted, and a
    // report sync would then reconcile them away.
    behavior.responses = [() => json(DETAIL_FULL)];

    // Act
    await syncCustomerDetailFullToD1(env, sessionStub, 5);

    // Assert
    expect(calls.forwards[0].body).toBe('{"customerID":5,"showDisabled":true}');
  });

  it("skips the address and container upserts when the customer has none", async () => {
    // Arrange
    behavior.responses = [() => json({ currentCustomer: { CustomerID: 5 }, data: [] })];

    // Act
    const result = await syncCustomerDetailFullToD1(env, sessionStub, 5);

    // Assert
    expect(result).toEqual({ addressIds: [], containerIds: [] });
    expect(calls.customers).toHaveLength(1);
    expect(calls.addresses).toEqual([]);
    expect(calls.containers).toEqual([]);
  });

  it("skips only the container upsert when addresses have no containers", async () => {
    // Arrange
    behavior.responses = [
      () =>
        json({
          currentCustomer: { CustomerID: 5 },
          data: [{ PickupAddressID: 10, CustomerID: 5 }]
        })
    ];

    // Act
    const result = await syncCustomerDetailFullToD1(env, sessionStub, 5);

    // Assert
    expect(result).toEqual({ addressIds: [10], containerIds: [] });
    expect(calls.addresses).toHaveLength(1);
    expect(calls.containers).toEqual([]);
  });

  it("propagates a malformed payload instead of writing a partial graph", async () => {
    // Arrange — no currentCustomer means the mapper throws before any upsert.
    behavior.responses = [() => json({ data: [] })];

    // Act
    const error = (await syncCustomerDetailFullToD1(env, sessionStub, 5).catch(
      (e: unknown) => e
    )) as Error;

    // Assert
    expect(error.message).toBe("GetCustomerDetailFull missing currentCustomer");
    expect(calls.customers).toEqual([]);
  });
});
