/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import changelog from "../CHANGELOG.md?raw";
import packageJsonRaw from "../package.json?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned oracle for the OPT-IN exact next-page signal (`exactNext`)
 * on the three ordinary flat snapshot list GETs only.
 *
 * Contract pinned here, hand-derived from the card (not from implementation):
 *  - `exactNext=true|false`, default `false`. Omitted/false preserve today's
 *    bytes, SQL and binds byte for byte — INCLUDING the accepted terminal
 *    false positive (a full final page still links to an empty page).
 *  - `true` runs the SAME single page SELECT with a `limit+1` bind (at most
 *    501 rows fetched), returns at most `limit` rows, and emits
 *    `nextCursor`/`Link` iff the extra matching row exists. The cursor is the
 *    LAST RETURNED primary id, never the lookahead row; the lookahead row is
 *    the first row of the continuation — never omitted, never duplicated.
 *  - No extra COUNT and no second page query in either mode:
 *    `includeTotal=false` still runs zero COUNTs. Seek SQL never gains OFFSET.
 *  - The lookahead row is sliced before field projection and before the
 *    response ETag is computed; 200/304 Link parity and `no-store` hold.
 *  - Invalid/repeated `exactNext` is a value-free 400 before D1, after auth.
 *  - `exactNext=true` is retained in relative next links; false/default is
 *    omitted. Unknown keys, origins and credentials are never propagated.
 *  - This is not snapshot isolation: concurrent inserts/deletes can still
 *    change later pages, and the mounted contract must say so.
 *
 * Real local D1 executes every recorded read; the recorder also captures how
 * many rows each page statement actually fetched, so a fetch-everything-then-
 * slice implementation cannot pass. Outbound fetch throws; fixtures are
 * synthetic. Expected RED before the paired build — do not weaken.
 */
const TEST_ENV = env as unknown as Env;
const READ_TOKEN = "test-read-token";
const ORIGIN = "https://exact-next.test.invalid";

// Gapped fixture: same ids in all three tables. Address owners (and, through
// the address join, container owners) are OWNERS; container N sits at address N.
const IDS = [11, 23, 37, 42, 58, 91];
const OWNERS = [11, 11, 23, 37, 37, 11];
const ENABLED = [1, 1, 1, 0, 1, 0];
const NEEDLE_TEXT = [false, true, false, false, true, false];
// Container row 37 also matches q=needle through serial_number (the OR leg).
const NEEDLE_SERIAL = [false, false, true, false, false, false];

const RESOURCES = [
  { name: "customer", path: "/api/v1/customer-snapshot", id: "customer_id", text: "company_name" },
  { name: "address", path: "/api/v1/address-snapshot", id: "pickup_address_id", text: "address" },
  { name: "container", path: "/api/v1/container-snapshot", id: "container_id", text: "location_address" }
] as const;
type Resource = (typeof RESOURCES)[number];
type Query = Record<string, string>;
type Statement = { sql: string; binds: unknown[]; method: string };
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };

const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);

// Observe actual executions and the number of rows each execution fetched.
function recordDb(real: D1Database) {
  const statements: Statement[] = [];
  const fetched: number[] = [];
  const batch = vi.fn(() => { throw new Error("List must not batch D1 work"); });
  const exec = vi.fn(() => { throw new Error("List must not exec D1 work"); });
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql, values),
      first: (...args: unknown[]) => {
        statements.push({ sql, binds, method: "first" });
        return (stmt.first as (...a: unknown[]) => unknown)(...args);
      },
      all: async () => {
        statements.push({ sql, binds, method: "all" });
        const result = await stmt.all();
        fetched.push((result.results as unknown[]).length);
        return result;
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
  const db = { prepare: (sql: string) => wrap(real.prepare(sql), sql, []), batch, exec } as unknown as D1Database;
  return { db, statements, fetched, batch, exec };
}

function forbiddenDb() {
  const fail = () => { throw new Error("Rejected request must not touch D1"); };
  const prepare = vi.fn(fail);
  const batch = vi.fn(fail);
  const exec = vi.fn(fail);
  return { db: { prepare, batch, exec } as unknown as D1Database, prepare, batch, exec };
}

