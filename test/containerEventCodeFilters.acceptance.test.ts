/// <reference types="vite/client" />

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";

/**
 * Test-Author-owned oracle. Run: npx vitest run --maxWorkers=2
 * test/containerEventCodeFilters.acceptance.test.ts
 * Real hermetic D1; literal expected IDs, never a production predicate helper.
 * Mutation targets: ignored/swapped/trimmed/LIKE/case-folded/numeric-coerced
 * codes, OR grouping, null-or-empty presence drift, missing COUNT/seek
 * predicates, UTF-16 bounds, validation after D1/auth/304, lost or unsafe
 * next-link selectors, stale ETags and undocumented parameters.
 * Stored code text is opaque mirrored text: not dispatch state, event history,
 * proof of service or a controlled taxonomy.
 * Intended state: RED before the paired build. Builder: consume this commit
 * WITHOUT editing this file; oracle corrections stay Test-Author-owned.
 * No implementation, real tenant data, external services or schema changes.
 */
const TEST_ENV = env as unknown as Env;
const ORIGIN = "https://container-event-code.test.invalid";
const PATH = "/api/v1/container-snapshot";
const CODE = "E-001";
const SPECIAL = " 雪' OR 1=1 -- \"%_ /+?&#🚛 ";
const HUNDRED = "🚛".repeat(100);
const STAMP = "2026-01-02T03:04:05.000Z";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";

// Matches share one code across customers/parents; decoys prove the predicate
// reads only c.event_code, never parent columns or parsed numbers. Dangling
// parent links are impossible under the enforced FK, so orphan visibility is
// pinned separately via a legacy constraint-free table below.
const CODE_MATCHES = [101, 102, 104, 105, 125];
const ABSENT = [108, 112, 126];
const PRESENT = [
  101, 102, 103, 104, 105, 106, 107, 109, 110, 111, 113, 114, 115, 116,
  117, 118, 119, 120, 121, 122, 123, 124, 125, 127, 128,
];
const ALL_IDS = Array.from({ length: 28 }, (_, index) => 101 + index);

type Query = Record<string, string> | URLSearchParams | URL;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
// id, parent, event_code, enabled, location, serial, rfid, material, color, zip, state, city.
type Fixture = readonly [number, number, string | null, number, string, string, string, string, string, string, string, string];

const OTHER: readonly [string, string, string, string, string, string, string, string] =
  ["other depot", "SN-00", "ZZZ", "zzz", "zzz", "00000", "ZZ", "Other City"];
const NORTH: readonly [string, string, string, string, string, string, string, string] =
  ["north depot", "SN-01", "TAG", "001", "Blue", "02139", "ST-01", "Depot City"];

const fixtures: readonly Fixture[] = [
  [101, 11, CODE, 1, ...NORTH],
  [102, 11, CODE, 1, "north depot", "SN-02", "TAG", "001", "Blue", "02139", "ST-01", "Depot City"],
  [103, 11, "e-001", 1, ...OTHER],
  [104, 12, CODE, 0, "south depot", "SN-01", "OTHER", "other", "Red", "99999", "ST-02", "South City"],
  [105, 21, CODE, 1, ...NORTH],
  [106, 11, "xE-001x", 1, ...OTHER],
  [107, 11, "E-001x", 1, ...OTHER],
  [108, 11, null, 1, ...OTHER],
  [109, 11, "001", 1, ...OTHER],
  [110, 11, " E-001 ", 1, ...OTHER],
  [111, 11, SPECIAL, 1, ...OTHER],
  [112, 11, "", 1, ...OTHER],
  [113, 11, "é", 1, ...OTHER],
  [114, 11, "é", 1, ...OTHER],
  [115, 11, HUNDRED, 1, ...OTHER],
  [116, 11, "a".repeat(100), 1, ...OTHER],
  [117, 11, "a", 1, ...OTHER],
  [118, 11, "A", 1, ...OTHER],
  [119, 11, "0", 1, ...OTHER],
  [120, 11, "🚛", 1, ...OTHER],
  [121, 11, " \tcode\n ", 1, ...OTHER],
  [122, 11, SPECIAL, 1, ...OTHER],
  [123, 11, "%_", 1, ...OTHER],
  [124, 11, "   ", 1, ...OTHER],
  [125, 11, CODE, 1, ...NORTH],
  [126, 11, null, 1, ...OTHER],
  [127, 12, "other", 1, ...OTHER],
  [128, 12, "zzz-other", 1, ...OTHER],
];

const recorders: ReturnType<typeof recordedDb>[] = [];
const denyExternal = vi.fn(() => { throw new Error("Event-code reads must not use external services or writes"); });
let initialState: unknown;

function recordedDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const forbid = vi.fn(() => { throw new Error("Event-code reads must only SELECT local D1"); });
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    const record = () => { statements.push({ sql, binds }); };
    return {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql, values),
      first: (...args: unknown[]) => {
        record();
        return (stmt.first as (...args: unknown[]) => unknown)(...args);
      },
      all: () => { record(); return stmt.all(); },
      raw: (...args: unknown[]) => {
        record();
        return (stmt.raw as (...args: unknown[]) => unknown)(...args);
      },
      run: forbid,
    } as unknown as D1PreparedStatement;
  }
  const db = {
    prepare: (sql: string) => {
      prepared.push(sql);
      if (!/^\s*SELECT\b/i.test(sql)) return forbid();
      return wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []);
    },
    batch: forbid, exec: forbid,
  } as unknown as D1Database;
  return { db, prepared, statements, forbid };
}

