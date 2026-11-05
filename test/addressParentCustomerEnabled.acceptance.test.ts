/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import changelog from "../CHANGELOG.md?raw";
import { focusedChecks } from "./focusedChecks";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned oracle: select sites by parent customer enabled state.
 *
 * R36-02 adds an optional `parentCustomerEnabled=true|false|any` selector
 * (default `any`) to the EXISTING address list ONLY
 * (`GET /api/v1/address-snapshot`). True matches a related stored customer
 * whose enabled is exactly 1; false matches exactly 0 via
 * `customer_snapshot.customer_id = address_snapshot.customer_id` with
 * qualified columns. Omission/any adds NO parent predicate and must not hide
 * pre-existing orphan rows. Explicit true/false never matches a missing
 * parent or a noncanonical stored enabled value.
 *
 * Site enabled stays independent. The predicate is a correlated EXISTS (or
 * equivalently non-fanout); no JOIN multiplying rows, no child/parent
 * expansion. Supplied filters AND-compose; contradictions return empty 200.
 *
 * Mirrored customer enabled is stored snapshot state, not current account
 * eligibility, service permission, billing status or authorization.
 *
 * Intended state: RED before the paired build. New-selector assertions fail
 * on main because `parentCustomerEnabled` is unknown there (ignored ->
 * unfiltered 200s, no 400s, no OpenAPI param, no docs). Compatibility
 * assertions (bare list, site scopes, order, count modes, by-id, unknown-key
 * policy, operation identity) pass before AND after.
 *
 * Builder rules: build on this commit WITHOUT editing this file. Oracle
 * corrections come through a new bounded child card, never a direct edit.
 * No snapshots in this file: every expectation is hand-derived so
 * `vitest -u` cannot re-record the missing behavior away.
 *
 * Hermetic: real local D1 executes every recorded read; outbound fetch, R2,
 * BROWSER and D1 writes/batch/exec throw. No tenant data, no live deploy.
 *
 * Run: npx vitest run test/addressParentCustomerEnabled.acceptance.test.ts --maxWorkers=2
 */

const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/address-snapshot";
const ORIGIN = "https://parent-customer.test.invalid";
const READ_TOKEN = "test-read-token";
const API_TOKEN = "test-api-token";
const SYNC_SECRET = "test-sync-secret";
const NEEDLE = "synthetic-needle";
const AUDIT = "2026-01-15";
const STAMP = "2026-01-02T03:04:05.000Z";

const INVALID_DETAIL =
  "Invalid request query (parentCustomerEnabled). See docs/PROBLEMS.md#bad-request.";

// Customers: id, enabled, company (101/103 share a name, 102/104 share a name
// as duplicate-decoy accounts; 105 is noncanonical stored state).
const CUSTOMERS: Array<[number, number, string]> = [
  [101, 1, "Synthetic Enabled Shared"],
  [102, 0, "Synthetic Disabled Shared"],
  [103, 1, "Synthetic Enabled Shared"],
  [104, 0, "Synthetic Disabled Shared"],
  [105, 2, "Synthetic Noncanonical"],
];

// Sites: id, customer, site enabled, route, franchise, street, city, state,
// zip, driver_note, extras_allowed, last_audit_date.
const SITES: Array<[
  number, number, number, number, string, string, string, string, string,
  string | null, number, string | null
]> = [
  [11, 101, 1, 7, "001", `11 ${NEEDLE} Way`, "Riverton", "ST", "02139", "Gate amber", 1, AUDIT],
  [12, 101, 0, 7, "001", "12 Synthetic Way", "Riverton", "ST", "02139", null, 0, null],
  [13, 101, 1, 8, "001", "13 Other Way", "Othertown", "OT", "99999", "unrelated", 1, AUDIT],
  [21, 102, 1, 7, "002", `21 ${NEEDLE} Way`, "Riverton", "ST", "02139", "Gate amber", 0, AUDIT],
  [22, 102, 0, 7, "001", "22 Synthetic Way", "Riverton", "ST", "02139", null, 1, null],
  [31, 103, 0, 7, "001", `31 ${NEEDLE} Way`, "Riverton", "ST", "02139", "Gate amber", 0, AUDIT],
  [32, 103, 1, 7, "001", "32 Synthetic Way", "Riverton", "ST", "02139", null, 1, null],
  [41, 104, 0, 7, "001", "41 Synthetic Way", "Riverton", "ST", "02139", null, 0, ""],
  [51, 105, 1, 7, "001", `51 ${NEEDLE} Way`, "Riverton", "ST", "02139", "Gate amber", 1, AUDIT],
  [52, 105, 0, 7, "001", "52 Synthetic Way", "Riverton", "ST", "02139", null, 0, null],
];

const ALL_IDS = [11, 12, 13, 21, 22, 31, 32, 41, 51, 52];
const PARENT_TRUE_IDS = [11, 12, 13, 31, 32];
const PARENT_FALSE_IDS = [21, 22, 41];
const NONCANONICAL_IDS = [51, 52];

// Containers: id, parent site, enabled. 13's child is disabled but still
// present; presence never depends on container enabled.
const CONTAINERS: Array<[number, number, number]> = [
  [11, 11, 1],
  [13, 13, 0],
  [21, 21, 1],
  [51, 51, 1],
];

type Query = Record<string, string | number>;
type Statement = { sql: string; binds: unknown[]; method: string };
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };

function recordDb(real: D1Database) {
  const statements: Statement[] = [];
  const batch = vi.fn(() => { throw new Error("List must not batch D1 work"); });
  const exec = vi.fn(() => { throw new Error("List must not exec D1 work"); });
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql, values),
      first: (...args: unknown[]) => {
        statements.push({ sql, binds, method: "first" });
        return (stmt.first as (...a: unknown[]) => unknown)(...args);
      },
      all: () => {
        statements.push({ sql, binds, method: "all" });
        return stmt.all();
      },
      raw: (...args: unknown[]) => {
        statements.push({ sql, binds, method: "raw" });
        return (stmt.raw as (...a: unknown[]) => unknown)(...args);
      },
      run: () => {
        statements.push({ sql, binds, method: "run" });
        throw new Error("List must not mutate D1");
      }
    } as unknown as D1PreparedStatement;
  }
  const db = {
    prepare: (sql: string) => wrap(real.prepare(sql), sql, []),
    batch,
    exec
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

function qs(query: Query): string {
  return new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)])
  ).toString();
}

async function call(
  query: Query | string = {},
  options: { token?: string | null; headers?: Record<string, string>; db?: D1Database; path?: string } = {}
) {
  const search = typeof query === "string" ? query : qs(query);
  const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
  const headers = new Headers();
  headers.set("origin", ORIGIN);
  headers.set("x-request-id", "Parent-customer-oracle");
  const token = options.token === undefined ? READ_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  const url = new URL(`${options.path ?? PATH}?${search}`, ORIGIN);
  // R2/BROWSER bindings deny: local list must never touch them.
  const deny = () => { throw new Error("Local list touched an external binding"); };
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV,
    CUSTOMER_DB: options.db ?? recorder.db,
    SNAPSHOTS: Object.fromEntries(
      ["get", "head", "list", "put", "delete", "createMultipartUpload", "resumeMultipartUpload"].map((k) => [k, deny])
    ) as unknown as R2Bucket,
    BROWSER: { fetch: deny } as unknown as Fetcher,
  });
  return { response, url, recorder, search };
}