async function request(
  path: string,
  query: Query = {},
  options: { token?: string | null; headers?: Record<string, string>; db?: D1Database } = {}
) {
  const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
  const headers = new Headers(options.headers);
  const token = options.token === undefined ? READ_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const url = new URL(path, ORIGIN);
  if (Object.keys(query).length > 0) url.search = new URLSearchParams(query).toString();
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV,
    CUSTOMER_DB: options.db ?? recorder.db
  });
  return { response, url, recorder };
}

/** A successful list page: pins envelope, no-store and the query budget. */
async function page(resource: Resource, query: Query | URL = {}, headers?: Record<string, string>) {
  const result = query instanceof URL
    ? await request(query.toString(), {}, { headers })
    : await request(resource.path, query, { headers });
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  const bytes = await result.response.clone().text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const counted = result.url.searchParams.get("includeTotal") !== "false";
  // exactNext must not add work: counted = COUNT + one page SELECT, else one.
  expect(result.recorder.statements).toHaveLength(counted ? 2 : 1);
  expect(result.recorder.statements.filter(isCount)).toHaveLength(counted ? 1 : 0);
  expect(result.recorder.statements.every((s) => /^\s*SELECT\b/i.test(s.sql))).toBe(true);
  expect(result.recorder.batch).not.toHaveBeenCalled();
  expect(result.recorder.exec).not.toHaveBeenCalled();
  for (const n of result.recorder.fetched) expect(n).toBeLessThanOrEqual(501);
  if (!counted) expect(body.total).toBeNull();
  // nextCursor and Link always agree.
  expect(result.response.headers.get("link") !== null).toBe(body.nextCursor !== null);
  return { ...result, body, bytes };
}

function nextTarget(response: Response, current: URL, resource: Resource, expected: Query): URL {
  const link = response.headers.get("link");
  expect(link, "non-null nextCursor requires Link: <relative-target>; rel=\"next\"").not.toBeNull();
  expect(link).toMatch(/^<\/api\/v1\/(?:customer|address|container)-snapshot\?[^<>\s]*>; rel="next"$/);
  const raw = /^<([^>]+)>; rel="next"$/.exec(link!)![1];
  expect(raw.startsWith("//")).toBe(false);
  const target = new URL(raw, current);
  expect(target.origin).toBe(current.origin);
  expect(target.pathname).toBe(resource.path);
  expect(target.hash).toBe("");
  expect(target.username).toBe("");
  expect(target.password).toBe("");
  const actualParams = new URLSearchParams(target.searchParams);
  const expectedParams = { ...expected };
  if (expected.includeTotal !== "false") {
    expect([null, "true"]).toContain(actualParams.get("includeTotal"));
    expect(actualParams.getAll("includeTotal").length).toBeLessThanOrEqual(1);
    actualParams.delete("includeTotal");
    delete expectedParams.includeTotal;
  }
  expect([...actualParams.keys()]).toHaveLength(Object.keys(expectedParams).length);
  expect(Object.fromEntries(actualParams)).toEqual(expectedParams);
  expect(target.searchParams.has("offset")).toBe(false);
  return target;
}

/**
 * Follow server Links from `query` (which must carry an explicit limit and no
 * offset) and prove the exact page sequence, ending on a terminal page with
 * null cursor and no Link — never requiring an extra empty request.
 */
async function traverse(resource: Resource, query: Query, expectedPages: number[][]) {
  const ids = (body: Body) => body.rows.map((r) => r[resource.id]);
  let current = await page(resource, query);
  const seen: unknown[] = [];
  for (let index = 0; index < expectedPages.length; index++) {
    const expected = expectedPages[index];
    expect(ids(current.body), `page ${index}`).toEqual(expected);
    expect(current.body.rows.length).toBeLessThanOrEqual(Number(query.limit));
    seen.push(...ids(current.body));
    if (index === expectedPages.length - 1) {
      expect(current.body.nextCursor, "exact terminal page must not signal a next page").toBeNull();
      expect(current.response.headers.get("link")).toBeNull();
    } else {
      const cursor = expected[expected.length - 1];
      expect(current.body.nextCursor, "cursor is the last RETURNED id, never the lookahead row").toBe(cursor);
      const target = nextTarget(current.response, current.url, resource, { ...query, cursor: String(cursor) });
      current = await page(resource, target);
    }
  }
  expect(seen).toEqual(expectedPages.flat());
  expect(new Set(seen).size, "no row duplicated across pages").toBe(seen.length);
  return seen;
}

