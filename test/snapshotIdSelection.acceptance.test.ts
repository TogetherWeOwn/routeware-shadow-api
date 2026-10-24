/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { AUTH_THROTTLE_MAX_FAILURES } from "../src/lib/authThrottle";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-first contract: `ids` filters the three ordinary flat snapshot lists.
 * Breaks caught: ignored/coerced selectors, union instead of intersection,
 * wrong primary/relationship column, divergent COUNT/page predicates, unbound
 * SQL, N+1/materialized reads, and lost selection on pagination/validators.
 * Expectations use synthetic fixture ordinals, not production selector helpers.
 * Adjacent direction/Link/ETag contracts are composed only when advertised or
 * emitted by the unselected list; this suite does not require those features.
 * Builder owns implementation, not this file. No live data or outbound I/O.
 */
const TEST_ENV = env as unknown as Env;
const READ_TOKEN = "test-read-token";
const ORIGIN = "https://id-selection-client.invalid";
const REQUEST_ID = "synthetic-id-selection-trace";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
const CORRECTION = "Invalid request query (ids). See docs/PROBLEMS.md#bad-request.";
const MAX_SAFE_ID = 9007199254740991;

type Spec = {
  name: "customer" | "address" | "container";
  base: number;
  id: string;
  singular: string;
  field: string;
  operationId: string;
};
const SPECS: Spec[] = [
  { name: "customer", base: 100, id: "customer_id", singular: "customerId", field: "company_name", operationId: "listCustomerSnapshot" },
  { name: "address", base: 200, id: "pickup_address_id", singular: "pickupAddressId", field: "address", operationId: "listAddressSnapshot" },
  { name: "container", base: 300, id: "container_id", singular: "containerId", field: "serial_number", operationId: "listContainerSnapshot" }
];
const pathFor = (s: Spec) => `/api/v1/${s.name}-snapshot`;
const idsFor = (s: Spec, ordinals: number[]) => ordinals.map((n) => s.base + n);
const selector = (s: Spec, ordinals: number[]) => idsFor(s, ordinals).join(",");
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
const normalize = (sql: string) => sql.replace(/\s+/g, " ").trim();

type Statement = { sql: string; binds: unknown[]; rowsRead?: number };
/** Record the real D1 boundary, including rows returned to the handler. */
function recordDb(real: D1Database) {
  const statements: Statement[] = [];
  const originals = new WeakMap<object, D1PreparedStatement>();
  const records = new WeakMap<object, Statement>();
  function wrap(stmt: D1PreparedStatement, rec: Statement): D1PreparedStatement {
    const wrapped = {
      bind(...binds: unknown[]) {
        rec.binds = binds;
        return wrap(stmt.bind(...binds), rec);
      },
      first: (...args: unknown[]) => (stmt.first as (...a: unknown[]) => unknown)(...args),
      async all() {
        const result = await stmt.all();
        rec.rowsRead = result.results.length;
        return result;
      },
      raw: () => stmt.raw(),
      run: () => { throw new Error("List must not write to D1"); }
    } as unknown as D1PreparedStatement;
    originals.set(wrapped, stmt);
    records.set(wrapped, rec);
    return wrapped;
  }
  const db = {
    prepare(sql: string) {
      const rec: Statement = { sql, binds: [] };
      statements.push(rec);
      return wrap(real.prepare(sql), rec);
    },
    async batch(stmts: D1PreparedStatement[]) {
      const results = await real.batch(stmts.map((s) => originals.get(s) ?? s));
      for (let i = 0; i < stmts.length; i++) {
        const rec = records.get(stmts[i]);
        if (rec) rec.rowsRead = results[i].results.length;
      }
      return results;
    }
  } as unknown as D1Database;
  return { db, statements };
}

type ListBody = { rows: Record<string, unknown>[]; total: number | null; nextCursor: number | null };
type Param = { name: string; in?: string; required?: boolean; description?: string; schema?: Record<string, unknown> };
type Operation = { operationId?: string; parameters?: Param[]; responses?: Record<string, { description?: string }>; [k: string]: unknown };
type OpenApi = { paths: Record<string, { get?: Operation }> };