async function page(query: Query | string = {}, headers?: Record<string, string>) {
  const result = await call(query, { headers });
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  expect(result.response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(result.response.headers.get("x-request-id")).toBe("Parent-customer-oracle");
  const bytes = await result.response.clone().text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const params = result.url.searchParams;
  const countOnly = params.get("countOnly") === "true";
  const counted = params.get("includeTotal") !== "false";
  if (countOnly) {
    expect(body.rows).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.recorder.statements).toHaveLength(1);
    expect(result.recorder.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(1);
  } else {
    expect(result.recorder.statements).toHaveLength(counted ? 2 : 1);
    expect(result.recorder.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(counted ? 1 : 0);
    if (!counted) expect(body.total).toBeNull();
  }
  expect(result.recorder.statements.every((s) => /^\s*SELECT\b/i.test(s.sql))).toBe(true);
  expect(result.recorder.statements.every((s) => s.method === "first" || s.method === "all")).toBe(true);
  expect(result.recorder.batch).not.toHaveBeenCalled();
  expect(result.recorder.exec).not.toHaveBeenCalled();
  return { ...result, body, bytes };
}

const ids = (body: Body) => body.rows.map((row) => row.pickup_address_id);

function expectOneRowPerId(body: Body) {
  const seen = ids(body);
  expect(new Set(seen).size).toBe(seen.length);
}

function nextTarget(response: Response, current: URL, expected: Query): URL {
  const link = response.headers.get("link");
  expect(link, "non-null nextCursor requires Link").not.toBeNull();
  expect(link).toMatch(/^<\/api\/v1\/address-snapshot\?[^<>\s]*>; rel="next"$/);
  const raw = /^<([^>]+)>; rel="next"$/.exec(link!)![1];
  expect(raw.startsWith("//")).toBe(false);
  const target = new URL(raw, current);
  expect(target.origin).toBe(current.origin);
  expect(target.pathname).toBe(PATH);
  expect(target.hash).toBe("");
  const actualParams = new URLSearchParams(target.searchParams);
  const expectedParams = { ...expected } as Record<string, string>;
  if (expectedParams.includeTotal !== "false") {
    expect([null, "true"]).toContain(actualParams.get("includeTotal"));
    actualParams.delete("includeTotal");
    delete expectedParams.includeTotal;
  }
  if (expectedParams.order === undefined || expectedParams.order === "asc") {
    expect([null, "asc"]).toContain(actualParams.get("order"));
    actualParams.delete("order");
    delete expectedParams.order;
  }
  if (expectedParams.countOnly !== "true") {
    actualParams.delete("countOnly");
    delete expectedParams.countOnly;
  }
  expect([...actualParams.keys()]).toHaveLength(Object.keys(expectedParams).length);
  expect(Object.fromEntries(actualParams)).toEqual(
    Object.fromEntries(Object.entries(expectedParams).map(([k, v]) => [k, String(v)]))
  );
  expect(target.searchParams.has("offset")).toBe(false);
  expect(link).not.toContain(current.origin);
  return target;
}

async function follow(target: URL) {
  expect(target.pathname).toBe(PATH);
  return page(target.search.startsWith("?") ? target.search.slice(1) : target.search);
}

async function seed() {
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  for (const [id, enabled, company] of CUSTOMERS) {
    await db.prepare(
      "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, ?, ?)"
    ).bind(id, company, enabled, STAMP).run();
  }
  for (const row of [...SITES].reverse()) {
    const [id, customer, enabled, route, franchise, street, city, state, zip, note, extras, audit] = row;
    await db.prepare(
      "INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, address, city, state, zip, driver_note, extras_allowed, enabled, last_audit_date, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, customer, route, franchise, street, city, state, zip, note, extras, enabled, audit, STAMP).run();
  }
  for (const [id, parent, enabled] of [...CONTAINERS].reverse()) {
    await db.prepare(
      "INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, synced_at) VALUES (?, ?, ?, ?)"
    ).bind(id, parent, enabled, STAMP).run();
  }
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("Unexpected outbound fetch in parent-customer acceptance");
  }));
  await seed();
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parentCustomerEnabled alone", () => {
  it("true returns only sites of enabled stored customers, one row per id", async () => {
    const { body } = await page({ parentCustomerEnabled: "true" });
    expect(ids(body)).toEqual(PARENT_TRUE_IDS);
    expect(body.total).toBe(5);
    expect(body.nextCursor).toBeNull();
    expectOneRowPerId(body);
  });

  it("false returns only sites of disabled stored customers, one row per id", async () => {
    const { body } = await page({ parentCustomerEnabled: "false" });
    expect(ids(body)).toEqual(PARENT_FALSE_IDS);
    expect(body.total).toBe(3);
    expect(body.nextCursor).toBeNull();
    expectOneRowPerId(body);
  });

  it("any is equivalent to omission: identical body and identical SQL, full stored rows", async () => {
    const omitted = await page({});
    const any = await page({ parentCustomerEnabled: "any" });
    expect(ids(omitted.body)).toEqual(ALL_IDS);
    expect(omitted.body.total).toBe(10);
    expect(any.body).toEqual(omitted.body);
    expect(any.recorder.statements).toEqual(omitted.recorder.statements);
    expect(omitted.body.rows[0]).toMatchObject({
      pickup_address_id: 11, customer_id: 101, enabled: 1, synced_at: STAMP
    });
    expect(Object.keys(omitted.body.rows[0])).not.toContain("parentCustomerEnabled");
  });

  it("true adds a correlated EXISTS over the stored customer with qualified columns", async () => {
    const { recorder } = await page({ parentCustomerEnabled: "true" });
    expect(recorder.statements).toHaveLength(2);
    for (const statement of recorder.statements) {
      expect(statement.sql).toMatch(/\bEXISTS\b/i);
      expect(statement.sql).toContain("customer_snapshot.customer_id");
      expect(statement.sql).toContain("address_snapshot.customer_id");
      // Exact stored state: literal 1 or a bound 1, never the enum text.
      expect(statement.sql).toMatch(/customer_snapshot\.enabled\s*=\s*(?:\?|1\b)/i);
      expect(statement.binds).not.toContain("true");
      expect(statement.sql).not.toMatch(/\bJOIN\b/i);
      expect(statement.sql).not.toContain(NEEDLE);
    }
    // COUNT and page share the same parent predicate and binds.
    const [count, select] = recorder.statements;
    const whereOf = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).split(/\bORDER\s+BY\b/i)[0];
    expect(whereOf(select.sql)).toContain(whereOf(count.sql).trim());
    expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
  });

  it("false adds a correlated EXISTS for stored 0 with qualified columns", async () => {
    const { recorder } = await page({ parentCustomerEnabled: "false" });
    expect(recorder.statements).toHaveLength(2);
    for (const statement of recorder.statements) {
      expect(statement.sql).toMatch(/\bEXISTS\b/i);
      expect(statement.sql).toContain("customer_snapshot.customer_id");
      expect(statement.sql).toContain("address_snapshot.customer_id");
      expect(statement.sql).toMatch(/customer_snapshot\.enabled\s*=\s*(?:\?|0\b)/i);
      expect(statement.binds).not.toContain("false");
      expect(statement.sql).not.toMatch(/\bJOIN\b/i);
    }
  });

  it("any and omission add no parent predicate", async () => {
    for (const query of [{}, { parentCustomerEnabled: "any" }] as Query[]) {
      const { recorder } = await page(query);
      for (const statement of recorder.statements) {
        expect(statement.sql).not.toContain("customer_snapshot");
      }
    }
  });

  it("never matches a noncanonical stored parent enabled value", async () => {
    const truthy = await page({ parentCustomerEnabled: "true" });
    const falsy = await page({ parentCustomerEnabled: "false" });
    for (const id of NONCANONICAL_IDS) {
      expect(ids(truthy.body)).not.toContain(id);
      expect(ids(falsy.body)).not.toContain(id);
    }
    expect(truthy.body.total).toBe(5);
    expect(falsy.body.total).toBe(3);
    // Unconstrained reads still include noncanonical parents.
    expect(ids((await page({})).body)).toEqual(expect.arrayContaining(NONCANONICAL_IDS));
    expect(ids((await page({ parentCustomerEnabled: "any" })).body)).toEqual(expect.arrayContaining(NONCANONICAL_IDS));
  });

  it("never multiplies rows: multiple sites per customer and decoy names stay distinct", async () => {
    // Customer 101 has three sites; 101/103 share a company name but select
    // independently by customer_id, never by name.
    const { body } = await page({ parentCustomerEnabled: "true" });
    expect(ids(body)).toEqual([11, 12, 13, 31, 32]);
    expectOneRowPerId(body);
    const byCustomer = await page({ customerId: "101", parentCustomerEnabled: "true" });
    expect(ids(byCustomer.body)).toEqual([11, 12, 13]);
    const decoy = await page({ customerId: "103", parentCustomerEnabled: "true" });
    expect(ids(decoy.body)).toEqual([31, 32]);
  });
});

