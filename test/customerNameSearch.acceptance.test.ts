import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independently owned tests-first oracle. Run:
 * npx vitest run test/customerNameSearch.acceptance.test.ts
 *
 * Catches company-only search, ungrouped OR, LIKE/interpolated queries, name
 * concatenation, Unicode-folding claims, lost filters/cursors, COUNT/lookahead,
 * stale representation validators and validation/auth leaks. Literal fixture
 * expectations do not call production search/pagination helpers. All HTTP work
 * uses app.fetch and real local D1; request-time writes/network are denied even
 * if caught by the handler. Intentionally RED until the paired runtime build.
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/customer-snapshot";
const ORIGIN = "https://customer-search.invalid";
const READ_TOKEN = "test-read-token";
const FIELDS = "company_name,first_name,last_name,enabled";
const LONG_QUERY = "😀".repeat(100);
const LITERAL = 'synthetic \'%_ &+/雪? #"';
type Fixture = [number, string | null, string | null, string | null, number];
const FIXTURES: Fixture[] = [
  [11, "Needle company", null, null, 1],
  [23, null, "pre-NEEDLE-post", null, 1],
  [37, "unrelated", null, "Needle", 0],
  [42, "Needle", "Needle", "Needle", 1],
  [58, "", "", "needle", 1],
  [91, null, "needle", "", 0],
  [102, null, null, null, 1],
  [103, "", "", "", 1],
  [104, null, "Ada", "Lovelace", 1],
  [105, "Ada Lovelace", null, null, 1],
  [111, LITERAL, null, null, 1],
  [112, null, LITERAL, null, 1],
  [113, null, null, LITERAL, 1],
  [121, "x%y", null, null, 1],
  [122, null, "x%y", null, 1],
  [123, null, null, "x%y", 1],
  [131, "x_y", null, null, 1],
  [132, null, "x_y", null, 1],
  [133, null, null, "x_y", 1],
  [141, null, "ÄTHER", null, 1],
  [142, null, null, "äther", 1],
  [151, null, LONG_QUERY, null, 1],
  [161, null, "MiXeD ASCII", null, 1],
  [171, "xay", null, null, 1]
];
const ALL_IDS = [11, 23, 37, 42, 58, 91, 102, 103, 104, 105, 111, 112, 113, 121, 122, 123, 131, 132, 133, 141, 142, 151, 161, 171];
const MATCH_IDS = [11, 23, 37, 42, 58, 91];

type Query = Record<string, string | number>;
type Statement = { sql: string; binds: unknown[]; method: string };
type Envelope = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
let violations: string[];
let requestNumber = 0;

function recordedDb() {
  const statements: Statement[] = [];
  const prepared: string[] = [];
  const deny = (operation: string): never => {
    violations.push(operation);
    throw new Error("Unexpected database effect in customer-name acceptance");
  };
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[] = []): D1PreparedStatement {
    return new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql, values);
        if (prop === "run") return () => deny("run");
        if (prop === "first" || prop === "all" || prop === "raw") {
          return (...args: unknown[]) => {
            statements.push({ sql, binds, method: String(prop) });
            return Reflect.apply(Reflect.get(target, prop, target), target, args);
          };
        }
        return Reflect.get(target, prop, target);
      }
    });
  }
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      if (!/^\s*SELECT\b/i.test(sql) || /;\s*\S/.test(sql)) return deny(sql);
      return wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql);
    },
    batch: () => deny("batch"),
    exec: () => deny("exec"),
    dump: () => deny("dump")
  } as unknown as D1Database;
  return { db, statements, prepared };
}

