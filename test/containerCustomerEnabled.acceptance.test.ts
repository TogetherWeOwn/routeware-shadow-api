import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent Test-Author oracle; every expected ID/page is hand-derived below.
 * Spec: `customerEnabled=true|false|any` (default `any`) on the container list
 * only. `true` keeps equipment whose OWNING customer (container ->
 * address.customer_id -> customer_snapshot) stores enabled exactly 1; `false`
 * keeps stored 0. Explicit true/false never matches a missing address, a
 * missing/null-linked customer, or a noncanonical stored customer enabled
 * (2, -1, NULL, text). Omission/`any` adds no predicate and preserves today's
 * unscoped visibility (including orphans and missing-customer rows).
 * Equipment `enabled` and `parentEnabled` stay independent: all eight
 * customer/address/container 0/1 combinations are seeded as containers
 * 101-108. A `customerId` that contradicts the owner's stored state yields an
 * empty 200. Joins must never fan out a container row.
 * Mutation targets: reading any customer's (or the address's, or the
 * container's) enabled instead of the owner's; truthiness (2/-1/text as true);
 * `<> 1`-style complements sweeping in noncanonical/missing rows; unconditional
 * customer joins changing unscoped/customerId visibility; COUNT/page drift;
 * lost next-link scope; pre-auth validation; stale sparse ETags.
 * Real local D1 evaluates product SQL. Only fixture setup may write. Requests
 * deny D1 writes/batch/exec, R2, browser and fetch; no production/staging probes.
 * Builder: incorporate this test commit unchanged; oracle corrections stay
 * Test-Author-owned. Expected RED until the paired implementation arrives.
 * Run: npx vitest run test/containerCustomerEnabled.acceptance.test.ts --maxWorkers=2
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/container-snapshot";
const ORIGIN = "https://container-customer-enabled.test.invalid";
const STAMP = "2026-01-02T03:04:05.000Z";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
type Query = Record<string, string> | string | URL;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
// Customer: id, stored enabled. 5/6 are noncanonical; 7/8 own nothing (decoys).
const CUSTOMERS = [[1, 1], [2, 0], [3, 1], [4, 0], [5, 2], [6, -1], [7, 1], [8, 0]] as const;
// Address: id, owning customer, parent (address) enabled.
const ADDRESSES = [
  [11, 1, 1], [12, 1, 0], [13, 2, 1], [14, 2, 0], [15, 3, 1],
  [16, 4, 1], [17, 5, 1], [18, 6, 0], [19, 1, 1], [20, 3, 0],
] as const;
// Container: id, address, equipment enabled. 101-108 are the eight
// customer/parent/equipment 0/1 combinations in binary order (111..000).
const CONTAINERS = [
  [101, 11, 1], [102, 11, 0], [103, 12, 1], [104, 12, 0],
  [105, 13, 1], [106, 13, 0], [107, 14, 1], [108, 14, 0],
  [109, 15, 1], [110, 16, 1], [111, 17, 1], [112, 17, 0],
  [113, 18, 1], [114, 19, 1], [115, 19, 1], [116, 20, 0],
] as const;
const ALL = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116];
const CUST_TRUE = [101, 102, 103, 104, 109, 114, 115, 116];
const CUST_FALSE = [105, 106, 107, 108, 110];
const NONCANONICAL = [111, 112, 113];
const ids = (body: Body) => body.rows.map(row => row.container_id);
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
let denied: string[];
let beforeState: unknown;

function recordedDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const forbid = (operation: string): never => {
    denied.push(operation);
    throw new Error("Unexpected effect in container customer-enabled oracle");
  };
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql, values),
      first: (...args: unknown[]) => {
        statements.push({ sql, binds });
        return (stmt.first as (...args: unknown[]) => unknown)(...args);
      },
      all: () => { statements.push({ sql, binds }); return stmt.all(); },
      raw: (...args: unknown[]) => {
        statements.push({ sql, binds });
        return (stmt.raw as (...args: unknown[]) => unknown)(...args);
      },
      run: () => forbid("D1 run"),
    } as unknown as D1PreparedStatement;
  }
  const db = {
    prepare: (sql: string) => {
      prepared.push(sql);
      if (!/^\s*SELECT\b/i.test(sql)) return forbid("D1 non-SELECT");
      return wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []);
    },
    batch: () => forbid("D1 batch"), exec: () => forbid("D1 exec"), dump: () => forbid("D1 dump"),
  } as unknown as D1Database;
  return { db, prepared, statements, external: () => forbid("external binding") };
}
async function state() {
  return Promise.all(["customer_snapshot", "address_snapshot", "container_snapshot"].map(table =>
    TEST_ENV.CUSTOMER_DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())).then(rows => rows.map(r => r.results));
}
async function request(query: Query = {}, options: { token?: string | null; headers?: Record<string, string> } = {}) {
  const recorder = recordedDb();
  const url = query instanceof URL ? query : new URL(PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = typeof query === "string" ? query : new URLSearchParams(query).toString();
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "CustEnabled-oracle", ...options.headers });
  const token = options.token === undefined ? "test-read-token" : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: recorder.db,
    SNAPSHOTS: Object.fromEntries(["get", "head", "list", "put", "delete", "createMultipartUpload", "resumeMultipartUpload"].map(key => [key, recorder.external])) as unknown as R2Bucket,
    BROWSER: { fetch: recorder.external } as unknown as Fetcher,
  });
  return { response, recorder, url };
}
function posture(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("vary")).toMatch(/\borigin\b/i);
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  expect(response.headers.get("x-request-id")).toBe("CustEnabled-oracle");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
function budget(result: Awaited<ReturnType<typeof request>>) {
  const q = result.url.searchParams;
  const countFree = q.get("includeTotal") === "false";
  const countOnly = q.get("countOnly") === "true";
  const statements = result.recorder.statements;
  expect(statements).toHaveLength(countFree || countOnly ? 1 : 2);
  expect(statements.filter(isCount)).toHaveLength(countFree ? 0 : 1);
  if (!countOnly) {
    const select = statements.find(s => !isCount(s))!;
    const tail = /\bOFFSET\b/i.test(select.sql) ? 2 : 1;
    expect(select.binds[select.binds.length - tail]).toBe(Number(q.get("limit") ?? 50));
    if (!countFree) expect(select.binds.slice(0, -tail)).toEqual(statements.find(isCount)!.binds);
  }
  // Effective customer scope must consult the owning-customer table in every
  // statement (join or EXISTS spelling is the Builder's choice); omission/any
  // must not consult it at all, so unscoped visibility cannot change.
  const effective = ["true", "false"].includes(q.get("customerEnabled") ?? "");
  for (const s of statements) {
    if (effective) expect(s.sql).toMatch(/\bcustomer_snapshot\b/i);
    else expect(s.sql).not.toMatch(/\bcustomer_snapshot\b/i);
  }
}
async function page(query: Query = {}, headers?: Record<string, string>) {
  const result = await request(query, { headers });
  expect(result.response.status).toBe(200);
  posture(result.response);
  budget(result);
  const bytes = await result.response.text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  if (result.url.searchParams.get("includeTotal") === "false") expect(body.total).toBeNull();
  if (result.url.searchParams.get("countOnly") === "true") {
    expect(body.rows).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  }
  // No fanout: a container id may never repeat within a page.
  expect(new Set(ids(body)).size).toBe(body.rows.length);
  return { ...result, body, bytes };
}
function next(result: Awaited<ReturnType<typeof page>>) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/container-snapshot\?[^<>\s]*>; rel="next"$/);
  const url = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(url.origin).toBe(result.url.origin);
  expect(url.pathname).toBe(PATH);
  expect(url.hash).toBe("");
  expect(url.searchParams.has("offset")).toBe(false);
  expect(url.searchParams.getAll("cursor")).toEqual([String(result.body.nextCursor)]);
  for (const [key, raw] of result.url.searchParams) {
    if (["offset", "cursor", "unknown", "redirect"].includes(key)) continue;
    const value = key === "q" ? raw.trim() : raw;
    if (["customerEnabled", "parentEnabled", "enabled"].includes(key) && value === "any") expect(url.searchParams.has(key)).toBe(false);
    else if ((key === "order" && value === "asc") || (key === "includeTotal" && value === "true")) {
      expect([[], [value]]).toContainEqual(url.searchParams.getAll(key));
    } else expect(url.searchParams.getAll(key), key).toEqual([value]);
  }
  expect(url.searchParams.has("unknown")).toBe(false);
  expect(url.searchParams.has("redirect")).toBe(false);
  expect(link).not.toContain(result.url.origin);
  return url;
}
async function hash(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}"`;
}
beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  denied = [];
  vi.stubGlobal("fetch", vi.fn(async () => { denied.push("network"); throw new Error("Unexpected outbound network in customer-enabled oracle"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot"),
    ...CUSTOMERS.map(([id, enabled]) => db.prepare("INSERT INTO customer_snapshot (customer_id, enabled, synced_at) VALUES (?, ?, ?)").bind(id, enabled, STAMP)),
  ]);
  await db.batch(ADDRESSES.map(([id, customer, enabled]) => db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, address, city, zip, synced_at) VALUES (?, ?, ?, 'Depot Site', 'Site City', '99999', ?)",
  ).bind(id, customer, enabled, STAMP)));
  await db.batch([...CONTAINERS].reverse().map(([id, parent, enabled]) => db.prepare(
    "INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, serial_number, rfid, location_address, city, state, zip, synced_at) VALUES (?, ?, ?, 'asset', 'tag', ?, 'Equipment City', 'ZZ', '02139', ?)",
  ).bind(id, parent, enabled, `Depot ${id}`, STAMP)));
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denied).toEqual([]);
    expect(await state(), "HTTP GET must not mutate the synthetic snapshot").toEqual(beforeState);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe("container customerEnabled: owning-customer state only", () => {
  it.each([
    ["true keeps stored-1 owners only", { customerEnabled: "true" }, CUST_TRUE],
    ["false keeps stored-0 owners only", { customerEnabled: "false" }, CUST_FALSE],
    ["any keeps every row including noncanonical owners", { customerEnabled: "any" }, ALL],
  ] as const)("%s", async (_name, filters, want) => {
    for (const mode of [{}, { includeTotal: "false" }, { countOnly: "true" }] as Array<Record<string, string>>) {
      const result = await page({ ...filters, ...mode });
      expect(ids(result.body)).toEqual("countOnly" in mode ? [] : want);
      expect(result.body.total).toBe("includeTotal" in mode ? null : want.length);
      expect(result.body.nextCursor).toBeNull();
      expect(result.response.headers.get("link")).toBeNull();
    }
  });
  it.each([
    ["true", "true", "true", [101]], ["true", "true", "false", [102]],
    ["true", "false", "true", [103]], ["true", "false", "false", [104]],
    ["false", "true", "true", [105]], ["false", "true", "false", [106]],
    ["false", "false", "true", [107]], ["false", "false", "false", [108]],
  ] as const)("independent customerEnabled=%s / parentEnabled=%s / enabled=%s", async (customerEnabled, parentEnabled, enabled, want) => {
    // Scope to the eight-combination cohort (customers 1/2) via ids so each
    // combination is a singleton; the extra addresses are covered separately.
    const result = await page({ customerEnabled, parentEnabled, enabled, ids: "101,102,103,104,105,106,107,108" });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
  });
  it.each([
    ["true + parent true", { customerEnabled: "true", parentEnabled: "true" }, [101, 102, 109, 114, 115]],
    ["true + parent false", { customerEnabled: "true", parentEnabled: "false" }, [103, 104, 116]],
    ["false + parent true", { customerEnabled: "false", parentEnabled: "true" }, [105, 106, 110]],
    ["false + parent false", { customerEnabled: "false", parentEnabled: "false" }, [107, 108]],
    ["true + equipment true", { customerEnabled: "true", enabled: "true" }, [101, 103, 109, 114, 115]],
    ["true + equipment false", { customerEnabled: "true", enabled: "false" }, [102, 104, 116]],
    ["false + equipment true", { customerEnabled: "false", enabled: "true" }, [105, 107, 110]],
    ["false + equipment false", { customerEnabled: "false", enabled: "false" }, [106, 108]],
    ["any + parent true (parent scope stays real)", { customerEnabled: "any", parentEnabled: "true" }, [101, 102, 105, 106, 109, 110, 111, 112, 114, 115]],
    ["any + equipment false", { customerEnabled: "any", enabled: "false" }, [102, 104, 106, 108, 112, 116]],
  ] as const)("%s AND-composes without conflating the three enabled states", async (_name, filters, want) => {
    const result = await page(filters);
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
  });
  it("noncanonical owners (stored 2 / -1) match neither true nor false, only any/omitted", async () => {
    for (const filters of [{ customerEnabled: "true" }, { customerEnabled: "false" }]) {
      const result = await page(filters);
      for (const id of NONCANONICAL) expect(ids(result.body)).not.toContain(id);
    }
    expect(ids((await page({ customerId: "5" })).body)).toEqual([111, 112]);
    expect(ids((await page({ customerId: "5", customerEnabled: "any" })).body)).toEqual([111, 112]);
    expect(ids((await page({ customerId: "5", customerEnabled: "true" })).body)).toEqual([]);
    expect(ids((await page({ customerId: "5", customerEnabled: "false" })).body)).toEqual([]);
    expect(ids((await page({ customerId: "6", customerEnabled: "true" })).body)).toEqual([]);
    expect(ids((await page({ customerId: "6", customerEnabled: "false" })).body)).toEqual([]);
  });
  it("omission and any are byte- and SQL-identical to today's unscoped list", async () => {
    const plain = await page();
    const any = await page({ customerEnabled: "any" });
    expect(ids(plain.body)).toEqual(ALL);
    expect(any.body).toEqual(plain.body);
    expect(any.bytes).toEqual(plain.bytes);
    expect(any.recorder.statements).toEqual(plain.recorder.statements);
    expect(plain.body.rows[0]).toMatchObject({ container_id: 101, pickup_address_id: 11, enabled: 1, synced_at: STAMP });
    expect(Object.keys(plain.body.rows[0])).not.toContain("customerEnabled");
    // any must not add a customer join/predicate even beside customerId, whose
    // current address-join visibility includes missing-customer owners.
    const scoped = await page({ customerId: "1" });
    const scopedAny = await page({ customerId: "1", customerEnabled: "any" });
    expect(scopedAny.body).toEqual(scoped.body);
    expect(scopedAny.recorder.statements).toEqual(scoped.recorder.statements);
    const counted = await page({ countOnly: "true" });
    const countedAny = await page({ countOnly: "true", customerEnabled: "any" });
    expect(countedAny.body).toEqual(counted.body);
    expect(countedAny.recorder.statements).toEqual(counted.recorder.statements);
  });
  it.each([
    ["enabled owner agrees", { customerId: "1", customerEnabled: "true" }, [101, 102, 103, 104, 114, 115]],
    ["enabled owner contradicted is empty 200", { customerId: "1", customerEnabled: "false" }, []],
    ["disabled owner agrees", { customerId: "2", customerEnabled: "false" }, [105, 106, 107, 108]],
    ["disabled owner contradicted is empty 200", { customerId: "2", customerEnabled: "true" }, []],
    ["second enabled owner agrees (decoys do not leak)", { customerId: "3", customerEnabled: "true" }, [109, 116]],
    ["second enabled owner contradicted", { customerId: "3", customerEnabled: "false" }, []],
    ["second disabled owner agrees", { customerId: "4", customerEnabled: "false" }, [110]],
    ["owner with no equipment stays empty", { customerId: "7", customerEnabled: "true" }, []],
    ["unknown owner stays empty", { customerId: "999", customerEnabled: "true" }, []],
    ["unknown owner + false stays empty", { customerId: "999", customerEnabled: "false" }, []],
  ] as const)("customerId conjunction: %s", async (_name, filters, want) => {
    for (const mode of [{}, { includeTotal: "false" }, { countOnly: "true" }] as Array<Record<string, string>>) {
      const result = await page({ ...filters, ...mode });
      expect(ids(result.body)).toEqual("countOnly" in mode ? [] : want);
      expect(result.body.total).toBe("includeTotal" in mode ? null : want.length);
    }
  });
  it.each([
    [{ pickupAddressId: "11" }, [101, 102]],
    [{ pickupAddressId: "11", customerEnabled: "false" }, []],
    [{ containerId: "105" }, []],
    [{ containerId: "105", customerEnabled: "false" }, [105]],
    [{ ids: "116,101,105,111" }, [101, 116]],
    [{ ids: "116,101,105,111", customerEnabled: "false" }, [105]],
    [{ ids: "116,101,105,111", customerEnabled: "any" }, [101, 105, 111, 116]],
    [{ q: "Depot 11" }, [114, 115, 116]],
    [{ q: "Depot 10" }, [101, 102, 103, 104, 109]],
    [{ upperId: "104" }, [101, 102, 103, 104]],
    [{ lowerId: "114" }, [114, 115, 116]],
    [{ cursor: "104" }, [109, 114, 115, 116]],
    [{ order: "desc", cursor: "109" }, [104, 103, 102, 101]],
    [{ customerEnabled: "false", parentEnabled: "true", enabled: "false", pickupAddressId: "13", containerId: "106" }, [106]],
    [{ customerEnabled: "false", parentEnabled: "false", pickupAddressId: "13" }, []],
  ] as const)("AND-composes with existing selectors %j", async (extra, want) => {
    const filters = "customerEnabled" in extra ? extra : { customerEnabled: "true", ...extra };
    const result = await page(filters);
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
  });
  it("independent specification SQL proves the fixture cohorts are satisfiable", async () => {
    // Oracle-side SQL (never product SQL) hand-checks the derivation above, so
    // a RED product result cannot be a fixture arithmetic error.
    for (const [stored, want] of [[1, CUST_TRUE], [0, CUST_FALSE]] as const) {
      const rows = await TEST_ENV.CUSTOMER_DB.prepare(
        "SELECT c.container_id FROM container_snapshot c INNER JOIN address_snapshot a ON a.pickup_address_id = c.pickup_address_id INNER JOIN customer_snapshot cu ON cu.customer_id = a.customer_id WHERE cu.enabled = ? ORDER BY c.container_id",
      ).bind(stored).all<{ container_id: number }>();
      expect(rows.results.map(r => r.container_id)).toEqual(want);
    }
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(
      "EXPLAIN QUERY PLAN SELECT c.container_id FROM container_snapshot c INNER JOIN address_snapshot a ON a.pickup_address_id = c.pickup_address_id INNER JOIN customer_snapshot cu ON cu.customer_id = a.customer_id WHERE cu.enabled = 1",
    ).all<{ detail: string }>();
    expect(plan.results.length).toBeGreaterThan(0);
    expect(plan.results.map(r => r.detail).join("\n")).toMatch(/\bSCAN\b|\bSEARCH\b/i);
  });
  it("product SQL consults customer_snapshot with an exact enabled equality on COUNT and page", async () => {
    for (const [value, stored] of [["true", 1], ["false", 0]] as const) {
      const result = await page({ customerEnabled: value, limit: "2" });
      for (const { sql, binds } of result.recorder.statements) {
        expect(sql).toMatch(/\bcustomer_snapshot\b/i);
        expect(sql).toMatch(/\benabled\s*=\s*(?:\?|1\b|0\b)/i);
        if (/\benabled\s*=\s*\?/i.test(sql)) expect(binds).toContain(stored);
        else expect(sql).toMatch(new RegExp(`\\benabled\\s*=\\s*${stored}\\b`, "i"));
        // A complement spelling must not sweep noncanonical/missing rows in.
        expect(sql).not.toMatch(/\benabled\s*(?:<>|!=)\s*(?:\?|0|1)\b/i);
        const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
        expect(plan.results.length, `Synthetic local plan (not production latency): ${plan.results.map(r => r.detail).join("; ")}`).toBeGreaterThan(0);
      }
    }
  });
});