describe("parent and site enabled stay independent", () => {
  it.each([
    ["true", "true", [11, 13, 32]],
    ["true", "false", [12, 31]],
    ["false", "true", [21]],
    ["false", "false", [22, 41]],
    ["any", "true", [11, 13, 21, 32, 51]],
    ["any", "false", [12, 22, 31, 41, 52]],
    ["true", "any", PARENT_TRUE_IDS],
    ["false", "any", PARENT_FALSE_IDS],
  ] as const)("parentCustomerEnabled=%s with site enabled=%s", async (parent, enabled, want) => {
    const result = await page({ parentCustomerEnabled: parent, enabled });
    expect(ids(result.body)).toEqual([...want]);
    expect(result.body.total).toBe(want.length);
    expectOneRowPerId(result.body);
  });

  it("never replaces the site predicate with parent state", async () => {
    const siteOnly = await page({ enabled: "true" });
    expect(ids(siteOnly.body)).toEqual([11, 13, 21, 32, 51]);
    const parentOnly = await page({ parentCustomerEnabled: "true" });
    expect(ids(parentOnly.body)).toEqual(PARENT_TRUE_IDS);
    // The conjunction is the intersection, not either side alone.
    const both = await page({ parentCustomerEnabled: "true", enabled: "true" });
    expect(ids(both.body)).toEqual([11, 13, 32]);
    for (const statement of both.recorder.statements) {
      // WHERE-specific: site predicate on the address table plus a parent
      // EXISTS over the customer table.
      const where = statement.sql.slice(statement.sql.search(/\bWHERE\b/i));
      expect(where).toMatch(/\baddress_snapshot\.enabled\s*=\s*1\b|\benabled\s*=\s*1\b/i);
      expect(where).toMatch(/\bEXISTS\b/i);
      expect(where).toContain("customer_snapshot");
    }
  });
});

