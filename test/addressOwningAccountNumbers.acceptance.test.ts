/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import policy from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import quickstart from "../docs/CONSUMER-QUICKSTART.md?raw";
import changelog from "../CHANGELOG.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

// Test-Author-owned, intentionally RED before the paired build. Builder must
// preserve this oracle; corrections require a separate Test Author handoff.
// Breaks caught: ignored/normalized numbers, inferred hierarchy, OR/cross-row
// matches, fanout, eager customer joins, lost predicates/links, early 304s,
// permissive validation and accidental external I/O. Expectations are literal.
// Only synthetic local D1; no implementation diff or unmerged selector required.
const E = env as unknown as Env;
const PATH = "/api/v1/address-snapshot";
const ORIGIN = "https://owning-account.test.invalid";
const KEYS = ["owningCustomerNumber", "owningSubCustomerNumber"] as const;
const STAMP = "2026-10-01T00:00:00.000Z";
const AUDIT = "2026-01-15";
const SPECIAL = "00'_% &+#?/=";
const SUB_SPECIAL = "S'_% &+#?/=";
const MAX = "😀".repeat(100);
const MIXED = "x".repeat(50) + "😀".repeat(50);
// id, customer_number, sub_customer_number, enabled. 1/2 deliberately share
// BOTH numbers; 3/4 match just one side; 6/21/24 pin stored NULL independently.
const CUSTOMERS: Array<[number, string | null, string | null, number]> = [
  [1, "00042", "North", 1], [2, "00042", "North", 0],
  [3, "00042", "South", 1], [4, "42", "North", 1],
  [5, "00042", "north", 1], [6, null, "North", 1],
  [7, "Case", "A", 1], [8, "case", "a", 1],
  [9, " 00042 ", " North ", 1], [10, "顧客😀", "枝😀", 1],
  [11, SPECIAL, SUB_SPECIAL, 1], [12, SPECIAL, SUB_SPECIAL, 1],
  [13, "AC%_42", "SU%_42", 1], [14, "ACxy42", "SUxy42", 1],
  [15, "x' OR 1=1 --", "y' OR 1=1 --", 1], [16, MAX, MAX, 1],
  [17, MIXED, MIXED, 1], [18, " \tX \n", " \tY \n", 1],
  [19, "0", "0", 1], [20, "000420", "North-extra", 1],
  [21, "0004", null, 1], [22, "é", "é", 1], [23, "é", "é", 1],
  [24, null, null, 1],
];
// site id, customer id, enabled, route, franchise, address, city, state, zip,
// note, extras_allowed, last_audit_date. Other parents get one unrelated site.
type Site = [number, number, number, number, string, string, string, string, string, string | null, number, string | null];
const SITES: Site[] = [
  [11, 1, 1, 7, "001", "11 needle Way", "Riverton", "ST", "02139", "Gate amber", 1, AUDIT],
  [12, 1, 0, 7, "001", "12 Synthetic Way", "Riverton", "ST", "02139", null, 0, null],
  [13, 1, 1, 8, "001", "13 Other Way", "Othertown", "OT", "99999", "unrelated", 1, AUDIT],
  [21, 2, 1, 7, "002", "21 needle Way", "Riverton", "ST", "02139", "Gate amber", 0, AUDIT],
  [22, 2, 0, 7, "001", "22 Synthetic Way", "Riverton", "ST", "02139", null, 1, null],
  ...CUSTOMERS.filter(([id]) => id >= 3).map(([id]): Site =>
    [id * 10 + 1, id, 1, 9, "003", `${id} Other Way`, "Elsewhere", "ET", "99998", null, 0, null]),
];
const ALL = [11, 12, 13, 21, 22, 31, 41, 51, 61, 71, 81, 91, 101, 111, 121, 131, 141, 151, 161, 171, 181, 191, 201, 211, 221, 231, 241];
const BOTH = { owningCustomerNumber: "00042", owningSubCustomerNumber: "North" };
const BOTH_IDS = [11, 12, 13, 21, 22];
type Query = Record<string, string | number>;
type Read = { sql: string; binds: unknown[]; method: string };
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
const ids = (body: Body) => body.rows.map(row => row.pickup_address_id);
const isCount = (read: Read) => /\bCOUNT\s*\(/i.test(read.sql);

function recordDb(real: D1Database) {
  const reads: Read[] = [];
  const prepared: string[] = [];
  const deny = vi.fn(() => { throw new Error("List attempted D1 write/batch/exec"); });
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    function observe(method: string) {
      if (!/^\s*SELECT\b/i.test(sql)) throw new Error("Non-SELECT through list read method");
      reads.push({ sql, binds, method });
    }
    return {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql, values),
      first: (...args: unknown[]) => { observe("first"); return (stmt.first as (...a: unknown[]) => unknown)(...args); },
      all: () => { observe("all"); return stmt.all(); },
      raw: (...args: unknown[]) => { observe("raw"); return (stmt.raw as (...a: unknown[]) => unknown)(...args); },
      run: deny,
    } as unknown as D1PreparedStatement;
  }
  const db = {
    prepare(sql: string) { prepared.push(sql); return wrap(real.prepare(sql), sql, []); },
    batch: deny, exec: deny,
  } as unknown as D1Database;
  return { db, reads, prepared, deny };
}
function forbiddenDb() {
  const fail = vi.fn(() => { throw new Error("Rejected request touched D1"); });
  return { db: { prepare: fail, batch: fail, exec: fail, withSession: fail } as unknown as D1Database, fail };
}
async function call(query: Query | string | URL = {}, options: {
  token?: string | null; headers?: Record<string, string>; db?: D1Database; path?: string;
} = {}) {
  const url = query instanceof URL ? query : new URL(options.path ?? PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = typeof query === "string" ? query : new URLSearchParams(
    Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  const recorder = recordDb(E.CUSTOMER_DB);
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Owning-number-oracle", ...options.headers });
  const token = options.token === undefined ? "test-read-token" : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const deny = vi.fn(() => { throw new Error("Local list accessed external storage/browser"); });
  const response = await app.fetch(new Request(url, { headers }), {
    ...E, CUSTOMER_DB: options.db ?? recorder.db,
    SNAPSHOTS: new Proxy({} as R2Bucket, { get: deny }),
    BROWSER: new Proxy({} as Fetcher, { get: deny }),
  });
  expect(deny).not.toHaveBeenCalled();
  return { response, recorder, url };
}
async function page(query: Query | URL = {}, headers?: Record<string, string>) {
  const result = await call(query, { headers });
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  const bytes = await result.response.text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const countOnly = result.url.searchParams.get("countOnly") === "true";
  const counted = result.url.searchParams.get("includeTotal") !== "false";
  expect(result.recorder.reads.filter(isCount)).toHaveLength(counted ? 1 : 0);
  expect(result.recorder.reads).toHaveLength(countOnly ? 1 : counted ? 2 : 1);
  expect(result.recorder.deny).not.toHaveBeenCalled();
  if (countOnly) {
    expect(body.rows).toEqual([]); expect(body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  }
  if (!counted) expect(body.total).toBeNull();
  expect(new Set(ids(body)).size).toBe(body.rows.length);
  return { ...result, body, bytes };
}
async function hash(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}"`;
}
function next(result: { response: Response; url: URL }, retained: Query) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/address-snapshot\?[^<>\s]*>; rel="next"$/);
  const raw = /^<([^>]+)>; rel="next"$/.exec(link!)![1];
  expect(raw.startsWith("//")).toBe(false);
  const target = new URL(raw, result.url);
  expect(target.origin).toBe(ORIGIN); expect(target.pathname).toBe(PATH); expect(target.hash).toBe("");
  expect(target.searchParams.has("offset")).toBe(false);
  expect(target.searchParams.has("bogus_param")).toBe(false);
  for (const [key, value] of Object.entries(retained)) {
    if (key === "offset" || key === "bogus_param" || (key === "includeTotal" && value === "true") || (key === "order" && value === "asc")) continue;
    expect(target.searchParams.getAll(key), key).toEqual([String(value)]);
  }
  return target;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound account lookup"); }));
  const db = E.CUSTOMER_DB;
  await db.batch([db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot")]);
  await db.batch(CUSTOMERS.map(([id, customer, sub, enabled]) => db.prepare(
    "INSERT INTO customer_snapshot (customer_id, customer_number, sub_customer_number, company_name, enabled, synced_at) VALUES (?, ?, ?, 'Synthetic shared company', ?, ?)"
  ).bind(id, customer, sub, enabled, STAMP)));
  await db.batch([...SITES].reverse().map(row => db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, route_id, franchise_id, address, city, state, zip, driver_note, extras_allowed, last_audit_date, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(...row, STAMP)));
  await db.batch([11, 13, 21].map((site, i) => db.prepare(
    "INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, synced_at) VALUES (?, ?, ?, ?)"
  ).bind(i + 1, site, site === 13 ? 0 : 1, STAMP)));
});
afterEach(() => {
  try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe("owning numbers: literal stored references on the same customer", () => {
  it("proves the duplicate/same-row/NULL fixture expectations with independent real SQL", async () => {
    const select = async (customer: string, sub: string) => (await E.CUSTOMER_DB.prepare(
      "SELECT address_snapshot.pickup_address_id FROM address_snapshot JOIN customer_snapshot ON customer_snapshot.customer_id = address_snapshot.customer_id WHERE customer_snapshot.customer_number = ? AND customer_snapshot.sub_customer_number = ? ORDER BY address_snapshot.pickup_address_id"
    ).bind(customer, sub).all<{ pickup_address_id: number }>()).results.map(row => row.pickup_address_id);
    expect(await select("00042", "North")).toEqual(BOTH_IDS);
    expect(await select("00042", "A")).toEqual([]);
    expect(await select("0004", "North")).toEqual([]);
    expect(await select(SPECIAL, SUB_SPECIAL)).toEqual([111, 121]);
    expect(await select(MAX, MAX)).toEqual([161]);
    expect(await select(MIXED, MIXED)).toEqual([171]);
    const nulls = await E.CUSTOMER_DB.prepare("SELECT customer_id FROM customer_snapshot WHERE customer_number IS NULL OR sub_customer_number IS NULL ORDER BY customer_id").all<{ customer_id: number }>();
    expect(nulls.results.map(row => row.customer_id)).toEqual([6, 21, 24]);
  });
  it.each<{ query: Query; want: number[] }>([
    { query: { owningCustomerNumber: "00042" }, want: [11, 12, 13, 21, 22, 31, 51] },
    { query: { owningSubCustomerNumber: "North" }, want: [11, 12, 13, 21, 22, 41, 61] },
    { query: BOTH, want: BOTH_IDS },
    { query: { owningCustomerNumber: "00042", owningSubCustomerNumber: "north" }, want: [51] },
    { query: { owningCustomerNumber: "42" }, want: [41] },
    { query: { owningCustomerNumber: "0004" }, want: [211] },
    { query: { owningCustomerNumber: "Case" }, want: [71] },
    { query: { owningCustomerNumber: "case" }, want: [81] },
    { query: { owningSubCustomerNumber: "A" }, want: [71] },
    { query: { owningSubCustomerNumber: "a" }, want: [81] },
    { query: { owningCustomerNumber: " 00042 ", owningSubCustomerNumber: " North " }, want: [91] },
    { query: { owningCustomerNumber: " \tX \n", owningSubCustomerNumber: " \tY \n" }, want: [181] },
    { query: { owningCustomerNumber: "0", owningSubCustomerNumber: "0" }, want: [191] },
    { query: { owningCustomerNumber: "顧客😀", owningSubCustomerNumber: "枝😀" }, want: [101] },
    { query: { owningCustomerNumber: MAX, owningSubCustomerNumber: MAX }, want: [161] },
    { query: { owningCustomerNumber: MIXED, owningSubCustomerNumber: MIXED }, want: [171] },
    { query: { owningCustomerNumber: "é", owningSubCustomerNumber: "é" }, want: [221] },
    { query: { owningCustomerNumber: "é", owningSubCustomerNumber: "é" }, want: [231] },
    { query: { owningCustomerNumber: "AC%_42" }, want: [131] },
    { query: { owningSubCustomerNumber: "SU%_42" }, want: [131] },
    { query: { owningCustomerNumber: "x' OR 1=1 --", owningSubCustomerNumber: "y' OR 1=1 --" }, want: [151] },
    { query: { owningCustomerNumber: SPECIAL, owningSubCustomerNumber: SUB_SPECIAL }, want: [111, 121] },
    { query: { owningCustomerNumber: "unknown-synthetic" }, want: [] },
    { query: { owningSubCustomerNumber: "unknown-synthetic" }, want: [] },
    { query: { owningCustomerNumber: "null" }, want: [] },
    { query: { owningSubCustomerNumber: "null" }, want: [] },
    // Both exist elsewhere, but never together. No hierarchy inference.
    { query: { owningCustomerNumber: "00042", owningSubCustomerNumber: "A" }, want: [] },
    { query: { owningCustomerNumber: "0004", owningSubCustomerNumber: "North" }, want: [] },
  ])("returns all and only exact sites: $query", async ({ query, want }) => {
    const result = await page(query);
    expect(ids(result.body)).toEqual(want); expect(result.body.total).toBe(want.length);
    expect(result.body.nextCursor).toBeNull();
    // A parent scope selects sites, not hydrated parent fields or changed rows.
    for (const row of result.body.rows) {
      const stored = await E.CUSTOMER_DB.prepare("SELECT * FROM address_snapshot WHERE pickup_address_id = ?").bind(row.pickup_address_id).first();
      expect(row).toEqual(stored);
    }
  });
  it.each<Query>([
    { owningCustomerNumber: SPECIAL, owningSubCustomerNumber: SUB_SPECIAL },
    { owningCustomerNumber: SPECIAL }, { owningSubCustomerNumber: SUB_SPECIAL },
    { owningCustomerNumber: SPECIAL, owningSubCustomerNumber: SUB_SPECIAL, parentCustomerEnabled: "true" },
  ])("qualifies one customer join, binds values, and shares COUNT/page predicates: %j", async scope => {
    const { recorder } = await page(scope);
    for (const read of recorder.reads) {
      expect(read.sql.match(/\bJOIN\s+customer_snapshot\b/gi) ?? [], "one conditional owning-customer join").toHaveLength(1);
      expect(read.sql).toMatch(/\baddress_snapshot\.customer_id\b/);
      expect(read.sql).toMatch(/\bcustomer_snapshot\.customer_id\b/);
      if (scope.owningCustomerNumber !== undefined) expect(read.sql).toMatch(/\bcustomer_snapshot\.customer_number\s*=\s*\?/);
      if (scope.owningSubCustomerNumber !== undefined) expect(read.sql).toMatch(/\bcustomer_snapshot\.sub_customer_number\s*=\s*\?/);
      expect(read.sql).not.toContain(SPECIAL); expect(read.sql).not.toContain(SUB_SPECIAL);
      const values = KEYS.filter(key => scope[key] !== undefined).map(key => scope[key]);
      expect(read.binds).toEqual(expect.arrayContaining(values));
      expect(read.sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP)\b|COLLATE\s+NOCASE/i);
    }
    const [count, rows] = recorder.reads;
    const where = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).split(/\bORDER\s+BY\b/i)[0].trim();
    expect(where(rows.sql)).toBe(where(count.sql));
    expect(rows.binds.slice(0, count.binds.length)).toEqual(count.binds);
    for (const { sql, binds } of recorder.reads) {
      const plan = await E.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all();
      expect(plan.success).toBe(true); expect(plan.results.length).toBeGreaterThan(0);
    }
  });
  it("omission preserves the old no-customer-join list and SQL", async () => {
    const bare = await page();
    expect(ids(bare.body)).toEqual(ALL); expect(bare.body.total).toBe(27);
    const unknown = await page({ bogus_param: "ignored" });
    expect(unknown.body).toEqual(bare.body); expect(unknown.recorder.reads).toEqual(bare.recorder.reads);
    for (const read of bare.recorder.reads) expect(read.sql).not.toContain("customer_snapshot");
    for (const query of [{ customerId: "1" }, { parentCustomerEnabled: "any" }] as Query[]) {
      const result = await page(query);
      for (const read of result.recorder.reads) expect(read.sql).not.toContain("customer_snapshot");
    }
  });
});

describe.each(["true", "false"])("owning-number intersections includeTotal=%s", includeTotal => {
  it.each<[Query, number[]]>([
    [{ customerId: "1" }, [11, 12, 13]], [{ customerId: "3" }, []],
    [{ pickupAddressId: "11" }, [11]], [{ pickupAddressId: "31" }, []],
    [{ ids: "31,22,11,41" }, [11, 22]], [{ ids: "31,41,51" }, []],
    [{ routeId: "7" }, [11, 12, 21, 22]], [{ routeId: "8" }, [13]],
    [{ franchiseId: "001" }, [11, 12, 13, 22]], [{ franchiseId: "002" }, [21]],
    [{ zip: "02139" }, [11, 12, 21, 22]], [{ streetAddress: "11 needle Way" }, [11]],
    [{ city: "Riverton" }, [11, 12, 21, 22]], [{ state: "OT" }, [13]],
    [{ driverNote: "amber" }, [11, 21]], [{ q: "needle" }, [11, 21]],
    [{ q: "00042" }, []], [{ enabled: "true" }, [11, 13, 21]],
    [{ enabled: "false" }, [12, 22]], [{ extrasAllowed: "true" }, [11, 13, 22]],
    [{ extrasAllowed: "false" }, [12, 21]], [{ hasContainers: "true" }, [11, 13, 21]],
    [{ hasContainers: "false" }, [12, 22]], [{ lastAuditDate: AUDIT }, [11, 13, 21]],
    [{ hasLastAuditDate: "false" }, [12, 22]], [{ hasLastAuditDate: "true" }, [11, 13, 21]],
    [{ lastAuditDate: AUDIT, hasLastAuditDate: "false" }, []],
    [{ parentCustomerEnabled: "true" }, [11, 12, 13]], [{ parentCustomerEnabled: "false" }, [21, 22]],
    [{ parentCustomerEnabled: "any" }, BOTH_IDS],
    [{ lowerId: "12", upperId: "21" }, [12, 13, 21]], [{ cursor: "12" }, [13, 21, 22]],
    [{ order: "desc", cursor: "21" }, [13, 12, 11]],
    [{ customerId: "1", pickupAddressId: "11", ids: "11,12,31", routeId: "7", franchiseId: "001",
      zip: "02139", streetAddress: "11 needle Way", city: "Riverton", state: "ST", driverNote: "amber", q: "needle",
      enabled: "true", extrasAllowed: "true", hasContainers: "true", lastAuditDate: AUDIT,
      hasLastAuditDate: "true", parentCustomerEnabled: "true", strictQuery: "true" }, [11]],
  ])("intersects merged controls %j", async (scope, want) => {
    const result = await page({ ...BOTH, ...scope, includeTotal });
    expect(ids(result.body)).toEqual(want); expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
  });
});

describe("owning numbers: count modes, sparse conditional reads and safety", () => {
  it.each<[Query, number]>([[BOTH, 5], [{ owningCustomerNumber: "00042" }, 7], [{ owningSubCustomerNumber: "North" }, 7],
    [{ ...BOTH, parentCustomerEnabled: "false" }, 2], [{ ...BOTH, customerId: "3" }, 0],
    [{ ...BOTH, cursor: "12" }, 3], [{ ...BOTH, order: "desc", cursor: "21" }, 3],
    [{ ...BOTH, lowerId: "12", upperId: "21" }, 3], [{ ...BOTH, parentCustomerEnabled: "true", cursor: "12" }, 1]])(
    "countOnly applies the same scope and ignores offset/limit: %j", async (scope, total) => {
      const result = await page({ ...scope, countOnly: "true", limit: "1", offset: "999", strictQuery: "true" });
      expect(result.body).toEqual({ rows: [], total, nextCursor: null });
    });
  it("count-free is exactly the counted row query without COUNT", async () => {
    const counted = await page({ ...BOTH, fields: "enabled", limit: "2" });
    const free = await page({ ...BOTH, fields: "enabled", limit: "2", includeTotal: "false" });
    expect(free.body).toEqual({ ...counted.body, total: null });
    expect(free.recorder.reads).toEqual(counted.recorder.reads.filter(read => !isCount(read)));
    expect(counted.body.rows).toEqual([{ pickup_address_id: 11, enabled: 1 }, { pickup_address_id: 12, enabled: 0 }]);
  });
  it.each(["true", "false"])("hashes served sparse bytes and retains Link on weak/exact/wildcard 304 (%s)", async includeTotal => {
    const query = { ...BOTH, fields: "address", limit: "2", includeTotal };
    const first = await page(query); const tag = await hash(first.bytes);
    expect(first.response.headers.get("etag")).toBe(tag);
    for (const validator of [tag, `W/${tag}`, "*"]) {
      const result = await call(query, { headers: { "if-none-match": validator } });
      expect(result.response.status).toBe(304); expect(await result.response.text()).toBe("");
      expect(result.response.headers.get("etag")).toBe(tag);
      expect(result.response.headers.get("link")).toBe(first.response.headers.get("link"));
      expect(result.response.headers.get("cache-control")).toBe("no-store");
      expect(result.recorder.reads).toEqual(first.recorder.reads);
    }
    const changed = await page({ ...query, owningCustomerNumber: "42" }, { "if-none-match": tag });
    expect(ids(changed.body)).toEqual([41]); expect(changed.response.headers.get("etag")).not.toBe(tag);
  });
  it("re-evaluates unprojected owning numbers before conditional success", async () => {
    const query = { ...BOTH, customerId: "1", fields: "enabled" };
    const first = await page(query); expect(ids(first.body)).toEqual([11, 12, 13]);
    await E.CUSTOMER_DB.prepare("UPDATE customer_snapshot SET customer_number = 'changed' WHERE customer_id = 1").run();
    const changed = await page(query, { "if-none-match": first.response.headers.get("etag")! });
    expect(changed.body).toEqual({ rows: [], total: 0, nextCursor: null });
    expect(changed.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
  });
  it("preserves state and idempotent bytes across repeated reads", async () => {
    const snapshot = async () => Promise.all(["customer_snapshot", "address_snapshot", "container_snapshot"].map(table =>
      E.CUSTOMER_DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
    const before = (await snapshot()).map(result => result.results);
    const first = await page(BOTH); const again = await page(BOTH);
    expect(again.bytes).toBe(first.bytes); expect(again.recorder.reads).toEqual(first.recorder.reads);
    expect((await snapshot()).map(result => result.results)).toEqual(before);
  });
});

describe.each(["asc", "desc"])("owning-number Link traversal %s", order => {
  it.each(KEYS)("retains %s alone without inventing its companion", async key => {
    const other = key === KEYS[0] ? KEYS[1] : KEYS[0];
    const scope = { [key]: key === KEYS[0] ? "00042" : "North", limit: "3", order, exactNext: "true", strictQuery: "true" };
    const expected = key === KEYS[0] ? [11, 12, 13, 21, 22, 31, 51] : [11, 12, 13, 21, 22, 41, 61];
    const want = order === "asc" ? expected : [...expected].reverse();
    let result = await page(scope); const seen: unknown[] = [];
    for (let offset = 0; offset < want.length; offset += 3) {
      const chunk = want.slice(offset, offset + 3);
      expect(ids(result.body)).toEqual(chunk); seen.push(...ids(result.body));
      if (offset + 3 < want.length) {
        const target = next(result, { ...scope, cursor: chunk[chunk.length - 1] });
        expect(target.searchParams.has(other)).toBe(false); result = await page(target);
      } else { expect(result.body.nextCursor).toBeNull(); expect(result.response.headers.get("link")).toBeNull(); }
    }
    expect(seen).toEqual(want);
  });
  it.each(["true", "false"])("fully follows partial-terminal pages in count mode %s", async includeTotal => {
    const filters = { ...BOTH, limit: "2", order, includeTotal, strictQuery: "true", fields: "enabled", lowerId: "11", upperId: "22" };
    const pages = order === "asc" ? [[11, 12], [13, 21], [22]] : [[22, 21], [13, 12], [11]];
    let result = await page(filters); const seen: unknown[] = [];
    for (let i = 0; i < pages.length; i++) {
      expect(ids(result.body)).toEqual(pages[i]); seen.push(...ids(result.body));
      expect(result.body.total).toBe(includeTotal === "false" ? null : [5, 3, 1][i]);
      if (i === 2) { expect(result.body.nextCursor).toBeNull(); expect(result.response.headers.get("link")).toBeNull(); }
      else {
        const cursor = pages[i][1]; expect(result.body.nextCursor).toBe(cursor);
        result = await page(next(result, { ...filters, cursor }));
      }
    }
    expect(seen).toEqual(order === "asc" ? BOTH_IDS : [22, 21, 13, 12, 11]);
  });
  it.each(["true", "false"])("offset-to-seek retains encoded literal references and all effective controls (%s)", async includeTotal => {
    const filters = { owningCustomerNumber: SPECIAL, owningSubCustomerNumber: SUB_SPECIAL, limit: "1", offset: "1",
      fields: "address", ids: "111,121", strictQuery: "true", exactNext: "true", order, includeTotal };
    const terminal = await page(filters);
    expect(ids(terminal.body)).toEqual(order === "asc" ? [121] : [111]);
    expect(terminal.body.nextCursor).toBeNull(); expect(terminal.response.headers.get("link")).toBeNull();
    let result = await page({ ...filters, offset: "0" });
    expect(ids(result.body)).toEqual(order === "asc" ? [111] : [121]);
    const target = next(result, { ...filters, cursor: order === "asc" ? 111 : 121 });
    result = await page(target);
    expect(result.body.rows).toEqual(terminal.body.rows);
    expect(result.body.nextCursor).toBeNull(); expect(result.response.headers.get("link")).toBeNull();
    // Nonzero offset with more data converts to seek and follows to the end.
    const scope = { ...BOTH, offset: "1", limit: "2", order, includeTotal, exactNext: "true", strictQuery: "true" };
    let middle = await page(scope);
    expect(ids(middle.body)).toEqual(order === "asc" ? [12, 13] : [21, 13]);
    middle = await page(next(middle, { ...scope, cursor: 13 }));
    expect(ids(middle.body)).toEqual(order === "asc" ? [21, 22] : [12, 11]);
    expect(middle.body.nextCursor).toBeNull(); expect(middle.response.headers.get("link")).toBeNull();
  });
  it("legacy full-final pages retain a cursor until the reachable empty page", async () => {
    const scope = { owningCustomerNumber: SPECIAL, owningSubCustomerNumber: SUB_SPECIAL, limit: "1", order };
    let result = await page(scope);
    for (const id of order === "asc" ? [111, 121] : [121, 111]) {
      expect(ids(result.body)).toEqual([id]); expect(result.body.nextCursor).toBe(id);
      result = await page(next(result, { ...scope, cursor: id }));
    }
    expect(result.body).toEqual({ rows: [], total: 0, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
  });
});

describe.each(KEYS)("%s opaque validation before SQL/304", key => {
  const other = key === KEYS[0] ? KEYS[1] : KEYS[0];
  const invalid = ["", "   ", "\t\n\r", "  ", "sensitive-marker-".padEnd(101, "x"), "😀".repeat(101), "x" + " ".repeat(100)];
  it.each(invalid)("rejects invalid raw reference %j without reflecting values or logging", async value => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const result = await call({ [key]: value, [other]: "valid-companion" }, { headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("etag")).toBeNull(); expect(result.response.headers.get("link")).toBeNull();
    const body = await result.response.json() as { detail: string };
    expect(body).toMatchObject({ type: problemType("bad-request"), title: "Bad Request", status: 400 });
    expect(body.detail).toContain(key); expect(body.detail).toContain("docs/PROBLEMS.md#bad-request");
    expect(JSON.stringify(body)).not.toContain("sensitive-marker"); expect(JSON.stringify(body)).not.toContain("valid-companion");
    expect(result.recorder.prepared).toEqual([]); expect(result.recorder.reads).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    // Same fixed guidance for all rejected values, not an input-derived reason.
    const empty = await call({ [key]: "" });
    expect(empty.response.status).toBe(400); expect(await empty.response.json()).toEqual(body);
  });
  it.each(["same", "different", "encoded", "blank-first", "bare"])("rejects duplicate/bare name variant %s", async variant => {
    const encoded = key.replace("Customer", "%43ustomer");
    const query = variant === "bare" ? key : variant === "encoded" ? `${key}=sensitive-marker&${encoded}=sensitive-marker`
      : `${key}=${variant === "blank-first" ? "" : "sensitive-marker"}&${key}=${variant === "different" ? "other-marker" : "sensitive-marker"}`;
    const result = await call(query, { headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    const body = await result.response.json() as { detail: string };
    expect(body).toMatchObject({ type: problemType("bad-request"), status: 400 });
    expect(body.detail).toContain(key); expect(body.detail).toContain("docs/PROBLEMS.md#bad-request");
    expect(JSON.stringify(body)).not.toMatch(/sensitive-marker|other-marker/);
    expect(result.recorder.prepared).toEqual([]); expect(result.recorder.reads).toEqual([]);
  });
  it.each([null, "synthetic-invalid-token"])("auth precedes valid/invalid/repeated validation (%s)", async token => {
    for (const query of [`${key}=00042`, `${key}=`, `${key}=sensitive-marker&${key}=other-marker`]) {
      const denied = forbiddenDb(); const { response } = await call(query, { token, db: denied.db, headers: { "if-none-match": "*" } });
      expect(response.status).toBe(401); expect(await response.text()).not.toContain("sensitive-marker"); expect(denied.fail).not.toHaveBeenCalled();
    }
  });
  it("rejects invalid input before a warm exact ETag, not only wildcard", async () => {
    const warm = await page({ limit: "1" });
    const { response, recorder } = await call({ [key]: "", limit: "1" }, { headers: { "if-none-match": await hash(warm.bytes) } });
    expect(response.status).toBe(400); expect(response.headers.get("etag")).toBeNull(); expect(recorder.prepared).toEqual([]);
  });
});

describe("owning-number access, strict policy and mounted discovery", () => {
  it("leaves detail and customer reads unchanged by these list-only names", async () => {
    for (const path of [`${PATH}/31`, "/api/v1/customer-snapshot"]) {
      const plain = await call({}, { path }); const ignored = await call(BOTH, { path });
      expect(plain.response.status).toBe(200); expect(ignored.response.status).toBe(200);
      expect(await ignored.response.json()).toEqual(await plain.response.json());
      expect(ignored.recorder.reads).toEqual(plain.recorder.reads);
    }
  });
  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("permits existing bearer read role %s", async token => {
    const { response } = await call(BOTH, { token }); expect(response.status).toBe(200);
    expect(ids(await response.json() as Body)).toEqual(BOTH_IDS);
    expect(response.headers.get("x-request-id")).toBe("Owning-number-oracle");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
  it("still rejects unknown strict keys and countOnly conflicts before SQL", async () => {
    for (const extra of [{ strictQuery: "true", parentEnabled: "true" }, { countOnly: "true", includeTotal: "false" }, { fields: "customer_number" }] as Query[]) {
      const denied = forbiddenDb(); const { response } = await call({ ...BOTH, ...extra }, { db: denied.db });
      expect(response.status).toBe(400); expect(denied.fail).not.toHaveBeenCalled();
      const body = await response.json() as { detail: string };
      expect(body).toMatchObject({ type: problemType("bad-request"), status: 400 });
      expect(body.detail).toMatch(/docs\/PROBLEMS\.md#bad-request|[Rr]emove|[Ss]et|[Uu]se/);
    }
  });
  it("keeps default ignoring of unrelated keys and strips them from next links", async () => {
    const query = { ...BOTH, limit: "1" }; const plain = await page(query);
    const ignored = await page({ ...query, bogus_param: "ignored" });
    expect(ignored.body).toEqual(plain.body); expect(ignored.recorder.reads).toEqual(plain.recorder.reads);
    expect(ignored.response.headers.get("link")).toBe(plain.response.headers.get("link"));
  });
  it("does not add these names to detail/customer/changes operations (container may have its own sibling contract)", async () => {
    const { response } = await call({}, { path: "/openapi.json" });
    const doc = await response.json() as { paths: Record<string, { get?: { operationId?: string; "x-access"?: string; "x-effect"?: string;
      description?: string; parameters?: Array<{ name: string; in: string; required?: boolean; description?: string; example?: unknown; schema: Record<string, unknown> }>;
      responses?: Record<string, { description: string }> } }> };
    const list = doc.paths[PATH].get!;
    expect(list).toMatchObject({ operationId: "listAddressSnapshot", "x-access": "read", "x-effect": "local-read" });
    for (const key of KEYS) {
      const params = list.parameters!.filter(p => p.in === "query" && p.name === key);
      expect(params).toHaveLength(1); expect(params[0].required).not.toBe(true);
      expect(params[0].schema).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
      const prose = `${params[0].description ?? ""} ${params[0].schema.description ?? ""} ${list.description ?? ""}`;
      expect(prose).toMatch(/exact/i); expect(prose).toMatch(/case-sensitive/i); expect(prose).toMatch(/Unicode code points/i);
      expect(prose).toMatch(/leading zeros/i); expect(prose).toMatch(/mirror|stored/i);
      expect(list.responses?.["400"].description).toContain(key);
      expect(list.responses?.["400"].description).toContain("docs/PROBLEMS.md#bad-request");
      for (const [path, operations] of Object.entries(doc.paths)) {
        for (const [method, operation] of Object.entries(operations)) {
          if (method === "get" && [PATH, "/api/v1/container-snapshot"].includes(path)) continue;
          expect(operation?.parameters?.filter(p => p.in === "query").map(p => p.name) ?? [], `${method} ${path}`).not.toContain(key);
        }
      }
      const example = params[0].example ?? params[0].schema.example;
      expect(typeof example).toBe("string"); expect([...String(example)].length).toBeLessThanOrEqual(100);
      const probe = await page({ [key]: String(example), strictQuery: "true" });
      expect(probe.body.rows).toEqual(expect.any(Array));
    }
  });
  it("inventories the address scope and explains the non-identity contract", () => {
    const addressRow = policy.split("\n").find(line => line.startsWith(`| \`${PATH}\` |`)) ?? "";
    for (const key of KEYS) expect(addressRow).toContain(`\`${key}\``);
    const sections = policy.split(/^#{1,6} /m).filter(section => section.includes("owningCustomerNumber"));
    const guidance = sections.join("\n");
    expect(guidance).toMatch(/repeat|non.unique|not unique/i);
    for (const phrase of [/billing identity/i, /hierarchy/i, /service territory/i, /proof of service/i]) expect(guidance).toMatch(phrase);
    expect(guidance).toMatch(/not|never/i);
    const release = changelog.split(/^## /m)[1] ?? "";
    for (const key of KEYS) expect(release).toContain(key);
  });
  it("provides a local consumer recipe whose selector URL actually executes", async () => {
    await Promise.resolve();
    const urls = [...quickstart.matchAll(/https?:\/\/localhost:8787\/api\/v1\/address-snapshot\?[^\s'"`]+/g)].map(match => new URL(match[0]));
    const recipe = urls.find(url => KEYS.every(key => url.searchParams.has(key)));
    expect(recipe, "local address recipe with both owning numbers").toBeDefined();
    const target = new URL(PATH, ORIGIN); target.search = recipe!.search;
    const result = await page(target);
    if (result.body.nextCursor !== null) await page(next(result, Object.fromEntries(target.searchParams)));
  });
});

// Prove dangling-parent behavior with an actual local legacy table, not an
// impossible FK-violating seed. Preserve original schema/index/trigger SQL and
// restore it in finally; this fixture alone temporarily removes the address FK.
describe("owning numbers: missing mirrored customer", () => {
  it("omission retains a dangling site while either explicit reference excludes it", async () => {
    const db = E.CUSTOMER_DB;
    const schema = await db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND (type = 'trigger' OR tbl_name IN ('address_snapshot', 'container_snapshot'))").all<{ type: string; name: string; sql: string }>();
    const triggers = schema.results.filter(row => row.type === "trigger");
    const address = schema.results.find(row => row.type === "table" && row.name === "address_snapshot")!;
    const container = schema.results.find(row => row.type === "table" && row.name === "container_snapshot")!;
    const dropTriggers = () => triggers.map(row => db.prepare(`DROP TRIGGER "${row.name.replace(/"/g, '""')}"`));
    const restoreTriggers = () => triggers.map(row => db.prepare(row.sql));
    // Copy tables before dropping them. Re-create addresses with the original PK
    // and all original columns, removing only the FK clause in fixture DDL.
    const legacySql = address.sql.replace(/,\s*FOREIGN KEY\s*\(customer_id\)\s*REFERENCES\s*customer_snapshot\s*\(customer_id\)/i, "");
    expect(legacySql).not.toBe(address.sql);
    await db.batch([
      ...dropTriggers(), db.prepare("CREATE TABLE saved_address_rows AS SELECT * FROM address_snapshot"),
      db.prepare("CREATE TABLE saved_container_rows AS SELECT * FROM container_snapshot"),
      db.prepare("DROP TABLE container_snapshot"), db.prepare("DROP TABLE address_snapshot"),
      db.prepare(legacySql), db.prepare("INSERT INTO address_snapshot SELECT * FROM saved_address_rows"),
      db.prepare(container.sql), db.prepare("INSERT INTO container_snapshot SELECT * FROM saved_container_rows"), ...restoreTriggers(),
      db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (999, 999, 1, ?)").bind(STAMP),
    ]);
    try {
      const plain = await page(); expect(ids(plain.body)).toEqual([...ALL, 999]);
      for (const read of plain.recorder.reads) expect(read.sql).not.toContain("customer_snapshot");
      for (const scope of [BOTH, { owningCustomerNumber: "00042" }, { owningSubCustomerNumber: "North" }] as Query[]) {
        expect(ids((await page(scope)).body)).not.toContain(999);
        expect((await page({ ...scope, pickupAddressId: "999" })).body).toEqual({ rows: [], total: 0, nextCursor: null });
      }
    } finally {
      await db.batch([
        ...dropTriggers(), db.prepare("DROP TABLE container_snapshot"), db.prepare("DROP TABLE address_snapshot"),
        db.prepare(address.sql), db.prepare("INSERT INTO address_snapshot SELECT * FROM saved_address_rows"),
        db.prepare(container.sql), db.prepare("INSERT INTO container_snapshot SELECT * FROM saved_container_rows"),
        ...schema.results.filter(row => row.type === "index").map(row => db.prepare(row.sql)), ...restoreTriggers(),
        db.prepare("DROP TABLE saved_container_rows"), db.prepare("DROP TABLE saved_address_rows"),
      ]);
    }
  });
});
