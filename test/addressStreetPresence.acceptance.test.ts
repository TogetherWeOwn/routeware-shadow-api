import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent test-first oracle. Hand-derived IDs exercise real local D1,
 * catching street/column confusion, case/whitespace/coercion, OR leakage,
 * count/page drift, leaked values, lost continuation scope and stale ETags.
 * Only fixture setup may write; HTTP bindings deny writes, R2 and network.
 * Builder consumes this oracle unchanged; request corrections from Test Author.
 * Focus: npx vitest run test/addressStreetPresence.acceptance.test.ts --maxWorkers=2
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/address-snapshot";
const ORIGIN = "https://street-presence-client.invalid";
const TOKEN = "test-read-token";
const NOTE = "Gate amber";
const AUDIT = "2026-01-15";
const STREET = "001 Cedar St";
const STREET_PADDED = " 001 Cedar St ";
const STREET_LOWER = "001 cedar st";
const LITERAL = 'O\'Ridge 50%_ &+/#? "雪\\tail';
const INJECTION = "x' OR 1=1 --";
const WS_ONLY = " \t ";
const ALL_IDS = [11, 23, 37, 42, 58, 69, 73, 79, 83, 89, 97, 101, 109, 113, 127, 131, 137, 139, 149, 151, 157];
const PRESENT_IDS = [11, 23, 37, 42, 58, 69, 73, 79, 83, 101, 127, 131, 137, 139, 151, 157];
const ABSENT_IDS = [89, 97, 109, 113, 149];
const EXACT_IDS = [11, 23, 37, 42];
type Query = Record<string, string | number>;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
type Options = { token?: string | null; headers?: Record<string, string>; forbidAll?: boolean; fail?: "count" | "page" };
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
const ids = (body: Body) => body.rows.map(row => row.pickup_address_id);

// id, customer, route, franchise, enabled, extras, street, city, zip, note, comments, state, audit
const FIXTURES: Array<[number, number, number, string, number, number, string | null, string | null, string | null, string | null, string | null, string, string | null]> = [
  [11, 101, 7, "001", 1, 1, STREET, null, "00741", NOTE, null, "ZZ", AUDIT],
  [23, 101, 7, "001", 1, 1, STREET, "741 Borough", "00741", NOTE, null, "ZZ", AUDIT],
  [37, 101, 7, "001", 1, 1, STREET, null, "00741-1234", NOTE, null, "ZZ", AUDIT],
  [42, 101, 8, "1", 1, 1, STREET, "741", "98000", NOTE, null, "ZZ", AUDIT],
  [58, 202, 7, "001", 1, 0, "741 Other Lane", null, "00741", "unrelated", null, "ZZ", AUDIT],
  [69, 101, 7, "001", 0, 0, "741 Disabled Lane", null, "00741", "unrelated", null, "ZZ", null],
  [73, 101, 7, "001", 1, 1, "Comment Lane", null, null, NOTE, STREET, "ZZ", ""],
  [79, 101, 7, "001", 1, 1, "City Lane", STREET, null, "unrelated", null, "ZZ", "unrelated"],
  [83, 101, 7, "001", 1, 1, "ZIP Lane", null, STREET, "unrelated", null, "ZZ", "unrelated"],
  [89, 101, 7, "001", 1, 1, null, null, null, "unrelated", null, "ZZ", null],
  [97, 101, 7, "001", 1, 0, "", null, null, "unrelated", null, "ZZ", "unrelated"],
  [101, 101, 7, "001", 1, 1, WS_ONLY, null, null, "unrelated", null, "ZZ", null],
  [109, 202, 7, "001", 1, 0, null, "Null Borough", "Null ZIP", "unrelated", null, "ZZ", ""],
  [113, 101, 7, "001", 1, 1, "", "Empty Borough", null, NOTE, null, "ZZ", AUDIT],
  [127, 101, 7, "001", 1, 1, LITERAL, null, null, "unrelated", null, "ZZ", "unrelated"],
  [131, 101, 7, "001", 1, 1, INJECTION, null, null, "unrelated", null, "ZZ", "unrelated"],
  [137, 101, 7, "001", 1, 1, STREET_PADDED, null, null, "unrelated", null, "ZZ", "unrelated"],
  [139, 101, 7, "001", 1, 1, STREET_LOWER, null, null, "unrelated", null, "ZZ", "unrelated"],
  [149, 101, 7, "001", 1, 1, null, STREET, STREET, NOTE, null, "ZZ", AUDIT],
  [151, 101, 7, "001", 1, 1, "Astral 🚛 Lane", null, null, "unrelated", null, "ZZ", "unrelated"],
  [157, 101, 7, "001", 1, 1, "0", null, null, "unrelated", null, "ZZ", "unrelated"]
];

