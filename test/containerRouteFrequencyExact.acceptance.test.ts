import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import snapshotDoc from "../CUSTOMER_SNAPSHOT.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import problemsDoc from "../docs/PROBLEMS.md?raw";
import changelog from "../CHANGELOG.md?raw";
import packageJson from "../package.json";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned acceptance oracle; Builder must not edit this file.
 * Run: npx vitest run test/containerRouteFrequencyExact.acceptance.test.ts --maxWorkers=2
 *
 * Contract pinned (ordinary container snapshot list GET ONLY):
 * - `routeIdsExact` / `frequencyIdsExact`: binary whole-stored-cell equality
 *   on `route_ids` / `frequency_ids` (`COLLATE BINARY = ?`, bound value).
 *   No split, substring, delimiter wrapping, trim, case-fold, numeric or
 *   Unicode normalization: `1` never matches stored `12`, `21` or `1,2`;
 *   order, duplicates and whitespace are significant; stored NULL never
 *   matches; a valid unmatched value is an empty 200.
 * - Lexical: exactly one string of 1..500 Unicode code points (UTF-16
 *   allocation guard before counting). Empty is invalid; whitespace-only
 *   is VALID literal data matching only byte-identical stored whitespace.
 *   Repeated/encoded-duplicate keys fail after auth, before D1/304.
 * - `hasRouteIds` / `hasFrequencyIds`: exact `true|false|any` (default
 *   `any`); present = stored `IS NOT NULL AND <> ''` (whitespace-only
 *   counts as present); `false` is the exact complement. Exact and
 *   presence AND-compose per column and across columns; no OR/union.
 * - COUNT/page share predicates and binds, including the cursor bound in
 *   both; countOnly/count-free, sparse fields, order/cursor/offset-to-seek,
 *   lowerId/upperId/exactNext, strictQuery, ETag/304 and no-store survive;
 *   next links retain effective selectors with commas/spaces encoded.
 * - Naming/docs never imply membership or assignment: these match the
 *   entire mirrored stored cell (`7` does not match stored `7,12`), not
 *   current route assignment, dispatch truth or service eligibility.
 *
 * The 37-case matrix is lifted verbatim from the route/frequency semantics
 * spec and run against BOTH columns independently. Expected sets below are
 * hand-derived literals; a few whole-fixture sets are computed from the
 * fixture table with plain JS strict equality / null-or-empty predicates,
 * which is the independent statement of the same binary contract.
 * Fixture setup alone writes. HTTP denies writes, network, R2 and browser.
 * Expected RED until the paired implementation adds these selectors.
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/container-snapshot";
const ORIGIN = "https://route-frequency-exact.test.invalid";
const STAMP = "2026-01-04T05:06:07.000Z";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
const INJ = "x' OR '1'='1";
const SPECIAL_LIST = "5 &+ 6";
const LONG500 = "9,".repeat(250);
const ASTRAL500 = "🚛".repeat(500);
type Query = Record<string, string> | string | URL;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
type ExactParam = "routeIdsExact" | "frequencyIdsExact";
type PresenceParam = "hasRouteIds" | "hasFrequencyIds";
type Row = {
  id: number; parent: number; route: string | null; freq: string | null;
  enabled?: number; serial?: string | null; city?: string;
};

// Spec matrix, verbatim: [stored, requested, expected match 0|1].
// Row for case n (1-based) is container 1000 + 10n, value in BOTH columns.
const MATRIX: ReadonlyArray<readonly [string | null, string, 0 | 1]> = [
  [null, "1", 0],
  ["", "1", 0],
  [" ", "1", 0],
  ["1", "1", 1],
  ["12", "1", 0],
  ["21", "1", 0],
  ["01", "1", 0],
  ["+1", "1", 0],
  ["1.0", "1", 0],
  [" 1", "1", 0],
  ["1 ", "1", 0],
  ["\t1\n", "1", 0],
  ["1,2", "1", 0],
  ["2,1", "1", 0],
  [",1,", "1", 0],
  ["1;2", "1", 0],
  ["1|2", "1", 0],
  ["1 2", "1", 0],
  ["[1,2]", "1", 0],
  ["[\"1\",\"2\"]", "1", 0],
  ["1,1", "1", 0],
  ["1,2", "1,2", 1],
  ["2,1", "1,2", 0],
  ["1, 2", "1,2", 0],
  ["1,1", "1,1", 1],
  ["1", "1,2", 0],
  ["A", "a", 0],
  ["a", "a", 1],
  ["%", "%", 1],
  ["12", "%", 0],
  ["_", "_", 1],
  ["1", "_", 0],
  ["1\\2", "1\\2", 1],
  ["\u00e9", "e\u0301", 0], // composed U+00E9 stored, decomposed e+U+0301 requested
  [" ", " ", 1],
  ["x' OR 1=1 --", "x' OR 1=1 --", 1],
  ["1", "x' OR 1=1 --", 0],
];
const matrixId = (index: number) => 1000 + 10 * (index + 1);
const ROWS: readonly Row[] = [
  // Pagination/composition cohort: route "7,12", frequency "3, 4".
  { id: 10, parent: 11, route: "7,12", freq: "3, 4", city: "Killeen" },
  { id: 20, parent: 11, route: "7,12", freq: "3, 4", serial: null, city: "Killeen" },
  { id: 30, parent: 12, route: "7,12", freq: "3, 4", enabled: 0, city: "Killeen" },
  { id: 40, parent: 21, route: "7,12", freq: "3, 4", city: "Killeen" },
  { id: 50, parent: 11, route: "7,12", freq: "3, 4", serial: "other", city: "Killeen" },
  { id: 60, parent: 11, route: "7,12", freq: "3, 4", city: "Other" },
  ...MATRIX.map(([stored], i): Row => ({ id: matrixId(i), parent: 11, route: stored, freq: stored })),
  { id: 2010, parent: 11, route: "7,12", freq: "8" },
  { id: 2020, parent: 11, route: "8", freq: "3, 4" },
  { id: 2030, parent: 11, route: null, freq: "3, 4" },
  { id: 2040, parent: 11, route: "7,12", freq: null },
  { id: 2050, parent: 11, route: "", freq: "" },
  { id: 2060, parent: 11, route: " ", freq: "\t" },
  { id: 2070, parent: 11, route: INJ, freq: INJ },
  { id: 2080, parent: 11, route: "7", freq: "7" },
  { id: 2090, parent: 11, route: LONG500, freq: ASTRAL500 },
  { id: 2100, parent: 11, route: "12,7", freq: "12,7" },
  { id: 2110, parent: 11, route: SPECIAL_LIST, freq: SPECIAL_LIST },
  { id: 2120, parent: 12, route: SPECIAL_LIST, freq: "9" },
];
const ALL = ROWS.map(r => r.id);
const COHORT = [10, 20, 30, 40, 50, 60];
const ROUTE_712 = [...COHORT, 2010, 2040];
const FREQ_34 = [...COHORT, 2020, 2030];
const present = (v: string | null) => v !== null && v !== "";
const exactSet = (col: "route" | "freq", value: string) => ROWS.filter(r => r[col] === value).map(r => r.id);
const presenceSet = (col: "route" | "freq", want: boolean) => ROWS.filter(r => present(r[col]) === want).map(r => r.id);
const ids = (body: Body) => body.rows.map(row => row.container_id);
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
const whereOf = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i), sql.search(/\b(?:ORDER|LIMIT|GROUP)\b/i) < 0 ? undefined : sql.search(/\b(?:ORDER|LIMIT|GROUP)\b/i));
let denied: string[];
let beforeState: unknown;

function recordedDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const forbid = (operation: string): never => {
    denied.push(operation);
    throw new Error("Unexpected effect in route/frequency exact oracle");
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
async function request(query: Query = {}, options: { token?: string | null; headers?: Record<string, string>; path?: string } = {}) {
  const recorder = recordedDb();
  const url = query instanceof URL ? query : new URL(options.path ?? PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = typeof query === "string" ? query : new URLSearchParams(query).toString();
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Route-frequency-oracle", ...options.headers });
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
  expect(response.headers.get("x-request-id")).toBe("Route-frequency-oracle");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
function budget(result: Awaited<ReturnType<typeof request>>) {
  const countFree = result.url.searchParams.get("includeTotal") === "false";
  const statements = result.recorder.statements;
  expect(statements).toHaveLength(countFree ? 1 : 2);
  expect(statements.filter(isCount)).toHaveLength(countFree ? 0 : 1);
  const select = statements.find(s => !isCount(s))!;
  const pagingBinds = /\bOFFSET\b/i.test(select.sql) ? 2 : 1;
  // exactNext lookahead reads one row past the page (binds limit + 1).
  const lookahead = result.url.searchParams.get("exactNext") === "true" ? 1 : 0;
  expect(select.binds[select.binds.length - pagingBinds]).toBe(Number(result.url.searchParams.get("limit") ?? 50) + lookahead);
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
  const omittable = (key: string, value: string) =>
    (key === "order" && value === "asc") || (key === "includeTotal" && value === "true") ||
    (key === "enabled" && value === "any") || (key === "parentEnabled" && value === "any") ||
    (key === "hasRouteIds" && value === "any") || (key === "hasFrequencyIds" && value === "any");
  for (const [key, raw] of result.url.searchParams) {
    if (["cursor", "offset", ...ignored].includes(key)) continue;
    const value = key === "q" ? raw.trim() : raw;
    if (omittable(key, value)) expect([[], [value]]).toContainEqual(url.searchParams.getAll(key));
    else expect(url.searchParams.getAll(key), key).toEqual([value]);
  }
  return url;
}
async function traverse(query: Record<string, string>, expected: number[]) {
  const limit = Number(query.limit);
  const countFree = query.includeTotal === "false";
  let result = await page(query);
  const seen: number[] = [];
  for (;;) {
    const pageIds = ids(result.body) as number[];
    if (!countFree) expect(result.body.total).toBe(expected.length - seen.length);
    expect(pageIds).toEqual(expected.slice(seen.length, seen.length + limit));
    seen.push(...pageIds);
    if (pageIds.length < limit) {
      expect(result.body.nextCursor).toBeNull();
      expect(result.response.headers.get("link")).toBeNull();
      break;
    }
    expect(result.body.nextCursor).toBe(pageIds[pageIds.length - 1]);
    result = await page(next(result));
    if (seen.length >= expected.length) {
      // A full terminal page is followed by exactly one empty page.
      expect(result.body).toEqual({ rows: [], total: countFree ? null : 0, nextCursor: null });
      expect(result.response.headers.get("link")).toBeNull();
      break;
    }
  }
  expect(seen).toEqual(expected);
  expect(new Set(seen).size).toBe(expected.length);
}
async function hash(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}"`;
}
async function expectBadQuery(result: Awaited<ReturnType<typeof request>>, param: string, markers: string[] = []) {
  expect(result.response.status).toBe(400);
  posture(result.response);
  expect(result.response.headers.get("content-type")).toContain("application/problem+json");
  expect(result.response.headers.get("link")).toBeNull();
  expect(result.response.headers.get("etag")).toBeNull();
  const problem = await result.response.json() as Record<string, unknown>;
  expect(problem).toMatchObject({ type: BAD_REQUEST, title: "Bad Request", status: 400 });
  // Value-free, param-scoped guidance; generic prose is deliberately not
  // exact-matched, only the named key and the absence of reflected input.
  expect(String(problem.detail)).toContain(param);
  for (const marker of markers) expect(JSON.stringify(problem)).not.toContain(marker);
  expect(result.recorder.prepared).toEqual([]);
  expect(result.recorder.statements).toEqual([]);
}
beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  denied = [];
  vi.stubGlobal("fetch", vi.fn(async () => { denied.push("network"); throw new Error("Unexpected network in route/frequency oracle"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, synced_at) VALUES (1, 'Synthetic One', ?), (2, 'Synthetic Two', ?)").bind(STAMP, STAMP),
    db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, state, city, zip, route_id, franchise_id, enabled, synced_at) VALUES (11, 1, 'Parent Depot', 'ParentState', 'Parent City', '99999', 7, '001', 1, ?), (12, 1, 'Parent Depot', 'ParentState', 'Parent City', '99999', 7, '001', 1, ?), (21, 2, 'Parent Depot', 'ParentState', 'Parent City', '99999', 8, '1', 1, ?)").bind(STAMP, STAMP, STAMP),
  ]);
  // Reverse insertion deliberately: storage order is not pagination order.
  await db.batch([...ROWS].reverse().map(r =>
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, state, enabled, serial_number, city, zip, rfid, route_ids, frequency_ids, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(r.id, r.parent, "Depot", "TX", r.enabled ?? 1, r.serial === undefined ? "asset" : r.serial, r.city ?? "Elsewhere", "02139", "tag", r.route, r.freq, STAMP)));
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denied).toEqual([]);
    expect(await state(), "GET must not mutate rows or schema").toEqual(beforeState);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe.each([
  ["routeIdsExact", "route"],
  ["frequencyIdsExact", "freq"],
] as const)("%s: spec 37-case whole-cell matrix", (param, col) => {
  it.each(MATRIX.map(([stored, requested, match], i) => [i, stored, requested, match] as const))(
    "case %i stored=%j requested=%j match=%i", async (i, _stored, requested, match) => {
      const result = await page({ [param]: requested, limit: "100" });
      const expected = exactSet(col, requested);
      expect(ids(result.body)).toEqual(expected);
      expect(result.body.total).toBe(expected.length);
      expect(ids(result.body).includes(matrixId(i))).toBe(match === 1);
    });
});

describe("exact selectors: literal whole-cell semantics", () => {
  it.each([
    ["routeIdsExact", "1", [1040, 1260, 1320, 1370]],
    ["frequencyIdsExact", "1", [1040, 1260, 1320, 1370]],
    ["routeIdsExact", "1,2", [1130, 1220]],
    ["routeIdsExact", "2,1", [1140, 1230]],
    ["routeIdsExact", "1,1", [1210, 1250]],
    ["routeIdsExact", "12", [1050, 1300]],
    ["routeIdsExact", "7", [2080]],
    ["frequencyIdsExact", "7", [2080]],
    ["routeIdsExact", "7,12", ROUTE_712],
    ["routeIdsExact", "12,7", [2100]],
    ["frequencyIdsExact", "7,12", []],
    ["frequencyIdsExact", "3, 4", FREQ_34],
    ["frequencyIdsExact", "3,4", []],
    ["routeIdsExact", " ", [1030, 1350, 2060]],
    ["frequencyIdsExact", " ", [1030, 1350]],
    ["frequencyIdsExact", "\t", [2060]],
    ["routeIdsExact", "\t", []],
    ["routeIdsExact", "  ", []],
    ["routeIdsExact", "%", [1290]],
    ["routeIdsExact", "_", [1310]],
    ["routeIdsExact", "a", [1280]],
    ["routeIdsExact", "A", [1270]],
    ["routeIdsExact", INJ, [2070]],
    ["frequencyIdsExact", INJ, [2070]],
    ["routeIdsExact", "x' OR 1=1 --", [1360]],
    ["routeIdsExact", "' OR 1=1 --", []],
    ["routeIdsExact", "synthetic-absent", []],
    ["routeIdsExact", "null", []],
    ["routeIdsExact", LONG500, [2090]],
    ["frequencyIdsExact", ASTRAL500, [2090]],
    ["routeIdsExact", SPECIAL_LIST, [2110, 2120]],
    ["frequencyIdsExact", SPECIAL_LIST, [2110]],
  ] as const)("%s=%j", async (param, value, want) => {
    const result = await page({ [param]: value, limit: "100" });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
    expect(result.body.nextCursor).toBeNull();
  });
  it("keeps stored NULL and empty rows out of every exact match while returning their cells unsqueezed when unfiltered", async () => {
    const plain = await page({ limit: "100", fields: "route_ids,frequency_ids" });
    expect(ids(plain.body)).toEqual(ALL);
    const byId = new Map(plain.body.rows.map(r => [r.container_id, r]));
    expect(byId.get(1010)).toMatchObject({ route_ids: null, frequency_ids: null });
    expect(byId.get(2050)).toMatchObject({ route_ids: "", frequency_ids: "" });
    expect(byId.get(2060)).toMatchObject({ route_ids: " ", frequency_ids: "\t" });
    expect(byId.get(2090)).toMatchObject({ route_ids: LONG500, frequency_ids: ASTRAL500 });
  });
  it("binds the whole-cell predicate per column and never interpolates the value", async () => {
    const result = await page({ routeIdsExact: INJ, frequencyIdsExact: "3, 4" });
    expect(ids(result.body)).toEqual([]);
    for (const { sql, binds } of result.recorder.statements) {
      expect(sql).toMatch(/\bc\.route_ids\s+COLLATE\s+BINARY\s*=\s*\?/i);
      expect(sql).toMatch(/\bc\.frequency_ids\s+COLLATE\s+BINARY\s*=\s*\?/i);
      expect(sql).not.toContain(INJ);
      expect(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP|COLLATE\s+NOCASE)\b/i);
      expect(binds.filter(v => v === INJ)).toHaveLength(1);
      expect(binds.filter(v => v === "3, 4")).toHaveLength(1);
    }
  });
});

