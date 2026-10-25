/// <reference types="vite/client" />

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";

/**
 * Test-Author-owned oracle. Run: npx vitest run --maxWorkers=2
 * test/containerMaterialColorFilters.acceptance.test.ts
 * Real hermetic D1; literal expected IDs, never a production predicate helper.
 * Mutation targets: ignored/swapped/trimmed/LIKE/case-folded labels, OR grouping,
 * missing COUNT/seek predicates, UTF-16 bounds, validation after D1/auth/304,
 * lost or unsafe next-link selectors, stale ETags and undocumented parameters.
 * No implementation, real tenant data, external services or schema changes.
 */
const TEST_ENV = env as unknown as Env;
const ORIGIN = "https://container-labels.test.invalid";
const PATH = "/api/v1/container-snapshot";
const STREAM = "001";
const COLOR = "Blue";
const SPECIAL = " 雪' OR 1=1 -- \"%_ /+?&#🚛 ";
const HUNDRED = "🚛".repeat(100);
const STAMP = "2026-01-02T03:04:05.000Z";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";

type Selector = "materialStream" | "color";
type Query = Record<string, string> | URLSearchParams | URL;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
type Fixture = readonly [number, number, string | null, string | null, number, string, string, string];

// Same-customer/different-address and different-customer duplicates distinguish
// the joined and nonjoined paths. Row 124 catches a swapped storage mapping.
const fixtures: readonly Fixture[] = [
  [101, 11, STREAM, COLOR, 1, "north depot", "SN-01", "TAG"],
  [102, 11, STREAM, "Red", 1, "south depot", "SN-01", "OTHER"],
  [103, 11, "other", COLOR, 1, "north depot", "SN-01", "TAG"],
  [104, 12, STREAM, COLOR, 0, "north depot", "SN-01", "TAG"],
  [105, 21, STREAM, COLOR, 1, "north depot", "SN-02", "TAG"],
  [106, 11, "x001x", "xBluex", 1, "north depot", "SN-01", "TAG"],
  [107, 11, "001x", "blue", 1, "north depot", "SN-01", "TAG"],
  [108, 11, null, null, 1, "north depot", "SN-01", "TAG"],
  [109, 11, "1", "Blue7", 1, "north depot", "SN-01", "TAG"],
  [110, 11, " 001 ", " Blue ", 1, "north depot", "SN-01", "TAG"],
  [111, 11, SPECIAL, SPECIAL, 1, "north depot", "SN-01", "TAG"],
  [112, 11, "", "", 1, "north depot", "SN-01", "TAG"],
  [113, 11, "é", "é", 1, "north depot", "SN-01", "TAG"],
  [114, 11, "é", "é", 1, "north depot", "SN-01", "TAG"],
  [115, 11, HUNDRED, HUNDRED, 1, "north depot", "SN-01", "TAG"],
  [116, 11, "a".repeat(100), "a".repeat(100), 1, "north depot", "SN-01", "TAG"],
  [117, 11, "a", "a", 1, "north depot", "SN-01", "TAG"],
  [118, 11, "A", "A", 1, "north depot", "SN-01", "TAG"],
  [119, 11, "0", "0", 1, "north depot", "SN-01", "TAG"],
  [120, 11, "🚛", "🚛", 1, "north depot", "SN-01", "TAG"],
  [121, 11, " \tlabel\n ", " \tlabel\n ", 1, "north depot", "SN-01", "TAG"],
  [122, 11, SPECIAL, SPECIAL, 1, "north depot", "SN-01", "TAG"],
  [123, 11, "%_", "%_", 1, "north depot", "SN-01", "TAG"],
  [124, 11, COLOR, STREAM, 1, "north depot", "SN-01", "TAG"],
];

const recorders: ReturnType<typeof recordedDb>[] = [];
const denyExternal = vi.fn(() => { throw new Error("Label reads must not use external services or writes"); });
let initialState: unknown;

function recordedDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const forbid = vi.fn(() => { throw new Error("Label reads must only SELECT local D1"); });
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    const record = () => { statements.push({ sql, binds }); };
    return {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql, values),
      first: (...args: unknown[]) => {
        record();
        return (stmt.first as (...args: unknown[]) => unknown)(...args);
      },
      all: () => { record(); return stmt.all(); },
      raw: (...args: unknown[]) => {
        record();
        return (stmt.raw as (...args: unknown[]) => unknown)(...args);
      },
      run: forbid,
    } as unknown as D1PreparedStatement;
  }
  const db = {
    prepare: (sql: string) => {
      prepared.push(sql);
      if (!/^\s*SELECT\b/i.test(sql)) return forbid();
      return wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []);
    },
    batch: forbid, exec: forbid,
  } as unknown as D1Database;
  return { db, prepared, statements, forbid };
}

function deniedDb() {
  const forbid = vi.fn(() => { throw new Error("Rejected request must not prepare or execute D1"); });
  return { db: { prepare: forbid, batch: forbid, exec: forbid } as unknown as D1Database, forbid };
}

async function state() {
  const db = TEST_ENV.CUSTOMER_DB;
  const rows = await Promise.all([
    db.prepare("SELECT * FROM customer_snapshot ORDER BY customer_id").all(),
    db.prepare("SELECT * FROM address_snapshot ORDER BY pickup_address_id").all(),
    db.prepare("SELECT * FROM container_snapshot ORDER BY container_id").all(),
    db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
  ]);
  return rows.map(row => row.results);
}

async function request(query: Query = {}, options: {
  token?: string | null; db?: D1Database; headers?: Record<string, string>;
} = {}) {
  const recorder = recordedDb();
  recorders.push(recorder);
  const url = query instanceof URL ? query : new URL(PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = new URLSearchParams(query).toString();
  const headers = new Headers(options.headers);
  const token = options.token === undefined ? "test-read-token" : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: options.db ?? recorder.db,
    SNAPSHOTS: Object.fromEntries([
      "get", "head", "list", "put", "delete", "createMultipartUpload", "resumeMultipartUpload",
    ].map(method => [method, denyExternal])) as unknown as R2Bucket,
    BROWSER: { fetch: denyExternal } as unknown as Fetcher,
  });
  return { response, recorder, url };
}

const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
const ids = (body: Body) => body.rows.map(row => row.container_id);
function reads(result: Awaited<ReturnType<typeof request>>) {
  const countFree = result.url.searchParams.get("includeTotal") === "false";
  expect(result.recorder.statements).toHaveLength(countFree ? 1 : 2);
  expect(result.recorder.statements.filter(isCount)).toHaveLength(countFree ? 0 : 1);
}
async function page(query: Query = {}) {
  const result = await request(query);
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  reads(result);
  const body = await result.response.json() as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  if (result.url.searchParams.get("includeTotal") === "false") expect(body.total).toBeNull();
  return { ...result, body };
}

