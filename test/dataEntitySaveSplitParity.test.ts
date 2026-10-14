import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * TOG-24091: route-level parity pin for the #262 save-handler split
 * (`src/lib/dataEntityHandlers.ts` -> `src/lib/dataEntitySave.ts`, move-only).
 *
 * The split must preserve POST-save behavior exactly: the same success
 * envelopes, the same error shapes, and the same save-step sequence
 * (prepare -> forward -> sync -> invalidate, plus the silent-failure token
 * eviction). Anything the move drops or reorders — a forgotten sync call, a
 * lost invalidation branch, a swapped upstream path, a miswired route — turns
 * one of these tests red, on the PR head as well as on main.
 *
 * Strategy: drive the real `dataEntityRoutes` module through a thin test-only
 * wrapper that reproduces the `app.ts` body-buffer/session middleware, with
 * the same low-level doubles as `test/dataEntityPostHandlers.test.ts`
 * (anti-forgery preparation, upstream forward, D1 detail sync, cache
 * invalidation). No handler module is mocked, so the tests exercise
 * whichever module the route actually imports — pre-split
 * (`dataEntityHandlers`) or post-split (`dataEntitySave` via re-export).
 * Test files only; no production code is touched.
 */

type Graph = { customerId: number; addressIds: number[]; containerIds: number[] };

const calls: {
  graph: Graph[];
  entity: Array<{ kind: string; id: number }>;
  forwarded: string[];
  synced: number[];
  evicted: number[];
} = { graph: [], entity: [], forwarded: [], synced: [], evicted: [] };

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

/** Ordered save-step ledger: prepare -> forward -> sync -> invalidate. */
const order: string[] = [];

/**
 * Shared stand-in for all three `prepare*Body` functions. Deliberately
 * synchronous: if this were `async`, the failure path would produce an
 * already-rejected promise that the async mock then adopts, and workerd
 * reports that intermediate promise as an unhandled rejection even though
 * the handler catches the one it awaits.
 */
function prepared(buf: ArrayBuffer | null): ArrayBuffer | null {
  if (behavior.prepareError) {
    throw new Error(behavior.prepareError);
  }
  return behavior.prepareReturnsNull ? null : buf;
}

vi.mock("../src/lib/customerSaveAutoToken", () => ({
  prepareSaveCustomerLongFormBody: async (
    _e: unknown,
    _s: unknown,
    _r: unknown,
    buf: ArrayBuffer | null
  ) => {
    order.push("prepare:customer");
    return prepared(buf);
  },
  // TOG-8149: the handlers evict the rejected token on the silent-failure
  // path; recording the call pins that step across the split.
  evictAntiForgeryTokenCacheForBody: (body: ArrayBuffer | null) => {
    order.push("evict");
    calls.evicted.push(body?.byteLength ?? 0);
    return false;
  }
}));

vi.mock("../src/lib/addressContainerSaveForm", () => ({
  prepareSaveAddressFormBody: async (
    _e: unknown,
    _s: unknown,
    _r: unknown,
    buf: ArrayBuffer | null
  ) => {
    order.push("prepare:address");
    return prepared(buf);
  },
  prepareSaveContainerFormBody: async (
    _e: unknown,
    _s: unknown,
    _r: unknown,
    buf: ArrayBuffer | null
  ) => {
    order.push("prepare:container");
    return prepared(buf);
  }
}));

vi.mock("../src/lib/forwardWithSessionRetry", () => ({
  forwardWithSessionRetry: async (_env: unknown, _stub: unknown, _req: unknown, url: URL) => {
    const u = String(url);
    order.push(`forward:${u}`);
    calls.forwarded.push(u);
    return new Response(behavior.upstreamBody, { status: behavior.upstreamStatus });
  }
}));