describe("presence selectors: stored null-or-empty complement", () => {
  it.each([
    ["hasRouteIds", "true", presenceSet("route", true)],
    ["hasRouteIds", "false", [1010, 1020, 2030, 2050]],
    ["hasFrequencyIds", "true", presenceSet("freq", true)],
    ["hasFrequencyIds", "false", [1010, 1020, 2040, 2050]],
  ] as const)("%s=%s", async (param, value, want) => {
    const result = await page({ [param]: value, limit: "100" });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
  });
  it("counts whitespace-only stored text as present on both columns", async () => {
    for (const param of ["hasRouteIds", "hasFrequencyIds"] as const) {
      const yes = await page({ [param]: "true", limit: "100" });
      expect(ids(yes.body)).toContain(1030);
      expect(ids(yes.body)).toContain(1350);
      expect(ids(yes.body)).toContain(2060);
      const no = await page({ [param]: "false", limit: "100" });
      expect(ids(no.body)).not.toContain(2060);
    }
  });
  it.each([
    [{ hasRouteIds: "true", hasFrequencyIds: "false" }, [2040]],
    [{ hasRouteIds: "false", hasFrequencyIds: "true" }, [2030]],
    [{ hasRouteIds: "false", hasFrequencyIds: "false" }, [1010, 1020, 2050]],
    [{ hasRouteIds: "true", hasFrequencyIds: "true" }, ALL.filter(id => ![1010, 1020, 2030, 2040, 2050].includes(id))],
  ] as const)("AND-composes the two presence controls: %j", async (query, want) => {
    const result = await page({ ...query, limit: "100" });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
  });
  it("true and false partition the stored rows per column with no overlap or gap", async () => {
    for (const [param] of [["hasRouteIds"], ["hasFrequencyIds"]] as const) {
      const yes = ids((await page({ [param]: "true", limit: "100" })).body) as number[];
      const no = ids((await page({ [param]: "false", limit: "100" })).body) as number[];
      expect([...yes, ...no].sort((a, b) => a - b)).toEqual(ALL);
      expect(yes.filter(id => no.includes(id))).toEqual([]);
    }
  });
  it("any and omission add no predicate, rows, bytes or binds", async () => {
    const plain = await page({ limit: "100" });
    expect(ids(plain.body)).toEqual(ALL);
    expect(plain.body.total).toBe(ALL.length);
    const any = await page({ hasRouteIds: "any", hasFrequencyIds: "any", limit: "100" });
    expect(any.body).toEqual(plain.body);
    expect(any.bytes).toBe(plain.bytes);
    expect(any.recorder.statements).toEqual(plain.recorder.statements);
    for (const s of any.recorder.statements) {
      expect(whereOf(s.sql)).not.toMatch(/route_ids|frequency_ids/i);
    }
  });
  it("emits distinct true/false SQL predicates with no value binds for the enum", async () => {
    const yes = await page({ hasRouteIds: "true", limit: "1" });
    const no = await page({ hasRouteIds: "false", limit: "1" });
    for (const s of yes.recorder.statements) {
      expect(whereOf(s.sql)).toMatch(/\bc\.route_ids\b/i);
      expect(whereOf(s.sql)).not.toMatch(/frequency_ids/i);
      expect(s.binds).not.toContain("true");
      expect(s.sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP)\b/i);
    }
    for (const s of no.recorder.statements) {
      expect(whereOf(s.sql)).toMatch(/\bc\.route_ids\b/i);
      expect(whereOf(s.sql)).not.toMatch(/frequency_ids/i);
      expect(s.binds).not.toContain("false");
    }
    expect(yes.recorder.statements.map(s => whereOf(s.sql))).not.toEqual(no.recorder.statements.map(s => whereOf(s.sql)));
  });
});