function deniedDb() {
  const forbid = vi.fn(() => { throw new Error("Rejected request must not prepare or execute D1"); });
  return { db: { prepare: forbid, batch: forbid, exec: forbid } as unknown as D1Database, forbid };
}

async function state() {
  const db = TEST_ENV.CUSTOMER_DB;
  const rows = await Promise.all([
    db.prepare("SELECT * FROM customer_snapshot ORDER BY customer_id").all(),
    db.prepare("SELECT * FROM address_snapshot ORDER BY pickup_address_id").all(),
    db.prepare("SELECT * FROM container_snapshot ORDER BY container_id").all(),
    db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
  ]);
  return rows.map(row => row.results);
}

async function request(query: Query = {}, options: {
  token?: string | null; db?: D1Database; headers?: Record<string, string>;
} = {}) {
  const recorder = recordedDb();
  recorders.push(recorder);
  const url = query instanceof URL ? query : new URL(PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = new URLSearchParams(query).toString();
  const headers = new Headers(options.headers);
  const token = options.token === undefined ? "test-read-token" : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: options.db ?? recorder.db,
    SNAPSHOTS: Object.fromEntries([
      "get", "head", "list", "put", "delete", "createMultipartUpload", "resumeMultipartUpload",
    ].map(method => [method, denyExternal])) as unknown as R2Bucket,
    BROWSER: { fetch: denyExternal } as unknown as Fetcher,
  });
  return { response, recorder, url };
}

const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
const ids = (body: Body) => body.rows.map(row => row.container_id);
function reads(result: Awaited<ReturnType<typeof request>>) {
  const countFree = result.url.searchParams.get("includeTotal") === "false";
  expect(result.recorder.statements).toHaveLength(countFree ? 1 : 2);
  expect(result.recorder.statements.filter(isCount)).toHaveLength(countFree ? 0 : 1);
}
async function page(query: Query = {}) {
  const result = await request(query);
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  reads(result);
  const body = await result.response.json() as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  if (result.url.searchParams.get("includeTotal") === "false") expect(body.total).toBeNull();
  return { ...result, body };
}
async function count(query: Query = {}) {
  const params = query instanceof URL ? query.searchParams : new URLSearchParams(query);
  params.set("countOnly", "true");
  const source = query instanceof URL ? query : params;
  const result = await request(source);
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  expect(result.recorder.statements).toHaveLength(1);
  expect(result.recorder.statements.filter(isCount)).toHaveLength(1);
  expect(result.response.headers.get("link")).toBeNull();
  const body = await result.response.json() as Body;
  expect(body.rows).toEqual([]);
  expect(body.nextCursor).toBeNull();
  return { ...result, body };
}

