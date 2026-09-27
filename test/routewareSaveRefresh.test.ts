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
} = {
  syncError: null,
  syncResult: { addressIds: [10], containerIds: [100] },
  graphError: null
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
    invalidateDataEntity: async (kind: string, id: number) => {
      calls.entity.push({ kind, id });
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
    expect(loggedErrors.length).toBeGreaterThanOrEqual(1);
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
