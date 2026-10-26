/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import snapshotDoc from "../CUSTOMER_SNAPSHOT.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import changelog from "../CHANGELOG.md?raw";
import packageJson from "../package.json";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-author-owned contract, written without implementation diffs.
 * Run: npx vitest run --maxWorkers=2 test/customerSyncedWindow.acceptance.test.ts
 *
 * Contract: the ordinary customer snapshot list GET only gains optional
 * `syncedSince` (strict: stored synced_at > normalized instant) and
 * `syncedUntil` (inclusive: stored synced_at <= normalized instant), validated
 * and normalized by exactly the shared UTC-Z millisecond chain the changes
 * feed uses (seconds or 1-3 fractional digits, calendar-valid, normalized to
 * toISOString() milliseconds, never rounded/truncated). Unlike the changes
 * feed's legacy empty-`since`, an EMPTY value for either new bound is a 400.
 * Normalized since must not exceed normalized until; equal bounds are a valid
 * empty 200. Ordering/cursors stay the list's customer_id keyset contract:
 * this is a filter over current mirrored rows, not a changes feed, not a
 * deletion history and not snapshot isolation; complete-delta consumers
 * belong on /api/v1/customer-snapshot/changes. Stored synced_at is mirror
 * freshness, not upstream event time or proof of change content.
 *
 * Hand-derived fixture oracle (all synthetic; address stamps are all LATE so
 * only the CUSTOMER row's stored synced_at can qualify it):
 * 11 enabled  Needle BEFORE  site 101 (route 7, franchise 001, enabled)
 * 12 enabled  Needle ZERO    site 102 (route 7, franchise 001, enabled)
 * 13 disabled Other  TENTH   no sites
 * 14 enabled  Needle MID     site 103 (route 8, franchise 001, disabled)
 * 15 enabled  Needle UPPER   site 104 (route 7, franchise 001, enabled)
 * 16 disabled Other  UPPER   no sites (upper-bound tie with 15)
 * 17 enabled  Needle AFTER   site 105 (route 7, franchise 001, enabled)
 * 18 enabled  Needle LATE    no sites
 * Window (ZERO, UPPER] = [13,14,15,16]: at-since 12 excluded, at-until 15/16 in.
 *
 * Mutations caught: inclusive/strict bound swapped; raw (unnormalized)
 * lexical comparison of .1Z/seconds forms; rounding/truncating overprecise
 * input instead of rejecting; empty bound treated as epoch/unbounded (the
 * changes-feed leniency leaking into new parameters); a forked timestamp
 * parser with different calendar/offset rules; reversed-bounds accepted or
 * checked pre-normalization; (synced_at, id) ordering or composite cursors;
 * divergent COUNT/page predicates or binds; bounds dropped or left
 * unnormalized in next Links; bounds leaking onto sibling lists or the
 * changes feed; validation after D1/304 or before auth; reflected values.
 *
 * Every read executes against migrated local D1. Fetch and R2 are denied;
 * the recording wrapper refuses non-SELECT work, so a green run also proves
 * zero writes. No production/staging calls or real PII. EXPLAIN evidence is
 * local planner evidence only: the predicates may scan and no index or
 * latency is promised. GET is an idempotent local read; CLI --dry-run is
 * not applicable. Intentional RED handoff: Builder consumes the commit
 * without editing this file. Oracle corrections belong to the Test Author.
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/customer-snapshot";
const CHANGES_PATH = "/api/v1/customer-snapshot/changes";
const ORIGIN = "https://customer-synced-window.invalid";
const TOKEN = "test-read-token";
const PROBLEM_TYPE = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
const BEFORE = "2026-08-31T23:59:59.999Z";
const ZERO = "2026-09-01T00:00:00.000Z";
const TENTH = "2026-09-01T00:00:00.100Z";
const MID = "2026-09-01T00:00:00.250Z";
const UPPER = "2026-09-01T00:00:00.500Z";
const AFTER = "2026-09-01T00:00:00.501Z";
const LATE = "2026-09-02T00:00:00.000Z";
const ALL = [11, 12, 13, 14, 15, 16, 17, 18];
const WINDOW = [13, 14, 15, 16];
const WINDOW_QUERY = { syncedSince: ZERO, syncedUntil: UPPER };
const ROW_COLUMNS = [
  "comments", "customer_id", "customer_number", "customer_type_id", "enabled",
  "first_name", "last_name", "middle_initial", "name_suffix", "phone1",
  "phone2", "sub_customer_number", "synced_at", "company_name"
].sort();
type Query = Record<string, string | number>;
type Statement = { sql: string; binds: unknown[]; method: string };
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };

function recordDb() {
  const statements: Statement[] = [];
  function wrap(real: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return new Proxy(real, {
      get(target, member) {
        const value = Reflect.get(target, member, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (member === "bind") return wrap(Reflect.apply(value, target, args), sql, args);
          statements.push({ sql, binds, method: String(member) });
          if (!["first", "all", "raw"].includes(String(member)) || !/^\s*SELECT\b/i.test(sql)) {
            throw new Error("Customer synced-window list must only execute SELECT reads");
          }
          return Reflect.apply(value, target, args);
        };
      }
    });
  }
  const db = {
    prepare: (sql: string) => wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []),
    batch: () => { throw new Error("List must not hide additional D1 work in batch"); },
    exec: () => { throw new Error("List must not exec D1 work"); }
  } as unknown as D1Database;
  return { db, statements };
}

function forbiddenDb() {
  const calls: string[] = [];
  const db = new Proxy({}, {
    get(_target, member) {
      return () => { calls.push(String(member)); throw new Error("Rejected request touched D1"); };
    }
  }) as D1Database;
  return { db, calls };
}

