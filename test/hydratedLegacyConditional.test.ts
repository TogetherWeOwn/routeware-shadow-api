import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const { default: app } = await import("../src/app");
const HYDRATED_SPECS = [
  { kind: "customer", id: 5, field: "company_name", rows: CUSTOMER_DB_ROWS },
  { kind: "address", id: 10, field: "address", rows: {
    ...ADDRESS_DB_ROWS,
    address: { pickup_address_id: 10, customer_id: 5, address: "Synthetic street" }
  } },
  { kind: "container", id: 100, field: "serial_number", rows: {
    ...CONTAINER_DB_ROWS,
    container: { container_id: 100, pickup_address_id: 10, serial_number: "Synthetic serial" }
  } }
];
const READ_PATHS = [
  { name: "cold full", warm: false, projected: false },
  { name: "warm full", warm: true, projected: false },
  { name: "cold projected", warm: false, projected: true },
  { name: "warm projected", warm: true, projected: true }
];
const QUOTED_NONMATCHES = [
  { name: "hash inside one quoted tag", header: (h: string) => `"prefix,${h},suffix"` },
  { name: "hash inside one lowercase-weak tag", header: (h: string) => `w/"prefix,${h},suffix"` },
  { name: "wildcard inside one quoted tag", header: () => '"prefix,*,suffix"' },
  { name: "wildcard inside one lowercase-weak tag", header: () => 'w/"prefix,*,suffix"' }
];
const LEGACY_MATCHES = [
  { name: "exact quoted tag", header: (h: string) => `"${h}"` },
  { name: "bare tag", header: (h: string) => h },
  { name: "lowercase weak tag", header: (h: string) => `w/"${h}"` },
  { name: "uppercase weak tag", header: (h: string) => `W/"${h}"` },
  { name: "standalone wildcard", header: () => "*" },
  { name: "whitespace and list", header: (h: string) => ` \t"other", \t${h} \t` },
  { name: "real tag after quoted commas", header: (h: string) => `"prefix,wrong,suffix", w/"${h}"` },
  // An opaque-tag backslash is literal: the next quote closes the first tag.
  { name: "real tag after a trailing backslash", header: (h: string) => `"prefix,wrong\\", "${h}"` }
];

async function getHydrated(
  kind: string, id: number, db: D1Database, fields?: string, ifNoneMatch?: string
): Promise<Response> {
  const query = new URLSearchParams({ id: String(id) });
  if (fields !== undefined) query.set("fields", fields);
  const headers = new Headers({ authorization: "Bearer test-sync-secret" });
  if (ifNoneMatch !== undefined) headers.set("if-none-match", ifNoneMatch);
  const pending: Promise<unknown>[] = [];
  const res = await app.fetch(
    new Request(`http://test.local/api/v1/data/${kind}?${query}`, { headers }),
    { ...env, CUSTOMER_DB: db } as unknown as Env,
    {
      waitUntil(p: Promise<unknown>) { pending.push(p); },
      passThroughOnException() {},
      props: {}
    } as ExecutionContext
  );
  await Promise.all(pending);
  return res;
}

// Mutation target: splitting inside an opaque tag returns a false 304 and loses
// the current body. Route through production auth/validation/hydration, not a
// matcher helper. Only D1 and the external cache/network boundaries are faked.
describe.each(HYDRATED_SPECS)("$kind quoted-comma legacy route", (spec) => {
  const outbound = vi.fn(async () => { throw new Error("Unexpected hydrated outbound fetch"); });
  beforeEach(() => {
    outbound.mockClear();
    vi.stubGlobal("fetch", outbound);
  });
  afterEach(() => {
    try { expect(outbound).not.toHaveBeenCalled(); }
    finally { vi.unstubAllGlobals(); }
  });

  describe.each(READ_PATHS)("$name", (path) => {
    async function currentRead() {
      const db = fakeDb(spec.rows);
      const full = await getHydrated(spec.kind, spec.id, db);
      expect(full.status).toBe(200);
      const fullText = await full.text();
      expect(fullText.length).toBeGreaterThan(0);
      const fields = path.projected ? spec.field : undefined;
      const current = await getHydrated(spec.kind, spec.id, db, fields);
      expect(current.status).toBe(200);
      const text = await current.text();
      expect(text.length).toBeGreaterThan(0);
      const hash = current.headers.get("x-entity-etag")!;
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      const readDb = path.warm ? {
        prepare() { throw new Error("Warm hydrated read unexpectedly queried D1"); }
      } as unknown as D1Database : db;
      return {
        hash, text,
        read: (header: string) => {
          cacheState.entry = path.warm
            ? new Response(fullText, { status: 200, headers: full.headers }) : null;
          return getHydrated(spec.kind, spec.id, readDb, fields, header);
        }
      };
    }

    it.each(QUOTED_NONMATCHES)("serves the current body for $name", async ({ header }) => {
      const current = await currentRead();
      const res = await current.read(header(current.hash));
      const text = await res.text();
      expect.soft(res.status).toBe(200);
      expect.soft(res.headers.get("etag")).toBe(`"${current.hash}"`);
      expect.soft(text.length).toBeGreaterThan(0);
      expect(text).toBe(current.text);
    });

    it.each(LEGACY_MATCHES)("preserves 304 for $name", async ({ header }) => {
      const current = await currentRead();
      await expectEmpty304(await current.read(header(current.hash)), current.hash);
    });
  });
});
