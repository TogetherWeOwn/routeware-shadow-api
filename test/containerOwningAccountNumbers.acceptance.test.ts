import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned acceptance oracle; Builder must not edit this file.
 * Run: npx vitest run test/containerOwningAccountNumbers.acceptance.test.ts --maxWorkers=2
 * Tests first, independent literal IDs, synthetic real local D1 via app.fetch.
 * Mutation targets: ignored/swapped/ORed numbers, matching different customer
 * rows, uniqueness assumptions, duplicate joins, NULL/parent fallbacks, LIKE,
 * numeric coercion/case folding/trimming/normalization/UTF-16 length, lost
 * COUNT/page/seek predicates or links, stale sparse ETags, validation before
 * auth or after D1/304, input reflection and accidentally broadened discovery.
 * No implementation or unmerged sibling selectors. Fixture setup alone writes;
 * HTTP denies writes, network, R2 and browser. No deployment or live data.
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/container-snapshot";
const ORIGIN = "https://equipment-account.test.invalid";
const STAMP = "2026-01-02T03:04:05.000Z";
const SPECIAL = " 雪'_% &+#?/=🚛 ";
const SUB_SPECIAL = " Branch'_% &+#?/=🚛 ";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
const SELECTORS = ["owningCustomerNumber", "owningSubCustomerNumber"] as const;
type Query = Record<string, string> | string | URL;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
type Account = readonly [number, string | null, string | null];
const ACCOUNTS: readonly Account[] = [
  [1, "00042", "North"], [2, "00042", "North"], [3, "00042", "South"],
  [4, "42", "North"], [5, "00042", "north"], [6, null, "North"],
  [7, "Case", "A"], [8, "case", "a"], [9, " 00042 ", " North "],
  [10, "顧客😀", "枝😀"], [11, SPECIAL, SUB_SPECIAL], [12, SPECIAL, SUB_SPECIAL],
  [13, "AC%_42", "SU%_42"], [14, "ACxy42", "SUxy42"],
  [15, "x' OR 1=1 --", "y' OR 1=1 --"],
  [16, "🚛".repeat(100), "🚛".repeat(100)],
  [17, "x".repeat(50) + "🚛".repeat(50), "x".repeat(50) + "🚛".repeat(50)],
  [18, " \tX \n", " \tY \n"], [19, "0", "0"],
  [20, "000420", "North-extra"], [21, "0004", null],
  [22, "é", "é"], [23, "é", "é"], [24, null, null],
  // Wrong-column decoy: neither selector can use the OTHER stored number.
  [25, "North", "00042"], [26, "x".repeat(100), "x".repeat(100)],
  [27, "", " \t\n"],
];
const ALL = [10, 11, 12, 20, 21, 30, 40, 50, 60, 70, 80, 90, 100, 110, 111, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250, 260, 270];
const BOTH = [10, 11, 12, 20, 21];
const PRIMARY = [10, 11, 12, 20, 21, 30, 50];
const SUB = [10, 11, 12, 20, 21, 40, 60];
const pair = { owningCustomerNumber: "00042", owningSubCustomerNumber: "North" };
const ids = (body: Body) => body.rows.map(row => row.container_id);
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
let denied: string[];
let beforeState: unknown;

function recordedDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const forbid = (operation: string): never => {
    denied.push(operation);
    throw new Error("Unexpected effect in owning-account oracle");
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
  const headers = new Headers({ origin: ORIGIN, ...options.headers });
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
}
function budget(result: Awaited<ReturnType<typeof request>>) {
  const q = result.url.searchParams;
  const free = q.get("includeTotal") === "false";
  const countOnly = q.get("countOnly") === "true";
  const statements = result.recorder.statements;
  expect(statements).toHaveLength(countOnly || free ? 1 : 2);
  expect(statements.filter(isCount)).toHaveLength(free ? 0 : 1);
  if (!countOnly) {
    const select = statements.find(s => !isCount(s))!;
    const pagingBinds = /\bOFFSET\b/i.test(select.sql) ? 2 : 1;
    const limit = Number(q.get("limit") ?? 50) + (q.get("exactNext") === "true" ? 1 : 0);
    expect(select.binds[select.binds.length - pagingBinds]).toBe(limit);
    if (!free) expect(select.binds.slice(0, -pagingBinds)).toEqual(statements.find(isCount)!.binds);
  }
}
async function page(query: Query = {}, headers?: Record<string, string>) {
  const result = await request(query, { headers });
  expect(result.response.status).toBe(200);
  posture(result.response);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  const bytes = await result.response.text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  budget(result);
  if (result.url.searchParams.get("includeTotal") === "false") expect(body.total).toBeNull();
  return { ...result, body, bytes };
}
function next(result: Awaited<ReturnType<typeof page>>) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/container-snapshot\?[^<>\s]*>; rel="next"$/);
  const url = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(url.origin).toBe(ORIGIN);
  expect(url.pathname).toBe(PATH);
  expect(url.hash).toBe("");
  expect(url.username).toBe("");
  expect(url.password).toBe("");
  expect(url.searchParams.has("offset")).toBe(false);
  expect(url.searchParams.getAll("cursor")).toEqual([String(result.body.nextCursor)]);
  const ignored = ["bogus_param", "unknown", "origin", "authorization"];
  for (const key of ignored) expect(url.searchParams.has(key)).toBe(false);
  for (const [key, raw] of result.url.searchParams) {
    if (["cursor", "offset", ...ignored].includes(key)) continue;
    const value = key === "q" ? raw.trim() : raw;
    if ((key === "order" && value === "asc") || (key === "includeTotal" && value === "true") || (value === "any" && ["enabled", "parentEnabled", "onCall", "gpsLocked", "hasSerialNumber", "hasRfid"].includes(key))) {
      expect([[], [value]]).toContainEqual(url.searchParams.getAll(key));
    } else expect(url.searchParams.getAll(key), key).toEqual([value]);
  }
  expect(link).not.toMatch(/private-marker|private-token|untrusted|test-read-token/);
  return url;
}
async function hash(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}"`;
}
beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  denied = [];
  vi.stubGlobal("fetch", vi.fn(async () => { denied.push("network"); throw new Error("Unexpected account lookup network"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot")]);
  await db.batch(ACCOUNTS.map(([id, customer, sub]) => db.prepare("INSERT INTO customer_snapshot (customer_id, customer_number, sub_customer_number, company_name, enabled, synced_at) VALUES (?, ?, ?, 'Synthetic Account', ?, ?)")
    .bind(id, customer, sub, id === 2 ? 0 : 1, STAMP)));
  await db.batch(ACCOUNTS.map(([id]) => db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, city, state, zip, route_id, franchise_id, enabled, synced_at) VALUES (?, ?, 'Parent Depot', 'Parent City', 'ParentState', '99999', ?, ?, ?, ?)")
    .bind(id * 100, id, id === 2 ? 8 : 7, id === 2 ? "1" : "001", id === 2 ? 0 : 1, STAMP)));
  await db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, route_id, franchise_id, enabled, synced_at) VALUES (101, 1, 'Other Parent', 9, '002', 0, ?)").bind(STAMP).run();
  const equipment = [...ACCOUNTS.map(([id]) => [id * 10, id * 100]), [11, 101], [12, 100], [21, 200], [111, 1100]];
  await db.batch(equipment.reverse().map(([id, parent]) => db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, container_type_id, serial_number, rfid, oncall, gps_locked, enabled, location_address, city, state, zip, ud_material_stream_ud, color, service_code_type, service_code_input, service_code, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Depot', 'Equipment City', 'TX', '02139', ?, ?, ?, ?, ?, ?)")
    .bind(id, parent, id === 12 ? 9 : 5, id === 12 ? null : "asset", id === 21 ? null : "tag", id === 11 ? 0 : 1, id === 12 ? 0 : 1, id === 11 ? 0 : 1,
      id === 12 ? "Other stream" : "Recycling", id === 21 ? "Blue" : "Green", id === 12 ? "T-2" : "T-001", id === 11 ? "IN-2" : "IN-01", id === 21 ? "SVC-B" : "SVC-A", STAMP)));
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denied).toEqual([]);
    expect(await state(), "GET must not change mirror rows or schema").toEqual(beforeState);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe("owning account numbers: exact same-row chain", () => {
  it.each([
    [{ owningCustomerNumber: "00042" }, PRIMARY],
    [{ owningSubCustomerNumber: "North" }, SUB], [pair, BOTH],
    [{ ...pair, owningSubCustomerNumber: "north" }, [50]],
    [{ owningCustomerNumber: "42" }, [40]],
    [{ owningCustomerNumber: "North" }, [250]],
    [{ owningSubCustomerNumber: "00042" }, [250]],
    [{ owningCustomerNumber: "00042", owningSubCustomerNumber: "A" }, []],
    [{ owningCustomerNumber: "Case", owningSubCustomerNumber: "a" }, []],
    [{ owningCustomerNumber: "Case", owningSubCustomerNumber: "A" }, [70]],
    [{ owningCustomerNumber: "case", owningSubCustomerNumber: "a" }, [80]],
    [{ owningCustomerNumber: " 00042 ", owningSubCustomerNumber: " North " }, [90]],
    [{ owningCustomerNumber: "顧客😀", owningSubCustomerNumber: "枝😀" }, [100]],
    [{ owningCustomerNumber: SPECIAL, owningSubCustomerNumber: SUB_SPECIAL }, [110, 111, 120]],
    [{ owningCustomerNumber: "AC%_42" }, [130]], [{ owningSubCustomerNumber: "SU%_42" }, [130]],
    [{ owningCustomerNumber: "x' OR 1=1 --", owningSubCustomerNumber: "y' OR 1=1 --" }, [150]],
    [{ owningCustomerNumber: " \tX \n", owningSubCustomerNumber: " \tY \n" }, [180]],
    [{ owningCustomerNumber: "0", owningSubCustomerNumber: "0" }, [190]],
    [{ owningCustomerNumber: "é", owningSubCustomerNumber: "é" }, [220]],
    [{ owningCustomerNumber: "é", owningSubCustomerNumber: "é" }, [230]],
    [{ owningCustomerNumber: "0004" }, [210]],
  ] as const)("selects exact stored values without uniqueness assumptions: %j", async (query, want) => {
    const result = await page(query);
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    expect(new Set(ids(result.body)).size).toBe(want.length);
    for (const row of result.body.rows) {
      expect(row).toMatchObject({ synced_at: STAMP, location_address: "Depot" });
      for (const key of ["customer_id", "customer_number", "sub_customer_number", ...SELECTORS]) expect(row).not.toHaveProperty(key);
    }
  });
  it.each(SELECTORS)("returns empty 200 for valid unknown/null text rather than fallback (%s)", async selector => {
    for (const value of ["synthetic-absent", "null", "%", "000", "Nort", "' OR 1=1 --"]) {
      const result = await page({ [selector]: value });
      expect(result.body).toEqual({ rows: [], total: 0, nextCursor: null });
    }
  });
  it.each([
    ["x".repeat(100), [260]], ["🚛".repeat(100), [160]],
    ["x".repeat(50) + "🚛".repeat(50), [170]],
  ] as const)("accepts 100 Unicode code points, not UTF-16 units (%s)", async (value, want) => {
    for (const selector of SELECTORS) {
      expect(ids((await page({ [selector]: value })).body)).toEqual(want);
    }
  });
  it("control: omission preserves the old unjoined SQL, canonical equipment shape and unknown-key behavior", async () => {
    const plain = await page();
    expect(ids(plain.body)).toEqual(ALL);
    expect(plain.body.total).toBe(31);
    expect(plain.body.rows[0]).toMatchObject({ container_id: 10, pickup_address_id: 100, enabled: 1, city: "Equipment City", synced_at: STAMP });
    for (const s of plain.recorder.statements) expect(s.sql).not.toMatch(/\bJOIN\b/i);
    const unknown = await page({ bogus_param: "private-marker", customerNumber: "00042", subCustomerNumber: "North" });
    expect(unknown.body).toEqual(plain.body);
    expect(unknown.recorder.statements).toEqual(plain.recorder.statements);
  });
  it("control: q remains equipment-local and is not broadened to owning account text", async () => {
    expect(ids((await page({ q: "00042" })).body)).toEqual([]);
    expect(ids((await page({ ...pair, q: "00042" })).body)).toEqual([]);
    expect(ids((await page({ ...pair, q: "Depot" })).body)).toEqual(BOTH);
  });
});

const SCOPES = [
  [{}, BOTH], [{ customerId: "1" }, [10, 11, 12]], [{ customerId: "2" }, [20, 21]],
  [{ customerId: "3" }, []], [{ pickupAddressId: "100" }, [10, 12]], [{ pickupAddressId: "101" }, [11]],
  [{ containerId: "20" }, [20]], [{ containerId: "40" }, []], [{ ids: "10,20,40" }, [10, 20]],
  [{ enabled: "true" }, [10, 12, 20, 21]], [{ enabled: "false" }, [11]], [{ enabled: "any" }, BOTH],
  [{ parentEnabled: "true" }, [10, 12]], [{ parentEnabled: "false" }, [11, 20, 21]], [{ parentEnabled: "any" }, BOTH],
  [{ parentRouteId: "7" }, [10, 12]], [{ parentRouteId: "8" }, [20, 21]], [{ parentRouteId: "9" }, [11]],
  [{ parentFranchiseId: "001" }, [10, 12]], [{ parentFranchiseId: "1" }, [20, 21]],
  [{ containerTypeId: "5" }, [10, 11, 20, 21]], [{ containerTypeId: "9" }, [12]],
  [{ onCall: "true" }, [10, 12, 20, 21]], [{ onCall: "false" }, [11]],
  [{ gpsLocked: "true" }, [10, 11, 20, 21]], [{ gpsLocked: "false" }, [12]],
  [{ hasSerialNumber: "true" }, [10, 11, 20, 21]], [{ hasSerialNumber: "false" }, [12]],
  [{ hasRfid: "true" }, [10, 11, 12, 20]], [{ hasRfid: "false" }, [21]],
  [{ serialNumber: "asset" }, [10, 11, 20, 21]], [{ rfid: "tag" }, [10, 11, 12, 20]],
  [{ materialStream: "Recycling" }, [10, 11, 20, 21]], [{ color: "Blue" }, [21]],
  [{ serviceCodeType: "T-001" }, [10, 11, 20, 21]],
  [{ serviceCodeInput: "IN-01" }, [10, 12, 20, 21]], [{ locationAddress: "Depot" }, BOTH],
  [{ city: "Equipment City" }, BOTH], [{ city: "Parent City" }, []],
  [{ state: "TX" }, BOTH], [{ state: "ParentState" }, []], [{ zip: "02139" }, BOTH], [{ zip: "99999" }, []],
  [{ q: " ASSET " }, [10, 11, 20, 21]], [{ q: "absent" }, []],
  [{ lowerId: "11", upperId: "20" }, [11, 12, 20]], [{ cursor: "12" }, [20, 21]],
  [{ order: "desc", cursor: "20" }, [12, 11, 10]],
  [{ customerId: "1", pickupAddressId: "200" }, []],
  [{ customerId: "1", pickupAddressId: "100", containerId: "10", ids: "10,40", enabled: "true", parentEnabled: "true", parentRouteId: "7", parentFranchiseId: "001", containerTypeId: "5", onCall: "true", gpsLocked: "true", hasSerialNumber: "true", hasRfid: "true", serialNumber: "asset", rfid: "tag", materialStream: "Recycling", color: "Green", serviceCodeType: "T-001", serviceCodeInput: "IN-01", locationAddress: "Depot", city: "Equipment City", state: "TX", zip: "02139", q: "ASSET", lowerId: "9", upperId: "21", fields: "enabled", strictQuery: "true" }, [10]],
] as const;
describe("GREEN fixture controls independent of the missing selectors", () => {
  it("proves the actual D1 chain has two distinct owners with the same pair and unequal single-number cohorts", async () => {
    const db = TEST_ENV.CUSTOMER_DB;
    const from = "FROM container_snapshot AS equipment JOIN address_snapshot AS site ON site.pickup_address_id = equipment.pickup_address_id JOIN customer_snapshot AS owner ON owner.customer_id = site.customer_id";
    const cases = [
      ["owner.customer_number = ?", ["00042"], PRIMARY],
      ["owner.sub_customer_number = ?", ["North"], SUB],
      ["owner.customer_number = ? AND owner.sub_customer_number = ?", ["00042", "North"], BOTH],
    ] as const;
    for (const [where, binds, want] of cases) {
      const actual = await db.prepare(`SELECT equipment.container_id ${from} WHERE ${where} ORDER BY equipment.container_id`).bind(...binds).all<{ container_id: number }>();
      expect(actual.results.map(row => row.container_id)).toEqual(want);
    }
  });
  it.each(SCOPES)("proves the existing selector fixture is satisfiable before implementation: %j", async (scopes, want) => {
    // The literal known-owning cohort is supplied through the OLD ids selector,
    // not through a new selector or a production predicate/expected-value helper.
    const scopeIds = "ids" in scopes ? scopes.ids.split(",").filter(id => ["10", "11", "12", "20", "21"].includes(id)).join(",") : "10,11,12,20,21";
    const result = await page({ ...scopes, ids: scopeIds });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
  });
});
describe.each(["true", "false"])("owning account AND-composition, includeTotal=%s", includeTotal => {
  it.each(SCOPES)("intersects every merged container/parent scope: %j", async (scopes, want) => {
    const result = await page({ ...pair, ...scopes, includeTotal });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
  });
});
it.each(SCOPES)("countOnly uses exactly the same chain predicates for %j", async (scopes, want) => {
  const result = await page({ ...pair, ...scopes, countOnly: "true" });
  expect(result.body).toEqual({ rows: [], total: want.length, nextCursor: null });
  expect(result.response.headers.get("link")).toBeNull();
});
it.each(SELECTORS)("countOnly does not drop a number supplied alone: %s", async selector => {
  const result = await page({ [selector]: selector === SELECTORS[0] ? "00042" : "North", countOnly: "true" });
  expect(result.body).toEqual({ rows: [], total: 7, nextCursor: null });
});
it("binds fully qualified owning columns once in COUNT/page with executable local plans", async () => {
  const result = await page({ owningCustomerNumber: SPECIAL, owningSubCustomerNumber: SUB_SPECIAL, customerId: "11", parentRouteId: "7" });
  expect(ids(result.body)).toEqual([110, 111]);
  for (const { sql, binds } of result.recorder.statements) {
    // Extend the pre-existing site join, never add a second copy of either table.
    expect(sql.match(/\bJOIN\s+address_snapshot\b/gi) ?? []).toHaveLength(1);
    expect(sql.match(/\bJOIN\s+customer_snapshot\b/gi) ?? []).toHaveLength(1);
    for (const column of ["customer_number", "sub_customer_number"]) expect(sql).toMatch(new RegExp(`\\b\\w+\\.${column}\\s*=\\s*\\?`, "i"));
    expect(sql).not.toContain(SPECIAL);
    expect(sql).not.toContain(SUB_SPECIAL);
    expect(binds.filter(value => value === SPECIAL)).toHaveLength(1);
    expect(binds.filter(value => value === SUB_SPECIAL)).toHaveLength(1);
    expect(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP|COLLATE\s+NOCASE)\b/i);
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all();
    expect(plan.success).toBe(true);
    expect(plan.results.length).toBeGreaterThan(0);
  }
});

