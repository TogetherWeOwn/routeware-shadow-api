/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned acceptance oracle: filter containers by stored container type.
 *
 * R26-01 contract: optional `containerTypeId` on the EXISTING container-snapshot
 * list as an exact unpadded ASCII nonnegative safe-integer query string. `0` is
 * a literal stored value, never a null/all sentinel. Invalid spellings and
 * repeated keys are value-free 400s before D1; one bound equality predicate on
 * `container_type_id` (alias-correct on both fromJoin paths), AND-composed with
 * every existing filter and cursor clause; null types never match; omission
 * preserves today's matches and wire behavior; the validated selector travels
 * in server-supplied next links.
 *
 * Hermetic: synthetic fixtures in real local D1 via real app.fetch; unexpected
 * outbound fetch throws; the recorder throws on batch/exec/run so any write
 * attempt fails the test. No live tenant/production calls.
 *
 * RED/GREEN split: assertions naming the new selector are intentionally RED
 * before the paired build (today the key is an ignored unknown name, so every
 * such request returns the unfiltered 200). Omission, auth, wire-shape,
 * unknown-name-ignore and operation pins are GREEN regression guards.
 *
 * Owned file: this file only. The Builder must not edit it; oracle corrections
 * come through new bounded children.
 */

const TEST_ENV = env as unknown as Env;
const READ_TOKEN = "test-read-token";
const ORIGIN = "https://container-type-filter.test.invalid";
const PATH = "/api/v1/container-snapshot";
const PROBLEM_BASE =
  "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#";

// Fixtures: type 0, two positive types, null, repeated types, enabled/disabled
// containers across distinct addresses/customers. 9305's location mentions
// "five" while its stored type is 7, and 9307's location mentions "five" with
// a null type, so q/type intersections prove the predicate reads the stored
// column rather than the text match.
const FIXTURES = [
  { id: 9301, address: 9201, customer: 9101, type: 0, enabled: 1, location: "synthetic-zero-alpha", serial: "ZERO-9301" },
  { id: 9302, address: 9201, customer: 9101, type: 5, enabled: 1, location: "synthetic-five-alpha", serial: "FIVE-9302-X" },
  { id: 9303, address: 9202, customer: 9101, type: 5, enabled: 0, location: "synthetic-five-beta", serial: "FIVE-9303-X" },
  { id: 9304, address: 9202, customer: 9101, type: 7, enabled: 1, location: "synthetic-seven-alpha", serial: "SEVEN-9304" },
  { id: 9305, address: 9203, customer: 9102, type: 7, enabled: 0, location: "synthetic-five-gamma", serial: "SEVEN-9305" },
  { id: 9306, address: 9203, customer: 9102, type: null, enabled: 1, location: "synthetic-null-alpha", serial: "NULL-9306" },
  { id: 9307, address: 9204, customer: 9103, type: null, enabled: 0, location: "synthetic-five-delta", serial: "NULL-9307" },
  { id: 9308, address: 9204, customer: 9103, type: 0, enabled: 0, location: "synthetic-zero-beta", serial: "ZERO-9308" }
] as const;
const ALL_IDS = FIXTURES.map((f) => f.id);

type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[]; method: string };

const ids = (body: Body) => body.rows.map((r) => r.container_id);

// Observe actual executions (including batch/exec), not merely prepare calls,
// so a count/lookahead hidden behind a different D1 method cannot evade the
// budget. Any mutation attempt throws: lists must not write.
function recordDb(real: D1Database) {
  const statements: Statement[] = [];
  const batch = vi.fn(() => { throw new Error("List must not batch D1 work"); });
  const exec = vi.fn(() => { throw new Error("List must not exec D1 work"); });
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql, values),
      first: (...args: unknown[]) => {
        statements.push({ sql, binds, method: "first" });
        return (stmt.first as (...a: unknown[]) => unknown)(...args);
      },
      all: () => {
        statements.push({ sql, binds, method: "all" });
        return stmt.all();
      },
      raw: (...args: unknown[]) => {
        statements.push({ sql, binds, method: "raw" });
        return (stmt.raw as (...a: unknown[]) => unknown)(...args);
      },
      run: () => {
        statements.push({ sql, binds, method: "run" });
        throw new Error("List must not mutate D1");
      }
    } as unknown as D1PreparedStatement;
  }
  const db = {
    prepare: (sql: string) => wrap(real.prepare(sql), sql, []),
    batch,
    exec
  } as unknown as D1Database;
  return { db, statements, batch, exec };
}