async function get(path: string, options: {
  db?: D1Database; token?: string | null; headers?: Record<string, string>;
} = {}) {
  const headers = new Headers({ origin: ORIGIN, "X-Request-Id": REQUEST_ID, ...options.headers });
  const token = options.token === undefined ? READ_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return app.fetch(new Request(`http://test.local${path}`, { headers }), {
    ...TEST_ENV, ...(options.db ? { CUSTOMER_DB: options.db } : {})
  });
}

async function list(s: Spec, query: string) {
  const recording = recordDb(TEST_ENV.CUSTOMER_DB);
  const response = await get(`${pathFor(s)}?${query}`, { db: recording.db });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = await response.clone().json() as ListBody;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  return { response, body, statements: recording.statements };
}

function expectPage(s: Spec, body: ListBody, ordinals: number[], total: number | null, next: number | null) {
  expect(body.rows.map((r) => r[s.id])).toEqual(idsFor(s, ordinals));
  expect(body.total).toBe(total);
  expect(body.nextCursor).toBe(next === null ? null : s.base + next);
}

function expectHeaders(res: Response) {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(res.headers.get("x-request-id")).toBe(REQUEST_ID);
}

async function openApi(): Promise<OpenApi> {
  const res = await get("/openapi.json", { token: null });
  expect(res.status).toBe(200);
  return res.json() as Promise<OpenApi>;
}

function whereOf(sql: string) {
  return normalize(sql).split(/\bWHERE\b/i)[1]?.split(/\b(?:ORDER BY|LIMIT|OFFSET)\b/i)[0].trim();
}

function expectBoundSelection(s: Spec, statements: Statement[], selected: number[], limit: number, seek = false, count = true) {
  expect(statements).toHaveLength(count ? 2 : 1);
  expect(statements.filter(isCount)).toHaveLength(count ? 1 : 0);
  const pages = statements.filter((stmt) => !isCount(stmt));
  expect(pages).toHaveLength(1);
  for (const stmt of statements) {
    expect(stmt.sql).toMatch(/^\s*SELECT\b/i);
    // One resource-local primary-key IN, with placeholders, not submitted SQL.
    const clauses = [...stmt.sql.matchAll(/(?:\b\w+\.)?(\w+)\s+IN\s*\(([^)]*)\)/gi)];
    const clause = clauses.find((m) => m[1] === s.id);
    expect(clause, stmt.sql).toBeDefined();
    const slots = clause![2].split(",").map((x) => x.trim());
    expect(slots).toHaveLength(selected.length);
    expect(slots.every((slot) => /^\?(?:\d+)?$/.test(slot))).toBe(true);
    for (const id of selected) {
      expect(stmt.sql).not.toMatch(new RegExp(`\\b${id}\\b`));
      // D1 supports number or canonical decimal-string binds; never a CSV bind.
      expect(stmt.binds.map(String)).toContain(String(id));
    }
    expect(stmt.binds.length).toBeLessThanOrEqual(100);
    expect(stmt.sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP)\b/i);
  }
  const page = pages[0];
  expect(page.sql).toMatch(/\bLIMIT\s+\?/i);
  // Catch SELECT-all + in-memory filtering even when the response looks right.
  expect(page.rowsRead).toBeDefined();
  expect(page.rowsRead!).toBeLessThanOrEqual(limit);
  if (seek) expect(page.sql).not.toMatch(/\bOFFSET\b/i);
  if (count) {
    const total = statements.find(isCount)!;
    expect(whereOf(total.sql)).toBeTruthy();
    expect(whereOf(page.sql)).toBe(whereOf(total.sql));
    // COUNT has exactly the predicate binds, page appends LIMIT[/OFFSET].
    expect(page.binds.slice(0, total.binds.length)).toEqual(total.binds);
    expect(page.binds.slice(total.binds.length)).toEqual(seek ? [limit] : [limit, expect.any(Number)]);
  }
}

