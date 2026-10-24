/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned oracle: select addresses by the stored extras-allowed flag.
 *
 * R26-02 adds an optional `extrasAllowed=true|false|any` selector (default
 * `any`) to the EXISTING address list. The flag is stored snapshot state
 * (`extras_allowed`, NOT NULL DEFAULT 1), not a live policy assertion and not
 * permission to mutate service terms.
 *
 * Intended state: RED before the paired build. The new-selector assertions
 * below fail on main because `extrasAllowed` is an unknown query name there
 * (ignored → unfiltered 200s, no 400s, no OpenAPI param). Compatibility
 * assertions (bare list, enabled/q/ID filters, order, count-free mode, by-id,
 * unknown-key policy, operation identity) pass before AND after the build.
 *
 * Builder rules: build on this commit WITHOUT editing this file. Oracle
 * corrections come through a new bounded child card, never a direct edit.
 * No snapshots in this file: every expectation is a hand-derived literal so
 * `vitest -u` cannot re-record the missing behavior away.
 *
 * Hermetic: real local D1 executes every recorded read; outbound fetch throws;
 * list paths must never batch/exec/run. No tenant data, no live deployment.
 */

const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/address-snapshot";
const ORIGIN = "https://extras.test.invalid";
const READ_TOKEN = "test-read-token";
const API_TOKEN = "test-api-token";
const SYNC_SECRET = "test-sync-secret";
const NEEDLE = "synthetic-needle";

// Six addresses spanning extras 0/1 x enabled 0/1, three customers, needle and
// non-needle street text, and present/absent child containers.
const IDS = [11, 23, 37, 42, 58, 91];
const OWNER = [11, 11, 23, 37, 37, 11];
const ENABLED = [1, 1, 1, 0, 1, 0];
const EXTRAS = [1, 0, 1, 1, 0, 0];
const NEEDLE_MATCH = [false, true, false, false, true, false];
// Child containers exist only here: extras 1/1/0, enabled 1/1/1. The filter
// must never join or multiply rows, so presence/absence changes nothing.
const WITH_CONTAINERS = new Set([11, 37, 58]);

const EXTRAS_TRUE_IDS = [11, 37, 42];
const EXTRAS_FALSE_IDS = [23, 58, 91];

const INVALID_DETAIL =
  "Invalid request query (extrasAllowed). See docs/PROBLEMS.md#bad-request.";

type Query = Record<string, string>;
type Statement = { sql: string; binds: unknown[]; method: string };
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };

// Observe actual executions (including batch/exec), not merely prepare calls,
// so a count/lookahead hidden behind a different D1 method cannot evade the
// budget. Writes throw: lists must never mutate D1.
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

function forbiddenDb() {
  const fail = () => { throw new Error("Rejected request must not touch D1"); };
  const prepare = vi.fn(fail);
  const batch = vi.fn(fail);
  const exec = vi.fn(fail);
  return { db: { prepare, batch, exec } as unknown as D1Database, prepare, batch, exec };
}

async function call(
  query: Query | string = {},
  options: { token?: string | null; headers?: Record<string, string>; db?: D1Database; path?: string } = {}
) {
  // Raw strings pass through verbatim so repeated-key probes reach the
  // validator exactly as written (a record would collapse duplicates).
  const search = typeof query === "string"
    ? query
    : new URLSearchParams(Object.entries(query)).toString();
  const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
  const headers = new Headers();
  const token = options.token === undefined ? READ_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  const url = new URL(`${options.path ?? PATH}?${search}`, ORIGIN);
  const input = new Request(url, { headers });
  const response = await app.fetch(input, {
    ...TEST_ENV,
    CUSTOMER_DB: options.db ?? recorder.db
  });
  return { response, url, recorder, search };
}