function next(result: Awaited<ReturnType<typeof page>>, expected: Record<string, string>) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/container-snapshot\?[^<>\s]*>; rel="next"$/);
  const url = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(url.origin).toBe(ORIGIN);
  expect(url.username).toBe("");
  expect(url.password).toBe("");
  expect(url.hash).toBe("");
  expect(url.pathname).toBe(PATH);
  expect(url.searchParams.has("offset")).toBe(false);
  expect(url.searchParams.getAll("cursor")).toEqual([String(result.body.nextCursor)]);
  for (const [key, value] of Object.entries(expected)) {
    expect(url.searchParams.getAll(key), key).toEqual([value]);
  }
  expect([...url.searchParams.keys()].every(key => key === "cursor" || Object.hasOwn(expected, key))).toBe(true);
  return url;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  recorders.length = 0;
  denyExternal.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound fetch in event-code oracle"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, synced_at) VALUES (1, 'Synthetic One', ?), (2, 'Synthetic Two', ?)").bind(STAMP, STAMP),
    // Parent 12 carries the code text as franchise AND city: containers under
    // it match only by their own stored event_code, never by parent columns.
    db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, city, enabled, synced_at) VALUES (11, 1, 7, 'F-11', 'Parent City', 1, ?), (12, 1, 7, ?, ?, 1, ?), (21, 2, 9, 'F-21', 'Other City', 1, ?)").bind(STAMP, CODE, CODE, STAMP, STAMP),
  ]);
  await db.batch([...fixtures].reverse().map(([id, address, code, enabled, location, serial, rfid, material, color, zip, stateName, city]) =>
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, event_code, enabled, location_address, serial_number, rfid, ud_material_stream_ud, color, zip, state, city, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, address, code, enabled, location, serial, rfid, material, color, zip, stateName, city, STAMP)));
  initialState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denyExternal).not.toHaveBeenCalled();
    for (const recorder of recorders) expect(recorder.forbid).not.toHaveBeenCalled();
    expect(await state(), "every GET leaves rows and schema unchanged").toEqual(initialState);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe("eventCode: exact opaque stored code", () => {
  it("retains duplicate exact matches across parents and customers", async () => {
    const result = await page({ eventCode: CODE });
    expect(ids(result.body)).toEqual(CODE_MATCHES);
    expect(result.body.total).toBe(5);
    expect(result.body.nextCursor).toBeNull();
    for (const row of result.body.rows) {
      expect(row.event_code).toBe(CODE);
      expect(typeof row.container_id).toBe("number");
    }
    expect(new Set(ids(result.body)).size).toBe(5);
  });

  it.each([
    ["case differs", "e-001", [103]],
    ["superstring is not a substring match", "xE-001x", [106]],
    ["prefix extension is distinct", "E-001x", [107]],
    ["leading zeros are text, not a number", "001", [109]],
    ["numeric coercion never matches zero-padded text", "1", []],
    ["significant padding is a distinct code", " E-001 ", [110]],
    ["quotes and URL delimiters are literal", SPECIAL, [111, 122]],
    ["LIKE wildcards are literal", "%_", [123]],
    ["a SQL-looking unknown cannot widen selection", "' OR 1=1 --", []],
    ["null is not a string", "null", []],
    ["unknown code is a normal empty success", "synthetic-unknown", []],
    ["composed Unicode is not normalized", "é", [113]],
    ["decomposed Unicode is not normalized", "é", [114]],
    ["100 astral code points (not UTF-16 units)", HUNDRED, [115]],
    ["100 ASCII code points", "a".repeat(100), [116]],
    ["lowercase", "a", [117]],
    ["uppercase", "A", [118]],
    ["zero is text", "0", [119]],
    ["one astral code point", "🚛", [120]],
    ["nonblank tabs/newlines remain data", " \tcode\n ", [121]],
    ["parent franchise text never leaks into matches", "other", [127]],
    ["second parent-decoy exclusion", "zzz-other", [128]],
  ] as const)("%s", async (_name, code, expected) => {
    const result = await page({ eventCode: code });
    expect(ids(result.body)).toEqual(expected);
    expect(result.body.total).toBe(expected.length);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  });

  it("empty-string eventCode is invalid, not an empty-match selector", async () => {
    const db = deniedDb();
    const result = await request({ eventCode: "" }, { db: db.db });
    expect(db.forbid).not.toHaveBeenCalled();
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({
      type: BAD_REQUEST, title: "Bad Request", status: 400,
      detail: "Invalid request query (eventCode). See docs/PROBLEMS.md#bad-request.",
    });
  });

  const invalid = [
    ["ASCII blanks", " \t\r\n "], ["Unicode blanks", "  　"],
    ["101 ASCII code points", "synthetic-private-" + "x".repeat(83)],
    ["101 astral code points", "🚛".repeat(101)],
    ["100 ASCII plus an astral code point", "x".repeat(100) + "🚛"],
  ];
  it.each(invalid)("rejects %s before D1 and conditional handling with value-free errors", async (_name, value) => {
    const db = deniedDb();
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const result = await request({ eventCode: value }, { db: db.db, headers: { "if-none-match": "*" } });
    expect(db.forbid).not.toHaveBeenCalled();
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("link")).toBeNull();
    expect(await result.response.json()).toEqual({
      type: BAD_REQUEST, title: "Bad Request", status: 400,
      detail: "Invalid request query (eventCode). See docs/PROBLEMS.md#bad-request.",
    });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["same", "synthetic-private-a", "synthetic-private-a"],
    ["different", "synthetic-private-a", "synthetic-private-b"],
    ["empty first", "", "synthetic-private-b"], ["empty last", "synthetic-private-a", ""],
  ])("rejects repeated keys (%s), never echoing either value", async (_name, a, b) => {
    const db = deniedDb();
    const result = await request(new URLSearchParams([["eventCode", a], ["eventCode", b]]), { db: db.db });
    expect(db.forbid).not.toHaveBeenCalled();
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const text = await result.response.text();
    expect(text).not.toMatch(/synthetic-private/);
    expect(JSON.parse(text)).toEqual({
      type: BAD_REQUEST, title: "Bad Request", status: 400,
      detail: "Invalid request query (eventCode). See docs/PROBLEMS.md#bad-request.",
    });
  });

  it("rejects a bare key as empty before D1", async () => {
    const db = deniedDb();
    const result = await request(new URL(`${PATH}?eventCode`, ORIGIN), { db: db.db });
    expect(db.forbid).not.toHaveBeenCalled();
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({
      type: BAD_REQUEST, title: "Bad Request", status: 400,
      detail: "Invalid request query (eventCode). See docs/PROBLEMS.md#bad-request.",
    });
  });

  it("decodes an encoded duplicate key before repetition validation", async () => {
    const db = deniedDb();
    const url = new URL(`${PATH}?eventCode=first&%65ventCode=second`, ORIGIN);
    const result = await request(url, { db: db.db });
    expect(db.forbid).not.toHaveBeenCalled();
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toMatchObject({ status: 400, detail: "Invalid request query (eventCode). See docs/PROBLEMS.md#bad-request." });
  });
});

