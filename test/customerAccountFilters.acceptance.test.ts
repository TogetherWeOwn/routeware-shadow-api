import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import { ensureD1TestTables } from "./d1TestMigrations";

// Test-first public contract. All account references are synthetic. Real local
// D1 executes the reads; only forbidden network/storage and rejected D1 are doubled.
// Expected IDs are hand-derived, not computed by the filtering code under test.
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/customer-snapshot";
const ORIGIN = "https://account-lookup.test.invalid";
const READ_TOKEN = "test-read-token";
const SPECIAL = "00'_% &+#?/=";
const SUB_SPECIAL = "S'_% &+#?/=";
const UNICODE = "顧客😀";
const MAX_UNICODE = "😀".repeat(100);
const MAX_MIXED = "x".repeat(50) + "😀".repeat(50);
const SYNCED_AT = "2026-10-01T00:00:00.000Z";
const FIXTURES: Array<[number, string | null, string | null, string, number]> = [
  [1, "00042", "North", "Synthetic Harbor", 1],
  [2, "00042", "North", "Synthetic Harbor", 0],
  [3, "00042", "South", "Synthetic Other", 1],
  [4, "42", "North", "Synthetic Harbor", 1],
  [5, "00042", "north", "Synthetic Harbor", 1],
  [6, null, "North", "Synthetic Harbor", 1],
  [7, "Case", "A", "Synthetic Other", 1],
  [8, "case", "a", "Synthetic Other", 1],
  [9, " 00042 ", " North ", "Synthetic Harbor", 1],
  [10, UNICODE, "枝😀", "Synthetic Other", 1],
  [11, SPECIAL, SUB_SPECIAL, "Synthetic Harbor", 1],
  [12, SPECIAL, SUB_SPECIAL, "Synthetic Harbor", 1],
  [13, "AC%_42", "SU%_42", "Synthetic Other", 1],
  [14, "ACxy42", "SUxy42", "Synthetic Other", 1],
  [15, "x' OR 1=1 --", "y' OR 1=1 --", "Synthetic Other", 1],
  [16, MAX_UNICODE, MAX_UNICODE, "Synthetic Other", 1],
  [17, MAX_MIXED, MAX_MIXED, "Synthetic Other", 1],
  [18, " \tX \n", " \tY \n", "Synthetic Other", 1],
  [19, "0", "0", "Synthetic Other", 1],
  [20, "000420", "North-extra", "Synthetic Other", 1],
  [21, "0004", null, "Synthetic Other", 1],
  [22, "é", "é", "Synthetic Other", 1],
  [23, "é", "é", "Synthetic Other", 1]
];

type Query = Record<string, string> | Array<[string, string]>;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Read = { sql: string; binds: unknown[]; method: string };
const isCount = (read: Read) => /\bCOUNT\s*\(/i.test(read.sql);

function recordDb(real: D1Database) {
  const reads: Read[] = [];
  const prepared: string[] = [];
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const records = new WeakMap<D1PreparedStatement, Read>();
  function observe(read: Read, method: string) {
    // A read endpoint cannot hide a mutation behind all()/raw()/batch().
    if (!/^\s*SELECT\b/i.test(read.sql)) throw new Error("Lookup attempted non-SELECT D1 work");
    reads.push({ ...read, method });
  }
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    const read = { sql, binds, method: "" };
    const wrapped = {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql, values),
      first: (...args: unknown[]) => {
        observe(read, "first");
        return (stmt.first as (...a: unknown[]) => unknown)(...args);
      },
      all: () => { observe(read, "all"); return stmt.all(); },
      raw: (...args: unknown[]) => {
        observe(read, "raw");
        return (stmt.raw as (...a: unknown[]) => unknown)(...args);
      },
      run: () => { observe(read, "run"); return stmt.run(); }
    } as unknown as D1PreparedStatement;
    originals.set(wrapped, stmt);
    records.set(wrapped, read);
    return wrapped;
  }
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      return wrap(real.prepare(sql), sql, []);
    },
    batch(statements: D1PreparedStatement[]) {
      for (const stmt of statements) observe(records.get(stmt)!, "batch");
      return real.batch(statements.map((stmt) => originals.get(stmt)!));
    },
    exec: vi.fn(() => { throw new Error("Lookup attempted unbound D1 exec"); })
  } as unknown as D1Database;
  return { db, reads, prepared };
}