async function page(query: Query | string = {}) {
  const result = await call(query);
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  const bytes = await result.response.clone().text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const counted = !/(?:^|&)includeTotal=false(?:&|$)/.test(result.search);
  expect(result.recorder.statements).toHaveLength(counted ? 2 : 1);
  expect(result.recorder.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(counted ? 1 : 0);
  expect(result.recorder.statements.every((s) => /^\s*SELECT\b/i.test(s.sql))).toBe(true);
  expect(result.recorder.statements.every((s) => s.method === "first" || s.method === "all")).toBe(true);
  expect(result.recorder.batch).not.toHaveBeenCalled();
  expect(result.recorder.exec).not.toHaveBeenCalled();
  if (!counted) expect(body.total).toBeNull();
  return { ...result, body, bytes };
}

const ids = (body: Body) => body.rows.map((row) => row.pickup_address_id);

function expectOneRowPerId(body: Body) {
  const seen = ids(body);
  expect(new Set(seen).size).toBe(seen.length);
}

function nextTarget(response: Response, current: URL, expected: Query): URL {
  const link = response.headers.get("link");
  expect(link, "non-null nextCursor requires Link: <relative-target>; rel=\"next\"").not.toBeNull();
  expect(link).toMatch(/^<\/api\/v1\/address-snapshot\?[^<>\s]*>; rel="next"$/);
  const raw = /^<([^>]+)>; rel="next"$/.exec(link!)![1];
  expect(raw.startsWith("//")).toBe(false);
  const target = new URL(raw, current);
  expect(target.origin).toBe(current.origin);
  expect(target.pathname).toBe(PATH);
  expect(target.hash).toBe("");
  expect(target.username).toBe("");
  expect(target.password).toBe("");
  const actualParams = new URLSearchParams(target.searchParams);
  const expectedParams = { ...expected };
  // Default-true may be omitted or spelled out; only false must round-trip.
  if (expected.includeTotal !== "false") {
    expect([null, "true"]).toContain(actualParams.get("includeTotal"));
    expect(actualParams.getAll("includeTotal").length).toBeLessThanOrEqual(1);
    actualParams.delete("includeTotal");
    delete expectedParams.includeTotal;
  }
  expect([...actualParams.keys()]).toHaveLength(Object.keys(expectedParams).length);
  expect(Object.fromEntries(actualParams)).toEqual(expectedParams);
  expect(target.searchParams.has("offset")).toBe(false);
  return target;
}

async function follow(target: URL) {
  // Follow exactly the server's path/query. Do not reconstruct any cursor/filter.
  expect(target.pathname).toBe(PATH);
  return page(target.search.startsWith("?") ? target.search.slice(1) : target.search);
}

async function seed() {
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  for (const customerId of [11, 23, 37]) {
    await db.prepare(
      "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, 1, 'synthetic')"
    ).bind(customerId, `synthetic-customer-${customerId}`).run();
  }
  for (let i = 0; i < IDS.length; i++) {
    const id = IDS[i];
    const label = NEEDLE_MATCH[i] ? `${NEEDLE}-${id}` : `synthetic-other-${id}`;
    await db.prepare(
      "INSERT INTO address_snapshot (pickup_address_id, customer_id, address, extras_allowed, enabled, synced_at) VALUES (?, ?, ?, ?, ?, 'synthetic')"
    ).bind(id, OWNER[i], label, EXTRAS[i], ENABLED[i]).run();
    if (WITH_CONTAINERS.has(id)) {
      await db.prepare(
        "INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, enabled, synced_at) VALUES (?, ?, ?, ?, 1, 'synthetic')"
      ).bind(id, id, `synthetic-container-${id}`, `synthetic-serial-${id}`).run();
    }
  }
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("Unexpected outbound fetch in extras-allowed acceptance");
  }));
  await seed();
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("address extrasAllowed selector alone", () => {
  it("true returns only stored-extras rows, one row per id, with a counted total", async () => {
    const { body, recorder } = await page({ extrasAllowed: "true" });
    expect(ids(body)).toEqual(EXTRAS_TRUE_IDS);
    expect(body.total).toBe(3);
    expect(body.nextCursor).toBeNull();
    expectOneRowPerId(body);
    for (const row of body.rows) expect(row.extras_allowed).toBe(1);
    expect(recorder.statements).toHaveLength(2);
  });

  it("false returns only stored-no-extras rows, one row per id, with a counted total", async () => {
    const { body } = await page({ extrasAllowed: "false" });
    expect(ids(body)).toEqual(EXTRAS_FALSE_IDS);
    expect(body.total).toBe(3);
    expect(body.nextCursor).toBeNull();
    expectOneRowPerId(body);
    for (const row of body.rows) expect(row.extras_allowed).toBe(0);
  });

  it("any is equivalent to omission: identical body and identical SQL", async () => {
    const omitted = await page({});
    const any = await page({ extrasAllowed: "any" });
    expect(ids(omitted.body)).toEqual(IDS);
    expect(omitted.body.total).toBe(6);
    expect(any.body).toEqual(omitted.body);
    expect(any.recorder.statements).toEqual(omitted.recorder.statements);
  });

  it("true adds a literal extras_allowed = 1 predicate to COUNT and page with no bind", async () => {
    const { recorder } = await page({ extrasAllowed: "true" });
    expect(recorder.statements).toHaveLength(2);
    for (const statement of recorder.statements) {
      expect(statement.sql).toContain("extras_allowed = 1");
      expect(statement.binds).not.toContain("true");
    }
    expect(recorder.statements[0].binds).toEqual([]);
  });

  it("false adds a literal extras_allowed = 0 predicate to COUNT and page with no bind", async () => {
    const { recorder } = await page({ extrasAllowed: "false" });
    expect(recorder.statements).toHaveLength(2);
    for (const statement of recorder.statements) {
      expect(statement.sql).toContain("extras_allowed = 0");
      expect(statement.binds).not.toContain("false");
    }
    expect(recorder.statements[0].binds).toEqual([]);
  });

  it("any and omission add no extras predicate", async () => {
    for (const query of [{}, { extrasAllowed: "any" }] as Query[]) {
      const { recorder } = await page(query);
      for (const statement of recorder.statements) {
        expect(statement.sql).not.toContain("extras_allowed = ");
      }
    }
  });

  it("never joins: the selector filters the address table without multiplying rows", async () => {
    for (const extrasAllowed of ["true", "false", "any"]) {
      const { body, recorder } = await page({ extrasAllowed });
      for (const statement of recorder.statements) {
        expect(statement.sql).not.toMatch(/\bJOIN\b/i);
      }
      expectOneRowPerId(body);
      // Rows with child containers (11, 37) appear exactly once, same as
      // rows without (42 under true; 23, 91 under false).
      const withChildren = ids(body).filter((id) => WITH_CONTAINERS.has(id as number));
      expect(new Set(withChildren).size).toBe(withChildren.length);
    }
  });
});