const originalFetch = globalThis.fetch;
let outbound: ReturnType<typeof vi.fn>;
beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  outbound = vi.fn(async () => { throw new Error("Unexpected outbound fetch in snapshot IDs acceptance"); });
  globalThis.fetch = outbound as typeof fetch;
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  // Distinct primary-key ranges prevent using customer/address IDs by mistake.
  // First six address owners: 101,101,102,103,103,101. Container 306 also
  // belongs to address 201, proving that relationship ID != primary ID.
  for (let n = 1; n <= 60; n++) {
    const owner = n <= 6 ? [101, 101, 102, 103, 103, 101][n - 1] : 100 + n;
    const address = n === 6 ? 201 : 200 + n;
    const enabled = n === 4 || n === 6 ? 0 : 1;
    const label = n === 2 || n === 5 ? `synthetic-needle-${n}` : `synthetic-other-${n}`;
    await db.batch([
      db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, ?, '2026-10-01T00:00:00.000Z')").bind(100 + n, label, enabled),
      db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, ?, ?, '2026-10-01T00:00:00.000Z')").bind(200 + n, owner, label, enabled),
      db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, enabled, synced_at) VALUES (?, ?, ?, ?, ?, '2026-10-01T00:00:00.000Z')").bind(300 + n, address, label, n === 3 ? "serial-needle-3" : `serial-other-${n}`, enabled)
    ]);
  }
  // Inclusive safe-integer boundary, stored and read through real D1.
  await db.batch([
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'synthetic-max', 1, 'test')").bind(MAX_SAFE_ID),
    db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, 'synthetic-max', 1, 'test')").bind(MAX_SAFE_ID, MAX_SAFE_ID),
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, serial_number, enabled, synced_at) VALUES (?, ?, 'synthetic-max', 1, 'test')").bind(MAX_SAFE_ID, MAX_SAFE_ID)
  ]);
});
afterEach(() => {
  const calls = outbound.mock.calls.length;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  expect(calls, "No read or rejected query may reach an upstream").toBe(0);
});

