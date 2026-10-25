import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned, tests-first oracle. Expected IDs/pages are hand-derived;
 * real local D1 executes product SQL, never a selection/sorting double.
 * Mutation targets: missing locality OR legs; ungrouped OR leakage; parent
 * fallback/join; trimmed/coerced/LIKE zip; lost binds, scopes, links or ETags;
 * UTF-16 limits; reflected values; auth/validation bypass via conditional GET.
 * Only fixture setup writes. Requests deny D1 writes, R2, browser and network.
 * Run: npx vitest run test/containerLocalityFilters.acceptance.test.ts --maxWorkers=2
 * GET is idempotent/local-read; CLI --dry-run is not applicable.
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/container-snapshot";
const ORIGIN = "https://container-locality.test.invalid";
const STAMP = "2026-01-02T03:04:05.000Z";
const LITERAL = 'O\'Ridge 50%_ &+/#? "雪\\tail';
const SPECIAL = ` ${LITERAL} `;
const HUNDRED = "🚛".repeat(100);
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
type Query = Record<string, string> | string | URL;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
type Fixture = readonly [number, number, string | null, string | null, string | null, string | null, number];
// id, parent, location_address, serial_number, city, zip, enabled.
// Parents 11/12/21 have deliberately DIFFERENT locality from these containers.
const FIXTURES: readonly Fixture[] = [
  [10, 11, "741 Depot", "asset", null, "02139", 1],
  [20, 11, "Plain", "741-serial", null, "02139", 1],
  [30, 11, "Plain", "asset", "North 741 Borough", "02139", 1],
  [40, 11, "Plain", "asset", null, "00741-1234", 1],
  [50, 12, "741 Depot", "741", "741", "02139", 1],
  [60, 21, "Plain", "asset", "741", "02139", 1],
  [70, 11, "Plain", "asset", "741", "02139", 0],
  [80, 12, "Other", "asset", "Elsewhere", "98000", 1],
  [90, 12, null, null, null, null, 1],
  [100, 11, "", "", "", "", 1],
  [110, 11, LITERAL, null, null, null, 1],
  [120, 11, null, LITERAL, null, null, 1],
  [130, 11, null, null, LITERAL, null, 1],
  [140, 11, null, null, null, SPECIAL, 1],
  [150, 11, "Plain", "asset", null, "00123", 1],
  [160, 11, "Plain", "asset", null, "123", 1],
  [170, 11, "Plain", "asset", null, "Ab-01", 1],
  [180, 11, "Plain", "asset", null, "ab-01", 1],
  [190, 11, "Plain", "asset", null, " 00123 ", 1],
  [200, 11, "Plain", "asset", HUNDRED, HUNDRED, 1],
  [210, 11, "Plain", "asset", "a".repeat(100), "a".repeat(100), 1],
  [220, 11, "Plain", "asset", "ÅBC", null, 1],
  [230, 11, null, null, null, SPECIAL, 1],
  [240, 11, null, null, LITERAL, null, 1],
  [250, 11, "Plain", "asset", null, "0", 1],
  [260, 11, "Plain", "asset", null, "x\t\ny", 1],
  [270, 11, "Plain", "asset", null, "é", 1],
  [280, 11, "Plain", "asset", null, "é", 1],
  [290, 11, "Plain", "asset", null, "%_", 1],
  [300, 11, "Plain", "asset", "741", "02139", 1],
];
const ALL = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230, 240, 250, 260, 270, 280, 290, 300];
const ids = (body: Body) => body.rows.map(row => row.container_id);
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
let denied: string[];
let beforeState: unknown;

function recordedDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const forbid = (operation: string): never => {
    denied.push(operation);
    throw new Error("Unexpected effect in container locality oracle");
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
  const external = () => forbid("external binding");
  return { db, prepared, statements, external };
}

