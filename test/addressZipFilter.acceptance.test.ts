import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned oracle; corrections require a separate bounded handoff.
 * Run: npx vitest run test/addressZipFilter.acceptance.test.ts --maxWorkers=2
 * Synthetic fixtures, real hermetic D1, real app.fetch; no outbound services.
 * Mutation targets: ignored/coerced/trimmed/case-folded/LIKE zip; OR composition;
 * lost COUNT/seek predicates or next-link selector; duplicate joins; UTF-16
 * bounds; auth/validation bypass on 304; unbound SQL and a scan of the zip path.
 * The literal expected pages do not use production query/continuation helpers.
 */
const TEST_ENV = env as unknown as Env;
const ORIGIN = "https://address-zip.test.invalid";
const PATH = "/api/v1/address-snapshot";
const SPECIAL = " 雪'\"%_ /+?&#🚛 ";
const HUNDRED = "🚛".repeat(100);
const SYNCED = "2026-01-02T03:04:05.000Z";
const fixtures = [
  { id: 10, customer: 1, route: 0, franchise: "001", zip: "02139", address: "Cedar Zero", enabled: 1 },
  { id: 20, customer: 1, route: 7, franchise: "001", zip: "02139", address: "Cedar One", enabled: 1 },
  { id: 30, customer: 1, route: 7, franchise: "001", zip: "02139", address: "Cedar Disabled", enabled: 0 },
  { id: 40, customer: 1, route: 7, franchise: "001", zip: "2139", address: "Cedar Numeric", enabled: 1 },
  { id: 50, customer: 1, route: 8, franchise: "1", zip: "02139", address: "Other Route", enabled: 1 },
  { id: 60, customer: 1, route: 7, franchise: "001", zip: "07001", address: "Cedar Other Zip", enabled: 1 },
  { id: 70, customer: 1, route: 7, franchise: "001", zip: "Ab-01", address: "Cedar Upper", enabled: 1 },
  { id: 80, customer: 1, route: 7, franchise: "001", zip: "ab-01", address: "Cedar Lower", enabled: 1 },
  { id: 90, customer: 1, route: 7, franchise: "001", zip: null, address: "Cedar Null", enabled: 1 },
  { id: 100, customer: 1, route: 7, franchise: "001", zip: " 02139 ", address: "Cedar Padded", enabled: 1 },
  { id: 110, customer: 1, route: 7, franchise: "001", zip: SPECIAL, address: "Opaque One", enabled: 1 },
  { id: 120, customer: 1, route: 7, franchise: "001", zip: "02139", address: "Cedar Two", enabled: 1 },
  { id: 130, customer: 2, route: 7, franchise: "001", zip: "02139", address: "Cedar Three", enabled: 1 },
  { id: 140, customer: 1, route: null, franchise: null, zip: HUNDRED, address: "Boundary", enabled: 1 },
  { id: 150, customer: 1, route: 7, franchise: "001", zip: SPECIAL, address: "Opaque Two", enabled: 1 },
  { id: 160, customer: 1, route: 7, franchise: "001", zip: "a".repeat(100), address: "ASCII Boundary", enabled: 1 },
  { id: 170, customer: 1, route: 7, franchise: "001", zip: "x\t\ny", address: "Embedded Whitespace", enabled: 1 },
  { id: 180, customer: 1, route: 7, franchise: "001", zip: "%_", address: "Literal Wildcards", enabled: 1 },
  { id: 190, customer: 1, route: 7, franchise: "001", zip: "0", address: "Single Code Point", enabled: 1 },
  { id: 200, customer: 1, route: 7, franchise: "001", zip: "", address: "Stored Empty", enabled: 1 },
] as const;

type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
const ids = (body: Body) => body.rows.map(row => row.pickup_address_id);