const r2Calls: string[] = [];
const deniedR2 = new Proxy({}, {
  get(_target, member) {
    return () => { r2Calls.push(String(member)); throw new Error("Local list touched R2"); };
  }
}) as R2Bucket;
const qs = (q: Query) => new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();
const ids = (body: Body) => body.rows.map((row) => row.customer_id);

async function request(search = "", options: {
  token?: string | null; headers?: Record<string, string>; db?: D1Database; path?: string;
} = {}) {
  const recorder = recordDb();
  const headers = new Headers(options.headers);
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const path = options.path ?? PATH;
  const url = new URL(search ? `${path}?${search}` : path, ORIGIN);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: options.db ?? recorder.db, SNAPSHOTS: deniedR2
  });
  return { response, url, recorder };
}

async function readPage(search: string) {
  const result = await request(search);
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  const bytes = await result.response.clone().text();
  const body = JSON.parse(bytes) as Body;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  const expectedTag = `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
  expect(result.response.headers.get("etag")).toBe(expectedTag);
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const params = new URLSearchParams(search);
  const counted = params.get("includeTotal") !== "false";
  const countOnly = params.get("countOnly") === "true";
  if (countOnly) {
    expect(body.rows).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.recorder.statements).toHaveLength(1);
    expect(result.recorder.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(1);
  } else {
    expect(result.recorder.statements).toHaveLength(counted ? 2 : 1);
    expect(result.recorder.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(counted ? 1 : 0);
    if (!counted) expect(body.total).toBeNull();
  }
  expect(new Set(ids(body)).size).toBe(body.rows.length);
  for (const row of body.rows) {
    expect(typeof row.customer_id).toBe("number");
    expect(row).not.toHaveProperty("addresses");
  }
  return { ...result, body, bytes };
}
const page = (query: Query = {}) => readPage(qs(query));

function nextTarget(result: Awaited<ReturnType<typeof page>>, expected: Query) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/customer-snapshot\?[^<>\s]*>; rel="next"$/);
  const raw = /^<([^>]+)>; rel="next"$/.exec(link!)![1];
  const target = new URL(raw, result.url);
  expect(target.origin).toBe(ORIGIN);
  expect(target.pathname).toBe(PATH);
  expect(target.hash + target.username + target.password).toBe("");
  const actual = new URLSearchParams(target.search);
  if (expected.includeTotal !== "false") {
    expect([null, "true"]).toContain(actual.get("includeTotal"));
    expect(actual.getAll("includeTotal").length).toBeLessThanOrEqual(1);
    actual.delete("includeTotal");
  }
  expect([...actual.keys()]).toHaveLength(Object.keys(expected).length);
  expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, String(v)])));
  expect(actual.has("offset")).toBe(false);
  return target;
}

function expectPage(result: Awaited<ReturnType<typeof page>>, want: number[], total: number | null, next: number | null = null) {
  expect(ids(result.body)).toEqual(want);
  expect(result.body.total).toBe(total);
  expect(result.body.nextCursor).toBe(next);
  if (next === null) expect(result.response.headers.get("link")).toBeNull();
}

const FIXTURES: Array<[number, number, string, string]> = [
  [11, 1, "Synthetic Needle Eleven", BEFORE],
  [12, 1, "Synthetic Needle Twelve", ZERO],
  [13, 0, "Synthetic Other Thirteen", TENTH],
  [14, 1, "Synthetic Needle Fourteen", MID],
  [15, 1, "Synthetic Needle Fifteen", UPPER],
  [16, 0, "Synthetic Other Sixteen", UPPER],
  [17, 1, "Synthetic Needle Seventeen", AFTER],
  [18, 1, "Synthetic Needle Eighteen", LATE]
];

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  r2Calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound fetch in synced-window acceptance"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  for (const [id, enabled, company, stamp] of FIXTURES) {
    await db.prepare("INSERT INTO customer_snapshot (customer_id, enabled, company_name, first_name, last_name, customer_number, sub_customer_number, phone1, comments, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, enabled, company, "Local", "Fixture", `CUST-${id}`, `SUB-${id}`, `55501${id}`, `Synthetic window ${id}`, stamp).run();
  }
  // Address rows all carry LATE: only the customer row's own stored
  // synced_at may qualify it, never a child's stamp.
  for (const [id, owner, route, franchise, enabled] of [
    [101, 11, 7, "001", 1], [102, 12, 7, "001", 1], [103, 14, 8, "001", 0],
    [104, 15, 7, "001", 1], [105, 17, 7, "001", 1]
  ] as const) {
    await db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, owner, route, franchise, enabled, LATE).run();
  }
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(r2Calls).toEqual([]);
    const stored = await TEST_ENV.CUSTOMER_DB.prepare(
      "SELECT customer_id, synced_at FROM customer_snapshot ORDER BY customer_id"
    ).all<{ customer_id: number; synced_at: string }>();
    expect(stored.results).toEqual(FIXTURES.map(([id, , , stamp]) => ({ customer_id: id, synced_at: stamp })));
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe("customer synced window selection", () => {
  it("both bounds select (since, until]: at-since excluded, at-until included, ties kept once", async () => {
    const result = await page(WINDOW_QUERY);
    expectPage(result, WINDOW, WINDOW.length);
    expect(Object.keys(result.body.rows[0]).sort()).toEqual(ROW_COLUMNS);
    expect(result.body.rows.map((r) => r.synced_at)).toEqual([TENTH, MID, UPPER, UPPER]);
  });

  it.each([
    ["since alone is strict at its instant", { syncedSince: ZERO }, [13, 14, 15, 16, 17, 18]],
    ["since at the earliest stamp excludes only that row", { syncedSince: BEFORE }, [12, 13, 14, 15, 16, 17, 18]],
    ["until alone is inclusive at its instant", { syncedUntil: UPPER }, [11, 12, 13, 14, 15, 16]],
    ["until at the earliest stamp keeps only that row", { syncedUntil: BEFORE }, [11]],
    ["until before every row is an empty 200", { syncedUntil: "2026-08-01T00:00:00.000Z" }, []],
    ["since at the latest stamp is an empty 200", { syncedSince: LATE }, []],
    ["equal bounds are valid and empty (strict lower, inclusive upper)", { syncedSince: ZERO, syncedUntil: ZERO }, []],
    ["equal bounds at a tied stamp are valid and empty", { syncedSince: UPPER, syncedUntil: UPPER }, []],
    ["leap-valid bound in the past keeps every row", { syncedSince: "2024-02-29T00:00:00Z" }, ALL]
  ] as Array<[string, Query, number[]]>)("%s", async (_label, query, want) => {
    expectPage(await page(query), want, want.length);
  });

  it("control: omission preserves the existing envelope, bytes and SQL with no synced_at predicate", async () => {
    const omitted = await page();
    expectPage(omitted, ALL, ALL.length);
    for (const statement of omitted.recorder.statements) {
      expect(statement.sql).not.toMatch(/synced_at\s*[<>]/i);
      expect(statement.binds).not.toContain(ZERO);
      expect(statement.binds).not.toContain(UPPER);
    }
  });

  it("ordering stays the customer_id keyset contract, never (synced_at, id)", async () => {
    const result = await page({ ...WINDOW_QUERY, order: "desc" });
    expectPage(result, [16, 15, 14, 13], 4);
    const select = result.recorder.statements.find((s) => !/\bCOUNT\s*\(/i.test(s.sql))!;
    expect(select.sql).toMatch(/ORDER BY customer_id/i);
    expect(select.sql).not.toMatch(/ORDER BY synced_at/i);
    expect(result.body.nextCursor).toBeNull();
  });

  it("a second identical GET is an idempotent local read", async () => {
    const first = await page(WINDOW_QUERY);
    const again = await page(WINDOW_QUERY);
    expect(again.bytes).toBe(first.bytes);
    expect(again.response.headers.get("etag")).toBe(first.response.headers.get("etag"));
    expect(again.recorder.statements).toEqual(first.recorder.statements);
  });
});

describe("customer synced window normalization", () => {
  it.each([
    ["seconds form since normalizes to .000Z", { syncedSince: "2026-09-01T00:00:00Z", syncedUntil: UPPER }, WINDOW],
    ["one-digit fraction until normalizes to .500Z", { syncedSince: ZERO, syncedUntil: "2026-09-01T00:00:00.5Z" }, WINDOW],
    ["two-digit fraction until normalizes to .500Z", { syncedSince: ZERO, syncedUntil: "2026-09-01T00:00:00.50Z" }, WINDOW],
    [".1Z since excludes the row stored at .100Z exactly", { syncedSince: "2026-09-01T00:00:00.1Z" }, [14, 15, 16, 17, 18]],
    [".12Z since normalizes to .120Z", { syncedSince: "2026-09-01T00:00:00.12Z", syncedUntil: UPPER }, [14, 15, 16]],
    ["seconds form until keeps rows at .000Z", { syncedUntil: "2026-09-01T00:00:00Z" }, [11, 12]]
  ] as Array<[string, Query, number[]]>)("%s", async (_label, query, want) => {
    expectPage(await page(query), want, want.length);
  });

  it("binds carry normalized milliseconds, never the raw submitted forms", async () => {
    const result = await page({ syncedSince: "2026-09-01T00:00:00Z", syncedUntil: "2026-09-01T00:00:00.5Z", limit: 2 });
    for (const statement of result.recorder.statements) {
      expect(statement.binds).toContain(ZERO);
      expect(statement.binds).toContain(UPPER);
      expect(statement.binds).not.toContain("2026-09-01T00:00:00Z");
      expect(statement.binds).not.toContain("2026-09-01T00:00:00.5Z");
      expect(statement.sql).not.toContain("2026-");
      expect(statement.sql).toMatch(/synced_at\s*>\s*\?/i);
      expect(statement.sql).toMatch(/synced_at\s*<=\s*\?/i);
    }
    const count = result.recorder.statements.find((s) => /\bCOUNT\s*\(/i.test(s.sql))!;
    const select = result.recorder.statements.find((s) => !/\bCOUNT\s*\(/i.test(s.sql))!;
    const where = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).replace(/\s+ORDER\s+BY[\s\S]*$/i, "").trim();
    expect(where(count.sql)).toBe(where(select.sql));
    expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
  });

  it("single-bound statements carry only that bound's predicate", async () => {
    const lowerOnly = await page({ syncedSince: ZERO });
    for (const s of lowerOnly.recorder.statements) {
      expect(s.sql).toMatch(/synced_at\s*>\s*\?/i);
      expect(s.sql).not.toMatch(/synced_at\s*<=\s*\?/i);
    }
    const upperOnly = await page({ syncedUntil: UPPER });
    for (const s of upperOnly.recorder.statements) {
      expect(s.sql).toMatch(/synced_at\s*<=\s*\?/i);
      expect(s.sql).not.toMatch(/synced_at\s*>\s*\?/i);
    }
  });

  it("produces a synthetic EXPLAIN plan for both statements (scan allowed, no index promised)", async () => {
    const result = await page({ ...WINDOW_QUERY, limit: 2 });
    for (const statement of result.recorder.statements) {
      const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.binds).all<{ detail: string }>();
      expect(plan.results.length).toBeGreaterThan(0);
      expect(plan.results.every((r) => typeof r.detail === "string")).toBe(true);
      expect(plan.results.map((r) => r.detail).join("\n")).toContain("customer_snapshot");
    }
  });
});

describe("customer synced window AND composition", () => {
  const cases: Array<[string, Query, number[]]> = [
    ["enabled=true", { ...WINDOW_QUERY, enabled: "true" }, [14, 15]],
    ["enabled=false", { ...WINDOW_QUERY, enabled: "false" }, [13, 16]],
    ["hasAddresses=true", { ...WINDOW_QUERY, hasAddresses: "true" }, [14, 15]],
    ["hasAddresses=false", { ...WINDOW_QUERY, hasAddresses: "false" }, [13, 16]],
    ["site cohort route", { ...WINDOW_QUERY, addressRouteId: 7 }, [15]],
    ["site cohort route+franchise same site", { ...WINDOW_QUERY, addressRouteId: 7, addressFranchiseId: "001" }, [15]],
    ["site cohort disabled site", { ...WINDOW_QUERY, addressEnabled: "false" }, [14]],
    ["hasContainers=false (no equipment seeded)", { ...WINDOW_QUERY, hasContainers: "false" }, WINDOW],
    ["hasContainers=true (no equipment seeded)", { ...WINDOW_QUERY, hasContainers: "true" }, []],
    ["customerId inside window", { ...WINDOW_QUERY, customerId: 14 }, [14]],
    ["customerId at excluded since instant", { ...WINDOW_QUERY, customerId: 12 }, []],
    ["ids intersect", { ...WINDOW_QUERY, ids: "12,13,17" }, [13]],
    ["q needle", { ...WINDOW_QUERY, q: "needle" }, [14, 15]],
    ["q other", { ...WINDOW_QUERY, q: "other" }, [13, 16]],
    ["exact customer number", { ...WINDOW_QUERY, customerNumber: "CUST-15" }, [15]],
    ["upperId ceiling inside window", { ...WINDOW_QUERY, upperId: 14 }, [13, 14]],
    ["lowerId floor inside window", { ...WINDOW_QUERY, lowerId: 15 }, [15, 16]],
    ["no text match", { ...WINDOW_QUERY, q: "synthetic-no-match" }, []]
  ];
  it.each(cases)("window with %s constrains both rows and total", async (_label, query, want) => {
    expectPage(await page(query), want, want.length);
  });
});

describe("customer synced window pagination, counts and projection", () => {
  it.each([
    ["asc seek", { ...WINDOW_QUERY, cursor: 13, limit: 2 }, [14, 15], 3, 15],
    ["desc first page", { ...WINDOW_QUERY, order: "desc", limit: 2 }, [16, 15], 4, 15],
    ["desc seek", { ...WINDOW_QUERY, order: "desc", cursor: 15, limit: 2 }, [14, 13], 2, 13],
    ["cursor wins over offset", { ...WINDOW_QUERY, cursor: 13, offset: 99, limit: 5 }, [14, 15, 16], 3, null],
    ["offset middle", { ...WINDOW_QUERY, offset: 1, limit: 2 }, [14, 15], 4, 15],
    ["offset partial end", { ...WINDOW_QUERY, offset: 3, limit: 2 }, [16], 4, null],
    ["offset empty end", { ...WINDOW_QUERY, offset: 4, limit: 1 }, [], 4, null]
  ] as Array<[string, Query, number[], number, number | null]>)("%s preserves seek/offset semantics", async (_label, query, want, total, next) => {
    expectPage(await page(query), want, total, next);
  });

  it("count-free uses one SELECT, no COUNT, same rows and nextCursor as counted", async () => {
    const counted = await page({ ...WINDOW_QUERY, limit: 2 });
    const free = await page({ ...WINDOW_QUERY, limit: 2, includeTotal: "false" });
    expectPage(free, [13, 14], null, 14);
    expect(free.body.rows).toEqual(counted.body.rows);
    expect(free.body.nextCursor).toBe(counted.body.nextCursor);
    expect(free.recorder.statements[0]).toEqual(counted.recorder.statements.find((s) => !/\bCOUNT\s*\(/i.test(s.sql)));
  });

  it.each([
    ["window", WINDOW_QUERY, 4],
    ["window past cursor", { ...WINDOW_QUERY, cursor: 14 }, 2],
    ["since only", { syncedSince: ZERO }, 6],
    ["until only", { syncedUntil: UPPER }, 6],
    ["equal bounds", { syncedSince: ZERO, syncedUntil: ZERO }, 0],
    ["window + enabled=false", { ...WINDOW_QUERY, enabled: "false" }, 2]
  ] as Array<[string, Query, number]>)("countOnly %s returns the cursor-relative count with no rows or Link", async (_label, query, total) => {
    const result = await page({ ...query, countOnly: "true" });
    expect(result.body.rows).toEqual([]);
    expect(result.body.total).toBe(total);
    expect(result.body.nextCursor).toBeNull();
  });

  it("sparse output retains canonical customer_id and the stored synced_at only when selected", async () => {
    const stamps = await page({ ...WINDOW_QUERY, fields: "synced_at" });
    expect(stamps.body.rows).toEqual([
      { customer_id: 13, synced_at: TENTH }, { customer_id: 14, synced_at: MID },
      { customer_id: 15, synced_at: UPPER }, { customer_id: 16, synced_at: UPPER }
    ]);
    const enabledOnly = await page({ ...WINDOW_QUERY, fields: "enabled" });
    expect(enabledOnly.body.rows).toEqual([
      { customer_id: 13, enabled: 0 }, { customer_id: 14, enabled: 1 },
      { customer_id: 15, enabled: 1 }, { customer_id: 16, enabled: 0 }
    ]);
  });

  it("exactNext emits an exact terminal signal inside the window", async () => {
    const first = await page({ ...WINDOW_QUERY, limit: 2, exactNext: "true" });
    expectPage(first, [13, 14], 4, 14);
    const second = await readPage(nextTarget(first, { ...WINDOW_QUERY, limit: 2, exactNext: "true", cursor: 14 }).search.slice(1));
    expectPage(second, [15, 16], 2, null);
  });

  it("default exactNext=false preserves the full-terminal link to an empty page", async () => {
    const first = await page({ ...WINDOW_QUERY, limit: 4 });
    expectPage(first, WINDOW, 4, 16);
    const terminal = await readPage(nextTarget(first, { ...WINDOW_QUERY, limit: 4, cursor: 16 }).search.slice(1));
    expectPage(terminal, [], 0, null);
  });
});

describe("customer synced window next-link traversal", () => {
  it.each([
    ["asc", [13, 14, 15, 16]], ["desc", [16, 15, 14, 13]]
  ] as const)("walks the window %s by returned relative links carrying NORMALIZED bounds", async (order, want) => {
    // Submitted unnormalized; every continuation must carry .000Z/.500Z.
    const filters: Query = { syncedSince: "2026-09-01T00:00:00Z", syncedUntil: "2026-09-01T00:00:00.5Z", order, limit: 1, includeTotal: "false" };
    let current = await page(filters);
    const seen: unknown[] = [];
    for (let i = 0; i <= want.length; i++) {
      expectPage(current, i < want.length ? [want[i]] : [], null, i < want.length ? want[i] : null);
      seen.push(...ids(current.body));
      if (i < want.length) {
        const target = nextTarget(current, { syncedSince: ZERO, syncedUntil: UPPER, order, limit: 1, includeTotal: "false", cursor: want[i] });
        current = await readPage(target.search.slice(1));
      }
    }
    expect(seen).toEqual([...want]);
    expect(new Set(seen).size).toBe(want.length);
  });

  it("single-bound continuations carry only the supplied bound, normalized; the omitted bound stays omitted", async () => {
    const first = await page({ syncedSince: "2026-09-01T00:00:00.1Z", limit: 2 });
    expectPage(first, [14, 15], 5, 15);
    const target = nextTarget(first, { syncedSince: TENTH, limit: 2, cursor: 15 });
    expect(target.searchParams.has("syncedUntil")).toBe(false);
    expectPage(await readPage(target.search.slice(1)), [16, 17], 3, 17);

    const upperFirst = await page({ syncedUntil: "2026-09-01T00:00:00.5Z", limit: 4 });
    expectPage(upperFirst, [11, 12, 13, 14], 6, 14);
    const upperTarget = nextTarget(upperFirst, { syncedUntil: UPPER, limit: 4, cursor: 14 });
    expect(upperTarget.searchParams.has("syncedSince")).toBe(false);
    expectPage(await readPage(upperTarget.search.slice(1)), [15, 16], 2, null);
  });

  it("offset starts convert to seek continuations that retain both bounds", async () => {
    const first = await page({ ...WINDOW_QUERY, offset: 1, limit: 2 });
    expectPage(first, [14, 15], 4, 15);
    const target = nextTarget(first, { ...WINDOW_QUERY, limit: 2, cursor: 15 });
    expectPage(await readPage(target.search.slice(1)), [16], 1);
  });

  it("counted links preserve cursor-relative totals through the empty terminal page", async () => {
    let current = await page({ ...WINDOW_QUERY, limit: 3 });
    expectPage(current, [13, 14, 15], 4, 15);
    current = await readPage(nextTarget(current, { ...WINDOW_QUERY, limit: 3, cursor: 15 }).search.slice(1));
    expectPage(current, [16], 1, null);
  });

  it("unknown keys stay ignored by default and never echo into Link, bytes or SQL", async () => {
    const filters = { ...WINDOW_QUERY, limit: 2 };
    const clean = await page(filters);
    const tainted = await readPage(`${qs(filters)}&token=query-credential-marker&bogus_param=unknown-marker`);
    expect(tainted.bytes).toBe(clean.bytes);
    expect(tainted.recorder.statements).toEqual(clean.recorder.statements);
    const target = nextTarget(tainted, { ...WINDOW_QUERY, limit: 2, cursor: 14 });
    expect(tainted.response.headers.get("link")).not.toMatch(/marker|Bearer|test-read-token|https?:|\/\//);
    expectPage(await readPage(target.search.slice(1)), [15, 16], 2, 16);
  });
});

describe("customer synced window conditional representations", () => {
  it("replays the exact sparse window envelope as an empty 304", async () => {
    const query = { ...WINDOW_QUERY, fields: "enabled", limit: 2, includeTotal: "false" };
    const first = await page(query);
    const tag = first.response.headers.get("etag");
    expect(tag).toMatch(/^".+"$/);
    const replay = await request(qs(query), { headers: { "if-none-match": tag! } });
    expect(replay.response.status).toBe(304);
    expect(await replay.response.text()).toBe("");
    expect(replay.response.headers.get("etag")).toBe(tag);
    expect(replay.response.headers.get("cache-control")).toBe("no-store");
    expect(replay.response.headers.get("link")).toBe(first.response.headers.get("link"));
  });

  it.each([
    ["narrower window", { syncedSince: TENTH, syncedUntil: UPPER, fields: "enabled", limit: 2, includeTotal: "false" }],
    ["unbounded tail", { syncedSince: ZERO, fields: "enabled", limit: 2, includeTotal: "false" }],
    ["counted envelope", { ...WINDOW_QUERY, fields: "enabled", limit: 2 }]
  ] as Array<[string, Query]>)("does not 304 a %s using another representation's tag", async (_label, query) => {
    const first = await page({ ...WINDOW_QUERY, fields: "enabled", limit: 2, includeTotal: "false" });
    const other = await request(qs(query), { headers: { "if-none-match": first.response.headers.get("etag")! } });
    expect(other.response.status).toBe(200);
    expect(other.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
  });
});

describe("customer synced window strict validation and auth", () => {
  const BAD_VALUES = [
    "", " ", "\t", "not-a-date", "secret-marker-xyz", "2026-09-01",
    "2026-09-01T00:00:00", "2026-09-01T00:00Z",
    "2026-09-01T00:00:00+00:00", "2026-09-01T01:00:00+01:00",
    "2026-09-01T00:00:00.0000Z", "2026-09-01T00:00:00.5000Z", "2026-09-01T00:00:00.123456789Z",
    "2026-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z",
    "2026-13-01T00:00:00Z", "2026-00-01T00:00:00Z", "2026-09-00T00:00:00Z",
    "2026-09-01T24:00:00Z", "2026-09-01T00:00:60Z",
    "2026-09-01T00:00:00Z' OR 1=1 --"
  ];
  async function expectRejected(search: string, names: RegExp, submitted: string[] = []) {
    const denied = forbiddenDb();
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((m) => vi.spyOn(console, m));
    const result = await request(search, { db: denied.db });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("link")).toBeNull();
    const body = await result.response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["detail", "status", "title", "type"]);
    expect(body).toMatchObject({ type: PROBLEM_TYPE, title: "Bad Request", status: 400 });
    // Guidance is fixed and value-free: it names fields, never submitted
    // values. Exact generic prose is intentionally not pinned beyond this.
    expect(String(body.detail)).toMatch(/^Invalid request query \(/);
    expect(String(body.detail)).toMatch(names);
    expect(String(body.detail)).toContain("docs/PROBLEMS.md#bad-request");
    for (const value of submitted) {
      if (value.length > 3) expect(JSON.stringify(body)).not.toContain(value);
    }
    expect(JSON.stringify(body)).not.toContain("secret-marker-xyz");
    expect(denied.calls).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
    return body;
  }

  it.each(BAD_VALUES)("rejects syncedSince=%j before D1", async (value) => {
    await expectRejected(`syncedSince=${encodeURIComponent(value)}`, /syncedSince/, [value]);
  });
  it.each(BAD_VALUES)("rejects syncedUntil=%j before D1", async (value) => {
    await expectRejected(`syncedUntil=${encodeURIComponent(value)}`, /syncedUntil/, [value]);
  });

  it.each([
    ["bare syncedSince", "syncedSince", /syncedSince/],
    ["bare syncedUntil", "syncedUntil", /syncedUntil/],
    ["repeated identical since", `syncedSince=${encodeURIComponent(ZERO)}&syncedSince=${encodeURIComponent(ZERO)}`, /syncedSince/],
    ["repeated different until", `syncedUntil=${encodeURIComponent(ZERO)}&syncedUntil=${encodeURIComponent(UPPER)}`, /syncedUntil/],
    ["empty then valid since", `syncedSince=&syncedSince=${encodeURIComponent(ZERO)}`, /syncedSince/],
    ["valid then empty until", `syncedUntil=${encodeURIComponent(UPPER)}&syncedUntil=`, /syncedUntil/],
    ["encoded duplicate since name", `syncedSince=${encodeURIComponent(ZERO)}&synced%53ince=${encodeURIComponent(TENTH)}`, /syncedSince/],
    ["bad since with valid until", `syncedSince=not-a-date&syncedUntil=${encodeURIComponent(UPPER)}`, /syncedSince/],
    ["valid since with offset until", `syncedSince=${encodeURIComponent(ZERO)}&syncedUntil=${encodeURIComponent("2026-09-01T00:00:00+00:00")}`, /syncedUntil/]
  ] as Array<[string, string, RegExp]>)("rejects %s before D1", async (_label, search, names) => {
    await expectRejected(search, names);
  });

  it.each([
    ["since after until", { syncedSince: UPPER, syncedUntil: ZERO }],
    ["normalized reversal hidden by fraction digits", { syncedSince: "2026-09-01T00:00:00.501Z", syncedUntil: "2026-09-01T00:00:00.5Z" }],
    ["normalized reversal hidden by seconds form", { syncedSince: "2026-09-01T00:00:01Z", syncedUntil: "2026-09-01T00:00:00.500Z" }]
  ] as Array<[string, Query]>)("rejects %s before D1 (comparison is post-normalization)", async (_label, query) => {
    await expectRejected(qs(query), /(syncedSince|syncedUntil|query)/);
  });

  it("rejection precedes conditional evaluation: a bad bound with If-None-Match is 400, never 304", async () => {
    const good = await page(WINDOW_QUERY);
    const denied = forbiddenDb();
    const result = await request(`syncedSince=not-a-date&syncedUntil=${encodeURIComponent(UPPER)}`, {
      db: denied.db, headers: { "if-none-match": good.response.headers.get("etag")! }
    });
    expect(result.response.status).toBe(400);
    expect(denied.calls).toEqual([]);
  });

  it("empty bound on the list is a 400, in explicit contrast with the changes feed's legacy empty since", async () => {
    // New parameters have no legacy leniency...
    await expectRejected("syncedSince=", /syncedSince/);
    await expectRejected("syncedUntil=", /syncedUntil/);
    // ...while the changes feed keeps its epoch behavior for empty `since`
    // untouched: same shared chain, different empty handling per parameter.
    const changes = await request("since=", { path: CHANGES_PATH });
    expect(changes.response.status).toBe(200);
    const body = await changes.response.json() as Body;
    expect(ids(body)).toEqual(ALL);
    const bounded = await request(`since=&until=${encodeURIComponent(UPPER)}`, { path: CHANGES_PATH });
    expect(bounded.response.status).toBe(200);
    expect(ids(await bounded.response.json() as Body)).toEqual([11, 12, 13, 14, 15, 16]);
  });

  it.each([
    `syncedSince=${encodeURIComponent(ZERO)}`, "syncedSince=secret-marker-xyz", "syncedUntil=",
    `syncedSince=${encodeURIComponent(UPPER)}&syncedUntil=${encodeURIComponent(ZERO)}`
  ])("control: auth precedes validation for %s", async (search) => {
    for (const token of [null, "synthetic-wrong-token"]) {
      const denied = forbiddenDb();
      const result = await request(search, { token, db: denied.db });
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get("content-type")).toContain("application/problem+json");
      expect(await result.response.text()).not.toContain("secret-marker-xyz");
      expect(denied.calls).toEqual([]);
    }
  });

  it("strictQuery=true accepts the declared bounds and retains them normalized in continuations", async () => {
    const first = await page({ syncedSince: "2026-09-01T00:00:00Z", syncedUntil: UPPER, limit: 2, strictQuery: "true" });
    expectPage(first, [13, 14], 4, 14);
    const target = nextTarget(first, { syncedSince: ZERO, syncedUntil: UPPER, limit: 2, strictQuery: "true", cursor: 14 });
    expectPage(await readPage(target.search.slice(1)), [15, 16], 2, 16);
  });

  it("strictQuery=true still rejects unknown names before D1 alongside valid bounds", async () => {
    const denied = forbiddenDb();
    const result = await request(`syncedSince=${encodeURIComponent(ZERO)}&strictQuery=true&bogus_param=1`, { db: denied.db });
    expect(result.response.status).toBe(400);
    const body = await result.response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ type: PROBLEM_TYPE, title: "Bad Request", status: 400 });
    expect(String(body.detail)).toMatch(/Unknown query parameter/);
    expect(JSON.stringify(body)).not.toContain("bogus_param");
    expect(denied.calls).toEqual([]);
  });

  it("bounds do not leak onto the address list: ignored by default, unknown under strictQuery", async () => {
    const ignored = await request(`syncedSince=${encodeURIComponent(ZERO)}&syncedUntil=${encodeURIComponent(UPPER)}`, { path: "/api/v1/address-snapshot" });
    expect(ignored.response.status).toBe(200);
    const body = await ignored.response.json() as Body;
    expect(body.rows.map((r) => r.pickup_address_id)).toEqual([101, 102, 103, 104, 105]);
    const strict = await request(`strictQuery=true&syncedSince=${encodeURIComponent(ZERO)}`, { path: "/api/v1/address-snapshot" });
    expect(strict.response.status).toBe(400);
    expect(String(((await strict.response.json()) as Record<string, unknown>).detail)).toMatch(/Unknown query parameter/);
  });
});

describe("customer synced window mounted discovery", () => {
  type Param = { name: string; in: string; required?: boolean; description?: string; schema?: { description?: string; [key: string]: unknown } };
  type Operation = { operationId?: string; parameters?: Param[]; responses?: Record<string, { description?: string }>; [key: string]: unknown };
  async function openApi() {
    const response = await exports.default.fetch("http://test.local/openapi.json");
    expect(response.status).toBe(200);
    return await response.json() as { paths: Record<string, { get?: Operation }> };
  }
  const PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?Z$";

  it.each([
    ["syncedSince", /strict|>|after|later|greater/i],
    ["syncedUntil", /inclusive|<=|≤|at or before/i]
  ] as Array<[string, RegExp]>)("serves optional %s on the shared lossless chain schema", async (name, sense) => {
    const doc = await openApi();
    const operation = doc.paths[PATH]?.get;
    expect(operation).toMatchObject({ operationId: "listCustomerSnapshot", "x-access": "read", "x-effect": "local-read" });
    const params = operation?.parameters?.filter((p) => p.name === name);
    expect(params).toHaveLength(1);
    expect(params![0]).toMatchObject({ in: "query", required: false, schema: { type: "string", pattern: PATTERN } });
    expect(params![0].schema).not.toHaveProperty("format");
    const prose = `${params![0].description ?? ""} ${params![0].schema?.description ?? ""}`;
    expect(prose).toMatch(sense);
    expect(prose).toMatch(/millisecond/i);
    expect(prose).toMatch(/synced_at|sync/i);
    expect(operation?.responses?.["400"]?.description).toContain(name);
  });

  it("bound prose together teaches omission, empty rejection and the changes-feed boundary", async () => {
    const doc = await openApi();
    const operation = doc.paths[PATH]?.get;
    const prose = ["syncedSince", "syncedUntil"].map((name) => {
      const p = operation?.parameters?.find((x) => x.name === name);
      return `${p?.description ?? ""} ${p?.schema?.description ?? ""}`;
    }).join(" ");
    expect(prose).toMatch(/omit/i);
    expect(prose).toMatch(/empty/i);
    expect(prose).toMatch(/changes/);
    expect(operation?.responses?.["400"]?.description).toContain("docs/PROBLEMS.md#bad-request");
  });

  it("keeps the bounds off sibling lists, the changes feed and by-id reads", async () => {
    const doc = await openApi();
    for (const path of ["/api/v1/address-snapshot", "/api/v1/container-snapshot", CHANGES_PATH, "/api/v1/customer-snapshot/{customerId}", "/api/v1/address-snapshot/{pickupAddressId}", "/api/v1/container-snapshot/{containerId}"]) {
      const names = (doc.paths[path]?.get?.parameters ?? []).map((p) => p.name);
      expect(names, path).not.toContain("syncedSince");
      expect(names, path).not.toContain("syncedUntil");
    }
    // The changes feed keeps its own since/until names, untouched.
    const changesNames = (doc.paths[CHANGES_PATH]?.get?.parameters ?? []).map((p) => p.name);
    expect(changesNames).toEqual(expect.arrayContaining(["since", "until"]));
  });

  it.each(["syncedSince", "syncedUntil"])("provides a schema-valid %s example an agent can replay alone", async (name) => {
    const doc = await openApi();
    const param = doc.paths[PATH]?.get?.parameters?.find((p) => p.name === name);
    const example = (param as (Param & { example?: unknown }) | undefined)?.example ?? param?.schema?.example;
    expect(typeof example).toBe("string");
    expect(String(example)).toMatch(new RegExp(PATTERN));
    const result = await request(qs({ [name]: String(example) }));
    expect(result.response.status).toBe(200);
  });
});

// These are machine-consumed selection/safety instructions, not prose style
// pins: an agent must learn that stored sync time is mirror freshness — not
// upstream event time, not proof of change content, not a complete delta —
// and that complete-delta traversal belongs on the changes feed.
describe("customer synced window agent guidance", () => {
  it("inventories both bounds on the customer list only and links the focused oracle", () => {
    const row = (path: string) => policyDoc.split("\n").find((line) => line.startsWith(`| \`${path}\` |`)) ?? "";
    expect(row(PATH)).toContain("`syncedSince`");
    expect(row(PATH)).toContain("`syncedUntil`");
    expect(row("/api/v1/address-snapshot")).not.toContain("syncedSince");
    expect(row("/api/v1/container-snapshot")).not.toContain("syncedUntil");
    expect(policyDoc).toContain("test/customerSyncedWindow.acceptance.test.ts");
  });

  it("explains mirror freshness, the filter-not-a-feed boundary and the missing deletion history", () => {
    const sections = policyDoc.split(/^#{1,6} /m).filter((section) => section.includes("syncedSince") && section.includes("syncedUntil"));
    expect(sections.length).toBeGreaterThanOrEqual(1);
    const guidance = sections.join("\n");
    expect(guidance).toMatch(/mirror/i);
    expect(guidance).toMatch(/freshness|stored/i);
    expect(guidance).toMatch(/upstream/i);
    expect(guidance).toMatch(/not[^.]{0,60}(event|proof|complete|delta|feed)|does not[^.]{0,60}(prove|guarantee|mean)/i);
    expect(guidance).toMatch(/delet/i);
    expect(guidance).toMatch(/customer-snapshot\/changes|\/changes/);
    expect(guidance).toMatch(/filter/i);
    const customerRow = snapshotDoc.split("\n").find((line) => line.includes("`/api/v1/customer-snapshot`") && line.includes("List rows")) ?? "";
    expect(customerRow).toContain("syncedSince");
    expect(customerRow).toContain("syncedUntil");
    expect(snapshotDoc).toContain("check:customer-synced-window");
  });

  it("publishes a synthetic finite-window recipe contrasted with complete delta traversal", () => {
    const blocks = [...quickstartDoc.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((m) => m[1]);
    const recipe = blocks.find((b) => b.includes("syncedSince=") && b.includes("syncedUntil=") && b.includes(PATH) && !b.includes("/changes"));
    expect(recipe, "local finite-window recipe").toBeDefined();
    expect(recipe).toContain("localhost:8787");
    expect(recipe).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
    const sections = quickstartDoc.split(/^#{1,6} /m).filter((section) => section.includes("syncedSince"));
    expect(sections.length).toBeGreaterThanOrEqual(1);
    const guidance = sections.join("\n");
    expect(guidance).toMatch(/customer-snapshot\/changes|\/changes/);
    expect(guidance).toMatch(/complete|delta/i);
    expect(guidance).toMatch(/cursor|rel="next"|[Ll]ink/);
    const unreleased = changelog.split(/^## /m)[1];
    const bullet = unreleased.split(/(?=^- #)/m).find((b) => b.includes("syncedSince") && b.includes("syncedUntil") && /customer/i.test(b));
    expect(bullet, "customer synced-window changelog bullet").toBeDefined();
  });

  it("exposes a named local-only focused check that includes this acceptance suite", () => {
    const scripts = packageJson.scripts as Record<string, string>;
    const command = scripts["check:customer-synced-window"];
    expect(command).toEqual(expect.any(String));
    expect(command).toMatch(/vitest\s+run/);
    expect(command).toContain("test/customerSyncedWindow.acceptance.test.ts");
    expect(command).not.toMatch(/--remote|deploy|probe:post-deploy/);
  });
});