describe.each(SPECS)("$name ordinary list: bounded primary-ID selection", (s) => {
  it("control: omission still serves the ordinary ascending page and headers", async () => {
    const { body, response, statements } = await list(s, "limit=2");
    expectPage(s, body, [1, 2], 61, 2);
    expectHeaders(response);
    expect(statements).toHaveLength(2);
  });

  it("control: existing q/enabled/seek and the pass-through D1 recorder work without ids", async () => {
    const { body, statements } = await list(s, `q=needle&enabled=true&limit=2&cursor=${s.base + 1}`);
    expectPage(s, body, s.name === "container" ? [2, 3] : [2, 5], s.name === "container" ? 3 : 2, s.name === "container" ? 3 : 5);
    const page = statements.find((stmt) => !isCount(stmt))!;
    const count = statements.find(isCount)!;
    expect(page.rowsRead).toBe(2);
    expect(page.sql).not.toMatch(/\bOFFSET\b/i);
    expect(whereOf(page.sql)).toBe(whereOf(count.sql));
    expect(count.binds.map(String)).toContain("needle");
    expect(page.binds.slice(0, count.binds.length)).toEqual(count.binds);
  });

  it("selects existing IDs, ignores missing IDs, and orders by primary key, not input order", async () => {
    const { body, response } = await list(s, `ids=${selector(s, [5, 1, 3])},999999&limit=10`);
    expectPage(s, body, [1, 3, 5], 3, null);
    expectHeaders(response);
    for (const row of body.rows) expect(row).not.toHaveProperty("missing");
  });

  it("accepts the one-ID lower boundary and returns only that primary ID", async () => {
    const { body } = await list(s, `ids=${s.base + 5}`);
    expectPage(s, body, [5], 1, null);
  });

  it("accepts positive ID 1 and both high safe-integer decimals without coercion", async () => {
    const { body } = await list(s, "ids=1,9007199254740990,9007199254740991");
    expect(body.rows.map((r) => r[s.id])).toEqual([9007199254740991]);
    expect(body.total).toBe(1);
    expect(body.nextCursor).toBeNull();
  });

  it("accepts exactly 50 IDs without fetching other rows or issuing per-ID reads", async () => {
    const ordinals = Array.from({ length: 50 }, (_, i) => 50 - i);
    const selected = idsFor(s, ordinals);
    const { body, statements } = await list(s, `ids=${selected.join(",")}&limit=50`);
    expectPage(s, body, Array.from({ length: 50 }, (_, i) => i + 1), 50, 50);
    expectBoundSelection(s, statements, selected, 50);
  });

  it("returns an empty ordinary envelope for an entirely missing set", async () => {
    const counted = await list(s, "ids=999991,999992");
    expectPage(s, counted.body, [], 0, null);
    const free = await list(s, "ids=999991,999992&includeTotal=false");
    expectPage(s, free.body, [], null, null);
    expect(free.statements.filter(isCount)).toEqual([]);
    expect(free.statements).toHaveLength(1);
  });

  it.each([
    ["intersection matches", 3, [3], 1],
    ["intersection is disjoint", 2, [], 0]
  ] as const)("AND-composes with the singular primary ID: %s", async (_label, singular, wanted, total) => {
    const { body } = await list(s, `ids=${selector(s, [1, 3, 5])}&${s.singular}=${s.base + singular}`);
    expectPage(s, body, [...wanted], total, null);
  });

  it.each([
    ["enabled=true", [1, 3, 5]],
    ["enabled=false", [4, 6]],
    ["q=needle", s.name === "container" ? [3, 5] : [5]],
    ["q=needle&enabled=true", s.name === "container" ? [3, 5] : [5]],
    ["q=not-in-any-synthetic-row", []]
  ] as const)("AND-composes ids with %s (including container serial OR isolation)", async (filter, wanted) => {
    const { body } = await list(s, `ids=${selector(s, [6, 5, 4, 3, 1])}&${filter}`);
    expectPage(s, body, [...wanted], wanted.length, null);
  });

  it("composes fields and both count modes without losing the primary ID or changing the page", async () => {
    const query = `ids=${selector(s, [5, 1, 3])}&limit=2&fields=${s.field}`;
    const counted = await list(s, query);
    const explicit = await list(s, `${query}&includeTotal=true`);
    const free = await list(s, `${query}&includeTotal=false`);
    expectPage(s, counted.body, [1, 3], 3, 3);
    expectPage(s, free.body, [1, 3], null, 3);
    expect(explicit.body).toEqual(counted.body);
    expect(explicit.statements).toEqual(counted.statements);
    expect(free.body.rows).toEqual(counted.body.rows);
    for (const row of free.body.rows) expect(Object.keys(row).sort()).toEqual([s.id, s.field].sort());
    expectBoundSelection(s, free.statements, idsFor(s, [5, 1, 3]), 2, false, false);
    expect(free.statements[0]).toEqual(counted.statements.find((stmt) => !isCount(stmt)));
  });

  it.each([
    ["limit=2", [1, 3], 3, 3],
    ["limit=2&offset=1", [3, 5], 3, 5],
    ["limit=2&offset=2", [5], 3, null],
    ["limit=2&offset=3", [], 3, null],
    [`limit=2&cursor=${s.base + 1}`, [3, 5], 2, 5],
    [`limit=2&cursor=${s.base + 3}`, [5], 1, null],
    [`limit=2&cursor=${s.base + 5}`, [], 0, null],
    [`limit=2&cursor=${s.base + 1}&offset=59`, [3, 5], 2, 5]
  ] as const)("preserves selected-set offset/seek and terminal-page semantics: %s", async (query, wanted, total, next) => {
    const selected = idsFor(s, [5, 1, 3]);
    for (const includeTotal of [true, false]) {
      const { body, statements } = await list(s, `ids=${selected.join(",")}&${query}&includeTotal=${includeTotal}`);
      expectPage(s, body, [...wanted], includeTotal ? total : null, next);
      expectBoundSelection(s, statements, selected, 2, query.includes("cursor="), includeTotal);
    }
  });

  it("walks a selected exactly-full final page through its empty terminal seek page", async () => {
    const query = `ids=${selector(s, [6, 5, 3, 1])}&limit=2&includeTotal=false`;
    const first = await list(s, query);
    expectPage(s, first.body, [1, 3], null, 3);
    const second = await list(s, `${query}&cursor=${first.body.nextCursor}`);
    expectPage(s, second.body, [5, 6], null, 6);
    const final = await list(s, `${query}&cursor=${second.body.nextCursor}`);
    expectPage(s, final.body, [], null, null);
    for (const page of [first, second, final]) {
      expect(page.statements).toHaveLength(1);
      expect(page.statements.filter(isCount)).toEqual([]);
    }
  });

  it("uses identical bound selection/filter/seek predicates for COUNT and page at the 50-ID cap", async () => {
    const selected = idsFor(s, Array.from({ length: 50 }, (_, i) => 50 - i));
    const relationships = s.name === "customer" ? "" : s.name === "address" ? "&customerId=103" : "&customerId=103&pickupAddressId=205";
    const query = `ids=${selected.join(",")}&${s.singular}=${s.base + 5}${relationships}&enabled=true&q=needle&fields=${s.field}&limit=1&offset=59&cursor=${s.base + 1}`;
    const { body, statements } = await list(s, query);
    expectPage(s, body, [5], 1, 5);
    expectBoundSelection(s, statements, selected, 1, true);
    const count = statements.find(isCount)!;
    // Existing q uses a literal substring bind, not a LIKE pattern; enabled
    // is a fixed SQL predicate and need not consume a statement bind.
    expect(count.binds.map(String)).toContain("needle");
    expect(count.binds.map(String).filter((v) => v === String(s.base + 5))).toHaveLength(2);
    expect(count.binds.map(String).filter((v) => v === String(s.base + 1))).toHaveLength(2);
  });

  it("keeps truly unknown names ignored without leaking them into SQL", async () => {
    const query = `ids=${selector(s, [5, 1, 3])}&limit=2`;
    const plain = await list(s, query);
    const unknown = await list(s, `${query}&bogus_param=SYNTHETIC-UNKNOWN`);
    expectPage(s, unknown.body, [1, 3], 3, 3);
    expect(unknown.body).toEqual(plain.body);
    expect(unknown.statements).toEqual(plain.statements);
  });

  it.each([READ_TOKEN, "test-api-token", "test-sync-secret"])("keeps existing read authority for %s", async (token) => {
    const response = await get(`${pathFor(s)}?ids=${s.base + 5}`, { token });
    expect(response.status).toBe(200);
    expectPage(s, await response.json() as ListBody, [5], 1, null);
    expectHeaders(response);
  });
});

