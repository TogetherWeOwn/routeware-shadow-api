/// <reference types="vite/client" />

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";

/**
 * Independent, Test-Author-owned oracle. Run:
 * npx vitest run test/containerNoteSearch.acceptance.test.ts --maxWorkers=2
 *
 * Mutation targets: ignored note, q widening, LIKE/interpolation, full Unicode
 * folding/normalization, untrimmed boundaries, UTF-16 length validation, lost
 * AND/join/count scope, post-D1 validation, leaked values, lost Link selectors,
 * stale representation validators. Expected IDs/pages are hand-derived literals.
 * Real local D1 supplies results; network, browser, R2, cache and writes are denied.
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/container-snapshot";
const ORIGIN = "https://equipment-client.invalid";
const FRAGMENT = "gate";
const SPECIAL = "key' OR 1=1 -- %_ 🧪&+/#?";
const STAMP = "2026-01-01T00:00:00.000Z";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";

type Fixture = readonly [number, number, string | null, string, string, number, string];
const fixtures: readonly Fixture[] = [
  [101, 11, "use GATE after noon", "00123", "RF-7", 1, "north depot"],
  [103, 11, "use GATE after noon", "00123", "RF-7", 1, "north depot"],
  [107, 12, "gate near the ramp", "OTHER", "RF-7", 1, "south depot"],
  [109, 12, "gate closed for repair", "00123", "RF-7", 0, "north depot"],
  [113, 21, "side gate", "00123", "RF-OTHER", 1, "north depot"],
  [119, 21, "rear gate", "00123", "RF-7", 1, "north depot"],
  [123, 11, "call attendant", "gate-serial", "other", 1, "gate location"],
  [127, 11, "", "NONE", "other", 1, "gate location"],
  [131, 11, null, "NONE", "other", 1, "north depot"],
  [137, 11, `before ${SPECIAL} after`, "special-serial", "special-rfid", 1, "north depot"],
  [139, 12, `before ${SPECIAL} after`, "special-serial", "special-rfid", 0, "north depot"],
  [149, 21, `before ${SPECIAL} after`, "special-serial", "special-rfid", 1, "north depot"],
  [151, 11, "%", "NONE", "other", 1, "north depot"],
  [157, 11, "_", "NONE", "other", 1, "north depot"],
  [163, 11, "percentXunderscore", "NONE", "other", 1, "north depot"],
  [167, 11, " \tmarker\n ", "NONE", "other", 1, "north depot"],
  [173, 11, "marker", "NONE", "other", 1, "north depot"],
  [179, 11, "line \tinside\n mark", "NONE", "other", 1, "north depot"],
  [181, 11, "line inside mark", "NONE", "other", 1, "north depot"],
  [191, 11, "🧪".repeat(100), "NONE", "other", 1, "north depot"],
  [193, 11, "x".repeat(100), "NONE", "other", 1, "north depot"],
  [197, 11, "é", "NONE", "other", 1, "north depot"],
  [199, 11, "É", "NONE", "other", 1, "north depot"],
  [211, 11, "é", "NONE", "other", 1, "north depot"],
  [223, 11, "walkthrough", "NONE", "other", 1, "north depot"],
  [229, 11, "walk around", "NONE", "other", 1, "north depot"]
];

type Query = Record<string, string> | URLSearchParams;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[]; method: string };
const ids = (body: Body) => body.rows.map((row) => row.container_id);
const isCount = (statement: Statement) => /\bCOUNT\s*\(/i.test(statement.sql);
const recorders: ReturnType<typeof recordingDb>[] = [];
const denyExternal = vi.fn(() => { throw new Error("Note lookup must not access network, browser, R2 or cache"); });
const forbiddenBucket = Object.fromEntries([
  "get", "head", "list", "put", "delete", "createMultipartUpload", "resumeMultipartUpload"
].map((method) => [method, denyExternal])) as unknown as R2Bucket;
let cacheSpies: ReturnType<typeof vi.spyOn>[] = [];
let beforeState: unknown;

// Forward SQL to real local D1. Observe prepare AND execution; never fake rows.
function recordingDb() {
  const statements: Statement[] = [];
  const prepared: string[] = [];
  const fail = () => { throw new Error("Note lookup must only SELECT from local D1"); };
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
  const results = await Promise.all([
    ...["customer_snapshot", "address_snapshot", "container_snapshot"].map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
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
  const headers = new Headers(options.headers);
  const token = options.token === undefined ? "test-read-token" : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: recorder.db, SNAPSHOTS: forbiddenBucket,
    BROWSER: { fetch: denyExternal } as unknown as Fetcher
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
  expect(result.recorder.statements.filter(isCount)).toHaveLength(counted ? 1 : 0);
  if (!counted) expect(body.total).toBeNull();
  return { ...result, body };
}

function next(response: Response, current: URL, expected: Record<string, string>) {
  const link = response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/container-snapshot\?[^<>\s]*>; rel="next"$/);
  const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], current);
  expect(target.origin).toBe(current.origin);
  expect(target.pathname).toBe(PATH);
  expect(target.username).toBe("");
  expect(target.password).toBe("");
  expect(target.hash).toBe("");
  expect(target.searchParams.has("offset")).toBe(false);
  for (const [key, value] of Object.entries(expected)) {
    if ((key === "includeTotal" && value === "true") || (key === "enabled" && value === "any") || (key === "order" && value === "asc")) {
      expect([null, value]).toContain(target.searchParams.get(key));
      expect(target.searchParams.getAll(key).length).toBeLessThanOrEqual(1);
    } else expect(target.searchParams.getAll(key), key).toEqual([value]);
  }
  expect([...target.searchParams.keys()].every((key) => Object.hasOwn(expected, key))).toBe(true);
  expect(link).not.toMatch(/equipment-client|Bearer|test-read-token|private-unknown/i);
  return target;
}

function sameScope(statements: Statement[]) {
  const count = statements.find(isCount)!;
  const rows = statements.find((s) => !isCount(s))!;
  const where = (sql: string) => /\bWHERE\b([\s\S]*?)(?:\bORDER\s+BY\b|\bLIMIT\b|$)/i.exec(sql)?.[1].replace(/\s+/g, " ").trim();
  expect(where(count.sql)).toBeDefined();
  expect(where(rows.sql)).toBe(where(count.sql));
  expect(rows.binds.slice(0, count.binds.length)).toEqual(count.binds);
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  recorders.length = 0;
  denyExternal.mockClear();
  vi.stubGlobal("fetch", vi.fn(denyExternal));
  cacheSpies = [
    vi.spyOn(caches, "open").mockImplementation(denyExternal),
    ...(["match", "put", "delete"] as const).map((method) => vi.spyOn((caches as CacheStorage & { default: Cache }).default, method).mockImplementation(denyExternal))
  ];
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, comments, synced_at) VALUES (1, 'Synthetic One', 'parent-only-fragment', ?), (2, 'Synthetic Two', NULL, ?)").bind(STAMP, STAMP),
    db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, driver_note, comments, synced_at) VALUES (11, 1, 'Synthetic A', 'parent-only-fragment', 'parent-only-fragment', ?), (12, 1, 'Synthetic B', NULL, NULL, ?), (21, 2, 'Synthetic C', NULL, NULL, ?)").bind(STAMP, STAMP, STAMP)
  ]);
  await db.batch([...fixtures].reverse().map(([id, address, note, serial, rfid, enabled, location]) =>
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, container_note, serial_number, rfid, enabled, location_address, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, address, note, serial, rfid, enabled, location, STAMP)
  ));
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denyExternal).not.toHaveBeenCalled();
    for (const spy of cacheSpies) expect(spy).not.toHaveBeenCalled();
    for (const recorder of recorders) {
      expect(recorder.batch).not.toHaveBeenCalled();
      expect(recorder.exec).not.toHaveBeenCalled();
      expect(recorder.prepared.every((sql) => /^\s*SELECT\b/i.test(sql))).toBe(true);
      expect(recorder.statements.every((s) => s.method !== "run")).toBe(true);
    }
    expect(await state(), "requests must leave synthetic rows and schema unchanged").toEqual(beforeState);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

it("establishes the independent local-D1 fixture oracle before exercising the route", async () => {
  const rows = await TEST_ENV.CUSTOMER_DB.prepare("SELECT c.container_id FROM container_snapshot c WHERE instr(lower(coalesce(c.container_note, '')), lower(?)) > 0 ORDER BY c.container_id")
    .bind("gate").all<{ container_id: number }>();
  expect(rows.results.map((row) => row.container_id)).toEqual([101, 103, 107, 109, 113, 119]);
  const joined = await TEST_ENV.CUSTOMER_DB.prepare("SELECT c.container_id FROM container_snapshot c INNER JOIN address_snapshot a ON a.pickup_address_id = c.pickup_address_id WHERE a.customer_id = ? AND instr(lower(coalesce(c.container_note, '')), lower(?)) > 0 ORDER BY c.container_id")
    .bind(1, "gate").all<{ container_id: number }>();
  expect(joined.results.map((row) => row.container_id)).toEqual([101, 103, 107, 109]);
});

describe("literal stored instruction fragments", () => {
  it("returns duplicate note matches without searching location, serial or parent notes", async () => {
    const { body } = await page({ note: FRAGMENT });
    expect(ids(body)).toEqual([101, 103, 107, 109, 113, 119]);
    expect(body.total).toBe(6);
    expect(body.nextCursor).toBeNull();
    expect(body.rows[0]).toMatchObject({ container_id: 101, pickup_address_id: 11, container_note: "use GATE after noon", synced_at: STAMP });
  });

  it.each([
    ["ASCII case-insensitive substring", "GATE", [101, 103, 107, 109, 113, 119]],
    ["trimmed query boundaries", " \t gate\n ", [101, 103, 107, 109, 113, 119]],
    ["trimmed Unicode query boundaries", " marker ", [167, 173]],
    ["internal whitespace remains literal", "line \tinside\n mark", [179]],
    ["substring rather than equality", "walk", [223, 229]],
    ["100 ASCII code points", "x".repeat(100), [193]],
    ["100 astral code points, not UTF-16 units", "🧪".repeat(100), [191]],
    ["trim before length validation", ` \t${"🧪".repeat(100)}\n `, [191]],
    ["one astral code point", "🧪", [137, 139, 149, 191]],
    ["ASCII-only folding preserves lowercase non-ASCII", "é", [197]],
    ["ASCII-only folding preserves uppercase non-ASCII", "É", [199]],
    ["no Unicode normalization", "é", [211]],
    ["literal quotes and URL delimiters", SPECIAL, [137, 139, 149]],
    ["SQL-looking text remains bound", "' OR 1=1 --", [137, 139, 149]],
    ["percent and underscore together are literal", "%_", [137, 139, 149]],
    ["percent alone is literal", "%", [137, 139, 149, 151]],
    ["underscore alone is literal", "_", [137, 139, 149, 157]],
    ["null notes are not the string null", "null", []],
    ["parent notes are not searched", "parent-only-fragment", []],
    ["no match is an empty success", "synthetic-absent-instruction", []]
  ] as const)("%s", async (_label, note, expected) => {
    const { body, response } = await page({ note });
    expect(ids(body)).toEqual(expected);
    expect(body.total).toBe(expected.length);
    expect(body.nextCursor).toBeNull();
    expect(response.headers.get("link")).toBeNull();
  });

  it("keeps q restricted to location/serial instead of widening it to instructions", async () => {
    expect(ids((await page({ q: "gate" })).body)).toEqual([123, 127]);
    expect(ids((await page({ note: "gate", q: "gate" })).body)).toEqual([]);
  });

  it.each(["", " \t\r\n ", "  ", " ".repeat(101)])("treats blank note as omitted, without a predicate, bind or next-link key (%j)", async (note) => {
    const query = { limit: "2", includeTotal: "false", order: "asc" };
    const omitted = await page(query);
    const blank = await page({ ...query, note });
    expect(ids(blank.body)).toEqual([101, 103]);
    expect(blank.body).toEqual(omitted.body);
    expect(blank.recorder.statements).toEqual(omitted.recorder.statements);
    expect(blank.response.headers.get("etag")).toBe(omitted.response.headers.get("etag"));
    expect(blank.response.headers.get("link")).toBe(omitted.response.headers.get("link"));
    next(blank.response, blank.url, { ...query, cursor: "103" });
  });

  it("preserves omitted defaults, canonical identities and stored null/empty notes", async () => {
    const result = await page();
    expect(ids(result.body)).toEqual([101, 103, 107, 109, 113, 119, 123, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181, 191, 193, 197, 199, 211, 223, 229]);
    expect(result.body.total).toBe(26);
    expect(result.body.rows[7]).toMatchObject({ container_id: 127, container_note: "" });
    expect(result.body.rows[8]).toMatchObject({ container_id: 131, container_note: null });
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    expect((await page({ enabled: "any", order: "asc", includeTotal: "true", limit: "50", offset: "0" })).body).toEqual(result.body);
  });

  it("accepts the selector for every existing read-capable role", async () => {
    for (const token of ["test-read-token", "test-api-token", "test-sync-secret"]) {
      expect(ids((await page({ note: FRAGMENT }, token)).body)).toEqual([101, 103, 107, 109, 113, 119]);
    }
  });
});

describe("AND-composition on both join paths", () => {
  it.each([
    ["customer join", { customerId: "1" }, [101, 103, 107, 109]],
    ["other customer", { customerId: "2" }, [113, 119]],
    ["missing customer", { customerId: "3" }, []],
    ["parent ID", { pickupAddressId: "11" }, [101, 103]],
    ["other parent ID", { pickupAddressId: "12" }, [107, 109]],
    ["primary ID", { containerId: "109" }, [109]],
    ["primary ID mismatch", { containerId: "123" }, []],
    ["ID set", { ids: "109,103,131" }, [103, 109]],
    ["serial", { serialNumber: "00123" }, [101, 103, 109, 113, 119]],
    ["RFID", { rfid: "RF-7" }, [101, 103, 107, 109, 119]],
    ["both opaque identifiers", { serialNumber: "00123", rfid: "RF-7" }, [101, 103, 109, 119]],
    ["enabled true", { enabled: "true" }, [101, 103, 107, 113, 119]],
    ["enabled false", { enabled: "false" }, [109]],
    ["enabled any", { enabled: "any" }, [101, 103, 107, 109, 113, 119]],
    ["q intersection", { q: "NORTH" }, [101, 103, 109, 113, 119]],
    ["q on alternate parent", { q: "south" }, [107]],
    ["q mismatch", { q: "absent-location" }, []],
    ["upper bound", { upperId: "107" }, [101, 103, 107]],
    ["joined q/enabled", { customerId: "1", q: "north", enabled: "false" }, [109]],
    ["conflicting parent and customer", { customerId: "2", pickupAddressId: "11" }, []],
    ["all selectors", { customerId: "1", pickupAddressId: "11", containerId: "103", ids: "101,103,113", serialNumber: "00123", rfid: "RF-7", q: "north", enabled: "true", upperId: "107" }, [103]]
  ] as const)("ANDs %s in counted and zero-COUNT modes", async (_label, filters, expected) => {
    const counted = await page({ note: FRAGMENT, ...filters });
    const countFree = await page({ note: FRAGMENT, ...filters, includeTotal: "false" });
    expect(ids(counted.body)).toEqual(expected);
    expect(counted.body.total).toBe(expected.length);
    expect(counted.body.nextCursor).toBeNull();
    expect(countFree.body).toEqual({ ...counted.body, total: null });
    expect(countFree.recorder.statements).toEqual(counted.recorder.statements.filter((s) => !isCount(s)));
    sameScope(counted.recorder.statements);
  });

  it("selects on a column absent from the fieldset and retains the canonical ID", async () => {
    const { body } = await page({ note: "GATE", customerId: "1", fields: "enabled", includeTotal: "false" });
    expect(body).toEqual({ rows: [
      { container_id: 101, enabled: 1 }, { container_id: 103, enabled: 1 },
      { container_id: 107, enabled: 1 }, { container_id: 109, enabled: 0 }
    ], total: null, nextCursor: null });
    const stored = await page({ note: "GATE", containerId: "101", fields: "container_note,pickup_address_id" });
    expect(stored.body).toEqual({ rows: [{ container_id: 101, container_note: "use GATE after noon", pickup_address_id: 11 }], total: 1, nextCursor: null });
  });

  it("is idempotent and ignores unknown keys without logging instruction values or arbitrary names", async () => {
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
    const first = await page({ note: SPECIAL });
    const second = await page(new URLSearchParams([["note", SPECIAL], ["private-unknown-key", "private-unknown-first"], ["private-unknown-key", "private-unknown-second"]]));
    expect(ids(first.body)).toEqual([137, 139, 149]);
    expect(second.body).toEqual(first.body);
    expect(second.recorder.statements).toEqual(first.recorder.statements);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe.each(["true", "false"])("note pagination includeTotal=%s", (includeTotal) => {
  it.each([
    ["ascending offset", { order: "asc", offset: "1", limit: "2" }, [103, 107], 6, 107],
    ["descending offset", { order: "desc", offset: "1", limit: "2" }, [113, 109], 6, 109],
    ["ascending seek", { order: "asc", cursor: "103", limit: "2" }, [107, 109], 4, 109],
    ["descending seek", { order: "desc", cursor: "109", limit: "2" }, [107, 103], 3, 103],
    ["cursor overrides offset", { order: "desc", cursor: "109", offset: "999", limit: "2" }, [107, 103], 3, 103],
    ["partial terminal", { order: "asc", cursor: "113", limit: "2" }, [119], 1, null],
    ["empty seek", { order: "desc", cursor: "101", limit: "2" }, [], 0, null],
    ["upperId with ascending seek", { order: "asc", cursor: "103", upperId: "109", limit: "2" }, [107, 109], 2, 109],
    ["upperId with descending seek", { order: "desc", cursor: "119", upperId: "109", limit: "2" }, [109, 107], 4, 107]
  ] as const)("%s keeps cursor-relative count and row predicates identical", async (_label, query, expected, total, cursor) => {
    const { body, response, recorder } = await page({ note: FRAGMENT, ...query, includeTotal });
    expect(ids(body)).toEqual(expected);
    expect(body.total).toBe(includeTotal === "false" ? null : total);
    expect(body.nextCursor).toBe(cursor);
    if (cursor === null) expect(response.headers.get("link")).toBeNull();
    if (includeTotal === "true") sameScope(recorder.statements);
    const rows = recorder.statements.find((s) => !isCount(s))!;
    const tail = "cursor" in query ? [Number(query.limit)] : [Number(query.limit), Number(query.offset)];
    expect(rows.binds.slice(-tail.length)).toEqual(tail);
    if ("cursor" in query) for (const stmt of recorder.statements) expect(stmt.sql).not.toMatch(/\bOFFSET\b/i);
  });

  it.each(["asc", "desc"])("follows complete %s pages for normalized quote/percent/underscore/Unicode notes", async (order) => {
    const filters = { note: SPECIAL, order, limit: "1", includeTotal, fields: "container_note", upperId: "149" };
    let current = await page({ ...filters, note: ` \t${SPECIAL}\n `, "private-unknown-key": "private-unknown-value" });
    const expected = order === "asc" ? [137, 139, 149] : [149, 139, 137];
    const seen: unknown[] = [];
    for (const [index, id] of expected.entries()) {
      expect(ids(current.body)).toEqual([id]);
      expect(current.body.total).toBe(includeTotal === "false" ? null : [3, 2, 1][index]);
      expect(current.body.nextCursor).toBe(id);
      expect(current.body.rows).toEqual([{ container_id: id, container_note: `before ${SPECIAL} after` }]);
      seen.push(...ids(current.body));
      const target = next(current.response, current.url, { ...filters, cursor: String(id) });
      expect(current.response.headers.get("link")).not.toContain(SPECIAL);
      current = await page(target);
    }
    expect(seen).toEqual(expected);
    expect(current.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(current.response.headers.get("link")).toBeNull();
  });
});

it.each(["asc", "desc"])("retains every selector on joined %s continuations after offset", async (order) => {
  const filters = { note: FRAGMENT, customerId: "1", pickupAddressId: "11", ids: "101,103,113", serialNumber: "00123", rfid: "RF-7", q: "north", enabled: "true", upperId: "109", fields: "enabled", order, limit: "1", includeTotal: "false" };
  let current = await page({ ...filters, note: " gate ", offset: "1", "private-unknown-key": "private-unknown-value" });
  const id = order === "asc" ? 103 : 101;
  expect(current.body).toEqual({ rows: [{ container_id: id, enabled: 1 }], total: null, nextCursor: id });
  current = await page(next(current.response, current.url, { ...filters, cursor: String(id) }));
  expect(current.body).toEqual({ rows: [], total: null, nextCursor: null });
  expect(current.response.headers.get("link")).toBeNull();
});

it("retains a supplied primary ID on its exactly full single-row continuation", async () => {
  const filters = { note: FRAGMENT, containerId: "109", limit: "1", includeTotal: "false", order: "desc" };
  const first = await page(filters);
  expect(ids(first.body)).toEqual([109]);
  const last = await page(next(first.response, first.url, { ...filters, cursor: "109" }));
  expect(last.body).toEqual({ rows: [], total: null, nextCursor: null });
  expect(last.response.headers.get("link")).toBeNull();
});

describe("pre-D1 value-free validation and auth ordering", () => {
  async function rejected(query: Query | URL) {
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
    const { response, recorder } = await request(query, { headers: { "if-none-match": "*" } });
    expect.soft(response.status).toBe(400);
    expect.soft(recorder.prepared).toEqual([]);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBeNull();
    expect(response.headers.get("link")).toBeNull();
    expect(await response.json()).toEqual({
      type: BAD_REQUEST, title: "Bad Request", status: 400,
      detail: "Invalid request query (note). See docs/PROBLEMS.md#bad-request."
    });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  }

  it.each([
    ["101 ASCII code points", "private-marker-" + "x".repeat(86)],
    ["101 astral code points", "🧪".repeat(101)],
    ["100 ASCII plus an astral", "x".repeat(100) + "🧪"],
    ["101 nonblank points after trim", ` \t${"🧪".repeat(101)}\n `]
  ])("rejects %s without 304, SQL, cache or external work", async (_label, note) => {
    await rejected({ note, "private-unknown-key": "private-unknown-value" });
  });

  it.each([
    ["identical", "private-first", "private-first"], ["different", "private-first", "private-second"],
    ["blank then valid", "", FRAGMENT], ["valid then blank", FRAGMENT, ""], ["both blank", " ", "\t"]
  ])("rejects repeated note (%s), never taking first or last", async (_label, first, second) => {
    await rejected(new URLSearchParams([["note", first], ["note", second], ["private-unknown-key", "private-unknown-value"]]));
  });

  it("recognizes a percent-encoded name as a repeated note key", async () => {
    await rejected(new URL(PATH + "?note=private-first&%6eote=private-second", ORIGIN));
  });

  it.each([null, "invalid-synthetic-token"])("returns 401 before valid/malformed note work (token %s)", async (token) => {
    for (const query of [{ note: FRAGMENT }, { note: "x".repeat(101) }, new URLSearchParams([["note", "private-first"], ["note", "private-second"]])]) {
      const { response, recorder } = await request(query, { token, headers: { "if-none-match": "*" } });
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(response.headers.get("etag")).toBeNull();
      const problem = await response.json();
      expect(problem).toMatchObject({ status: 401, title: "Unauthorized" });
      expect(JSON.stringify(problem)).not.toMatch(/private-first|private-second|gate|note/);
      expect(recorder.prepared).toEqual([]);
    }
  });
});

it.each(["true", "false"])("hashes filtered served bytes and preserves bodyless 304 semantics (includeTotal=%s)", async (includeTotal) => {
  const query = { note: SPECIAL, fields: "container_note", order: "desc", limit: "1", includeTotal };
  const first = await request(query);
  expect(first.response.status).toBe(200);
  const bytes = await first.response.text();
  expect(ids(JSON.parse(bytes) as Body)).toEqual([149]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  const tag = `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
  expect(first.response.headers.get("etag")).toBe(tag);
  const link = first.response.headers.get("link");
  expect(link).not.toBeNull();
  for (const validator of [tag, `W/${tag}`, "*"]) {
    const same = await request({ ...query, note: ` ${SPECIAL} ` }, { headers: { "if-none-match": validator } });
    expect(same.response.status).toBe(304);
    expect(same.response.body).toBeNull();
    expect((await same.response.arrayBuffer()).byteLength).toBe(0);
    expect(same.response.headers.get("etag")).toBe(tag);
    expect(same.response.headers.get("link")).toBe(link);
    expect(same.response.headers.get("cache-control")).toBe("no-store");
    expect(same.recorder.statements).toEqual(first.recorder.statements);
  }
  const different = await request({ ...query, note: FRAGMENT }, { headers: { "if-none-match": tag } });
  expect(different.response.status).toBe(200);
  expect(different.response.headers.get("etag")).not.toBe(tag);
  expect(ids(await different.response.json() as Body)).toEqual([119]);
  const fieldset = await request({ ...query, fields: "enabled" }, { headers: { "if-none-match": tag } });
  expect(fieldset.response.status).toBe(200);
  expect(fieldset.response.headers.get("etag")).not.toBe(tag);
});

it.each<Record<string, string>>([{}, { customerId: "1" }])("binds one normalized literal in COUNT and rows on both SQL paths (%j)", async (filters) => {
  const { body, recorder } = await page({ note: ` ${SPECIAL} `, ...filters });
  sameScope(recorder.statements);
  for (const { sql, binds } of recorder.statements) {
    expect.soft(sql).not.toContain(SPECIAL);
    if ("customerId" in filters) expect(sql).toMatch(/INNER JOIN address_snapshot a/i);
    else expect(sql).not.toMatch(/\bJOIN\b/i);
    expect.soft(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP)\b/i);
    expect.soft(sql).toMatch(/instr\(\s*lower\(\s*coalesce\(\s*c\.container_note\s*,\s*''\s*\)\s*\)\s*,\s*lower\(\s*\?\s*\)\s*\)\s*>\s*0/i);
    expect.soft(binds.filter((value) => value === SPECIAL)).toHaveLength(1);
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
    expect(plan.success).toBe(true);
    expect(plan.results.length).toBeGreaterThan(0);
    if (!("customerId" in filters)) expect(plan.results.some((row) => /\bSCAN c\b/.test(row.detail))).toBe(true);
  }
  expect(ids(body)).toEqual("customerId" in filters ? [137, 139] : [137, 139, 149]);
});

type Parameter = {
  name: string; in: string; required?: boolean; description?: string; example?: unknown;
  examples?: Record<string, { value?: unknown }>;
  schema?: { type?: string; maxLength?: number; description?: string; default?: unknown; example?: unknown; examples?: unknown[] };
};
type Operation = {
  operationId?: string; description?: string; parameters?: Parameter[];
  responses?: Record<string, { description?: string }>;
  "x-access"?: string; "x-effect"?: string;
};
async function document() {
  const { response } = await request(new URL("/openapi.json", ORIGIN), { token: null });
  expect(response.status).toBe(200);
  return await response.json() as { paths: Record<string, { get: Operation }> };
}

describe("mounted machine-readable note discovery", () => {
  it("publishes one optional bounded string with trimmed, literal, ASCII-only stored-note semantics", async () => {
    const operation = (await document()).paths[PATH].get;
    const matches = operation.parameters?.filter((p) => p.in === "query" && p.name === "note") ?? [];
    expect(matches).toHaveLength(1);
    const note = matches[0];
    expect(note).toMatchObject({ required: false, schema: { type: "string", maxLength: 100 } });
    expect(note.schema?.default).toBeUndefined();
    const description = `${note.description ?? ""} ${note.schema?.description ?? ""}`;
    for (const pattern of [/container_note/, /substring/i, /literal/i, /ASCII/i, /Unicode code points/i, /trim/i, /blank.*omit|omit.*blank/i, /repeat|single/i]) {
      expect(description).toMatch(pattern);
    }
  });

  it("publishes a runnable synthetic note parameter example", async () => {
    const note = (await document()).paths[PATH].get.parameters?.find((p) => p.in === "query" && p.name === "note");
    expect(note).toBeDefined();
    const samples = [note?.example, note?.schema?.example, ...(note?.schema?.examples ?? []),
      ...Object.values(note?.examples ?? {}).map((example) => example.value)].filter((value) => value !== undefined);
    expect(samples.length).toBeGreaterThan(0);
    for (const sample of samples) {
      expect(typeof sample).toBe("string");
      expect(String(sample).trim()).not.toBe("");
      expect([...String(sample).trim()].length).toBeLessThanOrEqual(100);
      await page({ note: String(sample), fields: "enabled", includeTotal: "false" });
    }
  });

  it("exposes AND composition, q separation, scan honesty and fixed pre-D1 correction guidance", async () => {
    const operation = (await document()).paths[PATH].get;
    const description = operation.description ?? "";
    for (const key of ["note", "q", "customerId", "pickupAddressId", "containerId", "serialNumber", "rfid", "enabled", "upperId"]) expect(description, key).toContain(key);
    expect(description).toMatch(/\bAND\b/i);
    expect(description).toMatch(/scan/i);
    expect(description).toMatch(/no (?:dedicated |new )?index|not indexed/i);
    const bad = operation.responses?.["400"]?.description ?? "";
    expect(bad).toContain("note");
    expect(bad).toMatch(/before.*D1/i);
    expect(bad).toMatch(/repeat|duplicate/i);
    expect(bad).toMatch(/100.*Unicode code points/i);
    expect(bad).toContain("application/problem+json");
  });

  it("keeps per-operation query inventory synchronized without widening another endpoint", async () => {
    const doc = await document();
    const operation = doc.paths[PATH].get;
    const row = policyDoc.split("\n").find((line) => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    const inventory = [...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort();
    expect(inventory).toContain("note");
    expect(inventory).toEqual((operation.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name).sort());
    expect(operation).toMatchObject({ operationId: "listContainerSnapshot", "x-access": "read", "x-effect": "local-read" });
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/address-snapshot", `${PATH}/export`, `${PATH}/{containerId}`, "/api/v1/customer-snapshot/changes"]) {
      expect(doc.paths[path].get.parameters?.map((p) => p.name) ?? [], path).not.toContain("note");
    }
    expect(Object.keys(doc.paths).filter((path) => /note/i.test(path))).toEqual([]);
  });
});