vi.mock("../src/lib/detailFullSync", () => ({
  syncCustomerDetailFullToD1: async (_env: unknown, _stub: unknown, customerId: number) => {
    order.push(`sync:${customerId}`);
    calls.synced.push(customerId);
    if (behavior.syncError) {
      throw new Error(behavior.syncError);
    }
    return { ...behavior.syncResult };
  }
}));

vi.mock("../src/lib/entityDataCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/entityDataCache")>();
  return {
    ...actual,
    invalidateCustomerGraphWithRetry: async (p: Graph) => {
      order.push("invalidate:graph");
      calls.graph.push(p);
    },
    invalidateDataEntity: async (kind: string, id: number) => {
      order.push(`invalidate:entity:${kind}:${id}`);
      calls.entity.push({ kind, id });
    }
  };
});

const { dataEntityRoutes } = await import("../src/routes/dataEntity");

const SECRET = "sync-secret";

const sessionStub = {
  fetch: async () =>
    new Response(
      JSON.stringify({ cookieHeader: "ASP.NET_SessionId=x", expiresAtMs: null, refreshing: false })
    )
} as unknown as DurableObjectStub;

/**
 * Thin test-only wrapper reproducing the `app.ts` body-buffer/session
 * middleware for the data-entity routes, so the real handlers receive the
 * same `bodyBuffer`/`sessionStub` vars they get in production. Only the
 * narrower snapshot-secret gate applies (as in `test/dataRoutes.test.ts`);
 * the app-wide `/api/v1/*` bearer gate is out of the picture.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const testApp = new Hono<any>();
testApp.use("/api/v1/data/*", async (c, next) => {
  const raw = c.req.raw;
  const buf = raw.method === "GET" || raw.method === "HEAD" ? null : await raw.arrayBuffer();
  c.set("bodyBuffer", buf);
  c.set("sessionStub", sessionStub);
  await next();
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
testApp.route("/", dataEntityRoutes as any);

const execCtx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

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

function makeEnv(db: D1Database = fallbackDb(null)): Env {
  return {
    CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET,
    TARGET_ORIGIN: "https://killeen.example.test",
    TARGET_BASE_PATH: "/WebRW",
    CUSTOMER_DB: db
  } as unknown as Env;
}

function fieldsBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function post(
  path: string,
  body: string,
  env: Env = makeEnv(),
  auth: string = SECRET
): Promise<Response> {
  return await testApp.fetch(
    new Request(`http://test.local${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Bearer ${auth}`
      },
      body
    }),
    env,
    execCtx
  );
}

/** Assert the strict save-step order; a dropped or reordered step fails here. */
function expectSaveOrder(entity: "customer" | "address" | "container", customerId: number): void {
  const iPrep = order.indexOf(`prepare:${entity}`);
  const iFwd = order.findIndex((s) => s.startsWith("forward:"));
  const iSync = order.indexOf(`sync:${customerId}`);
  const iInv = order.indexOf("invalidate:graph");
  expect([iPrep, iFwd, iSync, iInv].every((i) => i >= 0)).toBe(true);
  expect(iPrep).toBeLessThan(iFwd);
  expect(iFwd).toBeLessThan(iSync);
  expect(iSync).toBeLessThan(iInv);
}

const loggedErrors: Array<Record<string, unknown>> = [];
const realConsoleError = console.error;

beforeEach(() => {
  calls.graph = [];
  calls.entity = [];
  calls.forwarded = [];
  calls.synced = [];
  calls.evicted = [];
  order.length = 0;
  behavior.prepareError = null;
  behavior.prepareReturnsNull = false;
  behavior.upstreamStatus = 200;
  behavior.upstreamBody = "";
  behavior.syncError = null;
  behavior.syncResult = { addressIds: [10], containerIds: [100] };
  loggedErrors.length = 0;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args[0] as Record<string, unknown>);
  };
});

afterEach(() => {
  console.error = realConsoleError;
});