async function clearTables() {
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
}

/** Contiguous ids 1..n in all three tables, for exact cohort-size cases. */
async function seedCount(n: number) {
  await clearTables();
  const db = TEST_ENV.CUSTOMER_DB;
  let pending: D1PreparedStatement[] = [];
  const flush = async () => {
    if (pending.length > 0) { await db.batch(pending); pending = []; }
  };
  for (let id = 1; id <= n; id++) {
    pending.push(
      db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, 1, 'synthetic')")
        .bind(id, `synthetic-row-${id}`),
      db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, ?, 1, 'synthetic')")
        .bind(id, id, `synthetic-row-${id}`),
      db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, enabled, synced_at) VALUES (?, ?, ?, ?, 1, 'synthetic')")
        .bind(id, id, `synthetic-row-${id}`, `synthetic-serial-${id}`)
    );
    if (pending.length >= 60) await flush();
  }
  await flush();
}

beforeAll(async () => {
  await ensureD1TestTables();
});

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound fetch in exactNext acceptance"); }));
  await clearTables();
  const db = TEST_ENV.CUSTOMER_DB;
  for (let i = 0; i < IDS.length; i++) {
    const id = IDS[i];
    const label = `synthetic-${NEEDLE_TEXT[i] ? "needle" : "other"}-${id}`;
    await db.batch([
      db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, ?, 'synthetic')")
        .bind(id, label, ENABLED[i]),
      db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, ?, ?, 'synthetic')")
        .bind(id, OWNERS[i], label, ENABLED[i]),
      db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, enabled, synced_at) VALUES (?, ?, ?, ?, ?, 'synthetic')")
        .bind(id, id, label, `serial-${NEEDLE_SERIAL[i] ? "needle" : "other"}-${id}`, ENABLED[i])
    ]);
  }
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(RESOURCES)("$name snapshot: exactNext cohort sizes", (resource) => {
  const exact = { exactNext: "true", includeTotal: "false", fields: `${resource.id},enabled` };

  it.each([
    ["0 matches", 0, [[]]],
    ["limit-1 matches", 1, [[1]]],
    ["exactly limit matches (the false positive this opt-in removes)", 2, [[1, 2]]],
    ["limit+1 matches (lookahead row starts page 2)", 3, [[1, 2], [3]]],
    ["2*limit matches (second page is exact-terminal)", 4, [[1, 2], [3, 4]]]
  ] as const)("%s at limit=2: complete distinct traversal, exact terminal", async (_label, n, pages) => {
    await seedCount(n);
    await traverse(resource, { ...exact, limit: "2" }, pages as unknown as number[][]);
  });

  it.each([
    ["exactly limit matches", 1, [[1]]],
    ["limit+1 matches", 2, [[1], [2]]],
    ["2*limit matches", 2, [[1], [2]]]
  ] as const)("%s at limit=1", async (_label, n, pages) => {
    await seedCount(n);
    await traverse(resource, { ...exact, limit: "1" }, pages as unknown as number[][]);
  });

  it("at limit=500 fetches at most 501 rows and knows 500 is terminal, 501 is not", async () => {
    await seedCount(500);
    const terminal = await page(resource, { ...exact, limit: "500" });
    expect(terminal.body.rows).toHaveLength(500);
    expect(terminal.body.rows.map((r) => r[resource.id])).toEqual(Array.from({ length: 500 }, (_, i) => i + 1));
    expect(terminal.body.nextCursor).toBeNull();
    expect(terminal.response.headers.get("link")).toBeNull();
    expect(terminal.recorder.fetched).toEqual([500]);
    const terminalPageStmt = terminal.recorder.statements.find((s) => !isCount(s))!;
    expect(terminalPageStmt.binds).toContain(501);
    expect(terminalPageStmt.binds).not.toContain(502);

    await seedCount(501);
    const first = await page(resource, { ...exact, limit: "500" });
    expect(first.body.rows).toHaveLength(500);
    expect(first.body.nextCursor).toBe(500);
    expect(first.recorder.fetched).toEqual([501]);
    const target = nextTarget(first.response, first.url, resource, { ...exact, limit: "500", cursor: "500" });
    const last = await page(resource, target);
    expect(last.body.rows.map((r) => r[resource.id])).toEqual([501]);
    expect(last.body.nextCursor).toBeNull();
    expect(last.response.headers.get("link")).toBeNull();
    expect(last.recorder.fetched).toEqual([1]);
  });

  it("carries the effective default limit (50) plus exactNext=true on the link", async () => {
    await seedCount(51);
    const first = await page(resource, { ...exact });
    expect(first.body.rows).toHaveLength(50);
    expect(first.body.nextCursor).toBe(50);
    expect(first.recorder.fetched).toEqual([51]);
    const target = nextTarget(first.response, first.url, resource, { ...exact, limit: "50", cursor: "50" });
    const last = await page(resource, target);
    expect(last.body.rows.map((r) => r[resource.id])).toEqual([51]);
    expect(last.body.nextCursor).toBeNull();

    await seedCount(50);
    const only = await page(resource, { ...exact });
    expect(only.body.rows).toHaveLength(50);
    expect(only.body.nextCursor).toBeNull();
    expect(only.response.headers.get("link")).toBeNull();
  });
});