describe("hasEventCode: missing-code cohort", () => {
  it("true keeps every non-null nonempty code, including whitespace-only text", async () => {
    const result = await page({ hasEventCode: "true" });
    expect(ids(result.body)).toEqual(PRESENT);
    expect(result.body.total).toBe(25);
    expect(result.body.nextCursor).toBeNull();
    for (const row of result.body.rows) {
      expect(row.event_code).not.toBeNull();
      expect(row.event_code).not.toBe("");
    }
    expect(result.body.rows.find(row => row.container_id === 124)).toMatchObject({ event_code: "   " });
  });

  it("false keeps exactly the null-or-empty complement", async () => {
    const result = await page({ hasEventCode: "false" });
    expect(ids(result.body)).toEqual(ABSENT);
    expect(result.body.total).toBe(3);
    expect(result.body.nextCursor).toBeNull();
    expect(result.body.rows).toEqual([
      expect.objectContaining({ container_id: 108, event_code: null }),
      expect.objectContaining({ container_id: 112, event_code: "" }),
      expect.objectContaining({ container_id: 126, event_code: null }),
    ]);
  });

  it("any and omission add no predicate and keep identical SQL", async () => {
    const omitted = await page();
    const any = await page({ hasEventCode: "any" });
    expect(any.body).toEqual(omitted.body);
    expect(ids(any.body)).toEqual(ALL_IDS);
    expect(any.recorder.statements.map(s => ({ sql: s.sql, binds: s.binds })))
      .toEqual(omitted.recorder.statements.map(s => ({ sql: s.sql, binds: s.binds })));
  });

  it("a joined presence scope keeps the predicate while narrowing the cohort", async () => {
    const present = await page({ hasEventCode: "true", customerId: "1" });
    expect(ids(present.body)).toEqual(PRESENT.filter(id => id !== 105));
    expect(present.body.total).toBe(24);
    const absent = await page({ hasEventCode: "false", customerId: "1" });
    expect(ids(absent.body)).toEqual(ABSENT);
    expect(absent.body.total).toBe(3);
  });

  it.each([
    ["empty", ""], ["blank", " "], ["capitalized", "True"], ["upper", "FALSE"],
    ["padded true", " true"], ["padded any", "any "], ["numeric", "1"], ["word", "yes"],
  ])("rejects %s before D1 with value-free errors", async (_name, value) => {
    const db = deniedDb();
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const result = await request({ hasEventCode: value }, { db: db.db, headers: { "if-none-match": "*" } });
    expect(db.forbid).not.toHaveBeenCalled();
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("link")).toBeNull();
    expect(await result.response.json()).toEqual({
      type: BAD_REQUEST, title: "Bad Request", status: 400,
      detail: "Invalid request query (hasEventCode). See docs/PROBLEMS.md#bad-request.",
    });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["same", "true", "true"], ["mixed", "true", "false"], ["any plus true", "any", "true"],
  ])("rejects repeated keys (%s)", async (_name, a, b) => {
    const db = deniedDb();
    const result = await request(new URLSearchParams([["hasEventCode", a], ["hasEventCode", b]]), { db: db.db });
    expect(db.forbid).not.toHaveBeenCalled();
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({
      type: BAD_REQUEST, title: "Bad Request", status: 400,
      detail: "Invalid request query (hasEventCode). See docs/PROBLEMS.md#bad-request.",
    });
  });

  it("rejects a bare key as empty before D1", async () => {
    const db = deniedDb();
    const result = await request(new URL(`${PATH}?hasEventCode`, ORIGIN), { db: db.db });
    expect(db.forbid).not.toHaveBeenCalled();
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({
      type: BAD_REQUEST, title: "Bad Request", status: 400,
      detail: "Invalid request query (hasEventCode). See docs/PROBLEMS.md#bad-request.",
    });
  });

  it("decodes an encoded duplicate key before repetition validation", async () => {
    const db = deniedDb();
    const url = new URL(`${PATH}?hasEventCode=true&%68asEventCode=false`, ORIGIN);
    const result = await request(url, { db: db.db });
    expect(db.forbid).not.toHaveBeenCalled();
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toMatchObject({ status: 400, detail: "Invalid request query (hasEventCode). See docs/PROBLEMS.md#bad-request." });
  });
});

