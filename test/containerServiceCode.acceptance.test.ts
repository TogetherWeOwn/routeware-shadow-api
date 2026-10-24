/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";

// Test-Author-owned RED-first oracle; corrections require a separate bounded
// handoff. Run: NODE_ENV=development npx vitest run test/containerServiceCode.acceptance.test.ts
// Real local D1 evaluates emitted SQL. Literal expectations catch missing/wrong
// equality, normalization, OR composition, lost continuation and early cache hits.
const TEST_ENV = env as unknown as Env;
const ORIGIN = "https://service-code.test.invalid";
const PATH = "/api/v1/container-snapshot";
const CODE = "001Swap";
const SPECIAL = " 雪' OR 1=1 -- %_ &+/#?🚛 ";
const STAMP = "2026-01-02T03:04:05.000Z";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
type Query = Record<string, string> | URLSearchParams;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[]; method: string };
type Fixture = readonly [number, number, string | null, number, string, string, string];

// id, address, stored service_code, enabled, location, serial, RFID.
// 106 and 107 are explicit NULL/blank decoys; their type/input equal CODE.
const fixtures: readonly Fixture[] = [
  [101, 11, CODE, 1, "north depot", "SER-01", "RF-01"],
  [102, 11, CODE, 1, "south depot", "SER-01", "RF-02"],
  [103, 12, CODE, 0, "north depot", "SER-02", "RF-01"],
  [104, 21, CODE, 1, "north depot", "SER-01", "RF-01"],
  [105, 11, "OTHER", 1, "north depot", "SER-01", "RF-01"],
  [106, 11, null, 1, "north depot", "SER-01", "RF-01"],
  [107, 11, "", 1, "north depot", "SER-01", "RF-01"],
  [108, 11, "001swap", 1, "north depot", "SER-01", "RF-01"],
  [109, 11, "1Swap", 1, "north depot", "SER-01", "RF-01"],
  [110, 11, "x001Swapx", 1, "north depot", "SER-01", "RF-01"],
  [111, 11, " 001Swap ", 1, "north depot", "SER-01", "RF-01"],
  [112, 11, SPECIAL, 1, "north depot", "SER-01", "RF-01"],
  [113, 11, SPECIAL, 0, "north depot", "SER-01", "RF-01"],
  [114, 11, "é", 1, "north depot", "SER-01", "RF-01"],
  [115, 11, "é", 1, "north depot", "SER-01", "RF-01"],
  [116, 11, "🚛".repeat(100), 1, "north depot", "SER-01", "RF-01"],
  [117, 11, "A".repeat(100), 1, "north depot", "SER-01", "RF-01"],
  [118, 11, "0", 1, "north depot", "SER-01", "RF-01"],
  [119, 11, "🚛", 1, "north depot", "SER-01", "RF-01"],
  [120, 11, " \tcode\n ", 1, "north depot", "SER-01", "RF-01"],
  [121, 11, " \t\n ", 1, "north depot", "SER-01", "RF-01"],
  [122, 11, "null", 1, "north depot", "SER-01", "RF-01"],
  [Number.MAX_SAFE_INTEGER, 21, "UPPER-TAIL", 1, "north depot", "SER-MAX", "RF-MAX"],
];

const recorders: ReturnType<typeof recordDb>[] = [];
const denyExternal = vi.fn(() => { throw new Error("Service-code reads must not use network, browser or R2"); });
const forbiddenBucket = Object.fromEntries([
  "get", "head", "list", "put", "delete", "createMultipartUpload", "resumeMultipartUpload"
].map((method) => [method, denyExternal])) as unknown as R2Bucket;
let beforeState: unknown;
let requestNumber = 0;

function recordDb(real: D1Database) {
  const statements: Statement[] = [];
  const prepareCalls: string[] = [];
  const forbid = vi.fn(() => { throw new Error("Service-code reads must not mutate D1"); });
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    const observe = (method: string) => { statements.push({ sql, binds, method }); };
    return {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql, values),
      first: (...args: unknown[]) => {
        observe("first");
        return (stmt.first as (...a: unknown[]) => unknown)(...args);
      },
      all: () => { observe("all"); return stmt.all(); },
      raw: (...args: unknown[]) => {
        observe("raw");
        return (stmt.raw as (...a: unknown[]) => unknown)(...args);
      },
      run: forbid,
    } as unknown as D1PreparedStatement;
  }
  const db = {
    prepare: (sql: string) => {
      prepareCalls.push(sql);
      if (!/^\s*SELECT\b/i.test(sql)) return forbid();
      return wrap(real.prepare(sql), sql, []);
    },
    batch: forbid, exec: forbid,
  } as unknown as D1Database;
  return { db, statements, prepareCalls, forbid };
}