describe("relationship predicates remain intersections, not alternative ID selectors", () => {
  it.each(([
    [SPECS[1], "ids=206,205,201,203&customerId=101", [1, 6]],
    [SPECS[1], "ids=206,205,201,203&customerId=102&pickupAddressId=201", []],
    [SPECS[2], "ids=306,305,301,303&customerId=101", [1, 6]],
    [SPECS[2], "ids=306,305,301,303&pickupAddressId=201", [1, 6]],
    [SPECS[2], "ids=306,305,301,303&customerId=101&pickupAddressId=201&containerId=306", [6]],
    [SPECS[2], "ids=306,305,301,303&customerId=102&pickupAddressId=201", []],
    [SPECS[2], "ids=306,305,301,303&customerId=101&cursor=301&offset=59", [6]]
  ] as const).map(([s, query, wanted]) => ({ s, query, wanted })))("$s.name: $query", async ({ s, query, wanted }) => {
    const { body, statements } = await list(s, query);
    expectPage(s, body, [...wanted], wanted.length, null);
    const page = statements.find((stmt) => !isCount(stmt))!;
    if (s.name === "container" && query.includes("customerId=")) expect(page.sql).toMatch(/\bJOIN\s+address_snapshot\b/i);
    if (query.includes("cursor=")) expect(page.sql).not.toMatch(/\bOFFSET\b/i);
    expect(whereOf(page.sql)).toBe(whereOf(statements.find(isCount)!.sql));
  });
});

