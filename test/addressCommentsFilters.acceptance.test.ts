import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent, test-first outcome oracle; Builder consumes unchanged.
 * Run: npx vitest run test/addressCommentsFilters.acceptance.test.ts --maxWorkers=2
 * Mutation targets: ignored selector; note/locality/customer confusion; LIKE or
 * interpolated SQL; Unicode folding/normalization; trimming before length check;
 * SQL trim on stored presence; OR leakage; count/page/continuation drift; stale
 * validators; validation after SQL/auth; reflected values or external effects.
 * Literal expected IDs are hand-derived. Only synthetic fixture setup may write;
 * HTTP reads execute real local migrated D1, with network/R2/cache writes denied.
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/address-snapshot";
const ORIGIN = "https://address-comments.invalid";
const FRAGMENT = "handoff";
const SPECIAL = 'desk\' OR 1=1 -- 50%_ 🧪&+/#? "雪\\tail';
const HUNDRED = "🧪".repeat(100);
const ALL = [11, 23, 37, 42, 58, 69, 73, 79, 83, 89, 97, 101, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181];
const PRESENT = [11, 23, 37, 42, 58, 69, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181];
const ABSENT = [73, 79, 83, 89, 97, 101];
type Query = Record<string, string | number>;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
type Options = { token?: string | null; headers?: Record<string, string>; forbidAll?: boolean; fail?: "count" | "page" };
const ids = (body: Body) => body.rows.map(row => row.pickup_address_id);
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
// id, customer, route, franchise, enabled, extras, street, city, state, zip, note, comments
const FIXTURES: Array<[number, number, number, string, number, number, string, string | null, string, string | null, string | null, string | null]> = [
  [11, 101, 7, "001", 1, 1, "741 Synthetic Way", "North", "ZZ", "00741", "amber gate", "Leave at HANDOFF gate"],
  [23, 101, 7, "001", 1, 0, "741 Synthetic Way", "North", "ZZ", "00741", "amber gate", "handoff"],
  [37, 101, 7, "001", 1, 1, "741 Synthetic Way", "North", "ZZ", "00741-1234", "other note", "repeat handoff handoff"],
  [42, 101, 8, "1", 1, 0, "741 Synthetic Way", "South", "YY", "98000", "amber gate", "handoff"],
  [58, 202, 7, "001", 1, 1, "741 Other Way", "North", "ZZ", "00741", null, "handoff"],
  [69, 101, 7, "001", 0, 0, "741 Disabled Way", "North", "ZZ", "00741", "amber gate", "handoff"],
  [73, 101, 7, "001", 1, 1, "Plain Way", null, "ZZ", null, FRAGMENT, null],
  [79, 101, 7, "001", 1, 1, FRAGMENT, null, "ZZ", null, null, null],
  [83, 101, 7, "001", 1, 1, "Plain Way", FRAGMENT, "ZZ", null, null, null],
  [89, 101, 7, "001", 1, 1, "Plain Way", null, "ZZ", FRAGMENT, null, null],
  [97, 101, 7, "001", 1, 1, "Plain Way", null, FRAGMENT, null, null, null],
  [101, 101, 7, "001", 1, 1, "Empty Way", null, "ZZ", null, "amber gate", ""],
  [109, 101, 7, "001", 1, 1, "ASCII Whitespace Way", null, "ZZ", null, null, " \t\r\n "],
  [113, 101, 7, "001", 1, 1, "Unicode Whitespace Way", null, "ZZ", null, null, " 　 "],
  [127, 101, 7, "001", 1, 1, "Literal Way", null, "ZZ", null, null, SPECIAL],
  [131, 101, 7, "001", 1, 1, "Literal Way", null, "ZZ", null, null, SPECIAL],
  [137, 101, 7, "001", 1, 1, "Literal Way", null, "ZZ", null, null, SPECIAL],
  [139, 101, 7, "001", 1, 1, "Lower Unicode Way", null, "ZZ", null, null, "é-ÅBC"],
  [149, 101, 7, "001", 1, 1, "Upper Unicode Way", null, "ZZ", null, null, "É-åBC"],
  [151, 101, 7, "001", 1, 1, "Decomposed Way", null, "ZZ", null, null, "é"],
  [157, 101, 7, "001", 1, 1, "Astral Way", null, "ZZ", null, null, HUNDRED],
  [163, 101, 7, "001", 1, 1, "ASCII Way", null, "ZZ", null, null, "x".repeat(100)],
  [167, 101, 7, "001", 1, 1, "Mixed Way", null, "ZZ", null, null, "x".repeat(50) + "🧪".repeat(50)],
  [173, 101, 7, "001", 1, 1, "Padded Way", null, "ZZ", null, null, "  marker  "],
  [179, 101, 7, "001", 1, 1, "Unpadded Way", null, "ZZ", null, null, "marker"],
  [181, 101, 7, "001", 1, 1, "Wildcard Decoy Way", null, "ZZ", null, null, "50XX"]
];
let denied: string[];
let logs: Array<ReturnType<typeof vi.spyOn>>;
let submitted: string[];
let beforeState: unknown;
function forbid(effect: string): never { denied.push(effect); throw new Error("Forbidden address-comments effect"); }
function readOnlyDb(options: Options) {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const fetched: number[] = [];
  function wrap(real: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return new Proxy(real, {
      get(target, key) {
        if (key === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql, values);
        const method = Reflect.get(target, key, target);
        if (typeof method !== "function") return method;
        return async (...args: unknown[]) => {
          if (!["all", "first", "raw"].includes(String(key))) return forbid(`D1.${String(key)}`);
          statements.push({ sql, binds });
          if ((options.fail === "count" && isCount({ sql, binds })) || (options.fail === "page" && !isCount({ sql, binds }))) {
            throw new Error(`synthetic-private-db-marker ${SPECIAL}`);
          }
          const result = await Reflect.apply(method, target, args);
          if (!isCount({ sql, binds })) {
            if (key === "all") fetched.push((result as D1Result).results.length);
            else if (key === "raw") fetched.push((result as unknown[][]).length);
            else fetched.push(result === null ? 0 : 1);
          }
          return result;
        };
      }
    });
  }
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      if (options.forbidAll) throw new Error("Rejected request touched D1");
      if (!/^\s*SELECT\b/i.test(sql)) return forbid("D1.prepare write");
      return wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []);
    },
    batch: () => forbid("D1.batch"), exec: () => forbid("D1.exec"), dump: () => forbid("D1.dump"),
    withSession: () => forbid("D1.withSession")
  } as unknown as D1Database;
  return { db, prepared, statements, fetched };
}
async function request(query: Query | URL | string = {}, options: Options = {}) {
  const url = query instanceof URL ? query : new URL(PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = typeof query === "string" ? query : new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)])
  ).toString();
  for (const key of ["comments", "hasComments", "private-unknown"]) for (const value of url.searchParams.getAll(key)) {
    // Short generic values (e.g. null) can legitimately occur in structured log metadata.
    if (value.length >= 8 && value.trim() && !["true", "false", "any"].includes(value)) submitted.push(value);
  }
  const recorder = readOnlyDb(options);
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Address-comments-acceptance", ...options.headers });
  const token = options.token === undefined ? "test-read-token" : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const external = new Proxy({}, { get: (_target, key) => () => forbid(`external.${String(key)}`) });
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: recorder.db, SNAPSHOTS: external as R2Bucket, BROWSER: external as Fetcher
  });
  return { response, url, ...recorder };
}
function posture(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("x-request-id")).toBe("Address-comments-acceptance");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("vary")).toMatch(/\borigin\b/i);
}
async function page(query: Query | URL | string = {}, headers?: Record<string, string>) {
  const result = await request(query, { headers });
  expect(result.response.status).toBe(200);
  posture(result.response);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  const bytes = await result.response.text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const countOnly = result.url.searchParams.get("countOnly") === "true";
  const counted = result.url.searchParams.get("includeTotal") !== "false";
  expect(result.statements).toHaveLength(countOnly || !counted ? 1 : 2);
  expect(result.statements.filter(isCount)).toHaveLength(counted ? 1 : 0);
  expect(result.prepared).toHaveLength(result.statements.length);
  expect(new Set(ids(body)).size).toBe(body.rows.length);
  expect(result.response.headers.get("link") !== null).toBe(body.nextCursor !== null);
  const limit = Number(result.url.searchParams.get("limit") ?? 50);
  for (const n of result.fetched) expect(n).toBeLessThanOrEqual(limit + (result.url.searchParams.get("exactNext") === "true" ? 1 : 0));
  return { ...result, body, bytes };
}
function next(result: Awaited<ReturnType<typeof page>>, expected: Query) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/address-snapshot\?[^<>\s]*>; rel="next"$/);
  const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(target.origin).toBe(result.url.origin);
  expect(target.pathname).toBe(PATH);
  expect(target.hash + target.username + target.password).toBe("");
  const actual = new URLSearchParams(target.search);
  const want = Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, String(value)]));
  if (want.includeTotal !== "false") {
    expect([null, "true"]).toContain(actual.get("includeTotal"));
    expect(actual.getAll("includeTotal").length).toBeLessThanOrEqual(1);
    actual.delete("includeTotal"); delete want.includeTotal;
  }
  expect([...actual.keys()]).toHaveLength(Object.keys(want).length);
  expect(Object.fromEntries(actual)).toEqual(want);
  expect(actual.has("offset")).toBe(false);
  return target;
}
async function hash(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}"`;
}
async function state() {
  const results = await Promise.all([
    ...["customer_snapshot", "address_snapshot", "container_snapshot"].map(table => TEST_ENV.CUSTOMER_DB.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    TEST_ENV.CUSTOMER_DB.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()
  ]);
  return results.map(r => r.results);
}
beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  denied = []; submitted = [];
  vi.stubGlobal("fetch", vi.fn(async () => forbid("fetch")));
  logs = (["log", "info", "warn", "error", "debug"] as const).map(level => vi.spyOn(console, level).mockImplementation(() => undefined));
  const cache = (caches as CacheStorage & { default: Cache }).default;
  vi.spyOn(cache, "put").mockImplementation(async () => forbid("cache.put"));
  vi.spyOn(cache, "delete").mockImplementation(async () => forbid("cache.delete"));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot")]);
  for (const id of [101, 202]) await db.prepare(
    "INSERT INTO customer_snapshot (customer_id, company_name, comments, enabled, synced_at) VALUES (?, 'synthetic', ?, 1, 'fixed')"
  ).bind(id, id === 101 ? "customer-only-secret" : FRAGMENT).run();
  for (const row of [...FIXTURES].reverse()) await db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, enabled, extras_allowed, address, city, state, zip, driver_note, comments, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixed')"
  ).bind(...row).run();
  for (const [id, parent, enabled] of [[501, 23, 0], [502, 37, 1], [503, 37, 0], [504, 69, 1], [505, 73, 1]]) await db.prepare(
    "INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, synced_at) VALUES (?, ?, ?, 'fixed')"
  ).bind(id, parent, enabled).run();
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denied).toEqual([]);
    const text = JSON.stringify(logs.map(log => log.mock.calls));
    for (const marker of [...submitted, SPECIAL, "synthetic-private-db-marker", "private-first", "private-second", "unknown-private-marker"]) {
      expect(text).not.toContain(JSON.stringify(marker).slice(1, -1));
      expect(text).not.toContain(encodeURIComponent(marker));
      expect(text).not.toContain(new URLSearchParams({ comments: marker }).toString());
    }
    expect(await state(), "HTTP must not change stored rows/text/schema").toEqual(beforeState);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe("address comments literal substring", () => {
  it.each([
    ["comments not note/locality/customer", FRAGMENT, [11, 23, 37, 42, 58, 69]],
    ["ASCII folding and boundary trim", " \tHANDOFF\r\n ", [11, 23, 37, 42, 58, 69]],
    ["substring not equality", "andoff", [11, 23, 37, 42, 58, 69]],
    ["internal spaces are not collapsed", "hand off", []],
    ["customer comments are not searched", "customer-only-secret", []],
    ["note is not searched", "amber gate", []],
    ["locality is not searched", "741", []],
    ["stored padding not rewritten", " marker ", [173, 179]],
    ["literal punctuation", SPECIAL, [127, 131, 137]],
    ["percent not wildcard", "%", [127, 131, 137]],
    ["underscore not wildcard", "_", [127, 131, 137]],
    ["SQL-looking data", "' OR 1=1 --", [127, 131, 137]],
    ["URL delimiters", "&+/#?", [127, 131, 137]],
    ["backslash", "\\", [127, 131, 137]],
    ["quoted Unicode", '"雪', [127, 131, 137]],
    ["non-ASCII lower remains exact", "é", [139]],
    ["non-ASCII upper remains exact", "É", [149]],
    ["ASCII folds inside Unicode", "Åbc", [139]],
    ["no non-ASCII folding", "åbc", [149]],
    ["no Unicode normalization", "é", [151]],
    ["100 astral code points", HUNDRED, [157]],
    ["100 ASCII code points", "x".repeat(100), [163]],
    ["100 mixed code points", "x".repeat(50) + "🧪".repeat(50), [167]],
    ["100 raw including trim boundaries", ` ${"x".repeat(98)} `, [163]],
    ["100 raw astral including trim boundaries", ` ${"🧪".repeat(98)} `, [157]],
    ["NULL is not stringified", "null", []]
  ] as const)("%s", async (_label, comments, want) => {
    const result = await page({ comments });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
    expect(result.body.nextCursor).toBeNull();
  });

  it("binds literal fragment in identical COUNT/page predicates, without LIKE expansion", async () => {
    const result = await page({ comments: ` ${SPECIAL} `, hasComments: "true", upperId: 137, fields: "enabled" });
    expect(ids(result.body)).toEqual([127, 131, 137]);
    const count = result.statements.find(isCount)!;
    const rows = result.statements.find(s => !isCount(s))!;
    const where = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).split(/\bORDER\s+BY\b|\bLIMIT\b/i)[0].trim().replace(/\s+/g, " ");
    expect(where(count.sql)).toBe(where(rows.sql));
    expect(rows.binds.slice(0, count.binds.length)).toEqual(count.binds);
    for (const statement of result.statements) {
      expect(statement.binds).toContain(SPECIAL);
      expect(statement.sql).not.toContain(SPECIAL);
      expect(statement.sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP|TRIM)\s*(?:\(|\b)/i);
      expect(statement.sql).not.toMatch(/\bJOIN\b/i);
    }
  });

  it.each(["", " \t\r\n ", " 　 ", " ".repeat(100)])("blank %j is omitted in bytes, SQL, ETag and Link", async comments => {
    const plain = await page({ limit: 2 });
    const blank = await page({ comments, hasComments: "any", limit: 2 });
    expect(ids(blank.body)).toEqual([11, 23]);
    expect(blank.bytes).toBe(plain.bytes);
    expect(blank.statements).toEqual(plain.statements);
    expect(blank.response.headers.get("etag")).toBe(plain.response.headers.get("etag"));
    expect(blank.response.headers.get("link")).toBe(plain.response.headers.get("link"));
    next(blank, { limit: 2, cursor: 23 });
  });
});