describe("address extrasAllowed intersections", () => {
  it.each([
    { label: "customerId=11 & true", query: { customerId: "11", extrasAllowed: "true" }, expected: [11], total: 1 },
    { label: "customerId=11 & false", query: { customerId: "11", extrasAllowed: "false" }, expected: [23, 91], total: 2 },
    { label: "customerId=37 & true", query: { customerId: "37", extrasAllowed: "true" }, expected: [42], total: 1 },
    { label: "customerId=37 & false", query: { customerId: "37", extrasAllowed: "false" }, expected: [58], total: 1 },
    { label: "customerId=23 & true", query: { customerId: "23", extrasAllowed: "true" }, expected: [37], total: 1 },
    { label: "customerId=23 & false (empty)", query: { customerId: "23", extrasAllowed: "false" }, expected: [], total: 0 },
    { label: "pickupAddressId=23 & true (empty)", query: { pickupAddressId: "23", extrasAllowed: "true" }, expected: [], total: 0 },
    { label: "pickupAddressId=23 & false", query: { pickupAddressId: "23", extrasAllowed: "false" }, expected: [23], total: 1 },
    { label: "q=needle & true (empty)", query: { q: NEEDLE, extrasAllowed: "true" }, expected: [], total: 0 },
    { label: "q=needle & false", query: { q: NEEDLE, extrasAllowed: "false" }, expected: [23, 58], total: 2 },
    { label: "enabled=true & extras=true", query: { enabled: "true", extrasAllowed: "true" }, expected: [11, 37], total: 2 },
    { label: "enabled=true & extras=false", query: { enabled: "true", extrasAllowed: "false" }, expected: [23, 58], total: 2 },
    { label: "enabled=false & extras=true", query: { enabled: "false", extrasAllowed: "true" }, expected: [42], total: 1 },
    { label: "enabled=false & extras=false", query: { enabled: "false", extrasAllowed: "false" }, expected: [91], total: 1 },
    {
      label: "customerId & q & enabled & extras=false",
      query: { customerId: "11", q: NEEDLE, enabled: "true", extrasAllowed: "false" },
      expected: [23],
      total: 1
    },
    {
      label: "customerId & q & extras=true (empty)",
      query: { customerId: "11", q: NEEDLE, extrasAllowed: "true" },
      expected: [],
      total: 0
    }
  ] as Array<{ label: string; query: Query; expected: number[]; total: number }>)(
    "$label",
    async ({ query, expected, total }) => {
    const { body } = await page(query);
    expect(ids(body)).toEqual(expected);
    expect(body.total).toBe(total);
    expect(body.nextCursor).toBeNull();
    expectOneRowPerId(body);
  });

  it("counts and selects over the identical WHERE clause including the extras predicate", async () => {
    const { recorder } = await page({
      customerId: "11", pickupAddressId: "23", q: NEEDLE, enabled: "true", extrasAllowed: "false"
    });
    expect(recorder.statements).toHaveLength(2);
    const whereOf = (sql: string) => sql.slice(sql.indexOf("WHERE")).split(" ORDER BY ")[0];
    const [count, select] = recorder.statements;
    expect(whereOf(select.sql)).toContain(whereOf(count.sql));
    expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
    expect(count.sql).toContain("extras_allowed = 0");
    expect(select.sql).toContain("extras_allowed = 0");
  });

  it("keeps filter binds before pagination binds under the extras predicate", async () => {
    const { recorder } = await page({
      customerId: "11", extrasAllowed: "false", limit: "5", offset: "1"
    });
    expect(recorder.statements[0].binds).toEqual([11]);
    expect(recorder.statements[1].binds).toEqual([11, 5, 1]);
  });
});

