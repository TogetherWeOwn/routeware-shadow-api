/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import problemsDoc from "../docs/PROBLEMS.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned oracle: filter customers by STORED classification.
 *
 * `GET /api/v1/customer-snapshot?customerTypeId=<n>` is an exact equality
 * filter over the stored nullable `customer_snapshot.customer_type_id`
 * column: `0` is a literal stored value (never a null/all sentinel), NULL
 * rows never match, and omission preserves today's matches byte for byte.
 * The selector is an exact unpadded ASCII nonnegative safe-integer query
 * string, rejected before D1 on the existing value-free path, AND-composed
 * with every existing filter and cursor clause, and carried in follow-next
 * targets. Snapshot classification, not live Routeware state.
 *
 * Hermetic: real local D1 executes every recorded statement; outbound fetch
 * throws; D1 batch/exec/run throw (lists never write). Fixtures are
 * synthetic. New-capability assertions are intentionally RED before the
 * paired build; omission/unknown-key/auth-precedence pins stay GREEN.
 * Builder: consume this commit as-is; never edit this file — request oracle
 * corrections through a new bounded child card.
 */
const TEST_ENV = env as unknown as Env;
const READ_TOKEN = "test-read-token";
const PATH = "/api/v1/customer-snapshot";
const ORIGIN = "https://classification-client.invalid";
const MAX_SAFE = "9007199254740991";

// Stored classifications: literal 0, two positive types with repeats, and
// NULLs — crossed with enabled/disabled and needle/other company text.
type Fixture = { id: number; type: number | null; label: string; enabled: 0 | 1 };
const FIXTURES: Fixture[] = [
  { id: 101, type: 0, label: "synthetic-alpha-101", enabled: 1 },
  { id: 102, type: 2, label: "synthetic-needle-102", enabled: 1 },
  { id: 103, type: 2, label: "synthetic-other-103", enabled: 0 },
  { id: 104, type: 5, label: "synthetic-needle-104", enabled: 1 },
  { id: 105, type: 5, label: "synthetic-needle-105", enabled: 0 },
  { id: 106, type: null, label: "synthetic-needle-106", enabled: 1 },
  { id: 107, type: null, label: "synthetic-other-107", enabled: 0 },
  { id: 108, type: 2, label: "synthetic-needle-108", enabled: 1 }
];
const NULL_IDS = [106, 107];

type Statement = { sql: string; binds: unknown[]; method: string };
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
const idsOf = (body: Body) => body.rows.map((row) => row.customer_id);

// Observe actual executions (including batch/exec), not merely prepare
// calls, so a COUNT/lookahead hidden behind another D1 method cannot evade
// the budget, and any write attempt fails loudly.
function recordDb(real: D1Database) {
  const statements: Statement[] = [];
  const batch = vi.fn(() => { throw new Error("List must not batch D1 work"); });
  const exec = vi.fn(() => { throw new Error("List must not exec D1 work"); });
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql, values),
      first: (...args: unknown[]) => {
        statements.push({ sql, binds, method: "first" });
        return (stmt.first as (...a: unknown[]) => unknown)(...args);
      },
      all: () => {
        statements.push({ sql, binds, method: "all" });
        return stmt.all();
      },
      raw: (...args: unknown[]) => {
        statements.push({ sql, binds, method: "raw" });
        return (stmt.raw as (...a: unknown[]) => unknown)(...args);
      },
      run: () => {
        statements.push({ sql, binds, method: "run" });
        throw new Error("List must not mutate D1");
      }
    } as unknown as D1PreparedStatement;
  }
  const db = {
    prepare: (sql: string) => wrap(real.prepare(sql), sql, []),
    batch,
    exec
  } as unknown as D1Database;
  return { db, statements, batch, exec };
}

function forbiddenDb() {
  const fail = () => { throw new Error("Rejected request must not touch D1"); };
  const prepare = vi.fn(fail);
  const batch = vi.fn(fail);
  const exec = vi.fn(fail);
  return { db: { prepare, batch, exec } as unknown as D1Database, prepare, batch, exec };
}

async function request(
  search: string,
  options: { token?: string | null; headers?: Record<string, string>; db?: D1Database } = {}
) {
  const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
  const headers = new Headers({ origin: ORIGIN, ...options.headers });
  const token = options.token === undefined ? READ_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const url = `http://test.local${PATH}${search ? `?${search}` : ""}`;
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV,
    CUSTOMER_DB: options.db ?? recorder.db
  });
  return { response, url: new URL(url), recorder };
}

