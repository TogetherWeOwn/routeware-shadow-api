/// <reference types="vite/client" />

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent Test Author oracle, written against the spec, not implementation diffs.
 * Run: npx vitest run --maxWorkers=2 test/customerPhonePresence.acceptance.test.ts
 *
 * Hand-derived synthetic cohorts:
 *   phone1 present [59,61,97,103,109,127]; absent [11,23,37,41,73,89]
 *   phone2 present [73,89,97,103,109]; absent [11,23,37,41,59,61,127]
 *   both present [97,103,109]; primary only [59,61,127]; secondary only [73,89];
 *   neither [11,23,37,41], covering null/null, empty/null, null/empty, empty/empty.
 * Whitespace (61,89,109), non-number text (103) and literal "0" (103,127) are
 * present. No trimming, number validation, consent or reachability is inferred.
 *
 * Mutations caught: ignored/swapped slots; OR instead of AND; SQL null trap in
 * the complement; trim/normalization/truthiness; dropped existing predicates;
 * COUNT/page divergence; extra payload/COUNT/lookahead work; dropped next-link
 * selectors; pre-auth validation; duplicate acceptance; input reflection; and
 * ETags belonging to a different served representation.
 *
 * Real migrated local D1 only. Network, browser, R2 and all handler writes are
 * denied and observed. No index/migration or latency guarantee is assumed.
 * Intentional RED handoff: Builder consumes this commit without editing tests.
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/customer-snapshot";
const ORIGIN = "https://phone-presence.invalid";
const STAMP = "2026-01-01T00:00:00.000Z";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
type Query = Record<string, string>;
type Body = { rows: Record<string, unknown>[]; total: number | null; nextCursor: number | null };
type Read = { sql: string; binds: unknown[]; method: string };
type Fixture = readonly [number, string | null, string | null, number, string, string, string, string];
const FIXTURES: readonly Fixture[] = [
  [11, null, null, 1, "North Synthetic", "A+& 001", "North/one", "dispatch"],
  [23, "", null, 0, "North Synthetic", "A+& 001", "South", "hold"],
  [37, null, "", 1, "South Synthetic", "B", "North/one", "other"],
  [41, "", "", 0, "North Synthetic", "A+& 001", "North/one", "dispatch"],
  [59, "5550107", null, 1, "North Synthetic", "A+& 001", "North/one", "dispatch"],
  [61, " \t\r\n ", "", 0, "North Synthetic", "A+& 001", "South", "dispatch"],
  [73, null, "desk 5550107 ext 9", 0, "North Synthetic", "A+& 001", "North/one", "dispatch"],
  [89, "", "  ", 1, "South Synthetic", "B", "North/one", "hold"],
  [97, "backup 5550107", "main 5550107", 1, "North Synthetic", "A+& 001", "North/one", "dispatch"],
  [103, "not-a-number", "0", 0, "North Synthetic", "A+& 001", "South", "hold"],
  [109, " ", " ", 1, "South Synthetic", "B", "North/one", "dispatch"],
  [127, "0", "", 1, "South Synthetic", "B", "South", "hold"]
];
const ALL = [11, 23, 37, 41, 59, 61, 73, 89, 97, 103, 109, 127];
const MATRIX: Array<[string, string, number[]]> = [
  ["true", "true", [97, 103, 109]], ["true", "false", [59, 61, 127]],
  ["false", "true", [73, 89]], ["false", "false", [11, 23, 37, 41]],
  ["true", "any", [59, 61, 97, 103, 109, 127]],
  ["false", "any", [11, 23, 37, 41, 73, 89]],
  ["any", "true", [73, 89, 97, 103, 109]],
  ["any", "false", [11, 23, 37, 41, 59, 61, 127]], ["any", "any", ALL]
];
const isCount = (read: Read) => /\bCOUNT\s*\(/i.test(read.sql);
const ids = (body: Body) => body.rows.map((row) => row.customer_id);
const recorders: ReturnType<typeof recordDb>[] = [];
const external = vi.fn(() => { throw new Error("Phone presence must not access network, browser or R2"); });
const deniedR2 = new Proxy({} as R2Bucket, { get() { return external; } });
let beforeState: unknown;

function recordDb() {
  const prepared: string[] = [];
  const reads: Read[] = [];
  const violations: string[] = [];
  function fail(message: string): never { violations.push(message); throw new Error(message); }
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return new Proxy(stmt, {
      get(target, key) {
        if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql, args);
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          reads.push({ sql, binds, method: String(key) });
          if (!/^[\s]*SELECT\b/i.test(sql) || !["first", "all", "raw"].includes(String(key))) fail("Non-read D1 execution");
          return Reflect.apply(value, target, args);
        };
      }
    });
  }
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      if (!/^\s*SELECT\b/i.test(sql)) fail("Non-read D1 prepare");
      return wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []);
    },
    batch() { return fail("Unexpected batched D1 work"); },
    exec() { return fail("Unexpected unbound D1 work"); },
    withSession() { return fail("Unexpected alternate D1 session"); }
  } as unknown as D1Database;
  return { db, prepared, reads, violations };
}

