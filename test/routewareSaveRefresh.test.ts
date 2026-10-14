import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TOG-6463 — `refreshAfterRoutewareSave` is the shared post-save refresh for
 * the routeware-tier save routes (`save-long-form`, `save-address-form`,
 * `save-container-form`), which used to forward upstream and return, leaving
 * D1 + the data-entity cache stale until the next cron sync.
 *
 * The contract pinned here: on a successful upstream save the helper refreshes
 * D1 from `GetCustomerDetailFull` and invalidates the customer graph; when any
 * of that fails it falls back to single-entity eviction; and it never rejects,
 * so a local refresh failure cannot turn the passthrough 200 into a 500.
 */

type Graph = { customerId: number; addressIds: number[]; containerIds: number[] };

const calls: {
  synced: number[];
  graph: Graph[];
  entity: Array<{ kind: string; id: number }>;
} = { synced: [], graph: [], entity: [] };

const behavior: {
  syncError: string | null;
  syncResult: { addressIds: number[]; containerIds: number[] };
  graphError: string | null;
  /** Per-entity eviction failures, keyed by the `invalidateDataEntity` kind. */
  evictionErrors: Partial<Record<"customer" | "address" | "container", Error>>;
} = {
  syncError: null,
  syncResult: { addressIds: [10], containerIds: [100] },
  graphError: null,
  evictionErrors: {}
};

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
      if (behavior.graphError) {
        throw new Error(behavior.graphError);
      }
      calls.graph.push(p);
    },
    invalidateDataEntity: async (kind: "customer" | "address" | "container", id: number) => {
      // Recorded before the throw so a rejecting eviction still counts as attempted.
      calls.entity.push({ kind, id });
      const failure = behavior.evictionErrors[kind];
      if (failure) {
        throw failure;
      }
    }
  };
});

const { refreshAfterRoutewareSave } = await import("../src/lib/routewareSaveRefresh");

const sessionStub = {} as unknown as DurableObjectStub;

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

function envWithDb(row: { pickup_address_id: number; customer_id: number } | null = null): Env {
  return { CUSTOMER_DB: fallbackDb(row) } as unknown as Env;
}

/**
 * `console.error` is swapped directly rather than with `vi.spyOn`: under
 * `@cloudflare/vitest-pool-workers` the console methods are bound accessors, so
 * reading `console.error` back does not return the installed spy.
 */
const loggedErrors: unknown[][] = [];
const realConsoleError = console.error;

beforeEach(() => {
  calls.synced = [];
  calls.graph = [];
  calls.entity = [];
  behavior.syncError = null;
  behavior.syncResult = { addressIds: [10], containerIds: [100] };
  behavior.graphError = null;
  behavior.evictionErrors = {};
  loggedErrors.length = 0;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };
});

afterEach(() => {
  console.error = realConsoleError;
});