async function page(search: string, options: { headers?: Record<string, string> } = {}) {
  const result = await request(search, options);
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  const bytes = await result.response.clone().text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const counted = !new URLSearchParams(search).has("includeTotal") ||
    new URLSearchParams(search).get("includeTotal") !== "false";
  expect(result.recorder.statements).toHaveLength(counted ? 2 : 1);
  expect(result.recorder.statements.filter(isCount)).toHaveLength(counted ? 1 : 0);
  expect(result.recorder.statements.every((s) => /^\s*SELECT\b/i.test(s.sql))).toBe(true);
  expect(result.recorder.batch).not.toHaveBeenCalled();
  expect(result.recorder.exec).not.toHaveBeenCalled();
  if (!counted) expect(body.total).toBeNull();
  return { ...result, body, bytes };
}

function nextTarget(response: Response, current: URL, expected: Record<string, string>): URL {
  const link = response.headers.get("link");
  expect(link, "non-null nextCursor requires Link: <relative-target>; rel=\"next\"").not.toBeNull();
  expect(link).toMatch(/^<\/api\/v1\/customer-snapshot\?[^<>\s]*>; rel="next"$/);
  const raw = /^<([^>]+)>; rel="next"$/.exec(link!)![1];
  const target = new URL(raw, current);
  expect(target.origin).toBe(current.origin);
  expect(target.pathname).toBe(PATH);
  expect(Object.fromEntries(target.searchParams)).toEqual(expected);
  expect(target.searchParams.has("offset")).toBe(false);
  return target;
}

async function follow(target: URL) {
  // Follow exactly the server's path/query. Do not reconstruct any cursor/filter.
  const headers = new Headers({ origin: ORIGIN, authorization: `Bearer ${READ_TOKEN}` });
  const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
  const response = await app.fetch(new Request(target.toString(), { headers }), {
    ...TEST_ENV,
    CUSTOMER_DB: recorder.db
  });
  expect(response.status).toBe(200);
  const bytes = await response.clone().text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  return { response, url: target, recorder, body, bytes };
}

beforeAll(async () => { await ensureD1TestTables(); });

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("Unexpected outbound fetch in customerTypeId acceptance");
  }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  for (const f of FIXTURES) {
    await db.prepare(
      "INSERT INTO customer_snapshot (customer_id, customer_type_id, company_name, enabled, synced_at) VALUES (?, ?, ?, ?, 'synthetic')"
    ).bind(f.id, f.type, f.label, f.enabled).run();
  }
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("customerTypeId equality over the stored classification", () => {
  it.each([
    ["literal zero is a stored value, not a null/all sentinel", "customerTypeId=0", [101], 1],
    ["positive type with repeats", "customerTypeId=2", [102, 103, 108], 3],
    ["second positive type", "customerTypeId=5", [104, 105], 2],
    ["stored NULL rows never match a literal selector", "customerTypeId=0", [101], 1]
  ] as const)("%s", async (_label, search, expectedIds, total) => {
    const { body, statements } = await page(search).then((r) => ({ body: r.body, statements: r.recorder.statements }));
    expect(idsOf(body)).toEqual(expectedIds);
    expect(body.total).toBe(total);
    expect(body.nextCursor).toBeNull();
    for (const id of NULL_IDS) expect(idsOf(body)).not.toContain(id);
    expect(statements).toHaveLength(2);
  });

  it("returns every row's stored classification; NULL rows surface as null", async () => {
    const { body } = await page("customerTypeId=2");
    expect(body.rows).toHaveLength(3);
    for (const row of body.rows) {
      expect(row).toHaveProperty("customer_type_id", 2);
    }
    const omitted = await page("");
    const nulls = omitted.body.rows.filter((row) => row.customer_type_id === null);
    expect(nulls.map((row) => row.customer_id).sort()).toEqual([106, 107]);
  });

  it("answers an unmatched literal with an empty page, zero total and no Link", async () => {
    const { body, response } = await page("customerTypeId=999");
    expect(idsOf(body)).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.nextCursor).toBeNull();
    expect(response.headers.get("link")).toBeNull();
  });

  it("accepts the maximum safe integer as a valid literal with no match", async () => {
    const { body } = await page(`customerTypeId=${MAX_SAFE}`);
    expect(idsOf(body)).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.nextCursor).toBeNull();
  });

  it("omission preserves previous matches and wire behavior (all eight rows, asc)", async () => {
    const { body, statements } = await page("").then((r) => ({ body: r.body, statements: r.recorder.statements }));
    expect(idsOf(body)).toEqual([101, 102, 103, 104, 105, 106, 107, 108]);
    expect(body.total).toBe(8);
    expect(body.nextCursor).toBeNull();
    expect(statements.find(isCount)!.binds).toEqual([]);
    expect(statements.find((s) => !isCount(s))!.binds).toEqual([50, 0]);
  });
});