describe.each(["true", "false"])("container customerEnabled: followed links includeTotal=%s", includeTotal => {
  it.each(["asc", "desc"])("walks every %s page of the stored-1 cohort to the empty terminal page", async order => {
    const filters = { customerEnabled: "true", parentEnabled: "any", enabled: "any", fields: "enabled,city", limit: "2", includeTotal, order, unknown: "private-marker", redirect: "https://untrusted.invalid/private" };
    let result = await page(filters);
    const pages = order === "asc" ? [[101, 102], [103, 104], [109, 114], [115, 116], []] : [[116, 115], [114, 109], [104, 103], [102, 101], []];
    const totals = [8, 6, 4, 2, 0];
    const seen: unknown[] = [];
    for (let i = 0; i < pages.length; i++) {
      expect(ids(result.body)).toEqual(pages[i]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : totals[i]);
      for (const row of result.body.rows) expect(Object.keys(row).sort()).toEqual(["city", "container_id", "enabled"]);
      seen.push(...ids(result.body));
      expect(result.body.nextCursor).toBe(i === pages.length - 1 ? null : pages[i][1]);
      if (i === pages.length - 1) expect(result.response.headers.get("link")).toBeNull();
      else result = await page(next(result));
    }
    expect(seen).toEqual(order === "asc" ? CUST_TRUE : [...CUST_TRUE].reverse());
    expect(new Set(seen).size).toBe(CUST_TRUE.length);
  });
  it.each(["asc", "desc"])("walks the stored-0 cohort and stops on its partial terminal %s page", async order => {
    let result = await page({ customerEnabled: "false", limit: "2", includeTotal, order });
    const pages = order === "asc" ? [[105, 106], [107, 108], [110]] : [[110, 108], [107, 106], [105]];
    const totals = [5, 3, 1];
    for (let i = 0; i < pages.length; i++) {
      expect(ids(result.body)).toEqual(pages[i]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : totals[i]);
      if (i === pages.length - 1) {
        expect(result.body.nextCursor).toBeNull();
        expect(result.response.headers.get("link")).toBeNull();
      } else result = await page(next(result));
    }
  });
  it.each([
    ["asc", { offset: "1" }, [102, 103], 8, 103, [104, 109]],
    ["desc", { offset: "1" }, [115, 114], 8, 114, [109, 104]],
    ["asc", { cursor: "103", offset: "999" }, [104, 109], 5, 109, [114, 115]],
    ["desc", { cursor: "109", offset: "999" }, [104, 103], 4, 103, [102, 101]],
  ] as const)("%s offset-to-seek %j", async (order, paging, want, total, cursor, following) => {
    const result = await page({ customerEnabled: "true", order, ...paging, limit: "2", includeTotal });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(includeTotal === "false" ? null : total);
    expect(result.body.nextCursor).toBe(cursor);
    if ("cursor" in paging) for (const s of result.recorder.statements) expect(s.sql).not.toMatch(/\bOFFSET\b/i);
    const followed = await page(next(result));
    expect(ids(followed.body)).toEqual(following);
    for (const s of followed.recorder.statements) expect(s.sql).not.toMatch(/\bOFFSET\b/i);
  });
  it("retains false state, sparse fields and bounds on continuation; any stays omitted", async () => {
    const first = await page({ customerEnabled: "false", upperId: "108", fields: "enabled", limit: "2", includeTotal });
    expect(ids(first.body)).toEqual([105, 106]);
    const target = next(first);
    expect(target.searchParams.get("customerEnabled")).toBe("false");
    expect(target.searchParams.get("upperId")).toBe("108");
    const second = await page(target);
    expect(ids(second.body)).toEqual([107, 108]);
    expect(second.body.total).toBe(includeTotal === "false" ? null : 2);
    const anyFirst = await page({ customerEnabled: "any", limit: "2", includeTotal });
    expect(ids(anyFirst.body)).toEqual([101, 102]);
    expect(next(anyFirst).searchParams.has("customerEnabled")).toBe(false);
  });
});

