import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TOG-7375: cross-graph ETag invalidation after POST.
 *
 * `test/dataEntityEtagRoundTrip.test.ts` walks the GET→304→POST→fresh loop
 * for one entity at a time, and `test/dataEntityStaleEtag.test.ts` walks the
 * stale-ETag variant — but each loop only re-reads the entity that was
 * posted. The handlers invalidate the whole customer graph on every
 * successful POST (`invalidateCustomerGraphWithRetry` with the synced
 * address/container ids), and no test proves the sibling entries are
 * actually evicted: a stale address/container cache hit after a customer
 * POST would serve pre-edit PII with zero D1 reads.
 *
 * These tests pin the graph lifecycle a client depends on: cold-GET all
 * three entities, POST once, then every sibling GET with its pre-POST ETag
 * must return 200 with fresh data (D1 re-read, new ETag) — in both
 * directions (customer POST evicts address/container; container POST evicts
 * the owning customer).
 *
 * The doubles mirror the round-trip suite: a real key-value cache double
 * (clone on write/read, keyed by kind + id) and a fake D1 that counts every
 * `prepare()` call, with mutable tables so stale hits are observable as old
 * data, not just old opaque ETags.
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
    // Handlers call the retry wrapper; evict the same keys.
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
  // TOG-8149: the handlers evict the rejected token on the silent-failure
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
  syncCustomerDetailFullToD1: async () => ({ addressIds: [10], containerIds: [100] }),
  detailFullInvalidateAttempts: () => 2
}));

const {
  handleGetDataAddress,
  handleGetDataContainer,
  handleGetDataCustomer,
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

function getCtx(db: D1Database, path: string, ifNoneMatch?: string): GetCtx {
  return {
    env: { CUSTOMER_DB: db } as unknown as Env,
    var: { bodyBuffer: null, sessionStub },
    req: {
      raw: new Request(`http://test.local${path}`),
      header: (n: string) => (n.toLowerCase() === "if-none-match" ? ifNoneMatch : undefined)
    }
  } as GetCtx;
}

function postCtx(path: string, fields: Record<string, string>, db: D1Database): PostCtx {
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
      raw: new Request(`http://test.local${path}`, {
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

describe("data-entity cross-graph ETag invalidation (TOG-7375)", () => {
  it("customer POST evicts sibling address+container entries: stale ETags 200 with fresh data", async () => {
    const db = fakeDb();

    // Arrange — cold GETs learn each entity's ETag and populate the cache.
    const firstCustomer = await handleGetDataCustomer(
      getCtx(db, "/api/v1/data/customer?id=5"),
      5
    );
    const firstAddress = await handleGetDataAddress(
      getCtx(db, "/api/v1/data/address?id=10"),
      10
    );
    const firstContainer = await handleGetDataContainer(
      getCtx(db, "/api/v1/data/container?id=100"),
      100
    );
    expect(firstCustomer.status).toBe(200);
    expect(firstAddress.status).toBe(200);
    expect(firstContainer.status).toBe(200);
    const staleCustomer = firstCustomer.headers.get("X-Entity-ETag") as string;
    const staleAddress = firstAddress.headers.get("X-Entity-ETag") as string;
    const staleContainer = firstContainer.headers.get("X-Entity-ETag") as string;

    // Act — the shadow data changes behind the cache, then one customer
    // write evicts the whole graph (sync reports address 10, container 100).
    tables.customer!.company_name = "Acme v2";
    tables.addresses[0]!.city = "Harker Heights";
    tables.containers[0]!.serial_number = "SN-2";
    const posted = await handlePostDataCustomer(
      postCtx("/api/v1/data/customer", { CustomerID: "5" }, db)
    );
    expect(posted.status).toBe(200);

    // Assert — the customer entry is fresh (covered by the round-trip suite,
    // repeated here so one test owns the whole graph lifecycle).
    dbReads = 0;
    const freshCustomer = await handleGetDataCustomer(
      getCtx(db, "/api/v1/data/customer?id=5", `"${staleCustomer}"`),
      5
    );
    expect(freshCustomer.status).toBe(200);
    expect(dbReads).toBeGreaterThan(0);
    expect(freshCustomer.headers.get("X-Entity-ETag")).not.toBe(staleCustomer);
    expect(JSON.stringify(await freshCustomer.json())).toContain("Acme v2");

    // Assert — the sibling address entry was evicted too: stale ETag must
    // not 304, D1 is re-read, new data, new ETag. A missed eviction would
    // serve "Killeen" with zero reads.
    dbReads = 0;
    const freshAddress = await handleGetDataAddress(
      getCtx(db, "/api/v1/data/address?id=10", `"${staleAddress}"`),
      10
    );
    expect(freshAddress.status).toBe(200);
    expect(dbReads).toBeGreaterThan(0);
    expect(freshAddress.headers.get("X-Entity-ETag")).not.toBe(staleAddress);
    expect(JSON.stringify(await freshAddress.json())).toContain("Harker Heights");

    // Assert — same for the sibling container entry.
    dbReads = 0;
    const freshContainer = await handleGetDataContainer(
      getCtx(db, "/api/v1/data/container?id=100", `"${staleContainer}"`),
      100
    );
    expect(freshContainer.status).toBe(200);
    expect(dbReads).toBeGreaterThan(0);
    expect(freshContainer.headers.get("X-Entity-ETag")).not.toBe(staleContainer);
    expect(JSON.stringify(await freshContainer.json())).toContain("SN-2");
  });

  it("container POST evicts the owning customer entry: stale customer ETag 200s with fresh data", async () => {
    const db = fakeDb();

    // Arrange — cold GET learns the customer ETag and populates the cache.
    const first = await handleGetDataCustomer(getCtx(db, "/api/v1/data/customer?id=5"), 5);
    expect(first.status).toBe(200);
    const stale = first.headers.get("X-Entity-ETag") as string;
    expect(stale).toMatch(/^[0-9a-f]{64}$/);

    // Act — the shadow data changes, then a container write evicts the whole
    // owning-customer graph (sync reports address 10, container 100).
    tables.customer!.company_name = "Acme v2";
    tables.containers[0]!.serial_number = "SN-2";
    const posted = await handlePostDataContainer(
      postCtx(
        "/api/v1/data/container",
        { CustomerID: "5", PickupAddressID: "10", ContainerID: "100" },
        db
      )
    );
    expect(posted.status).toBe(200);

    // Assert — the customer entry was evicted by the sibling write: stale
    // ETag must not 304, D1 is re-read, new data, new ETag.
    dbReads = 0;
    const fresh = await handleGetDataCustomer(
      getCtx(db, "/api/v1/data/customer?id=5", `"${stale}"`),
      5
    );
    expect(fresh.status).toBe(200);
    expect(dbReads).toBeGreaterThan(0);
    const freshEtag = fresh.headers.get("X-Entity-ETag") as string;
    expect(freshEtag).not.toBe(stale);
    expect(JSON.stringify(await fresh.json())).toContain("Acme v2");

    // Act — conditional GET with the fresh ETag.
    dbReads = 0;
    const notModified = await handleGetDataCustomer(
      getCtx(db, "/api/v1/data/customer?id=5", `"${freshEtag}"`),
      5
    );

    // Assert — 304 served from the repopulated cache entry, D1 untouched.
    expect(notModified.status).toBe(304);
    expect(await notModified.text()).toBe("");
    expect(dbReads).toBe(0);
  });
});