async function request(query: Query | URL | string = {}, options: {
  token?: string | null; headers?: Record<string, string>
} = {}) {
  const url = query instanceof URL ? query : new URL(PATH, "http://test.local");
  if (!(query instanceof URL)) url.search = typeof query === "string" ? query : new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)])
  ).toString();
  const requestId = `Customer-Name-${++requestNumber}`;
  const headers = new Headers({ origin: ORIGIN, "x-request-id": requestId, ...options.headers });
  const token = options.token === undefined ? READ_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const recording = recordedDb();
  const forbiddenBinding = new Proxy({}, {
    get(_target, key): never {
      violations.push(`binding:${String(key)}`);
      throw new Error("Unexpected browser or object-storage access in customer-name acceptance");
    }
  });
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: recording.db,
    BROWSER: forbiddenBinding as Fetcher, SNAPSHOTS: forbiddenBinding as R2Bucket
  });
  return { response, url, requestId, ...recording };
}

function posture(response: Response, requestId: string) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("vary")).toMatch(/\borigin\b/i);
  expect(response.headers.get("x-request-id")).toBe(requestId);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("etag");
  expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("x-request-id");
}

function budget(statements: Statement[], countFree: boolean) {
  expect(statements).toHaveLength(countFree ? 1 : 2);
  expect(statements.filter(isCount)).toHaveLength(countFree ? 0 : 1);
  for (const s of statements) {
    expect(s.sql).toMatch(/^\s*SELECT\b/i);
    expect(s.sql).not.toMatch(/\bJOIN\b/i);
    expect(["first", "all", "raw"]).toContain(s.method);
  }
}

async function page(query: Query | URL = {}) {
  const result = await request(query);
  expect(result.response.status).toBe(200);
  posture(result.response, result.requestId);
  const bytes = await result.response.text();
  const body = JSON.parse(bytes) as Envelope;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  budget(result.statements, result.url.searchParams.get("includeTotal") === "false");
  return { ...result, bytes, body };
}

const ids = (body: Envelope) => body.rows.map((r) => r.customer_id);
function expectRows(body: Envelope, expected: number[], total: number | null, next: number | null = null) {
  expect(ids(body)).toEqual(expected);
  expect(new Set(ids(body)).size).toBe(expected.length);
  expect(body.total).toBe(total);
  expect(body.nextCursor).toBe(next);
}
async function hash(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
}
function nextUrl(result: Awaited<ReturnType<typeof page>>) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/customer-snapshot\?[^<>\s]*>; rel="next"$/);
  const next = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(next.origin).toBe(result.url.origin);
  expect(next.pathname).toBe(PATH);
  expect(next.hash).toBe("");
  expect(next.searchParams.has("offset")).toBe(false);
  expect(next.searchParams.get("cursor")).toBe(String(result.body.nextCursor));
  return next;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  violations = [];
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound fetch in customer-name acceptance"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  // Insert backwards so passing cannot depend on insertion order.
  await db.batch([...FIXTURES].reverse().map(([id, company, first, last, enabled]) => db.prepare(
    "INSERT INTO customer_snapshot (customer_id, company_name, first_name, last_name, enabled, synced_at) VALUES (?, ?, ?, ?, ?, 'synthetic-fixed-time')"
  ).bind(id, company, first, last, enabled)));
});
afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(violations).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe("customer q: literal substring in any single name column", () => {
  it.each([
    { label: "company or first or last; a three-leg hit still appears once", q: "needle", want: MATCH_IDS },
    { label: "trim and ASCII case", q: " \tNeEdLe\n ", want: MATCH_IDS },
    { label: "first-name-only substring", q: "pre-needle", want: [23] },
    { label: "last-name-only match with empty company", q: "needle", customerId: 58, want: [58] },
    { label: "first-name-only ASCII folding", q: "mixed ascii", want: [161] },
    { label: "no synthesized full name", q: "Ada Lovelace", want: [105] },
    { label: "no token parser", q: "Lovelace Ada", want: [] },
    { label: "first name remains independently searchable", q: "Ada", want: [104, 105] },
    { label: "last name remains independently searchable", q: "Lovelace", want: [104, 105] },
    { label: "SQLite does not Unicode-fold uppercase Ä", q: "äther", want: [142] },
    { label: "SQLite ASCII folding still applies after uppercase Ä", q: "Äther", want: [141] },
    { label: "literal percent, not LIKE wildcard", q: "x%y", want: [121, 122, 123] },
    { label: "literal underscore, not LIKE wildcard", q: "x_y", want: [131, 132, 133] },
    { label: "quotes and URL characters remain literal in all columns", q: LITERAL, want: [111, 112, 113] },
    { label: "SQL-shaped text is just text", q: "' OR 1=1 --", want: [] },
    { label: "100 astral code points, not 100 UTF-16 units", q: LONG_QUERY, want: [151] },
    { label: "100 ASCII code points accepted without truncation", q: "x".repeat(100), want: [] },
    { label: "null and empty columns never qualify for a missing substring", q: "no-synthetic-match", want: [] }
  ])("$label", async ({ q, want, ...scenario }) => {
    const query: Query = { q, fields: FIELDS };
    if ("customerId" in scenario) query.customerId = scenario.customerId!;
    const result = await page(query);
    expectRows(result.body, want, want.length);
    for (const statement of result.statements) expect(statement.sql).not.toContain(q.trim());
  });

  it.each(["", " \t\n "])("empty q=%j preserves omitted-query bytes and SQL, including null/empty names", async (q) => {
    const omitted = await page({ fields: FIELDS });
    const empty = await page({ fields: FIELDS, q });
    expectRows(omitted.body, ALL_IDS, 24);
    expect(empty.bytes).toBe(omitted.bytes);
    expect(empty.statements).toEqual(omitted.statements);
    expect(empty.response.headers.get("etag")).toBe(omitted.response.headers.get("etag"));
  });
});

