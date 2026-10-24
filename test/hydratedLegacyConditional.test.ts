import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pins the hydrated reads' legacy `If-None-Match` dispatch.
 *
 * `src/lib/dataEntityHandlers.ts` funnels every hydrated conditional read
 * (customer/address/container, full and projected, cold and warm) through one
 * shared call: `matchesConditional(h, etag, "legacy")`. The legacy syntax
 * accepts bare opaque tokens (`H`) and lowercase-weak tags (`w/"H"`); the
 * shared helper's strict quoted default rejects both.
 *
 * Every other hydrated conditional test uses quoted, uppercase-weak,
 * wildcard, or list validators, which both syntaxes accept — so dropping the
 * `"legacy"` argument keeps them green while silently switching existing
 * hydrated clients to the stricter parser. The cases below use only
 * legacy-shaped validators that the quoted mode rejects, so each 304
 * assertion fails if the dispatch argument is removed. Nonmatch cases guard
 * the other direction: legacy-shaped but wrong validators must still serve.
 *
 * The Workers Cache API is mocked out so cache hits/misses are controllable;
 * everything else (the D1 reads, `sha256Etag`, the bundle serialization) runs
 * for real against a fake `D1Database`. Mirrors the harness in
 * `dataEntityHandlers.test.ts`.
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

const ADDRESS_DB_ROWS: FakeRows = {
  address: { pickup_address_id: 10, customer_id: 5 },
  customer: { customer_id: 5 },
  containers: [{ container_id: 100, pickup_address_id: 10 }]
};

const CONTAINER_DB_ROWS: FakeRows = {
  container: { container_id: 100, pickup_address_id: 10 },
  address: { pickup_address_id: 10, customer_id: 5 },
  customer: { customer_id: 5 }
};

beforeEach(() => {
  cacheState.entry = null;
  cacheState.puts = [];
});

/** Fetch once to learn the ETag the handler computes for this data. */
async function etagFor(columns?: string[]): Promise<string> {
  const res = await handleGetDataCustomer(ctx(fakeDb(CUSTOMER_DB_ROWS)), 5, columns);
  expect(res.status).toBe(200);
  const etag = res.headers.get("X-Entity-ETag");
  expect(etag).toBeTruthy();
  return etag as string;
}

async function expectEmpty304(res: Response, etag: string): Promise<void> {
  expect(res.status).toBe(304);
  expect(res.headers.get("ETag")).toBe(`"${etag}"`);
  expect(await res.text()).toBe("");
}

describe("hydrated legacy If-None-Match dispatch", () => {
  it("304s a bare current validator on a cold full read", async () => {
    // Arrange
    const etag = await etagFor();
    const db = fakeDb(CUSTOMER_DB_ROWS);

    // Act
    const res = await handleGetDataCustomer(ctx(db, etag), 5);

    // Assert
    await expectEmpty304(res, etag);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=60");
  });

  it("304s a lowercase-weak current validator on a cold full read", async () => {
    // Arrange
    const etag = await etagFor();
    const db = fakeDb(CUSTOMER_DB_ROWS);

    // Act
    const res = await handleGetDataCustomer(ctx(db, `w/"${etag}"`), 5);

    // Assert
    await expectEmpty304(res, etag);
  });

  it("304s legacy-only validators from the cached entry's ETag on a warm full read", async () => {
    // Arrange — the absent D1 row proves the 304 comes from the cache path.
    cacheState.entry = new Response('{"cached":true}', {
      status: 200,
      headers: { "X-Entity-ETag": "cached-etag" }
    });
    const db = fakeDb({ customer: null });

    // Act / Assert
    await expectEmpty304(
      await handleGetDataCustomer(ctx(db, "cached-etag"), 5),
      "cached-etag"
    );
    await expectEmpty304(
      await handleGetDataCustomer(ctx(db, 'w/"cached-etag"'), 5),
      "cached-etag"
    );
  });

  it("304s legacy-only validators on a cold projected read", async () => {
    // Arrange
    const columns = ["company_name"];
    const etag = await etagFor(columns);
    const db = fakeDb(CUSTOMER_DB_ROWS);

    // Act / Assert
    await expectEmpty304(
      await handleGetDataCustomer(ctx(db, etag), 5, columns),
      etag
    );
    await expectEmpty304(
      await handleGetDataCustomer(ctx(db, `w/"${etag}"`), 5, columns),
      etag
    );
  });

  it("304s legacy-only validators on a warm projected read", async () => {
    // Arrange
    const columns = ["company_name"];
    const etag = await etagFor(columns);
    const db = fakeDb(CUSTOMER_DB_ROWS);
    const full = await handleGetDataCustomer(ctx(db), 5);
    const fullText = await full.text();
    const seedWarmFull = () => {
      cacheState.entry = new Response(fullText, { status: 200, headers: full.headers });
    };

    // Act / Assert — reseed per request: the projected path consumes the entry.
    seedWarmFull();
    await expectEmpty304(
      await handleGetDataCustomer(ctx(db, etag), 5, columns),
      etag
    );
    seedWarmFull();
    await expectEmpty304(
      await handleGetDataCustomer(ctx(db, `w/"${etag}"`), 5, columns),
      etag
    );
  });

  it("serves 200 for non-matching legacy-shaped validators", async () => {
    // Arrange
    const etag = await etagFor();
    const db = fakeDb(CUSTOMER_DB_ROWS);

    // Act / Assert — wrong tokens serve the representation, quoted or not.
    for (const validator of ["nope", 'w/"nope"']) {
      const res = await handleGetDataCustomer(ctx(db, validator), 5);
      expect(res.status).toBe(200);
      expect(res.headers.get("ETag")).toBe(`"${etag}"`);
      expect((await res.text()).length).toBeGreaterThan(0);
    }
  });

  it("304s legacy-only validators on address and container reads", async () => {
    // Arrange — each handler has its own conditional branch over the shared
    // legacy dispatch, so exercise each directly rather than via customer.
    const first = await handleGetDataAddress(ctx(fakeDb(ADDRESS_DB_ROWS)), 10);
    const addressEtag = first.headers.get("X-Entity-ETag") as string;
    const addressDb = fakeDb(ADDRESS_DB_ROWS);
    const containerFirst = await handleGetDataContainer(ctx(fakeDb(CONTAINER_DB_ROWS)), 100);
    const containerEtag = containerFirst.headers.get("X-Entity-ETag") as string;
    const containerDb = fakeDb(CONTAINER_DB_ROWS);

    // Act / Assert
    await expectEmpty304(
      await handleGetDataAddress(ctx(addressDb, addressEtag), 10),
      addressEtag
    );
    await expectEmpty304(
      await handleGetDataAddress(ctx(addressDb, `w/"${addressEtag}"`), 10),
      addressEtag
    );
    await expectEmpty304(
      await handleGetDataContainer(ctx(containerDb, containerEtag), 100),
      containerEtag
    );
    await expectEmpty304(
      await handleGetDataContainer(ctx(containerDb, `w/"${containerEtag}"`), 100),
      containerEtag
    );
  });
});
