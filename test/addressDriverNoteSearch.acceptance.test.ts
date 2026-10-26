import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent test-first oracle. Hand-derived IDs exercise real local D1,
 * catching note/locality confusion, wildcard interpolation, missing AND scopes,
 * count/page drift, leaked values, lost continuation scope and stale ETags.
 * Only fixture setup may write; HTTP bindings deny writes, R2 and network.
 * Builder consumes this oracle unchanged; request corrections from Test Author.
 * Focus: npx vitest run test/addressDriverNoteSearch.acceptance.test.ts --maxWorkers=2
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/address-snapshot";
const ORIGIN = "https://note-client.invalid";
const TOKEN = "test-read-token";
const NOTE = "Gate amber";
const LITERAL = 'O\'Ridge 50%_ &+/#? "雪\\tail';
const INJECTION = "x' OR 1=1 --";
const HUNDRED = "🧭".repeat(100);
const ASCII_HUNDRED = "a".repeat(100);
const ALL_IDS = [11, 23, 37, 42, 58, 69, 73, 79, 83, 89, 97, 101, 109, 113, 127, 131, 137, 139, 149, 151, 157];
type Query = Record<string, string | number>;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
type Options = { token?: string | null; headers?: Record<string, string>; forbidAll?: boolean; fail?: "count" | "page" };
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
const ids = (body: Body) => body.rows.map(row => row.pickup_address_id);

// id, customer, route, franchise, enabled, street, city, zip, note, comments, state
const FIXTURES: Array<[number, number, number, string, number, string | null, string | null, string | null, string | null, string | null, string]> = [
  [11, 101, 7, "001", 1, "741 Synthetic Way", null, "00741", NOTE, null, "ZZ"],
  [23, 101, 7, "001", 1, "Plain Lane", "741 Borough", "00741", NOTE, null, "ZZ"],
  [37, 101, 7, "001", 1, "Plain Lane", null, "00741-1234", NOTE, null, "ZZ"],
  [42, 101, 8, "1", 1, "741 Synthetic Way", "741", "98000", NOTE, null, "ZZ"],
  [58, 202, 7, "001", 1, "741 Other Lane", null, "00741", NOTE, null, "ZZ"],
  [69, 101, 7, "001", 0, "741 Disabled Lane", null, "00741", NOTE, null, "ZZ"],
  [73, 101, 7, "001", 1, NOTE, null, null, "unrelated", null, "ZZ"],
  [79, 101, 7, "001", 1, "Comment Lane", null, null, "unrelated", NOTE, "ZZ"],
  [83, 101, 7, "001", 1, "City Lane", NOTE, null, "unrelated", null, "ZZ"],
  [89, 101, 7, "001", 1, "ZIP Lane", null, NOTE, "unrelated", null, "ZZ"],
  [97, 101, 7, "001", 1, "State Lane", null, null, "unrelated", null, NOTE],
  [101, 101, 7, "001", 1, "Null Lane", null, null, null, null, "ZZ"],
  [109, 101, 7, "001", 1, "Blank Lane", null, null, " \t ", null, "ZZ"],
  [113, 101, 7, "001", 1, "Empty Lane", null, null, "", null, "ZZ"],
  [127, 101, 7, "001", 1, "Literal One", null, null, LITERAL, null, "ZZ"],
  [131, 101, 7, "001", 1, "Literal Two", null, null, LITERAL, null, "ZZ"],
  [137, 101, 7, "001", 1, "Literal Three", null, null, LITERAL, null, "ZZ"],
  [139, 101, 7, "001", 1, "Case Lane", null, null, "ÅBC", null, "ZZ"],
  [149, 101, 7, "001", 1, "Astral Lane", null, null, HUNDRED, null, "ZZ"],
  [151, 101, 7, "001", 1, "ASCII Lane", null, null, ASCII_HUNDRED, null, "ZZ"],
  [157, 101, 7, "001", 1, "Injection Lane", null, null, INJECTION, null, "ZZ"]
];