describe("stored address comment presence is not trimmed or interpreted", () => {
  it.each([
    ["true", PRESENT], ["false", ABSENT], ["any", ALL]
  ] as const)("hasComments=%s exact cohort includes legacy whitespace", async (hasComments, want) => {
    const result = await page({ hasComments, fields: "comments" });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
    expect(result.body.nextCursor).toBeNull();
    if (hasComments === "true") {
      expect(result.body.rows.find(r => r.pickup_address_id === 109)?.comments).toBe(" \t\r\n ");
      expect(result.body.rows.find(r => r.pickup_address_id === 113)?.comments).toBe(" 　 ");
    }
    for (const s of result.statements) expect(s.sql).not.toMatch(/\btrim\s*\(/i);
  });
  it("omitted/any preserve full rows, SQL and stored NULL/empty distinctions", async () => {
    const omitted = await page();
    const any = await page({ hasComments: "any" });
    expect(ids(omitted.body)).toEqual(ALL);
    expect(any.bytes).toBe(omitted.bytes);
    expect(any.statements).toEqual(omitted.statements);
    expect(omitted.body.rows.find(r => r.pickup_address_id === 73)?.comments).toBeNull();
    expect(omitted.body.rows.find(r => r.pickup_address_id === 101)?.comments).toBe("");
  });
});

describe.each(["true", "false"])("AND scope and budgets includeTotal=%s", includeTotal => {
  it.each<{ query: Query; want: number[] }>([
    { query: {}, want: [11, 23, 37, 42, 58, 69] },
    { query: { hasComments: "true" }, want: [11, 23, 37, 42, 58, 69] },
    { query: { hasComments: "false" }, want: [] },
    { query: { hasComments: "any" }, want: [11, 23, 37, 42, 58, 69] },
    { query: { customerId: 101, enabled: "true" }, want: [11, 23, 37, 42] },
    { query: { customerId: 202 }, want: [58] },
    { query: { pickupAddressId: 23 }, want: [23] },
    { query: { pickupAddressId: 73 }, want: [] },
    { query: { ids: "37,11,73" }, want: [11, 37] },
    { query: { customerId: 202, pickupAddressId: 23 }, want: [] },
    { query: { enabled: "false" }, want: [69] },
    { query: { extrasAllowed: "false" }, want: [23, 42, 69] },
    { query: { extrasAllowed: "true" }, want: [11, 37, 58] },
    { query: { routeId: 7, franchiseId: "001" }, want: [11, 23, 37, 58, 69] },
    { query: { routeId: 8, franchiseId: "001" }, want: [] },
    { query: { franchiseId: "1" }, want: [42] },
    { query: { city: "North", state: "ZZ", zip: "00741" }, want: [11, 23, 58, 69] },
    { query: { zip: "00741-1234" }, want: [37] },
    { query: { hasContainers: "true" }, want: [23, 37, 69] },
    { query: { hasContainers: "false" }, want: [11, 42, 58] },
    { query: { driverNote: "amber gate" }, want: [11, 23, 42, 69] },
    { query: { driverNote: FRAGMENT }, want: [] },
    { query: { q: FRAGMENT }, want: [] },
    { query: { q: "Other" }, want: [58] },
    { query: { upperId: 37, cursor: 23 }, want: [37] },
    { query: { upperId: 37, cursor: 37, order: "desc" }, want: [23, 11] },
    { query: { customerId: 101, routeId: 7, franchiseId: "001", city: "North", state: "ZZ", zip: "00741", enabled: "true", extrasAllowed: "false", hasContainers: "true", driverNote: "amber gate", q: "741", upperId: 37, hasComments: "true" }, want: [23] }
  ])("comments $query", async ({ query, want }) => {
    const result = await page({ ...query, comments: FRAGMENT, includeTotal, fields: "enabled" });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
    for (const row of result.body.rows) expect(Object.keys(row).sort()).toEqual(["enabled", "pickup_address_id"]);
  });

  it.each<{ query: Query; want: number[] }>([
    { query: { hasComments: "false", driverNote: "amber gate" }, want: [101] },
    { query: { hasComments: "false", hasContainers: "true" }, want: [73] },
    { query: { hasComments: "false", q: FRAGMENT }, want: [79, 83, 89] },
    { query: { hasComments: "true", ids: "73,101,109,113" }, want: [109, 113] },
    { query: { hasComments: "false", comments: " \t " }, want: ABSENT }
  ])("presence without a nonblank fragment $query", async ({ query, want }) => {
    const result = await page({ ...query, includeTotal });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
  });
});

describe("countOnly uses the full comments/presence cohort without payload reads", () => {
  it.each<{ query: Query; total: number }>([
    { query: { comments: FRAGMENT }, total: 6 },
    { query: { hasComments: "true" }, total: 20 },
    { query: { hasComments: "false" }, total: 6 },
    { query: { comments: FRAGMENT, hasComments: "false" }, total: 0 },
    { query: { comments: " \t ", hasComments: "false" }, total: 6 },
    { query: { comments: FRAGMENT, cursor: 23, upperId: 58, offset: 999, limit: 1 }, total: 3 },
    { query: { comments: FRAGMENT, cursor: 42, order: "desc", upperId: 37 }, total: 3 },
    { query: { comments: FRAGMENT, hasComments: "true", driverNote: "amber gate", extrasAllowed: "false", enabled: "true", hasContainers: "true" }, total: 1 },
    { query: { comments: FRAGMENT, offset: 999, limit: 1, exactNext: "true", fields: "comments" }, total: 6 }
  ])("$query", async ({ query, total }) => {
    const baseline = await page(query);
    const result = await page({ ...query, countOnly: "true" });
    expect(result.body).toEqual({ rows: [], total, nextCursor: null });
    expect(result.statements).toEqual(baseline.statements.filter(isCount));
    expect(result.fetched).toEqual([]);
    expect(result.statements[0].sql).toMatch(/^SELECT\s+COUNT\s*\([^)]*\)\s*(?:AS\s+\w+)?\s+FROM\b/i);
    expect(result.statements[0].sql).not.toMatch(/\bLIMIT\b|\bOFFSET\b/i);
    expect(result.response.headers.get("etag")).toBe(await hash(result.bytes));
  });
});

