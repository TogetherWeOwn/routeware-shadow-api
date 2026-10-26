/// <reference types="vite/client" />

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent Test Author oracle, intentionally RED before implementation.
 * Run: npx vitest run --maxWorkers=2 test/customerCommentsSearch.acceptance.test.ts
 * Builder must not edit this file; oracle corrections belong to the Test Author.
 *
 * Mutation targets: ignored selector; company/phone instead of comments; LIKE or
 * interpolated SQL; Unicode folding/normalization; trimming before length check;
 * first/last repeated value; OR leakage; COUNT/page divergence; lost next filters;
 * wrong representation validator; any external/storage write effect.
 * Expected IDs/pages are hand-derived from synthetic migrated local D1 fixtures.
 * No implementation helpers compute expected matches. GET is an idempotent local
 * read, not a deploy or a latency claim; CLI --dry-run is not applicable.
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/customer-snapshot";
const ORIGIN = "https://comments-client.invalid";
const STAMP = "2026-01-01T00:00:00.000Z";
const FRAGMENT = "handoff";
const SPECIAL = "desk' OR 1=1 -- %_ 🧪&+/#?";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";

type Fixture = readonly [number, string, string | null, string | null, number, string | null, string | null, string | null];
// id, company, phone1, phone2, enabled, customer number, sub number, comments
const fixtures: readonly Fixture[] = [
  [11, "North Synthetic One", "5550107", null, 1, "00042", "North", "Leave at HANDOFF gate"],
  [23, "North Synthetic Two", null, "desk 5550107 ext 9", 0, "00042", "North", "handoff"],
  [37, "North Synthetic Three", "5550107", "5550107", 1, "00042", "South", "repeat handoff handoff"],
  [42, "South Synthetic Four", "other", "5550107", 0, "42", "North", "handoff"],
  [58, "handoff company-only decoy", "other", null, 1, "00042", "North", null],
  [91, "North Synthetic Phone Decoy", "handoff", null, 1, "00042", "North", "unrelated"],
  [103, "Synthetic Null", null, null, 1, null, null, null],
  [107, "Synthetic Empty", null, null, 1, null, null, ""],
  [109, "Synthetic Blank", null, null, 1, null, null, " \t\r\n "],
  [113, "Synthetic Punctuation", null, null, 1, null, null, SPECIAL],
  [127, "Synthetic ASCII", null, null, 1, null, null, "Desk-AbC-Extension"],
  [131, "Synthetic Padded", null, null, 1, null, null, "  marker  "],
  [137, "Synthetic Astral Boundary", null, null, 1, null, null, "🧪".repeat(100)],
  [139, "Synthetic ASCII Boundary", null, null, 1, null, null, "x".repeat(100)],
  [149, "Synthetic Composed", null, null, 1, null, null, "é"],
  [151, "Synthetic Decomposed", null, null, 1, null, null, "é"],
  [157, "Synthetic Whitespace", null, null, 1, null, null, " \tcomment\n "],
  [163, "Synthetic Wildcards", null, null, 1, null, null, "%_"],
  [167, "Synthetic Wildcard Decoy", null, null, 1, null, null, "XXanything"],
  [173, "Synthetic Trim Decoy", null, null, 1, null, null, "marker"],
  [179, "Synthetic Whitespace Decoy", null, null, 1, null, null, "comment"],
  [181, "Synthetic Astral Prefix", null, null, 1, null, null, "🧪".repeat(99)],
  [191, "Synthetic ASCII Prefix", null, null, 1, null, null, "x".repeat(99)],
  [193, "Synthetic Mixed Boundary", null, null, 1, null, null, "x".repeat(50) + "🧪".repeat(50)],
  [197, "Synthetic Mixed Prefix", null, null, 1, null, null, "x".repeat(50) + "🧪".repeat(49)],
  [199, "Synthetic Upper Composed", null, null, 1, null, null, "É"]
];
const ALL_IDS = [11, 23, 37, 42, 58, 91, 103, 107, 109, 113, 127, 131, 137, 139, 149, 151, 157, 163, 167, 173, 179, 181, 191, 193, 197, 199];
type Query = Record<string, string> | URLSearchParams;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[]; method: string };
const ids = (body: Body) => body.rows.map((row) => row.customer_id);
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
const recorders: ReturnType<typeof recordingDb>[] = [];
const deniedEffects = vi.fn(() => { throw new Error("Comments lookup attempted network, R2 or cache write"); });
const deniedR2 = new Proxy({} as R2Bucket, { get: () => deniedEffects });
let beforeState: unknown;
let requestNumber = 0;

