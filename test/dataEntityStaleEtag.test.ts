import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TOG-5834: stale-ETag freshness after POST invalidation.
 *
 * `test/dataEntityHandlers.test.ts` pins each GET handler's conditional-request
 * branches in isolation (304 on match, 200 on mismatch/prefix/superstring,
 * weak/wildcard/list forms) and `test/dataEntityPostHandlers.test.ts` pins
 * each POST handler's invalidation *calls* — but neither proves the lifecycle
 * that matters to a client holding a stale ETag: after a POST evicts the
 * cache entry, a GET carrying the *old* ETag must return 200 with fresh data,
 * not a 304 derived from the evicted entry.
 *
 * Each test walks that loop: cold GET learns the ETag, POST evicts the entry
 * (invalidating the whole customer graph, as the handlers do), the D1 row is
 * mutated behind the cache (so a stale hit is observable as old data, not
 * just an old opaque ETag), then the stale-ETag GET must re-read D1 and serve
 * the new body with a new ETag. One loop per table; the address/container
 * loops exercise graph invalidation (the customer POST's ids would not evict
 * sibling entries), mirroring the real write path.
 *
 * The doubles are a real key-value store (clone on write and on read, like
 * the Workers Cache API) keyed by entity kind + id, so customer 5 and
 * container 5 cannot cross-pollute. A mock that merely recorded invalidation
 * calls could not serve the second GET from cache and could not prove the
 * eviction took effect. The fake D1 counts every `prepare()` call: the 200
 * after POST asserts reads happened (entry was evicted), and the final
 * conditional GET asserts zero reads (served from the repopulated cache).
 */

const cacheStore = new Map<string, Response>();

function cacheKey(kind: string, id: number): string {
  return `https://routeware-shadow-entity/v1/${kind}/${id}`;
}

vi.mock("../src/lib/entityDataCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/entityDataCache")>();
  return {
    ...actual,
    getCachedDataEntity: async (kind: string, id: number) => {
      const hit = cacheStore.get(cacheKey(kind, id));
      return hit ? hit.clone() : undefined;
    },
    putCachedDataEntity: async (kind: string, id: number, res: Response) => {
      cacheStore.set(cacheKey(kind, id), res.clone());
    },
    invalidateDataEntity: async (kind: string, id: number) => {
      cacheStore.delete(cacheKey(kind, id));
    },
    invalidateCustomerGraph: async (p: {
      customerId: number;
      addressIds: number[];
      containerIds: number[];
    }) => {
      cacheStore.delete(cacheKey("customer", p.customerId));
      for (const id of p.addressIds) {
        cacheStore.delete(cacheKey("address", id));
      }
      for (const id of p.containerIds) {
        cacheStore.delete(cacheKey("container", id));
      }
    },
    // TOG-6534: handlers now call the retry wrapper; evict the same keys.
    invalidateCustomerGraphWithRetry: async (p: {
      customerId: number;
      addressIds: number[];
      containerIds: number[];
    }) => {
      cacheStore.delete(cacheKey("customer", p.customerId));
      for (const id of p.addressIds) {
        cacheStore.delete(cacheKey("address", id));
      }
      for (const id of p.containerIds) {
        cacheStore.delete(cacheKey("container", id));
      }
    }
  };
});

/** Anti-forgery preparation is a passthrough: the token path is covered elsewhere. */
function prepared(buf: ArrayBuffer | null): ArrayBuffer | null {
  return buf;
}

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
  forwardWithSessionRetry: async () => new Response('{"success":true}', { status: 200 })
}));

vi.mock("../src/lib/detailFullSync", () => ({
  syncCustomerDetailFullToD1: async () => ({ addressIds: [10], containerIds: [100] })
}));

const {
  handleGetDataAddress,
  handleGetDataContainer,
  handleGetDataCustomer,
  handlePostDataAddress,
  handlePostDataContainer,
  handlePostDataCustomer
} = await import("../src/lib/dataEntityHandlers");
type GetCtx = Parameters<typeof handleGetDataCustomer>[0];
type PostCtx = Parameters<typeof handlePostDataCustomer>[0];