describe.each(RESOURCES)("$name snapshot: exactNext traversal semantics", (resource) => {
  const fields = `${resource.id},enabled`;

  it("traverses ascending and descending with an exact terminal page (no empty request)", async () => {
    await traverse(resource,
      { exactNext: "true", includeTotal: "false", fields, limit: "2" },
      [[11, 23], [37, 42], [58, 91]]);
    await traverse(resource,
      { exactNext: "true", includeTotal: "false", fields, limit: "2", order: "desc" },
      [[91, 58], [42, 37], [23, 11]]);
  });

  it("converts an offset first page to seek continuation and never puts OFFSET in seek SQL", async () => {
    const query = { exactNext: "true", includeTotal: "false", fields, limit: "2" };
    const first = await page(resource, { ...query, offset: "2" });
    expect(first.body.rows.map((r) => r[resource.id])).toEqual([37, 42]);
    expect(first.body.nextCursor).toBe(42);
    const target = nextTarget(first.response, first.url, resource, { ...query, cursor: "42" });
    const last = await page(resource, target);
    expect(last.body.rows.map((r) => r[resource.id])).toEqual([58, 91]);
    expect(last.body.nextCursor).toBeNull();
    expect(last.response.headers.get("link")).toBeNull();
    for (const s of last.recorder.statements) expect(s.sql).not.toMatch(/\bOFFSET\b/i);
  });

  it("keeps counted totals cursor-relative and unchanged while exactNext only fixes the signal", async () => {
    const query = { exactNext: "true", fields, limit: "2" };
    const first = await page(resource, query);
    expect(first.body.total).toBe(6);
    expect(first.body.nextCursor).toBe(23);
    const last = await page(resource,
      nextTarget(first.response, first.url, resource, { ...query, cursor: "23" }));
    // Follow through the middle page to the exact terminal page.
    expect(last.body.rows.map((r) => r[resource.id])).toEqual([37, 42]);
    expect(last.body.total).toBe(4);
    const terminal = await page(resource,
      nextTarget(last.response, last.url, resource, { ...query, cursor: "42" }));
    expect(terminal.body.rows.map((r) => r[resource.id])).toEqual([58, 91]);
    expect(terminal.body.total).toBe(2);
    expect(terminal.body.nextCursor).toBeNull();
    expect(terminal.response.headers.get("link")).toBeNull();
  });

  it("lookahead respects upperId: rows above the cap never create a next signal", async () => {
    await traverse(resource,
      { exactNext: "true", includeTotal: "false", fields, limit: "2", upperId: "42" },
      [[11, 23], [37, 42]]);
    await traverse(resource,
      { exactNext: "true", includeTotal: "false", fields, limit: "2", upperId: "58", order: "desc" },
      [[58, 42], [37, 23], [11]]);
  });

  it("lookahead respects filters: a filtered-out row after the cohort is not a next page", async () => {
    // Enabled cohort is exactly [11,23,37,58]; disabled 91 follows it.
    await traverse(resource,
      { exactNext: "true", includeTotal: "false", fields, limit: "2", enabled: "true" },
      [[11, 23], [37, 58]]);
    // q cohort: customer/address [23,58]; container adds 37 via serial_number.
    await traverse(resource,
      { exactNext: "true", includeTotal: "false", fields, limit: "2", q: "needle" },
      resource.name === "container" ? [[23, 37], [58]] : [[23, 58]]);
  });

  it("lookahead respects identity selectors, including the container address join", async () => {
    // customerId=11: customer selects itself; address/container reach [11,23,91].
    await traverse(resource,
      { exactNext: "true", includeTotal: "false", fields, limit: "3", customerId: "11" },
      resource.name === "customer" ? [[11]] : [[11, 23, 91]]);
    if (resource.name === "address") {
      await traverse(resource,
        { exactNext: "true", includeTotal: "false", fields, limit: "1", pickupAddressId: "23" },
        [[23]]);
    }
    if (resource.name === "container") {
      await traverse(resource,
        { exactNext: "true", includeTotal: "false", fields, limit: "1", containerId: "37" },
        [[37]]);
      await traverse(resource,
        { exactNext: "true", includeTotal: "false", fields, limit: "1", customerId: "11", pickupAddressId: "23" },
        [[23]]);
    }
  });

  it("lookahead respects an unsorted ids selection and retains it in the link", async () => {
    const query = { exactNext: "true", includeTotal: "false", fields, limit: "2", ids: "91,23,42" };
    const first = await page(resource, query);
    expect(first.body.rows.map((r) => r[resource.id])).toEqual([23, 42]);
    expect(first.body.nextCursor).toBe(42);
    const link = first.response.headers.get("link") ?? "";
    const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link)![1], first.url);
    // The ids oracle owns member order in links; here the selection must survive.
    expect(target.searchParams.get("ids")!.split(",").sort()).toEqual(["23", "42", "91"]);
    expect(target.searchParams.get("exactNext")).toBe("true");
    expect(target.searchParams.get("cursor")).toBe("42");
    expect(target.searchParams.has("offset")).toBe(false);
    const last = await page(resource, target);
    expect(last.body.rows.map((r) => r[resource.id])).toEqual([91]);
    expect(last.body.nextCursor).toBeNull();
    expect(last.response.headers.get("link")).toBeNull();
  });

  it("still rejects duplicate ids before D1 even with exactNext=true", async () => {
    const db = forbiddenDb();
    const result = await request(resource.path, { exactNext: "true", ids: "23,23" }, { db: db.db });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("link")).toBeNull();
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it("slices the lookahead before field projection; cursor uses the canonical id fields omitted", async () => {
    const query = { exactNext: "true", includeTotal: "false", fields: resource.text, limit: "2" };
    const first = await page(resource, query);
    // The primary id is always present; the lookahead row (37) must not appear.
    expect(first.body.rows).toEqual([
      { [resource.id]: 11, [resource.text]: "synthetic-other-11" },
      { [resource.id]: 23, [resource.text]: "synthetic-needle-23" }
    ]);
    expect(first.body.nextCursor).toBe(23);
    const second = await page(resource,
      nextTarget(first.response, first.url, resource, { ...query, cursor: "23" }));
    expect(second.body.rows.map((r) => r[resource.id])).toEqual([37, 42]);
    expect(second.body.nextCursor).toBe(42);
  });

  it("retains exactNext=true in links but never propagates unknown keys or credentials", async () => {
    const clean = { exactNext: "true", includeTotal: "false", fields, limit: "1" };
    const baseline = await page(resource, clean);
    const tainted = await page(resource, {
      ...clean,
      bogus_param: "unknown-marker",
      authorization: "Bearer query-credential-marker",
      token: "query-token-marker"
    }, {
      host: "host-marker.invalid",
      "x-forwarded-host": "x-forwarded-marker.invalid",
      origin: "https://origin-marker.invalid"
    });
    expect(tainted.bytes).toBe(baseline.bytes);
    expect(tainted.response.headers.get("link")).toBe(baseline.response.headers.get("link"));
    expect(tainted.response.headers.get("link")).not.toMatch(/marker|Bearer|test-read-token|https?:|\/\//);
    nextTarget(tainted.response, tainted.url, resource, { ...clean, cursor: "11" });
  });
});