function forbiddenDb() {
  const forbid = vi.fn(() => { throw new Error("Rejected requests must not touch D1"); });
  return { db: { prepare: forbid, batch: forbid, exec: forbid } as unknown as D1Database, forbid };
}

async function state() {
  const db = TEST_ENV.CUSTOMER_DB;
  const results = await Promise.all([
    db.prepare("SELECT * FROM customer_snapshot ORDER BY customer_id").all(),
    db.prepare("SELECT * FROM address_snapshot ORDER BY pickup_address_id").all(),
    db.prepare("SELECT * FROM container_snapshot ORDER BY container_id").all(),
    db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
  ]);
  return results.map((result) => result.results);
}

async function request(query: Query | URL = {}, options: {
  token?: string | null; db?: D1Database; headers?: Record<string, string>; method?: string;
} = {}) {
  const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
  recorders.push(recorder);
  const url = query instanceof URL ? query : new URL(PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = new URLSearchParams(query).toString();
  const headers = new Headers({ "cf-connecting-ip": `192.0.2.${++requestNumber}`, ...options.headers });
  const token = options.token === undefined ? "test-read-token" : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(url, { headers, method: options.method }), {
    ...TEST_ENV,
    CUSTOMER_DB: options.db ?? recorder.db,
    SNAPSHOTS: forbiddenBucket,
    BROWSER: { fetch: denyExternal } as unknown as Fetcher,
  });
  return { response, recorder, url };
}

