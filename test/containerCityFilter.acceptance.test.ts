import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned acceptance oracle; Builder must not edit this file.
 * Run: npx vitest run test/containerCityFilter.acceptance.test.ts --maxWorkers=2
 * Independent tests-first oracle: literal expected IDs, real synthetic local D1.
 * Mutation targets: ignored/ORed city, parent-city fallback, substring/NOCASE,
 * trimming/coercion/normalization, UTF-16 bounds, COUNT/page/countOnly drift,
 * lost continuation scopes, stale ETags, reflected values and validation before
 * auth. Fixture setup alone writes. HTTP denies writes, network, R2 and browser.
 * GET is idempotent/local-read; CLI --dry-run is not applicable.
 * Expected RED until the paired implementation adds exact `city` to the
 * ordinary container list.
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/container-snapshot";
const ORIGIN = "https://exact-city.test.invalid";
const STAMP = "2026-01-02T03:04:05.000Z";
const CITY = "Killeen";
const SPECIAL = ` O'Ridge 50%_ &+/#? "雪\\tail `;
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
type Query = Record<string, string> | string | URL;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
// ID, parent, own city, enabled, optional serial/state/zip/RFID/location.
type Fixture = readonly [number, number, string | null, number, string?, string?, string?, string?, string?];
const FIXTURES: readonly Fixture[] = [
  [10, 11, CITY, 1],
  [20, 11, CITY, 1, "other"],
  [30, 12, CITY, 0],
  [40, 21, CITY, 1],
  [50, 11, `x${CITY}x`, 1],
  [60, 11, "killeen", 1],
  [70, 11, "Other", 1, "asset", CITY],
  [75, 12, "Elsewhere", 1],
  [80, 11, "Other", 1, CITY, CITY, CITY],
  [90, 11, null, 1],
  [100, 11, "", 1],
  [110, 11, " \t\n ", 1],
  [120, 11, SPECIAL, 1],
  [130, 12, SPECIAL, 1],
  [140, 11, "a", 1],
  [150, 11, "A", 1],
  [160, 11, "00123", 1],
  [170, 11, "123", 1],
  [180, 11, ` ${CITY} `, 1],
  [190, 11, "%_", 1],
  [200, 11, "é", 1],
  [210, 11, "é", 1],
  [220, 11, "ÅBC", 1],
  [230, 11, "åbc", 1],
  [240, 11, "x\t\ny", 1],
  [250, 11, "A".repeat(100), 1],
  [260, 11, "🚛".repeat(100), 1],
  [270, 11, CITY, 1, "asset", "OnlyState", "00999", "other-tag"],
  [280, 11, CITY, 1],
  [290, 11, "0", 1],
  [300, 11, null, 1, CITY],
  [310, 11, "Kill", 1],
  [320, 11, "Parent City", 1],
  [330, 11, "parent city", 1],
  [340, 11, " edge　", 1],
];
const ALL = [10, 20, 30, 40, 50, 60, 70, 75, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250, 260, 270, 280, 290, 300, 310, 320, 330, 340];
const COHORT = [10, 20, 30, 40, 270, 280];
const ids = (body: Body) => body.rows.map(row => row.container_id);
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
let denied: string[];
let beforeState: unknown;

function recordedDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const forbid = (operation: string): never => {
    denied.push(operation);
    throw new Error("Unexpected effect in exact city oracle");
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
  return Promise.all([
    ...["customer_snapshot", "address_snapshot", "container_snapshot"].map(table =>
      TEST_ENV.CUSTOMER_DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()),
    TEST_ENV.CUSTOMER_DB.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
  ]).then(results => results.map(r => r.results));
}
async function request(query: Query = {}, options: { token?: string | null; headers?: Record<string, string> } = {}) {
  const recorder = recordedDb();
  const url = query instanceof URL ? query : new URL(PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = typeof query === "string" ? query : new URLSearchParams(query).toString();
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Exact-city-oracle", ...options.headers });
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
  expect(response.headers.get("x-request-id")).toBe("Exact-city-oracle");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
function budget(result: Awaited<ReturnType<typeof request>>) {
  const countFree = result.url.searchParams.get("includeTotal") === "false";
  const statements = result.recorder.statements;
  expect(statements).toHaveLength(countFree ? 1 : 2);
  expect(statements.filter(isCount)).toHaveLength(countFree ? 0 : 1);
  const select = statements.find(s => !isCount(s))!;
  const pagingBinds = /\bOFFSET\b/i.test(select.sql) ? 2 : 1;
  expect(select.binds[select.binds.length - pagingBinds]).toBe(Number(result.url.searchParams.get("limit") ?? 50));
  if (!countFree) expect(select.binds.slice(0, -pagingBinds)).toEqual(statements.find(isCount)!.binds);
  const q = result.url.searchParams;
  const joined = q.has("customerId") || q.has("parentRouteId") || q.has("parentFranchiseId") || ["true", "false"].includes(q.get("parentEnabled") ?? "");
  for (const s of statements) {
    const joins = s.sql.match(/\bJOIN\b/gi) ?? [];
    expect(joins).toHaveLength(joined ? 1 : 0);
    if (joined) expect(s.sql).toMatch(/\bJOIN\s+address_snapshot\b/i);
  }
}
async function page(query: Query = {}, headers?: Record<string, string>) {
  const result = await request(query, { headers });
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  posture(result.response);
  budget(result);
  const bytes = await result.response.text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  if (result.url.searchParams.get("includeTotal") === "false") expect(body.total).toBeNull();
  return { ...result, body, bytes };
}
function next(result: Awaited<ReturnType<typeof page>>) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/container-snapshot\?[^<>\s]*>; rel="next"$/);
  const url = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(url.origin).toBe(ORIGIN);
  expect(url.username).toBe("");
  expect(url.password).toBe("");
  expect(url.hash).toBe("");
  expect(url.pathname).toBe(PATH);
  expect(url.searchParams.has("offset")).toBe(false);
  expect(url.searchParams.getAll("cursor")).toEqual([String(result.body.nextCursor)]);
  const ignored = ["bogus_param", "unknown", "origin", "authorization"];
  for (const key of ignored) expect(url.searchParams.has(key)).toBe(false);
  for (const [key, raw] of result.url.searchParams) {
    if (["cursor", "offset", ...ignored].includes(key)) continue;
    const value = key === "q" ? raw.trim() : raw;
    if ((key === "order" && value === "asc") || (key === "includeTotal" && value === "true") || (key === "enabled" && value === "any") || (key === "parentEnabled" && value === "any")) {
      expect([[], [value]]).toContainEqual(url.searchParams.getAll(key));
    } else expect(url.searchParams.getAll(key), key).toEqual([value]);
  }
  return url;
}
async function hash(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}"`;
}
beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  denied = [];
  vi.stubGlobal("fetch", vi.fn(async () => { denied.push("network"); throw new Error("Unexpected network in exact city oracle"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, synced_at) VALUES (1, 'Synthetic One', ?), (2, 'Synthetic Two', ?)").bind(STAMP, STAMP),
    // Parent 12 carries the equipment CITY name itself: equipment must match
    // only its own stored city, never this parent value.
    db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, state, city, zip, route_id, franchise_id, enabled, synced_at) VALUES (11, 1, 'Parent Depot', 'ParentState', 'Parent City', '99999', 7, '001', 1, ?), (12, 1, 'Parent Depot', 'ParentState', ?, '99999', 7, '001', 1, ?), (21, 2, 'Parent Depot', 'ParentState', 'Parent City', '99999', 8, '1', 1, ?)").bind(STAMP, CITY, STAMP, STAMP),
  ]);
  // Reverse insertion deliberately: storage insertion order is not pagination order.
  await db.batch([...FIXTURES].reverse().map(([id, parent, city, enabled, serial = "asset", ownState = "TX", zip = "02139", rfid = "tag", location = "Depot"]) =>
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, state, enabled, serial_number, city, zip, rfid, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, parent, location, ownState, enabled, serial, city, zip, rfid, STAMP)));
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denied).toEqual([]);
    expect(await state(), "GET must not mutate rows or schema").toEqual(beforeState);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe("city: exact container-owned opaque value", () => {
  it("keeps duplicate matches but excludes substring, case, parent-only and null decoys on both join paths", async () => {
    const unjoined = COHORT;
    const joined = [10, 20, 30, 270, 280];
    for (const customer of [false, true]) {
      const query: Record<string, string> = { city: CITY };
      if (customer) query.customerId = "1";
      const result = await page(query);
      expect(ids(result.body)).toEqual(customer ? joined : unjoined);
      expect(result.body.total).toBe(customer ? joined.length : unjoined.length);
      expect(result.body.nextCursor).toBeNull();
    }
  });
  it.each([
    ["leading zeros", "00123", [160]], ["no number coercion", "123", [170]],
    ["one code point", "0", [290]], ["lowercase", "a", [140]], ["uppercase", "A", [150]],
    ["composed Unicode", "é", [200]], ["decomposed Unicode", "é", [210]],
    ["non-ASCII uppercase", "ÅBC", [220]], ["non-ASCII lowercase", "åbc", [230]],
    ["ASCII case inside Unicode stays exact", "Åbc", []],
    ["internal whitespace", "x\t\ny", [240]], ["significant Unicode whitespace", " edge　", [340]],
    ["literal wildcards", "%_", [190]],
    ["quotes and reserved Unicode", SPECIAL, [120, 130]],
    ["no wildcard expansion", "%", []], ["no SQL expansion", "' OR 1=1 --", []],
    ["null is not text", "null", []], ["unknown", "synthetic-absent", []],
    ["prefix is not a match", "Kill", [310]], ["prefix needle misses longer stored values", "Kille", []],
  ] as const)("%s", async (_name, value, want) => {
    for (const customer of [false, true]) {
      const query: Record<string, string> = { city: value };
      if (customer) query.customerId = "1";
      const result = await page(query);
      expect(ids(result.body)).toEqual(want);
      expect(result.body.total).toBe(want.length);
    }
  });
  it.each([false, true])("preserves nonblank edge whitespace, joined=%s", async joined => {
    const result = await page({ city: ` ${CITY} `, ...(joined ? { customerId: "1" } : {}) });
    expect(ids(result.body)).toEqual([180]);
    expect(result.body.total).toBe(1);
  });
  it.each([false, true])("matches only the equipment column when the parent shares the name, joined=%s", async joined => {
    // Parents 11 and 21 are named "Parent City" and parent 12 is named CITY;
    // null/empty/blank equipment rows under them must not match by fallback.
    const parentNamed = await page({ city: "Parent City", ...(joined ? { customerId: "1" } : {}) });
    expect(ids(parentNamed.body)).toEqual([320]);
    expect(parentNamed.body.total).toBe(1);
    const lower = await page({ city: "parent city", ...(joined ? { customerId: "1" } : {}) });
    expect(ids(lower.body)).toEqual([330]);
    const elsewhere = await page({ city: "Elsewhere", ...(joined ? { customerId: "1" } : {}) });
    expect(ids(elsewhere.body)).toEqual([75]);
  });
  it.each(["A", "🚛"])("accepts the exact code-point ceiling (%s)", async character => {
    const result = await page({ city: character.repeat(100) });
    expect(ids(result.body)).toEqual(character === "A" ? [250] : [260]);
    expect(result.body.total).toBe(1);
  });
  it("retains a single exact city throughout asc and desc followed links", async () => {
    for (const order of ["asc", "desc"]) {
      let result = await page({ city: SPECIAL, limit: "1", includeTotal: "false", order });
      const seen: unknown[] = [];
      for (const id of order === "asc" ? [120, 130] : [130, 120]) {
        expect(ids(result.body)).toEqual([id]);
        expect(result.body.nextCursor).toBe(id);
        seen.push(...ids(result.body));
        result = await page(next(result));
      }
      expect(result.body).toEqual({ rows: [], total: null, nextCursor: null });
      expect(result.response.headers.get("link")).toBeNull();
      expect(seen).toEqual(order === "asc" ? [120, 130] : [130, 120]);
    }
  });
});

