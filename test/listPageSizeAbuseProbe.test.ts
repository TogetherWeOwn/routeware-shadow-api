import { describe, expect, it } from "vitest";

/**
 * TOG-8890 (R3-14): adversarial page-size probe against the three keyset
 * list pages (`customer/address/container-snapshot`).
 *
 * Every probe must answer 200 (with the limit honoured/capped) or a
 * documented 400 `bad-request` problem+json — never a 500, never a stack
 * leak. A 400 must reject before D1 is touched; a 200 must bind a LIMIT
 * within the schema's 1..500 window and return at most that many rows.
 *
 * Route modules are fetched directly (as in `test/snapshotRoutes.test.ts`),
 * bypassing the app-wide bearer gate, with a recording fake D1.
 */

type Row = Record<string, unknown>;

const { customerSnapshotRoutes } = await import("../src/routes/customerSnapshot");
const { addressSnapshotRoutes } = await import("../src/routes/addressSnapshot");
const { containerSnapshotRoutes } = await import("../src/routes/containerSnapshot");

type RouteModule = typeof customerSnapshotRoutes;

const SECRET = "sync-secret";

const ROUTES: Array<{ name: string; routes: RouteModule; base: string; idColumn: string }> = [
  { name: "customer", routes: customerSnapshotRoutes, base: "/api/v1/customer-snapshot", idColumn: "customer_id" },
  { name: "address", routes: addressSnapshotRoutes, base: "/api/v1/address-snapshot", idColumn: "pickup_address_id" },
  { name: "container", routes: containerSnapshotRoutes, base: "/api/v1/container-snapshot", idColumn: "container_id" }
];

/** Recording read-side D1 fake: COUNT → total, SELECT → rows, in call order. */
function readDb(total: number, rows: Row[]): { db: D1Database; calls: Array<{ sql: string; binds: unknown[] }> } {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...binds: unknown[]) {
          calls.push({ sql: sql.replace(/\s+/g, " ").trim(), binds });
          return {
            async first<T>() {
              return (sql.includes("COUNT(*)") ? { n: total } : null) as T;
            },
            async all<T>() {
              return { results: rows } as unknown as T;
            }
          };
        }
      };
    }
  };
  return { db: db as unknown as D1Database, calls };
}

function makeEnv(db: D1Database): Env {
  return { CUSTOMER_DB: db, CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET } as unknown as Env;
}

async function call(routes: RouteModule, path: string, env: Env): Promise<Response> {
  return routes.fetch(
    new Request(`http://test.local${path}`, { headers: { authorization: `Bearer ${SECRET}` } }),
    env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
  );
}

/** Abusive `limit` spellings: huge, over-ceiling, zero, negative, non-numeric. */
const LIMIT_PROBES = [
  "999999999",
  "1000000",
  "501",
  "0",
  "-1",
  "-100",
  "NaN",
  "abc",
  "2.5",
  "Infinity",
  "-Infinity",
  "1e308"
];

/** Abusive `offset` spellings. */
const OFFSET_PROBES = ["-1", "-999999", "999999999999", "NaN", "abc", "1.5"];

/** Abusive `cursor` spellings (cursor has no min/max in the schema). */
const CURSOR_PROBES = ["NaN", "abc", "1.5", "Infinity"];

type ListBody = { rows: Row[]; total: number; nextCursor: number | null };

describe.each(ROUTES)("$name list page-size abuse probe", (spec) => {
  it.each(LIMIT_PROBES)("limit=%s answers 200-with-cap or documented 400, never 500", async (limit) => {
    // Arrange — seed a full page so an uncapped LIMIT would be observable.
    const rows = Array.from({ length: 3 }, (_, i) => ({ [spec.idColumn]: i + 1 }));
    const { db, calls } = readDb(3, rows);

    // Act
    const res = await call(spec.routes, `${spec.base}?limit=${limit}`, makeEnv(db));

    // Assert — the whole acceptance contract in one probe.
    expect(res.status).toBeLessThan(500);
    expect([200, 400]).toContain(res.status);
    const raw = await res.text();
    expect(raw).not.toMatch(/at\s+\S+\s+\(.+:\d+:\d+\)/); // no stack-trace leak
    expect(raw).not.toContain('"stack"');
    if (res.status === 400) {
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(calls).toHaveLength(0); // schema rejects before D1
    } else {
      const body = JSON.parse(raw) as ListBody;
      expect(body.rows.length).toBeLessThanOrEqual(500);
      // The LIMIT bind is the schema-capped value actually sent to D1.
      const limitBind = calls[1].binds[0] as number;
      expect(limitBind).toBeGreaterThanOrEqual(1);
      expect(limitBind).toBeLessThanOrEqual(500);
      expect(body.rows.length).toBeLessThanOrEqual(limitBind);
    }
  });

  it.each(OFFSET_PROBES)("offset=%s answers 200 or documented 400, never 500", async (offset) => {
    // Arrange
    const { db, calls } = readDb(0, []);

    // Act
    const res = await call(spec.routes, `${spec.base}?offset=${offset}`, makeEnv(db));

    // Assert
    expect(res.status).toBeLessThan(500);
    expect([200, 400]).toContain(res.status);
    const raw = await res.text();
    expect(raw).not.toContain('"stack"');
    if (res.status === 400) {
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(calls).toHaveLength(0);
    } else {
      const body = JSON.parse(raw) as ListBody;
      expect(body).toEqual({ rows: [], total: 0, nextCursor: null });
    }
  });

  it.each(CURSOR_PROBES)("cursor=%s answers 200 or documented 400, never 500", async (cursor) => {
    // Arrange
    const { db, calls } = readDb(0, []);

    // Act
    const res = await call(spec.routes, `${spec.base}?cursor=${cursor}`, makeEnv(db));

    // Assert
    expect(res.status).toBeLessThan(500);
    expect([200, 400]).toContain(res.status);
    const raw = await res.text();
    expect(raw).not.toContain('"stack"');
    if (res.status === 400) {
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(calls).toHaveLength(0);
    }
  });

  it("combined abuse (huge limit + negative offset + bad cursor) is still 200/400, never 500", async () => {
    // Arrange
    const { db } = readDb(0, []);

    // Act
    const res = await call(
      spec.routes,
      `${spec.base}?limit=999999999&offset=-5&cursor=abc`,
      makeEnv(db)
    );

    // Assert
    expect(res.status).toBeLessThan(500);
    expect([200, 400]).toContain(res.status);
  });

  it("limit=500 boundary still returns 200 with the full cap", async () => {
    // Arrange
    const rows = [{ [spec.idColumn]: 1 }, { [spec.idColumn]: 2 }];
    const { db, calls } = readDb(2, rows);

    // Act
    const res = await call(spec.routes, `${spec.base}?limit=500`, makeEnv(db));

    // Assert — ceiling value is usable, not rejected.
    expect(res.status).toBe(200);
    expect(calls[1].binds[0]).toBe(500);
    expect(await res.json()).toEqual({ rows, total: 2, nextCursor: null });
  });
});