describe("refreshAfterRoutewareSave", () => {
  it("syncs D1 and invalidates the customer graph for a customer update", async () => {
    // Arrange — the documented disable flow posts CustomerID + Enabled=false.
    const body = formBody({ CustomerID: "42", Enabled: "false" });

    // Act
    await refreshAfterRoutewareSave(envWithDb(), sessionStub, "customer", body, '{"success":true}');

    // Assert
    expect(calls.synced).toEqual([42]);
    expect(calls.graph).toEqual([{ customerId: 42, addressIds: [10], containerIds: [100] }]);
    expect(calls.entity).toEqual([]);
  });

  it("resolves a newly created customer id out of the upstream JSON", async () => {
    // Arrange — a create has no CustomerID in the posted form.
    const body = formBody({ CompanyName: "New" });

    // Act
    await refreshAfterRoutewareSave(
      envWithDb(),
      sessionStub,
      "customer",
      body,
      '{"data":{"CustomerID":77}}'
    );

    // Assert
    expect(calls.synced).toEqual([77]);
    expect(calls.graph).toEqual([{ customerId: 77, addressIds: [10], containerIds: [100] }]);
  });

  it("skips the sync when no customer id is resolvable", async () => {
    // Arrange — nothing in the form and nothing parseable upstream.
    const body = formBody({ CompanyName: "New" });

    // Act
    await refreshAfterRoutewareSave(envWithDb(), sessionStub, "customer", body, "Saved.");

    // Assert
    expect(calls.synced).toEqual([]);
    expect(calls.graph).toEqual([]);
    expect(calls.entity).toEqual([]);
  });

  it("skips the sync on an empty forwarded body", async () => {
    // Act
    await refreshAfterRoutewareSave(envWithDb(), sessionStub, "customer", null, '{"success":true}');

    // Assert
    expect(calls.synced).toEqual([]);
    expect(calls.graph).toEqual([]);
  });

  it("syncs the owning customer for an address save", async () => {
    // Act
    await refreshAfterRoutewareSave(
      envWithDb(),
      sessionStub,
      "address",
      formBody({ CustomerID: "5", PickupAddressID: "10" }),
      '{"success":true}'
    );

    // Assert
    expect(calls.synced).toEqual([5]);
    expect(calls.graph).toEqual([{ customerId: 5, addressIds: [10], containerIds: [100] }]);
  });

  it("skips the sync when an address save carries no usable customer id", async () => {
    // Act
    await refreshAfterRoutewareSave(
      envWithDb(),
      sessionStub,
      "address",
      formBody({ PickupAddressID: "10" }),
      '{"success":true}'
    );

    // Assert
    expect(calls.synced).toEqual([]);
    expect(calls.graph).toEqual([]);
  });

  it("resolves the owning customer from D1 for a container save posting only PickupAddressID", async () => {
    // Arrange — the container form frequently posts only PickupAddressID.
    const env = envWithDb({ pickup_address_id: 10, customer_id: 5 });

    // Act
    await refreshAfterRoutewareSave(
      env,
      sessionStub,
      "container",
      formBody({ PickupAddressID: "10" }),
      '{"success":true}'
    );

    // Assert
    expect(calls.synced).toEqual([5]);
    expect(calls.graph).toEqual([{ customerId: 5, addressIds: [10], containerIds: [100] }]);
  });

  it("prefers the posted customer id over the D1 fallback lookup", async () => {
    // Arrange — the DB would answer 5; the form says 8.
    const env = envWithDb({ pickup_address_id: 10, customer_id: 5 });

    // Act
    await refreshAfterRoutewareSave(
      env,
      sessionStub,
      "container",
      formBody({ CustomerID: "8", PickupAddressID: "10" }),
      '{"success":true}'
    );

    // Assert
    expect(calls.synced).toEqual([8]);
  });

  it("skips the sync when the container fallback lookup finds no owning customer", async () => {
    // Arrange — the address is not in the snapshot yet.
    const env = envWithDb({ pickup_address_id: 99, customer_id: 5 });

    // Act
    await refreshAfterRoutewareSave(
      env,
      sessionStub,
      "container",
      formBody({ PickupAddressID: "10" }),
      '{"success":true}'
    );

    // Assert
    expect(calls.synced).toEqual([]);
    expect(calls.graph).toEqual([]);
  });

  it("names the error class when the container owner lookup throws before any sync", async () => {
    // Arrange — the D1 lookup itself fails.
    const env = {
      CUSTOMER_DB: {
        prepare() {
          throw new TypeError("D1 lookup failed");
        }
      }
    } as unknown as Env;

    // Act
    await refreshAfterRoutewareSave(
      env,
      sessionStub,
      "container",
      formBody({ PickupAddressID: "10" }),
      '{"success":true}'
    );

    // Assert — no sync ran; the record carries the class, never the message.
    expect(calls.synced).toEqual([]);
    expect(loggedErrors.map((args) => args[0])).toContainEqual(
      expect.objectContaining({
        msg: "Post-save refresh failed",
        entity: "container",
        kind: "TypeError"
      })
    );
    expect(JSON.stringify(loggedErrors)).not.toContain("D1 lookup failed");
  });

  it("falls back to single-entity eviction when the D1 sync throws, and never rejects", async () => {
    // Arrange — the graph ids are unknown when the sync throws.
    behavior.syncError = "D1_ERROR: no such table";

    // Act
    await refreshAfterRoutewareSave(
      envWithDb(),
      sessionStub,
      "address",
      formBody({ CustomerID: "5", PickupAddressID: "10" }),
      '{"success":true}'
    );

    // Assert — the whole graph must not be invalidated with partial ids.
    expect(calls.graph).toEqual([]);
    expect(calls.entity).toEqual([
      { kind: "customer", id: 5 },
      { kind: "address", id: 10 }
    ]);
    expect(loggedErrors.map((args) => args[0])).toContainEqual(
      expect.objectContaining({
        msg: "Post-save snapshot sync failed; evicting affected cache keys",
        entity: "address",
        kind: "Error"
      })
    );
  });

  it("falls back to the customer plus the posted container when the container sync throws", async () => {
    // Arrange
    behavior.syncError = "boom";

    // Act
    await refreshAfterRoutewareSave(
      envWithDb(),
      sessionStub,
      "container",
      formBody({ CustomerID: "5", ContainerID: "100" }),
      '{"success":true}'
    );

    // Assert
    expect(calls.graph).toEqual([]);
    expect(calls.entity).toEqual([
      { kind: "customer", id: 5 },
      { kind: "container", id: 100 }
    ]);
  });

  it("falls back to single-entity eviction when the graph invalidation itself throws", async () => {
    // Arrange — the D1 sync succeeded but the cache delete failed; serving the
    // superseded entry is worse than evicting only what is known.
    behavior.graphError = "cache delete failed";

    // Act
    await refreshAfterRoutewareSave(
      envWithDb(),
      sessionStub,
      "customer",
      formBody({ CustomerID: "5" }),
      '{"success":true}'
    );

    // Assert
    expect(calls.synced).toEqual([5]);
    expect(calls.graph).toEqual([]);
    expect(calls.entity).toEqual([{ kind: "customer", id: 5 }]);
  });
});