const INTERSECTIONS: Array<{ label: string; query: Query; want: number[]; total: number; next?: number }> = [
  { label: "enabled encloses all OR legs", query: { enabled: "true" }, want: [11, 23, 42, 58], total: 4 },
  { label: "disabled encloses all OR legs", query: { enabled: "false" }, want: [37, 91], total: 2 },
  { label: "identity encloses every OR leg", query: { customerId: 11 }, want: [11], total: 1 },
  { label: "identity plus last-name-only row", query: { customerId: 37, enabled: "false" }, want: [37], total: 1 },
  { label: "conflicting identity and enabled", query: { customerId: 37, enabled: "true" }, want: [], total: 0 },
  { label: "nonmatching identity must not leak first/last hits", query: { customerId: 102 }, want: [], total: 0 },
  { label: "offset on the filtered set", query: { offset: 1, limit: 2 }, want: [23, 37], total: 6, next: 37 },
  { label: "ascending seek intersects all OR legs", query: { cursor: 37, limit: 2, offset: 999 }, want: [42, 58], total: 3, next: 58 },
  { label: "ascending enabled seek", query: { cursor: 23, enabled: "true", limit: 2 }, want: [42, 58], total: 2, next: 58 },
  { label: "descending offset", query: { order: "desc", offset: 1, limit: 2 }, want: [58, 42], total: 6, next: 42 },
  { label: "descending seek intersects all OR legs", query: { order: "desc", cursor: 58, limit: 2, offset: 999 }, want: [42, 37], total: 4, next: 37 },
  { label: "descending disabled seek", query: { order: "desc", cursor: 91, enabled: "false", limit: 2 }, want: [37], total: 1 },
  { label: "identity outside ascending seek", query: { customerId: 23, cursor: 37 }, want: [], total: 0 },
  { label: "identity outside descending seek", query: { customerId: 58, order: "desc", cursor: 42 }, want: [], total: 0 },
  { label: "empty ascending tail", query: { cursor: 91 }, want: [], total: 0 },
  { label: "empty descending tail", query: { order: "desc", cursor: 11 }, want: [], total: 0 }
];

