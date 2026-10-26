/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned oracle: select stored on-call and GPS-lock states on the
 * EXISTING container list (`GET /api/v1/container-snapshot`).
 *
 * Contract under test (paired build implements it; this file never does):
 * optional `onCall=true|false|any` and `gpsLocked=true|false|any`, each
 * defaulting to `any`. Exact case-sensitive enum strings only; malformed,
 * blank and repeated keys reject via the existing value-free 400 before D1.
 * `true` maps to stored `=1`, `false` to `=0`, `any`/omission adds no
 * predicate. The two predicates AND independently with customer/address/
 * container IDs, `q`, `enabled` and cursor scope on both fromJoin paths, with
 * no extra D1 calls, indexes, migration, new endpoint or upstream request.
 * Non-`any` validated selectors round-trip in continuation links; `any` is
 * omitted canonically like `enabled=any`. The flags are stored snapshot
 * values, not permission to mutate equipment or proof of fresh GPS.
 *
 * Fixture matrix (synthetic ids/labels only — no PII). Eight containers at
 * eight pickup addresses owned by four distinct customers, covering all four
 * 0/1 flag combinations crossed with enabled/disabled:
 *
 *   id  oncall  gps  enabled  address  customer
 *    1       1    1        1      101        11
 *    2       1    1        0      102        11   location ~ needle
 *    3       1    0        1      103        22
 *    4       1    0        0      104        22   serial ~ needle
 *    5       0    1        1      105        33   location ~ needle
 *    6       0    1        0      106        33
 *    7       0    0        1      107        44
 *    8       0    0        0      108        44
 *
 * So `q=needle` matches {2,4,5} (location OR serial leg), `customerId=11`
 * reaches {1,2}, `customerId=22` reaches {3,4}, `customerId=33` reaches
 * {5,6}, and `customerId=44` reaches {7,8}.
 *
 * Expected RED before the paired build (do not skip or weaken): every
 * `describe` marked RED below fails on the missing selectors today because
 * unknown query keys are ignored (200 with unfiltered rows) and the served
 * OpenAPI / query-policy inventory do not name the keys yet. GREEN describes
 * are preservation guards that pass both before and after (auth-before-D1,
 * any/omission equivalence, existing selectors, statement budgets, local
 * query-plan shape). A RED test that passes before the build is a broken
 * oracle — fix the test, not the verdict.
 *
 * Hermetic: real local D1 executes every recorded statement; the list path
 * may only prepare SELECTs (batch/exec/run throw); unexpected network fails.
 */

const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/container-snapshot";
const API_TOKEN = "test-api-token";
const READ_TOKEN = "test-read-token";
const ORIGIN = "http://test.local";
const BAD_REQUEST = problemType("bad-request");

type Statement = { sql: string; binds: unknown[]; method: string };
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };

const FIXTURES = [
  { id: 1, oncall: 1, gps: 1, enabled: 1, address: 101, customer: 11, location: "synthetic-other-1", serial: "serial-other-1" },
  { id: 2, oncall: 1, gps: 1, enabled: 0, address: 102, customer: 11, location: "synthetic-needle-2", serial: "serial-other-2" },
  { id: 3, oncall: 1, gps: 0, enabled: 1, address: 103, customer: 22, location: "synthetic-other-3", serial: "serial-other-3" },
  { id: 4, oncall: 1, gps: 0, enabled: 0, address: 104, customer: 22, location: "synthetic-other-4", serial: "serial-needle-4" },
  { id: 5, oncall: 0, gps: 1, enabled: 1, address: 105, customer: 33, location: "synthetic-needle-5", serial: "serial-other-5" },
  { id: 6, oncall: 0, gps: 1, enabled: 0, address: 106, customer: 33, location: "synthetic-other-6", serial: "serial-other-6" },
  { id: 7, oncall: 0, gps: 0, enabled: 1, address: 107, customer: 44, location: "synthetic-other-7", serial: "serial-other-7" },
  { id: 8, oncall: 0, gps: 0, enabled: 0, address: 108, customer: 44, location: "synthetic-other-8", serial: "serial-other-8" }
] as const;

/** Pass-through recorder over the real test D1; the list path must only SELECT. */
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

async function request(
  search: string,
  options: { token?: string | null; headers?: Record<string, string>; db?: D1Database } = {}
) {
  const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
  const headers = new Headers();
  const token = options.token === undefined ? API_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  const url = new URL(`${PATH}${search}`, ORIGIN);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV,
    CUSTOMER_DB: options.db ?? recorder.db
  });
  return { response, url, recorder };
}