let denied: string[];
let outbound: ReturnType<typeof vi.fn>;
let logs: Array<ReturnType<typeof vi.spyOn>>;
function forbid(operation: string): never {
  denied.push(operation);
  throw new Error("Forbidden effect in note acceptance");
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
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Note-acceptance", ...options.headers });
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
  expect(response.headers.get("x-request-id")).toBe("Note-acceptance");
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
  const countFree = result.url.searchParams.get("includeTotal") === "false";
  expect(result.statements).toHaveLength(countFree ? 1 : 2);
  expect(result.statements.filter(isCount)).toHaveLength(countFree ? 0 : 1);
  expect(result.prepared).toHaveLength(countFree ? 1 : 2);
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
  outbound = vi.fn(async () => { throw new Error("Forbidden outbound note request"); });
  vi.stubGlobal("fetch", outbound);
  logs = (["log", "info", "warn", "error", "debug"] as const).map(level => vi.spyOn(console, level).mockImplementation(() => undefined));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot")
  ]);
  await db.batch([101, 202].map(id => db.prepare(
    "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'synthetic-note', 1, 'fixed-time')"
  ).bind(id)));
  for (const row of [...FIXTURES].reverse()) await db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, enabled, address, city, zip, driver_note, comments, state, synced_at) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixed-time')"
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
    for (const marker of [NOTE, LITERAL, INJECTION, HUNDRED, ASCII_HUNDRED, "synthetic-private-db-marker", "private-note-", "unknown-note-marker"]) {
      expect(text).not.toContain(marker);
      expect(text).not.toContain(JSON.stringify(marker).slice(1, -1));
      expect(text).not.toContain(encodeURIComponent(marker));
      expect(text).not.toContain(new URLSearchParams({ driverNote: marker }).toString());
    }
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe("driverNote is only a stored note literal substring", () => {
  it.each([
    { label: "note-only hits, including disabled sites", driverNote: "amber", want: [11, 23, 37, 42, 58, 69] },
    { label: "ASCII folding", driverNote: "GATE AMBER", want: [11, 23, 37, 42, 58, 69] },
    { label: "trimmed boundaries", driverNote: " \t Gate amber \n", want: [11, 23, 37, 42, 58, 69] },
    { label: "no non-ASCII case folding", driverNote: "åbc", want: [] },
    { label: "ASCII folds within Unicode", driverNote: "Åbc", want: [139] },
    { label: "null/empty note never matches a nonblank value", driverNote: "Null Lane", want: [] },
    { label: "no instruction interpretation", driverNote: "open the amber gate", want: [] },
    { label: "100 astral code points", driverNote: HUNDRED, want: [149] },
    { label: "100 ASCII code points", driverNote: ASCII_HUNDRED, want: [151] },
    { label: "100 pre-trim code points", driverNote: ` ${"a".repeat(98)} `, want: [151] }
  ])("$label", async ({ driverNote, want }) => {
    const result = await page({ driverNote });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  });

  it.each([LITERAL, "%", "_", "'", "\\", "&+/#?", '"雪', INJECTION])("binds %j as literal text, never LIKE or SQL", async driverNote => {
    const result = await page({ driverNote });
    const want = driverNote === INJECTION ? [157] : driverNote === "'" ? [127, 131, 137, 157] : [127, 131, 137];
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
    expect(new Set(ids(result.body)).size).toBe(want.length);
    for (const statement of result.statements) {
      expect(statement.binds).toContain(driverNote);
      expect(statement.sql).not.toContain(LITERAL);
      expect(statement.sql).not.toContain(INJECTION);
      expect(statement.sql).not.toMatch(/\bLIKE\b/i);
    }
  });

  it.each(["", " \t\n ", " 　"])("blank %j is omitted, with identical bytes, SQL and Link", async driverNote => {
    const plain = await page({ limit: 2 });
    const blank = await page({ driverNote, limit: 2 });
    expect(ids(blank.body)).toEqual([11, 23]);
    expect(blank.bytes).toBe(plain.bytes);
    expect(blank.statements).toEqual(plain.statements);
    expect(blank.response.headers.get("etag")).toBe(plain.response.headers.get("etag"));
    expect(blank.response.headers.get("link")).toBe(plain.response.headers.get("link"));
    next(blank, { limit: 2, cursor: 23 });
    expect(ids((await page({ driverNote })).body)).toEqual(ALL_IDS);
  });

  it("does not widen q to notes or comments, and keeps locality OR semantics", async () => {
    const locality = await page({ q: NOTE });
    expect(ids(locality.body)).toEqual([73, 83, 89]);
    expect(locality.body.total).toBe(3);
    const both = await page({ driverNote: NOTE, q: NOTE });
    expect(both.body).toEqual({ rows: [], total: 0, nextCursor: null });
    expect(ids((await page({ driverNote: "741" })).body)).toEqual([]);
    expect(ids((await page({ q: "741", driverNote: NOTE })).body)).toEqual([11, 23, 37, 42, 58, 69]);
  });
});