function next(result: Awaited<ReturnType<typeof page>>, expected: Record<string, string>) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/container-snapshot\?[^<>\s]*>; rel="next"$/);
  const url = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(url.origin).toBe(ORIGIN);
  expect(url.username).toBe("");
  expect(url.password).toBe("");
  expect(url.hash).toBe("");
  expect(url.pathname).toBe(PATH);
  expect(url.searchParams.has("offset")).toBe(false);
  expect(url.searchParams.getAll("cursor")).toEqual([String(result.body.nextCursor)]);
  for (const [key, value] of Object.entries(expected)) {
    if ((key === "includeTotal" && value === "true") || (key === "order" && value === "asc") || (key === "enabled" && value === "any")) {
      expect([[], [value]], key).toContainEqual(url.searchParams.getAll(key));
    } else expect(url.searchParams.getAll(key), key).toEqual([value]);
  }
  expect([...url.searchParams.keys()].every(key => key === "cursor" || Object.hasOwn(expected, key))).toBe(true);
  return url;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  recorders.length = 0;
  denyExternal.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound fetch in label oracle"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, synced_at) VALUES (1, 'Synthetic One', ?), (2, 'Synthetic Two', ?)").bind(STAMP, STAMP),
    db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, synced_at) VALUES (11, 1, 'Synthetic A', ?), (12, 1, 'Synthetic B', ?), (21, 2, 'Synthetic C', ?)").bind(STAMP, STAMP, STAMP),
  ]);
  await db.batch([...fixtures].reverse().map(([id, address, stream, color, enabled, location, serial, rfid]) =>
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, ud_material_stream_ud, color, enabled, location_address, serial_number, rfid, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, address, stream, color, enabled, location, serial, rfid, STAMP)));
  initialState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denyExternal).not.toHaveBeenCalled();
    for (const recorder of recorders) expect(recorder.forbid).not.toHaveBeenCalled();
    expect(await state(), "every GET leaves rows and schema unchanged").toEqual(initialState);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe.each(["materialStream", "color"] as const)("%s: exact opaque stored label", (selector: Selector) => {
  it("retains duplicate exact matches without substring, null, empty or case widening", async () => {
    const result = await page({ [selector]: selector === "materialStream" ? STREAM : COLOR });
    expect(ids(result.body)).toEqual(selector === "materialStream" ? [101, 102, 104, 105] : [101, 103, 104, 105]);
    expect(result.body.total).toBe(4);
    expect(result.body.nextCursor).toBeNull();
  });

  it.each([
    ["significant padding", " 001 ", " Blue ", [110]],
    ["leading zero", "0", "0", [119]],
    ["lowercase", "a", "a", [117]],
    ["uppercase", "A", "A", [118]],
    ["100 ASCII code points", "a".repeat(100), "a".repeat(100), [116]],
    ["100 astral code points (not UTF-16 units)", HUNDRED, HUNDRED, [115]],
    ["one astral code point", "🚛", "🚛", [120]],
    ["composed Unicode is not normalized", "é", "é", [113]],
    ["decomposed Unicode is not normalized", "é", "é", [114]],
    ["nonblank tabs/newlines remain data", " \tlabel\n ", " \tlabel\n ", [121]],
    ["quotes and URL delimiters are literal", SPECIAL, SPECIAL, [111, 122]],
    ["LIKE wildcards are literal", "%_", "%_", [123]],
    ["a SQL-looking unknown cannot widen selection", "' OR 1=1 --", "' OR 1=1 --", []],
    ["null is not a string", "null", "null", []],
    ["unknown label is a normal empty success", "synthetic-unknown", "synthetic-unknown", []],
    ["column mappings cannot be swapped", COLOR, STREAM, [124]],
  ] as const)("%s", async (_name, material, color, expected) => {
    const result = await page({ [selector]: selector === "materialStream" ? material : color });
    expect(ids(result.body)).toEqual(expected);
    expect(result.body.total).toBe(expected.length);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  });

  const invalid = [
    ["empty", ""], ["ASCII blanks", " \t\r\n "], ["Unicode blanks", "  　"],
    ["101 ASCII code points", "synthetic-private-" + "x".repeat(83)],
    ["101 astral code points", "🚛".repeat(101)],
    ["100 ASCII plus an astral code point", "x".repeat(100) + "🚛"],
  ];
  it.each(invalid)("rejects %s before D1 and conditional handling with value-free errors", async (_name, value) => {
    const db = deniedDb();
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const result = await request({ [selector]: value }, { db: db.db, headers: { "if-none-match": "*" } });
    expect(db.forbid).not.toHaveBeenCalled();
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("link")).toBeNull();
    expect(await result.response.json()).toEqual({
      type: BAD_REQUEST, title: "Bad Request", status: 400,
      detail: `Invalid request query (${selector}). See docs/PROBLEMS.md#bad-request.`,
    });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["same", "synthetic-private-a", "synthetic-private-a"],
    ["different", "synthetic-private-a", "synthetic-private-b"],
    ["empty first", "", "synthetic-private-b"], ["empty last", "synthetic-private-a", ""],
  ])("rejects repeated keys (%s), never echoing either value", async (_name, a, b) => {
    const db = deniedDb();
    const result = await request(new URLSearchParams([[selector, a], [selector, b]]), { db: db.db });
    expect(db.forbid).not.toHaveBeenCalled();
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(await result.response.json()).toEqual({
      type: BAD_REQUEST, title: "Bad Request", status: 400,
      detail: `Invalid request query (${selector}). See docs/PROBLEMS.md#bad-request.`,
    });
  });

  it("rejects a bare key as empty before D1", async () => {
    const db = deniedDb();
    const result = await request(new URL(`${PATH}?${selector}`, ORIGIN), { db: db.db });
    expect(db.forbid).not.toHaveBeenCalled();
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(await result.response.json()).toEqual({
      type: BAD_REQUEST, title: "Bad Request", status: 400,
      detail: `Invalid request query (${selector}). See docs/PROBLEMS.md#bad-request.`,
    });
  });

  it("decodes an encoded duplicate key before repetition validation", async () => {
    const db = deniedDb();
    const encoded = `%${selector.charCodeAt(0).toString(16)}${selector.slice(1)}`;
    const url = new URL(`${PATH}?${selector}=first&${encoded}=second`, ORIGIN);
    const result = await request(url, { db: db.db });
    expect(db.forbid).not.toHaveBeenCalled();
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toMatchObject({ status: 400, detail: `Invalid request query (${selector}). See docs/PROBLEMS.md#bad-request.` });
  });
});

