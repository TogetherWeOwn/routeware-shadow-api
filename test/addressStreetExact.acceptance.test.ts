/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned oracle; Builder consumes this commit without editing it.
 * Corrections require a separate bounded Test Author handoff.
 * Run: npx vitest run test/addressStreetExact.acceptance.test.ts --maxWorkers=2
 * Real app.fetch and local D1; synthetic data only, outbound services denied.
 * Mutation targets: ignored selector, LIKE/case-fold/trim/normalization, first
 * match only, city/ZIP false matches, OR composition, UTF-16 length bounds,
 * lost COUNT/seek/upperId/link predicates, duplicate joins, unbound SQL,
 * validation/auth bypass via conditional GET, and leaked query values.
 * Literal pages below are independent of production selection/link helpers.
 */
const TEST_ENV = env as unknown as Env;
const ORIGIN = "https://street-exact.test.invalid";
const PATH = "/api/v1/address-snapshot";
const STREET = "001 Cedar St";
const SPECIAL = " 雪'\"%_ /+?&#🚛 ";
const ASTRAL = "🚛".repeat(200);
const SYNCED = "2026-01-02T03:04:05.000Z";
const fixtures = [
  { id: 10, customer: 1, route: 0, franchise: "001", address: STREET, enabled: 1 },
  { id: 20, customer: 1, route: 7, franchise: "001", address: STREET, enabled: 1 },
  { id: 30, customer: 1, route: 7, franchise: "001", address: STREET, enabled: 0 },
  { id: 40, customer: 1, route: 7, franchise: "001", address: "001 Cedar St Annex", enabled: 1 },
  { id: 50, customer: 1, route: 8, franchise: "1", address: STREET, enabled: 1 },
  { id: 60, customer: 1, route: 7, franchise: "001", address: "Old 001 Cedar St", enabled: 1 },
  { id: 70, customer: 1, route: 7, franchise: "001", address: "001 cedar st", enabled: 1 },
  { id: 80, customer: 1, route: 7, franchise: "001", address: "001 CEDAR ST", enabled: 1 },
  { id: 90, customer: 1, route: 7, franchise: "001", address: null, enabled: 1 },
  { id: 100, customer: 1, route: 7, franchise: "001", address: " 001 Cedar St ", enabled: 1 },
  { id: 110, customer: 1, route: 7, franchise: "001", address: SPECIAL, enabled: 1 },
  { id: 120, customer: 1, route: 7, franchise: "001", address: STREET, enabled: 1 },
  { id: 130, customer: 2, route: 7, franchise: "001", address: STREET, enabled: 1 },
  { id: 140, customer: 1, route: null, franchise: null, address: ASTRAL, enabled: 1 },
  { id: 150, customer: 1, route: 7, franchise: "001", address: SPECIAL, enabled: 1 },
  { id: 160, customer: 1, route: 7, franchise: "001", address: "a".repeat(200), enabled: 1 },
  { id: 170, customer: 1, route: 7, franchise: "001", address: "x\t\ny", enabled: 1 },
  { id: 180, customer: 1, route: 7, franchise: "001", address: "%_", enabled: 1 },
  { id: 190, customer: 1, route: 7, franchise: "001", address: "0", enabled: 1 },
  { id: 200, customer: 1, route: 7, franchise: "001", address: "", enabled: 1 },
  { id: 210, customer: 1, route: 7, franchise: "001", address: "City decoy", enabled: 1 },
  { id: 220, customer: 1, route: 7, franchise: "001", address: "ZIP decoy", enabled: 1 },
  { id: 230, customer: 1, route: 7, franchise: "001", address: "é", enabled: 1 },
  { id: 240, customer: 1, route: 7, franchise: "001", address: "é", enabled: 1 },
  { id: 250, customer: 1, route: 7, franchise: "001", address: " \t ", enabled: 1 },
] as const;