describe.each(["true", "false"])("driverNote AND intersections includeTotal=%s", includeTotal => {
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
    { query: { zip: "00741" }, want: [11, 23, 58, 69] },
    { query: { zip: "00741-1234" }, want: [37] },
    { query: { hasContainers: "true" }, want: [23, 37, 69] },
    { query: { hasContainers: "false" }, want: [11, 42, 58] },
    { query: { hasContainers: "any" }, want: [11, 23, 37, 42, 58, 69] },
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
    const result = await page({ ...query, driverNote: NOTE, includeTotal, fields: "enabled" });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
    expect(result.body.nextCursor).toBeNull();
    for (const row of result.body.rows) expect(Object.keys(row).sort()).toEqual(["enabled", "pickup_address_id"]);
    for (const statement of result.statements) expect(statement.binds).toContain(NOTE);
    if (includeTotal === "true") {
      const count = result.statements.find(isCount)!;
      const select = result.statements.find(s => !isCount(s))!;
      const predicate = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).split(/\bORDER\s+BY\b|\bLIMIT\b/i)[0].trim().replace(/\s+/g, " ");
      expect(predicate(count.sql)).toBe(predicate(select.sql));
      expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
    }
  });
});

describe.each(["true", "false"])("driverNote continuation includeTotal=%s", includeTotal => {
  it.each([
    { order: "asc", pages: [[11, 23], [37, 42], []] },
    { order: "desc", pages: [[42, 37], [23, 11], []] }
  ])("follows every full page in $order order through terminal empty, no duplicates", async ({ order, pages }) => {
    const filters = { driverNote: NOTE, customerId: 101, enabled: "true", upperId: 58, q: "741", order, fields: "enabled", limit: 2, includeTotal };
    let current = await page({ ...filters, driverNote: ` \t${NOTE} ` });
    const seen: unknown[] = [];
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
  ])("offset-to-seek $order retains normalized note, scopes, upperId and punctuation", async ({ order, first, cursor, last }) => {
    const filters = { driverNote: NOTE, customerId: 101, enabled: "true", upperId: 42, q: "741", fields: "city,zip", order, limit: 2, includeTotal };
    const result = await page({ ...filters, offset: 1, driverNote: ` ${NOTE} ` });
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
      const result = await page({ ...query, driverNote: NOTE, customerId: 101, enabled: "true", limit: 2, includeTotal });
      expect(ids(result.body)).toEqual(want);
      expect(result.body.total).toBe(includeTotal === "false" ? null : total);
      expect(result.body.nextCursor).toBe(cursor);
      if (query.cursor !== undefined) for (const s of result.statements) expect(s.sql).not.toMatch(/\bOFFSET\b/i);
      if (cursor === null) expect(result.response.headers.get("link")).toBeNull();
    }
  });

  it.each(["asc", "desc"])("URL-encodes literal note once in followable %s links", async order => {
    const filters = { driverNote: LITERAL, routeId: 7, franchiseId: "001", fields: "driver_note", upperId: 137, order, limit: 2, includeTotal };
    const first = await page(filters);
    expect(ids(first.body)).toEqual(order === "asc" ? [127, 131] : [137, 131]);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 3);
    const target = next(first, { ...filters, cursor: 131 });
    expect(first.response.headers.get("link")).not.toContain(LITERAL);
    const last = await page(target);
    expect(last.body.rows).toEqual([{ pickup_address_id: order === "asc" ? 137 : 127, driver_note: LITERAL }]);
    expect(last.body.total).toBe(includeTotal === "false" ? null : 1);
    expect(last.body.nextCursor).toBeNull();
  });

  it("retains single-ID and child-presence scope in a full terminal page link", async () => {
    const filters = { driverNote: NOTE, pickupAddressId: 23, customerId: 101, routeId: 7, franchiseId: "001", zip: "00741", enabled: "true", hasContainers: "true", upperId: 37, fields: "enabled", order: "desc", limit: 1, includeTotal };
    const first = await page(filters);
    expect(ids(first.body)).toEqual([23]);
    const last = await page(next(first, { ...filters, cursor: 23 }));
    expect(last.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(last.response.headers.get("link")).toBeNull();
  });
});