describe.each(["true", "false"])("parent intersections includeTotal=%s", (includeTotal) => {
  const total = (want: number[]) => (includeTotal === "false" ? null : want.length);
  it.each([
    [{}, PARENT_TRUE_IDS],
    [{ customerId: "101" }, [11, 12, 13]],
    [{ customerId: "103" }, [31, 32]],
    [{ customerId: "102" }, []],
    [{ customerId: "105" }, []],
    [{ pickupAddressId: "11" }, [11]],
    [{ pickupAddressId: "21" }, []],
    [{ pickupAddressId: "51" }, []],
    [{ ids: "11,21,51,32" }, [11, 32]],
    [{ ids: "21,41,51" }, []],
    [{ routeId: "7" }, [11, 12, 31, 32]],
    [{ routeId: "8" }, [13]],
    [{ routeId: "99" }, []],
    [{ franchiseId: "001" }, PARENT_TRUE_IDS],
    [{ franchiseId: "002" }, []],
    [{ zip: "02139" }, [11, 12, 31, 32]],
    [{ zip: "99999" }, [13]],
    [{ zip: "missing" }, []],
    [{ streetAddress: `11 ${NEEDLE} Way` }, [11]],
    [{ streetAddress: `21 ${NEEDLE} Way` }, []],
    [{ city: "Riverton" }, [11, 12, 31, 32]],
    [{ city: "Othertown" }, [13]],
    [{ city: "missing" }, []],
    [{ state: "ST" }, [11, 12, 31, 32]],
    [{ state: "OT" }, [13]],
    [{ driverNote: "amber" }, [11, 31]],
    [{ driverNote: "unrelated" }, [13]],
    [{ driverNote: "missing" }, []],
    [{ q: NEEDLE }, [11, 31]],
    [{ q: "Othertown" }, [13]],
    [{ q: "missing-needle" }, []],
    [{ enabled: "true" }, [11, 13, 32]],
    [{ enabled: "false" }, [12, 31]],
    [{ extrasAllowed: "true" }, [11, 13, 32]],
    [{ extrasAllowed: "false" }, [12, 31]],
    [{ hasContainers: "true" }, [11, 13]],
    [{ hasContainers: "false" }, [12, 31, 32]],
    [{ lastAuditDate: AUDIT }, [11, 13, 31]],
    [{ lastAuditDate: "1999-12-31" }, []],
    [{ hasLastAuditDate: "true" }, [11, 13, 31]],
    [{ hasLastAuditDate: "false" }, [12, 32]],
    [{ lastAuditDate: AUDIT, hasLastAuditDate: "false" }, []],
    [{ upperId: "13" }, [11, 12, 13]],
    [{ upperId: "12" }, [11, 12]],
    [{ cursor: "12" }, [13, 31, 32]],
    [{ order: "desc", cursor: "31" }, [13, 12, 11]],
    // Full conjunction across every merged control still selects hand-derived 11.
    [{
      customerId: "101", pickupAddressId: "11", ids: "11,12,13", routeId: "7",
      franchiseId: "001", zip: "02139", streetAddress: `11 ${NEEDLE} Way`,
      city: "Riverton", state: "ST", driverNote: "amber", q: NEEDLE,
      enabled: "true", extrasAllowed: "true", hasContainers: "true",
      lastAuditDate: AUDIT, hasLastAuditDate: "true"
    }, [11]],
    [{ customerId: "101", routeId: "8", franchiseId: "002" }, []],
  ] as const)("AND-composes %j", async (filters, want) => {
    const result = await page({ parentCustomerEnabled: "true", ...filters, includeTotal });
    expect(ids(result.body)).toEqual([...want]);
    expect(result.body.total).toBe(total([...want]));
    expectOneRowPerId(result.body);
  });

  it.each([
    [{}, PARENT_FALSE_IDS],
    [{ customerId: "102" }, [21, 22]],
    [{ customerId: "104" }, [41]],
    [{ customerId: "101" }, []],
    [{ customerId: "105" }, []],
    [{ pickupAddressId: "21" }, [21]],
    [{ pickupAddressId: "11" }, []],
    [{ ids: "11,21,41" }, [21, 41]],
    [{ routeId: "7" }, PARENT_FALSE_IDS],
    [{ franchiseId: "001" }, [22, 41]],
    [{ franchiseId: "002" }, [21]],
    [{ zip: "02139" }, PARENT_FALSE_IDS],
    [{ streetAddress: `21 ${NEEDLE} Way` }, [21]],
    [{ city: "Riverton" }, PARENT_FALSE_IDS],
    [{ q: NEEDLE }, [21]],
    [{ enabled: "true" }, [21]],
    [{ enabled: "false" }, [22, 41]],
    [{ extrasAllowed: "true" }, [22]],
    [{ extrasAllowed: "false" }, [21, 41]],
    [{ hasContainers: "true" }, [21]],
    [{ hasContainers: "false" }, [22, 41]],
    [{ lastAuditDate: AUDIT }, [21]],
    [{ hasLastAuditDate: "true" }, [21]],
    [{ hasLastAuditDate: "false" }, [22, 41]],
    [{ upperId: "22" }, [21, 22]],
    [{ cursor: "21" }, [22, 41]],
  ] as const)("false AND-composes %j", async (filters, want) => {
    const result = await page({ parentCustomerEnabled: "false", ...filters, includeTotal });
    expect(ids(result.body)).toEqual([...want]);
    expect(result.body.total).toBe(total([...want]));
  });

  it("contradictions return empty 200 with shared COUNT/page predicates", async () => {
    const result = await page({
      parentCustomerEnabled: "true", customerId: "102", routeId: "8",
      franchiseId: "002", enabled: "false", extrasAllowed: "false",
      hasContainers: "false", includeTotal
    });
    expect(result.body).toEqual({ rows: [], total: total([]), nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
    const statements = result.recorder.statements;
    expect(statements.length).toBe(includeTotal === "false" ? 1 : 2);
    for (const s of statements) {
      expect(s.sql).toMatch(/\bEXISTS\b/i);
      expect(s.sql).toContain("customer_snapshot");
    }
    if (includeTotal !== "false") {
      const [count, select] = statements;
      const whereOf = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).split(/\bORDER\s+BY\b/i)[0];
      expect(whereOf(select.sql)).toContain(whereOf(count.sql).trim());
      expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
    }
  });
});

describe("parent countOnly and count-free modes", () => {
  it("countOnly returns COUNT-only with the parent predicate and no rows or Link", async () => {
    for (const value of ["true", "false"] as const) {
      const result = await page({ parentCustomerEnabled: value, countOnly: "true", limit: "1", offset: "1" });
      const want = value === "true" ? 5 : 3;
      expect(result.body).toEqual({ rows: [], total: want, nextCursor: null });
      expect(result.recorder.statements).toHaveLength(1);
      expect(result.recorder.statements[0].sql).toMatch(/\bCOUNT\s*\(/i);
      expect(result.recorder.statements[0].sql).toMatch(/\bEXISTS\b/i);
      expect(result.recorder.statements[0].sql).toContain("customer_snapshot");
    }
  });

  it("countOnly ignores limit/offset for the total but still validates them", async () => {
    const counted = await page({ parentCustomerEnabled: "true", countOnly: "true", limit: "1", offset: "4" });
    expect(counted.body).toEqual({ rows: [], total: 5, nextCursor: null });
    const bad = await call("parentCustomerEnabled=true&countOnly=true&limit=501");
    expect(bad.response.status).toBe(400);
    expect(bad.recorder.statements).toEqual([]);
  });

  it("countOnly plus includeTotal=false is a value-free 400 before D1", async () => {
    const { response, recorder } = await call("parentCustomerEnabled=true&countOnly=true&includeTotal=false");
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(recorder.statements).toEqual([]);
  });

  it("count-free returns identical rows and cursor without COUNT", async () => {
    const counted = await page({ parentCustomerEnabled: "true", limit: "2" });
    const free = await page({ parentCustomerEnabled: "true", limit: "2", includeTotal: "false" });
    expect(free.body.rows).toEqual(counted.body.rows);
    expect(free.body.nextCursor).toBe(counted.body.nextCursor);
    expect(ids(free.body)).toEqual([11, 12]);
    expect(free.body.total).toBeNull();
    expect(free.recorder.statements).toHaveLength(1);
    expect(free.recorder.statements[0].sql).toMatch(/\bEXISTS\b/i);
    expect(counted.body.total).toBe(5);
  });
});

describe("parent pagination, order and sparse fieldsets", () => {
  it("pages true rows by offset through partial and empty pages", async () => {
    const first = await page({ parentCustomerEnabled: "true", limit: "2" });
    expect(ids(first.body)).toEqual([11, 12]);
    expect(first.body.total).toBe(5);
    expect(first.body.nextCursor).toBe(12);
    const partial = await page({ parentCustomerEnabled: "true", limit: "2", offset: "4" });
    expect(ids(partial.body)).toEqual([32]);
    expect(partial.body.total).toBe(5);
    expect(partial.body.nextCursor).toBeNull();
    expect(partial.response.headers.get("link")).toBeNull();
    const empty = await page({ parentCustomerEnabled: "true", limit: "2", offset: "6" });
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.total).toBe(5);
    expect(empty.body.nextCursor).toBeNull();
  });

  it("seeks by cursor with cursor-relative totals", async () => {
    const { body, recorder } = await page({ parentCustomerEnabled: "true", limit: "2", cursor: "12" });
    expect(ids(body)).toEqual([13, 31]);
    expect(body.total).toBe(3);
    expect(body.nextCursor).toBe(31);
    for (const statement of recorder.statements) {
      expect(statement.sql).toContain("pickup_address_id > ?");
      expect(statement.sql).toMatch(/\bEXISTS\b/i);
    }
    const empty = await page({ parentCustomerEnabled: "true", limit: "2", cursor: "32" });
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.total).toBe(0);
  });

  it("cursor wins over offset under the parent filter", async () => {
    const { body } = await page({ parentCustomerEnabled: "false", limit: "2", cursor: "21", offset: "999" });
    expect(ids(body)).toEqual([22, 41]);
    expect(body.total).toBe(2);
  });

  it("orders by primary key descending with strict-below seek", async () => {
    const first = await page({ parentCustomerEnabled: "true", order: "desc" });
    expect(ids(first.body)).toEqual([32, 31, 13, 12, 11]);
    expect(first.body.total).toBe(5);
    const seek = await page({ parentCustomerEnabled: "true", order: "desc", limit: "2", cursor: "31" });
    expect(ids(seek.body)).toEqual([13, 12]);
    expect(seek.body.total).toBe(3);
    for (const statement of seek.recorder.statements) {
      expect(statement.sql).toContain("pickup_address_id < ?");
    }
  });

  it("explicit asc matches omitted order", async () => {
    const omitted = await page({ parentCustomerEnabled: "false", limit: "2" });
    const explicit = await page({ parentCustomerEnabled: "false", order: "asc", limit: "2" });
    expect(explicit.body).toEqual(omitted.body);
    expect(ids(explicit.body)).toEqual([21, 22]);
  });

  it("caps either traversal with upperId", async () => {
    const asc = await page({ parentCustomerEnabled: "true", upperId: "13" });
    expect(ids(asc.body)).toEqual([11, 12, 13]);
    expect(asc.body.total).toBe(3);
    const desc = await page({ parentCustomerEnabled: "true", order: "desc", upperId: "13" });
    expect(ids(desc.body)).toEqual([13, 12, 11]);
    expect(desc.body.total).toBe(3);
    const none = await page({ parentCustomerEnabled: "false", upperId: "11" });
    expect(none.body).toEqual({ rows: [], total: 0, nextCursor: null });
  });

  it("exactNext fetches limit+1 internally and signals the terminal page exactly", async () => {
    const first = await page({ parentCustomerEnabled: "true", limit: "2", exactNext: "true" });
    expect(ids(first.body)).toEqual([11, 12]);
    expect(first.body.total).toBe(5);
    expect(first.body.nextCursor).toBe(12);
    const terminal = await page({ parentCustomerEnabled: "true", limit: "2", exactNext: "true", cursor: "31" });
    expect(ids(terminal.body)).toEqual([32]);
    expect(terminal.body.total).toBe(1);
    // Exact signal: a full terminal page carries no next link.
    expect(terminal.body.nextCursor).toBeNull();
    expect(terminal.response.headers.get("link")).toBeNull();
  });

  it("trims filtered rows to selected columns with the id always present", async () => {
    const { body } = await page({ parentCustomerEnabled: "true", fields: "address" });
    expect(ids(body)).toEqual(PARENT_TRUE_IDS);
    expect(body.rows[0]).toEqual({ pickup_address_id: 11, address: `11 ${NEEDLE} Way` });
    for (const row of body.rows) expect(Object.keys(row).sort()).toEqual(["address", "pickup_address_id"]);
  });

  it("still rejects an invalid fields selector before D1 when the parent filter is present", async () => {
    const { response, recorder } = await call({ parentCustomerEnabled: "true", fields: "nope" });
    expect(response.status).toBe(400);
    expect(recorder.statements).toEqual([]);
  });
});

