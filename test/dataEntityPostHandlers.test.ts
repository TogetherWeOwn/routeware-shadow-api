import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The three POST write paths in `src/lib/dataEntityHandlers.ts` had zero coverage.
 *
 * The highest-risk branch is the one exercised first below: the upstream write to
 * Routeware succeeds, but the follow-up `syncCustomerDetailFullToD1` throws. The
 * handler must **not** turn that 200 into a 500 — the customer's data really was
 * saved upstream — and it must still invalidate the affected cache entries, or the
 * API keeps serving stale customer PII from the Workers cache indefinitely.
 *
 * Everything the handlers reach out to is mocked so each branch is reachable:
 * the anti-forgery body preparation, the upstream forward, and the D1 detail sync.
 * The response-shape helpers (`urlEncodedToObject`, `routewarePostLooksSuccessful`,
 * `parseCustomerIdFromSaveResponse`) run for real — they are what decides whether
 * a sync is attempted at all.
 */

type Graph = { customerId: number; addressIds: number[]; containerIds: number[] };

const calls: {
  graph: Graph[];
  entity: Array<{ kind: string; id: number }>;
  forwarded: string[];
  synced: number[];
} = { graph: [], entity: [], forwarded: [], synced: [] };

const behavior: {
  prepareError: string | null;
  prepareReturnsNull: boolean;
  upstreamStatus: number;
  upstreamBody: string;
  syncError: string | null;
  syncResult: { addressIds: number[]; containerIds: number[] };
} = {
  prepareError: null,
  prepareReturnsNull: false,
  upstreamStatus: 200,
  upstreamBody: "",
  syncError: null,
  syncResult: { addressIds: [10], containerIds: [100] }
};

/**
 * Shared stand-in for all three `prepare*Body` functions.
 *
 * Deliberately synchronous: if this were `async`, the failure path would produce
 * an already-rejected promise that the async mock then adopts, and workerd
 * reports that intermediate promise as an unhandled rejection even though the
 * handler catches the one it awaits.
 */
function prepared(buf: ArrayBuffer | null): ArrayBuffer | null {
  if (behavior.prepareError) {
    throw new Error(behavior.prepareError);
  }
  return behavior.prepareReturnsNull ? null : buf;
}

/*
 * These doubles are plain functions rather than `vi.fn()`. The spy wrapper
 * tracks each call's settled result, which turns the deliberate rejection in
 * `prepared()` into an unhandled rejection that fails the run even though the
 * handler catches it. Call tracking is done by hand in `calls` instead.
 */
vi.mock("../src/lib/customerSaveAutoToken", () => ({
  prepareSaveCustomerLongFormBody: async (
    _e: unknown,
    _s: unknown,
    _r: unknown,
    buf: ArrayBuffer | null
  ) => prepared(buf)
}));

vi.mock("../src/lib/addressContainerSaveForm", () => ({
  prepareSaveAddressFormBody: async (
    _e: unknown,
    _s: unknown,
    _r: unknown,
    buf: ArrayBuffer | null
  ) => prepared(buf),
  prepareSaveContainerFormBody: async (
    _e: unknown,
    _s: unknown,
    _r: unknown,
    buf: ArrayBuffer | null
  ) => prepared(buf)
}));

vi.mock("../src/lib/forwardWithSessionRetry", () => ({
  forwardWithSessionRetry: async (_env: unknown, _stub: unknown, _req: unknown, url: URL) => {
    calls.forwarded.push(url.toString());
    return new Response(behavior.upstreamBody, { status: behavior.upstreamStatus });
  }
}));

vi.mock("../src/lib/detailFullSync", () => ({
  syncCustomerDetailFullToD1: async (_env: unknown, _stub: unknown, customerId: number) => {
    calls.synced.push(customerId);
    if (behavior.syncError) {
      throw new Error(behavior.syncError);
    }
    return behavior.syncResult;
  }
}));

