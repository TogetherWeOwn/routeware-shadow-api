/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import changelog from "../CHANGELOG.md?raw";
import packageJson from "../package.json";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned acceptance oracle; Builder must not edit this file.
 * Run: npx vitest run test/addressCityStateFilters.acceptance.test.ts --maxWorkers=2
 * Real hermetic D1 evaluates SQL; expected IDs/pages are independent literals.
 * Synthetic data only. Fetch, browser, R2 and request-side writes are denied.
 * Mutation targets: ignored/swapped/OR/LIKE/case-folded/trimmed/coerced facets,
 * UTF-16 bounds, lost COUNT/seek/upperId/continuation predicates, unsafe echo,
 * expanded parent joins, auth/validation bypass on 304 and stale ETags.
 * City/state equality has NO index/performance or geographic inference claim.
 * GET is idempotent/local-read; CLI --dry-run does not apply.
 */
const TEST_ENV = env as unknown as Env;
const ORIGIN = "https://address-city-state.test.invalid";
const PATH = "/api/v1/address-snapshot";
const CITY = " 雪'\"%_ /+?&#🚛 ";
const STATE = " Ω'\"%_ /+?&#🌿 ";
const HUNDRED = "🚛".repeat(100);
const SYNCED = "2026-01-02T03:04:05.000Z";
// IDs 10/20/30/120/130/140 share city/state/zip, not route/customer/presence.
// Other rows independently distinguish each selector from substring/coercion.
const fixtures = [
  [10, "Riverton", "TX", "02139", 1, 0, "001", 1, "Cedar Zero"],
  [20, "Riverton", "TX", "02139", 1, 7, "001", 1, "Cedar One"],
  [30, "Riverton", "TX", "02139", 1, 7, "001", 0, "Cedar Disabled"],
  [40, "Riverton", "CA", "02139", 1, 7, "001", 1, "Different State"],
  [50, "East Riverton", "TX", "02139", 1, 7, "001", 1, "Substring City"],
  [60, "riverton", "TX", "02139", 1, 7, "001", 1, "Lower City"],
  [70, "Riverton", "tx", "02139", 1, 7, "001", 1, "Lower State"],
  [80, "Riverton", "Texas", "02139", 1, 7, "001", 1, "Full State"],
  [90, null, "TX", "02139", 1, 7, "001", 1, "Null City"],
  [100, "", "TX", "02139", 1, 7, "001", 1, "Empty City"],
  [110, " Riverton ", " TX ", "02139", 1, 7, "001", 1, "Padded"],
  [120, "Riverton", "TX", "02139", 1, 7, "001", 1, "Cedar Two"],
  [130, "Riverton", "TX", "02139", 2, 7, "001", 1, "Cedar Three"],
  [140, "Riverton", "TX", "02139", 1, 8, "1", 1, "Cedar Other Route"],
  [150, "Riverton", "TX", "99999", 1, 7, "001", 1, "Cedar Other Zip"],
  [160, CITY, STATE, "02139", 1, 7, "001", 1, "Opaque One"],
  [170, CITY, STATE, "02139", 1, 7, "001", 1, "Opaque Two"],
  [180, HUNDRED, HUNDRED, null, 1, null, null, 1, "Astral Boundary"],
  [190, "a".repeat(100), "b".repeat(100), null, 1, null, null, 1, "ASCII Boundary"],
  [200, "0", "0", null, 1, null, null, 1, "One Code Point"],
  [210, "x\t\ny", "x\t\ny", null, 1, null, null, 1, "Embedded Whitespace"],
  [220, "%_", "%_", null, 1, null, null, 1, "Literal Wildcards"],
  [230, "é", "é", null, 1, null, null, 1, "Composed Unicode"],
  [240, "é", "é", null, 1, null, null, 1, "Decomposed Unicode"],
  [250, "Other", null, null, 1, null, null, 1, "Null State"],
  [260, "Other", "", null, 1, null, null, 1, "Empty State"],
  [270, "null", "null", null, 1, null, null, 1, "Literal Null"],
  [280, "Other", "CA", null, 1, null, null, 1, "Riverton Street"],
  [290, "Other", "Else", "123Riverton456", 1, null, null, 1, "Postal Search"],
  [300, "O'Quote", "S'Quote", null, 1, null, null, 1, "Literal Quotes"],
  [310, "xx", "yy", null, 1, null, null, 1, "Wildcard Decoy"],
  [320, "Riverton", null, null, 1, null, null, 1, "City Null State"],
  [330, "Riverton", "", null, 1, null, null, 1, "City Empty State"],
  [340, "1", "0001", null, 1, null, null, 1, "Padded State"],
  [350, "0001", "1", null, 1, null, null, 1, "Padded City"],
] as const;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
const ids = (body: Body) => body.rows.map(row => row.pickup_address_id);
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
const qs = (query: Record<string, string>) => new URLSearchParams(query).toString();