function forbiddenDb() {
  const fail = vi.fn(() => { throw new Error("Rejected request touched D1"); });
  return { db: { prepare: fail, batch: fail, exec: fail, withSession: fail } as unknown as D1Database, fail };
}

async function request(
  query: Query | URL = {},
  options: { token?: string | null; headers?: Record<string, string>; db?: D1Database } = {}
) {
  const url = query instanceof URL ? query : new URL(PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = new URLSearchParams(query).toString();
  const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
  const headers = new Headers(options.headers);
  const token = options.token === undefined ? READ_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV,
    CUSTOMER_DB: options.db ?? recorder.db,
    SNAPSHOTS: new Proxy({} as R2Bucket, {
      get() { throw new Error("Local account lookup must not access R2"); }
    })
  });
  return { response, recorder, url };
}

async function page(query: Query | URL = {}, token?: string) {
  const result = await request(query, { token });
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  const body = await result.response.json() as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const counted = result.url.searchParams.get("includeTotal") !== "false";
  expect(result.recorder.reads.filter(isCount)).toHaveLength(counted ? 1 : 0);
  expect(result.recorder.reads).toHaveLength(counted ? 2 : 1);
  if (!counted) expect(body.total).toBeNull();
  return { ...result, body };
}

const ids = (body: Body) => body.rows.map((row) => row.customer_id);

function nextUrl(response: Response, current: URL) {
  const link = response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/customer-snapshot\?[^<>\s]*>; rel="next"$/);
  const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], current);
  expect(target.origin).toBe(current.origin);
  expect(target.pathname).toBe(PATH);
  expect(target.hash).toBe("");
  expect(target.searchParams.has("offset")).toBe(false);
  return target;
}

beforeAll(async () => { await ensureD1TestTables(); });

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound account lookup fetch"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  await db.batch(FIXTURES.map(([id, customer, sub, company, enabled]) => db.prepare(
    "INSERT INTO customer_snapshot (customer_id, customer_number, sub_customer_number, company_name, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, customer, sub, company, enabled, SYNCED_AT)));
});