describe.each(RESOURCES)("$name snapshot: exactNext statement contract", (resource) => {
  it("reuses the default page SQL with only a limit+1 bind (offset and seek), COUNT untouched", async () => {
    const dfltOffset = await page(resource, { limit: "2" });
    const exactOffset = await page(resource, { limit: "2", exactNext: "true" });
    const pageOf = (r: Awaited<ReturnType<typeof page>>) => r.recorder.statements.find((s) => !isCount(s))!;
    const countOf = (r: Awaited<ReturnType<typeof page>>) => r.recorder.statements.find(isCount)!;
    expect(pageOf(exactOffset).sql).toBe(pageOf(dfltOffset).sql);
    expect(pageOf(dfltOffset).binds).toEqual([2, 0]);
    expect(pageOf(exactOffset).binds).toEqual([3, 0]);
    expect(exactOffset.recorder.fetched).toEqual([3]);
    expect(countOf(exactOffset)).toEqual(countOf(dfltOffset));

    const dfltSeek = await page(resource, { limit: "2", cursor: "23", includeTotal: "false" });
    const exactSeek = await page(resource, { limit: "2", cursor: "23", includeTotal: "false", exactNext: "true" });
    expect(pageOf(exactSeek).sql).toBe(pageOf(dfltSeek).sql);
    expect(pageOf(exactSeek).sql).not.toMatch(/\bOFFSET\b/i);
    expect(pageOf(dfltSeek).binds).toEqual([23, 2]);
    expect(pageOf(exactSeek).binds).toEqual([23, 3]);
    expect(exactSeek.recorder.statements.filter(isCount)).toEqual([]);
    expect(exactSeek.body.total).toBeNull();
  });

  it.each([
    ["bare full terminal page keeps the accepted false positive", { limit: "2", offset: "4" }],
    ["seek full terminal page", { limit: "2", cursor: "42" }],
    ["descending seek", { limit: "2", cursor: "58", order: "desc" }],
    ["filtered count-free", { limit: "2", enabled: "true", includeTotal: "false" }],
    ["sparse fields", { limit: "2", fields: "enabled" }],
    ["upperId cap", { limit: "2", upperId: "42" }]
  ] as const)("omitted and exactNext=false are byte- and SQL-identical to today: %s", async (_label, query) => {
    const omitted = await page(resource, query);
    const explicit = await page(resource, { ...query, exactNext: "false" });
    expect(explicit.bytes).toBe(omitted.bytes);
    expect(explicit.recorder.statements).toEqual(omitted.recorder.statements);
    expect(explicit.recorder.fetched).toEqual(omitted.recorder.fetched);
    expect(explicit.response.headers.get("link")).toBe(omitted.response.headers.get("link"));
    // No lookahead fetch in default mode: fetched rows are exactly the page.
    expect(omitted.recorder.fetched).toEqual([omitted.body.rows.length]);
    // False/default is omitted from any next link, never spelled out.
    expect(omitted.response.headers.get("link") ?? "").not.toContain("exactNext");
  });

  it("default mode still links a full terminal page to an empty page (unchanged policy)", async () => {
    let current = await page(resource, { limit: "2", includeTotal: "false", fields: `${resource.id},enabled` });
    const seenPages: number[][] = [];
    for (let i = 0; i < 4; i++) {
      seenPages.push(current.body.rows.map((r) => r[resource.id]) as number[]);
      if (current.body.nextCursor === null) break;
      const target = new URL(/^<([^>]+)>/.exec(current.response.headers.get("link")!)![1], current.url);
      expect(target.searchParams.has("exactNext")).toBe(false);
      current = await page(resource, target);
    }
    expect(seenPages).toEqual([[11, 23], [37, 42], [58, 91], []]);
  });
});