describe("AND-composition with every existing selector", () => {
  it.each([
    ["intersecting customerId selects one row", "customerTypeId=2&customerId=102", [102], 1],
    ["intersecting customerId selects a disabled row", "customerTypeId=2&customerId=103", [103], 1],
    ["conflicting customerId matches nothing", "customerTypeId=2&customerId=104", [], 0],
    ["conflicting customerId against another type", "customerTypeId=5&customerId=102", [], 0],
    ["q narrows to needle rows of the type", "customerTypeId=2&q=needle", [102, 108], 2],
    ["q plus enabled=true", "customerTypeId=2&q=needle&enabled=true", [102, 108], 2],
    ["enabled=false keeps the disabled row of the type", "customerTypeId=2&enabled=false", [103], 1],
    ["enabled=true drops the disabled row of the type", "customerTypeId=2&enabled=true", [102, 108], 2],
    ["second type with enabled=true", "customerTypeId=5&enabled=true", [104], 1],
    ["q with no row in the type matches nothing", "customerTypeId=5&q=other", [], 0],
    ["q matching nothing matches nothing with the type", "customerTypeId=2&q=synthetic-no-match", [], 0]
  ] as const)("%s", async (_label, search, expectedIds, total) => {
    const { body } = await page(search);
    expect(idsOf(body)).toEqual(expectedIds);
    expect(body.total).toBe(total);
    expect(body.nextCursor).toBeNull();
  });

  it("preserves the existing customerId filter without the new selector", async () => {
    const { body } = await page("customerId=102");
    expect(idsOf(body)).toEqual([102]);
    expect(body.total).toBe(1);
  });

  it("preserves the existing customerId validator for non-numeric ids", async () => {
    const db = forbiddenDb();
    const { response } = await request("customerId=synthetic-not-a-number", { db: db.db });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(db.prepare).not.toHaveBeenCalled();
  });
});