describe("split module identity (TOG-19136)", () => {
  it("keeps the three POST save handlers behind the legacy import path", async () => {
    // Arrange — post-split this module re-exports from `./dataEntitySave`;
    // pre-split it owns the implementations. Either way the route's old
    // import path must keep resolving, or existing import sites break.
    const oldMod = await import("../src/lib/dataEntityHandlers");

    // Assert
    expect(typeof oldMod.handlePostDataCustomer).toBe("function");
    expect(typeof oldMod.handlePostDataAddress).toBe("function");
    expect(typeof oldMod.handlePostDataContainer).toBe("function");
    expect(typeof oldMod.handleGetDataCustomer).toBe("function");
    expect(typeof oldMod.handleGetDataAddress).toBe("function");
    expect(typeof oldMod.handleGetDataContainer).toBe("function");
  });

  it("exports the identical POST handler references from the new save module", async () => {
    // Arrange — a move-only split must not fork behavior: the re-export and
    // the new module must be the same function objects. On the pre-split
    // layout the new module does not exist yet; the legacy-module assertion
    // above is the applicable pin there.
    const oldMod = await import("../src/lib/dataEntityHandlers");
    let newMod: typeof oldMod | null = null;
    try {
      newMod = await import("../src/lib/dataEntitySave");
    } catch {
      newMod = null;
    }
    if (newMod === null) {
      expect(typeof oldMod.handlePostDataCustomer).toBe("function");
      expect(typeof oldMod.handlePostDataAddress).toBe("function");
      expect(typeof oldMod.handlePostDataContainer).toBe("function");
      return;
    }

    // Assert — identity, not just shape: a copy-paste fork would pass a
    // shape check while silently diverging later.
    expect(newMod.handlePostDataCustomer).toBe(oldMod.handlePostDataCustomer);
    expect(newMod.handlePostDataAddress).toBe(oldMod.handlePostDataAddress);
    expect(newMod.handlePostDataContainer).toBe(oldMod.handlePostDataContainer);
  });
});

describe("POST success parity through the route", () => {
  it("customer save returns ids + sync outcome only, in save-step order", async () => {
    // Arrange — TOG-6535 envelope: no `posted` PII map, no raw upstream body.
    behavior.upstreamBody = '{"success":true}';
    behavior.syncResult = { addressIds: [10, 11], containerIds: [100] };

    // Act
    const res = await post(
      "/api/v1/data/customer",
      fieldsBody({ CustomerID: "5", CompanyName: "Acme" })
    );

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await res.json()).toEqual({
      ok: true,
      routewareStatus: 200,
      customerId: 5,
      upstreamBytes: new TextEncoder().encode(behavior.upstreamBody).length,
      localSync: { done: true, customerId: 5, addressIds: [10, 11], containerIds: [100] }
    });
    expect(calls.forwarded).toEqual([
      "https://killeen.example.test/WebRW/Customer/SaveCustomerLongForm"
    ]);
    expect(calls.graph).toEqual([{ customerId: 5, addressIds: [10, 11], containerIds: [100] }]);
    expectSaveOrder("customer", 5);
  });

  it("address save syncs the owning customer and invalidates its graph", async () => {
    // Arrange
    behavior.upstreamBody = '{"success":true}';

    // Act
    const res = await post(
      "/api/v1/data/address",
      fieldsBody({ CustomerID: "5", PickupAddressID: "10" })
    );

    // Assert
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      routewareStatus: 200,
      customerId: 5,
      pickupAddressId: 10,
      upstreamBytes: new TextEncoder().encode(behavior.upstreamBody).length,
      localSync: { done: true, customerId: 5, addressIds: [10], containerIds: [100] }
    });
    expect(calls.forwarded).toEqual([
      "https://killeen.example.test/WebRW/PickupAddress/SaveAddressForm"
    ]);
    expect(calls.synced).toEqual([5]);
    expectSaveOrder("address", 5);
  });

  it("container save prefers the posted customer id over the D1 fallback", async () => {
    // Arrange — the DB would answer 5; the form says 8, and the form wins.
    behavior.upstreamBody = '{"success":true}';
    const env = makeEnv(fallbackDb({ pickup_address_id: 10, customer_id: 5 }));

    // Act
    const res = await post(
      "/api/v1/data/container",
      fieldsBody({ CustomerID: "8", PickupAddressID: "10", ContainerID: "100" }),
      env
    );

    // Assert
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      routewareStatus: 200,
      customerId: 8,
      pickupAddressId: 10,
      containerId: 100,
      upstreamBytes: new TextEncoder().encode(behavior.upstreamBody).length,
      localSync: { done: true, customerId: 8, addressIds: [10], containerIds: [100] }
    });
    expect(calls.forwarded).toEqual([
      "https://killeen.example.test/WebRW/Container/SaveContainerForm"
    ]);
    expect(calls.synced).toEqual([8]);
    expectSaveOrder("container", 8);
  });

  it("container save resolves the customer from the address snapshot when the form omits it", async () => {
    // Arrange — the container form frequently posts only PickupAddressID; the
    // D1 address-snapshot fallback step must survive the split.
    behavior.upstreamBody = '{"success":true}';
    const env = makeEnv(fallbackDb({ pickup_address_id: 10, customer_id: 5 }));

    // Act
    const res = await post("/api/v1/data/container", fieldsBody({ PickupAddressID: "10" }), env);

    // Assert
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      customerId: number | null;
      localSync: unknown;
    };
    expect(body.ok).toBe(true);
    expect(body.customerId).toBe(5);
    expect(body.localSync).toEqual({
      done: true,
      customerId: 5,
      addressIds: [10],
      containerIds: [100]
    });
    expect(calls.synced).toEqual([5]);
    expectSaveOrder("container", 5);
  });
});