// Live observer for the rejection path: proves zero D1 work without
// substituting SQL results.
function observedDb() {
  const calls = vi.fn<(method: string) => void>();
  const db = new Proxy(TEST_ENV.CUSTOMER_DB, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls(String(property));
        return Reflect.apply(value, target, args);
      };
    }
  });
  return { db, calls };
}

async function getList(
  search = "",
  options: { db?: D1Database; token?: string | null; headers?: Record<string, string> } = {}
): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN, ...options.headers });
  const token = options.token === undefined ? READ_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return app.fetch(new Request(`http://test.local${PATH}${search ? `?${search}` : ""}`, { headers }), {
    ...TEST_ENV,
    CUSTOMER_DB: options.db ?? TEST_ENV.CUSTOMER_DB
  });
}

async function page(search = "", db?: D1Database): Promise<{ response: Response; body: Body; url: URL }> {
  const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
  const response = await getList(search, { db: db ?? recorder.db });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("x-request-id")).toBeTruthy();
  const body = (await response.json()) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  return { response, body, url: new URL(`http://test.local${PATH}${search ? `?${search}` : ""}`) };
}

function nextTarget(response: Response, current: URL, expected: Record<string, string>): URL {
  const link = response.headers.get("link");
  expect(link, "non-null nextCursor requires Link: <relative-target>; rel=\"next\"").not.toBeNull();
  expect(link).toMatch(/^<\/api\/v1\/container-snapshot\?[^<>\s]*>; rel="next"$/);
  const raw = /^<([^>]+)>; rel="next"$/.exec(link!)![1];
  expect(raw.startsWith("//")).toBe(false);
  const target = new URL(raw, current);
  expect(target.origin).toBe(current.origin);
  expect(target.pathname).toBe(PATH);
  const expectedParams = { ...expected };
  if (expected.includeTotal !== "false") {
    expect([null, "true"]).toContain(target.searchParams.get("includeTotal"));
    target.searchParams.delete("includeTotal");
    delete expectedParams.includeTotal;
  }
  expect(Object.fromEntries(target.searchParams)).toEqual(expectedParams);
  expect(target.searchParams.has("offset")).toBe(false);
  return target;
}

async function expectInvalid(search: string): Promise<Record<string, unknown>> {
  const observed = observedDb();
  const response = await getList(search, { db: observed.db });
  // Soft checks keep both the boundary status and forbidden D1 work visible on RED.
  expect.soft(observed.calls.mock.calls, "invalid containerTypeId must do zero D1 work").toEqual([]);
  expect.soft(response.status).toBe(400);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  const body = (await response.json()) as Record<string, unknown>;
  // Value-free: names the field, never the submitted value.
  expect(body).toEqual({
    type: `${PROBLEM_BASE}bad-request`,
    title: "Bad Request",
    status: 400,
    detail: "Invalid request query (containerTypeId). See docs/PROBLEMS.md#bad-request."
  });
  return body;
}

beforeAll(async () => {
  await ensureD1TestTables();
});

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("Unexpected outbound fetch in container type filter acceptance");
  }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  await db.batch(
    [9101, 9102, 9103].map((id) =>
      db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, 1, 'synthetic')")
        .bind(id, `Synthetic type-filter customer ${id}`)
    )
  );
  const addresses = [
    [9201, 9101],
    [9202, 9101],
    [9203, 9102],
    [9204, 9103]
  ] as const;
  await db.batch(
    addresses.map(([address, customer]) =>
      db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, ?, 1, 'synthetic')")
        .bind(address, customer, `Synthetic type-filter address ${address}`)
    )
  );
  await db.batch(
    FIXTURES.map((f) =>
      db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, container_type_id, location_address, serial_number, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?, 'synthetic')")
        .bind(f.id, f.address, f.type, f.location, f.serial, f.enabled)
    )
  );
});

afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("container type filter: equality and null exclusion", () => {
  it("matches stored type 0 as a literal value, not a null/all sentinel", async () => {
    const { body } = await page("containerTypeId=0");
    expect(ids(body)).toEqual([9301, 9308]);
    expect(body.total).toBe(2);
    expect(body.nextCursor).toBeNull();
    expect(body.rows.every((r) => r.container_type_id === 0)).toBe(true);
  });

  it.each([
    ["5", [9302, 9303]],
    ["7", [9304, 9305]]
  ])("matches repeated positive type %s across addresses", async (type, expected) => {
    const { body } = await page(`containerTypeId=${type}`);
    expect(ids(body)).toEqual(expected);
    expect(body.total).toBe(expected.length);
    expect(body.rows.every((r) => r.container_type_id === Number(type))).toBe(true);
  });

  it("returns an empty page when no stored row carries the type", async () => {
    const { body } = await page("containerTypeId=999");
    expect(body.rows).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.nextCursor).toBeNull();
  });

  it("never matches null stored types for any value", async () => {
    for (const type of ["0", "5", "7", "999"]) {
      const { body } = await page(`containerTypeId=${type}`);
      expect(body.rows.every((r) => r.container_type_id !== null)).toBe(true);
      expect(ids(body)).not.toContain(9306);
      expect(ids(body)).not.toContain(9307);
    }
  });

  it("accepts the maximum safe integer as a valid value with no matches", async () => {
    const { body } = await page("containerTypeId=9007199254740991");
    expect(body.rows).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.nextCursor).toBeNull();
  });
});

