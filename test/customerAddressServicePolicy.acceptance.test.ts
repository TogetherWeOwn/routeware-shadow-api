/// <reference types="vite/client" />

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent test-first oracle; no implementation diffs were read.
 * Run: npx vitest run --maxWorkers=2 test/customerAddressServicePolicy.acceptance.test.ts
 *
 * Mutations caught: ignored/reversed extras; date parsing, trimming, folding,
 * UTF-16 length, LIKE or interpolation; separate/uncorrelated child EXISTS;
 * duplicated/expanded parents; conflated site/customer enabled; global equipment
 * presence accidentally narrowed to matching sites; COUNT/page drift; lost
 * continuation state; representation-wrong 304; validation after auth/SQL/304.
 *
 * Only fixture setup writes. app.fetch uses real migrated local D1 behind a
 * read-only recorder; network, R2, browser and hidden SQL work are denied.
 * Fixtures and expected IDs are hand-derived. Builder consumes this RED handoff
 * unchanged; oracle corrections remain Test Author work. Baseline: e6391257.
 * No unmerged locality/classification selectors are required.
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/customer-snapshot";
const ORIGIN = "https://customer-site-policy.invalid";
const STAMP = "2026-01-02T03:04:05.000Z";
const AUDIT = "2026-01-05";
const OPAQUE = " 雪'\"%_ /+?&#🚛 ";
const INJECTION = "x' OR 1=1 --";
const HUNDRED = "🚛".repeat(100);
const SCOPES = ["addressExtrasAllowed", "addressLastAuditDate"] as const;
const COMBINED = { addressExtrasAllowed: "true", addressLastAuditDate: AUDIT };
const COHORT = { addressRouteId: "7", addressFranchiseId: "001", addressEnabled: "true" };
const ALL = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36];
const MATCH = [11, 13, 14, 18, 19, 20, 30, 35];
// Site IDs deliberately differ from account IDs. 11 has two matching sites;
// 12 splits extras/audit, 18 splits route/extras, 19 splits franchise/extras,
// 20 splits enabled/extras. 17/31 have no sites. 35 exercises storage DEFAULT 1.
// id, owner, extras, audit, route, franchise, site enabled
const SITES: Array<[number, number, number, string | null, number | null, string | null, number]> = [
  [101, 11, 1, AUDIT, 7, "001", 1], [102, 11, 1, AUDIT, 7, "001", 1],
  [103, 12, 1, "other", 7, "001", 1], [104, 12, 0, AUDIT, 7, "001", 1],
  [105, 13, 1, AUDIT, 7, "001", 1], [106, 14, 1, AUDIT, 7, "001", 0],
  [107, 15, 0, AUDIT, 7, "001", 0], [108, 16, 1, null, 7, "001", 1],
  [109, 18, 0, AUDIT, 7, "001", 1], [110, 18, 1, AUDIT, 8, "001", 1],
  [111, 19, 1, AUDIT, 7, "other", 1], [112, 19, 0, AUDIT, 7, "001", 1],
  [113, 20, 1, AUDIT, 7, "001", 0], [114, 20, 0, AUDIT, 7, "001", 1],
  [115, 21, 1, "2026-1-5", 7, "001", 1], [116, 22, 1, ` ${AUDIT} `, 7, "001", 1],
  [117, 23, 1, "Audit-X", 7, "001", 1], [118, 24, 1, "audit-x", 7, "001", 1],
  [119, 25, 1, OPAQUE, 7, "001", 1], [120, 26, 1, HUNDRED, 7, "001", 1],
  [121, 27, 1, "a".repeat(100), 7, "001", 1], [122, 28, 1, INJECTION, 7, "001", 1],
  [123, 29, 0, null, null, null, 1], [124, 30, 1, AUDIT, 7, "001", 1],
  [125, 30, 0, "other", 8, "other", 0], [126, 32, 1, "x\t\ny", 7, "001", 1],
  [127, 33, 1, ` ${AUDIT}`, 7, "001", 1], [128, 34, 1, `${AUDIT} `, 7, "001", 1],
  [130, 36, 0, "other", 8, "1", 0],
];
type Query = Record<string, string>;
type Body = { rows: Record<string, unknown>[]; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[]; method: string };
const ids = (body: Body) => body.rows.map(row => row.customer_id);
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
let effects: string[];
let beforeState: unknown;
let logs: Array<ReturnType<typeof vi.spyOn>>;