describe("address extrasAllowed offset and seek pagination", () => {
  it("pages true rows by offset through a partial and an empty page", async () => {
    const first = await page({ extrasAllowed: "true", limit: "2" });
    expect(ids(first.body)).toEqual([11, 37]);
    expect(first.body.total).toBe(3);
    expect(first.body.nextCursor).toBe(37);
    const partial = await page({ extrasAllowed: "true", limit: "2", offset: "2" });
    expect(ids(partial.body)).toEqual([42]);
    expect(partial.body.total).toBe(3);
    expect(partial.body.nextCursor).toBeNull();
    expect(partial.response.headers.get("link")).toBeNull();
    const empty = await page({ extrasAllowed: "true", limit: "2", offset: "4" });
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.total).toBe(3);
    expect(empty.body.nextCursor).toBeNull();
    expect(empty.response.headers.get("link")).toBeNull();
  });

  it("pages false rows by offset", async () => {
    const { body } = await page({ extrasAllowed: "false", limit: "2", offset: "1" });
    expect(ids(body)).toEqual([58, 91]);
    expect(body.total).toBe(3);
    expect(body.nextCursor).toBe(91);
  });

  it("seeks true rows by cursor with cursor-relative totals", async () => {
    const { body, recorder } = await page({ extrasAllowed: "true", limit: "2", cursor: "11" });
    expect(ids(body)).toEqual([37, 42]);
    expect(body.total).toBe(2);
    expect(body.nextCursor).toBe(42);
    for (const statement of recorder.statements) {
      expect(statement.sql).toContain("pickup_address_id > ?");
      expect(statement.sql).toContain("extras_allowed = 1");
    }
    const empty = await page({ extrasAllowed: "true", limit: "2", cursor: "42" });
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.total).toBe(0);
    expect(empty.body.nextCursor).toBeNull();
  });

  it("cursor wins over offset under the extras filter", async () => {
    const { body } = await page({ extrasAllowed: "false", limit: "2", cursor: "23", offset: "999" });
    expect(ids(body)).toEqual([58, 91]);
    expect(body.total).toBe(2);
    expect(body.nextCursor).toBe(91);
  });

  it("orders filtered rows by primary key descending with strict-below seek", async () => {
    const first = await page({ extrasAllowed: "true", order: "desc" });
    expect(ids(first.body)).toEqual([42, 37, 11]);
    expect(first.body.total).toBe(3);
    expect(first.body.nextCursor).toBeNull();
    const seek = await page({ extrasAllowed: "true", order: "desc", limit: "2", cursor: "42" });
    expect(ids(seek.body)).toEqual([37, 11]);
    expect(seek.body.total).toBe(2);
    expect(seek.body.nextCursor).toBe(11);
    for (const statement of seek.recorder.statements) {
      expect(statement.sql).toContain("pickup_address_id < ?");
    }
    const empty = await page({ extrasAllowed: "false", order: "desc", limit: "2", cursor: "23" });
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.total).toBe(0);
    expect(empty.body.nextCursor).toBeNull();
  });

  it("explicit asc matches omitted order under the extras filter", async () => {
    const omitted = await page({ extrasAllowed: "false", limit: "2" });
    const explicit = await page({ extrasAllowed: "false", order: "asc", limit: "2" });
    expect(explicit.body).toEqual(omitted.body);
    expect(ids(explicit.body)).toEqual([23, 58]);
  });

  it("count-free mode keeps rows and cursor with total null and one SELECT", async () => {
    const counted = await page({ extrasAllowed: "true", limit: "2" });
    const free = await page({ extrasAllowed: "true", limit: "2", includeTotal: "false" });
    expect(free.body.rows).toEqual(counted.body.rows);
    expect(free.body.nextCursor).toBe(counted.body.nextCursor);
    expect(ids(free.body)).toEqual([11, 37]);
    expect(free.body.total).toBeNull();
    expect(free.recorder.statements).toHaveLength(1);
    expect(free.recorder.statements[0].sql).toContain("extras_allowed = 1");
    expect(counted.body.total).toBe(3);
  });

  it("count-free mode composes with intersections", async () => {
    const { body, recorder } = await page({
      customerId: "11", extrasAllowed: "false", includeTotal: "false"
    });
    expect(ids(body)).toEqual([23, 91]);
    expect(body.total).toBeNull();
    expect(body.nextCursor).toBeNull();
    expect(recorder.statements).toHaveLength(1);
  });
});

