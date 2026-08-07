import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `src/lib/dataEntityHandlers.ts` had zero coverage despite serving the
 * `/api/v1/data/*` routes that read customer PII out of D1.
 *
 * These tests target the conditional-request logic, which is where the subtle
 * bugs live: `matchesIfNoneMatch` parses the RFC 7232 header into tokens and
 * compares them exactly, precisely so a client-supplied prefix of a real ETag
 * cannot produce a false 304. A false 304 would tell a client its stale copy is
 * still current — a correctness bug that no type check would catch.
 *
 * The Workers Cache API is mocked out so cache hits/misses are controllable;
 * everything else (the D1 reads, `sha256Etag`, the bundle serialization) runs
 * for real against a fake `D1Database`.
 */

const cacheState: { entry: Response | null; puts: Array<{ kind: string; id: number }> } = {
  entry: null,
  puts: []
};

vi.mock("../src/lib/entityDataCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/entityDataCache")>();
  return {
    ...actual,
    getCachedDataEntity: vi.fn(async () => cacheState.entry),
    putCachedDataEntity: vi.fn(async (kind: string, id: number) => {
      cacheState.puts.push({ kind, id });
    })
  };
});

const {
  handleGetDataAddress,
  handleGetDataContainer,
  handleGetDataCustomer
} = await import("../src/lib/dataEntityHandlers");
type Ctx = Parameters<typeof handleGetDataCustomer>[0];

type Row = Record<string, unknown>;

type FakeRows = {
  customer?: Row | null;
  address?: Row | null;
  container?: Row | null;
  addresses?: Row[];
  containers?: Row[];
};

/**
 * Fake D1 that dispatches on the table named in the SQL and honours the bound
 * parameters, so a handler that looks a row up by the wrong id (e.g. passing a
 * customer id where a pickup_address_id is expected) gets `null` rather than a
 * canned row. Matches the approach in `dataEntityRead.test.ts`.
 */