const INVALID: [string, string][] = [
  ["empty", ""], ["zero", "0"], ["negative", "-1"], ["positive sign", "+1"],
  ["leading zero", "01"], ["all zeros", "00"], ["fraction", "1.5"],
  ["decimal integer", "1.0"], ["trailing dot", "1."], ["exponent", "1e2"],
  ["uppercase exponent", "1E2"], ["hex prefix", "0x10"], ["binary prefix", "0b10"],
  ["unsafe integer", "9007199254740992"], ["huge integer", "9".repeat(1000)],
  ["NaN", "NaN"], ["infinity", "Infinity"], ["leading whitespace", " 1"],
  ["trailing whitespace", "1 "], ["embedded whitespace", "1, 2"],
  ["tab", "1\t"], ["newline", "1\n"], ["NUL", "1\0"],
  ["non-ASCII decimal", "١"], ["full-width decimal", "１"],
  ["non-ASCII separator", "1，2"], ["nonbreaking space", "1, 2"],
  ["leading comma", ",1"], ["trailing comma", "1,"], ["only comma", ","],
  ["empty middle", "1,,2"], ["duplicate", "1,1"], ["nonadjacent duplicate", "1,2,1"],
  ["mixed invalid member", "1,2,3x"], ["mixed unsafe member", "1,9007199254740992"],
  ["mixed padded member", "1,02"], ["JSON array", "[1,2]"],
  ["double encoding", "1%2C2"], ["SQL-shaped", "1) OR 1=1--"],
  ["SQL union", "1,2 UNION SELECT 3"], ["value marker", "SYNTHETIC-REJECTED-ID"],
  ["51 distinct IDs", Array.from({ length: 51 }, (_, i) => i + 1).join(",")],
  ["51 members including duplicate", [...Array.from({ length: 50 }, (_, i) => i + 1), 1].join(",")]
];

describe.each(SPECS)("$name ids: strict value-free validation before any D1 work", (s) => {
  it.each(INVALID)("rejects %s", async (_label, value) => {
    const { db, statements } = recordDb(TEST_ENV.CUSTOMER_DB);
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const response = await get(`${pathFor(s)}?ids=${encodeURIComponent(value)}`, { db });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expectHeaders(response);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ type: BAD_REQUEST, title: "Bad Request", status: 400, detail: CORRECTION });
    expect(Object.keys(body).filter((k) => !["instance", "requestId"].includes(k)).sort()).toEqual(["detail", "status", "title", "type"]);
    if (body.instance !== undefined) expect(body.instance).toBe(pathFor(s));
    if (body.requestId !== undefined) expect(body.requestId).toBe(REQUEST_ID);
    expect(JSON.stringify(body)).not.toContain("SYNTHETIC-REJECTED-ID");
    expect(statements).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each(["ids", "ids=1&ids=2", "ids=1&ids=1", "ids=&ids=1", "ids=1,2&ids=3,4", "ids=1&%69ds=2"])("rejects bare/repeated keys: %s", async (query) => {
    const { db, statements } = recordDb(TEST_ENV.CUSTOMER_DB);
    const response = await get(`${pathFor(s)}?${query}`, { db });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ type: BAD_REQUEST, detail: CORRECTION });
    expect(statements).toEqual([]);
  });

  it.each([null, "wrong-token", ""])("auth control: missing/invalid bearer wins over malformed ids (%j)", async (token) => {
    const { db, statements } = recordDb(TEST_ENV.CUSTOMER_DB);
    for (const query of ["ids=1,2", "ids=0", "ids=1&ids=2"]) {
      const response = await get(`${pathFor(s)}?${query}`, { db, token });
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expectHeaders(response);
      expect(await response.json()).toMatchObject({ status: 401, title: "Unauthorized" });
    }
    expect(statements).toEqual([]);
  });

  it("auth control: throttled invalid bearer still wins over invalid ids before D1", async () => {
    // TEST-NET-3 addresses unique to this suite, one bucket per resource.
    const ip = `203.0.113.${s.base / 100 + 181}`;
    const { db, statements } = recordDb(TEST_ENV.CUSTOMER_DB);
    for (let n = 1; n <= AUTH_THROTTLE_MAX_FAILURES; n++) {
      const response = await get(`${pathFor(s)}?ids=0`, {
        db, token: "synthetic-wrong-throttled", headers: { "cf-connecting-ip": ip }
      });
      expect(response.status).toBe(n < AUTH_THROTTLE_MAX_FAILURES ? 401 : 429);
      if (n === AUTH_THROTTLE_MAX_FAILURES) {
        expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(await response.json()).toMatchObject({ status: 429, title: "Too Many Requests" });
      }
    }
    expect(statements).toEqual([]);
  });

  it.each(["limit=501", "includeTotal=TRUE", "fields=not_a_column", "q=" + "x".repeat(101)])("valid ids does not weaken existing invalid-known-key control: %s", async (other) => {
    const { db, statements } = recordDb(TEST_ENV.CUSTOMER_DB);
    const response = await get(`${pathFor(s)}?ids=${s.base + 1}&${other}`, { db });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ type: BAD_REQUEST, status: 400 });
    expect(statements).toEqual([]);
  });
});

