/// <reference types="vite/client" />

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";

// Test-first public contract. Real local D1 executes the queries; expected IDs are
// hand-derived. Removing equality, binding, validation or filter propagation must
// fail these tests. No product SQL builder or identifier normalizer is the oracle.
const TEST_ENV = env as unknown as Env;
const ORIGIN = "https://asset-lookup.test.invalid";
const PATH = "/api/v1/container-snapshot";
const SERIAL = "00123";
const RFID = "RF-0007";
const SPECIAL = "crate' OR 1=1 -- %_ 🧪&+/#?";
const STAMP = "2026-01-01T00:00:00.000Z";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";

type Selector = "serialNumber" | "rfid";
type Query = Record<string, string> | URLSearchParams;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[]; method: string };
type Fixture = readonly [number, number, string | null, string | null, number, string];

const fixtures: readonly Fixture[] = [
  [101, 11, SERIAL, RFID, 1, "north depot"],
  [102, 11, SERIAL, "RF-OTHER", 1, "south depot"],
  [103, 11, "OTHER", RFID, 1, "north depot"],
  [104, 12, SERIAL, RFID, 0, "north depot"],
  [105, 21, SERIAL, RFID, 1, "north depot"],
  [106, 11, "x00123x", "xRF-0007x", 1, "north depot"],
  [107, 11, "00123x", "rf-0007", 1, "north depot"],
  [108, 11, null, null, 1, "north depot"],
  [109, 11, "123", "RF-7", 1, "north depot"],
  [110, 11, " 00123 ", " RF-0007 ", 1, "north depot"],
  [111, 11, SPECIAL, SPECIAL, 1, "north depot"],
  [112, 11, "crateX", "tagX", 1, "north depot"],
  [113, 11, "é", "é", 1, "north depot"],
  [114, 11, "é", "é", 1, "north depot"],
  [115, 11, "🧪".repeat(100), "🧪".repeat(100), 1, "north depot"],
  [116, 11, "A".repeat(100), "A".repeat(100), 1, "north depot"],
  [117, 11, "a", "a", 1, "north depot"],
  [118, 11, "A", "A", 1, "north depot"],
  [119, 11, "0", "0", 1, "north depot"],
  [120, 11, "🧪", "🧪", 1, "north depot"],
  [121, 11, " \tasset\n ", " \tasset\n ", 1, "north depot"],
];

const recorders: ReturnType<typeof recordDb>[] = [];
const denyExternalBinding = vi.fn(() => { throw new Error("Identifier lookup must not use browser, R2 or upstream bindings"); });
const forbiddenBucket = Object.fromEntries([
  "get", "head", "list", "put", "delete", "createMultipartUpload", "resumeMultipartUpload"
].map((method) => [method, denyExternalBinding])) as unknown as R2Bucket;
let beforeState: unknown;

