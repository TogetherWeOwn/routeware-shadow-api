import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent test-first oracle. Hand-derived IDs exercise real local D1,
 * catching audit/column confusion, case/whitespace/coercion, OR leakage,
 * count/page drift, leaked values, lost continuation scope and stale ETags.
 * Only fixture setup may write; HTTP bindings deny writes, R2 and network.
 * Builder consumes this oracle unchanged; request corrections from Test Author.
 * Focus: npx vitest run test/addressLastAuditDate.acceptance.test.ts --maxWorkers=2
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/address-snapshot";
const ORIGIN = "https://audit-client.invalid";
const TOKEN = "test-read-token";
const NOTE = "Gate amber";
const AUDIT = "2026-01-15";
const AUDIT_NOPAD = "2026-1-15";
const AUDIT_PADDED_LEAD = " 2026-01-15";
const AUDIT_PADDED_TRAIL = "2026-01-15 ";
const CASE_UPPER = "2026-SEP-15";
const CASE_LOWER = "2026-sep-15";
const LITERAL = 'O\'Ridge 50%_ &+/#? "雪\\tail';
const INJECTION = "x' OR 1=1 --";
const HUNDRED = "🧭".repeat(100);
const ASCII_HUNDRED = "a".repeat(100);
const WS_ONLY = " \t ";
const ALL_IDS = [11, 23, 37, 42, 58, 69, 73, 79, 83, 89, 97, 101, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179];
const AUDIT_IDS = [11, 23, 37, 42, 58, 69];
const PRESENT_IDS = [11, 23, 37, 42, 58, 69, 73, 79, 83, 89, 97, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179];
const ABSENT_IDS = [101, 109];
type Query = Record<string, string | number>;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
type Options = { token?: string | null; headers?: Record<string, string>; forbidAll?: boolean; fail?: "count" | "page" };
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
const ids = (body: Body) => body.rows.map(row => row.pickup_address_id);

// id, customer, route, franchise, enabled, street, city, zip, note, comments, state, lat, long, audit
const FIXTURES: Array<[number, number, number, string, number, string | null, string | null, string | null, string | null, string | null, string, string | null, string | null, string | null]> = [
  [11, 101, 7, "001", 1, "741 Synthetic Way", null, "00741", NOTE, null, "ZZ", null, null, AUDIT],
  [23, 101, 7, "001", 1, "Plain Lane", "741 Borough", "00741", NOTE, null, "ZZ", null, null, AUDIT],
  [37, 101, 7, "001", 1, "Plain Lane", null, "00741-1234", NOTE, null, "ZZ", null, null, AUDIT],
  [42, 101, 8, "1", 1, "741 Synthetic Way", "741", "98000", NOTE, null, "ZZ", null, null, AUDIT],
  [58, 202, 7, "001", 1, "741 Other Lane", null, "00741", "unrelated", null, "ZZ", null, null, AUDIT],
  [69, 101, 7, "001", 0, "741 Disabled Lane", null, "00741", "unrelated", null, "ZZ", null, null, AUDIT],
  [73, 101, 7, "001", 1, AUDIT, null, null, NOTE, null, "ZZ", AUDIT, AUDIT, "unrelated"],
  [79, 101, 7, "001", 1, "Comment Lane", null, null, NOTE, AUDIT, "ZZ", null, null, "unrelated"],
  [83, 101, 7, "001", 1, "City Lane", AUDIT, null, "unrelated", null, "ZZ", null, null, "unrelated"],
  [89, 101, 7, "001", 1, "ZIP Lane", null, AUDIT, "unrelated", null, "ZZ", null, null, "unrelated"],
  [97, 101, 7, "001", 1, "State Lane", null, null, "unrelated", null, AUDIT, null, null, "unrelated"],
  [101, 101, 7, "001", 1, "Null Lane", null, null, "unrelated", null, "ZZ", null, null, null],
  [109, 101, 7, "001", 1, "Empty Lane", null, null, "unrelated", null, "ZZ", null, null, ""],
  [113, 101, 7, "001", 1, "Blank Lane", null, null, "unrelated", null, "ZZ", null, null, WS_ONLY],
  [127, 101, 7, "001", 1, "Literal One", null, null, "unrelated", null, "ZZ", null, null, LITERAL],
  [131, 101, 7, "001", 1, "Literal Two", null, null, "unrelated", null, "ZZ", null, null, LITERAL],
  [137, 101, 7, "001", 1, "Literal Three", null, null, "unrelated", null, "ZZ", null, null, LITERAL],
  [139, 101, 7, "001", 1, "Case Upper", null, null, "unrelated", null, "ZZ", null, null, CASE_UPPER],
  [149, 101, 7, "001", 1, "Case Lower", null, null, "unrelated", null, "ZZ", null, null, CASE_LOWER],
  [151, 101, 7, "001", 1, "Nopad Lane", null, null, "unrelated", null, "ZZ", null, null, AUDIT_NOPAD],
  [157, 101, 7, "001", 1, "Injection Lane", null, null, "unrelated", null, "ZZ", null, null, INJECTION],
  [163, 101, 7, "001", 1, "Padded Lead", null, null, "unrelated", null, "ZZ", null, null, AUDIT_PADDED_LEAD],
  [167, 101, 7, "001", 1, "Padded Trail", null, null, "unrelated", null, "ZZ", null, null, AUDIT_PADDED_TRAIL],
  [173, 101, 7, "001", 1, "Astral Lane", null, null, "unrelated", null, "ZZ", null, null, HUNDRED],
  [179, 101, 7, "001", 1, "ASCII Lane", null, null, "unrelated", null, "ZZ", null, null, ASCII_HUNDRED]
];