type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
const ids = (body: Body) => body.rows.map(row => row.pickup_address_id);
const isCount = (statement: Statement) => /\bCOUNT\s*\(/i.test(statement.sql);
const query = (street: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({ streetAddress: street, ...extra }).toString();

// Observe executions without simulating SQL selection. Mutations are forbidden
// at the request boundary; only fixture setup can access the real DB directly.
function recordedDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const forbid = vi.fn(() => { throw new Error("Unexpected write or external service in street oracle"); });
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
  search: string | URL = "",
  options: { token?: string | null; headers?: Record<string, string> } = {},
) {
  const recorder = recordedDb();
  const url = search instanceof URL ? search : new URL(`${PATH}${search ? `?${search}` : ""}`, ORIGIN);
  const requestId = `Street-oracle-${++requestNumber}`;
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
  expect(select.binds[select.binds.length - (offset ? 2 : 1)]).toBe(Number(result.url.searchParams.get("limit") ?? 50));
}

async function page(search: string | URL = "") {
  const result = await request(search);
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
  const target = /^<([^>]+)>; rel="next"$/.exec(link!)![1];
  expect(target.startsWith("//")).toBe(false);
  const url = new URL(target, ORIGIN);
  expect(url.origin).toBe(ORIGIN);
  expect(url.pathname).toBe(PATH);
  expect(url.username).toBe("");
  expect(url.password).toBe("");
  expect(url.hash).toBe("");
  expect(url.searchParams.has("offset")).toBe(false);
  expect(url.searchParams.getAll("cursor")).toEqual([String(result.body.nextCursor)]);
  const allowed = new Set(["cursor"]);
  for (const [key, value] of result.url.searchParams) {
    if (["cursor", "offset", "unknown", "token"].includes(key)) continue;
    allowed.add(key);
    if ((key === "includeTotal" && value === "true") || (key === "order" && value === "asc") || (key === "hasContainers" && value === "any")) {
      expect([[], [value]], key).toContainEqual(url.searchParams.getAll(key));
    } else expect(url.searchParams.getAll(key), key).toEqual([value]);
  }
  for (const key of url.searchParams.keys()) expect(allowed.has(key), key).toBe(true);
  return url;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  requestNumber = 0;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound fetch in street oracle"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, synced_at) VALUES (1, 'Synthetic One', ?), (2, 'Synthetic Two', ?)").bind(SYNCED, SYNCED),
  ]);
  await db.batch([...fixtures].reverse().map(row => db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, address, city, state, zip, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(row.id, row.customer, row.route, row.franchise, row.address,
    row.id === 210 ? STREET : row.id === 120 ? "Other Town" : "Cedarville",
    "XY", row.id === 220 ? STREET : row.id === 120 ? "07001" : "02139", row.enabled, SYNCED)));
  // Duplicate children must not duplicate a site; a disabled-only child counts.
  await db.batch([
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, synced_at) VALUES (1, 20, 1, ?), (2, 20, 0, ?), (3, 30, 0, ?)").bind(SYNCED, SYNCED, SYNCED),
  ]);
});
afterEach(() => {
  try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

const matches = [
  ["omission retains null, empty and blank stored streets", "", [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250]],
  ["all duplicate exact sites, not city/ZIP/substrings", query(STREET), [10, 20, 30, 50, 120, 130]],
  ["q still searches street/city/ZIP substrings", "q=001%20Cedar%20St", [10, 20, 30, 40, 50, 60, 70, 80, 100, 120, 130, 210, 220]],
  ["lowercase is distinct", query("001 cedar st"), [70]],
  ["uppercase is distinct", query("001 CEDAR ST"), [80]],
  ["significant padding is retained", query(" 001 Cedar St "), [100]],
  ["leading zeros are not coerced", query("1 Cedar St"), []],
  ["prefix is not a complete street", query("001 Cedar"), []],
  ["suffix is not a complete street", query("Cedar St"), []],
  ["null is not a string", query("null"), []],
  ["unmatched street succeeds empty", query("Synthetic missing"), []],
  ["Unicode and reserved punctuation are literal", query(SPECIAL), [110, 150]],
  ["SQL-looking street cannot widen selection", query("' OR 1=1 --"), []],
  ["LIKE wildcard characters are literal", query("%_"), [180]],
  ["200 astral code points are valid", query(ASTRAL), [140]],
  ["200 ASCII code points are valid", query("a".repeat(200)), [160]],
  ["one code point, including zero, is valid", query("0"), [190]],
  ["embedded nonblank whitespace is data", query("x\t\ny"), [170]],
  ["composed Unicode is not normalized", query("é"), [230]],
  ["decomposed Unicode is not normalized", query("é"), [240]],
  ["customer intersects", query(STREET, { customerId: "2" }), [130]],
  ["route intersects", query(STREET, { routeId: "7" }), [20, 30, 120, 130]],
  ["route zero remains literal", query(STREET, { routeId: "0" }), [10]],
  ["franchise keeps leading zeros", query(STREET, { franchiseId: "001" }), [10, 20, 30, 120, 130]],
  ["another franchise intersects", query(STREET, { franchiseId: "1" }), [50]],
  ["q intersects using the city leg", query(STREET, { q: "Other Town" }), [120]],
  ["q intersects using the ZIP leg", query(STREET, { q: "07001" }), [120]],
  ["disjoint q cannot escape exact street", query(STREET, { q: "Annex" }), []],
  ["zip intersects", query(STREET, { zip: "02139" }), [10, 20, 30, 50, 130]],
  ["disjoint zip cannot escape exact street", query("City decoy", { zip: "07001" }), []],
  ["enabled true intersects", query(STREET, { enabled: "true" }), [10, 20, 50, 120, 130]],
  ["enabled false intersects", query(STREET, { enabled: "false" }), [30]],
  ["primary address ID intersects", query(STREET, { pickupAddressId: "120" }), [120]],
  ["primary address ID cannot escape street", query(STREET, { pickupAddressId: "40" }), []],
  ["ID set intersects without swallowing exact street", query(STREET, { ids: "10,20,40,210" }), [10, 20]],
  ["disjoint ID set cannot escape street", query(STREET, { ids: "40,210,220" }), []],
  ["presence does not duplicate sites or ignore disabled children", query(STREET, { hasContainers: "true" }), [20, 30]],
  ["absence intersects", query(STREET, { hasContainers: "false" }), [10, 50, 120, 130]],
  ["any presence preserves all matches", query(STREET, { hasContainers: "any" }), [10, 20, 30, 50, 120, 130]],
  ["upperId caps matches", query(STREET, { upperId: "120" }), [10, 20, 30, 50, 120]],
  ["all selectors intersect", query(STREET, { q: "Cedarville", zip: "02139", routeId: "7", franchiseId: "001", customerId: "1", enabled: "true", hasContainers: "true", upperId: "120" }), [20]],
  ["unknown keys remain ignored", query(STREET, { unknown: "ignored" }), [10, 20, 30, 50, 120, 130]],
] as const;

describe.each(["true", "false"])("exact street: selection includeTotal=%s", includeTotal => {
  it.each(matches)("%s", async (_name, search, expected) => {
    const result = await page(`${search}${search ? "&" : ""}includeTotal=${includeTotal}`);
    expect(ids(result.body)).toEqual(expected);
    expect(result.body.total).toBe(includeTotal === "false" ? null : expected.length);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  });
});

it("preserves the full canonical row and filters before sparse projection", async () => {
  const full = await page(query(STREET, { pickupAddressId: "10" }));
  expect(full.body.rows).toEqual([{
    pickup_address_id: 10, customer_id: 1, route_id: 0, franchise_id: "001", address: STREET,
    city: "Cedarville", state: "XY", zip: "02139", comments: null, extras_allowed: 1,
    enabled: 1, driver_note: null, latitude: null, longitude: null, last_audit_date: null, synced_at: SYNCED,
  }]);
  const sparse = await page(query(STREET, { fields: "enabled", customerId: "1", routeId: "7" }));
  expect(sparse.body.rows).toEqual([
    { pickup_address_id: 20, enabled: 1 }, { pickup_address_id: 30, enabled: 0 }, { pickup_address_id: 120, enabled: 1 },
  ]);
  expect(sparse.body.total).toBe(3);
});

describe.each(["true", "false"])("exact street: bounded pages includeTotal=%s", includeTotal => {
  it.each([
    ["asc", [10, 20], 20, [30, 50], 50, [120, 130], 130],
    ["desc", [130, 120], 120, [50, 30], 30, [20, 10], 10],
  ] as const)("follows %s links to an empty terminal page without losing duplicates", async (order, a, ca, b, cb, c, cc) => {
    let result = await page(query(STREET, { order, includeTotal, fields: "address", limit: "2" }));
    const seen: unknown[] = [];
    for (const [expected, total, cursor] of [[a, 6, ca], [b, 4, cb], [c, 2, cc], [[], 0, null]] as const) {
      expect(ids(result.body)).toEqual(expected);
      expect(result.body.rows.every(row => Object.keys(row).sort().join(",") === "address,pickup_address_id" && row.address === STREET)).toBe(true);
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
    ["asc", [20, 30], [50, 120], 30], ["desc", [120, 50], [30, 20], 50],
  ] as const)("applies offset once, then seeks %s with filtered totals", async (order, a, b, cursor) => {
    const first = await page(query(STREET, { order, includeTotal, offset: "1", limit: "2" }));
    expect(ids(first.body)).toEqual(a);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 6);
    expect(first.body.nextCursor).toBe(cursor);
    const second = await page(next(first));
    expect(ids(second.body)).toEqual(b);
    expect(second.body.total).toBe(includeTotal === "false" ? null : 3);
  });

  it.each([
    ["asc", "30", [50, 120], 3], ["desc", "50", [30, 20], 3],
    ["asc", "250", [], 0], ["desc", "1", [], 0],
  ] as const)("prioritizes %s cursor %s over offset", async (order, cursor, expected, total) => {
    const result = await page(query(STREET, { order, cursor, offset: "99", limit: "2", includeTotal }));
    expect(ids(result.body)).toEqual(expected);
    expect(result.body.total).toBe(includeTotal === "false" ? null : total);
    for (const statement of result.recorder.statements) expect(statement.sql).not.toMatch(/\bOFFSET\b/i);
    if (expected.length === 0) expect(result.response.headers.get("link")).toBeNull();
  });

  it("returns pre-offset filtered total on an empty offset page", async () => {
    const result = await page(query(STREET, { offset: "6", limit: "2", includeTotal }));
    expect(result.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 6, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
  });

  it.each(["asc", "desc"])("retains upperId and every composed selector through %s links", async order => {
    let result = await page(query(STREET, {
      q: "Cedarville", zip: "02139", routeId: "7", franchiseId: "001", customerId: "1",
      hasContainers: "true", upperId: "30", fields: "enabled", limit: "1", order, includeTotal,
    }));
    const pages = order === "asc" ? [[20], [30], []] : [[30], [20], []];
    for (let index = 0; index < pages.length; index++) {
      expect(ids(result.body)).toEqual(pages[index]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : 2 - index);
      if (index === 2) {
        expect(result.body.nextCursor).toBeNull();
        expect(result.response.headers.get("link")).toBeNull();
      } else result = await page(next(result));
    }
  });

  it.each(["asc", "desc"])("encodes literal punctuation/Unicode and excludes credentials/unknown keys on %s links", async order => {
    const url = new URL(`${PATH}?${query(SPECIAL, {
      enabled: "true", fields: "enabled", limit: "1", order, includeTotal, offset: "0",
      unknown: "https://synthetic-user:synthetic-pass@untrusted.test.invalid/synthetic-hidden", token: "synthetic-query-token",
    })}`, "https://untrusted.test.invalid");
    let result = await page(url);
    for (const expected of (order === "asc" ? [[110], [150], []] : [[150], [110], []])) {
      expect(ids(result.body)).toEqual(expected);
      if (expected.length) {
        const target = next(result);
        expect(target.searchParams.getAll("streetAddress")).toEqual([SPECIAL]);
        const link = result.response.headers.get("link")!;
        expect(link).not.toMatch(/synthetic-(?:user|pass|hidden|query-token)|untrusted\.test|https?:/);
        expect(link).not.toContain(SPECIAL);
        result = await page(target);
      } else expect(result.response.headers.get("link")).toBeNull();
    }
  });

  it("stops on a short final page", async () => {
    const first = await page(query(STREET, { limit: "4", includeTotal }));
    expect(ids(first.body)).toEqual([10, 20, 30, 50]);
    const last = await page(next(first));
    expect(ids(last.body)).toEqual([120, 130]);
    expect(last.body.total).toBe(includeTotal === "false" ? null : 2);
    expect(last.body.nextCursor).toBeNull();
    expect(last.response.headers.get("link")).toBeNull();
  });
});

const invalid = [
  ["empty", "streetAddress="], ["bare", "streetAddress"], ["spaces", "streetAddress=++"],
  ["tabs/newlines", "streetAddress=%09%0A"], ["Unicode blanks", query(" 　")],
  ["201 ASCII code points", query("a".repeat(201))], ["201 astral code points", query("🚛".repeat(201))],
  ["same repeated", `${query(STREET)}&${query(STREET)}`],
  ["different repeated", "streetAddress=synthetic-private-one&streetAddress=synthetic-private-two"],
  ["empty then valid", `streetAddress=&${query(STREET)}`], ["valid then empty", `${query(STREET)}&streetAddress=`],
  ["encoded duplicate key", `${query(STREET)}&street%41ddress=synthetic-private-two`],
] as const;

describe("exact street: value-free validation and auth precedence", () => {
  it.each(invalid.flatMap(([name, search]) => [
    [name, search, "ordinary"] as const, [name, search, "wildcard"] as const,
  ]))("rejects %s (%s, %s) before D1", async (_name, search, mode) => {
    const result = await request(search, { headers: mode === "wildcard" ? { "if-none-match": "*" } : {} });
    expect(result.response.status).toBe(400);
    posture(result);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("link")).toBeNull();
    const problem = await result.response.json() as Record<string, unknown>;
    expect(problem).toMatchObject({ title: "Bad Request", status: 400 });
    expect(String(problem.type)).toMatch(/#bad-request$/);
    expect(String(problem.detail)).toContain("streetAddress");
    expect(String(problem.detail)).toContain("docs/PROBLEMS.md#bad-request");
    const text = JSON.stringify(problem);
    expect(text).not.toMatch(/synthetic-private|received|invalid_type|"input"/i);
    for (const value of new URLSearchParams(search).getAll("streetAddress")) {
      if (value.trim()) expect(text).not.toContain(JSON.stringify(value).slice(1, -1));
    }
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
  });

  it.each([null, "invalid-read-token"])("authenticates before malformed street/304, token %s", async token => {
    const result = await request("streetAddress=synthetic-private-one&streetAddress=", { token, headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(await result.response.json()).toMatchObject({ title: "Unauthorized", status: 401 });
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
  });

  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("preserves GET authority with %s", async token => {
    const result = await request(query(STREET), { token });
    expect(result.response.status).toBe(200);
    expect(ids(await result.response.json() as Body)).toEqual([10, 20, 30, 50, 120, 130]);
  });

  it("does not log valid or rejected values", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method =>
      vi.spyOn(console, method).mockImplementation(() => undefined));
    expect((await request(query(SPECIAL))).response.status).toBe(200);
    const marker = `synthetic-private-street-${"x".repeat(201)}`;
    const rejected = await request(query(marker));
    expect(rejected.response.status).toBe(400);
    expect(await rejected.response.text()).not.toContain(marker);
    const output = JSON.stringify(logs.flatMap(log => log.mock.calls));
    for (const value of [SPECIAL, JSON.stringify(SPECIAL).slice(1, -1), encodeURIComponent(SPECIAL), marker]) expect(output).not.toContain(value);
    expect(rejected.recorder.prepared).toEqual([]);
    expect(rejected.recorder.statements).toEqual([]);
  });

  it("retains the page bound and existing-selector validation before D1", async () => {
    const invalidSelectors: Array<Record<string, string>> = [{ limit: "501" }, { zip: "" }, { hasContainers: "TRUE" }, { routeId: "-1" }];
    for (const extra of invalidSelectors) {
      const result = await request(query(STREET, extra));
      expect(result.response.status).toBe(400);
      expect(result.recorder.prepared).toEqual([]);
    }
  });
});

it.each(["true", "false"])("preserves representation ETags/304 and continuation includeTotal=%s", async includeTotal => {
  const search = query(STREET, { fields: "address", limit: "2", includeTotal });
  const first = await request(search);
  expect(first.response.status).toBe(200);
  const bytes = await first.response.text();
  expect(ids(JSON.parse(bytes) as Body)).toEqual([10, 20]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  const tag = `"${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}"`;
  expect(first.response.headers.get("etag")).toBe(tag);
  const link = first.response.headers.get("link");
  expect(link).not.toBeNull();
  expect(new URL(/^<([^>]+)>/.exec(link!)![1], ORIGIN).searchParams.get("streetAddress")).toBe(STREET);
  for (const validator of [tag, `W/${tag}`, "*"]) {
    const same = await request(search, { headers: { "if-none-match": validator } });
    expect(same.response.status).toBe(304);
    expect(same.response.body).toBeNull();
    expect((await same.response.arrayBuffer()).byteLength).toBe(0);
    expect(same.response.headers.get("etag")).toBe(tag);
    expect(same.response.headers.get("link")).toBe(link);
    posture(same);
    reads(same);
  }
  const different = await request(query("001 cedar st", { fields: "address", limit: "2", includeTotal }), { headers: { "if-none-match": tag } });
  expect(different.response.status).toBe(200);
  expect(different.response.headers.get("etag")).not.toBe(tag);
  expect(ids(await different.response.json() as Body)).toEqual([70]);
  const projected = await request(query(STREET, { fields: "enabled", limit: "2", includeTotal }), { headers: { "if-none-match": tag } });
  expect(projected.response.status).toBe(200);
  expect(projected.response.headers.get("etag")).not.toBe(tag);
  // D1 must be re-read even when the URL and validator are unchanged.
  await TEST_ENV.CUSTOMER_DB.prepare("UPDATE address_snapshot SET address = 'Moved synthetic street' WHERE pickup_address_id = 10").run();
  const changed = await request(search, { headers: { "if-none-match": tag } });
  expect(changed.response.status).toBe(200);
  expect(changed.response.headers.get("etag")).not.toBe(tag);
  const changedBody = await changed.response.json() as Body;
  expect(ids(changedBody)).toEqual([20, 30]);
  expect(changedBody.total).toBe(includeTotal === "false" ? null : 5);
});

it("binds equality in shared COUNT/page predicates without normalizing or interpolating", async () => {
  const result = await page(query(SPECIAL, { limit: "1", upperId: "150", routeId: "7" }));
  expect(ids(result.body)).toEqual([110]);
  expect(result.body.total).toBe(2);
  const predicates: string[] = [];
  for (const { sql, binds } of result.recorder.statements) {
    const unquoted = sql.replace(/["`\[\]]/g, "");
    expect(unquoted.match(/\baddress\s*=\s*\?\d*/gi)).toHaveLength(1);
    expect(unquoted).not.toMatch(/\b(?:JOIN|LIKE|GLOB|REGEXP|LOWER|UPPER|TRIM|COLLATE\s+NOCASE)\b/i);
    expect(sql).not.toContain(SPECIAL);
    expect(binds.filter(value => value === SPECIAL)).toHaveLength(1);
    predicates.push(unquoted.split(/\bWHERE\b/i)[1].split(/\bORDER\s+BY\b|\bLIMIT\b/i)[0].trim());
  }
  expect(predicates).toHaveLength(2);
  expect(predicates[0]).toBe(predicates[1]);
  const count = result.recorder.statements.find(isCount)!;
  const select = result.recorder.statements.find(statement => !isCount(statement))!;
  expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
});

it("is an idempotent local read without stored-data mutation", async () => {
  const snapshot = () => Promise.all(["customer_snapshot", "address_snapshot", "container_snapshot"].map(table =>
    TEST_ENV.CUSTOMER_DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
  const before = await snapshot();
  const first = await page(query(SPECIAL));
  expect(ids(first.body)).toEqual([110, 150]);
  expect((await page(query(SPECIAL))).body).toEqual(first.body);
  expect((await snapshot()).map(result => result.results)).toEqual(before.map(result => result.results));
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
  return await response.json() as { paths: Record<string, { get?: Operation }> };
}

describe("exact street: mounted discovery", () => {
  it("exposes one optional bounded opaque string on the existing operation only", async () => {
    const doc = await document();
    const operation = doc.paths[PATH].get!;
    expect(operation.operationId).toBe("listAddressSnapshot");
    const params = operation.parameters.filter(parameter => parameter.in === "query" && parameter.name === "streetAddress");
    expect(params).toHaveLength(1);
    const param = params[0];
    expect(param.required ?? false).toBe(false);
    expect(param.schema).toMatchObject({ type: "string", minLength: 1, maxLength: 200 });
    expect(param.schema.default).toBeUndefined();
    const examples = [param.example, param.schema.example, ...Object.values(param.examples ?? {}).map(example => example.value)];
    expect(examples.some(value => typeof value === "string" && /\S/.test(value) && [...value].length <= 200)).toBe(true);
    const guidance = `${param.description ?? ""} ${param.schema.description ?? ""}`;
    expect(guidance).toMatch(/exact/i);
    expect(guidance).toMatch(/case.sensitive/i);
    expect(guidance).toMatch(/Unicode code points/i);
    for (const other of ["/api/v1/customer-snapshot", "/api/v1/container-snapshot"]) {
      expect(doc.paths[other].get!.parameters.some(parameter => parameter.name === "streetAddress")).toBe(false);
    }
  });

  it("distinguishes exact streets from substring q and retains per-selector discovery", async () => {
    const operation = (await document()).paths[PATH].get!;
    for (const name of ["streetAddress", "q", "zip", "routeId", "franchiseId", "customerId", "pickupAddressId", "ids", "enabled", "hasContainers", "upperId", "order", "fields", "includeTotal", "cursor", "offset", "limit"]) {
      expect(operation.parameters.filter(parameter => parameter.name === name && parameter.in === "query"), name).toHaveLength(1);
    }
    const q = operation.parameters.find(parameter => parameter.name === "q")!;
    expect(`${q.description ?? ""} ${q.schema.description ?? ""}`).toMatch(/substring/i);
    expect(operation.description).toContain("streetAddress");
    expect(operation.description).toMatch(/\bAND\b|intersect/i);
    const recovery = operation.responses["400"].description;
    expect(recovery).toContain("streetAddress");
    expect(recovery).toMatch(/blank|empty/i);
    expect(recovery).toMatch(/repeat|duplicate/i);
    expect(recovery).toMatch(/200.*Unicode code points/i);
    expect(recovery).toMatch(/before.*D1/i);
    expect(recovery).toMatch(/URL.encode/i);
    expect(recovery).toMatch(/omit.*streetAddress/i);
    expect(recovery).toContain("application/problem+json");
    expect(recovery).toContain("docs/PROBLEMS.md#bad-request");
  });

  it("keeps the canonical machine-consumed query inventory aligned with the mounted operation", async () => {
    const operation = (await document()).paths[PATH].get!;
    const row = policyDoc.split("\n").find(line => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    const inventory = [...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map(match => match[1]).sort();
    expect(inventory).toContain("streetAddress");
    expect(inventory).toEqual(operation.parameters.filter(parameter => parameter.in === "query").map(parameter => parameter.name).sort());
  });
});