describe("strict lexical validation before D1", () => {
  const INVALID = [
    ["empty", ""],
    ["blank", " "],
    ["plus sign", "+2"],
    ["negative", "-1"],
    ["negative zero", "-0"],
    ["padded zero", "00"],
    ["padded value", "02"],
    ["fraction", "2.0"],
    ["fractional", "2.5"],
    ["exponent", "2e1"],
    ["capital exponent", "1E3"],
    ["hex", "0x2"],
    ["leading space", " 2"],
    ["trailing space", "2 "],
    ["tab", "\t2"],
    ["suffix", "2suffix"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["just over the safe-integer boundary", "9007199254740992"],
    ["far over the safe-integer boundary", "99999999999999999999999"],
    ["marker value (must never echo)", "secret-type-marker"]
  ] as const;

  it.each(INVALID)("rejects %s with the fixed value-free 400, no Link and no D1 work", async (_label, value) => {
    const db = forbiddenDb();
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const { response } = await request(`customerTypeId=${encodeURIComponent(value)}`, { db: db.db });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("link")).toBeNull();
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      type: problemType("bad-request"), title: "Bad Request", status: 400,
      detail: "Invalid request query (customerTypeId). See docs/PROBLEMS.md#bad-request."
    });
    expect(text).not.toContain("secret-type-marker");
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("rejects a bare valueless key (it parses as empty, not omitted)", async () => {
    const db = forbiddenDb();
    const { response } = await request("customerTypeId", { db: db.db });
    expect(response.status).toBe(400);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it.each([
    "customerTypeId=2&customerTypeId=2",
    "customerTypeId=2&customerTypeId=5",
    "customerTypeId=&customerTypeId=2",
    "customerTypeId=2&%63ustomerTypeId=2"
  ])("rejects ambiguous repeated keys before D1: %s", async (search) => {
    const db = forbiddenDb();
    const { response } = await request(search, { db: db.db });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({
      title: "Bad Request", status: 400,
      detail: "Invalid request query (customerTypeId). See docs/PROBLEMS.md#bad-request."
    });
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
  });

  it("uses identical fixed correction guidance for different rejected values", async () => {
    const first = await request("customerTypeId=+2");
    const second = await request("customerTypeId=9007199254740992");
    expect(first.response.status).toBe(400);
    expect(await first.response.text()).toBe(await second.response.text());
  });
});

describe("auth precedes validation and D1", () => {
  it.each([null, "synthetic-invalid-token"])("401s before validating an invalid selector with token=%j", async (token) => {
    const db = forbiddenDb();
    const { response } = await request("customerTypeId=secret-type-marker", { token, db: db.db });
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.text()).not.toContain("secret-type-marker");
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
  });

  it.each([null, "synthetic-invalid-token"])("401s before running a valid selector with token=%j", async (token) => {
    const db = forbiddenDb();
    const { response } = await request("customerTypeId=2", { token, db: db.db });
    expect(response.status).toBe(401);
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("serves the filtered page to the GET read-only token (read scope preserved)", async () => {
    const headers = new Headers({ origin: ORIGIN, authorization: `Bearer ${READ_TOKEN}` });
    const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
    const response = await app.fetch(new Request(`http://test.local${PATH}?customerTypeId=2`, { headers }), {
      ...TEST_ENV, CUSTOMER_DB: recorder.db
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as Body;
    expect(idsOf(body)).toEqual([102, 103, 108]);
    expect(body.total).toBe(3);
  });
});

describe("SQL/bind contract: one bound equality predicate", () => {
  it("adds exactly one customer_type_id = ? predicate with a numeric bind", async () => {
    const { recorder } = await page("customerTypeId=2");
    expect(recorder.statements).toHaveLength(2);
    const count = recorder.statements.find(isCount)!;
    const select = recorder.statements.find((s) => !isCount(s))!;
    for (const statement of [count, select]) {
      const where = statement.sql.slice(statement.sql.indexOf("WHERE"));
      expect(where).toContain("customer_type_id = ?");
      expect(where.match(/customer_type_id\s*=\s*\?/g)).toHaveLength(1);
      expect(statement.sql).not.toMatch(/\bJOIN\b/i);
    }
    expect(count.binds).toEqual([2]);
    expect(select.binds).toEqual([2, 50, 0]);
    for (const bind of [...count.binds, select.binds[0]]) expect(typeof bind).toBe("number");
  });

  it("keeps COUNT and SELECT over the identical WHERE with pagination binds last", async () => {
    const { recorder } = await page("customerTypeId=2&customerId=102&q=needle&enabled=true&cursor=101&limit=2");
    const count = recorder.statements.find(isCount)!;
    const select = recorder.statements.find((s) => !isCount(s))!;
    const whereOf = (sql: string) => sql.slice(sql.indexOf("WHERE")).split(" ORDER BY ")[0];
    expect(whereOf(select.sql)).toContain(whereOf(count.sql));
    expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
    // Pagination binds stay last: cursor seek in WHERE, then LIMIT only.
    expect(select.sql).not.toMatch(/\bOFFSET\b/i);
    expect(select.binds.at(-1)).toBe(2);
    expect(count.binds).toContain(2);
    expect(count.binds).toContain(102);
    expect(count.binds).toContain("needle");
    expect(count.binds).toContain(101);
  });

  it("binds zero as the number 0, not a null/all sentinel", async () => {
    const { recorder, body } = await page("customerTypeId=0");
    expect(idsOf(body)).toEqual([101]);
    expect(recorder.statements.find(isCount)!.binds).toEqual([0]);
    expect(recorder.statements.find((s) => !isCount(s))!.binds).toEqual([0, 50, 0]);
  });

  it("ignores unknown names alongside the selector without changing bytes or SQL", async () => {
    const baseline = await page("customerTypeId=2");
    const tainted = await page("customerTypeId=2&bogus_param=1");
    expect(tainted.bytes).toBe(baseline.bytes);
    expect(tainted.recorder.statements).toEqual(baseline.recorder.statements);
  });
});

describe("filtered pagination and followable next links", () => {
  it("carries the selector in Link and follows an offset start as keyset pages", async () => {
    const first = await page("customerTypeId=2&limit=2&offset=1");
    expect(idsOf(first.body)).toEqual([103, 108]);
    expect(first.body.total).toBe(3);
    expect(first.body.nextCursor).toBe(108);
    const target = nextTarget(first.response, first.url, {
      customerTypeId: "2", limit: "2", cursor: "108"
    });
    const last = await follow(target);
    expect(idsOf(last.body)).toEqual([]);
    expect(last.body.total).toBe(0);
    expect(last.body.nextCursor).toBeNull();
    expect(last.response.headers.get("link")).toBeNull();
  });

  it("walks every row of the type once, linking a full terminal page to an empty tail", async () => {
    let current = await page("customerTypeId=2&limit=1");
    const seen: unknown[] = [];
    const expectedPages = [[102], [103], [108], []];
    const expectedTotals = [3, 2, 1, 0];
    for (let index = 0; index < expectedPages.length; index++) {
      expect(idsOf(current.body)).toEqual(expectedPages[index]);
      expect(current.body.total).toBe(expectedTotals[index]);
      seen.push(...idsOf(current.body));
      if (index === expectedPages.length - 1) {
        expect(current.body.nextCursor).toBeNull();
        expect(current.response.headers.get("link")).toBeNull();
      } else {
        const cursor = String([102, 103, 108][index]);
        expect(current.body.nextCursor).toBe(Number(cursor));
        current = await follow(nextTarget(current.response, current.url, {
          customerTypeId: "2", limit: "1", cursor
        }));
      }
    }
    expect(seen).toEqual([102, 103, 108]);
  });

  it("keeps the selector on descending pages with cursor-relative totals", async () => {
    const first = await page("customerTypeId=2&order=desc&limit=2");
    expect(idsOf(first.body)).toEqual([108, 103]);
    expect(first.body.total).toBe(3);
    expect(first.body.nextCursor).toBe(103);
    const target = nextTarget(first.response, first.url, {
      customerTypeId: "2", limit: "2", order: "desc", cursor: "103"
    });
    const last = await follow(target);
    expect(idsOf(last.body)).toEqual([102]);
    expect(last.body.total).toBe(1);
    expect(last.body.nextCursor).toBeNull();
    expect(last.response.headers.get("link")).toBeNull();
  });

  it("drops even a conflicting offset once the cursor takes over", async () => {
    const { body, recorder } = await page("customerTypeId=2&cursor=102&offset=999&limit=2");
    expect(idsOf(body)).toEqual([103, 108]);
    expect(body.total).toBe(2);
    for (const statement of recorder.statements) {
      expect(statement.sql).not.toMatch(/\bOFFSET\b/i);
    }
  });

  it("keeps count-free mode through the selector: null total, zero COUNT, carried flag", async () => {
    const first = await page("customerTypeId=2&includeTotal=false&limit=2");
    expect(idsOf(first.body)).toEqual([102, 103]);
    expect(first.body.total).toBeNull();
    expect(first.body.nextCursor).toBe(103);
    expect(first.recorder.statements).toHaveLength(1);
    expect(first.recorder.statements.filter(isCount)).toEqual([]);
    const target = nextTarget(first.response, first.url, {
      customerTypeId: "2", limit: "2", includeTotal: "false", cursor: "103"
    });
    const last = await follow(target);
    expect(idsOf(last.body)).toEqual([108]);
    expect(last.body.total).toBeNull();
    expect(last.body.nextCursor).toBeNull();
    expect(last.response.headers.get("link")).toBeNull();
  });

  it("omits Link on a partial filtered terminal page", async () => {
    const { body, response } = await page("customerTypeId=5&limit=5");
    expect(idsOf(body)).toEqual([104, 105]);
    expect(body.total).toBe(2);
    expect(body.nextCursor).toBeNull();
    expect(response.headers.get("link")).toBeNull();
  });
});

describe("sparse fields and conditional metadata on filtered pages", () => {
  it("projects filtered rows to the selector plus the always-present id", async () => {
    const full = await page("customerTypeId=2");
    const sparse = await page("customerTypeId=2&fields=company_name");
    expect(sparse.body.rows).toEqual(
      full.body.rows.map((row) => ({ customer_id: row.customer_id, company_name: row.company_name }))
    );
    expect(sparse.body.total).toBe(full.body.total);
    expect(sparse.body.nextCursor).toBe(full.body.nextCursor);
  });

  it("selects the stored classification column itself", async () => {
    const { body } = await page("customerTypeId=2&fields=customer_type_id");
    expect(body.rows).toEqual([
      { customer_id: 102, customer_type_id: 2 },
      { customer_id: 103, customer_type_id: 2 },
      { customer_id: 108, customer_type_id: 2 }
    ]);
  });

  it("carries fields and the selector together through a linked page", async () => {
    const first = await page("customerTypeId=2&fields=company_name&limit=2&includeTotal=false");
    expect(first.body.rows).toEqual([
      { customer_id: 102, company_name: "synthetic-needle-102" },
      { customer_id: 103, company_name: "synthetic-other-103" }
    ]);
    const target = nextTarget(first.response, first.url, {
      customerTypeId: "2", fields: "company_name", limit: "2", includeTotal: "false", cursor: "103"
    });
    const second = await follow(target);
    expect(second.body.rows).toEqual([
      { customer_id: 108, company_name: "synthetic-needle-108" }
    ]);
  });

  it("emits a quoted ETag over the filtered envelope and answers 304 with the same Link", async () => {
    const first = await page("customerTypeId=2&limit=2");
    const etag = first.response.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const replay = await request("customerTypeId=2&limit=2", { headers: { "if-none-match": etag! } });
    expect(replay.response.status).toBe(304);
    expect(await replay.response.text()).toBe("");
    expect(replay.response.headers.get("etag")).toBe(etag);
    expect(replay.response.headers.get("cache-control")).toBe("no-store");
    expect(replay.response.headers.get("link")).toBe(first.response.headers.get("link"));
  });

  it("a changed selector invalidates the previous filtered validator", async () => {
    const first = await page("customerTypeId=2");
    const etag = first.response.headers.get("etag")!;
    const changed = await request("customerTypeId=5", { headers: { "if-none-match": etag } });
    expect(changed.response.status).toBe(200);
    expect(changed.response.headers.get("etag")).not.toBe(etag);
  });

  it("conditional validators cannot skip auth or selector validation", async () => {
    const first = await page("customerTypeId=2");
    const etag = first.response.headers.get("etag")!;
    const unauthenticated = await request("customerTypeId=2", {
      token: null, headers: { "if-none-match": etag }
    });
    expect(unauthenticated.response.status).toBe(401);
    const invalid = await request("customerTypeId=secret-type-marker", {
      headers: { "if-none-match": etag }
    });
    expect(invalid.response.status).toBe(400);
  });
});

describe("local query shape (EXPLAIN is recorded, not a scan-cost claim)", () => {
  it("explains the actually executed filtered SELECT on real D1", async () => {
    const { recorder } = await page("customerTypeId=2&enabled=true");
    const select = recorder.statements.find((s) => !isCount(s))!;
    expect(select.sql).toContain("customer_type_id = ?");
    const explained = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${select.sql}`)
      .bind(...select.binds)
      .all<{ detail: string }>();
    const plan = (explained.results ?? []).map((row) => row.detail);
    // Recorded local shape only: the plan exists and touches the snapshot
    // table. No production SCAN/SEARCH claim — planner output is SQLite's
    // debugging text, not a stable API, and no new index is proposed.
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.join("\n")).toContain("customer_snapshot");
  });
});

type OpenApiParam = {
  name: string; in: string; required?: boolean; description?: string;
  schema?: { type?: unknown; minimum?: unknown; maximum?: unknown; example?: unknown; description?: string };
};
type OpenApiOperation = {
  operationId?: string; parameters?: OpenApiParam[];
  responses?: Record<string, { description?: string; content?: Record<string, { example?: unknown }> }>;
  [key: string]: unknown;
};
type OpenApiDoc = { paths: Record<string, { get?: OpenApiOperation }> };

async function openApi(): Promise<OpenApiDoc> {
  const response = await exports.default.fetch("http://test.local/openapi.json");
  expect(response.status).toBe(200);
  return (await response.json()) as OpenApiDoc;
}

describe("served OpenAPI description and synthetic example", () => {
  it("publishes customerTypeId as an optional honest-integer query parameter", async () => {
    const doc = await openApi();
    const operation = doc.paths[PATH]?.get;
    expect(operation?.operationId).toBe("listCustomerSnapshot");
    const param = operation?.parameters?.find((p) => p.name === "customerTypeId");
    expect(param).toMatchObject({ in: "query", required: false });
    expect(param?.schema?.type).toBe("integer");
    expect(param?.schema?.minimum).toBe(0);
    expect(param?.schema?.maximum).toBe(9007199254740991);
    const description = param?.description ?? param?.schema?.description ?? "";
    expect(description).toMatch(/snapshot|stored/i);
    expect(Number.isSafeInteger(param?.schema?.example)).toBe(true);
    expect(param?.schema?.example as number).toBeGreaterThanOrEqual(0);
  });

  it("keeps the route identity, auth class and read effect unchanged", async () => {
    const doc = await openApi();
    const operation = doc.paths[PATH]?.get;
    expect(operation?.operationId).toBe("listCustomerSnapshot");
    expect(operation?.["x-access"]).toBe("read");
    expect(operation?.["x-effect"]).toBe("local-read");
  });

  it("shows the stored classification in the served 200 example row", async () => {
    const doc = await openApi();
    const example = doc.paths[PATH]?.get?.responses?.["200"]?.content?.["application/json"]?.example as
      | { rows?: Array<Record<string, unknown>> } | undefined;
    expect(example?.rows?.[0]).toHaveProperty("customer_type_id");
  });

  it("does not add the selector to other lists, the changes feed or by-id reads", async () => {
    const doc = await openApi();
    for (const path of [
      "/api/v1/address-snapshot",
      "/api/v1/container-snapshot",
      "/api/v1/customer-snapshot/changes",
      "/api/v1/customer-snapshot/{customerId}"
    ]) {
      const names = (doc.paths[path]?.get?.parameters ?? []).map((p) => p.name);
      expect(names, path).not.toContain("customerTypeId");
    }
  });
});

describe("canonical docs: inventory, recipe and correction action", () => {
  it("lists customerTypeId in the query-policy inventory for the customer list only", () => {
    const row = (path: string) =>
      policyDoc.split("\n").find((line) => line.startsWith(`| \`${path}\` |`)) ?? "";
    expect(row("/api/v1/customer-snapshot")).toContain("`customerTypeId`");
    expect(row("/api/v1/address-snapshot")).not.toContain("customerTypeId");
    expect(row("/api/v1/container-snapshot")).not.toContain("customerTypeId");
    expect(row("/api/v1/customer-snapshot/changes")).not.toContain("customerTypeId");
    expect(policyDoc).toContain("test/customerTypeFilter.acceptance.test.ts");
  });

  it("shows a synthetic credential-free quickstart example for the selector", () => {
    const blocks = [...quickstartDoc.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((m) => m[1]);
    const block = blocks.find((b) => b.includes("customerTypeId="));
    expect(block).toBeDefined();
    expect(block).toContain("/api/v1/customer-snapshot");
    expect(block).toContain("localhost:8787");
    expect(block).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
  });

  it("gives a fixed correction action for invalid selector syntax", () => {
    expect(problemsDoc).toContain("customerTypeId");
  });
});

describe("deployed Worker boundary (mounted contract)", () => {
  it("keeps request-ID echo, no-store and CORS on a filtered page", async () => {
    const response = await exports.default.fetch(`http://test.local${PATH}?customerTypeId=2`, {
      headers: {
        authorization: `Bearer ${READ_TOKEN}`,
        origin: "https://app.example.com",
        "x-request-id": "synthetic-classification-trace"
      }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("synthetic-classification-trace");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("x-request-id");
    const body = await response.json() as Body;
    expect(idsOf(body)).toEqual([102, 103, 108]);
    expect(body.total).toBe(3);
  });

  it("keeps request-ID correlation and the fixed problem body on a rejected selector", async () => {
    const response = await exports.default.fetch(`http://test.local${PATH}?customerTypeId=+2`, {
      headers: {
        authorization: `Bearer ${READ_TOKEN}`,
        origin: "https://app.example.com",
        "x-request-id": "synthetic-classification-error"
      }
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("synthetic-classification-error");
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(await response.json()).toEqual({
      type: problemType("bad-request"), title: "Bad Request", status: 400,
      detail: "Invalid request query (customerTypeId). See docs/PROBLEMS.md#bad-request."
    });
  });
});