function fakeDb(rows: FakeRows): D1Database {
  const keyed = (row: Row | null | undefined, key: string, args: unknown[]): Row | null =>
    row && args.includes(row[key]) ? row : null;

  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.includes("FROM customer_snapshot")) {
                return keyed(rows.customer, "customer_id", args) as T;
              }
              if (sql.includes("FROM address_snapshot")) {
                return keyed(rows.address, "pickup_address_id", args) as T;
              }
              if (sql.includes("FROM container_snapshot")) {
                return keyed(rows.container, "container_id", args) as T;
              }
              return null;
            },
            async all<T>() {
              if (sql.includes("FROM address_snapshot")) {
                const results = (rows.addresses ?? []).filter((r) =>
                  args.includes(r.customer_id)
                );
                return { results: results as T[] };
              }
              if (sql.includes("FROM container_snapshot")) {
                const results = (rows.containers ?? []).filter((r) =>
                  args.includes(r.pickup_address_id)
                );
                return { results: results as T[] };
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

function ctx(db: D1Database, ifNoneMatch?: string): Ctx {
  return {
    env: { CUSTOMER_DB: db } as unknown as Env,
    var: { bodyBuffer: null, sessionStub: {} as unknown as DurableObjectStub },
    req: {
      raw: new Request("http://test.local/api/v1/data/customer?id=5"),
      header: (n: string) => (n.toLowerCase() === "if-none-match" ? ifNoneMatch : undefined)
    }
  } as Ctx;
}

const CUSTOMER_DB_ROWS: FakeRows = {
  customer: { customer_id: 5, company_name: "Acme" },
  addresses: [{ pickup_address_id: 10, customer_id: 5 }],
  containers: [{ container_id: 100, pickup_address_id: 10 }]
};

beforeEach(() => {
  cacheState.entry = null;
  cacheState.puts = [];
});

/** Fetch once to learn the ETag the handler computes for this data. */
async function etagFor(rows: FakeRows = CUSTOMER_DB_ROWS): Promise<string> {
  const res = await handleGetDataCustomer(ctx(fakeDb(rows)), 5);
  const etag = res.headers.get("X-Entity-ETag");
  expect(etag).toBeTruthy();
  return etag as string;
}

describe("handleGetDataCustomer", () => {
  it("returns 404 problem+json when the customer is not in D1", async () => {
    // Arrange
    const c = ctx(fakeDb({ customer: null }));

    // Act
    const res = await handleGetDataCustomer(c, 999);

    // Assert
    expect(res.status).toBe(404);
    const body = (await res.json()) as { title: string; detail: string };
    expect(body.title).toBe("Not found");
    expect(body.detail).toBe("No snapshot data for customer_id=999 (import/sync first).");
  });

  it("returns 200 with a quoted ETag and private caching headers", async () => {
    // Arrange
    const c = ctx(fakeDb(CUSTOMER_DB_ROWS));

    // Act
    const res = await handleGetDataCustomer(c, 5);

    // Assert
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
    const bare = res.headers.get("X-Entity-ETag") as string;
    expect(res.headers.get("ETag")).toBe(`"${bare}"`);
    expect(cacheState.puts).toEqual([{ kind: "customer", id: 5 }]);
  });

  it("returns 304 when If-None-Match carries the current ETag", async () => {
    // Arrange
    const etag = await etagFor();

    // Act
    const res = await handleGetDataCustomer(ctx(fakeDb(CUSTOMER_DB_ROWS), `"${etag}"`), 5);

    // Assert
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(`"${etag}"`);
    expect(await res.text()).toBe("");
  });

  it("accepts a weak validator, a wildcard, and a comma-separated list", async () => {
    // Arrange
    const etag = await etagFor();
    const db = fakeDb(CUSTOMER_DB_ROWS);

    // Act / Assert
    expect((await handleGetDataCustomer(ctx(db, `W/"${etag}"`), 5)).status).toBe(304);
    expect((await handleGetDataCustomer(ctx(db, "*"), 5)).status).toBe(304);
    expect(
      (await handleGetDataCustomer(ctx(db, `"other", W/"${etag}"`), 5)).status
    ).toBe(304);
  });

  it("returns 200 for a non-matching ETag", async () => {
    // Arrange / Act
    const res = await handleGetDataCustomer(ctx(fakeDb(CUSTOMER_DB_ROWS), '"nope"'), 5);

    // Assert
    expect(res.status).toBe(200);
  });

  it("does not treat a prefix of the real ETag as a match", async () => {
    // Arrange — a truncated ETag must not produce a false 304, which would tell
    // the client its stale copy is still current.
    const etag = await etagFor();
    const prefix = etag.slice(0, etag.length - 4);

    // Act
    const res = await handleGetDataCustomer(ctx(fakeDb(CUSTOMER_DB_ROWS), `"${prefix}"`), 5);

    // Assert
    expect(prefix).not.toBe(etag);
    expect(res.status).toBe(200);
  });

  it("does not treat a superstring of the real ETag as a match", async () => {
    // Arrange
    const etag = await etagFor();

    // Act
    const res = await handleGetDataCustomer(ctx(fakeDb(CUSTOMER_DB_ROWS), `"${etag}extra"`), 5);

    // Assert
    expect(res.status).toBe(200);
  });

  it("serves the cached response when the client sends no If-None-Match", async () => {
    // Arrange
    cacheState.entry = new Response('{"cached":true}', {
      status: 200,
      headers: { "X-Entity-ETag": "cached-etag" }
    });

    // Act
    const res = await handleGetDataCustomer(ctx(fakeDb({ customer: null })), 5);

    // Assert — served from cache, so the absent D1 row does not produce a 404.
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"cached":true}');
  });

  it("returns 304 from the cached entry's ETag when If-None-Match matches it", async () => {
    // Arrange
    cacheState.entry = new Response('{"cached":true}', {
      status: 200,
      headers: { "X-Entity-ETag": "cached-etag" }
    });

    // Act
    const res = await handleGetDataCustomer(ctx(fakeDb({ customer: null }), '"cached-etag"'), 5);

    // Assert
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe('"cached-etag"');
  });
});

describe("handleGetDataAddress", () => {
  it("returns 404 when the address row is missing", async () => {
    // Arrange / Act
    const res = await handleGetDataAddress(ctx(fakeDb({ address: null })), 42);

    // Assert
    expect(res.status).toBe(404);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toBe("No snapshot for pickup_address_id=42.");
  });

  it("returns 304 for a matching ETag on its own 304 branch", async () => {
    // Arrange — the address handler has its own copy of the conditional-request
    // branch, so exercise it directly rather than via the customer handler.
    const db = fakeDb({
      address: { pickup_address_id: 10, customer_id: 5 },
      customer: { customer_id: 5 },
      containers: [{ container_id: 100, pickup_address_id: 10 }]
    });
    const first = await handleGetDataAddress(ctx(db), 10);
    const etag = first.headers.get("X-Entity-ETag") as string;

    // Act
    const res = await handleGetDataAddress(ctx(db, `"${etag}"`), 10);

    // Assert
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(`"${etag}"`);
  });

  it("returns 200 and caches under the address key", async () => {
    // Arrange
    const db = fakeDb({
      address: { pickup_address_id: 10, customer_id: 5 },
      customer: { customer_id: 5 },
      containers: [{ container_id: 100, pickup_address_id: 10 }]
    });

    // Act
    const res = await handleGetDataAddress(ctx(db), 10);

    // Assert
    expect(res.status).toBe(200);
    expect(cacheState.puts).toEqual([{ kind: "address", id: 10 }]);
  });
});

describe("handleGetDataContainer", () => {
  it("returns 404 when the container row is missing", async () => {
    // Arrange / Act
    const res = await handleGetDataContainer(ctx(fakeDb({ container: null })), 7);

    // Assert
    expect(res.status).toBe(404);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toBe("No snapshot for container_id=7.");
  });

  it("returns 304 for a matching ETag on its own 304 branch", async () => {
    // Arrange
    const db = fakeDb({
      container: { container_id: 100, pickup_address_id: 10 },
      address: { pickup_address_id: 10, customer_id: 5 },
      customer: { customer_id: 5 }
    });
    const first = await handleGetDataContainer(ctx(db), 100);
    const etag = first.headers.get("X-Entity-ETag") as string;

    // Act
    const res = await handleGetDataContainer(ctx(db, `"${etag}"`), 100);

    // Assert
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(`"${etag}"`);
  });

  it("returns 200 and caches under the container key", async () => {
    // Arrange
    const db = fakeDb({
      container: { container_id: 100, pickup_address_id: 10 },
      address: { pickup_address_id: 10, customer_id: 5 },
      customer: { customer_id: 5 }
    });

    // Act
    const res = await handleGetDataContainer(ctx(db), 100);

    // Assert
    expect(res.status).toBe(200);
    expect(cacheState.puts).toEqual([{ kind: "container", id: 100 }]);
  });
});
