/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned oracle: select equipment mirrored since a caller-held
 * instant on the EXISTING container list (`GET /api/v1/container-snapshot`).
 * Written from the card spec only; the paired build implements it and must
 * not edit this file.
 *
 * Contract under test:
 * - Optional `syncedSince` (container list ONLY) keeps rows whose stored
 *   `synced_at` is STRICTLY GREATER than the normalized instant. A row
 *   stamped exactly at the instant is excluded.
 * - Validation/normalization is exactly the customer-changes `since` rule
 *   (one shared parser, no fork): UTC `Z`, seconds required, optional 1-3
 *   fractional digits, calendar-valid, normalized to `toISOString()`
 *   milliseconds, never rounded or truncated. Empty, timezone-offset,
 *   >3-fraction-digit, calendar-invalid and repeated values (including
 *   percent-encoded duplicate keys) reject with the established value-free
 *   400 before any D1 work. Unlike legacy empty-`since` on the changes
 *   feed, empty `syncedSince` is invalid here.
 * - This is a stored-value selector on the ordinary list, NOT a changes
 *   feed: ordering and cursors stay `container_id` keyset (asc/desc,
 *   offset-to-seek links), totals stay cursor-relative, and no deletion,
 *   isolation or completeness claim is made. Continuation links carry the
 *   NORMALIZED instant.
 * - It ANDs with the existing selectors (ids/q/enabled/onCall/join scopes/
 *   lowerId/upperId) on both fromJoin paths, composes with COUNT / page /
 *   countOnly / count-free / sparse / conditional modes, and adds no D1
 *   statements beyond the existing budgets. Omission adds no predicate.
 * - Mounted OpenAPI declares it once on the container list, with the same
 *   pattern spelling as the changes-feed `since` parameter and a
 *   schema-valid example; no other operation gains it. (routeExamples
 *   inventories it after `enabled`; keep the mounted order consistent
 *   with that inventory.)
 *
 * Fixture matrix (synthetic only; id order deliberately disagrees with
 * time order so a synced_at-ordered implementation fails):
 *
 *   id  synced_at                       enabled  address  customer  q=needle
 *    1  2026-09-01T00:00:00.000Z (T0)         1      101        11
 *    2  2026-09-01T00:00:01.000Z (NEXT)       1      102        11   location
 *    3  2026-09-01T00:00:00.500Z (HALF)       0      103        22
 *    4  2026-09-01T00:00:00.100Z (TENTH)      1      104        22   serial
 *    5  2026-09-01T00:00:00.499Z              1      105        33
 *    6  2026-09-01T00:00:00.501Z              0      106        33   location
 *    7  2026-08-31T23:59:59.999Z (BEFORE)     1      107        44
 *    8  2026-09-01T00:00:00.500Z (HALF)       1      108        44
 *
 * So `syncedSince=T0` selects [2,3,4,5,6,8] in container_id order (time
 * order would be [4,5,3,8,6,2]), `=HALF` selects [2,6] (3 and 8 sit
 * exactly at the instant), and `=TENTH` selects [2,3,5,6,8] (4 is equal).
 *
 * Expected RED before the paired build (do not skip or weaken): the
 * headline cases in every RED describe fail today because unknown query
 * keys are ignored (200 with unfiltered rows) and the served OpenAPI /
 * query-policy inventory do not name the key yet. GREEN tests, and the
 * absence-only guards inside RED describes (other operations/rows must
 * NOT gain the key), are preservation guards that pass before and after
 * (auth-before-D1, omission parity, other lists ignoring the unknown
 * name, existing validation, countOnly/includeTotal conflict).
 * A headline RED case that passes before the build is a broken oracle —
 * fix the test, not the verdict.
 *
 * Hermetic: real local D1 executes every recorded statement; the list path
 * may only prepare SELECTs (batch/exec/run throw); unexpected network fails.
 */

const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/container-snapshot";
const CHANGES_PATH = "/api/v1/customer-snapshot/changes";
const API_TOKEN = "test-api-token";
const READ_TOKEN = "test-read-token";
const ORIGIN = "http://test.local";
const BAD_REQUEST = problemType("bad-request");
const MARKER = "secret-marker-xyz";

const BEFORE = "2026-08-31T23:59:59.999Z";
const T0 = "2026-09-01T00:00:00.000Z";
const TENTH = "2026-09-01T00:00:00.100Z";
const M499 = "2026-09-01T00:00:00.499Z";
const HALF = "2026-09-01T00:00:00.500Z";
const M501 = "2026-09-01T00:00:00.501Z";
const NEXT = "2026-09-01T00:00:01.000Z";

type Statement = { sql: string; binds: unknown[]; method: string };
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };

const FIXTURES = [
  { id: 1, stamp: T0, enabled: 1, address: 101, customer: 11, location: "synthetic-other-1", serial: "serial-other-1" },
  { id: 2, stamp: NEXT, enabled: 1, address: 102, customer: 11, location: "synthetic-needle-2", serial: "serial-other-2" },
  { id: 3, stamp: HALF, enabled: 0, address: 103, customer: 22, location: "synthetic-other-3", serial: "serial-other-3" },
  { id: 4, stamp: TENTH, enabled: 1, address: 104, customer: 22, location: "synthetic-other-4", serial: "serial-needle-4" },
  { id: 5, stamp: M499, enabled: 1, address: 105, customer: 33, location: "synthetic-other-5", serial: "serial-other-5" },
  { id: 6, stamp: M501, enabled: 0, address: 106, customer: 33, location: "synthetic-needle-6", serial: "serial-other-6" },
  { id: 7, stamp: BEFORE, enabled: 1, address: 107, customer: 44, location: "synthetic-other-7", serial: "serial-other-7" },
  { id: 8, stamp: HALF, enabled: 1, address: 108, customer: 44, location: "synthetic-other-8", serial: "serial-other-8" }
] as const;
const AFTER_T0 = [2, 3, 4, 5, 6, 8];

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

/** Status-only probe of another mounted list/feed against the seeded real D1. */
async function statusFor(path: string, params: Record<string, string>) {
  const url = new URL(path, ORIGIN);
  url.search = new URLSearchParams(params).toString();
  const response = await app.fetch(
    new Request(url, { headers: { authorization: `Bearer ${READ_TOKEN}` } }),
    TEST_ENV
  );
  const body = (await response.json()) as { rows?: Array<Record<string, unknown>> };
  return { status: response.status, body };
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
  const countOnly = result.url.searchParams.get("countOnly") === "true";
  const counted = result.url.searchParams.get("includeTotal") !== "false";
  expect(result.recorder.statements).toHaveLength(countOnly ? 1 : counted ? 2 : 1);
  expect(result.recorder.statements.filter(isCount)).toHaveLength(counted ? 1 : 0);
  expect(result.recorder.statements.every((s) => /^\s*SELECT\b/i.test(s.sql))).toBe(true);
  expect(result.recorder.statements.every((s) => s.method === "first" || s.method === "all")).toBe(true);
  expect(result.recorder.batch).not.toHaveBeenCalled();
  expect(result.recorder.exec).not.toHaveBeenCalled();
  if (!counted) expect(body.total).toBeNull();
  if (countOnly) {
    expect(body.rows).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  }
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
    throw new Error("Unexpected outbound fetch in syncedSince acceptance");
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
        "INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(f.id, f.address, f.location, f.serial, f.enabled, f.stamp)
    ]);
  }
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RED: strict-greater selection with since-rule normalization", () => {
  it.each([
    ["seconds form", "2026-09-01T00:00:00Z", AFTER_T0],
    ["one zero digit", "2026-09-01T00:00:00.0Z", AFTER_T0],
    ["two zero digits", "2026-09-01T00:00:00.00Z", AFTER_T0],
    ["millisecond form", T0, AFTER_T0],
    ["one tenth digit", "2026-09-01T00:00:00.1Z", [2, 3, 5, 6, 8]],
    ["two tenth digits", "2026-09-01T00:00:00.10Z", [2, 3, 5, 6, 8]],
    ["three tenth digits", TENTH, [2, 3, 5, 6, 8]],
    ["just below half", M499, [2, 3, 6, 8]],
    ["one half digit", "2026-09-01T00:00:00.5Z", [2, 6]],
    ["two half digits", "2026-09-01T00:00:00.50Z", [2, 6]],
    ["three half digits", HALF, [2, 6]],
    ["one millisecond above half", M501, [2]],
    ["at the newest stamp", NEXT, []],
    ["far future", "9999-12-31T23:59:59.999Z", []],
    ["exactly the oldest stamp", BEFORE, [1, 2, 3, 4, 5, 6, 8]]
  ])("%s keeps only rows stored strictly after the instant", async (_label, value, expected) => {
    const { body } = await page(`?syncedSince=${value}`);
    expect(ids(body)).toEqual(expected);
    expect(body.total).toBe(expected.length);
    expect(new Set(ids(body)).size).toBe(expected.length);
  });

  it("excludes the row stamped exactly at the instant and every earlier row", async () => {
    const { body } = await page(`?syncedSince=${HALF}`);
    expect(ids(body)).toEqual([2, 6]);
    expect(body.rows.map((r) => r.synced_at)).toEqual([NEXT, M501]);
  });

  it("orders by container_id, not by synced_at (this is not a changes feed)", async () => {
    const { body } = await page(`?syncedSince=${T0}`);
    expect(ids(body)).toEqual(AFTER_T0);
    // Hand-derived stamp sequence in id order; time order would differ.
    expect(body.rows.map((r) => r.synced_at)).toEqual([NEXT, HALF, TENTH, M499, M501, HALF]);
  });

  it("accepts a leap-day instant and binds it normalized to milliseconds", async () => {
    const { body, recorder } = await page("?syncedSince=2024-02-29T00:00:00Z");
    expect(ids(body)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(body.total).toBe(8);
    for (const s of recorder.statements) expect(s.binds).toContain("2024-02-29T00:00:00.000Z");
  });

  it("accepts the year-0000 instant exactly like the shared since parser", async () => {
    const { body, recorder } = await page("?syncedSince=0000-01-01T00:00:00.000Z");
    expect(ids(body)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const s of recorder.statements) expect(s.binds).toContain("0000-01-01T00:00:00.000Z");
  });

  it("accepts a single percent-encoded key spelling after decoding", async () => {
    const { body } = await page(`?%73yncedSince=${encodeURIComponent(HALF)}`);
    expect(ids(body)).toEqual([2, 6]);
    expect(body.total).toBe(2);
  });
});