const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
const ids = (body: Body) => body.rows.map((r) => r.container_id);

async function page(search: string, options?: { token?: string | null; headers?: Record<string, string> }) {
  const result = await request(search, options);
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  const body = (await result.response.clone().json()) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const counted = result.url.searchParams.get("includeTotal") !== "false";
  expect(result.recorder.statements).toHaveLength(counted ? 2 : 1);
  expect(result.recorder.statements.filter(isCount)).toHaveLength(counted ? 1 : 0);
  expect(result.recorder.statements.every((s) => /^\s*SELECT\b/i.test(s.sql))).toBe(true);
  expect(result.recorder.statements.every((s) => s.method === "first" || s.method === "all")).toBe(true);
  expect(result.recorder.batch).not.toHaveBeenCalled();
  expect(result.recorder.exec).not.toHaveBeenCalled();
  if (!counted) expect(body.total).toBeNull();
  return { ...result, body };
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
  expect(target.hash).toBe("");
  const actual = new URLSearchParams(target.searchParams);
  const wanted = { ...expected };
  if (wanted.includeTotal !== "false") {
    expect([null, "true"]).toContain(actual.get("includeTotal"));
    expect(actual.getAll("includeTotal").length).toBeLessThanOrEqual(1);
    actual.delete("includeTotal");
    delete wanted.includeTotal;
  }
  expect([...actual.keys()]).toHaveLength(Object.keys(wanted).length);
  expect(Object.fromEntries(actual)).toEqual(wanted);
  expect(target.searchParams.has("offset")).toBe(false);
  return target;
}

async function follow(target: URL) {
  // Follow exactly the server's path/query. Do not reconstruct any cursor/filter.
  const headers = new Headers();
  headers.set("authorization", `Bearer ${API_TOKEN}`);
  const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
  const response = await app.fetch(new Request(target, { headers }), {
    ...TEST_ENV,
    CUSTOMER_DB: recorder.db
  });
  expect(response.status).toBe(200);
  const body = (await response.clone().json()) as Body;
  return { response, url: target, recorder, body };
}

beforeAll(async () => {
  await ensureD1TestTables();
});