type Row = Record<string, unknown>;

/** Mutable tables so a test can change the data behind the cache mid-round-trip. */
const tables: { customer: Row | null; addresses: Row[]; containers: Row[] } = {
  customer: null,
  addresses: [],
  containers: []
};

let dbReads = 0;

function fakeDb(): D1Database {
  const keyed = (row: Row | null | undefined, key: string, args: unknown[]): Row | null =>
    row && args.includes(row[key]) ? row : null;

  const db = {
    prepare(sql: string) {
      dbReads += 1;
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("FROM customer_snapshot")) {
                return keyed(tables.customer, "customer_id", args) as T;
              }
              if (sql.includes("FROM address_snapshot")) {
                return (
                  tables.addresses.find((r) => args.includes(r.pickup_address_id)) ?? null
                ) as T;
              }
              if (sql.includes("FROM container_snapshot")) {
                return (
                  tables.containers.find((r) => args.includes(r.container_id)) ?? null
                ) as T;
              }
              return null;
            },
            async all<T>() {
              if (sql.includes("FROM address_snapshot")) {
                return {
                  results: tables.addresses.filter((r) => args.includes(r.customer_id)) as T[]
                };
              }
              if (sql.includes("FROM container_snapshot")) {
                return {
                  results: tables.containers.filter((r) =>
                    args.includes(r.pickup_address_id)
                  ) as T[]
                };
              }
              return { results: [] as T[] };
            }
          };
        }
      };
    }
  };
  return db as unknown as D1Database;
}

const sessionStub = {
  fetch: async () =>
    new Response(
      JSON.stringify({ cookieHeader: null, expiresAtMs: null, refreshing: false })
    )
} as unknown as DurableObjectStub;

function getCtx(db: D1Database, ifNoneMatch?: string): GetCtx {
  return {
    env: { CUSTOMER_DB: db } as unknown as Env,
    var: { bodyBuffer: null, sessionStub },
    req: {
      raw: new Request("http://test.local/api/v1/data/customer?id=5"),
      header: (n: string) => (n.toLowerCase() === "if-none-match" ? ifNoneMatch : undefined)
    }
  } as GetCtx;
}

function postCtx(fields: Record<string, string>, db: D1Database): PostCtx {
  const buf = new TextEncoder().encode(new URLSearchParams(fields).toString())
    .buffer as ArrayBuffer;
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
  } as PostCtx;
}

function seedTables(): void {
  tables.customer = { customer_id: 5, company_name: "Acme" };
  tables.addresses = [{ pickup_address_id: 10, customer_id: 5, city: "Killeen" }];
  tables.containers = [{ container_id: 100, pickup_address_id: 10, serial_number: "SN-1" }];
}

beforeEach(() => {
  cacheStore.clear();
  seedTables();
  dbReads = 0;
});