describe("event-code intersections, legacy controls and authority", () => {
  it.each([
    ["no other filter", {}, CODE_MATCHES],
    ["qualified customer join", { customerId: "1" }, [101, 102, 104, 125]],
    ["other customer join", { customerId: "2" }, [105]],
    ["other address", { pickupAddressId: "21" }, [105]],
    ["address", { pickupAddressId: "11" }, [101, 102, 125]],
    ["container", { containerId: "104" }, [104]],
    ["canonical ID set", { ids: "125,102,101" }, [101, 102, 125]],
    ["ID set cannot escape the code", { ids: "103,106,108" }, []],
    ["serialNumber", { serialNumber: "SN-01" }, [101, 104, 105, 125]],
    ["lone serial", { serialNumber: "SN-02" }, [102]],
    ["rfid", { rfid: "TAG" }, [101, 102, 105, 125]],
    ["lone rfid", { rfid: "OTHER" }, [104]],
    ["materialStream", { materialStream: "001" }, [101, 102, 105, 125]],
    ["color", { color: "Blue" }, [101, 102, 105, 125]],
    ["lone color", { color: "Red" }, [104]],
    ["zip", { zip: "02139" }, [101, 102, 105, 125]],
    ["locationAddress", { locationAddress: "north depot" }, [101, 102, 105, 125]],
    ["state", { state: "ST-01" }, [101, 102, 105, 125]],
    ["q", { q: "NORTH" }, [101, 102, 105, 125]],
    ["q mismatch", { q: "south" }, [104]],
    ["enabled true", { enabled: "true" }, [101, 102, 105, 125]],
    ["enabled false", { enabled: "false" }, [104]],
    ["enabled any", { enabled: "any" }, CODE_MATCHES],
    ["parent route", { parentRouteId: "7" }, [101, 102, 104, 125]],
    ["other parent route", { parentRouteId: "9" }, [105]],
    ["parent franchise", { parentFranchiseId: "F-11" }, [101, 102, 125]],
    ["code-text parent franchise still ANDs", { parentFranchiseId: CODE }, [104]],
    ["parent enabled true", { parentEnabled: "true" }, CODE_MATCHES],
    ["parent enabled false", { parentEnabled: "false" }, []],
    ["presence true", { hasEventCode: "true" }, CODE_MATCHES],
    ["presence any", { hasEventCode: "any" }, CODE_MATCHES],
    ["all existing row selectors", { customerId: "1", pickupAddressId: "11", containerId: "101", q: "north", enabled: "true", serialNumber: "SN-01", rfid: "TAG" }, [101]],
    ["conflicting customer/address", { customerId: "2", pickupAddressId: "11" }, []],
    ["conflicting identifier", { serialNumber: "SN-02", rfid: "OTHER" }, []],
  ] as const)("ANDs eventCode with %s in both counted and count-free modes", async (_name, filters, expected) => {
    for (const includeTotal of ["true", "false"]) {
      const result = await page({ eventCode: CODE, ...filters, includeTotal });
      expect(ids(result.body)).toEqual(expected);
      expect(result.body.total).toBe(includeTotal === "false" ? null : expected.length);
      expect(result.body.nextCursor).toBeNull();
    }
  });

  it.each([
    ["exact plus absence is empty", { eventCode: CODE, hasEventCode: "false" }, []],
    ["special plus absence is empty", { eventCode: SPECIAL, hasEventCode: "false" }, []],
    ["absence plus unknown code is empty", { eventCode: "synthetic-unknown", hasEventCode: "false" }, []],
    ["absence alone", { hasEventCode: "false" }, ABSENT],
    ["absence plus customer join", { hasEventCode: "false", customerId: "1" }, ABSENT],
    ["absence plus serial", { hasEventCode: "false", serialNumber: "SN-00" }, ABSENT],
    ["absence plus enabled", { hasEventCode: "false", enabled: "true" }, ABSENT],
    ["absence plus parent scope", { hasEventCode: "false", parentRouteId: "7" }, ABSENT],
    ["presence plus special", { eventCode: SPECIAL, hasEventCode: "true" }, [111, 122]],
  ] as const)("%s", async (_name, query, expected) => {
    const result = await page(query);
    expect(ids(result.body)).toEqual(expected);
    expect(result.body.total).toBe(expected.length);
    expect(result.body.nextCursor).toBeNull();
  });

  it.each([
    [{ eventCode: CODE }, 5],
    [{ eventCode: CODE, customerId: "1" }, 4],
    [{ eventCode: SPECIAL }, 2],
    [{ eventCode: "synthetic-unknown" }, 0],
    [{ hasEventCode: "true" }, 25],
    [{ hasEventCode: "false" }, 3],
    [{ hasEventCode: "false", customerId: "1" }, 3],
    [{ eventCode: CODE, hasEventCode: "false" }, 0],
    [{ eventCode: CODE, hasEventCode: "true" }, 5],
  ] as const)("countOnly inspects the filtered cohort without row payloads: %j", async (query, total) => {
    const result = await count(query);
    expect(result.body.total).toBe(total);
  });

  it("CONTROL: omission preserves null/empty codes, canonical IDs and defaults", async () => {
    const result = await page();
    expect(ids(result.body)).toEqual(ALL_IDS);
    expect(result.body.total).toBe(28);
    expect(result.body.rows[0]).toMatchObject({ container_id: 101, pickup_address_id: 11, event_code: CODE, synced_at: STAMP });
    expect(result.body.rows[7]).toMatchObject({ container_id: 108, event_code: null });
    expect(result.body.rows[11]).toMatchObject({ container_id: 112, event_code: "" });
    expect(result.body.rows[24]).toMatchObject({ container_id: 125, pickup_address_id: 11, event_code: CODE });
    expect(result.body.nextCursor).toBeNull();
    const explicit = await page({ hasEventCode: "any", enabled: "any", includeTotal: "true", offset: "0", limit: "50" });
    expect(explicit.body).toEqual(result.body);
  });

  it("CONTROL: unknown keys stay ignored in default mode", async () => {
    const bare = await page();
    const bogus = await page(new URL(`${PATH}?bogus_param=1&custmerId=999`, ORIGIN));
    expect(bogus.body).toEqual(bare.body);
    expect(bogus.recorder.statements).toEqual(bare.recorder.statements);
  });

  it.each([null, "invalid-read-token"])("CONTROL: auth precedes malformed codes (token %s)", async token => {
    const db = deniedDb();
    const result = await request(new URLSearchParams([["eventCode", ""], ["hasEventCode", "maybe"], ["hasEventCode", "true"]]), {
      token, db: db.db, headers: { "if-none-match": "*" },
    });
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const problem = await result.response.json();
    expect(problem).toMatchObject({ status: 401, title: "Unauthorized" });
    expect(JSON.stringify(problem)).not.toMatch(/eventCode|hasEventCode|maybe/);
    expect(db.forbid).not.toHaveBeenCalled();
  });

  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("retains authorized local GET access with %s", async token => {
    const result = await request({ eventCode: CODE, hasEventCode: "true" }, { token });
    expect(result.response.status).toBe(200);
    expect(ids(await result.response.json() as Body)).toEqual(CODE_MATCHES);
  });

  it("filters before sparse projection and always keeps the canonical ID", async () => {
    const result = await page({ eventCode: CODE, hasEventCode: "true", fields: "event_code,enabled", includeTotal: "false" });
    expect(result.body).toEqual({
      rows: [
        { container_id: 101, event_code: CODE, enabled: 1 },
        { container_id: 102, event_code: CODE, enabled: 1 },
        { container_id: 104, event_code: CODE, enabled: 0 },
        { container_id: 105, event_code: CODE, enabled: 1 },
        { container_id: 125, event_code: CODE, enabled: 1 },
      ], total: null, nextCursor: null
    });
  });

  it("is idempotent and never logs successful codes", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const first = await page({ eventCode: SPECIAL, hasEventCode: "true" });
    const second = await page({ eventCode: SPECIAL, hasEventCode: "true" });
    expect(ids(first.body)).toEqual([111, 122]);
    expect(second.body).toEqual(first.body);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe.each(["true", "false"])("event-code continuation includeTotal=%s", includeTotal => {
  it.each([
    ["asc", [101, 102], 102, [104, 105], 105, [125]],
    ["desc", [125, 105], 105, [104, 102], 102, [101]],
  ] as const)("follows %s code pages with cursor-relative totals", async (order, firstIds, firstCursor, secondIds, secondCursor, lastIds) => {
    const filters = { eventCode: CODE, limit: "2", includeTotal, order };
    const first = await page(filters);
    expect(ids(first.body)).toEqual(firstIds);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 5);
    expect(first.body.nextCursor).toBe(firstCursor);
    const second = await page(next(first, filters));
    expect(ids(second.body)).toEqual(secondIds);
    expect(second.body.total).toBe(includeTotal === "false" ? null : 3);
    expect(second.body.nextCursor).toBe(secondCursor);
    const last = await page(next(second, filters));
    expect(ids(last.body)).toEqual(lastIds);
    expect(last.body.total).toBe(includeTotal === "false" ? null : 1);
    expect(last.body.nextCursor).toBeNull();
    expect(last.response.headers.get("link")).toBeNull();
  });

  it("reaches the null cohort through an absence seek", async () => {
    const filters = { hasEventCode: "false", limit: "2", includeTotal };
    const first = await page(filters);
    expect(ids(first.body)).toEqual([108, 112]);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 3);
    expect(first.body.nextCursor).toBe(112);
    const last = await page(next(first, filters));
    expect(ids(last.body)).toEqual([126]);
    expect(last.body.total).toBe(includeTotal === "false" ? null : 1);
    expect(last.body.nextCursor).toBeNull();
  });

  it("retains a lone special code until the full final/empty terminal page", async () => {
    const filters = { eventCode: SPECIAL, hasEventCode: "true", limit: "1", includeTotal };
    let result = await page(filters);
    for (const [index, id] of [111, 122].entries()) {
      expect(ids(result.body)).toEqual([id]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : 2 - index);
      expect(result.body.nextCursor).toBe(id);
      result = await page(next(result, filters));
    }
    expect(result.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
  });

  it.each([
    ["asc", "101", [102, 104], 2], ["desc", "105", [104, 102, 101], 3],
  ] as const)("keeps upperId and %s cursor over a conflicting offset", async (order, cursor, expected, total) => {
    const result = await page({ eventCode: CODE, upperId: "104", cursor, order, offset: "99", includeTotal });
    expect(ids(result.body)).toEqual(expected);
    expect(result.body.total).toBe(includeTotal === "false" ? null : total);
  });

  it.each(["asc", "desc"])("retains inclusive upperId across %s links", async order => {
    const filters = { eventCode: CODE, upperId: "104", order, limit: "1", includeTotal };
    let result = await page(filters);
    for (const [index, id] of (order === "asc" ? [101, 102, 104] : [104, 102, 101]).entries()) {
      expect(ids(result.body)).toEqual([id]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : 3 - index);
      result = await page(next(result, filters));
    }
    expect(result.body.rows).toEqual([]);
    expect(result.body.nextCursor).toBeNull();
  });

  it("uses offset only on the first page", async () => {
    const filters = { eventCode: CODE, limit: "1", includeTotal };
    const first = await page({ ...filters, offset: "1" });
    expect(ids(first.body)).toEqual([102]);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 5);
    const second = await page(next(first, filters));
    expect(ids(second.body)).toEqual([104]);
    expect(second.body.total).toBe(includeTotal === "false" ? null : 3);
  });

  it("omits any/default presence from continuation targets", async () => {
    const first = await page({ eventCode: CODE, hasEventCode: "any", limit: "2", includeTotal });
    expect(ids(first.body)).toEqual([101, 102]);
    const target = next(first, { eventCode: CODE, limit: "2", includeTotal });
    expect(target.searchParams.has("hasEventCode")).toBe(false);
    const second = await page(target);
    expect(ids(second.body)).toEqual([104, 105]);
  });

  it("honors strictQuery=true for recognized selectors and retains it in links", async () => {
    const filters = { eventCode: CODE, hasEventCode: "true", strictQuery: "true", limit: "2", includeTotal };
    const first = await page(filters);
    expect(ids(first.body)).toEqual([101, 102]);
    const second = await page(next(first, filters));
    expect(ids(second.body)).toEqual([104, 105]);
  });

  it("preserves significant whitespace, reserved codes and composed selectors without copying untrusted keys", async () => {
    const filters = { eventCode: SPECIAL, hasEventCode: "true", customerId: "1", pickupAddressId: "11", serialNumber: "SN-00", rfid: "ZZZ", q: "other", enabled: "true", fields: "event_code", upperId: "122", order: "desc", limit: "1", includeTotal };
    const url = new URL(PATH, ORIGIN);
    url.search = new URLSearchParams({ ...filters, access_token: "synthetic-credential", redirect: "https://untrusted.invalid", unknown: "private-marker" }).toString();
    const first = await page(url);
    expect(ids(first.body)).toEqual([122]);
    const target = next(first, filters);
    expect(first.response.headers.get("link")).not.toMatch(/synthetic-credential|untrusted|private-marker|https:/);
    expect(first.response.headers.get("link")).not.toContain(SPECIAL);
    const second = await page(target);
    expect(ids(second.body)).toEqual([111]);
    const empty = await page(next(second, filters));
    expect(empty.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(empty.response.headers.get("link")).toBeNull();
  });
});

it.each(["true", "false"])("ETags describe filtered bytes, not just the URL (includeTotal=%s)", async includeTotal => {
  const query = { eventCode: CODE, hasEventCode: "true", fields: "event_code", limit: "1", includeTotal };
  const first = await request(query);
  expect(first.response.status).toBe(200);
  const bytes = await first.response.text();
  expect(ids(JSON.parse(bytes) as Body)).toEqual([101]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  const tag = `"${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}"`;
  expect(first.response.headers.get("etag")).toBe(tag);
  const link = first.response.headers.get("link");
  expect(link).not.toBeNull();
  for (const validator of [tag, `W/${tag}`, "*"]) {
    const same = await request(query, { headers: { "if-none-match": validator } });
    expect(same.response.status).toBe(304);
    expect((await same.response.arrayBuffer()).byteLength).toBe(0);
    expect(same.response.headers.get("etag")).toBe(tag);
    expect(same.response.headers.get("link")).toBe(link);
    expect(same.response.headers.get("cache-control")).toBe("no-store");
    reads(same);
  }
  for (const changed of [{ eventCode: "other" }, { hasEventCode: "false" }, { fields: "enabled" }, { includeTotal: includeTotal === "true" ? "false" : "true" }]) {
    const result = await request({ ...query, ...changed }, { headers: { "if-none-match": tag } });
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("etag")).not.toBe(tag);
    reads(result);
  }
});

it.each<Record<string, string>>([{}, { customerId: "1" }])("binds the literal code equality on both join paths: %j", async join => {
  const result = await page({ eventCode: SPECIAL, ...join, limit: "1" });
  expect(ids(result.body)).toEqual([111]);
  expect(result.body.total).toBe(2);
  for (const { sql, binds } of result.recorder.statements) {
    expect(sql).not.toContain(SPECIAL);
    expect(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP|COLLATE\s+NOCASE)\b/i);
    const unquoted = sql.replace(/["`[\]]/g, "");
    expect(unquoted).toMatch(/\bevent_code\s*=\s*\?/i);
    expect(binds.filter(value => value === SPECIAL)).toHaveLength(1);
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
    expect(plan.success).toBe(true);
    expect(plan.results.length).toBeGreaterThan(0);
    // Executability only: equality may scan; no index or latency assertion.
  }
});

it.each<Record<string, string>>([{}, { customerId: "1" }])("binds the null-or-empty presence complement on both join paths: %j", async join => {
  const present = await page({ hasEventCode: "true", ...join, limit: "1" });
  expect(ids(present.body)).toEqual([101]);
  for (const { sql } of present.recorder.statements) {
    expect(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP|COLLATE\s+NOCASE)\b/i);
    const unquoted = sql.replace(/["`[\]]/g, "");
    expect(unquoted).toMatch(/\bevent_code\s+IS\s+NOT\s+NULL/i);
    expect(unquoted).toMatch(/\bevent_code\s*(?:<>|!=)\s*(?:''|""|\?)/i);
  }
  const absent = await page({ hasEventCode: "false", ...join, limit: "1" });
  expect(ids(absent.body)).toEqual([108]);
  for (const { sql } of absent.recorder.statements) {
    const unquoted = sql.replace(/["`[\]]/g, "");
    expect(unquoted).toContain("event_code");
    expect(unquoted).toMatch(/IS\s+NULL/i);
  }
});

it("shares the contradictory scope between COUNT and page", async () => {
  const result = await page({ eventCode: CODE, hasEventCode: "false" });
  expect(result.body).toEqual({ rows: [], total: 0, nextCursor: null });
  expect(result.recorder.statements).toHaveLength(2);
  for (const { sql } of result.recorder.statements) {
    const unquoted = sql.replace(/["`[\]]/g, "");
    expect(unquoted).toMatch(/\bevent_code\s*=\s*\?/i);
    expect(unquoted).toMatch(/IS\s+NULL/i);
  }
});

it("keeps legacy missing parent links visible only when unjoined", async () => {
  // Local fixture-only legacy table: AS SELECT preserves every real column,
  // but omits FK/NOT NULL constraints so historical dangling links can exist.
  // Production migrations/constraints are NOT changed; all other tests use them.
  const db = TEST_ENV.CUSTOMER_DB;
  // SQLite validates triggers during ALTER TABLE; preserve and restore every
  // trigger verbatim around the fixture-only table replacement.
  const triggers = await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all<{ name: string; sql: string }>();
  await db.batch([
    ...triggers.results.map(t => db.prepare(`DROP TRIGGER "${t.name.replace(/"/g, '""')}"`)),
    db.prepare("CREATE TABLE legacy_container_snapshot AS SELECT * FROM container_snapshot"),
    db.prepare("DROP TABLE container_snapshot"),
    db.prepare("ALTER TABLE legacy_container_snapshot RENAME TO container_snapshot"),
    ...triggers.results.map(t => db.prepare(t.sql)),
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, event_code, enabled, synced_at) VALUES (220, 999, ?, 1, ?), (230, 999, NULL, 1, ?)").bind(CODE, STAMP, STAMP),
  ]);
  initialState = await state();
  expect(ids((await page({ eventCode: CODE })).body)).toEqual([...CODE_MATCHES, 220]);
  expect(ids((await page({ hasEventCode: "false" })).body)).toEqual([...ABSENT, 230]);
  expect(ids((await page({ hasEventCode: "true" })).body)).toEqual([...PRESENT, 220]);
  const joins: Record<string, string>[] = [{ customerId: "1" }, { parentRouteId: "7" }, { parentEnabled: "true" }, { parentEnabled: "false" }];
  for (const filters of joins) {
    expect(ids((await page({ eventCode: CODE, ...filters })).body)).not.toContain(220);
    expect(ids((await page({ hasEventCode: "false", ...filters })).body)).not.toContain(230);
  }
  expect(ids((await page({ eventCode: CODE, hasEventCode: "false" })).body)).toEqual([]);
});

type Parameter = {
  name: string; in: string; required?: boolean; description?: string; example?: unknown;
  examples?: Record<string, { value?: unknown }>;
  schema?: { type?: string; enum?: unknown[]; minLength?: number; maxLength?: number; description?: string; default?: unknown; example?: unknown };
};
type Operation = { operationId?: string; description?: string; parameters?: Parameter[]; responses?: Record<string, { description?: string }> };
async function document() {
  const { response } = await request(new URL("/openapi.json", ORIGIN), { token: null });
  expect(response.status).toBe(200);
  return await response.json() as { paths: Record<string, { get: Operation }> };
}

describe("mounted machine-readable event-code discovery", () => {
  it("publishes one optional eventCode string with actionable opaque-code guidance", async () => {
    const operation = (await document()).paths[PATH].get;
    expect(operation.operationId).toBe("listContainerSnapshot");
    const params = operation.parameters?.filter(p => p.in === "query" && p.name === "eventCode") ?? [];
    expect(params).toHaveLength(1);
    const param = params[0];
    expect(param.required ?? false).toBe(false);
    expect(param.schema).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
    expect(param.schema?.default).toBeUndefined();
    const description = `${param.description ?? ""} ${param.schema?.description ?? ""}`;
    expect(description).toContain("event_code");
    for (const concept of [/exact/i, /case.sensitive/i, /Unicode code points/i, /whitespace/i, /opaque|stored/i, /URL.encod/i, /omit/i, /single|repeat|one value/i]) expect(description).toMatch(concept);
    const examples = [param.example, param.schema?.example, ...Object.values(param.examples ?? {}).map(e => e.value)];
    expect(examples.some(value => typeof value === "string" && value.trim().length > 0 && [...value].length <= 100)).toBe(true);
  });

  it("publishes one optional hasEventCode true|false|any enum, default any", async () => {
    const operation = (await document()).paths[PATH].get;
    const params = operation.parameters?.filter(p => p.in === "query" && p.name === "hasEventCode") ?? [];
    expect(params).toHaveLength(1);
    const param = params[0];
    expect(param.required ?? false).toBe(false);
    expect(param.schema).toMatchObject({ type: "string", enum: ["true", "false", "any"], default: "any" });
    const description = `${param.description ?? ""} ${param.schema?.description ?? ""}`;
    for (const concept of [/true/i, /false/i, /\bany\b/i, /null/i, /empty/i, /whitespace/i, /omit/i]) expect(description).toMatch(concept);
    const examples = [param.example, param.schema?.example, ...Object.values(param.examples ?? {}).map(e => e.value)];
    expect(examples.some(value => ["true", "false", "any"].includes(value as string))).toBe(true);
  });

  it("publishes AND composition, empty success and value-free correction before D1", async () => {
    const operation = (await document()).paths[PATH].get;
    const guidance = operation.description ?? "";
    for (const name of ["eventCode", "hasEventCode", "serialNumber", "rfid", "materialStream", "color", "customerId", "pickupAddressId", "containerId", "q", "enabled"]) expect(guidance).toContain(name);
    expect(guidance).toMatch(/\bAND\b|intersect/i);
    expect(guidance).toMatch(/unknown|unmatched|no match/i);
    expect(guidance).toMatch(/empty|zero rows/i);
    const recovery = operation.responses?.["400"]?.description ?? "";
    for (const name of ["eventCode", "hasEventCode"]) expect(recovery).toContain(name);
    for (const concept of [/empty|blank/i, /repeat|duplicate/i, /100.*Unicode code points/i, /true.*false.*any/i, /before.*D1/i, /URL.encod/i, /omit/i]) expect(recovery).toMatch(concept);
    expect(recovery).toContain("application/problem+json");
    expect(recovery).toContain("docs/PROBLEMS.md#bad-request");
  });

  it("states stored code text is mirrored text, not dispatch truth, with no scan promise", async () => {
    const guidance = (await document()).paths[PATH].get.description ?? "";
    for (const concept of [/dispatch/i, /history/i, /proof of service/i, /taxonom/i]) expect(guidance).toMatch(concept);
    expect(guidance).toMatch(/scan/i);
    expect(guidance).toMatch(/no index/i);
    expect(guidance).toMatch(/migration/i);
  });

  it("aligns the query inventory with the served selectors rather than silently omitting both", async () => {
    const operation = (await document()).paths[PATH].get;
    const row = policyDoc.split("\n").find(line => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    const inventory = [...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map(match => match[1]).sort();
    expect(inventory).toEqual(expect.arrayContaining(["eventCode", "hasEventCode"]));
    expect(inventory).toEqual(operation.parameters?.filter(p => p.in === "query").map(p => p.name).sort());
  });

  it("CONTROL: keeps these selectors off unrelated reads and adds no lookup endpoint", async () => {
    const doc = await document();
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/address-snapshot", `${PATH}/{containerId}`, `${PATH}/export`]) {
      const names = doc.paths[path].get.parameters?.map(p => p.name) ?? [];
      expect(names, path).not.toContain("eventCode");
      expect(names, path).not.toContain("hasEventCode");
    }
    expect(app.routes.filter(route => /event-?code/i.test(route.path))).toEqual([]);
  });
});