/**
 * The last line of defense: the D1 sync threw, and the single-entity eviction
 * that is supposed to contain the damage then rejects too. The upstream save
 * already succeeded, so the helper still has to resolve, log each failed
 * eviction with the entity and error class only, and keep trying the other one.
 */
describe("refreshAfterRoutewareSave when the fallback eviction itself fails", () => {
  // Distinctive on purpose: a leak into a log record must be findable by substring.
  const POSTED = {
    CustomerID: "4242",
    PickupAddressID: "7654321",
    ContainerID: "8765432",
    __RequestVerificationToken: "tok-SECRET-9f3a",
    Cookie: "ASP.NET_SessionId=SECRET-cookie-77"
  };
  const EVICTION_MESSAGES = ["cache delete failed: SECRET-customer", "cache delete failed: SECRET-entity"];

  const SYNC_FAILED = "Post-save snapshot sync failed; evicting affected cache keys";
  const CUSTOMER_EVICTION_FAILED = "Post-save customer cache invalidation failed";
  const ENTITY_EVICTION_FAILED = "Post-save entity cache invalidation failed";

  function records(): Array<Record<string, unknown>> {
    return loggedErrors.map((args) => args[0] as Record<string, unknown>);
  }

  function recordsMatching(msg: string): Array<Record<string, unknown>> {
    return records().filter((record) => record.msg === msg);
  }

  /** The log may name the entity and the error class, never what was posted or thrown. */
  function expectLogsCarryNoPostedValues(): void {
    const serialized = JSON.stringify(loggedErrors);
    for (const secret of [
      ...Object.values(POSTED),
      "SECRET",
      "ASP.NET_SessionId",
      ...EVICTION_MESSAGES
    ]) {
      expect(serialized).not.toContain(secret);
    }
  }

  it.each([
    { kind: "customer", expectedEvictions: [{ kind: "customer", id: 4242 }] },
    {
      kind: "address",
      expectedEvictions: [
        { kind: "customer", id: 4242 },
        { kind: "address", id: 7654321 }
      ]
    },
    {
      kind: "container",
      expectedEvictions: [
        { kind: "customer", id: 4242 },
        { kind: "container", id: 8765432 }
      ]
    }
  ] as const)(
    "resolves and logs once when the customer eviction rejects on a $kind save",
    async ({ kind, expectedEvictions }) => {
      // Arrange — the sync throws, then the customer eviction rejects as well.
      behavior.syncError = "D1_ERROR: no such table";
      behavior.evictionErrors = { customer: new TypeError(EVICTION_MESSAGES[0]) };

      // Act — resolving (not rejecting) is the assertion.
      await expect(
        refreshAfterRoutewareSave(
          envWithDb(),
          sessionStub,
          kind,
          formBody(POSTED),
          '{"success":true}'
        )
      ).resolves.toBeUndefined();

      // Assert — every eviction was still attempted; the failure did not short-circuit the rest.
      expect(calls.graph).toEqual([]);
      expect(calls.entity).toEqual(expectedEvictions);
      expect(recordsMatching(CUSTOMER_EVICTION_FAILED)).toEqual([
        {
          level: "error",
          msg: CUSTOMER_EVICTION_FAILED,
          route: "routeware.saveRefresh.invalidate",
          ms: null,
          entity: "customer",
          kind: "TypeError"
        }
      ]);
      expect(recordsMatching(ENTITY_EVICTION_FAILED)).toEqual([]);
      // The sync failure is the only other record: nothing escaped to the outer handler.
      expect(records().map((record) => record.msg)).toEqual([SYNC_FAILED, CUSTOMER_EVICTION_FAILED]);
      expectLogsCarryNoPostedValues();
    }
  );

  it.each([
    { kind: "address", entity: "address", id: 7654321 },
    { kind: "container", entity: "container", id: 8765432 }
  ] as const)(
    "resolves and logs once when the $entity eviction rejects but the customer eviction succeeds",
    async ({ kind, entity, id }) => {
      // Arrange
      behavior.syncError = "D1_ERROR: no such table";
      behavior.evictionErrors = { [entity]: new RangeError(EVICTION_MESSAGES[1]) };

      // Act
      await expect(
        refreshAfterRoutewareSave(
          envWithDb(),
          sessionStub,
          kind,
          formBody(POSTED),
          '{"success":true}'
        )
      ).resolves.toBeUndefined();

      // Assert — the customer key was evicted before the entity key failed.
      expect(calls.graph).toEqual([]);
      expect(calls.entity).toEqual([
        { kind: "customer", id: 4242 },
        { kind: entity, id }
      ]);
      expect(recordsMatching(ENTITY_EVICTION_FAILED)).toEqual([
        {
          level: "error",
          msg: ENTITY_EVICTION_FAILED,
          route: "routeware.saveRefresh.invalidate",
          ms: null,
          entity,
          kind: "RangeError"
        }
      ]);
      expect(recordsMatching(CUSTOMER_EVICTION_FAILED)).toEqual([]);
      expect(records().map((record) => record.msg)).toEqual([SYNC_FAILED, ENTITY_EVICTION_FAILED]);
      expectLogsCarryNoPostedValues();
    }
  );

  it.each([
    { kind: "address", entity: "address", id: 7654321 },
    { kind: "container", entity: "container", id: 8765432 }
  ] as const)(
    "resolves and logs both failures when the customer and $entity evictions both reject",
    async ({ kind, entity, id }) => {
      // Arrange — each rejection has its own error class so a swapped or merged log is visible.
      behavior.syncError = "D1_ERROR: no such table";
      behavior.evictionErrors = {
        customer: new TypeError(EVICTION_MESSAGES[0]),
        [entity]: new RangeError(EVICTION_MESSAGES[1])
      };

      // Act
      await expect(
        refreshAfterRoutewareSave(
          envWithDb(),
          sessionStub,
          kind,
          formBody(POSTED),
          '{"success":true}'
        )
      ).resolves.toBeUndefined();

      // Assert — both evictions were attempted and each failure got its own record.
      expect(calls.graph).toEqual([]);
      expect(calls.entity).toEqual([
        { kind: "customer", id: 4242 },
        { kind: entity, id }
      ]);
      expect(recordsMatching(CUSTOMER_EVICTION_FAILED)).toEqual([
        {
          level: "error",
          msg: CUSTOMER_EVICTION_FAILED,
          route: "routeware.saveRefresh.invalidate",
          ms: null,
          entity: "customer",
          kind: "TypeError"
        }
      ]);
      expect(recordsMatching(ENTITY_EVICTION_FAILED)).toEqual([
        {
          level: "error",
          msg: ENTITY_EVICTION_FAILED,
          route: "routeware.saveRefresh.invalidate",
          ms: null,
          entity,
          kind: "RangeError"
        }
      ]);
      expect(records()).toHaveLength(3);
      expect(records().map((record) => record.msg)).not.toContain("Post-save refresh failed");
      expectLogsCarryNoPostedValues();
    }
  );

  it("logs the eviction failure after a graph invalidation failure too, and still resolves", async () => {
    // Arrange — the sync succeeded, the graph delete threw, then the customer eviction rejects.
    behavior.graphError = "cache delete failed";
    behavior.evictionErrors = { customer: new TypeError(EVICTION_MESSAGES[0]) };

    // Act
    await expect(
      refreshAfterRoutewareSave(
        envWithDb(),
        sessionStub,
        "customer",
        formBody(POSTED),
        '{"success":true}'
      )
    ).resolves.toBeUndefined();

    // Assert
    expect(calls.synced).toEqual([4242]);
    expect(calls.entity).toEqual([{ kind: "customer", id: 4242 }]);
    expect(records().map((record) => record.msg)).toEqual([SYNC_FAILED, CUSTOMER_EVICTION_FAILED]);
    expectLogsCarryNoPostedValues();
  });
});
