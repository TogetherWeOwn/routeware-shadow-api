import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `src/lib/entityDataCache.ts` decides how long stale customer PII stays
 * readable from the Workers cache. It had no direct test — `dataEntityHandlers`
 * mocks it out — so the two behaviours that matter were unverified.
 *
 * The deliberate asymmetry is the point. `putCachedDataEntity` swallows its
 * errors: the response is already computed and valid, so a failed cache write
 * must not turn a good 200 into a 500. `invalidateDataEntity` does the opposite
 * and lets errors propagate, because a silently failed invalidation means the
 * API keeps serving PII that a write has already superseded. Collapsing the two
 * into one convention breaks whichever half it is applied to.
 *
 * The key namespacing matters for the same reason: customer 5 and container 5
 * must not share a cache entry.
 */

type Put = { url: string; body: string };

const cacheOps: { matches: string[]; puts: Put[]; deletes: string[] } = {
  matches: [],
  puts: [],
  deletes: []
};

const behavior: {
  entry: Response | undefined;
  putError: string | null;
  deleteError: string | null;
  /** Fail the next N deletes, then succeed — simulates a transient mid-graph throw. */
  deleteFailTimes: number;
} = { entry: undefined, putError: null, deleteError: null, deleteFailTimes: 0 };

const fakeCache = {
  async match(request: Request): Promise<Response | undefined> {
    cacheOps.matches.push(request.url);
    return behavior.entry;
  },
  async put(request: Request, response: Response): Promise<void> {
    if (behavior.putError) {
      throw new Error(behavior.putError);
    }
    cacheOps.puts.push({ url: request.url, body: await response.text() });
  },
  async delete(request: Request): Promise<boolean> {
    if (behavior.deleteFailTimes > 0) {
      behavior.deleteFailTimes -= 1;
      throw new Error("transient cache failure");
    }
    if (behavior.deleteError) {
      throw new Error(behavior.deleteError);
    }
    cacheOps.deletes.push(request.url);
    return true;
  }
};

// Stubbed before the dynamic import below, because the module captures
// `caches.default` into a module-level const at import time.
vi.stubGlobal("caches", { default: fakeCache });

const {
  ENTITY_DATA_CACHE_MAX_AGE_SECONDS,
  entityDataCacheControlValue,
  getCachedDataEntity,
  getEntityDataCacheStats,
  invalidateCustomerGraph,
  invalidateCustomerGraphWithRetry,
  invalidateDataEntity,
  putCachedDataEntity,
  resetEntityDataCacheStats,
  sha256Etag
} = await import("../src/lib/entityDataCache");

type CapturedLog = Record<string, unknown>;

const loggedWarnings: CapturedLog[] = [];
const loggedLines: CapturedLog[] = [];
const realConsoleWarn = console.warn;
const realConsoleInfo = console.info;
const loggedErrors: CapturedLog[] = [];
const realConsoleError = console.error;

beforeEach(() => {
  cacheOps.matches = [];
  cacheOps.puts = [];
  cacheOps.deletes = [];
  behavior.entry = undefined;
  behavior.putError = null;
  behavior.deleteError = null;
  behavior.deleteFailTimes = 0;
  resetEntityDataCacheStats();
  loggedWarnings.length = 0;
  loggedLines.length = 0;
  console.warn = (...args: unknown[]) => {
    loggedWarnings.push(args[0] as CapturedLog);
  };
  console.info = (...args: unknown[]) => {
    loggedLines.push(args[0] as CapturedLog);
  };
  loggedErrors.length = 0;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args[0] as CapturedLog);
  };
});

afterEach(() => {
  console.warn = realConsoleWarn;
  console.info = realConsoleInfo;
  console.error = realConsoleError;
});