// Observe the real database boundary, never simulate SQL selection or sorting.
function recordedDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const forbid = vi.fn(() => { throw new Error("Unexpected D1 write or external service in ZIP oracle"); });
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
      expect(sql.trim()).toMatch(/^SELECT\b/i);
      return wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []);
    },
    batch: forbid, exec: forbid,
  } as unknown as D1Database;
  return { db, prepared, statements, forbid };
}

let requestNumber = 0;
async function request(
  query: string | URL = "",
  options: { token?: string | null; headers?: Record<string, string> } = {},
) {
  const recorder = recordedDb();
  const url = query instanceof URL ? query : new URL(`${PATH}${query ? `?${query}` : ""}`, ORIGIN);
  const requestId = `Zip-oracle-${++requestNumber}`;
  const headers = new Headers({ origin: ORIGIN, "x-request-id": requestId, ...options.headers });
  const token = options.token === undefined ? "test-read-token" : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: recorder.db,
    SNAPSHOTS: {
      get: recorder.forbid, head: recorder.forbid, list: recorder.forbid,
      put: recorder.forbid, delete: recorder.forbid,
    } as unknown as R2Bucket,
    BROWSER: { fetch: recorder.forbid } as unknown as Fetcher,
  });
  expect(recorder.forbid).not.toHaveBeenCalled();
  return { response, recorder, url, requestId };
}