describe.each(["true", "false"])("parent continuation links includeTotal=%s", (includeTotal) => {
  it.each(["asc", "desc"])("traverses every %s page once, retaining the parent scope", async (order) => {
    const filters = { parentCustomerEnabled: "true", limit: "2", includeTotal, order };
    let current = await page(filters);
    // A partial page is terminal (nextCursor null, no next Link), so the
    // 5-row traversal at limit 2 ends on the partial page; there is no
    // reachable trailing empty page.
    const pages = order === "asc"
      ? [[11, 12], [13, 31], [32]]
      : [[32, 31], [13, 12], [11]];
    const totals = [5, 3, 1];
    const seen: unknown[] = [];
    for (let i = 0; i < pages.length; i++) {
      expect(ids(current.body)).toEqual(pages[i]);
      expect(current.body.total).toBe(includeTotal === "false" ? null : totals[i]);
      seen.push(...ids(current.body));
      if (i === pages.length - 1) {
        expect(current.body.nextCursor).toBeNull();
        expect(current.response.headers.get("link")).toBeNull();
      } else {
        const cursor = String(pages[i][pages[i].length - 1]);
        expect(current.body.nextCursor).toBe(Number(cursor));
        current = await follow(nextTarget(current.response, current.url, { ...filters, cursor }));
      }
    }
    expect(seen).toEqual(order === "asc" ? [11, 12, 13, 31, 32] : [32, 31, 13, 12, 11]);
    expect(new Set(seen).size).toBe(5);
  });

  it("retains false parent state in the link instead of dropping a false-like filter", async () => {
    const filters = { parentCustomerEnabled: "false", limit: "1", includeTotal };
    const first = await page(filters);
    expect(ids(first.body)).toEqual([21]);
    const second = await follow(nextTarget(first.response, first.url, { ...filters, cursor: "21" }));
    expect(ids(second.body)).toEqual([22]);
    const third = await follow(nextTarget(second.response, second.url, { ...filters, cursor: "22" }));
    expect(ids(third.body)).toEqual([41]);
    const empty = await follow(nextTarget(third.response, third.url, { ...filters, cursor: "41" }));
    expect(ids(empty.body)).toEqual([]);
    expect(empty.response.headers.get("link")).toBeNull();
  });

  it("omits parentCustomerEnabled=any from the link canonically, like enabled=any", async () => {
    const first = await page({ parentCustomerEnabled: "any", limit: "2", includeTotal });
    expect(ids(first.body)).toEqual([11, 12]);
    const target = nextTarget(first.response, first.url, { limit: "2", cursor: "12", includeTotal });
    expect(target.searchParams.has("parentCustomerEnabled")).toBe(false);
  });

  it("carries no parent key in the link when the selector was omitted", async () => {
    const first = await page({ limit: "2", includeTotal });
    const target = nextTarget(first.response, first.url, { limit: "2", cursor: "12", includeTotal });
    expect(target.searchParams.has("parentCustomerEnabled")).toBe(false);
  });

  it("converts an offset start to a cursor link preserving the parent selector", async () => {
    const first = await page({ parentCustomerEnabled: "true", limit: "1", offset: "1", includeTotal });
    expect(ids(first.body)).toEqual([12]);
    const second = await follow(
      nextTarget(first.response, first.url, { parentCustomerEnabled: "true", limit: "1", cursor: "12", includeTotal })
    );
    expect(ids(second.body)).toEqual([13]);
  });

  it("retains the finite ids selector and strictQuery through every page", async () => {
    let result = await page({
      parentCustomerEnabled: "true", ids: "11,13,21,32", limit: "1",
      strictQuery: "true", includeTotal
    });
    expect(ids(result.body)).toEqual([11]);
    result = await follow(nextTarget(result.response, result.url, {
      parentCustomerEnabled: "true", ids: "11,13,21,32", limit: "1",
      strictQuery: "true", cursor: "11", includeTotal
    }));
    expect(ids(result.body)).toEqual([13]);
    result = await follow(nextTarget(result.response, result.url, {
      parentCustomerEnabled: "true", ids: "11,13,21,32", limit: "1",
      strictQuery: "true", cursor: "13", includeTotal
    }));
    expect(ids(result.body)).toEqual([32]);
  });
});