beforeEach(async () => {
  globalThis.fetch = vi.fn(async () => {
    throw new Error("Unexpected outbound fetch in on-call/GPS-lock acceptance");
  }) as typeof fetch;
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  for (const customer of [11, 22, 33, 44]) {
    await db.prepare(
      "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, ?, 'synthetic')"
    ).bind(customer, `synthetic-customer-${customer}`, 1).run();
  }
  for (const f of FIXTURES) {
    await db.batch([
      db.prepare(
        "INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, ?, ?, 'synthetic')"
      ).bind(f.address, f.customer, `synthetic-address-${f.address}`, 1),
      db.prepare(
        "INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, oncall, gps_locked, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'synthetic')"
      ).bind(f.id, f.address, f.location, f.serial, f.oncall, f.gps, f.enabled)
    ]);
  }
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RED: each selector alone, both together, and intersections", () => {
  it.each([
    ["onCall=true", "?onCall=true", [1, 2, 3, 4]],
    ["onCall=false", "?onCall=false", [5, 6, 7, 8]],
    ["gpsLocked=true", "?gpsLocked=true", [1, 2, 5, 6]],
    ["gpsLocked=false", "?gpsLocked=false", [3, 4, 7, 8]]
  ])("%s selects its stored rows with a counted total", async (_label, search, expected) => {
    const { body } = await page(search);
    expect(ids(body)).toEqual(expected);
    expect(body.total).toBe(expected.length);
    expect(new Set(ids(body)).size).toBe(expected.length);
  });

  it.each([
    ["both true", "?onCall=true&gpsLocked=true", [1, 2]],
    ["on-call only", "?onCall=true&gpsLocked=false", [3, 4]],
    ["gps-lock only", "?onCall=false&gpsLocked=true", [5, 6]],
    ["both false", "?onCall=false&gpsLocked=false", [7, 8]]
  ])("%s ANDs the two predicates", async (_label, search, expected) => {
    const { body } = await page(search);
    expect(ids(body)).toEqual(expected);
    expect(body.total).toBe(expected.length);
  });

  it.each([
    ["q narrows on-call rows", "?q=needle&onCall=true", [2, 4]],
    ["q narrows non-on-call rows", "?q=needle&onCall=false", [5]],
    ["q narrows gps-locked rows", "?q=needle&gpsLocked=true", [2, 5]],
    ["q narrows non-gps rows via the serial OR leg", "?q=needle&gpsLocked=false", [4]],
    ["enabled ANDs with on-call", "?enabled=true&onCall=true", [1, 3]],
    ["disabled ANDs with non-gps", "?enabled=false&gpsLocked=false", [4, 8]],
    ["containerId hit with gps-locked", "?containerId=5&gpsLocked=true", [5]],
    ["containerId miss against on-call", "?containerId=5&onCall=true", []],
    ["pickupAddressId hit with on-call", "?pickupAddressId=103&onCall=true", [3]],
    ["pickupAddressId miss against gps-locked", "?pickupAddressId=103&gpsLocked=true", []],
    ["customerId join hit with on-call", "?customerId=22&onCall=true", [3, 4]],
    ["customerId join miss against gps-locked", "?customerId=22&gpsLocked=true", []],
    ["customerId join miss against on-call", "?customerId=11&onCall=false", []],
    ["customerId join with both flags", "?customerId=44&onCall=false&gpsLocked=false", [7, 8]]
  ])("%s", async (_label, search, expected) => {
    const { body, recorder } = await page(search);
    expect(ids(body)).toEqual(expected);
    expect(body.total).toBe(expected.length);
    if (search.includes("customerId=")) {
      expect(recorder.statements[0].sql).toMatch(/INNER JOIN address_snapshot/i);
    }
  });

  it("keeps one row per id with counted totals on a full filtered traversal", async () => {
    const seen: unknown[] = [];
    const totals: Array<number | null> = [];
    let cursor: number | null = null;
    for (let hop = 0; hop < 10; hop++) {
      const search = cursor === null ? "?onCall=true&limit=3" : `?onCall=true&limit=3&cursor=${cursor}`;
      const { body } = await page(search);
      totals.push(body.total);
      seen.push(...ids(body));
      if (body.nextCursor === null) break;
      cursor = body.nextCursor;
    }
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(new Set(seen).size).toBe(4);
    // Totals are cursor-relative today: the cursor is part of the WHERE, so
    // the second page counts only the rows after cursor 3 within the flag scope.
    expect(totals).toEqual([4, 1]);
  });

  it("keeps count-free pages identical except the deliberately uncomputed total", async () => {
    const counted = await page("?gpsLocked=true&limit=2");
    const free = await page("?gpsLocked=true&limit=2&includeTotal=false");
    expect(ids(counted.body)).toEqual([1, 2]);
    expect(counted.body.total).toBe(4);
    expect(free.body.rows).toEqual(counted.body.rows);
    expect(free.body.nextCursor).toBe(counted.body.nextCursor);
    expect(free.body.total).toBeNull();
    expect(free.recorder.statements.filter(isCount)).toEqual([]);
  });
});

describe("GREEN: any/omission equivalence", () => {
  it.each([
    ["onCall=any", "?onCall=any"],
    ["gpsLocked=any", "?gpsLocked=any"],
    ["both any", "?onCall=any&gpsLocked=any"],
    ["both any with enabled=any", "?onCall=any&gpsLocked=any&enabled=any"]
  ])("%s returns the same page as the bare list", async (_label, search) => {
    const bare = await page("");
    const any = await page(search);
    expect(ids(any.body)).toEqual(ids(bare.body));
    expect(any.body.total).toBe(bare.body.total);
    expect(any.body.nextCursor).toBe(bare.body.nextCursor);
  });
});

