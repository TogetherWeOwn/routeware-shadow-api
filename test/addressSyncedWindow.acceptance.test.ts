/// <reference types="vite/client" />

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import problemsDoc from "../docs/PROBLEMS.md?raw";
import changelog from "../CHANGELOG.md?raw";
import packageJson from "../package.json";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent test-first oracle: select sites mirrored in a caller-held
 * synced window.
 *
 * Adds `syncedSince` (strict: stored `synced_at` > normalized instant) and
 * `syncedUntil` (inclusive: stored `synced_at` <= normalized instant) ONLY to
 * the ordinary address snapshot list GET. Validation and normalization are
 * exactly the customer-changes timestamp rules (UTC `Z`, seconds or 1-3
 * fractional digits, calendar-valid, normalized to `toISOString()`
 * milliseconds, never rounded/truncated), reusing the existing chain from
 * `src/lib/customerChangesTimestamp.ts` — no second parser. These are NEW
 * parameters with no legacy leniency: empty (for EITHER bound, unlike the
 * changes feed's legacy empty `since`), offset, >3 fractional digits,
 * calendar-invalid and repeated values are a fixed value-free 400 after
 * auth, before D1/304. Normalized since must not exceed normalized until;
 * equal bounds are a valid empty 200. Either bound may stand alone.
 *
 * This is a FILTER, not a changes feed: ordering, cursors and identity stay
 * the `pickup_address_id` keyset contract (no `(synced_at, id)` ordering, no
 * composite cursor, no deletion history, no snapshot isolation or
 * completeness claim). Stored sync time is mirror freshness, not upstream
 * event time, service time or proof of change content. `synced_at` is
 * NOT NULL; no null semantics are invented. The predicates may scan (no
 * address `synced_at` index); no index/migration or performance promise.
 *
 * Hand-derived IDs exercise real local D1 with scripted `synced_at` values
 * deliberately out of primary-key order, catching strict/inclusive
 * confusion, lossy normalization, raw-value binding, OR leakage, count/page
 * drift, lost continuation scope and stale ETags. Only fixture setup may
 * write; HTTP bindings deny writes, R2 and network. Builder consumes this
 * oracle unchanged; request corrections from the Test Author.
 * Focus: npx vitest run test/addressSyncedWindow.acceptance.test.ts --maxWorkers=2
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/address-snapshot";
const ORIGIN = "https://synced-window-client.invalid";
const TOKEN = "test-read-token";
const NOTE = "Gate amber";
const AUDIT = "2026-01-15";
// Bound instants. Raw short forms must normalize to the `_N` millisecond
// spelling before comparison, binding and next-Link retention.
const SINCE_RAW = "2026-03-01T10:00:00.1Z";
const SINCE_N = "2026-03-01T10:00:00.100Z";
const UNTIL_RAW = "2026-03-01T10:00:00.5Z";
const UNTIL_N = "2026-03-01T10:00:00.500Z";
const SECONDS_RAW = "2026-03-01T10:00:00Z";
const SECONDS_N = "2026-03-01T10:00:00.000Z";
const ALL_IDS = [11, 23, 37, 42, 58, 69, 73, 79, 83, 89, 97];
const SINCE_ONLY = [37, 42, 58, 69, 73, 83, 89];
const UNTIL_ONLY = [11, 23, 37, 42, 58, 79, 83, 89, 97];
const WINDOW = [37, 42, 58, 83, 89];
const PRIVATE = "private-synced-marker";
type Query = Record<string, string | number>;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
type Options = { token?: string | null; headers?: Record<string, string>; forbidAll?: boolean; fail?: "count" | "page" };
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
const ids = (body: Body) => body.rows.map(row => row.pickup_address_id);
const whereOf = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).split(/\bORDER\s+BY\b|\bLIMIT\b/i)[0].trim().replace(/\s+/g, " ");

// id, customer, route, franchise, enabled, extras, street, city, zip, state, note, audit, synced_at
// synced_at is scrambled against id order: 58 (.500) precedes 83 (.300) by id
// but follows it in time, so any (synced_at, id) ordering is caught.
const FIXTURES: Array<[number, number, number, string, number, number, string | null, string | null, string | null, string, string | null, string | null, string]> = [
  [11, 101, 7, "001", 1, 1, "741 Synthetic Way", null, "00741", "ZZ", NOTE, AUDIT, "2026-03-01T09:59:59.999Z"],
  [23, 101, 7, "001", 1, 1, "Plain Lane", "741 Borough", "00741", "ZZ", NOTE, AUDIT, SINCE_N],
  [37, 101, 7, "001", 1, 0, "Plain Lane", null, "00741-1234", "ZZ", NOTE, AUDIT, "2026-03-01T10:00:00.101Z"],
  [42, 101, 8, "1", 1, 1, "741 Synthetic Way", "741", "98000", "ZZ", NOTE, AUDIT, "2026-03-01T10:00:00.250Z"],
  [58, 202, 7, "001", 1, 1, "741 Other Lane", null, "00741", "ZZ", "unrelated", AUDIT, UNTIL_N],
  [69, 101, 7, "001", 0, 1, "741 Disabled Lane", null, "00741", "ZZ", "unrelated", AUDIT, "2026-03-01T10:00:00.501Z"],
  [73, 202, 8, "001", 1, 1, "After Lane", null, null, "ZZ", NOTE, "unrelated", "2026-03-01T10:00:01.000Z"],
  [79, 101, 7, "001", 1, 1, "Early Lane", null, null, "ZZ", NOTE, AUDIT, "2026-02-28T23:59:59.000Z"],
  [83, 303, 7, "001", 1, 1, "Window Lane", "741 Borough", "00741", "ZZ", NOTE, AUDIT, "2026-03-01T10:00:00.300Z"],
  [89, 101, 7, "001", 0, 0, "Window Disabled", null, "00741", "ZZ", "unrelated", null, "2026-03-01T10:00:00.400Z"],
  [97, 202, 7, "001", 1, 1, "Seconds Lane", null, null, "ZZ", NOTE, AUDIT, SECONDS_N]
];