vi.mock("../src/lib/entityDataCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/entityDataCache")>();
  return {
    ...actual,
    invalidateCustomerGraph: async (p: Graph) => {
      calls.graph.push(p);
    },
    invalidateDataEntity: async (kind: string, id: number) => {
      calls.entity.push({ kind, id });
    }
  };
});

const { handlePostDataAddress, handlePostDataContainer, handlePostDataCustomer } = await import(
  "../src/lib/dataEntityHandlers"
);
type Ctx = Parameters<typeof handlePostDataCustomer>[0];

const sessionStub = {
  fetch: async () =>
    new Response(
      JSON.stringify({ cookieHeader: "ASP.NET_SessionId=x", expiresAtMs: null, refreshing: false })
    )
} as unknown as DurableObjectStub;

function formBody(fields: Record<string, string>): ArrayBuffer {
  return new TextEncoder().encode(new URLSearchParams(fields).toString()).buffer as ArrayBuffer;
}

/**
 * Fake D1 for the container handler's customer-id fallback lookup only.
 * `bind()` is honoured so a query for the wrong pickup_address_id misses.
 */
function fallbackDb(row: { pickup_address_id: number; customer_id: number } | null): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (!sql.includes("FROM address_snapshot") || !row) {
                return null;
              }
              return args.includes(row.pickup_address_id)
                ? ({ customer_id: row.customer_id } as T)
                : null;
            }
          };
        }
      };
    }
  } as unknown as D1Database;
}

function postCtx(buf: ArrayBuffer | null, db: D1Database = fallbackDb(null)): Ctx {
  return {
    env: {
      CUSTOMER_DB: db,
      TARGET_ORIGIN: "https://killeen.example.test",
      TARGET_BASE_PATH: "/WebRW"
    } as unknown as Env,
    var: { bodyBuffer: buf, sessionStub },
    req: {
      raw: new Request("http://test.local/api/v1/data/customer", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" }
      }),
      header: () => undefined
    }
  } as Ctx;
}

type PostBody = {
  ok: boolean;
  routewareStatus: number;
  upstream: unknown;
  posted: Record<string, string>;
  localSync?: { done: boolean; reason?: string; customerId?: number };
};

/**
 * `console.error` is swapped directly rather than with `vi.spyOn`: under
 * `@cloudflare/vitest-pool-workers` the console methods are bound accessors, so
 * reading `console.error` back does not return the installed spy.
 */
const loggedErrors: unknown[][] = [];
const realConsoleError = console.error;

beforeEach(() => {
  calls.graph = [];
  calls.entity = [];
  calls.forwarded = [];
  calls.synced = [];
  behavior.prepareError = null;
  behavior.prepareReturnsNull = false;
  behavior.upstreamStatus = 200;
  behavior.upstreamBody = "";
  behavior.syncError = null;
  behavior.syncResult = { addressIds: [10], containerIds: [100] };
  loggedErrors.length = 0;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };
});

afterEach(() => {
  console.error = realConsoleError;
});