describe("POST error-shape parity through the route", () => {
  const saveRoutes = [
    {
      name: "customer",
      path: "/api/v1/data/customer",
      emptyDetail:
        "POST application/x-www-form-urlencoded (SaveCustomerLongForm fields). See docs/PROBLEMS.md#bad-request."
    },
    {
      name: "address",
      path: "/api/v1/data/address",
      emptyDetail:
        "POST application/x-www-form-urlencoded (SaveAddressForm fields). See docs/PROBLEMS.md#bad-request."
    },
    {
      name: "container",
      path: "/api/v1/data/container",
      emptyDetail:
        "POST application/x-www-form-urlencoded (SaveContainerForm fields). See docs/PROBLEMS.md#bad-request."
    }
  ] as const;

  for (const spec of saveRoutes) {
    it(`returns 400 for an empty body on ${spec.path}`, async () => {
      // Arrange / Act
      const res = await post(spec.path, "");

      // Assert
      expect(res.status).toBe(400);
      const body = (await res.json()) as { title: string; detail: string };
      expect(body.title).toBe("Bad Request");
      expect(body.detail).toBe(spec.emptyDetail);
      expect(calls.forwarded).toEqual([]);
      expect(order.some((s) => s.startsWith("forward:"))).toBe(false);
    });

    it(`returns 400 when body preparation yields nothing on ${spec.path}`, async () => {
      // Arrange
      behavior.prepareReturnsNull = true;

      // Act
      const res = await post(spec.path, fieldsBody({ CustomerID: "5" }));

      // Assert
      expect(res.status).toBe(400);
      const body = (await res.json()) as { title: string };
      expect(body.title).toBe("Bad Request");
      expect(calls.forwarded).toEqual([]);
    });

    it(`returns 502 without forwarding when preparation fails on ${spec.path}`, async () => {
      // Arrange — a failed token fetch must not reach Routeware and must not
      // be reported as a client error.
      behavior.prepareError = "token fetch failed";

      // Act
      const res = await post(spec.path, fieldsBody({ CustomerID: "5" }));

      // Assert
      expect(res.status).toBe(502);
      const body = (await res.json()) as { title: string; detail: string };
      expect(body.title).toBe("Bad Gateway");
      expect(body.detail).toBe("token fetch failed See docs/PROBLEMS.md#bad-gateway.");
      expect(calls.forwarded).toEqual([]);
    });

    it(`mirrors an upstream failure without syncing or echoing PII on ${spec.path}`, async () => {
      // Arrange — a 503 carrying PII-shaped HTML survives only as a byte count.
      behavior.upstreamStatus = 503;
      behavior.upstreamBody = '<html><body>Error — customer "Jane Example" phone 555-0199</body></html>';

      // Act
      const res = await post(spec.path, fieldsBody({ CustomerID: "5", CompanyName: "Acme" }));

      // Assert
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        ok: boolean;
        routewareStatus: number;
        upstreamBytes: unknown;
        localSync: unknown;
      };
      expect(body.ok).toBe(false);
      expect(body.routewareStatus).toBe(503);
      expect(typeof body.upstreamBytes).toBe("number");
      expect(body.localSync).toEqual({ done: false, code: "not_attempted" });
      const raw = JSON.stringify(body);
      expect(raw).not.toContain("Acme");
      expect(raw).not.toContain("Jane Example");
      expect(raw).not.toContain("555-0199");
      expect("posted" in body).toBe(false);
      expect("upstream" in body).toBe(false);
      expect(calls.synced).toEqual([]);
      expect(calls.entity).toEqual([]);
    });

    it(`does not reach the save steps without the sync secret on ${spec.path}`, async () => {
      // Arrange / Act
      const res = await post(spec.path, fieldsBody({ CustomerID: "5" }), makeEnv(), "not-the-secret");

      // Assert
      expect(res.status).toBe(401);
      expect(order.some((s) => s.startsWith("prepare:"))).toBe(false);
      expect(calls.forwarded).toEqual([]);
    });
  }

  it("returns 400 when a new address posts no CustomerID", async () => {
    // Arrange
    behavior.prepareError = "New address requires CustomerID in POST body";

    // Act
    const res = await post("/api/v1/data/address", fieldsBody({ PickupAddressID: "0" }));

    // Assert
    expect(res.status).toBe(400);
    const body = (await res.json()) as { title: string; detail: string };
    expect(body.title).toBe("Bad Request");
    expect(body.detail).toBe(
      "New address requires CustomerID in POST body. See docs/PROBLEMS.md#bad-request."
    );
    expect(calls.forwarded).toEqual([]);
  });

  it("returns 400 when a new container posts no PickupAddressID", async () => {
    // Arrange
    behavior.prepareError = "New container requires PickupAddressID in POST body";

    // Act
    const res = await post("/api/v1/data/container", fieldsBody({ ContainerID: "0" }));

    // Assert
    expect(res.status).toBe(400);
    const body = (await res.json()) as { title: string; detail: string };
    expect(body.title).toBe("Bad Request");
    expect(body.detail).toBe(
      "New container requires PickupAddressID in POST body. See docs/PROBLEMS.md#bad-request."
    );
    expect(calls.forwarded).toEqual([]);
  });

  it("evicts the rejected token on the silent-failure path instead of syncing", async () => {
    // Arrange — TOG-8149: upstream 200 carrying a login page means the token
    // was rejected; it must be evicted so the next token-less save refetches,
    // and no D1 sync may run off a failed save.
    behavior.upstreamStatus = 200;
    behavior.upstreamBody = "<html><body>login required</body></html>";

    // Act
    const res = await post("/api/v1/data/customer", fieldsBody({ CustomerID: "5" }));

    // Assert
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; localSync: unknown };
    expect(body.ok).toBe(false);
    expect(body.localSync).toEqual({ done: false, code: "not_attempted" });
    expect(calls.evicted).toHaveLength(1);
    expect(order).toContain("evict");
    expect(calls.synced).toEqual([]);
    expect(calls.graph).toEqual([]);
  });
});