// Selection/sort/count are never faked: wrap the real local D1 read boundary.
function recordedDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const forbid = vi.fn(() => { throw new Error("Unexpected write or external service in city/state oracle"); });
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
  const requestId = `City-state-oracle-${++requestNumber}`;
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
  const offset = /\bOFFSET\b/i.test(select.sql);
  // No COUNT or LIMIT+1 lookahead hiding in the count-free path.
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
  expect(url.username).toBe("");
  expect(url.password).toBe("");
  expect(url.searchParams.has("offset")).toBe(false);
  expect(url.searchParams.getAll("cursor")).toEqual([String(result.body.nextCursor)]);
  for (const [key, value] of result.url.searchParams) {
    if (["cursor", "offset", "unknown", "token", "redirect"].includes(key)) continue;
    if ((key === "includeTotal" && value === "true") || (key === "order" && value === "asc") || (key === "hasContainers" && value === "any")) {
      expect([[], [value]]).toContainEqual(url.searchParams.getAll(key));
    } else expect(url.searchParams.getAll(key), key).toEqual([value]);
  }
  for (const key of ["unknown", "token", "redirect"]) expect(url.searchParams.has(key)).toBe(false);
  expect(link).not.toMatch(/synthetic-secret|evil\.invalid|address-city-state\.test\.invalid/);
  return url;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  requestNumber = 0;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound fetch in city/state oracle"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, synced_at) VALUES (1, 'Synthetic One', ?), (2, 'Synthetic Two', ?)").bind(SYNCED, SYNCED),
  ]);
  await db.batch([...fixtures].reverse().map(([id, city, state, zip, customer, route, franchise, enabled, address]) => db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, city, state, zip, customer_id, route_id, franchise_id, enabled, address, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, city, state, zip, customer, route, franchise, enabled, address, SYNCED)));
  // Two children at 20 detect row multiplication. Disabled-only child at 30
  // still counts as present; presence does not imply an enabled parent/child.
  await db.batch([
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, synced_at) VALUES (1, 20, 1, ?), (2, 20, 1, ?), (3, 30, 0, ?), (4, 40, 1, ?), (5, 140, 1, ?)").bind(SYNCED, SYNCED, SYNCED, SYNCED, SYNCED),
  ]);
});
afterEach(() => {
  try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

// Explicit controls identify harness/setup failures separately from new RED.
describe("city/state controls: existing behavior", () => {
  it.each([
    ["omission retains null and empty facets", "", [10,20,30,40,50,60,70,80,90,100,110,120,130,140,150,160,170,180,190,200,210,220,230,240,250,260,270,280,290,300,310,320,330,340,350]],
    ["q retains street/city/zip substring search", "q=Riverton", [10,20,30,40,50,60,70,80,110,120,130,140,150,280,290,320,330]],
    ["q does not search the state column", "q=TX", []],
    ["existing route/zip/customer intersection", "routeId=7&zip=02139&customerId=2", [130]],
    ["existing presence keeps distinct parent rows", "hasContainers=true", [20,30,40,140]],
  ] as const)("%s", async (_name, query, expected) => {
    const result = await page(query);
    expect(ids(result.body)).toEqual(expected);
    expect(result.body.total).toBe(expected.length);
  });

  it.each([null, "invalid-read-token"])("authentication remains first: %s", async token => {
    const result = await request("city=synthetic-secret&city=&state=", { token, headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(await result.response.json()).toMatchObject({ title: "Unauthorized", status: 401 });
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
  });

  it("retains unrelated malformed page validation before D1", async () => {
    const result = await request("city=Riverton&state=TX&limit=501");
    expect(result.response.status).toBe(400);
    expect(result.recorder.prepared).toEqual([]);
  });
});

const matches = [
  ["city equality is not city substring", "city=Riverton", [10,20,30,40,70,80,120,130,140,150,320,330]],
  ["state alone is exact without requiring city", "state=TX", [10,20,30,50,60,90,100,120,130,140,150]],
  ["same city in another state", "city=Riverton&state=CA", [40]],
  ["both equality predicates AND, never OR", "city=Riverton&state=TX", [10,20,30,120,130,140,150]],
  ["case-sensitive city", "city=riverton&state=TX", [60]],
  ["case-sensitive state", "city=Riverton&state=tx", [70]],
  ["no abbreviation normalization or state enum", "city=Riverton&state=Texas", [80]],
  ["city padding is significant", qs({ city: " Riverton " }), [110]],
  ["state padding is significant", qs({ state: " TX " }), [110]],
  ["both padded values", qs({ city: " Riverton ", state: " TX " }), [110]],
  ["opaque city punctuation/Unicode", qs({ city: CITY }), [160,170]],
  ["opaque state punctuation/Unicode", qs({ state: STATE }), [160,170]],
  ["literal quotes", qs({ city: "O'Quote", state: "S'Quote" }), [300]],
  ["100 astral code points in city", qs({ city: HUNDRED }), [180]],
  ["100 astral code points in state", qs({ state: HUNDRED }), [180]],
  ["100 ASCII code points", qs({ city: "a".repeat(100), state: "b".repeat(100) }), [190]],
  ["100 combining code points are valid city input", qs({ city: "é".repeat(50) }), []],
  ["100 combining code points are valid state input", qs({ state: "é".repeat(50) }), []],
  ["one code point zero is valid", "city=0&state=0", [200]],
  ["city numeric-looking leading zeros stay data", "city=0001", [350]],
  ["state numeric-looking leading zeros stay data", "state=0001", [340]],
  ["no numeric coercion of city", "city=1", [340]],
  ["no numeric coercion of state", "state=1", [350]],
  ["embedded nonblank whitespace", qs({ city: "x\t\ny", state: "x\t\ny" }), [210]],
  ["wildcards are literals in city", "city=%25_", [220]],
  ["wildcards are literals in state", "state=%25_", [220]],
  ["Unicode composed city stays distinct", qs({ city: "é" }), [230]],
  ["Unicode decomposed city stays distinct", qs({ city: "é" }), [240]],
  ["Unicode composed state stays distinct", qs({ state: "é" }), [230]],
  ["Unicode decomposed state stays distinct", qs({ state: "é" }), [240]],
  ["null is not a string city", "city=null", [270]],
  ["null is not a string state", "state=null", [270]],
  ["city prefix has no match", "city=Riv", []],
  ["state substring has no match", "state=T", []],
  ["unknown city is empty success", "city=Missing", []],
  ["unknown state is empty success", "state=Missing", []],
  ["SQL-looking city cannot widen", qs({ city: "' OR 1=1 --" }), []],
  ["SQL-looking state cannot widen", qs({ state: "' OR 1=1 --" }), []],
  ["disjoint facets cannot OR", "city=riverton&state=CA", []],
  ["zip intersects", "city=Riverton&state=TX&zip=99999", [150]],
  ["route intersects", "city=Riverton&state=TX&routeId=7", [20,30,120,130,150]],
  ["zero route remains literal", "city=Riverton&state=TX&routeId=0", [10]],
  ["franchise intersects as an opaque string", "city=Riverton&state=TX&franchiseId=001", [10,20,30,120,130,150]],
  ["other franchise", "city=Riverton&state=TX&franchiseId=1", [140]],
  ["customer intersects", "city=Riverton&state=TX&customerId=2", [130]],
  ["primary ID intersects", "city=Riverton&state=TX&pickupAddressId=120", [120]],
  ["primary ID cannot escape city", "city=riverton&pickupAddressId=20", []],
  ["primary ID cannot escape state", "state=CA&pickupAddressId=20", []],
  ["enabled true intersects", "city=Riverton&state=TX&enabled=true", [10,20,120,130,140,150]],
  ["enabled false intersects", "city=Riverton&state=TX&enabled=false", [30]],
  ["presence deduplicates and includes disabled child", "city=Riverton&state=TX&hasContainers=true", [20,30,140]],
  ["absence intersects", "city=Riverton&state=TX&hasContainers=false", [10,120,130,150]],
  ["any presence is unchanged", "city=Riverton&state=TX&hasContainers=any", [10,20,30,120,130,140,150]],
  ["q intersects the street", "city=Riverton&state=TX&q=Two", [120]],
  ["q intersects another city independently", "city=East+Riverton&state=TX&q=Riverton", [50]],
  ["q OR legs cannot escape city/state", "city=Riverton&state=CA&q=Cedar", []],
  ["all selectors intersect including disabled-only presence", "city=Riverton&state=TX&zip=02139&routeId=7&franchiseId=001&customerId=1&pickupAddressId=30&enabled=false&hasContainers=true&q=Cedar", [30]],
  ["unknown keys remain ignored", "city=Riverton&state=TX&unknown=ignored", [10,20,30,120,130,140,150]],
] as const;

describe("city/state: exact stored matching and composition", () => {
  it.each(matches)("%s", async (_name, query, expected) => {
    const result = await page(query);
    expect(ids(result.body)).toEqual(expected);
    expect(result.body.total).toBe(expected.length);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  });

  it("preserves the canonical full address representation", async () => {
    const result = await page("city=Riverton&state=TX&pickupAddressId=10");
    expect(result.body.rows).toEqual([{
      pickup_address_id: 10, customer_id: 1, route_id: 0, franchise_id: "001", city: "Riverton", state: "TX", zip: "02139",
      address: "Cedar Zero", comments: null, extras_allowed: 1, enabled: 1, driver_note: null,
      latitude: null, longitude: null, last_audit_date: null, synced_at: SYNCED,
    }]);
  });

  it("filters before sparse projection even when neither facet is selected", async () => {
    const result = await page("city=Riverton&state=TX&fields=enabled&routeId=7&customerId=1");
    expect(result.body.rows).toEqual([
      { pickup_address_id: 20, enabled: 1 }, { pickup_address_id: 30, enabled: 0 },
      { pickup_address_id: 120, enabled: 1 }, { pickup_address_id: 150, enabled: 1 },
    ]);
    expect(result.body.total).toBe(4);
  });

  it("is idempotent and leaves all three tables unchanged", async () => {
    const snapshot = () => Promise.all(["customer_snapshot", "address_snapshot", "container_snapshot"].map(table =>
      TEST_ENV.CUSTOMER_DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
    const before = await snapshot();
    const first = await page(qs({ city: CITY, state: STATE }));
    const second = await page(qs({ city: CITY, state: STATE }));
    expect(ids(first.body)).toEqual([160,170]);
    expect(second.body).toEqual(first.body);
    expect((await snapshot()).map(r => r.results)).toEqual(before.map(r => r.results));
  });

  it("binds distinct equality values in both real SELECTs, never interpolates or uses LIKE", async () => {
    const result = await page(qs({ city: CITY, state: STATE, limit: "1" }));
    expect(ids(result.body)).toEqual([160]);
    expect(result.body.total).toBe(2);
    for (const { sql, binds } of result.recorder.statements) {
      const unquoted = sql.replace(/["`\[\]]/g, "");
      for (const name of ["city", "state"]) expect(unquoted).toMatch(new RegExp(`\\b${name}\\s*=\\s*\\?\\d*|\\?\\d*\\s*=\\s*(?:\\w+\\.)?${name}\\b`, "i"));
      expect(unquoted).toMatch(/\bAND\b/i);
      expect(unquoted).not.toMatch(/\b(?:JOIN|LIKE|GLOB|REGEXP|NOCASE)\b/i);
      for (const value of [CITY, STATE]) {
        expect(sql).not.toContain(value);
        expect(binds.filter(bind => bind === value)).toHaveLength(1);
      }
      const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
      expect(plan.results.length).toBeGreaterThan(0);
      expect(plan.results.every(row => typeof row.detail === "string")).toBe(true);
      // Intentionally no SEARCH/index assertion: city/state-only may scan.
    }
  });
});

const COHORT = "city=Riverton&state=TX&zip=02139";
describe.each(["true", "false"])("city/state: bounded pagination includeTotal=%s", includeTotal => {
  it.each([
    ["asc", [[10,20],[30,120],[130,140],[]], [20,120,140,null]],
    ["desc", [[140,130],[120,30],[20,10],[]], [130,30,10,null]],
  ] as const)("follows %s links to an empty terminal page", async (order, pages, cursors) => {
    let result = await page(`${COHORT}&order=${order}&includeTotal=${includeTotal}&fields=city,state&limit=2`);
    const seen: unknown[] = [];
    for (let i = 0; i < pages.length; i++) {
      expect(ids(result.body)).toEqual(pages[i]);
      expect(result.body.rows.every(row => Object.keys(row).sort().join(",") === "city,pickup_address_id,state" && row.city === "Riverton" && row.state === "TX")).toBe(true);
      expect(result.body.total).toBe(includeTotal === "false" ? null : [6,4,2,0][i]);
      expect(result.body.nextCursor).toBe(cursors[i]);
      seen.push(...ids(result.body));
      if (cursors[i] === null) expect(result.response.headers.get("link")).toBeNull();
      else result = await page(next(result));
    }
    expect(seen).toEqual(order === "desc" ? [140,130,120,30,20,10] : [10,20,30,120,130,140]);
    expect(new Set(seen).size).toBe(6);
  });

  it.each([
    ["asc", [20,30], [120,130], 30], ["desc", [130,120], [30,20], 120],
  ] as const)("applies offset once then seeks %s", async (order, a, b, cursor) => {
    const first = await page(`${COHORT}&order=${order}&offset=1&limit=2&includeTotal=${includeTotal}`);
    expect(ids(first.body)).toEqual(a);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 6);
    expect(first.body.nextCursor).toBe(cursor);
    const second = await page(next(first));
    expect(ids(second.body)).toEqual(b);
    expect(second.body.total).toBe(includeTotal === "false" ? null : 3);
  });

  it.each([
    ["asc", "30", [120,130], 3], ["desc", "120", [30,20], 3],
    ["asc", "350", [], 0], ["desc", "1", [], 0],
  ] as const)("gives %s cursor=%s precedence over offset", async (order, cursor, expected, total) => {
    const result = await page(`${COHORT}&order=${order}&cursor=${cursor}&offset=99&limit=2&includeTotal=${includeTotal}`);
    expect(ids(result.body)).toEqual(expected);
    expect(result.body.total).toBe(includeTotal === "false" ? null : total);
    for (const statement of result.recorder.statements) expect(statement.sql).not.toMatch(/\bOFFSET\b/i);
  });

  it.each(["asc", "desc"])("carries upperId through %s traversal and excludes later arrivals", async order => {
    let result = await page(`${COHORT}&upperId=120&order=${order}&limit=2&includeTotal=${includeTotal}`);
    expect(ids(result.body)).toEqual(order === "asc" ? [10,20] : [120,30]);
    expect(result.body.total).toBe(includeTotal === "false" ? null : 4);
    await TEST_ENV.CUSTOMER_DB.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, city, state, zip, enabled, synced_at) VALUES (121, 1, 'Riverton', 'TX', '02139', 1, ?)").bind(SYNCED).run();
    result = await page(next(result));
    expect(ids(result.body)).toEqual(order === "asc" ? [30,120] : [20,10]);
    expect(result.body.total).toBe(includeTotal === "false" ? null : 2);
    const terminal = await page(next(result));
    expect(terminal.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(terminal.response.headers.get("link")).toBeNull();
  });

  it("stops on a short final page", async () => {
    const first = await page(`${COHORT}&limit=4&includeTotal=${includeTotal}`);
    expect(ids(first.body)).toEqual([10,20,30,120]);
    const last = await page(next(first));
    expect(last.body).toMatchObject({ total: includeTotal === "false" ? null : 2, nextCursor: null });
    expect(ids(last.body)).toEqual([130,140]);
    expect(last.response.headers.get("link")).toBeNull();
  });

  it("keeps the filtered pre-offset total on an empty offset page", async () => {
    const result = await page(`${COHORT}&offset=6&limit=2&includeTotal=${includeTotal}`);
    expect(result.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 6, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
  });

  it.each(["city", "state"])("retains an independently supplied opaque %s selector", async key => {
    const first = await page(qs({ [key]: key === "city" ? CITY : STATE, limit: "1", includeTotal }));
    expect(ids(first.body)).toEqual([160]);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 2);
    const last = await page(next(first));
    expect(ids(last.body)).toEqual([170]);
    expect(last.body.total).toBe(includeTotal === "false" ? null : 1);
    const empty = await page(next(last));
    expect(empty.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(empty.response.headers.get("link")).toBeNull();
  });

  it.each(["asc", "desc"])("round-trips opaque values with every composed selector %s, not the raw URL", async order => {
    const first = await page(qs({
      city: CITY, state: STATE, zip: "02139", routeId: "7", franchiseId: "001", customerId: "1",
      q: "Opaque", enabled: "true", hasContainers: "false", upperId: "170", fields: "enabled",
      limit: "1", includeTotal, order, offset: "0", unknown: "synthetic-secret",
      token: "synthetic-secret", redirect: "https://evil.invalid/path#secret",
    }));
    expect(first.body.rows).toEqual([{ pickup_address_id: order === "asc" ? 160 : 170, enabled: 1 }]);
    const target = next(first);
    expect(target.searchParams.getAll("city")).toEqual([CITY]);
    expect(target.searchParams.getAll("state")).toEqual([STATE]);
    expect(first.response.headers.get("link")).not.toContain(CITY);
    expect(first.response.headers.get("link")).not.toContain(STATE);
    const last = await page(target);
    expect(last.body.rows).toEqual([{ pickup_address_id: order === "asc" ? 170 : 160, enabled: 1 }]);
    const empty = await page(next(last));
    expect(empty.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(empty.response.headers.get("link")).toBeNull();
  });
});

const invalid = [
  ["empty", ""], ["ASCII blank", "++"], ["tabs/newlines", "%09%0A"],
  ["Unicode blanks", encodeURIComponent(" 　")], ["101 ASCII code points", "a".repeat(101)],
  ["101 astral code points", encodeURIComponent("🚛".repeat(101))],
  ["102 code points despite 51 graphemes", encodeURIComponent("é".repeat(51))],
] as const;
describe.each(["city", "state"])("city/state: value-free validation for %s", key => {
  const other = key === "city" ? "state=TX" : "city=Riverton";
  const valid = key === "city" ? "Riverton" : "TX";
  const malformed = [
    ...invalid.map(([name, value]) => [name, `${key}=${value}`]),
    ["bare key", key], ["same repeated", `${key}=${valid}&${key}=${valid}`],
    ["different repeated", `${key}=${valid}&${key}=synthetic-secret`],
    ["empty then valid", `${key}=&${key}=${valid}`], ["valid then empty", `${key}=${valid}&${key}=`],
    ["encoded duplicate key", `${key}=${valid}&${key === "city" ? "c%69ty" : "st%61te"}=${valid}`],
  ];
  it.each(malformed)("rejects %s before prepare and before wildcard 304", async (_name, query) => {
    const result = await request(`${query}&${other}`, { headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    posture(result);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("link")).toBeNull();
    const problem = await result.response.json() as Record<string, unknown>;
    expect(problem).toMatchObject({
      title: "Bad Request", status: 400,
      detail: `Invalid request query (${key}). See docs/PROBLEMS.md#bad-request.`,
    });
    expect(String(problem.type)).toMatch(/#bad-request$/);
    expect(JSON.stringify(problem)).not.toMatch(/synthetic-secret|received|invalid_type|"input"|Riverton/);
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
  });

  it("does not log valid or rejected opaque values", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method =>
      vi.spyOn(console, method).mockImplementation(() => undefined));
    const value = key === "city" ? CITY : STATE;
    expect((await request(qs({ [key]: value }))).response.status).toBe(200);
    const marker = `synthetic-secret-${key}-${"x".repeat(101)}`;
    const rejected = await request(qs({ [key]: marker }));
    const bytes = await rejected.response.text();
    const output = JSON.stringify(logs.flatMap(log => log.mock.calls));
    for (const literal of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value), marker]) expect(output).not.toContain(literal);
    expect(bytes).not.toContain(marker);
    expect(rejected.response.status).toBe(400);
    expect(rejected.recorder.prepared).toEqual([]);
  });
});

it.each(["test-read-token", "test-api-token", "test-sync-secret"])("city/state retains authorized GET with %s", async token => {
  const result = await request("city=Riverton&state=CA", { token });
  expect(result.response.status).toBe(200);
  expect(ids(await result.response.json() as Body)).toEqual([40]);
});

it.each(["true", "false"])("city/state ETag hashes the selected representation; includeTotal=%s", async includeTotal => {
  const query = `${COHORT}&fields=enabled&limit=2&includeTotal=${includeTotal}`;
  const first = await request(query);
  expect(first.response.status).toBe(200);
  const bytes = await first.response.text();
  expect(ids(JSON.parse(bytes) as Body)).toEqual([10,20]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  const tag = `"${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}"`;
  expect(first.response.headers.get("etag")).toBe(tag);
  const link = first.response.headers.get("link");
  expect(link).not.toBeNull();
  const target = new URL(/^<([^>]+)>/.exec(link!)![1], first.url);
  expect(target.searchParams.get("city")).toBe("Riverton");
  expect(target.searchParams.get("state")).toBe("TX");
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
  for (const differentQuery of [
    `city=riverton&state=TX&fields=enabled&limit=2&includeTotal=${includeTotal}`,
    `city=Riverton&state=CA&fields=enabled&limit=2&includeTotal=${includeTotal}`,
    `${COHORT}&fields=city,state&limit=2&includeTotal=${includeTotal}`,
    `${COHORT}&fields=enabled&limit=2&includeTotal=${includeTotal === "true" ? "false" : "true"}`,
  ]) {
    const different = await request(differentQuery, { headers: { "if-none-match": tag } });
    expect(different.response.status).toBe(200);
    expect(different.response.headers.get("etag")).not.toBe(tag);
  }
  // Same representation with harmless ignored params must keep the same tag.
  const ignored = await request(`${query}&unknown=synthetic-secret`, { headers: { "if-none-match": tag } });
  expect(ignored.response.status).toBe(304);
  expect(ignored.response.headers.get("etag")).toBe(tag);
  // Reread D1 on replay, not a URL-based response cache.
  await TEST_ENV.CUSTOMER_DB.prepare("UPDATE address_snapshot SET state = 'CA' WHERE pickup_address_id = 10").run();
  const changed = await request(query, { headers: { "if-none-match": tag } });
  expect(changed.response.status).toBe(200);
  expect(changed.response.headers.get("etag")).not.toBe(tag);
  expect(ids(await changed.response.json() as Body)).toEqual([20,30]);
});

type Parameter = {
  name: string; in: string; required?: boolean; description?: string; example?: unknown;
  examples?: Record<string, { value?: unknown }>;
  schema: { type?: string; minLength?: number; maxLength?: number; default?: unknown; enum?: unknown; description?: string; example?: unknown };
};
type Operation = { operationId: string; description: string; parameters: Parameter[]; responses: Record<string, { description: string }> };
async function document() {
  const response = await exports.default.fetch(`${ORIGIN}/openapi.json`);
  expect(response.status).toBe(200);
  return await response.json() as { paths: Record<string, { get: Operation }> };
}

describe("city/state: consumer delivery contract", () => {
  it("offers a discoverable focused acceptance check", () => {
    // Discover the command by its actual test target, not an invented script name.
    const checks = Object.entries(packageJson.scripts).filter(([name, command]) =>
      name.startsWith("check:") && command.includes("test/addressCityStateFilters.acceptance.test.ts"));
    expect(checks.length).toBeGreaterThan(0);
    for (const [name, command] of checks) {
      expect(command).toMatch(/\bvitest\s+run\b/);
      expect(command).not.toMatch(/--passWithNoTests|--exclude|--testNamePattern|\s-t\s/);
      expect(quickstartDoc).toContain(`npm run ${name}`);
    }
  });

  it("shows an encoded exact city/state local-read recipe with continuation", () => {
    const blocks = [...quickstartDoc.matchAll(/^```(?:bash|sh)\n([\s\S]*?)^```/gm)].map(m => m[1]);
    const recipes = blocks.filter(block => block.includes(PATH) && /\bcity[=\s]/.test(block) && /\bstate[=\s]/.test(block));
    expect(recipes.length).toBeGreaterThan(0);
    for (const block of recipes) {
      expect(block).toMatch(/localhost:8787|127\.0\.0\.1:8787/);
      expect(block).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
      expect(block).not.toMatch(/--dry-run|--request\s+(?:POST|PUT|DELETE)|-X\s+(?:POST|PUT|DELETE)/);
    }
    // Preserve significant whitespace/reserved characters via URL encoding,
    // and consume the validated server continuation rather than rebuilding it.
    expect(recipes.some(block => /--data-urlencode|URLSearchParams|%[0-9a-f]{2}/i.test(block))).toBe(true);
    expect(recipes.some(block => /cursor|\blink\b/i.test(block))).toBe(true);
    const sections = quickstartDoc.split(/^#{2,4}\s+/m).filter(section => /\bcity\b/.test(section) && /\bstate\b/.test(section) && /exact/i.test(section));
    const guidance = sections.join("\n");
    expect(guidance).toMatch(/case.sensitive/i);
    expect(guidance).toMatch(/scan/i);
    expect(guidance).toMatch(/no dedicated|without.*index|not.*index/i);
    expect(guidance).toMatch(/non.?blank|non.?whitespace/i);
    expect(guidance).toMatch(/retry/i);
    expect(guidance).toMatch(/idempotent|local.read/i);
  });

  it("records the consumer-visible exact city/state change", () => {
    const entries = changelog.split(/\n-\s+/).filter(entry => /\bcity\b/.test(entry) && /\bstate\b/.test(entry) && /address-snapshot/.test(entry));
    expect(entries.some(entry => /exact|equality/i.test(entry))).toBe(true);
  });
});

describe("city/state: served discovery contract", () => {
  it.each(["city", "state"])("publishes one optional bounded opaque string %s, not a geography enum", async key => {
    const operation = (await document()).paths[PATH].get;
    expect(operation.operationId).toBe("listAddressSnapshot");
    const params = operation.parameters.filter(p => p.in === "query" && p.name === key);
    expect(params).toHaveLength(1);
    const param = params[0];
    expect(param.required ?? false).toBe(false);
    expect(param.schema).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
    expect(param.schema.default).toBeUndefined();
    expect(param.schema.enum).toBeUndefined();
    const prose = `${param.description ?? ""} ${param.schema.description ?? ""}`;
    expect(prose).toMatch(/exact|opaque/i);
    expect(prose).toMatch(/case.sensitive/i);
    expect(prose).toMatch(/Unicode code points/i);
    expect(prose).toMatch(/non.?blank|non.?whitespace/i);
    expect(prose).toMatch(/preserv|not trim|no trim|untrimmed/i);
    const examples = [param.example, param.schema.example, ...Object.values(param.examples ?? {}).map(e => e.value)];
    expect(examples.some(value => typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= 100)).toBe(true);
  });

  it("documents composition, value-free retry and honest local scan semantics", async () => {
    const operation = (await document()).paths[PATH].get;
    for (const name of ["city", "state", "zip", "routeId", "franchiseId", "customerId", "pickupAddressId", "q", "enabled", "hasContainers", "upperId", "cursor", "offset"]) {
      expect(operation.parameters.some(p => p.name === name && p.in === "query"), name).toBe(true);
      expect(operation.description).toContain(name);
    }
    expect(operation.description).toMatch(/\bAND\b|intersect/i);
    expect(operation.description).toMatch(/scan/i);
    expect(operation.description).toMatch(/no dedicated|without.*index|not.*index/i);
    const recovery = operation.responses["400"].description;
    for (const key of ["city", "state"]) expect(recovery).toContain(key);
    expect(recovery).toMatch(/blank|empty/i);
    expect(recovery).toMatch(/repeat|duplicate/i);
    expect(recovery).toMatch(/100.*Unicode code points/i);
    expect(recovery).toMatch(/before.*D1/i);
    expect(recovery).toMatch(/URL.encod|percent.encod/i);
    expect(recovery).toMatch(/retry/i);
    expect(recovery).toContain("application/problem+json");
    expect(recovery).toContain("docs/PROBLEMS.md#bad-request");
  });

  it("keeps the canonical query inventory aligned with the served selectors", async () => {
    const operation = (await document()).paths[PATH].get;
    const row = policyDoc.split("\n").find(line => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    const inventory = [...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map(match => match[1]).sort();
    expect(inventory).toContain("city");
    expect(inventory).toContain("state");
    expect(inventory).toEqual(operation.parameters.filter(p => p.in === "query").map(p => p.name).sort());
  });
});