describe("RED: composition with existing selectors", () => {
  it.each([
    ["q narrows the window", `?q=needle&syncedSince=${T0}`, [2, 4, 6]],
    ["q with the equal-stamp row excluded", `?q=needle&syncedSince=${TENTH}`, [2, 6]],
    ["enabled=true ANDs", `?enabled=true&syncedSince=${T0}`, [2, 4, 5, 8]],
    ["enabled=false ANDs", `?enabled=false&syncedSince=${T0}`, [3, 6]],
    ["containerId hit inside the window", `?containerId=3&syncedSince=${M499}`, [3]],
    ["containerId at the instant is excluded", `?containerId=3&syncedSince=${HALF}`, []],
    ["pickupAddressId hit inside the window", `?pickupAddressId=106&syncedSince=${HALF}`, [6]],
    ["pickupAddressId at its own stamp is excluded", `?pickupAddressId=106&syncedSince=${M501}`, []],
    ["customerId join narrows the window", `?customerId=22&syncedSince=${TENTH}`, [3]],
    ["customerId join can empty the window", `?customerId=22&syncedSince=${HALF}`, []],
    ["ids selection ANDs", `?ids=2,3,8&syncedSince=${HALF}`, [2]],
    ["lowerId/upperId bounds AND with the window", `?lowerId=3&upperId=6&syncedSince=${T0}`, [3, 4, 5, 6]],
    ["lowerId bound keeps the equal-stamp row out", `?lowerId=6&syncedSince=${HALF}`, [6]],
    ["descending order stays container_id keyset", `?order=desc&syncedSince=${T0}`, [8, 6, 5, 4, 3, 2]]
  ])("%s", async (_label, search, expected) => {
    const { body, recorder } = await page(search);
    expect(ids(body)).toEqual(expected);
    expect(body.total).toBe(expected.length);
    // The window predicate must be present even where the sibling selector
    // alone would return the same rows (keeps every case discriminating).
    const stamp = new URLSearchParams(search).get("syncedSince");
    for (const s of recorder.statements) {
      expect(s.sql).toMatch(/synced_at\s*>\s*\?/);
      expect(s.binds).toContain(stamp);
    }
    if (search.includes("customerId=")) {
      expect(recorder.statements[0].sql).toMatch(/INNER JOIN address_snapshot/i);
    }
  });

  it("composes with strictQuery=true and carries both in continuation links", async () => {
    const first = await page(`?strictQuery=true&syncedSince=${T0}&limit=2`);
    expect(ids(first.body)).toEqual([2, 3]);
    const second = await follow(
      nextTarget(first.response, first.url, { strictQuery: "true", syncedSince: T0, limit: "2", cursor: "3" })
    );
    expect(ids(second.body)).toEqual([4, 5]);
  });
});