// Observe actual SQL/binds while forwarding reads to real D1, never synthesizing rows.
function recordingDb() {
  const statements: Statement[] = [];
  const prepared: string[] = [];
  const deny = vi.fn(() => { throw new Error("Comments list must only SELECT from local D1"); });
  function wrap(real: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return new Proxy(real, {
      get(target, member) {
        const value = Reflect.get(target, member, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (member === "bind") return wrap(Reflect.apply(value, target, args), sql, args);
          statements.push({ sql, binds, method: String(member) });
          if (!["first", "all", "raw"].includes(String(member)) || !/^\s*SELECT\b/i.test(sql)) return deny();
          return Reflect.apply(value, target, args);
        };
      }
    });
  }
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      if (!/^\s*SELECT\b/i.test(sql)) return deny();
      return wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []);
    }, batch: deny, exec: deny, withSession: deny, dump: deny
  } as unknown as D1Database;
  return { db, statements, prepared, deny };
}

async function state() {
  const db = TEST_ENV.CUSTOMER_DB;
  const results = await Promise.all([
    ...["customer_snapshot", "address_snapshot", "container_snapshot"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()
  ]);
  return results.map((result) => result.results);
}

async function request(query: Query | URL = {}, options: { token?: string | null; headers?: Record<string, string> } = {}) {
  const recorder = recordingDb();
  recorders.push(recorder);
  const url = query instanceof URL ? query : new URL(PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = new URLSearchParams(query).toString();
  const requestId = `Comments-${++requestNumber}`;
  const headers = new Headers({ origin: ORIGIN, "x-request-id": requestId, ...options.headers });
  const token = options.token === undefined ? "test-read-token" : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: recorder.db, SNAPSHOTS: deniedR2,
    BROWSER: { fetch: deniedEffects } as unknown as Fetcher
  });
  return { response, recorder, url, requestId };
}

function posture(response: Response, requestId: string) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  expect(response.headers.get("vary")).toMatch(/\borigin\b/i);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("x-frame-options")).toBe("DENY");
  expect(response.headers.get("x-request-id")).toBe(requestId);
}

async function page(query: Query | URL = {}, token?: string) {
  const result = await request(query, { token });
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  posture(result.response, result.requestId);
  const body = await result.response.json() as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const counted = result.url.searchParams.get("includeTotal") !== "false";
  expect(result.recorder.statements).toHaveLength(counted ? 2 : 1);
  expect(result.recorder.statements.filter(isCount)).toHaveLength(counted ? 1 : 0);
  if (!counted) expect(body.total).toBeNull();
  expect(new Set(ids(body)).size).toBe(body.rows.length);
  return { ...result, body };
}