describe.each(["true", "false"])("customer name search includeTotal=%s", (includeTotal) => {
  it.each(INTERSECTIONS)("$label", async (scenario) => {
    const result = await page({ q: "needle", fields: FIELDS, ...scenario.query, includeTotal });
    expectRows(result.body, scenario.want, includeTotal === "false" ? null : scenario.total, scenario.next ?? null);
    if (scenario.query.cursor !== undefined) {
      for (const statement of result.statements) expect(statement.sql).not.toMatch(/\bOFFSET\b/i);
    }
  });

  it.each(["asc", "desc"])("follows %s links through a full terminal page and empty tail without dropping filters", async (order) => {
    const expected = order === "asc" ? [[11, 23], [42, 58], []] : [[58, 42], [23, 11], []];
    let current = await page({ q: "needle", enabled: "true", fields: "first_name", order, limit: 2, offset: 0, includeTotal, ignored: "synthetic-private-marker" });
    const seen: unknown[] = [];
    for (const [index, want] of expected.entries()) {
      expectRows(current.body, want, includeTotal === "false" ? null : [4, 2, 0][index], want.length === 2 ? want[1] : null);
      for (const row of current.body.rows) expect(Object.keys(row).sort()).toEqual(["customer_id", "first_name"]);
      seen.push(...ids(current.body));
      if (index === 2) {
        expect(current.response.headers.get("link")).toBeNull();
      } else {
        const next = nextUrl(current);
        expect(next.searchParams.get("q")).toBe("needle");
        expect(next.searchParams.get("enabled")).toBe("true");
        expect(next.searchParams.get("fields")).toBe("first_name");
        expect(next.searchParams.get("order")).toBe(order);
        expect(next.searchParams.get("limit")).toBe("2");
        expect(next.searchParams.has("ignored")).toBe(false);
        expect([null, "true", "false"]).toContain(next.searchParams.get("includeTotal"));
        if (includeTotal === "false") expect(next.searchParams.get("includeTotal")).toBe("false");
        current = await page(next);
      }
    }
    expect(seen).toEqual(order === "asc" ? [11, 23, 42, 58] : [58, 42, 23, 11]);
    expect(new Set(seen).size).toBe(4);
  });

  it("retains literal encoded q and customerId in a followable link", async () => {
    const first = await page({ q: LITERAL, customerId: 112, fields: "last_name", limit: 1, includeTotal });
    expectRows(first.body, [112], includeTotal === "false" ? null : 1, 112);
    const next = nextUrl(first);
    expect(next.searchParams.get("q")).toBe(LITERAL);
    expect(next.searchParams.get("customerId")).toBe("112");
    const tail = await page(next);
    expectRows(tail.body, [], includeTotal === "false" ? null : 0);
    expect(tail.response.headers.get("link")).toBeNull();
  });
});

it("count-free mode only removes COUNT and changes total, never adds lookahead or queries", async () => {
  const query = { q: "needle", enabled: "true", order: "desc", cursor: 91, offset: 999, fields: "last_name", limit: 2 };
  const counted = await page(query);
  const free = await page({ ...query, includeTotal: "false" });
  expectRows(counted.body, [58, 42], 4, 42);
  expect(free.body).toEqual({ ...counted.body, total: null });
  expect(free.statements).toEqual(counted.statements.filter((s) => !isCount(s)));
  expect(free.statements[0].binds.slice(-1)).toEqual([2]);
});

