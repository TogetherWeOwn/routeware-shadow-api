import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROBLEM_TYPE_BASE } from "../src/lib/problem";

/**
 * The three `src/routes/*Snapshot.ts` modules were the largest remaining block
 * of uncovered branches (5.9% / 6.3% / 18.4%). They are near-identical by
 * design — same four routes, same guards, same response shapes — so the bulk of
 * this file is a `describe.each` over one spec per module, with only the
 * genuinely divergent behaviour (the container join and its double-bound `q`)
 * kept separate.
 *
 * `test/snapshotAuth.test.ts` already pins each route's 401 body, so nothing
 * here re-tests that. This file starts where it stops: the SQL these handlers
 * build, the query-parameter parsing, and the error mapping.
 *
 * What is actually at risk in this code is the **WHERE-clause / bind-array
 * correspondence**. Every filter pushes a fragment onto `where` and a value onto
 * `binds` in two separate statements, and `limit`/`offset` are appended after
 * the caller's binds. Drop one push, or append the pagination binds first, and
 * D1 silently binds the wrong value to the wrong placeholder — a wrong-customer
 * PII disclosure that still returns 200. So the assertions here compare the
 * exact normalised SQL and the exact bind array, not just the response body.
 *
 * The route modules are fetched directly rather than through `src/app.ts`: that
 * bypasses the app-wide `/api/v1/*` gate and lets each test supply its own
 * `CUSTOMER_DB` and report-path vars.
 */

type Row = Record<string, unknown>;
type Recorded = { sql: string; binds: unknown[] };

/** Controls the mocked `d1SnapshotSync` module. Reset in `beforeEach`. */
const syncState: {
  runResult: unknown;
  streamResult: unknown;
  runCalls: unknown[];
  streamCalls: Array<{ db: unknown; body: unknown }>;
} = { runResult: null, streamResult: null, runCalls: [], streamCalls: [] };

/**
 * Plain functions, not `vi.fn()`: a spy wrapping a double that rejects records
 * the settled result and turns a deliberate rejection into an unhandled
 * rejection under `@cloudflare/vitest-pool-workers`. Calls are recorded by hand.
 */
vi.mock("../src/lib/d1SnapshotSync", () => {
  const run = async (env: unknown) => {
    syncState.runCalls.push(env);
    return syncState.runResult;
  };
  const stream = async (db: unknown, body: unknown) => {
    syncState.streamCalls.push({ db, body });
    return syncState.streamResult;
  };
  return {
    runCustomerSnapshotSync: run,
    runAddressSnapshotSync: run,
    runContainerSnapshotSync: run,
    syncCustomerSnapshotFromStream: stream,
    syncAddressSnapshotFromStream: stream,
    syncContainerSnapshotFromStream: stream
  };
});

const { customerSnapshotRoutes } = await import("../src/routes/customerSnapshot");
const { addressSnapshotRoutes } = await import("../src/routes/addressSnapshot");
const { containerSnapshotRoutes } = await import("../src/routes/containerSnapshot");

type RouteModule = typeof customerSnapshotRoutes;

const SECRET = "sync-secret";
const PROBLEM_BASE = PROBLEM_TYPE_BASE;

type ProblemBody = { type: string; title: string; status: number; detail?: string };

/** Collapse the multi-line template SQL so assertions can be written on one line. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

type DbOptions = {
  /** `n` for the COUNT row; `null` makes `first()` return null (tests `?? 0`). */
  total?: number | null;
  /** `results` for the list query; `undefined` tests the `results ?? []` fallback. */
  rows?: Row[];
  /** Row for the by-id lookup; `null` is the 404 path. */
  row?: Row | null;
};

/**
 * Recording read-side `D1Database`. Dispatches on whether the statement is the
 * COUNT or the SELECT so a single fake serves both queries the list handler
 * issues, and records every `(sql, binds)` pair in call order.
 */
