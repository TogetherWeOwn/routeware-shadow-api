/// <reference types="vite/client" />

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import snapshotDoc from "../CUSTOMER_SNAPSHOT.md?raw";
import packageJson from "../package.json";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent outcome oracle, derived from the specification, not build diffs.
 * Run: npx vitest run --maxWorkers=2 test/customerEnabledDescendants.acceptance.test.ts
 *
 * Contract pinned: ONLY on the ordinary customer snapshot list GET, add the
 * single exact enums `hasEnabledAddresses=true|false|any` and
 * `hasEnabledContainers=true|false|any` (default `any`).
 * - `hasEnabledAddresses=true`: at least one stored address with
 *   `customer_id` = the customer AND address `enabled` exactly 1.
 * - `hasEnabledContainers=true`: at least one stored container reachable
 *   through ANY stored address of the customer with container `enabled`
 *   exactly 1; the intermediate address's own `enabled` is irrelevant.
 * - Each `false` is the exact NOT-EXISTS complement: zero descendants at that
 *   level OR descendants all non-1. Noncanonical stored enabled values (2)
 *   never count as enabled. Omission/`any` adds no predicate. Customer
 *   `enabled` stays fully independent. COUNT and page share predicates;
 *   `countOnly`/`includeTotal=false`, canonical IDs, sparse projection,
 *   order/cursor/`lowerId`/`upperId`/`exactNext`, `strictQuery`, ETag/304 and
 *   no-store are preserved. Relative next links retain effective selectors in
 *   both directions and across offset-to-seek; `any`/default is omitted.
 *   Invalid/blank/repeated values fail after auth, before D1/304, with fixed
 *   value-free next-action guidance. Enabled-descendant presence is mirrored
 *   report state, not account eligibility, live service status, deployment
 *   proof or authorization. No upstream/R2 access or writes.
 *
 * Hand-derived fixture oracle (all synthetic; child IDs differ from parent
 * IDs, except site 20 under account 19 which equals another account's ID and
 * traps a nested correlation written on the wrong key; enabled=2 is a
 * noncanonical stored decoy the INTEGER column admits):
 *  11 en=1: no sites.            12 en=1: site 101(en=1), no equipment.
 *  13 en=0: site 102(en=0) holding the only enabled equipment 201.
 *  14 en=1: site 103(en=1) with only disabled equipment 202/203.
 *  15 en=0: sites 104/105 (en=0), equipment 204(en=0).
 *  16 en=1: site 106(en=0) with enabled equipment 205/213; site 107(en=1)
 *           with disabled equipment 206/214.
 *  17 en=1: site 108(en=2) with equipment 208(en=2).
 *  18 en=0: site 109(en=1) with equipment 209(en=2) and 210(en=0).
 *  19 en=1: site 20(en=0) with enabled equipment 211.
 *  20 en=1: no sites.   21 en=0: site 110(en=1) with enabled equipment 212.
 *  22 en=0: no sites.
 * hasEnabledAddresses=true  [12,14,16,18,21]; false [11,13,15,17,19,20,22].
 * hasEnabledContainers=true [13,16,19,21];    false [11,12,14,15,17,18,20,22].
 *
 * Mutation targets: ignored/reversed selectors; `false` narrowed to
 * childless-only or to all-disabled-only (an EXISTS(enabled=0) debond);
 * truths requiring the intermediate site to be enabled; same-site coupling
 * between the two selectors; noncanonical values counted as enabled;
 * uncorrelated or wrong-key EXISTS; JOIN-expanded duplicate parents;
 * conflated account/site/equipment enabled states; divergent COUNT/page
 * predicates or binds; payload work in countOnly, COUNT in count-free;
 * lost selectors in continuation; stale representation validators;
 * validation after auth/SQL/304; reflection of submitted markers.
 *
 * Real migrated local D1 executes product reads. Only fixture setup writes.
 * Network, R2, browser, D1 writes and hidden batch work are denied. All data
 * is synthetic. EXPLAIN is local planner evidence, not a latency guarantee.
 * Builder consumes this immutable handoff; oracle corrections stay
 * test-owned. This suite intentionally remains RED until the paired
 * implementation lands.
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/customer-snapshot";
const ORIGIN = "https://customer-enabled-descendants.test.invalid";
const STAMP = "2026-01-02T03:04:05.000Z";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
const SELECTORS = ["hasEnabledAddresses", "hasEnabledContainers"] as const;
const ALL = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
const ENABLED_ADDR = [12, 14, 16, 18, 21];
const NO_ENABLED_ADDR = [11, 13, 15, 17, 19, 20, 22];
const ENABLED_CONT = [13, 16, 19, 21];
const NO_ENABLED_CONT = [11, 12, 14, 15, 17, 18, 20, 22];
const CUSTOMERS = [
  [11, 1, "Synthetic Needle 11", "CUST+& 001", "SITE/one", "+1 202 5550107", null, "red marker"],
  [12, 1, "Synthetic Needle 12", "CUST+& 001", null, null, null, "other note"],
  [13, 0, "Synthetic Other 13", "OTHER-13", null, null, null, "red marker"],
  [14, 1, "Synthetic Needle 14", "OTHER-14", "SITE/one", null, "5550107 EXT9", "other note"],
  [15, 0, "Synthetic Other 15", "CUST+& 001", null, null, null, "other note"],
  [16, 1, "Synthetic Needle 16", "OTHER-16", "SITE/one", "+1 202 5550107", null, "red marker"],
  [17, 1, "Synthetic Other 17", "OTHER-17", null, null, null, "other note"],
  [18, 0, "Synthetic Needle 18", "OTHER-18", null, null, null, "other note"],
  [19, 1, "Synthetic Other 19", "OTHER-19", null, null, null, "other note"],
  [20, 1, "Synthetic Needle 20", "OTHER-20", null, null, null, "other note"],
  [21, 0, "Synthetic Other 21", "CUST+& 001", null, "+1 202 5550107", "5550107 EXT9", "red marker"],
  [22, 0, "Synthetic Other 22", "OTHER-22", null, null, null, "other note"],
] as const;
const SITES: Array<[number, number, number, string, number]> = [
  [101, 12, 7, "001", 1], [102, 13, 7, "001", 0], [103, 14, 7, "001", 1],
  [104, 15, 8, "001", 0], [105, 15, 7, "other", 0], [106, 16, 8, "other", 0],
  [107, 16, 7, "001", 1], [108, 17, 7, "001", 2], [109, 18, 7, "001", 1],
  [20, 19, 7, "001", 0], [110, 21, 7, "001", 1],
];
const CONTAINERS: Array<[number, number, number]> = [
  [201, 102, 1], [202, 103, 0], [203, 103, 0], [204, 104, 0],
  [205, 106, 1], [213, 106, 1], [206, 107, 0], [214, 107, 0],
  [208, 108, 2], [209, 109, 2], [210, 109, 0], [211, 20, 1], [212, 110, 1],
];
type Query = Record<string, string>;
type Body = { rows: Record<string, unknown>[]; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[]; method: string };
const ids = (body: Body) => body.rows.map(row => row.customer_id);
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
let effects: string[];
let beforeState: unknown;

function recordDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const fetched: number[] = [];
  const forbid = (effect: string): never => { effects.push(effect); throw new Error("Unexpected effect in enabled-descendant GET"); };
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
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Enabled-descendant-oracle", ...options.headers });
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
  expect(response.headers.get("x-request-id")).toBe("Enabled-descendant-oracle");
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
  } else if (!counted) {
    expect(body.total).toBeNull();
  }
  expect(result.response.headers.has("link")).toBe(body.nextCursor !== null);
  expect(new Set(ids(body)).size).toBe(body.rows.length);
  for (const row of body.rows) {
    expect(typeof row.customer_id).toBe("number");
    for (const field of ["addresses", "address_count", "containers", "container_count", "pickup_address_id", "container_id", "route_id", "franchise_id"]) expect(row).not.toHaveProperty(field);
    expect(Object.values(row).every(v => v === null || typeof v !== "object")).toBe(true);
  }
  return { ...result, body, bytes };
}
function expectPage(result: Awaited<ReturnType<typeof page>>, want: readonly number[], total: number | null, next: number | null = null) {
  expect(ids(result.body)).toEqual(want);
  expect(result.body.total).toBe(total);
  expect(result.body.nextCursor).toBe(next);
}
async function expectAllModes(query: Query, want: readonly number[]) {
  expectPage(await page(query), want, want.length);
  expectPage(await page({ ...query, includeTotal: "false" }), want, null);
  expectPage(await page({ ...query, countOnly: "true" }), [], want.length);
}
function nextTarget(result: Awaited<ReturnType<typeof page>>, expected: Query) {
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
  // Inserted in reverse order so result order proves the query's ORDER BY.
  await db.batch([...CUSTOMERS].reverse().map((row) => db.prepare(
    "INSERT INTO customer_snapshot (customer_id, enabled, company_name, customer_number, sub_customer_number, phone1, phone2, comments, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(...row, STAMP)));
  await db.batch([...SITES].reverse().map((site) => db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, enabled, address, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(site[0], site[1], site[2], site[3], site[4], `Synthetic site ${site[0]}`, STAMP)));
  await db.batch([...CONTAINERS].reverse().map((box) => db.prepare(
    "INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, synced_at) VALUES (?, ?, ?, ?)"
  ).bind(box[0], box[1], box[2], STAMP)));
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(effects).toEqual([]);
    expect(await state(), "GET must not mutate the mirrored rows").toEqual(beforeState);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe("enabled-descendant selection: exact stored truth tables", () => {
  it.each([
    ["an enabled site is required, disabled-only and no-site accounts stay out", { hasEnabledAddresses: "true" }, ENABLED_ADDR],
    ["false is the whole complement: no sites, disabled-only and noncanonical-only", { hasEnabledAddresses: "false" }, NO_ENABLED_ADDR],
    ["enabled equipment counts through any site, enabled or not", { hasEnabledContainers: "true" }, ENABLED_CONT],
    ["false is the whole complement: no equipment, disabled-only and noncanonical-only", { hasEnabledContainers: "false" }, NO_ENABLED_CONT],
    ["both true intersect independently", { hasEnabledAddresses: "true", hasEnabledContainers: "true" }, [16, 21]],
    ["an enabled site does not imply enabled equipment", { hasEnabledAddresses: "true", hasEnabledContainers: "false" }, [12, 14, 18]],
    ["enabled equipment does not imply an enabled site", { hasEnabledAddresses: "false", hasEnabledContainers: "true" }, [13, 19]],
    ["both false keeps every account with neither", { hasEnabledAddresses: "false", hasEnabledContainers: "false" }, [11, 15, 17, 20, 22]],
    // The two new selectors must not collapse into merged addressEnabled:
    // addressEnabled asks "some site has this enabled state", so false there
    // is narrower than "no site is enabled".
    ["merged addressEnabled=true alone agrees on this fixture", { addressEnabled: "true" }, ENABLED_ADDR],
    ["merged addressEnabled=false means some site is exactly 0, a different set", { addressEnabled: "false" }, [13, 15, 16, 19]],
    ["no enabled site AND some site exactly 0", { hasEnabledAddresses: "false", addressEnabled: "false" }, [13, 15, 19]],
    ["some enabled site AND some disabled site on the same account", { hasEnabledAddresses: "true", addressEnabled: "false" }, [16]],
    ["no enabled site with the merged cohort scope", { hasEnabledAddresses: "false", addressRouteId: "7", addressFranchiseId: "001", addressEnabled: "false" }, [13, 19]],
  ] as Array<[string, Query, readonly number[]]>)("%s agrees across page, count-free and COUNT-only", async (_name, query, want) => {
    await expectAllModes(query, want);
  });

  it("the disabled-address-only account holding the sole enabled container matches containers=true and addresses=false", async () => {
    await expectAllModes({ customerId: "13", hasEnabledContainers: "true", hasEnabledAddresses: "false" }, [13]);
    await expectAllModes({ customerId: "19", hasEnabledContainers: "true", hasEnabledAddresses: "false" }, [19]);
    await expectAllModes({ customerId: "13", hasEnabledContainers: "true", hasEnabledAddresses: "true" }, []);
  });

  it("truth needs no same-site coupling: enabled site here, enabled equipment through a disabled site", async () => {
    await expectAllModes({ customerId: "16", hasEnabledAddresses: "true", hasEnabledContainers: "true" }, [16]);
  });

  it("noncanonical stored enabled values never count as enabled at either level", async () => {
    await expectAllModes({ customerId: "17", hasEnabledAddresses: "true" }, []);
    await expectAllModes({ customerId: "17", hasEnabledContainers: "true" }, []);
    await expectAllModes({ customerId: "17", hasEnabledAddresses: "false", hasEnabledContainers: "false" }, [17]);
    await expectAllModes({ customerId: "18", hasEnabledContainers: "true" }, []);
    await expectAllModes({ customerId: "18", hasEnabledAddresses: "true", hasEnabledContainers: "false" }, [18]);
  });

  it("control: omission and any add no child predicate, bytes or SQL, even beside merged child scopes", async () => {
    const plain = await page();
    for (const query of [
      { hasEnabledAddresses: "any" },
      { hasEnabledContainers: "any" },
      { hasEnabledAddresses: "any", hasEnabledContainers: "any", strictQuery: "true" },
    ] as Query[]) {
      const any = await page(query);
      expectPage(any, ALL, 12);
      expect(any.bytes).toBe(plain.bytes);
      expect(any.recorder.statements).toEqual(plain.recorder.statements);
      for (const s of any.recorder.statements) expect(s.sql).not.toMatch(/address_snapshot|container_snapshot|\bEXISTS\b|\bJOIN\b/i);
    }
    expectPage(plain, ALL, 12);
  });

  it("all read-capable roles use local idempotent reads without child expansion", async () => {
    const first = await page({ hasEnabledContainers: "true" });
    expectPage(first, ENABLED_CONT, 4);
    expect((await page({ hasEnabledContainers: "true" })).bytes).toBe(first.bytes);
    for (const token of ["test-read-token", "test-api-token", "test-sync-secret"]) {
      const result = await request({ hasEnabledContainers: "true" }, { token });
      expect(result.response.status).toBe(200);
      expect(await result.response.text()).toBe(first.bytes);
    }
  });
});

describe("enabled-descendant selection: independence and AND composition", () => {
  it.each([
    ["true", "true", "hasEnabledAddresses", [12, 14, 16]],
    ["true", "false", "hasEnabledAddresses", [11, 17, 19, 20]],
    ["false", "true", "hasEnabledAddresses", [18, 21]],
    ["false", "false", "hasEnabledAddresses", [13, 15, 22]],
    ["true", "true", "hasEnabledContainers", [16, 19]],
    ["true", "false", "hasEnabledContainers", [11, 12, 14, 17, 20]],
    ["false", "true", "hasEnabledContainers", [13, 21]],
    ["false", "false", "hasEnabledContainers", [15, 18, 22]],
  ] as const)("account enabled=%s and %s=%s stay fully independent", async (accountEnabled, selectorValue, selector, want) => {
    await expectAllModes({ enabled: accountEnabled, [selector]: selectorValue }, want);
  });

  it.each([
    ["no sites contradicts enabled-site presence", { hasAddresses: "false", hasEnabledAddresses: "true" }, []],
    ["no sites contradicts enabled-equipment presence", { hasAddresses: "false", hasEnabledContainers: "true" }, []],
    ["stored sites but none enabled", { hasAddresses: "true", hasEnabledAddresses: "false" }, [13, 15, 17, 19]],
    ["stored sites but no enabled equipment", { hasAddresses: "true", hasEnabledContainers: "false" }, [12, 14, 15, 17, 18]],
    ["no sites is contained in both complements", { hasAddresses: "false", hasEnabledAddresses: "false", hasEnabledContainers: "false" }, [11, 20, 22]],
    ["stored sites with both truths", { hasAddresses: "true", hasEnabledAddresses: "true", hasEnabledContainers: "true" }, [16, 21]],
  ] as Array<[string, Query, number[]]>)("hasAddresses truth table: %s", async (_name, query, want) => {
    await expectAllModes(query, want);
  });

  it("control: merged hasContainers counts stored equipment regardless of its enabled state", async () => {
    await expectAllModes({ hasContainers: "true" }, [13, 14, 15, 16, 17, 18, 19, 21]);
    await expectAllModes({ hasContainers: "false" }, [11, 12, 20, 22]);
    const scoped = await page({ hasContainers: "true" });
    const any = await page({ hasContainers: "true", hasEnabledAddresses: "any", hasEnabledContainers: "any" });
    expect(any.bytes).toBe(scoped.bytes);
    expect(any.recorder.statements).toEqual(scoped.recorder.statements);
  });

  // Catch ignored hasContainers, conflating stored presence with enabled
  // presence, or OR-combining independently selected descendant cohorts.
  it.each([
    ["stored equipment AND enabled sites", { hasContainers: "true", hasEnabledAddresses: "true" }, [14, 16, 18, 21]],
    ["stored equipment AND no enabled sites", { hasContainers: "true", hasEnabledAddresses: "false" }, [13, 15, 17, 19]],
    ["no equipment AND enabled sites", { hasContainers: "false", hasEnabledAddresses: "true" }, [12]],
    ["no equipment AND no enabled sites", { hasContainers: "false", hasEnabledAddresses: "false" }, [11, 20, 22]],
    ["stored equipment AND enabled equipment", { hasContainers: "true", hasEnabledContainers: "true" }, [13, 16, 19, 21]],
    ["stored equipment AND no enabled equipment includes noncanonical-only rows", { hasContainers: "true", hasEnabledContainers: "false" }, [14, 15, 17, 18]],
    ["no equipment contradicts enabled equipment", { hasContainers: "false", hasEnabledContainers: "true" }, []],
    ["no equipment is contained in the enabled-equipment complement", { hasContainers: "false", hasEnabledContainers: "false" }, [11, 12, 20, 22]],
    ["stored equipment with both enabled truths need not share a site", { hasContainers: "true", hasEnabledAddresses: "true", hasEnabledContainers: "true" }, [16, 21]],
    ["stored equipment with neither enabled truth keeps disabled and noncanonical descendants", { hasContainers: "true", hasEnabledAddresses: "false", hasEnabledContainers: "false" }, [15, 17]],
    ["no equipment with neither enabled truth also includes childless accounts", { hasContainers: "false", hasEnabledAddresses: "false", hasEnabledContainers: "false" }, [11, 20, 22]],
    ["any equipment presence adds no predicate to enabled truth", { hasContainers: "any", hasEnabledContainers: "true" }, [13, 16, 19, 21]],
  ] as Array<[string, Query, number[]]>)("hasContainers composition: %s agrees across all modes", async (_name, query, want) => {
    await expectAllModes({ ...query, strictQuery: "true" }, want);
  });

  it.each([
    ["primary ID", { hasEnabledAddresses: "true", customerId: "14" }, [14]],
    ["nonmatching primary ID", { hasEnabledAddresses: "true", customerId: "13" }, []],
    ["IDs cannot OR-leak a disabled-only account", { hasEnabledContainers: "true", ids: "11,12,13,14,17,21" }, [13, 21]],
    ["company text", { hasEnabledAddresses: "true", q: "needle" }, [12, 14, 16, 18]],
    ["other company text with equipment truth", { hasEnabledContainers: "true", q: "other", ids: "11,12,13,14,15,16,17,18,19,20,21,22" }, [13, 19, 21]],
    ["exact account number", { hasEnabledAddresses: "true", customerNumber: "CUST+& 001" }, [12, 21]],
    ["exact account number with equipment complement", { hasEnabledContainers: "false", customerNumber: "CUST+& 001" }, [11, 12, 15]],
    ["exact sub-account", { hasEnabledContainers: "true", subCustomerNumber: "SITE/one" }, [16]],
    ["stored phone fragment stays inside the AND", { hasEnabledContainers: "false", phone: "5550107" }, [11, 14]],
    ["stored comment fragment", { hasEnabledContainers: "true", comments: "red" }, [13, 16, 21]],
    ["phone-slot presence", { hasPhone1: "true", hasEnabledAddresses: "false" }, [11]],
    ["phone-slot presence with equipment truth", { hasPhone1: "true", hasEnabledContainers: "true" }, [16, 21]],
    ["second phone slot", { hasPhone2: "true", hasEnabledAddresses: "true", hasEnabledContainers: "false" }, [14]],
    ["child route scope alone", { addressRouteId: "8", hasEnabledContainers: "true" }, [16]],
    ["all merged selectors intersect", { hasEnabledAddresses: "true", hasEnabledContainers: "true", hasAddresses: "true", hasContainers: "true", enabled: "false", ids: "11,12,13,14,15,16,17,18,19,20,21,22", customerNumber: "CUST+& 001", addressRouteId: "7", addressFranchiseId: "001", addressEnabled: "true", hasPhone1: "true", hasPhone2: "true", comments: "red", phone: "5550107", lowerId: "20", upperId: "21", strictQuery: "true" }, [21]],
  ] as Array<[string, Query, number[]]>)("%s constrains rows and totals", async (_name, query, want) => {
    await expectAllModes(query, want);
  });
});

describe("enabled-descendant selection: SQL shape and representation budgets", () => {
  it("correlated EXISTS/NOT EXISTS over both FK keys serve COUNT and page identically, without joins", async () => {
    const query = { hasEnabledAddresses: "true", hasEnabledContainers: "false", ids: "11,12,13,14,15,16,17,18,19,20,21,22", q: "synthetic", limit: "2" };
    const result = await page(query);
    expectPage(result, [12, 14], 3, 14);
    const count = result.recorder.statements.find(isCount)!;
    const select = result.recorder.statements.find(s => !isCount(s))!;
    const where = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).replace(/\s+ORDER\s+BY[\s\S]*$/i, "").trim();
    expect(where(count.sql)).toBe(where(select.sql));
    expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
    for (const s of [count, select]) {
      expect(s.sql).toMatch(/\bEXISTS\s*\(/i);
      expect(s.sql).toMatch(/\bNOT\s+EXISTS\s*\(/i);
      expect(s.sql).toMatch(/address_snapshot/i);
      expect(s.sql).toMatch(/container_snapshot/i);
      expect(s.sql).toMatch(/customer_id/);
      expect(s.sql).toMatch(/pickup_address_id/);
      expect(s.sql).toMatch(/enabled\s*=\s*1|enabled\s*=\s*\?/i);
      expect(s.sql).not.toMatch(/\bJOIN\b/i);
      for (const raw of ["true", "false", "any"]) expect(s.binds).not.toContain(raw);
    }
    const free = await page({ ...query, includeTotal: "false" });
    expect(free.body.rows).toEqual(result.body.rows);
    expect(free.recorder.statements).toEqual([select]);
    const only = await page({ ...query, countOnly: "true", fields: "enabled", exactNext: "true", offset: "1" });
    expectPage(only, [], 3);
    expect(only.recorder.statements).toEqual([count]);
  });

  it("a lone selector adds only its own reachability: containers alone never filters the site's enabled state away", async () => {
    const onlySites = await page({ hasEnabledAddresses: "true" });
    for (const s of onlySites.recorder.statements) {
      expect(s.sql).toMatch(/address_snapshot/i);
      expect(s.sql).not.toMatch(/container_snapshot/i);
    }
    // Semantic, not textual: accounts 13/19 qualify only because their sole
    // sites are disabled, and 14 stays out although its site is enabled.
    const onlyBoxes = await page({ hasEnabledContainers: "true" });
    expectPage(onlyBoxes, ENABLED_CONT, 4);
    for (const s of onlyBoxes.recorder.statements) expect(s.sql).toMatch(/container_snapshot/i);
  });

  it("EXPLAIN uses the existing FK indexes for the enabled-descendant lookups", async () => {
    const result = await page({ hasEnabledAddresses: "true", hasEnabledContainers: "true" });
    expectPage(result, [16, 21], 2);
    for (const s of result.recorder.statements) {
      const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).bind(...s.binds).all<{ detail: string }>();
      const details = plan.results.map(r => r.detail).join("\n");
      expect(details).toContain("idx_address_snapshot_customer_id");
      expect(details).toContain("idx_container_snapshot_pickup_address_id");
      expect(details).toMatch(/SEARCH/i);
    }
  });

  it("sparse rows retain canonical account IDs, never descendant identifiers or counts", async () => {
    const result = await page({ hasEnabledContainers: "true", fields: "enabled" });
    expect(result.body.rows).toEqual([
      { customer_id: 13, enabled: 0 }, { customer_id: 16, enabled: 1 },
      { customer_id: 19, enabled: 1 }, { customer_id: 21, enabled: 0 },
    ]);
    const complement = await page({ hasEnabledAddresses: "false", fields: "customer_number,customer_id" });
    expect(complement.body.rows).toEqual([
      { customer_id: 11, customer_number: "CUST+& 001" }, { customer_id: 13, customer_number: "OTHER-13" },
      { customer_id: 15, customer_number: "CUST+& 001" }, { customer_id: 17, customer_number: "OTHER-17" },
      { customer_id: 19, customer_number: "OTHER-19" }, { customer_id: 20, customer_number: "OTHER-20" },
      { customer_id: 22, customer_number: "OTHER-22" },
    ]);
  });

  it("merged child scopes still evaluate one shared same-site EXISTS beside the new selectors", async () => {
    const result = await page({ addressRouteId: "7", addressFranchiseId: "001", addressEnabled: "false", hasEnabledAddresses: "false", hasEnabledContainers: "true" });
    expectPage(result, [13, 19], 2);
    for (const s of result.recorder.statements) expect(s.sql).not.toMatch(/\bJOIN\b/i);
  });
});

describe("enabled-descendant selection: complete continuation traversal", () => {
  it.each([
    ["asc", { hasEnabledAddresses: "false", hasEnabledContainers: "any" }, NO_ENABLED_ADDR],
    ["desc", { hasEnabledAddresses: "false", hasEnabledContainers: "any" }, [22, 20, 19, 17, 15, 13, 11]],
    ["asc", { hasEnabledContainers: "false" }, NO_ENABLED_CONT],
    ["desc", { hasEnabledContainers: "false" }, [22, 20, 18, 17, 15, 14, 12, 11]],
    ["asc", { hasContainers: "true", hasEnabledContainers: "false" }, [14, 15, 17, 18]],
    ["desc", { hasContainers: "true", hasEnabledContainers: "false" }, [18, 17, 15, 14]],
  ] as Array<[string, Query, readonly number[]]>)("fully follows %s returned links for %j without duplicate parents, omitting any", async (order, filters, want) => {
    const query = { ...filters, order, limit: "3", includeTotal: "false", strictQuery: "true" };
    const effective = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== "any"));
    const pages: number[][] = [];
    for (let i = 0; i < want.length; i += 3) pages.push(want.slice(i, i + 3));
    // A trailing empty page is only reachable after a FULL terminal page;
    // a partial page is terminal (nextCursor null, no Link).
    if (want.length % 3 === 0) pages.push([]);
    let result = await page(query);
    const seen: unknown[] = [];
    for (let i = 0; i < pages.length; i++) {
      const full = pages[i].length === 3;
      expectPage(result, pages[i], null, full ? pages[i][pages[i].length - 1] : null);
      seen.push(...ids(result.body));
      if (result.body.nextCursor !== null) {
        result = await page(nextTarget(result, { ...effective, cursor: String(result.body.nextCursor) }));
      }
    }
    expect(seen).toEqual([...want]);
    expect(new Set(seen).size).toBe(want.length);
  });

  it("counted links preserve both selectors and cursor-relative totals to the terminal page", async () => {
    const filters = { hasEnabledAddresses: "true", hasEnabledContainers: "false", limit: "2" };
    let result = await page(filters);
    expectPage(result, [12, 14], 3, 14);
    result = await page(nextTarget(result, { ...filters, cursor: "14" }));
    // Partial page (1 of 2) is terminal: nextCursor null, no Link, so no
    // reachable trailing empty page at this limit.
    expectPage(result, [18], 1, null);
    // At limit 1 the same cohort ends on a FULL page, so the reachable
    // empty terminal page still carries the selectors and a zero total.
    const single = { hasEnabledAddresses: "true", hasEnabledContainers: "false", limit: "1" };
    let walk = await page({ ...single, cursor: "14" });
    expectPage(walk, [18], 1, 18);
    walk = await page(nextTarget(walk, { ...single, cursor: "18" }));
    expectPage(walk, [], 0);
  });

  it.each(["asc", "desc"])("merged exactNext retains both selectors and suppresses the full terminal %s page link", async order => {
    const filters = { hasEnabledAddresses: "false", hasEnabledContainers: "true", hasContainers: "true", order, includeTotal: "false", exactNext: "true", limit: "1" };
    const want = order === "asc" ? [13, 19] : [19, 13];
    let result = await page(filters);
    const seen: unknown[] = [];
    for (let i = 0; i < want.length; i++) {
      expectPage(result, [want[i]], null, i < want.length - 1 ? want[i] : null);
      seen.push(...ids(result.body));
      if (result.body.nextCursor !== null) result = await page(nextTarget(result, { ...filters, cursor: String(want[i]) }));
    }
    expect(seen).toEqual(want);
  });

  it.each(["asc", "desc"])("converts %s offset pages to seek links that keep bounds and selectors", async order => {
    const filters = { hasEnabledAddresses: "false", lowerId: "12", upperId: "21", order, fields: "enabled", limit: "2" };
    let result = await page({ ...filters, offset: "1" });
    expectPage(result, order === "asc" ? [15, 17] : [19, 17], 5, 17);
    result = await page(nextTarget(result, { ...filters, cursor: "17" }));
    // This second seek page is FULL (2 of 2), so the non-exact signal still
    // advertises one more page; following it reaches the empty terminal page.
    expectPage(result, order === "asc" ? [19, 20] : [15, 13], 2, order === "asc" ? 20 : 13);
    result = await page(nextTarget(result, { ...filters, cursor: String(result.body.nextCursor) }));
    expectPage(result, [], 0);
    expect(result.recorder.statements.every(s => !/\bOFFSET\b/i.test(s.sql))).toBe(true);
  });

  it.each([
    [{ hasEnabledAddresses: "true", cursor: "14", offset: "99", limit: "2" }, [16, 18], 3, 18],
    [{ hasEnabledContainers: "true", cursor: "19", order: "desc", limit: "2" }, [16, 13], 2, 13],
    // Offset terminal pages are terminal even when partly filled.
    [{ hasEnabledContainers: "false", offset: "7", limit: "2" }, [22], 8, null],
    [{ hasEnabledContainers: "false", offset: "8", limit: "2" }, [], 8, null],
    [{ hasEnabledAddresses: "false", lowerId: "12", upperId: "21" }, [13, 15, 17, 19, 20], 5, null],
    [{ hasEnabledContainers: "true", lowerId: "16", upperId: "19" }, [16, 19], 2, null],
    [{ hasEnabledAddresses: "true", lowerId: "18", upperId: "12" }, [], 0, null],
    [{ hasEnabledAddresses: "true", upperId: "11" }, [], 0, null],
  ] as Array<[Query, number[], number, number | null]>)("seek/offset/bounds %j apply to the selected cohort", async (query, want, total, next) => {
    expectPage(await page(query), want, total, next);
    expectPage(await page({ ...query, countOnly: "true" }), [], total);
  });

  it("round-trips encoded business keys and both selectors, never unknown keys, credentials or hostile origins", async () => {
    const filters = {
      hasEnabledAddresses: "true", hasEnabledContainers: "true", customerNumber: "CUST+& 001",
      ids: "11,12,14,16,21", q: "other", comments: "red", hasPhone2: "true",
      hasAddresses: "true", hasContainers: "true", fields: "enabled", limit: "1", includeTotal: "false",
    };
    const clean = await page(filters);
    // The page is full at limit 1, so a next Link to the empty terminal page exists.
    expectPage(clean, [21], null, 21);
    const search = new URLSearchParams(filters).toString();
    const tainted = await page(`${search}&token=query-marker&unknown=secret-marker&redirect=https%3A%2F%2Fhost-marker.invalid`,
      { host: "host-marker.invalid", origin: ORIGIN, "x-forwarded-host": "forward-marker.invalid" });
    expect(tainted.bytes).toBe(clean.bytes);
    expect(tainted.recorder.statements).toEqual(clean.recorder.statements);
    expect(tainted.response.headers.get("link")).toBe(clean.response.headers.get("link"));
    expect(tainted.response.headers.get("link")).not.toMatch(/marker|Bearer|test-read-token|https?:|\/\//);
    expectPage(await page(nextTarget(tainted, { ...filters, cursor: "21" })), [], null);
  });

  it("control: explicit any on both selectors is omitted from next links", async () => {
    const result = await page({ hasEnabledAddresses: "any", hasEnabledContainers: "any", limit: "5" });
    expectPage(result, [11, 12, 13, 14, 15], 12, 15);
    const target = nextTarget(result, { limit: "5", cursor: "15" });
    for (const name of SELECTORS) expect(target.searchParams.has(name)).toBe(false);
    expectPage(await page(target), [16, 17, 18, 19, 20], 7, 20);
  });
});

describe("enabled-descendant selection: conditional representations", () => {
  it.each([{}, { includeTotal: "false" }, { countOnly: "true" }, { exactNext: "true" }] as Query[])("revalidates the served %j envelope, not an unscoped or hydrated representation", async mode => {
    const query = { hasEnabledAddresses: "true", hasEnabledContainers: "false", fields: "enabled", limit: "2", ...mode };
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
    { hasEnabledAddresses: "false" }, { hasEnabledContainers: "true" },
    { hasEnabledAddresses: "any", hasEnabledContainers: "any" },
    { hasContainers: "false" },
    { fields: "company_name" }, { includeTotal: "false" }, { cursor: "12" }, { countOnly: "true" },
  ] as Query[])("does not 304 a changed representation %j", async changes => {
    const query: Query = { hasEnabledAddresses: "true", hasEnabledContainers: "false", fields: "enabled", limit: "2" };
    const first = await page(query);
    const other = await page({ ...query, ...changes }, { "if-none-match": first.response.headers.get("etag")! });
    expect(other.bytes).not.toBe(first.bytes);
    expect(other.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
  });
});

const INVALID: Array<readonly [typeof SELECTORS[number], string]> = [
  ...SELECTORS.flatMap(key => ["", "TRUE", "True", "1", "0", "yes", " true", "false ", "true,false", "null", "secret-marker"]
    .map(value => [key, `${key}=${encodeURIComponent(value)}`] as const)),
  ...SELECTORS.map(key => [key, key] as const),
  ...SELECTORS.flatMap(key => [
    [key, `${key}=true&${key}=false`],
    [key, `${key}=any&${key}=any`],
    [key, `${key}=true&${encodeURIComponent(key[0]) === key[0] ? "%68" : ""}${key.slice(1)}=true`],
  ] as const),
];
describe("enabled-descendant selection: auth first, value-free validation, zero SQL", () => {
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
    expect(detail).toMatch(/true[\s\S]*false[\s\S]*any/);
    expect(detail).toMatch(/one|single|once/i);
    expect(detail).toMatch(/omit/i);
    expect(detail).toMatch(/retry/i);
    expect(JSON.stringify(problem)).not.toMatch(/secret-marker|TRUE|True|yes/);
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    const comparison = await request(new URLSearchParams({ [key]: "different-secret-marker" }).toString());
    expect(comparison.response.status).toBe(400);
    expect(await comparison.response.json()).toEqual(problem);
    expect(comparison.recorder.prepared).toEqual([]);
  });
  it.each([
    "hasEnabledAddresses=true", "hasEnabledContainers=false",
    "hasEnabledAddresses=secret-marker", "hasEnabledContainers=true&hasEnabledContainers=false",
  ])("control: auth wins for %s", async search => {
    for (const token of [null, "wrong-synthetic-token"]) {
      const result = await request(search, { token, headers: { "if-none-match": "*" } });
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get("content-type")).toContain("application/problem+json");
      expect(await result.response.text()).not.toMatch(/secret-marker|wrong-synthetic-token/);
      expect(result.recorder.prepared).toEqual([]);
    }
  });
  it("known encoded selector names work with strictQuery, unknown names still fail closed", async () => {
    expectPage(await page("%68asEnabledAddresses=false&hasEnabledContainers=true&strictQuery=true"), [13, 19], 2);
    const result = await request("hasEnabledContainers=true&strictQuery=true&unknown=secret-marker");
    expect(result.response.status).toBe(400);
    expect(await result.response.text()).not.toContain("secret-marker");
    expect(result.recorder.prepared).toEqual([]);
  });
  it.each([
    "/api/v1/address-snapshot",
    "/api/v1/container-snapshot",
    "/api/v1/customer-snapshot/changes",
    "/api/v1/customer-snapshot/13",
    "/api/v1/address-snapshot/102",
    "/api/v1/container-snapshot/201",
  ])("the new selectors stay ignored on %s (lists keep ignore-unknown parity)", async path => {
    const recorderFetch = async (suffix: string) => app.fetch(new Request(new URL(`${path}${suffix}`, ORIGIN), {
      headers: { authorization: "Bearer test-read-token" },
    }), TEST_ENV);
    const bare = await recorderFetch("");
    if (bare.status === 400) { await bare.text(); return; }
    const withSelectors = await recorderFetch("?hasEnabledAddresses=true&hasEnabledContainers=false");
    expect(withSelectors.status).toBe(bare.status);
    await bare.clone().text();
    expect(await withSelectors.text()).toBe(await bare.text());
  });
});

describe("enabled-descendant selection: mounted discovery and agent guidance", () => {
  type Parameter = { name: string; in: string; required?: boolean; description?: string; example?: unknown; schema?: { description?: string; example?: unknown; [key: string]: unknown } };
  type Operation = { parameters?: Parameter[]; responses?: Record<string, { description?: string }>; [key: string]: unknown };
  async function openApi() {
    const response = await app.fetch(new Request(`${ORIGIN}/openapi.json`), TEST_ENV);
    expect(response.status).toBe(200);
    return response.json() as Promise<{ paths: Record<string, { get?: Operation }> }>;
  }
  it("publishes optional exact enums with honest complement prose only on the ordinary customer list", async () => {
    const doc = await openApi();
    const operation = doc.paths[PATH]?.get;
    expect(operation).toMatchObject({ operationId: "listCustomerSnapshot", "x-access": "read", "x-effect": "local-read" });
    for (const name of SELECTORS) {
      const params = operation?.parameters?.filter(p => p.name === name);
      expect(params, name).toHaveLength(1);
      expect(params![0]).toMatchObject({ in: "query", required: false, schema: { type: "string", enum: ["true", "false", "any"], default: "any" } });
      expect(operation?.responses?.["400"]?.description).toContain(name);
      const prose = `${params![0].description ?? ""} ${params![0].schema?.description ?? ""}`;
      expect(prose, name).toMatch(/mirror|stored/i);
      expect(prose, name).toMatch(/exactly 1|stored value (?:is )?1/i);
      expect(prose, name).toMatch(/false/);
      expect(prose, name).toMatch(/zero|none|no stored/i);
      expect(prose, name).toMatch(/one|single/i);
      expect(prose, name).toMatch(/omit/i);
      expect(prose, name).toMatch(/retry/i);
      expect(prose, name).toMatch(/eligibility|live service|deployment|authori[sz]/i);
    }
    const boxes = operation!.parameters!.find(p => p.name === "hasEnabledContainers")!;
    const boxesProse = `${boxes.description ?? ""} ${boxes.schema?.description ?? ""}`;
    expect(boxesProse).toMatch(/any (?:stored )?(?:address|site)/i);
    expect(boxesProse).toMatch(/(?:intermediate|parent|site|address)[\s\S]{0,80}(irrelevant|does not matter|not (?:required|needed)|regardless)/i);
    for (const [path, item] of Object.entries(doc.paths)) {
      if (path === PATH) continue;
      for (const p of item.get?.parameters ?? []) expect(SELECTORS, path).not.toContain(p.name as typeof SELECTORS[number]);
    }
  });
  it("parameter examples are discoverable valid selectors replayable against local synthetic data", async () => {
    const doc = await openApi();
    for (const name of SELECTORS) {
      const param = doc.paths[PATH]?.get?.parameters?.find(p => p.name === name);
      expect(param, name).toBeDefined();
      const example = param!.example ?? param!.schema?.example;
      expect(["true", "false", "any"], name).toContain(example);
      const result = await page({ [name]: String(example), strictQuery: "true" });
      expect(result.body.total).toEqual(expect.any(Number));
    }
  });
  // This inventory and these recipes are machine-consumed agent instructions.
  // They must expose safe selection without suggesting authority or freshness.
  it("inventories both selectors only on the customer list and offers a local active-footprint recipe", () => {
    const row = (path: string) => policyDoc.split("\n").find(line => line.startsWith(`| \`${path}\` |`)) ?? "";
    for (const key of SELECTORS) {
      expect(row(PATH)).toContain(`\`${key}\``);
      for (const path of ["/api/v1/address-snapshot", "/api/v1/container-snapshot"]) expect(row(path)).not.toContain(key);
      expect(snapshotDoc).toContain(key);
    }
    expect(policyDoc).toContain("test/customerEnabledDescendants.acceptance.test.ts");
    const guidance = policyDoc.split(/^#{1,6} /m).filter(section => section.includes("hasEnabledContainers")).join("\n");
    expect(guidance).toMatch(/mirror|stored/i);
    expect(guidance).toMatch(/upstream/i);
    expect(guidance).toMatch(/eligibility|live service|deployment/i);
    expect(guidance).toMatch(/not (?:proof|evidence)|does not (?:prove|mean|authori[sz]e)|no (?:proof|guarantee)|never|must not/i);
    const notes = snapshotDoc.split(/^#{1,6} /m).filter(section => section.includes("hasEnabledAddresses")).join("\n");
    expect(notes).toMatch(/zero|none|no stored/i);
    expect(notes).toMatch(/mirror|stored/i);
    const blocks = [...quickstartDoc.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map(m => m[1]);
    const footprint = blocks.find(b => b.includes("hasEnabledAddresses=") && b.includes("hasEnabledContainers=") && b.includes("countOnly=true"));
    expect(footprint, "compact count-only active-footprint recipe").toBeDefined();
    expect(footprint).toContain("localhost:8787");
    expect(footprint).toContain(PATH);
    expect(footprint).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
    const commands = Object.entries(packageJson.scripts)
      .filter(([name, command]) => name.startsWith("check:") && command.includes("test/customerEnabledDescendants.acceptance.test.ts"));
    expect(commands.length).toBeGreaterThan(0);
    for (const [, command] of commands) {
      expect(command).toMatch(/vitest\s+run/);
      expect(command).not.toMatch(/--remote|deploy|probe:post-deploy/);
    }
  });
});