it.each(["true", "false"])("conditional sparse JSON hashes the final name-filtered envelope (includeTotal=%s)", async (includeTotal) => {
  const query = { q: "needle", enabled: "true", order: "desc", limit: 2, fields: "last_name", includeTotal };
  const first = await page(query);
  expect(first.body).toEqual({ rows: [{ customer_id: 58, last_name: "needle" }, { customer_id: 42, last_name: "Needle" }], total: includeTotal === "false" ? null : 4, nextCursor: 42 });
  const tag = await hash(first.bytes);
  expect(first.response.headers.get("etag")).toBe(tag);
  const conditional = await request(query, { headers: { "if-none-match": tag } });
  expect(conditional.response.status).toBe(304);
  expect(conditional.response.body).toBeNull();
  expect(await conditional.response.text()).toBe("");
  expect(conditional.response.headers.get("etag")).toBe(tag);
  posture(conditional.response, conditional.requestId);
  expect(conditional.statements).toEqual(first.statements);
  const changed = await page({ ...query, fields: "first_name" });
  expect(changed.response.headers.get("etag")).toBe(await hash(changed.bytes));
  expect(changed.response.headers.get("etag")).not.toBe(tag);
});

it("unknown query keys change neither filtered bytes, SQL nor validators", async () => {
  const query = { q: "needle", enabled: "false", fields: "last_name", order: "desc" };
  const plain = await page(query);
  const ignored = await page({ ...query, unexpected: "synthetic-private-marker" });
  expectRows(plain.body, [91, 37], 2);
  expect(ignored.bytes).toBe(plain.bytes);
  expect(ignored.statements).toEqual(plain.statements);
  expect(ignored.response.headers.get("etag")).toBe(plain.response.headers.get("etag"));
});

it("executes bound instr/lower/coalesce predicates and real local EXPLAIN without joins or extra request work", async () => {
  const result = await page({ q: LITERAL, cursor: 11, enabled: "true", fields: "first_name", limit: 2 });
  // Do not pin the total number of binds: selectors may be added independently.
  // Each of the three OR legs must use a bound, literal substring expression.
  for (const statement of result.statements) {
    for (const column of ["company_name", "first_name", "last_name"]) {
      expect(statement.sql).toMatch(new RegExp(`instr\\(\\s*lower\\(\\s*coalesce\\(\\s*(?:\\w+\\.)?${column}\\s*,\\s*''\\s*\\)\\s*\\)\\s*,\\s*lower\\(\\s*\\?\\s*\\)\\s*\\)\\s*>\\s*0`, "i"));
    }
    expect(statement.binds.filter((value) => value === LITERAL)).toHaveLength(3);
    expect(statement.sql).not.toContain(LITERAL);
    expect(statement.sql).not.toMatch(/\bLIKE\b|\|\|/i);
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.binds).all<{ detail: string }>();
    const details = plan.results.map((r) => r.detail).join("\n");
    expect(details).toMatch(/SEARCH customer_snapshot USING (?:INTEGER PRIMARY KEY|INDEX idx_customer_snapshot_enabled)/i);
    expect(details).not.toMatch(/TEMP B-TREE|JOIN/i);
  }
  expectRows(result.body, [111, 112], 3, 112);
});