describe("data-entity stale-ETag freshness after POST (TOG-5834)", () => {
  it("customer: a GET with the pre-POST ETag returns 200 with fresh data, then 304s on the new ETag", async () => {
    const db = fakeDb();

    // Arrange — cold GET learns the ETag and populates the cache.
    const first = await handleGetDataCustomer(getCtx(db), 5);
    expect(first.status).toBe(200);
    const stale = first.headers.get("X-Entity-ETag") as string;
    expect(stale).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await first.clone().json())).toContain("Acme");

    // Act — the shadow data changes, then a write evicts the entry.
    tables.customer!.company_name = "Acme v2";
    const posted = await handlePostDataCustomer(postCtx({ CustomerID: "5" }, db));
    expect(posted.status).toBe(200);

    // Assert — the client's stale copy must not 304: D1 re-read, new data,
    // new ETag. A stale cache hit would still say "Acme" with the old ETag
    // and zero reads.
    dbReads = 0;
    const fresh = await handleGetDataCustomer(getCtx(db, `"${stale}"`), 5);
    expect(fresh.status).toBe(200);
    expect(dbReads).toBeGreaterThan(0);
    const freshEtag = fresh.headers.get("X-Entity-ETag") as string;
    expect(freshEtag).not.toBe(stale);
    expect(fresh.headers.get("ETag")).toBe(`"${freshEtag}"`);
    expect(JSON.stringify(await fresh.json())).toContain("Acme v2");

    // Act — conditional GET with the fresh ETag.
    dbReads = 0;
    const notModified = await handleGetDataCustomer(getCtx(db, `"${freshEtag}"`), 5);

    // Assert — 304 served from the repopulated cache entry, D1 untouched.
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    expect(notModified.headers.get("ETag")).toBe(`"${freshEtag}"`);
    expect(dbReads).toBe(0);
  });

  it("address: a GET with the pre-POST ETag returns 200 with fresh data, then 304s on the new ETag", async () => {
    const db = fakeDb();

    // Arrange — cold GET learns the ETag and populates the cache.
    const first = await handleGetDataAddress(getCtx(db), 10);
    expect(first.status).toBe(200);
    const stale = first.headers.get("X-Entity-ETag") as string;
    expect(stale).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await first.clone().json())).toContain("Killeen");

    // Act — the shadow data changes, then an address write evicts the entry
    // via the customer-graph invalidation.
    tables.addresses[0]!.city = "Harker Heights";
    const posted = await handlePostDataAddress(
      postCtx({ CustomerID: "5", PickupAddressID: "10" }, db)
    );
    expect(posted.status).toBe(200);

    // Assert — stale ETag must not 304 after eviction.
    dbReads = 0;
    const fresh = await handleGetDataAddress(getCtx(db, `"${stale}"`), 10);
    expect(fresh.status).toBe(200);
    expect(dbReads).toBeGreaterThan(0);
    const freshEtag = fresh.headers.get("X-Entity-ETag") as string;
    expect(freshEtag).not.toBe(stale);
    expect(JSON.stringify(await fresh.json())).toContain("Harker Heights");

    // Act — conditional GET with the fresh ETag.
    dbReads = 0;
    const notModified = await handleGetDataAddress(getCtx(db, `"${freshEtag}"`), 10);

    // Assert
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    expect(dbReads).toBe(0);
  });

  it("container: a GET with the pre-POST ETag returns 200 with fresh data, then 304s on the new ETag", async () => {
    const db = fakeDb();

    // Arrange — cold GET learns the ETag and populates the cache.
    const first = await handleGetDataContainer(getCtx(db), 100);
    expect(first.status).toBe(200);
    const stale = first.headers.get("X-Entity-ETag") as string;
    expect(stale).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await first.clone().json())).toContain("SN-1");

    // Act — the shadow data changes, then a container write evicts the entry
    // via the customer-graph invalidation.
    tables.containers[0]!.serial_number = "SN-2";
    const posted = await handlePostDataContainer(
      postCtx({ CustomerID: "5", PickupAddressID: "10", ContainerID: "100" }, db)
    );
    expect(posted.status).toBe(200);

    // Assert — stale ETag must not 304 after eviction.
    dbReads = 0;
    const fresh = await handleGetDataContainer(getCtx(db, `"${stale}"`), 100);
    expect(fresh.status).toBe(200);
    expect(dbReads).toBeGreaterThan(0);
    const freshEtag = fresh.headers.get("X-Entity-ETag") as string;
    expect(freshEtag).not.toBe(stale);
    expect(JSON.stringify(await fresh.json())).toContain("SN-2");

    // Act — conditional GET with the fresh ETag.
    dbReads = 0;
    const notModified = await handleGetDataContainer(getCtx(db, `"${freshEtag}"`), 100);

    // Assert
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    expect(dbReads).toBe(0);
  });
});