async function page(query: Query | URL = {}, token?: string) {
  const result = await request(query, { token });
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  const body = await result.response.json() as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const counted = result.url.searchParams.get("includeTotal") !== "false";
  expect(result.recorder.statements).toHaveLength(counted ? 2 : 1);
  expect(result.recorder.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(counted ? 1 : 0);
  if (!counted) expect(body.total).toBeNull();
  return { ...result, body };
}

const ids = (body: Body) => body.rows.map((row) => row.container_id);

function next(result: Awaited<ReturnType<typeof page>>) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/container-snapshot\?[^<>\s]*>; rel="next"$/);
  const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(target.origin).toBe(ORIGIN);
  expect(target.pathname).toBe(PATH);
  expect(target.hash).toBe("");
  expect(target.searchParams.has("offset")).toBe(false);
  expect(target.searchParams.getAll("cursor")).toEqual([String(result.body.nextCursor)]);
  for (const [key, value] of result.url.searchParams) {
    if (key === "cursor" || key === "offset" || key === "unrelated") continue;
    if ((key === "includeTotal" && value === "true") || (key === "enabled" && value === "any")) {
      expect([[], [value]]).toContainEqual(target.searchParams.getAll(key));
    } else expect(target.searchParams.getAll(key), key).toEqual([value]);
  }
  expect(target.searchParams.has("unrelated")).toBe(false);
  return target;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  recorders.length = 0;
  requestNumber = 0;
  denyExternal.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound network in service-code acceptance"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, synced_at) VALUES (1, 'Synthetic One', ?), (2, 'Synthetic Two', ?)").bind(STAMP, STAMP),
    db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, address, synced_at) VALUES (11, 1, 7, '001', 'Synthetic A', ?), (12, 1, 8, '002', 'Synthetic B', ?), (21, 2, 7, '001', 'Synthetic C', ?)").bind(STAMP, STAMP, STAMP),
  ]);
  await db.batch(fixtures.map(([id, address, code, enabled, location, serial, rfid]) =>
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, service_code, service_code_type, service_code_input, enabled, location_address, serial_number, rfid, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, address, code, code === CODE ? "unrelated-type" : CODE, code === CODE ? "unrelated-input" : CODE, enabled, location, serial, rfid, STAMP)
  ));
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denyExternal).not.toHaveBeenCalled();
    for (const recorder of recorders) {
      expect(recorder.forbid).not.toHaveBeenCalled();
      expect(recorder.statements.every((s) => /^\s*SELECT\b/i.test(s.sql))).toBe(true);
    }
    expect(await state(), "all requests must leave rows and schema unchanged").toEqual(beforeState);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe("serviceCode: exact stored opaque value", () => {
  it.each([
    ["duplicate matches include disabled and cross-customer containers", CODE, [101, 102, 103, 104]],
    ["case is significant", "001swap", [108]],
    ["leading zeros are not coerced", "1Swap", [109]],
    ["substrings are not equality", "x001Swapx", [110]],
    ["nonblank edge whitespace is data", " 001Swap ", [111]],
    ["SQL, URL delimiters and wildcards are literal", SPECIAL, [112, 113]],
    ["composed Unicode is not normalized", "é", [114]],
    ["decomposed Unicode is not normalized", "é", [115]],
    ["100 astral code points, not UTF-16 units", "🚛".repeat(100), [116]],
    ["100 ASCII code points", "A".repeat(100), [117]],
    ["one ASCII code point", "0", [118]],
    ["one astral code point", "🚛", [119]],
    ["nonblank tabs and newlines are preserved", " \tcode\n ", [120]],
    ["the literal null string is not SQL NULL", "null", [122]],
    ["percent and underscore are not wildcards", "%_", []],
    ["unknown code has an empty successful envelope", "synthetic-missing-code", []],
    ["service-code type and input are not fallbacks", "unrelated-type", []],
  ] as const)("%s", async (_name, serviceCode, expected) => {
    const result = await page({ serviceCode });
    expect(ids(result.body)).toEqual(expected);
    expect(result.body.total).toBe(expected.length);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  });

  it("omission preserves stored NULL, blank and full canonical rows", async () => {
    const implicit = await page();
    expect(ids(implicit.body)).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, Number.MAX_SAFE_INTEGER]);
    expect(implicit.body.total).toBe(23);
    expect(implicit.body.rows[0]).toMatchObject({ container_id: 101, pickup_address_id: 11, service_code: CODE, service_code_type: "unrelated-type", service_code_input: "unrelated-input", synced_at: STAMP });
    expect(implicit.body.rows[5]).toMatchObject({ container_id: 106, service_code: null });
    expect(implicit.body.rows[6]).toMatchObject({ container_id: 107, service_code: "" });
    expect(implicit.body.rows[20]).toMatchObject({ container_id: 121, service_code: " \t\n " });
    expect((await page({ enabled: "any", includeTotal: "true", order: "asc", offset: "0", limit: "50" })).body).toEqual(implicit.body);
  });
});