describe("address extrasAllowed continuation links", () => {
  it("traverses every true row once ascending through a final empty page", async () => {
    const filters = { extrasAllowed: "true", limit: "1" };
    let current = await page(filters);
    const seen: unknown[] = [];
    const expectedPages = [[11], [37], [42], []];
    const expectedTotals = [3, 2, 1, 0];
    for (let index = 0; index < expectedPages.length; index++) {
      expect(ids(current.body)).toEqual(expectedPages[index]);
      expect(current.body.total).toBe(expectedTotals[index]);
      seen.push(...ids(current.body));
      if (index === expectedPages.length - 1) {
        expect(current.body.nextCursor).toBeNull();
        expect(current.response.headers.get("link")).toBeNull();
      } else {
        const cursor = String(expectedPages[index][0]);
        expect(current.body.nextCursor).toBe(Number(cursor));
        // The full terminal page ([42]) still links onward: no lookahead.
        current = await follow(nextTarget(current.response, current.url, { ...filters, cursor }));
      }
    }
    expect(seen).toEqual([11, 37, 42]);
    expect(new Set(seen).size).toBe(3);
  });

  it("traverses every false row once descending through a final empty page", async () => {
    const filters = { extrasAllowed: "false", order: "desc", limit: "1" };
    let current = await page(filters);
    const seen: unknown[] = [];
    const expectedPages = [[91], [58], [23], []];
    const expectedTotals = [3, 2, 1, 0];
    for (let index = 0; index < expectedPages.length; index++) {
      expect(ids(current.body)).toEqual(expectedPages[index]);
      expect(current.body.total).toBe(expectedTotals[index]);
      seen.push(...ids(current.body));
      if (index === expectedPages.length - 1) {
        expect(current.body.nextCursor).toBeNull();
        expect(current.response.headers.get("link")).toBeNull();
      } else {
        const cursor = String(expectedPages[index][0]);
        expect(current.body.nextCursor).toBe(Number(cursor));
        current = await follow(nextTarget(current.response, current.url, { ...filters, cursor }));
      }
    }
    expect(seen).toEqual([91, 58, 23]);
    expect(new Set(seen).size).toBe(3);
  });

  it("keeps extrasAllowed=false in the link instead of dropping a false-like filter", async () => {
    const filters = { extrasAllowed: "false", limit: "1", includeTotal: "false" };
    const first = await page(filters);
    expect(ids(first.body)).toEqual([23]);
    expect(first.body.nextCursor).toBe(23);
    const second = await follow(
      nextTarget(first.response, first.url, { ...filters, cursor: "23" })
    );
    expect(ids(second.body)).toEqual([58]);
    expect(second.body.total).toBeNull();
    expect(second.body.nextCursor).toBe(58);
    const third = await follow(
      nextTarget(second.response, second.url, { ...filters, cursor: "58" })
    );
    expect(ids(third.body)).toEqual([91]);
    expect(third.body.total).toBeNull();
    expect(third.body.nextCursor).toBe(91);
    const empty = await follow(
      nextTarget(third.response, third.url, { ...filters, cursor: "91" })
    );
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.total).toBeNull();
    expect(empty.body.nextCursor).toBeNull();
    expect(empty.response.headers.get("link")).toBeNull();
  });

  it("omits extrasAllowed=any from the link canonically, like enabled=any", async () => {
    const first = await page({ extrasAllowed: "any", limit: "2" });
    expect(ids(first.body)).toEqual([11, 23]);
    expect(first.body.nextCursor).toBe(23);
    const target = nextTarget(first.response, first.url, { limit: "2", cursor: "23" });
    expect(target.searchParams.has("extrasAllowed")).toBe(false);
    const second = await follow(target);
    expect(ids(second.body)).toEqual([37, 42]);
  });

  it("carries no extrasAllowed key in the link when the selector was omitted", async () => {
    const first = await page({ limit: "2" });
    expect(first.body.nextCursor).toBe(23);
    const target = nextTarget(first.response, first.url, { limit: "2", cursor: "23" });
    expect(target.searchParams.has("extrasAllowed")).toBe(false);
  });

  it("converts an offset start to a cursor link preserving the extras selector", async () => {
    const first = await page({ extrasAllowed: "true", limit: "1", offset: "1" });
    expect(ids(first.body)).toEqual([37]);
    expect(first.body.nextCursor).toBe(37);
    const second = await follow(
      nextTarget(first.response, first.url, { extrasAllowed: "true", limit: "1", cursor: "37" })
    );
    expect(ids(second.body)).toEqual([42]);
    expect(second.body.total).toBe(1);
  });
});