describe.each(["true", "false"])("AND scopes and COUNT parity, includeTotal=%s", includeTotal => {
  it.each([
    [{}, COHORT],
    [{ customerId: "1" }, [10, 20, 30, 270, 280]], [{ customerId: "2" }, [40]],
    [{ pickupAddressId: "11" }, [10, 20, 270, 280]], [{ pickupAddressId: "12" }, [30]],
    [{ containerId: "30" }, [30]], [{ containerId: "50" }, []],
    [{ ids: "10,50,280" }, [10, 280]], [{ ids: "50,60" }, []],
    [{ serialNumber: "asset" }, [10, 30, 40, 270, 280]], [{ serialNumber: "other" }, [20]],
    [{ rfid: "tag" }, [10, 20, 30, 40, 280]], [{ rfid: "other-tag" }, [270]],
    [{ materialStream: "Synthetic stream" }, []], [{ color: "Synthetic color" }, []],
    [{ locationAddress: "Depot" }, COHORT], [{ locationAddress: "Other Depot" }, []],
    [{ state: "TX" }, [10, 20, 30, 40, 280]], [{ state: "OnlyState" }, [270]], [{ state: CITY }, []],
    [{ zip: "02139" }, [10, 20, 30, 40, 280]], [{ zip: "00999" }, [270]], [{ zip: "99999" }, []],
    [{ parentRouteId: "7" }, [10, 20, 30, 270, 280]], [{ parentRouteId: "8" }, [40]],
    [{ parentFranchiseId: "001" }, [10, 20, 30, 270, 280]], [{ parentFranchiseId: "1" }, [40]],
    [{ parentEnabled: "true" }, COHORT], [{ parentEnabled: "false" }, []],
    [{ q: "ASSET" }, [10, 30, 40, 270, 280]], [{ q: "00999" }, [270]],
    [{ q: CITY }, COHORT], [{ q: "kill" }, COHORT], [{ q: "no-such-match" }, []],
    [{ enabled: "true" }, [10, 20, 40, 270, 280]], [{ enabled: "false" }, [30]],
    [{ enabled: "any" }, COHORT],
    [{ customerId: "2", pickupAddressId: "11" }, []], [{ customerId: "1", containerId: "40" }, []],
    [{ upperId: "40" }, [10, 20, 30, 40]], [{ cursor: "40" }, [270, 280]],
    [{ order: "desc", cursor: "40" }, [30, 20, 10]],
    [{ customerId: "1", pickupAddressId: "11", containerId: "10", ids: "10,50", serialNumber: "asset", rfid: "tag", locationAddress: "Depot", state: "TX", zip: "02139", parentRouteId: "7", parentFranchiseId: "001", parentEnabled: "true", q: "Kill", enabled: "true", upperId: "20", fields: "enabled" }, [10]],
  ] as const)("intersects exact city with %j", async (filters, want) => {
    const paths = "customerId" in filters ? [false] : [false, true];
    for (const joined of paths) {
      const result = await page({ city: CITY, ...filters, ...(joined ? { customerId: "1" } : {}), includeTotal });
      // Container 40 is the sole matching row owned by customer 2.
      const expected = joined ? want.filter(id => id !== 40) : want;
      expect(ids(result.body)).toEqual(expected);
      expect(result.body.total).toBe(includeTotal === "false" ? null : expected.length);
    }
  });
  it.each([
    [{ city: "Other", state: "TX" }, []],
    [{ city: "Other", state: CITY }, [70, 80]],
    [{ city: "Elsewhere", state: "TX", zip: "02139" }, [75]],
  ] as const)("never ORs or falls back across columns: %j", async (filters, want) => {
    for (const joined of [false, true]) {
      const result = await page({ ...filters, ...(joined ? { customerId: "1" } : {}), includeTotal });
      expect(ids(result.body)).toEqual(want);
      expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
    }
  });
  it.each(["asc", "desc"])("follows all %s pages with city, state/zip/q/parent scopes, upperId and sparse fields", async order => {
    const filters = { city: CITY, customerId: "1", q: " Kill ", state: "TX", zip: "02139", parentRouteId: "7", parentFranchiseId: "001", parentEnabled: "true", enabled: "any", upperId: "40", fields: "enabled", limit: "2", includeTotal, order };
    let result = await page(filters);
    const pages = order === "asc" ? [[10, 20], [30]] : [[30, 20], [10]];
    const seen: unknown[] = [];
    for (let i = 0; i < pages.length; i++) {
      expect(ids(result.body)).toEqual(pages[i]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : [3, 1][i]);
      for (const row of result.body.rows) expect(Object.keys(row).sort()).toEqual(["container_id", "enabled"]);
      seen.push(...ids(result.body));
      expect(result.body.nextCursor).toBe(i === 0 ? 20 : null);
      if (i === 0) result = await page(next(result));
      else expect(result.response.headers.get("link")).toBeNull();
    }
    expect(seen).toEqual(order === "asc" ? [10, 20, 30] : [30, 20, 10]);
    expect(new Set(seen).size).toBe(3);
  });
  it.each(["asc", "desc"])("offset-to-seek %s retains every remaining member", async order => {
    let result = await page({ city: CITY, upperId: "40", offset: "1", limit: "1", order, includeTotal });
    const expected = order === "asc" ? [20, 30, 40] : [30, 20, 10];
    const seen: unknown[] = [];
    for (let i = 0; i < expected.length; i++) {
      expect(ids(result.body)).toEqual([expected[i]]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : [4, 2, 1][i]);
      seen.push(...ids(result.body));
      result = await page(next(result));
    }
    expect(seen).toEqual(expected);
    expect(result.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
  });
  it.each(["asc", "desc"])("cursor overrides conflicting offset in %s traversal", async order => {
    const result = await page({ city: CITY, order, cursor: "30", offset: "999", limit: "2", includeTotal });
    expect(ids(result.body)).toEqual(order === "asc" ? [40, 270] : [20, 10]);
    expect(result.body.total).toBe(includeTotal === "false" ? null : order === "asc" ? 3 : 2);
    for (const s of result.recorder.statements) expect(s.sql).not.toMatch(/\bOFFSET\b/i);
    next(result);
  });
  it.each(["asc", "desc"])("round-trips the literal city on every %s link without unknown keys or credentials", async order => {
    const filters = { city: SPECIAL, serialNumber: "asset", rfid: "tag", customerId: "1", state: "TX", zip: "02139", parentRouteId: "7", upperId: "130", fields: "enabled", limit: "1", includeTotal, order };
    let result = await page({ ...filters, bogus_param: "private-marker", unknown: "private-marker", origin: "https://untrusted.invalid", authorization: "private-token" });
    for (const id of order === "asc" ? [120, 130] : [130, 120]) {
      expect(result.body.rows).toEqual([{ container_id: id, enabled: 1 }]);
      const link = result.response.headers.get("link")!;
      expect(link).not.toContain(SPECIAL);
      expect(link).not.toMatch(/private-marker|private-token|untrusted|test-read-token/);
      expect(new URL(/^<([^>]+)>; rel="next"$/.exec(link)![1], result.url).searchParams.get("city")).toBe(SPECIAL);
      result = await page(next(result));
    }
    expect(result.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
  });
});

describe("city: countOnly COUNT-only and count-free parity", () => {
  it.each([
    [{ city: CITY }, 6],
    [{ city: CITY, customerId: "1" }, 5],
    [{ city: CITY, state: "TX" }, 5],
    [{ city: CITY, state: "TX", zip: "02139", parentRouteId: "7", parentEnabled: "true" }, 4],
    [{ city: SPECIAL }, 2],
    [{ city: "synthetic-absent" }, 0],
  ] as const)("counts %j with exactly one COUNT and no page SELECT", async (filters, total) => {
    const result = await request({ ...filters, countOnly: "true" });
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("content-type")).toContain("application/json");
    posture(result.response);
    expect(result.recorder.statements).toHaveLength(1);
    expect(result.recorder.statements.filter(isCount)).toHaveLength(1);
    expect(result.recorder.statements[0].sql).toMatch(/\bc\.city\s*=\s*\?/i);
    const body = await result.response.json() as Body;
    expect(body).toEqual({ rows: [], total, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
    // Parity: the same filters counted on a normal page agree.
    const counted = await page(filters);
    expect(counted.body.total).toBe(total);
    expect(ids(counted.body)).toHaveLength(total);
  });
  it("keeps count-free rows identical to the counted page with total null", async () => {
    const counted = await page({ city: CITY, state: "TX", zip: "02139", limit: "3" });
    const free = await page({ city: CITY, state: "TX", zip: "02139", limit: "3", includeTotal: "false" });
    expect(free.body.rows).toEqual(counted.body.rows);
    expect(free.body.nextCursor).toEqual(counted.body.nextCursor);
    expect(free.body.total).toBeNull();
    expect(counted.body.total).toBe(5);
  });
  it("rejects countOnly=true with includeTotal=false before D1 without reflecting the city", async () => {
    const result = await request({ city: SPECIAL, countOnly: "true", includeTotal: "false" });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const body = await result.response.text();
    expect(body).not.toContain(SPECIAL);
    expect(body).toMatch(/countOnly/);
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
  });
  it("validates city before applying countOnly", async () => {
    const result = await request({ city: "", countOnly: "true" });
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ type: BAD_REQUEST, title: "Bad Request", status: 400, detail: "Invalid request query (city). See docs/PROBLEMS.md#bad-request." });
    expect(result.recorder.prepared).toEqual([]);
  });
});

describe("city: value-free validation before any D1", () => {
  it.each([
    ["empty", ""], ["ASCII whitespace", " \t\r\n "], ["Unicode whitespace", " 　"],
    ["ASCII overlength", "x".repeat(101)], ["astral overlength", "🚛".repeat(101)],
    ["mixed overlength", "x".repeat(100) + "🚛"],
    ["raw overlength cannot pass by trimming", "x" + " ".repeat(100)],
  ])("rejects %s even with a wildcard conditional validator", async (_name, value) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const result = await request({ city: value }, { headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    posture(result.response);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(await result.response.json()).toEqual({ type: BAD_REQUEST, title: "Bad Request", status: 400, detail: "Invalid request query (city). See docs/PROBLEMS.md#bad-request." });
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it.each([
    ["private-one", "private-one"], ["private-one", "private-two"], ["", "private-one"], ["private-one", ""],
  ])("rejects repeats (%j, %j) before D1 without reflecting either value", async (first, second) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const result = await request(`city=${encodeURIComponent(first)}&c%69ty=${encodeURIComponent(second)}`, { headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(await result.response.json()).toEqual({ type: BAD_REQUEST, title: "Bad Request", status: 400, detail: "Invalid request query (city). See docs/PROBLEMS.md#bad-request." });
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it("rejects a bare key without a value", async () => {
    const result = await request("city");
    expect(result.response.status).toBe(400);
    expect(result.recorder.prepared).toEqual([]);
  });
});

it.each([null, "invalid-token"])("authenticates before invalid city and 304 handling: %s", async token => {
  const result = await request("city=&city=private-one&city=private-two", { token, headers: { "if-none-match": "*" } });
  expect(result.response.status).toBe(401);
  expect(result.response.headers.get("content-type")).toContain("application/problem+json");
  const problem = await result.response.json();
  expect(problem).toMatchObject({ status: 401, title: "Unauthorized" });
  // Bare "city" is not asserted: the fixed requestId echo carries our own
  // "Exact-city-oracle" correlation value, not reflected query input.
  expect(JSON.stringify(problem)).not.toMatch(/private-one|private-two|city=|\(city\)/);
  expect(result.recorder.prepared).toEqual([]);
  expect(result.response.headers.get("etag")).toBeNull();
  expect(result.response.headers.get("link")).toBeNull();
});
it.each(["test-read-token", "test-api-token", "test-sync-secret"])("authorizes exact local reads via %s", async token => {
  const result = await request({ city: SPECIAL }, { token });
  expect(result.response.status).toBe(200);
  expect(ids(await result.response.json() as Body)).toEqual([120, 130]);
});
it("control: omission, canonical own columns, blank/null data and ignored unknowns are unchanged", async () => {
  const plain = await page();
  expect(ids(plain.body)).toEqual(ALL);
  expect(plain.body.total).toBe(35);
  expect(plain.body.rows[0]).toMatchObject({ container_id: 10, pickup_address_id: 11, city: CITY, synced_at: STAMP });
  expect(plain.body.rows[9]).toMatchObject({ container_id: 90, city: null });
  expect(plain.body.rows[10]).toMatchObject({ container_id: 100, city: "" });
  const unknown = await page({ bogus_param: "private-marker" });
  expect(unknown.body).toEqual(plain.body);
  expect(unknown.recorder.statements).toEqual(plain.recorder.statements);
  expect((await page({ enabled: "any", parentEnabled: "any", includeTotal: "true" })).body).toEqual(plain.body);
  expect((await page({ enabled: "any", parentEnabled: "any" })).recorder.statements).toEqual(plain.recorder.statements);
});
it("never widens q to state or substitutes serial/zip/parent matches for an exact city", async () => {
  expect(ids((await page({ q: CITY })).body)).toEqual([10, 20, 30, 40, 50, 60, 80, 180, 270, 280, 300]);
  expect(ids((await page({ q: "Depot" })).body)).toEqual(ALL);
  expect(ids((await page({ city: CITY, q: CITY })).body)).toEqual(COHORT);
  expect(ids((await page({ city: "Other" })).body)).toEqual([70, 80]);
  expect(ids((await page({ state: CITY })).body)).toEqual([70, 80]);
});
it("does not log successful raw exact values and remains idempotent", async () => {
  const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
  const first = await page({ city: SPECIAL });
  expect(ids(first.body)).toEqual([120, 130]);
  const second = await page({ city: SPECIAL });
  expect(second.body).toEqual(first.body);
  expect(second.recorder.statements).toEqual(first.recorder.statements);
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});
it.each(["true", "false"])("hashes the final sparse envelope and preserves conditional links, includeTotal=%s", async includeTotal => {
  const query = { city: CITY, customerId: "1", fields: "enabled", limit: "2", includeTotal };
  const first = await page(query);
  expect(first.body.rows).toEqual([{ container_id: 10, enabled: 1 }, { container_id: 20, enabled: 1 }]);
  expect(first.body.total).toBe(includeTotal === "false" ? null : 5);
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
  for (const filters of [{ city: "Other" }, { state: "TX" }, { fields: "state" }] as Record<string, string>[]) {
    const different = await page({ ...query, ...filters }, { "if-none-match": tag });
    expect(different.response.headers.get("etag")).not.toBe(tag);
  }
});
it("recomputes membership when unprojected city changes without changing sync time", async () => {
  const query = { city: SPECIAL, fields: "enabled" };
  const first = await page(query);
  expect(ids(first.body)).toEqual([120, 130]);
  // Fixture mutation only, not the request's read-only D1 binding.
  await TEST_ENV.CUSTOMER_DB.prepare("UPDATE container_snapshot SET city = NULL WHERE container_id = 120").run();
  beforeState = await state();
  const changed = await page(query, { "if-none-match": await hash(first.bytes) });
  expect(changed.body).toEqual({ rows: [{ container_id: 130, enabled: 1 }], total: 1, nextCursor: null });
});
it.each([false, true])("binds c-qualified equality with executable local plans, joined=%s", async joined => {
  const result = await page({ city: SPECIAL, ...(joined ? { customerId: "1" } : {}), limit: "1" });
  expect(ids(result.body)).toEqual([120]);
  expect(result.body.total).toBe(2);
  for (const { sql, binds } of result.recorder.statements) {
    expect(sql).toMatch(/\bc\.city\s*=\s*\?/i);
    expect(sql).not.toContain(SPECIAL);
    expect(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP|COLLATE\s+NOCASE)\b/i);
    expect(binds.filter(value => value === SPECIAL)).toHaveLength(1);
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
    expect(plan.success).toBe(true);
    expect(plan.results.length).toBeGreaterThan(0);
    if (!joined) {
      const details = plan.results.map(row => row.detail).join("\n");
      expect(details, "unindexed exact column: local scan, not a latency claim").toMatch(/\bSCAN\s+c\b/i);
      expect(details).not.toMatch(/\bSEARCH\s+c\b/i);
    }
  }
});

type Parameter = { name: string; in: string; required?: boolean; description?: string; example?: unknown; examples?: Record<string, { value?: unknown }>; schema: { type?: string; minLength?: number; maxLength?: number; default?: unknown; description?: string; example?: unknown } };
type Operation = { operationId: string; description: string; parameters: Parameter[]; responses: Record<string, { description: string }>; "x-effect"?: string; "x-access"?: string };
async function document() {
  const result = await request(new URL("/openapi.json", ORIGIN), { token: null });
  expect(result.response.status).toBe(200);
  expect(result.recorder.prepared).toEqual([]);
  return await result.response.json() as { paths: Record<string, { get: Operation }> };
}
describe("mounted exact-city discovery", () => {
  it("publishes optional city, code-point bounds, own-column meaning and an opaque example", async () => {
    const op = (await document()).paths[PATH].get;
    expect(op).toMatchObject({ operationId: "listContainerSnapshot", "x-effect": "local-read", "x-access": "read" });
    const matches = op.parameters.filter(p => p.in === "query" && p.name === "city");
    expect(matches).toHaveLength(1);
    const p = matches[0];
    expect(p.required ?? false).toBe(false);
    expect(p.schema).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
    expect(p.schema.default).toBeUndefined();
    const examples = [p.example, p.schema.example, ...Object.values(p.examples ?? {}).map(example => example.value)];
    expect(examples.some(value => typeof value === "string" && value.trim().length > 0 && [...value].length <= 100)).toBe(true);
    const guidance = `${p.description ?? ""} ${p.schema.description ?? ""}`;
    for (const pattern of [/exact/i, /case.sensitive/i, /Unicode code points/i, /whitespace/i, /container|own|c\./i]) expect(guidance).toMatch(pattern);
  });
  it("discovers AND composition and a fixed value-free next action for the city limit", async () => {
    const op = (await document()).paths[PATH].get;
    for (const name of ["city", "state", "zip", "locationAddress", "q", "customerId", "pickupAddressId", "containerId", "ids", "serialNumber", "rfid", "materialStream", "color", "parentRouteId", "parentFranchiseId", "parentEnabled", "enabled", "upperId", "order", "cursor", "offset", "includeTotal", "fields"]) {
      expect(op.parameters.some(p => p.in === "query" && p.name === name), name).toBe(true);
    }
    expect(op.description).toMatch(/\bAND\b|intersect/i);
    const recovery = op.responses["400"].description;
    for (const pattern of [/city/, /100/, /Unicode code points/i, /repeat|duplicate/i, /blank|empty/i, /before.*D1/i, /application\/problem\+json/, /docs\/PROBLEMS\.md#bad-request/, /URL.encode/i, /omit/i]) expect(recovery).toMatch(pattern);
  });
  it("aligns the canonical query inventory with served names without changing other operations", async () => {
    const doc = await document();
    const row = policyDoc.split("\n").find(line => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    const inventory = [...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map(m => m[1]).sort();
    expect(inventory).toContain("city");
    expect(inventory).toEqual(doc.paths[PATH].get.parameters.filter(p => p.in === "query").map(p => p.name).sort());
    for (const path of ["/api/v1/customer-snapshot", `${PATH}/{containerId}`, `${PATH}/export`, "/api/v1/customer-snapshot/changes"]) {
      const params = doc.paths[path].get.parameters?.filter(p => p.in === "query").map(p => p.name) ?? [];
      expect(params, path).not.toContain("city");
    }
  });
});