function next(result: Awaited<ReturnType<typeof page>>, expected: Record<string, string>) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/customer-snapshot\?[^<>\s]*>; rel="next"$/);
  const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(target.origin).toBe(ORIGIN);
  expect(target.pathname).toBe(PATH);
  expect(target.hash + target.username + target.password).toBe("");
  expect(target.searchParams.has("offset")).toBe(false);
  for (const [key, value] of Object.entries(expected)) {
    if ((key === "includeTotal" && value === "true") || (key === "enabled" && value === "any")) {
      expect([null, value]).toContain(target.searchParams.get(key));
      expect(target.searchParams.getAll(key).length).toBeLessThanOrEqual(1);
    } else expect(target.searchParams.getAll(key), key).toEqual([value]);
  }
  expect([...target.searchParams.keys()].every((key) => Object.hasOwn(expected, key))).toBe(true);
  return target;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  recorders.length = 0;
  deniedEffects.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound comments fetch"); }));
  const cache = (caches as CacheStorage & { default: Cache }).default;
  vi.spyOn(cache, "put").mockImplementation(deniedEffects);
  vi.spyOn(cache, "delete").mockImplementation(deniedEffects);
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot")
  ]);
  await db.batch([...fixtures].reverse().map(([id, company, phone1, phone2, enabled, number, sub, comments]) => db.prepare(
    "INSERT INTO customer_snapshot (customer_id, company_name, phone1, phone2, enabled, customer_number, sub_customer_number, comments, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, company, phone1, phone2, enabled, number, sub, comments, STAMP)));
  for (const [id, owner, enabled] of [[501, 23, 0], [502, 37, 1], [503, 37, 0], [504, 58, 1]]) {
    await db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, 'Synthetic site', ?, ?)")
      .bind(id, owner, enabled, STAMP).run();
  }
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(deniedEffects).not.toHaveBeenCalled();
    for (const recorder of recorders) {
      expect(recorder.deny).not.toHaveBeenCalled();
      expect(recorder.prepared.every((sql) => /^\s*SELECT\b/i.test(sql))).toBe(true);
    }
    expect(await state(), "GET must not alter rows, stored text, or schema").toEqual(beforeState);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe("stored comments literal substring", () => {
  it("selects comments only, without company/phone decoys or duplicate occurrences", async () => {
    const { body } = await page({ comments: FRAGMENT });
    expect(ids(body)).toEqual([11, 23, 37, 42]);
    expect(body.total).toBe(4);
    expect(body.nextCursor).toBeNull();
  });

  it.each([
    ["ASCII case folding", "aBc", [127]],
    ["substring not equality", "andoff", [11, 23, 37, 42]],
    ["one code point", "'", [113]],
    ["trim request boundaries", " \tHANDOFF\r\n ", [11, 23, 37, 42]],
    ["do not collapse internal spaces", "hand off", []],
    ["trim without rewriting stored text", "  marker  ", [131, 173]],
    ["trim tabs and newlines", " \tcomment\n ", [157, 179]],
    ["100 ASCII code points", "x".repeat(100), [139]],
    ["100 astral code points not UTF-16 units", "🧪".repeat(100), [137]],
    ["100 mixed code points", "x".repeat(50) + "🧪".repeat(50), [193]],
    ["100 raw including trim boundaries", " " + "x".repeat(98) + " ", [139, 191]],
    ["100 raw astral including trim boundaries", " " + "🧪".repeat(98) + " ", [137, 181]],
    ["non-ASCII exact lower case", "é", [149]],
    ["non-ASCII exact upper case", "É", [199]],
    ["no composed/decomposed normalization", "é", [151]],
    ["quotes, Unicode and URL delimiters", SPECIAL, [113]],
    ["percent and underscore not wildcards", "%_", [113, 163]],
    ["SQL-looking fragment bound as data", "' OR 1=1 --", [113]],
    ["null not stringified", "null", []],
    ["no match is empty success", "absent-synthetic-comment", []]
  ] as const)("%s", async (_name, comments, want) => {
    const { body, response } = await page({ comments });
    expect(ids(body)).toEqual(want);
    expect(body.total).toBe(want.length);
    expect(body.nextCursor).toBeNull();
    expect(response.headers.get("link")).toBeNull();
  });

  it.each(["", " \t\r\n ", "  ", " ".repeat(100)])("blank within raw bound is omitted (%j)", async (comments) => {
    const baseline = await page();
    const blank = await page({ comments });
    expect(ids(blank.body)).toEqual(ALL_IDS);
    expect(blank.body.total).toBe(26);
    expect(blank.body).toEqual(baseline.body);
    expect(blank.recorder.statements).toEqual(baseline.recorder.statements);
    expect(blank.response.headers.get("etag")).toBe(baseline.response.headers.get("etag"));
  });

  it("keeps q limited to company text rather than widening it to comments", async () => {
    expect(ids((await page({ q: FRAGMENT })).body)).toEqual([58]);
    expect(ids((await page({ q: FRAGMENT, comments: FRAGMENT })).body)).toEqual([]);
    expect(ids((await page({ phone: FRAGMENT })).body)).toEqual([91]);
    expect(ids((await page({ phone: FRAGMENT, comments: FRAGMENT })).body)).toEqual([]);
  });

  it("preserves nullable/blank stored values and canonical flat IDs on omission", async () => {
    const { body } = await page();
    expect(ids(body)).toEqual(ALL_IDS);
    expect(body.rows.find((row) => row.customer_id === 103)).toMatchObject({ comments: null });
    expect(body.rows.find((row) => row.customer_id === 107)).toMatchObject({ comments: "" });
    expect(body.rows.find((row) => row.customer_id === 109)).toMatchObject({ comments: " \t\r\n " });
    for (const row of body.rows) expect(Object.values(row).every((value) => value === null || typeof value !== "object")).toBe(true);
  });

  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("retains existing read-capable role (%s)", async (token) => {
    expect(ids((await page({ comments: FRAGMENT }, token)).body)).toEqual([11, 23, 37, 42]);
  });

  it("ignores unrelated repeated unknown keys without reflecting or executing them", async () => {
    const plain = await page({ comments: FRAGMENT });
    const unknown = await page(new URLSearchParams([["comments", FRAGMENT], ["unknown-private-key", "private-first"], ["unknown-private-key", "private-second"]]));
    expect(ids(plain.body)).toEqual([11, 23, 37, 42]);
    expect(unknown.body).toEqual(plain.body);
    expect(unknown.recorder.statements).toEqual(plain.recorder.statements);
  });
});

describe("comments AND intersections with every existing selector", () => {
  it.each([
    ["enabled", { enabled: "true" }, [11, 37]],
    ["disabled", { enabled: "false" }, [23, 42]],
    ["any", { enabled: "any" }, [11, 23, 37, 42]],
    ["q", { q: " north " }, [11, 23, 37]],
    ["phone1 and phone2", { phone: "5550107" }, [11, 23, 37, 42]],
    ["phone2 substring", { phone: "EXT 9" }, [23]],
    ["customer number", { customerNumber: "00042" }, [11, 23, 37]],
    ["sub number", { subCustomerNumber: "North" }, [11, 23, 42]],
    ["opaque number exactness", { customerNumber: "42" }, [42]],
    ["customer ID", { customerId: "37" }, [37]],
    ["ID mismatch", { customerId: "58" }, []],
    ["IDs", { ids: "11,23,58,91" }, [11, 23]],
    ["upperId inclusive", { upperId: "37" }, [11, 23, 37]],
    ["upperId excludes all", { upperId: "10" }, []],
    ["address presence (includes disabled child, deduplicates many)", { hasAddresses: "true" }, [23, 37]],
    ["address absence", { hasAddresses: "false" }, [11, 42]],
    ["all selectors", { q: "north", phone: "5550107", customerNumber: "00042", subCustomerNumber: "North", customerId: "23", ids: "11,23,58", enabled: "false", hasAddresses: "true", upperId: "23" }, [23]],
    ["conflicting all selectors", { q: "north", phone: "5550107", customerNumber: "00042", subCustomerNumber: "North", customerId: "23", enabled: "true" }, []]
  ] as const)("%s shares COUNT and page scope", async (_name, filters, want) => {
    for (const includeTotal of ["true", "false"]) {
      const { body } = await page({ ...filters, comments: FRAGMENT, includeTotal });
      expect(ids(body)).toEqual(want);
      expect(body.total).toBe(includeTotal === "false" ? null : want.length);
      expect(body.nextCursor).toBeNull();
    }
  });

  it("projects comments as stored and retains customer_id", async () => {
    const { body } = await page({ comments: " marker ", fields: "comments", includeTotal: "false" });
    expect(body).toEqual({ rows: [
      { customer_id: 131, comments: "  marker  " }, { customer_id: 173, comments: "marker" }
    ], total: null, nextCursor: null });
  });

  it("filters even when the comments column is omitted from the representation", async () => {
    const { body } = await page({ comments: FRAGMENT, fields: "phone1" });
    expect(body).toEqual({ rows: [
      { customer_id: 11, phone1: "5550107" }, { customer_id: 23, phone1: null },
      { customer_id: 37, phone1: "5550107" }, { customer_id: 42, phone1: "other" }
    ], total: 4, nextCursor: null });
  });

  it("is idempotent and never logs a successful private fragment", async () => {
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
    const first = await page({ comments: SPECIAL });
    const second = await page({ comments: SPECIAL });
    expect(ids(first.body)).toEqual([113]);
    expect(second.body).toEqual(first.body);
    expect(second.recorder.statements).toEqual(first.recorder.statements);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("binds literal comments once with identical COUNT/page predicates and filter binds", async () => {
    const { body, recorder } = await page({ comments: `  ${SPECIAL}  `, upperId: "113", fields: "company_name" });
    expect(ids(body)).toEqual([113]);
    const count = recorder.statements.find(isCount)!;
    const rows = recorder.statements.find((s) => !isCount(s))!;
    const where = (sql: string) => sql.split(/\bWHERE\b/i)[1].split(/\b(?:ORDER BY|LIMIT)\b/i)[0].trim();
    expect(where(rows.sql)).toBe(where(count.sql));
    expect(rows.binds.slice(0, count.binds.length)).toEqual(count.binds);
    for (const { sql, binds } of recorder.statements) {
      expect(sql).not.toContain(SPECIAL);
      expect(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP)\b/i);
      expect(sql).toMatch(/instr\(\s*lower\(\s*coalesce\(\s*(?:\w+\.)?comments\s*,\s*''\s*\)\s*\)\s*,\s*lower\(\s*\?\s*\)\s*\)\s*>\s*0/i);
      expect(binds.filter((value) => value === SPECIAL)).toHaveLength(1);
    }
  });
});

describe.each(["true", "false"])("comments traversal includeTotal=%s", (includeTotal) => {
  it.each([
    ["ascending offset", { order: "asc", offset: "1", limit: "2" }, [23, 37], 4, 37],
    ["descending offset", { order: "desc", offset: "1", limit: "2" }, [37, 23], 4, 23],
    ["ascending seek gap", { order: "asc", cursor: "24", limit: "2" }, [37, 42], 2, 42],
    ["descending seek gap", { order: "desc", cursor: "36", limit: "2" }, [23, 11], 2, 11],
    ["cursor overrides offset", { order: "desc", cursor: "37", offset: "999", limit: "1" }, [23], 2, 23],
    ["partial terminal", { order: "asc", cursor: "37", limit: "2" }, [42], 1, null],
    ["empty seek", { order: "asc", cursor: "42", limit: "2" }, [], 0, null],
    ["empty offset", { order: "desc", offset: "4", limit: "2" }, [], 4, null]
  ] as const)("%s uses the filtered scope and no lookahead", async (_name, filters, want, total, cursor) => {
    const { body, response, recorder } = await page({ ...filters, comments: FRAGMENT, includeTotal });
    expect(ids(body)).toEqual(want);
    expect(body.total).toBe(includeTotal === "false" ? null : total);
    expect(body.nextCursor).toBe(cursor);
    if (cursor === null) expect(response.headers.get("link")).toBeNull();
    if ("cursor" in filters) for (const read of recorder.statements) expect(read.sql).not.toMatch(/\bOFFSET\b/i);
    const rows = recorder.statements.find((s) => !isCount(s))!;
    const tail = "cursor" in filters ? [Number(filters.limit)] : [Number(filters.limit), Number(filters.offset ?? 0)];
    expect(rows.binds.slice(-tail.length)).toEqual(tail);
  });

  it.each(["asc", "desc"])("follows actual %s links through duplicate matches and a full terminal page", async (order) => {
    const filters = { comments: " HANDOFF ", order, limit: "2", includeTotal, fields: "comments" };
    const pages = order === "asc" ? [[11, 23], [37, 42], []] : [[42, 37], [23, 11], []];
    let current = await page(filters);
    const seen: unknown[] = [];
    for (const [index, want] of pages.entries()) {
      expect(ids(current.body)).toEqual(want);
      expect(current.body.total).toBe(includeTotal === "false" ? null : [4, 2, 0][index]);
      expect(current.body.nextCursor).toBe(want[1] ?? null);
      for (const row of current.body.rows) expect(Object.keys(row).sort()).toEqual(["comments", "customer_id"]);
      seen.push(...ids(current.body));
      if (want.length === 0) expect(current.response.headers.get("link")).toBeNull();
      else current = await page(next(current, { ...filters, comments: "HANDOFF", cursor: String(want[1]) }));
    }
    expect(seen).toEqual(order === "asc" ? [11, 23, 37, 42] : [42, 37, 23, 11]);
  });

  it.each(["asc", "desc"])("%s offset-to-seek retains upperId and normalized selector, never unknown keys", async (order) => {
    const filters = { comments: " handoff ", order, limit: "1", upperId: "37", includeTotal, fields: "company_name" };
    const pages = order === "asc" ? [[23], [37], []] : [[23], [11], []];
    let current = await page({ ...filters, offset: "1", "unknown-private-key": "private-value", access_token: "private-credential" });
    for (const [index, want] of pages.entries()) {
      expect(ids(current.body)).toEqual(want);
      expect(current.body.total).toBe(includeTotal === "false" ? null : [3, 1, 0][index]);
      expect(current.body.nextCursor).toBe(want[0] ?? null);
      if (want.length === 0) expect(current.response.headers.get("link")).toBeNull();
      else current = await page(next(current, { ...filters, comments: FRAGMENT, cursor: String(want[0]) }));
    }
  });
});

it("carries all intersections after an offset start without leaking headers/origin/credentials", async () => {
  const filters = { comments: FRAGMENT, q: "north", phone: "5550107", customerNumber: "00042", subCustomerNumber: "North", customerId: "23", ids: "11,23,58", enabled: "false", hasAddresses: "true", upperId: "23", fields: "phone1", order: "desc", limit: "1", includeTotal: "false" };
  const first = await page({ ...filters, offset: "0", ignored: "private-value" });
  expect(first.body).toEqual({ rows: [{ customer_id: 23, phone1: null }], total: null, nextCursor: 23 });
  const target = next(first, { ...filters, cursor: "23" });
  const link = first.response.headers.get("link")!;
  expect(link).not.toMatch(/private-value|test-read-token|https:|authorization|origin/i);
  const last = await page(target);
  expect(last.body).toEqual({ rows: [], total: null, nextCursor: null });
  expect(last.response.headers.get("link")).toBeNull();
});

it.each([SPECIAL, "%_", "é", "🧪".repeat(100)])("round-trips encoded literal data in next links (%s)", async (comments) => {
  const want = comments === SPECIAL ? [113] : comments === "%_" ? [113, 163] : comments === "é" ? [149] : [137];
  const filters = { comments, limit: "1", includeTotal: "false" };
  let current = await page(filters);
  for (const id of want) {
    expect(ids(current.body)).toEqual([id]);
    expect(current.body.nextCursor).toBe(id);
    const target = next(current, { ...filters, cursor: String(id) });
    expect(current.response.headers.get("link")).not.toContain(comments);
    current = await page(target);
  }
  expect(current.body).toEqual({ rows: [], total: null, nextCursor: null });
  expect(current.response.headers.get("link")).toBeNull();
});

it.each(["asc", "desc"])("omits blank comments from followed %s links", async (order) => {
  const filters = { customerId: "113", limit: "1", order, includeTotal: "false" };
  const first = await page({ ...filters, comments: " \t  " });
  expect(ids(first.body)).toEqual([113]);
  const last = await page(next(first, { ...filters, cursor: "113" }));
  expect(last.body).toEqual({ rows: [], total: null, nextCursor: null });
  expect(last.response.headers.get("link")).toBeNull();
});

describe("comments validation before D1 and conditionals, after auth", () => {
  async function rejected(query: Query | URL) {
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
    const { response, recorder, requestId } = await request(query, { headers: { "if-none-match": "*" } });
    expect.soft(response.status).toBe(400);
    expect.soft(recorder.prepared).toEqual([]);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("etag")).toBeNull();
    posture(response, requestId);
    const problem = await response.json() as Record<string, unknown>;
    expect(problem).toMatchObject({ type: BAD_REQUEST, title: "Bad Request", status: 400 });
    expect(problem.detail).toEqual(expect.any(String));
    expect(problem.detail).toMatch(/comments/);
    // The fixed problem points to the bounded-single-fragment remedy, not input values.
    expect(problem.detail).toContain("docs/PROBLEMS.md#bad-request");
    expect(Object.keys(problem).every((key) => ["type", "title", "status", "detail", "requestId"].includes(key))).toBe(true);
    expect(JSON.stringify(problem)).not.toMatch(/private-first|private-second|unknown-private-key|private-value|🧪/);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  }

  it.each([
    ["101 ASCII code points", "private-first" + "x".repeat(88)],
    ["101 astral code points", "🧪".repeat(101)],
    ["101 mixed code points", "x".repeat(50) + "🧪".repeat(51)],
    ["raw 101 trimmed to 99 ASCII", " " + "x".repeat(99) + " "],
    ["raw 101 trimmed to 99 astral", " " + "🧪".repeat(99) + " "],
    ["101 blank code points before trim", " ".repeat(101)]
  ])("rejects %s, never truncating or trimming before length validation", async (_name, comments) => {
    await rejected({ comments, "unknown-private-key": "private-value" });
  });

  it.each([
    ["identical", "private-first", "private-first"], ["different", "private-first", "private-second"],
    ["empty then valid", "", FRAGMENT], ["valid then empty", FRAGMENT, ""], ["both blank", "", " "]
  ])("rejects repeated values (%s) rather than taking first/last", async (_name, first, second) => {
    await rejected(new URLSearchParams([["comments", first], ["comments", second], ["unknown-private-key", "private-value"]]));
  });

  it("treats an encoded query key as the same repeated comments key", async () => {
    await rejected(new URL(PATH + "?comments=private-first&%63omments=private-second", ORIGIN));
  });

  it("returns the same value-free problem for distinct invalid values and unknown keys", async () => {
    const a = await request({ comments: "private-first".padEnd(101, "a"), "unknown-private-key": "private-value" });
    const b = await request({ comments: "private-second".padEnd(102, "b"), "other-private-key": "other-private-value" });
    expect(a.response.status).toBe(400);
    expect(b.response.status).toBe(400);
    expect(a.recorder.prepared).toEqual([]);
    expect(b.recorder.prepared).toEqual([]);
    const left = await a.response.json() as Record<string, unknown>;
    const right = await b.response.json() as Record<string, unknown>;
    delete left.requestId; delete right.requestId;
    expect(left).toEqual(right);
    expect(JSON.stringify(left)).not.toMatch(/private|aaaa|bbbb/);
  });

  it.each([null, "invalid-synthetic-token"])("auth takes precedence over every selector error (token %s)", async (token) => {
    const queries: Query[] = [
      { comments: FRAGMENT }, { comments: "x".repeat(101) },
      new URLSearchParams([["comments", "private-first"], ["comments", "private-second"]])
    ];
    for (const query of queries) {
      const { response, recorder, requestId } = await request(query, { token, headers: { "if-none-match": "*" } });
      expect(response.status).toBe(401);
      expect(recorder.prepared).toEqual([]);
      expect(response.headers.get("etag")).toBeNull();
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      posture(response, requestId);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ status: 401, title: "Unauthorized" });
      expect(text).not.toMatch(/private-first|private-second|handoff/);
    }
  });
});