async function state() {
  const db = TEST_ENV.CUSTOMER_DB;
  const results = await Promise.all([
    ...["customer_snapshot", "address_snapshot", "container_snapshot"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()
  ]);
  return results.map((result) => result.results);
}

async function request(query: Query | string | URL = {}, options: { token?: string | null; tag?: string } = {}) {
  const url = query instanceof URL ? query : new URL(PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = typeof query === "string" ? query : new URLSearchParams(query).toString();
  const headers = new Headers();
  const token = options.token === undefined ? "test-read-token" : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  if (options.tag !== undefined) headers.set("if-none-match", options.tag);
  const recorder = recordDb();
  recorders.push(recorder);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: recorder.db, SNAPSHOTS: deniedR2, BROWSER: { fetch: external } as unknown as Fetcher
  });
  return { response, recorder, url };
}
async function etag(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
}
async function page(query: Query | string | URL = {}) {
  const result = await request(query);
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  expect(result.response.headers.get("content-type")).toContain("application/json");
  const bytes = await result.response.text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  expect(result.response.headers.get("etag")).toBe(await etag(bytes));
  const countOnly = result.url.searchParams.get("countOnly") === "true";
  const counted = result.url.searchParams.get("includeTotal") !== "false";
  expect(result.recorder.reads.filter(isCount)).toHaveLength(counted ? 1 : 0);
  expect(result.recorder.reads.filter((read) => !isCount(read))).toHaveLength(countOnly ? 0 : 1);
  if (!counted) expect(body.total).toBeNull();
  if (countOnly) {
    expect(body.rows).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.recorder.reads[0].sql).toMatch(/^\s*SELECT\s+COUNT\s*\([^)]*\)\s*(?:AS\s+\w+)?\s+FROM\b/i);
    expect(result.recorder.reads[0].sql).not.toMatch(/\bLIMIT\b|\bOFFSET\b/i);
  }
  for (const read of result.recorder.reads) {
    expect(read.sql).not.toMatch(/\bcontainer_snapshot\b/i);
    if (!["true", "false"].includes(result.url.searchParams.get("hasAddresses") ?? "")) {
      expect(read.sql).not.toMatch(/\baddress_snapshot\b/i);
    }
  }
  return { ...result, bytes, body };
}
function expectPage(result: Awaited<ReturnType<typeof page>>, want: number[], total: number | null, next: number | null = null) {
  expect(ids(result.body)).toEqual(want);
  expect(result.body.total).toBe(total);
  expect(result.body.nextCursor).toBe(next);
  if (next === null) expect(result.response.headers.get("link")).toBeNull();
}
function next(result: Awaited<ReturnType<typeof page>>, expected: Query) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/customer-snapshot\?[^<>\s]*>; rel="next"$/);
  const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(target.origin).toBe(ORIGIN);
  expect(target.pathname).toBe(PATH);
  expect(target.hash + target.username + target.password).toBe("");
  expect(target.searchParams.has("offset")).toBe(false);
  const actual = new URLSearchParams(target.search);
  // Only established defaults may be elided; effective presence is never lost.
  for (const [key, value] of Object.entries(expected)) {
    if ((key === "includeTotal" && value === "true") || (key === "enabled" && value === "any")) {
      expect([null, value]).toContain(actual.get(key));
      expect(actual.getAll(key).length).toBeLessThanOrEqual(1);
      actual.delete(key);
    } else expect(actual.getAll(key), key).toEqual([value]);
  }
  expect([...actual.keys()].every((key) => Object.hasOwn(expected, key))).toBe(true);
  return target;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  recorders.length = 0;
  external.mockClear();
  vi.stubGlobal("fetch", external);
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot")]);
  await db.batch([...FIXTURES].reverse().map(([id, phone1, phone2, enabled, company, account, sub, comments]) =>
    db.prepare("INSERT INTO customer_snapshot (customer_id, phone1, phone2, enabled, company_name, customer_number, sub_customer_number, comments, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, phone1, phone2, enabled, company, account, sub, comments, STAMP)
  ));
  for (const [id, owner, enabled] of [[201, 23, 1], [202, 41, 0], [203, 59, 1], [204, 59, 0], [205, 89, 1], [206, 97, 0]]) {
    await db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, 'Synthetic site', ?, ?)")
      .bind(id, owner, enabled, STAMP).run();
  }
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(external).not.toHaveBeenCalled();
    for (const recorder of recorders) expect(recorder.violations).toEqual([]);
    expect(await state(), "GET must not mutate rows or schema").toEqual(beforeState);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe("stored phone-slot presence and list-mode budgets", () => {
  it.each(MATRIX)("hasPhone1=%s AND hasPhone2=%s", async (hasPhone1, hasPhone2, want) => {
    const filters = { hasPhone1, hasPhone2 };
    const counted = await page(filters);
    expectPage(counted, want, want.length);
    const free = await page({ ...filters, includeTotal: "false" });
    expectPage(free, want, null);
    expect(free.recorder.reads).toEqual(counted.recorder.reads.filter((read) => !isCount(read)));
    const only = await page({ ...filters, countOnly: "true", limit: "1", offset: "999", fields: "enabled" });
    expectPage(only, [], want.length);
    expect(only.recorder.reads).toEqual(counted.recorder.reads.filter(isCount));
  });

  it.each<Query>([{}, { hasPhone1: "any" }, { hasPhone2: "any" }, { hasPhone1: "any", hasPhone2: "any" }])("omitted/any adds no predicate (%j)", async (query) => {
    for (const mode of [{}, { includeTotal: "false" }, { countOnly: "true" }] as Query[]) {
      const baseline = await page(mode);
      const explicit = await page({ ...mode, ...query });
      expectPage(baseline, mode.countOnly ? [] : ALL, mode.includeTotal === "false" ? null : 12);
      expect(explicit.bytes).toBe(baseline.bytes);
      expect(explicit.recorder.reads).toEqual(baseline.recorder.reads);
    }
  });

  it("accepts each selector alone; whitespace, non-number text and zero remain present", async () => {
    expectPage(await page({ hasPhone1: "true" }), [59, 61, 97, 103, 109, 127], 6);
    expectPage(await page({ hasPhone2: "false" }), [11, 23, 37, 41, 59, 61, 127], 7);
    const sparse = await page({ hasPhone1: "true", ids: "61,103,109,127", fields: "phone1,phone2" });
    expect(sparse.body.rows).toEqual([
      { customer_id: 61, phone1: " \t\r\n ", phone2: "" },
      { customer_id: 103, phone1: "not-a-number", phone2: "0" },
      { customer_id: 109, phone1: " ", phone2: " " },
      { customer_id: 127, phone1: "0", phone2: "" }
    ]);
    expectPage(await page({ hasPhone2: "true", customerId: "89" }), [89], 1);
  });

  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("retains read-capable role %s", async (token) => {
    const result = await request({ hasPhone1: "false", hasPhone2: "true" }, { token });
    expect(result.response.status).toBe(200);
    expect(ids(await result.response.json() as Body)).toEqual([73, 89]);
  });

  it("repeated successful reads are idempotent and do not log stored-phone fragments", async () => {
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
    const query = { hasPhone1: "false", hasPhone2: "true", phone: "5550107", fields: "enabled" };
    const first = await page(query);
    const again = await page(query);
    expectPage(first, [73], 1);
    expect(again.bytes).toBe(first.bytes);
    expect(again.recorder.reads).toEqual(first.recorder.reads);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("an empty local table has total zero, not null", async () => {
    const db = TEST_ENV.CUSTOMER_DB;
    await db.batch([db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot")]);
    beforeState = await state();
    expectPage(await page({ hasPhone1: "false", hasPhone2: "false", countOnly: "true" }), [], 0);
  });
});

const INTERSECTIONS: Array<[string, Query, number[]]> = [
  ["primary-only enabled", { hasPhone1: "true", hasPhone2: "false", enabled: "true" }, [59, 127]],
  ["primary-only disabled whitespace", { hasPhone1: "true", hasPhone2: "false", enabled: "false" }, [61]],
  ["secondary-only enabled", { hasPhone1: "false", hasPhone2: "true", enabled: "true" }, [89]],
  ["secondary-only disabled", { hasPhone1: "false", hasPhone2: "true", enabled: "false" }, [73]],
  ["both present disabled", { hasPhone1: "true", hasPhone2: "true", enabled: "false" }, [103]],
  ["neither enabled", { hasPhone1: "false", hasPhone2: "false", enabled: "true" }, [11, 37]],
  ["primary-only ids", { hasPhone1: "true", hasPhone2: "false", ids: "11,59,61,73,97" }, [59, 61]],
  ["secondary-only id", { hasPhone1: "false", hasPhone2: "true", customerId: "73" }, [73]],
  ["nonmatching id", { hasPhone1: "true", hasPhone2: "false", customerId: "73" }, []],
  ["nonmatching ids", { hasPhone1: "false", hasPhone2: "false", ids: "59,73,97" }, []],
  ["company substring", { hasPhone1: "false", hasPhone2: "true", q: "north" }, [73]],
  ["no company match cannot escape via phone2", { hasPhone1: "false", hasPhone2: "true", q: "absent-company", phone: "5550107" }, []],
  ["opaque exact account", { hasPhone1: "true", hasPhone2: "false", customerNumber: "A+& 001" }, [59, 61]],
  ["exact sub-account", { hasPhone1: "true", hasPhone2: "false", subCustomerNumber: "North/one" }, [59]],
  ["case-sensitive account conflict", { hasPhone1: "false", hasPhone2: "true", subCustomerNumber: "north/one" }, []],
  ["comments", { hasPhone1: "true", hasPhone2: "true", comments: "dispatch" }, [97, 109]],
  ["primary-only fragment", { hasPhone1: "true", hasPhone2: "false", phone: "5550107" }, [59]],
  ["secondary-only fragment", { hasPhone1: "false", hasPhone2: "true", phone: "5550107" }, [73]],
  ["both-phone fragment deduplicated", { hasPhone1: "true", hasPhone2: "true", phone: "5550107" }, [97]],
  ["neither cannot match fragment", { hasPhone1: "false", hasPhone2: "false", phone: "5550107" }, []],
  ["child presence", { hasPhone1: "false", hasPhone2: "false", hasAddresses: "true" }, [23, 41]],
  ["child absence", { hasPhone1: "false", hasPhone2: "true", hasAddresses: "false" }, [73]],
  ["all filters", { hasPhone1: "true", hasPhone2: "false", hasAddresses: "true", ids: "11,59,61,73,97", customerId: "59", customerNumber: "A+& 001", subCustomerNumber: "North/one", q: "north", phone: "5550107", comments: "dispatch", enabled: "true", upperId: "59", strictQuery: "true" }, [59]],
  ["all-filter conflict", { hasPhone1: "true", hasPhone2: "false", hasAddresses: "false", ids: "11,59,61,73,97", customerId: "59", phone: "5550107" }, []]
];
describe("phone presence AND-composes with existing customer selectors", () => {
  it.each(INTERSECTIONS)("%s scopes rows, total and countOnly identically", async (_label, filters, want) => {
    const counted = await page(filters);
    expectPage(counted, want, want.length);
    // Child EXISTS is needed only when explicitly selected, never to infer phone presence.
    const only = await page({ ...filters, countOnly: "true" });
    expectPage(only, [], want.length);
    expect(only.recorder.reads).toEqual(counted.recorder.reads.filter(isCount));
    expectPage(await page({ ...filters, includeTotal: "false" }), want, null);
  });
});

describe("presence preserves seek, projection and relative continuation", () => {
  it.each([
    ["asc seek", { cursor: "59", limit: "2" }, [61, 127], 2, 127],
    ["desc seek", { order: "desc", cursor: "127", limit: "2" }, [61, 59], 2, 59],
    ["cursor wins", { cursor: "59", offset: "999", limit: "3" }, [61, 127], 2, null],
    ["offset page", { offset: "1", limit: "2" }, [61, 127], 3, 127],
    ["empty offset retains cohort total", { offset: "99", limit: "2" }, [], 3, null],
    ["inclusive upperId", { upperId: "61" }, [59, 61], 2, null],
    ["descending upper and cursor", { order: "desc", cursor: "61", upperId: "59" }, [59], 1, null],
    ["contradictory bound", { cursor: "61", upperId: "59" }, [], 0, null]
  ] as Array<[string, Query, number[], number, number | null]>)("%s", async (_label, query, want, total, cursor) => {
    const filters = { hasPhone1: "true", hasPhone2: "false", ...query };
    expectPage(await page(filters), want, total, cursor);
    expectPage(await page({ ...filters, includeTotal: "false" }), want, null, cursor);
    expectPage(await page({ ...filters, countOnly: "true" }), [], total);
  });

  it("count-free and counted page use exactly the requested LIMIT, not LIMIT+1", async () => {
    const filters = { hasPhone1: "true", hasPhone2: "false", limit: "2", cursor: "41" };
    const counted = await page(filters);
    const free = await page({ ...filters, includeTotal: "false" });
    expectPage(counted, [59, 61], 3, 61);
    expectPage(free, [59, 61], null, 61);
    expect(free.recorder.reads).toEqual(counted.recorder.reads.filter((read) => !isCount(read)));
    expect(free.recorder.reads[0].binds.at(-1)).toBe(2);
    expect(free.recorder.reads[0].sql).not.toMatch(/\bOFFSET\b/i);
  });

  it.each(["asc", "desc"])("follows both effective flags on every %s page", async (order) => {
    const filters = { hasPhone1: "true", hasPhone2: "false", limit: "1", includeTotal: "false", order, fields: "enabled", upperId: "127", strictQuery: "true" };
    const want = order === "asc" ? [59, 61, 127] : [127, 61, 59];
    let current = await page(filters);
    const seen: unknown[] = [];
    for (let i = 0; i <= want.length; i++) {
      expectPage(current, i < want.length ? [want[i]] : [], null, want[i] ?? null);
      for (const row of current.body.rows) expect(Object.keys(row).sort()).toEqual(["customer_id", "enabled"]);
      seen.push(...ids(current.body));
      if (i < want.length) current = await page(next(current, { ...filters, cursor: String(want[i]) }));
    }
    expect(seen).toEqual(want);
  });

  it("counted links retain cursor-relative totals through a full last page", async () => {
    const filters = { hasPhone1: "false", hasPhone2: "true", limit: "1" };
    let current = await page(filters);
    for (const [want, total, cursor] of [[[73], 2, 73], [[89], 1, 89], [[], 0, null]] as Array<[number[], number, number | null]>) {
      expectPage(current, want, total, cursor);
      if (cursor !== null) current = await page(next(current, { ...filters, cursor: String(cursor) }));
    }
  });

  it.each<Query>([{}, { hasPhone1: "any" }, { hasPhone2: "any" }, { hasPhone1: "any", hasPhone2: "any" }])("omits any/default from next links (%j)", async (query) => {
    const first = await page({ ...query, limit: "11", includeTotal: "false" });
    expectPage(first, [11, 23, 37, 41, 59, 61, 73, 89, 97, 103, 109], null, 109);
    const target = next(first, { limit: "11", includeTotal: "false", cursor: "109" });
    expect(target.searchParams.has("hasPhone1")).toBe(false);
    expect(target.searchParams.has("hasPhone2")).toBe(false);
    expectPage(await page(target), [127], null);
  });

  it.each([
    [{ hasPhone1: "true", hasPhone2: "any" }, { hasPhone1: "true" }, 59],
    [{ hasPhone1: "any", hasPhone2: "false" }, { hasPhone2: "false" }, 11]
  ] as Array<[Query, Query, number]>)("drops only the default flag (%j)", async (query, effective, id) => {
    const first = await page({ ...query, limit: "1" });
    const target = next(first, { ...effective, limit: "1", cursor: String(id) });
    expect((await page(target)).body.rows.length).toBe(1);
  });

  it("round-trips encoded intersections and strips unknown names/values and offset", async () => {
    const filters = { hasPhone1: "true", hasPhone2: "false", ids: "11,59,61,73,97", customerId: "59", customerNumber: "A+& 001", subCustomerNumber: "North/one", q: "north", comments: "dispatch", phone: "5550107", enabled: "true", hasAddresses: "true", fields: "enabled", upperId: "59", order: "desc", includeTotal: "false", limit: "1" };
    const clean = await page(filters);
    const tainted = await page({ ...filters, offset: "0", "unknown-name-marker": "unknown-value-marker", token: "query-credential-marker", url: "https://redirect-marker.invalid" });
    expectPage(tainted, [59], null, 59);
    expect(tainted.bytes).toBe(clean.bytes);
    const target = next(tainted, { ...filters, cursor: "59" });
    expect(tainted.response.headers.get("link")).not.toMatch(/marker|Bearer|test-read-token|https?:|\/\//);
    expectPage(await page(target), [], null);
  });
});

describe("presence conditional representations", () => {
  it.each<Query>([
    { hasPhone1: "true", hasPhone2: "false", fields: "enabled", limit: "2", includeTotal: "false" },
    { hasPhone1: "false", hasPhone2: "true", fields: "phone1", limit: "1" },
    { hasPhone1: "false", hasPhone2: "false", countOnly: "true" }
  ])("hashes served bytes and replays bodyless 304 (%j)", async (query) => {
    const first = await page(query);
    for (const tag of [first.response.headers.get("etag")!, `W/${first.response.headers.get("etag")}`, "*"]) {
      const replay = await request(query, { tag });
      expect(replay.response.status).toBe(304);
      expect(replay.response.body).toBeNull();
      expect(await replay.response.text()).toBe("");
      expect(replay.response.headers.get("etag")).toBe(first.response.headers.get("etag"));
      expect(replay.response.headers.get("link")).toBe(first.response.headers.get("link"));
      expect(replay.response.headers.get("cache-control")).toBe("no-store");
      expect(replay.recorder.reads).toEqual(first.recorder.reads);
    }
  });

  it.each<Query>([
    { hasPhone1: "false", hasPhone2: "true", fields: "enabled", limit: "2", includeTotal: "false" },
    { hasPhone1: "true", hasPhone2: "false", fields: "phone1", limit: "2", includeTotal: "false" },
    { hasPhone1: "true", hasPhone2: "false", fields: "enabled", limit: "2" },
    { hasPhone1: "true", hasPhone2: "false", fields: "enabled", limit: "2", includeTotal: "false", cursor: "61" },
    { hasPhone1: "true", hasPhone2: "false", countOnly: "true" }
  ])("does not reuse a different representation's validator (%j)", async (query) => {
    const first = await page({ hasPhone1: "true", hasPhone2: "false", fields: "enabled", limit: "2", includeTotal: "false" });
    const changed = await request(query, { tag: first.response.headers.get("etag")! });
    expect(changed.response.status).toBe(200);
    expect(changed.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
    expect(await changed.response.text()).not.toBe(first.bytes);
  });
});

async function rejected(search: string) {
  const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
  const result = await request(search, { tag: "*" });
  expect.soft(result.response.status).toBe(400);
  expect.soft(result.recorder.prepared).toEqual([]);
  expect.soft(result.recorder.reads).toEqual([]);
  expect(result.response.headers.get("content-type") ?? "").toContain("application/problem+json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  expect(result.response.headers.get("link")).toBeNull();
  expect(result.response.headers.get("etag")).toBeNull();
  const body = await result.response.json() as Record<string, unknown>;
  expect(body).toMatchObject({ type: BAD_REQUEST, title: "Bad Request", status: 400 });
  expect(Object.keys(body).sort()).toEqual(["detail", "status", "title", "type"]);
  const text = JSON.stringify(body);
  expect(text).not.toMatch(/private-phone-marker|unknown-name-marker|unknown-value-marker|TRUE|False|ANY|%20|%2C/);
  for (const log of logs) expect(log).not.toHaveBeenCalled();
  return body.detail;
}

describe.each(["hasPhone1", "hasPhone2"])("%s validation before SQL/304, after auth", (key) => {
  it.each(["", "TRUE", "False", "ANY", "1", "0", "yes", "null", " true", "false ", "\t", "  ", "true,false", "private-phone-marker"])("rejects invalid value %j with fixed next action", async (value) => {
    const detail = await rejected(new URLSearchParams({ [key]: value, phone: "private-phone-marker", "unknown-name-marker": "unknown-value-marker" }).toString());
    expect(detail).toEqual(expect.any(String));
    expect(String(detail)).toContain(key);
    expect(String(detail)).toMatch(/true[\s\S]*false[\s\S]*any/);
    expect(String(detail)).toMatch(/once|one|single/i);
    expect(String(detail)).toMatch(/omit/i);
    expect(String(detail)).toMatch(/retry/i);
  });

  it("rejects bare key and percent-encoded duplicates, never choosing first or last", async () => {
    await rejected(key);
    const encoded = `%68${key.slice(1)}`;
    for (const [first, last] of [["true", "true"], ["false", "true"], ["any", "any"], ["", "false"], ["true", ""]]) {
      await rejected(`${key}=${first}&${encoded}=${last}`);
    }
  });

  it("invalid peer selector cannot be hidden by an empty cohort or count-only mode", async () => {
    const peer = key === "hasPhone1" ? "hasPhone2" : "hasPhone1";
    await rejected(`${key}=private-phone-marker&${peer}=false&customerId=999&countOnly=true`);
    await rejected(`${key}=false&${peer}=false&countOnly=true&includeTotal=false`);
  });

  it.each([null, "invalid-token"])("unauthorized token %s does no SQL even on invalid input", async (token) => {
    for (const search of [`${key}=true`, `${key}=private-phone-marker`, `${key}=true&${key}=false`]) {
      const result = await request(search, { token, tag: "*" });
      expect(result.response.status).toBe(401);
      expect(result.recorder.prepared).toEqual([]);
      expect(result.response.headers.get("etag")).toBeNull();
      expect(result.response.headers.get("link")).toBeNull();
      expect(result.response.headers.get("cache-control")).toBe("no-store");
      expect(await result.response.text()).not.toContain("private-phone-marker");
    }
  });
});

it("strictQuery accepts supported flags and rejects unknown names without reflecting them", async () => {
  expectPage(await page({ hasPhone1: "false", hasPhone2: "true", strictQuery: "true" }), [73, 89], 2);
  await rejected("hasPhone1=false&hasPhone2=true&strictQuery=true&unknown-name-marker=unknown-value-marker");
});

it("records executable synthetic EXPLAIN evidence without an index or latency promise", async () => {
  // Independent specification SQL validates the fixture/null-complement oracle,
  // not a prescription for the Builder's SQL spelling or optimizer choice.
  for (const [predicate, want] of [
    ["phone1 IS NOT NULL AND phone1 <> '' AND (phone2 IS NULL OR phone2 = '')", [59, 61, 127]],
    ["(phone1 IS NULL OR phone1 = '') AND phone2 IS NOT NULL AND phone2 <> ''", [73, 89]],
    ["(phone1 IS NULL OR phone1 = '') AND (phone2 IS NULL OR phone2 = '')", [11, 23, 37, 41]]
  ] as Array<[string, number[]]>) {
    const sql = `SELECT customer_id FROM customer_snapshot WHERE ${predicate} ORDER BY customer_id`;
    const rows = await TEST_ENV.CUSTOMER_DB.prepare(sql).all<{ customer_id: number }>();
    expect(rows.results.map((row) => row.customer_id)).toEqual(want);
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>();
    expect(plan.results.some((row) => /\bSCAN\b/i.test(row.detail))).toBe(true);
  }
  const selective = await TEST_ENV.CUSTOMER_DB.prepare("EXPLAIN QUERY PLAN SELECT customer_id FROM customer_snapshot WHERE customer_id = ? AND phone1 IS NOT NULL AND phone1 <> '' AND (phone2 IS NULL OR phone2 = '')")
    .bind(59).all<{ detail: string }>();
  expect(selective.results.some((row) => /SEARCH customer_snapshot USING INTEGER PRIMARY KEY/i.test(row.detail))).toBe(true);
});

type Parameter = { name: string; in: string; required?: boolean; description?: string; example?: unknown; schema?: { description?: string; example?: unknown; [key: string]: unknown } };
type Operation = { operationId?: string; parameters?: Parameter[]; responses?: Record<string, { description?: string }>; [key: string]: unknown };
async function document() {
  const result = await request(new URL("/openapi.json", ORIGIN), { token: null });
  expect(result.response.status).toBe(200);
  expect(result.recorder.prepared).toEqual([]);
  return await result.response.json() as { paths: Record<string, { get?: Operation; post?: Operation }> };
}

describe("mounted phone presence discovery", () => {
  it("replays the documented neither-slot count-only recipe without retrieving phone payloads", async () => {
    // Consume an actual documented request, not a prose/format snapshot. Only
    // the local app is invoked; no shell command or documented host is contacted.
    const urls = [...quickstartDoc.matchAll(/\/api\/v1\/customer-snapshot\?([^\s"'<>`]+)/g)]
      .map((match) => new URL(`${PATH}?${match[1]}`, ORIGIN));
    const recipe = urls.find((url) => url.searchParams.get("hasPhone1") === "false"
      && url.searchParams.get("hasPhone2") === "false" && url.searchParams.get("countOnly") === "true");
    expect(recipe, "Document a compact countOnly=true&hasPhone1=false&hasPhone2=false request").toBeDefined();
    expectPage(await page(recipe!), [], 4);
  });

  it.each(["hasPhone1", "hasPhone2"])("publishes optional enum/default and replayable %s example", async (key) => {
    const operation = (await document()).paths[PATH].get!;
    expect(operation).toMatchObject({ operationId: "listCustomerSnapshot", "x-access": "read", "x-effect": "local-read" });
    const matches = operation.parameters?.filter((p) => p.in === "query" && p.name === key) ?? [];
    expect(matches).toHaveLength(1);
    const parameter = matches[0];
    expect(parameter).toMatchObject({ required: false, schema: { type: "string", enum: ["true", "false", "any"], default: "any" } });
    const prose = `${parameter.description ?? ""} ${parameter.schema?.description ?? ""}`;
    expect(prose).toMatch(/stored/i);
    expect(prose).toMatch(/null/i);
    expect(prose).toMatch(/empty/i);
    expect(prose).toMatch(/whitespace/i);
    const example = parameter.example ?? parameter.schema?.example;
    expect(["true", "false", "any"]).toContain(example);
    const cohort = key === "hasPhone1"
      ? example === "true" ? [59, 61, 97, 103, 109, 127] : example === "false" ? [11, 23, 37, 41, 73, 89] : ALL
      : example === "true" ? [73, 89, 97, 103, 109] : example === "false" ? [11, 23, 37, 41, 59, 61, 127] : ALL;
    expectPage(await page({ [key]: String(example) }), cohort, cohort.length);
    expect(operation.responses?.["400"]?.description).toContain(key);
  });

  it("query inventory matches mounted discovery; flags belong only on this list GET", async () => {
    const doc = await document();
    const row = policyDoc.split("\n").find((line) => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    const inventory = [...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort();
    expect(inventory).toEqual(expect.arrayContaining(["hasPhone1", "hasPhone2"]));
    const published = (doc.paths[PATH].get!.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name).sort();
    expect(inventory).toEqual(published);
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (path === PATH && method === "get") continue;
        const keys = (operation.parameters ?? []).filter((p: Parameter) => p.in === "query").map((p: Parameter) => p.name);
        expect(keys, `${method} ${path}`).not.toContain("hasPhone1");
        expect(keys, `${method} ${path}`).not.toContain("hasPhone2");
      }
    }
  });
});