describe("driverNote representation and read authority", () => {
  it("count-free returns identical page SQL, rows and cursor without COUNT or lookahead", async () => {
    const filters = { driverNote: NOTE, customerId: 101, enabled: "true", fields: "enabled", limit: 2 };
    const counted = await page(filters);
    const free = await page({ ...filters, includeTotal: "false" });
    expect(ids(free.body)).toEqual([11, 23]);
    expect(counted.body.total).toBe(4);
    expect(free.body).toEqual({ rows: counted.body.rows, total: null, nextCursor: 23 });
    expect(free.statements).toEqual(counted.statements.filter(s => !isCount(s)));
  });

  it.each(["true", "false"])("hashes final sparse envelope and revalidates 304 with reads, includeTotal=%s", async includeTotal => {
    const query = { driverNote: NOTE, customerId: 101, enabled: "true", fields: "city,zip", limit: 2, includeTotal };
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

  it("recomputes membership after an unprojected stored note changes with unchanged synced_at", async () => {
    const query = { driverNote: NOTE, customerId: 101, enabled: "true", fields: "address" };
    const first = await page(query);
    expect(ids(first.body)).toEqual([11, 23, 37, 42]);
    // Fixture-only write, never exposed to the HTTP binding.
    await TEST_ENV.CUSTOMER_DB.prepare("UPDATE address_snapshot SET driver_note = 'unrelated' WHERE pickup_address_id = 23").run();
    const changed = await page(query, { "if-none-match": first.response.headers.get("etag")! });
    expect(ids(changed.body)).toEqual([11, 37, 42]);
    expect(changed.body.total).toBe(3);
    expect(changed.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
  });

  it("is idempotent, preserves full stored rows and ignores untrusted raw GET params in links", async () => {
    const before = await TEST_ENV.CUSTOMER_DB.prepare("SELECT * FROM address_snapshot ORDER BY pickup_address_id").all();
    const first = await page({ driverNote: NOTE, limit: 2 });
    expect(first.body.rows[0]).toMatchObject({ pickup_address_id: 11, customer_id: 101, driver_note: NOTE, comments: null, synced_at: "fixed-time" });
    const url = new URL(PATH, "https://untrusted-origin.invalid");
    url.search = new URLSearchParams({ driverNote: NOTE, limit: "2", "unknown-note-marker": "unknown-note-marker", token: "query-token-marker", url: "https://redirect-marker.invalid" }).toString();
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
    const result = await request({ driverNote: NOTE, pickupAddressId: 11 }, { token });
    expect(result.response.status).toBe(200);
    posture(result.response);
    expect(ids(await result.response.json() as Body)).toEqual([11]);
  });
});

describe("driverNote validation and value-free failures", () => {
  const invalid = [
    new URLSearchParams({ driverNote: `${HUNDRED}🧭` }).toString(),
    new URLSearchParams({ driverNote: `${ASCII_HUNDRED}a` }).toString(),
    new URLSearchParams({ driverNote: `private-note-padding${" ".repeat(101)}` }).toString(),
    new URLSearchParams({ driverNote: " ".repeat(101) }).toString(),
    "driverNote=private-note-first&driverNote=private-note-second",
    "driverNote=private-note-first&driver%4Eote=private-note-second",
    "driverNote=&driverNote=private-note-second",
    "driverNote=&driverNote="
  ];
  it.each(invalid)("rejects invalid query before D1 without echoing submitted data: %s", async query => {
    const result = await request(`${query}&private-note-unknown=unknown-note-marker`, { forbidAll: true, headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    posture(result.response);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const bytes = await result.response.text();
    const body = JSON.parse(bytes) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["detail", "status", "title", "type"]);
    expect(body).toMatchObject({ type: expect.stringMatching(/#bad-request$/), title: "Bad Request", status: 400 });
    // Recovery lives in the established problem detail, not a new header/field.
    const action = String(body.detail);
    expect(action).toContain("driverNote");
    expect(action).toContain("docs/PROBLEMS.md#bad-request");
    expect(action).toMatch(/100/);
    expect(action).toMatch(/code.point/i);
    expect(action).toMatch(/one|single/i);
    expect(action).toMatch(/omit/i);
    expect(action).toMatch(/retry/i);
    for (const marker of ["private-note-", "unknown-note-marker", "🧭", ASCII_HUNDRED]) expect(bytes).not.toContain(marker);
    expect(result.prepared).toEqual([]);
    expect(result.statements).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
  });

  it("uses the same fixed correction for repeated and overlength values", async () => {
    const oversized = await request(invalid[0], { forbidAll: true });
    const repeated = await request(invalid[4], { forbidAll: true });
    expect(oversized.response.status).toBe(400);
    expect(repeated.response.status).toBe(400);
    expect(await repeated.response.json()).toEqual(await oversized.response.json());
    expect(oversized.prepared).toEqual([]);
    expect(repeated.prepared).toEqual([]);
  });

  it.each([null, "incorrect-synthetic-token"])("auth precedes repeated/oversize validation and conditional handling: %s", async token => {
    for (const query of [invalid[0], invalid[4], "driverNote=private-note-valid"]) {
      const result = await request(query, { token, forbidAll: true, headers: { "if-none-match": "*" } });
      expect(result.response.status).toBe(401);
      expect(await result.response.text()).not.toContain("private-note-");
      expect(result.prepared).toEqual([]);
      expect(result.response.headers.get("link")).toBeNull();
      expect(result.response.headers.get("etag")).toBeNull();
    }
  });

  it.each(["count", "page"] as const)("D1 %s failures do not log or reflect notes or private exceptions", async fail => {
    const result = await request({ driverNote: LITERAL }, { fail });
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

describe("driverNote mounted discovery", () => {
  it("publishes one optional bounded note selector on the existing local-read operation only", async () => {
    const result = await request(new URL("/openapi.json", "http://test.local"), { forbidAll: true });
    expect(result.response.status).toBe(200);
    type Operation = { operationId?: string; parameters?: Array<{ name: string; in: string; required?: boolean; description?: string; example?: unknown; schema?: Record<string, unknown> }>; responses?: Record<string, { description?: string }>; [key: string]: unknown };
    const document = await result.response.json() as { paths: Record<string, { get?: Operation }> };
    const operation = document.paths[PATH]?.get;
    expect(operation).toMatchObject({ operationId: "listAddressSnapshot", "x-access": "read", "x-effect": "local-read" });
    const parameters = operation?.parameters?.filter(p => p.name === "driverNote");
    expect(parameters).toHaveLength(1);
    expect(parameters![0]).toMatchObject({ in: "query", required: false, schema: { type: "string", maxLength: 100 } });
    expect(parameters![0].schema?.default).toBeUndefined();
    const guidance = `${parameters![0].description ?? ""} ${parameters![0].schema?.description ?? ""} ${operation?.description ?? ""}`;
    expect(guidance).toMatch(/driver_note/);
    expect(guidance).toMatch(/literal[\s\S]*substring|substring[\s\S]*literal/i);
    expect(guidance).toMatch(/ASCII/);
    expect(guidance).toMatch(/code.point/i);
    expect(guidance).toMatch(/trim/i);
    expect(guidance).toMatch(/blank|whitespace/i);
    expect(guidance).toMatch(/\bAND\b|intersect/i);
    expect(operation?.responses?.["400"]?.description).toMatch(/driverNote/);
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/container-snapshot", "/api/v1/customer-snapshot/changes", "/api/v1/address-snapshot/{pickupAddressId}"]) {
      expect(document.paths[path]?.get?.parameters?.map(p => p.name) ?? []).not.toContain("driverNote");
    }
    expect(result.prepared).toEqual([]);
  });
});