describe("cache key namespacing", () => {
  it("gives each entity kind its own key space", async () => {
    // Arrange / Act — id 5 means three different things.
    await getCachedDataEntity("customer", 5);
    await getCachedDataEntity("address", 5);
    await getCachedDataEntity("container", 5);

    // Assert
    expect(cacheOps.matches).toEqual([
      "https://routeware-shadow-entity/v1/customer/5",
      "https://routeware-shadow-entity/v1/address/5",
      "https://routeware-shadow-entity/v1/container/5"
    ]);
    expect(new Set(cacheOps.matches).size).toBe(3);
  });

  it("gives each id its own key", async () => {
    // Arrange / Act
    await getCachedDataEntity("customer", 5);
    await getCachedDataEntity("customer", 6);

    // Assert
    expect(cacheOps.matches[0]).not.toBe(cacheOps.matches[1]);
  });

  it("returns undefined on a miss", async () => {
    // Arrange / Act
    const hit = await getCachedDataEntity("customer", 5);

    // Assert
    expect(hit).toBeUndefined();
  });

  it("returns the stored response on a hit", async () => {
    // Arrange
    behavior.entry = new Response('{"cached":true}');

    // Act
    const hit = await getCachedDataEntity("customer", 5);

    // Assert
    expect(await hit?.text()).toBe('{"cached":true}');
  });
});

describe("putCachedDataEntity", () => {
  it("stores the response body under the entity's key", async () => {
    // Arrange
    const response = new Response('{"customer":1}');

    // Act
    await putCachedDataEntity("customer", 5, response);

    // Assert
    expect(cacheOps.puts).toEqual([
      { url: "https://routeware-shadow-entity/v1/customer/5", body: '{"customer":1}' }
    ]);
  });

  it("leaves the caller's response body readable", async () => {
    // Arrange — the handler returns this same response, so caching must clone
    // rather than consume it.
    const response = new Response('{"customer":1}');

    // Act
    await putCachedDataEntity("customer", 5, response);

    // Assert
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe('{"customer":1}');
  });

  it("swallows a cache write failure rather than failing the request", async () => {
    // Arrange — the response is already computed and valid; a failed cache
    // write must not turn a good 200 into a 500.
    behavior.putError = "Cache put failed: body too large";

    // Act
    const result = await putCachedDataEntity("customer", 5, new Response("{}"));

    // Assert
    expect(result).toBeUndefined();
  });

  it("logs the swallowed failure instead of hiding it", async () => {
    // Arrange
    behavior.putError = "body too large";

    // Act
    await putCachedDataEntity("address", 10, new Response("{}"));

    // Assert
    expect(loggedWarnings).toHaveLength(1);
    expect(loggedWarnings[0]).toMatchObject({
      level: "warn",
      msg: "Cache put failed; serving the response uncached",
      route: "cache.entityData",
      entity: "address",
      ms: null
    });
    expect(JSON.stringify(loggedWarnings[0])).not.toContain("body too large");
  });
});