describe("RED: offset/asc/desc seek composes with the flags", () => {
  it("pages on-call rows by offset with cursor-relative totals", async () => {
    const first = await page("?onCall=true&limit=2");
    expect(ids(first.body)).toEqual([1, 2]);
    expect(first.body.total).toBe(4);
    expect(first.body.nextCursor).toBe(2);
    const second = await page("?onCall=true&limit=2&offset=2");
    expect(ids(second.body)).toEqual([3, 4]);
    expect(second.body.total).toBe(4);
    expect(second.body.nextCursor).toBe(4);
    const empty = await page("?onCall=true&limit=2&offset=4");
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.total).toBe(4);
    expect(empty.body.nextCursor).toBeNull();
  });

  it("traverses gps-locked rows downward and seeks with the flag predicate", async () => {
    const first = await page("?gpsLocked=false&order=desc&limit=2");
    expect(ids(first.body)).toEqual([8, 7]);
    expect(first.body.total).toBe(4);
    expect(first.body.nextCursor).toBe(7);
    expect(first.recorder.statements[1].sql).toMatch(/ORDER BY c\.container_id\s+DESC/i);
    expect(first.recorder.statements[1].sql).toContain("c.gps_locked = 0");
    const second = await page("?gpsLocked=false&order=desc&limit=2&cursor=7");
    expect(ids(second.body)).toEqual([4, 3]);
    expect(second.body.total).toBe(2);
    // No lookahead: a full page links onward even when nothing remains.
    expect(second.body.nextCursor).toBe(3);
    for (const s of second.recorder.statements) {
      expect(s.sql).toMatch(/c\.container_id\s*<\s*\?/);
      expect(s.sql).not.toMatch(/\bOFFSET\b/i);
    }
    const empty = await follow(
      nextTarget(second.response, second.url, { gpsLocked: "false", order: "desc", limit: "2", cursor: "3" })
    );
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.total).toBe(0);
    expect(empty.body.nextCursor).toBeNull();
    expect(empty.response.headers.get("link")).toBeNull();
  });

  it("prefers the cursor over a conflicting offset under a flag filter", async () => {
    const { body } = await page("?onCall=true&limit=2&cursor=1&offset=99");
    expect(ids(body)).toEqual([2, 3]);
    // Cursor-relative total: only rows after cursor 1 within the flag scope.
    expect(body.total).toBe(3);
    expect(body.nextCursor).toBe(3);
  });
});

describe("sparse fieldsets and conditional responses compose", () => {
  it("RED: sparse rows keep the flag filter and the id on every row", async () => {
    const { body } = await page("?onCall=true&fields=container_id,oncall");
    expect(ids(body)).toEqual([1, 2, 3, 4]);
    expect(body.rows).toEqual([1, 2, 3, 4].map((id) => ({ container_id: id, oncall: 1 })));
  });

  it("GREEN: the same filtered request replays to 304 with an empty body", async () => {
    const first = await page("?onCall=true");
    const etag = first.response.headers.get("etag");
    expect(etag).toMatch(/^".+"$/);
    const replay = await request("?onCall=true", { headers: { "if-none-match": etag! } });
    expect(replay.response.status).toBe(304);
    expect(await replay.response.text()).toBe("");
  });

  it("RED: distinct flag filters yield distinct ETags", async () => {
    const on = await page("?onCall=true");
    const off = await page("?onCall=false");
    expect(on.response.headers.get("etag")).not.toBe(off.response.headers.get("etag"));
  });
});

describe("RED: continuation links preserve the flags", () => {
  it("follows on-call pages to a full terminal page and then an empty page", async () => {
    const first = await page("?onCall=true&limit=2");
    expect(ids(first.body)).toEqual([1, 2]);
    expect(first.body.nextCursor).toBe(2);
    const second = await follow(nextTarget(first.response, first.url, { onCall: "true", limit: "2", cursor: "2" }));
    expect(ids(second.body)).toEqual([3, 4]);
    expect(second.body.nextCursor).toBe(4);
    const empty = await follow(nextTarget(second.response, second.url, { onCall: "true", limit: "2", cursor: "4" }));
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.total).toBe(0);
    expect(empty.body.nextCursor).toBeNull();
    expect(empty.response.headers.get("link")).toBeNull();
  });

  it("carries gpsLocked with enabled, q and count-free mode across links", async () => {
    const filters = { q: "needle", enabled: "any", gpsLocked: "true", includeTotal: "false", limit: "1" };
    const search = `?${new URLSearchParams(filters).toString()}`;
    const first = await page(search);
    expect(ids(first.body)).toEqual([2]);
    const seen: unknown[] = [...ids(first.body)];
    let current = first;
    for (let hop = 0; hop < 5; hop++) {
      const cursor = current.body.nextCursor;
      if (cursor === null) break;
      // `any` stays canonical: gpsLocked=true round-trips, enabled=any is omitted.
      current = await follow(
        nextTarget(current.response, current.url, { q: "needle", gpsLocked: "true", includeTotal: "false", limit: "1", cursor: String(cursor) })
      );
      seen.push(...ids(current.body));
      expect(current.body.total).toBeNull();
    }
    expect(seen).toEqual([2, 5]);
    expect(current.body.nextCursor).toBeNull();
    expect(current.response.headers.get("link")).toBeNull();
  });

  it("GREEN: any selectors are omitted canonically like enabled=any", async () => {
    const first = await page("?onCall=any&gpsLocked=any&enabled=any&limit=2");
    expect(ids(first.body)).toEqual([1, 2]);
    const target = nextTarget(first.response, first.url, { limit: "2", cursor: "2" });
    expect(target.searchParams.has("onCall")).toBe(false);
    expect(target.searchParams.has("gpsLocked")).toBe(false);
    expect(target.searchParams.has("enabled")).toBe(false);
  });
});