function readDb(opts: DbOptions): { db: D1Database; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql: flat(sql), binds });
          return {
            async first<T>() {
              if (sql.includes("COUNT(*)")) {
                return (opts.total === null || opts.total === undefined
                  ? null
                  : { n: opts.total }) as T;
              }
              return (opts.row ?? null) as T;
            },
            async all<T>() {
              return { results: opts.rows } as unknown as T;
            }
          };
        }
      };
    }
  };
  return { db: db as unknown as D1Database, calls };
}

function makeEnv(db: D1Database, vars: Record<string, string> = {}): Env {
  return {
    CUSTOMER_DB: db,
    CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET,
    ...vars
  } as unknown as Env;
}

async function call(
  routes: RouteModule,
  path: string,
  env: Env,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${SECRET}`);
  return await routes.fetch(
    new Request(`http://test.local${path}`, { ...init, headers }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
  );
}

/** One entry per module. Everything the shared tests need to differ on. */
type Spec = {
  name: string;
  routes: RouteModule;
  base: string;
  table: string;
  /** Table alias used in the container module's WHERE fragments; "" elsewhere. */
  prefix: string;
  idParam: string;
  idColumn: string;
  /** Exact WHERE fragment the free-text `q` filter appends. */
  qClause: string;
  /** How many binds `q` contributes — two for container (location + serial). */
  qBinds: number;
  exportPathVar: string;
  queryIdVar: string;
  notConfiguredDetail: string;
  notFoundDetail: (id: number) => string;
};

const SPECS: Spec[] = [
  {
    name: "customer",
    routes: customerSnapshotRoutes,
    base: "/api/v1/customer-snapshot",
    table: "customer_snapshot",
    prefix: "",
    idParam: "customerId",
    idColumn: "customer_id",
    qClause: "instr(lower(coalesce(company_name, '')), lower(?)) > 0",
    qBinds: 1,
    exportPathVar: "CUSTOMER_REPORT_EXPORT_PATH",
    queryIdVar: "CUSTOMER_REPORT_QUERY_ID",
    notConfiguredDetail:
      "Set CUSTOMER_REPORT_EXPORT_PATH (static report URL) or CUSTOMER_REPORT_QUERY_ID (Routeware query id). See CUSTOMER_SNAPSHOT.md. See docs/PROBLEMS.md#misconfigured.",
    notFoundDetail: (id) => `No snapshot row for customer_id=${id}. See docs/PROBLEMS.md#not-found.`
  },
  {
    name: "address",
    routes: addressSnapshotRoutes,
    base: "/api/v1/address-snapshot",
    table: "address_snapshot",
    prefix: "",
    idParam: "pickupAddressId",
    idColumn: "pickup_address_id",
    qClause: "instr(lower(coalesce(address, '')), lower(?)) > 0",
    qBinds: 1,
    exportPathVar: "ADDRESS_REPORT_EXPORT_PATH",
    queryIdVar: "ADDRESS_REPORT_QUERY_ID",
    notConfiguredDetail:
      "Set ADDRESS_REPORT_EXPORT_PATH or ADDRESS_REPORT_QUERY_ID (see CUSTOMER_SNAPSHOT.md). See docs/PROBLEMS.md#misconfigured.",
    notFoundDetail: (id) => `No address row for pickup_address_id=${id}. See docs/PROBLEMS.md#not-found.`
  },
  {
    name: "container",
    routes: containerSnapshotRoutes,
    base: "/api/v1/container-snapshot",
    table: "container_snapshot",
    prefix: "c.",
    idParam: "containerId",
    idColumn: "container_id",
    qClause:
      "(instr(lower(coalesce(c.location_address, '')), lower(?)) > 0 OR instr(lower(coalesce(c.serial_number, '')), lower(?)) > 0)",
    qBinds: 2,
    exportPathVar: "CONTAINER_REPORT_EXPORT_PATH",
    queryIdVar: "CONTAINER_REPORT_QUERY_ID",
    notConfiguredDetail:
      "Set CONTAINER_REPORT_EXPORT_PATH or CONTAINER_REPORT_QUERY_ID (see CUSTOMER_SNAPSHOT.md). See docs/PROBLEMS.md#misconfigured.",
    notFoundDetail: (id) => `No container row for container_id=${id}. See docs/PROBLEMS.md#not-found.`
  }
];

