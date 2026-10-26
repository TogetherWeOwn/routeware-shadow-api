/// <reference types="vite/client" />

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import packageJson from "../package.json";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent outcome oracle, derived from the specification, not build diffs.
 * Run: npx vitest run --maxWorkers=2 test/customerAddressLocality.acceptance.test.ts
 *
 * Mutation targets: locality on a second uncorrelated EXISTS (split-site
 * leakage); locality ignored when supplied alone; JOIN-expanded or duplicated
 * accounts; trimmed/case-folded/abbreviation-converted locality text; conflated
 * account/site enabled; divergent COUNT/page binds; payload work in countOnly,
 * COUNT in count-free, lost selectors in continuation; stale validators;
 * validation after auth/SQL/304; submitted-value reflection.
 *
 * Real migrated local D1 executes product reads. Only fixture setup writes.
 * Network, R2, browser, D1 writes and hidden batch work are denied. All data
 * is synthetic. EXPLAIN is local planner evidence, not a latency guarantee.
 * Builder consumes this immutable handoff; oracle corrections stay test-owned.
 * This suite intentionally remains RED until the paired implementation lands.
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/customer-snapshot";
const ORIGIN = "https://customer-locality.test.invalid";
const STAMP = "2026-01-02T03:04:05.000Z";
const OPAQUE = " 雪'\"%_ /+?&#🚛 ";
const OPAQUE_STATE = " Ω'\"%_ /+?&#🌿 ";
const HUNDRED = "🚛".repeat(100);
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
const LOCALITY = { addressCity: "Riverton", addressState: "TX", addressZip: "02139" };
const SCOPES = ["addressCity", "addressState", "addressZip"] as const;
type Query = Record<string, string>;
type Body = { rows: Record<string, unknown>[]; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[]; method: string };
// [pickup_address_id, customer_id, route_id, franchise_id, enabled, city, state, zip]
// 11 has two canonical sites; 12 splits city on one site from state/zip on
// another; 29 matches the canonical locality in both site-enabled states.
const SITES = [
  [101, 11, 7, "001", 1, "Riverton", "TX", "02139"], [102, 11, 7, "001", 1, "Riverton", "TX", "02139"],
  [103, 12, 7, "001", 1, "Riverton", "CA", "99999"], [104, 12, 8, "other", 1, "Other", "TX", "02139"],
  [105, 13, 7, "001", 1, "Riverton", "TX", "02139"], [106, 14, 7, "001", 0, "Riverton", "TX", "02139"],
  [107, 15, 7, "001", 0, "Riverton", "TX", "02139"], [108, 16, null, null, 1, null, null, null],
  [109, 18, 7, "001", 1, "riverton", "TX", "02139"], [110, 19, 7, "001", 1, " Riverton ", " TX ", " 02139 "],
  [111, 20, 7, "001", 1, "Riverton", "Texas", "02139"], [112, 21, 7, "001", 1, "Riverton", "TX", "2139"],
  [113, 22, 7, "001", 1, "Riverton", "TX", "02139-1234"], [114, 23, 7, "001", 1, HUNDRED, "b".repeat(100), "0"],
  [115, 24, 7, "001", 1, OPAQUE, OPAQUE_STATE, "00 139"], [116, 25, 7, "001", 1, "x\t\ny", "x\t\ny", "x\t\ny"],
  [117, 27, 7, "001", 0, "Riverton", "CA", "99999"], [118, 28, 7, "001", 1, null, "TX", "02139"],
  [119, 29, 7, "001", 1, "Riverton", "TX", "02139"], [120, 29, 7, "001", 0, "Riverton", "TX", "02139"],
  [121, 30, 8, "other", 1, "Riverton", "TX", "02139"], [122, 31, 7, "001", 1, "", "", ""],
] as const;
const ALL = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
const ids = (body: Body) => body.rows.map(row => row.customer_id);
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
let effects: string[];
let beforeState: unknown;

function recordDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const fetched: number[] = [];
  const forbid = (effect: string): never => { effects.push(effect); throw new Error("Unexpected effect in customer locality GET"); };
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return new Proxy(stmt, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql, values);
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          statements.push({ sql, binds, method: String(key) });
          if (!["first", "all", "raw"].includes(String(key))) return forbid("D1 non-read execution");
          const result = await Reflect.apply(value, target, args);
          if (key === "all") fetched.push((result as D1Result).results.length);
          if (key === "raw") fetched.push((result as unknown[]).length);
          return result;
        };
      }
    });
  }
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      if (!/^\s*SELECT\b/i.test(sql)) return forbid("D1 non-SELECT");
      return wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []);
    },
    batch: () => forbid("D1 batch"), exec: () => forbid("D1 exec"), dump: () => forbid("D1 dump")
  } as unknown as D1Database;
  return { db, prepared, statements, fetched, external: () => forbid("external binding") };
}
async function state() {
  return Promise.all(["customer_snapshot", "address_snapshot", "container_snapshot"].map(table =>
    TEST_ENV.CUSTOMER_DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())).then(rows => rows.map(r => r.results));
}
async function request(query: Query | string | URL = {}, options: {
  token?: string | null; headers?: Record<string, string>;
} = {}) {
  const recorder = recordDb();
  const url = query instanceof URL ? query : new URL(PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = typeof query === "string" ? query : new URLSearchParams(query).toString();
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Locality-oracle", ...options.headers });
  const token = options.token === undefined ? "test-read-token" : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: recorder.db,
    SNAPSHOTS: new Proxy({} as R2Bucket, { get: () => recorder.external }),
    BROWSER: { fetch: recorder.external } as unknown as Fetcher,
  });
  return { response, recorder, url };
}
async function tag(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}"`;
}
function posture(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("x-request-id")).toBe("Locality-oracle");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
async function page(query: Query | string | URL = {}, headers?: Record<string, string>) {
  const result = await request(query, { headers });
  expect(result.response.status).toBe(200);
  posture(result.response);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  const bytes = await result.response.text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  expect(result.response.headers.get("etag")).toBe(await tag(bytes));
  const countOnly = result.url.searchParams.get("countOnly") === "true";
  const counted = result.url.searchParams.get("includeTotal") !== "false";
  expect(result.recorder.statements).toHaveLength(countOnly || !counted ? 1 : 2);
  expect(result.recorder.statements.filter(isCount)).toHaveLength(counted ? 1 : 0);
  if (countOnly) {
    expect(body.rows).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.recorder.fetched).toEqual([]);
  } else {
    const select = result.recorder.statements.find(s => !isCount(s))!;
    const limit = Number(result.url.searchParams.get("limit") ?? 50);
    const exact = result.url.searchParams.get("exactNext") === "true";
    const tail = /\bOFFSET\b/i.test(select.sql) ? 2 : 1;
    expect(select.binds[select.binds.length - tail]).toBe(limit + (exact ? 1 : 0));
    for (const n of result.recorder.fetched) expect(n).toBeLessThanOrEqual(limit + (exact ? 1 : 0));
    if (!counted) expect(body.total).toBeNull();
  }
  expect(result.response.headers.has("link")).toBe(body.nextCursor !== null);
  expect(new Set(ids(body)).size).toBe(body.rows.length);
  for (const row of body.rows) {
    expect(typeof row.customer_id).toBe("number");
    for (const field of ["addresses", "address_count", "pickup_address_id", "route_id", "franchise_id", "city", "state", "zip"]) expect(row).not.toHaveProperty(field);
    expect(Object.values(row).every(v => v === null || typeof v !== "object")).toBe(true);
  }
  return { ...result, body, bytes };
}
function expectPage(result: Awaited<ReturnType<typeof page>>, want: readonly number[], total: number | null, next: number | null = null) {
  expect(ids(result.body)).toEqual(want);
  expect(result.body.total).toBe(total);
  expect(result.body.nextCursor).toBe(next);
}
function next(result: Awaited<ReturnType<typeof page>>, expected: Query) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/customer-snapshot\?[^<>\s]*>; rel="next"$/);
  const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(target.origin).toBe(ORIGIN);
  expect(target.pathname).toBe(PATH);
  expect(target.hash + target.username + target.password).toBe("");
  const actual = new URLSearchParams(target.search);
  for (const [key, value] of [["includeTotal", "true"], ["order", "asc"]]) {
    if (expected[key] === undefined || expected[key] === value) {
      expect([null, value]).toContain(actual.get(key));
      expect(actual.getAll(key).length).toBeLessThanOrEqual(1);
      actual.delete(key);
    }
  }
  const effective = Object.fromEntries(Object.entries(expected).filter(([key, value]) =>
    !(key === "includeTotal" && value === "true") && !(key === "order" && value === "asc")));
  expect([...actual.keys()]).toHaveLength(Object.keys(effective).length);
  expect(Object.fromEntries(actual)).toEqual(effective);
  expect(actual.has("offset")).toBe(false);
  return target;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  effects = [];
  vi.stubGlobal("fetch", vi.fn(async () => { effects.push("network"); throw new Error("Outbound network forbidden"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot")]);
  await db.batch([...ALL].reverse().map(id => db.prepare(
    "INSERT INTO customer_snapshot (customer_id, enabled, company_name, customer_number, sub_customer_number, phone1, phone2, comments, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, [13, 15, 26].includes(id) ? 0 : 1,
    [11, 12, 13, 14, 15, 29, 30].includes(id) ? `Synthetic Needle ${id}` : `Synthetic Other ${id}`,
    [11, 12, 13, 15, 29, 30].includes(id) ? "CUST+& 001" : `OTHER-${id}`,
    [11, 12, 14, 29].includes(id) ? "SITE/one" : null,
    [11, 29].includes(id) ? "+1 202 5550107" : null,
    [12, 14, 29].includes(id) ? "5550107 EXT9" : null,
    [11, 12, 13, 29].includes(id) ? "red marker" : "other comment", STAMP)));
  await db.batch([...SITES].reverse().map(site => db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, enabled, city, state, zip, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(...site, STAMP)));
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(effects).toEqual([]);
    expect(await state(), "GET must not mutate the mirrored rows").toEqual(beforeState);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe("customer site locality: exact same-address membership", () => {
  const cases: Array<[string, Query, number[]]> = [
    ["city alone creates the child scope", { addressCity: "Riverton" }, [11, 12, 13, 14, 15, 20, 21, 22, 27, 29, 30]],
    ["state alone creates the child scope", { addressState: "TX" }, [11, 12, 13, 14, 15, 18, 21, 22, 28, 29, 30]],
    ["zip alone creates the child scope", { addressZip: "02139" }, [11, 12, 13, 14, 15, 18, 20, 28, 29, 30]],
    ["all three on one site, split-site decoy excluded", LOCALITY, [11, 13, 14, 15, 29, 30]],
    ["city and state must share a site", { addressCity: "Riverton", addressState: "TX" }, [11, 13, 14, 15, 21, 22, 29, 30]],
    ["city and zip must share a site", { addressCity: "Riverton", addressZip: "02139" }, [11, 13, 14, 15, 20, 29, 30]],
    ["state and zip share the decoy's second site", { addressState: "TX", addressZip: "02139" }, [11, 12, 13, 14, 15, 18, 28, 29, 30]],
    ["city case is significant", { addressCity: "riverton" }, [18]],
    ["padded city is preserved verbatim", { addressCity: " Riverton " }, [19]],
    ["padded state is preserved verbatim", { addressState: " TX " }, [19]],
    ["padded zip is preserved verbatim", { addressZip: " 02139 " }, [19]],
    ["no state-name abbreviation conversion", { addressState: "Texas" }, [20]],
    ["zip leading zero is significant", { addressZip: "2139" }, [21]],
    ["zip suffix is opaque text", { addressZip: "02139-1234" }, [22]],
    ["100 astral code-point city", { addressCity: HUNDRED }, [23]],
    ["100 ASCII code-point state", { addressState: "b".repeat(100) }, [23]],
    ["single-character zip", { addressZip: "0" }, [23]],
    ["opaque reserved characters and Unicode city", { addressCity: OPAQUE }, [24]],
    ["opaque reserved characters and Unicode state", { addressState: OPAQUE_STATE }, [24]],
    ["internal-space zip", { addressZip: "00 139" }, [24]],
    ["internal tab/newline locality", { addressCity: "x\t\ny", addressState: "x\t\ny", addressZip: "x\t\ny" }, [25]],
    ["wildcards are not patterns", { addressCity: "%_" }, []],
    ["SQL-looking value stays bound", { addressCity: "' OR 1=1 --" }, []],
    ["null is not a string", { addressCity: "null", addressState: "null", addressZip: "null" }, []],
    ["valid unknown locality returns empty", { addressCity: "Unknownville" }, []],
    ["route on one site plus state on another never matches", { addressRouteId: "7", addressState: "TX" }, [11, 13, 14, 15, 18, 21, 22, 28, 29]],
    ["route and city share the decoy's first site", { addressRouteId: "7", addressCity: "Riverton" }, [11, 12, 13, 14, 15, 20, 21, 22, 27, 29]],
    ["route 8 plus city finds only the route-8 canonical site", { addressRouteId: "8", addressCity: "Riverton" }, [30]],
    ["locality narrows the route/franchise cohort on the same site", { ...LOCALITY, addressRouteId: "7", addressFranchiseId: "001" }, [11, 13, 14, 15, 29]],
    ["disabled site matches by default", { addressCity: "Riverton", addressEnabled: "any" }, [11, 12, 13, 14, 15, 20, 21, 22, 27, 29, 30]],
    ["disabled site matches under addressEnabled=false", { ...LOCALITY, addressEnabled: "false" }, [14, 15, 29]],
    ["disabled site excluded under addressEnabled=true", { ...LOCALITY, addressEnabled: "true" }, [11, 13, 29, 30]],
  ];
  it.each(cases)("%s agrees across page, count-free and COUNT-only", async (_name, query, want) => {
    expectPage(await page(query), want, want.length);
    expectPage(await page({ ...query, includeTotal: "false" }), want, null);
    expectPage(await page({ ...query, countOnly: "true" }), [], want.length);
  });

  it("control: omission adds no child predicate, even for accounts without sites", async () => {
    const plain = await page();
    expectPage(plain, ALL, 22);
    for (const s of plain.recorder.statements) expect(s.sql).not.toMatch(/address_snapshot|\bEXISTS\b|\bJOIN\b/i);
  });
  it.each([
    ["true", "true", [11, 29, 30]], ["true", "false", [13]],
    ["false", "true", [14, 29]], ["false", "false", [15]],
    ["any", "any", [11, 13, 14, 15, 29, 30]],
  ] as const)("site addressEnabled=%s and account enabled=%s stay independent under locality", async (addressEnabled, enabled, want) => {
    expectPage(await page({ ...LOCALITY, addressEnabled, enabled }), want, want.length);
  });
  it("locality must match the same site as the enabled state", async () => {
    await TEST_ENV.CUSTOMER_DB.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, enabled, city, state, zip, synced_at) VALUES (123, 13, 8, 'other', 0, 'Elsewhere', 'CA', '99999', ?)").bind(STAMP).run();
    beforeState = await state();
    expectPage(await page({ ...LOCALITY, addressEnabled: "false" }), [14, 15, 29], 3);
  });
  it("all read-capable roles use local idempotent reads without child expansion", async () => {
    const first = await page(LOCALITY);
    expectPage(first, [11, 13, 14, 15, 29, 30], 6);
    expect((await page(LOCALITY)).bytes).toBe(first.bytes);
    for (const token of ["test-read-token", "test-api-token", "test-sync-secret"]) {
      const result = await request(LOCALITY, { token });
      expect(result.response.status).toBe(200);
      expect(await result.response.text()).toBe(first.bytes);
    }
  });
});

describe("customer site locality: AND all merged selectors", () => {
  it.each([
    ["presence true", { hasAddresses: "true" }, [11, 13, 14, 15, 29, 30]],
    ["presence contradiction", { hasAddresses: "false" }, []],
    ["container presence false (none mirrored)", { hasContainers: "false" }, [11, 13, 14, 15, 29, 30]],
    ["container presence true (none mirrored)", { hasContainers: "true" }, []],
    ["primary ID", { customerId: "13" }, [13]],
    ["split-site primary ID", { customerId: "12" }, []],
    ["IDs with split-site decoy", { ids: "11,12,15,17" }, [11, 15]],
    ["company text cannot OR-leak decoy", { q: "needle", ids: "12,13,17,29" }, [13, 29]],
    ["nonmatching company text", { q: "other" }, []],
    ["exact account number", { customerNumber: "CUST+& 001" }, [11, 13, 15, 29, 30]],
    ["exact sub-account", { subCustomerNumber: "SITE/one" }, [11, 14, 29]],
    ["phone OR legs contained within AND", { phone: "5550107" }, [11, 14, 29]],
    ["comments substring", { comments: "red" }, [11, 13, 29]],
    ["inclusive lower bound", { lowerId: "14" }, [14, 15, 29, 30]],
    ["inclusive upper bound", { upperId: "14" }, [11, 13, 14]],
    ["all selectors intersect", { hasAddresses: "true", addressRouteId: "7", addressFranchiseId: "001", enabled: "true", ids: "11,12,13,14,29", customerNumber: "CUST+& 001", subCustomerNumber: "SITE/one", q: "needle", phone: "5550107", comments: "red", upperId: "14", strictQuery: "true" }, [11]],
  ] as Array<[string, Query, number[]]>)("%s", async (_name, filters, want) => {
    const query = { ...LOCALITY, ...filters };
    expectPage(await page(query), want, want.length);
    expectPage(await page({ ...query, includeTotal: "false" }), want, null);
    expectPage(await page({ ...query, countOnly: "true" }), [], want.length);
  });
  it.each([
    { addressCity: "Riverton" }, { addressState: "TX" }, { addressZip: "02139" }, LOCALITY,
  ] as Query[])("hasAddresses=false contradicts every effective locality scope %j", async filters => {
    expectPage(await page({ ...filters, hasAddresses: "false" }), [], 0);
    expectPage(await page({ ...filters, hasAddresses: "false", countOnly: "true" }), [], 0);
  });
});

describe("customer site locality: SQL and representation budgets", () => {
  it("one correlated EXISTS and identical predicates/binds serve COUNT and page without joins or hydration", async () => {
    const query = { ...LOCALITY, addressRouteId: "7", addressFranchiseId: "001", addressEnabled: "false", q: "needle", ids: "11,13,14,15,29,30", upperId: "29", limit: "2" };
    const result = await page(query);
    expectPage(result, [14, 15], 3, 15);
    const count = result.recorder.statements.find(isCount)!;
    const select = result.recorder.statements.find(s => !isCount(s))!;
    const where = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).replace(/\s+ORDER\s+BY[\s\S]*$/i, "").trim();
    expect(where(count.sql)).toBe(where(select.sql));
    expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
    for (const s of [count, select]) {
      expect(s.sql.match(/\bEXISTS\s*\(/gi)).toHaveLength(1);
      expect(s.sql).toMatch(/address_snapshot/);
      expect(s.sql).not.toMatch(/\bJOIN\b/i);
      expect(s.binds).toContain("Riverton");
      expect(s.binds).toContain("TX");
      expect(s.binds).toContain("02139");
      expect(s.binds).toContain(7);
      expect(s.binds).toContain("001");
      expect(s.binds).toContain(0);
    }
    const free = await page({ ...query, includeTotal: "false" });
    expect(free.body.rows).toEqual(result.body.rows);
    expect(free.recorder.statements).toEqual([select]);
    const only = await page({ ...query, countOnly: "true", fields: "enabled", exactNext: "true", offset: "2" });
    expectPage(only, [], 3);
    expect(only.recorder.statements).toEqual([count]);
  });
  it("locality alone still emits exactly one correlated EXISTS", async () => {
    const result = await page({ addressCity: "Riverton" });
    expectPage(result, [11, 12, 13, 14, 15, 20, 21, 22, 27, 29, 30], 11);
    for (const s of result.recorder.statements) {
      expect(s.sql.match(/\bEXISTS\s*\(/gi)).toHaveLength(1);
      expect(s.binds).toContain("Riverton");
      expect(s.sql).not.toMatch(/\bJOIN\b/i);
    }
  });
  it("EXPLAIN uses the existing customer-correlated child index in COUNT and page", async () => {
    const result = await page({ ...LOCALITY, addressEnabled: "false" });
    expectPage(result, [14, 15, 29], 3);
    for (const s of result.recorder.statements) {
      const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).bind(...s.binds).all<{ detail: string }>();
      const details = plan.results.map(r => r.detail).join("\n");
      expect(details).toContain("idx_address_snapshot_customer_id");
      expect(details).toMatch(/SEARCH/i);
    }
  });
  it("sparse rows retain canonical account IDs, never matching child identifiers or locality", async () => {
    const result = await page({ ...LOCALITY, fields: "enabled" });
    expect(result.body.rows).toEqual([
      { customer_id: 11, enabled: 1 }, { customer_id: 13, enabled: 0 }, { customer_id: 14, enabled: 1 },
      { customer_id: 15, enabled: 0 }, { customer_id: 29, enabled: 1 }, { customer_id: 30, enabled: 1 },
    ]);
  });
});

describe("customer site locality: complete continuation traversal", () => {
  it.each(["asc", "desc"])("fully follows %s links with strictQuery, bounds, fieldset and scoped state", async order => {
    const filters = { ...LOCALITY, addressEnabled: "false", enabled: "any", hasAddresses: "true", ids: "11,12,13,14,15,29", upperId: "29", fields: "enabled", strictQuery: "true", includeTotal: "false", order, limit: "1" };
    const want = order === "asc" ? [14, 15, 29] : [29, 15, 14];
    let result = await page(filters);
    const seen: unknown[] = [];
    for (let i = 0; i <= 3; i++) {
      expectPage(result, i < 3 ? [want[i]] : [], null, i < 3 ? want[i] : null);
      seen.push(...ids(result.body));
      if (i < 3) {
        const { enabled: _default, ...effective } = filters;
        result = await page(next(result, { ...effective, cursor: String(want[i]) }));
      }
    }
    expect(seen).toEqual(want);
    expect(new Set(seen).size).toBe(3);
  });
  it.each(["asc", "desc"])("preserves cursor-relative counts and converts %s offset to seek", async order => {
    const filters = { ...LOCALITY, order, fields: "enabled", limit: "2" };
    let result = await page({ ...filters, offset: "1" });
    expectPage(result, order === "asc" ? [13, 14] : [29, 15], 6, order === "asc" ? 14 : 15);
    result = await page(next(result, { ...filters, cursor: String(result.body.nextCursor) }));
    expectPage(result, order === "asc" ? [15, 29] : [14, 13], 3, order === "asc" ? 29 : 13);
    const cursor = String(result.body.nextCursor);
    result = await page(next(result, { ...filters, cursor }));
    expectPage(result, order === "asc" ? [30] : [11], 1, order === "asc" ? 30 : 11);
    result = await page(next(result, { ...filters, cursor: String(result.body.nextCursor) }));
    expectPage(result, [], 0);
    expect(result.recorder.statements.every(s => !/\bOFFSET\b/i.test(s.sql))).toBe(true);
  });
  it.each(["asc", "desc"])("merged exactNext retains the selectors and suppresses the full terminal %s page link", async order => {
    const filters = { ...LOCALITY, addressEnabled: "true", order, includeTotal: "false", exactNext: "true", limit: "1" };
    const want = order === "asc" ? [11, 13, 29, 30] : [30, 29, 13, 11];
    let result = await page(filters);
    const seen: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      expectPage(result, [want[i]], null, i < 3 ? want[i] : null);
      seen.push(...ids(result.body));
      if (i < 3) result = await page(next(result, { ...filters, cursor: String(want[i]) }));
    }
    expect(seen).toEqual(want);
  });
  it.each([
    [{ cursor: "13", offset: "99" }, [14, 15, 29, 30], 4],
    [{ cursor: "15", order: "desc", upperId: "14" }, [14, 13, 11], 3],
    [{ upperId: "13" }, [11, 13], 2],
    [{ lowerId: "30" }, [30], 1],
    [{ upperId: "10" }, [], 0],
  ] as Array<[Query, number[], number]>)("seek/bounds %j apply to locality membership", async (filters, want, total) => {
    expectPage(await page({ ...LOCALITY, ...filters }), want, total);
    expectPage(await page({ ...LOCALITY, ...filters, countOnly: "true" }), [], total);
  });
  it("round-trips opaque locality, never unknown keys, credentials or hostile origins", async () => {
    const filters = { addressCity: OPAQUE, limit: "1", includeTotal: "false" };
    const search = new URLSearchParams(filters).toString();
    const result = await page(`${search}&token=query-marker&unknown=secret-marker&redirect=https%3A%2F%2Fhost-marker.invalid`, { host: "host-marker.invalid", origin: ORIGIN, "x-forwarded-host": "forward-marker.invalid" });
    expectPage(result, [24], null, 24);
    expectPage(await page(next(result, { ...filters, cursor: "24" })), [], null);
    expect(result.response.headers.get("link")).not.toMatch(/marker|Bearer|test-read-token|https?:|\/\//);
  });
});

describe("customer site locality: conditional representations", () => {
  it.each([{}, { includeTotal: "false" }, { countOnly: "true" }, { exactNext: "true" }] as Query[])("revalidates the served %j envelope, not an unscoped or hydrated representation", async mode => {
    const query = { ...LOCALITY, addressEnabled: "false", fields: "enabled", limit: "2", ...mode };
    const first = await page(query);
    const replay = await request(query, { headers: { "if-none-match": first.response.headers.get("etag")! } });
    expect(replay.response.status).toBe(304);
    expect(await replay.response.text()).toBe("");
    posture(replay.response);
    expect(replay.response.headers.get("etag")).toBe(first.response.headers.get("etag"));
    expect(replay.response.headers.get("link")).toBe(first.response.headers.get("link"));
    expect(replay.recorder.statements).toEqual(first.recorder.statements);
  });
  it.each([
    { addressCity: "riverton" }, { addressState: "Texas" }, { addressZip: "2139" },
    { addressEnabled: "true" }, { fields: "company_name" }, { includeTotal: "false" }, { cursor: "14" }, { countOnly: "true" },
  ] as Query[])("does not 304 a changed representation %j", async changes => {
    const query = { ...LOCALITY, addressEnabled: "false", fields: "enabled", limit: "2" };
    const first = await page(query);
    const other = await page({ ...query, ...changes }, { "if-none-match": first.response.headers.get("etag")! });
    expect(other.bytes).not.toBe(first.bytes);
    expect(other.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
  });
});

const INVALID: Array<readonly [typeof SCOPES[number], string]> = [
  ...SCOPES.flatMap(key => ["", " ", "\t\n", " ", "a".repeat(101), "🚛".repeat(101)].map(value =>
    [key, `${key}=${encodeURIComponent(value)}`] as const)),
  ...SCOPES.map(key => [key, key] as const),
  ["addressCity", "addressCity=Riverton&addressCity=Other"], ["addressCity", "addressCity=Riverton&%61ddressCity=Riverton"],
  ["addressState", "addressState=TX&addressState=TX"], ["addressState", "addressState=TX&address%53tate=CA"],
  ["addressZip", "addressZip=02139&addressZip=99999"], ["addressZip", "addressZip=02139&%61ddressZip=02139"],
];
describe("customer site locality: auth first, value-free validation, zero SQL", () => {
  it.each(INVALID)("rejects %s: %s before SQL or conditional success", async (key, search) => {
    const logs = (["error", "warn", "info", "log", "debug"] as const).map(m => vi.spyOn(console, m));
    const result = await request(search, { headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
    const problem = await result.response.json() as Record<string, unknown>;
    expect(Object.keys(problem).sort()).toEqual(["detail", "status", "title", "type"]);
    expect(problem).toMatchObject({ type: BAD_REQUEST, title: "Bad Request", status: 400 });
    const detail = String(problem.detail);
    expect(detail).toContain(key);
    expect(detail).toMatch(/one|single|once/i);
    expect(detail).toMatch(/omit/i);
    expect(detail).toMatch(/retry/i);
    expect(detail).toMatch(/100/);
    expect(JSON.stringify(problem)).not.toMatch(/secret-marker|🚛|%61|%53/);
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    const comparison = await request(new URLSearchParams({ [key]: "different-secret-marker".repeat(6) }).toString());
    expect(comparison.response.status).toBe(400);
    expect(await comparison.response.json()).toEqual(problem);
    expect(comparison.recorder.prepared).toEqual([]);
  });
  it.each([LOCALITY, "addressCity=", "addressState=TX&addressState=CA", `addressZip=${"🚛".repeat(101)}`])("control: auth wins for %j", async query => {
    for (const token of [null, "wrong-synthetic-token"]) {
      const result = await request(query, { token, headers: { "if-none-match": "*" } });
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get("content-type")).toContain("application/problem+json");
      expect(await result.response.text()).not.toMatch(/wrong-synthetic-token/);
      expect(result.recorder.prepared).toEqual([]);
    }
  });
  it("known encoded locality names work with strictQuery, unknown names still fail closed", async () => {
    expectPage(await page("%61ddressCity=Riverton&address%53tate=TX&addressZip=02139&strictQuery=true"), [11, 13, 14, 15, 29, 30], 6);
    const result = await request("addressCity=Riverton&strictQuery=true&unknown=secret-marker");
    expect(result.response.status).toBe(400);
    expect(await result.response.text()).not.toContain("secret-marker");
    expect(result.recorder.prepared).toEqual([]);
  });
});

describe("customer site locality: mounted discovery and agent continuation guidance", () => {
  type Parameter = { name: string; in: string; required?: boolean; description?: string; example?: unknown; schema?: Record<string, unknown> };
  type Operation = { parameters?: Parameter[]; responses?: Record<string, { description?: string }>; [key: string]: unknown };
  async function openApi() {
    const response = await app.fetch(new Request(`${ORIGIN}/openapi.json`), TEST_ENV);
    expect(response.status).toBe(200);
    return response.json() as Promise<{ paths: Record<string, { get?: Operation }> }>;
  }
  it("publishes truthful optional opaque facets only on the ordinary customer list", async () => {
    const doc = await openApi();
    const operation = doc.paths[PATH]?.get;
    expect(operation).toMatchObject({ operationId: "listCustomerSnapshot", "x-access": "read", "x-effect": "local-read" });
    for (const name of SCOPES) {
      const params = operation?.parameters?.filter(p => p.name === name);
      expect(params, name).toHaveLength(1);
      expect(params![0]).toMatchObject({ in: "query", required: false });
      expect(params![0].schema).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
      expect(operation?.responses?.["400"]?.description).toContain(name);
    }
    for (const [path, item] of Object.entries(doc.paths)) {
      if (path === PATH) continue;
      for (const p of item.get?.parameters ?? []) expect(SCOPES, path).not.toContain(p.name);
    }
  });
  it("parameter examples are discoverable valid selectors replayable against local synthetic data", async () => {
    const doc = await openApi();
    for (const name of SCOPES) {
      const param = doc.paths[PATH]?.get?.parameters?.find(p => p.name === name);
      expect(param, name).toBeDefined();
      const example = param!.example ?? param!.schema?.example;
      expect(example, name).toBeDefined();
      const result = await page({ [name]: String(example), strictQuery: "true" });
      expect(result.body.total).toEqual(expect.any(Number));
    }
  });
  // This inventory and these recipes are machine-consumed agent instructions.
  // They must expose safe selection without suggesting geography or authority.
  it("inventories locality scopes only on customer lists and offers a local account-by-site-locality recipe", () => {
    const row = (path: string) => policyDoc.split("\n").find(line => line.startsWith(`| \`${path}\` |`)) ?? "";
    for (const key of SCOPES) {
      expect(row(PATH)).toContain(`\`${key}\``);
      for (const path of ["/api/v1/address-snapshot", "/api/v1/container-snapshot"]) expect(row(path)).not.toContain(key);
    }
    expect(policyDoc).toContain("test/customerAddressLocality.acceptance.test.ts");
    const guidance = policyDoc.split(/^#{1,6} /m).filter(section => section.includes("addressCity")).join("\n");
    expect(guidance).toMatch(/same (?:stored )?(?:address|site|child)|same[- ](?:site|child|address)/i);
    expect(guidance).toMatch(/mirror|stored/i);
    expect(guidance).toMatch(/headquarters/i);
    expect(guidance).toMatch(/geocod/i);
    expect(guidance).toMatch(/territor|eligib/i);
    expect(guidance).toMatch(/not (?:a )?snapshot isolation|no snapshot isolation|does not (?:provide|guarantee) snapshot isolation/i);
    const blocks = [...quickstartDoc.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map(m => m[1]);
    const recipe = blocks.find(b => b.includes("addressCity=") && (b.includes("addressState=") || b.includes("addressZip=")));
    expect(recipe).toBeDefined();
    expect(recipe).toContain("localhost:8787");
    expect(recipe).toContain(PATH);
    expect(recipe).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
    const commands = Object.values(packageJson.scripts).filter(command => command.includes("test/customerAddressLocality.acceptance.test.ts"));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toMatch(/vitest\s+run/);
      expect(command).not.toMatch(/--remote|deploy|probe:post-deploy/);
    }
  });
});
