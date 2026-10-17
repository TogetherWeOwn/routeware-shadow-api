import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ETag/304 round-trips for `GET /api/v1/data/customer|address|container`.
 *
 * `test/dataEntityHandlers.test.ts` pins each GET handler's conditional-request
 * branches in isolation and `test/dataEntityPostHandlers.test.ts` pins each POST
 * handler's invalidation calls — but neither proves the lifecycle that matters to
 * a client: first GET populates the cache, a repeat with `If-None-Match` gets a
 * 304 without touching D1, and a POST evicts the entry so the next GET serves
 * fresh data. One test per table walks that full loop.
 *
 * The doubles are load-bearing, not incidental:
 *
 * - The `entityDataCache` double is a real key-value store (clone on write and
 *   on read, like the Workers Cache API) keyed by entity kind + id, so customer
 *   5 and container 5 cannot cross-pollute. A mock that merely recorded calls
 *   could not serve a second GET from cache.
 * - The fake D1 counts every `prepare()` call. The 304-from-cache and
 *   plain-repeat GETs assert zero reads (served from cache), and the post-POST
 *   GET asserts reads happened (entry was evicted). Remove the `putCached` /
 *   `getCached` calls and the middle assertions fail; remove the POST
 *   invalidation and the final GET serves the stale body with the stale ETag.
 * - The D1 row is mutated between the POST and the final GET, so a stale cache
 *   hit is observable as old data, not just an old opaque ETag.
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
    // Handlers now call the retry wrapper; evict the same keys.
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
  ) => prepared(buf),
  // The handlers evict the rejected token on the silent-failure
  // path; this double carries no cache, so the evict is a no-op.
  evictAntiForgeryTokenCacheForBody: () => false
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

describe("data-entity ETag round-trips", () => {
  it("customer: GET caches, If-None-Match 304s from cache, POST invalidates", async () => {
    const db = fakeDb();

    // Arrange + Act — cold GET populates the cache.
    dbReads = 0;
    const first = await handleGetDataCustomer(getCtx(db), 5);

    // Assert
    expect(first.status).toBe(200);
    const etag = first.headers.get("X-Entity-ETag");
    expect(etag).toMatch(/^[0-9a-f]{64}$/);
    expect(first.headers.get("ETag")).toBe(`"${etag}"`);
    expect(dbReads).toBeGreaterThan(0);
    expect(JSON.stringify(await first.clone().json())).toContain("Acme");

    // Act — conditional GET with the fresh ETag.
    dbReads = 0;
    const notModified = await handleGetDataCustomer(getCtx(db, `"${etag}"`), 5);

    // Assert — 304 served from the cache entry, D1 untouched.
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    expect(notModified.headers.get("ETag")).toBe(`"${etag}"`);
    expect(dbReads).toBe(0);

    // Act — plain repeat GET.
    dbReads = 0;
    const cached = await handleGetDataCustomer(getCtx(db), 5);

    // Assert — cached body, D1 untouched.
    expect(cached.status).toBe(200);
    expect(dbReads).toBe(0);
    expect(JSON.stringify(await cached.json())).toContain("Acme");

    // Arrange — the shadow data changes, then a write evicts the entry.
    tables.customer!.company_name = "Acme v2";
    const posted = await handlePostDataCustomer(postCtx({ CustomerID: "5" }, db));

    // Assert
    expect(posted.status).toBe(200);

    // Act — GET after the POST.
    dbReads = 0;
    const fresh = await handleGetDataCustomer(getCtx(db), 5);

    // Assert — D1 re-read, new data, new ETag. A stale cache hit would still
    // say "Acme" with the old ETag and zero reads.
    expect(fresh.status).toBe(200);
    expect(dbReads).toBeGreaterThan(0);
    const freshEtag = fresh.headers.get("X-Entity-ETag");
    expect(freshEtag).not.toBe(etag);
    expect(JSON.stringify(await fresh.json())).toContain("Acme v2");
  });

  it("address: GET caches, If-None-Match 304s from cache, POST invalidates", async () => {
    const db = fakeDb();

    // Arrange + Act — cold GET populates the cache.
    dbReads = 0;
    const first = await handleGetDataAddress(getCtx(db), 10);

    // Assert
    expect(first.status).toBe(200);
    const etag = first.headers.get("X-Entity-ETag");
    expect(etag).toMatch(/^[0-9a-f]{64}$/);
    expect(first.headers.get("ETag")).toBe(`"${etag}"`);
    expect(dbReads).toBeGreaterThan(0);
    expect(JSON.stringify(await first.clone().json())).toContain("Killeen");

    // Act — conditional GET with the fresh ETag.
    dbReads = 0;
    const notModified = await handleGetDataAddress(getCtx(db, `"${etag}"`), 10);

    // Assert — 304 served from the cache entry, D1 untouched.
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    expect(dbReads).toBe(0);

    // Arrange — the shadow data changes, then an address write evicts the entry
    // via the customer-graph invalidation.
    tables.addresses[0]!.city = "Harker Heights";
    const posted = await handlePostDataAddress(
      postCtx({ CustomerID: "5", PickupAddressID: "10" }, db)
    );

    // Assert
    expect(posted.status).toBe(200);

    // Act — GET after the POST.
    dbReads = 0;
    const fresh = await handleGetDataAddress(getCtx(db), 10);

    // Assert — D1 re-read, new data, new ETag.
    expect(fresh.status).toBe(200);
    expect(dbReads).toBeGreaterThan(0);
    expect(fresh.headers.get("X-Entity-ETag")).not.toBe(etag);
    expect(JSON.stringify(await fresh.json())).toContain("Harker Heights");
  });

  it("container: GET caches, If-None-Match 304s from cache, POST invalidates", async () => {
    const db = fakeDb();

    // Arrange + Act — cold GET populates the cache.
    dbReads = 0;
    const first = await handleGetDataContainer(getCtx(db), 100);

    // Assert
    expect(first.status).toBe(200);
    const etag = first.headers.get("X-Entity-ETag");
    expect(etag).toMatch(/^[0-9a-f]{64}$/);
    expect(first.headers.get("ETag")).toBe(`"${etag}"`);
    expect(dbReads).toBeGreaterThan(0);
    expect(JSON.stringify(await first.clone().json())).toContain("SN-1");

    // Act — conditional GET with the fresh ETag.
    dbReads = 0;
    const notModified = await handleGetDataContainer(getCtx(db, `"${etag}"`), 100);

    // Assert — 304 served from the cache entry, D1 untouched.
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    expect(dbReads).toBe(0);

    // Arrange — the shadow data changes, then a container write evicts the entry
    // via the customer-graph invalidation.
    tables.containers[0]!.serial_number = "SN-2";
    const posted = await handlePostDataContainer(
      postCtx({ CustomerID: "5", PickupAddressID: "10", ContainerID: "100" }, db)
    );

    // Assert
    expect(posted.status).toBe(200);

    // Act — GET after the POST.
    dbReads = 0;
    const fresh = await handleGetDataContainer(getCtx(db), 100);

    // Assert — D1 re-read, new data, new ETag.
    expect(fresh.status).toBe(200);
    expect(dbReads).toBeGreaterThan(0);
    expect(fresh.headers.get("X-Entity-ETag")).not.toBe(etag);
    expect(JSON.stringify(await fresh.json())).toContain("SN-2");
  });
});