let denied: string[];
let outbound: ReturnType<typeof vi.fn>;
let logs: Array<ReturnType<typeof vi.spyOn>>;
function forbid(operation: string): never {
  denied.push(operation);
  throw new Error("Forbidden effect in street-presence acceptance");
}
function readOnlyDb(options: Options) {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return new Proxy(stmt, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql, values);
        const method = Reflect.get(target, property, target);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          if (!["all", "first", "raw"].includes(String(property))) return forbid(`D1.${String(property)}`);
          statements.push({ sql, binds });
          if ((options.fail === "count" && isCount({ sql, binds })) ||
              (options.fail === "page" && !isCount({ sql, binds }))) {
            throw new Error(`synthetic-private-db-marker ${LITERAL}`);
          }
          return Reflect.apply(method, target, args);
        };
      }
    });
  }
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      if (options.forbidAll || !/^\s*SELECT\b/i.test(sql)) return forbid("D1.prepare");
      return wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []);
    },
    batch: () => forbid("D1.batch"), exec: () => forbid("D1.exec"), dump: () => forbid("D1.dump")
  } as unknown as D1Database;
  return { db, prepared, statements };
}
async function request(query: Query | URL | string = {}, options: Options = {}) {
  const url = query instanceof URL ? query : new URL(PATH, "http://test.local");
  if (!(query instanceof URL)) url.search = typeof query === "string" ? query : new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)])
  ).toString();
  const recorder = readOnlyDb(options);
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Street-presence-acceptance", ...options.headers });
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const forbiddenBinding = new Proxy({}, { get: (_target, property) => () => forbid(`external.${String(property)}`) });
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: recorder.db,
    SNAPSHOTS: forbiddenBinding as R2Bucket, BROWSER: forbiddenBinding as Fetcher
  });
  return { response, url, ...recorder };
}
function posture(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("x-request-id")).toBe("Street-presence-acceptance");
  expect(response.headers.get("vary")).toMatch(/\borigin\b/i);
  const exposed = (response.headers.get("access-control-expose-headers") ?? "").toLowerCase().split(/,\s*/);
  expect(exposed).toEqual(expect.arrayContaining(["etag", "link", "x-request-id"]));
}
async function page(query: Query | URL | string = {}, headers?: Record<string, string>) {
  const result = await request(query, { headers });
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  posture(result.response);
  const bytes = await result.response.text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const params = result.url.searchParams;
  const countOnly = params.get("countOnly") === "true";
  const countFree = params.get("includeTotal") === "false";
  if (countOnly) {
    expect(body.rows).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.statements).toHaveLength(1);
    expect(result.statements.filter(isCount)).toHaveLength(1);
    expect(result.prepared).toHaveLength(1);
  } else {
    expect(result.statements).toHaveLength(countFree ? 1 : 2);
    expect(result.statements.filter(isCount)).toHaveLength(countFree ? 0 : 1);
    expect(result.prepared).toHaveLength(countFree ? 1 : 2);
  }
  for (const statement of result.statements) expect(statement.sql).not.toMatch(/\bJOIN\b/i);
  return { ...result, body, bytes };
}
function next(result: Awaited<ReturnType<typeof page>>, expected: Query) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/address-snapshot\?[^<>\s]*>; rel="next"$/);
  const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(target.origin).toBe(result.url.origin);
  expect(target.pathname).toBe(PATH);
  expect(target.hash).toBe("");
  expect(target.username).toBe("");
  expect(target.password).toBe("");
  const actual = new URLSearchParams(target.search);
  const want = Object.fromEntries(Object.entries(expected).map(([key, value]) => [key, String(value)]));
  if (want.includeTotal !== "false") {
    expect([null, "true"]).toContain(actual.get("includeTotal"));
    expect(actual.getAll("includeTotal").length).toBeLessThanOrEqual(1);
    actual.delete("includeTotal");
    delete want.includeTotal;
  }
  if (want.countOnly !== "true") {
    expect([null, "false"]).toContain(actual.get("countOnly"));
    actual.delete("countOnly");
    delete want.countOnly;
  }
  if (want.order === undefined || want.order === "asc") {
    expect([null, "asc"]).toContain(actual.get("order"));
    if (actual.get("order") !== null) expect(want.order).toBe("asc");
    actual.delete("order");
    delete want.order;
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

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  denied = [];
  outbound = vi.fn(async () => { throw new Error("Forbidden outbound street-presence request"); });
  vi.stubGlobal("fetch", outbound);
  logs = (["log", "info", "warn", "error", "debug"] as const).map(level => vi.spyOn(console, level).mockImplementation(() => undefined));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot")
  ]);
  await db.batch([101, 202].map(id => db.prepare(
    "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'synthetic-street-presence', 1, 'fixed-time')"
  ).bind(id)));
  for (const row of [...FIXTURES].reverse()) await db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, enabled, extras_allowed, address, city, zip, driver_note, comments, state, last_audit_date, synced_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixed-time')"
  ).bind(...row).run();
  for (const [id, owner, enabled] of [[501, 23, 0], [502, 37, 1], [503, 37, 0], [504, 89, 1]]) await db.prepare(
    "INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, synced_at) VALUES (?, ?, ?, 'fixed-time')"
  ).bind(id, owner, enabled).run();
});
afterEach(() => {
  try {
    expect(outbound).not.toHaveBeenCalled();
    expect(denied).toEqual([]);
    const text = JSON.stringify(logs.map(log => log.mock.calls));
    for (const marker of [NOTE, STREET, LITERAL, INJECTION, WS_ONLY, "synthetic-private-db-marker", "private-street-", "unknown-street-marker"]) {
      expect(text).not.toContain(marker);
      expect(text).not.toContain(JSON.stringify(marker).slice(1, -1));
      expect(text).not.toContain(encodeURIComponent(marker));
      expect(text).not.toContain(new URLSearchParams({ hasStreetAddress: marker }).toString());
    }
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe("hasStreetAddress presence is the exact null-or-empty complement", () => {
  it("true selects every nonempty stored street including whitespace-only, \"0\" and punctuation", async () => {
    const result = await page({ hasStreetAddress: "true" });
    expect(ids(result.body)).toEqual(PRESENT_IDS);
    expect(result.body.total).toBe(PRESENT_IDS.length);
    expect(result.body.nextCursor).toBeNull();
    for (const row of result.body.rows) {
      expect(row.address).not.toBeNull();
      expect(row.address).not.toBe("");
    }
    expect(ids(result.body)).toContain(101);
    expect(ids(result.body)).toContain(157);
    expect(ids(result.body)).toContain(127);
    expect(ids(result.body)).toContain(131);
    for (const statement of result.statements) {
      expect(statement.sql).toMatch(/\baddress\s+IS\s+NOT\s+NULL/i);
      expect(statement.sql).toMatch(/\baddress\s*<>\s*''/);
      expect(statement.binds).not.toContain("true");
    }
  });

  it("false selects exactly NULL plus empty, excluding whitespace-only", async () => {
    const result = await page({ hasStreetAddress: "false" });
    expect(ids(result.body)).toEqual(ABSENT_IDS);
    expect(result.body.total).toBe(5);
    expect(result.body.nextCursor).toBeNull();
    expect(result.body.rows).toEqual([
      expect.objectContaining({ pickup_address_id: 89, address: null }),
      expect.objectContaining({ pickup_address_id: 97, address: "" }),
      expect.objectContaining({ pickup_address_id: 109, address: null }),
      expect.objectContaining({ pickup_address_id: 113, address: "" }),
      expect.objectContaining({ pickup_address_id: 149, address: null })
    ]);
    for (const statement of result.statements) {
      expect(statement.sql).toMatch(/\baddress\s+IS\s+NULL/i);
      expect(statement.sql).toMatch(/\baddress\s*=\s*''/);
      expect(statement.binds).not.toContain("false");
    }
  });

  it("reads the stored street column only: locality text never rescues a null street", async () => {
    const absent = await page({ hasStreetAddress: "false" });
    expect(ids(absent.body)).toContain(149);
    const present = await page({ hasStreetAddress: "true", q: STREET });
    expect(ids(present.body)).not.toContain(149);
    for (const statement of absent.statements) {
      // The page SELECT legitimately projects every address column, so the
      // column-isolation check scopes to the WHERE clause predicate only.
      const where = statement.sql.slice(statement.sql.search(/\bWHERE\b/i)).split(/\bORDER\s+BY\b|\bLIMIT\b/i)[0];
      expect(where).toMatch(/\baddress\s+IS\s+NULL/i);
      expect(where).not.toMatch(/comments|driver_note|latitude|longitude/i);
    }
  });

  it.each(["any", "omitted"])("%s adds no predicate, with identical bytes, SQL and Link", async mode => {
    const plain = await page({ limit: 2 });
    const any = mode === "any" ? await page({ hasStreetAddress: "any", limit: 2 }) : plain;
    const target = mode === "any" ? any : plain;
    expect(ids(target.body)).toEqual([11, 23]);
    if (mode === "any") {
      expect(any.bytes).toBe(plain.bytes);
      expect(any.statements).toEqual(plain.statements);
      expect(any.response.headers.get("etag")).toBe(plain.response.headers.get("etag"));
      expect(any.response.headers.get("link")).toBe(plain.response.headers.get("link"));
      next(any, { limit: 2, cursor: 23 });
    }
    expect(ids((await page(mode === "any" ? { hasStreetAddress: "any" } : {})).body)).toEqual(ALL_IDS);
  });
});

describe("exact street plus presence intersection and contradiction", () => {
  it.each([
    { streetAddress: STREET, hasStreetAddress: "true", want: EXACT_IDS },
    { streetAddress: STREET, hasStreetAddress: "any", want: EXACT_IDS },
    { streetAddress: LITERAL, hasStreetAddress: "true", want: [127] },
    { streetAddress: INJECTION, hasStreetAddress: "true", want: [131] },
    { streetAddress: STREET_PADDED, hasStreetAddress: "true", want: [137] },
    { streetAddress: STREET_LOWER, hasStreetAddress: "true", want: [139] }
  ])("exact $streetAddress plus $hasStreetAddress intersects", async ({ streetAddress, hasStreetAddress, want }) => {
    const result = await page({ streetAddress, hasStreetAddress });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
    for (const row of result.body.rows) expect(row.address).toBe(streetAddress);
  });

  it("exact matching still reads only the street column under a presence intersection", async () => {
    const result = await page({ streetAddress: STREET, hasStreetAddress: "true" });
    expect(ids(result.body)).toEqual(EXACT_IDS);
    for (const confusion of [73, 79, 83, 137, 139, 149]) expect(ids(result.body)).not.toContain(confusion);
    for (const statement of result.statements) {
      expect(statement.binds).toContain(STREET);
      expect(statement.sql).toContain("address = ?");
      expect(statement.sql).toMatch(/\baddress\s+IS\s+NOT\s+NULL/i);
    }
  });

  it.each([
    { streetAddress: STREET, hasStreetAddress: "false" },
    { streetAddress: LITERAL, hasStreetAddress: "false" },
    { streetAddress: "1999 Missing Lane", hasStreetAddress: "true" },
    { streetAddress: "1999 Missing Lane", hasStreetAddress: "false" },
    { streetAddress: "1999 Missing Lane", hasStreetAddress: "any" }
  ])("contradiction $streetAddress plus $hasStreetAddress is empty", async ({ streetAddress, hasStreetAddress }) => {
    const result = await page({ streetAddress, hasStreetAddress });
    expect(result.body).toEqual({ rows: [], total: 0, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
  });
});

describe.each(["true", "false"])("street-presence AND intersections includeTotal=%s", includeTotal => {
  it.each<{ query: Query; want: number[] }>([
    { query: { hasStreetAddress: "true", customerId: 101, enabled: "true" }, want: [11, 23, 37, 42, 73, 79, 83, 101, 127, 131, 137, 139, 151, 157] },
    { query: { hasStreetAddress: "false", customerId: 101, enabled: "true" }, want: [89, 97, 113, 149] },
    { query: { hasStreetAddress: "true", customerId: 202 }, want: [58] },
    { query: { hasStreetAddress: "false", customerId: 202 }, want: [109] },
    { query: { hasStreetAddress: "true", pickupAddressId: 89 }, want: [] },
    { query: { hasStreetAddress: "false", pickupAddressId: 23 }, want: [] },
    { query: { hasStreetAddress: "true", ids: "89,23" }, want: [23] },
    { query: { hasStreetAddress: "false", ids: "89,23" }, want: [89] },
    { query: { hasStreetAddress: "true", ids: "89,109" }, want: [] },
    { query: { hasStreetAddress: "false", ids: "42,149" }, want: [149] },
    { query: { hasStreetAddress: "true", enabled: "false" }, want: [69] },
    { query: { hasStreetAddress: "false", enabled: "false" }, want: [] },
    { query: { hasStreetAddress: "false", routeId: 8 }, want: [] },
    { query: { hasStreetAddress: "false", franchiseId: "1" }, want: [] },
    { query: { hasStreetAddress: "true", routeId: 8, franchiseId: "1" }, want: [42] },
    { query: { hasStreetAddress: "false", routeId: 7, franchiseId: "001" }, want: [89, 97, 109, 113, 149] },
    { query: { hasStreetAddress: "true", zip: "00741" }, want: [11, 23, 58, 69] },
    { query: { hasStreetAddress: "false", zip: STREET }, want: [149] },
    { query: { hasStreetAddress: "true", zip: STREET }, want: [83] },
    { query: { hasStreetAddress: "false", city: STREET }, want: [149] },
    { query: { hasStreetAddress: "true", city: STREET }, want: [79] },
    { query: { hasStreetAddress: "true", state: "ZZ" }, want: PRESENT_IDS },
    { query: { hasStreetAddress: "false", state: "ZZ" }, want: ABSENT_IDS },
    { query: { hasStreetAddress: "true", extrasAllowed: "false" }, want: [58, 69] },
    { query: { hasStreetAddress: "false", extrasAllowed: "false" }, want: [97, 109] },
    { query: { hasStreetAddress: "false", extrasAllowed: "true" }, want: [89, 113, 149] },
    { query: { hasStreetAddress: "true", hasContainers: "true" }, want: [23, 37] },
    { query: { hasStreetAddress: "false", hasContainers: "true" }, want: [89] },
    { query: { hasStreetAddress: "false", hasContainers: "false" }, want: [97, 109, 113, 149] },
    { query: { hasStreetAddress: "false", driverNote: NOTE }, want: [113, 149] },
    { query: { hasStreetAddress: "true", driverNote: NOTE }, want: [11, 23, 37, 42, 73] },
    { query: { hasStreetAddress: "false", driverNote: "unrelated" }, want: [89, 97, 109] },
    { query: { hasStreetAddress: "true", lastAuditDate: AUDIT }, want: [11, 23, 37, 42, 58] },
    { query: { hasStreetAddress: "false", lastAuditDate: AUDIT }, want: [113, 149] },
    { query: { hasStreetAddress: "false", hasLastAuditDate: "false" }, want: [89, 109] },
    { query: { hasStreetAddress: "false", hasLastAuditDate: "true" }, want: [97, 113, 149] },
    { query: { hasStreetAddress: "true", hasLastAuditDate: "false" }, want: [69, 73, 101] },
    { query: { hasStreetAddress: "true", q: "Borough" }, want: [23] },
    { query: { hasStreetAddress: "false", q: "Borough" }, want: [109, 113] },
    { query: { hasStreetAddress: "true", q: STREET }, want: [11, 23, 37, 42, 79, 83, 137, 139] },
    { query: { hasStreetAddress: "false", q: STREET }, want: [149] },
    { query: { hasStreetAddress: "true", q: "missing-locality" }, want: [] },
    { query: { hasStreetAddress: "false", q: "missing-locality" }, want: [] },
    { query: { hasStreetAddress: "false", upperId: 109 }, want: [89, 97, 109] },
    { query: { hasStreetAddress: "false", upperId: 109, cursor: 97 }, want: [109] },
    { query: { hasStreetAddress: "false", upperId: 109, cursor: 109, order: "desc" }, want: [97, 89] },
    { query: { hasStreetAddress: "false", upperId: 109, cursor: 113 }, want: [] },
    { query: { hasStreetAddress: "true", customerId: 101, routeId: 7, franchiseId: "001", zip: "00741", enabled: "true", hasContainers: "true", upperId: 37, q: "741" }, want: [23] }
  ])("$query", async ({ query, want }) => {
    const result = await page({ ...query, includeTotal, fields: "enabled" });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
    expect(result.body.nextCursor).toBeNull();
    for (const row of result.body.rows) expect(Object.keys(row).sort()).toEqual(["enabled", "pickup_address_id"]);
    if (includeTotal === "true") {
      const count = result.statements.find(isCount)!;
      const select = result.statements.find(s => !isCount(s))!;
      const predicate = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).split(/\bORDER\s+BY\b|\bLIMIT\b/i)[0].trim().replace(/\s+/g, " ");
      expect(predicate(count.sql)).toBe(predicate(select.sql));
      expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
    }
  });
});

describe.each(["true", "false"])("street-presence continuation includeTotal=%s", includeTotal => {
  it.each([
    { order: "asc", pages: [[89, 97], [109, 113], [149]] },
    { order: "desc", pages: [[149, 113], [109, 97], [89]] }
  ])("follows every full absent page in $order order through terminal, no duplicates", async ({ order, pages }) => {
    const walk = { hasStreetAddress: "false", order, limit: 2, includeTotal };
    const current0 = await page(walk);
    const seen: unknown[] = [];
    let current = current0;
    for (let index = 0; index < pages.length; index++) {
      expect(ids(current.body)).toEqual(pages[index]);
      expect(current.body.total).toBe(includeTotal === "false" ? null : [5, 3, 1][index]);
      seen.push(...ids(current.body));
      if (index === 2) {
        expect(current.body.nextCursor).toBeNull();
        expect(current.response.headers.get("link")).toBeNull();
      } else {
        const cursor = pages[index][1];
        expect(current.body.nextCursor).toBe(cursor);
        current = await page(next(current, { ...walk, cursor }));
      }
    }
    expect(seen).toEqual(order === "asc" ? [89, 97, 109, 113, 149] : [149, 113, 109, 97, 89]);
    expect(new Set(seen).size).toBe(5);
  });

  it.each([
    { order: "asc", first: [97, 109], cursor: 109, last: [113, 149] },
    { order: "desc", first: [113, 109], cursor: 109, last: [97, 89] }
  ])("offset-to-seek $order retains presence and omits offset", async ({ order, first, cursor, last }) => {
    const filters = { hasStreetAddress: "false", fields: "city,zip", order, limit: 2, includeTotal };
    const result = await page({ ...filters, offset: 1 });
    expect(ids(result.body)).toEqual(first);
    expect(result.body.total).toBe(includeTotal === "false" ? null : 5);
    expect(result.body.nextCursor).toBe(cursor);
    const terminal = await page(next(result, { ...filters, cursor }));
    expect(ids(terminal.body)).toEqual(last);
    expect(terminal.body.total).toBe(includeTotal === "false" ? null : 2);
    expect(terminal.body.nextCursor).toBeNull();
    expect(terminal.response.headers.get("link")).toBeNull();
  });

  it("cursor takes precedence over offset; partial, gap and empty pages remain correct", async () => {
    for (const [query, want, total, cursor] of [
      [{ cursor: 97, offset: 999 }, [109, 113], 2, 113],
      [{ cursor: 100 }, [109, 113], 2, 113],
      [{ cursor: 113 }, [149], 1, null],
      [{ cursor: 149 }, [], 0, null],
      [{ offset: 5 }, [], 5, null]
    ] as Array<[Query, number[], number, number | null]>) {
      const result = await page({ ...query, hasStreetAddress: "false", limit: 2, includeTotal });
      expect(ids(result.body)).toEqual(want);
      expect(result.body.total).toBe(includeTotal === "false" ? null : total);
      expect(result.body.nextCursor).toBe(cursor);
      if (query.cursor !== undefined) for (const s of result.statements) expect(s.sql).not.toMatch(/\bOFFSET\b/i);
      if (cursor === null) expect(result.response.headers.get("link")).toBeNull();
    }
  });

  it("retains presence with exact street, scopes and child presence in a full terminal page link", async () => {
    const filters = { streetAddress: STREET, hasStreetAddress: "true", pickupAddressId: 23, customerId: 101, routeId: 7, franchiseId: "001", zip: "00741", enabled: "true", hasContainers: "true", upperId: 37, fields: "enabled", order: "desc", limit: 1, includeTotal };
    const first = await page(filters);
    expect(ids(first.body)).toEqual([23]);
    const last = await page(next(first, { ...filters, cursor: 23 }));
    expect(last.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(last.response.headers.get("link")).toBeNull();
  });

  it("exactNext emits no lookahead link on the final absent page", async () => {
    const filters = { hasStreetAddress: "false", limit: 2, exactNext: "true", includeTotal };
    const first = await page(filters);
    expect(ids(first.body)).toEqual([89, 97]);
    const second = await page(next(first, { ...filters, cursor: 97 }));
    expect(ids(second.body)).toEqual([109, 113]);
    const terminal = await page(next(second, { ...filters, cursor: 113 }));
    expect(ids(terminal.body)).toEqual([149]);
    expect(terminal.body.nextCursor).toBeNull();
    expect(terminal.response.headers.get("link")).toBeNull();
  });
});

describe("street-presence countOnly and count-free modes", () => {
  it.each<{ query: Query; total: number }>([
    { query: { hasStreetAddress: "true" }, total: 16 },
    { query: { hasStreetAddress: "false" }, total: 5 },
    { query: { hasStreetAddress: "any" }, total: 21 },
    { query: {}, total: 21 },
    { query: { streetAddress: STREET, hasStreetAddress: "false" }, total: 0 },
    { query: { streetAddress: STREET, hasStreetAddress: "true" }, total: 4 },
    { query: { hasStreetAddress: "false", customerId: 101 }, total: 4 },
    { query: { hasStreetAddress: "false", q: STREET }, total: 1 }
  ])("countOnly returns COUNT-only $query", async ({ query, total }) => {
    const result = await page({ ...query, countOnly: "true" });
    expect(result.body).toEqual({ rows: [], total, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.statements).toHaveLength(1);
    expect(result.statements.filter(isCount)).toHaveLength(1);
    for (const statement of result.statements) {
      if (query.hasStreetAddress === "true") expect(statement.sql).toMatch(/\baddress\s+IS\s+NOT\s+NULL/i);
      if (query.hasStreetAddress === "false") expect(statement.sql).toMatch(/\baddress\s+IS\s+NULL/i);
    }
  });

  it("countOnly ignores limit/offset for the total but still validates them", async () => {
    const result = await page({ hasStreetAddress: "false", countOnly: "true", limit: 1, offset: 5 });
    expect(result.body).toEqual({ rows: [], total: 5, nextCursor: null });
    const bad = await request({ hasStreetAddress: "false", countOnly: "true", limit: 501 }, { forbidAll: true });
    expect(bad.response.status).toBe(400);
    expect(bad.prepared).toEqual([]);
  });

  it("countOnly plus includeTotal=false is a value-free 400 before D1", async () => {
    const result = await request({ hasStreetAddress: "false", countOnly: "true", includeTotal: "false" }, { forbidAll: true });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(await result.response.text()).toMatch(/countOnly/);
    expect(result.prepared).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
  });

  it("count-free returns identical page SQL, rows and cursor without COUNT or lookahead", async () => {
    const filters = { hasStreetAddress: "false", fields: "address", limit: 2 };
    const counted = await page(filters);
    const free = await page({ ...filters, includeTotal: "false" });
    expect(ids(free.body)).toEqual([89, 97]);
    expect(counted.body.total).toBe(5);
    expect(free.body).toEqual({ rows: counted.body.rows, total: null, nextCursor: 97 });
    expect(free.statements).toEqual(counted.statements.filter(s => !isCount(s)));
    const presentCounted = await page({ hasStreetAddress: "true", limit: 2 });
    const presentFree = await page({ hasStreetAddress: "true", limit: 2, includeTotal: "false" });
    expect(presentFree.body).toEqual({ rows: presentCounted.body.rows, total: null, nextCursor: 23 });
  });
});

describe("street-presence representation and read authority", () => {
  it.each(["true", "false"])("hashes final sparse envelope and revalidates 304 with reads, includeTotal=%s", async includeTotal => {
    const query = { hasStreetAddress: "false", fields: "city,zip", limit: 2, includeTotal };
    const first = await page(query);
    expect(first.body.rows).toEqual([
      { pickup_address_id: 89, city: null, zip: null },
      { pickup_address_id: 97, city: null, zip: null }
    ]);
    const tag = await hash(first.bytes);
    expect(first.response.headers.get("etag")).toBe(tag);
    const replay = await request(query, { headers: { "if-none-match": tag } });
    expect(replay.response.status).toBe(304);
    expect(replay.response.body).toBeNull();
    expect(await replay.response.text()).toBe("");
    posture(replay.response);
    expect(replay.response.headers.get("etag")).toBe(tag);
    expect(replay.response.headers.get("link")).toBe(first.response.headers.get("link"));
    expect(replay.statements).toEqual(first.statements);
    const changedFields = await page({ ...query, fields: "address" }, { "if-none-match": tag });
    expect(changedFields.response.headers.get("etag")).not.toBe(tag);
    const changedTotal = await page({ ...query, includeTotal: includeTotal === "true" ? "false" : "true" }, { "if-none-match": tag });
    expect(changedTotal.response.headers.get("etag")).not.toBe(tag);
  });

  it("recomputes membership after an unprojected stored street changes with unchanged synced_at", async () => {
    const query = { hasStreetAddress: "false", fields: "address" };
    const first = await page(query);
    expect(ids(first.body)).toEqual(ABSENT_IDS);
    await TEST_ENV.CUSTOMER_DB.prepare("UPDATE address_snapshot SET address = 'unrelated' WHERE pickup_address_id = 97").run();
    const changed = await page(query, { "if-none-match": first.response.headers.get("etag")! });
    expect(ids(changed.body)).toEqual([89, 109, 113, 149]);
    expect(changed.body.total).toBe(4);
    expect(changed.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
  });

  it("is idempotent, preserves full stored rows and ignores untrusted raw GET params in links", async () => {
    const before = await TEST_ENV.CUSTOMER_DB.prepare("SELECT * FROM address_snapshot ORDER BY pickup_address_id").all();
    const first = await page({ hasStreetAddress: "false", limit: 2 });
    expect(first.body.rows[0]).toMatchObject({ pickup_address_id: 89, customer_id: 101, address: null, comments: null, synced_at: "fixed-time" });
    const url = new URL(PATH, "https://untrusted-origin.invalid");
    url.search = new URLSearchParams({ hasStreetAddress: "false", limit: "2", "unknown-street-marker": "unknown-street-marker", token: "query-token-marker", url: "https://redirect-marker.invalid" }).toString();
    const tainted = await request(url, { headers: { host: "untrusted-host.invalid", "x-forwarded-host": "untrusted-forwarded.invalid" } });
    expect(tainted.response.status).toBe(200);
    expect(await tainted.response.text()).toBe(first.bytes);
    expect(tainted.statements).toEqual(first.statements);
    expect(tainted.response.headers.get("link")).toBe(first.response.headers.get("link"));
    expect(tainted.response.headers.get("link")).not.toMatch(/marker|untrusted|Bearer|test-read-token|https?:|\/\//);
    const after = await TEST_ENV.CUSTOMER_DB.prepare("SELECT * FROM address_snapshot ORDER BY pickup_address_id").all();
    expect(after.results).toEqual(before.results);
  });

  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("preserves existing read authority: %s", async token => {
    const result = await request({ streetAddress: STREET, hasStreetAddress: "true", pickupAddressId: 11 }, { token });
    expect(result.response.status).toBe(200);
    posture(result.response);
    expect(ids(await result.response.json() as Body)).toEqual([11]);
    const absent = await request({ hasStreetAddress: "false" }, { token });
    expect(absent.response.status).toBe(200);
    expect(ids(await absent.response.json() as Body)).toEqual(ABSENT_IDS);
  });

  it("works under strictQuery=true while unknown names still fail", async () => {
    const ok = await page({ hasStreetAddress: "false", strictQuery: "true" });
    expect(ids(ok.body)).toEqual(ABSENT_IDS);
    const bad = await request("hasStreetAddress=false&strictQuery=true&unknown-street-marker=1", { forbidAll: true });
    expect(bad.response.status).toBe(400);
    expect(bad.prepared).toEqual([]);
  });
});

describe("street-presence validation and value-free failures", () => {
  const invalidPresence = [
    "hasStreetAddress=",
    "hasStreetAddress=%20",
    "hasStreetAddress=yes",
    "hasStreetAddress=1",
    "hasStreetAddress=0",
    "hasStreetAddress=TRUE",
    "hasStreetAddress=True",
    "hasStreetAddress=%20true",
    "hasStreetAddress=true%20",
    "hasStreetAddress=ANY",
    "hasStreetAddress=any%20",
    "hasStreetAddress=null",
    "hasStreetAddress=true%2Cfalse",
    "hasStreetAddress=secret-street-marker",
    "hasStreetAddress=true&hasStreetAddress=false",
    "hasStreetAddress=true&hasStreetAddress=true",
    "hasStreetAddress=&hasStreetAddress=true",
    "hasStreetAddress=any&hasStreetAddress=any",
    "hasStreetAddress=true&hasStreet%41ddress=false"
  ];
  it.each(invalidPresence)("rejects invalid hasStreetAddress before D1 without echoing submitted data: %s", async query => {
    const result = await request(query, { forbidAll: true, headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    posture(result.response);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const bytes = await result.response.text();
    const body = JSON.parse(bytes) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["detail", "status", "title", "type"]);
    expect(body).toMatchObject({ type: expect.stringMatching(/#bad-request$/), title: "Bad Request", status: 400 });
    const action = String(body.detail);
    expect(action).toContain("hasStreetAddress");
    expect(action).toContain("docs/PROBLEMS.md#bad-request");
    expect(action).toMatch(/retry/i);
    for (const marker of ["private-street-", "secret-street-marker"]) expect(bytes).not.toContain(marker);
    expect(result.prepared).toEqual([]);
    expect(result.statements).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
  });

  it("uses the same fixed correction for repeated and unknown values", async () => {
    const unknown = await request(invalidPresence[13], { forbidAll: true });
    const repeated = await request(invalidPresence[14], { forbidAll: true });
    expect(unknown.response.status).toBe(400);
    expect(repeated.response.status).toBe(400);
    expect(await repeated.response.json()).toEqual(await unknown.response.json());
    expect(unknown.prepared).toEqual([]);
    expect(repeated.prepared).toEqual([]);
  });

  it.each([null, "incorrect-synthetic-token"])("auth precedes presence validation and conditional handling: %s", async token => {
    for (const query of [invalidPresence[13], invalidPresence[14], "hasStreetAddress=true"]) {
      const result = await request(query, { token, forbidAll: true, headers: { "if-none-match": "*" } });
      expect(result.response.status).toBe(401);
      expect(await result.response.text()).not.toContain("private-street-");
      expect(result.prepared).toEqual([]);
      expect(result.response.headers.get("link")).toBeNull();
      expect(result.response.headers.get("etag")).toBeNull();
    }
  });

  it.each(["count", "page"] as const)("D1 %s failures do not log or reflect street values or private exceptions", async fail => {
    const result = await request({ streetAddress: LITERAL, hasStreetAddress: "true" }, { fail });
    expect(result.response.status).toBe(500);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const bytes = await result.response.text();
    expect(JSON.parse(bytes)).toMatchObject({ status: 500, type: expect.stringMatching(/#internal$/) });
    expect(bytes).not.toContain(LITERAL);
    expect(bytes).not.toContain(JSON.stringify(LITERAL).slice(1, -1));
    expect(bytes).not.toContain("synthetic-private-db-marker");
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
  });
});

describe("street-presence mounted discovery", () => {
  it("publishes the optional presence selector on the existing local-read operation only", async () => {
    const result = await request(new URL("/openapi.json", "http://test.local"), { forbidAll: true });
    expect(result.response.status).toBe(200);
    type Operation = { operationId?: string; parameters?: Array<{ name: string; in: string; required?: boolean; description?: string; example?: unknown; schema?: Record<string, unknown> }>; responses?: Record<string, { description?: string }>; description?: string; [key: string]: unknown };
    const document = await result.response.json() as { paths: Record<string, { get?: Operation }> };
    const operation = document.paths[PATH]?.get;
    expect(operation).toMatchObject({ operationId: "listAddressSnapshot", "x-access": "read", "x-effect": "local-read" });
    const presence = operation?.parameters?.filter(p => p.name === "hasStreetAddress");
    expect(presence).toHaveLength(1);
    expect(presence![0]).toMatchObject({ in: "query", required: false, schema: { type: "string", enum: ["true", "false", "any"], default: "any" } });
    const guidance = `${presence![0].description ?? ""} ${operation?.description ?? ""}`;
    expect(guidance).toMatch(/stored/i);
    expect(guidance).toMatch(/presence/i);
    expect(guidance).toMatch(/\bAND\b|intersect/i);
    expect(guidance).toMatch(/mirror|stored/i);
    expect(operation?.responses?.["400"]?.description).toMatch(/hasStreetAddress/);
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/container-snapshot", "/api/v1/customer-snapshot/changes", "/api/v1/address-snapshot/{pickupAddressId}"]) {
      const names = document.paths[path]?.get?.parameters?.map(p => p.name) ?? [];
      expect(names).not.toContain("hasStreetAddress");
    }
    expect(result.prepared).toEqual([]);
  });
});