it.each(["true", "false"])("hashes the served projection and replays a bodyless 304 (includeTotal=%s)", async (includeTotal) => {
  const query = { comments: FRAGMENT, fields: "company_name", order: "desc", upperId: "37", limit: "2", includeTotal };
  const first = await request(query);
  expect(first.response.status).toBe(200);
  const bytes = await first.response.text();
  const body = JSON.parse(bytes) as Body;
  expect(ids(body)).toEqual([37, 23]);
  expect(body.total).toBe(includeTotal === "false" ? null : 3);
  for (const row of body.rows) expect(Object.keys(row).sort()).toEqual(["company_name", "customer_id"]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  const tag = `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
  expect(first.response.headers.get("etag")).toBe(tag);
  const link = first.response.headers.get("link");
  expect(link).not.toBeNull();
  for (const validator of [tag, `W/${tag}`, "*"]) {
    const replay = await request(first.url, { headers: { "if-none-match": validator } });
    expect(replay.response.status).toBe(304);
    expect(replay.response.body).toBeNull();
    expect((await replay.response.arrayBuffer()).byteLength).toBe(0);
    expect(replay.response.headers.get("etag")).toBe(tag);
    expect(replay.response.headers.get("link")).toBe(link);
    posture(replay.response, replay.requestId);
    expect(replay.recorder.statements).toEqual(first.recorder.statements);
  }
  const changed = await request({ ...query, comments: "gate" }, { headers: { "if-none-match": tag } });
  expect(changed.response.status).toBe(200);
  expect(changed.response.headers.get("etag")).not.toBe(tag);
  expect(ids(await changed.response.json() as Body)).toEqual([11]);
  const projected = await request({ ...query, fields: "comments" }, { headers: { "if-none-match": tag } });
  expect(projected.response.status).toBe(200);
  expect(projected.response.headers.get("etag")).not.toBe(tag);
});

type Parameter = { name: string; in: string; required?: boolean; description?: string; example?: unknown; examples?: Record<string, { value?: unknown }>; schema?: { type?: string; maxLength?: number; description?: string; example?: unknown; examples?: unknown[] } };
type Operation = { operationId?: string; description?: string; parameters?: Parameter[]; responses?: Record<string, { description?: string }>; "x-access"?: string; "x-effect"?: string };
type Document = { paths: Record<string, { get: Operation }> };
async function document() {
  const { response } = await request(new URL("/openapi.json", ORIGIN), { token: null });
  expect(response.status).toBe(200);
  return await response.json() as Document;
}

describe("mounted comments discovery", () => {
  it("publishes one optional bounded parameter with the real SQLite/validation boundary", async () => {
    const op = (await document()).paths[PATH].get;
    const matches = op.parameters?.filter((p) => p.in === "query" && p.name === "comments") ?? [];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ required: false, schema: { type: "string", maxLength: 100 } });
    const guidance = `${op.description ?? ""} ${matches[0].description ?? ""} ${matches[0].schema?.description ?? ""}`;
    for (const pattern of [/substring/i, /literal/i, /ASCII/i, /Unicode code points/i, /before.*trim/i, /blank.*omit|omit.*blank/i, /repeat|single/i, /scan/i, /\bq\b/, /\bAND\b/]) expect(guidance).toMatch(pattern);
    expect(op).toMatchObject({ operationId: "listCustomerSnapshot", "x-access": "read", "x-effect": "local-read" });
    const error = op.responses?.["400"]?.description ?? "";
    expect(error).toContain("comments");
    expect(error).toMatch(/before.*D1/i);
  });

  it("offers an executable synthetic parameter example", async () => {
    const p = (await document()).paths[PATH].get.parameters?.find((p) => p.in === "query" && p.name === "comments");
    expect(p).toBeDefined();
    const examples = [p?.example, p?.schema?.example, ...(p?.schema?.examples ?? []), ...Object.values(p?.examples ?? {}).map((v) => v.value)].filter((v) => v !== undefined);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(typeof example).toBe("string");
      expect([...String(example)].length).toBeLessThanOrEqual(100);
      expect(String(example).trim()).not.toBe("");
      await page({ comments: String(example), includeTotal: "false", fields: "comments" });
    }
  });

  it("synchronizes the query inventory and does not introduce another endpoint or cross-resource selector", async () => {
    const doc = await document();
    const row = policyDoc.split("\n").find((line) => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    const inventory = [...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map((m) => m[1]).sort();
    expect(inventory).toContain("comments");
    expect(inventory).toEqual(doc.paths[PATH].get.parameters?.filter((p) => p.in === "query").map((p) => p.name).sort());
    for (const path of ["/api/v1/address-snapshot", "/api/v1/container-snapshot", `${PATH}/changes`, `${PATH}/export`, `${PATH}/{customerId}`]) {
      expect(doc.paths[path].get.parameters?.map((p) => p.name) ?? [], path).not.toContain("comments");
    }
    expect(Object.keys(doc.paths).filter((path) => /comments/i.test(path))).toEqual([]);
  });
});