describe("container type filter: AND-composition with existing selectors", () => {
  it.each([
    ["customerId=9101&containerTypeId=5", [9302, 9303]],
    ["customerId=9102&containerTypeId=7", [9305]],
    ["customerId=9101&containerTypeId=7", [9304]],
    ["customerId=9103&containerTypeId=0", [9308]]
  ])("intersects the customer join: %s", async (search, expected) => {
    const { body } = await page(search);
    expect(ids(body)).toEqual(expected);
    expect(body.total).toBe(expected.length);
  });

  it.each([
    "customerId=9102&containerTypeId=5",
    "customerId=9103&containerTypeId=7",
    "customerId=9101&containerTypeId=999"
  ])("returns empty on conflicting customer/type selectors: %s", async (search) => {
    const { body } = await page(search);
    expect(body.rows).toEqual([]);
    expect(body.total).toBe(0);
  });

  it.each([
    ["pickupAddressId=9202&containerTypeId=7", [9304]],
    ["pickupAddressId=9201&containerTypeId=0", [9301]],
    ["pickupAddressId=9204&containerTypeId=0", [9308]]
  ])("intersects the address selector: %s", async (search, expected) => {
    const { body } = await page(search);
    expect(ids(body)).toEqual(expected);
  });

  it("returns empty on a conflicting address/type pair", async () => {
    const { body } = await page("pickupAddressId=9203&containerTypeId=5");
    expect(body.rows).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("intersects the container id selector on agreement", async () => {
    const { body } = await page("containerId=9302&containerTypeId=5");
    expect(ids(body)).toEqual([9302]);
    expect(body.total).toBe(1);
  });

  it("returns empty on a conflicting container id/type pair", async () => {
    const { body } = await page("containerId=9302&containerTypeId=7");
    expect(body.rows).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("intersects text search on the stored column, not the text match", async () => {
    // q=five matches 9302, 9303 (serial+location), 9305 and 9307 (location).
    // The type predicate keeps only stored 5s: 9305 (type 7) and 9307 (null)
    // drop out even though their locations mention five.
    const { body } = await page("q=five&containerTypeId=5");
    expect(ids(body)).toEqual([9302, 9303]);
  });

  it("keeps a type-7 text match whose location names another type", async () => {
    const { body } = await page("q=five&containerTypeId=7");
    expect(ids(body)).toEqual([9305]);
  });

  it("returns empty on conflicting q/type selectors", async () => {
    const { body } = await page("q=seven&containerTypeId=5");
    expect(body.rows).toEqual([]);
    expect(body.total).toBe(0);
  });

  it.each([
    ["enabled=true&containerTypeId=5", [9302]],
    ["enabled=false&containerTypeId=5", [9303]],
    ["enabled=true&containerTypeId=0", [9301]],
    ["enabled=false&containerTypeId=0", [9308]]
  ])("intersects the enabled selector: %s", async (search, expected) => {
    const { body } = await page(search);
    expect(ids(body)).toEqual(expected);
    expect(body.total).toBe(expected.length);
  });
});

describe("container type filter: strict lexical validation before D1", () => {
  it.each([
    "",
    " ",
    "00",
    "05",
    " 5",
    "5 ",
    "+5",
    "-5",
    "-0",
    "5.0",
    "5.5",
    "5e1",
    "5E0",
    "0x5",
    "0b101",
    "NaN",
    "Infinity",
    "5suffix",
    "five",
    "9007199254740992",
    "9007199254740993",
    "99999999999999999999999"
  ])("rejects non-exact spelling %j without D1 work", async (value) => {
    await expectInvalid(`containerTypeId=${encodeURIComponent(value)}`);
  });

  it.each([
    "containerTypeId=5&containerTypeId=7",
    "containerTypeId=5&containerTypeId=5",
    "containerTypeId=&containerTypeId=5"
  ])("rejects repeated keys rather than selecting a value: %s", async (search) => {
    await expectInvalid(search);
  });

  it("rejects a repeated key even when combined with valid sibling filters", async () => {
    await expectInvalid("customerId=9101&containerTypeId=5&containerTypeId=5&enabled=true");
  });

  it("uses identical fixed guidance for different rejected spellings", async () => {
    const first = await expectInvalid("containerTypeId=+5");
    const second = await expectInvalid("containerTypeId=9007199254740993");
    expect(first).toEqual(second);
  });

  it.each([null, "synthetic-invalid-token"])("authenticates before type validation with token=%j", async (token) => {
    const observed = observedDb();
    const response = await getList("containerTypeId=+5", { db: observed.db, token });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ type: `${PROBLEM_BASE}unauthorized`, status: 401 });
    expect(observed.calls).not.toHaveBeenCalled();
  });
});

describe("container type filter: SQL shape and binds", () => {
  function typePredicates(statements: Statement[]): Statement[] {
    return statements.filter((s) => /container_type_id\s*=\s*\?/.test(s.sql));
  }

  it("applies one bound equality predicate on the bare path", async () => {
    const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
    const response = await getList("containerTypeId=5", { db: recorder.db });
    expect(response.status).toBe(200);
    expect(recorder.statements).toHaveLength(2);
    expect(recorder.statements.every((s) => /^\s*SELECT\b/i.test(s.sql))).toBe(true);
    // Both the COUNT and the page SELECT carry the predicate; the bare path
    // has no address join, so the alias must be the container alias.
    expect(typePredicates(recorder.statements)).toHaveLength(2);
    for (const s of recorder.statements) {
      expect(s.sql).toContain("c.container_type_id = ?");
      expect(s.sql.match(/container_type_id\s*=\s*\?/g)).toHaveLength(1);
      expect(s.binds).toContain(5);
    }
    expect(recorder.batch).not.toHaveBeenCalled();
    expect(recorder.exec).not.toHaveBeenCalled();
  });

  it("keeps the container alias on the customer-join path", async () => {
    const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
    const response = await getList("customerId=9101&containerTypeId=5", { db: recorder.db });
    expect(response.status).toBe(200);
    expect(recorder.statements).toHaveLength(2);
    expect(typePredicates(recorder.statements)).toHaveLength(2);
    for (const s of recorder.statements) {
      expect(s.sql).toContain("INNER JOIN address_snapshot");
      expect(s.sql).toContain("c.container_type_id = ?");
      expect(s.sql.match(/container_type_id\s*=\s*\?/g)).toHaveLength(1);
      expect(s.binds).toContain(9101);
      expect(s.binds).toContain(5);
    }
  });

  it("binds zero as the number 0, not a null/all sentinel", async () => {
    const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
    const response = await getList("containerTypeId=0", { db: recorder.db });
    expect(response.status).toBe(200);
    for (const s of typePredicates(recorder.statements)) {
      expect(s.binds).toContain(0);
    }
    expect(typePredicates(recorder.statements).length).toBeGreaterThan(0);
  });

  it("executes zero COUNT statements in count-free mode with identical rows", async () => {
    const counted = recordDb(TEST_ENV.CUSTOMER_DB);
    const countedRes = await getList("containerTypeId=5&limit=1", { db: counted.db });
    expect(countedRes.status).toBe(200);
    const countedBody = (await countedRes.json()) as Body;
    expect(counted.statements).toHaveLength(2);
    expect(counted.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(1);

    const free = recordDb(TEST_ENV.CUSTOMER_DB);
    const freeRes = await getList("containerTypeId=5&limit=1&includeTotal=false", { db: free.db });
    expect(freeRes.status).toBe(200);
    const freeBody = (await freeRes.json()) as Body;
    expect(free.statements).toHaveLength(1);
    expect(free.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(0);
    expect(free.statements.every((s) => /^\s*SELECT\b/i.test(s.sql))).toBe(true);
    expect(freeBody.total).toBeNull();
    expect(freeBody.rows).toEqual(countedBody.rows);
    expect(freeBody.nextCursor).toBe(countedBody.nextCursor);
    expect(ids(freeBody)).toEqual([9302]);
    expect(ids(countedBody)).toEqual([9302]);
  });

  it("performs zero application writes on filtered reads", async () => {
    const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
    const response = await getList("containerTypeId=5", { db: recorder.db });
    expect(response.status).toBe(200);
    const count = await TEST_ENV.CUSTOMER_DB.prepare("SELECT COUNT(*) as n FROM container_snapshot")
      .first<{ n: number }>();
    expect(count?.n).toBe(FIXTURES.length);
  });

  it("records the local query shape for the intended predicate", async () => {
    // Local shape evidence only, not a production scan-cost claim: the
    // contract adds no index or migration, so this documents the hermetic
    // plan text the Builder's predicate produces on local D1.
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(
      "EXPLAIN QUERY PLAN SELECT c.container_id FROM container_snapshot c WHERE c.container_type_id = ? ORDER BY c.container_id LIMIT ?"
    ).bind(5, 50).all<Record<string, unknown>>();
    expect(plan.results.length).toBeGreaterThan(0);
    // The contract adds no index or migration: the hermetic local plan stays
    // a scan of the container alias. Local shape only, never a production
    // scan-cost claim.
    expect(plan.results.map((r) => String(r.detail))).toEqual(["SCAN c"]);
  });
});

describe("container type filter: next-link traversal", () => {
  it("carries the validated selector through asc pages to an empty tail", async () => {
    const first = await page("containerTypeId=5&limit=1");
    expect(ids(first.body)).toEqual([9302]);
    expect(first.body.total).toBe(2);
    expect(first.body.nextCursor).toBe(9302);
    const second = await getList(nextTarget(first.response, first.url, {
      containerTypeId: "5",
      limit: "1",
      cursor: "9302"
    }).search.slice(1));
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Body;
    expect(ids(secondBody)).toEqual([9303]);
    expect(secondBody.total).toBe(1);
    expect(secondBody.nextCursor).toBe(9303);
    // Full terminal page links to an empty page: omission means stop.
    const emptyTarget = nextTarget(second, new URL(second.url), {
      containerTypeId: "5",
      limit: "1",
      cursor: "9303"
    });
    const empty = await getList(emptyTarget.search.slice(1));
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as Body;
    expect(emptyBody.rows).toEqual([]);
    expect(emptyBody.total).toBe(0);
    expect(emptyBody.nextCursor).toBeNull();
    expect(empty.headers.get("link")).toBeNull();
  });

  it("carries the selector through desc pages in reverse id order", async () => {
    const first = await page("containerTypeId=5&limit=1&order=desc");
    expect(ids(first.body)).toEqual([9303]);
    expect(first.body.nextCursor).toBe(9303);
    const target = nextTarget(first.response, first.url, {
      containerTypeId: "5",
      limit: "1",
      order: "desc",
      cursor: "9303"
    });
    const second = await getList(target.search.slice(1));
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Body;
    expect(ids(secondBody)).toEqual([9302]);
    expect(secondBody.nextCursor).toBe(9302);
    const tail = await getList(nextTarget(second, new URL(second.url), {
      containerTypeId: "5",
      limit: "1",
      order: "desc",
      cursor: "9302"
    }).search.slice(1));
    const tailBody = (await tail.json()) as Body;
    expect(tailBody.rows).toEqual([]);
    expect(tailBody.nextCursor).toBeNull();
  });

  it("converts an offset start into keyset continuation without offset", async () => {
    const first = await page("containerTypeId=7&limit=1&offset=1");
    expect(ids(first.body)).toEqual([9305]);
    expect(first.body.total).toBe(2);
    expect(first.body.nextCursor).toBe(9305);
    const target = nextTarget(first.response, first.url, {
      containerTypeId: "7",
      limit: "1",
      cursor: "9305"
    });
    const tail = await getList(target.search.slice(1));
    const tailBody = (await tail.json()) as Body;
    expect(tailBody.rows).toEqual([]);
    expect(tailBody.nextCursor).toBeNull();
  });

  it("keeps cursor-relative totals under the type predicate", async () => {
    const { body } = await page("containerTypeId=5&cursor=9302");
    expect(ids(body)).toEqual([9303]);
    // Total counts matches after the cursor predicate, not the full table.
    expect(body.total).toBe(1);
  });

  it("composes with sparse fields without changing matches", async () => {
    const { body } = await page("containerTypeId=5&fields=container_type_id,serial_number");
    expect(ids(body)).toEqual([9302, 9303]);
    expect(body.total).toBe(2);
    expect(body.rows).toEqual([
      { container_id: 9302, container_type_id: 5, serial_number: "FIVE-9302-X" },
      { container_id: 9303, container_type_id: 5, serial_number: "FIVE-9303-X" }
    ]);
  });

  it("round-trips conditional metadata with the filtered envelope", async () => {
    const first = await getList("containerTypeId=5");
    expect(first.status).toBe(200);
    const tag = first.headers.get("etag");
    expect(tag).toMatch(/^".+"$/);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const replay = await getList("containerTypeId=5", { headers: { "if-none-match": tag! } });
    expect(replay.status).toBe(304);
    expect(await replay.text()).toBe("");
    expect(replay.headers.get("etag")).toBe(tag);
    expect(replay.headers.get("cache-control")).toBe("no-store");
    expect(replay.headers.get("link")).toBe(first.headers.get("link"));
    // A different selector is a different envelope: no false match.
    const other = await getList("containerTypeId=7", { headers: { "if-none-match": tag! } });
    expect(other.status).toBe(200);
  });
});

describe("container type filter: mounted OpenAPI contract", () => {
  type Parameter = { in?: string; name?: string; description?: string; schema?: Record<string, unknown> };
  type Operation = { operationId?: string; parameters?: Parameter[]; responses?: Record<string, { description?: string }> } & Record<string, unknown>;

  async function listOperation(): Promise<Operation> {
    const res = await exports.default.fetch("http://test.local/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, Record<string, Operation>> };
    const op = doc.paths["/api/v1/container-snapshot"]?.["get"];
    expect(op).toBeTruthy();
    return op!;
  }

  it("publishes containerTypeId as an honest integer query facet", async () => {
    const op = await listOperation();
    const param = (op.parameters ?? []).find((p) => p.in === "query" && p.name === "containerTypeId");
    expect(param, "mounted listContainerSnapshot must declare the containerTypeId query key").toBeTruthy();
    // Honest numeric contract for generated clients; runtime validation stays
    // strict-lexical (unpadded ASCII, no coercion) per the invalid-spelling
    // cases above.
    expect(param!.schema).toMatchObject({ type: "integer", minimum: 0, maximum: 9007199254740991 });
    expect(param!.description).toBeTruthy();
    expect(param!.description).toContain("snapshot");
  });

  it("names the fixed correction action for invalid syntax", async () => {
    const op = await listOperation();
    expect(op.responses?.["400"]?.description).toContain("containerTypeId");
  });

  it("keeps the list operation identity and read scope", async () => {
    const op = await listOperation();
    expect(op.operationId).toBe("listContainerSnapshot");
    expect(op["x-access"]).toBe("read");
  });
});

describe("container type filter: omission and compatibility pins", () => {
  it("preserves previous matches when the selector is omitted", async () => {
    const { body } = await page("");
    expect(ids(body)).toEqual(ALL_IDS);
    expect(body.total).toBe(ALL_IDS.length);
    expect(body.nextCursor).toBeNull();
    expect(body.rows.map((r) => r.container_type_id)).toEqual([0, 5, 5, 7, 7, null, null, 0]);
  });

  it("emits no type predicate when the selector is omitted", async () => {
    const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
    const response = await getList("", { db: recorder.db });
    expect(response.status).toBe(200);
    expect(recorder.statements).toHaveLength(2);
    for (const s of recorder.statements) {
      expect(s.sql).not.toContain("container_type_id = ?");
    }
  });

  it("keeps the full row shape and envelope keys", async () => {
    const { body } = await page("limit=1");
    expect(Object.keys(body.rows[0]!).sort()).toEqual(
      [
        "container_id", "pickup_address_id", "container_type_id", "serial_number", "rfid", "oncall",
        "event_code", "gps_locked", "latitude", "longitude", "enabled", "location_address", "city",
        "state", "zip", "container_note", "ud_cost_share_ud", "ud_enclosure_doors_ud",
        "ud_last_compactor_inspection_ud", "ud_last_enclosure_inspection_ud", "ud_material_stream_ud",
        "color", "service_code_type", "service_code_input", "service_code", "service_date",
        "route_ids", "frequency_ids", "synced_at"
      ].sort()
    );
  });

  it("keeps ignoring unknown query names without changing matches", async () => {
    const plain = await page("containerTypeId=5");
    const extra = await getList("containerTypeId=5&bogus_param=1");
    expect(extra.status).toBe(200);
    expect((await extra.json()) as Body).toEqual(plain.body);
  });

  it("keeps existing selector behavior with the type omitted", async () => {
    const byCustomer = await page("customerId=9101");
    expect(ids(byCustomer.body)).toEqual([9301, 9302, 9303, 9304]);
    const byAddress = await page("pickupAddressId=9203");
    expect(ids(byAddress.body)).toEqual([9305, 9306]);
    const byId = await page("containerId=9306");
    expect(ids(byId.body)).toEqual([9306]);
    const byText = await page("q=five");
    expect(ids(byText.body)).toEqual([9302, 9303, 9305, 9307]);
    const byEnabled = await page("enabled=false");
    expect(ids(byEnabled.body)).toEqual([9303, 9305, 9307, 9308]);
  });
});