describe("RED: COUNT / page / countOnly / count-free parity", () => {
  it("keeps count-free pages identical except the deliberately uncomputed total", async () => {
    const counted = await page(`?syncedSince=${T0}&limit=2`);
    const free = await page(`?syncedSince=${T0}&limit=2&includeTotal=false`);
    expect(ids(counted.body)).toEqual([2, 3]);
    expect(counted.body.total).toBe(6);
    expect(free.body.rows).toEqual(counted.body.rows);
    expect(free.body.nextCursor).toBe(counted.body.nextCursor);
    expect(free.body.total).toBeNull();
    expect(free.recorder.statements.filter(isCount)).toEqual([]);
  });

  it.each([
    ["window total", `?syncedSince=${T0}&countOnly=true`, 6],
    ["half-window total", `?syncedSince=${HALF}&countOnly=true`, 2],
    ["empty window total", `?syncedSince=${NEXT}&countOnly=true`, 0],
    ["limit/offset do not truncate the count", `?syncedSince=${T0}&countOnly=true&limit=1&offset=99`, 6],
    ["cursor-relative count", `?syncedSince=${T0}&countOnly=true&cursor=3`, 4],
    ["q-filtered count", `?q=needle&syncedSince=${T0}&countOnly=true`, 3]
  ])("countOnly returns the filtered COUNT only: %s", async (_label, search, total) => {
    const { body, recorder } = await page(search);
    expect(body).toEqual({ rows: [], total, nextCursor: null });
    expect(recorder.statements).toHaveLength(1);
    expect(recorder.statements.filter(isCount)).toHaveLength(1);
    expect(recorder.statements[0].sql).toMatch(/synced_at\s*>\s*\?/);
    expect(recorder.statements[0].binds).toContain(new URLSearchParams(search).get("syncedSince"));
  });

  it("still validates syncedSince in countOnly mode before any D1 access", async () => {
    const forbidden = forbiddenDb();
    const { response } = await request("?countOnly=true&syncedSince=not-a-date", { db: forbidden.db });
    expect(response.status).toBe(400);
    expect(forbidden.prepare).not.toHaveBeenCalled();
  });

  it("GREEN: countOnly plus includeTotal=false keeps the established conflict 400", async () => {
    const forbidden = forbiddenDb();
    const { response } = await request(`?syncedSince=${T0}&countOnly=true&includeTotal=false`, { db: forbidden.db });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toMatch(/(?:omit|remove).*includeTotal=false|includeTotal=false.*(?:omit|remove)/i);
    expect(text).toMatch(/countOnly=false/);
    expect(forbidden.prepare).not.toHaveBeenCalled();
  });
});

describe("RED: offset, seek and both traversal directions follow real links", () => {
  it("follows ascending links from the seconds form, normalized, to an empty page", async () => {
    const first = await page("?syncedSince=2026-09-01T00:00:00Z&limit=2");
    expect(ids(first.body)).toEqual([2, 3]);
    expect(first.body.total).toBe(6);
    expect(first.body.nextCursor).toBe(3);
    const second = await follow(nextTarget(first.response, first.url, { syncedSince: T0, limit: "2", cursor: "3" }));
    expect(ids(second.body)).toEqual([4, 5]);
    expect(second.body.total).toBe(4);
    expect(second.body.nextCursor).toBe(5);
    const third = await follow(nextTarget(second.response, second.url, { syncedSince: T0, limit: "2", cursor: "5" }));
    expect(ids(third.body)).toEqual([6, 8]);
    expect(third.body.total).toBe(2);
    // No lookahead: a full page links onward even when nothing remains.
    expect(third.body.nextCursor).toBe(8);
    const empty = await follow(nextTarget(third.response, third.url, { syncedSince: T0, limit: "2", cursor: "8" }));
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.total).toBe(0);
    expect(empty.body.nextCursor).toBeNull();
    expect(empty.response.headers.get("link")).toBeNull();
  });

  it("carries the normalized half-second form in single-row links", async () => {
    const first = await page("?syncedSince=2026-09-01T00:00:00.5Z&limit=1");
    expect(ids(first.body)).toEqual([2]);
    expect(first.body.total).toBe(2);
    const second = await follow(nextTarget(first.response, first.url, { syncedSince: HALF, limit: "1", cursor: "2" }));
    expect(ids(second.body)).toEqual([6]);
    expect(second.body.total).toBe(1);
    expect(second.body.nextCursor).toBe(6);
    const empty = await follow(nextTarget(second.response, second.url, { syncedSince: HALF, limit: "1", cursor: "6" }));
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.total).toBe(0);
    expect(empty.body.nextCursor).toBeNull();
    expect(empty.response.headers.get("link")).toBeNull();
  });

  it("follows descending links with a < seek and cursor-relative totals", async () => {
    const first = await page(`?syncedSince=${T0}&order=desc&limit=2`);
    expect(ids(first.body)).toEqual([8, 6]);
    expect(first.body.total).toBe(6);
    expect(first.body.nextCursor).toBe(6);
    const second = await follow(
      nextTarget(first.response, first.url, { syncedSince: T0, order: "desc", limit: "2", cursor: "6" })
    );
    expect(ids(second.body)).toEqual([5, 4]);
    expect(second.body.total).toBe(4);
    expect(second.body.nextCursor).toBe(4);
    for (const s of second.recorder.statements) {
      expect(s.sql).toMatch(/container_id\s*<\s*\?/);
      expect(s.sql).not.toMatch(/\bOFFSET\b/i);
    }
    const third = await follow(
      nextTarget(second.response, second.url, { syncedSince: T0, order: "desc", limit: "2", cursor: "4" })
    );
    expect(ids(third.body)).toEqual([3, 2]);
    expect(third.body.total).toBe(2);
    expect(third.body.nextCursor).toBe(2);
    const empty = await follow(
      nextTarget(third.response, third.url, { syncedSince: T0, order: "desc", limit: "2", cursor: "2" })
    );
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.total).toBe(0);
    expect(empty.body.nextCursor).toBeNull();
    expect(empty.response.headers.get("link")).toBeNull();
  });

  it("turns an offset start into seek links without reintroducing offset", async () => {
    const first = await page(`?syncedSince=${T0}&limit=2&offset=2`);
    expect(ids(first.body)).toEqual([4, 5]);
    expect(first.body.total).toBe(6);
    expect(first.body.nextCursor).toBe(5);
    const second = await follow(nextTarget(first.response, first.url, { syncedSince: T0, limit: "2", cursor: "5" }));
    expect(ids(second.body)).toEqual([6, 8]);
    expect(second.body.total).toBe(2);
    const empty = await follow(nextTarget(second.response, second.url, { syncedSince: T0, limit: "2", cursor: "8" }));
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.nextCursor).toBeNull();
  });

  it("pages by offset with un-windowed totals and an empty tail page", async () => {
    const tail = await page(`?syncedSince=${T0}&limit=2&offset=4`);
    expect(ids(tail.body)).toEqual([6, 8]);
    expect(tail.body.total).toBe(6);
    expect(tail.body.nextCursor).toBe(8);
    const empty = await page(`?syncedSince=${T0}&limit=2&offset=6`);
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.total).toBe(6);
    expect(empty.body.nextCursor).toBeNull();
  });

  it("prefers the cursor over a conflicting offset inside the window", async () => {
    const { body } = await page(`?syncedSince=${T0}&limit=2&cursor=2&offset=99`);
    expect(ids(body)).toEqual([3, 4]);
    // Cursor-relative total: only rows after cursor 2 within the window.
    expect(body.total).toBe(5);
    expect(body.nextCursor).toBe(4);
  });
});