describe("POST handlers when the local D1 sync throws after a successful upstream write", () => {
  it("keeps the upstream 200 and reports localSync.done=false with the reason", async () => {
    // Arrange — the save reached Routeware; only the shadow-copy sync failed.
    behavior.syncError = "D1_ERROR: no such table";

    // Act
    const res = await handlePostDataCustomer(postCtx(formBody({ CustomerID: "5" })));

    // Assert
    expect(res.status).toBe(200);
    const body = (await res.json()) as PostBody;
    expect(body.ok).toBe(true);
    expect(body.localSync).toEqual({ done: false, reason: "D1_ERROR: no such table" });
  });

  it("falls back to invalidating the single customer instead of the whole graph", async () => {
    // Arrange — the graph ids are unknown when the sync throws, so the handler
    // must not call invalidateCustomerGraph with stale or partial ids.
    behavior.syncError = "boom";

    // Act
    await handlePostDataCustomer(postCtx(formBody({ CustomerID: "5" })));

    // Assert
    expect(calls.graph).toEqual([]);
    expect(calls.entity).toEqual([{ kind: "customer", id: 5 }]);
  });

  it("logs the sync failure rather than swallowing it", async () => {
    // Arrange
    behavior.syncError = "boom";

    // Act
    await handlePostDataCustomer(postCtx(formBody({ CustomerID: "5" })));

    // Assert
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0][0]).toBe("syncCustomerDetailFullToD1");
    expect(loggedErrors[0][1]).toBeInstanceOf(Error);
  });

  it("invalidates both the customer and the posted address when the address sync throws", async () => {
    // Arrange
    behavior.syncError = "boom";

    // Act
    const res = await handlePostDataAddress(
      postCtx(formBody({ CustomerID: "5", PickupAddressID: "10" }))
    );

    // Assert
    expect(res.status).toBe(200);
    expect(calls.graph).toEqual([]);
    expect(calls.entity).toEqual([
      { kind: "customer", id: 5 },
      { kind: "address", id: 10 }
    ]);
  });

  it("invalidates only the customer when the address sync throws and no address id was posted", async () => {
    // Arrange
    behavior.syncError = "boom";

    // Act
    await handlePostDataAddress(postCtx(formBody({ CustomerID: "5" })));

    // Assert
    expect(calls.entity).toEqual([{ kind: "customer", id: 5 }]);
  });

  it("invalidates both the customer and the posted container when the container sync throws", async () => {
    // Arrange — mirrors the address handler: the posted ContainerID keys its own
    // cached GET /api/v1/data/container bundle (which nests address + customer
    // PII), so it must be invalidated too or stale PII is served indefinitely.
    behavior.syncError = "boom";

    // Act
    const res = await handlePostDataContainer(
      postCtx(formBody({ CustomerID: "5", ContainerID: "100" }))
    );

    // Assert
    expect(res.status).toBe(200);
    expect(calls.graph).toEqual([]);
    expect(calls.entity).toEqual([
      { kind: "customer", id: 5 },
      { kind: "container", id: 100 }
    ]);
  });

  it("invalidates only the customer when the container sync throws and no container id was posted", async () => {
    // Arrange — a create posts ContainerID=0/absent; only the customer key can be
    // invalidated because the new container id is unknown until the sync succeeds.
    behavior.syncError = "boom";

    // Act
    await handlePostDataContainer(postCtx(formBody({ CustomerID: "5" })));

    // Assert
    expect(calls.entity).toEqual([{ kind: "customer", id: 5 }]);
  });
});

describe("handlePostDataCustomer", () => {
  it("returns the full response envelope and invalidates the customer graph on success", async () => {
    // Arrange
    behavior.upstreamBody = '{"success":true}';
    behavior.syncResult = { addressIds: [10, 11], containerIds: [100] };

    // Act
    const res = await handlePostDataCustomer(
      postCtx(formBody({ CustomerID: "5", CompanyName: "Acme" }))
    );

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = (await res.json()) as PostBody;
    expect(body).toEqual({
      ok: true,
      routewareStatus: 200,
      upstream: { success: true },
      posted: { CustomerID: "5", CompanyName: "Acme" },
      localSync: { done: true, customerId: 5, addressIds: [10, 11], containerIds: [100] }
    });
    expect(calls.graph).toEqual([{ customerId: 5, addressIds: [10, 11], containerIds: [100] }]);
  });

  it("posts to the SaveCustomerLongForm upstream path", async () => {
    // Arrange / Act
    await handlePostDataCustomer(postCtx(formBody({ CustomerID: "5" })));

    // Assert
    expect(calls.forwarded).toEqual([
      "https://killeen.example.test/WebRW/Customer/SaveCustomerLongForm"
    ]);
  });

  it("resolves a newly created customer id out of the upstream JSON", async () => {
    // Arrange — a create has no CustomerID in the posted form.
    behavior.upstreamBody = '{"data":{"CustomerID":77}}';

    // Act
    const res = await handlePostDataCustomer(postCtx(formBody({ CompanyName: "New" })));

    // Assert
    expect(calls.synced).toEqual([77]);
    const body = (await res.json()) as PostBody;
    expect(body.localSync).toMatchObject({ done: true, customerId: 77 });
  });

  it("reports an unresolvable customer id without attempting a sync", async () => {
    // Arrange — nothing in the form and nothing parseable upstream.
    behavior.upstreamBody = "Saved.";

    // Act
    const res = await handlePostDataCustomer(postCtx(formBody({ CompanyName: "New" })));

    // Assert
    expect(calls.synced).toEqual([]);
    const body = (await res.json()) as PostBody;
    expect(body.localSync).toEqual({
      done: false,
      reason: "could not determine CustomerID from response"
    });
    expect(body.upstream).toBe("Saved.");
    // TOG-6533: the form carries no usable posted id, so there is nothing to
    // invalidate — but the branch must run without throwing.
    expect(calls.entity).toEqual([]);
  });

  it("mirrors an upstream failure status and never attempts a sync", async () => {
    // Arrange
    behavior.upstreamStatus = 503;
    behavior.upstreamBody = "upstream down";

    // Act
    const res = await handlePostDataCustomer(postCtx(formBody({ CustomerID: "5" })));

    // Assert
    expect(res.status).toBe(503);
    const body = (await res.json()) as PostBody;
    expect(body.ok).toBe(false);
    expect(body.routewareStatus).toBe(503);
    expect(body.localSync).toEqual({ done: false, reason: "not attempted" });
    expect(calls.synced).toEqual([]);
    expect(calls.entity).toEqual([]);
  });
});