function posture(result: Awaited<ReturnType<typeof request>>) {
  const headers = result.response.headers;
  expect(headers.get("cache-control")).toBe("no-store");
  expect(headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(headers.get("vary")).toMatch(/\borigin\b/i);
  expect(headers.get("access-control-allow-credentials")).toBeNull();
  expect(headers.get("x-request-id")).toBe(result.requestId);
  expect(headers.get("x-content-type-options")).toBe("nosniff");
}

function reads(result: Awaited<ReturnType<typeof request>>) {
  const countFree = result.url.searchParams.get("includeTotal") === "false";
  expect(result.recorder.statements).toHaveLength(countFree ? 1 : 2);
  expect(result.recorder.statements.filter(isCount)).toHaveLength(countFree ? 0 : 1);
  const select = result.recorder.statements.find(statement => !isCount(statement))!;
  // The bounded list contract is LIMIT, not LIMIT+1 lookahead plus slicing.
  const offset = /\bOFFSET\b/i.test(select.sql);
  expect(select.binds[select.binds.length - (offset ? 2 : 1)]).toBe(Number(result.url.searchParams.get("limit") ?? 50));
}

async function page(query: string | URL = "") {
  const result = await request(query);
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  posture(result);
  reads(result);
  const body = await result.response.json() as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  if (result.url.searchParams.get("includeTotal") === "false") expect(body.total).toBeNull();
  return { ...result, body };
}

function next(result: Awaited<ReturnType<typeof page>>) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/address-snapshot\?[^<>\s]*>; rel="next"$/);
  const url = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(url.origin).toBe(ORIGIN);
  expect(url.pathname).toBe(PATH);
  expect(url.hash).toBe("");
  expect(url.searchParams.has("offset")).toBe(false);
  expect(url.searchParams.getAll("cursor")).toEqual([String(result.body.nextCursor)]);
  for (const [key, value] of result.url.searchParams) {
    if (key === "cursor" || key === "offset") continue;
    if ((key === "includeTotal" && value === "true") || (key === "order" && value === "asc")) {
      // Default values may be omitted; exact selectors and false must survive.
      expect([[], [value]]).toContainEqual(url.searchParams.getAll(key));
    } else expect(url.searchParams.getAll(key), key).toEqual([value]);
  }
  return url;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  requestNumber = 0;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound fetch in ZIP oracle"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, synced_at) VALUES (1, 'Synthetic One', ?), (2, 'Synthetic Two', ?)").bind(SYNCED, SYNCED),
  ]);
  await db.batch([...fixtures].reverse().map(row => db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, zip, address, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(row.id, row.customer, row.route, row.franchise, row.zip, row.address, row.enabled, SYNCED)));
  // Two containers at one matching address catch accidental join duplication;
  // other matching addresses deliberately have no containers.
  await db.batch([
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, synced_at) VALUES (1, 20, ?), (2, 20, ?), (3, 60, ?)").bind(SYNCED, SYNCED, SYNCED),
  ]);
});
afterEach(() => {
  try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

const matches = [
  ["omission retains NULL and empty zips", "", [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200]],
  ["leading zeros are significant, NULL excluded, duplicate sites retained", "zip=02139", [10, 20, 30, 50, 120, 130]],
  ["numeric-looking unpadded value is distinct", "zip=2139", [40]],
  ["other leading-zero postcode", "zip=07001", [60]],
  ["uppercase opaque postcode", "zip=Ab-01", [70]],
  ["lowercase opaque postcode", "zip=ab-01", [80]],
  ["padding is data, not trimmed", `zip=${encodeURIComponent(" 02139 ")}`, [100]],
  ["100 astral code points, not UTF-16 units", `zip=${encodeURIComponent(HUNDRED)}`, [140]],
  ["100 ASCII code points", `zip=${"a".repeat(100)}`, [160]],
  ["one code point and zero are valid", "zip=0", [190]],
  ["nonblank embedded whitespace is data", `zip=${encodeURIComponent("x\t\ny")}`, [170]],
  ["reserved and Unicode characters are opaque", `zip=${encodeURIComponent(SPECIAL)}`, [110, 150]],
  ["wildcards are literals", "zip=%25_", [180]],
  ["SQL-looking input cannot widen selection", `zip=${encodeURIComponent("' OR 1=1 --")}`, []],
  ["prefix does not match", "zip=021", []],
  ["suffix does not match", "zip=139", []],
  ["unknown value is an empty success", "zip=missing", []],
  ["NULL is not the string null", "zip=null", []],
  ["customer intersects", "zip=02139&customerId=2", [130]],
  ["route intersects", "zip=02139&routeId=7", [20, 30, 120, 130]],
  ["route zero is literal", "zip=02139&routeId=0", [10]],
  ["franchise intersects without numeric coercion", "zip=02139&franchiseId=001", [10, 20, 30, 120, 130]],
  ["another franchise intersects", "zip=02139&franchiseId=1", [50]],
  ["q intersects the street", "zip=02139&q=Two", [120]],
  ["enabled true intersects", "zip=02139&enabled=true", [10, 20, 50, 120, 130]],
  ["enabled false intersects", "zip=02139&enabled=false", [30]],
  ["pickupAddressId intersects", "zip=02139&pickupAddressId=120", [120]],
  ["pickupAddressId cannot escape zip", "zip=07001&pickupAddressId=20", []],
  ["disjoint route is not OR", "zip=07001&routeId=0", []],
  ["all selectors intersect", "zip=02139&customerId=1&routeId=7&franchiseId=001&q=Cedar&enabled=true", [20, 120]],
  ["unrelated unknown key remains ignored", "zip=02139&unrelated=ignored", [10, 20, 30, 50, 120, 130]],
] as const;

describe("address zip: exact stored selector and composition", () => {
  it.each(matches)("%s", async (_name, query, expected) => {
    const result = await page(query);
    expect(ids(result.body)).toEqual(expected);
    expect(result.body.total).toBe(expected.length);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  });

  it("round-trips the stored zip and preserves the canonical full row", async () => {
    const result = await page("zip=02139&pickupAddressId=10");
    expect(result.body.rows).toEqual([{
      pickup_address_id: 10, customer_id: 1, route_id: 0, franchise_id: "001", zip: "02139",
      address: "Cedar Zero", city: null, state: null, comments: null, extras_allowed: 1,
      enabled: 1, driver_note: null, latitude: null, longitude: null, last_audit_date: null, synced_at: SYNCED,
    }]);
  });

  it("filters before sparse projection even when zip is not selected", async () => {
    const result = await page("zip=02139&fields=enabled&routeId=7&customerId=1");
    expect(result.body.rows).toEqual([
      { pickup_address_id: 20, enabled: 1 }, { pickup_address_id: 30, enabled: 0 }, { pickup_address_id: 120, enabled: 1 },
    ]);
    expect(result.body.total).toBe(3);
  });

  it("is idempotent without modifying any of the three synthetic tables", async () => {
    const before = await Promise.all(["customer_snapshot", "address_snapshot", "container_snapshot"].map(table =>
      TEST_ENV.CUSTOMER_DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
    const first = await page(`zip=${encodeURIComponent(SPECIAL)}`);
    const second = await page(`zip=${encodeURIComponent(SPECIAL)}`);
    expect(ids(first.body)).toEqual([110, 150]);
    expect(second.body).toEqual(first.body);
    const after = await Promise.all(["customer_snapshot", "address_snapshot", "container_snapshot"].map(table =>
      TEST_ENV.CUSTOMER_DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
    expect(after.map(r => r.results)).toEqual(before.map(r => r.results));
  });
});

describe.each(["true", "false"])("address zip: bounded pagination includeTotal=%s", includeTotal => {
  it.each([
    ["asc", [10, 20], 20, [30, 50], 50, [120, 130], 130],
    ["desc", [130, 120], 120, [50, 30], 30, [20, 10], 10],
  ] as const)("follows %s server links through a full final page and the empty terminal page", async (order, a, ca, b, cb, c, cc) => {
    let result = await page(`zip=02139&order=${order}&includeTotal=${includeTotal}&fields=zip&limit=2`);
    const seen: unknown[] = [];
    for (const [expected, total, cursor] of [[a, 6, ca], [b, 4, cb], [c, 2, cc], [[], 0, null]] as const) {
      expect(ids(result.body)).toEqual(expected);
      expect(result.body.rows.every(row => Object.keys(row).sort().join(",") === "pickup_address_id,zip" && row.zip === "02139")).toBe(true);
      expect(result.body.total).toBe(includeTotal === "false" ? null : total);
      expect(result.body.nextCursor).toBe(cursor);
      seen.push(...ids(result.body));
      if (cursor === null) expect(result.response.headers.get("link")).toBeNull();
      else result = await page(next(result));
    }
    expect(seen).toEqual(order === "desc" ? [130, 120, 50, 30, 20, 10] : [10, 20, 30, 50, 120, 130]);
    expect(new Set(seen).size).toBe(6);
  });

  it.each([
    ["asc", [20, 30], [50, 120], 30],
    ["desc", [120, 50], [30, 20], 50],
  ] as const)("applies offset once then seeks %s with cursor-relative totals", async (order, firstIds, secondIds, cursor) => {
    const first = await page(`zip=02139&order=${order}&offset=1&limit=2&includeTotal=${includeTotal}`);
    expect(ids(first.body)).toEqual(firstIds);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 6);
    expect(first.body.nextCursor).toBe(cursor);
    const second = await page(next(first));
    expect(ids(second.body)).toEqual(secondIds);
    expect(second.body.total).toBe(includeTotal === "false" ? null : 3);
  });

  it.each([
    ["asc", "30", [50, 120], 3], ["desc", "50", [30, 20], 3],
    ["asc", "200", [], 0], ["desc", "1", [], 0],
  ] as const)("honors %s cursor %s over offset without losing zip", async (order, cursor, expected, total) => {
    const result = await page(`zip=02139&order=${order}&cursor=${cursor}&offset=99&limit=2&includeTotal=${includeTotal}`);
    expect(ids(result.body)).toEqual(expected);
    expect(result.body.total).toBe(includeTotal === "false" ? null : total);
    for (const statement of result.recorder.statements) expect(statement.sql).not.toMatch(/\bOFFSET\b/i);
    if (expected.length === 0) expect(result.response.headers.get("link")).toBeNull();
  });

  it("stops on a short final page without inventing another cursor", async () => {
    const first = await page(`zip=02139&limit=4&includeTotal=${includeTotal}`);
    expect(ids(first.body)).toEqual([10, 20, 30, 50]);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 6);
    const last = await page(next(first));
    expect(ids(last.body)).toEqual([120, 130]);
    expect(last.body.total).toBe(includeTotal === "false" ? null : 2);
    expect(last.body.nextCursor).toBeNull();
    expect(last.response.headers.get("link")).toBeNull();
  });

  it("returns an empty offset page with filtered, pre-offset total", async () => {
    const result = await page(`zip=02139&offset=6&limit=2&includeTotal=${includeTotal}`);
    expect(result.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 6, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
  });

  it("encodes the opaque zip and preserves every composed selector on real links", async () => {
    const query = new URLSearchParams({
      zip: SPECIAL, routeId: "7", franchiseId: "001", customerId: "1", q: "Opaque", enabled: "true",
      fields: "enabled", limit: "1", includeTotal, order: "desc", offset: "0",
    });
    const first = await page(query.toString());
    expect(first.body.rows).toEqual([{ pickup_address_id: 150, enabled: 1 }]);
    const target = next(first);
    expect(target.searchParams.getAll("zip")).toEqual([SPECIAL]);
    expect(first.response.headers.get("link")).not.toContain(SPECIAL);
    const last = await page(target);
    expect(last.body.rows).toEqual([{ pickup_address_id: 110, enabled: 1 }]);
    const empty = await page(next(last));
    expect(empty.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(empty.response.headers.get("link")).toBeNull();
  });
});

const invalid = [
  ["empty", "zip="], ["bare key", "zip"], ["ASCII spaces", "zip=++"], ["tabs/newlines", "zip=%09%0A"],
  ["Unicode blanks", `zip=${encodeURIComponent(" 　")}`],
  ["101 ASCII code points", `zip=${"a".repeat(101)}`],
  ["101 astral code points", `zip=${encodeURIComponent("🚛".repeat(101))}`],
  ["same value repeated", "zip=02139&zip=02139"], ["different values repeated", "zip=02139&zip=07001"],
  ["empty then valid", "zip=&zip=02139"], ["valid then empty", "zip=02139&zip="],
  ["encoded duplicate key", "zip=02139&z%69p=02139"],
  ["private repeated values", "zip=synthetic-private-one&zip=synthetic-private-two"],
] as const;

describe("address zip: value-free validation and read authority", () => {
  it.each(invalid)("rejects %s before any D1 prepare, including with a matching wildcard", async (_name, query) => {
    const result = await request(query, { headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    posture(result);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("link")).toBeNull();
    const problem = await result.response.json() as Record<string, unknown>;
    expect(problem).toMatchObject({
      title: "Bad Request", status: 400,
      detail: "Invalid request query (zip). See docs/PROBLEMS.md#bad-request.",
    });
    expect(String(problem.type)).toMatch(/#bad-request$/);
    expect(JSON.stringify(problem)).not.toMatch(/synthetic-private|received|invalid_type|"input"/i);
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
  });

  it.each([null, "invalid-read-token"])("authenticates before malformed ZIP/304 handling, token %s", async token => {
    const result = await request("zip=synthetic-private-one&zip=", { token, headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(await result.response.json()).toMatchObject({ title: "Unauthorized", status: 401 });
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
  });

  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("retains authorized GET access with %s", async token => {
    const result = await request("zip=02139", { token });
    expect(result.response.status).toBe(200);
    posture(result);
    expect(ids(await result.response.json() as Body)).toEqual([10, 20, 30, 50, 120, 130]);
  });

  it("does not log valid or rejected zip values", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method =>
      vi.spyOn(console, method).mockImplementation(() => undefined));
    expect((await request(`zip=${encodeURIComponent(SPECIAL)}`)).response.status).toBe(200);
    const marker = `synthetic-private-zip-${"x".repeat(101)}`;
    const rejected = await request(`zip=${marker}`);
    expect(rejected.response.status).toBe(400);
    expect(await rejected.response.text()).not.toContain(marker);
    const output = JSON.stringify(logs.flatMap(log => log.mock.calls));
    for (const value of [SPECIAL, JSON.stringify(SPECIAL).slice(1, -1), encodeURIComponent(SPECIAL), marker]) expect(output).not.toContain(value);
    expect(rejected.recorder.prepared).toEqual([]);
  });

  it("retains the existing page upper bound before D1", async () => {
    const result = await request("zip=02139&limit=501");
    expect(result.response.status).toBe(400);
    expect(result.recorder.prepared).toEqual([]);
  });
});

it.each(["true", "false"])("keeps ZIP-filtered ETags and 304 continuation includeTotal=%s", async includeTotal => {
  const query = `zip=02139&fields=zip&limit=2&includeTotal=${includeTotal}`;
  const first = await request(query);
  expect(first.response.status).toBe(200);
  const bytes = await first.response.text();
  expect(ids(JSON.parse(bytes) as Body)).toEqual([10, 20]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  const tag = `"${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}"`;
  expect(first.response.headers.get("etag")).toBe(tag);
  const link = first.response.headers.get("link");
  expect(link).not.toBeNull();
  expect(new URL(/^<([^>]+)>/.exec(link!)![1], first.url).searchParams.get("zip")).toBe("02139");
  for (const validator of [tag, `W/${tag}`, "*"]) {
    const same = await request(query, { headers: { "if-none-match": validator } });
    expect(same.response.status).toBe(304);
    expect(same.response.body).toBeNull();
    expect((await same.response.arrayBuffer()).byteLength).toBe(0);
    expect(same.response.headers.get("etag")).toBe(tag);
    expect(same.response.headers.get("link")).toBe(link);
    posture(same);
    reads(same);
  }
  const different = await request(`zip=07001&fields=zip&limit=2&includeTotal=${includeTotal}`, { headers: { "if-none-match": tag } });
  expect(different.response.status).toBe(200);
  expect(different.response.headers.get("etag")).not.toBe(tag);
  expect(ids(await different.response.json() as Body)).toEqual([60]);
  // A replay must re-read D1, not return a cached representation based on URL.
  await TEST_ENV.CUSTOMER_DB.prepare("UPDATE address_snapshot SET zip = '07001' WHERE pickup_address_id = 10").run();
  const changed = await request(query, { headers: { "if-none-match": tag } });
  expect(changed.response.status).toBe(200);
  expect(changed.response.headers.get("etag")).not.toBe(tag);
  expect(ids(await changed.response.json() as Body)).toEqual([20, 30]);
});

describe("address zip: bound equality and the existing index", () => {
  it("proves the existing schema supports a local indexed equality seek", async () => {
    const result = await TEST_ENV.CUSTOMER_DB.prepare(
      "SELECT pickup_address_id FROM address_snapshot WHERE zip = ? ORDER BY pickup_address_id ASC LIMIT ? OFFSET ?",
    ).bind("02139", 2, 0).all<{ pickup_address_id: number }>();
    expect(result.results.map(row => row.pickup_address_id)).toEqual([10, 20]);
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(
      "EXPLAIN QUERY PLAN SELECT pickup_address_id FROM address_snapshot WHERE zip = ? ORDER BY pickup_address_id ASC LIMIT ? OFFSET ?",
    ).bind("02139", 2, 0).all<{ detail: string }>();
    const details = plan.results.map(row => row.detail);
    expect(details.join("\n")).toMatch(/SEARCH\b.*\bidx_address_snapshot_zip\b.*zip=\?/i);
    console.info("Synthetic local D1 equality EXPLAIN (no production claim):", details);
  });

  it("binds one ZIP equality in both actual SELECTs and seeks the existing ZIP index without a join", async () => {
    const result = await page(`zip=${encodeURIComponent(SPECIAL)}&limit=1`);
    const plans: Array<{ sql: string; details: string[] }> = [];
    for (const { sql, binds } of result.recorder.statements) {
      const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
      plans.push({ sql, details: plan.results.map(row => row.detail) });
    }
    const evidence = `Synthetic local D1 EXPLAIN (not a production measurement): ${JSON.stringify(plans)}`;
    expect(ids(result.body), evidence).toEqual([110]);
    expect(result.body.total).toBe(2);
    for (const { sql, binds } of result.recorder.statements) {
      const unquoted = sql.replace(/["`\[\]]/g, "");
      expect(unquoted.match(/\bzip\s*=\s*\?\d*/gi), evidence).toHaveLength(1);
      expect(unquoted).not.toMatch(/\b(?:JOIN|LIKE|GLOB|REGEXP|COLLATE\s+NOCASE)\b/i);
      expect(sql).not.toContain(SPECIAL);
      expect(binds.filter(value => value === SPECIAL)).toHaveLength(1);
    }
    for (const plan of plans) expect(plan.details.join("\n"), evidence).toMatch(/SEARCH\b.*\bidx_address_snapshot_zip\b.*zip=\?/i);
  });
});

type Parameter = {
  name: string; in: string; required?: boolean; description?: string; example?: unknown;
  examples?: Record<string, { value?: unknown }>;
  schema: { type?: string; minLength?: number; maxLength?: number; example?: unknown; default?: unknown; description?: string };
};
type Operation = { operationId: string; description: string; parameters: Parameter[]; responses: Record<string, { description: string }> };
async function document() {
  const response = await exports.default.fetch(`${ORIGIN}/openapi.json`);
  expect(response.status).toBe(200);
  return await response.json() as { paths: Record<string, { get: Operation }> };
}

describe("address zip: served discovery contract", () => {
  it("publishes one optional string facet and an honest leading-zero synthetic example", async () => {
    const doc = await document();
    const operation = doc.paths[PATH].get;
    expect(operation.operationId).toBe("listAddressSnapshot");
    const params = operation.parameters.filter(p => p.in === "query" && p.name === "zip");
    expect(params).toHaveLength(1);
    const param = params[0];
    expect(param.required ?? false).toBe(false);
    expect(param.schema).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
    expect(param.schema.default).toBeUndefined();
    const examples = [param.example, param.schema.example, ...Object.values(param.examples ?? {}).map(e => e.value)];
    expect(examples.some(value => typeof value === "string" && /^0[0-9]{4}$/.test(value))).toBe(true);
    const guidance = `${param.description ?? ""} ${param.schema.description ?? ""}`;
    expect(guidance).toMatch(/exact|opaque/i);
    expect(guidance).toMatch(/case.sensitive/i);
    expect(guidance).toMatch(/Unicode code points/i);
    expect(guidance).toMatch(/leading zeros/i);
  });

  it("documents composition and value-free correction without losing existing selectors", async () => {
    const operation = (await document()).paths[PATH].get;
    for (const name of ["zip", "routeId", "franchiseId", "customerId", "pickupAddressId", "q", "enabled", "cursor", "offset"]) {
      expect(operation.parameters.some(p => p.name === name && p.in === "query"), name).toBe(true);
      expect(operation.description).toContain(name);
    }
    expect(operation.description).toMatch(/\bAND\b|intersect/i);
    const recovery = operation.responses["400"].description;
    expect(recovery).toContain("zip");
    expect(recovery).toMatch(/blank|empty/i);
    expect(recovery).toMatch(/repeat|duplicate/i);
    expect(recovery).toMatch(/100.*Unicode code points/i);
    expect(recovery).toMatch(/before.*D1/i);
    expect(recovery).toContain("application/problem+json");
    expect(recovery).toContain("docs/PROBLEMS.md#bad-request");
  });

  it("aligns the canonical policy inventory with the served ZIP parameter", async () => {
    const operation = (await document()).paths[PATH].get;
    const row = policyDoc.split("\n").find(line => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    const inventory = [...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map(match => match[1]).sort();
    expect(inventory).toContain("zip");
    expect(inventory).toEqual(operation.parameters.filter(p => p.in === "query").map(p => p.name).sort());
  });
});