const invalid = [
  ...["", "TRUE", "True", "FALSE", "Any", "ANY", "1", "0", "yes", "no", "enabled", " true", "false ", "any\n", "true,false", "tru e", " true"].map(value => `customerEnabled=${encodeURIComponent(value)}`),
  "customerEnabled",
  "customerEnabled=true&customerEnabled=true",
  "customerEnabled=true&customerEnabled=false",
  "customerEnabled=any&customerEnabled=any",
  "customerEnabled=&customerEnabled=true",
  "customerEnabled=true&customer%45nabled=true",
  "customerEnabled=false&%63ustomerEnabled=false",
];
describe("container customerEnabled: value-free validation before D1, after authentication", () => {
  it.each(invalid)("rejects query %s even on conditional GET", async query => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const result = await request(query, { headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    posture(result.response);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const problem = await result.response.json() as Record<string, unknown>;
    expect(problem).toMatchObject({ type: BAD_REQUEST, title: "Bad Request", status: 400 });
    // Guidance (fixed remedy prose after the anchor) is Builder-owned; only the
    // field-naming anchor and doc link are pinned, never a submitted value.
    expect(problem.detail).toMatch(/^Invalid request query \(customerEnabled\)\./);
    expect(problem.detail).toContain("See docs/PROBLEMS.md#bad-request.");
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it("does not reflect a rejected selector value in the error body", async () => {
    const marker = "synthetic-private-customer-enabled-marker";
    const result = await request(`customerEnabled=${marker}`);
    expect(result.response.status).toBe(400);
    expect(await result.response.text()).not.toContain(marker);
    expect(result.recorder.prepared).toEqual([]);
  });
  it.each([null, "invalid-read-token"])("authenticates %s before malformed customerEnabled/304 handling", async token => {
    for (const query of ["customerEnabled=true", "customerEnabled=private-marker", "customerEnabled=true&customerEnabled=false"]) {
      const result = await request(query, { token, headers: { "if-none-match": "*" } });
      expect(result.response.status).toBe(401);
      expect(result.recorder.prepared).toEqual([]);
      expect(result.response.headers.get("link")).toBeNull();
      expect(result.response.headers.get("etag")).toBeNull();
      expect(await result.response.text()).not.toContain("private-marker");
    }
  });
  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("preserves authorized read access via %s", async token => {
    const result = await request({ customerEnabled: "true", customerId: "3" }, { token });
    expect(result.response.status).toBe(200);
    expect(ids(await result.response.json() as Body)).toEqual([109, 116]);
  });
  it("unknown keys remain ignored by default but are not reflected in next links", async () => {
    const filters = { customerEnabled: "true", limit: "1" };
    const plain = await page(filters);
    const unknown = await page({ ...filters, unknown: "private-marker" });
    expect(unknown.body).toEqual(plain.body);
    expect(unknown.recorder.statements).toEqual(plain.recorder.statements);
    next(unknown);
  });
  it("strictQuery accepts the supported selector and still rejects unknown names pre-D1", async () => {
    const ok = await page({ customerEnabled: "false", strictQuery: "true" });
    expect(ids(ok.body)).toEqual(CUST_FALSE);
    const bad = await request("customerEnabled=false&strictQuery=true&unknown-name-marker=unknown-value-marker");
    expect(bad.response.status).toBe(400);
    expect(bad.recorder.prepared).toEqual([]);
    expect(await bad.response.text()).not.toContain("unknown-value-marker");
  });
  it("countOnly conflicts keep their existing guidance, not a customerEnabled remedy", async () => {
    const result = await request("customerEnabled=true&countOnly=true&includeTotal=false");
    expect(result.response.status).toBe(400);
    expect(result.recorder.prepared).toEqual([]);
    const problem = await result.response.json() as { detail: string };
    expect(problem.detail).toMatch(/countOnly/);
    expect(problem.detail).toContain("See docs/PROBLEMS.md#bad-request.");
  });
});

it.each(["true", "false"])("customer-scoped representation ETags and 304 includeTotal=%s", async includeTotal => {
  const query = { customerEnabled: "true", fields: "enabled", limit: "2", includeTotal };
  const first = await page(query);
  expect(first.body.rows).toEqual([{ container_id: 101, enabled: 1 }, { container_id: 102, enabled: 0 }]);
  expect(first.body.total).toBe(includeTotal === "false" ? null : 8);
  const tag = await hash(first.bytes);
  expect(first.response.headers.get("etag")).toBe(tag);
  next(first);
  for (const validator of [tag, `W/${tag}`, "*"]) {
    const same = await request(query, { headers: { "if-none-match": validator } });
    expect(same.response.status).toBe(304);
    expect(same.response.body).toBeNull();
    expect(await same.response.text()).toBe("");
    expect(same.response.headers.get("etag")).toBe(tag);
    expect(same.response.headers.get("link")).toBe(first.response.headers.get("link"));
    posture(same.response);
    budget(same);
    expect(same.recorder.statements).toEqual(first.recorder.statements);
  }
  const changed = await page({ ...query, customerEnabled: "false" }, { "if-none-match": tag });
  expect(ids(changed.body)).toEqual([105, 106]);
  expect(changed.response.headers.get("etag")).not.toBe(tag);
  // No validator replayed here: in count-free mode the any first page is the
  // same representation, so a 304 would be correct; only the cohort/total
  // widening is asserted.
  const anyQuery = await page({ ...query, customerEnabled: "any" });
  expect(ids(anyQuery.body)).toEqual([101, 102]);
  expect(anyQuery.body.total).toBe(includeTotal === "false" ? null : 16);
});
it("recomputes sparse membership after an unprojected owning-customer enabled change", async () => {
  const query = { customerEnabled: "true", containerId: "101", fields: "enabled" };
  const first = await page(query);
  expect(first.body.rows).toEqual([{ container_id: 101, enabled: 1 }]);
  // Direct fixture mutation only; deliberately leave synced_at unchanged.
  await TEST_ENV.CUSTOMER_DB.prepare("UPDATE customer_snapshot SET enabled = 0 WHERE customer_id = 1").run();
  beforeState = await state();
  const changed = await page(query, { "if-none-match": await hash(first.bytes) });
  expect(changed.body).toEqual({ rows: [], total: 0, nextCursor: null });
  expect(changed.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
  const flipped = await page({ ...query, customerEnabled: "false" });
  expect(flipped.body.rows).toEqual([{ container_id: 101, enabled: 1 }]);
});

type Parameter = { name: string; in: string; required?: boolean; description?: string; example?: unknown; examples?: Record<string, { value?: unknown }>; schema: Record<string, unknown> };
type Operation = { operationId?: string; description?: string; parameters?: Parameter[]; responses?: Record<string, { description?: string }>; "x-effect"?: string; "x-access"?: string };
async function document() {
  const result = await request(new URL("/openapi.json", ORIGIN), { token: null });
  expect(result.response.status).toBe(200);
  expect(result.recorder.prepared).toEqual([]);
  return await result.response.json() as { paths: Record<string, Record<string, Operation>> };
}
describe("container customerEnabled: mounted machine-readable discovery", () => {
  it("publishes one optional enum selector with a replayable example", async () => {
    const op = (await document()).paths[PATH].get;
    expect(op).toMatchObject({ operationId: "listContainerSnapshot", "x-effect": "local-read", "x-access": "read" });
    const params = (op.parameters ?? []).filter(p => p.in === "query" && p.name === "customerEnabled");
    expect(params).toHaveLength(1);
    const parameter = params[0];
    expect(parameter.required ?? false).toBe(false);
    expect(parameter.schema).toMatchObject({ type: "string", enum: ["true", "false", "any"], default: "any" });
    const prose = `${parameter.description ?? ""} ${String((parameter.schema as { description?: string }).description ?? "")}`;
    expect(prose).toMatch(/customer/i);
    expect(prose).toMatch(/enabled/i);
    const examples = [parameter.example, (parameter.schema as { example?: unknown }).example, ...Object.values(parameter.examples ?? {}).map(e => e.value)];
    const example = examples.find(value => value !== undefined);
    expect(["true", "false", "any"]).toContain(example);
    const cohort = example === "true" ? CUST_TRUE : example === "false" ? CUST_FALSE : ALL;
    const replay = await page({ customerEnabled: String(example) });
    expect(ids(replay.body)).toEqual(cohort);
    expect(replay.body.total).toBe(cohort.length);
  });
  it("names the selector in operation and 400 recovery discovery", async () => {
    const op = (await document()).paths[PATH].get;
    expect(op.description).toContain("customerEnabled");
    const recovery = op.responses?.["400"]?.description ?? "";
    expect(recovery).toContain("customerEnabled");
    expect(recovery).toMatch(/true.*false.*any/);
    expect(recovery).toMatch(/repeat|duplicate/i);
    expect(recovery).toMatch(/before.*D1/i);
    expect(recovery).toContain("docs/PROBLEMS.md#bad-request");
  });
  it("aligns the served inventory with the canonical query-policy table and stays container-only", async () => {
    const doc = await document();
    const op = doc.paths[PATH].get;
    const names = (op.parameters ?? []).filter(p => p.in === "query").map(p => p.name).sort();
    for (const key of ["customerEnabled", "parentRouteId", "parentFranchiseId", "parentEnabled", "customerId", "pickupAddressId", "containerId", "ids", "serialNumber", "rfid", "zip", "q", "enabled", "upperId", "lowerId", "order", "cursor", "offset", "includeTotal", "countOnly", "fields", "limit"]) expect(names).toContain(key);
    const row = policyDoc.split("\n").find(line => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    expect([...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map(m => m[1]).sort()).toEqual(names);
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (path === PATH && method === "get") continue;
        const keys = (operation.parameters ?? []).filter(p => p.in === "query").map(p => p.name);
        expect(keys, `${method} ${path}`).not.toContain("customerEnabled");
      }
    }
  });
});

// Last: replaces the three fixture tables with constraint-free legacy copies
// (same columns) so historical dangling/null links can exist. Production
// migrations are never changed; every earlier test uses the real schema.
describe("container customerEnabled: missing/noncanonical lineage (legacy fixture tables)", () => {
  it("explicit states never match missing address/customer or null/text customer enabled; unscoped visibility is preserved", async () => {
    const db = TEST_ENV.CUSTOMER_DB;
    const triggers = await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all<{ name: string; sql: string }>();
    await db.batch([
      ...triggers.results.map(t => db.prepare(`DROP TRIGGER "${t.name.replace(/"/g, '""')}"`)),
      db.prepare("CREATE TABLE legacy_container_snapshot AS SELECT * FROM container_snapshot"),
      db.prepare("DROP TABLE container_snapshot"),
      db.prepare("ALTER TABLE legacy_container_snapshot RENAME TO container_snapshot"),
      db.prepare("CREATE TABLE legacy_address_snapshot AS SELECT * FROM address_snapshot"),
      db.prepare("DROP TABLE address_snapshot"),
      db.prepare("ALTER TABLE legacy_address_snapshot RENAME TO address_snapshot"),
      db.prepare("CREATE TABLE legacy_customer_snapshot AS SELECT * FROM customer_snapshot"),
      db.prepare("DROP TABLE customer_snapshot"),
      db.prepare("ALTER TABLE legacy_customer_snapshot RENAME TO customer_snapshot"),
      ...triggers.results.map(t => db.prepare(t.sql)),
      // 201: customer exists with NULL enabled. 202: customer row missing.
      // 203: address customer_id NULL. 204: address missing. 205: address NULL.
      // 206: customer enabled stored as text. All must match neither state.
      db.prepare("INSERT INTO customer_snapshot (customer_id, enabled, synced_at) VALUES (50, NULL, ?), (51, 'true', ?)").bind(STAMP, STAMP),
      db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (50, 50, 1, ?), (51, 999, 1, ?), (52, NULL, 1, ?), (53, 51, 1, ?)").bind(STAMP, STAMP, STAMP, STAMP),
      db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, synced_at) VALUES (201, 50, 1, ?), (202, 51, 1, ?), (203, 52, 1, ?), (204, 999, 1, ?), (205, NULL, 1, ?), (206, 53, 1, ?)").bind(STAMP, STAMP, STAMP, STAMP, STAMP, STAMP),
    ]);
    beforeState = await state();
    const LEGACY = [201, 202, 203, 204, 205, 206];
    expect(ids((await page()).body)).toEqual([...ALL, ...LEGACY]);
    expect(ids((await page({ customerEnabled: "any" })).body)).toEqual([...ALL, ...LEGACY]);
    expect(ids((await page({ customerEnabled: "true" })).body)).toEqual(CUST_TRUE);
    expect(ids((await page({ customerEnabled: "false" })).body)).toEqual(CUST_FALSE);
    expect(ids((await page({ customerEnabled: "true", countOnly: "true" })).body)).toEqual([]);
    expect((await page({ customerEnabled: "true", countOnly: "true" })).body.total).toBe(CUST_TRUE.length);
    expect(ids((await page({ containerId: "204" })).body)).toEqual([204]);
    expect(ids((await page({ containerId: "204", customerEnabled: "true" })).body)).toEqual([]);
    // Today's customerId read (address join only) sees the missing-customer
    // owner's equipment; an effective customerEnabled must exclude it.
    expect(ids((await page({ customerId: "999" })).body)).toEqual([202]);
    expect(ids((await page({ customerId: "999", customerEnabled: "any" })).body)).toEqual([202]);
    expect(ids((await page({ customerId: "999", customerEnabled: "true" })).body)).toEqual([]);
    expect(ids((await page({ customerId: "999", customerEnabled: "false" })).body)).toEqual([]);
  });
});