describe("sparse fieldsets and conditional responses compose", () => {
  it("RED: sparse rows keep the window and project only id + synced_at", async () => {
    const { body } = await page(`?syncedSince=${T0}&fields=synced_at`);
    expect(body.rows).toEqual([
      { container_id: 2, synced_at: NEXT },
      { container_id: 3, synced_at: HALF },
      { container_id: 4, synced_at: TENTH },
      { container_id: 5, synced_at: M499 },
      { container_id: 6, synced_at: M501 },
      { container_id: 8, synced_at: HALF }
    ]);
    expect(body.total).toBe(6);
  });

  it("GREEN: the same filtered request replays to 304 with an empty body", async () => {
    const first = await page(`?syncedSince=${T0}`);
    const etag = first.response.headers.get("etag");
    expect(etag).toMatch(/^".+"$/);
    const replay = await request(`?syncedSince=${T0}`, { headers: { "if-none-match": etag! } });
    expect(replay.response.status).toBe(304);
    expect(await replay.response.text()).toBe("");
  });

  it("RED: distinct windows yield distinct ETags and no cross-window 304", async () => {
    const bare = await page("");
    const t0 = await page(`?syncedSince=${T0}`);
    const half = await page(`?syncedSince=${HALF}`);
    const tags = [bare, t0, half].map((r) => r.response.headers.get("etag"));
    expect(new Set(tags).size).toBe(3);
    const cross = await request(`?syncedSince=${T0}`, {
      headers: { "if-none-match": half.response.headers.get("etag")! }
    });
    expect(cross.response.status).toBe(200);
    const body = (await cross.response.json()) as Body;
    expect(ids(body)).toEqual(AFTER_T0);
  });

  it("RED: an invalid window is a 400 before D1 even with If-None-Match", async () => {
    const forbidden = forbiddenDb();
    const { response } = await request("?syncedSince=2026-02-29T00:00:00Z", {
      headers: { "if-none-match": "*" },
      db: forbidden.db
    });
    expect(response.status).toBe(400);
    expect(forbidden.prepare).not.toHaveBeenCalled();
  });
});