describe("exact x presence x cross-column composition (AND only)", () => {
  it.each([
    [{ routeIdsExact: "7,12", hasRouteIds: "true" }, ROUTE_712],
    [{ routeIdsExact: "7,12", hasRouteIds: "false" }, []],
    [{ routeIdsExact: " ", hasRouteIds: "true" }, [1030, 1350, 2060]],
    [{ routeIdsExact: " ", hasRouteIds: "false" }, []],
    [{ frequencyIdsExact: "3, 4", hasFrequencyIds: "false" }, []],
    [{ routeIdsExact: "7,12", frequencyIdsExact: "3, 4" }, COHORT],
    [{ routeIdsExact: "7", frequencyIdsExact: "7" }, [2080]],
    [{ routeIdsExact: "7", frequencyIdsExact: "3, 4" }, []],
    [{ routeIdsExact: "7,12", frequencyIdsExact: "7,12" }, []],
    [{ routeIdsExact: "7,12", hasFrequencyIds: "false" }, [2040]],
    [{ frequencyIdsExact: "3, 4", hasRouteIds: "false" }, [2030]],
    [{ routeIdsExact: "7,12", hasFrequencyIds: "true" }, [...COHORT, 2010]],
    [{ routeIdsExact: "7,12", frequencyIdsExact: "3, 4", hasRouteIds: "true", hasFrequencyIds: "true" }, COHORT],
    [{ routeIdsExact: "7,12", frequencyIdsExact: "3, 4", hasRouteIds: "false" }, []],
  ] as const)("%j", async (query, want) => {
    const result = await page({ ...query, limit: "100" });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
  });
  it.each(["true", "false"])("composes with merged selectors, includeTotal=%s", async includeTotal => {
    const base = { routeIdsExact: "7,12", frequencyIdsExact: "3, 4", includeTotal, limit: "100" };
    const cases: Array<[Record<string, string>, number[]]> = [
      [{}, COHORT],
      [{ customerId: "1" }, [10, 20, 30, 50, 60]], [{ customerId: "2" }, [40]],
      [{ pickupAddressId: "11" }, [10, 20, 50, 60]], [{ pickupAddressId: "12" }, [30]],
      [{ containerId: "30" }, [30]], [{ containerId: "2010" }, []],
      [{ ids: "10,40,2010" }, [10, 40]], [{ ids: "2010,2020" }, []],
      [{ serialNumber: "asset" }, [10, 30, 40, 60]], [{ serialNumber: "other" }, [50]],
      [{ hasSerialNumber: "false" }, [20]], [{ hasSerialNumber: "true" }, [10, 30, 40, 50, 60]],
      [{ rfid: "tag" }, COHORT], [{ hasRfid: "false" }, []],
      [{ city: "Killeen" }, [10, 20, 30, 40, 50]], [{ city: "Other" }, [60]],
      [{ state: "TX" }, COHORT], [{ zip: "02139" }, COHORT], [{ zip: "99999" }, []],
      [{ locationAddress: "Depot" }, COHORT],
      [{ materialStream: "Synthetic stream" }, []], [{ color: "Synthetic color" }, []],
      [{ parentRouteId: "7" }, [10, 20, 30, 50, 60]], [{ parentRouteId: "8" }, [40]],
      [{ parentFranchiseId: "001" }, [10, 20, 30, 50, 60]], [{ parentFranchiseId: "1" }, [40]],
      [{ parentEnabled: "true" }, COHORT], [{ parentEnabled: "false" }, []],
      [{ enabled: "true" }, [10, 20, 40, 50, 60]], [{ enabled: "false" }, [30]], [{ enabled: "any" }, COHORT],
      [{ q: "ASSET" }, [10, 30, 40, 60]], [{ q: "no-such-match" }, []],
      [{ upperId: "30" }, [10, 20, 30]], [{ lowerId: "30", upperId: "50" }, [30, 40, 50]],
      [{ cursor: "30" }, [40, 50, 60]], [{ order: "desc", cursor: "40" }, [30, 20, 10]],
      [{ customerId: "1", pickupAddressId: "11", containerId: "10", ids: "10,50", serialNumber: "asset", rfid: "tag", city: "Killeen", state: "TX", zip: "02139", parentRouteId: "7", parentFranchiseId: "001", parentEnabled: "true", enabled: "true", lowerId: "10", upperId: "20", fields: "enabled" }, [10]],
    ];
    for (const [filters, want] of cases) {
      const result = await page({ ...base, ...filters });
      expect(ids(result.body), JSON.stringify(filters)).toEqual(want);
      expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
    }
  });
  it("never substitutes the scalar parent route for stored route-list text", async () => {
    // Every parent-11 row sits under scalar parent route 7, but only row
    // 2080 stores the exact whole cell "7".
    const exact = await page({ routeIdsExact: "7", limit: "100" });
    expect(ids(exact.body)).toEqual([2080]);
    const parented = await page({ routeIdsExact: "7", parentRouteId: "7", limit: "100" });
    expect(ids(parented.body)).toEqual([2080]);
    const parentOnly = await page({ parentRouteId: "8", limit: "100" });
    expect(ids(parentOnly.body)).toEqual([40]);
  });
});