describe.each(RESOURCES)("$name snapshot: exactNext conditional requests", (resource) => {
  async function validator(bytes: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
    return `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
  }

  it("ETag is over the sliced page; 304 keeps Link parity on non-terminal and terminal pages", async () => {
    const query = { exactNext: "true", includeTotal: "false", limit: "2", fields: `${resource.id},enabled` };
    const first = await page(resource, query);
    const tag = await validator(first.bytes);
    expect(first.response.headers.get("etag"), "hash the served (sliced) bytes, not the lookahead row").toBe(tag);

    const conditional = await request(resource.path, query, { headers: { "if-none-match": tag } });
    expect(conditional.response.status).toBe(304);
    expect((await conditional.response.arrayBuffer()).byteLength).toBe(0);
    expect(conditional.response.headers.get("etag")).toBe(tag);
    expect(conditional.response.headers.get("cache-control")).toBe("no-store");
    expect(conditional.response.headers.get("link")).toBe(first.response.headers.get("link"));
    // Conditional success saves bytes, never D1 work.
    expect(conditional.recorder.statements).toEqual(first.recorder.statements);

    // Exact terminal page: no Link on either the 200 or its 304.
    const terminalQuery = { ...query, cursor: "42" };
    const terminal = await page(resource, terminalQuery);
    expect(terminal.body.nextCursor).toBeNull();
    expect(terminal.response.headers.get("link")).toBeNull();
    const terminalTag = await validator(terminal.bytes);
    expect(terminal.response.headers.get("etag")).toBe(terminalTag);
    const terminal304 = await request(resource.path, terminalQuery, { headers: { "if-none-match": terminalTag } });
    expect(terminal304.response.status).toBe(304);
    expect(terminal304.response.headers.get("etag")).toBe(terminalTag);
    expect(terminal304.response.headers.get("link")).toBeNull();
  });

  it("the default page's validator does not match the exact terminal representation", async () => {
    const base = { includeTotal: "false", limit: "2", cursor: "42", fields: `${resource.id},enabled` };
    const dflt = await page(resource, base);
    expect(dflt.body.nextCursor).toBe(91); // accepted false positive, default only
    const exact = await request(resource.path, { ...base, exactNext: "true" },
      { headers: { "if-none-match": dflt.response.headers.get("etag")! } });
    expect(exact.response.status).toBe(200);
    const body = await exact.response.json() as Body;
    expect(body.nextCursor).toBeNull();
    expect(exact.response.headers.get("link")).toBeNull();
  });
});

describe.each(RESOURCES)("$name snapshot: exactNext validation and auth", (resource) => {
  it.each([
    ["empty string", "exactNext="],
    ["upper-case TRUE", "exactNext=TRUE"],
    ["capitalised False", "exactNext=False"],
    ["numeric 1", "exactNext=1"],
    ["numeric 0", "exactNext=0"],
    ["yes", "exactNext=yes"],
    ["trailing space", "exactNext=true%20"],
    ["comma list", "exactNext=true%2Cfalse"],
    ["marker value", "exactNext=secret-exact-marker"],
    ["repeated differing", "exactNext=true&exactNext=false"],
    ["repeated identical", "exactNext=true&exactNext=true"],
    ["repeated with empty first", "exactNext=&exactNext=true"]
  ] as const)("rejects %s with a value-free 400 before any D1 access", async (_label, search) => {
    const db = forbiddenDb();
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((m) => vi.spyOn(console, m));
    const response = await app.fetch(
      new Request(`${ORIGIN}${resource.path}?${search}`, { headers: { authorization: `Bearer ${READ_TOKEN}` } }),
      { ...TEST_ENV, CUSTOMER_DB: db.db }
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("link")).toBeNull();
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail: "Invalid request query (exactNext). See docs/PROBLEMS.md#bad-request."
    });
    expect(text).not.toContain("secret-exact-marker");
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each(["exactNext=true", "exactNext=secret-exact-marker", "exactNext=true&exactNext=false"])(
    "auth precedes exactNext validation and D1: %s", async (search) => {
      for (const token of [null, "synthetic-invalid-token"]) {
        const db = forbiddenDb();
        const headers = new Headers();
        if (token !== null) headers.set("authorization", `Bearer ${token}`);
        const response = await app.fetch(
          new Request(`${ORIGIN}${resource.path}?${search}`, { headers }),
          { ...TEST_ENV, CUSTOMER_DB: db.db }
        );
        expect(response.status).toBe(401);
        expect(response.headers.get("content-type")).toContain("application/problem+json");
        expect(response.headers.get("link")).toBeNull();
        expect(await response.text()).not.toContain("secret-exact-marker");
        expect(db.prepare).not.toHaveBeenCalled();
      }
    });

  it("does not attach a continuation to a D1 error in exact mode", async () => {
    const prepare = vi.fn(() => { throw new Error("synthetic database failure"); });
    const result = await request(resource.path, { limit: "1", exactNext: "true" },
      { db: { prepare } as unknown as D1Database });
    expect(result.response.status).toBe(500);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("link")).toBeNull();
  });
});

describe("exactNext mounted contract and docs", () => {
  type Param = {
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    example?: unknown;
    schema?: { type?: unknown; enum?: unknown[]; default?: unknown; description?: string; example?: unknown };
  };
  type Doc = {
    paths: Record<string, { get?: { parameters?: Param[]; responses?: Record<string, { description?: string }> } }>;
  };

  async function openApi(): Promise<Doc> {
    const res = await exports.default.fetch(`${ORIGIN}/openapi.json`);
    expect(res.status).toBe(200);
    return (await res.json()) as Doc;
  }

  it("publishes one identical optional exact true|false parameter, after includeTotal, on the three lists", async () => {
    const doc = await openApi();
    const params = RESOURCES.map((resource) => {
      const parameters = doc.paths[resource.path]?.get?.parameters ?? [];
      const param = parameters.find((p) => p.name === "exactNext");
      expect(param, resource.path).toMatchObject({
        in: "query",
        required: false,
        schema: { type: "string", enum: ["true", "false"], default: "false" }
      });
      expect(param?.example ?? param?.schema?.example, resource.path).toBe("true");
      const description = `${param?.description ?? ""} ${param?.schema?.description ?? ""}`;
      expect(description, resource.path).toMatch(/opt[- ]in|exactNext=true/i);
      expect(description, resource.path).toMatch(/lookahead|limit\s*\+\s*1|one (?:extra|additional) row/i);
      expect(description, resource.path).toMatch(/default/i);
      expect(description, resource.path).toMatch(/empty page|terminal|false positive/i);
      // No snapshot-isolation claim: later pages can still change under the caller.
      expect(description, resource.path).toMatch(/concurren|isolation|insert|delete/i);
      const names = parameters.map((p) => p.name);
      expect(names.indexOf("exactNext"), `${resource.path} mounted order`).toBe(names.indexOf("includeTotal") + 1);
      expect(doc.paths[resource.path]?.get?.responses?.["400"]?.description, resource.path).toMatch(/exactNext/);
      return param;
    });
    expect(params[1]).toEqual(params[0]);
    expect(params[2]).toEqual(params[0]);
  });

  it("adds exactNext nowhere else: not the changes feed, by-id reads or exports", async () => {
    const doc = await openApi();
    for (const path of [
      "/api/v1/customer-snapshot/changes",
      "/api/v1/customer-snapshot/{customerId}",
      "/api/v1/address-snapshot/{pickupAddressId}",
      "/api/v1/container-snapshot/{containerId}",
      "/api/v1/customer-snapshot/export",
      "/api/v1/address-snapshot/export",
      "/api/v1/container-snapshot/export"
    ]) {
      const names = (doc.paths[path]?.get?.parameters ?? []).map((p) => p.name);
      expect(names, path).not.toContain("exactNext");
    }
  });

  it("lists exactNext in the query-policy inventory for the three ordinary lists with guidance", () => {
    const row = (path: string) =>
      policyDoc.split("\n").find((line) => line.startsWith(`| \`${path}\` |`)) ?? "";
    for (const resource of RESOURCES) {
      expect(row(resource.path), resource.path).toContain("`exactNext`");
    }
    expect(row("/api/v1/customer-snapshot/changes")).not.toContain("exactNext");
    expect(policyDoc).toContain("test/snapshotExactNext.acceptance.test.ts");
    expect(policyDoc).toContain("npm run check:snapshot-exact-next");
    expect(policyDoc).toMatch(/exactNext[\s\S]{0,400}(?:concurren|isolation)/i);
  });

  it("shows a synthetic credential-free quickstart example and a changelog entry", () => {
    const blocks = [...quickstartDoc.matchAll(/^```(?:bash|sh)\n([\s\S]*?)^```/gm)].map((m) => m[1]);
    const block = blocks.find((b) => b.includes("exactNext=true"));
    expect(block).toBeDefined();
    expect(block).toMatch(/\/api\/v1\/(?:customer|address|container)-snapshot/);
    expect(block).toContain("localhost:8787");
    expect(block).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
    const entries = changelog.split(/\n-\s+/).filter((entry) => entry.includes("exactNext"));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.join(" ")).toMatch(/opt[- ]in/i);
  });

  it("wires the focused local check to this oracle", () => {
    const scripts = (JSON.parse(packageJsonRaw) as { scripts: Record<string, string> }).scripts;
    expect(scripts["check:snapshot-exact-next"]).toContain("test/snapshotExactNext.acceptance.test.ts");
  });
});