describe("serviceCode strict lexical rejection and auth ordering", () => {
  it.each([
    ["empty", ""], ["spaces", "   "], ["tabs and newlines", " \t\r\n "],
    ["Unicode whitespace", "  　"], ["101 ASCII code points", "private-marker-" + "x".repeat(86)],
    ["101 astral code points", "🚛".repeat(101)], ["100 ASCII plus one astral", "x".repeat(100) + "🚛"],
  ])("rejects %s with fixed value-free guidance before D1, even with a conditional wildcard", async (_name, value) => {
    const db = forbiddenDb();
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
    const { response } = await request({ serviceCode: value }, { db: db.db, headers: { "if-none-match": "*" } });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toEqual({ type: BAD_REQUEST, title: "Bad Request", status: 400,
      detail: "Invalid request query (serviceCode). See docs/PROBLEMS.md#bad-request." });
    expect(db.forbid).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each([
    "serviceCode=private-first&serviceCode=private-first",
    "serviceCode=private-first&serviceCode=private-second",
    "serviceCode=&serviceCode=private-first",
    "serviceCode=private-first&service%43ode=private-second",
  ])("rejects repeated keys (%s) before D1 without reflecting values", async (query) => {
    const db = forbiddenDb();
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
    const { response } = await request(new URLSearchParams(query), { db: db.db });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toEqual({ type: BAD_REQUEST, title: "Bad Request", status: 400,
      detail: "Invalid request query (serviceCode). See docs/PROBLEMS.md#bad-request." });
    expect(db.forbid).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each([null, "synthetic-invalid-token"])("authenticates before valid or invalid selectors (token %s)", async (token) => {
    for (const query of [{ serviceCode: CODE }, { serviceCode: "" }, new URLSearchParams("serviceCode=private-first&serviceCode=private-second")]) {
      const db = forbiddenDb();
      const { response } = await request(query, { token, db: db.db, headers: { "if-none-match": "*" } });
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      const problem = await response.json() as Record<string, unknown>;
      expect(problem).toMatchObject({ status: 401, title: "Unauthorized" });
      expect(String(problem.type)).toMatch(/#unauthorized$/);
      expect(JSON.stringify(problem)).not.toMatch(/serviceCode|private-first|private-second/);
      expect(db.forbid).not.toHaveBeenCalled();
    }
  });

  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("keeps authorized GET scope (%s)", async (token) => {
    expect(ids((await page({ serviceCode: CODE }, token)).body)).toEqual([101, 102, 103, 104]);
  });

  it("does not grant a read token the sync POST scope", async () => {
    const db = forbiddenDb();
    const { response } = await request({ serviceCode: CODE }, { db: db.db, method: "POST" });
    expect(response.status).toBe(401);
    expect(db.forbid).not.toHaveBeenCalled();
  });
});

describe("serviceCode AND composition on both SQL paths", () => {
  it.each([
    ["customer join", { customerId: "1" }, [101, 102, 103]],
    ["other customer", { customerId: "2" }, [104]],
    ["address", { pickupAddressId: "11" }, [101, 102]],
    ["canonical container ID", { containerId: "103" }, [103]],
    ["serial", { serialNumber: "SER-01" }, [101, 102, 104]],
    ["RFID", { rfid: "RF-01" }, [101, 103, 104]],
    ["both exact identifiers", { serialNumber: "SER-01", rfid: "RF-01" }, [101, 104]],
    ["case-insensitive q", { q: "NORTH" }, [101, 103, 104]],
    ["enabled true", { enabled: "true" }, [101, 102, 104]],
    ["enabled false", { enabled: "false" }, [103]],
    ["enabled any", { enabled: "any" }, [101, 102, 103, 104]],
    ["all selectors", { customerId: "1", pickupAddressId: "11", containerId: "101", serialNumber: "SER-01", rfid: "RF-01", q: "north", enabled: "true" }, [101]],
    ["conflicting customer/address", { customerId: "2", pickupAddressId: "11" }, []],
    ["matching ID cannot escape service scope", { containerId: "105" }, []],
    ["q mismatch", { q: "synthetic-nowhere" }, []],
    ["identifier mismatch", { serialNumber: "SER-MAX" }, []],
  ] as const)("ANDs %s with the same row/COUNT scope", async (_name, filters, expected) => {
    for (const includeTotal of ["true", "false"]) {
      const result = await page({ serviceCode: CODE, ...filters, includeTotal });
      expect(ids(result.body)).toEqual(expected);
      expect(result.body.total).toBe(includeTotal === "false" ? null : expected.length);
      expect(result.body.nextCursor).toBeNull();
    }
  });

  it("projects stored service fields only after filtering, always retaining canonical IDs", async () => {
    const { body } = await page({ serviceCode: CODE, customerId: "1", fields: "service_code,enabled", includeTotal: "false" });
    expect(body).toEqual({ rows: [
      { container_id: 101, service_code: CODE, enabled: 1 },
      { container_id: 102, service_code: CODE, enabled: 1 },
      { container_id: 103, service_code: CODE, enabled: 0 },
    ], total: null, nextCursor: null });
  });

  it("ignores unrelated names without changing successful rows, SQL or ETag", async () => {
    const base = await page({ serviceCode: CODE });
    const unknown = await page({ serviceCode: CODE, unrelated: "private-marker", serviceCodeType: "not-a-filter", serviceCodeInput: "not-a-filter" });
    expect(ids(base.body)).toEqual([101, 102, 103, 104]);
    expect(unknown.body).toEqual(base.body);
    expect(unknown.recorder.statements).toEqual(base.recorder.statements);
    expect(unknown.response.headers.get("etag")).toBe(base.response.headers.get("etag"));
  });

  it("is idempotent and does not log successful service-code values", async () => {
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
    const first = await page({ serviceCode: SPECIAL });
    const second = await page({ serviceCode: SPECIAL });
    expect(ids(first.body)).toEqual([112, 113]);
    expect(second.body).toEqual(first.body);
    expect(second.recorder.statements).toEqual(first.recorder.statements);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe.each(["asc", "desc"])("service-code %s pagination", (order) => {
  it.each(["true", "false"])("follows actual next links through a partial terminal page (includeTotal=%s)", async (includeTotal) => {
    const query = { serviceCode: CODE, customerId: "1", fields: "enabled", limit: "2", order, includeTotal, unrelated: "ignored" };
    let current = await page(query);
    const pages = order === "asc" ? [[101, 102], [103]] : [[103, 102], [101]];
    expect(ids(current.body)).toEqual(pages[0]);
    expect(current.body.total).toBe(includeTotal === "false" ? null : 3);
    expect(current.body.nextCursor).toBe(102);
    current = await page(next(current));
    expect(ids(current.body)).toEqual(pages[1]);
    expect(current.body.total).toBe(includeTotal === "false" ? null : 1);
    expect(current.body.nextCursor).toBeNull();
    expect(current.response.headers.get("link")).toBeNull();
    expect(current.body.rows).toEqual(order === "asc" ? [{ container_id: 103, enabled: 0 }] : [{ container_id: 101, enabled: 1 }]);
  });

  it.each(["true", "false"])("follows exact-full pages to an empty tail without losing filters (includeTotal=%s)", async (includeTotal) => {
    let current = await page({ serviceCode: CODE, order, limit: "2", includeTotal });
    const pages = order === "asc" ? [[101, 102], [103, 104], []] : [[104, 103], [102, 101], []];
    const cursors = order === "asc" ? [102, 104, null] : [103, 101, null];
    const seen: unknown[] = [];
    for (let index = 0; index < pages.length; index++) {
      expect(ids(current.body)).toEqual(pages[index]);
      expect(current.body.total).toBe(includeTotal === "false" ? null : [4, 2, 0][index]);
      expect(current.body.nextCursor).toBe(cursors[index]);
      seen.push(...ids(current.body));
      if (cursors[index] === null) expect(current.response.headers.get("link")).toBeNull();
      else current = await page(next(current));
    }
    expect(seen).toEqual(order === "asc" ? [101, 102, 103, 104] : [104, 103, 102, 101]);
  });

  it("starts with offset then uses an offset-free cursor-relative continuation", async () => {
    const first = await page({ serviceCode: CODE, order, offset: "1", limit: "2" });
    expect(ids(first.body)).toEqual(order === "asc" ? [102, 103] : [103, 102]);
    expect(first.body.total).toBe(4);
    expect(first.body.nextCursor).toBe(order === "asc" ? 103 : 102);
    const second = await page(next(first));
    expect(ids(second.body)).toEqual(order === "asc" ? [104] : [101]);
    expect(second.body.total).toBe(1);
    expect(second.body.nextCursor).toBeNull();
  });

  it("gives a supplied cursor precedence over offset and changes only total in count-free mode", async () => {
    const query = { serviceCode: CODE, order, cursor: order === "asc" ? "101" : "104", offset: "999", limit: "2", fields: "service_code" };
    const counted = await page(query);
    const free = await page({ ...query, includeTotal: "false" });
    expect(ids(counted.body)).toEqual(order === "asc" ? [102, 103] : [103, 102]);
    expect(counted.body.total).toBe(3);
    expect(counted.body.nextCursor).toBe(order === "asc" ? 103 : 102);
    expect(free.body).toEqual({ ...counted.body, total: null });
    expect(free.recorder.statements).toEqual(counted.recorder.statements.filter((s) => !/\bCOUNT\s*\(/i.test(s.sql)));
  });

  it("retains punctuation, Unicode and every composed predicate in encoded next links", async () => {
    const first = await page({ serviceCode: SPECIAL, customerId: "1", pickupAddressId: "11", serialNumber: "SER-01", rfid: "RF-01", q: "north", enabled: "any", fields: "service_code", limit: "1", includeTotal: "false", order });
    expect(ids(first.body)).toEqual(order === "asc" ? [112] : [113]);
    const target = next(first);
    expect(first.response.headers.get("link")).not.toContain(SPECIAL);
    const second = await page(target);
    expect(ids(second.body)).toEqual(order === "asc" ? [113] : [112]);
    const tail = await page(next(second));
    expect(tail.body).toEqual({ rows: [], total: null, nextCursor: null });
    expect(tail.response.headers.get("link")).toBeNull();
  });
});

it("keeps the maximum safe canonical ID and its ascending empty-tail cursor exact", async () => {
  const first = await page({ serviceCode: "UPPER-TAIL", limit: "1", includeTotal: "false" });
  expect(ids(first.body)).toEqual([9007199254740991]);
  expect(first.body.nextCursor).toBe(9007199254740991);
  const tail = await page(next(first));
  expect(tail.body).toEqual({ rows: [], total: null, nextCursor: null });
  expect(tail.response.headers.get("link")).toBeNull();
  const desc = await page({ serviceCode: "UPPER-TAIL", order: "desc", cursor: "9007199254740991" });
  expect(desc.body).toEqual({ rows: [], total: 0, nextCursor: null });
});

it.each(["true", "false"])("hashes the final filtered envelope and preserves the selector on conditional replay (includeTotal=%s)", async (includeTotal) => {
  const query = { serviceCode: SPECIAL, fields: "enabled", limit: "1", includeTotal };
  const first = await request(query);
  expect(first.response.status).toBe(200);
  const bytes = await first.response.text();
  expect(JSON.parse(bytes)).toEqual({ rows: [{ container_id: 112, enabled: 1 }], total: includeTotal === "false" ? null : 2, nextCursor: 112 });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  const tag = `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
  expect(first.response.headers.get("etag")).toBe(tag);
  expect(first.response.headers.get("link")).toContain("serviceCode=");
  for (const validator of [tag, `W/${tag}`, "*"]) {
    const replay = await request(query, { headers: { "if-none-match": validator } });
    expect(replay.response.status).toBe(304);
    expect(replay.response.body).toBeNull();
    expect((await replay.response.arrayBuffer()).byteLength).toBe(0);
    expect(replay.response.headers.get("etag")).toBe(tag);
    expect(replay.response.headers.get("link")).toBe(first.response.headers.get("link"));
    expect(replay.response.headers.get("cache-control")).toBe("no-store");
    expect(replay.recorder.statements).toHaveLength(includeTotal === "false" ? 1 : 2);
    expect(replay.recorder.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(includeTotal === "false" ? 0 : 1);
  }
  const different = await request({ ...query, serviceCode: CODE }, { headers: { "if-none-match": tag } });
  expect(different.response.status).toBe(200);
  expect(different.response.headers.get("etag")).not.toBe(tag);
  expect(ids(await different.response.json() as Body)).toEqual([101]);
  const changedEnvelope = await request({ ...query, fields: "service_code" }, { headers: { "if-none-match": tag } });
  expect(changedEnvelope.response.status).toBe(200);
  expect(changedEnvelope.response.headers.get("etag")).not.toBe(tag);
});

it("retains CORS, request-ID correlation and no-store on the Worker boundary", async () => {
  const response = await exports.default.fetch(`http://test.local${PATH}?serviceCode=${CODE}`, {
    headers: { authorization: "Bearer test-read-token", origin: "https://app.example.com", "x-request-id": "synthetic-service-trace" },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("x-request-id")).toBe("synthetic-service-trace");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBeTruthy();
  expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("x-request-id");
  expect(ids(await response.json() as Body)).toEqual([101, 102, 103, 104]);
});

it.each([false, true])("binds one alias-qualified service equality in row and COUNT queries (customer join=%s)", async (join) => {
  const result = await page({ serviceCode: SPECIAL, ...(join ? { customerId: "1" } : {}), limit: "1" });
  for (const { sql, binds } of result.recorder.statements) {
    expect(sql).not.toContain(SPECIAL);
    expect(sql.match(/\bc\.service_code\s*=\s*\?/g)).toHaveLength(1);
    expect(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP|COLLATE\s+NOCASE)\b/i);
    expect(binds.filter((value) => value === SPECIAL)).toHaveLength(1);
    expect(/\bJOIN\s+address_snapshot\b/i.test(sql)).toBe(join);
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
    expect(plan.success).toBe(true);
    expect(plan.results.length).toBeGreaterThan(0);
  }
  expect(ids(result.body)).toEqual([112]);
  expect(result.body.total).toBe(2);
});

it("records the honest unindexed local equality plan without inventing a migration or performance claim", async () => {
  const statements = [
    { sql: "SELECT c.container_id FROM container_snapshot c WHERE c.service_code = ? ORDER BY c.container_id ASC LIMIT ? OFFSET ?", binds: [CODE, 2, 0] },
    { sql: "SELECT COUNT(*) AS total FROM container_snapshot c WHERE c.service_code = ?", binds: [CODE] },
  ];
  for (const { sql, binds } of statements) {
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
    expect(plan.success).toBe(true);
    expect(plan.results.map((row) => row.detail)).toEqual(["SCAN c"]);
  }
});

describe("served service-code declaration", () => {
  type Parameter = { name: string; in: string; required?: boolean; description?: string; example?: unknown;
    schema?: { type?: unknown; minLength?: number; maxLength?: number; description?: string; default?: unknown; example?: unknown } };
  type Operation = { operationId?: string; description?: string; parameters?: Parameter[]; responses?: Record<string, { description?: string }>; [key: string]: unknown };
  async function document() {
    const { response, recorder } = await request(new URL("/openapi.json", ORIGIN), { token: null });
    expect(response.status).toBe(200);
    expect(recorder.prepareCalls).toEqual([]);
    return await response.json() as { paths: Record<string, Record<string, Operation>> };
  }

  it("publishes one optional honest string facet and a runnable synthetic example", async () => {
    const doc = await document();
    const operation = doc.paths[PATH].get;
    const parameters = operation.parameters?.filter((p) => p.in === "query" && p.name === "serviceCode") ?? [];
    expect(parameters).toHaveLength(1);
    const parameter = parameters[0];
    expect(parameter).toMatchObject({ required: false, schema: { type: "string", minLength: 1, maxLength: 100 } });
    expect(parameter.schema?.default).toBeUndefined();
    const example = parameter.example ?? parameter.schema?.example;
    expect(typeof example).toBe("string");
    expect((example as string).trim().length).toBeGreaterThan(0);
    expect([...(example as string)].length).toBeLessThanOrEqual(100);
    expect((await request({ serviceCode: example as string })).response.status).toBe(200);
    const description = `${parameter.description ?? ""} ${parameter.schema?.description ?? ""}`;
    expect(description).toMatch(/exact/i);
    expect(description).toMatch(/case[- ]sensitive/i);
    expect(description).toMatch(/Unicode code points/i);
    expect(description).toMatch(/whitespace/i);
    expect(description).toMatch(/repeat|single/i);
  });

  it("describes AND composition and value-free pre-D1 rejection without losing existing selectors", async () => {
    const operation = (await document()).paths[PATH].get;
    for (const key of ["serviceCode", "serialNumber", "rfid", "customerId", "pickupAddressId", "containerId", "q", "enabled", "cursor", "offset"]) {
      expect(operation.description, key).toContain(key);
    }
    expect(operation.description).toMatch(/\bAND\b/i);
    const error = operation.responses?.["400"]?.description ?? "";
    expect(error).toContain("serviceCode");
    expect(error).toContain("application/problem+json");
    expect(error).toMatch(/before.*D1/i);
    expect(error).toMatch(/repeat|duplicate/i);
    expect(error).toMatch(/empty|blank/i);
    expect(error).toMatch(/100.*Unicode code points/i);
  });

  it("keeps the canonical query-policy inventory aligned with the new served selector", async () => {
    const operation = (await document()).paths[PATH].get;
    const row = policyDoc.split("\n").find((line) => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    const inventory = [...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort();
    const published = (operation.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name).sort();
    expect(inventory).toContain("serviceCode");
    expect(inventory).toEqual(published);
  });

  it("preserves operation identity and read-only metadata without adding service selectors elsewhere", async () => {
    const doc = await document();
    expect(doc.paths[PATH].get).toMatchObject({ operationId: "listContainerSnapshot", "x-access": "read", "x-effect": "local-read" });
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/address-snapshot", `${PATH}/{containerId}`, `${PATH}/export`, "/api/v1/customer-snapshot/changes"]) {
      expect(doc.paths[path].get.parameters?.map((p) => p.name) ?? [], path).not.toContain("serviceCode");
    }
    expect(app.routes.filter((route) => /service[-_]?code/i.test(route.path))).toEqual([]);
  });
});