describe("COUNT/page parity, traversal and continuation", () => {
  it.each(["1", "2", "3", "8"])("follows every asc link at limit=%s with cursor-relative totals", async limit => {
    await traverse({ routeIdsExact: "7,12", limit }, ROUTE_712);
  });
  it.each(["2", "3"])("follows every desc link at limit=%s", async limit => {
    await traverse({ routeIdsExact: "7,12", limit, order: "desc" }, [...ROUTE_712].reverse());
  });
  it("follows count-free links in both directions", async () => {
    await traverse({ frequencyIdsExact: "3, 4", limit: "3", includeTotal: "false" }, FREQ_34);
    await traverse({ frequencyIdsExact: "3, 4", limit: "3", includeTotal: "false", order: "desc" }, [...FREQ_34].reverse());
  });
  it.each([
    ["hasRouteIds", "asc", [1010, 1020, 2030, 2050]],
    ["hasRouteIds", "desc", [2050, 2030, 1020, 1010]],
    ["hasFrequencyIds", "asc", [1010, 1020, 2040, 2050]],
    ["hasFrequencyIds", "desc", [2050, 2040, 1020, 1010]],
  ] as const)("retains %s=false through every %s next link", async (param, order, want) => {
    await traverse({ [param]: "false", limit: "1", order }, [...want]);
  });
  it("survives comma and space values through link encoding without leaking unknowns or credentials", async () => {
    let result = await page({ routeIdsExact: "7,12", frequencyIdsExact: "3, 4", limit: "1", bogus_param: "private-marker", authorization: "private-token" });
    for (const id of COHORT) {
      expect(ids(result.body)).toEqual([id]);
      const link = result.response.headers.get("link")!;
      expect(link).not.toContain("7,12");
      expect(link).not.toContain("3, 4");
      expect(link).not.toMatch(/private-marker|private-token|test-read-token/);
      const decoded = new URL(/^<([^>]+)>; rel="next"$/.exec(link)![1], result.url).searchParams;
      expect(decoded.get("routeIdsExact")).toBe("7,12");
      expect(decoded.get("frequencyIdsExact")).toBe("3, 4");
      result = await page(next(result));
    }
    expect(result.body).toEqual({ rows: [], total: 0, nextCursor: null });
  });
  it.each(["asc", "desc"])("round-trips reserved characters on every %s link", async order => {
    let result = await page({ routeIdsExact: SPECIAL_LIST, limit: "1", includeTotal: "false", order });
    const seen: unknown[] = [];
    for (const id of order === "asc" ? [2110, 2120] : [2120, 2110]) {
      expect(ids(result.body)).toEqual([id]);
      expect(result.body.nextCursor).toBe(id);
      seen.push(...ids(result.body));
      const decoded = new URL(/^<([^>]+)>; rel="next"$/.exec(result.response.headers.get("link")!)![1], result.url).searchParams;
      expect(decoded.get("routeIdsExact")).toBe(SPECIAL_LIST);
      result = await page(next(result));
    }
    expect(result.body).toEqual({ rows: [], total: null, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
    expect(seen).toEqual(order === "asc" ? [2110, 2120] : [2120, 2110]);
  });
  it.each(["asc", "desc"])("offset-to-seek %s retains every remaining member", async order => {
    const ordered = order === "asc" ? ROUTE_712 : [...ROUTE_712].reverse();
    let result = await page({ routeIdsExact: "7,12", offset: "1", limit: "2", order });
    expect(result.body.total).toBe(ordered.length);
    const expected = ordered.slice(1);
    const seen: number[] = [];
    for (;;) {
      const pageIds = ids(result.body) as number[];
      expect(result.body.total).toBe(seen.length === 0 ? ordered.length : expected.length - seen.length);
      seen.push(...pageIds);
      if (pageIds.length < 2) {
        expect(result.response.headers.get("link")).toBeNull();
        break;
      }
      result = await page(next(result));
      if (seen.length >= expected.length) {
        expect(result.body).toEqual({ rows: [], total: 0, nextCursor: null });
        break;
      }
    }
    expect(seen).toEqual(expected);
  });
  it("cursor overrides a conflicting offset and COUNT includes the cursor bound in both directions", async () => {
    const asc = await page({ routeIdsExact: "7,12", cursor: "30", offset: "999", limit: "100" });
    expect(ids(asc.body)).toEqual([40, 50, 60, 2010, 2040]);
    expect(asc.body.total).toBe(5);
    for (const s of asc.recorder.statements) expect(s.sql).not.toMatch(/\bOFFSET\b/i);
    const desc = await page({ routeIdsExact: "7,12", order: "desc", cursor: "50", limit: "100" });
    expect(ids(desc.body)).toEqual([40, 30, 20, 10]);
    expect(desc.body.total).toBe(4);
  });
  it("keeps exactNext lookahead terminal behavior under both exact selectors", async () => {
    let result = await page({ routeIdsExact: "7,12", frequencyIdsExact: "3, 4", limit: "2", exactNext: "true" });
    const pages = [[10, 20], [30, 40], [50, 60]];
    for (let i = 0; i < pages.length; i++) {
      expect(ids(result.body)).toEqual(pages[i]);
      if (i < pages.length - 1) {
        expect(result.body.nextCursor).toBe(pages[i][1]);
        result = await page(next(result));
      }
    }
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    const terminal = await page({ routeIdsExact: "7,12", frequencyIdsExact: "3, 4", limit: "6", exactNext: "true" });
    expect(ids(terminal.body)).toEqual(COHORT);
    expect(terminal.body.nextCursor).toBeNull();
    expect(terminal.response.headers.get("link")).toBeNull();
  });
  it("preserves sparse stored-column projection with the canonical ID while filtering on unprojected cells", async () => {
    const sparse = await page({ routeIdsExact: "7,12", frequencyIdsExact: "3, 4", fields: "route_ids,frequency_ids", limit: "100" });
    expect(ids(sparse.body)).toEqual(COHORT);
    for (const row of sparse.body.rows) {
      expect(Object.keys(row).sort()).toEqual(["container_id", "frequency_ids", "route_ids"]);
      expect(row).toMatchObject({ route_ids: "7,12", frequency_ids: "3, 4" });
    }
    const unprojected = await page({ routeIdsExact: "7,12", fields: "enabled", limit: "100" });
    expect(ids(unprojected.body)).toEqual(ROUTE_712);
    for (const row of unprojected.body.rows) expect(Object.keys(row).sort()).toEqual(["container_id", "enabled"]);
  });
  it.each([
    [{ routeIdsExact: "7,12" }, 8],
    [{ frequencyIdsExact: "3, 4" }, 8],
    [{ routeIdsExact: "7,12", frequencyIdsExact: "3, 4" }, 6],
    [{ routeIdsExact: "7,12", hasRouteIds: "false" }, 0],
    [{ hasRouteIds: "false" }, 4],
    [{ hasFrequencyIds: "true", hasRouteIds: "false" }, 1],
    [{ routeIdsExact: "7,12", customerId: "1" }, 7],
    [{ routeIdsExact: "synthetic-absent" }, 0],
  ] as const)("countOnly counts %j with exactly one COUNT and no page SELECT", async (filters, total) => {
    const result = await request({ ...filters, countOnly: "true" });
    expect(result.response.status).toBe(200);
    posture(result.response);
    expect(result.recorder.statements).toHaveLength(1);
    expect(result.recorder.statements.filter(isCount)).toHaveLength(1);
    const body = await result.response.json() as Body;
    expect(body).toEqual({ rows: [], total, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
    const counted = await page({ ...filters, limit: "100" });
    expect(counted.body.total).toBe(total);
    expect(ids(counted.body)).toHaveLength(total);
  });
  it("keeps count-free rows identical to the counted page with total null", async () => {
    const counted = await page({ routeIdsExact: "7,12", frequencyIdsExact: "3, 4", limit: "3" });
    const free = await page({ routeIdsExact: "7,12", frequencyIdsExact: "3, 4", limit: "3", includeTotal: "false" });
    expect(free.body.rows).toEqual(counted.body.rows);
    expect(free.body.nextCursor).toEqual(counted.body.nextCursor);
    expect(free.body.total).toBeNull();
    expect(counted.body.total).toBe(6);
  });
  it("rejects countOnly with includeTotal=false before D1 without reflecting selector values", async () => {
    const result = await request({ routeIdsExact: SPECIAL_LIST, countOnly: "true", includeTotal: "false" });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const body = await result.response.text();
    expect(body).not.toContain(SPECIAL_LIST);
    expect(body).toMatch(/countOnly/);
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
  });
  it("strictQuery accepts all four names on the container list and rejects them on a sibling list", async () => {
    const own = await page({ strictQuery: "true", routeIdsExact: "7,12", frequencyIdsExact: "3, 4", hasRouteIds: "true", hasFrequencyIds: "any", limit: "100" });
    expect(ids(own.body)).toEqual(COHORT);
    for (const [path, pair] of [
      ["/api/v1/customer-snapshot", "routeIdsExact=1"],
      ["/api/v1/address-snapshot", "hasFrequencyIds=true"],
    ] as const) {
      const sibling = await request(`strictQuery=true&${pair}`, { path });
      expect(sibling.response.status, path).toBe(400);
      expect(sibling.recorder.prepared).toEqual([]);
    }
  });
});

describe.each(["routeIdsExact", "frequencyIdsExact"] as const)("%s: lexical contract before D1", (param: ExactParam) => {
  const encodedDup = param === "routeIdsExact" ? "routeIdsExact=a&routeIds%45xact=b" : "frequencyIdsExact=a&frequencyIds%45xact=b";
  it.each([
    ["empty", ""], ["ASCII overlength", "x".repeat(501)], ["astral overlength", "🚛".repeat(501)],
    ["mixed overlength", "x".repeat(500) + "🚛"], ["raw overlength cannot pass by trimming", "x" + " ".repeat(500)],
  ])("rejects %s even with a wildcard conditional validator", async (_name, value) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(m => vi.spyOn(console, m));
    const result = await request({ [param]: value }, { headers: { "if-none-match": "*" } });
    await expectBadQuery(result, param, ["x".repeat(64)]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it.each([
    ["private-one", "private-one"], ["private-one", "private-two"], ["", "private-one"], ["private-one", ""],
  ])("rejects repeats (%j, %j) before D1 without reflecting either value", async (first, second) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(m => vi.spyOn(console, m));
    const result = await request(`${param}=${encodeURIComponent(first)}&${param}=${encodeURIComponent(second)}`, { headers: { "if-none-match": "*" } });
    await expectBadQuery(result, param, ["private-one", "private-two"]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it("rejects a percent-encoded duplicate key and a bare key", async () => {
    await expectBadQuery(await request(encodedDup, { headers: { "if-none-match": "*" } }), param);
    await expectBadQuery(await request(param), param);
  });
  it.each([
    ["500 BMP code points", "x".repeat(500), []],
    ["500 astral code points (1000 UTF-16 units)", ASTRAL500, param === "frequencyIdsExact" ? [2090] : []],
    ["499 BMP plus one astral", "x".repeat(499) + "🚛", []],
    ["one code point", "0", []],
    ["whitespace-only is valid literal data", " \t\r\n ", []],
    ["edge whitespace is preserved, not trimmed", " 7,12 ", []],
  ] as const)("accepts %s", async (_name, value, want) => {
    const result = await page({ [param]: value, limit: "100" });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
  });
  it("validates the exact value before applying countOnly", async () => {
    const result = await request({ [param]: "", countOnly: "true" });
    await expectBadQuery(result, param);
  });
});

describe.each(["hasRouteIds", "hasFrequencyIds"] as const)("%s: enum validation before D1", (param: PresenceParam) => {
  const encodedDup = param === "hasRouteIds" ? "hasRouteIds=true&hasRoute%49ds=true" : "hasFrequencyIds=true&hasFrequency%49ds=true";
  it.each([
    ...["", "TRUE", "False", "Any", "1", "0", " true", "false ", "any\n", "true,false", "yes"].map(
      (value): [string, string] => [JSON.stringify(value), `${param}=${encodeURIComponent(value)}`]),
    ["bare key", param] as [string, string],
    ["repeated identical", `${param}=any&${param}=any`] as [string, string],
    ["repeated conflicting", `${param}=true&${param}=false`] as [string, string],
    ["repeated empty plus valid", `${param}=&${param}=true`] as [string, string],
    ["encoded duplicate", encodedDup] as [string, string],
  ])("rejects %s before any D1 access without logging the value", async (_name, search) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(m => vi.spyOn(console, m));
    const result = await request(search, { headers: { "if-none-match": "*" } });
    await expectBadQuery(result, param);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

it.each([null, "invalid-token"])("authenticates before invalid selectors and 304 handling: %s", async token => {
  const result = await request("routeIdsExact=&routeIdsExact=private-one&hasRouteIds=nope", { token, headers: { "if-none-match": "*" } });
  expect(result.response.status).toBe(401);
  expect(result.response.headers.get("content-type")).toContain("application/problem+json");
  const problem = await result.response.json();
  expect(problem).toMatchObject({ status: 401, title: "Unauthorized" });
  expect(JSON.stringify(problem)).not.toMatch(/private-one|routeIdsExact=|hasRouteIds=/);
  expect(result.recorder.prepared).toEqual([]);
  expect(result.response.headers.get("etag")).toBeNull();
  expect(result.response.headers.get("link")).toBeNull();
});
it.each(["test-read-token", "test-api-token", "test-sync-secret"])("authorizes exact local reads via %s", async token => {
  const result = await request({ routeIdsExact: "7,12", frequencyIdsExact: "3, 4" }, { token });
  expect(result.response.status).toBe(200);
  expect(ids(await result.response.json() as Body)).toEqual(COHORT);
});
it("control: omission, canonical columns and ignored unknowns are unchanged", async () => {
  const plain = await page({ limit: "100" });
  expect(ids(plain.body)).toEqual(ALL);
  expect(plain.body.total).toBe(ALL.length);
  expect(plain.body.rows[0]).toMatchObject({ container_id: 10, pickup_address_id: 11, route_ids: "7,12", frequency_ids: "3, 4", synced_at: STAMP });
  const unknown = await page({ bogus_param: "private-marker", limit: "100" });
  expect(unknown.body).toEqual(plain.body);
  expect(unknown.recorder.statements).toEqual(plain.recorder.statements);
});
it("does not log successful raw selector values and remains idempotent", async () => {
  const logs = (["log", "info", "warn", "error", "debug"] as const).map(m => vi.spyOn(console, m));
  const first = await page({ routeIdsExact: SPECIAL_LIST, limit: "100" });
  expect(ids(first.body)).toEqual([2110, 2120]);
  const second = await page({ routeIdsExact: SPECIAL_LIST, limit: "100" });
  expect(second.body).toEqual(first.body);
  expect(second.recorder.statements).toEqual(first.recorder.statements);
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});
it.each(["true", "false"])("hashes the final sparse envelope and preserves conditional links, includeTotal=%s", async includeTotal => {
  const query = { routeIdsExact: "7,12", frequencyIdsExact: "3, 4", fields: "enabled", limit: "2", includeTotal };
  const first = await page(query);
  expect(first.body.rows).toEqual([{ container_id: 10, enabled: 1 }, { container_id: 20, enabled: 1 }]);
  expect(first.body.total).toBe(includeTotal === "false" ? null : 6);
  const tag = await hash(first.bytes);
  expect(first.response.headers.get("etag")).toBe(tag);
  next(first);
  for (const validator of [tag, `W/${tag}`, "*"]) {
    const same = await request(query, { headers: { "if-none-match": validator } });
    expect(same.response.status).toBe(304);
    expect(await same.response.text()).toBe("");
    expect(same.response.headers.get("etag")).toBe(tag);
    expect(same.response.headers.get("link")).toBe(first.response.headers.get("link"));
    posture(same.response);
    budget(same);
    expect(same.recorder.statements).toEqual(first.recorder.statements);
  }
  for (const filters of [{ routeIdsExact: "7" }, { hasRouteIds: "false" }, { fields: "route_ids" }] as Record<string, string>[]) {
    const different = await page({ ...query, ...filters }, { "if-none-match": tag });
    expect(different.response.headers.get("etag")).not.toBe(tag);
  }
});
it("recomputes membership when an unprojected stored cell changes without a sync-time change", async () => {
  const query = { routeIdsExact: SPECIAL_LIST, fields: "enabled", limit: "100" };
  const first = await page(query);
  expect(ids(first.body)).toEqual([2110, 2120]);
  // Fixture mutation only, not the request's read-only D1 binding.
  await TEST_ENV.CUSTOMER_DB.prepare("UPDATE container_snapshot SET route_ids = NULL WHERE container_id = 2110").run();
  beforeState = await state();
  const changed = await page(query, { "if-none-match": await hash(first.bytes) });
  expect(changed.body).toEqual({ rows: [{ container_id: 2120, enabled: 1 }], total: 1, nextCursor: null });
});
it.each([false, true])("records executable synthetic plans; the unjoined exact read scans, joined=%s", async joined => {
  const result = await page({ routeIdsExact: "7,12", hasFrequencyIds: "true", ...(joined ? { customerId: "1" } : {}), limit: "1" });
  expect(ids(result.body)).toEqual([10]);
  for (const { sql, binds } of result.recorder.statements) {
    expect(sql).toMatch(/\bc\.route_ids\s+COLLATE\s+BINARY\s*=\s*\?/i);
    expect(sql).not.toContain("7,12");
    expect(binds.filter(v => v === "7,12")).toHaveLength(1);
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
    expect(plan.success).toBe(true);
    expect(plan.results.length).toBeGreaterThan(0);
    if (!joined) {
      const details = plan.results.map(row => row.detail).join("\n");
      // Local SCAN evidence only: no index, migration or latency promise.
      expect(details).toMatch(/\bSCAN\s+c\b/i);
      expect(details).not.toMatch(/\bSEARCH\s+c\b.*route_ids/i);
    }
  }
});

type Parameter = { name: string; in: string; required?: boolean; description?: string; example?: unknown; examples?: Record<string, { value?: unknown }>; schema: { type?: string; minLength?: number; maxLength?: number; enum?: unknown; default?: unknown; description?: string; example?: unknown } };
type Operation = { operationId: string; description: string; parameters: Parameter[]; responses: Record<string, { description: string }>; "x-effect"?: string; "x-access"?: string };
async function document() {
  const result = await request(new URL("/openapi.json", ORIGIN), { token: null });
  expect(result.response.status).toBe(200);
  expect(result.recorder.prepared).toEqual([]);
  return await result.response.json() as { paths: Record<string, { get: Operation }> };
}
describe("mounted discovery for the literal route/frequency selectors", () => {
  it.each(["routeIdsExact", "frequencyIdsExact"] as const)("publishes optional %s with 1..500 code-point bounds and a replayable synthetic example", async param => {
    const op = (await document()).paths[PATH].get;
    expect(op).toMatchObject({ operationId: "listContainerSnapshot", "x-effect": "local-read", "x-access": "read" });
    const matches = op.parameters.filter(p => p.in === "query" && p.name === param);
    expect(matches).toHaveLength(1);
    const p = matches[0];
    expect(p.required ?? false).toBe(false);
    expect(p.schema).toMatchObject({ type: "string", minLength: 1, maxLength: 500 });
    expect(p.schema.default).toBeUndefined();
    const examples = [p.example, p.schema.example, ...Object.values(p.examples ?? {}).map(e => e.value)];
    const example = examples.find(v => typeof v === "string" && [...v].length >= 1 && [...v].length <= 500);
    expect(example, "one schema-valid example").toBeDefined();
    const replay = await page({ [param]: String(example), limit: "100" });
    expect(replay.response.status).toBe(200);
    expect(ids(replay.body)).toEqual(exactSet(param === "routeIdsExact" ? "route" : "freq", String(example)));
  });
  it.each(["hasRouteIds", "hasFrequencyIds"] as const)("publishes optional %s as exact true|false|any defaulting to any", async param => {
    const op = (await document()).paths[PATH].get;
    const matches = op.parameters.filter(p => p.in === "query" && p.name === param);
    expect(matches).toHaveLength(1);
    const p = matches[0];
    expect(p.required ?? false).toBe(false);
    expect(p.schema).toMatchObject({ type: "string", enum: ["true", "false", "any"], default: "any" });
    const examples = [p.example, p.schema.example, ...Object.values(p.examples ?? {}).map(e => e.value)];
    expect(examples.some(v => ["true", "false", "any"].includes(String(v)))).toBe(true);
  });
  it("states whole-cell literal meaning and the non-membership warning in served guidance", async () => {
    const op = (await document()).paths[PATH].get;
    const guidance = [
      op.description,
      ...op.parameters.filter(p => ["routeIdsExact", "frequencyIdsExact", "hasRouteIds", "hasFrequencyIds"].includes(p.name))
        .map(p => `${p.description ?? ""} ${p.schema.description ?? ""}`),
    ].join("\n");
    for (const pattern of [/whole|entire/i, /stored/i, /mirror/i, /7,12/, /whitespace/i, /code points/i]) expect(guidance).toMatch(pattern);
    // Never presented as membership, current assignment or dispatch truth.
    expect(guidance).toMatch(/(?:not|never|no)\b[^.]{0,100}(membership|member)/i);
    expect(guidance).toMatch(/(?:not|never|no)\b[^.]{0,140}(assignment|dispatch|eligib)/i);
    const exactGuidance = op.parameters.filter(p => p.name.endsWith("Exact")).map(p => `${p.description ?? ""} ${p.schema.description ?? ""}`).join("\n");
    expect(exactGuidance).toMatch(/exact/i);
    expect(exactGuidance).toMatch(/case.sensitive|binary/i);
  });
  it("documents AND composition and value-free recovery for all four selectors", async () => {
    const op = (await document()).paths[PATH].get;
    for (const name of ["routeIdsExact", "frequencyIdsExact", "hasRouteIds", "hasFrequencyIds", "customerId", "pickupAddressId", "containerId", "ids", "serialNumber", "rfid", "hasSerialNumber", "hasRfid", "city", "state", "zip", "q", "enabled", "parentRouteId", "parentFranchiseId", "parentEnabled", "upperId", "lowerId", "order", "cursor", "offset", "includeTotal", "countOnly", "exactNext", "fields", "strictQuery"]) {
      expect(op.parameters.some(p => p.in === "query" && p.name === name), name).toBe(true);
    }
    expect(op.description).toMatch(/\bAND\b|intersect/i);
    const recovery = op.responses["400"].description;
    for (const pattern of [/routeIdsExact/, /frequencyIdsExact/, /hasRouteIds/, /hasFrequencyIds/, /500/, /Unicode code points/i, /repeat|duplicate/i, /empty/i, /before.*D1/i, /application\/problem\+json/, /docs\/PROBLEMS\.md#bad-request/, /omit/i]) expect(recovery).toMatch(pattern);
  });
  it("aligns the canonical query inventory with served names and keeps the selectors off other operations", async () => {
    const doc = await document();
    const row = policyDoc.split("\n").find(line => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    const inventory = [...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map(m => m[1]).sort();
    for (const name of ["routeIdsExact", "frequencyIdsExact", "hasRouteIds", "hasFrequencyIds"]) expect(inventory).toContain(name);
    expect(inventory).toEqual(doc.paths[PATH].get.parameters.filter(p => p.in === "query").map(p => p.name).sort());
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/address-snapshot", `${PATH}/{containerId}`, `${PATH}/export`, "/api/v1/customer-snapshot/changes"]) {
      const params = doc.paths[path].get.parameters?.filter(p => p.in === "query").map(p => p.name) ?? [];
      for (const name of ["routeIdsExact", "frequencyIdsExact", "hasRouteIds", "hasFrequencyIds"]) expect(params, path).not.toContain(name);
    }
    expect(app.routes.filter(r => /(?:routeIdsExact|frequencyIdsExact|hasRouteIds|hasFrequencyIds)/.test(r.path))).toEqual([]);
  });
});

// Machine-consumed safety guidance, not prose style: an agent must be able
// to discover the literal-cohort reading without inferring route membership
// or assignment from mirrored text.
describe("agent guidance for literal route/frequency cohorts", () => {
  it("keeps the standing warning against parsing these cells as assignments", () => {
    expect(policyDoc).toMatch(/never parse equipment `route_ids`\/`frequency_ids`/);
    expect(policyDoc).toMatch(/infer paired assignments/);
  });
  it("explains whole-cell literal cohorts and forbids membership/assignment inference", () => {
    const sections = policyDoc.split(/^#{1,6} /m).filter(s => s.includes("routeIdsExact"));
    const guidance = sections.join("\n");
    expect(guidance).toMatch(/frequencyIdsExact/);
    expect(guidance).toMatch(/hasRouteIds/);
    expect(guidance).toMatch(/hasFrequencyIds/);
    expect(guidance).toMatch(/whole|entire/i);
    expect(guidance).toMatch(/7,12/);
    expect(guidance).toMatch(/mirror/i);
    expect(guidance).toMatch(/(?:not|never|no)\b[^.]{0,100}(membership|member)/i);
    expect(guidance).toMatch(/(?:not|never|no)\b[^.]{0,180}(assignment|dispatch|eligib)/i);
    expect(guidance).toMatch(/test\/containerRouteFrequencyExact\.acceptance\.test\.ts/);
    const listRow = snapshotDoc.split("\n").find(line => line.includes("GET") && line.includes(PATH)) ?? "";
    expect(listRow).toMatch(/routeIdsExact/);
    expect(listRow).toMatch(/hasRouteIds/);
    expect(problemsDoc).toContain("routeIdsExact");
    expect(problemsDoc).toContain("hasFrequencyIds");
  });
  it("publishes a local synthetic literal-cohort recipe that can be counted and traversed", () => {
    const blocks = [...quickstartDoc.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map(m => m[1]);
    const recipe = blocks.find(b => b.includes("routeIdsExact=") && b.includes("countOnly=true"));
    expect(recipe, "local literal-cohort count-only recipe").toBeDefined();
    expect(recipe).toContain(PATH);
    expect(recipe).toContain("localhost:8787");
    expect(recipe).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
    expect(blocks.some(b => b.includes("routeIdsExact=") && /cursor|rel=.next|[Ll]ink/.test(b))).toBe(true);
    expect(changelog.split(/^## /m)[1]).toContain("routeIdsExact");
    expect(changelog.split(/^## /m)[1]).toContain("hasFrequencyIds");
  });
  it("exposes a named local-only focused check that includes this acceptance suite", () => {
    const scripts = packageJson.scripts as Record<string, string>;
    const command = scripts["check:container-route-frequency-exact"];
    expect(command).toEqual(expect.any(String));
    expect(command).toMatch(/vitest\s+run/);
    expect(command).toContain("test/containerRouteFrequencyExact.acceptance.test.ts");
    expect(command).not.toMatch(/--remote|deploy|probe:post-deploy/);
  });
});