describe("parent strict enum validation", () => {
  it.each([
    "parentCustomerEnabled=yes",
    "parentCustomerEnabled=1",
    "parentCustomerEnabled=0",
    "parentCustomerEnabled=TRUE",
    "parentCustomerEnabled=True",
    "parentCustomerEnabled=%20true",
    "parentCustomerEnabled=true%20",
    "parentCustomerEnabled=",
    "parentCustomerEnabled=%20",
    "parentCustomerEnabled=ANY",
    "parentCustomerEnabled=any%20",
    "parentCustomerEnabled=null",
    "parentCustomerEnabled=2",
    "parentCustomerEnabled=true%2Cfalse",
    "parentCustomerEnabled=true%00",
    "parentCustomerEnabled=secret-parent-marker",
    "parentCustomerEnabled",
  ])("rejects %s with a value-free 400 before D1", async (query) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const { response, recorder } = await call(query, { headers: { "if-none-match": "*" } });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("link")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    const body = await response.json();
    expect(body).toEqual({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail: INVALID_DETAIL
    });
    expect(JSON.stringify(body)).not.toContain("secret-parent-marker");
    expect(recorder.statements).toEqual([]);
    expect(recorder.batch).not.toHaveBeenCalled();
    expect(recorder.exec).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each([
    "parentCustomerEnabled=true&parentCustomerEnabled=false",
    "parentCustomerEnabled=true&parentCustomerEnabled=true",
    "parentCustomerEnabled=&parentCustomerEnabled=true",
    "parentCustomerEnabled=any&parentCustomerEnabled=any",
    "parentCustomerEnabled=true&parentCustomer%45nabled=true",
    "parentCustomerEnabled=true&parent%43ustomerEnabled=true",
  ])("rejects repeated keys %s with a value-free 400 before D1", async (query) => {
    const { response, recorder } = await call(query);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail: INVALID_DETAIL
    });
    expect(recorder.statements).toEqual([]);
  });

  it("accepts exactly true, false and any with case-sensitive spelling", async () => {
    for (const value of ["true", "false", "any"]) {
      const { response } = await call({ parentCustomerEnabled: value });
      expect(response.status).toBe(200);
    }
  });

  it.each([
    "parentCustomerEnabled=true",
    "parentCustomerEnabled=secret-parent-marker",
    "parentCustomerEnabled=true&parentCustomerEnabled=false"
  ])("auth precedes validation and D1: %s", async (query) => {
    for (const token of [null, "synthetic-invalid-token"]) {
      const forbidden = forbiddenDb();
      const { response } = await call(query, { token, db: forbidden.db });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("secret-parent-marker");
      expect(forbidden.prepare).not.toHaveBeenCalled();
      expect(forbidden.batch).not.toHaveBeenCalled();
      expect(forbidden.exec).not.toHaveBeenCalled();
    }
  });

  it("lets every bearer role read with the selector", async () => {
    for (const token of [READ_TOKEN, API_TOKEN, SYNC_SECRET]) {
      const { response } = await call({ parentCustomerEnabled: "true" }, { token });
      expect(response.status).toBe(200);
      expect(ids((await response.json()) as Body)).toEqual(PARENT_TRUE_IDS);
    }
  });

  it("keeps request-ID correlation, CORS and no Link on a rejected selector", async () => {
    const response = await exports.default.fetch(`${ORIGIN}${PATH}?parentCustomerEnabled=secret-parent-marker`, {
      headers: {
        authorization: `Bearer ${READ_TOKEN}`,
        origin: "https://app.example.com",
        "x-request-id": "synthetic-parent-error"
      }
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("synthetic-parent-error");
    expect(response.headers.get("access-control-allow-origin")).toBeTruthy();
    expect(response.headers.get("link")).toBeNull();
    expect(await response.json()).toEqual({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail: INVALID_DETAIL
    });
  });

  it("ignores unknown names alongside the selector without reflecting them", async () => {
    const filtered = await page({ parentCustomerEnabled: "true" });
    const bogus = await page("parentCustomerEnabled=true&bogus_param=1");
    expect(bogus.body).toEqual(filtered.body);
    expect(bogus.recorder.statements).toEqual(filtered.recorder.statements);
    expect(bogus.response.headers.get("link")).toBe(filtered.response.headers.get("link"));
  });

  it("strictQuery=true accepts the new selector and still rejects sibling-only names", async () => {
    const strict = await page({ parentCustomerEnabled: "true", strictQuery: "true" });
    expect(ids(strict.body)).toEqual(PARENT_TRUE_IDS);
    for (const sibling of ["hasAddresses=true", "parentEnabled=true", "containerTypeId=7", "bogus_param=1"]) {
      const { response, recorder } = await call(`parentCustomerEnabled=true&strictQuery=true&${sibling}`);
      expect(response.status, sibling).toBe(400);
      expect(recorder.statements).toEqual([]);
    }
  });
});

describe("parent representation ETags and conditional reads", () => {
  async function hash(bytes: string) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
    return `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
  }

  it.each(["true", "false"])("answers a matching If-None-Match with an empty 304 (includeTotal=%s)", async (includeTotal) => {
    const query = { parentCustomerEnabled: "true", fields: "enabled", limit: "2", includeTotal };
    const first = await page(query);
    expect(first.body.rows).toEqual([
      { pickup_address_id: 11, enabled: 1 },
      { pickup_address_id: 12, enabled: 0 },
    ]);
    const tag = await hash(first.bytes);
    expect(first.response.headers.get("etag")).toBe(tag);
    for (const validator of [tag, `W/${tag}`, "*"]) {
      const { response, recorder } = await call(query, { headers: { "if-none-match": validator } });
      expect(response.status).toBe(304);
      expect(response.body).toBeNull();
      expect(await response.text()).toBe("");
      expect(response.headers.get("etag")).toBe(tag);
      expect(response.headers.get("link")).toBe(first.response.headers.get("link"));
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(recorder.statements).toEqual(first.recorder.statements);
    }
    const changed = await page({ ...query, parentCustomerEnabled: "false" }, { "if-none-match": tag });
    expect(ids(changed.body)).toEqual([21, 22]);
    expect(changed.response.headers.get("etag")).not.toBe(tag);
  });

  it("recomputes sparse membership after an unprojected parent enabled change", async () => {
    const query = { parentCustomerEnabled: "true", customerId: "101", fields: "enabled" };
    const first = await page(query);
    expect(ids(first.body)).toEqual([11, 12, 13]);
    await TEST_ENV.CUSTOMER_DB.prepare(
      "UPDATE customer_snapshot SET enabled = 0 WHERE customer_id = 101"
    ).run();
    const changed = await page(query, { "if-none-match": await hash(first.bytes) });
    expect(changed.body).toEqual({ rows: [], total: 0, nextCursor: null });
    expect(changed.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
  });

  it("is idempotent and preserves full stored rows", async () => {
    const first = await page({ parentCustomerEnabled: "false" });
    const again = await page({ parentCustomerEnabled: "false" });
    expect(again.body).toEqual(first.body);
    expect(again.bytes).toBe(first.bytes);
    expect(first.body.rows[0]).toMatchObject({
      pickup_address_id: 21, customer_id: 102, enabled: 1, synced_at: STAMP
    });
  });
});

describe("parent SQL proofs and synthetic local plan (no latency promise)", () => {
  it("binds no enum text and executes a synthetic EXPLAIN without promising an index", async () => {
    const result = await page({ parentCustomerEnabled: "true", customerId: "101", limit: "1" });
    expect(ids(result.body)).toEqual([11]);
    for (const { sql, binds } of result.recorder.statements) {
      expect(sql).toMatch(/\bEXISTS\s*\(\s*SELECT\s+1\s+FROM\s+customer_snapshot\b/i);
      expect(sql).toContain("customer_snapshot.customer_id");
      expect(sql).toContain("address_snapshot.customer_id");
      expect(sql).not.toMatch(/\bJOIN\b/i);
      expect(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP|COLLATE\s+NOCASE)\b/i);
      expect(binds.map(String)).not.toContain("true");
      // Existing-PK lookup shape only; the planner result is local evidence.
      const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds)
        .all<{ detail: string }>();
      const details = (plan.results ?? []).map((r) => r.detail).join("\n");
      expect(plan.results.length, `Synthetic local plan (not production latency): ${details}`).toBeGreaterThan(0);
      expect(details).toMatch(/\bSCAN\b|\bSEARCH\b/i);
      expect(details).toContain("address_snapshot");
    }
  });

  it("stores customer enabled as NOT NULL with 0/1/2 representable and no migration needed", async () => {
    const row = await TEST_ENV.CUSTOMER_DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'customer_snapshot'"
    ).first<{ sql: string }>();
    expect(row?.sql).toContain("enabled INTEGER NOT NULL");
    const states = await TEST_ENV.CUSTOMER_DB.prepare(
      "SELECT DISTINCT enabled AS e FROM customer_snapshot ORDER BY e"
    ).all<{ e: number }>();
    expect(states.results?.map((r) => r.e)).toEqual([0, 1, 2]);
  });

  it("selects the hand-derived id sets with the literal parent predicates", async () => {
    const run = async (enabled: number) =>
      (await TEST_ENV.CUSTOMER_DB.prepare(
        "SELECT pickup_address_id FROM address_snapshot WHERE EXISTS " +
        "(SELECT 1 FROM customer_snapshot WHERE customer_snapshot.customer_id = address_snapshot.customer_id " +
        "AND customer_snapshot.enabled = ?) ORDER BY pickup_address_id"
      ).bind(enabled).all<{ pickup_address_id: number }>()).results?.map((r) => r.pickup_address_id);
    expect(await run(1)).toEqual(PARENT_TRUE_IDS);
    expect(await run(0)).toEqual(PARENT_FALSE_IDS);
    expect(await run(2)).toEqual(NONCANONICAL_IDS);
  });
});

describe("parent mounted OpenAPI contract", () => {
  type Operation = {
    operationId?: string;
    "x-access"?: string;
    "x-effect"?: string;
    description?: string;
    parameters?: Array<{
      in?: string; name?: string; required?: boolean; description?: string;
      example?: unknown; schema?: Record<string, unknown>;
    }>;
    responses?: Record<string, { description?: string }>;
  };
  async function fetchAddressOperations() {
    const response = await exports.default.fetch(`${ORIGIN}/openapi.json`);
    expect(response.status).toBe(200);
    const doc = await response.json() as { paths: Record<string, Record<string, Operation>> };
    return doc.paths;
  }

  it("publishes parentCustomerEnabled as an optional true|false|any enum on the address list", async () => {
    const paths = await fetchAddressOperations();
    const operation = paths[PATH]?.get;
    expect(operation).toBeDefined();
    const param = (operation!.parameters ?? []).find((p) => p.in === "query" && p.name === "parentCustomerEnabled");
    expect(param, "mounted OpenAPI must advertise parentCustomerEnabled").toBeDefined();
    expect(param!.required).toBe(false);
    expect(param!.schema).toMatchObject({ type: "string", enum: ["true", "false", "any"], default: "any" });
    const example = param!.example ?? (param!.schema as Record<string, unknown>)?.example;
    expect(["true", "false", "any"]).toContain(example);
    const prose = `${param!.description ?? ""} ${operation!.description ?? ""}`;
    expect(prose).toMatch(/mirror|stored/i);
    expect(prose).toMatch(/\bAND\b|intersect/i);
    expect(prose).toMatch(/independent/i);
    // Mirrored state is not live account truth.
    for (const term of ["eligibility", "permission", "billing", "authorization"]) {
      expect(prose).toMatch(new RegExp(`not[^.]{0,120}${term}`, "i"));
    }
  });

  it("keeps the list operation identity, access class and effect class", async () => {
    const paths = await fetchAddressOperations();
    const operation = paths[PATH]?.get;
    expect(operation?.operationId).toBe("listAddressSnapshot");
    expect(operation?.["x-access"]).toBe("read");
    expect(operation?.["x-effect"]).toBe("local-read");
    for (const name of ["parentCustomerEnabled", "enabled"]) expect(operation?.description).toContain(name);
  });

  it("names parentCustomerEnabled in the list 400 correction guidance", async () => {
    const paths = await fetchAddressOperations();
    const description = paths[PATH]?.get?.responses?.["400"]?.description ?? "";
    expect(description).toContain("parentCustomerEnabled");
    expect(description).toMatch(/repeat|duplicate/i);
    expect(description).toMatch(/blank|empty/i);
    expect(description).toMatch(/before.*D1/i);
  });

  it("keeps the selector address-only", async () => {
    const paths = await fetchAddressOperations();
    for (const path of [
      "/api/v1/customer-snapshot", "/api/v1/container-snapshot",
      "/api/v1/customer-snapshot/changes", "/api/v1/address-snapshot/{pickupAddressId}"
    ]) {
      const names = (paths[path]?.get?.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name);
      expect(names, path).not.toContain("parentCustomerEnabled");
    }
  });

  it("keeps the unknown-name ignore policy on the address list", async () => {
    const bare = await page({});
    const bogus = await page("bogus_param=1");
    expect(bogus.body).toEqual(bare.body);
    expect(bogus.recorder.statements).toEqual(bare.recorder.statements);
  });
});

describe("parent agent guidance: inventory, recipe and changelog", () => {
  it("inventories the selector only on the address list and links this oracle", () => {
    const row = (path: string) =>
      policyDoc.split("\n").find((line) => line.startsWith(`| \`${path}\` |`)) ?? "";
    expect(row(PATH), "address row").toContain("`parentCustomerEnabled`");
    expect(row("/api/v1/customer-snapshot"), "customer row").not.toContain("parentCustomerEnabled");
    expect(row("/api/v1/container-snapshot"), "container row").not.toContain("parentCustomerEnabled");
    expect(policyDoc).toContain("test/addressParentCustomerEnabled.acceptance.test.ts");
  });

  it("explains mirrored parent state is not eligibility, permission, billing or authorization", () => {
    const sections = policyDoc.split(/^#{1,6} /m).filter((s) => s.includes("parentCustomerEnabled"));
    const guidance = sections.join("\n");
    expect(guidance).toMatch(/parentCustomerEnabled/);
    expect(guidance).toMatch(/mirror|stored/i);
    for (const term of ["eligibility", "permission", "billing", "authorization"]) {
      expect(guidance).toMatch(new RegExp(`not[^.]{0,120}${term}`, "i"));
    }
    expect(guidance).toMatch(/independent/i);
  });

  it("publishes local synthetic true/false recipes that can be traversed", () => {
    const blocks = [...quickstartDoc.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((m) => m[1]);
    for (const value of ["true", "false"]) {
      const recipe = blocks.find((b) => b.includes(`parentCustomerEnabled=${value}`));
      expect(recipe, `local ${value} recipe`).toBeDefined();
      expect(recipe).toContain(PATH);
      expect(recipe).toContain("localhost:8787");
      expect(recipe).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
    }
    // Independent parent/site-state recipe: both selectors appear together.
    expect(blocks.some((b) => b.includes("parentCustomerEnabled=") && b.includes("enabled="))).toBe(true);
    expect(blocks.some((b) => b.includes("parentCustomerEnabled=") && /cursor|rel=.next|[Ll]ink/.test(b))).toBe(true);
    expect(changelog.split(/^## /m)[1]).toContain("parentCustomerEnabled");
  });

  it("exposes a named local-only focused check that includes this acceptance suite", () => {
    const command = focusedChecks["address-parent-customer-enabled"];
    expect(command).toEqual(expect.any(String));
    expect(command).toMatch(/vitest\s+run/);
    expect(command).toContain("test/addressParentCustomerEnabled.acceptance.test.ts");
    expect(command).not.toMatch(/--remote|deploy|probe:post-deploy/);
  });
});

describe("parent preserves compatible merged behavior", () => {
  it("keeps the bare list: all rows ascending with a counted total", async () => {
    const { body } = await page({});
    expect(ids(body)).toEqual(ALL_IDS);
    expect(body.total).toBe(10);
  });

  it.each([
    { enabled: "true", expected: [11, 13, 21, 32, 51], total: 5 },
    { enabled: "false", expected: [12, 22, 31, 41, 52], total: 5 },
    { enabled: "any", expected: ALL_IDS, total: 10 },
  ])("keeps enabled=$enabled membership and totals", async ({ enabled, expected, total }) => {
    const { body } = await page({ enabled });
    expect(ids(body)).toEqual(expected);
    expect(body.total).toBe(total);
  });

  it("keeps the street-text substring filter and whitespace-only ignore", async () => {
    const needle = await page({ q: NEEDLE });
    expect(ids(needle.body)).toEqual([11, 21, 31, 51]);
    const blank = await page({ q: "   " });
    expect(ids(blank.body)).toEqual(ALL_IDS);
    expect(blank.recorder.statements[0].sql).not.toContain("instr(");
  });

  it("keeps customer and pickup-address identity filters", async () => {
    expect(ids((await page({ customerId: "101" })).body)).toEqual([11, 12, 13]);
    expect(ids((await page({ pickupAddressId: "41" })).body)).toEqual([41]);
  });

  it("keeps descending primary-key order without the selector", async () => {
    const { body } = await page({ order: "desc" });
    expect(ids(body)).toEqual([...ALL_IDS].reverse());
  });

  it("keeps count-free mode without the selector", async () => {
    const counted = await page({});
    const free = await page({ includeTotal: "false" });
    expect(free.body.rows).toEqual(counted.body.rows);
    expect(free.body.total).toBeNull();
    expect(free.recorder.statements).toHaveLength(1);
  });

  it("keeps the by-id read returning the stored site row", async () => {
    const { response } = await call({}, { path: `${PATH}/11` });
    expect(response.status).toBe(200);
    const row = await response.json() as Record<string, unknown>;
    expect(row.pickup_address_id).toBe(11);
    expect(row.customer_id).toBe(101);
  });

  it("ignores parentCustomerEnabled as an unknown name on the sibling lists", async () => {
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/container-snapshot"]) {
      const bare = await call({}, { path });
      const bareBody = await bare.response.json() as Body;
      const withSelector = await call({ parentCustomerEnabled: "true" }, { path });
      expect(withSelector.response.status).toBe(200);
      expect(await withSelector.response.json()).toEqual(bareBody);
      expect(withSelector.recorder.statements).toEqual(bare.recorder.statements);
    }
  });
});

describe("parent legacy missing-parent links (SQL semantics, no impossible fixture)", () => {
  // Normal FK-enforced D1 cannot store an address with a missing customer
  // (probed: PRAGMA foreign_keys=OFF is ignored by the D1 API and dropping
  // the middle table fails on the container FK). Like the hasContainers
  // oracle, missing-parent behavior is therefore pinned at the SQL-semantics
  // level: omission/any adds no parent predicate (proven above), so
  // unconstrained reads cannot hide legacy orphans; explicit true/false use
  // a plain correlated EXISTS equality which by SQL semantics cannot match
  // a NULL or dangling link.
  it("uses a plain correlated equality with no null-tolerant shape", async () => {
    const result = await page({ parentCustomerEnabled: "true" });
    for (const statement of result.recorder.statements) {
      const where = statement.sql.slice(statement.sql.search(/\bWHERE\b/i));
      // By SQL semantics a plain EXISTS equality cannot match NULL or a
      // dangling link; null-tolerant shapes would.
      expect(where).not.toMatch(/\bIS\s+NULL\b/i);
      expect(where).not.toMatch(/\bIS\s+NOT\s+DISTINCT\s+FROM\b/i);
      expect(where).not.toMatch(/\bLEFT\s+(?:OUTER\s+)?JOIN\b/i);
      expect(where).not.toMatch(/\bOR\b.*customer_snapshot/i);
    }
  });
});