describe.each(SPECS)("$name: compatible adjacent features (only when already present)", (s) => {
  it("applies advertised descending direction to the selected set and its seek", async () => {
    const op = (await openApi()).paths[pathFor(s)]?.get;
    if (!op?.parameters?.some((p) => p.name === "direction")) return;
    const query = `ids=${selector(s, [1, 5, 3])}&direction=desc&limit=2`;
    const first = await list(s, query);
    expectPage(s, first.body, [5, 3], 3, 3);
    const second = await list(s, `${query}&cursor=${first.body.nextCursor}&offset=59`);
    expectPage(s, second.body, [1], 1, null);
    expect(second.statements.find((stmt) => !isCount(stmt))!.sql).not.toMatch(/\bOFFSET\b/i);
  });

  it("retains selection in an existing next Link, excludes unknown keys, and follows it", async () => {
    const plain = await list(s, "limit=2");
    if (plain.response.headers.get("link") === null) return;
    const first = await list(s, `ids=${selector(s, [5, 1, 3])}&fields=${s.field}&includeTotal=false&limit=2&bogus_param=SYNTHETIC-UNKNOWN`);
    expectPage(s, first.body, [1, 3], null, 3);
    const link = first.response.headers.get("link") ?? "";
    const next = link.match(/<([^>]+)>;\s*rel="?next"?/i)?.[1];
    expect(next).toBeDefined();
    const target = new URL(next!, `http://test.local${pathFor(s)}`);
    expect(target.pathname).toBe(pathFor(s));
    expect(target.searchParams.getAll("ids")).toHaveLength(1);
    expect(target.searchParams.get("ids")!.split(",").sort()).toEqual(idsFor(s, [1, 3, 5]).map(String).sort());
    expect(target.searchParams.get("cursor")).toBe(String(s.base + 3));
    const names = (await openApi()).paths[pathFor(s)]!.get!.parameters!.map((p) => p.name);
    for (const name of target.searchParams.keys()) expect(names).toContain(name);
    expect(target.search).not.toContain("SYNTHETIC-UNKNOWN");
    const second = await list(s, target.search.slice(1));
    expectPage(s, second.body, [5], null, null);
    expect(Object.keys(second.body.rows[0]).sort()).toEqual([s.id, s.field].sort());
  });

  it("keeps existing conditional validators tied to the selected served envelope", async () => {
    const plain = await list(s, "limit=2");
    const oldTag = plain.response.headers.get("etag");
    if (oldTag === null) return;
    const query = `ids=${selector(s, [5, 1, 3])}&limit=2`;
    const selected = await get(`${pathFor(s)}?${query}`, { headers: { "If-None-Match": oldTag } });
    expect(selected.status).toBe(200);
    expectPage(s, await selected.json() as ListBody, [1, 3], 3, 3);
    const tag = selected.headers.get("etag");
    expect(tag).toBeTruthy();
    expect(tag).not.toBe(oldTag);
    const repeat = await get(`${pathFor(s)}?${query}`, { headers: { "If-None-Match": tag! } });
    expect(repeat.status).toBe(304);
    expect(await repeat.text()).toBe("");
    expect(repeat.headers.get("etag")).toBe(tag);
    for (const suffix of ["&includeTotal=false", `&fields=${s.field}`, `&cursor=${s.base + 1}`, "&offset=1"]) {
      const changed = await get(`${pathFor(s)}?${query}${suffix}`, { headers: { "If-None-Match": tag! } });
      expect(changed.status).toBe(200);
      expect(changed.headers.get("etag")).not.toBe(tag);
    }
    // Same page and cursor, different COUNT: a validator must hash the envelope.
    const more = await get(`${pathFor(s)}?ids=${selector(s, [1, 3, 5, 6])}&limit=2`, { headers: { "If-None-Match": tag! } });
    expect(more.status).toBe(200);
    expectPage(s, await more.json() as ListBody, [1, 3], 4, 3);
    expect(more.headers.get("etag")).not.toBe(tag);
  });
});