describe("handlePostDataAddress", () => {
  it("syncs the owning customer and invalidates its graph on success", async () => {
    // Arrange
    behavior.syncResult = { addressIds: [10], containerIds: [100] };

    // Act
    const res = await handlePostDataAddress(
      postCtx(formBody({ CustomerID: "5", PickupAddressID: "10" }))
    );

    // Assert
    expect(res.status).toBe(200);
    expect(calls.synced).toEqual([5]);
    expect(calls.graph).toEqual([{ customerId: 5, addressIds: [10], containerIds: [100] }]);
    expect(calls.forwarded).toEqual([
      "https://killeen.example.test/WebRW/PickupAddress/SaveAddressForm"
    ]);
  });

  it("skips the sync when the posted form carries no usable customer id", async () => {
    // Arrange / Act
    const res = await handlePostDataAddress(postCtx(formBody({ PickupAddressID: "10" })));

    // Assert — an address save with no owner is still forwarded and still 200.
    expect(res.status).toBe(200);
    expect(calls.synced).toEqual([]);
    expect(calls.graph).toEqual([]);
  });

  it("invalidates the posted address id when the write succeeds with no usable customer id", async () => {
    // Arrange — TOG-6533: the upstream save succeeded but no graph sync is
    // possible, so the pre-edit cached address bundle must still be dropped.
    // Act
    const res = await handlePostDataAddress(postCtx(formBody({ PickupAddressID: "10" })));

    // Assert
    expect(res.status).toBe(200);
    expect(calls.synced).toEqual([]);
    expect(calls.graph).toEqual([]);
    expect(calls.entity).toEqual([{ kind: "address", id: 10 }]);
  });

  it("invalidates nothing when the unresolvable address write posts no usable ids", async () => {
    // Arrange — an address save with neither CustomerID nor PickupAddressID
    // still succeeds upstream; there is simply no cache key to drop.
    // Act
    const res = await handlePostDataAddress(postCtx(formBody({ Notes: "x" })));

    // Assert
    expect(res.status).toBe(200);
    expect(calls.synced).toEqual([]);
    expect(calls.entity).toEqual([]);
  });
});

