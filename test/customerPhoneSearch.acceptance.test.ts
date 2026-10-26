/// <reference types="vite/client" />

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";

/**
 * Test-Author-owned RED-first oracle; corrections require a separate bounded task.
 * Run: npx vitest run test/customerPhoneSearch.acceptance.test.ts --maxWorkers=2
 *
 * Mutation targets: ignored selector, equality/LIKE instead of literal substring,
 * one missing OR arm, ungrouped OR, normalization, count/row scope disagreement,
 * post-query validation/auth, lost continuation selector, stale conditional body.
 * Expected IDs/pages are hand-derived, not computed by a production helper.
 * Only synthetic real local D1 is used; all outbound access and handler writes fail.
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/customer-snapshot";
const ORIGIN = "https://phone-client.invalid";
const FRAGMENT = "5550107";
const SPECIAL = "desk' OR 1=1 -- %_ 🧪&+/#?";
const STAMP = "2026-01-01T00:00:00.000Z";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";

type Fixture = readonly [number, string, string | null, string | null, number];
const fixtures: readonly Fixture[] = [
  [11, "North Synthetic One", "+1 (202) 5550107", null, 1],
  [23, "North Synthetic Two", null, "desk 5550107 ext 9", 0],
  [37, "North Synthetic Three", "5550107", "backup 5550107", 1],
  [42, "South Synthetic Four", "line 5550107", "unrelated", 0],
  [58, "North Synthetic Dashed", "+1-202-555-0107", null, 1],
  [91, "North Synthetic Spaced", null, "202 555 0107", 1],
  [103, "Synthetic Nulls", null, null, 1],
  [107, "Synthetic Empty", "", "", 1],
  [109, "5550107 company-only decoy", "other", "other", 1],
  [113, "Synthetic Punctuation", SPECIAL, null, 1],
  [127, "Synthetic Lettered", null, "Desk-AbC-Extension", 1],
  [131, "Synthetic Padded", "  marker  ", null, 1],
  [137, "Synthetic Astral Boundary", "🧪".repeat(100), null, 1],
  [139, "Synthetic ASCII Boundary", null, "x".repeat(100), 1],
  [149, "Synthetic Composed", "é", null, 1],
  [151, "Synthetic Decomposed", null, "é", 1],
  [157, "Synthetic Embedded Whitespace", " \tphone\n ", null, 1],
  [163, "Synthetic Literal Wildcards", null, "%_", 1],
  [167, "Synthetic Wildcard Decoy", "XXanything", null, 1],
  [173, "Synthetic Trim Decoy", "marker", null, 1],
  [179, "Synthetic Whitespace Decoy", null, "phone", 1]
];

type Query = Record<string, string> | URLSearchParams;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[]; method: string };
const ids = (body: Body) => body.rows.map((row) => row.customer_id);
const isCount = (statement: Statement) => /\bCOUNT\s*\(/i.test(statement.sql);
const recorders: ReturnType<typeof recordingDb>[] = [];
let beforeState: unknown;
let requestNumber = 0;
const denyExternal = vi.fn(() => { throw new Error("Phone lookup must not access upstream, browser or R2"); });
const forbiddenBucket = Object.fromEntries([
  "get", "head", "list", "put", "delete", "createMultipartUpload", "resumeMultipartUpload"
].map((method) => [method, denyExternal])) as unknown as R2Bucket;

// Forward executions to real D1 without synthesizing results. Deny all mutations.
function recordingDb() {
  const statements: Statement[] = [];
  const prepared: string[] = [];
  const fail = () => { throw new Error("Phone lookup must only SELECT from local D1"); };
  const batch = vi.fn(fail);
  const exec = vi.fn(fail);
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql, values);
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          statements.push({ sql, binds, method: String(prop) });
          if (!/^\s*SELECT\b/i.test(sql) || prop === "run") return fail();
          return Reflect.apply(value, target, args);
        };
      }
    });
  }
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      if (!/^\s*SELECT\b/i.test(sql)) return fail();
      return wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []);
    }, batch, exec
  } as unknown as D1Database;
  return { db, statements, prepared, batch, exec };
}

async function state() {
  const db = TEST_ENV.CUSTOMER_DB;
  const tables = ["customer_snapshot", "address_snapshot", "container_snapshot"];
  const results = await Promise.all([
    ...tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()
  ]);
  return results.map((result) => result.results);
}

async function request(query: Query | URL = {}, options: {
  token?: string | null; headers?: Record<string, string>
} = {}) {
  const recorder = recordingDb();
  recorders.push(recorder);
  const url = query instanceof URL ? query : new URL(PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = new URLSearchParams(query).toString();
  const requestId = `Phone-${++requestNumber}`;
  const headers = new Headers({ origin: ORIGIN, "x-request-id": requestId, ...options.headers });
  const token = options.token === undefined ? "test-read-token" : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: recorder.db, SNAPSHOTS: forbiddenBucket,
    BROWSER: { fetch: denyExternal } as unknown as Fetcher
  });
  return { response, recorder, url, requestId };
}

function posture(response: Response, requestId: string) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  expect(response.headers.get("vary")).toMatch(/\borigin\b/i);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("x-request-id")).toBe(requestId);
}

async function page(query: Query | URL = {}, token?: string) {
  const result = await request(query, { token });
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  posture(result.response, result.requestId);
  const body = await result.response.json() as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const counted = result.url.searchParams.get("includeTotal") !== "false";
  expect(result.recorder.statements).toHaveLength(counted ? 2 : 1);
  expect(result.recorder.statements.filter(isCount)).toHaveLength(counted ? 1 : 0);
  if (!counted) expect(body.total).toBeNull();
  return { ...result, body };
}

function next(response: Response, current: URL, expected: Record<string, string>) {
  const link = response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/customer-snapshot\?[^<>\s]*>; rel="next"$/);
  const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], current);
  expect(target.origin).toBe(ORIGIN);
  expect(target.pathname).toBe(PATH);
  expect(target.hash).toBe("");
  expect(target.searchParams.has("offset")).toBe(false);
  for (const [key, value] of Object.entries(expected)) {
    // Existing next links may elide defaults, never the supplied phone data.
    if ((key === "includeTotal" && value === "true") || (key === "enabled" && value === "any")) {
      expect([null, value]).toContain(target.searchParams.get(key));
      expect(target.searchParams.getAll(key).length).toBeLessThanOrEqual(1);
    } else expect(target.searchParams.getAll(key), key).toEqual([value]);
  }
  expect([...target.searchParams.keys()].every((key) => Object.hasOwn(expected, key))).toBe(true);
  return target;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  recorders.length = 0;
  denyExternal.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound network in phone oracle"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  // Reversed insertion order prevents an insertion-order oracle.
  await db.batch([...fixtures].reverse().map(([id, company, phone1, phone2, enabled]) =>
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, phone1, phone2, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, company, phone1, phone2, enabled, STAMP)
  ));
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denyExternal).not.toHaveBeenCalled();
    for (const recorder of recorders) {
      expect(recorder.batch).not.toHaveBeenCalled();
      expect(recorder.exec).not.toHaveBeenCalled();
      expect(recorder.prepared.every((sql) => /^\s*SELECT\b/i.test(sql))).toBe(true);
      expect(recorder.statements.every((s) => s.method !== "run")).toBe(true);
    }
    expect(await state(), "requests must not mutate fixture rows or schema").toEqual(beforeState);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe("stored phone fragment semantics", () => {
  it("ORs phone1 and phone2, deduplicating a row matching both and excluding non-phone decoys", async () => {
    const { body } = await page({ phone: FRAGMENT });
    expect(ids(body)).toEqual([11, 23, 37, 42]);
    expect(body.total).toBe(4);
    expect(body.nextCursor).toBeNull();
  });

  it.each([
    ["phone1-only formatting", "+1 (202)", [11]],
    ["phone2-only formatting", "EXT 9", [23]],
    ["ASCII case-insensitive substring", "aBc", [127]],
    ["substring rather than equality", "555010", [11, 23, 37, 42]],
    ["one code point", "(", [11]],
    ["no digit stripping", "2025550107", []],
    ["dashed stored text", "555-0107", [58]],
    ["spaced stored text", "555 0107", [91]],
    ["nonblank edge whitespace is data", "  marker  ", [131]],
    ["nonblank tabs and newlines are data", " \tphone\n ", [157]],
    ["100 ASCII code points", "x".repeat(100), [139]],
    ["100 astral code points, not UTF-16 units", "🧪".repeat(100), [137]],
    ["one astral code point", "🧪", [113, 137]],
    ["no composed Unicode normalization", "é", [149]],
    ["no decomposed Unicode normalization", "é", [151]],
    ["quotes and URL delimiters are literal data", SPECIAL, [113]],
    ["percent and underscore are not SQL wildcards", "%_", [113, 163]],
    ["SQL-looking text does not escape binding", "' OR 1=1 --", [113]],
    ["null is not a string", "null", []],
    ["no match is an empty success", "synthetic-absent-phone", []]
  ] as const)("%s", async (_label, phone, expected) => {
    const { body, response } = await page({ phone });
    expect(ids(body)).toEqual(expected);
    expect(body.total).toBe(expected.length);
    expect(body.nextCursor).toBeNull();
    expect(response.headers.get("link")).toBeNull();
  });

  it("omission preserves default rows, nullable stored phones, canonical IDs and role access", async () => {
    const baseline = await page();
    expect(ids(baseline.body)).toEqual([11, 23, 37, 42, 58, 91, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179]);
    expect(baseline.body.total).toBe(21);
    expect(baseline.body.rows[0]).toMatchObject({ customer_id: 11, phone1: "+1 (202) 5550107", phone2: null, synced_at: STAMP });
    expect(baseline.body.rows[6]).toMatchObject({ customer_id: 103, phone1: null, phone2: null });
    expect(baseline.body.rows[7]).toMatchObject({ customer_id: 107, phone1: "", phone2: "" });
    const explicit = await page({ enabled: "any", order: "asc", includeTotal: "true", offset: "0", limit: "50" });
    expect(explicit.body).toEqual(baseline.body);
    for (const token of ["test-api-token", "test-sync-secret"]) {
      expect((await page({}, token)).body).toEqual(baseline.body);
    }
  });

  it("accepts phone lookups for all existing read-capable roles", async () => {
    for (const token of ["test-read-token", "test-api-token", "test-sync-secret"]) {
      expect(ids((await page({ phone: FRAGMENT }, token)).body)).toEqual([11, 23, 37, 42]);
    }
  });

  it.each(["asc", "desc"])("retains existing %s next-link semantics when phone is omitted", async (order) => {
    const filters = { customerId: "113", order, limit: "1", includeTotal: "false" };
    const first = await page(filters);
    expect(ids(first.body)).toEqual([113]);
    const last = await page(next(first.response, first.url, { ...filters, cursor: "113" }));
    expect(last.body).toEqual({ rows: [], total: null, nextCursor: null });
    expect(last.response.headers.get("link")).toBeNull();
  });

  it("keeps unrelated unknown keys ignored without changing the selected SQL or results", async () => {
    const plain = await page({ phone: FRAGMENT });
    const unknown = await page(new URLSearchParams([
      ["phone", FRAGMENT], ["bogus_param", "private-first"], ["bogus_param", "private-second"]
    ]));
    expect(ids(plain.body)).toEqual([11, 23, 37, 42]);
    expect(unknown.body).toEqual(plain.body);
    expect(unknown.recorder.statements).toEqual(plain.recorder.statements);
  });
});

describe("phone predicate intersection", () => {
  it.each([
    ["enabled", { enabled: "true" }, [11, 37]],
    ["disabled (including phone2-only match)", { enabled: "false" }, [23, 42]],
    ["all enabled states", { enabled: "any" }, [11, 23, 37, 42]],
    ["company q", { q: "NORTH" }, [11, 23, 37]],
    ["nonmatching q cannot be escaped by phone2", { q: "absent-company" }, []],
    ["customer ID", { customerId: "37" }, [37]],
    ["nonmatching customer ID", { customerId: "58" }, []],
    ["q and enabled", { q: "north", enabled: "false" }, [23]],
    ["all selectors", { customerId: "23", q: "north", enabled: "false" }, [23]],
    ["conflicting enabled", { customerId: "23", q: "north", enabled: "true" }, []]
  ] as const)("ANDs %s with identical count and row scope", async (_name, filters, expected) => {
    for (const includeTotal of ["true", "false"]) {
      const { body } = await page({ phone: FRAGMENT, ...filters, includeTotal });
      expect(ids(body)).toEqual(expected);
      expect(body.total).toBe(includeTotal === "false" ? null : expected.length);
      expect(body.nextCursor).toBeNull();
    }
  });

  it("projects phone1/phone2 as stored and always retains customer_id", async () => {
    const { body } = await page({ phone: FRAGMENT, fields: "phone1,phone2", includeTotal: "false" });
    expect(body).toEqual({ rows: [
      { customer_id: 11, phone1: "+1 (202) 5550107", phone2: null },
      { customer_id: 23, phone1: null, phone2: "desk 5550107 ext 9" },
      { customer_id: 37, phone1: "5550107", phone2: "backup 5550107" },
      { customer_id: 42, phone1: "line 5550107", phone2: "unrelated" }
    ], total: null, nextCursor: null });
  });

  it("can select using a phone column omitted from the output fieldset", async () => {
    const { body } = await page({ phone: "ext 9", fields: "phone1" });
    expect(body).toEqual({ rows: [{ customer_id: 23, phone1: null }], total: 1, nextCursor: null });
  });

  it("is idempotent without logging a successful phone selector", async () => {
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
    const first = await page({ phone: SPECIAL });
    const second = await page({ phone: SPECIAL });
    expect(ids(first.body)).toEqual([113]);
    expect(second.body).toEqual(first.body);
    expect(second.recorder.statements).toEqual(first.recorder.statements);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe.each(["true", "false"])("phone pagination includeTotal=%s", (includeTotal) => {
  it.each([
    ["ascending offset", { order: "asc", offset: "1", limit: "2" }, [23, 37], 4, 37],
    ["descending offset", { order: "desc", offset: "1", limit: "2" }, [37, 23], 4, 23],
    ["ascending seek", { order: "asc", cursor: "23", limit: "2" }, [37, 42], 2, 42],
    ["descending seek", { order: "desc", cursor: "37", limit: "2" }, [23, 11], 2, 11],
    ["ascending gap", { order: "asc", cursor: "24", limit: "2" }, [37, 42], 2, 42],
    ["descending gap", { order: "desc", cursor: "36", limit: "2" }, [23, 11], 2, 11],
    ["cursor overrides offset", { order: "desc", cursor: "37", offset: "999", limit: "1" }, [23], 2, 23],
    ["partial terminal", { order: "asc", cursor: "37", limit: "2" }, [42], 1, null],
    ["empty seek", { order: "asc", cursor: "42", limit: "2" }, [], 0, null],
    ["empty offset", { order: "desc", offset: "4", limit: "2" }, [], 4, null]
  ] as const)("%s retains the selector and cursor-relative scope", async (_name, query, expected, total, cursor) => {
    const { body, response, recorder } = await page({ phone: FRAGMENT, ...query, includeTotal });
    expect(ids(body)).toEqual(expected);
    expect(body.total).toBe(includeTotal === "false" ? null : total);
    expect(body.nextCursor).toBe(cursor);
    if (cursor === null) expect(response.headers.get("link")).toBeNull();
    if ("cursor" in query) {
      for (const statement of recorder.statements) expect(statement.sql).not.toMatch(/\bOFFSET\b/i);
    }
    const rows = recorder.statements.find((s) => !isCount(s))!;
    const tail = "cursor" in query ? [Number(query.limit)] : [Number(query.limit), Number(query.offset ?? 0)];
    expect(rows.binds.slice(-tail.length)).toEqual(tail); // no LIMIT+1 lookahead
  });

  it.each(["asc", "desc"])("follows actual %s links through an exactly full last page to an empty page", async (order) => {
    const filters = { phone: FRAGMENT, order, limit: "2", includeTotal, fields: "phone1" };
    const pages = order === "asc" ? [[11, 23], [37, 42], []] : [[42, 37], [23, 11], []];
    let current = await page(filters);
    const seen: unknown[] = [];
    for (const [index, expected] of pages.entries()) {
      expect(ids(current.body)).toEqual(expected);
      expect(current.body.total).toBe(includeTotal === "false" ? null : [4, 2, 0][index]);
      expect(current.body.nextCursor).toBe(expected[1] ?? null);
      for (const row of current.body.rows) expect(Object.keys(row).sort()).toEqual(["customer_id", "phone1"]);
      seen.push(...ids(current.body));
      if (expected.length === 0) expect(current.response.headers.get("link")).toBeNull();
      else current = await page(next(current.response, current.url, { ...filters, cursor: String(expected[1]) }));
    }
    expect(seen).toEqual(order === "asc" ? [11, 23, 37, 42] : [42, 37, 23, 11]);
  });
});

it("retains q/enabled/phone/fields after an offset start while removing unknown keys", async () => {
  const filters = { phone: FRAGMENT, q: "north", enabled: "any", fields: "phone2", order: "desc", limit: "1", includeTotal: "false" };
  let current = await page({ ...filters, offset: "1", bogus_param: "must-not-propagate" });
  for (const expected of [23, 11]) {
    expect(ids(current.body)).toEqual([expected]);
    expect(current.body.nextCursor).toBe(expected);
    current = await page(next(current.response, current.url, { ...filters, cursor: String(expected) }));
  }
  expect(current.body).toEqual({ rows: [], total: null, nextCursor: null });
  expect(current.response.headers.get("link")).toBeNull();
});

it("carries customerId and all selector intersections on an exactly full single-customer page", async () => {
  const filters = { phone: FRAGMENT, customerId: "23", q: "north", enabled: "false", fields: "phone1", order: "asc", limit: "1", includeTotal: "false" };
  const first = await page(filters);
  expect(first.body).toEqual({ rows: [{ customer_id: 23, phone1: null }], total: null, nextCursor: 23 });
  const last = await page(next(first.response, first.url, { ...filters, cursor: "23" }));
  expect(last.body).toEqual({ rows: [], total: null, nextCursor: null });
  expect(last.response.headers.get("link")).toBeNull();
});

it.each([SPECIAL, "  marker  ", " \tphone\n ", "🧪".repeat(100)])("round-trips opaque selector data in encoded continuation (%s)", async (phone) => {
  const expected = phone === SPECIAL ? 113 : phone === "  marker  " ? 131 : phone === " \tphone\n " ? 157 : 137;
  const filters = { phone, limit: "1", includeTotal: "false" };
  const first = await page(filters);
  expect(ids(first.body)).toEqual([expected]);
  const target = next(first.response, first.url, { ...filters, cursor: String(expected) });
  expect(first.response.headers.get("link")).not.toContain(phone);
  const last = await page(target);
  expect(last.body).toEqual({ rows: [], total: null, nextCursor: null });
  expect(last.response.headers.get("link")).toBeNull();
});

describe("validation and auth precede any D1 access, including conditional requests", () => {
  async function rejected(query: Query | URL) {
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
    const { response, recorder, requestId } = await request(query, { headers: { "if-none-match": "*" } });
    // Soft status assertion still exposes D1 work in the RED baseline.
    expect.soft(response.status).toBe(400);
    expect.soft(recorder.prepared).toEqual([]);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("etag")).toBeNull();
    posture(response, requestId);
    const problem = await response.json() as Record<string, unknown>;
    expect(problem).toMatchObject({
      type: BAD_REQUEST, title: "Bad Request", status: 400,
      detail: "Invalid request query (phone). See docs/PROBLEMS.md#bad-request."
    });
    expect(Object.keys(problem).every((key) => ["type", "title", "status", "detail", "requestId"].includes(key))).toBe(true);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  }

  it.each([
    ["empty", ""], ["ASCII blank", " \t\r\n "], ["Unicode blank", "  "],
    ["101 ASCII code points", "private-marker-" + "x".repeat(86)],
    ["101 astral code points", "🧪".repeat(101)],
    ["100 ASCII plus one astral", "x".repeat(100) + "🧪"]
  ])("rejects %s with fixed value-free correction guidance", async (_label, phone) => { await rejected({ phone }); });

  it.each([
    ["identical", "private-first", "private-first"],
    ["different", "private-first", "private-second"],
    ["empty then valid", "", FRAGMENT],
    ["valid then empty", FRAGMENT, ""]
  ])("rejects repeated phone (%s), never taking first or last", async (_label, first, second) => {
    await rejected(new URLSearchParams([["phone", first], ["phone", second]]));
  });

  it("recognizes percent-encoded names as repeated phone keys", async () => {
    const url = new URL(PATH + "?phone=private-first&%70hone=private-second", ORIGIN);
    await rejected(url);
  });

  it.each([null, "invalid-synthetic-token"])("returns 401 before selector validation or D1 (token %s)", async (token) => {
    for (const query of [{ phone: FRAGMENT }, { phone: "" }, new URLSearchParams([["phone", "private-first"], ["phone", "private-second"]])]) {
      const { response, recorder, requestId } = await request(query, { token, headers: { "if-none-match": "*" } });
      expect(response.status).toBe(401);
      posture(response, requestId);
      expect(response.headers.get("etag")).toBeNull();
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      const problem = await response.json();
      expect(problem).toMatchObject({ status: 401, title: "Unauthorized" });
      expect(JSON.stringify(problem)).not.toMatch(/private-first|private-second|5550107/);
      expect(recorder.prepared).toEqual([]);
    }
  });
});

it.each(["true", "false"])("hashes the selected served bytes and replays a bodyless 304 (includeTotal=%s)", async (includeTotal) => {
  const query = { phone: FRAGMENT, fields: "phone1", order: "desc", limit: "2", includeTotal };
  const first = await request(query);
  expect(first.response.status).toBe(200);
  const bytes = await first.response.text();
  expect(ids(JSON.parse(bytes) as Body)).toEqual([42, 37]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  const tag = `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
  expect(first.response.headers.get("etag")).toBe(tag);
  const link = first.response.headers.get("link");
  expect(link).not.toBeNull();
  for (const validator of [tag, `W/${tag}`, "*"]) {
    const replay = await request(first.url, { headers: { "if-none-match": validator } });
    expect(replay.response.status).toBe(304);
    expect(replay.response.body).toBeNull();
    expect((await replay.response.arrayBuffer()).byteLength).toBe(0);
    expect(replay.response.headers.get("etag")).toBe(tag);
    expect(replay.response.headers.get("link")).toBe(link);
    posture(replay.response, replay.requestId);
    expect(replay.recorder.statements).toEqual(first.recorder.statements);
  }
  const changed = await request({ ...query, phone: "EXT 9" }, { headers: { "if-none-match": tag } });
  expect(changed.response.status).toBe(200);
  expect(changed.response.headers.get("etag")).not.toBe(tag);
  expect(ids(await changed.response.json() as Body)).toEqual([23]);
});

it("executes the declared predicate on the synthetic fixtures and records its scan boundary", async () => {
  // This is specification SQL, not imported product code. It checks that the
  // independent fixtures support the required semantics before route integration.
  const predicate = "(instr(lower(coalesce(phone1,'')), lower(?)) > 0 OR instr(lower(coalesce(phone2,'')), lower(?)) > 0)";
  const sql = `SELECT customer_id FROM customer_snapshot WHERE ${predicate} ORDER BY customer_id`;
  const matches = await TEST_ENV.CUSTOMER_DB.prepare(sql).bind(FRAGMENT, FRAGMENT).all<{ customer_id: number }>();
  expect(matches.results.map((row) => row.customer_id)).toEqual([11, 23, 37, 42]);
  const scan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(FRAGMENT, FRAGMENT).all<{ detail: string }>();
  expect(scan.results.map((row) => row.detail)).toContain("SCAN customer_snapshot");
  const byId = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN SELECT customer_id FROM customer_snapshot WHERE customer_id = ? AND ${predicate} ORDER BY customer_id`)
    .bind(23, FRAGMENT, FRAGMENT).all<{ detail: string }>();
  expect(byId.results.map((row) => row.detail)).toContain("SEARCH customer_snapshot USING INTEGER PRIMARY KEY (rowid=?)");
});

it.each<Record<string, string>>([{}, { customerId: "113" }])("binds the same phone twice in COUNT and rows; exposes honest local EXPLAIN (%j)", async (filters) => {
  const result = await page({ phone: SPECIAL, ...filters });
  const plans: Array<{ sql: string; details: string[] }> = [];
  for (const { sql, binds } of result.recorder.statements) {
    const explained = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
    expect(explained.success).toBe(true);
    expect(explained.results.length).toBeGreaterThan(0);
    plans.push({ sql, details: explained.results.map((row) => row.detail) });
    expect.soft(sql).not.toContain(SPECIAL);
    expect.soft(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP)\b/i);
    expect.soft(binds.filter((value) => value === SPECIAL), `Synthetic local D1 EXPLAIN (no values): ${JSON.stringify(plans)}`).toHaveLength(2);
    for (const column of ["phone1", "phone2"]) {
      expect.soft(sql).toMatch(new RegExp(`instr\\(\\s*lower\\(\\s*coalesce\\(\\s*(?:\\w+\\.)?${column}\\s*,\\s*''\\s*\\)\\s*\\)\\s*,\\s*lower\\(\\s*\\?\\s*\\)\\s*\\)\\s*>\\s*0`, "i"));
    }
    expect.soft(sql).toMatch(/\bOR\b/i);
  }
  expect(ids(result.body), `Synthetic local D1 EXPLAIN (no values): ${JSON.stringify(plans)}`).toEqual([113]);
  if (!("customerId" in filters)) {
    expect(plans.every((plan) => plan.details.some((detail) => /\bSCAN\b/i.test(detail)))).toBe(true);
  }
});

type Parameter = {
  name: string; in: string; required?: boolean; description?: string; example?: unknown;
  examples?: Record<string, { value?: unknown }>;
  schema?: { type?: string; minLength?: number; maxLength?: number; description?: string; default?: unknown; example?: unknown; examples?: unknown[] };
};
type Operation = {
  operationId?: string; description?: string; parameters?: Parameter[];
  responses?: Record<string, { description?: string }>;
  "x-access"?: string; "x-effect"?: string;
};
type Document = { paths: Record<string, { get: Operation }> };
async function document() {
  const { response } = await request(new URL("/openapi.json", ORIGIN), { token: null });
  expect(response.status).toBe(200);
  return await response.json() as Document;
}

describe("discoverable phone lookup contract", () => {
  it("publishes one optional bounded string with substring, stored-column and no-normalization guidance", async () => {
    const operation = (await document()).paths[PATH].get;
    const matches = operation.parameters?.filter((p) => p.in === "query" && p.name === "phone") ?? [];
    expect(matches).toHaveLength(1);
    const phone = matches[0];
    expect(phone).toMatchObject({ required: false, schema: { type: "string", minLength: 1, maxLength: 100 } });
    expect(phone.schema?.default).toBeUndefined();
    const description = `${phone.description ?? ""} ${phone.schema?.description ?? ""}`;
    expect(description).toMatch(/case[- ]insensitive/i);
    expect(description).toMatch(/substring/i);
    expect(description).toMatch(/phone1/i);
    expect(description).toMatch(/phone2/i);
    expect(description).toMatch(/Unicode code points/i);
    expect(description).toMatch(/normaliz|digit[- ]stripp|as stored/i);
    expect(description).toMatch(/repeat|single/i);
  });

  it("publishes a runnable synthetic phone parameter example", async () => {
    const operation = (await document()).paths[PATH].get;
    const phone = operation.parameters?.find((p) => p.in === "query" && p.name === "phone");
    expect(phone).toBeDefined();
    const samples = [phone?.example, phone?.schema?.example, ...(phone?.schema?.examples ?? []),
      ...Object.values(phone?.examples ?? {}).map((example) => example.value)].filter((value) => value !== undefined);
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      expect(typeof sample).toBe("string");
      expect([...String(sample)].length).toBeGreaterThan(0);
      expect([...String(sample)].length).toBeLessThanOrEqual(100);
      expect(String(sample).trim()).not.toBe("");
      await page({ phone: String(sample), fields: "phone1", includeTotal: "false" });
    }
  });

  it("advertises AND composition, scan honesty and value-free pre-D1 400s", async () => {
    const operation = (await document()).paths[PATH].get;
    const description = operation.description ?? "";
    for (const key of ["phone", "customerId", "q", "enabled", "cursor", "offset"]) expect(description, key).toContain(key);
    expect(description).toMatch(/\bAND\b/i);
    expect(description).toMatch(/scan/i);
    const badRequest = operation.responses?.["400"]?.description ?? "";
    expect(badRequest).toContain("phone");
    expect(badRequest).toMatch(/before.*D1/i);
    expect(badRequest).toMatch(/blank|empty/i);
    expect(badRequest).toMatch(/repeat|duplicate/i);
    expect(badRequest).toMatch(/100.*Unicode code points/i);
  });

  it("keeps the canonical query-key inventory synchronized with served discovery", async () => {
    const operation = (await document()).paths[PATH].get;
    const row = policyDoc.split("\n").find((line) => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    const inventory = [...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort();
    expect(inventory).toContain("phone");
    const published = (operation.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name).sort();
    expect(inventory).toEqual(published);
  });

  it("preserves the operation ID/access/effect and adds no selector to unrelated endpoints", async () => {
    const doc = await document();
    expect(doc.paths[PATH].get).toMatchObject({ operationId: "listCustomerSnapshot", "x-access": "read", "x-effect": "local-read" });
    for (const path of ["/api/v1/address-snapshot", "/api/v1/container-snapshot", `${PATH}/changes`, `${PATH}/export`, `${PATH}/{customerId}`]) {
      expect(doc.paths[path].get.parameters?.map((p) => p.name) ?? [], path).not.toContain("phone");
    }
    expect(Object.keys(doc.paths).filter((path) => /phone/i.test(path))).toEqual([]);
  });
});