describe("RED: malformed and repeated values reject before D1", () => {
  const INVALID: Array<[string, string]> = [
    ["empty", ""],
    ["blank space", " "],
    ["blank tab", "\t"],
    ["not a date", "not-a-date"],
    ["marker value", MARKER],
    ["date only", "2026-09-01"],
    ["missing Z", "2026-09-01T00:00:00"],
    ["missing seconds", "2026-09-01T00:00Z"],
    ["space separator", "2026-09-01 00:00:00Z"],
    ["lowercase t", "2026-09-01t00:00:00Z"],
    ["lowercase z", "2026-09-01T00:00:00z"],
    ["zero offset", "2026-09-01T00:00:00+00:00"],
    ["positive offset", "2026-09-01T01:00:00+01:00"],
    ["negative offset", "2026-08-31T19:00:00-05:00"],
    ["four fraction digits", "2026-09-01T00:00:00.0000Z"],
    ["four digits would round up", "2026-09-01T00:00:00.4999Z"],
    ["four digits trailing zero", "2026-09-01T00:00:00.5000Z"],
    ["nanosecond precision", "2026-09-01T00:00:00.123456789Z"],
    ["fraction dot without digits", "2026-09-01T00:00:00.Z"],
    ["comma fraction", "2026-09-01T00:00:00,5Z"],
    ["non-leap Feb 29", "2026-02-29T00:00:00Z"],
    ["Feb 30", "2026-02-30T00:00:00Z"],
    ["Apr 31", "2026-04-31T00:00:00Z"],
    ["month 13", "2026-13-01T00:00:00Z"],
    ["month 00", "2026-00-01T00:00:00Z"],
    ["day 00", "2026-09-00T00:00:00Z"],
    ["single-digit month", "2026-9-01T00:00:00Z"],
    ["hour 24", "2026-09-01T24:00:00Z"],
    ["minute 60", "2026-09-01T00:60:00Z"],
    ["second 60", "2026-09-01T00:00:60Z"],
    ["leading space", " 2026-09-01T00:00:00Z"],
    ["trailing space", "2026-09-01T00:00:00Z "],
    ["sql-flavoured suffix", "2026-09-01T00:00:00Z' OR 1=1 --"]
  ];

  it.each(INVALID)("rejects %s with a value-free 400 before any D1 access", async (_name, value) => {
    const forbidden = forbiddenDb();
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((m) => vi.spyOn(console, m));
    const { response } = await request(`?syncedSince=${encodeURIComponent(value)}`, { db: forbidden.db });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("link")).toBeNull();
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["detail", "status", "title", "type"]);
    expect(body).toMatchObject({ type: BAD_REQUEST, title: "Bad Request", status: 400 });
    expect(String(body.detail)).toMatch(/syncedSince/);
    expect(String(body.detail)).toContain("docs/PROBLEMS.md#bad-request");
    expect(text).not.toContain(MARKER);
    expect(forbidden.prepare).not.toHaveBeenCalled();
    expect(forbidden.batch).not.toHaveBeenCalled();
    expect(forbidden.exec).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["repeated with the same value", `?syncedSince=${T0}&syncedSince=${T0}`],
    ["repeated with conflicting values", `?syncedSince=${T0}&syncedSince=${HALF}`],
    ["repeated with an empty second value", `?syncedSince=${T0}&syncedSince=`],
    ["repeated with an empty first value", `?syncedSince=&syncedSince=${T0}`],
    ["encoded values repeated", `?syncedSince=${encodeURIComponent(T0)}&syncedSince=${encodeURIComponent(HALF)}`],
    ["percent-encoded duplicate key", `?syncedSince=${encodeURIComponent(T0)}&%73yncedSince=${encodeURIComponent(HALF)}`],
    ["percent-encoded duplicate key, same value", `?%73yncedSince=${encodeURIComponent(T0)}&syncedSince=${encodeURIComponent(T0)}`]
  ])("%s rejects before any D1 access", async (_label, search) => {
    const forbidden = forbiddenDb();
    const { response } = await request(search, { db: forbidden.db });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(forbidden.prepare).not.toHaveBeenCalled();
  });

  it("uses identical fixed guidance for different rejected values, without logging them", async () => {
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {})
    );
    const bodies: unknown[] = [];
    for (const value of ["private-synthetic-marker-a", "private-synthetic-marker-b"]) {
      const forbidden = forbiddenDb();
      const { response } = await request(`?syncedSince=${value}`, { db: forbidden.db });
      expect(response.status).toBe(400);
      bodies.push(await response.json());
      expect(forbidden.prepare).not.toHaveBeenCalled();
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toMatch(/private-synthetic-marker/);
  });

  it.each([
    ["count-free mode", "?syncedSince=not-a-date&includeTotal=false"],
    ["sparse mode", "?syncedSince=not-a-date&fields=synced_at"],
    ["read-only token", "?syncedSince=not-a-date"]
  ])("rejects an invalid window in %s before D1", async (_label, search) => {
    const forbidden = forbiddenDb();
    const { response } = await request(search, { token: READ_TOKEN, db: forbidden.db });
    expect(response.status).toBe(400);
    expect(forbidden.prepare).not.toHaveBeenCalled();
  });

  it("GREEN: a valid window does not bypass existing limit validation", async () => {
    const forbidden = forbiddenDb();
    const { response } = await request(`?syncedSince=${T0}&limit=0`, { db: forbidden.db });
    expect(response.status).toBe(400);
    expect(forbidden.prepare).not.toHaveBeenCalled();
  });
});