describe("POST sync-failure parity through the route", () => {
  it("keeps the upstream customer 200 and falls back to single-entity invalidation", async () => {
    // Arrange — the save reached Routeware; only the shadow-copy sync failed.
    // The D1 error text must not reach the client: fixed `code` only.
    behavior.syncError = "D1_ERROR: no such table";

    // Act
    const res = await post("/api/v1/data/customer", fieldsBody({ CustomerID: "5" }));

    // Assert
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; localSync: unknown };
    expect(body.ok).toBe(true);
    expect(body.localSync).toEqual({ done: false, code: "sync_failed" });
    expect(JSON.stringify(body)).not.toContain("D1_ERROR");
    expect(calls.graph).toEqual([]);
    expect(calls.entity).toEqual([{ kind: "customer", id: 5 }]);
  });

  it("invalidates the customer and the posted address when the address sync throws", async () => {
    // Arrange
    behavior.syncError = "boom";

    // Act
    const res = await post(
      "/api/v1/data/address",
      fieldsBody({ CustomerID: "5", PickupAddressID: "10" })
    );

    // Assert
    expect(res.status).toBe(200);
    expect(calls.graph).toEqual([]);
    expect(calls.entity).toEqual([
      { kind: "customer", id: 5 },
      { kind: "address", id: 10 }
    ]);
  });

  it("invalidates the customer and the posted container when the container sync throws", async () => {
    // Arrange
    behavior.syncError = "boom";

    // Act
    const res = await post(
      "/api/v1/data/container",
      fieldsBody({ CustomerID: "5", PickupAddressID: "10", ContainerID: "100" })
    );

    // Assert
    expect(res.status).toBe(200);
    expect(calls.graph).toEqual([]);
    expect(calls.entity).toEqual([
      { kind: "customer", id: 5 },
      { kind: "container", id: 100 }
    ]);
  });
});