beforeEach(() => {
  syncState.runResult = null;
  syncState.streamResult = null;
  syncState.runCalls = [];
  syncState.streamCalls = [];
});

describe.each(SPECS)("$name snapshot routes", (spec) => {
  /** The container list filters on `c.container_id`; the others on the bare column. */
  const idFilter = `${spec.prefix}${spec.idColumn} = ?`;
  const enabledCol = `${spec.prefix}enabled`;

  describe("GET list", () => {
    it("applies no filters and paginates with the documented defaults", async () => {
      // Arrange
      const { db, calls } = readDb({ total: 2, rows: [{ a: 1 }, { a: 2 }] });

      // Act
      const res = await call(spec.routes, spec.base, makeEnv(db));

      // Assert — WHERE degenerates to the always-true seed, and the only binds
      // are the default limit/offset.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ rows: [{ a: 1 }, { a: 2 }], total: 2, nextCursor: null });
      expect(calls).toHaveLength(2);
      expect(calls[0].sql).toContain("WHERE 1 = 1");
      expect(calls[0].binds).toEqual([]);
      expect(calls[1].binds).toEqual([50, 0]);
    });

    it(`filters on ${spec.idColumn} when ${spec.idParam} is supplied`, async () => {
      // Arrange
      const { db, calls } = readDb({ total: 1, rows: [] });

      // Act
      await call(spec.routes, `${spec.base}?${spec.idParam}=7`, makeEnv(db));

      // Assert
      expect(calls[0].sql).toContain(`WHERE 1 = 1 AND ${idFilter}`);
      expect(calls[0].binds).toEqual([7]);
    });

    it("appends the pagination binds after the filter binds, not before", async () => {
      // Arrange — the placeholder order is WHERE-first, then LIMIT/OFFSET.
      // Swapping them binds a customer id as a LIMIT and returns another
      // customer's rows with a 200, which no type check would catch.
      const { db, calls } = readDb({ total: 1, rows: [] });

      // Act
      await call(
        spec.routes,
        `${spec.base}?${spec.idParam}=7&limit=5&offset=10`,
        makeEnv(db)
      );

      // Assert
      expect(calls[1].binds).toEqual([7, 5, 10]);
    });

    it("applies a trimmed, case-insensitive substring filter for q", async () => {
      // Arrange
      const { db, calls } = readDb({ total: 0, rows: [] });

      // Act
      await call(spec.routes, `${spec.base}?q=${encodeURIComponent("  Acme  ")}`, makeEnv(db));

      // Assert
      expect(calls[0].sql).toContain(spec.qClause);
      expect(calls[0].binds).toEqual(Array(spec.qBinds).fill("Acme"));
    });

    it("ignores a whitespace-only q rather than matching every row", async () => {
      // Arrange
      const { db, calls } = readDb({ total: 0, rows: [] });

      // Act
      await call(spec.routes, `${spec.base}?q=${encodeURIComponent("   ")}`, makeEnv(db));

      // Assert — no instr clause and no bind for it.
      expect(calls[0].sql).not.toContain("instr(");
      expect(calls[0].binds).toEqual([]);
    });

    it("maps enabled=true to a literal 1 comparison with no bind", async () => {
      // Arrange
      const { db, calls } = readDb({ total: 0, rows: [] });

      // Act
      await call(spec.routes, `${spec.base}?enabled=true`, makeEnv(db));

      // Assert
      expect(calls[0].sql).toContain(`${enabledCol} = 1`);
      expect(calls[0].binds).toEqual([]);
    });

    it("maps enabled=false to a literal 0 comparison", async () => {
      // Arrange
      const { db, calls } = readDb({ total: 0, rows: [] });

      // Act
      await call(spec.routes, `${spec.base}?enabled=false`, makeEnv(db));

      // Assert
      expect(calls[0].sql).toContain(`${enabledCol} = 0`);
    });

    it("adds no enabled clause for the default enabled=any", async () => {
      // Arrange
      const { db, calls } = readDb({ total: 0, rows: [] });

      // Act
      await call(spec.routes, `${spec.base}?enabled=any`, makeEnv(db));

      // Assert
      expect(calls[0].sql).not.toContain(`${enabledCol} = `);
    });

    it("counts and selects over the identical WHERE clause", async () => {
      // Arrange — a count taken over a wider WHERE than the select inflates
      // `total` and makes clients page into rows that do not exist.
      const { db, calls } = readDb({ total: 3, rows: [] });

      // Act
      await call(
        spec.routes,
        `${spec.base}?${spec.idParam}=7&enabled=true&q=x`,
        makeEnv(db)
      );

      // Assert
      const whereOf = (sql: string) => sql.slice(sql.indexOf("WHERE")).split(" ORDER BY ")[0];
      expect(whereOf(calls[1].sql)).toContain(whereOf(calls[0].sql));
      expect(calls[1].binds.slice(0, calls[0].binds.length)).toEqual(calls[0].binds);
    });

    it("orders by the primary key so pagination is stable across pages", async () => {
      // Arrange
      const { db, calls } = readDb({ total: 0, rows: [] });

      // Act
      await call(spec.routes, spec.base, makeEnv(db));

      // Assert
      expect(calls[1].sql).toContain(`ORDER BY ${spec.prefix}${spec.idColumn} LIMIT ? OFFSET ?`);
    });

    it("seeks past cursor with LIMIT only, dropping OFFSET, when cursor is supplied", async () => {
      // Arrange
      const { db, calls } = readDb({ total: 0, rows: [] });

      // Act — offset is present but must be ignored once cursor takes over.
      await call(spec.routes, `${spec.base}?cursor=42&limit=5&offset=10`, makeEnv(db));

      // Assert — WHERE gains the seek predicate on both count and select, and
      // pagination drops to a single LIMIT bind (no OFFSET placeholder at all).
      const seekFilter = `${spec.prefix}${spec.idColumn} > ?`;
      expect(calls[0].sql).toContain(seekFilter);
      expect(calls[0].binds).toEqual([42]);
      expect(calls[1].sql).toContain(`ORDER BY ${spec.prefix}${spec.idColumn} LIMIT ?`);
      expect(calls[1].sql).not.toContain("OFFSET");
      expect(calls[1].binds).toEqual([42, 5]);
    });

    it("returns the last row's id as nextCursor when the page is full", async () => {
      // Arrange
      const rows = [{ [spec.idColumn]: 10 }, { [spec.idColumn]: 20 }];
      const { db } = readDb({ total: 2, rows });

      // Act
      const res = await call(spec.routes, `${spec.base}?limit=2`, makeEnv(db));

      // Assert
      expect(await res.json()).toEqual({ rows, total: 2, nextCursor: 20 });
    });

    it("returns nextCursor null when the page is short of the limit", async () => {
      // Arrange — fewer rows than the limit means this is the last page.
      const rows = [{ [spec.idColumn]: 10 }];
      const { db } = readDb({ total: 1, rows });

      // Act
      const res = await call(spec.routes, `${spec.base}?limit=5`, makeEnv(db));

      // Assert
      expect(await res.json()).toEqual({ rows, total: 1, nextCursor: null });
    });

    it("reports total 0 when the count query returns no row", async () => {
      // Arrange
      const { db } = readDb({ total: null, rows: [] });

      // Act
      const res = await call(spec.routes, spec.base, makeEnv(db));

      // Assert
      expect(await res.json()).toEqual({ rows: [], total: 0, nextCursor: null });
    });

    it("returns an empty rows array when the select yields no results field", async () => {
      // Arrange — D1 can answer with `results` absent; `rows: null` would break
      // clients that iterate the field unconditionally.
      const { db } = readDb({ total: 0 });

      // Act
      const res = await call(spec.routes, spec.base, makeEnv(db));

      // Assert
      expect(await res.json()).toEqual({ rows: [], total: 0, nextCursor: null });
    });

    it("rejects a limit above the 500 ceiling", async () => {
      // Arrange
      const { db, calls } = readDb({ total: 0, rows: [] });

      // Act
      const res = await call(spec.routes, `${spec.base}?limit=501`, makeEnv(db));

      // Assert — rejected by the schema, so D1 is never touched.
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("rejects a negative offset", async () => {
      // Arrange
      const { db } = readDb({ total: 0, rows: [] });

      // Act
      const res = await call(spec.routes, `${spec.base}?offset=-1`, makeEnv(db));

      // Assert
      expect(res.status).toBe(400);
    });

    it("rejects an unknown enabled value instead of silently ignoring it", async () => {
      // Arrange
      const { db } = readDb({ total: 0, rows: [] });

      // Act
      const res = await call(spec.routes, `${spec.base}?enabled=yes`, makeEnv(db));

      // Assert
      expect(res.status).toBe(400);
    });
  });

  describe("GET by id", () => {
    it("returns the row keyed by the path parameter", async () => {
      // Arrange
      const { db, calls } = readDb({ row: { [spec.idColumn]: 42, synced_at: "now" } });

      // Act
      const res = await call(spec.routes, `${spec.base}/42`, makeEnv(db));

      // Assert
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ [spec.idColumn]: 42, synced_at: "now" });
      expect(calls[0].sql).toContain(`FROM ${spec.table} WHERE ${spec.idColumn} = ?`);
      expect(calls[0].binds).toEqual([42]);
    });

    it("returns a 404 problem+json naming the id that was not found", async () => {
      // Arrange
      const { db } = readDb({ row: null });

      // Act
      const res = await call(spec.routes, `${spec.base}/9999`, makeEnv(db));

      // Assert
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).toContain("problem+json");
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(`${PROBLEM_BASE}not-found`);
      expect(body.title).toBe("Not Found");
      expect(body.detail).toBe(spec.notFoundDetail(9999));
    });

    it("rejects a non-numeric id at the schema before any query runs", async () => {
      // Arrange
      const { db, calls } = readDb({ row: { x: 1 } });

      // Act
      const res = await call(spec.routes, `${spec.base}/abc`, makeEnv(db));

      // Assert
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("rejects a fractional id rather than truncating it to another row", async () => {
      // Arrange
      const { db, calls } = readDb({ row: { x: 1 } });

      // Act
      const res = await call(spec.routes, `${spec.base}/4.5`, makeEnv(db));

      // Assert
      expect(res.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  });

  describe("GET by id guard", () => {
    it.each(["-5", "0", "1e3", "007", "abc", "4.5"])(
      "answers %s with the documented 400 problem+json before any query runs",
      async (id) => {
        // Arrange
        const { db, calls } = readDb({ row: { x: 1 } });

        // Act
        const res = await call(spec.routes, `${spec.base}/${id}`, makeEnv(db));

        // Assert
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("problem+json");
        expect(calls).toHaveLength(0);
      }
    );
  });

  describe("POST sync", () => {
    it("returns 503 when neither the export path nor the query id is configured", async () => {
      // Arrange
      const { db } = readDb({});

      // Act
      const res = await call(spec.routes, `${spec.base}/sync`, makeEnv(db), { method: "POST" });

      // Assert
      expect(res.status).toBe(503);
      expect(res.headers.get("content-type")).toContain("problem+json");
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(`${PROBLEM_BASE}misconfigured`);
      expect(body.title).toBe("Service Unavailable");
      expect(body.detail).toBe(spec.notConfiguredDetail);
      expect(syncState.runCalls).toHaveLength(0);
    });

    it("treats a whitespace-only export path as unconfigured", async () => {
      // Arrange — an env var set to blank in wrangler.toml is a real failure
      // mode; without the `.trim()` it would pass the guard and the sync would
      // fetch a report from the origin root.
      const { db } = readDb({});
      const env = makeEnv(db, { [spec.exportPathVar]: "   " });

      // Act
      const res = await call(spec.routes, `${spec.base}/sync`, env, { method: "POST" });

      // Assert
      expect(res.status).toBe(503);
      expect(syncState.runCalls).toHaveLength(0);
    });

    it("runs the sync when only the query id is configured", async () => {
      // Arrange — the second half of the `||`; a regression here would make the
      // async report pipeline unreachable while the static path still worked.
      const { db } = readDb({});
      const env = makeEnv(db, { [spec.queryIdVar]: "q-123" });
      syncState.runResult = { upserted: 4, rowCount: 4, deleted: 1 };

      // Act
      const res = await call(spec.routes, `${spec.base}/sync`, env, { method: "POST" });

      // Assert
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ upserted: 4, rowCount: 4, deleted: 1 });
      expect(syncState.runCalls).toEqual([env]);
    });

    it("reports skipped when the runner declines to sync", async () => {
      // Arrange — a null result means the runner found nothing to do; it must
      // surface as an explicit `skipped`, not as a silent zero-row success.
      const { db } = readDb({});
      const env = makeEnv(db, { [spec.exportPathVar]: "/report.csv" });
      syncState.runResult = null;

      // Act
      const res = await call(spec.routes, `${spec.base}/sync`, env, { method: "POST" });

      // Assert
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ upserted: 0, rowCount: 0, skipped: true });
    });

    it("passes the runner result through without a skipped flag", async () => {
      // Arrange
      const { db } = readDb({});
      const env = makeEnv(db, { [spec.exportPathVar]: "/report.csv" });
      syncState.runResult = { upserted: 10, rowCount: 12 };

      // Act
      const res = await call(spec.routes, `${spec.base}/sync`, env, { method: "POST" });

      // Assert
      expect(await res.json()).toEqual({ upserted: 10, rowCount: 12 });
    });
  });

  describe("POST import", () => {
    it("streams the request body into the D1 sync and returns its result", async () => {
      // Arrange
      const { db } = readDb({});
      const env = makeEnv(db);
      syncState.streamResult = { upserted: 3, rowCount: 3, deleted: 0 };

      // Act
      const res = await call(spec.routes, `${spec.base}/import`, env, {
        method: "POST",
        body: "a,b\n1,2\n",
        headers: { "content-type": "text/csv" }
      });

      // Assert — the handler must hand over `CUSTOMER_DB`, not some other binding.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ upserted: 3, rowCount: 3, deleted: 0 });
      expect(syncState.streamCalls).toHaveLength(1);
      expect(syncState.streamCalls[0].db).toBe(db);
      expect(syncState.streamCalls[0].body).not.toBeNull();
    });

    it("returns 400 for a body-less POST instead of importing nothing", async () => {
      // Arrange — a POST with no body has no request stream at all. Without the
      // guard this would reach the CSV parser as `null`.
      const { db } = readDb({});

      // Act
      const res = await call(spec.routes, `${spec.base}/import`, makeEnv(db), {
        method: "POST"
      });

      // Assert
      expect(res.status).toBe(400);
      const body = (await res.json()) as ProblemBody;
      expect(body.type).toBe(`${PROBLEM_BASE}bad-request`);
      expect(body.title).toBe("Bad Request");
      expect(syncState.streamCalls).toHaveLength(0);
    });
  });
});