afterEach(() => {
  try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe("customer account numbers: exact opaque selectors", () => {
  it.each<{ query: Record<string, string>; want: number[] }>([
    { query: { customerNumber: "00042" }, want: [1, 2, 3, 5] },
    { query: { subCustomerNumber: "North" }, want: [1, 2, 4, 6] },
    { query: { customerNumber: "00042", subCustomerNumber: "North" }, want: [1, 2] },
    { query: { customerNumber: "00042", subCustomerNumber: "north" }, want: [5] },
    { query: { customerNumber: "42" }, want: [4] },
    { query: { customerNumber: "Case" }, want: [7] },
    { query: { customerNumber: "case" }, want: [8] },
    { query: { subCustomerNumber: "A" }, want: [7] },
    { query: { subCustomerNumber: "a" }, want: [8] },
    { query: { customerNumber: " 00042 ", subCustomerNumber: " North " }, want: [9] },
    { query: { customerNumber: " \tX \n", subCustomerNumber: " \tY \n" }, want: [18] },
    { query: { customerNumber: "0", subCustomerNumber: "0" }, want: [19] },
    { query: { customerNumber: UNICODE, subCustomerNumber: "枝😀" }, want: [10] },
    { query: { customerNumber: MAX_UNICODE, subCustomerNumber: MAX_UNICODE }, want: [16] },
    { query: { customerNumber: MAX_MIXED, subCustomerNumber: MAX_MIXED }, want: [17] },
    { query: { customerNumber: "é", subCustomerNumber: "é" }, want: [22] },
    { query: { customerNumber: "é", subCustomerNumber: "é" }, want: [23] },
    { query: { customerNumber: "AC%_42" }, want: [13] },
    { query: { subCustomerNumber: "SU%_42" }, want: [13] },
    { query: { customerNumber: "x' OR 1=1 --", subCustomerNumber: "y' OR 1=1 --" }, want: [15] },
    { query: { customerNumber: SPECIAL, subCustomerNumber: SUB_SPECIAL }, want: [11, 12] },
    { query: { customerNumber: "missing-synthetic" }, want: [] },
    { query: { subCustomerNumber: "null" }, want: [] },
    { query: { customerNumber: "null" }, want: [] },
    { query: { customerNumber: "00042", subCustomerNumber: "A" }, want: [] }
  ])("returns all and only exact matches: $query", async ({ query, want }) => {
    const { body } = await page(query);
    expect(ids(body)).toEqual(want);
    expect(body.total).toBe(want.length);
    expect(body.nextCursor).toBeNull();
  });

  it.each<{ query: Record<string, string>; want: number[] }>([
    { query: { customerId: "2" }, want: [2] },
    { query: { customerId: "4" }, want: [] },
    { query: { q: "  hArBoR  " }, want: [1, 2, 5] },
    { query: { enabled: "true" }, want: [1, 3, 5] },
    { query: { enabled: "false" }, want: [2] },
    { query: { customerId: "1", q: "Harbor", enabled: "true" }, want: [1] },
    { query: { customerId: "3", q: "Harbor" }, want: [] },
    // q remains a company-name substring; it must not search the new columns.
    { query: { q: "00042" }, want: [] }
  ])("AND-composes customerNumber with existing selectors: $query", async ({ query, want }) => {
    const { body } = await page({ customerNumber: "00042", ...query });
    expect(ids(body)).toEqual(want);
    expect(body.total).toBe(want.length);
  });

  it("AND-composes both numbers, ID, q, enabled and sparse fields", async () => {
    const { body } = await page({
      customerNumber: "00042", subCustomerNumber: "North", customerId: "1",
      q: "Harbor", enabled: "true", fields: "company_name,customer_number,sub_customer_number"
    });
    expect(body).toEqual({ rows: [{
      customer_id: 1, company_name: "Synthetic Harbor", customer_number: "00042", sub_customer_number: "North"
    }], total: 1, nextCursor: null });
  });

  it("does not drop subCustomerNumber when customerId is also supplied", async () => {
    const { body } = await page({ customerNumber: "00042", subCustomerNumber: "North", customerId: "3" });
    expect(body).toEqual({ rows: [], total: 0, nextCursor: null });
  });

  it("binds each literal in both COUNT and row equality predicates", async () => {
    const { body, recorder } = await page({ customerNumber: SPECIAL, subCustomerNumber: SUB_SPECIAL });
    for (const read of recorder.reads) {
      expect(read.sql).not.toContain(SPECIAL);
      expect(read.sql).not.toContain(SUB_SPECIAL);
      expect(read.binds).toEqual(expect.arrayContaining([SPECIAL, SUB_SPECIAL]));
      // Observe bound equality at the D1 boundary without pinning column
      // quoting, aliases, collation spelling, predicate order or a SQL builder.
      // The exact-match fixture matrix separately excludes LIKE/substring bugs.
      const equalities = read.sql.match(/(?:=\s*\?\d*|\?\d*\s*=)/g) ?? [];
      expect(equalities.length).toBeGreaterThanOrEqual(2);
    }
    expect(ids(body)).toEqual([11, 12]);
  });
});

describe("account lookups: existing pagination conventions", () => {
  it.each([undefined, "true", "false"])("keeps filtered COUNT/offset/cursor semantics (includeTotal=%s)", async (includeTotal) => {
    const mode: Record<string, string> = includeTotal === undefined ? {} : { includeTotal };
    const offset = await page({ customerNumber: "00042", limit: "2", offset: "1", ...mode });
    expect(ids(offset.body)).toEqual([2, 3]);
    expect(offset.body.total).toBe(includeTotal === "false" ? null : 4);
    expect(offset.body.nextCursor).toBe(3);
    const cursor = await page({ customerNumber: "00042", limit: "2", cursor: "2", offset: "999", ...mode });
    expect(ids(cursor.body)).toEqual([3, 5]);
    expect(cursor.body.total).toBe(includeTotal === "false" ? null : 2);
    expect(cursor.body.nextCursor).toBe(5);
    const empty = await page({ customerNumber: "00042", cursor: "5", ...mode });
    expect(empty.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(empty.response.headers.get("link")).toBeNull();
  });

  it("count-free mode has identical rows/cursor and executes zero COUNTs", async () => {
    const query = { customerNumber: "00042", subCustomerNumber: "North", fields: "customer_number", limit: "1" };
    const counted = await page(query);
    const countFree = await page({ ...query, includeTotal: "false" });
    expect(counted.body).toEqual({ rows: [{ customer_id: 1, customer_number: "00042" }], total: 2, nextCursor: 1 });
    expect(countFree.body).toEqual({ ...counted.body, total: null });
    expect(countFree.recorder.reads).toEqual(counted.recorder.reads.filter((read) => !isCount(read)));
  });

  it.each(["true", "false"])("follows encoded Link verbatim, including the full-final-page cursor (%s)", async (includeTotal) => {
    const query = {
      customerNumber: SPECIAL, subCustomerNumber: SUB_SPECIAL, q: "Harbor", enabled: "true",
      fields: "customer_number,sub_customer_number", limit: "1", offset: "0", includeTotal,
      bogus_param: "ignored-not-reflected"
    };
    const first = await page(query);
    expect(ids(first.body)).toEqual([11]);
    expect(first.body.nextCursor).toBe(11);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 2);
    let target = nextUrl(first.response, first.url);
    for (const [key, value] of Object.entries(query)) {
      if (["offset", "bogus_param", "includeTotal"].includes(key)) continue;
      expect(target.searchParams.getAll(key)).toEqual([value]);
    }
    expect(target.searchParams.has("bogus_param")).toBe(false);
    expect(target.searchParams.get("cursor")).toBe("11");
    if (includeTotal === "false") expect(target.searchParams.get("includeTotal")).toBe("false");
    const second = await page(target);
    expect(second.body).toEqual({ rows: [{ customer_id: 12, customer_number: SPECIAL, sub_customer_number: SUB_SPECIAL }],
      total: includeTotal === "false" ? null : 1, nextCursor: 12 });
    target = nextUrl(second.response, second.url);
    expect(target.searchParams.get("customerNumber")).toBe(SPECIAL);
    expect(target.searchParams.get("subCustomerNumber")).toBe(SUB_SPECIAL);
    expect(target.searchParams.get("cursor")).toBe("12");
    const third = await page(target);
    expect(third.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(third.response.headers.get("link")).toBeNull();
  });
});

describe.each(["customerNumber", "subCustomerNumber"] as const)("%s validation and recovery", (key) => {
  it.each([
    ["empty", ""], ["spaces", "   "], ["Unicode whitespace", "  \t\n"],
    ["101 ASCII code points", "synthetic-sensitive-".padEnd(101, "x")],
    ["101 astral code points", "😀".repeat(101)],
    ["raw padding above 100", "x" + " ".repeat(100)]
  ])("rejects %s before D1, with a fixed value-free problem and no logs", async (_label, value) => {
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
    const { response, recorder } = await request({ [key]: value });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("link")).toBeNull();
    expect(await response.json()).toEqual({
      type: problemType("bad-request"), title: "Bad Request", status: 400,
      detail: `Invalid request query (${key}). See docs/PROBLEMS.md#bad-request.`
    });
    expect(recorder.prepared).toEqual([]);
    expect(recorder.reads).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each(["same", "different"])("rejects repeated keys (%s), even individually valid ones", async (kind) => {
    const { response, recorder } = await request([[key, "00042"], [key, kind === "same" ? "00042" : "42"]]);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      type: problemType("bad-request"), title: "Bad Request", status: 400,
      detail: `Invalid request query (${key}). See docs/PROBLEMS.md#bad-request.`
    });
    expect(recorder.prepared).toEqual([]);
    expect(recorder.reads).toEqual([]);
  });

  it("does not let a valid companion selector mask invalid input", async () => {
    const other = key === "customerNumber" ? "subCustomerNumber" : "customerNumber";
    const { response, recorder } = await request({ [key]: "", [other]: "00042" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: 400,
      detail: `Invalid request query (${key}). See docs/PROBLEMS.md#bad-request.` });
    expect(recorder.prepared).toEqual([]);
    expect(recorder.reads).toEqual([]);
  });

  it.each([null, "wrong-synthetic-token"])("authenticates before validation, D1 or wildcard conditional success (token=%s)", async (token) => {
    const denied = forbiddenDb();
    const { response } = await request({ [key]: "" }, { token, db: denied.db, headers: { "if-none-match": "*" } });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ type: problemType("unauthorized"), status: 401 });
    expect(denied.fail).not.toHaveBeenCalled();
  });

  it.each(["*", "exact"])("validates before a warm conditional read (%s)", async (condition) => {
    const warm = await request({ limit: "1" });
    expect(warm.response.status).toBe(200);
    // Hash served bytes independently so this also runs on the pre-validator
    // baseline; newer implementations must not let an exact/wildcard 304 hide
    // ignored invalid account input. No production hash helper is the oracle.
    const bytes = await warm.response.text();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
    const tag = `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
    const { response, recorder } = await request({ [key]: "", limit: "1" }, {
      headers: { "if-none-match": condition === "*" ? "*" : tag }
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("etag")).toBeNull();
    expect(await response.json()).toMatchObject({ type: problemType("bad-request"), status: 400,
      detail: `Invalid request query (${key}). See docs/PROBLEMS.md#bad-request.` });
    expect(recorder.prepared).toEqual([]);
    expect(recorder.reads).toEqual([]);
  });

  it("lets the valid read token reach a value-free 400 before D1", async () => {
    const { response, recorder } = await request({ [key]: "" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ type: problemType("bad-request"), status: 400 });
    expect(recorder.prepared).toEqual([]);
    expect(recorder.reads).toEqual([]);
  });
});