describe("RED: the instant parser is the shared changes-feed since parser", () => {
  it.each([
    "2026-09-01T00:00:00Z",
    "2026-09-01T00:00:00.5Z",
    "2024-02-29T00:00:00Z",
    "2026-09-01T00:00:00.4999Z",
    "2026-09-01T01:00:00+01:00",
    "2026-02-29T00:00:00Z",
    "2026-09-01T00:00Z",
    "2026-09-01T00:00:00z"
  ])("container syncedSince and changes since agree on %s", async (value) => {
    const changes = await statusFor(CHANGES_PATH, { since: value });
    const { response, recorder } = await request(`?syncedSince=${encodeURIComponent(value)}`);
    await response.text();
    expect(response.status).toBe(changes.status);
    if (response.status === 200) {
      // Agreement is only meaningful if the container list actually applied
      // the instant (an ignored unknown key would also return 200).
      for (const s of recorder.statements) expect(s.binds).toContain(new Date(value).toISOString());
    }
  });

  it("diverges only on empty: legacy empty since stays 200, empty syncedSince is 400", async () => {
    const changes = await statusFor(CHANGES_PATH, { since: "" });
    expect(changes.status).toBe(200);
    const forbidden = forbiddenDb();
    const { response } = await request("?syncedSince=", { db: forbidden.db });
    expect(response.status).toBe(400);
    expect(forbidden.prepare).not.toHaveBeenCalled();
  });
});