describe("ids discovery and compatibility boundaries", () => {
  it.each(SPECS)("publishes $name optional string selector, bounds, errors, and unchanged operation metadata", async (s) => {
    const operation = (await openApi()).paths[pathFor(s)]!.get!;
    expect(operation.operationId).toBe(s.operationId);
    expect(operation["x-access"]).toBe("read");
    expect(operation["x-effect"]).toBe("local-read");
    const params = operation.parameters?.filter((p) => p.name === "ids") ?? [];
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ in: "query", required: false, schema: { type: "string" } });
    const description = `${params[0].description ?? ""} ${params[0].schema?.description ?? ""}`;
    expect(description).toMatch(/50/);
    expect(description).toMatch(/comma/i);
    expect(description).toMatch(/distinct|unique|duplicate/i);
    expect(description).toMatch(/canonical|unpadded/i);
    expect(description).toMatch(/positive/i);
    expect(description).toMatch(/safe.integer|9007199254740991/i);
    expect(description).toMatch(/primary/i);
    const error = operation.responses?.["400"]?.description ?? "";
    for (const term of ["ids", "fields", "q", "limit", "enabled"]) expect(error).toContain(term);
    expect(error).toContain("application/problem+json");
  });

  it("adds ids only to ordinary lists, preserving the exact operation surface", async () => {
    const doc = await openApi();
    // Hydrated /data/* may independently gain batch ids; that is not this contract.
    const selecting = Object.entries(doc.paths).filter(([path, item]) =>
      /^\/api\/v1\/(?:customer|address|container)-snapshot(?:\/|$)/.test(path) &&
      item.get?.parameters?.some((p) => p.name === "ids")
    ).map(([path]) => path).sort();
    expect(selecting).toEqual(SPECS.map(pathFor).sort());
  });

  it.each(SPECS)("query-policy inventory recognizes ids on $name", (s) => {
    const row = policyDoc.split("\n").find((line) => line.startsWith(`| \`${pathFor(s)}\` |`));
    expect(row).toContain("`ids`");
    expect(row).toContain("Ignore");
  });

  it("does not add ids to the changes-feed policy inventory", () => {
    const row = policyDoc.split("\n").find((line) => line.startsWith("| `/api/v1/customer-snapshot/changes` |"));
    expect(row).toBeDefined();
    expect(row).not.toContain("`ids`");
  });

  it.each(SPECS)("$name by-id reads and CSV exports still ignore ids", async (s) => {
    for (const suffix of [`/${s.base + 1}`, "/export"]) {
      const path = pathFor(s) + suffix;
      const plain = await get(path, { token: "test-sync-secret" });
      const selected = await get(`${path}?ids=not-valid-for-a-list`, { token: "test-sync-secret" });
      expect(plain.status).toBe(200);
      expect(selected.status).toBe(200);
      expect(await selected.text()).toBe(await plain.text());
    }
  });

  it("the changes feed still ignores ids, rather than inheriting ordinary-list validation", async () => {
    const path = "/api/v1/customer-snapshot/changes?limit=2";
    const plain = await get(path);
    const extra = await get(`${path}&ids=not-valid-for-a-list`);
    expect(plain.status).toBe(200);
    expect(extra.status).toBe(200);
    expect(await extra.json()).toEqual(await plain.json());
  });
});
