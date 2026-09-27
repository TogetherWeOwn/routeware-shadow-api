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
} = { entry: undefined, putError: null, deleteError: null };

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
  invalidateDataEntity,
  putCachedDataEntity,
  resetEntityDataCacheStats,
  sha256Etag
} = await import("../src/lib/entityDataCache");

const loggedWarnings: unknown[][] = [];
const loggedLines: unknown[][] = [];
const realConsoleWarn = console.warn;
const realConsoleLog = console.log;

beforeEach(() => {
  cacheOps.matches = [];
  cacheOps.puts = [];
  cacheOps.deletes = [];
  behavior.entry = undefined;
  behavior.putError = null;
  behavior.deleteError = null;
  resetEntityDataCacheStats();
  loggedWarnings.length = 0;
  loggedLines.length = 0;
  console.warn = (...args: unknown[]) => {
    loggedWarnings.push(args);
  };
  console.log = (...args: unknown[]) => {
    loggedLines.push(args);
  };
});

afterEach(() => {
  console.warn = realConsoleWarn;
  console.log = realConsoleLog;
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
    expect(String(loggedWarnings[0][0])).toContain("Cache put failed for address/10");
    expect(loggedWarnings[0][1]).toBe("body too large");
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
});

describe("TTL centralization (TOG-6294)", () => {
  it("exposes the shared TTL and renders the Cache-Control value from it", () => {
    // Arrange / Act / Assert — one constant feeds every 200/304 header, so a
    // tuning change cannot miss a call site.
    expect(ENTITY_DATA_CACHE_MAX_AGE_SECONDS).toBe(60);
    expect(entityDataCacheControlValue()).toBe(
      `private, max-age=${ENTITY_DATA_CACHE_MAX_AGE_SECONDS}`
    );
  });
});

describe("hit/miss observability (TOG-6294)", () => {
  it("logs a count-only miss line and counts it per entity kind", async () => {
    // Arrange / Act
    await getCachedDataEntity("customer", 5);

    // Assert
    expect(loggedLines).toHaveLength(1);
    expect(loggedLines[0][0]).toBe("entityDataCache customer miss hits=0 misses=1");
    expect(getEntityDataCacheStats().customer).toEqual({ hits: 0, misses: 1 });
  });

  it("logs a count-only hit line and accumulates running totals", async () => {
    // Arrange
    behavior.entry = new Response('{"cached":true}');

    // Act
    await getCachedDataEntity("address", 10);
    await getCachedDataEntity("address", 11);

    // Assert
    expect(loggedLines).toHaveLength(2);
    expect(loggedLines[0][0]).toBe("entityDataCache address hit hits=1 misses=0");
    expect(loggedLines[1][0]).toBe("entityDataCache address hit hits=2 misses=0");
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

  it("never logs ids or bodies in the hit/miss line", async () => {
    // Arrange
    behavior.entry = new Response('{"company_name":"Acme"}');

    // Act
    await getCachedDataEntity("customer", 12345);

    // Assert — the id 12345 and the PII body appear nowhere in the log.
    const line = String(loggedLines[0][0]);
    expect(line).not.toContain("12345");
    expect(line).not.toContain("Acme");
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