describe("address extrasAllowed sparse fieldsets and conditional responses", () => {
  it("trims filtered rows to the selected columns with the id always present", async () => {
    const { body } = await page({ extrasAllowed: "true", fields: "address" });
    expect(ids(body)).toEqual(EXTRAS_TRUE_IDS);
    expect(body.total).toBe(3);
    expect(body.rows).toEqual([
      { pickup_address_id: 11, address: "synthetic-other-11" },
      { pickup_address_id: 37, address: "synthetic-other-37" },
      { pickup_address_id: 42, address: "synthetic-other-42" }
    ]);
  });

  it("selects the stored extras_allowed column explicitly under the filter", async () => {
    const { body } = await page({ extrasAllowed: "false", fields: "extras_allowed", limit: "2" });
    expect(body.rows).toEqual([
      { pickup_address_id: 23, extras_allowed: 0 },
      { pickup_address_id: 58, extras_allowed: 0 }
    ]);
    expect(body.total).toBe(3);
    expect(body.nextCursor).toBe(58);
  });

  it("still rejects an invalid fields selector before D1 when extrasAllowed is present", async () => {
    const { response, recorder } = await call({ extrasAllowed: "true", fields: "nope" });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(recorder.statements).toEqual([]);
  });

  it("answers a matching If-None-Match with an empty 304 over filtered rows", async () => {
    const first = await page({ extrasAllowed: "true" });
    expect(ids(first.body)).toEqual(EXTRAS_TRUE_IDS);
    const tag = first.response.headers.get("etag");
    expect(tag).toMatch(/^".+"$/);
    const { response, recorder } = await call(
      { extrasAllowed: "true" },
      { headers: { "if-none-match": tag! } }
    );
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(tag);
    expect(await response.text()).toBe("");
    // Conditional validation saves bytes only: authentication, query
    // validation and D1 reads still run; Cache-Control remains no-store.
    expect(recorder.statements).toHaveLength(2);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("preserves the extras-carrying next-page Link on the 304", async () => {
    const first = await page({ extrasAllowed: "true", limit: "2" });
    expect(first.body.nextCursor).toBe(37);
    const link = first.response.headers.get("link");
    expect(link).toContain("extrasAllowed=true");
    const tag = first.response.headers.get("etag")!;
    const { response } = await call(
      { extrasAllowed: "true", limit: "2" },
      { headers: { "if-none-match": tag } }
    );
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(tag);
    expect(response.headers.get("link")).toBe(link);
  });

  it("matches a weak If-None-Match validator over filtered rows", async () => {
    const first = await page({ extrasAllowed: "false", limit: "2" });
    expect(ids(first.body)).toEqual([23, 58]);
    const tag = first.response.headers.get("etag")!;
    const { response } = await call(
      { extrasAllowed: "false", limit: "2" },
      { headers: { "if-none-match": `W/${tag}` } }
    );
    expect(response.status).toBe(304);
    expect(response.headers.get("etag")).toBe(tag);
    expect(await response.text()).toBe("");
  });
});

describe("address extrasAllowed strict enum validation", () => {
  it.each([
    "extrasAllowed=yes",
    "extrasAllowed=1",
    "extrasAllowed=0",
    "extrasAllowed=TRUE",
    "extrasAllowed=True",
    "extrasAllowed=%20true",
    "extrasAllowed=true%20",
    "extrasAllowed=",
    "extrasAllowed=%20",
    "extrasAllowed=ANY",
    "extrasAllowed=any%20",
    "extrasAllowed=null",
    "extrasAllowed=2",
    "extrasAllowed=true%2Cfalse",
    "extrasAllowed=true%00",
    "extrasAllowed=secret-extras-marker"
  ])("rejects %s with a value-free 400 before D1", async (query) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
    const { response, recorder } = await call(query);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("link")).toBeNull();
    expect(await response.json()).toEqual({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail: INVALID_DETAIL
    });
    expect(JSON.stringify(await response.clone().json())).not.toContain("secret-extras-marker");
    expect(recorder.statements).toEqual([]);
    expect(recorder.batch).not.toHaveBeenCalled();
    expect(recorder.exec).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each([
    "extrasAllowed=true&extrasAllowed=false",
    "extrasAllowed=true&extrasAllowed=true",
    "extrasAllowed=&extrasAllowed=true",
    "extrasAllowed=any&extrasAllowed=any"
  ])("rejects repeated keys %s with a value-free 400 before D1", async (query) => {
    const { response, recorder } = await call(query);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toEqual({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail: INVALID_DETAIL
    });
    expect(recorder.statements).toEqual([]);
  });

  it("accepts exactly true, false and any with case-sensitive spelling", async () => {
    for (const extrasAllowed of ["true", "false", "any"]) {
      const { response } = await call({ extrasAllowed });
      expect(response.status).toBe(200);
    }
    const filtered = await page({ extrasAllowed: "true" });
    expect(ids(filtered.body)).toEqual(EXTRAS_TRUE_IDS);
  });

  it.each([
    "extrasAllowed=true",
    "extrasAllowed=secret-extras-marker",
    "extrasAllowed=true&extrasAllowed=false"
  ])("auth precedes validation and D1: %s", async (query) => {
    for (const token of [null, "synthetic-invalid-token"]) {
      const forbidden = forbiddenDb();
      const { response } = await call(query, { token, db: forbidden.db });
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(await response.text()).not.toContain("secret-extras-marker");
      expect(forbidden.prepare).not.toHaveBeenCalled();
      expect(forbidden.batch).not.toHaveBeenCalled();
      expect(forbidden.exec).not.toHaveBeenCalled();
    }
  });

  it("lets every bearer role read with the selector", async () => {
    for (const token of [READ_TOKEN, API_TOKEN, SYNC_SECRET]) {
      const { response } = await call({ extrasAllowed: "true" }, { token });
      expect(response.status).toBe(200);
      expect(ids((await response.json()) as Body)).toEqual(EXTRAS_TRUE_IDS);
    }
  });

  it("keeps request-ID correlation, CORS and no Link on a rejected selector", async () => {
    const response = await exports.default.fetch(`${ORIGIN}${PATH}?extrasAllowed=secret-extras-marker`, {
      headers: {
        authorization: `Bearer ${READ_TOKEN}`,
        origin: "https://app.example.com",
        "x-request-id": "synthetic-extras-error"
      }
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("synthetic-extras-error");
    expect(response.headers.get("access-control-allow-origin")).toBeTruthy();
    expect(response.headers.get("link")).toBeNull();
    expect(await response.json()).toEqual({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail: INVALID_DETAIL
    });
  });
});

describe("address extrasAllowed mounted OpenAPI contract", () => {
  type Operation = {
    operationId?: string;
    "x-access"?: string;
    "x-effect"?: string;
    description?: string;
    parameters?: Array<{
      in?: string;
      name?: string;
      required?: boolean;
      description?: string;
      schema?: Record<string, unknown>;
    }>;
    responses?: Record<string, { description?: string }>;
  };
  async function fetchAddressOperations() {
    const response = await exports.default.fetch(`${ORIGIN}/openapi.json`);
    expect(response.status).toBe(200);
    const doc = await response.json() as { paths: Record<string, Record<string, Operation>> };
    return doc.paths;
  }

  it("publishes extrasAllowed as an optional true|false|any enum on the address list", async () => {
    const paths = await fetchAddressOperations();
    const operation = paths[PATH]?.get;
    expect(operation).toBeDefined();
    const param = (operation!.parameters ?? [])
      .find((p) => p.in === "query" && p.name === "extrasAllowed");
    expect(param, "mounted OpenAPI must advertise the extrasAllowed selector").toBeDefined();
    expect(param!.required).toBe(false);
    expect(param!.schema).toMatchObject({
      type: "string",
      enum: ["true", "false", "any"],
      default: "any"
    });
    // The flag is stored snapshot state, not proof of current upstream policy.
    // Assert the stored-state wording without pinning the builder's prose.
    expect(`${param!.description ?? ""} ${param!.schema?.["description"] ?? ""}`).toMatch(/stored/i);
  });

  it("keeps the list operation identity, access class and effect class", async () => {
    const paths = await fetchAddressOperations();
    const operation = paths[PATH]?.get;
    expect(operation?.operationId).toBe("listAddressSnapshot");
    expect(operation?.["x-access"]).toBe("read");
    expect(operation?.["x-effect"]).toBe("local-read");
  });

  it("names extrasAllowed in the list 400 correction guidance", async () => {
    const paths = await fetchAddressOperations();
    const description = paths[PATH]?.get?.responses?.["400"]?.description ?? "";
    expect(description).toContain("extrasAllowed");
  });

  it("keeps the selector address-only: customer and container lists do not publish it", async () => {
    const paths = await fetchAddressOperations();
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/container-snapshot"]) {
      const names = (paths[path]?.get?.parameters ?? [])
        .filter((p) => p.in === "query")
        .map((p) => p.name);
      expect(names).not.toContain("extrasAllowed");
    }
  });

  it("keeps the unknown-name ignore policy on the address list", async () => {
    const bare = await page({});
    const bogus = await page("bogus_param=1");
    expect(bogus.body).toEqual(bare.body);
    expect(bogus.recorder.statements).toEqual(bare.recorder.statements);
  });

  it("still ignores unknown names alongside the extras selector", async () => {
    const filtered = await page({ extrasAllowed: "true" });
    const bogus = await page("extrasAllowed=true&bogus_param=1");
    expect(bogus.body).toEqual(filtered.body);
    expect(bogus.recorder.statements).toEqual(filtered.recorder.statements);
  });
});

describe("address extrasAllowed preserves compatible merged behavior", () => {
  it("keeps the bare list: all rows ascending with a counted total", async () => {
    const { body } = await page({});
    expect(ids(body)).toEqual(IDS);
    expect(body.total).toBe(6);
    expect(body.nextCursor).toBeNull();
  });

  it.each([
    { enabled: "true", expected: [11, 23, 37, 58], total: 4 },
    { enabled: "false", expected: [42, 91], total: 2 },
    { enabled: "any", expected: IDS, total: 6 }
  ])("keeps enabled=$enabled membership and totals", async ({ enabled, expected, total }) => {
    const { body } = await page({ enabled });
    expect(ids(body)).toEqual(expected);
    expect(body.total).toBe(total);
  });

  it("keeps the street-text substring filter and whitespace-only ignore", async () => {
    const needle = await page({ q: NEEDLE });
    expect(ids(needle.body)).toEqual([23, 58]);
    expect(needle.body.total).toBe(2);
    const blank = await page({ q: "   " });
    expect(ids(blank.body)).toEqual(IDS);
    expect(blank.recorder.statements[0].sql).not.toContain("instr(");
  });

  it("keeps customer and pickup-address identity filters", async () => {
    const byCustomer = await page({ customerId: "11" });
    expect(ids(byCustomer.body)).toEqual([11, 23, 91]);
    expect(byCustomer.body.total).toBe(3);
    const byId = await page({ pickupAddressId: "42" });
    expect(ids(byId.body)).toEqual([42]);
    expect(byId.body.total).toBe(1);
  });

  it("keeps descending primary-key order without the selector", async () => {
    const { body } = await page({ order: "desc" });
    expect(ids(body)).toEqual([91, 58, 42, 37, 23, 11]);
    expect(body.total).toBe(6);
  });

  it("keeps count-free mode without the selector", async () => {
    const counted = await page({});
    const free = await page({ includeTotal: "false" });
    expect(free.body.rows).toEqual(counted.body.rows);
    expect(free.body.total).toBeNull();
    expect(free.recorder.statements).toHaveLength(1);
  });

  it("keeps the by-id read returning the stored extras column", async () => {
    const { response } = await call({}, { path: `${PATH}/42` });
    expect(response.status).toBe(200);
    const row = await response.json() as Record<string, unknown>;
    expect(row.pickup_address_id).toBe(42);
    expect(row.extras_allowed).toBe(1);
  });

  it("keeps the sibling lists serving their own rows", async () => {
    const customers = await call({}, { path: "/api/v1/customer-snapshot" });
    expect(customers.response.status).toBe(200);
    const customerBody = await customers.response.json() as Body;
    expect(customerBody.rows.map((row) => row.customer_id)).toEqual([11, 23, 37]);
    expect(customerBody.total).toBe(3);
    const containers = await call({}, { path: "/api/v1/container-snapshot" });
    expect(containers.response.status).toBe(200);
    const containerBody = await containers.response.json() as Body;
    expect(containerBody.rows.map((row) => row.container_id)).toEqual([11, 37, 58]);
    expect(containerBody.total).toBe(3);
  });

  it("ignores extrasAllowed as an unknown name on the sibling lists", async () => {
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/container-snapshot"]) {
      const bare = await call({}, { path });
      const bareBody = await bare.response.json() as Body;
      const withSelector = await call({ extrasAllowed: "true" }, { path });
      expect(withSelector.response.status).toBe(200);
      expect(await withSelector.response.json()).toEqual(bareBody);
      expect(withSelector.recorder.statements).toEqual(bare.recorder.statements);
    }
  });

  it("keeps request-ID echo, no-store and CORS exposure on the deployed Worker boundary", async () => {
    const response = await exports.default.fetch(
      `${ORIGIN}${PATH}?extrasAllowed=true&limit=2&includeTotal=false`,
      {
        headers: {
          authorization: `Bearer ${READ_TOKEN}`,
          origin: "https://app.example.com",
          "x-request-id": "synthetic-extras-trace"
        }
      }
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("synthetic-extras-trace");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeTruthy();
    expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("link");
    const body = await response.json() as Body;
    expect(ids(body)).toEqual([11, 37]);
    expect(body.total).toBeNull();
    expect(body.nextCursor).toBe(37);
  });
});

describe("address extras reference SQL proofs and stored schema (route-independent)", () => {
  // These pin the stored column and prove the WHERE shape the route must emit
  // selects correctly — independent of the route handler under test. Local
  // query shape only; no production-latency claim is made anywhere here.
  const SELECT_IDS = "SELECT pickup_address_id FROM address_snapshot";

  it("stores extras_allowed as NOT NULL DEFAULT 1 with no migration needed", async () => {
    const row = await TEST_ENV.CUSTOMER_DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'address_snapshot'"
    ).first<{ sql: string }>();
    expect(row?.sql).toContain("extras_allowed INTEGER NOT NULL DEFAULT 1");
  });

  it("selects the hand-derived id sets with the literal extras predicates", async () => {
    const run = async (predicate: string) =>
      (await TEST_ENV.CUSTOMER_DB.prepare(
        `${SELECT_IDS} WHERE ${predicate} ORDER BY pickup_address_id`
      ).all<{ pickup_address_id: number }>()).results?.map((r) => r.pickup_address_id);
    expect(await run("extras_allowed = 1")).toEqual(EXTRAS_TRUE_IDS);
    expect(await run("extras_allowed = 0")).toEqual(EXTRAS_FALSE_IDS);
    expect(await run("1 = 1")).toEqual(IDS);
  });

  it("counts the composed customer/q/enabled/extras shape the route must emit", async () => {
    const count = await TEST_ENV.CUSTOMER_DB.prepare(
      "SELECT COUNT(*) as n FROM address_snapshot WHERE 1 = 1 AND customer_id = ? " +
      "AND instr(lower(coalesce(address, '')), lower(?)) > 0 AND enabled = 1 AND extras_allowed = 0"
    ).bind(11, NEEDLE).first<{ n: number }>();
    expect(count?.n).toBe(1);
    const empty = await TEST_ENV.CUSTOMER_DB.prepare(
      "SELECT COUNT(*) as n FROM address_snapshot WHERE 1 = 1 AND customer_id = ? AND extras_allowed = 1 " +
      "AND instr(lower(coalesce(address, '')), lower(?)) > 0"
    ).bind(11, NEEDLE).first<{ n: number }>();
    expect(empty?.n).toBe(0);
  });

  it("resolves the extras shapes against the address table locally (shape only)", async () => {
    for (const where of [
      "extras_allowed = 1",
      "extras_allowed = 0 AND enabled = 1",
      "1 = 1 AND customer_id = ? AND extras_allowed = 1"
    ]) {
      const plan = await TEST_ENV.CUSTOMER_DB.prepare(
        `EXPLAIN QUERY PLAN ${SELECT_IDS} WHERE ${where} ORDER BY pickup_address_id LIMIT ? OFFSET ?`
      ).bind(...(where.includes("customer_id") ? [11, 50, 0] : [50, 0]))
        .all<{ detail: string }>();
      const details = (plan.results ?? []).map((r) => r.detail).join(" ");
      expect(details).toContain("address_snapshot");
    }
  });
});