describe("invalidateDataEntity", () => {
  it("deletes the entity's key", async () => {
    // Arrange / Act
    await invalidateDataEntity("container", 100);

    // Assert
    expect(cacheOps.deletes).toEqual(["https://routeware-shadow-entity/v1/container/100"]);
  });

  it("propagates a delete failure rather than swallowing it", async () => {
    // Arrange — the asymmetry with putCachedDataEntity is deliberate: a
    // silently failed invalidation serves superseded PII indefinitely.
    behavior.deleteError = "cache unavailable";

    // Act
    const error = (await invalidateDataEntity("customer", 5).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("cache unavailable");
    expect(loggedWarnings).toEqual([]);
  });
});

describe("invalidateCustomerGraph", () => {
  it("invalidates the customer, every address and every container", async () => {
    // Arrange / Act
    await invalidateCustomerGraph({
      customerId: 5,
      addressIds: [10, 11],
      containerIds: [100, 101, 102]
    });

    // Assert
    expect(new Set(cacheOps.deletes)).toEqual(
      new Set([
        "https://routeware-shadow-entity/v1/customer/5",
        "https://routeware-shadow-entity/v1/address/10",
        "https://routeware-shadow-entity/v1/address/11",
        "https://routeware-shadow-entity/v1/container/100",
        "https://routeware-shadow-entity/v1/container/101",
        "https://routeware-shadow-entity/v1/container/102"
      ])
    );
  });

  it("invalidates the customer even when it has no addresses or containers", async () => {
    // Arrange / Act
    await invalidateCustomerGraph({ customerId: 5, addressIds: [], containerIds: [] });

    // Assert
    expect(cacheOps.deletes).toEqual(["https://routeware-shadow-entity/v1/customer/5"]);
  });

  it("rejects when any single invalidation fails", async () => {
    // Arrange — a partial graph invalidation leaves some entries stale, so it
    // must not report success.
    behavior.deleteError = "cache unavailable";

    // Act
    const error = (await invalidateCustomerGraph({
      customerId: 5,
      addressIds: [10],
      containerIds: []
    }).catch((e: unknown) => e)) as Error;

    // Assert
    expect(error).toBeInstanceOf(Error);
  });

  it("invalidates a graph larger than one chunk without dropping ids", async () => {
    // Arrange — deletes run in bounded sequential chunks; a large
    // graph must still invalidate every id exactly once.
    const addressIds = Array.from({ length: 250 }, (_, i) => 1000 + i);
    const containerIds = Array.from({ length: 300 }, (_, i) => 2000 + i);

    // Act
    await invalidateCustomerGraph({ customerId: 5, addressIds, containerIds });

    // Assert
    expect(cacheOps.deletes).toHaveLength(1 + 250 + 300);
    expect(new Set(cacheOps.deletes).size).toBe(1 + 250 + 300);
    expect(cacheOps.deletes).toContain("https://routeware-shadow-entity/v1/customer/5");
    expect(cacheOps.deletes).toContain("https://routeware-shadow-entity/v1/address/1249");
    expect(cacheOps.deletes).toContain("https://routeware-shadow-entity/v1/container/2299");
  });
});

describe("TTL centralization", () => {
  it("exposes the shared TTL and renders the Cache-Control value from it", () => {
    // Arrange / Act / Assert — one constant feeds every 200/304 header, so a
    // tuning change cannot miss a call site.
    expect(ENTITY_DATA_CACHE_MAX_AGE_SECONDS).toBe(60);
    expect(entityDataCacheControlValue()).toBe(
      `private, max-age=${ENTITY_DATA_CACHE_MAX_AGE_SECONDS}`
    );
  });
});

describe("hit/miss observability", () => {
  it("logs a count-only miss event and counts it per entity kind", async () => {
    // Arrange / Act
    await getCachedDataEntity("customer", 5);

    // Assert
    expect(loggedLines).toHaveLength(1);
    expect(loggedLines[0]).toMatchObject({
      level: "info",
      msg: "Entity data cache miss",
      route: "cache.entityData",
      entity: "customer",
      hits: 0,
      misses: 1,
      ms: null
    });
    expect(getEntityDataCacheStats().customer).toEqual({ hits: 0, misses: 1 });
  });

  it("logs a count-only hit event and accumulates running totals", async () => {
    // Arrange
    behavior.entry = new Response('{"cached":true}');

    // Act
    await getCachedDataEntity("address", 10);
    await getCachedDataEntity("address", 11);

    // Assert
    expect(loggedLines).toHaveLength(2);
    expect(loggedLines[0]).toMatchObject({
      level: "info",
      msg: "Entity data cache hit",
      route: "cache.entityData",
      entity: "address",
      hits: 1,
      misses: 0,
      ms: null
    });
    expect(loggedLines[1]).toMatchObject({
      level: "info",
      msg: "Entity data cache hit",
      route: "cache.entityData",
      entity: "address",
      hits: 2,
      misses: 0,
      ms: null
    });
    expect(getEntityDataCacheStats().address).toEqual({ hits: 2, misses: 0 });
  });

  it("keeps counters separate per entity kind", async () => {
    // Arrange
    behavior.entry = new Response('{"cached":true}');

    // Act
    await getCachedDataEntity("customer", 5);
    await getCachedDataEntity("container", 5);

    // Assert — customer 5 and container 5 share an id but not a counter.
    expect(getEntityDataCacheStats().customer).toEqual({ hits: 1, misses: 0 });
    expect(getEntityDataCacheStats().container).toEqual({ hits: 1, misses: 0 });
    expect(getEntityDataCacheStats().address).toEqual({ hits: 0, misses: 0 });
  });

  it("never logs ids or bodies in the hit/miss event", async () => {
    // Arrange
    behavior.entry = new Response('{"company_name":"Acme"}');

    // Act
    await getCachedDataEntity("customer", 12345);

    // Assert — the id 12345 and the PII body appear nowhere in the log.
    const line = JSON.stringify(loggedLines[0]);
    expect(line).not.toContain("12345");
    expect(line).not.toContain("Acme");
  });
});

describe("invalidateCustomerGraphWithRetry", () => {
  it("invalidates the remaining ids on the retry path after a mid-graph throw", async () => {
    // Arrange — the first whole-graph attempt throws mid-graph (the two
    // deletes that landed stay landed; deletes are idempotent), the retry
    // then completes the graph.
    behavior.deleteFailTimes = 2;

    // Act
    await invalidateCustomerGraphWithRetry({
      customerId: 5,
      addressIds: [10],
      containerIds: [100]
    });

    // Assert — every id invalidated despite the transient mid-graph throw.
    expect(new Set(cacheOps.deletes)).toEqual(
      new Set([
        "https://routeware-shadow-entity/v1/customer/5",
        "https://routeware-shadow-entity/v1/address/10",
        "https://routeware-shadow-entity/v1/container/100"
      ])
    );
    expect(loggedErrors).toHaveLength(1);
    expect(loggedErrors[0]).toMatchObject({
      level: "error",
      msg: "Customer cache graph invalidation failed",
      route: "cache.customerGraph.invalidate",
      attempt: 1,
      attempts: 2,
      ms: null
    });
  });

  it("succeeds without retry noise when the first attempt lands clean", async () => {
    // Arrange / Act
    await invalidateCustomerGraphWithRetry({
      customerId: 5,
      addressIds: [10],
      containerIds: []
    });

    // Assert
    expect(cacheOps.deletes).toEqual([
      "https://routeware-shadow-entity/v1/customer/5",
      "https://routeware-shadow-entity/v1/address/10"
    ]);
    expect(loggedErrors).toEqual([]);
  });

  it("propagates the last error when every attempt fails", async () => {
    // Arrange — persistent outage: both attempts throw.
    behavior.deleteError = "cache unavailable";

    // Act
    const error = (await invalidateCustomerGraphWithRetry({
      customerId: 5,
      addressIds: [10],
      containerIds: []
    }).catch((e: unknown) => e)) as Error;

    // Assert — same loud contract as invalidateCustomerGraph: the caller
    // still must not report success.
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("cache unavailable");
    expect(loggedErrors).toHaveLength(2);
  });
});

describe("sha256Etag", () => {
  it("returns the SHA-256 digest as 64 lowercase hex characters", async () => {
    // Arrange / Act
    const etag = await sha256Etag("hello");

    // Assert
    expect(etag).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the published SHA-256 of a known input", async () => {
    // Arrange / Act — pins the algorithm and hex encoding, not just the shape.
    const etag = await sha256Etag("abc");

    // Assert
    expect(etag).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("is stable for the same input and differs for different input", async () => {
    // Arrange / Act
    const [a, again, b] = await Promise.all([
      sha256Etag('{"customer":1}'),
      sha256Etag('{"customer":1}'),
      sha256Etag('{"customer":2}')
    ]);

    // Assert
    expect(a).toBe(again);
    expect(a).not.toBe(b);
  });
});