/**
 * Container-only behaviour. The container table has no `customer_id`; reaching a
 * customer means joining through `address_snapshot`, and that join is
 * conditional — added only when the caller filters by `customerId`.
 */
describe("container snapshot list join", () => {
  const base = "/api/v1/container-snapshot";

  it("joins address_snapshot only when filtering by customerId", async () => {
    // Arrange
    const { db, calls } = readDb({ total: 1, rows: [] });

    // Act
    await call(containerSnapshotRoutes, `${base}?customerId=3`, makeEnv(db));

    // Assert
    expect(calls[0].sql).toContain(
      "FROM container_snapshot c INNER JOIN address_snapshot a ON a.pickup_address_id = c.pickup_address_id"
    );
    expect(calls[0].sql).toContain("a.customer_id = ?");
    expect(calls[0].binds).toEqual([3]);
  });

  it("omits the join when customerId is absent", async () => {
    // Arrange — joining unconditionally would drop every container whose
    // address row is missing, turning a referential gap into silent data loss.
    const { db, calls } = readDb({ total: 1, rows: [] });

    // Act
    await call(containerSnapshotRoutes, `${base}?pickupAddressId=8`, makeEnv(db));

    // Assert
    expect(calls[0].sql).not.toContain("INNER JOIN");
    expect(calls[0].sql).toContain("c.pickup_address_id = ?");
    expect(calls[0].binds).toEqual([8]);
  });

  it("uses the same FROM clause for the count and the select", async () => {
    // Arrange
    const { db, calls } = readDb({ total: 1, rows: [] });

    // Act
    await call(containerSnapshotRoutes, `${base}?customerId=3`, makeEnv(db));

    // Assert
    expect(calls[1].sql).toContain("INNER JOIN address_snapshot a");
  });

  it("binds the q value twice, once per column in the OR", async () => {
    // Arrange — one bind for two placeholders shifts every later bind by one.
    const { db, calls } = readDb({ total: 0, rows: [] });

    // Act
    await call(containerSnapshotRoutes, `${base}?q=BIN&limit=5&offset=2`, makeEnv(db));

    // Assert
    expect(calls[1].binds).toEqual(["BIN", "BIN", 5, 2]);
  });

  it("filters by containerId independently of the address filters", async () => {
    // Arrange
    const { db, calls } = readDb({ total: 0, rows: [] });

    // Act
    await call(containerSnapshotRoutes, `${base}?containerId=55`, makeEnv(db));

    // Assert
    expect(calls[0].sql).toContain("c.container_id = ?");
    expect(calls[0].binds).toEqual([55]);
  });

  it("stacks customerId, pickupAddressId and containerId in declaration order", async () => {
    // Arrange — the bind array order follows the order of the `if` blocks, not
    // the order of the query string.
    const { db, calls } = readDb({ total: 0, rows: [] });

    // Act
    await call(
      containerSnapshotRoutes,
      `${base}?containerId=3&pickupAddressId=2&customerId=1`,
      makeEnv(db)
    );

    // Assert
    expect(calls[0].binds).toEqual([1, 2, 3]);
  });
});

/**
 * Address list filters on both `customer_id` and `pickup_address_id` without a
 * join — the column lives on the table itself.
 */
describe("address snapshot list filters", () => {
  it("filters by customerId directly, with no join", async () => {
    // Arrange
    const { db, calls } = readDb({ total: 0, rows: [] });

    // Act
    await call(addressSnapshotRoutes, "/api/v1/address-snapshot?customerId=4", makeEnv(db));

    // Assert
    expect(calls[0].sql).not.toContain("JOIN");
    expect(calls[0].sql).toContain("customer_id = ?");
    expect(calls[0].binds).toEqual([4]);
  });

  it("stacks customerId before pickupAddressId in the bind array", async () => {
    // Arrange
    const { db, calls } = readDb({ total: 0, rows: [] });

    // Act
    await call(
      addressSnapshotRoutes,
      "/api/v1/address-snapshot?pickupAddressId=2&customerId=1",
      makeEnv(db)
    );

    // Assert
    expect(calls[0].binds).toEqual([1, 2]);
  });
});