describe("label intersections, legacy controls and authority", () => {
  it.each([
    ["both labels", {}, [101, 104, 105]],
    ["qualified customer join", { customerId: "1" }, [101, 104]],
    ["other customer join", { customerId: "2" }, [105]],
    ["address", { pickupAddressId: "11" }, [101]],
    ["container", { containerId: "104" }, [104]],
    ["q", { q: "NORTH" }, [101, 104, 105]],
    ["q mismatch", { q: "south" }, []],
    ["enabled true", { enabled: "true" }, [101, 105]],
    ["enabled false", { enabled: "false" }, [104]],
    ["enabled any", { enabled: "any" }, [101, 104, 105]],
    ["serialNumber", { serialNumber: "SN-01" }, [101, 104]],
    ["rfid", { rfid: "TAG" }, [101, 104, 105]],
    ["canonical ID set", { ids: "105,102,101" }, [101, 105]],
    ["ID set cannot escape either label", { ids: "102,103,124" }, []],
    ["all existing row selectors", { customerId: "1", pickupAddressId: "11", containerId: "101", q: "north", enabled: "true", serialNumber: "SN-01", rfid: "TAG" }, [101]],
    ["conflicting customer/address", { customerId: "2", pickupAddressId: "11" }, []],
    ["conflicting identifier", { serialNumber: "SN-02", rfid: "OTHER" }, []],
  ] as const)("ANDs %s in both counted and count-free modes", async (_name, filters, expected) => {
    for (const includeTotal of ["true", "false"]) {
      const result = await page({ materialStream: STREAM, color: COLOR, ...filters, includeTotal });
      expect(ids(result.body)).toEqual(expected);
      expect(result.body.total).toBe(includeTotal === "false" ? null : expected.length);
      expect(result.body.nextCursor).toBeNull();
    }
  });

  it.each([
    [{ materialStream: STREAM, customerId: "1" }, [101, 102, 104]],
    [{ color: COLOR, customerId: "1" }, [101, 103, 104]],
    [{ materialStream: STREAM, color: "Red" }, [102]],
    [{ materialStream: "other", color: COLOR }, [103]],
  ] as const)("retains lone selectors and disjoint label pairs: %j", async (query, expected) => {
    const result = await page(query);
    expect(ids(result.body)).toEqual(expected);
    expect(result.body.total).toBe(expected.length);
  });

  it("CONTROL: omission preserves null/empty stored values, canonical IDs and defaults", async () => {
    const result = await page();
    expect(ids(result.body)).toEqual([101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124]);
    expect(result.body.total).toBe(24);
    expect(result.body.rows[0]).toMatchObject({ container_id: 101, pickup_address_id: 11, ud_material_stream_ud: STREAM, color: COLOR, synced_at: STAMP });
    expect(result.body.rows[7]).toMatchObject({ container_id: 108, ud_material_stream_ud: null, color: null });
    expect(result.body.rows[11]).toMatchObject({ container_id: 112, ud_material_stream_ud: "", color: "" });
    expect(result.body.nextCursor).toBeNull();
    const explicit = await page({ enabled: "any", includeTotal: "true", offset: "0", limit: "50" });
    expect(explicit.body).toEqual(result.body);
  });

  it.each([null, "invalid-read-token"])("CONTROL: auth precedes malformed labels (token %s)", async token => {
    const db = deniedDb();
    const result = await request(new URLSearchParams([["materialStream", ""], ["color", "synthetic-private-a"], ["color", "synthetic-private-b"]]), {
      token, db: db.db, headers: { "if-none-match": "*" },
    });
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const problem = await result.response.json();
    expect(problem).toMatchObject({ status: 401, title: "Unauthorized" });
    expect(JSON.stringify(problem)).not.toMatch(/synthetic-private|materialStream|color/);
    expect(db.forbid).not.toHaveBeenCalled();
  });

  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("retains authorized local GET access with %s", async token => {
    const result = await request({ materialStream: STREAM, color: COLOR }, { token });
    expect(result.response.status).toBe(200);
    expect(ids(await result.response.json() as Body)).toEqual([101, 104, 105]);
  });

  it("filters before sparse projection and always keeps the canonical ID", async () => {
    const result = await page({ materialStream: STREAM, color: COLOR, fields: "enabled", includeTotal: "false" });
    expect(result.body).toEqual({ rows: [
      { container_id: 101, enabled: 1 }, { container_id: 104, enabled: 0 }, { container_id: 105, enabled: 1 },
    ], total: null, nextCursor: null });
  });

  it("is idempotent and never logs successful labels", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const first = await page({ materialStream: SPECIAL, color: SPECIAL });
    const second = await page({ materialStream: SPECIAL, color: SPECIAL });
    expect(ids(first.body)).toEqual([111, 122]);
    expect(second.body).toEqual(first.body);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe.each(["true", "false"])("label continuation includeTotal=%s", includeTotal => {
  it.each([
    ["asc", [101, 104], 104, [105], null],
    ["desc", [105, 104], 104, [101], null],
  ] as const)("follows %s duplicate pages with cursor-relative totals", async (order, firstIds, cursor, lastIds, lastCursor) => {
    const filters = { materialStream: STREAM, color: COLOR, fields: "color", limit: "2", includeTotal, order };
    const first = await page(filters);
    expect(ids(first.body)).toEqual(firstIds);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 3);
    expect(first.body.nextCursor).toBe(cursor);
    const last = await page(next(first, filters));
    expect(ids(last.body)).toEqual(lastIds);
    expect(last.body.total).toBe(includeTotal === "false" ? null : 1);
    expect(last.body.nextCursor).toBe(lastCursor);
    expect(last.response.headers.get("link")).toBeNull();
    for (const row of [...first.body.rows, ...last.body.rows]) expect(Object.keys(row).sort()).toEqual(["color", "container_id"]);
  });

  it.each([
    ["materialStream", STREAM, [101, 102, 104, 105]],
    ["color", COLOR, [101, 103, 104, 105]],
  ] as const)("retains a lone %s until the full final/empty terminal page", async (selector, value, expected) => {
    const filters = { [selector]: value, limit: "1", includeTotal };
    let result = await page(filters);
    for (const [index, id] of expected.entries()) {
      expect(ids(result.body)).toEqual([id]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : 4 - index);
      expect(result.body.nextCursor).toBe(id);
      result = await page(next(result, filters));
    }
    expect(result.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
  });

  it.each([
    ["asc", "101", [104]], ["desc", "105", [104]],
  ] as const)("keeps upperId and %s cursor over a conflicting offset", async (order, cursor, expected) => {
    const result = await page({ materialStream: STREAM, color: COLOR, upperId: "104", cursor, order, offset: "99", includeTotal });
    expect(ids(result.body)).toEqual(expected);
    expect(result.body.total).toBe(includeTotal === "false" ? null : 1);
  });

  it.each(["asc", "desc"])("retains inclusive upperId across %s links", async order => {
    const filters = { materialStream: STREAM, color: COLOR, upperId: "104", order, limit: "1", includeTotal };
    let result = await page(filters);
    for (const [index, id] of (order === "asc" ? [101, 104] : [104, 101]).entries()) {
      expect(ids(result.body)).toEqual([id]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : 2 - index);
      result = await page(next(result, filters));
    }
    expect(result.body.rows).toEqual([]);
    expect(result.body.nextCursor).toBeNull();
  });

  it("uses offset only on the first page", async () => {
    const filters = { materialStream: STREAM, color: COLOR, limit: "1", includeTotal };
    const first = await page({ ...filters, offset: "1" });
    expect(ids(first.body)).toEqual([104]);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 3);
    const second = await page(next(first, filters));
    expect(ids(second.body)).toEqual([105]);
    expect(second.body.total).toBe(includeTotal === "false" ? null : 1);
  });

  it("preserves significant whitespace, reserved labels and composed selectors without copying untrusted keys", async () => {
    const filters = { materialStream: SPECIAL, color: SPECIAL, customerId: "1", pickupAddressId: "11", serialNumber: "SN-01", rfid: "TAG", q: "north", enabled: "true", fields: "color", upperId: "122", order: "desc", limit: "1", includeTotal };
    const url = new URL(PATH, ORIGIN);
    url.search = new URLSearchParams({ ...filters, access_token: "synthetic-credential", redirect: "https://untrusted.invalid", unknown: "private-marker" }).toString();
    const first = await page(url);
    expect(ids(first.body)).toEqual([122]);
    const target = next(first, filters);
    expect(first.response.headers.get("link")).not.toMatch(/synthetic-credential|untrusted|private-marker|https:/);
    expect(first.response.headers.get("link")).not.toContain(SPECIAL);
    const second = await page(target);
    expect(ids(second.body)).toEqual([111]);
    const empty = await page(next(second, filters));
    expect(empty.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(empty.response.headers.get("link")).toBeNull();
  });
});

it.each(["true", "false"])("ETags describe filtered bytes, not just the URL (includeTotal=%s)", async includeTotal => {
  const query = { materialStream: STREAM, color: COLOR, fields: "color", limit: "1", includeTotal };
  const first = await request(query);
  expect(first.response.status).toBe(200);
  const bytes = await first.response.text();
  expect(ids(JSON.parse(bytes) as Body)).toEqual([101]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  const tag = `"${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}"`;
  expect(first.response.headers.get("etag")).toBe(tag);
  const link = first.response.headers.get("link");
  expect(link).not.toBeNull();
  for (const validator of [tag, `W/${tag}`, "*"]) {
    const same = await request(query, { headers: { "if-none-match": validator } });
    expect(same.response.status).toBe(304);
    expect((await same.response.arrayBuffer()).byteLength).toBe(0);
    expect(same.response.headers.get("etag")).toBe(tag);
    expect(same.response.headers.get("link")).toBe(link);
    expect(same.response.headers.get("cache-control")).toBe("no-store");
    reads(same);
  }
  for (const changed of [{ materialStream: "other" }, { color: "Red" }, { fields: "enabled" }, { includeTotal: includeTotal === "true" ? "false" : "true" }]) {
    const result = await request({ ...query, ...changed }, { headers: { "if-none-match": tag } });
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("etag")).not.toBe(tag);
    reads(result);
  }
});

it.each<Record<string, string>>([{}, { customerId: "1" }])("binds the literal storage equalities on both join paths: %j", async join => {
  const result = await page({ materialStream: SPECIAL, color: SPECIAL, ...join, limit: "1" });
  expect(ids(result.body)).toEqual([111]);
  expect(result.body.total).toBe(2);
  for (const { sql, binds } of result.recorder.statements) {
    expect(sql).not.toContain(SPECIAL);
    expect(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP|COLLATE\s+NOCASE)\b/i);
    const unquoted = sql.replace(/["`\[\]]/g, "");
    expect(unquoted).toMatch(/\bud_material_stream_ud\s*=\s*\?/i);
    expect(unquoted).toMatch(/\bcolor\s*=\s*\?/i);
    expect(binds.filter(value => value === SPECIAL)).toHaveLength(2);
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
    expect(plan.success).toBe(true);
    expect(plan.results.length).toBeGreaterThan(0);
    // Executability only: there is deliberately no index or latency assertion.
  }
});

type Parameter = {
  name: string; in: string; required?: boolean; description?: string; example?: unknown;
  examples?: Record<string, { value?: unknown }>;
  schema?: { type?: string; minLength?: number; maxLength?: number; description?: string; default?: unknown; example?: unknown };
};
type Operation = { operationId?: string; description?: string; parameters?: Parameter[]; responses?: Record<string, { description?: string }> };
async function document() {
  const { response } = await request(new URL("/openapi.json", ORIGIN), { token: null });
  expect(response.status).toBe(200);
  return await response.json() as { paths: Record<string, { get: Operation }> };
}

describe("mounted machine-readable label discovery", () => {
  it.each(["materialStream", "color"])("publishes one optional %s string with actionable opaque-label guidance", async selector => {
    const operation = (await document()).paths[PATH].get;
    expect(operation.operationId).toBe("listContainerSnapshot");
    const params = operation.parameters?.filter(p => p.in === "query" && p.name === selector) ?? [];
    expect(params).toHaveLength(1);
    const param = params[0];
    expect(param.required ?? false).toBe(false);
    expect(param.schema).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
    expect(param.schema?.default).toBeUndefined();
    const description = `${param.description ?? ""} ${param.schema?.description ?? ""}`;
    for (const concept of [/exact/i, /case.sensitive/i, /Unicode code points/i, /whitespace/i, /opaque|stored/i, /URL.encod/i, /omit/i, /single|repeat|one value/i]) expect(description).toMatch(concept);
    const examples = [param.example, param.schema?.example, ...Object.values(param.examples ?? {}).map(e => e.value)];
    expect(examples.some(value => typeof value === "string" && value.trim().length > 0 && [...value].length <= 100)).toBe(true);
    if (selector === "materialStream") expect(description).toContain("ud_material_stream_ud");
  });

  it("publishes AND composition, empty success and value-free correction before D1", async () => {
    const operation = (await document()).paths[PATH].get;
    const guidance = operation.description ?? "";
    for (const name of ["materialStream", "color", "serialNumber", "rfid", "customerId", "pickupAddressId", "containerId", "q", "enabled"]) expect(guidance).toContain(name);
    expect(guidance).toMatch(/\bAND\b|intersect/i);
    expect(guidance).toMatch(/unknown|unmatched|no match/i);
    expect(guidance).toMatch(/empty|zero rows/i);
    const recovery = operation.responses?.["400"]?.description ?? "";
    for (const name of ["materialStream", "color"]) expect(recovery).toContain(name);
    for (const concept of [/empty|blank/i, /repeat|duplicate/i, /100.*Unicode code points/i, /before.*D1/i, /URL.encod/i, /omit/i]) expect(recovery).toMatch(concept);
    expect(recovery).toContain("application/problem+json");
    expect(recovery).toContain("docs/PROBLEMS.md#bad-request");
  });

  it("aligns the query inventory with the served selectors rather than silently omitting both", async () => {
    const operation = (await document()).paths[PATH].get;
    const row = policyDoc.split("\n").find(line => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    const inventory = [...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map(match => match[1]).sort();
    expect(inventory).toEqual(expect.arrayContaining(["materialStream", "color"]));
    expect(inventory).toEqual(operation.parameters?.filter(p => p.in === "query").map(p => p.name).sort());
  });

  it("CONTROL: keeps these labels off unrelated reads and adds no lookup endpoint", async () => {
    const doc = await document();
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/address-snapshot", `${PATH}/{containerId}`, `${PATH}/export`]) {
      const names = doc.paths[path].get.parameters?.map(p => p.name) ?? [];
      expect(names, path).not.toContain("materialStream");
      expect(names, path).not.toContain("color");
    }
    expect(app.routes.filter(route => /(?:materialStream|color)/i.test(route.path))).toEqual([]);
  });
});