async function state() {
  return Promise.all(["customer_snapshot", "address_snapshot", "container_snapshot"].map(table =>
    TEST_ENV.CUSTOMER_DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())).then(results => results.map(r => r.results));
}
function recordDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const fetched: number[] = [];
  const forbid = (effect: string): never => { effects.push(effect); throw new Error("Forbidden effect in service-policy GET"); };
  function wrap(real: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return new Proxy(real, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql, values);
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          statements.push({ sql, binds, method: String(key) });
          if (!["all", "first", "raw"].includes(String(key))) return forbid("D1 non-read execution");
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
async function request(query: Query | string | URL = {}, options: { token?: string | null; headers?: Record<string, string> } = {}) {
  const recorder = recordDb();
  const url = query instanceof URL ? query : new URL(PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = typeof query === "string" ? query : new URLSearchParams(query).toString();
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Site-policy-oracle", ...options.headers });
  const token = options.token === undefined ? "test-read-token" : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: recorder.db,
    SNAPSHOTS: new Proxy({} as R2Bucket, { get: () => recorder.external }),
    BROWSER: new Proxy({} as Fetcher, { get: () => recorder.external }),
  });
  return { response, recorder, url };
}
function posture(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("x-request-id")).toBe("Site-policy-oracle");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
async function hash(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}"`;
}
async function page(query: Query | string | URL = {}, headers?: Record<string, string>) {
  const result = await request(query, { headers });
  expect(result.response.status).toBe(200);
  posture(result.response);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  const bytes = await result.response.text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  expect(result.response.headers.get("etag")).toBe(await hash(bytes));
  const countOnly = result.url.searchParams.get("countOnly") === "true";
  const counted = result.url.searchParams.get("includeTotal") !== "false";
  expect(result.recorder.statements).toHaveLength(countOnly || !counted ? 1 : 2);
  expect(result.recorder.prepared).toHaveLength(result.recorder.statements.length);
  expect(result.recorder.statements.filter(isCount)).toHaveLength(counted ? 1 : 0);
  if (countOnly) {
    expect(body.rows).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(result.recorder.fetched).toEqual([]);
  } else {
    const select = result.recorder.statements.find(s => !isCount(s))!;
    const limit = Number(result.url.searchParams.get("limit") ?? 50);
    const budget = limit + (result.url.searchParams.get("exactNext") === "true" ? 1 : 0);
    const tail = /\bOFFSET\b/i.test(select.sql) ? 2 : 1;
    expect(select.binds[select.binds.length - tail]).toBe(budget);
    for (const n of result.recorder.fetched) expect(n).toBeLessThanOrEqual(budget);
    if (!counted) expect(body.total).toBeNull();
  }
  expect(result.response.headers.has("link")).toBe(body.nextCursor !== null);
  expect(new Set(ids(body)).size).toBe(body.rows.length);
  for (const row of body.rows) {
    expect(typeof row.customer_id).toBe("number");
    for (const key of ["addresses", "containers", "pickup_address_id", "extras_allowed", "last_audit_date", "route_id", "franchise_id"]) expect(row).not.toHaveProperty(key);
    expect(Object.values(row).every(value => value === null || typeof value !== "object")).toBe(true);
  }
  return { ...result, body, bytes };
}
function expectPage(result: Awaited<ReturnType<typeof page>>, want: readonly number[], total: number | null, cursor: number | null = null) {
  expect(ids(result.body)).toEqual(want);
  expect(result.body.total).toBe(total);
  expect(result.body.nextCursor).toBe(cursor);
}
function next(result: Awaited<ReturnType<typeof page>>, expected: Query) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/customer-snapshot\?[^<>\s]*>; rel="next"$/);
  const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(target.origin).toBe(ORIGIN);
  expect(target.pathname).toBe(PATH);
  expect(target.hash + target.username + target.password).toBe("");
  const actual = new URLSearchParams(target.search);
  const want = { ...expected };
  for (const [key, defaultValue] of [["includeTotal", "true"], ["order", "asc"], ["enabled", "any"], ["addressExtrasAllowed", "any"]]) {
    if (want[key] === undefined || want[key] === defaultValue) {
      expect([null, defaultValue]).toContain(actual.get(key));
      expect(actual.getAll(key).length).toBeLessThanOrEqual(1);
      actual.delete(key);
      delete want[key];
    }
  }
  expect([...actual.keys()]).toHaveLength(Object.keys(want).length);
  expect(Object.fromEntries(actual)).toEqual(want);
  expect(actual.has("offset")).toBe(false);
  return target;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  effects = [];
  logs = (["error", "warn", "info", "log", "debug"] as const).map(level => vi.spyOn(console, level).mockImplementation(() => undefined));
  vi.stubGlobal("fetch", vi.fn(async () => { effects.push("network"); throw new Error("Outbound network forbidden"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot")]);
  await db.batch([...ALL].reverse().map(id => db.prepare(
    "INSERT INTO customer_snapshot (customer_id, enabled, company_name, customer_number, sub_customer_number, phone1, phone2, comments, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, [13, 15, 31].includes(id) ? 0 : 1,
    [11, 12, 13, 14, 30, 35].includes(id) ? `Synthetic Needle ${id}` : `Synthetic Other ${id}`,
    [11, 13, 30, 35].includes(id) ? "CUST+& 001" : `OTHER-${id}`,
    [11, 14, 30].includes(id) ? "SITE/one" : null,
    [11, 30].includes(id) ? "+1 202 5550107" : id === 14 ? "5559999" : null,
    [13, 30].includes(id) ? "5550107 EXT9" : null,
    [11, 13, 30].includes(id) ? "red marker" : "other comment", STAMP)));
  await db.batch([...SITES].reverse().map(site => db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, extras_allowed, last_audit_date, route_id, franchise_id, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(...site, STAMP)));
  await db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, last_audit_date, route_id, franchise_id, enabled, synced_at) VALUES (129, 35, ?, 7, '001', 1, ?)").bind(AUDIT, STAMP).run();
  // Equipment on 30 is ONLY on a nonmatching site. Presence must stay global.
  await db.batch([[201, 102, 0], [202, 125, 0], [203, 106, 1]].map(row => db.prepare(
    "INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, synced_at) VALUES (?, ?, ?, ?)"
  ).bind(...row, STAMP)));
  await db.prepare("UPDATE address_snapshot SET driver_note = ?, comments = ?, city = ? WHERE pickup_address_id = 108").bind(AUDIT, AUDIT, AUDIT).run();
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(effects).toEqual([]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(await state(), "GET must not mutate mirrored rows").toEqual(beforeState);
    const text = JSON.stringify(logs.map(log => log.mock.calls));
    for (const marker of [OPAQUE, INJECTION, HUNDRED, "private-policy-", "synthetic-wrong-token"]) {
      expect(text).not.toContain(marker);
      expect(text).not.toContain(JSON.stringify(marker).slice(1, -1));
    }
  } finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

describe("service-policy scopes: exact stored same-site selection", () => {
  it("control: real fixtures prove satisfiable intersections, split-site decoys and default extras", async () => {
    const rows = await TEST_ENV.CUSTOMER_DB.prepare(
      "SELECT customer_id FROM customer_snapshot c WHERE EXISTS (SELECT 1 FROM address_snapshot a WHERE a.customer_id = c.customer_id AND a.extras_allowed = 1 AND a.last_audit_date = ?) ORDER BY customer_id"
    ).bind(AUDIT).all<{ customer_id: number }>();
    expect(rows.results.map(row => row.customer_id)).toEqual(MATCH);
    const defaultRow = await TEST_ENV.CUSTOMER_DB.prepare("SELECT extras_allowed FROM address_snapshot WHERE pickup_address_id = 129").first();
    expect(defaultRow).toEqual({ extras_allowed: 1 });
  });
  it.each([
    ["extras alone creates EXISTS", { addressExtrasAllowed: "true" }, [11, 12, 13, 14, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 30, 32, 33, 34, 35]],
    ["false means stored zero, not absence", { addressExtrasAllowed: "false" }, [12, 15, 18, 19, 20, 29, 30, 36]],
    ["audit alone creates EXISTS including extras zero", { addressLastAuditDate: AUDIT }, [11, 12, 13, 14, 15, 18, 19, 20, 30, 35]],
    ["same-site combined, never split or duplicate", COMBINED, MATCH],
    ["same-site false", { addressExtrasAllowed: "false", addressLastAuditDate: AUDIT }, [12, 15, 18, 19, 20]],
    ["extras any does not require a true flag", { addressExtrasAllowed: "any", addressLastAuditDate: AUDIT }, [11, 12, 13, 14, 15, 18, 19, 20, 30, 35]],
    ["NULL is not text null", { addressLastAuditDate: "null" }, []],
    ["unknown valid text returns empty success", { addressLastAuditDate: "unknown audit marker" }, []],
    ["unpadded date is not parsed", { addressLastAuditDate: "2026-1-5" }, [21]],
    ["both edge spaces are significant", { addressLastAuditDate: ` ${AUDIT} ` }, [22]],
    ["leading space significant", { addressLastAuditDate: ` ${AUDIT}` }, [33]],
    ["trailing space significant", { addressLastAuditDate: `${AUDIT} ` }, [34]],
    ["case-sensitive upper", { addressLastAuditDate: "Audit-X" }, [23]],
    ["case-sensitive lower", { addressLastAuditDate: "audit-x" }, [24]],
    ["literal reserved characters", { addressLastAuditDate: OPAQUE }, [25]],
    ["100 Unicode code points, not UTF-16 units", { addressLastAuditDate: HUNDRED }, [26]],
    ["100 ASCII boundary", { addressLastAuditDate: "a".repeat(100) }, [27]],
    ["SQL-looking text is literal", { addressLastAuditDate: INJECTION }, [28]],
    ["internal whitespace preserved", { addressLastAuditDate: "x\t\ny" }, [32]],
    ["no wildcard interpretation", { addressLastAuditDate: "%_" }, []],
    ["no prefix/range interpretation", { addressLastAuditDate: "2026-01" }, []],
    ["no scheduling interpretation", { addressLastAuditDate: "audit all sites" }, []],
  ] as Array<[string, Query, number[]]>)('%s agrees across counted, count-free and COUNT-only', async (_label, query, want) => {
    expectPage(await page(query), want, want.length);
    expectPage(await page({ ...query, includeTotal: "false" }), want, null);
    expectPage(await page({ ...query, countOnly: "true" }), [], want.length);
  });
  it("control: omission and any preserve no-site accounts and byte/SQL/ETag/Link parity", async () => {
    const plain = await page();
    const any = await page({ addressExtrasAllowed: "any" });
    expectPage(plain, ALL, 26);
    expect(any.bytes).toBe(plain.bytes);
    expect(any.recorder.statements).toEqual(plain.recorder.statements);
    expect(any.response.headers.get("etag")).toBe(plain.response.headers.get("etag"));
    for (const s of any.recorder.statements) expect(s.sql).not.toMatch(/address_snapshot|\bEXISTS\b/i);
    expectPage(await page({ addressExtrasAllowed: "any", hasAddresses: "false" }), [17, 31], 2);
    const first = await page({ addressExtrasAllowed: "any", limit: "25" });
    const target = next(first, { limit: "25", cursor: "35" });
    expect(target.searchParams.has("addressExtrasAllowed")).toBe(false);
    expectPage(await page(target), [36], 1);
  });
  it.each([
    ["true", "true", [11, 18, 19, 30, 35]], ["true", "false", [13]],
    ["false", "true", [14, 20]], ["false", "false", []],
  ] as const)("site enabled=%s AND customer enabled=%s remain independent", async (addressEnabled, enabled, want) => {
    expectPage(await page({ ...COMBINED, addressEnabled, enabled }), want, want.length);
  });
});

describe("service-policy scopes: AND every merged selector", () => {
  it.each([
    ["route must match SAME site as extras", { addressRouteId: "7" }, [11, 13, 14, 19, 20, 30, 35]],
    ["franchise must match SAME site as extras", { addressFranchiseId: "001" }, [11, 13, 14, 18, 20, 30, 35]],
    ["enabled must match SAME site as extras", { addressEnabled: "true" }, [11, 13, 18, 19, 30, 35]],
    ["all cohort scopes on one site", COHORT, [11, 13, 30, 35]],
    ["customer primary ID", { customerId: "13" }, [13]],
    ["split-site primary ID cannot match", { customerId: "12" }, []],
    ["IDs cannot OR-leak split-site customer", { ids: "11,12,15,17,30" }, [11, 30]],
    ["company search", { q: "needle" }, [11, 13, 14, 30, 35]],
    ["other company search", { q: "other" }, [18, 19, 20]],
    ["exact customer number", { customerNumber: "CUST+& 001" }, [11, 13, 30, 35]],
    ["exact sub-customer", { subCustomerNumber: "SITE/one" }, [11, 14, 30]],
    ["phone OR legs inside AND", { phone: "5550107" }, [11, 13, 30]],
    ["phone1 presence", { hasPhone1: "true" }, [11, 14, 30]],
    ["phone1 absence", { hasPhone1: "false" }, [13, 18, 19, 20, 35]],
    ["phone2 presence", { hasPhone2: "true" }, [13, 30]],
    ["phone2 absence", { hasPhone2: "false" }, [11, 14, 18, 19, 20, 35]],
    ["comments substring", { comments: "red" }, [11, 13, 30]],
    ["address presence", { hasAddresses: "true" }, MATCH],
    ["address absence contradiction", { hasAddresses: "false" }, []],
    ["equipment is global, even on nonmatching site 125", { hasContainers: "true" }, [11, 14, 30]],
    ["equipment absence is global", { hasContainers: "false" }, [13, 18, 19, 20, 35]],
    ["inclusive lower and upper ID", { lowerId: "13", upperId: "20" }, [13, 14, 18, 19, 20]],
    ["all account selectors intersect", { ...COHORT, hasAddresses: "true", hasContainers: "true", hasPhone1: "true", hasPhone2: "true", enabled: "true", ids: "11,12,13,14,30,35", customerNumber: "CUST+& 001", subCustomerNumber: "SITE/one", q: "needle", phone: "5550107", comments: "red", lowerId: "11", upperId: "35", strictQuery: "true" }, [30]],
  ] as Array<[string, Query, number[]]>)('%s', async (_label, filters, want) => {
    const query = { ...COMBINED, ...filters };
    expectPage(await page(query), want, want.length);
    expectPage(await page({ ...query, includeTotal: "false" }), want, null);
    expectPage(await page({ ...query, countOnly: "true" }), [], want.length);
  });
  it.each([{ addressExtrasAllowed: "true" }, { addressExtrasAllowed: "false" }, { addressLastAuditDate: AUDIT }] as Query[])("effective scope %j contradicts hasAddresses=false", async filters => {
    expectPage(await page({ ...filters, hasAddresses: "false" }), [], 0);
  });
  it("correlates audit to route/franchise/enabled even when extras is omitted", async () => {
    // 12: route7+franchise001+enabled1 on a site with a different audit;
    // move its DATE site away from all three controls to isolate audit leakage.
    await TEST_ENV.CUSTOMER_DB.prepare("UPDATE address_snapshot SET route_id = 8, franchise_id = 'other', enabled = 0 WHERE pickup_address_id = 104").run();
    beforeState = await state();
    for (const filters of [{ addressRouteId: "7" }, { addressFranchiseId: "001" }, { addressEnabled: "true" }] as Query[]) {
      expectPage(await page({ ...filters, addressLastAuditDate: AUDIT, customerId: "12" }), [], 0);
    }
  });
});

describe("service-policy scopes: SQL budgets and sparse representations", () => {
  it("extends one correlated cohort EXISTS; COUNT and page share all predicates and binds", async () => {
    const query = { ...COMBINED, ...COHORT, q: "needle", limit: "2" };
    const result = await page(query);
    expectPage(result, [11, 13], 4, 13);
    const count = result.recorder.statements.find(isCount)!;
    const select = result.recorder.statements.find(s => !isCount(s))!;
    const where = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).replace(/\s+ORDER\s+BY[\s\S]*$/i, "").trim();
    expect(where(count.sql)).toBe(where(select.sql));
    expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
    for (const s of [count, select]) {
      expect(s.sql.match(/\bEXISTS\s*\(/gi)).toHaveLength(1);
      expect(s.sql).not.toMatch(/\bJOIN\b/i);
      expect(s.sql).toMatch(/address_snapshot/);
      expect(s.sql).toMatch(/extras_allowed\s*=\s*\?/);
      expect(s.sql).toMatch(/last_audit_date\s*=\s*\?/);
      expect(s.binds).toContain(1);
      expect(s.binds).toContain(AUDIT);
    }
    const free = await page({ ...query, includeTotal: "false" });
    expect(free.body.rows).toEqual(result.body.rows);
    expect(free.recorder.statements).toEqual([select]);
    const only = await page({ ...query, countOnly: "true", fields: "enabled", offset: "999", exactNext: "true" });
    expectPage(only, [], 4);
    expect(only.recorder.statements).toEqual([count]);
  });
  it("binds opaque audit verbatim without interpolation or LIKE", async () => {
    for (const audit of [OPAQUE, INJECTION]) {
      const result = await page({ addressLastAuditDate: audit });
      expectPage(result, audit === OPAQUE ? [25] : [28], 1);
      for (const s of result.recorder.statements) {
        expect(s.binds).toContain(audit);
        expect(s.sql).not.toContain(audit);
        expect(s.sql).not.toMatch(/\bLIKE\b/i);
      }
    }
  });
  it("keeps canonical customer IDs without exposing or hydrating the matching sites", async () => {
    const result = await page({ ...COMBINED, ...COHORT, fields: "enabled" });
    expect(result.body.rows).toEqual([
      { customer_id: 11, enabled: 1 }, { customer_id: 13, enabled: 0 },
      { customer_id: 30, enabled: 1 }, { customer_id: 35, enabled: 1 },
    ]);
  });
  it.each([{}, { includeTotal: "false" }, { countOnly: "true" }, { exactNext: "true" }] as Query[])("revalidates sparse %j envelope only after the scoped reads", async mode => {
    const query = { ...COMBINED, ...COHORT, fields: "enabled", limit: "2", ...mode };
    const first = await page(query);
    const replay = await request(query, { headers: { "if-none-match": first.response.headers.get("etag")! } });
    expect(replay.response.status).toBe(304);
    expect(await replay.response.text()).toBe("");
    posture(replay.response);
    expect(replay.response.headers.get("etag")).toBe(first.response.headers.get("etag"));
    expect(replay.response.headers.get("link")).toBe(first.response.headers.get("link"));
    expect(replay.recorder.statements).toEqual(first.recorder.statements);
  });
  it.each([{ addressExtrasAllowed: "false" }, { addressLastAuditDate: "2026-1-5" }, { fields: "company_name" }, { includeTotal: "false" }, { cursor: "13" }] as Query[])("never 304s a changed representation %j", async changes => {
    const query = { ...COMBINED, fields: "enabled", limit: "2" };
    const first = await page(query);
    const changed = await page({ ...query, ...changes }, { "if-none-match": first.response.headers.get("etag")! });
    expect(changed.bytes).not.toBe(first.bytes);
    expect(changed.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
  });
  it.each(["extras_allowed", "last_audit_date"])("recomputes sparse membership when unprojected %s changes, even with unchanged synced_at", async column => {
    const query = { ...COMBINED, ...COHORT, fields: "enabled" };
    const first = await page(query);
    expectPage(first, [11, 13, 30, 35], 4);
    // Customer 11 has TWO matching sites: remove both, not just one.
    await TEST_ENV.CUSTOMER_DB.prepare(`UPDATE address_snapshot SET ${column} = ? WHERE customer_id = 11`).bind(column === "extras_allowed" ? 0 : "other").run();
    beforeState = await state();
    const changed = await page(query, { "if-none-match": first.response.headers.get("etag")! });
    expectPage(changed, [13, 30, 35], 3);
    expect(changed.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
  });
});

describe("service-policy scopes: fully followed continuation", () => {
  it.each([
    ["asc", false, false], ["desc", false, false], ["asc", true, false], ["desc", true, false],
    ["asc", false, true], ["desc", false, true], ["asc", true, true], ["desc", true, true],
  ] as const)("%s counted=%s exactNext=%s preserves every effective selector to terminal", async (order, counted, exact) => {
    const filters = { ...COMBINED, ...COHORT, lowerId: "11", upperId: "35", strictQuery: "true", fields: "enabled", order, limit: "2", includeTotal: String(counted), ...(exact ? { exactNext: "true" } : {}) };
    const wants = order === "asc" ? [[11, 13], [30, 35], []] : [[35, 30], [13, 11], []];
    let current = await page(filters);
    const seen: unknown[] = [];
    const pages = exact ? 2 : 3;
    for (let i = 0; i < pages; i++) {
      const cursor = i < pages - 1 ? wants[i][1] : null;
      expectPage(current, wants[i], counted ? [4, 2, 0][i] : null, cursor);
      seen.push(...ids(current.body));
      if (cursor !== null) current = await page(next(current, { ...filters, cursor: String(cursor) }));
    }
    expect(seen).toEqual(order === "asc" ? [11, 13, 30, 35] : [35, 30, 13, 11]);
    expect(new Set(seen).size).toBe(4);
  });
  it.each(["asc", "desc"])("%s offset-to-seek stops on a partial page without inventing another empty page", async order => {
    const filters = { ...COMBINED, ...COHORT, order, limit: "2", fields: "enabled" };
    const first = await page({ ...filters, offset: "1" });
    expectPage(first, order === "asc" ? [13, 30] : [30, 13], 4, order === "asc" ? 30 : 13);
    const last = await page(next(first, { ...filters, cursor: String(first.body.nextCursor) }));
    expectPage(last, order === "asc" ? [35] : [11], 1);
    expect(last.recorder.statements.every(s => !/\bOFFSET\b/i.test(s.sql))).toBe(true);
  });
  it.each([
    [{ cursor: "13", offset: "999", lowerId: "13", upperId: "30" }, [14, 18, 19, 20, 30]],
    [{ cursor: "30", order: "desc", lowerId: "13", upperId: "30" }, [20, 19, 18, 14, 13]],
    [{ lowerId: "21", upperId: "29" }, []],
  ] as Array<[Query, number[]]>)("seek and inclusive fences %j intersect membership", async (filters, want) => {
    expectPage(await page({ ...COMBINED, ...filters }), want, want.length);
    expectPage(await page({ ...COMBINED, ...filters, countOnly: "true" }), [], want.length);
  });
  it.each(["true", "false"])("retains standalone effective extras=%s and drops unknown values from relative links", async flag => {
    const filters = { addressExtrasAllowed: flag, limit: "1", includeTotal: "false" };
    const search = `${new URLSearchParams(filters)}&token=private-policy-token&unknown=private-policy-unknown&url=https%3A%2F%2Fredirect.invalid`;
    const first = await page(search, { host: "host-marker.invalid", "x-forwarded-host": "forward-marker.invalid" });
    expectPage(first, flag === "true" ? [11] : [12], null, flag === "true" ? 11 : 12);
    const target = next(first, { ...filters, cursor: flag === "true" ? "11" : "12" });
    expect(first.response.headers.get("link")).not.toMatch(/private-policy|marker|Bearer|test-read-token|https?:|\/\//);
    expectPage(await page(target), flag === "true" ? [12] : [15], null, flag === "true" ? 12 : 15);
  });
  it("round-trips an opaque audit in audit-only links, preserving it exactly once", async () => {
    const filters = { addressLastAuditDate: OPAQUE, includeTotal: "false", limit: "1" };
    const first = await page(filters);
    expectPage(first, [25], null, 25);
    const target = next(first, { ...filters, cursor: "25" });
    expect(target.searchParams.getAll("addressLastAuditDate")).toEqual([OPAQUE]);
    expectPage(await page(target), [], null);
  });
});

const INVALID: Array<[typeof SCOPES[number], string]> = [
  ...["", " ", "TRUE", "False", "ANY", "1", "0", "yes", " true", "false ", "any ", "true,false", "null", "private-policy-enum"].map(value => ["addressExtrasAllowed", `addressExtrasAllowed=${encodeURIComponent(value)}`] as [typeof SCOPES[number], string]),
  ...["", " ", "\t\n", " ", " 　", "a".repeat(101), "🚛".repeat(101), `private-policy-audit${" ".repeat(101)}`].map(value => ["addressLastAuditDate", `addressLastAuditDate=${encodeURIComponent(value)}`] as [typeof SCOPES[number], string]),
  ["addressExtrasAllowed", "addressExtrasAllowed"], ["addressLastAuditDate", "addressLastAuditDate"],
  ["addressExtrasAllowed", "addressExtrasAllowed=true&addressExtrasAllowed=false"],
  ["addressExtrasAllowed", "addressExtrasAllowed=any&addressExtrasAllowed=any"],
  ["addressExtrasAllowed", "addressExtrasAllowed=true&addressExtras%41llowed=true"],
  ["addressExtrasAllowed", "addressExtrasAllowed=&%61ddressExtrasAllowed=false"],
  ["addressLastAuditDate", "addressLastAuditDate=private-policy-first&addressLastAuditDate=private-policy-second"],
  ["addressLastAuditDate", "addressLastAuditDate=2026-01-05&addressLastAuditDate=2026-01-05"],
  ["addressLastAuditDate", "addressLastAuditDate=private-policy-first&addressLastAudit%44ate=private-policy-second"],
  ["addressLastAuditDate", "addressLastAuditDate=&%61ddressLastAuditDate=private-policy-second"],
];
describe("service-policy scopes: auth first and fixed value-free validation", () => {
  it.each(INVALID)("rejects %s: %s before SQL and 304", async (key, search) => {
    const result = await request(search, { headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    posture(result.response);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("etag")).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    const body = await result.response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["detail", "status", "title", "type"]);
    expect(body).toMatchObject({ type: expect.stringMatching(/docs\/PROBLEMS\.md#bad-request$/), title: "Bad Request", status: 400 });
    const detail = String(body.detail);
    expect(detail).toContain(key);
    expect(detail).toMatch(/single|one|once/i);
    expect(detail).toMatch(/omit/i);
    expect(detail).toMatch(/retry/i);
    if (key === "addressExtrasAllowed") expect(detail).toMatch(/true[\s\S]*false[\s\S]*any/);
    else expect(detail).toMatch(/100/);
    expect(JSON.stringify(body)).not.toMatch(/private-policy-|🚛|%61|%44|%41|TRUE|False|ANY/);
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
    // Fixed guidance is shared across malformed, repeated and oversized inputs.
    const comparison = await request({ [key]: key === "addressLastAuditDate" ? "x".repeat(101) : "different-invalid-enum" });
    expect(comparison.response.status).toBe(400);
    expect(await comparison.response.json()).toEqual(body);
    expect(comparison.recorder.prepared).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it.each([COMBINED, "addressExtrasAllowed=private-policy-invalid", "addressLastAuditDate=&addressLastAuditDate=private-policy-valid", { addressLastAuditDate: HUNDRED + "🚛" }] as Array<Query | string>)("control: auth wins for %j", async query => {
    for (const token of [null, "synthetic-wrong-token"]) {
      const result = await request(query, { token, headers: { "if-none-match": "*" } });
      expect(result.response.status).toBe(401);
      expect(result.recorder.prepared).toEqual([]);
      expect(result.response.headers.get("etag")).toBeNull();
      expect(result.response.headers.get("link")).toBeNull();
      expect(await result.response.text()).not.toMatch(/private-policy-|synthetic-wrong-token|🚛/);
    }
  });
  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("keeps read authority and idempotence for %s", async token => {
    const first = await page(COMBINED);
    expectPage(first, MATCH, 8);
    const replay = await request(COMBINED, { token });
    expect(replay.response.status).toBe(200);
    expect(await replay.response.text()).toBe(first.bytes);
  });
  it("accepts encoded known names under strictQuery, rejects unknowns before SQL", async () => {
    expectPage(await page("%61ddressExtrasAllowed=false&addressLastAudit%44ate=2026-01-05&strictQuery=true"), [12, 15, 18, 19, 20], 5);
    const result = await request({ ...COMBINED, strictQuery: "true", unknown: "private-policy-unknown" });
    expect(result.response.status).toBe(400);
    expect(result.recorder.prepared).toEqual([]);
    expect(await result.response.text()).not.toContain("private-policy-unknown");
  });
  it("rejects conflicting count modes with guidance, never generic-prose equality", async () => {
    const result = await request({ ...COMBINED, countOnly: "true", includeTotal: "false" }, { headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    const body = await result.response.json() as { detail: string };
    expect(body.detail).toMatch(/countOnly/);
    expect(body.detail).toMatch(/includeTotal/);
    expect(result.recorder.prepared).toEqual([]);
  });
});

describe("service-policy scopes: mounted discovery and consumer instructions", () => {
  type Parameter = { name: string; in: string; required?: boolean; description?: string; example?: unknown; schema?: Record<string, unknown> };
  type Operation = { parameters?: Parameter[]; description?: string; responses?: Record<string, { description?: string }>; [key: string]: unknown };
  async function openApi() {
    const result = await request(new URL("/openapi.json", ORIGIN));
    expect(result.response.status).toBe(200);
    expect(result.recorder.prepared).toEqual([]);
    return result.response.json() as Promise<{ paths: Record<string, Record<string, Operation>> }>;
  }
  it("publishes optional enum and exact opaque facets ONLY on ordinary customer list GET", async () => {
    const doc = await openApi();
    const operation = doc.paths[PATH]?.get;
    expect(operation).toMatchObject({ operationId: "listCustomerSnapshot", "x-access": "read", "x-effect": "local-read" });
    for (const name of SCOPES) {
      const params = operation?.parameters?.filter(p => p.name === name);
      expect(params, name).toHaveLength(1);
      expect(params![0]).toMatchObject({ in: "query", required: false });
      expect(operation?.responses?.["400"]?.description).toContain(name);
    }
    const extras = operation!.parameters!.find(p => p.name === SCOPES[0])!;
    const audit = operation!.parameters!.find(p => p.name === SCOPES[1])!;
    expect(extras.schema).toMatchObject({ type: "string", enum: ["true", "false", "any"], default: "any" });
    expect(audit.schema).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
    expect(audit.schema?.default).toBeUndefined();
    const guidance = `${operation?.description ?? ""} ${extras.description ?? ""} ${extras.schema?.description ?? ""} ${audit.description ?? ""} ${audit.schema?.description ?? ""}`;
    expect(guidance).toMatch(/same[- ](?:stored[- ]?)?(?:site|child|address)/i);
    expect(guidance).toMatch(/extras_allowed/);
    expect(guidance).toMatch(/last_audit_date/);
    expect(guidance).toMatch(/case-sensitive/i);
    expect(guidance).toMatch(/code.point/i);
    expect(guidance).toMatch(/mirror|stored/i);
    expect(guidance).toMatch(/not[^.\n]*billing|not[^.\n]*authori[sz]|no[^.\n]*authori[sz]/i);
    expect(guidance).toMatch(/not[^.\n]*(?:compliance|certif|proof)|no[^.\n]*(?:compliance|certif|proof)/i);
    for (const [path, item] of Object.entries(doc.paths)) for (const [method, op] of Object.entries(item)) {
      if (path === PATH && method === "get") continue;
      for (const param of op.parameters ?? []) expect(SCOPES, `${method} ${path}`).not.toContain(param.name);
    }
  });
  it("replays schema-provided examples against the local mirror", async () => {
    const doc = await openApi();
    for (const name of SCOPES) {
      const param = doc.paths[PATH]?.get?.parameters?.find(p => p.name === name);
      expect(param, name).toBeDefined();
      const example = param!.example ?? param!.schema?.example;
      expect(example, name).toBeDefined();
      await page({ [name]: String(example), strictQuery: "true" });
    }
  });
  it("inventories the new names only for the customer list and exposes a local combined consumer recipe", () => {
    const row = (path: string) => policyDoc.split("\n").find(line => line.startsWith(`| \`${path}\` |`)) ?? "";
    for (const name of SCOPES) {
      expect(row(PATH)).toContain(`\`${name}\``);
      for (const path of ["/api/v1/address-snapshot", "/api/v1/container-snapshot"]) expect(row(path)).not.toContain(name);
    }
    const recipes = [...quickstartDoc.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map(m => m[1]);
    const combined = recipes.find(block => block.includes("addressExtrasAllowed=") && block.includes("addressLastAuditDate="));
    expect(combined).toBeDefined();
    expect(combined).toContain(PATH);
    expect(combined).toContain("localhost:8787");
    expect(combined).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
  });
});