describe("GREEN: auth precedes validation, conditional handling and D1", () => {
  it("401s without a token before validating the window or touching D1", async () => {
    for (const search of [`?syncedSince=${T0}`, "?syncedSince=bogus"]) {
      const forbidden = forbiddenDb();
      const { response } = await request(search, { token: null, db: forbidden.db });
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(forbidden.prepare).not.toHaveBeenCalled();
      expect(forbidden.batch).not.toHaveBeenCalled();
      expect(forbidden.exec).not.toHaveBeenCalled();
    }
  });

  it("401s on a wrong token without touching D1, even with If-None-Match", async () => {
    const forbidden = forbiddenDb();
    const { response } = await request(`?syncedSince=${T0}`, {
      token: "wrong-token",
      headers: { "if-none-match": "*" },
      db: forbidden.db
    });
    expect(response.status).toBe(401);
    expect(forbidden.prepare).not.toHaveBeenCalled();
  });

  it("serves the list to the read-only token with Cache-Control: no-store", async () => {
    const { response } = await request(`?syncedSince=${T0}`, { token: READ_TOKEN });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("GREEN: omission and other lists are unchanged", () => {
  it("returns the bare list with full-row keys when syncedSince is omitted", async () => {
    const { body, recorder } = await page("");
    expect(ids(body)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(body.total).toBe(8);
    for (const key of ["container_id", "pickup_address_id", "serial_number", "enabled", "location_address", "synced_at"]) {
      expect(body.rows[0], key).toHaveProperty(key);
    }
    for (const s of recorder.statements) expect(s.sql).not.toMatch(/synced_at\s*>/);
  });

  it("keeps the existing enabled and q selectors exact without the new key", async () => {
    const enabled = await page("?enabled=true");
    expect(ids(enabled.body)).toEqual([1, 2, 4, 5, 7, 8]);
    const searched = await page("?q=needle");
    expect(ids(searched.body)).toEqual([2, 4, 6]);
  });

  it("other snapshot lists keep ignoring the unknown name (container list only)", async () => {
    const customers = await statusFor("/api/v1/customer-snapshot", { syncedSince: T0 });
    expect(customers.status).toBe(200);
    expect(customers.body.rows?.map((r) => r.customer_id)).toEqual([11, 22, 33, 44]);
    const addresses = await statusFor("/api/v1/address-snapshot", { syncedSince: T0 });
    expect(addresses.status).toBe(200);
    expect(addresses.body.rows?.map((r) => r.pickup_address_id)).toEqual([101, 102, 103, 104, 105, 106, 107, 108]);
  });
});

describe("RED: route SQL binds the normalized strict predicate", () => {
  it("adds a bound synced_at > predicate to COUNT and page, never the literal text", async () => {
    const { recorder } = await page("?syncedSince=2026-09-01T00:00:00.5Z");
    expect(recorder.statements).toHaveLength(2);
    for (const s of recorder.statements) {
      expect(s.sql).toMatch(/synced_at\s*>\s*\?/);
      expect(s.sql).not.toContain("2026-");
      expect(s.binds).toContain(HALF);
      expect(s.binds).not.toContain("2026-09-01T00:00:00.5Z");
    }
  });

  it("keeps the predicate on the count-free page with zero COUNT statements", async () => {
    const { recorder } = await page(`?syncedSince=${T0}&includeTotal=false`);
    expect(recorder.statements).toHaveLength(1);
    expect(recorder.statements.filter(isCount)).toEqual([]);
    expect(recorder.statements[0].sql).toMatch(/synced_at\s*>\s*\?/);
    expect(recorder.statements[0].binds).toContain(T0);
  });

  it("keeps the predicate on the customer-join path without multiplying rows", async () => {
    const { body, recorder } = await page(`?customerId=11&syncedSince=${T0}`);
    expect(recorder.statements[0].sql).toMatch(/INNER JOIN address_snapshot/i);
    for (const s of recorder.statements) expect(s.sql).toMatch(/synced_at\s*>\s*\?/);
    expect(ids(body)).toEqual([2]);
    expect(body.total).toBe(1);
  });

  it("produces a synthetic EXPLAIN plan from the actual recorded statements", async () => {
    // Recorded local shape only; production latency is never claimed from this.
    const { recorder } = await page(`?syncedSince=${T0}&limit=2`);
    for (const s of recorder.statements) {
      expect(s.sql).toMatch(/synced_at\s*>\s*\?/);
      const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${s.sql}`)
        .bind(...s.binds)
        .all<{ detail: string }>();
      expect((plan.results ?? []).length, s.sql).toBeGreaterThan(0);
    }
  });
});

describe("RED: served OpenAPI declares the selector", () => {
  type Param = {
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    example?: unknown;
    schema?: { type?: unknown; pattern?: unknown; example?: unknown; description?: string };
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

  it("declares syncedSince once, optional, with the since pattern and a replayable example", async () => {
    const doc = await openApi();
    const op = doc.paths[PATH]?.get;
    expect(op).toBeDefined();
    const params = (op!.parameters ?? []).filter((p) => p.name === "syncedSince");
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({
      in: "query",
      required: false,
      schema: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?Z$" }
    });
    expect(params[0].schema).not.toHaveProperty("format");
    const prose = `${params[0].description ?? ""} ${params[0].schema?.description ?? ""}`;
    expect(prose).toMatch(/synced_at|stored/i);
    expect(prose).toMatch(/strictly|after|greater/i);
    expect(prose).toMatch(/UTC/);
    expect(prose).toMatch(/millisecond/i);
    const example = params[0].example ?? params[0].schema?.example;
    expect(typeof example).toBe("string");
    const { body } = await page(`?syncedSince=${encodeURIComponent(String(example))}`);
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it("keeps the stable operation identity, read access and documented 400", async () => {
    const doc = await openApi();
    const op = doc.paths[PATH]?.get;
    expect(op?.operationId).toBe("listContainerSnapshot");
    expect(op?.["x-access"]).toBe("read");
    expect(op?.responses?.["400"]?.description ?? "").toMatch(/syncedSince/);
  });

  it("does not add the selector to other lists, the changes feed or single-row reads", async () => {
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
      expect(names, path).not.toContain("syncedSince");
    }
  });
});

describe("RED: query-policy inventory lists the selector", () => {
  const row = (path: string) =>
    policyDoc.split("\n").find((line) => line.startsWith(`| \`${path}\` |`)) ?? "";

  it("names syncedSince on the container list row, still ignoring unknown names", () => {
    expect(row(PATH)).toContain("`syncedSince`");
    expect(row(PATH)).toMatch(/\| Ignore by default; reject when strictQuery=true \|/);
  });

  it("leaves the customer/address/changes rows without the selector", () => {
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/address-snapshot", "/api/v1/customer-snapshot/changes"]) {
      expect(row(path), path).not.toContain("syncedSince");
    }
  });

  it("documents strict-greater stored-value selection with unchanged container_id keyset", () => {
    const guidance = policyDoc.split(/^#{1,6} /m)
      .filter((section) => section.includes("syncedSince")).join("\n");
    expect(guidance).toMatch(/strict/i);
    expect(guidance).toContain("container_id");
  });

  it("cites this oracle file", () => {
    expect(policyDoc).toContain("test/containerSyncedSince.acceptance.test.ts");
  });
});