// Observe executions, including alternate D1 methods; do not replace SQL results.
// A write is both recorded and refused, so the failure cannot silently mutate fixtures.
function recordDb(real: D1Database) {
  const statements: Statement[] = [];
  const fail = () => { throw new Error("Identifier lookup must only read local D1"); };
  const batch = vi.fn(fail);
  const exec = vi.fn(fail);
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    const observe = (method: string) => {
      statements.push({ sql, binds, method });
      if (!/^\s*SELECT\b/i.test(sql) || method === "run") fail();
    };
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
      run: () => { observe("run"); return fail(); }
    } as unknown as D1PreparedStatement;
  }
  const db = {
    prepare: (sql: string) => wrap(real.prepare(sql), sql, []), batch, exec
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

async function state() {
  const db = TEST_ENV.CUSTOMER_DB;
  return Promise.all([
    db.prepare("SELECT * FROM customer_snapshot ORDER BY customer_id").all(),
    db.prepare("SELECT * FROM address_snapshot ORDER BY pickup_address_id").all(),
    db.prepare("SELECT * FROM container_snapshot ORDER BY container_id").all(),
    db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()
  ]).then((results) => results.map((r) => r.results));
}

async function request(
  query: Query | URL = {},
  options: { token?: string | null; db?: D1Database; headers?: Record<string, string> } = {}
) {
  const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
  recorders.push(recorder);
  const url = query instanceof URL ? query : new URL(PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = new URLSearchParams(query).toString();
  const headers = new Headers(options.headers);
  const token = options.token === undefined ? "test-read-token" : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV,
    CUSTOMER_DB: options.db ?? recorder.db,
    SNAPSHOTS: forbiddenBucket,
    BROWSER: { fetch: denyExternalBinding } as unknown as Fetcher
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

const ids = (body: Body) => body.rows.map((r) => r.container_id);

function next(response: Response, current: URL, expected: Record<string, string>) {
  const link = response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/container-snapshot\?[^<>\s]*>; rel="next"$/);
  const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], current);
  expect(target.origin).toBe(ORIGIN);
  expect(target.pathname).toBe(PATH);
  expect(target.hash).toBe("");
  expect(target.searchParams.has("offset")).toBe(false);
  for (const [key, value] of Object.entries(expected)) {
    if (key === "includeTotal" && value === "true") continue;
    expect(target.searchParams.getAll(key), key).toEqual([value]);
  }
  if (expected.includeTotal !== "false") {
    expect([null, "true"]).toContain(target.searchParams.get("includeTotal"));
    expect(target.searchParams.getAll("includeTotal").length).toBeLessThanOrEqual(1);
  }
  expect([...target.searchParams.keys()].every((key) =>
    Object.hasOwn(expected, key) || key === "includeTotal"
  )).toBe(true);
  return target;
}

beforeAll(async () => { await ensureD1TestTables(); });

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound network in identifier acceptance"); }));
  recorders.length = 0;
  denyExternalBinding.mockClear();
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, synced_at) VALUES (1, 'Synthetic One', ?), (2, 'Synthetic Two', ?)").bind(STAMP, STAMP),
    db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, synced_at) VALUES (11, 1, 'Synthetic A', ?), (12, 1, 'Synthetic B', ?), (21, 2, 'Synthetic C', ?)").bind(STAMP, STAMP, STAMP)
  ]);
  await db.batch(fixtures.map(([id, address, serial, rfid, enabled, location]) =>
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, serial_number, rfid, enabled, location_address, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, address, serial, rfid, enabled, location, STAMP)
  ));
  beforeState = await state();
});

afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denyExternalBinding).not.toHaveBeenCalled();
    for (const recorder of recorders) {
      expect(recorder.batch).not.toHaveBeenCalled();
      expect(recorder.exec).not.toHaveBeenCalled();
      expect(recorder.statements.every((s) => /^\s*SELECT\b/i.test(s.sql) && s.method !== "run")).toBe(true);
    }
    expect(await state(), "rows and schema must be unchanged by every request, including failures").toEqual(beforeState);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe.each(["serialNumber", "rfid"] as const)("%s: opaque exact identifier", (selector: Selector) => {
  it("returns every duplicate exact match, excluding substrings, nulls and case differences", async () => {
    const result = await page({ [selector]: selector === "serialNumber" ? SERIAL : RFID });
    expect(ids(result.body)).toEqual(selector === "serialNumber" ? [101, 102, 104, 105] : [101, 103, 104, 105]);
    expect(result.body.total).toBe(4);
    expect(result.body.nextCursor).toBeNull();
  });

  it.each([
    ["leading zeros are not numbers", "0", [119]],
    ["nonblank edge whitespace is data", " 00123 ", [110]],
    ["nonblank tabs and newlines are data", " \tasset\n ", [121]],
    ["lowercase is distinct", "a", [117]],
    ["uppercase is distinct", "A", [118]],
    ["one astral code point", "🧪", [120]],
    ["100 ASCII code points", "A".repeat(100), [116]],
    ["100 astral code points, not 100 UTF-16 units", "🧪".repeat(100), [115]],
    ["composed Unicode is not normalized", "é", [113]],
    ["decomposed Unicode is not normalized", "é", [114]],
    ["quotes, percent, underscore and URL delimiters are literal", SPECIAL, [111]],
    ["a wildcard spelling is not a wildcard", "%_", []],
    ["null is not an opaque string", "null", []],
    ["absent identifiers yield no match", "synthetic-no-such-asset", []]
  ] as const)("%s", async (_name, rawValue, expected) => {
    const value = selector === "rfid" && rawValue === " 00123 " ? " RF-0007 " : rawValue;
    const result = await page({ [selector]: value });
    expect(ids(result.body)).toEqual(expected);
    expect(result.body.total).toBe(expected.length);
    expect(result.body.nextCursor).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["ASCII whitespace only", " \t\r\n "],
    ["Unicode whitespace only", "  "],
    ["101 ASCII code points", "private-marker-" + "x".repeat(86)],
    ["101 astral code points", "🧪".repeat(101)],
    ["100 ASCII plus an astral code point", "x".repeat(100) + "🧪"]
  ])("rejects %s before any D1 access, without logging or reflecting the value", async (_name, value) => {
    const db = forbiddenDb();
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
    const { response } = await request({ [selector]: value }, { db: db.db, headers: { "if-none-match": "*" } });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toEqual({
      type: BAD_REQUEST,
      title: "Bad Request",
      status: 400,
      detail: `Invalid request query (${selector}). See docs/PROBLEMS.md#bad-request.`
    });
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["identical", "private-marker", "private-marker"],
    ["different", "private-first", "private-second"],
    ["empty plus nonempty", "", "private-marker"]
  ])("rejects repeated keys (%s) before D1 with the same fixed recovery guidance", async (_name, first, second) => {
    const db = forbiddenDb();
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
    const { response } = await request(new URLSearchParams([[selector, first], [selector, second]]), { db: db.db, headers: { "if-none-match": "*" } });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toEqual({
      type: BAD_REQUEST, title: "Bad Request", status: 400,
      detail: `Invalid request query (${selector}). See docs/PROBLEMS.md#bad-request.`
    });
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe("identifier composition and existing list behavior", () => {
  it.each([
    ["both identifiers", {}, [101, 104, 105]],
    ["qualified customer join", { customerId: "1" }, [101, 104]],
    ["address", { pickupAddressId: "11" }, [101]],
    ["container", { containerId: "104" }, [104]],
    ["q", { q: "NORTH" }, [101, 104, 105]],
    ["q mismatch", { q: "south" }, []],
    ["enabled true", { enabled: "true" }, [101, 105]],
    ["enabled false", { enabled: "false" }, [104]],
    ["enabled any", { enabled: "any" }, [101, 104, 105]],
    ["all legacy predicates", { customerId: "1", pickupAddressId: "11", containerId: "101", q: "north", enabled: "true" }, [101]],
    ["conflicting customer and address", { customerId: "2", pickupAddressId: "11" }, []],
    ["conflicting container", { containerId: "102" }, []]
  ] as const)("ANDs %s with identical COUNT/row scope", async (_name, filters, expected) => {
    for (const includeTotal of ["true", "false"]) {
      const result = await page({ serialNumber: SERIAL, rfid: RFID, ...filters, includeTotal });
      expect(ids(result.body)).toEqual(expected);
      expect(result.body.total).toBe(includeTotal === "false" ? null : expected.length);
      expect(result.body.nextCursor).toBeNull();
    }
  });

  it("does not treat one matching selector as a fallback for the other", async () => {
    const result = await page({ serialNumber: SERIAL, rfid: "RF-OTHER" });
    expect(ids(result.body)).toEqual([102]);
    expect(result.body.total).toBe(1);
  });

  it("retains individual filters when composed with the customer join", async () => {
    const serial = await page({ serialNumber: SERIAL, customerId: "1" });
    expect(ids(serial.body)).toEqual([101, 102, 104]);
    const rfid = await page({ rfid: RFID, customerId: "1" });
    expect(ids(rfid.body)).toEqual([101, 103, 104]);
  });

  it("keeps unselected defaults, canonical identities, and read-token access unchanged", async () => {
    const result = await page();
    expect(ids(result.body)).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121]);
    expect(result.body.total).toBe(21);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.body.rows[0]).toMatchObject({ container_id: 101, pickup_address_id: 11, serial_number: SERIAL, rfid: RFID, enabled: 1, synced_at: STAMP });
    expect(result.body.rows[7]).toMatchObject({ container_id: 108, serial_number: null, rfid: null });
    const explicit = await page({ enabled: "any", includeTotal: "true", offset: "0", limit: "50" });
    expect(explicit.body).toEqual(result.body);
    for (const token of ["test-api-token", "test-sync-secret"]) {
      expect((await page({}, token)).body).toEqual(result.body);
    }
  });

  it("ignores unrelated unknown names without changing results or SQL", async () => {
    const base = await page({ serialNumber: SERIAL, rfid: RFID });
    const unknown = await page({ serialNumber: SERIAL, rfid: RFID, bogus_param: "private-marker" });
    expect(unknown.body).toEqual(base.body);
    expect(unknown.recorder.statements).toEqual(base.recorder.statements);
  });

  it("preserves sparse stored-column names and always retains the canonical ID", async () => {
    const result = await page({ serialNumber: SERIAL, rfid: RFID, fields: "serial_number,rfid", includeTotal: "false" });
    expect(result.body).toEqual({
      rows: [101, 104, 105].map((container_id) => ({ container_id, serial_number: SERIAL, rfid: RFID })),
      total: null, nextCursor: null
    });
  });

  it.each([null, "not-a-valid-token"])("authenticates before malformed selector validation (token %s)", async (token) => {
    const db = forbiddenDb();
    const { response } = await request(new URLSearchParams([["serialNumber", ""], ["rfid", "private-first"], ["rfid", "private-second"]]), { token, db: db.db, headers: { "if-none-match": "*" } });
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const problem = await response.json() as Record<string, unknown>;
    expect(problem).toMatchObject({ status: 401, title: "Unauthorized" });
    expect(String(problem.type)).toMatch(/#unauthorized$/);
    expect(JSON.stringify(problem)).not.toMatch(/private-first|private-second|serialNumber|rfid/);
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
  });

  it("is idempotent and does not log successful asset identifiers", async () => {
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
    const first = await page({ serialNumber: SPECIAL, rfid: SPECIAL });
    const second = await page({ serialNumber: SPECIAL, rfid: SPECIAL });
    expect(ids(first.body)).toEqual([111]);
    expect(second.body).toEqual(first.body);
    expect(second.recorder.statements).toEqual(first.recorder.statements);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe("followable identifier lookup pages", () => {
  it.each([
    ["serialNumber", SERIAL, [101, 102, 104, 105]],
    ["rfid", RFID, [101, 103, 104, 105]]
  ] as const)("retains a lone %s selector on every next page", async (selector, value, expected) => {
    const filters = { [selector]: value, limit: "1", includeTotal: "false" };
    let current = await page(filters);
    for (const id of expected) {
      expect(ids(current.body)).toEqual([id]);
      expect(current.body.total).toBeNull();
      expect(current.body.nextCursor).toBe(id);
      current = await page(next(current.response, current.url, { ...filters, cursor: String(id) }));
    }
    expect(current.body).toEqual({ rows: [], total: null, nextCursor: null });
    expect(current.response.headers.get("link")).toBeNull();
  });

  it.each(["true", "false"])("retains duplicate matches across exact server links (includeTotal=%s)", async (includeTotal) => {
    const filters = { serialNumber: SERIAL, rfid: RFID, fields: "rfid", limit: "1", includeTotal };
    let current = await page(filters);
    const seen: unknown[] = [];
    for (const [expected, total, cursor] of [
      [[101], 3, 101], [[104], 2, 104], [[105], 1, 105], [[], 0, null]
    ] as const) {
      expect(ids(current.body)).toEqual(expected);
      expect(current.body.total).toBe(includeTotal === "false" ? null : total);
      expect(current.body.nextCursor).toBe(cursor);
      seen.push(...ids(current.body));
      if (cursor === null) {
        expect(current.response.headers.get("link")).toBeNull();
      } else {
        current = await page(next(current.response, current.url, { ...filters, cursor: String(cursor) }));
      }
    }
    expect(seen).toEqual([101, 104, 105]);
  });

  it("starts with offset, then follows keyset links with cursor-relative totals", async () => {
    const filters = { serialNumber: SERIAL, rfid: RFID, limit: "1" };
    const first = await page({ ...filters, offset: "1" });
    expect(ids(first.body)).toEqual([104]);
    expect(first.body.total).toBe(3);
    expect(first.body.nextCursor).toBe(104);
    const second = await page(next(first.response, first.url, { ...filters, cursor: "104" }));
    expect(ids(second.body)).toEqual([105]);
    expect(second.body.total).toBe(1);
  });

  it("honors a supplied cursor over a conflicting offset without dropping filters", async () => {
    const result = await page({ serialNumber: SERIAL, rfid: RFID, cursor: "101", offset: "19", limit: "2" });
    expect(ids(result.body)).toEqual([104, 105]);
    expect(result.body.total).toBe(2);
    expect(result.body.nextCursor).toBe(105);
  });

  it("encodes reserved/Unicode identifier data rather than interpolating it into Link", async () => {
    const result = await page({ serialNumber: SPECIAL, rfid: SPECIAL, fields: "rfid", limit: "1", includeTotal: "false" });
    expect(ids(result.body)).toEqual([111]);
    const target = next(result.response, result.url, { serialNumber: SPECIAL, rfid: SPECIAL, fields: "rfid", limit: "1", includeTotal: "false", cursor: "111" });
    expect(result.response.headers.get("link")).not.toContain(SPECIAL);
    const last = await page(target);
    expect(last.body).toEqual({ rows: [], total: null, nextCursor: null });
    expect(last.response.headers.get("link")).toBeNull();
  });

  it("preserves legacy joins, q, enabled, fields and both exact selectors in continuation", async () => {
    const filters = { serialNumber: SERIAL, rfid: RFID, customerId: "1", q: "north", enabled: "any", fields: "enabled", limit: "1", includeTotal: "false" };
    const first = await page(filters);
    expect(first.body.rows).toEqual([{ container_id: 101, enabled: 1 }]);
    const second = await page(next(first.response, first.url, { ...filters, cursor: "101" }));
    expect(second.body.rows).toEqual([{ container_id: 104, enabled: 0 }]);
  });
});

// Preserve the conditional JSON-list contract already published at the build
// head, even though it landed after this suite's original RED baseline.
it.each(["true", "false"])("keeps conditional reads scoped to the filtered representation (includeTotal=%s)", async (includeTotal) => {
  const query = { serialNumber: SPECIAL, rfid: SPECIAL, fields: "rfid", limit: "1", includeTotal };
  const first = await request(query);
  expect(first.response.status).toBe(200);
  const bytes = await first.response.text();
  expect(ids(JSON.parse(bytes) as Body)).toEqual([111]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  const tag = `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
  expect(first.response.headers.get("etag")).toBe(tag);
  const link = first.response.headers.get("link");
  expect(link).not.toBeNull();
  for (const validator of [tag, `W/${tag}`, "*"]) {
    const same = await request(query, { headers: { "if-none-match": validator } });
    expect(same.response.status).toBe(304);
    expect(same.response.body).toBeNull();
    expect((await same.response.arrayBuffer()).byteLength).toBe(0);
    expect(same.response.headers.get("etag")).toBe(tag);
    expect(same.response.headers.get("cache-control")).toBe("no-store");
    expect(same.response.headers.get("link")).toBe(link);
    expect(same.recorder.statements).toHaveLength(includeTotal === "false" ? 1 : 2);
    expect(same.recorder.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(includeTotal === "false" ? 0 : 1);
  }
  const different = await request({ ...query, serialNumber: SERIAL, rfid: RFID }, { headers: { "if-none-match": tag } });
  expect(different.response.status).toBe(200);
  expect(different.response.headers.get("etag")).not.toBe(tag);
  expect(ids(await different.response.json() as Body)).toEqual([101]);
});

it("uses bound equality for both identifiers and yields executable synthetic EXPLAIN plans without new schema", async () => {
  const result = await page({ serialNumber: SPECIAL, rfid: SPECIAL, customerId: "1", limit: "1" });
  const plans: Array<{ sql: string; details: string[] }> = [];
  for (const { sql, binds } of result.recorder.statements) {
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
    expect(plan.success).toBe(true);
    expect(plan.results.length).toBeGreaterThan(0);
    expect(plan.results.every((row) => typeof row.detail === "string" && row.detail.length > 0)).toBe(true);
    plans.push({ sql, details: plan.results.map((row) => row.detail) });
  }
  // On RED, include the actual query shape and local plan in the assertion evidence,
  // never binds/asset values. A plan is executability evidence, not a latency claim.
  expect(ids(result.body), `Synthetic local D1 EXPLAIN: ${JSON.stringify(plans)}`).toEqual([111]);
  for (const { sql, binds } of result.recorder.statements) {
    expect(sql).not.toContain(SPECIAL);
    expect(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP)\b/i);
    expect(sql).toMatch(/\bserial_number\b\s*=\s*\?/i);
    expect(sql).toMatch(/\brfid\b\s*=\s*\?/i);
    expect(binds).toContain(SPECIAL);
  }
});

describe("machine-readable identifier discovery", () => {
  type Parameter = {
    name: string; in: string; required?: boolean; description?: string;
    schema?: { type?: unknown; minLength?: number; maxLength?: number; description?: string; default?: unknown };
  };
  type Operation = { operationId?: string; description?: string; parameters?: Parameter[]; responses?: Record<string, { description?: string }> };

  async function document() {
    const url = new URL("/openapi.json", ORIGIN);
    const { response } = await request(url, { token: null });
    expect(response.status).toBe(200);
    return await response.json() as { paths: Record<string, Record<string, Operation>> };
  }

  it.each(["serialNumber", "rfid"])("publishes optional %s with the exact opaque-string and 400 contract", async (selector) => {
    const doc = await document();
    const operation = doc.paths[PATH].get;
    const matches = operation.parameters?.filter((p) => p.in === "query" && p.name === selector) ?? [];
    expect(matches).toHaveLength(1);
    const param = matches[0];
    expect(param).toMatchObject({ required: false, schema: { type: "string", minLength: 1, maxLength: 100 } });
    expect(param.schema?.default).toBeUndefined();
    const description = `${param.description ?? ""} ${param.schema?.description ?? ""}`;
    expect(description).toMatch(/case[- ]sensitive/i);
    expect(description).toMatch(/exact/i);
    expect(description).toMatch(/Unicode code points/i);
    expect(description).toMatch(/whitespace/i);
    expect(description).toMatch(/repeat|single/i);
    expect(operation.responses).toHaveProperty("400");
  });

  it("documents AND composition and the new rejection cases without losing legacy query guidance", async () => {
    const doc = await document();
    const operation = doc.paths[PATH].get;
    const description = operation.description ?? "";
    for (const key of ["serialNumber", "rfid", "customerId", "pickupAddressId", "containerId", "q", "enabled", "cursor", "offset"]) {
      expect(description, key).toContain(key);
    }
    expect(description).toMatch(/\bAND\b/i);
    const error = operation.responses?.["400"]?.description ?? "";
    for (const key of ["serialNumber", "rfid", "q", "limit", "offset", "enabled", "fields"]) {
      expect(error, key).toContain(key);
    }
    expect(error).toContain("application/problem+json");
    expect(error).toMatch(/before.*D1/i);
    expect(error).toMatch(/repeat|duplicate/i);
    expect(error).toMatch(/empty|blank/i);
    expect(error).toMatch(/100.*Unicode code points/i);
  });

  it("keeps the machine-readable query inventory aligned with the served parameter names", async () => {
    const doc = await document();
    const row = policyDoc.split("\n").find((line) => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    const inventory = [...(row!.split("|")[2]).matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort();
    const published = (doc.paths[PATH].get.parameters ?? []).filter((param) => param.in === "query").map((param) => param.name).sort();
    expect(inventory).toEqual(published);
  });

  it("preserves the stable operation ID and adds no endpoint or selector to unrelated reads", async () => {
    const doc = await document();
    expect(doc.paths[PATH].get.operationId).toBe("listContainerSnapshot");
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/address-snapshot", `${PATH}/{containerId}`, `${PATH}/export`, "/api/v1/customer-snapshot/changes"]) {
      const params = doc.paths[path].get.parameters?.map((p) => p.name) ?? [];
      expect(params, path).not.toContain("serialNumber");
      expect(params, path).not.toContain("rfid");
    }
    expect(app.routes.filter((r) => /(?:serialNumber|rfid)/i.test(r.path))).toEqual([]);
  });
});