let denied: string[];
let outbound: ReturnType<typeof vi.fn>;
let logs: Array<ReturnType<typeof vi.spyOn>>;
function forbid(operation: string): never {
  denied.push(operation);
  throw new Error("Forbidden effect in synced-window acceptance");
}
function readOnlyDb(options: Options) {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return new Proxy(stmt, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql, values);
        const method = Reflect.get(target, property, target);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          if (!["all", "first", "raw"].includes(String(property))) return forbid(`D1.${String(property)}`);
          statements.push({ sql, binds });
          if ((options.fail === "count" && isCount({ sql, binds })) ||
              (options.fail === "page" && !isCount({ sql, binds }))) {
            throw new Error(`synthetic-private-db-marker ${PRIVATE}`);
          }
          return Reflect.apply(method, target, args);
        };
      }
    });
  }
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      if (options.forbidAll || !/^\s*SELECT\b/i.test(sql)) return forbid("D1.prepare");
      return wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []);
    },
    batch: () => forbid("D1.batch"), exec: () => forbid("D1.exec"), dump: () => forbid("D1.dump")
  } as unknown as D1Database;
  return { db, prepared, statements };
}
async function request(query: Query | URL | string = {}, options: Options = {}) {
  const url = query instanceof URL ? query : new URL(PATH, "http://test.local");
  if (!(query instanceof URL)) url.search = typeof query === "string" ? query : new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)])
  ).toString();
  const recorder = readOnlyDb(options);
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Synced-window-acceptance", ...options.headers });
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const forbiddenBinding = new Proxy({}, { get: (_target, property) => () => forbid(`external.${String(property)}`) });
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: recorder.db,
    SNAPSHOTS: forbiddenBinding as R2Bucket, BROWSER: forbiddenBinding as Fetcher
  });
  return { response, url, ...recorder };
}
function posture(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("x-request-id")).toBe("Synced-window-acceptance");
  expect(response.headers.get("vary")).toMatch(/\borigin\b/i);
  const exposed = (response.headers.get("access-control-expose-headers") ?? "").toLowerCase().split(/,\s*/);
  expect(exposed).toEqual(expect.arrayContaining(["etag", "link", "x-request-id"]));
}
async function page(query: Query | URL | string = {}, headers?: Record<string, string>) {
  const result = await request(query, { headers });
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  posture(result.response);
  const bytes = await result.response.text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const params = result.url.searchParams;
  const countOnly = params.get("countOnly") === "true";
  const countFree = params.get("includeTotal") === "false";
  if (countOnly) {
    expect(body.rows).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.statements).toHaveLength(1);
    expect(result.statements.filter(isCount)).toHaveLength(1);
    expect(result.prepared).toHaveLength(1);
  } else {
    expect(result.statements).toHaveLength(countFree ? 1 : 2);
    expect(result.statements.filter(isCount)).toHaveLength(countFree ? 0 : 1);
    expect(result.prepared).toHaveLength(countFree ? 1 : 2);
  }
  for (const statement of result.statements) expect(statement.sql).not.toMatch(/\bJOIN\b/i);
  return { ...result, body, bytes };
}
function next(result: Awaited<ReturnType<typeof page>>, expected: Query) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/address-snapshot\?[^<>\s]*>; rel="next"$/);
  const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(target.origin).toBe(result.url.origin);
  expect(target.pathname).toBe(PATH);
  expect(target.hash).toBe("");
  expect(target.username).toBe("");
  expect(target.password).toBe("");
  const actual = new URLSearchParams(target.search);
  const want = Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, String(value)]));
  if (want.includeTotal !== "false") {
    expect([null, "true"]).toContain(actual.get("includeTotal"));
    expect(actual.getAll("includeTotal").length).toBeLessThanOrEqual(1);
    actual.delete("includeTotal");
    delete want.includeTotal;
  }
  if (want.countOnly !== "true") {
    expect([null, "false"]).toContain(actual.get("countOnly"));
    actual.delete("countOnly");
    delete want.countOnly;
  }
  if (want.order === undefined || want.order === "asc") {
    expect([null, "asc"]).toContain(actual.get("order"));
    if (actual.get("order") !== null) expect(want.order).toBe("asc");
    actual.delete("order");
    delete want.order;
  }
  expect([...actual.keys()]).toHaveLength(Object.keys(want).length);
  expect(Object.fromEntries(actual)).toEqual(want);
  expect(actual.has("offset")).toBe(false);
  return target;
}
async function invalid(search: string, field: "syncedSince" | "syncedUntil" | "either" = "either") {
  const result = await request(search, { forbidAll: true, headers: { "if-none-match": "*" } });
  expect(result.response.status).toBe(400);
  posture(result.response);
  expect(result.response.headers.get("content-type")).toContain("application/problem+json");
  const bytes = await result.response.text();
  const body = JSON.parse(bytes) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["detail", "status", "title", "type"]);
  expect(body).toMatchObject({ type: expect.stringMatching(/#bad-request$/), title: "Bad Request", status: 400 });
  const detail = String(body.detail);
  if (field === "either") expect(detail).toMatch(/syncedSince|syncedUntil|query/);
  else expect(detail).toContain(field);
  expect(detail).toContain("docs/PROBLEMS.md#bad-request");
  expect(bytes).not.toContain(PRIVATE);
  expect(result.prepared).toEqual([]);
  expect(result.statements).toEqual([]);
  expect(result.response.headers.get("link")).toBeNull();
  expect(result.response.headers.get("etag")).toBeNull();
  return body;
}
async function hash(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}"`;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  denied = [];
  outbound = vi.fn(async () => { throw new Error("Forbidden outbound synced-window request"); });
  vi.stubGlobal("fetch", outbound);
  logs = (["log", "info", "warn", "error", "debug"] as const).map(level => vi.spyOn(console, level).mockImplementation(() => undefined));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot")
  ]);
  // Parent customers: 101/303 enabled, 202 disabled (parentCustomerEnabled).
  for (const [id, enabled] of [[101, 1], [202, 0], [303, 1]]) await db.prepare(
    "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'synthetic-synced-window', ?, 'fixed-time')"
  ).bind(id, enabled).run();
  for (const row of [...FIXTURES].reverse()) await db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, enabled, extras_allowed, address, city, zip, state, driver_note, last_audit_date, synced_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(...row).run();
  for (const [id, owner, enabled] of [[501, 37, 1], [502, 83, 0], [503, 23, 1]]) await db.prepare(
    "INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, synced_at) VALUES (?, ?, ?, 'fixed-time')"
  ).bind(id, owner, enabled).run();
});
afterEach(() => {
  try {
    expect(outbound).not.toHaveBeenCalled();
    expect(denied).toEqual([]);
    const text = JSON.stringify(logs.map(log => log.mock.calls));
    for (const marker of [PRIVATE, "synthetic-private-db-marker"]) expect(text).not.toContain(marker);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe("synced window bounds: strict since, inclusive until", () => {
  it("syncedSince alone keeps only rows strictly after the instant (at-bound excluded)", async () => {
    const result = await page({ syncedSince: SINCE_N });
    expect(ids(result.body)).toEqual(SINCE_ONLY);
    expect(ids(result.body)).not.toContain(23);
    expect(result.body.total).toBe(SINCE_ONLY.length);
    expect(result.body.nextCursor).toBeNull();
    for (const row of result.body.rows) expect(String(row.synced_at) > SINCE_N).toBe(true);
  });

  it("syncedUntil alone keeps rows at or before the instant (at-bound included)", async () => {
    const result = await page({ syncedUntil: UNTIL_N });
    expect(ids(result.body)).toEqual(UNTIL_ONLY);
    expect(ids(result.body)).toContain(58);
    expect(ids(result.body)).not.toContain(69);
    expect(result.body.total).toBe(UNTIL_ONLY.length);
    for (const row of result.body.rows) expect(String(row.synced_at) <= UNTIL_N).toBe(true);
  });

  it("both bounds keep the (since, until] window in pickup_address_id order, not synced order", async () => {
    const result = await page({ syncedSince: SINCE_N, syncedUntil: UNTIL_N });
    expect(ids(result.body)).toEqual(WINDOW);
    // 58 is stamped .500 and 83 is stamped .300: id order puts 58 first.
    expect(result.body.rows.map(r => r.synced_at)).toEqual([
      "2026-03-01T10:00:00.101Z", "2026-03-01T10:00:00.250Z", UNTIL_N,
      "2026-03-01T10:00:00.300Z", "2026-03-01T10:00:00.400Z"
    ]);
    expect(result.body.total).toBe(5);
    for (const statement of result.statements) {
      expect(statement.sql).toMatch(/synced_at\s*>\s*\?/);
      expect(statement.sql).toMatch(/synced_at\s*<=\s*\?/);
      expect(statement.sql).not.toMatch(/ORDER\s+BY[^,]*synced_at/i);
      expect(statement.sql).not.toContain("2026-03-01");
      expect(statement.binds).toContain(SINCE_N);
      expect(statement.binds).toContain(UNTIL_N);
    }
    const pageSql = result.statements.find(s => !isCount(s))!.sql;
    expect(pageSql).toMatch(/ORDER\s+BY\s+pickup_address_id/i);
  });

  it("until at the since instant includes the at-bound row the strict since excludes", async () => {
    const result = await page({ syncedUntil: SINCE_N });
    expect(ids(result.body)).toEqual([11, 23, 79, 97]);
  });

  it.each([
    { label: "equal millisecond bounds", syncedSince: SINCE_N, syncedUntil: SINCE_N },
    { label: "equal only after normalization (.1Z vs .100Z)", syncedSince: SINCE_RAW, syncedUntil: SINCE_N },
    { label: "equal seconds vs milliseconds", syncedSince: SECONDS_RAW, syncedUntil: SECONDS_N },
    { label: "equal at the until instant", syncedSince: UNTIL_RAW, syncedUntil: UNTIL_N }
  ])("$label are a valid empty 200 (no row is both > x and <= x)", async ({ syncedSince, syncedUntil }) => {
    const result = await page({ syncedSince, syncedUntil });
    expect(result.body).toEqual({ rows: [], total: 0, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
  });

  it("since at the latest stored instant is empty; until at that instant keeps every row", async () => {
    expect(ids((await page({ syncedSince: "2026-03-01T10:00:01.000Z" })).body)).toEqual([]);
    expect(ids((await page({ syncedUntil: "2026-03-01T10:00:01.000Z" })).body)).toEqual(ALL_IDS);
    expect(ids((await page({ syncedUntil: "2026-02-28T00:00:00Z" })).body)).toEqual([]);
  });

  it("accepts a calendar-valid leap day and keeps every later row", async () => {
    const result = await page({ syncedSince: "2024-02-29T00:00:00Z" });
    expect(ids(result.body)).toEqual(ALL_IDS);
    for (const statement of result.statements) expect(statement.binds).toContain("2024-02-29T00:00:00.000Z");
  });
});

describe("synced window normalization is lossless milliseconds", () => {
  it.each(["2026-03-01T10:00:00.1Z", "2026-03-01T10:00:00.10Z", SINCE_N])(
    "syncedSince=%s normalizes to milliseconds before binding", async raw => {
      const result = await page({ syncedSince: raw });
      expect(ids(result.body)).toEqual(SINCE_ONLY);
      for (const statement of result.statements) {
        expect(statement.binds).toContain(SINCE_N);
        if (raw !== SINCE_N) expect(statement.binds).not.toContain(raw);
      }
    });

  it.each(["2026-03-01T10:00:00.5Z", "2026-03-01T10:00:00.50Z", UNTIL_N])(
    "syncedUntil=%s normalizes to milliseconds before binding", async raw => {
      const result = await page({ syncedUntil: raw });
      expect(ids(result.body)).toEqual(UNTIL_ONLY);
      for (const statement of result.statements) {
        expect(statement.binds).toContain(UNTIL_N);
        if (raw !== UNTIL_N) expect(statement.binds).not.toContain(raw);
      }
    });

  it("seconds forms normalize to .000 milliseconds for both bounds", async () => {
    const since = await page({ syncedSince: SECONDS_RAW });
    expect(ids(since.body)).toEqual([23, 37, 42, 58, 69, 73, 83, 89]);
    expect(ids(since.body)).not.toContain(97);
    for (const statement of since.statements) expect(statement.binds).toContain(SECONDS_N);
    const until = await page({ syncedUntil: SECONDS_RAW });
    expect(ids(until.body)).toEqual([11, 79, 97]);
    for (const statement of until.statements) expect(statement.binds).toContain(SECONDS_N);
  });

  it("two fractional digits keep hundredth precision (.12Z excludes the .101 row)", async () => {
    const result = await page({ syncedSince: "2026-03-01T10:00:00.12Z" });
    expect(ids(result.body)).toEqual([42, 58, 69, 73, 83, 89]);
    for (const statement of result.statements) expect(statement.binds).toContain("2026-03-01T10:00:00.120Z");
  });

  it("omission adds no synced predicate, bind or Link key (omission parity)", async () => {
    const result = await page({ limit: 2 });
    expect(ids(result.body)).toEqual([11, 23]);
    for (const statement of result.statements) {
      expect(whereOf(statement.sql)).not.toMatch(/synced_at\s*[<>]/);
      expect(statement.binds).not.toContain(SINCE_N);
      expect(statement.binds).not.toContain(UNTIL_N);
    }
    const target = next(result, { limit: 2, cursor: 23 });
    expect(target.searchParams.has("syncedSince")).toBe(false);
    expect(target.searchParams.has("syncedUntil")).toBe(false);
    expect(ids((await page({})).body)).toEqual(ALL_IDS);
  });
});

describe.each(["true", "false"])("synced window AND-composition includeTotal=%s", includeTotal => {
  it.each<{ query: Query; want: number[] }>([
    { query: { customerId: 101 }, want: [37, 42, 89] },
    { query: { customerId: 202 }, want: [58] },
    { query: { customerId: 303 }, want: [83] },
    { query: { pickupAddressId: 42 }, want: [42] },
    { query: { pickupAddressId: 23 }, want: [] },
    { query: { ids: "58,37,23" }, want: [37, 58] },
    { query: { routeId: 8 }, want: [42] },
    { query: { routeId: 7 }, want: [37, 58, 83, 89] },
    { query: { franchiseId: "1" }, want: [42] },
    { query: { franchiseId: "001" }, want: [37, 58, 83, 89] },
    { query: { zip: "00741" }, want: [58, 83, 89] },
    { query: { streetAddress: "741 Other Lane" }, want: [58] },
    { query: { streetAddress: "Plain Lane" }, want: [37] },
    { query: { city: "741 Borough" }, want: [83] },
    { query: { state: "ZZ" }, want: WINDOW },
    { query: { state: "XX" }, want: [] },
    { query: { q: "Borough" }, want: [83] },
    { query: { q: "Other" }, want: [58] },
    { query: { driverNote: NOTE }, want: [37, 42, 83] },
    { query: { enabled: "true" }, want: [37, 42, 58, 83] },
    { query: { enabled: "false" }, want: [89] },
    { query: { extrasAllowed: "true" }, want: [42, 58, 83] },
    { query: { extrasAllowed: "false" }, want: [37, 89] },
    { query: { hasContainers: "true" }, want: [37, 83] },
    { query: { hasContainers: "false" }, want: [42, 58, 89] },
    { query: { lastAuditDate: AUDIT }, want: [37, 42, 58, 83] },
    { query: { hasLastAuditDate: "true" }, want: [37, 42, 58, 83] },
    { query: { hasLastAuditDate: "false" }, want: [89] },
    { query: { parentCustomerEnabled: "true" }, want: [37, 42, 83, 89] },
    { query: { parentCustomerEnabled: "false" }, want: [58] },
    { query: { lowerId: 42 }, want: [42, 58, 83, 89] },
    { query: { upperId: 58 }, want: [37, 42, 58] },
    { query: { lowerId: 42, upperId: 83 }, want: [42, 58, 83] },
    { query: { customerId: 101, routeId: 7, enabled: "true", hasContainers: "true" }, want: [37] }
  ])("$query intersects the window", async ({ query, want }) => {
    const result = await page({ ...query, syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW, includeTotal, fields: "synced_at" });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
    expect(result.body.nextCursor).toBeNull();
    for (const row of result.body.rows) {
      expect(Object.keys(row).sort()).toEqual(["pickup_address_id", "synced_at"]);
      expect(String(row.synced_at) > SINCE_N && String(row.synced_at) <= UNTIL_N).toBe(true);
    }
    for (const statement of result.statements) {
      expect(statement.binds).toContain(SINCE_N);
      expect(statement.binds).toContain(UNTIL_N);
      expect(statement.sql).toMatch(/synced_at\s*>\s*\?/);
      expect(statement.sql).toMatch(/synced_at\s*<=\s*\?/);
    }
    if (includeTotal === "true") {
      const count = result.statements.find(isCount)!;
      const select = result.statements.find(s => !isCount(s))!;
      expect(whereOf(count.sql)).toBe(whereOf(select.sql));
      expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
    }
  });

  it("single bounds compose without inventing the omitted bound", async () => {
    const since = await page({ syncedSince: SINCE_RAW, enabled: "false", includeTotal });
    expect(ids(since.body)).toEqual([69, 89]);
    for (const statement of since.statements) {
      expect(statement.sql).not.toMatch(/synced_at\s*<=/);
      expect(statement.binds).not.toContain(UNTIL_N);
    }
    const until = await page({ syncedUntil: UNTIL_RAW, customerId: 202, includeTotal });
    expect(ids(until.body)).toEqual([58, 97]);
    for (const statement of until.statements) {
      expect(statement.sql).not.toMatch(/synced_at\s*>\s*\?/);
      expect(statement.binds).not.toContain(SINCE_N);
    }
  });
});

describe.each(["true", "false"])("synced window continuation includeTotal=%s", includeTotal => {
  it.each([
    { order: "asc", pages: [[37, 42], [58, 83], []] },
    { order: "desc", pages: [[83, 58], [42, 37], []] }
  ])("follows every $order Link carrying normalized bounds through terminal empty", async ({ order, pages }) => {
    const filters = { syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW, enabled: "true", limit: 2, order, includeTotal };
    let current = await page(filters);
    const seen: unknown[] = [];
    for (let index = 0; index < pages.length; index++) {
      expect(ids(current.body)).toEqual(pages[index]);
      expect(current.body.total).toBe(includeTotal === "false" ? null : [4, 2, 0][index]);
      seen.push(...ids(current.body));
      if (index === pages.length - 1) {
        expect(current.body.nextCursor).toBeNull();
        expect(current.response.headers.get("link")).toBeNull();
      } else {
        const cursor = pages[index][pages[index].length - 1];
        expect(current.body.nextCursor).toBe(cursor);
        const target = next(current, {
          syncedSince: SINCE_N, syncedUntil: UNTIL_N, enabled: "true",
          limit: 2, order, includeTotal, cursor
        });
        expect(target.searchParams.getAll("syncedSince")).toEqual([SINCE_N]);
        expect(target.searchParams.getAll("syncedUntil")).toEqual([UNTIL_N]);
        current = await page(target);
      }
    }
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("offset-to-seek retains normalized bounds and drops offset", async () => {
    const filters = { syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW, limit: 2, includeTotal };
    const first = await page({ ...filters, offset: 1 });
    expect(ids(first.body)).toEqual([42, 58]);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 5);
    expect(first.body.nextCursor).toBe(58);
    const second = await page(next(first, { syncedSince: SINCE_N, syncedUntil: UNTIL_N, limit: 2, includeTotal, cursor: 58 }));
    expect(ids(second.body)).toEqual([83, 89]);
    expect(second.body.total).toBe(includeTotal === "false" ? null : 2);
    const terminal = await page(next(second, { syncedSince: SINCE_N, syncedUntil: UNTIL_N, limit: 2, includeTotal, cursor: 89 }));
    expect(terminal.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(terminal.response.headers.get("link")).toBeNull();
  });

  it("exactNext walks the window and stops on the partial page, bounds retained", async () => {
    const filters = { syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW, limit: 2, exactNext: "true", includeTotal };
    let current = await page(filters);
    const pages: number[][] = [[37, 42], [58, 83], [89]];
    for (let index = 0; index < pages.length; index++) {
      expect(ids(current.body)).toEqual(pages[index]);
      if (index === pages.length - 1) {
        expect(current.body.nextCursor).toBeNull();
        expect(current.response.headers.get("link")).toBeNull();
      } else {
        const cursor = pages[index][1];
        expect(current.body.nextCursor).toBe(cursor);
        current = await page(next(current, {
          syncedSince: SINCE_N, syncedUntil: UNTIL_N, limit: 2,
          exactNext: "true", includeTotal, cursor
        }));
      }
    }
  });

  it("cursor takes precedence over offset; gap and beyond-window cursors stay correct", async () => {
    for (const [query, want, total, cursor] of [
      [{ cursor: 42, offset: 999 }, [58, 83], 3, 83],
      [{ cursor: 50 }, [58, 83], 3, 83],
      [{ cursor: 83 }, [89], 1, null],
      [{ cursor: 89 }, [], 0, null],
      [{ offset: 5 }, [], 5, null]
    ] as Array<[Query, number[], number, number | null]>) {
      const result = await page({ ...query, syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW, limit: 2, includeTotal });
      expect(ids(result.body)).toEqual(want);
      expect(result.body.total).toBe(includeTotal === "false" ? null : total);
      expect(result.body.nextCursor).toBe(cursor);
      if (query.cursor !== undefined) for (const s of result.statements) expect(s.sql).not.toMatch(/\bOFFSET\b/i);
      if (cursor === null) expect(result.response.headers.get("link")).toBeNull();
    }
  });

  it("single-bound Links carry only the supplied bound, normalized", async () => {
    const since = await page({ syncedSince: SINCE_RAW, limit: 2, includeTotal });
    expect(ids(since.body)).toEqual([37, 42]);
    const sinceTarget = next(since, { syncedSince: SINCE_N, limit: 2, includeTotal, cursor: 42 });
    expect(sinceTarget.searchParams.has("syncedUntil")).toBe(false);
    const until = await page({ syncedUntil: UNTIL_RAW, limit: 2, includeTotal });
    expect(ids(until.body)).toEqual([11, 23]);
    const untilTarget = next(until, { syncedUntil: UNTIL_N, limit: 2, includeTotal, cursor: 23 });
    expect(untilTarget.searchParams.has("syncedSince")).toBe(false);
  });
});

describe("synced window countOnly and count-free modes", () => {
  it.each<{ query: Query; total: number }>([
    { query: { syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW }, total: 5 },
    { query: { syncedSince: SINCE_RAW }, total: 7 },
    { query: { syncedUntil: UNTIL_RAW }, total: 9 },
    { query: { syncedSince: SINCE_N, syncedUntil: SINCE_N }, total: 0 },
    { query: { syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW, customerId: 101 }, total: 3 }
  ])("countOnly returns COUNT-only $total for $query", async ({ query, total }) => {
    const result = await page({ ...query, countOnly: "true" });
    expect(result.body).toEqual({ rows: [], total, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.statements).toHaveLength(1);
    expect(result.statements.filter(isCount)).toHaveLength(1);
    if (query.syncedSince !== undefined) expect(result.statements[0].binds).toContain(SINCE_N);
    if (query.syncedUntil !== undefined) expect(result.statements[0].binds).toContain(query.syncedUntil === SINCE_N ? SINCE_N : UNTIL_N);
  });

  it("countOnly plus includeTotal=false is a value-free 400 before D1", async () => {
    const result = await request({ syncedSince: SINCE_RAW, countOnly: "true", includeTotal: "false" }, { forbidAll: true });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(await result.response.text()).toMatch(/countOnly/);
    expect(result.prepared).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
  });

  it("count-free returns identical page SQL, rows and cursor without COUNT", async () => {
    const filters = { syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW, fields: "enabled", limit: 2 };
    const counted = await page(filters);
    const free = await page({ ...filters, includeTotal: "false" });
    expect(ids(free.body)).toEqual([37, 42]);
    expect(counted.body.total).toBe(5);
    expect(free.body).toEqual({ rows: counted.body.rows, total: null, nextCursor: 42 });
    expect(free.statements).toEqual(counted.statements.filter(s => !isCount(s)));
  });
});

describe("synced window representation and read authority", () => {
  it.each(["true", "false"])("hashes the sparse envelope and revalidates 304 with reads, includeTotal=%s", async includeTotal => {
    const query = { syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW, fields: "synced_at,city", limit: 2, includeTotal };
    const first = await page(query);
    expect(first.body.rows).toEqual([
      { pickup_address_id: 37, synced_at: "2026-03-01T10:00:00.101Z", city: null },
      { pickup_address_id: 42, synced_at: "2026-03-01T10:00:00.250Z", city: "741" }
    ]);
    const tag = await hash(first.bytes);
    expect(first.response.headers.get("etag")).toBe(tag);
    const replay = await request(query, { headers: { "if-none-match": tag } });
    expect(replay.response.status).toBe(304);
    expect(await replay.response.text()).toBe("");
    posture(replay.response);
    expect(replay.response.headers.get("etag")).toBe(tag);
    expect(replay.response.headers.get("link")).toBe(first.response.headers.get("link"));
    expect(replay.statements).toEqual(first.statements);
    const rawForm = await page({ ...query, syncedSince: SINCE_N, syncedUntil: UNTIL_N });
    expect(rawForm.bytes).toBe(first.bytes);
    expect(rawForm.response.headers.get("etag")).toBe(tag);
  });

  it("recomputes membership after a stored synced_at leaves the window", async () => {
    const query = { syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW, fields: "address" };
    const first = await page(query);
    expect(ids(first.body)).toEqual(WINDOW);
    await TEST_ENV.CUSTOMER_DB.prepare("UPDATE address_snapshot SET synced_at = '2026-03-01T10:00:00.900Z' WHERE pickup_address_id = 42").run();
    const changed = await page(query, { "if-none-match": first.response.headers.get("etag")! });
    expect(ids(changed.body)).toEqual([37, 58, 83, 89]);
    expect(changed.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
  });

  it("is idempotent, preserves stored rows and ignores untrusted raw GET params in Links", async () => {
    const before = await TEST_ENV.CUSTOMER_DB.prepare("SELECT * FROM address_snapshot ORDER BY pickup_address_id").all();
    const first = await page({ syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW, limit: 2 });
    expect(first.body.rows[0]).toMatchObject({ pickup_address_id: 37, synced_at: "2026-03-01T10:00:00.101Z" });
    const url = new URL(PATH, "https://untrusted-origin.invalid");
    url.search = new URLSearchParams({ syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW, limit: "2", "unknown-synced-marker": PRIVATE, token: "query-token-marker" }).toString();
    const tainted = await request(url, { headers: { host: "untrusted-host.invalid" } });
    expect(tainted.response.status).toBe(200);
    expect(await tainted.response.text()).toBe(first.bytes);
    expect(tainted.statements).toEqual(first.statements);
    expect(tainted.response.headers.get("link")).toBe(first.response.headers.get("link"));
    expect(tainted.response.headers.get("link")).not.toMatch(/marker|untrusted|Bearer|test-read-token|https?:|\/\//);
    const after = await TEST_ENV.CUSTOMER_DB.prepare("SELECT * FROM address_snapshot ORDER BY pickup_address_id").all();
    expect(after.results).toEqual(before.results);
  });

  it("unknown names stay ignored with a window, and strictQuery accepts the new names", async () => {
    const baseline = await page({ syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW });
    const bogus = await page(`syncedSince=${encodeURIComponent(SINCE_RAW)}&syncedUntil=${encodeURIComponent(UNTIL_RAW)}&bogus_param=1`);
    expect(bogus.body).toEqual(baseline.body);
    expect(bogus.statements).toEqual(baseline.statements);
    const strict = await page({ syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW, strictQuery: "true", limit: 2 });
    expect(ids(strict.body)).toEqual([37, 42]);
    const strictBogus = await request(`syncedSince=${encodeURIComponent(SINCE_RAW)}&strictQuery=true&bogus_param=1`, { forbidAll: true });
    expect(strictBogus.response.status).toBe(400);
    expect(strictBogus.prepared).toEqual([]);
  });

  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("preserves existing read authority: %s", async token => {
    const result = await request({ syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW, pickupAddressId: 37 }, { token });
    expect(result.response.status).toBe(200);
    posture(result.response);
    expect(ids(await result.response.json() as Body)).toEqual([37]);
  });

  it("applies on the address list only: sibling lists ignore the names as unknown", async () => {
    const customers = await request(new URL(`/api/v1/customer-snapshot?syncedSince=${encodeURIComponent("2999-01-01T00:00:00Z")}`, "http://test.local"));
    expect(customers.response.status).toBe(200);
    const customerBody = await customers.response.json() as { rows: Array<Record<string, unknown>> };
    expect(customerBody.rows.map(r => r.customer_id)).toEqual([101, 202, 303]);
    for (const statement of customers.statements) expect(whereOf(statement.sql)).not.toMatch(/synced_at\s*>\s*\?/);
  });
});

describe("synced window validation and value-free failures", () => {
  const INVALID_VALUES = [
    "", " ", "\t", "not-a-date", "2026-03-01", "2026-03-01T10:00:00",
    "2026-03-01T10:00:00+00:00", "2026-03-01T11:00:00+01:00",
    "2026-03-01T10:00:00.0000Z", "2026-03-01T10:00:00.5000Z",
    "2026-03-01T10:00:00.4999Z", "2026-03-01T10:00:00.123456789Z",
    "2026-02-29T10:00:00Z", "2026-02-30T10:00:00Z", "2026-04-31T10:00:00Z",
    "2026-13-01T10:00:00Z", "2026-00-01T10:00:00Z", "2026-03-00T10:00:00Z",
    "2026-03-01T24:00:00Z", "2026-03-01T10:00:60Z",
    "2026-03-01T10:00:00.100z", "2026-03-01 10:00:00Z",
    "2026-03-01T10:00:00Z' OR 1=1 --", PRIVATE
  ];
  it.each(INVALID_VALUES)("rejects malformed or lossy syncedSince=%j before D1/304", async value => {
    await invalid(new URLSearchParams({ syncedSince: value }).toString(), "syncedSince");
  });
  it.each(INVALID_VALUES)("rejects malformed or lossy syncedUntil=%j before D1/304", async value => {
    await invalid(new URLSearchParams({ syncedUntil: value }).toString(), "syncedUntil");
  });

  it("rejects an empty syncedSince: no legacy empty-bound leniency for the new parameters", async () => {
    await invalid("syncedSince=", "syncedSince");
    await invalid("syncedUntil=", "syncedUntil");
    await invalid(`syncedSince=&syncedUntil=${encodeURIComponent(UNTIL_RAW)}`);
    await invalid(`syncedSince=${encodeURIComponent(SINCE_RAW)}&syncedUntil=`);
  });

  it.each([
    `syncedSince=${encodeURIComponent(SINCE_N)}&syncedSince=${encodeURIComponent(SINCE_N)}`,
    `syncedSince=${encodeURIComponent(SECONDS_RAW)}&syncedSince=${encodeURIComponent(SINCE_N)}`,
    `syncedSince=&syncedSince=${encodeURIComponent(SINCE_N)}`,
    `syncedSince=${encodeURIComponent(SINCE_N)}&synced%53ince=${encodeURIComponent(SINCE_N)}`
  ])("rejects repeated syncedSince keys: %s", async search => { await invalid(search, "syncedSince"); });

  it.each([
    `syncedUntil=${encodeURIComponent(UNTIL_N)}&syncedUntil=${encodeURIComponent(UNTIL_N)}`,
    `syncedUntil=${encodeURIComponent(SECONDS_RAW)}&syncedUntil=${encodeURIComponent(UNTIL_N)}`,
    `syncedUntil=${encodeURIComponent(UNTIL_N)}&syncedUntil=`,
    `syncedUntil=${encodeURIComponent(UNTIL_N)}&synced%55ntil=${encodeURIComponent(UNTIL_N)}`
  ])("rejects repeated syncedUntil keys: %s", async search => { await invalid(search, "syncedUntil"); });

  it.each([
    { syncedSince: UNTIL_RAW, syncedUntil: SINCE_RAW },
    { syncedSince: "2026-03-01T10:00:00.501Z", syncedUntil: UNTIL_RAW },
    { syncedSince: "2026-03-01T10:00:01Z", syncedUntil: UNTIL_N },
    { syncedSince: "2026-03-01T10:00:00.10Z", syncedUntil: "2026-03-01T10:00:00.099Z" }
  ])("rejects normalized since-after-until before D1 with zero SQL: $syncedSince > $syncedUntil", async bounds => {
    await invalid(new URLSearchParams(bounds).toString());
  });

  it("adding a window does not bypass existing validation (limit, count-mode conflict)", async () => {
    const badLimit = await request({ syncedSince: SINCE_RAW, limit: 501 }, { forbidAll: true });
    expect(badLimit.response.status).toBe(400);
    expect(badLimit.prepared).toEqual([]);
  });

  it("uses identical fixed correction guidance without reflecting or logging submitted values", async () => {
    const first = await invalid(new URLSearchParams({ syncedSince: `${PRIVATE}-a` }).toString(), "syncedSince");
    const second = await invalid(new URLSearchParams({ syncedSince: `${PRIVATE}-b` }).toString(), "syncedSince");
    expect(first).toEqual(second);
  });

  it("returns the fixed synced correction guidance, without echoing supplied values, for each bound and inverted windows", async () => {
    const GUIDANCE = "Send each synced bound once as a calendar-valid UTC Z datetime with seconds or 1–3 fractional digits, with syncedSince <= syncedUntil; omit unused bounds and retry.";
    expect(problemsDoc).toContain(GUIDANCE);
    const cases: Array<{ search: string; field: "syncedSince" | "syncedUntil"; supplied: string[] }> = [
      { search: new URLSearchParams({ syncedSince: `${PRIVATE}-since` }).toString(), field: "syncedSince", supplied: [`${PRIVATE}-since`] },
      { search: new URLSearchParams({ syncedUntil: `${PRIVATE}-until` }).toString(), field: "syncedUntil", supplied: [`${PRIVATE}-until`] },
      {
        search: new URLSearchParams({ syncedSince: "2027-01-02T03:04:05.678Z", syncedUntil: "2027-01-02T03:04:05.677Z" }).toString(),
        field: "syncedUntil",
        supplied: ["2027-01-02T03:04:05.678Z", "2027-01-02T03:04:05.677Z"]
      }
    ];
    for (const { search, field, supplied } of cases) {
      const body = await invalid(search, field);
      expect(String(body.detail)).toContain(GUIDANCE);
      for (const value of supplied) expect(String(body.detail)).not.toContain(value);
    }
  });

  it.each([null, "incorrect-synthetic-token"])("auth precedes window validation and conditional handling: %s", async token => {
    for (const search of [
      new URLSearchParams({ syncedSince: PRIVATE }).toString(),
      new URLSearchParams({ syncedSince: UNTIL_RAW, syncedUntil: SINCE_RAW }).toString(),
      new URLSearchParams({ syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW }).toString()
    ]) {
      const result = await request(search, { token, forbidAll: true, headers: { "if-none-match": "*" } });
      expect(result.response.status).toBe(401);
      expect(await result.response.text()).not.toContain(PRIVATE);
      expect(result.prepared).toEqual([]);
      expect(result.response.headers.get("link")).toBeNull();
      expect(result.response.headers.get("etag")).toBeNull();
    }
  });

  it.each(["count", "page"] as const)("D1 %s failures do not log or reflect bounds or private exceptions", async fail => {
    const result = await request({ syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW }, { fail });
    expect(result.response.status).toBe(500);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const bytes = await result.response.text();
    expect(JSON.parse(bytes)).toMatchObject({ status: 500, type: expect.stringMatching(/#internal$/) });
    expect(bytes).not.toContain(PRIVATE);
    expect(bytes).not.toContain("synthetic-private-db-marker");
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
  });
});

describe("synced window SQL proofs and synthetic local plan (no latency promise)", () => {
  it("binds only normalized bounds and executes a synthetic EXPLAIN", async () => {
    const result = await page({ syncedSince: SINCE_RAW, syncedUntil: UNTIL_RAW, limit: 2 });
    const statement = result.statements.find(s => !isCount(s))!;
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
      .bind(...statement.binds).all<{ detail: string }>();
    expect(plan.results.length).toBeGreaterThan(0);
    expect(plan.results.every(row => typeof row.detail === "string")).toBe(true);
    expect(statement.sql).toMatch(/synced_at\s*>\s*\?/);
    expect(statement.sql).toMatch(/synced_at\s*<=\s*\?/);
    expect(statement.binds).toContain(SINCE_N);
    expect(statement.binds).toContain(UNTIL_N);
    expect(statement.binds).not.toContain(SINCE_RAW);
    expect(statement.binds).not.toContain(UNTIL_RAW);
  });

  it("hand-derived fixture sets are satisfiable by the literal SQL predicates", async () => {
    const select = async (sql: string, ...binds: unknown[]) => {
      const rows = await TEST_ENV.CUSTOMER_DB.prepare(sql).bind(...binds).all<{ pickup_address_id: number }>();
      return rows.results.map(r => r.pickup_address_id);
    };
    const base = "SELECT pickup_address_id FROM address_snapshot WHERE ";
    const order = " ORDER BY pickup_address_id";
    expect(await select(`${base}synced_at > ?${order}`, SINCE_N)).toEqual(SINCE_ONLY);
    expect(await select(`${base}synced_at <= ?${order}`, UNTIL_N)).toEqual(UNTIL_ONLY);
    expect(await select(`${base}synced_at > ? AND synced_at <= ?${order}`, SINCE_N, UNTIL_N)).toEqual(WINDOW);
    expect(await select(`${base}synced_at > ? AND synced_at <= ?${order}`, SINCE_N, SINCE_N)).toEqual([]);
    expect(await select(`${base}synced_at > ?${order}`, SECONDS_N)).toEqual([23, 37, 42, 58, 69, 73, 83, 89]);
    expect(await select(`${base}synced_at <= ?${order}`, SECONDS_N)).toEqual([11, 79, 97]);
  });

  it("synced_at stays NOT NULL with no new synced_at index or migration", async () => {
    const columns = await TEST_ENV.CUSTOMER_DB.prepare("PRAGMA table_info(address_snapshot)").all<{ name: string; notnull: number }>();
    expect(columns.results.find(c => c.name === "synced_at")?.notnull).toBe(1);
    const indexes = await TEST_ENV.CUSTOMER_DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'address_snapshot'"
    ).all<{ name: string; sql: string | null }>();
    for (const index of indexes.results) expect(index.sql ?? "").not.toMatch(/synced_at/);
  });
});

describe("synced window mounted discovery", () => {
  it("publishes optional lossless synced bounds on the existing local-read operation only", async () => {
    const result = await request(new URL("/openapi.json", "http://test.local"), { forbidAll: true });
    expect(result.response.status).toBe(200);
    type Operation = { operationId?: string; parameters?: Array<{ name: string; in: string; required?: boolean; description?: string; example?: unknown; schema?: Record<string, unknown> }>; responses?: Record<string, { description?: string }>; description?: string; [key: string]: unknown };
    const document = await result.response.json() as { paths: Record<string, { get?: Operation }> };
    const operation = document.paths[PATH]?.get;
    expect(operation).toMatchObject({ operationId: "listAddressSnapshot", "x-access": "read", "x-effect": "local-read" });
    for (const name of ["syncedSince", "syncedUntil"] as const) {
      const params = operation?.parameters?.filter(p => p.name === name);
      expect(params, name).toHaveLength(1);
      expect(params![0]).toMatchObject({ in: "query", required: false });
      expect(params![0].schema).toMatchObject({
        type: "string",
        pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?Z$"
      });
      expect(params![0].schema?.default).toBeUndefined();
    }
    const since = operation!.parameters!.find(p => p.name === "syncedSince")!;
    const until = operation!.parameters!.find(p => p.name === "syncedUntil")!;
    const guidance = `${since.description ?? ""} ${since.schema?.description ?? ""} ${until.description ?? ""} ${until.schema?.description ?? ""} ${operation?.description ?? ""}`;
    expect(guidance).toMatch(/synced_at/);
    expect(guidance).toMatch(/strict|only later|>/i);
    expect(guidance).toMatch(/inclusive|<=/i);
    expect(guidance).toMatch(/millisecond/i);
    expect(guidance).toMatch(/never rounded|not rounded|no rounding/i);
    expect(guidance).toMatch(/\bAND\b|intersect/i);
    expect(guidance).toMatch(/mirror/i);
    expect(guidance).toMatch(/not[^.]{0,40}changes feed/i);
    expect(guidance).toMatch(/not[^.]{0,120}event time/i);
    expect(operation?.responses?.["400"]?.description).toMatch(/syncedSince/);
    expect(operation?.responses?.["400"]?.description).toMatch(/syncedUntil/);
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/container-snapshot", "/api/v1/customer-snapshot/changes", "/api/v1/address-snapshot/{pickupAddressId}"]) {
      const names = document.paths[path]?.get?.parameters?.map(p => p.name) ?? [];
      expect(names, path).not.toContain("syncedSince");
      expect(names, path).not.toContain("syncedUntil");
    }
    expect(result.prepared).toEqual([]);
  });
});

describe("synced window agent guidance: inventory, recipe and changelog", () => {
  it("inventories the bounds only on the address list and links this oracle", () => {
    const row = (path: string) =>
      policyDoc.split("\n").find(line => line.startsWith(`| \`${path}\` |`)) ?? "";
    expect(row(PATH), "address row").toContain("`syncedSince`");
    expect(row(PATH), "address row").toContain("`syncedUntil`");
    expect(row("/api/v1/customer-snapshot"), "customer row").not.toContain("syncedSince");
    expect(row("/api/v1/container-snapshot"), "container row").not.toContain("syncedSince");
    expect(policyDoc).toContain("test/addressSyncedWindow.acceptance.test.ts");
  });

  it("states stored sync time is mirror freshness, not event/service time or change proof", () => {
    const sections = policyDoc.split(/^#{1,6} /m).filter(s => s.includes("syncedSince"));
    const guidance = sections.join("\n");
    expect(guidance).toMatch(/syncedUntil/);
    expect(guidance).toMatch(/mirror/i);
    expect(guidance).toMatch(/not[^.]{0,40}changes feed/i);
    expect(guidance).toMatch(/not[^.]{0,160}event time/i);
    expect(guidance).toMatch(/strict/i);
    expect(guidance).toMatch(/inclusive/i);
  });

  it("publishes a compact finite-window polling recipe in the quickstart", () => {
    const blocks = [...quickstartDoc.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map(m => m[1]);
    const recipe = blocks.find(b => b.includes("syncedSince=") && b.includes("syncedUntil="));
    expect(recipe, "finite-window recipe").toBeDefined();
    expect(recipe).toContain(PATH);
    expect(recipe).toContain("localhost:8787");
    expect(recipe).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
    const sections = quickstartDoc.split(/^#{1,6} /m).filter(s => s.includes("syncedSince"));
    const guidance = sections.join("\n");
    expect(guidance).toMatch(/finite/i);
    expect(guidance).toMatch(/overlap/i);
    expect(guidance).toMatch(/(store|remember|keep|save)[^.]{0,120}window/i);
    expect(guidance).toMatch(/not promised|not exact|no completeness/i);
    expect(changelog.split(/^## /m)[1]).toContain("syncedSince");
    expect(changelog.split(/^## /m)[1]).toContain("syncedUntil");
  });

  it("exposes a named local-only focused check that includes this acceptance suite", () => {
    const scripts = packageJson.scripts as Record<string, string>;
    const command = Object.values(scripts).find(c => c.includes("test/addressSyncedWindow.acceptance.test.ts"));
    expect(command).toEqual(expect.any(String));
    expect(command).toMatch(/vitest\s+run/);
    expect(command).not.toMatch(/--remote|deploy|probe:post-deploy/);
  });
});

describe("synced window preserves compatible merged behavior", () => {
  it("keeps the bare list, descending order and by-id read unchanged", async () => {
    expect(ids((await page({})).body)).toEqual(ALL_IDS);
    expect(ids((await page({ order: "desc" })).body)).toEqual([...ALL_IDS].reverse());
    const byId = await request(new URL(`${PATH}/23`, "http://test.local"));
    expect(byId.response.status).toBe(200);
    expect(await byId.response.json()).toMatchObject({ pickup_address_id: 23, synced_at: SINCE_N });
  });
});