describe("POST unknown-customer parity through the route (TOG-6533)", () => {
  it("reports an unresolvable customer id without attempting a sync", async () => {
    // Arrange — nothing in the form and nothing parseable upstream.
    behavior.upstreamBody = "Saved.";

    // Act
    const res = await post("/api/v1/data/customer", fieldsBody({ CompanyName: "New" }));

    // Assert
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      customerId: number | null;
      localSync: unknown;
    };
    expect(body.customerId).toBeNull();
    expect(body.localSync).toEqual({ done: false, code: "unknown_customer_id" });
    expect(calls.synced).toEqual([]);
    expect(calls.entity).toEqual([]);
  });

  it("invalidates the posted address id when the write succeeds with no usable customer id", async () => {
    // Arrange / Act
    const res = await post("/api/v1/data/address", fieldsBody({ PickupAddressID: "10" }));

    // Assert
    expect(res.status).toBe(200);
    const body = (await res.json()) as { localSync: unknown };
    expect(body.localSync).toEqual({ done: false, code: "unknown_customer_id" });
    expect(calls.synced).toEqual([]);
    expect(calls.graph).toEqual([]);
    expect(calls.entity).toEqual([{ kind: "address", id: 10 }]);
  });

  it("invalidates the posted address and container ids when no customer resolves", async () => {
    // Arrange — neither the form nor the address-snapshot fallback yields a
    // customer, but the upstream write succeeded: pre-edit cached bundles
    // must still be dropped.
    const env = makeEnv(fallbackDb({ pickup_address_id: 99, customer_id: 5 }));

    // Act
    const res = await post(
      "/api/v1/data/container",
      fieldsBody({ PickupAddressID: "10", ContainerID: "100" }),
      env
    );

    // Assert
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      customerId: number | null;
      localSync: unknown;
    };
    expect(body.customerId).toBeNull();
    expect(body.localSync).toEqual({ done: false, code: "unknown_customer_id" });
    expect(calls.synced).toEqual([]);
    expect(calls.graph).toEqual([]);
    expect(calls.entity).toEqual([
      { kind: "address", id: 10 },
      { kind: "container", id: 100 }
    ]);
  });
});