describe("handlePostDataContainer", () => {
  it("looks the customer id up from the pickup address when the form omits it", async () => {
    // Arrange — the container form frequently posts only PickupAddressID.
    const db = fallbackDb({ pickup_address_id: 10, customer_id: 5 });

    // Act
    const res = await handlePostDataContainer(postCtx(formBody({ PickupAddressID: "10" }), db));

    // Assert
    expect(res.status).toBe(200);
    expect(calls.synced).toEqual([5]);
    expect(calls.graph).toEqual([{ customerId: 5, addressIds: [10], containerIds: [100] }]);
  });

  it("skips the sync when the fallback lookup finds no owning customer", async () => {
    // Arrange — the address is not in the snapshot yet.
    const db = fallbackDb({ pickup_address_id: 99, customer_id: 5 });

    // Act
    const res = await handlePostDataContainer(postCtx(formBody({ PickupAddressID: "10" }), db));

    // Assert
    expect(res.status).toBe(200);
    expect(calls.synced).toEqual([]);
    expect(calls.graph).toEqual([]);
  });

  it("invalidates the posted address and container ids when the write succeeds with no resolvable customer", async () => {
    // Arrange — TOG-6533: the upstream save succeeded but neither the form
    // nor the address-snapshot fallback yields a customer, so the pre-edit
    // cached bundles must still be dropped.
    const db = fallbackDb({ pickup_address_id: 99, customer_id: 5 });

    // Act
    const res = await handlePostDataContainer(
      postCtx(formBody({ PickupAddressID: "10", ContainerID: "100" }), db)
    );

    // Assert
    expect(res.status).toBe(200);
    expect(calls.synced).toEqual([]);
    expect(calls.graph).toEqual([]);
    expect(calls.entity).toEqual([
      { kind: "address", id: 10 },
      { kind: "container", id: 100 }
    ]);
  });

  it("invalidates nothing when the unresolvable container write posts no usable ids", async () => {
    // Arrange
    const db = fallbackDb(null);

    // Act
    const res = await handlePostDataContainer(postCtx(formBody({ Notes: "x" }), db));

    // Assert
    expect(res.status).toBe(200);
    expect(calls.synced).toEqual([]);
    expect(calls.entity).toEqual([]);
  });

  it("prefers the posted customer id over the fallback lookup", async () => {
    // Arrange — the DB would answer 5; the form says 8.
    const db = fallbackDb({ pickup_address_id: 10, customer_id: 5 });

    // Act
    await handlePostDataContainer(
      postCtx(formBody({ CustomerID: "8", PickupAddressID: "10" }), db)
    );

    // Assert
    expect(calls.synced).toEqual([8]);
    expect(calls.forwarded).toEqual([
      "https://killeen.example.test/WebRW/Container/SaveContainerForm"
    ]);
  });
});

describe("POST handler request-validation branches", () => {
  const handlers = [
    ["customer", handlePostDataCustomer],
    ["address", handlePostDataAddress],
    ["container", handlePostDataContainer]
  ] as const;

  for (const [name, handler] of handlers) {
    it(`returns 400 for an empty body on the ${name} handler`, async () => {
      // Arrange / Act
      const res = await handler(postCtx(new ArrayBuffer(0)));

      // Assert
      expect(res.status).toBe(400);
      const body = (await res.json()) as { title: string };
      expect(body.title).toBe("Empty body");
      expect(calls.forwarded).toEqual([]);
    });

    it(`returns 400 when body preparation yields nothing on the ${name} handler`, async () => {
      // Arrange
      behavior.prepareReturnsNull = true;

      // Act
      const res = await handler(postCtx(formBody({ CustomerID: "5" })));

      // Assert
      expect(res.status).toBe(400);
      expect(calls.forwarded).toEqual([]);
    });

    it(`returns 502 without forwarding when anti-forgery preparation fails on the ${name} handler`, async () => {
      // Arrange — a failed token fetch must not reach Routeware with a body that
      // would be rejected, and must not be reported as a client error.
      behavior.prepareError = "token fetch failed";

      // Act
      const res = await handler(postCtx(formBody({ CustomerID: "5" })));

      // Assert
      expect(res.status).toBe(502);
      const body = (await res.json()) as { title: string; detail: string };
      expect(body.title).toBe("Anti-forgery preparation failed");
      expect(body.detail).toBe("token fetch failed");
      expect(calls.forwarded).toEqual([]);
    });
  }
});