// Full-final pages need a trailing empty page only in legacy exactNext=false.
describe.each(["true", "false"])("followed links and sparse ETags, includeTotal=%s", includeTotal => {
  it.each(["asc", "desc"])("traverses every %s page, preserves both opaque selectors and offset-to-seek", async order => {
    const filters = { owningCustomerNumber: SPECIAL, owningSubCustomerNumber: SUB_SPECIAL, parentRouteId: "7", fields: "enabled", limit: "1", offset: "1", lowerId: "100", upperId: "120", order, includeTotal, unknown: "private-marker", origin: "https://untrusted.invalid", authorization: "private-token" };
    let result = await page(filters);
    const expected = order === "asc" ? [111, 120] : [111, 110];
    const seen: unknown[] = [];
    for (let i = 0; i < expected.length; i++) {
      expect(result.body.rows).toEqual([{ container_id: expected[i], enabled: 1 }]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : [3, 1][i]);
      expect(result.body.nextCursor).toBe(expected[i]);
      seen.push(...ids(result.body));
      result = await page(next(result));
    }
    expect(seen).toEqual(expected);
    expect(result.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
  });
  it.each(["asc", "desc"])("exactNext=true ends %s traversal on the partial page (no invented empty hop)", async order => {
    let result = await page({ ...pair, order, includeTotal, exactNext: "true", limit: "2", fields: "enabled", lowerId: "9", upperId: "21", strictQuery: "true" });
    const pages = order === "asc" ? [[10, 11], [12, 20], [21]] : [[21, 20], [12, 11], [10]];
    for (let i = 0; i < pages.length; i++) {
      expect(ids(result.body)).toEqual(pages[i]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : [5, 3, 1][i]);
      expect(result.body.nextCursor).toBe(i === 2 ? null : pages[i][1]);
      if (i < 2) result = await page(next(result));
      else expect(result.response.headers.get("link")).toBeNull();
    }
  });
  it.each(["asc", "desc"])("exactNext=true suppresses the %s full-final link and cursor beats offset", async order => {
    const query = { ...pair, order, includeTotal, exactNext: "true", limit: "2", customerId: "2" };
    const result = await page(query);
    expect(ids(result.body)).toEqual(order === "asc" ? [20, 21] : [21, 20]);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    const seek = await page({ ...pair, order, includeTotal, cursor: "12", offset: "999" });
    expect(ids(seek.body)).toEqual(order === "asc" ? [20, 21] : [11, 10]);
    for (const s of seek.recorder.statements) expect(s.sql).not.toMatch(/\bOFFSET\b/i);
  });
  it("hashes the final sparse envelope and retains conditional next links", async () => {
    const query = { ...pair, includeTotal, fields: "enabled", limit: "2" };
    const first = await page(query);
    expect(first.body.rows).toEqual([{ container_id: 10, enabled: 1 }, { container_id: 11, enabled: 0 }]);
    const tag = await hash(first.bytes);
    expect(first.response.headers.get("etag")).toBe(tag);
    next(first);
    for (const validator of [tag, `W/${tag}`, "*"]) {
      const same = await request(query, { headers: { "if-none-match": validator } });
      expect(same.response.status).toBe(304);
      expect(same.response.body).toBeNull();
      expect(await same.response.text()).toBe("");
      posture(same.response);
      expect(same.response.headers.get("etag")).toBe(tag);
      expect(same.response.headers.get("link")).toBe(first.response.headers.get("link"));
      expect(same.recorder.statements).toEqual(first.recorder.statements);
      budget(same);
    }
    for (const changed of [{ owningCustomerNumber: "42" }, { owningSubCustomerNumber: "north" }, { fields: "city" }]) {
      const different = await page({ ...query, ...changed }, { "if-none-match": tag });
      expect(different.response.headers.get("etag")).not.toBe(tag);
    }
    const counted = await page({ ...pair, fields: "enabled", limit: "2" });
    const free = await page({ ...pair, fields: "enabled", limit: "2", includeTotal: "false" });
    expect(free.body.rows).toEqual(counted.body.rows);
    expect(free.body.nextCursor).toEqual(counted.body.nextCursor);
    expect(free.recorder.statements).toEqual(counted.recorder.statements.filter(s => !isCount(s)));
  });
});
it.each(SELECTORS)("retains a selector supplied alone through both traversal directions: %s", async selector => {
  for (const order of ["asc", "desc"]) {
    let result = await page({ [selector]: selector === SELECTORS[0] ? SPECIAL : SUB_SPECIAL, limit: "2", order });
    const expected = order === "asc" ? [[110, 111], [120]] : [[120, 111], [110]];
    expect(ids(result.body)).toEqual(expected[0]);
    result = await page(next(result));
    expect(ids(result.body)).toEqual(expected[1]);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  }
});
it.each(SELECTORS)("invalidates sparse membership when unprojected owning data changes: %s", async selector => {
  const query = { ...pair, fields: "enabled" };
  const first = await page(query);
  expect(ids(first.body)).toEqual(BOTH);
  const column = selector === SELECTORS[0] ? "customer_number" : "sub_customer_number";
  await TEST_ENV.CUSTOMER_DB.prepare(`UPDATE customer_snapshot SET ${column} = NULL WHERE customer_id = 1`).run();
  beforeState = await state();
  const changed = await page(query, { "if-none-match": await hash(first.bytes) });
  expect(changed.body).toEqual({ rows: [{ container_id: 20, enabled: 1 }, { container_id: 21, enabled: 1 }], total: 2, nextCursor: null });
});

async function bad(query: Query, values: string[] = []) {
  const result = await request(query, { headers: { "if-none-match": "*" } });
  expect(result.response.status).toBe(400);
  posture(result.response);
  expect(result.response.headers.get("content-type")).toContain("application/problem+json");
  const body = await result.response.json() as { type: string; title: string; status: number; detail: string };
  expect(body).toMatchObject({ type: BAD_REQUEST, title: "Bad Request", status: 400 });
  expect(body.detail).toMatch(/docs\/PROBLEMS\.md#bad-request/);
  // Fixed, actionable, value-free guidance; never pin exact generic 400 prose.
  for (const value of values.filter(value => value.trim().length > 0)) expect(body.detail).not.toContain(value);
  expect(result.recorder.prepared).toEqual([]);
  expect(result.recorder.statements).toEqual([]);
  expect(result.response.headers.get("etag")).toBeNull();
  expect(result.response.headers.get("link")).toBeNull();
  return body.detail;
}
describe.each(SELECTORS)("auth then value-free validation before D1/304: %s", selector => {
  it.each(["", " \t\r\n ", " 　", "x".repeat(101), "🚛".repeat(101), "x".repeat(100) + "🚛", "x" + " ".repeat(100)])("rejects malformed opaque value %j", async value => {
    await bad({ [selector]: value }, [value]);
  });
  it("rejects bare and encoded duplicate names with stable value-free guidance", async () => {
    const baseline = await bad(`${selector}`);
    const encoded = selector.replace("owning", "own%69ng");
    for (const [first, second] of [["private-one", "private-two"], ["private-one", "private-one"], ["", "private-two"], ["private-one", ""]]) {
      const detail = await bad(`${selector}=${first}&${encoded}=${second}`, [first, second]);
      expect(detail).toBe(baseline);
    }
  });
  it("validates before countOnly and strictQuery, without logging submitted values", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    await bad({ [selector]: "private-".repeat(20), countOnly: "true" }, ["private-"]);
    await bad({ [selector]: "", strictQuery: "true" });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it.each([null, "invalid-token"])("auth wins over malformed/repeated query and wildcard conditional (%s)", async token => {
    const result = await request(`${selector}=&${selector}=private-one`, { token, headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(401);
    const body = await result.response.json();
    expect(body).toMatchObject({ status: 401, title: "Unauthorized" });
    expect(JSON.stringify(body)).not.toMatch(/private-one|owningCustomerNumber|owningSubCustomerNumber/);
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
    expect(result.response.headers.get("etag")).toBeNull();
  });
});
it.each(["test-read-token", "test-api-token", "test-sync-secret"])("permits the existing read credentials, %s", async token => {
  const result = await request(pair, { token });
  expect(result.response.status).toBe(200);
  expect(ids(await result.response.json() as Body)).toEqual(BOTH);
});
it("strictQuery rejects unknown companions before D1 and countOnly conflicts remain value-free", async () => {
  await bad({ ...pair, strictQuery: "true", bogus_param: "private-marker" }, ["00042", "North", "private-marker"]);
  const result = await request({ ...pair, countOnly: "true", includeTotal: "false" });
  expect(result.response.status).toBe(400);
  expect(await result.response.text()).not.toMatch(/00042|North/);
  expect(result.recorder.prepared).toEqual([]);
});
it("does not log raw successful numbers and repeated GET remains idempotent", async () => {
  const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
  const query = { owningCustomerNumber: SPECIAL, owningSubCustomerNumber: SUB_SPECIAL };
  const first = await page(query);
  expect(ids(first.body)).toEqual([110, 111, 120]);
  const second = await page(query);
  expect(second.body).toEqual(first.body);
  expect(second.recorder.statements).toEqual(first.recorder.statements);
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});

it("legacy mirror gaps: omission keeps orphan equipment, either explicit number excludes it", async () => {
  // Fixture-only copies retain every real column but remove FK constraints.
  // Replace bottom-up to avoid an impossible FK-enforced orphan setup. Normal
  // tests above use the real migrated schema. HTTP still cannot write anything.
  const db = TEST_ENV.CUSTOMER_DB;
  const triggers = await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all<{ name: string; sql: string }>();
  await db.batch([
    ...triggers.results.map(t => db.prepare(`DROP TRIGGER "${t.name.replace(/"/g, '""')}"`)),
    db.prepare("CREATE TABLE legacy_container_snapshot AS SELECT * FROM container_snapshot"),
    db.prepare("CREATE TABLE legacy_address_snapshot AS SELECT * FROM address_snapshot"),
    db.prepare("DROP TABLE container_snapshot"), db.prepare("DROP TABLE address_snapshot"),
    db.prepare("ALTER TABLE legacy_address_snapshot RENAME TO address_snapshot"),
    db.prepare("ALTER TABLE legacy_container_snapshot RENAME TO container_snapshot"),
    ...triggers.results.map(t => db.prepare(t.sql)),
    db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (9998, 9999, 1, ?)").bind(STAMP),
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, synced_at) VALUES (901, 9997, 1, ?), (902, 9998, 1, ?)").bind(STAMP, STAMP),
  ]);
  beforeState = await state();
  const omitted = await page({ ids: "10,901,902" });
  expect(ids(omitted.body)).toEqual([10, 901, 902]);
  const selections: Record<string, string>[] = [{ owningCustomerNumber: "00042" }, { owningSubCustomerNumber: "North" }, pair];
  for (const filters of selections) {
    expect(ids((await page({ ...filters, ids: "10,901,902" })).body)).toEqual([10]);
    const counted = await page({ ...filters, ids: "10,901,902", countOnly: "true" });
    expect(counted.body.total).toBe(1);
    expect(ids((await page({ ...filters, ids: "901,902", includeTotal: "false" })).body)).toEqual([]);
  }
});

type Parameter = { name: string; in: string; required?: boolean; description?: string; example?: unknown; examples?: Record<string, { value?: unknown }>; schema: { type?: string; minLength?: number; maxLength?: number; default?: unknown; description?: string; example?: unknown } };
type Operation = { operationId: string; description: string; parameters?: Parameter[]; responses: Record<string, { description: string }>; "x-effect"?: string; "x-access"?: string };
async function document() {
  const result = await request(new URL("/openapi.json", ORIGIN), { token: null });
  expect(result.response.status).toBe(200);
  expect(result.recorder.prepared).toEqual([]);
  return await result.response.json() as { paths: Record<string, Record<string, Operation>> };
}
describe("mounted owning-number discovery", () => {
  it.each(SELECTORS)("publishes an optional opaque account reference with Unicode bounds and example: %s", async selector => {
    const op = (await document()).paths[PATH].get;
    expect(op).toMatchObject({ operationId: "listContainerSnapshot", "x-effect": "local-read", "x-access": "read" });
    const matches = op.parameters!.filter(p => p.in === "query" && p.name === selector);
    expect(matches).toHaveLength(1);
    const p = matches[0];
    expect(p.required ?? false).toBe(false);
    expect(p.schema).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
    expect(p.schema.default).toBeUndefined();
    const examples = [p.example, p.schema.example, ...Object.values(p.examples ?? {}).map(e => e.value)];
    expect(examples.some(v => typeof v === "string" && v.trim().length > 0 && [...v].length <= 100)).toBe(true);
    const guidance = `${p.description ?? ""} ${p.schema.description ?? ""} ${op.description}`;
    for (const pattern of [/exact/i, /case.sensitive/i, /Unicode code points/i, /whitespace/i, /customer_snapshot|owning customer/i]) expect(guidance).toMatch(pattern);
  });
  it("serves recovery guidance and an inventory matching the ordinary list only", async () => {
    const doc = await document();
    const op = doc.paths[PATH].get;
    const row = policyDoc.split("\n").find(line => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    const inventory = [...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map(m => m[1]).sort();
    expect(inventory).toEqual(op.parameters!.filter(p => p.in === "query").map(p => p.name).sort());
    for (const selector of SELECTORS) {
      expect(inventory).toContain(selector);
      expect(op.responses["400"].description).toContain(selector);
    }
    for (const pattern of [/100/, /Unicode code points/i, /repeat|duplicate/i, /blank|empty/i, /before.*D1/i, /docs\/PROBLEMS\.md#bad-request/, /URL.encode/i, /omit/i]) expect(op.responses["400"].description).toMatch(pattern);
    for (const [path, methods] of Object.entries(doc.paths)) for (const [method, operation] of Object.entries(methods)) {
      if (path === PATH && method === "get") continue;
      for (const selector of SELECTORS) expect(operation.parameters?.filter(p => p.in === "query").map(p => p.name) ?? [], `${method} ${path}`).not.toContain(selector);
    }
  });
});