async function state() {
  return Promise.all(["customer_snapshot", "address_snapshot", "container_snapshot"].map(table =>
    TEST_ENV.CUSTOMER_DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())).then(rows => rows.map(r => r.results));
}
async function request(query: Query = {}, options: { token?: string | null; headers?: Record<string, string> } = {}) {
  const recorder = recordedDb();
  const url = query instanceof URL ? query : new URL(PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = typeof query === "string" ? query : new URLSearchParams(query).toString();
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Locality-oracle", ...options.headers });
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
  expect(response.headers.get("x-request-id")).toBe("Locality-oracle");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
function budget(result: Awaited<ReturnType<typeof request>>) {
  const countFree = result.url.searchParams.get("includeTotal") === "false";
  const statements = result.recorder.statements;
  expect(statements).toHaveLength(countFree ? 1 : 2);
  expect(statements.filter(isCount)).toHaveLength(countFree ? 0 : 1);
  const select = statements.find(s => !isCount(s))!;
  const hasOffset = /\bOFFSET\b/i.test(select.sql);
  expect(select.binds[select.binds.length - (hasOffset ? 2 : 1)]).toBe(Number(result.url.searchParams.get("limit") ?? 50));
  if (!countFree) {
    const count = statements.find(isCount)!;
    // COUNT and page share predicate binds; LIMIT/OFFSET belong to the page only.
    expect(select.binds.slice(0, -(hasOffset ? 2 : 1))).toEqual(count.binds);
  }
  for (const s of statements) {
    const joins = s.sql.match(/\bJOIN\b/gi) ?? [];
    expect(joins).toHaveLength(result.url.searchParams.has("customerId") ? 1 : 0);
    if (joins.length) expect(s.sql).toMatch(/\bJOIN\s+address_snapshot\b/i);
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
  return { ...result, body, bytes };
}
function next(result: Awaited<ReturnType<typeof page>>) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/container-snapshot\?[^<>\s]*>; rel="next"$/);
  const url = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(url.origin).toBe(ORIGIN);
  expect(url.pathname).toBe(PATH);
  expect(url.hash).toBe("");
  expect(url.searchParams.has("offset")).toBe(false);
  expect(url.searchParams.getAll("cursor")).toEqual([String(result.body.nextCursor)]);
  for (const [key, raw] of result.url.searchParams) {
    if (key === "cursor" || key === "offset") continue;
    const value = key === "q" ? raw.trim() : raw;
    if (key === "q" && !value) expect(url.searchParams.has(key)).toBe(false);
    else if ((key === "order" && value === "asc") || (key === "includeTotal" && value === "true") || (key === "enabled" && value === "any")) {
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
  vi.stubGlobal("fetch", vi.fn(async () => { denied.push("network"); throw new Error("Unexpected network in locality oracle"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, synced_at) VALUES (1, 'Synthetic One', ?), (2, 'Synthetic Two', ?)").bind(STAMP, STAMP),
    db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, city, zip, synced_at) VALUES (11, 1, 'Parent-only', 'Parent City', '99999', ?), (12, 1, '741 Parent', '741 Parent City', '02139', ?), (21, 2, 'Other Parent', 'Parent City', '99999', ?)").bind(STAMP, STAMP, STAMP),
  ]);
  await db.batch([...FIXTURES].reverse().map(row => db.prepare(
    "INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, city, zip, enabled, rfid, state, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ZZ', ?)",
  ).bind(...row, row[0] === 300 ? "tag-other" : "tag", STAMP)));
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denied).toEqual([]);
    expect(await state(), "GET must not mutate any synthetic table").toEqual(beforeState);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe("container locality: exact stored zip", () => {
  it.each([
    ["duplicate localities, null excluded", "02139", [10, 20, 30, 50, 60, 70, 300]],
    ["leading zeros", "00123", [150]], ["not numeric coercion", "123", [160]],
    ["upper case", "Ab-01", [170]], ["lower case", "ab-01", [180]],
    ["edge whitespace preserved", " 00123 ", [190]], ["100 astral code points", HUNDRED, [200]],
    ["100 ASCII code points", "a".repeat(100), [210]], ["one code point", "0", [250]],
    ["internal whitespace", "x\t\ny", [260]], ["composed Unicode", "é", [270]], ["decomposed Unicode", "é", [280]],
    ["literal wildcards", "%_", [290]], ["reserved text and Unicode", SPECIAL, [140, 230]],
    ["prefix is not equality", "021", []], ["extended postcode is not prefix", "00741", []],
    ["null is not text", "null", []], ["unknown", "missing", []], ["SQL text cannot widen", "' OR 1=1 --", []],
    ["parent zip is not a fallback", "99999", []],
  ] as const)("%s", async (_name, zip, want) => {
    for (const joined of [false, true]) {
      const query: Record<string, string> = { zip };
      if (joined) query.customerId = "1";
      const result = await page(query);
      const expected = zip === "02139" && joined ? [10, 20, 30, 50, 70, 300] : want;
      expect(ids(result.body)).toEqual(expected);
      expect(result.body.total).toBe(expected.length);
      expect(result.body.nextCursor).toBeNull();
    }
  });
  it("filters an unprojected postcode before selecting canonical sparse rows", async () => {
    const result = await page({ zip: SPECIAL, fields: "enabled", includeTotal: "false" });
    expect(result.body).toEqual({ rows: [{ container_id: 140, enabled: 1 }, { container_id: 230, enabled: 1 }], total: null, nextCursor: null });
  });
});

describe("container locality: grouped literal q across four stored columns", () => {
  it.each([
    ["location-only", "Depot", [10, 50]], ["serial-only", "741-serial", [20]],
    ["city-only", "north 741", [30]], ["zip-only", "00741", [40]],
    ["four OR legs, no duplicate rows", "741", [10, 20, 30, 40, 50, 60, 70, 300]],
    ["postcode substring not exact zip", "00123", [150, 190]],
    ["ASCII folds in city", "NORTH", [30]], ["non-ASCII does not fold", "åbc", []], ["ASCII folds inside Unicode", "Åbc", [220]],
    ["parent city not searched", "Parent City", []], ["parent street not searched", "Parent-only", []],
    ["state not searched", "ZZ", []], ["no concatenated address", "Plain North", []], ["no nearby-postcode expansion", "00124", []],
    ["100 astral code points", HUNDRED, [200]], ["100 ASCII code points", "a".repeat(100), [210]],
    ["unknown", "no-synthetic-match", []],
  ] as const)("%s", async (_name, q, want) => {
    const result = await page({ q });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
    expect(result.body.nextCursor).toBeNull();
  });
  it.each([LITERAL, "'", "%", "_", "\\", "&+/#?", '"雪'])("binds literal %s without LIKE expansion", async q => {
    const result = await page({ q });
    expect(ids(result.body)).toEqual(q === "%" || q === "_" ? [110, 120, 130, 140, 230, 240, 290] : [110, 120, 130, 140, 230, 240]);
    for (const s of result.recorder.statements) {
      expect(s.sql).not.toContain(LITERAL);
      expect(s.sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP)\b/i);
      expect(s.binds).toContain(q);
    }
  });
  it.each(["", " \t\n "])("control: blank q is omitted, not an empty OR match (%j)", async q => {
    const plain = await page();
    const blank = await page({ q });
    expect(ids(blank.body)).toEqual(ALL);
    expect(blank.body).toEqual(plain.body);
    expect(blank.recorder.statements).toEqual(plain.recorder.statements);
  });
  it.each(["", " \t\n "])("omits validated blank q from continuation (%j)", async q => {
    const limited = await page({ q, limit: "2" });
    expect(next(limited).searchParams.has("q")).toBe(false);
  });
  it("control: omitted selectors preserve canonical stored locality, nulls and IDs", async () => {
    const result = await page();
    expect(ids(result.body)).toEqual(ALL);
    expect(result.body.total).toBe(30);
    expect(result.body.rows[0]).toMatchObject({ container_id: 10, pickup_address_id: 11, location_address: "741 Depot", city: null, zip: "02139", synced_at: STAMP });
    expect(result.body.rows[8]).toMatchObject({ container_id: 90, city: null, zip: null });
    expect((await page({ enabled: "any", includeTotal: "true" })).body).toEqual(result.body);
  });
});

describe.each(["true", "false"])("container locality: AND scope includeTotal=%s", includeTotal => {
  it.each([
    [{}, [10, 20, 30, 50, 60, 70, 300]],
    [{ customerId: "1" }, [10, 20, 30, 50, 70, 300]], [{ customerId: "2" }, [60]],
    [{ pickupAddressId: "11" }, [10, 20, 30, 70, 300]], [{ containerId: "30" }, [30]],
    [{ containerId: "80" }, []], [{ enabled: "true" }, [10, 20, 30, 50, 60, 300]], [{ enabled: "false" }, [70]],
    [{ serialNumber: "asset" }, [10, 30, 60, 70, 300]], [{ rfid: "tag-other" }, [300]],
    [{ customerId: "1", pickupAddressId: "11", containerId: "30", serialNumber: "asset", rfid: "tag", enabled: "true" }, [30]],
    [{ customerId: "2", pickupAddressId: "11" }, []], [{ customerId: "1", containerId: "60" }, []],
    [{ upperId: "30" }, [10, 20, 30]], [{ cursor: "30" }, [50, 60, 70, 300]],
    [{ order: "desc", cursor: "50" }, [30, 20, 10]],
  ] as const)("intersects q and zip with %j", async (filters, want) => {
    const result = await page({ zip: "02139", q: "741", ...filters, includeTotal });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
  });
  it("zip still restricts an existing location match instead of ORing outside q", async () => {
    const result = await page({ zip: "00123", q: "Depot", includeTotal });
    expect(result.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
  });
});

describe.each(["true", "false"])("container locality: next links includeTotal=%s", includeTotal => {
  it.each(["asc", "desc"])("traverses %s without duplicates, retaining validated scopes and upper fence", async order => {
    const filters = { zip: "02139", q: " 741 \t", customerId: "1", enabled: "true", upperId: "70", fields: "city,zip", limit: "2", includeTotal, order };
    let result = await page(filters);
    const pages = order === "asc" ? [[10, 20], [30, 50], []] : [[50, 30], [20, 10], []];
    const seen: unknown[] = [];
    for (let i = 0; i < pages.length; i++) {
      expect(ids(result.body)).toEqual(pages[i]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : [4, 2, 0][i]);
      for (const row of result.body.rows) expect(Object.keys(row).sort()).toEqual(["city", "container_id", "zip"]);
      seen.push(...ids(result.body));
      expect(result.body.nextCursor).toBe(i === 2 ? null : pages[i][1]);
      if (i === 2) expect(result.response.headers.get("link")).toBeNull();
      else result = await page(next(result));
    }
    expect(seen).toEqual(order === "asc" ? [10, 20, 30, 50] : [50, 30, 20, 10]);
    expect(new Set(seen).size).toBe(4);
  });
  it.each([
    ["asc", { offset: "1" }, [20, 30], 7, 30],
    ["desc", { offset: "1" }, [70, 60], 7, 60],
    ["asc", { cursor: "30", offset: "999" }, [50, 60], 4, 60],
    ["desc", { cursor: "50", offset: "999" }, [30, 20], 3, 20],
    ["asc", { cursor: "70" }, [300], 1, null],
    ["asc", { cursor: "300" }, [], 0, null],
    ["asc", { offset: "7" }, [], 7, null],
  ] as const)("%s offset/seek %j", async (order, paging, want, total, cursor) => {
    const result = await page({ zip: "02139", q: "741", order, ...paging, limit: "2", includeTotal });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(includeTotal === "false" ? null : total);
    expect(result.body.nextCursor).toBe(cursor);
    if ("cursor" in paging) for (const s of result.recorder.statements) expect(s.sql).not.toMatch(/\bOFFSET\b/i);
    if (cursor === null) expect(result.response.headers.get("link")).toBeNull();
    else next(result);
  });
  it("encodes opaque zip and trimmed q on followable links without losing exact identifiers", async () => {
    const filters = { zip: SPECIAL, q: `  ${LITERAL}  `, customerId: "1", pickupAddressId: "11", rfid: "tag", fields: "enabled", limit: "1", order: "desc", includeTotal };
    const first = await page(filters);
    expect(first.body.rows).toEqual([{ container_id: 230, enabled: 1 }]);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 2);
    expect(first.response.headers.get("link")).not.toContain(SPECIAL);
    const last = await page(next(first));
    expect(last.body.rows).toEqual([{ container_id: 140, enabled: 1 }]);
    const empty = await page(next(last));
    expect(empty.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(empty.response.headers.get("link")).toBeNull();
  });
});

const invalid = [
  ["zip", "zip="], ["zip", "zip"], ["zip", "zip=++"], ["zip", "zip=%09%0A"],
  ["zip", `zip=${encodeURIComponent(" 　")}`], ["zip", `zip=${"x".repeat(101)}`],
  ["zip", `zip=${encodeURIComponent(`${HUNDRED}🚛`)}`],
  ["zip", "zip=private-one&zip=private-one"], ["zip", "zip=private-one&zip=private-two"],
  ["zip", "zip=&zip=private-one"], ["zip", "zip=private-one&zip="], ["zip", "zip=private-one&z%69p=private-two"],
  ["q", `q=${"x".repeat(101)}`], ["q", `q=${encodeURIComponent(`${HUNDRED}🚛`)}`],
  ["q", `q=${encodeURIComponent(`741${" ".repeat(98)}`)}`],
  ["q", "q=private-one&q=private-two"], ["q", "q=&q=private-one"],
] as const;
describe("container locality: value-free rejection before D1", () => {
  it.each(invalid)("rejects %s query %s even on conditional GET", async (key, query) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const result = await request(query, { headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    posture(result.response);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(await result.response.json()).toEqual({ type: BAD_REQUEST, title: "Bad Request", status: 400, detail: `Invalid request query (${key}). See docs/PROBLEMS.md#bad-request.` });
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it.each([null, "invalid-token"])("control: authenticates token %s before malformed locality/304 handling", async token => {
    const result = await request("zip=private-one&zip=&q=private-one&q=private-two", { token, headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toMatchObject({ status: 401, title: "Unauthorized" });
    expect(result.recorder.prepared).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
  });
  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("retains authorized local reads via %s", async token => {
    const result = await request({ zip: "00123" }, { token });
    expect(result.response.status).toBe(200);
    expect(ids(await result.response.json() as Body)).toEqual([150]);
  });
  it("does not log successful raw zip/q and remains idempotent", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const first = await page({ zip: SPECIAL, q: LITERAL });
    expect(ids(first.body)).toEqual([140, 230]);
    expect((await page({ zip: SPECIAL, q: LITERAL })).body).toEqual(first.body);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it("control: unrelated unknown selectors remain ignored", async () => {
    const first = await page({ q: "Depot" });
    const unknown = await page({ q: "Depot", bogus_param: "private-marker" });
    expect(ids(unknown.body)).toEqual([10, 50]);
    expect(unknown.body).toEqual(first.body);
    expect(unknown.recorder.statements).toEqual(first.recorder.statements);
  });
});

it.each(["true", "false"])("locality-scoped final-envelope ETag/304 includeTotal=%s", async includeTotal => {
  const query = { zip: "02139", q: "741", customerId: "1", enabled: "true", fields: "enabled", limit: "2", includeTotal };
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
  const different = await page({ ...query, zip: "00741-1234" }, { "if-none-match": tag });
  expect(ids(different.body)).toEqual([40]);
  expect(different.response.headers.get("etag")).not.toBe(tag);
  const projected = await page({ ...query, fields: "zip" }, { "if-none-match": tag });
  expect(projected.response.headers.get("etag")).not.toBe(tag);
});

it.each(["city", "zip"])("recomputes membership after unprojected %s changes without a sync timestamp", async column => {
  const query = { q: column === "city" ? "north" : "00741", fields: "enabled" };
  const first = await page(query);
  expect(ids(first.body)).toEqual(column === "city" ? [30] : [40]);
  // Fixture mutation only, never through the HTTP binding.
  await TEST_ENV.CUSTOMER_DB.prepare(`UPDATE container_snapshot SET ${column} = NULL WHERE container_id = ?`).bind(column === "city" ? 30 : 40).run();
  beforeState = await state();
  const changed = await page(query, { "if-none-match": (await hash(first.bytes)) });
  expect(changed.body).toEqual({ rows: [], total: 0, nextCursor: null });
});

it("uses bound c.zip equality and executable unindexed locality scans, not parent joins or performance claims", async () => {
  const result = await page({ zip: SPECIAL, q: LITERAL, limit: "1" });
  expect(ids(result.body)).toEqual([140]);
  expect(result.body.total).toBe(2);
  for (const { sql, binds } of result.recorder.statements) {
    expect(sql).toMatch(/\bc\.zip\s*=\s*\?/i);
    expect(sql).not.toContain(LITERAL);
    expect(sql).not.toMatch(/\b(?:JOIN|LIKE|GLOB|REGEXP|COLLATE\s+NOCASE)\b/i);
    expect(binds).toContain(SPECIAL);
    expect(binds).toContain(LITERAL);
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
    const details = plan.results.map(row => row.detail).join("\n");
    expect(details, "synthetic local D1 only, not production latency evidence").toMatch(/\bSCAN\s+c\b/i);
    expect(details).not.toMatch(/\bSEARCH\s+c\b/i);
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
describe("container locality: mounted agent discovery", () => {
  it("publishes optional exact zip with code-point bounds and a leading-zero example", async () => {
    const op = (await document()).paths[PATH].get;
    expect(op).toMatchObject({ operationId: "listContainerSnapshot", "x-effect": "local-read", "x-access": "read" });
    const params = op.parameters.filter(p => p.in === "query" && p.name === "zip");
    expect(params).toHaveLength(1);
    const p = params[0];
    expect(p.required ?? false).toBe(false);
    expect(p.schema).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
    expect(p.schema.default).toBeUndefined();
    expect([p.example, p.schema.example, ...Object.values(p.examples ?? {}).map(e => e.value)].some(v => typeof v === "string" && /^0[0-9]{4}$/.test(v))).toBe(true);
    const guidance = `${p.description ?? ""} ${p.schema.description ?? ""}`;
    for (const pattern of [/exact/i, /case.sensitive/i, /Unicode code points/i, /leading zeros/i, /whitespace/i]) expect(guidance).toMatch(pattern);
  });
  it("discovers the broader q, AND scopes and value-free remediation on the existing operation", async () => {
    const op = (await document()).paths[PATH].get;
    const q = op.parameters.find(p => p.name === "q")!;
    const guidance = `${q.description ?? ""} ${q.schema.description ?? ""}`;
    expect(q.schema).toMatchObject({ type: "string", maxLength: 100 });
    expect(guidance).toMatch(/city/i);
    expect(guidance).toMatch(/zip|postcode/i);
    expect(guidance).toMatch(/substring/i);
    for (const name of ["zip", "q", "customerId", "pickupAddressId", "containerId", "serialNumber", "rfid", "enabled", "upperId", "order", "cursor", "offset", "includeTotal", "fields"]) {
      expect(op.parameters.some(p => p.in === "query" && p.name === name), name).toBe(true);
    }
    expect(op.description).toMatch(/\bAND\b|intersect/i);
    const recovery = op.responses["400"].description;
    for (const pattern of [/zip/i, /q/, /blank|empty/i, /repeat|duplicate/i, /100.*Unicode code points/i, /before.*D1/i, /application\/problem\+json/, /docs\/PROBLEMS\.md#bad-request/]) expect(recovery).toMatch(pattern);
  });
  it("keeps the served parameter inventory aligned with the canonical query-policy table", async () => {
    const op = (await document()).paths[PATH].get;
    const row = policyDoc.split("\n").find(line => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    const names = [...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map(m => m[1]).sort();
    expect(names).toContain("zip");
    expect(names).toEqual(op.parameters.filter(p => p.in === "query").map(p => p.name).sort());
  });
});