describe("RED: strict enum validation rejects before D1", () => {
  const INVALID: Array<[string, string]> = [
    ["empty string", ""],
    ["upper-case TRUE", "TRUE"],
    ["capitalised True", "True"],
    ["mixed-case tRue", "tRue"],
    ["numeric 1", "1"],
    ["numeric 0", "0"],
    ["yes", "yes"],
    ["leading space", "%20true"],
    ["trailing space", "true%20"],
    ["comma list", "true%2Cfalse"],
    ["marker value", "secret-marker-xyz"]
  ];

  it.each(INVALID)("onCall rejects %s with a value-free 400 before any D1 access", async (_name, value) => {
    const forbidden = forbiddenDb();
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((m) => vi.spyOn(console, m));
    const response = await request(`?onCall=${value}`, { db: forbidden.db });
    expect(response.response.status).toBe(400);
    expect(response.response.headers.get("content-type")).toContain("application/problem+json");
    const text = await response.response.text();
    expect(JSON.parse(text)).toEqual({
      type: BAD_REQUEST,
      title: "Bad Request",
      status: 400,
      detail: "Invalid request query (onCall). See docs/PROBLEMS.md#bad-request."
    });
    expect(text).not.toContain("secret-marker-xyz");
    expect(forbidden.prepare).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each(INVALID)("gpsLocked rejects %s with a value-free 400 before any D1 access", async (_name, value) => {
    const forbidden = forbiddenDb();
    const response = await request(`?gpsLocked=${value}`, { db: forbidden.db });
    expect(response.response.status).toBe(400);
    expect(response.response.headers.get("content-type")).toContain("application/problem+json");
    const text = await response.response.text();
    expect(JSON.parse(text)).toEqual({
      type: BAD_REQUEST,
      title: "Bad Request",
      status: 400,
      detail: "Invalid request query (gpsLocked). See docs/PROBLEMS.md#bad-request."
    });
    expect(text).not.toContain("secret-marker-xyz");
    expect(forbidden.prepare).not.toHaveBeenCalled();
  });

  it.each([
    ["repeated onCall with the same value", "?onCall=true&onCall=true"],
    ["repeated onCall with conflicting values", "?onCall=true&onCall=false"],
    ["repeated gpsLocked with the same value", "?gpsLocked=false&gpsLocked=false"],
    ["repeated gpsLocked with conflicting values", "?gpsLocked=true&gpsLocked=false"]
  ])("%s rejects before any D1 access", async (_label, search) => {
    const forbidden = forbiddenDb();
    const response = await request(search, { db: forbidden.db });
    expect(response.response.status).toBe(400);
    expect(response.response.headers.get("content-type")).toContain("application/problem+json");
    expect(forbidden.prepare).not.toHaveBeenCalled();
  });

  it("rejects both selectors together naming both fields without submitted values", async () => {
    const forbidden = forbiddenDb();
    const response = await request("?onCall=maybe&gpsLocked=secret-marker-xyz", { db: forbidden.db });
    expect(response.response.status).toBe(400);
    const text = await response.response.text();
    expect(text).toMatch(/onCall/);
    expect(text).toMatch(/gpsLocked/);
    expect(text).not.toContain("maybe");
    expect(text).not.toContain("secret-marker-xyz");
    expect(forbidden.prepare).not.toHaveBeenCalled();
  });

  it("rejects invalid selectors with the read-only token as well", async () => {
    for (const search of ["?onCall=nope", "?gpsLocked=nope"]) {
      const forbidden = forbiddenDb();
      const response = await request(search, { token: READ_TOKEN, db: forbidden.db });
      expect(response.response.status).toBe(400);
      expect(forbidden.prepare).not.toHaveBeenCalled();
    }
  });
});

describe("GREEN: auth precedes validation and D1", () => {
  it("401s without a token before validating the selectors or touching D1", async () => {
    for (const search of ["?onCall=true&gpsLocked=false", "?onCall=bogus&gpsLocked=bogus"]) {
      const forbidden = forbiddenDb();
      const response = await request(search, { token: null, db: forbidden.db });
      expect(response.response.status).toBe(401);
      expect(response.response.headers.get("content-type")).toContain("application/problem+json");
      expect(forbidden.prepare).not.toHaveBeenCalled();
      expect(forbidden.batch).not.toHaveBeenCalled();
      expect(forbidden.exec).not.toHaveBeenCalled();
    }
  });

  it("401s on a wrong token without touching D1", async () => {
    const forbidden = forbiddenDb();
    const response = await request("?onCall=true", { token: "wrong-token", db: forbidden.db });
    expect(response.response.status).toBe(401);
    expect(forbidden.prepare).not.toHaveBeenCalled();
  });

  it("serves filtered lists to the read-only token with Cache-Control: no-store", async () => {
    const { response } = await request("?onCall=true&gpsLocked=any", { token: READ_TOKEN });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("route SQL binds the stored-integer predicates", () => {
  it.each([
    ["onCall=true", "?onCall=true", "c.oncall = 1"],
    ["onCall=false", "?onCall=false", "c.oncall = 0"],
    ["gpsLocked=true", "?gpsLocked=true", "c.gps_locked = 1"],
    ["gpsLocked=false", "?gpsLocked=false", "c.gps_locked = 0"]
  ])("RED: %s adds its literal predicate to the COUNT and the page SELECT", async (_label, search, fragment) => {
    const { recorder } = await page(search);
    expect(recorder.statements).toHaveLength(2);
    for (const s of recorder.statements) expect(s.sql).toContain(fragment);
  });

  it("RED: both flags compose with the customer join without multiplying rows", async () => {
    const { body, recorder } = await page("?customerId=33&onCall=false&gpsLocked=true");
    expect(recorder.statements[0].sql).toMatch(/INNER JOIN address_snapshot/i);
    for (const s of recorder.statements) {
      expect(s.sql).toContain("c.oncall = 0");
      expect(s.sql).toContain("c.gps_locked = 1");
    }
    expect(ids(body)).toEqual([5, 6]);
    expect(body.total).toBe(2);
  });

  it("RED: the count-free page carries the predicate with zero COUNT statements", async () => {
    const { recorder } = await page("?onCall=false&includeTotal=false");
    expect(recorder.statements).toHaveLength(1);
    expect(recorder.statements.filter(isCount)).toEqual([]);
    expect(recorder.statements[0].sql).toContain("c.oncall = 0");
  });

  it("GREEN: any/omission adds no predicate on either fromJoin path", async () => {
    for (const search of ["", "?onCall=any&gpsLocked=any", "?customerId=11", "?customerId=11&onCall=any&gpsLocked=any"]) {
      const { recorder } = await page(search);
      for (const s of recorder.statements) {
        expect(s.sql).not.toContain("c.oncall =");
        expect(s.sql).not.toContain("c.gps_locked =");
      }
    }
  });

  it("GREEN: flag literals add no binds beyond the unfiltered pagination binds", async () => {
    const bare = await page("?limit=2&offset=1");
    const filtered = await page("?onCall=true&gpsLocked=false&limit=2&offset=1");
    const barePage = bare.recorder.statements.find((s) => !isCount(s))!;
    const filteredPage = filtered.recorder.statements.find((s) => !isCount(s))!;
    expect(filteredPage.binds).toEqual(barePage.binds);
  });
});

describe("GREEN: compatible merged behavior is preserved", () => {
  it("keeps full-row keys including the stored flag columns", async () => {
    const { body } = await page("?containerId=1");
    expect(ids(body)).toEqual([1]);
    for (const key of ["container_id", "pickup_address_id", "serial_number", "rfid", "oncall", "gps_locked", "enabled", "location_address", "synced_at"]) {
      expect(body.rows[0], key).toHaveProperty(key);
    }
    expect(body.rows[0].oncall).toBe(1);
    expect(body.rows[0].gps_locked).toBe(1);
  });

  it("keeps the existing enabled selector exact", async () => {
    const { body } = await page("?enabled=true");
    expect(ids(body)).toEqual([1, 3, 5, 7]);
    expect(body.total).toBe(4);
  });

  it("keeps the q serial OR leg exact", async () => {
    const { body } = await page("?q=needle");
    expect(ids(body)).toEqual([2, 4, 5]);
    expect(body.total).toBe(3);
  });

  it("keeps the customer join exact without the new selectors", async () => {
    const { body } = await page("?customerId=33");
    expect(ids(body)).toEqual([5, 6]);
    expect(body.total).toBe(2);
  });
});

describe("RED: served OpenAPI declares the selectors", () => {
  type Param = {
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    example?: unknown;
    schema?: { type?: unknown; enum?: unknown[]; default?: unknown; example?: unknown; description?: string };
  };
  type Operation = {
    operationId?: string;
    parameters?: Param[];
    responses?: Record<string, { description?: string }>;
  } & Record<string, unknown>;
  type Doc = { paths: Record<string, Record<string, Operation>> };

  async function openApi(): Promise<Doc> {
    const res = await exports.default.fetch("http://test.local/openapi.json");
    expect(res.status).toBe(200);
    return (await res.json()) as Doc;
  }

  async function containerList(): Promise<Operation> {
    const doc = await openApi();
    const op = doc.paths[PATH]?.get;
    expect(op).toBeDefined();
    return op!;
  }

  it.each(["onCall", "gpsLocked"])(
    "%s is an optional exact true|false|any query enum defaulting to any",
    async (name) => {
      const op = await containerList();
      const param = op.parameters?.find((p) => p.name === name);
      expect(param).toMatchObject({
        in: "query",
        required: false,
        schema: { type: "string", enum: ["true", "false", "any"], default: "any" }
      });
      expect(param?.example ?? param?.schema?.example).toBeDefined();
      expect(param?.description ?? param?.schema?.description ?? "").toMatch(/stored/i);
    }
  );

  it("keeps the stable operation identity, read access and documented 400", async () => {
    const op = await containerList();
    expect(op.operationId).toBe("listContainerSnapshot");
    expect(op["x-access"]).toBe("read");
    expect(op.responses?.["400"]?.description ?? "").toMatch(/onCall/);
    expect(op.responses?.["400"]?.description ?? "").toMatch(/gpsLocked/);
  });

  it("does not add the selectors to other lists, the changes feed or single-row reads", async () => {
    const doc = await openApi();
    for (const path of [
      "/api/v1/customer-snapshot",
      "/api/v1/address-snapshot",
      "/api/v1/customer-snapshot/changes",
      "/api/v1/customer-snapshot/{customerId}",
      "/api/v1/address-snapshot/{pickupAddressId}",
      "/api/v1/container-snapshot/{containerId}"
    ]) {
      const names = (doc.paths[path]?.get?.parameters ?? []).map((p) => p.name);
      expect(names, path).not.toContain("onCall");
      expect(names, path).not.toContain("gpsLocked");
    }
  });
});

describe("RED: query-policy inventory lists the selectors", () => {
  const row = (path: string) =>
    policyDoc.split("\n").find((line) => line.startsWith(`| \`${path}\` |`)) ?? "";

  it("names both selectors on the container list row, still ignoring unknown names", () => {
    expect(row(PATH)).toContain("`onCall`");
    expect(row(PATH)).toContain("`gpsLocked`");
    expect(row(PATH)).toMatch(/\| Ignore by default; reject when strictQuery=true \|/);
  });

  it("leaves the customer/address/changes rows without the selectors", () => {
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/address-snapshot", "/api/v1/customer-snapshot/changes"]) {
      expect(row(path), path).not.toContain("onCall");
      expect(row(path), path).not.toContain("gpsLocked");
    }
  });

  it("cites this oracle file", () => {
    expect(policyDoc).toContain("test/containerOnCallGpsLocked.acceptance.test.ts");
  });
});

describe("GREEN: local query plans need no new index", () => {
  // Recorded local shape only; production latency is never claimed from these.
  // The column list mirrors the route's page SELECT
  // (src/routes/containerSnapshot.ts): it must fetch the flag columns, so a
  // minimal `SELECT c.container_id` cannot fake a covering-index divergence
  // between bare and filtered shapes for row-fetch reasons.
  const COLS =
    "c.container_id, c.pickup_address_id, c.serial_number, c.oncall, c.gps_locked, c.enabled, c.location_address, c.synced_at";
  const SELECT = `SELECT ${COLS} FROM container_snapshot c WHERE 1 = 1`;
  const COUNT = "SELECT COUNT(*) as n FROM container_snapshot c WHERE 1 = 1";
  const JOIN_SELECT = `SELECT ${COLS} FROM container_snapshot c INNER JOIN address_snapshot a ON a.pickup_address_id = c.pickup_address_id WHERE 1 = 1 AND a.customer_id = ?`;
  const JOIN_COUNT = "SELECT COUNT(*) as n FROM container_snapshot c INNER JOIN address_snapshot a ON a.pickup_address_id = c.pickup_address_id WHERE 1 = 1 AND a.customer_id = ?";

  async function plan(sql: string, ...binds: unknown[]): Promise<string[]> {
    const r = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...binds)
      .all<{ detail: string }>();
    return (r.results ?? []).map((x) => x.detail);
  }

  /** Plan lines name the `c`/`a` aliases, not the table names. */
  function tablesOf(details: string[]): { container: boolean; address: boolean } {
    const text = details.join("\n");
    return { container: /\bc\b/.test(text), address: /\ba\b/.test(text) };
  }

  /** Covering-ness is a row-fetch detail, not an access-path change. */
  const accessPath = (details: string[]) =>
    details.map((d) => d.replace("USING COVERING INDEX", "USING INDEX"));

  it("executes every flag shape on both fromJoin paths with offset and seek pagination", async () => {
    const shapes = [
      `${SELECT} ORDER BY c.container_id ASC LIMIT ? OFFSET ?`,
      `${COUNT}`,
      `${SELECT} AND c.oncall = 1 AND c.gps_locked = 0 ORDER BY c.container_id ASC LIMIT ? OFFSET ?`,
      `${COUNT} AND c.oncall = 1 AND c.gps_locked = 0`,
      `${SELECT} AND c.oncall = 0 AND c.gps_locked = 1 ORDER BY c.container_id DESC LIMIT ?`,
      `${SELECT} AND c.oncall = 1 AND c.gps_locked = 1 AND c.container_id > ? ORDER BY c.container_id ASC LIMIT ?`,
      `${SELECT} AND c.oncall = 0 AND c.gps_locked = 0 AND c.container_id < ? ORDER BY c.container_id DESC LIMIT ?`
    ];
    const joinShapes = shapes.map((s) =>
      s.replace(COUNT, JOIN_COUNT).replace(SELECT, JOIN_SELECT)
    );
    for (const sql of [...shapes, ...joinShapes]) {
      const placeholders = (sql.match(/\?/g) ?? []).length;
      const binds = Array.from({ length: placeholders }, (_, i) =>
        sql.includes("customer_id") && i === 0 ? 11 : i + 1
      );
      const details = await plan(sql, ...binds);
      expect(details.length, sql).toBeGreaterThan(0);
      const tables = tablesOf(details);
      expect(tables.container, sql).toBe(true);
      expect(tables.address, sql).toBe(sql.includes("INNER JOIN"));
    }
  });

  it("keeps the identical access path with and without the flag predicates", async () => {
    // Integer-equality predicates on unindexed stored columns filter rows
    // without changing the plan: same tables, same indexes, same SCAN/SEARCH
    // verbs, same ORDER BY handling — no new index, no added sort step, no
    // extra table. Any divergence here means the route shape outgrew this oracle.
    const pairs: Array<[string, string, unknown[]]> = [
      [
        `${SELECT} ORDER BY c.container_id ASC LIMIT ? OFFSET ?`,
        `${SELECT} AND c.oncall = 1 AND c.gps_locked = 0 ORDER BY c.container_id ASC LIMIT ? OFFSET ?`,
        [2, 0]
      ],
      [
        `${SELECT} AND c.container_id > ? ORDER BY c.container_id ASC LIMIT ?`,
        `${SELECT} AND c.oncall = 0 AND c.gps_locked = 1 AND c.container_id > ? ORDER BY c.container_id ASC LIMIT ?`,
        [1, 2]
      ],
      [
        `${JOIN_SELECT} ORDER BY c.container_id DESC LIMIT ?`,
        `${JOIN_SELECT} AND c.oncall = 1 AND c.gps_locked = 1 ORDER BY c.container_id DESC LIMIT ?`,
        [22, 2]
      ],
      [
        `${JOIN_COUNT}`,
        `${JOIN_COUNT} AND c.oncall = 0 AND c.gps_locked = 0`,
        [22]
      ]
    ];
    for (const [bare, filtered, binds] of pairs) {
      const [barePlan, filteredPlan] = await Promise.all([plan(bare, ...binds), plan(filtered, ...binds)]);
      expect(accessPath(filteredPlan), filtered).toEqual(accessPath(barePlan));
    }
  });
});