describe.each(["true", "false"])("followed comments links includeTotal=%s", includeTotal => {
  it.each(["asc", "desc"])("%s traverses full terminal page and preserves normalized scope", async order => {
    const filters = { comments: FRAGMENT, hasComments: "true", customerId: 101, enabled: "true", upperId: 58, fields: "enabled", limit: 2, order, includeTotal };
    const pages = order === "asc" ? [[11, 23], [37, 42], []] : [[42, 37], [23, 11], []];
    let current = await page({ ...filters, comments: " \tHANDOFF " });
    const seen: unknown[] = [];
    for (const [index, want] of pages.entries()) {
      expect(ids(current.body)).toEqual(want);
      expect(current.body.total).toBe(includeTotal === "false" ? null : [4, 2, 0][index]);
      seen.push(...ids(current.body));
      if (want.length === 0) expect(current.body.nextCursor).toBeNull();
      else {
        expect(current.body.nextCursor).toBe(want[1]);
        current = await page(next(current, { ...filters, comments: "HANDOFF", cursor: want[1] }));
      }
    }
    expect(seen).toEqual(order === "asc" ? [11, 23, 37, 42] : [42, 37, 23, 11]);
    expect(new Set(seen).size).toBe(4);
  });

  it.each(["asc", "desc"])("%s exactNext looks ahead only within the filtered cohort", async order => {
    const filters = { comments: FRAGMENT, hasComments: "true", customerId: 101, enabled: "true", upperId: 58, fields: "enabled", limit: 2, order, includeTotal, exactNext: "true" };
    const first = await page(filters);
    expect(ids(first.body)).toEqual(order === "asc" ? [11, 23] : [42, 37]);
    expect(first.fetched).toEqual([3]);
    const cursor = order === "asc" ? 23 : 37;
    expect(first.body.nextCursor).toBe(cursor);
    const terminal = await page(next(first, { ...filters, cursor }));
    expect(ids(terminal.body)).toEqual(order === "asc" ? [37, 42] : [23, 11]);
    expect(terminal.fetched).toEqual([2]);
    expect(terminal.body.nextCursor).toBeNull();
    expect(terminal.body.total).toBe(includeTotal === "false" ? null : 2);
  });

  it.each(["asc", "desc"])("%s offset-to-seek preserves literal punctuation exactly once", async order => {
    const filters = { comments: SPECIAL, hasComments: "true", routeId: 7, franchiseId: "001", upperId: 137, fields: "comments", limit: 1, order, includeTotal };
    const first = await page({ ...filters, comments: ` ${SPECIAL} `, offset: 1 });
    expect(first.body.rows).toEqual([{ pickup_address_id: 131, comments: SPECIAL }]);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 3);
    const target = next(first, { ...filters, cursor: 131 });
    expect(first.response.headers.get("link")).not.toContain(SPECIAL);
    const second = await page(target);
    expect(second.body.rows).toEqual([{ pickup_address_id: order === "asc" ? 137 : 127, comments: SPECIAL }]);
    const empty = await page(next(second, { ...filters, cursor: order === "asc" ? 137 : 127 }));
    expect(empty.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
  });

  it("retains comment, note, locality, exact scopes and child flags in one followed link", async () => {
    const filters = { comments: FRAGMENT, hasComments: "true", pickupAddressId: 23, customerId: 101, routeId: 7, franchiseId: "001", city: "North", state: "ZZ", zip: "00741", q: "741", driverNote: "amber gate", enabled: "true", extrasAllowed: "false", hasContainers: "true", ids: "11,23,73", upperId: 37, fields: "enabled", order: "desc", limit: 1, includeTotal };
    const first = await page({ ...filters, comments: " handoff " });
    expect(first.body.rows).toEqual([{ pickup_address_id: 23, enabled: 1 }]);
    const terminal = await page(next(first, { ...filters, cursor: 23 }));
    expect(terminal.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
  });

  it("retains false presence, IDs and every address scope while omitting blank comments", async () => {
    const filters = { hasComments: "false", pickupAddressId: 73, customerId: 101, routeId: 7, franchiseId: "001", enabled: "true", extrasAllowed: "true", hasContainers: "true", driverNote: FRAGMENT, ids: "73,101", upperId: 101, fields: "comments", order: "desc", limit: 1, includeTotal };
    const first = await page({ ...filters, comments: " \t ", offset: 0, "private-unknown": "unknown-private-marker" });
    expect(first.body.rows).toEqual([{ pickup_address_id: 73, comments: null }]);
    const last = await page(next(first, { ...filters, cursor: 73 }));
    expect(last.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
  });
});

describe("representation, authority and unchanged existing behavior", () => {
  it("baseline discriminates note, locality and customer comments without new selectors", async () => {
    expect(ids((await page({ driverNote: FRAGMENT })).body)).toEqual([73]);
    expect(ids((await page({ q: FRAGMENT })).body)).toEqual([79, 83, 89]);
    const customers = await request(new URL(`/api/v1/customer-snapshot?comments=${FRAGMENT}`, ORIGIN));
    expect(customers.response.status).toBe(200);
    expect((await customers.response.json() as Body).rows.map(r => r.customer_id)).toEqual([202]);
    const byId = await request(new URL(`${PATH}/101`, ORIGIN));
    expect(byId.response.status).toBe(200);
    expect(await byId.response.json()).toMatchObject({ pickup_address_id: 101, comments: "" });
  });

  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("retains existing read authority %s", async token => {
    const result = await request({ comments: FRAGMENT, hasComments: "true", pickupAddressId: 11 }, { token });
    expect(result.response.status).toBe(200);
    expect(ids(await result.response.json() as Body)).toEqual([11]);
  });

  it.each([{}, { includeTotal: "false" }, { countOnly: "true" }] as Query[])("hashes served bytes and revalidates without skipping reads: %j", async mode => {
    const query = { ...mode, comments: FRAGMENT, hasComments: "true", fields: "comments", limit: 2 };
    const first = await page(query);
    expect(first.response.headers.get("etag")).toBe(await hash(first.bytes));
    for (const validator of [first.response.headers.get("etag")!, `W/${first.response.headers.get("etag")}`, "*"]) {
      const replay = await request(query, { headers: { "if-none-match": validator } });
      expect(replay.response.status).toBe(304);
      expect(replay.response.body).toBeNull();
      expect(await replay.response.text()).toBe("");
      posture(replay.response);
      expect(replay.response.headers.get("etag")).toBe(first.response.headers.get("etag"));
      expect(replay.response.headers.get("link")).toBe(first.response.headers.get("link"));
      expect(replay.statements).toEqual(first.statements);
    }
    const changed = await page({ ...query, hasComments: "false" }, { "if-none-match": first.response.headers.get("etag")! });
    expect(changed.body.rows).toEqual([]);
    expect(changed.body.total).toBe(mode.includeTotal === "false" ? null : 0);
    expect(changed.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
  });

  it.each(["true", "false"])("unprojected membership changes invalidate the ETag even with fixed synced_at (%s)", async includeTotal => {
    const query = { comments: FRAGMENT, hasComments: "true", fields: "enabled", includeTotal };
    const first = await page(query);
    expect(ids(first.body)).toEqual([11, 23, 37, 42, 58, 69]);
    // Synthetic setup mutation only; the HTTP binding still cannot write.
    await TEST_ENV.CUSTOMER_DB.prepare("UPDATE address_snapshot SET comments = NULL WHERE pickup_address_id = 23").run();
    beforeState = await state();
    const changed = await page(query, { "if-none-match": first.response.headers.get("etag")! });
    expect(ids(changed.body)).toEqual([11, 37, 42, 58, 69]);
    expect(changed.body.total).toBe(includeTotal === "false" ? null : 5);
    expect(changed.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
  });

  it("presence transition from stored whitespace to empty invalidates sparse membership", async () => {
    const query = { hasComments: "false", fields: "enabled" };
    const first = await page(query);
    expect(ids(first.body)).toEqual(ABSENT);
    await TEST_ENV.CUSTOMER_DB.prepare("UPDATE address_snapshot SET comments = '' WHERE pickup_address_id = 109").run();
    beforeState = await state();
    const changed = await page(query, { "if-none-match": first.response.headers.get("etag")! });
    expect(ids(changed.body)).toEqual([73, 79, 83, 89, 97, 101, 109]);
    expect(changed.body.total).toBe(7);
    expect(changed.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
  });

  it("count-free changes only envelope total and does not add lookahead", async () => {
    const query = { comments: FRAGMENT, hasComments: "true", fields: "enabled", limit: 2 };
    const counted = await page(query);
    const free = await page({ ...query, includeTotal: "false" });
    expect(ids(counted.body)).toEqual([11, 23]);
    expect(counted.body.total).toBe(6);
    expect(free.body).toEqual({ rows: counted.body.rows, total: null, nextCursor: 23 });
    expect(free.statements).toEqual(counted.statements.filter(s => !isCount(s)));
    expect(free.fetched).toEqual([2]);
  });

  it("unknown query names and forged origin/forwarded hosts cannot taint relative links", async () => {
    const plain = await page({ comments: FRAGMENT, hasComments: "true", limit: 2 });
    const tainted = new URL(`${PATH}?${new URLSearchParams({ comments: FRAGMENT, hasComments: "true", limit: "2", "private-unknown": "unknown-private-marker", token: "query-token-marker", url: "https://redirect-marker.invalid" })}`, "https://forged.invalid");
    const result = await request(tainted, { headers: { host: "forged.invalid", "x-forwarded-host": "forwarded.invalid" } });
    expect(result.response.status).toBe(200);
    expect(await result.response.text()).toBe(plain.bytes);
    expect(result.statements).toEqual(plain.statements);
    expect(result.response.headers.get("link")).toBe(plain.response.headers.get("link"));
    expect(result.response.headers.get("link")).not.toMatch(/marker|forged|forwarded|https?:|\/\//);
  });
});

const INVALID_COMMENTS = [
  ...["x".repeat(101), "🧪".repeat(101), "x".repeat(50) + "🧪".repeat(51), ` ${"x".repeat(99)} `, ` ${"🧪".repeat(99)} `, " ".repeat(101)].map(comments => new URLSearchParams({ comments }).toString()),
  "comments=private-first&comments=private-second", "comments=private-first&comments=private-first",
  "comments=&comments=private-second", "comments=private-first&comments=", "comments=&comments=",
  "comments=private-first&%63omments=private-second"
];
const INVALID_PRESENCE = [
  ...["", " ", "TRUE", "False", "ANY", "1", "0", "null", "true ", " true", "true,false", "true\0", "private-presence-marker"].map(hasComments => new URLSearchParams({ hasComments }).toString()),
  "hasComments=true&hasComments=false", "hasComments=any&hasComments=any", "hasComments=&hasComments=true",
  "hasComments=true&has%43omments=false"
];
describe("validation after auth, before SQL/conditional responses, with value-free correction", () => {
  it.each([
    ...INVALID_COMMENTS.map(query => ({ key: "comments", query })),
    ...INVALID_PRESENCE.map(query => ({ key: "hasComments", query }))
  ])("$query", async ({ key, query }) => {
    const result = await request(`${query}&private-unknown=unknown-private-marker`, { forbidAll: true, headers: { "if-none-match": "*" } });
    expect.soft(result.prepared).toEqual([]);
    expect.soft(result.statements).toEqual([]);
    expect(result.response.status).toBe(400);
    posture(result.response);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const bytes = await result.response.text();
    const problem = JSON.parse(bytes) as Record<string, unknown>;
    expect(Object.keys(problem).sort()).toEqual(["detail", "status", "title", "type"]);
    expect(problem).toMatchObject({ type: expect.stringMatching(/#bad-request$/), title: "Bad Request", status: 400 });
    expect(String(problem.detail)).toContain(key);
    expect(String(problem.detail)).toContain("docs/PROBLEMS.md#bad-request");
    expect(String(problem.detail)).toMatch(/omit|use|provide|send/i);
    if (key === "comments") {
      expect(String(problem.detail)).toMatch(/100/);
      expect(String(problem.detail)).toMatch(/code.point/i);
      expect(String(problem.detail)).toMatch(/one|single/i);
    } else for (const value of ["true", "false", "any"]) expect(String(problem.detail)).toContain(value);
    expect(bytes).not.toMatch(/private-first|private-second|unknown-private-marker|private-presence-marker|🧪|xxxxx/);
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
  });

  it.each([
    [INVALID_COMMENTS[0], INVALID_COMMENTS[6]], [INVALID_PRESENCE[0], INVALID_PRESENCE[13]]
  ])("same fixed problem for distinct invalid forms %s", async (left, right) => {
    const a = await request(left, { forbidAll: true });
    const b = await request(right, { forbidAll: true });
    expect(a.response.status).toBe(400); expect(b.response.status).toBe(400);
    expect(await a.response.json()).toEqual(await b.response.json());
    expect(a.prepared).toEqual([]); expect(b.prepared).toEqual([]);
  });

  it.each([null, "invalid-synthetic-token"])("auth takes precedence for token %s", async token => {
    for (const query of ["comments=private-first&hasComments=true", INVALID_COMMENTS[0], INVALID_COMMENTS[6], INVALID_PRESENCE[0], INVALID_PRESENCE[16]]) {
      const result = await request(query, { token, forbidAll: true, headers: { "if-none-match": "*" } });
      expect(result.response.status).toBe(401);
      expect(result.prepared).toEqual([]); expect(result.statements).toEqual([]);
      expect(await result.response.text()).not.toMatch(/private-first|private-second|🧪/);
      expect(result.response.headers.get("link")).toBeNull(); expect(result.response.headers.get("etag")).toBeNull();
    }
  });

  it.each(["count", "page"] as const)("D1 %s errors never reflect private SQL/values", async fail => {
    const result = await request({ comments: SPECIAL, hasComments: "true" }, { fail });
    expect(result.response.status).toBe(500);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const bytes = await result.response.text();
    expect(JSON.parse(bytes)).toMatchObject({ status: 500, type: expect.stringMatching(/#internal$/) });
    expect(bytes).not.toContain(JSON.stringify(SPECIAL).slice(1, -1));
    expect(bytes).not.toContain("synthetic-private-db-marker");
    expect(result.response.headers.get("etag")).toBeNull(); expect(result.response.headers.get("link")).toBeNull();
  });

  it.each(["fields=not-a-column", "countOnly=true&includeTotal=false", "exactNext=bogus", "upperId=bad"])("preserves existing validation %s", async invalid => {
    const result = await request(`comments=handoff&hasComments=true&${invalid}`, { forbidAll: true });
    expect(result.response.status).toBe(400);
    expect(result.prepared).toEqual([]); expect(result.statements).toEqual([]);
  });
});

describe("synthetic local query-plan evidence, not an index or latency guarantee", () => {
  it("resolves literal comment and stored-presence shapes against migrated D1", async () => {
    const sql = "SELECT pickup_address_id FROM address_snapshot WHERE comments IS NOT NULL AND comments <> '' AND instr(lower(coalesce(comments, '')), lower(?)) > 0 ORDER BY pickup_address_id LIMIT ?";
    const matches = await TEST_ENV.CUSTOMER_DB.prepare(sql).bind(FRAGMENT, 50).all<{ pickup_address_id: number }>();
    expect(matches.results.map(r => r.pickup_address_id)).toEqual([11, 23, 37, 42, 58, 69]);
    const absent = await TEST_ENV.CUSTOMER_DB.prepare("SELECT pickup_address_id FROM address_snapshot WHERE comments IS NULL OR comments = '' ORDER BY pickup_address_id").all<{ pickup_address_id: number }>();
    expect(absent.results.map(r => r.pickup_address_id)).toEqual(ABSENT);
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(FRAGMENT, 50).all<{ detail: string }>();
    expect(plan.results.map(r => r.detail).join(" ")).toMatch(/SCAN address_snapshot/i);
    const indexes = await TEST_ENV.CUSTOMER_DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'address_snapshot'").all<{ name: string }>();
    expect(indexes.results.map(r => r.name).filter(name => /comment/i.test(name))).toEqual([]);
  });
});

describe("mounted address-comments discovery", () => {
  type Parameter = { name: string; in: string; required?: boolean; description?: string; example?: unknown; schema?: Record<string, unknown> };
  type Operation = { operationId?: string; parameters?: Parameter[]; description?: string; responses?: Record<string, { description?: string }>; [key: string]: unknown };
  async function document() {
    const result = await request(new URL("/openapi.json", ORIGIN), { forbidAll: true });
    expect(result.response.status).toBe(200); expect(result.prepared).toEqual([]);
    return await result.response.json() as { paths: Record<string, Record<string, Operation>> };
  }
  it("advertises bounded comments and exact stored presence on the existing read operation", async () => {
    const op = (await document()).paths[PATH].get;
    expect(op).toMatchObject({ operationId: "listAddressSnapshot", "x-access": "read", "x-effect": "local-read" });
    const comments = op.parameters?.filter(p => p.in === "query" && p.name === "comments") ?? [];
    const presence = op.parameters?.filter(p => p.in === "query" && p.name === "hasComments") ?? [];
    expect(comments).toHaveLength(1); expect(presence).toHaveLength(1);
    expect(comments[0]).toMatchObject({ required: false, schema: { type: "string", maxLength: 100 } });
    expect(presence[0]).toMatchObject({ required: false, schema: { type: "string", enum: ["true", "false", "any"], default: "any" } });
    const guidance = `${op.description ?? ""} ${comments[0].description ?? ""} ${comments[0].schema?.description ?? ""} ${presence[0].description ?? ""} ${presence[0].schema?.description ?? ""}`;
    for (const pattern of [/literal/i, /substring/i, /ASCII/, /code.point/i, /before.*trim/i, /blank|whitespace/i, /stored/i, /null/i, /empty/i, /\bAND\b|intersect/i, /driverNote|driver_note/, /scan/i]) expect(guidance).toMatch(pattern);
    expect(op.responses?.["400"]?.description).toMatch(/comments/);
    expect(op.responses?.["400"]?.description).toMatch(/hasComments/);
  });
  it("keeps hasComments address-list-only and preserves customer comments as a separate selector", async () => {
    const doc = await document();
    for (const [path, operations] of Object.entries(doc.paths)) for (const [method, op] of Object.entries(operations)) {
      if (path === PATH && method === "get") continue;
      expect(op.parameters?.map(p => p.name) ?? [], `${method} ${path}`).not.toContain("hasComments");
      if (path !== "/api/v1/customer-snapshot" || method !== "get") expect(op.parameters?.filter(p => p.in === "query").map(p => p.name) ?? [], `${method} ${path}`).not.toContain("comments");
    }
    expect(doc.paths["/api/v1/customer-snapshot"].get.parameters?.map(p => p.name)).toContain("comments");
    expect(Object.keys(doc.paths).filter(path => /comments/i.test(path))).toEqual([]);
  });
});