describe("customer q auth and value-free validation", () => {
  const INVALID = [
    new URLSearchParams({ q: "😀".repeat(101) }).toString(),
    new URLSearchParams({ q: "x".repeat(101) }).toString(),
    new URLSearchParams({ q: ` ${LONG_QUERY}` }).toString(),
    new URLSearchParams({ q: " ".repeat(101) }).toString(),
    "q=private-first-marker&q=private-second-marker",
    "q=private-first-marker&q=private-first-marker",
    "q=&q=private-second-marker"
  ];
  it.each(INVALID)("rejects malformed/repeated q before D1: %s", async (query) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const result = await request(query, { headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(await result.response.json()).toEqual({
      type: problemType("bad-request"),
      title: "Bad Request", status: 400,
      detail: "Invalid request query (q). See docs/PROBLEMS.md#bad-request."
    });
    expect(result.statements).toEqual([]);
    expect(result.prepared).toEqual([]);
    expect(result.response.headers.get("x-request-id")).toBe(result.requestId);
    expect(result.response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each([null, "synthetic-invalid-token"])("auth precedes q validation/D1 even with conditional header: %s", async (token) => {
    for (const query of ["q=needle", ...INVALID]) {
      const result = await request(query, { token, headers: { "if-none-match": "*" } });
      expect(result.response.status).toBe(401);
      const problem = await result.response.text();
      expect(problem).not.toContain("private-first-marker");
      expect(problem).not.toContain("private-second-marker");
      expect(problem).not.toContain("😀");
      expect(result.statements).toEqual([]);
      expect(result.prepared).toEqual([]);
    }
  });

  it("keeps repeated-key validator precedence over a later invalid known key", async () => {
    const result = await request("q=private-first-marker&q=private-second-marker&limit=0");
    expect(result.response.status).toBe(400);
    const body = await result.response.json() as { detail: string };
    // The existing validator reports both invalid schema fields, not a route-only
    // repeated-q guard. Values never belong in that detail.
    expect(body.detail).toContain("q");
    expect(body.detail).toContain("limit");
    expect(body.detail).not.toContain("private-");
    expect(result.statements).toEqual([]);
    expect(result.prepared).toEqual([]);
  });

  it.each([READ_TOKEN, "test-api-token", "test-sync-secret"])("existing read-authorized bearer finds personal names: %s", async (token) => {
    const result = await request({ q: "pre-needle", fields: "first_name" }, { token });
    expect(result.response.status).toBe(200);
    expect(await result.response.json()).toEqual({ rows: [{ customer_id: 23, first_name: "pre-NEEDLE-post" }], total: 1, nextCursor: null });
    budget(result.statements, false);
  });

  it("does not log literal search values on success", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}));
    const result = await page({ q: LITERAL });
    expectRows(result.body, [111, 112, 113], 3);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

it.each(["parameter", "schema"] as const)("mounted OpenAPI comments %s description explains q's three-column name search", async (location) => {
  const response = await app.fetch(new Request("http://test.local/openapi.json"), TEST_ENV);
  expect(response.status).toBe(200);
  const doc = await response.json() as { paths: Record<string, { get: {
    parameters: Array<{ name: string; in: string; description?: string; schema?: { description?: string } }>
  } }> };
  const comments = doc.paths[PATH].get.parameters.filter((p) => p.name === "comments" && p.in === "query");
  expect(comments).toHaveLength(1);
  const description = location === "parameter" ? comments[0].description : comments[0].schema?.description;
  expect(description).toEqual(expect.any(String));
  expect.soft(description).not.toMatch(/company[ -]only/i);
  expect.soft(description).toMatch(/\bq\s+searches\b/i);
  for (const column of [/company[_ -]name/i, /first[_ -]name/i, /last[_ -]name/i]) {
    expect.soft(description).toMatch(column);
  }
  expect.soft(description).toMatch(/\bor\b/i);
});

it("mounted OpenAPI keeps the operation/read contract and describes substring search across the three separate columns", async () => {
  const response = await app.fetch(new Request("http://test.local/openapi.json"), TEST_ENV);
  expect(response.status).toBe(200);
  const doc = await response.json() as { paths: Record<string, { get: {
    operationId: string; parameters: Array<{ name: string; in: string; description?: string; schema?: { description?: string } }>;
    "x-access": string; "x-effect": string
  } }> };
  const operation = doc.paths[PATH].get;
  expect(operation.operationId).toBe("listCustomerSnapshot");
  expect(operation["x-access"]).toBe("read");
  expect(operation["x-effect"]).toBe("local-read");
  const q = operation.parameters.find((p) => p.name === "q" && p.in === "query");
  expect(q).toBeDefined();
  const description = `${q!.description ?? ""} ${q!.schema?.description ?? ""}`;
  expect(description).toMatch(/substring/i);
  for (const column of [/company[_ -]name/i, /first[_ -]name/i, /last[_ -]name/i]) expect(description).toMatch(column);
  expect(description).toMatch(/any|\bor\b/i);
});
