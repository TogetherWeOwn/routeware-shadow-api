/// <reference types="vite/client" />

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned oracle; Builder must not edit. Independent literal IDs and
 * real synthetic local D1, written before the implementation. Run:
 * npx vitest run test/containerCostShareEnclosureTexts.acceptance.test.ts --maxWorkers=2
 * Mutations: ignored/swapped/ORed columns, numeric/percent coercion, LIKE,
 * trimming/case-folding/normalization, UTF-16 bounds, COUNT/seek drift,
 * validation after auth/D1/304, lost links, stale sparse ETags, reflected values.
 * Fixture setup alone writes. HTTP denies network, browser, R2 and D1 writes;
 * row/schema snapshots verify idempotence. No live data or remote access.
 * GET is an idempotent local read; CLI --dry-run is not applicable.
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/container-snapshot";
const ORIGIN = "https://container-report-texts.test.invalid";
const STAMP = "2026-01-02T03:04:05.000Z";
const SPECIAL = ` 雪' OR 1=1 -- \"%_ /+?&#🚛 `;
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
const SELECTORS = ["costShare", "enclosureDoors"] as const;
type Query = Record<string, string> | string | URL;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
type Fixture = readonly [number, number, string | null, string | null];

// Own-column decoys: 70 swaps the two ordinary values; 290/300 plant each
// needle only in the OTHER column with NULL in the requested column.
// 60/260/270 distinguish percentages from plain text in BOTH directions.
const FIXTURES: readonly Fixture[] = [
  [10, 11, "50", "2"], [20, 11, "50", "other"], [30, 11, "other", "2"],
  [40, 12, "50", "2"], [50, 21, "50", "2"], [60, 11, "50%", "2%"],
  [70, 11, "2", "50"], [80, 11, "050", "02"], [90, 11, null, null],
  [100, 11, "", ""], [110, 11, " \t\n ", " \t\n "],
  [120, 11, SPECIAL, SPECIAL], [130, 12, SPECIAL, SPECIAL],
  [140, 11, "50 ", "2 "], [150, 11, " 50", " 2"],
  [160, 11, "label", "label"], [170, 11, "LABEL", "LABEL"],
  [180, 11, "é", "é"], [190, 11, "é", "é"],
  [200, 11, "A".repeat(100), "A".repeat(100)],
  [210, 11, "🚛".repeat(100), "🚛".repeat(100)],
  [220, 11, "a", "a"], [230, 11, "0", "0"], [240, 11, "%_", "%_"],
  [250, 11, "x50x", "x2x"], [260, 11, "50%", "2"], [270, 11, "50", "2%"],
  [280, 11, "50", "2"], [290, 11, null, "50"], [300, 11, "2", null],
  [310, 11, " edge　", " edge　"], [320, 11, "x\t\ny", "x\t\ny"],
];
const ALL = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250, 260, 270, 280, 290, 300, 310, 320];
const BOTH = { costShare: "50", enclosureDoors: "2" };
const ids = (body: Body) => body.rows.map(row => row.container_id);
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
let denied: string[];
let beforeState: unknown;

function recordedDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const forbid = (effect: string): never => { denied.push(effect); throw new Error("Unexpected effect in report-text oracle"); };
  function wrap(real: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return {
      bind: (...values: unknown[]) => wrap(real.bind(...values), sql, values),
      first: (...args: unknown[]) => {
        statements.push({ sql, binds });
        return (real.first as (...args: unknown[]) => unknown)(...args);
      },
      all: () => { statements.push({ sql, binds }); return real.all(); },
      raw: (...args: unknown[]) => {
        statements.push({ sql, binds });
        return (real.raw as (...args: unknown[]) => unknown)(...args);
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
  const db = TEST_ENV.CUSTOMER_DB;
  return Promise.all([
    ...["customer_snapshot", "address_snapshot", "container_snapshot"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()),
    db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
  ]).then(results => results.map(r => r.results));
}
async function request(query: Query = {}, options: { token?: string | null; headers?: Record<string, string> } = {}) {
  const recorder = recordedDb();
  const url = query instanceof URL ? query : new URL(PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = typeof query === "string" ? query : new URLSearchParams(query).toString();
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Report-text-oracle", ...options.headers });
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
  expect(response.headers.get("x-request-id")).toBe("Report-text-oracle");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
function reads(result: Awaited<ReturnType<typeof request>>) {
  const q = result.url.searchParams;
  const free = q.get("includeTotal") === "false";
  const statements = result.recorder.statements;
  expect(statements).toHaveLength(free ? 1 : 2);
  expect(statements.filter(isCount)).toHaveLength(free ? 0 : 1);
  const select = statements.find(s => !isCount(s))!;
  const pagingBinds = /\bOFFSET\b/i.test(select.sql) ? 2 : 1;
  // exactNext's lookahead fetches limit+1; ordinary pagination fetches limit.
  expect(select.binds[select.binds.length - pagingBinds]).toBe(Number(q.get("limit") ?? 50) + (q.get("exactNext") === "true" ? 1 : 0));
  if (!free) expect(select.binds.slice(0, -pagingBinds)).toEqual(statements.find(isCount)!.binds);
}
async function page(query: Query = {}, headers?: Record<string, string>) {
  const result = await request(query, { headers });
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  posture(result.response);
  reads(result);
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
  expect(url.username).toBe(""); expect(url.password).toBe(""); expect(url.hash).toBe("");
  expect(url.pathname).toBe(PATH);
  expect(url.searchParams.has("offset")).toBe(false);
  expect(url.searchParams.getAll("cursor")).toEqual([String(result.body.nextCursor)]);
  const ignore = ["offset", "cursor", "bogus_param", "authorization", "origin"];
  for (const [key, raw] of result.url.searchParams) {
    if (ignore.includes(key)) continue;
    const value = key === "q" ? raw.trim() : raw;
    if ((key === "order" && value === "asc") || (key === "includeTotal" && value === "true") || (["enabled", "parentEnabled"].includes(key) && value === "any")) {
      expect([[], [value]], key).toContainEqual(url.searchParams.getAll(key));
    } else expect(url.searchParams.getAll(key), key).toEqual([value]);
  }
  for (const key of ["bogus_param", "authorization", "origin"]) expect(url.searchParams.has(key)).toBe(false);
  expect([...url.searchParams.keys()].every(key => key === "cursor" || result.url.searchParams.has(key))).toBe(true);
  return url;
}
async function hash(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}"`;
}
function noSql(result: Awaited<ReturnType<typeof request>>) {
  expect(result.recorder.prepared).toEqual([]);
  expect(result.recorder.statements).toEqual([]);
  expect(result.response.headers.get("etag")).toBeNull();
  expect(result.response.headers.get("link")).toBeNull();
}
async function bad(result: Awaited<ReturnType<typeof request>>, values: string[] = []) {
  expect(result.response.status).toBe(400);
  posture(result.response);
  noSql(result);
  expect(result.response.headers.get("content-type")).toContain("application/problem+json");
  const body = await result.response.json() as { detail: string };
  expect(body).toMatchObject({ type: BAD_REQUEST, title: "Bad Request", status: 400 });
  expect(body.detail).toMatch(/docs\/PROBLEMS\.md#bad-request/);
  expect(body.detail).toMatch(/query|parameter|countOnly/i);
  for (const value of values.filter(v => v.trim().length > 0)) expect(JSON.stringify(body)).not.toContain(value);
  return body.detail;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  denied = [];
  vi.stubGlobal("fetch", vi.fn(async () => { denied.push("network"); throw new Error("Unexpected outbound fetch"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, synced_at) VALUES (1, 'Synthetic One', ?), (2, 'Synthetic Two', ?)").bind(STAMP, STAMP),
    db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, enabled, synced_at) VALUES (11, 1, 7, '001', 1, ?), (12, 1, 7, '001', 0, ?), (21, 2, 8, '1', 1, ?)").bind(STAMP, STAMP, STAMP),
  ]);
  await db.batch([...FIXTURES].reverse().map(([id, parent, cost, doors]) =>
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, ud_cost_share_ud, ud_enclosure_doors_ud, enabled, serial_number, rfid, container_type_id, oncall, gps_locked, ud_material_stream_ud, color, service_code_type, service_code_input, location_address, city, state, zip, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, parent, cost, doors, id === 40 ? 0 : 1, id === 20 ? "other" : "asset", id === 280 ? "" : "tag", id === 280 ? 8 : 7, id === 280 ? 1 : 0, id === 280 ? 1 : 0, id === 280 ? "Glass" : "Paper", id === 280 ? "Blue" : "Green", id === 280 ? "T-2" : "T-1", id === 280 ? "IN-2" : "IN-1", id === 280 ? "South Depot" : "North Depot", id === 280 ? "Riverton" : "Killeen", id === 280 ? "ST" : "TX", id === 280 ? "00999" : "02139", STAMP)));
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denied).toEqual([]);
    expect(await state(), "GET must not mutate rows or schema").toEqual(beforeState);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

it("CONTROL: real D1 proves the literal cohorts and the all-selector intersection are satisfiable", async () => {
  const db = TEST_ENV.CUSTOMER_DB;
  for (const [column, value, want] of [
    ["ud_cost_share_ud", "50", [10, 20, 40, 50, 270, 280]],
    ["ud_cost_share_ud", "50%", [60, 260]],
    ["ud_enclosure_doors_ud", "2", [10, 30, 40, 50, 260, 280]],
    ["ud_enclosure_doors_ud", "2%", [60, 270]],
  ] as const) {
    const result = await db.prepare(`SELECT container_id FROM container_snapshot WHERE ${column} = ? ORDER BY container_id`).bind(value).all<{ container_id: number }>();
    expect(result.results.map(row => row.container_id)).toEqual(want);
  }
  const pair = await db.prepare("SELECT container_id FROM container_snapshot WHERE ud_cost_share_ud = ? AND ud_enclosure_doors_ud = ? ORDER BY container_id").bind("50", "2").all<{ container_id: number }>();
  expect(pair.results.map(row => row.container_id)).toEqual([10, 40, 50, 280]);
  const composed = await db.prepare(`SELECT c.container_id FROM container_snapshot c
    JOIN address_snapshot a ON a.pickup_address_id = c.pickup_address_id
    WHERE c.ud_cost_share_ud = '50' AND c.ud_enclosure_doors_ud = '2'
    AND a.customer_id = 1 AND c.pickup_address_id = 11 AND c.container_id = 10
    AND c.container_id IN (10, 20) AND c.serial_number = 'asset' AND c.rfid = 'tag'
    AND c.serial_number IS NOT NULL AND c.serial_number != '' AND c.rfid IS NOT NULL AND c.rfid != ''
    AND c.container_type_id = 7 AND c.ud_material_stream_ud = 'Paper' AND c.color = 'Green'
    AND c.service_code_type = 'T-1' AND c.service_code_input = 'IN-1'
    AND c.location_address = 'North Depot' AND c.city = 'Killeen' AND c.state = 'TX' AND c.zip = '02139'
    AND a.route_id = 7 AND a.franchise_id = '001' AND a.enabled = 1
    AND instr(lower(c.location_address), 'north') > 0 AND c.enabled = 1 AND c.oncall = 0 AND c.gps_locked = 0
    AND c.container_id >= 10 AND c.container_id <= 10`).all<{ container_id: number }>();
  expect(composed.results.map(row => row.container_id)).toEqual([10]);
});

describe.each(SELECTORS)("%s: independent opaque mirrored report text", selector => {
  it("selects only its own column, including duplicate rows on joined and unjoined paths", async () => {
    for (const joined of [false, true]) {
      const result = await page({ [selector]: selector === "costShare" ? "50" : "2", ...(joined ? { customerId: "1" } : {}) });
      const want = selector === "costShare" ? [10, 20, 40, 50, 270, 280] : [10, 30, 40, 50, 260, 280];
      expect(ids(result.body)).toEqual(joined ? want.filter(id => id !== 50) : want);
      expect(result.body.total).toBe(joined ? 5 : 6);
    }
  });
  it.each([
    ["percent is not a number", "50%", "2%", [60, 260], [60, 270]],
    ["cross-column needle never spills", "2", "50", [70, 300], [70, 290]],
    ["leading zeros are not parsed", "050", "02", [80], [80]],
    ["trailing whitespace is data", "50 ", "2 ", [140], [140]],
    ["leading whitespace is data", " 50", " 2", [150], [150]],
    ["case stays lowercase", "label", "label", [160], [160]],
    ["case stays uppercase", "LABEL", "LABEL", [170], [170]],
    ["no Unicode normalization", "é", "é", [180], [180]],
    ["decomposed Unicode stays distinct", "é", "é", [190], [190]],
    ["100 ASCII code points", "A".repeat(100), "A".repeat(100), [200], [200]],
    ["100 astral code points, not UTF-16 units", "🚛".repeat(100), "🚛".repeat(100), [210], [210]],
    ["one code point", "a", "a", [220], [220]],
    ["zero is opaque nonempty text", "0", "0", [230], [230]],
    ["wildcards are literal", "%_", "%_", [240], [240]],
    ["Unicode edge whitespace is data", " edge　", " edge　", [310], [310]],
    ["internal whitespace is data", "x\t\ny", "x\t\ny", [320], [320]],
    ["URL and SQL-looking text is literal", SPECIAL, SPECIAL, [120, 130], [120, 130]],
    ["no substring expansion", "%", "%", [], []],
    ["no SQL expansion", "' OR 1=1 --", "' OR 1=1 --", [], []],
    ["NULL is not the text null", "null", "null", [], []],
    ["unknown is an empty success", "synthetic-absent", "synthetic-absent", [], []],
  ] as const)("%s", async (_name, cost, doors, costIds, doorIds) => {
    for (const joined of [false, true]) {
      const result = await page({ [selector]: selector === "costShare" ? cost : doors, ...(joined ? { customerId: "1" } : {}) });
      const want = selector === "costShare" ? costIds : doorIds;
      expect(ids(result.body)).toEqual(want);
      expect(result.body.total).toBe(want.length);
      expect(result.body.nextCursor).toBeNull();
      expect(result.response.headers.get("link")).toBeNull();
    }
  });
  it("binds a single qualified equality without coercion or interpolation", async () => {
    for (const joined of [false, true]) {
      const result = await page({ [selector]: SPECIAL, ...(joined ? { customerId: "1" } : {}) });
      expect(ids(result.body)).toEqual([120, 130]);
      const column = selector === "costShare" ? "ud_cost_share_ud" : "ud_enclosure_doors_ud";
      for (const { sql, binds } of result.recorder.statements) {
        expect(sql).toMatch(new RegExp(`\\bc\\.${column}\\s*=\\s*\\?`, "i"));
        expect(sql).not.toContain(SPECIAL);
        expect(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP)\b|\b(?:CAST|TRIM|LOWER|UPPER|SUM)\s*\(|\bCOLLATE\s+NOCASE\b/i);
        expect(binds.filter(value => value === SPECIAL)).toHaveLength(1);
        expect((await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all()).success).toBe(true);
      }
    }
  });
  it.each([
    ["empty", ""], ["ASCII blank", " \t\r\n "], ["Unicode blank", "  　"],
    ["101 ASCII", "private-" + "x".repeat(93)], ["101 astral", "🚛".repeat(101)],
    ["100 ASCII plus astral", "x".repeat(100) + "🚛"], ["cannot trim into bounds", "x" + " ".repeat(100)],
  ])("rejects %s before D1/304 with a fixed value-free next action", async (_name, value) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const detail = await bad(await request({ [selector]: value }, { headers: { "if-none-match": "*" } }), [value]);
    const other = await bad(await request({ [selector]: "another-private-" + "y".repeat(101) }));
    expect(detail).toBe(other);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it.each([["private-a", "private-a"], ["private-a", "private-b"], ["", "private-b"], ["private-a", ""]])("rejects raw and encoded repeats (%j, %j) without reflecting values", async (a, b) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const encoded = `%${selector.charCodeAt(0).toString(16)}${selector.slice(1)}`;
    const details: string[] = [];
    for (const key of [selector, encoded]) details.push(await bad(await request(`${selector}=${encodeURIComponent(a)}&${key}=${encodeURIComponent(b)}`, { headers: { "if-none-match": "*" } }), [a, b]));
    expect(details[0]).toBe(details[1]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it("rejects a bare key and validates even on countOnly", async () => {
    await bad(await request(selector));
    await bad(await request({ [selector]: "", countOnly: "true" }));
  });
});

const SCOPES = [
  [{}, [10, 40, 50, 280]],
  [{ customerId: "1" }, [10, 40, 280]], [{ customerId: "2" }, [50]],
  [{ pickupAddressId: "11" }, [10, 280]], [{ pickupAddressId: "12" }, [40]],
  [{ containerId: "40" }, [40]], [{ containerId: "20" }, []],
  [{ ids: "10,20,30,280" }, [10, 280]], [{ ids: "20,30,70" }, []],
  [{ serialNumber: "asset" }, [10, 40, 50, 280]], [{ serialNumber: "other" }, []],
  [{ rfid: "tag" }, [10, 40, 50]], [{ rfid: "other" }, []],
  [{ hasSerialNumber: "true" }, [10, 40, 50, 280]], [{ hasSerialNumber: "false" }, []],
  [{ hasRfid: "true" }, [10, 40, 50]], [{ hasRfid: "false" }, [280]],
  [{ containerTypeId: "7" }, [10, 40, 50]], [{ containerTypeId: "8" }, [280]],
  [{ materialStream: "Paper" }, [10, 40, 50]], [{ materialStream: "Glass" }, [280]],
  [{ color: "Green" }, [10, 40, 50]], [{ color: "Blue" }, [280]],
  [{ serviceCodeType: "T-1" }, [10, 40, 50]], [{ serviceCodeType: "T-2" }, [280]],
  [{ serviceCodeInput: "IN-1" }, [10, 40, 50]], [{ serviceCodeInput: "IN-2" }, [280]],
  [{ locationAddress: "North Depot" }, [10, 40, 50]], [{ locationAddress: "South Depot" }, [280]],
  [{ city: "Killeen" }, [10, 40, 50]], [{ city: "Riverton" }, [280]],
  [{ state: "TX" }, [10, 40, 50]], [{ state: "ST" }, [280]],
  [{ zip: "02139" }, [10, 40, 50]], [{ zip: "00999" }, [280]],
  [{ parentRouteId: "7" }, [10, 40, 280]], [{ parentRouteId: "8" }, [50]],
  [{ parentFranchiseId: "001" }, [10, 40, 280]], [{ parentFranchiseId: "1" }, [50]],
  [{ parentEnabled: "true" }, [10, 50, 280]], [{ parentEnabled: "false" }, [40]],
  [{ q: "north" }, [10, 40, 50]], [{ q: "no-such-match" }, []],
  [{ enabled: "true" }, [10, 50, 280]], [{ enabled: "false" }, [40]],
  [{ onCall: "true" }, [280]], [{ onCall: "false" }, [10, 40, 50]],
  [{ gpsLocked: "true" }, [280]], [{ gpsLocked: "false" }, [10, 40, 50]],
  [{ lowerId: "40", upperId: "50" }, [40, 50]], [{ cursor: "40" }, [50, 280]],
  [{ order: "desc", cursor: "50" }, [40, 10]],
  [{ customerId: "2", pickupAddressId: "11" }, []],
  [{ customerId: "1", pickupAddressId: "11", containerId: "10", ids: "10,20", serialNumber: "asset", rfid: "tag", hasSerialNumber: "true", hasRfid: "true", containerTypeId: "7", materialStream: "Paper", color: "Green", serviceCodeType: "T-1", serviceCodeInput: "IN-1", locationAddress: "North Depot", city: "Killeen", state: "TX", zip: "02139", parentRouteId: "7", parentFranchiseId: "001", parentEnabled: "true", q: "north", enabled: "true", onCall: "false", gpsLocked: "false", lowerId: "10", upperId: "10", fields: "enabled", strictQuery: "true" }, [10]],
] as const;
describe("AND composition with every selector merged on the starting baseline", () => {
  it.each(SCOPES)("COUNT, page and countOnly agree for %j", async (filters, want) => {
    for (const includeTotal of ["true", "false"]) {
      const result = await page({ ...BOTH, ...filters, includeTotal });
      expect(ids(result.body)).toEqual(want);
      expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
    }
    const only = await request({ ...BOTH, ...filters, countOnly: "true" });
    expect(only.response.status).toBe(200);
    posture(only.response);
    expect(only.recorder.statements).toHaveLength(1);
    expect(only.recorder.statements.filter(isCount)).toHaveLength(1);
    expect(await only.response.json()).toEqual({ rows: [], total: want.length, nextCursor: null });
    expect(only.response.headers.get("link")).toBeNull();
  });
  it.each([
    [{ costShare: "50", enclosureDoors: "other" }, [20]],
    [{ costShare: "other", enclosureDoors: "2" }, [30]],
    [{ costShare: "50%", enclosureDoors: "2%" }, [60]],
    [{ costShare: "50%", enclosureDoors: "2" }, [260]],
    [{ costShare: "50", enclosureDoors: "2%" }, [270]],
    [{ costShare: "2", enclosureDoors: "50" }, [70]],
    [{ costShare: "50", enclosureDoors: "50" }, []],
    [{ costShare: "synthetic-absent", enclosureDoors: "2" }, []],
  ] as const)("keeps columns independent and percentages opaque: %j", async (query, want) => {
    const result = await page(query);
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
  });
  it("countOnly rejects count-free conflict with value-free recovery guidance", async () => {
    const detail = await bad(await request({ costShare: SPECIAL, enclosureDoors: SPECIAL, countOnly: "true", includeTotal: "false" }), [SPECIAL]);
    expect(detail).toMatch(/countOnly/);
    expect(detail).toMatch(/includeTotal|omit|remove/i);
  });
  it("CONTROL: omission preserves defaults, NULL/empty/blank text and canonical columns", async () => {
    const plain = await page();
    expect(ids(plain.body)).toEqual(ALL);
    expect(plain.body.total).toBe(32);
    expect(plain.body.rows[0]).toMatchObject({ container_id: 10, pickup_address_id: 11, ud_cost_share_ud: "50", ud_enclosure_doors_ud: "2", synced_at: STAMP });
    expect(plain.body.rows[8]).toMatchObject({ container_id: 90, ud_cost_share_ud: null, ud_enclosure_doors_ud: null });
    expect(plain.body.rows[9]).toMatchObject({ container_id: 100, ud_cost_share_ud: "", ud_enclosure_doors_ud: "" });
    expect(plain.body.rows[10]).toMatchObject({ container_id: 110, ud_cost_share_ud: " \t\n ", ud_enclosure_doors_ud: " \t\n " });
    const explicit = await page({ enabled: "any", parentEnabled: "any", includeTotal: "true", offset: "0", limit: "50" });
    expect(explicit.bytes).toBe(plain.bytes);
    const unknown = await page({ bogus_param: "private-marker" });
    expect(unknown.bytes).toBe(plain.bytes);
    expect(unknown.recorder.statements).toEqual(plain.recorder.statements);
  });
});

describe.each(["true", "false"])("continuations and sparse validators, includeTotal=%s", includeTotal => {
  it.each(["asc", "desc"])("fully follows %s exactNext pages through an offset-to-seek transition", async order => {
    const filters = { ...BOTH, customerId: "1", parentRouteId: "7", parentFranchiseId: "001", lowerId: "10", upperId: "280", fields: "enabled", limit: "1", includeTotal, order, exactNext: "true", strictQuery: "true" };
    let result = await page({ ...filters, offset: "1" });
    const expected = order === "asc" ? [40, 280] : [40, 10];
    const seen: unknown[] = [];
    for (let i = 0; i < expected.length; i++) {
      expect(result.body.rows).toEqual([{ container_id: expected[i], enabled: expected[i] === 40 ? 0 : 1 }]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : [3, 1][i]);
      seen.push(...ids(result.body));
      expect(result.body.nextCursor).toBe(i === 0 ? 40 : null);
      if (i === 0) result = await page(next(result));
      else expect(result.response.headers.get("link")).toBeNull();
    }
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(2);
  });
  it.each(["asc", "desc"])("retains literal texts on all %s legacy pages, including the terminal empty page", async order => {
    let result = await page({ costShare: SPECIAL, enclosureDoors: SPECIAL, fields: "enabled", limit: "1", order, includeTotal, bogus_param: "private-marker", authorization: "private-token", origin: "https://untrusted.invalid" });
    for (const id of order === "asc" ? [120, 130] : [130, 120]) {
      expect(result.body.rows).toEqual([{ container_id: id, enabled: 1 }]);
      const link = result.response.headers.get("link")!;
      expect(link).not.toContain(SPECIAL);
      expect(link).not.toMatch(/private-marker|private-token|untrusted|test-read-token/);
      result = await page(next(result));
    }
    expect(result.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
  });
  it.each(["asc", "desc"])("cursor overrides offset without losing predicates in %s order", async order => {
    const result = await page({ ...BOTH, cursor: "40", offset: "999", limit: "1", order, includeTotal });
    expect(ids(result.body)).toEqual(order === "asc" ? [50] : [10]);
    expect(result.body.total).toBe(includeTotal === "false" ? null : order === "asc" ? 2 : 1);
    for (const s of result.recorder.statements) expect(s.sql).not.toMatch(/\bOFFSET\b/i);
    next(result);
  });
  it("hashes the final sparse envelope and preserves links on strong/weak/wildcard 304", async () => {
    const query = { ...BOTH, fields: "enabled", limit: "2", includeTotal };
    const first = await page(query);
    expect(first.body.rows).toEqual([{ container_id: 10, enabled: 1 }, { container_id: 40, enabled: 0 }]);
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
      posture(same.response); reads(same);
      expect(same.recorder.statements).toEqual(first.recorder.statements);
    }
    for (const changed of [{ costShare: "50%" }, { enclosureDoors: "2%" }, { fields: "city" }]) {
      const different = await page({ ...query, ...changed }, { "if-none-match": tag });
      expect(different.response.headers.get("etag")).not.toBe(tag);
    }
  });
});
it.each(SELECTORS)("invalidates sparse membership when unprojected %s changes, synced_at unchanged", async selector => {
  const query = { costShare: SPECIAL, enclosureDoors: SPECIAL, fields: "enabled" };
  const first = await page(query);
  expect(ids(first.body)).toEqual([120, 130]);
  const column = selector === "costShare" ? "ud_cost_share_ud" : "ud_enclosure_doors_ud";
  await TEST_ENV.CUSTOMER_DB.prepare(`UPDATE container_snapshot SET ${column} = NULL WHERE container_id = 120`).run();
  beforeState = await state();
  const changed = await page(query, { "if-none-match": await hash(first.bytes) });
  expect(changed.body).toEqual({ rows: [{ container_id: 130, enabled: 1 }], total: 1, nextCursor: null });
});
it.each([null, "invalid-token"])("CONTROL: auth precedes malformed selectors and 304, token=%s", async token => {
  const result = await request("costShare=&enclosureDoors=private-a&%65nclosureDoors=private-b", { token, headers: { "if-none-match": "*" } });
  expect(result.response.status).toBe(401);
  expect(result.response.headers.get("content-type")).toContain("application/problem+json");
  const body = await result.response.json();
  expect(body).toMatchObject({ status: 401, title: "Unauthorized" });
  expect(JSON.stringify(body)).not.toMatch(/costShare|enclosureDoors|private-a|private-b/);
  noSql(result);
});
it.each(["test-read-token", "test-api-token", "test-sync-secret"])("retains authorized GET access via %s", async token => {
  const result = await request(BOTH, { token });
  expect(result.response.status).toBe(200);
  expect(ids(await result.response.json() as Body)).toEqual([10, 40, 50, 280]);
});
it("is idempotent and never logs successful raw report texts", async () => {
  const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
  const first = await page({ costShare: SPECIAL, enclosureDoors: SPECIAL });
  const second = await page({ costShare: SPECIAL, enclosureDoors: SPECIAL });
  expect(ids(first.body)).toEqual([120, 130]);
  expect(second.bytes).toBe(first.bytes);
  expect(second.recorder.statements).toEqual(first.recorder.statements);
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});

type Parameter = { name: string; in: string; required?: boolean; description?: string; example?: unknown; examples?: Record<string, { value?: unknown }>; schema: { type?: string; minLength?: number; maxLength?: number; default?: unknown; description?: string; example?: unknown } };
type Operation = { operationId: string; description: string; parameters?: Parameter[]; responses: Record<string, { description: string }>; "x-effect"?: string; "x-access"?: string };
async function document() {
  const result = await request(new URL("/openapi.json", ORIGIN), { token: null });
  expect(result.response.status).toBe(200);
  expect(result.recorder.prepared).toEqual([]);
  return await result.response.json() as { paths: Record<string, { get?: Operation; post?: Operation }> };
}
describe("mounted discovery and preserve-if-merged presence", () => {
  it.each(SELECTORS)("publishes only ordinary-list %s as optional bounded opaque text", async selector => {
    const doc = await document();
    const op = doc.paths[PATH].get!;
    expect(op).toMatchObject({ operationId: "listContainerSnapshot", "x-effect": "local-read", "x-access": "read" });
    const matches = op.parameters!.filter(p => p.in === "query" && p.name === selector);
    expect(matches).toHaveLength(1);
    const p = matches[0];
    expect(p.required ?? false).toBe(false);
    expect(p.schema).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
    expect(p.schema.default).toBeUndefined();
    const examples = [p.example, p.schema.example, ...Object.values(p.examples ?? {}).map(e => e.value)];
    expect(examples.some(value => typeof value === "string" && value.trim().length > 0 && [...value].length <= 100)).toBe(true);
    const guidance = `${p.description ?? ""} ${p.schema.description ?? ""} ${op.description}`;
    for (const pattern of [/exact/i, /case.sensitive/i, /Unicode code points/i, /whitespace/i, /mirrored|report/i, /\bAND\b|intersect/i]) expect(guidance).toMatch(pattern);
    expect(guidance).toContain(selector === "costShare" ? "ud_cost_share_ud" : "ud_enclosure_doors_ud");
    for (const [path, methods] of Object.entries(doc.paths)) for (const [method, other] of Object.entries(methods)) {
      if (path === PATH && method === "get") continue;
      expect(other.parameters?.filter(p => p.in === "query").map(p => p.name) ?? [], `${method} ${path}`).not.toContain(selector);
    }
  });
  it("exposes mirrored-text limits, non-inference and actionable recovery in the served contract", async () => {
    const op = (await document()).paths[PATH].get!;
    const text = `${op.description} ${op.parameters!.map(p => `${p.description ?? ""} ${p.schema.description ?? ""}`).join(" ")}`;
    for (const pattern of [/cost.share agreement/i, /invoice allocation/i, /enclosure compliance/i, /access/i, /report.*gap|detail.*gap/i, /no sharing|no.*arrangement/i, /no enclosure/i, /opaque|not.*numeric/i]) expect(text).toMatch(pattern);
    const recovery = op.responses["400"].description;
    for (const pattern of [/costShare/, /enclosureDoors/, /100/, /Unicode code points/i, /repeat|duplicate/i, /blank|empty/i, /before.*D1/i, /application\/problem\+json/, /docs\/PROBLEMS\.md#bad-request/, /omit|remove/i]) expect(recovery).toMatch(pattern);
  });
  it("keeps the canonical machine-consumed query inventory equal to the mounted list", async () => {
    const op = (await document()).paths[PATH].get!;
    const row = policyDoc.split("\n").find(line => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    const inventory = [...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map(m => m[1]).sort();
    expect(inventory).toEqual(op.parameters!.filter(p => p.in === "query").map(p => p.name).sort());
    for (const selector of SELECTORS) expect(inventory).toContain(selector);
  });
  it("intersects exact text with the corresponding presence flag only if that sibling has merged", async () => {
    const names = (await document()).paths[PATH].get!.parameters!.map(p => p.name);
    for (const [selector, presence, value, want] of [
      ["costShare", "hasCostShare", "50", [10, 20, 40, 50, 270, 280]],
      ["enclosureDoors", "hasEnclosureDoors", "2", [10, 30, 40, 50, 260, 280]],
    ] as const) {
      if (!names.includes(presence)) continue;
      for (const includeTotal of ["true", "false"]) {
        const yes = await page({ [selector]: value, [presence]: "true", includeTotal });
        expect(ids(yes.body)).toEqual(want);
        const no = await page({ [selector]: value, [presence]: "false", includeTotal });
        expect(no.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
      }
    }
  });
});