let denied: string[];
let outbound: ReturnType<typeof vi.fn>;
let logs: Array<ReturnType<typeof vi.spyOn>>;
function forbid(operation: string): never {
  denied.push(operation);
  throw new Error("Forbidden effect in audit acceptance");
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
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Audit-acceptance", ...options.headers });
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
  expect(response.headers.get("x-request-id")).toBe("Audit-acceptance");
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
  outbound = vi.fn(async () => { throw new Error("Forbidden outbound audit request"); });
  vi.stubGlobal("fetch", outbound);
  logs = (["log", "info", "warn", "error", "debug"] as const).map(level => vi.spyOn(console, level).mockImplementation(() => undefined));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot")
  ]);
  await db.batch([101, 202].map(id => db.prepare(
    "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'synthetic-audit', 1, 'fixed-time')"
  ).bind(id)));
  for (const row of [...FIXTURES].reverse()) await db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, enabled, address, city, zip, driver_note, comments, state, latitude, longitude, last_audit_date, synced_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixed-time')"
  ).bind(...row).run();
  for (const [id, owner, enabled] of [[501, 23, 0], [502, 37, 1], [503, 37, 0], [504, 69, 1]]) await db.prepare(
    "INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, synced_at) VALUES (?, ?, ?, 'fixed-time')"
  ).bind(id, owner, enabled).run();
});
afterEach(() => {
  try {
    expect(outbound).not.toHaveBeenCalled();
    expect(denied).toEqual([]);
    const text = JSON.stringify(logs.map(log => log.mock.calls));
    for (const marker of [NOTE, AUDIT, LITERAL, INJECTION, HUNDRED, ASCII_HUNDRED, CASE_UPPER, CASE_LOWER, AUDIT_NOPAD, "synthetic-private-db-marker", "private-audit-", "unknown-audit-marker"]) {
      expect(text).not.toContain(marker);
      expect(text).not.toContain(JSON.stringify(marker).slice(1, -1));
      expect(text).not.toContain(encodeURIComponent(marker));
      expect(text).not.toContain(new URLSearchParams({ lastAuditDate: marker }).toString());
    }
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe("lastAuditDate is only a stored exact opaque string", () => {
  it.each([
    { label: "exact ISO date hits, including disabled sites", lastAuditDate: AUDIT, want: AUDIT_IDS },
    { label: "case-sensitive upper", lastAuditDate: CASE_UPPER, want: [139] },
    { label: "case-sensitive lower", lastAuditDate: CASE_LOWER, want: [149] },
    { label: "leading-zero month/day significant", lastAuditDate: AUDIT_NOPAD, want: [151] },
    { label: "unpadded query does not match padded stored", lastAuditDate: "2026-1-15", want: [151] },
    { label: "padded stored leading space is distinct", lastAuditDate: AUDIT_PADDED_LEAD, want: [163] },
    { label: "padded stored trailing space is distinct", lastAuditDate: AUDIT_PADDED_TRAIL, want: [167] },
    { label: "100 astral code points", lastAuditDate: HUNDRED, want: [173] },
    { label: "100 ASCII code points", lastAuditDate: ASCII_HUNDRED, want: [179] },
    { label: "unrelated stored text only", lastAuditDate: "unrelated", want: [73, 79, 83, 89, 97] },
    { label: "unknown value is empty success", lastAuditDate: "1999-12-31", want: [] },
    { label: "NULL is not the string null", lastAuditDate: "null", want: [] },
    { label: "prefix does not match", lastAuditDate: "2026-01", want: [] },
    { label: "suffix does not match", lastAuditDate: "01-15", want: [] },
    { label: "no date parsing or range", lastAuditDate: "2026", want: [] },
    { label: "no instruction interpretation", lastAuditDate: "audit all sites", want: [] }
  ])("$label", async ({ lastAuditDate, want }) => {
    const result = await page({ lastAuditDate });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    for (const row of result.body.rows) expect(row.last_audit_date).toBe(lastAuditDate);
  });

  it.each([LITERAL, "%", "_", "'", "\\", "&+/#?", '"雪', INJECTION])("binds %j as literal text, never LIKE or SQL", async lastAuditDate => {
    const result = await page({ lastAuditDate });
    const expected = lastAuditDate === LITERAL ? [127, 131, 137] : lastAuditDate === INJECTION ? [157] : [];
    expect(ids(result.body)).toEqual(expected);
    expect(result.body.total).toBe(expected.length);
    expect(new Set(ids(result.body)).size).toBe(expected.length);
    for (const statement of result.statements) {
      expect(statement.binds).toContain(lastAuditDate);
      expect(statement.sql).not.toContain(LITERAL);
      expect(statement.sql).not.toContain(INJECTION);
      expect(statement.sql).not.toMatch(/\bLIKE\b/i);
      expect(statement.sql).toContain("last_audit_date = ?");
    }
  });

  it("matches only the audit column, never street/comments/city/zip/state/note/coordinates", async () => {
    const result = await page({ lastAuditDate: AUDIT });
    expect(ids(result.body)).toEqual(AUDIT_IDS);
    for (const confusion of [73, 79, 83, 89, 97]) expect(ids(result.body)).not.toContain(confusion);
    const unrelated = await page({ lastAuditDate: "unrelated" });
    expect(ids(unrelated.body)).toEqual([73, 79, 83, 89, 97]);
    for (const statement of unrelated.statements) {
      expect(statement.sql).toContain("last_audit_date = ?");
      // The page SELECT legitimately projects every address column, so the
      // column-isolation check scopes to the WHERE clause predicate only.
      const where = statement.sql.slice(statement.sql.search(/\bWHERE\b/i)).split(/\bORDER\s+BY\b|\bLIMIT\b/i)[0];
      expect(where).not.toMatch(/comments|driver_note|latitude|longitude/i);
    }
  });

  it("NULL/empty/whitespace-only stored text never matches a nonblank exact value", async () => {
    for (const lastAuditDate of [AUDIT, "unrelated", LITERAL, "1999-12-31"]) {
      const result = await page({ lastAuditDate });
      for (const absent of [101, 109, 113]) expect(ids(result.body)).not.toContain(absent);
    }
  });
});

describe("hasLastAuditDate presence is null-or-empty complement", () => {
  it("true selects every non-empty stored text including whitespace-only", async () => {
    const result = await page({ hasLastAuditDate: "true" });
    expect(ids(result.body)).toEqual(PRESENT_IDS);
    expect(result.body.total).toBe(PRESENT_IDS.length);
    expect(result.body.nextCursor).toBeNull();
    for (const row of result.body.rows) {
      expect(row.last_audit_date).not.toBeNull();
      expect(row.last_audit_date).not.toBe("");
    }
    expect(ids(result.body)).toContain(113);
    for (const statement of result.statements) {
      expect(statement.sql).toMatch(/last_audit_date\s+IS\s+NOT\s+NULL/i);
      expect(statement.sql).toMatch(/last_audit_date\s*<>\s*''/);
      expect(statement.binds).not.toContain("true");
    }
  });

  it("false selects exactly NULL plus empty, excluding whitespace-only", async () => {
    const result = await page({ hasLastAuditDate: "false" });
    expect(ids(result.body)).toEqual(ABSENT_IDS);
    expect(result.body.total).toBe(2);
    expect(result.body.nextCursor).toBeNull();
    expect(result.body.rows).toEqual([
      expect.objectContaining({ pickup_address_id: 101, last_audit_date: null }),
      expect.objectContaining({ pickup_address_id: 109, last_audit_date: "" })
    ]);
    for (const statement of result.statements) {
      expect(statement.sql).toMatch(/last_audit_date\s+IS\s+NULL/i);
      expect(statement.sql).toMatch(/last_audit_date\s*=\s*''/);
    }
  });

  it.each(["any", "omitted"])("%s adds no predicate, with identical bytes, SQL and Link", async mode => {
    const plain = await page({ limit: 2 });
    const any = mode === "any" ? await page({ hasLastAuditDate: "any", limit: 2 }) : plain;
    const target = mode === "any" ? any : plain;
    expect(ids(target.body)).toEqual([11, 23]);
    if (mode === "any") {
      expect(any.bytes).toBe(plain.bytes);
      expect(any.statements).toEqual(plain.statements);
      expect(any.response.headers.get("etag")).toBe(plain.response.headers.get("etag"));
      expect(any.response.headers.get("link")).toBe(plain.response.headers.get("link"));
      next(any, { limit: 2, cursor: 23 });
    }
    expect(ids((await page(mode === "any" ? { hasLastAuditDate: "any" } : {})).body)).toEqual(ALL_IDS);
  });
});

describe("exact-plus-presence intersection and contradiction", () => {
  it.each([
    { lastAuditDate: AUDIT, hasLastAuditDate: "true", want: AUDIT_IDS },
    { lastAuditDate: AUDIT, hasLastAuditDate: "any", want: AUDIT_IDS },
    { lastAuditDate: LITERAL, hasLastAuditDate: "true", want: [127, 131, 137] },
    { lastAuditDate: CASE_UPPER, hasLastAuditDate: "true", want: [139] },
    { lastAuditDate: INJECTION, hasLastAuditDate: "true", want: [157] },
    { lastAuditDate: "unrelated", hasLastAuditDate: "true", want: [73, 79, 83, 89, 97] }
  ])("exact $lastAuditDate plus $hasLastAuditDate intersects", async ({ lastAuditDate, hasLastAuditDate, want }) => {
    const result = await page({ lastAuditDate, hasLastAuditDate });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
  });

  it.each([
    { lastAuditDate: AUDIT, hasLastAuditDate: "false" },
    { lastAuditDate: LITERAL, hasLastAuditDate: "false" },
    { lastAuditDate: "1999-12-31", hasLastAuditDate: "true" },
    { lastAuditDate: "1999-12-31", hasLastAuditDate: "false" },
    { lastAuditDate: "1999-12-31", hasLastAuditDate: "any" }
  ])("contradiction $lastAuditDate plus $hasLastAuditDate is empty", async ({ lastAuditDate, hasLastAuditDate }) => {
    const result = await page({ lastAuditDate, hasLastAuditDate });
    expect(result.body).toEqual({ rows: [], total: 0, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
  });
});

describe.each(["true", "false"])("lastAuditDate AND intersections includeTotal=%s", includeTotal => {
  it.each<{ query: Query; want: number[] }>([
    { query: { customerId: 101, enabled: "true" }, want: [11, 23, 37, 42] },
    { query: { customerId: 202 }, want: [58] },
    { query: { pickupAddressId: 23 }, want: [23] },
    { query: { ids: "23,79" }, want: [23] },
    { query: { ids: "37,11" }, want: [11, 37] },
    { query: { pickupAddressId: 79 }, want: [] },
    { query: { customerId: 202, pickupAddressId: 23 }, want: [] },
    { query: { enabled: "false" }, want: [69] },
    { query: { routeId: 7, franchiseId: "001" }, want: [11, 23, 37, 58, 69] },
    { query: { routeId: 8, franchiseId: "001" }, want: [] },
    { query: { routeId: 7, franchiseId: "1" }, want: [] },
    { query: { routeId: 8, franchiseId: "1" }, want: [42] },
    { query: { zip: "00741" }, want: [11, 23, 58, 69] },
    { query: { zip: "00741-1234" }, want: [37] },
    { query: { city: "741 Borough" }, want: [23] },
    { query: { state: "ZZ" }, want: [11, 23, 37, 42, 58, 69] },
    { query: { driverNote: NOTE }, want: [11, 23, 37, 42] },
    { query: { driverNote: "unrelated" }, want: [58, 69] },
    { query: { hasContainers: "true" }, want: [23, 37, 69] },
    { query: { hasContainers: "false" }, want: [11, 42, 58] },
    { query: { hasContainers: "any" }, want: [11, 23, 37, 42, 58, 69] },
    { query: { hasLastAuditDate: "true" }, want: [11, 23, 37, 42, 58, 69] },
    { query: { hasLastAuditDate: "false" }, want: [] },
    { query: { hasLastAuditDate: "any" }, want: [11, 23, 37, 42, 58, 69] },
    { query: { upperId: 37 }, want: [11, 23, 37] },
    { query: { upperId: 37, cursor: 23 }, want: [37] },
    { query: { upperId: 37, cursor: 37, order: "desc" }, want: [23, 11] },
    { query: { upperId: 37, cursor: 42 }, want: [] },
    { query: { q: "Borough" }, want: [23] },
    { query: { q: "00741-1234" }, want: [37] },
    { query: { q: "Other" }, want: [58] },
    { query: { q: "missing-locality" }, want: [] },
    { query: { customerId: 101, routeId: 7, franchiseId: "001", zip: "00741", enabled: "true", hasContainers: "true", upperId: 37, q: "741" }, want: [23] }
  ])("$query", async ({ query, want }) => {
    const result = await page({ ...query, lastAuditDate: AUDIT, includeTotal, fields: "enabled" });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
    expect(result.body.nextCursor).toBeNull();
    for (const row of result.body.rows) expect(Object.keys(row).sort()).toEqual(["enabled", "pickup_address_id"]);
    for (const statement of result.statements) {
      expect(statement.binds).toContain(AUDIT);
      expect(statement.sql).toContain("last_audit_date = ?");
    }
    if (includeTotal === "true") {
      const count = result.statements.find(isCount)!;
      const select = result.statements.find(s => !isCount(s))!;
      const predicate = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).split(/\bORDER\s+BY\b|\bLIMIT\b/i)[0].trim().replace(/\s+/g, " ");
      expect(predicate(count.sql)).toBe(predicate(select.sql));
      expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
    }
  });
});

describe.each(["true", "false"])("hasLastAuditDate AND intersections includeTotal=%s", includeTotal => {
  it.each<{ query: Query; want: number[] }>([
    { query: { hasLastAuditDate: "true", pickupAddressId: 101 }, want: [] },
    { query: { hasLastAuditDate: "true", pickupAddressId: 109 }, want: [] },
    { query: { hasLastAuditDate: "false", pickupAddressId: 23 }, want: [] },
    { query: { hasLastAuditDate: "true", ids: "101,23" }, want: [23] },
    { query: { hasLastAuditDate: "false", ids: "101,23" }, want: [101] },
    { query: { hasLastAuditDate: "true", ids: "101,109" }, want: [] },
    { query: { hasLastAuditDate: "false", ids: "42,101" }, want: [101] },
    { query: { hasLastAuditDate: "false", customerId: 202 }, want: [] },
    { query: { hasLastAuditDate: "false", enabled: "false" }, want: [] },
    { query: { hasLastAuditDate: "false", customerId: 101, enabled: "true" }, want: [101, 109] },
    { query: { hasLastAuditDate: "true", q: "Null" }, want: [] },
    { query: { hasLastAuditDate: "true", q: "Empty" }, want: [] },
    { query: { hasLastAuditDate: "false", q: "Borough" }, want: [] },
    { query: { hasLastAuditDate: "false", q: "Blank" }, want: [] },
    { query: { hasLastAuditDate: "false", hasContainers: "true" }, want: [] },
    { query: { hasLastAuditDate: "false", hasContainers: "false" }, want: [101, 109] },
    { query: { hasLastAuditDate: "false", driverNote: NOTE }, want: [] },
    { query: { hasLastAuditDate: "false", driverNote: "unrelated" }, want: [101, 109] }
  ])("$query", async ({ query, want }) => {
    const result = await page({ ...query, includeTotal, fields: "last_audit_date" });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
    expect(result.body.nextCursor).toBeNull();
    for (const statement of result.statements) expect(statement.sql).not.toMatch(/\bJOIN\b/i);
    if (includeTotal === "true" && want.length > 0) {
      const count = result.statements.find(isCount)!;
      const select = result.statements.find(s => !isCount(s))!;
      const predicate = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).split(/\bORDER\s+BY\b|\bLIMIT\b/i)[0].trim().replace(/\s+/g, " ");
      expect(predicate(count.sql)).toBe(predicate(select.sql));
    }
  });
});

describe.each(["true", "false"])("audit continuation includeTotal=%s", includeTotal => {
  it.each([
    { order: "asc", pages: [[11, 23], [37, 42], []] },
    { order: "desc", pages: [[42, 37], [23, 11], []] }
  ])("follows every full exact page in $order order through terminal empty, no duplicates", async ({ order, pages }) => {
    const filters = { lastAuditDate: AUDIT, customerId: 101, enabled: "true", upperId: 58, q: "741", order, fields: "enabled", limit: 2, includeTotal };
    const current0 = await page(filters);
    const seen: unknown[] = [];
    let current = current0;
    for (let index = 0; index < pages.length; index++) {
      expect(ids(current.body)).toEqual(pages[index]);
      expect(current.body.total).toBe(includeTotal === "false" ? null : [4, 2, 0][index]);
      seen.push(...ids(current.body));
      if (index === 2) {
        expect(current.body.nextCursor).toBeNull();
        expect(current.response.headers.get("link")).toBeNull();
      } else {
        const cursor = pages[index][1];
        expect(current.body.nextCursor).toBe(cursor);
        current = await page(next(current, { ...filters, cursor }));
      }
    }
    expect(seen).toEqual(order === "asc" ? [11, 23, 37, 42] : [42, 37, 23, 11]);
    expect(new Set(seen).size).toBe(4);
  });

  it.each([
    { order: "asc", first: [23, 37], cursor: 37, last: [42] },
    { order: "desc", first: [37, 23], cursor: 23, last: [11] }
  ])("offset-to-seek $order retains audit, scopes, upperId and punctuation", async ({ order, first, cursor, last }) => {
    const filters = { lastAuditDate: AUDIT, customerId: 101, enabled: "true", upperId: 42, q: "741", fields: "city,zip", order, limit: 2, includeTotal };
    const result = await page({ ...filters, offset: 1 });
    expect(ids(result.body)).toEqual(first);
    expect(result.body.total).toBe(includeTotal === "false" ? null : 4);
    expect(result.body.nextCursor).toBe(cursor);
    const terminal = await page(next(result, { ...filters, cursor }));
    expect(ids(terminal.body)).toEqual(last);
    expect(terminal.body.total).toBe(includeTotal === "false" ? null : 1);
    expect(terminal.body.nextCursor).toBeNull();
    expect(terminal.response.headers.get("link")).toBeNull();
  });

  it("cursor takes precedence over offset; partial, gap and empty pages remain correct", async () => {
    for (const [query, want, total, cursor] of [
      [{ cursor: 23, offset: 999 }, [37, 42], 2, 42],
      [{ cursor: 30 }, [37, 42], 2, 42],
      [{ cursor: 37 }, [42], 1, null],
      [{ cursor: 42 }, [], 0, null],
      [{ offset: 4 }, [], 4, null]
    ] as Array<[Query, number[], number, number | null]>) {
      const result = await page({ ...query, lastAuditDate: AUDIT, customerId: 101, enabled: "true", limit: 2, includeTotal });
      expect(ids(result.body)).toEqual(want);
      expect(result.body.total).toBe(includeTotal === "false" ? null : total);
      expect(result.body.nextCursor).toBe(cursor);
      if (query.cursor !== undefined) for (const s of result.statements) expect(s.sql).not.toMatch(/\bOFFSET\b/i);
      if (cursor === null) expect(result.response.headers.get("link")).toBeNull();
    }
  });

  it.each(["asc", "desc"])("URL-encodes literal audit once in followable %s links", async order => {
    const filters = { lastAuditDate: LITERAL, routeId: 7, franchiseId: "001", fields: "last_audit_date", upperId: 137, order, limit: 2, includeTotal };
    const first = await page(filters);
    expect(ids(first.body)).toEqual(order === "asc" ? [127, 131] : [137, 131]);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 3);
    const target = next(first, { ...filters, cursor: 131 });
    expect(first.response.headers.get("link")).not.toContain(LITERAL);
    const last = await page(target);
    expect(last.body.rows).toEqual([{ pickup_address_id: order === "asc" ? 137 : 127, last_audit_date: LITERAL }]);
    expect(last.body.total).toBe(includeTotal === "false" ? null : 1);
    expect(last.body.nextCursor).toBeNull();
  });

  it("retains single-ID and child-presence scope in a full terminal page link", async () => {
    const filters = { lastAuditDate: AUDIT, pickupAddressId: 23, customerId: 101, routeId: 7, franchiseId: "001", zip: "00741", enabled: "true", hasContainers: "true", upperId: 37, fields: "enabled", order: "desc", limit: 1, includeTotal };
    const first = await page(filters);
    expect(ids(first.body)).toEqual([23]);
    const last = await page(next(first, { ...filters, cursor: 23 }));
    expect(last.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(last.response.headers.get("link")).toBeNull();
  });

  it("walks absent presence through a final empty page without duplicates", async () => {
    const filters = { hasLastAuditDate: "false", limit: 1, includeTotal };
    let current = await page(filters);
    const seen: unknown[] = [];
    for (const [want, total] of [[[101], 2], [[109], 1], [[], 0]] as Array<[number[], number]>) {
      expect(ids(current.body)).toEqual(want);
      expect(current.body.total).toBe(includeTotal === "false" ? null : total);
      seen.push(...ids(current.body));
      if (want.length === 0) {
        expect(current.body.nextCursor).toBeNull();
        expect(current.response.headers.get("link")).toBeNull();
      } else {
        expect(current.body.nextCursor).toBe(want[0]);
        current = await page(next(current, { ...filters, cursor: want[0] }));
      }
    }
    expect(seen).toEqual([101, 109]);
  });
});

describe("audit countOnly and count-free modes", () => {
  it.each<{ query: Query; total: number }>([
    { query: { lastAuditDate: AUDIT }, total: 6 },
    { query: { lastAuditDate: "1999-12-31" }, total: 0 },
    { query: { lastAuditDate: AUDIT, hasLastAuditDate: "false" }, total: 0 },
    { query: { lastAuditDate: AUDIT, customerId: 101, enabled: "true" }, total: 4 },
    { query: { hasLastAuditDate: "true" }, total: 23 },
    { query: { hasLastAuditDate: "false" }, total: 2 },
    { query: { hasLastAuditDate: "any" }, total: 25 },
    { query: { hasLastAuditDate: "false", customerId: 101 }, total: 2 }
  ])("countOnly returns COUNT-only $query", async ({ query, total }) => {
    const result = await page({ ...query, countOnly: "true" });
    expect(result.body).toEqual({ rows: [], total, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.statements).toHaveLength(1);
    expect(result.statements.filter(isCount)).toHaveLength(1);
    for (const statement of result.statements) {
      if (query.lastAuditDate !== undefined && total > 0) expect(statement.binds).toContain(query.lastAuditDate);
      if (query.lastAuditDate !== undefined) expect(statement.sql).toContain("last_audit_date");
    }
  });

  it("countOnly ignores limit/offset for the total but still validates them", async () => {
    const result = await page({ lastAuditDate: AUDIT, countOnly: "true", limit: 1, offset: 5 });
    expect(result.body).toEqual({ rows: [], total: 6, nextCursor: null });
    const bad = await request({ lastAuditDate: AUDIT, countOnly: "true", limit: 501 }, { forbidAll: true });
    expect(bad.response.status).toBe(400);
    expect(bad.prepared).toEqual([]);
  });

  it("countOnly plus includeTotal=false is a value-free 400 before D1", async () => {
    const result = await request({ lastAuditDate: AUDIT, countOnly: "true", includeTotal: "false" }, { forbidAll: true });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(await result.response.text()).toMatch(/countOnly/);
    expect(result.prepared).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
  });

  it("count-free returns identical page SQL, rows and cursor without COUNT or lookahead", async () => {
    const filters = { lastAuditDate: AUDIT, customerId: 101, enabled: "true", fields: "enabled", limit: 2 };
    const counted = await page(filters);
    const free = await page({ ...filters, includeTotal: "false" });
    expect(ids(free.body)).toEqual([11, 23]);
    expect(counted.body.total).toBe(4);
    expect(free.body).toEqual({ rows: counted.body.rows, total: null, nextCursor: 23 });
    expect(free.statements).toEqual(counted.statements.filter(s => !isCount(s)));
    const absentCounted = await page({ hasLastAuditDate: "false" });
    const absentFree = await page({ hasLastAuditDate: "false", includeTotal: "false" });
    expect(absentFree.body).toEqual({ rows: absentCounted.body.rows, total: null, nextCursor: null });
  });
});

describe("audit representation and read authority", () => {
  it.each(["true", "false"])("hashes final sparse envelope and revalidates 304 with reads, includeTotal=%s", async includeTotal => {
    const query = { lastAuditDate: AUDIT, customerId: 101, enabled: "true", fields: "city,zip", limit: 2, includeTotal };
    const first = await page(query);
    expect(first.body.rows).toEqual([
      { pickup_address_id: 11, city: null, zip: "00741" },
      { pickup_address_id: 23, city: "741 Borough", zip: "00741" }
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

  it("recomputes membership after an unprojected stored audit changes with unchanged synced_at", async () => {
    const query = { lastAuditDate: AUDIT, customerId: 101, enabled: "true", fields: "address" };
    const first = await page(query);
    expect(ids(first.body)).toEqual([11, 23, 37, 42]);
    await TEST_ENV.CUSTOMER_DB.prepare("UPDATE address_snapshot SET last_audit_date = 'unrelated' WHERE pickup_address_id = 23").run();
    const changed = await page(query, { "if-none-match": first.response.headers.get("etag")! });
    expect(ids(changed.body)).toEqual([11, 37, 42]);
    expect(changed.body.total).toBe(3);
    expect(changed.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
  });

  it("is idempotent, preserves full stored rows and ignores untrusted raw GET params in links", async () => {
    const before = await TEST_ENV.CUSTOMER_DB.prepare("SELECT * FROM address_snapshot ORDER BY pickup_address_id").all();
    const first = await page({ lastAuditDate: AUDIT, limit: 2 });
    expect(first.body.rows[0]).toMatchObject({ pickup_address_id: 11, customer_id: 101, last_audit_date: AUDIT, comments: null, synced_at: "fixed-time" });
    const url = new URL(PATH, "https://untrusted-origin.invalid");
    url.search = new URLSearchParams({ lastAuditDate: AUDIT, limit: "2", "unknown-audit-marker": "unknown-audit-marker", token: "query-token-marker", url: "https://redirect-marker.invalid" }).toString();
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
    const result = await request({ lastAuditDate: AUDIT, pickupAddressId: 11 }, { token });
    expect(result.response.status).toBe(200);
    posture(result.response);
    expect(ids(await result.response.json() as Body)).toEqual([11]);
    const absent = await request({ hasLastAuditDate: "false" }, { token });
    expect(absent.response.status).toBe(200);
    expect(ids(await absent.response.json() as Body)).toEqual([101, 109]);
  });
});

describe("audit validation and value-free failures", () => {
  const invalidAudit = [
    "lastAuditDate=",
    "lastAuditDate=%20%20",
    "lastAuditDate=%09%0A",
    `lastAuditDate=${encodeURIComponent(" 　")}`,
    new URLSearchParams({ lastAuditDate: `${HUNDRED}🧭` }).toString(),
    new URLSearchParams({ lastAuditDate: `${ASCII_HUNDRED}a` }).toString(),
    new URLSearchParams({ lastAuditDate: `private-audit-padding${" ".repeat(101)}` }).toString(),
    "lastAuditDate=private-audit-first&lastAuditDate=private-audit-second",
    "lastAuditDate=private-audit-first&lastAudit%44ate=private-audit-second",
    "lastAuditDate=&lastAuditDate=private-audit-second",
    "lastAuditDate=&lastAuditDate="
  ];
  const invalidPresence = [
    "hasLastAuditDate=",
    "hasLastAuditDate=%20",
    "hasLastAuditDate=yes",
    "hasLastAuditDate=1",
    "hasLastAuditDate=0",
    "hasLastAuditDate=TRUE",
    "hasLastAuditDate=True",
    "hasLastAuditDate=%20true",
    "hasLastAuditDate=true%20",
    "hasLastAuditDate=ANY",
    "hasLastAuditDate=any%20",
    "hasLastAuditDate=null",
    "hasLastAuditDate=true%2Cfalse",
    "hasLastAuditDate=secret-audit-marker",
    "hasLastAuditDate=true&hasLastAuditDate=false",
    "hasLastAuditDate=true&hasLastAuditDate=true",
    "hasLastAuditDate=&hasLastAuditDate=true",
    "hasLastAuditDate=any&hasLastAuditDate=any",
    "hasLastAuditDate=true&hasLastAudit%44ate=false"
  ];
  it.each(invalidAudit)("rejects invalid lastAuditDate before D1 without echoing submitted data: %s", async query => {
    const result = await request(`${query}&private-audit-unknown=unknown-audit-marker`, { forbidAll: true, headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    posture(result.response);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const bytes = await result.response.text();
    const body = JSON.parse(bytes) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["detail", "status", "title", "type"]);
    expect(body).toMatchObject({ type: expect.stringMatching(/#bad-request$/), title: "Bad Request", status: 400 });
    const action = String(body.detail);
    expect(action).toContain("lastAuditDate");
    expect(action).toContain("docs/PROBLEMS.md#bad-request");
    expect(action).toMatch(/retry/i);
    for (const marker of ["private-audit-", "unknown-audit-marker", "🧭", ASCII_HUNDRED]) expect(bytes).not.toContain(marker);
    expect(result.prepared).toEqual([]);
    expect(result.statements).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
  });

  it.each(invalidPresence)("rejects invalid hasLastAuditDate before D1 without echoing submitted data: %s", async query => {
    const result = await request(query, { forbidAll: true, headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    posture(result.response);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const bytes = await result.response.text();
    const body = JSON.parse(bytes) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["detail", "status", "title", "type"]);
    expect(body).toMatchObject({ type: expect.stringMatching(/#bad-request$/), title: "Bad Request", status: 400 });
    const action = String(body.detail);
    expect(action).toContain("hasLastAuditDate");
    expect(action).toContain("docs/PROBLEMS.md#bad-request");
    for (const marker of ["private-audit-", "secret-audit-marker"]) expect(bytes).not.toContain(marker);
    expect(result.prepared).toEqual([]);
    expect(result.statements).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
  });

  it("uses the same fixed correction for repeated and overlength values", async () => {
    const oversized = await request(invalidAudit[4], { forbidAll: true });
    const repeated = await request(invalidAudit[7], { forbidAll: true });
    expect(oversized.response.status).toBe(400);
    expect(repeated.response.status).toBe(400);
    expect(await repeated.response.json()).toEqual(await oversized.response.json());
    expect(oversized.prepared).toEqual([]);
    expect(repeated.prepared).toEqual([]);
  });

  it.each([null, "incorrect-synthetic-token"])("auth precedes repeated/oversize validation and conditional handling: %s", async token => {
    for (const query of [invalidAudit[4], invalidAudit[7], invalidPresence[13], "lastAuditDate=private-audit-valid", "hasLastAuditDate=true"]) {
      const result = await request(query, { token, forbidAll: true, headers: { "if-none-match": "*" } });
      expect(result.response.status).toBe(401);
      expect(await result.response.text()).not.toContain("private-audit-");
      expect(result.prepared).toEqual([]);
      expect(result.response.headers.get("link")).toBeNull();
      expect(result.response.headers.get("etag")).toBeNull();
    }
  });

  it.each(["count", "page"] as const)("D1 %s failures do not log or reflect audit values or private exceptions", async fail => {
    const result = await request({ lastAuditDate: LITERAL }, { fail });
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

describe("audit mounted discovery", () => {
  it("publishes optional bounded audit selectors on the existing local-read operation only", async () => {
    const result = await request(new URL("/openapi.json", "http://test.local"), { forbidAll: true });
    expect(result.response.status).toBe(200);
    type Operation = { operationId?: string; parameters?: Array<{ name: string; in: string; required?: boolean; description?: string; example?: unknown; schema?: Record<string, unknown> }>; responses?: Record<string, { description?: string }>; description?: string; [key: string]: unknown };
    const document = await result.response.json() as { paths: Record<string, { get?: Operation }> };
    const operation = document.paths[PATH]?.get;
    expect(operation).toMatchObject({ operationId: "listAddressSnapshot", "x-access": "read", "x-effect": "local-read" });
    const exact = operation?.parameters?.filter(p => p.name === "lastAuditDate");
    expect(exact).toHaveLength(1);
    expect(exact![0]).toMatchObject({ in: "query", required: false });
    expect(exact![0].schema).toMatchObject({ type: "string", maxLength: 100 });
    expect(exact![0].schema?.default).toBeUndefined();
    const presence = operation?.parameters?.filter(p => p.name === "hasLastAuditDate");
    expect(presence).toHaveLength(1);
    expect(presence![0]).toMatchObject({ in: "query", required: false, schema: { type: "string", enum: ["true", "false", "any"], default: "any" } });
    const guidance = `${exact![0].description ?? ""} ${exact![0].schema?.description ?? ""} ${presence![0].description ?? ""} ${operation?.description ?? ""}`;
    expect(guidance).toMatch(/last_audit_date/);
    expect(guidance).toMatch(/exact/i);
    expect(guidance).toMatch(/case-sensitive/i);
    expect(guidance).toMatch(/code.point/i);
    expect(guidance).toMatch(/\bAND\b|intersect/i);
    expect(guidance).toMatch(/mirror|stored/i);
    expect(operation?.responses?.["400"]?.description).toMatch(/lastAuditDate/);
    expect(operation?.responses?.["400"]?.description).toMatch(/hasLastAuditDate/);
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/container-snapshot", "/api/v1/customer-snapshot/changes", "/api/v1/address-snapshot/{pickupAddressId}"]) {
      const names = document.paths[path]?.get?.parameters?.map(p => p.name) ?? [];
      expect(names).not.toContain("lastAuditDate");
      expect(names).not.toContain("hasLastAuditDate");
    }
    expect(result.prepared).toEqual([]);
  });
});