describe("account lookups: unchanged defaults, read safety and discoverability", () => {
  it("retains the omitted-selector JSON fields, stable IDs, totals and ascending cursor", async () => {
    const { body } = await page({ limit: "1" });
    expect(body).toEqual({ rows: [{
      customer_id: 1, customer_type_id: null, company_name: "Synthetic Harbor", first_name: null,
      middle_initial: null, last_name: null, name_suffix: null, customer_number: "00042",
      sub_customer_number: "North", phone1: null, phone2: null, comments: null, enabled: 1, synced_at: SYNCED_AT
    }], total: 23, nextCursor: 1 });
  });

  it.each([READ_TOKEN, "test-api-token", "test-sync-secret"])("retains authorized read access (%s)", async (token) => {
    const { body } = await page({ customerNumber: "00042", subCustomerNumber: "North" }, token);
    expect(ids(body)).toEqual([1, 2]);
  });

  it("continues to ignore unrelated unknown keys without changing SQL or results", async () => {
    const plain = await page({ customerNumber: "00042", subCustomerNumber: "North" });
    const unknown = await page({ customerNumber: "00042", subCustomerNumber: "North", unrelated_key: "ignore-me" });
    expect(ids(plain.body)).toEqual([1, 2]);
    expect(unknown.body).toEqual(plain.body);
    expect(unknown.recorder.reads).toEqual(plain.recorder.reads);
  });

  it("is idempotent, read-only, and has runnable synthetic EXPLAIN evidence", async () => {
    const before = await TEST_ENV.CUSTOMER_DB.prepare("SELECT * FROM customer_snapshot ORDER BY customer_id").all();
    const query = { customerNumber: SPECIAL, subCustomerNumber: SUB_SPECIAL, limit: "1" };
    const first = await page(query);
    const second = await page(query);
    expect(second.body).toEqual(first.body);
    expect(second.recorder.reads).toEqual(first.recorder.reads);
    for (const read of first.recorder.reads) {
      const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${read.sql}`).bind(...read.binds).all();
      expect(plan.success).toBe(true);
      expect(plan.results.length).toBeGreaterThan(0);
      // Emit shape/plan only, never supplied account values. This tiny synthetic
      // fixture proves validity/read-only behavior, NOT indexing or prod latency.
      console.info("synthetic account lookup query", JSON.stringify({ sql: read.sql, plan: plan.results }));
    }
    const after = await TEST_ENV.CUSTOMER_DB.prepare("SELECT * FROM customer_snapshot ORDER BY customer_id").all();
    expect(after.results).toEqual(before.results);
  });

  it.each(["customerNumber", "subCustomerNumber"])("publishes optional %s query bounds and recovery in mounted OpenAPI", async (key) => {
    const response = await app.fetch(new Request(`${ORIGIN}/openapi.json`), TEST_ENV);
    expect(response.status).toBe(200);
    const doc = await response.json() as { paths: Record<string, { get: {
      operationId: string; "x-access": string; "x-effect": string;
      parameters: Array<{ name: string; in: string; required?: boolean; description?: string;
        schema: { type?: string; minLength?: number; maxLength?: number; description?: string } }>;
      responses: Record<string, { description: string }>;
    } }> };
    const operation = doc.paths[PATH].get;
    expect(operation.operationId).toBe("listCustomerSnapshot");
    expect(operation["x-access"]).toBe("read");
    expect(operation["x-effect"]).toBe("local-read");
    const params = operation.parameters.filter((parameter) => parameter.name === key);
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ in: "query", schema: { type: "string", minLength: 1, maxLength: 100 } });
    expect(params[0].required).not.toBe(true);
    const description = `${params[0].description ?? ""} ${params[0].schema.description ?? ""}`;
    expect(description).toMatch(/exact/i);
    expect(description).toMatch(/case-sensitive/i);
    expect(description).toMatch(/Unicode code points/i);
    const errors = operation.responses["400"].description;
    expect(errors).toContain(key);
    expect(errors).toContain("docs/PROBLEMS.md#bad-request");
  });
});
