/// <reference types="vite/client" />

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import snapshotDoc from "../CUSTOMER_SNAPSHOT.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import changelog from "../CHANGELOG.md?raw";
import problemsDoc from "../docs/PROBLEMS.md?raw";
import packageJson from "../package.json";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent Test-Author oracle; all expected IDs/pages are hand-derived.
 * Mutation targets: ignored/reversed presence selector, OR leakage between
 * the two controls, empty-string treated as present, whitespace-only treated
 * as absent, exact-plus-presence contradiction returning rows, scope leakage
 * into unscoped reads, COUNT/page predicate or bind drift, joined/unjoined path
 * divergence, dropped link filters, reflected markers, stale sparse ETags
 * and auth bypass. Real local D1 evaluates product SQL. Only fixture setup
 * may write. Requests deny D1 writes/batch/exec, R2, browser and fetch; no
 * production/staging probes and no live PII.
 * Builder: incorporate this test commit unchanged; oracle corrections stay
 * Test-Author-owned. Expected RED until the paired implementation arrives.
 * Run: npx vitest run test/containerSerialRfidPresence.acceptance.test.ts --maxWorkers=2
 *
 * Hand-derived fixture oracle (all synthetic):
 * serial present = NOT NULL AND <> '' : [201,202,206,207,208,209,211,213]
 * serial absent  = NULL or ''          : [203,204,205,210,212]
 * rfid present   = NOT NULL AND <> ''  : [201,203,206,207,208,209,212,213]
 * rfid absent    = NULL or ''          : [202,204,205,210,211]
 * 205/210 pin empty-string absence; 206 pins whitespace-only presence
 * ('   ' / '\t'); 211 parents to address 13 (NULL route/franchise), proving
 * unscoped presence reads stay join-free while parent scopes exclude it and
 * the customer join still resolves it; 213 pins padded exact values
 * (presence yes, exact equality no).
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/container-snapshot";
const ORIGIN = "https://serial-rfid-presence.test.invalid";
const STAMP = "2026-01-03T04:05:06.000Z";
const SERIAL = "SN-001";
const RFID = "RF-001";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
type Selector = "hasSerialNumber" | "hasRfid";
type Query = Record<string, string> | URL;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[]; method: string };
// Address: id, customer, scalar route, opaque franchise, parent enabled.
type Parent = readonly [number, number, number | null, string | null, number];
const PARENTS: readonly Parent[] = [
  [11, 1, 7, "F-1", 1], [12, 1, 7, "F-2", 0], [13, 1, null, null, 1], [21, 2, 9, "F-1", 1]
];
// Container: id, parent, serial, rfid, enabled, material, color, location, state, zip.
type Fixture = readonly [number, number, string | null, string | null, number, string | null, string | null, string, string, string];
const FIXTURES: readonly Fixture[] = [
  [201, 11, SERIAL, RFID, 1, "Metal", "Blue", "north depot", "ST", "02139"],
  [202, 11, SERIAL, null, 1, "Metal", "Red", "north depot", "ST", "02139"],
  [203, 11, null, RFID, 1, "Plastic", "Blue", "south depot", "SO", "99999"],
  [204, 11, null, null, 1, null, null, "north depot", "ST", "02139"],
  [205, 12, "", "", 1, null, null, "north depot", "ST", "02139"],
  [206, 12, "   ", "\t", 1, null, null, "north depot", "ST", "02139"],
  [207, 11, SERIAL, RFID, 0, null, "Red", "north depot", "ST", "02139"],
  [208, 21, SERIAL, RFID, 1, null, "Green", "north depot", "ST", "02139"],
  [209, 11, "OTHER", "RF-OTHER", 1, "Wood", "Green", "north depot", "ST", "02139"],
  [210, 13, null, "", 1, null, null, "north depot", "ST", "02139"],
  [211, 13, SERIAL, null, 1, null, null, "north depot", "ST", "02139"],
  [212, 11, "", RFID, 1, null, null, "north depot", "ST", "02139"],
  [213, 11, `  ${SERIAL}  `, ` ${RFID} `, 1, null, null, "north depot", "ST", "02139"]
];
const ALL = [201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213];
const SERIAL_PRESENT = [201, 202, 206, 207, 208, 209, 211, 213];
const SERIAL_ABSENT = [203, 204, 205, 210, 212];
const RFID_PRESENT = [201, 203, 206, 207, 208, 209, 212, 213];
const RFID_ABSENT = [202, 204, 205, 210, 211];
const recorders: ReturnType<typeof recordDb>[] = [];
const denyExternalBinding = vi.fn(() => { throw new Error("Presence lookup must not use browser, R2 or upstream bindings"); });
const forbiddenBucket = Object.fromEntries([
  "get", "head", "list", "put", "delete", "createMultipartUpload", "resumeMultipartUpload"
].map((method) => [method, denyExternalBinding])) as unknown as R2Bucket;
let beforeState: unknown;

function recordDb(real: D1Database) {
  const statements: Statement[] = [];
  const fail = () => { throw new Error("Presence lookup must only read local D1"); };
  const batch = vi.fn(fail);
  const exec = vi.fn(fail);
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    const observe = (method: string) => {
      statements.push({ sql, binds, method });
      if (!/^\s*SELECT\b/i.test(sql) || method === "run") fail();
    };
    return {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql, values),
      first: (...args: unknown[]) => {
        observe("first");
        return (stmt.first as (...a: unknown[]) => unknown)(...args);
      },
      all: () => { observe("all"); return stmt.all(); },
      raw: (...args: unknown[]) => {
        observe("raw");
        return (stmt.raw as (...a: unknown[]) => unknown)(...args);
      },
      run: () => { observe("run"); return fail(); }
    } as unknown as D1PreparedStatement;
  }
  const db = {
    prepare: (sql: string) => wrap(real.prepare(sql), sql, []), batch, exec
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

async function state() {
  const db = TEST_ENV.CUSTOMER_DB;
  return Promise.all([
    db.prepare("SELECT * FROM customer_snapshot ORDER BY customer_id").all(),
    db.prepare("SELECT * FROM address_snapshot ORDER BY pickup_address_id").all(),
    db.prepare("SELECT * FROM container_snapshot ORDER BY container_id").all(),
    db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()
  ]).then((results) => results.map((r) => r.results));
}

async function request(
  query: Query | string = {},
  options: { token?: string | null; db?: D1Database; headers?: Record<string, string> } = {}
) {
  const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
  recorders.push(recorder);
  const url = query instanceof URL ? query : new URL(PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = typeof query === "string" ? query : new URLSearchParams(query).toString();
  const headers = new Headers(options.headers);
  const token = options.token === undefined ? "test-read-token" : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV,
    CUSTOMER_DB: options.db ?? recorder.db,
    SNAPSHOTS: forbiddenBucket,
    BROWSER: { fetch: denyExternalBinding } as unknown as Fetcher
  });
  return { response, recorder, url };
}

async function page(query: Query | string = {}, token?: string) {
  const result = await request(query, { token });
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  expect(result.response.headers.get("etag")).toMatch(/^".+"$/);
  const body = await result.response.json() as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const counted = result.url.searchParams.get("includeTotal") !== "false";
  expect(result.recorder.statements).toHaveLength(counted ? 2 : 1);
  expect(result.recorder.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(counted ? 1 : 0);
  if (!counted) expect(body.total).toBeNull();
  return { ...result, body };
}

async function countOnly(query: Query | string = {}) {
  const result = await request(query);
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  expect(result.response.headers.get("link")).toBeNull();
  const body = await result.response.json() as Body;
  expect(body.rows).toEqual([]);
  expect(body.nextCursor).toBeNull();
  expect(result.recorder.statements).toHaveLength(1);
  expect(result.recorder.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(1);
  return { ...result, body };
}

const ids = (body: Body) => body.rows.map((r) => r.container_id);
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
const whereOf = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).replace(/\s+ORDER\s+BY[\s\S]*$/i, "").trim();

// Follows one server-issued relative next link after asserting the retention
// contract: effective controls round-trip exactly once, any/default presence
// and unknowns are dropped, offset never appears, and cursor tracks nextCursor.
function next(result: Awaited<ReturnType<typeof page>>) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/container-snapshot\?[^<>\s]*>; rel="next"$/);
  const url = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(url.origin).toBe(result.url.origin);
  expect(url.pathname).toBe(PATH);
  expect(url.hash).toBe("");
  expect(url.searchParams.has("offset")).toBe(false);
  expect(url.searchParams.getAll("cursor")).toEqual([String(result.body.nextCursor)]);
  for (const [key, raw] of result.url.searchParams) {
    if (["offset", "cursor", "unknown", "redirect", "token"].includes(key)) continue;
    const value = key === "q" ? raw.trim() : raw;
    if (["hasSerialNumber", "hasRfid", "parentEnabled", "enabled"].includes(key) && value === "any") {
      expect(url.searchParams.has(key)).toBe(false);
    } else if ((key === "order" && value === "asc") || (key === "includeTotal" && value === "true")) {
      expect([[], [value]]).toContainEqual(url.searchParams.getAll(key));
    } else {
      expect(url.searchParams.getAll(key), key).toEqual([value]);
    }
  }
  for (const dropped of ["unknown", "redirect", "token"]) expect(url.searchParams.has(dropped)).toBe(false);
  expect(link).not.toContain(result.url.origin);
  return url;
}

beforeAll(async () => { await ensureD1TestTables(); });

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound network in presence acceptance"); }));
  recorders.length = 0;
  denyExternalBinding.mockClear();
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, synced_at) VALUES (1, 'Synthetic One', ?), (2, 'Synthetic Two', ?)").bind(STAMP, STAMP)
  ]);
  await db.batch(PARENTS.map(([id, customer, route, franchise, enabled]) =>
    db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, enabled, address, synced_at) VALUES (?, ?, ?, ?, ?, 'Synthetic site', ?)")
      .bind(id, customer, route, franchise, enabled, STAMP)
  ));
  await db.batch(FIXTURES.map(([id, address, serial, rfid, enabled, material, color, location, stateCode, zip]) =>
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, serial_number, rfid, enabled, ud_material_stream_ud, color, location_address, state, zip, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, address, serial, rfid, enabled, material, color, location, stateCode, zip, STAMP)
  ));
  beforeState = await state();
});

afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denyExternalBinding).not.toHaveBeenCalled();
    for (const recorder of recorders) {
      expect(recorder.batch).not.toHaveBeenCalled();
      expect(recorder.exec).not.toHaveBeenCalled();
      expect(recorder.statements.every((s) => /^\s*SELECT\b/i.test(s.sql) && s.method !== "run")).toBe(true);
    }
    expect(await state(), "rows and schema must be unchanged by every request, including failures").toEqual(beforeState);
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe("serial/RFID presence truth table", () => {
  it.each([
    ["serial present", { hasSerialNumber: "true" }, SERIAL_PRESENT],
    ["serial absent", { hasSerialNumber: "false" }, SERIAL_ABSENT],
    ["rfid present", { hasRfid: "true" }, RFID_PRESENT],
    ["rfid absent", { hasRfid: "false" }, RFID_ABSENT],
    ["both present", { hasSerialNumber: "true", hasRfid: "true" }, [201, 206, 207, 208, 209, 213]],
    ["serial only", { hasSerialNumber: "true", hasRfid: "false" }, [202, 211]],
    ["rfid only", { hasSerialNumber: "false", hasRfid: "true" }, [203, 212]],
    ["neither present", { hasSerialNumber: "false", hasRfid: "false" }, [204, 205, 210]]
  ] as Array<[string, Record<string, string>, readonly number[]]>)("%s selects the exact stored-text cohort with matching COUNT scope", async (_name, query, expected) => {
    for (const includeTotal of ["true", "false"]) {
      const result = await page({ ...query, includeTotal });
      expect(ids(result.body)).toEqual([...expected]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : expected.length);
      expect(result.body.nextCursor).toBeNull();
    }
  });

  it("treats NULL and empty string as absent but nonempty whitespace-only text as present", async () => {
    const serialTrue = await page({ hasSerialNumber: "true" });
    expect(ids(serialTrue.body)).toContain(206);
    expect(ids(serialTrue.body)).not.toContain(205);
    const serialFalse = await page({ hasSerialNumber: "false" });
    expect(ids(serialFalse.body)).toEqual(SERIAL_ABSENT);
    expect(ids(serialFalse.body)).not.toContain(206);
    const rfidTrue = await page({ hasRfid: "true" });
    expect(ids(rfidTrue.body)).toContain(206);
    expect(ids(rfidTrue.body)).not.toContain(205);
    expect(ids(rfidTrue.body)).not.toContain(210);
    const rfidFalse = await page({ hasRfid: "false" });
    expect(ids(rfidFalse.body)).toEqual(RFID_ABSENT);
    // Empty serial with present rfid, and null serial with empty rfid, pin
    // per-field NULL/empty handling without cross-field leakage.
    expect(ids(rfidTrue.body)).toContain(212);
    expect(ids(serialFalse.body)).toContain(212);
    expect(ids(rfidFalse.body)).toContain(210);
  });

  it("control: omission and any preserve existing rows, bytes and unjoined SQL", async () => {
    const omitted = await page();
    expect(ids(omitted.body)).toEqual(ALL);
    expect(omitted.body.total).toBe(13);
    expect(omitted.body.nextCursor).toBeNull();
    expect(omitted.response.headers.get("link")).toBeNull();
    expect(omitted.body.rows[0]).toMatchObject({
      container_id: 201, pickup_address_id: 11, serial_number: SERIAL, rfid: RFID, enabled: 1, synced_at: STAMP
    });
    for (const query of [{ hasSerialNumber: "any" }, { hasRfid: "any" }, { hasSerialNumber: "any", hasRfid: "any" }] as Array<Record<string, string>>) {
      const result = await request(query);
      expect(result.response.status).toBe(200);
      expect(await result.response.text()).toBe(await (await request()).response.text());
      expect(result.recorder.statements).toEqual(omitted.recorder.statements);
    }
    for (const statement of omitted.recorder.statements) {
      expect(statement.sql).not.toMatch(/\bJOIN\b/i);
      expect(whereOf(statement.sql)).not.toMatch(/serial_number|rfid/i);
    }
    const explicit = await page({ enabled: "any", includeTotal: "true", offset: "0", limit: "50" });
    expect(ids(explicit.body)).toEqual(ALL);
  });

  it("keeps null-parent-scoped rows visible without an effective parent scope", async () => {
    expect(ids((await page({ hasSerialNumber: "true" })).body)).toContain(211);
    expect(ids((await page({ hasRfid: "false" })).body)).toContain(211);
    expect(ids((await page({ hasSerialNumber: "true", hasRfid: "false" })).body)).toEqual([202, 211]);
    // The customer join still resolves the row; only value scopes exclude it.
    expect(ids((await page({ hasSerialNumber: "true", customerId: "1" })).body)).toContain(211);
    expect(ids((await page({ hasSerialNumber: "true", parentRouteId: "7" })).body)).not.toContain(211);
  });

  it("is idempotent and does not log successful presence reads", async () => {
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
    const first = await page({ hasSerialNumber: "true", hasRfid: "false" });
    const second = await page({ hasSerialNumber: "true", hasRfid: "false" });
    expect(ids(first.body)).toEqual([202, 211]);
    expect(second.body).toEqual(first.body);
    expect(second.recorder.statements).toEqual(first.recorder.statements);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe("exact-plus-presence intersection and contradiction", () => {
  it.each([
    ["serial intersection", { serialNumber: SERIAL, hasSerialNumber: "true" }, [201, 202, 207, 208, 211]],
    ["serial contradiction", { serialNumber: SERIAL, hasSerialNumber: "false" }, []],
    ["rfid intersection", { rfid: RFID, hasRfid: "true" }, [201, 203, 207, 208, 212]],
    ["rfid contradiction", { rfid: RFID, hasRfid: "false" }, []],
    ["other serial intersection", { serialNumber: "OTHER", hasSerialNumber: "true" }, [209]],
    ["other serial contradiction", { serialNumber: "OTHER", hasSerialNumber: "false" }, []],
    ["other rfid intersection", { rfid: "RF-OTHER", hasRfid: "true" }, [209]],
    ["other rfid contradiction", { rfid: "RF-OTHER", hasRfid: "false" }, []]
  ] as const)("%s shares COUNT/row scope", async (_name, query, expected) => {
    for (const includeTotal of ["true", "false"]) {
      const result = await page({ ...query, includeTotal });
      expect(ids(result.body)).toEqual([...expected]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : expected.length);
      expect(result.body.nextCursor).toBeNull();
      expect(result.response.headers.get("link")).toBeNull();
    }
  });

  it("does not let padded stored text match the trimmed exact value", async () => {
    const result = await page({ serialNumber: SERIAL, rfid: RFID, hasSerialNumber: "true", hasRfid: "true" });
    expect(ids(result.body)).toEqual([201, 207, 208]);
    expect(result.body.total).toBe(3);
  });
});

describe("presence AND composition with existing selectors", () => {
  it.each([
    ["both present plus customer", { hasSerialNumber: "true", hasRfid: "true", customerId: "1" }, [201, 206, 207, 209, 213]],
    ["serial present plus other customer", { hasSerialNumber: "true", customerId: "2" }, [208]],
    ["rfid absent plus customer", { hasRfid: "false", customerId: "1" }, [202, 204, 205, 210, 211]],
    ["serial present plus address", { hasSerialNumber: "true", pickupAddressId: "11" }, [201, 202, 207, 209, 213]],
    ["rfid present plus container", { hasRfid: "true", containerId: "203" }, [203]],
    ["serial absent plus ids", { hasSerialNumber: "false", ids: "203,204,205,206" }, [203, 204, 205]],
    ["serial present plus parent route", { hasSerialNumber: "true", parentRouteId: "7" }, [201, 202, 206, 207, 209, 213]],
    ["rfid present plus parent franchise", { hasRfid: "true", parentFranchiseId: "F-1" }, [201, 203, 207, 208, 209, 212, 213]],
    ["serial present plus disabled parent", { hasSerialNumber: "true", parentEnabled: "false" }, [206]],
    ["rfid absent plus enabled parent", { hasRfid: "false", parentEnabled: "true" }, [202, 204, 210, 211]],
    ["serial present plus material", { hasSerialNumber: "true", materialStream: "Metal" }, [201, 202]],
    ["rfid present plus color", { hasRfid: "true", color: "Blue" }, [201, 203]],
    ["rfid present plus stored location", { hasRfid: "true", locationAddress: "south depot" }, [203]],
    ["serial absent plus state", { hasSerialNumber: "false", state: "SO" }, [203]],
    ["serial present plus zip", { hasSerialNumber: "true", zip: "02139" }, SERIAL_PRESENT],
    ["serial present plus q", { hasSerialNumber: "true", q: "SN-001" }, [201, 202, 207, 208, 211, 213]],
    ["rfid absent plus q", { hasRfid: "false", q: "north" }, RFID_ABSENT],
    ["serial present plus disabled equipment", { hasSerialNumber: "true", enabled: "false" }, [207]],
    ["rfid absent plus any equipment state", { hasRfid: "false", enabled: "any" }, RFID_ABSENT],
    ["full legacy conjunction", { hasSerialNumber: "true", hasRfid: "true", customerId: "1", q: "north", enabled: "true", materialStream: "Metal" }, [201]],
    ["contradictory container", { hasSerialNumber: "true", containerId: "204" }, []],
    ["contradictory address", { hasRfid: "false", pickupAddressId: "21" }, []]
  ] as const)("ANDs %s with identical COUNT/row scope", async (_name, filters, expected) => {
    for (const includeTotal of ["true", "false"]) {
      const result = await page({ ...filters, includeTotal });
      expect(ids(result.body)).toEqual([...expected]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : expected.length);
      expect(result.body.nextCursor).toBeNull();
    }
  });

  it("ignores unrelated unknown names without changing results or SQL", async () => {
    const base = await page({ hasSerialNumber: "true", hasRfid: "false" });
    const unknown = await page({ hasSerialNumber: "true", hasRfid: "false", bogus_param: "private-marker" });
    expect(unknown.body).toEqual(base.body);
    expect(unknown.recorder.statements).toEqual(base.recorder.statements);
  });

  it("preserves sparse stored-column names and always retains the canonical ID", async () => {
    const serial = await page({ hasSerialNumber: "false", fields: "serial_number", includeTotal: "false" });
    expect(serial.body).toEqual({
      rows: [
        { container_id: 203, serial_number: null },
        { container_id: 204, serial_number: null },
        { container_id: 205, serial_number: "" },
        { container_id: 210, serial_number: null },
        { container_id: 212, serial_number: "" }
      ],
      total: null, nextCursor: null
    });
    const rfid = await page({ hasRfid: "true", hasSerialNumber: "false", fields: "rfid", includeTotal: "false" });
    expect(rfid.body).toEqual({
      rows: [
        { container_id: 203, rfid: RFID },
        { container_id: 212, rfid: RFID }
      ],
      total: null, nextCursor: null
    });
  });
});

describe("presence COUNT/page SQL parity", () => {
  it.each(["true", "false"] as const)("hasSerialNumber=%s shares WHERE/binds across COUNT and page without a join", async (value) => {
    const result = await page({ hasSerialNumber: value, ids: "201,202,203,204,205,206", q: "north", enabled: "true", upperId: "206", limit: "1" });
    const count = result.recorder.statements.find(isCount)!;
    const select = result.recorder.statements.find((s) => !isCount(s))!;
    expect(whereOf(count.sql)).toBe(whereOf(select.sql));
    expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
    expect(select.binds.length - count.binds.length).toBeLessThanOrEqual(2);
    for (const statement of [count, select]) {
      expect(statement.sql).toMatch(/serial_number/i);
      expect(whereOf(statement.sql)).not.toMatch(/\brfid\b/i);
      expect(statement.sql).not.toMatch(/\bJOIN\b/i);
      expect(statement.sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP|COLLATE\s+NOCASE)\b/i);
      expect(statement.binds).not.toContain("true");
      expect(statement.binds).not.toContain("false");
      expect(statement.binds).not.toContain("any");
    }
    expect(ids(result.body)).toEqual(value === "true" ? [201] : [203]);
    expect(result.body.total).toBe(3);
  });

  it.each(["true", "false"] as const)("hasRfid=%s shares WHERE/binds across COUNT and page without a join", async (value) => {
    const result = await page({ hasRfid: value, ids: "201,202,203,204,205,206", q: "north", enabled: "true", upperId: "206", limit: "1" });
    const count = result.recorder.statements.find(isCount)!;
    const select = result.recorder.statements.find((s) => !isCount(s))!;
    expect(whereOf(count.sql)).toBe(whereOf(select.sql));
    expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
    expect(select.binds.length - count.binds.length).toBeLessThanOrEqual(2);
    for (const statement of [count, select]) {
      expect(statement.sql).toMatch(/\brfid\b/i);
      expect(whereOf(statement.sql)).not.toMatch(/serial_number/i);
      expect(statement.sql).not.toMatch(/\bJOIN\b/i);
      expect(statement.sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP|COLLATE\s+NOCASE)\b/i);
      expect(statement.binds).not.toContain("true");
      expect(statement.binds).not.toContain("false");
      expect(statement.binds).not.toContain("any");
    }
    expect(ids(result.body)).toEqual(value === "true" ? [201] : [202]);
    expect(result.body.total).toBe(3);
  });

  it("uses one shared address join for presence plus customer scope in both statements", async () => {
    const result = await page({ hasSerialNumber: "true", hasRfid: "false", customerId: "1", limit: "5" });
    expect(ids(result.body)).toEqual([202, 211]);
    expect(result.body.total).toBe(2);
    for (const statement of result.recorder.statements) {
      expect(statement.sql.match(/\bJOIN\b/gi) ?? []).toHaveLength(1);
      expect(statement.sql).toMatch(/\bJOIN\s+address_snapshot\b/i);
      expect(whereOf(statement.sql)).toMatch(/serial_number/i);
      expect(whereOf(statement.sql)).toMatch(/\brfid\b/i);
    }
    const count = result.recorder.statements.find(isCount)!;
    const select = result.recorder.statements.find((s) => !isCount(s))!;
    expect(whereOf(count.sql)).toBe(whereOf(select.sql));
    expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
  });

  it("emits distinct true/false predicates that vanish under any", async () => {
    const yes = await page({ hasSerialNumber: "true", hasRfid: "true" });
    const no = await page({ hasSerialNumber: "false", hasRfid: "false" });
    const any = await page({ hasSerialNumber: "any", hasRfid: "any" });
    const whereYes = yes.recorder.statements.map((s) => whereOf(s.sql));
    const whereNo = no.recorder.statements.map((s) => whereOf(s.sql));
    expect(whereYes).not.toEqual(whereNo);
    for (const clause of [...whereYes, ...whereNo]) {
      expect(clause).toMatch(/serial_number/i);
      expect(clause).toMatch(/\brfid\b/i);
    }
    for (const statement of any.recorder.statements) {
      expect(whereOf(statement.sql)).not.toMatch(/serial_number/i);
      expect(whereOf(statement.sql)).not.toMatch(/\brfid\b/i);
    }
  });

  it("binds exact values while presence needs no value binds, with executable synthetic EXPLAIN plans", async () => {
    const result = await page({ serialNumber: SERIAL, hasSerialNumber: "true", hasRfid: "any", customerId: "1", limit: "1" });
    expect(ids(result.body)).toEqual([201]);
    const plans: Array<{ sql: string; details: string[] }> = [];
    for (const { sql, binds } of result.recorder.statements) {
      const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
      expect(plan.success).toBe(true);
      expect(plan.results.length).toBeGreaterThan(0);
      expect(plan.results.every((row) => typeof row.detail === "string" && row.detail.length > 0)).toBe(true);
      plans.push({ sql, details: plan.results.map((row) => row.detail) });
      expect(plan.results.map((row) => row.detail).join("\n")).toMatch(/\bSCAN\b|\bSEARCH\b/i);
    }
    expect(ids(result.body), `Synthetic local D1 EXPLAIN: ${JSON.stringify(plans)}`).toEqual([201]);
    for (const { sql, binds } of result.recorder.statements) {
      expect(sql).not.toContain(SERIAL);
      expect(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP)\b/i);
      expect(sql).toMatch(/\bserial_number\b\s*=\s*\?/i);
      expect(binds).toContain(SERIAL);
      expect(binds).not.toContain("true");
    }
  });
});

describe("presence count-only and count-free reads", () => {
  it.each([
    ["serial present", { hasSerialNumber: "true" }, 8],
    ["serial absent", { hasSerialNumber: "false" }, 5],
    ["rfid present", { hasRfid: "true" }, 8],
    ["rfid absent", { hasRfid: "false" }, 5],
    ["both present", { hasSerialNumber: "true", hasRfid: "true" }, 6],
    ["serial only", { hasSerialNumber: "true", hasRfid: "false" }, 2],
    ["present plus customer", { hasSerialNumber: "true", customerId: "1" }, 7],
    ["absent plus parent", { hasRfid: "false", parentEnabled: "true" }, 4]
  ] as const)("%s countOnly returns the filtered total without rows, paging or a Link", async (_name, query, total) => {
    const result = await countOnly({ ...query, countOnly: "true" });
    expect(result.body.total).toBe(total);
  });

  it.each(["true", "false", "any"] as const)("hasSerialNumber=%s count-free keeps rows and cursor with zero COUNTs", async (value) => {
    const counted = await page({ hasSerialNumber: value, hasRfid: "any", limit: "2" });
    const free = await page({ hasSerialNumber: value, hasRfid: "any", limit: "2", includeTotal: "false" });
    const want = value === "true" ? [201, 202] : value === "false" ? [203, 204] : [201, 202];
    expect(ids(free.body)).toEqual(want);
    expect(free.body.total).toBeNull();
    expect(free.body.rows).toEqual(counted.body.rows);
    expect(free.body.nextCursor).toBe(counted.body.nextCursor);
    expect(free.recorder.statements[0]).toEqual(counted.recorder.statements.find((s) => !isCount(s)));
  });

  it("countOnly rejects the count-free combination before D1 with the existing mode guidance", async () => {
    const db = forbiddenDb();
    const { response } = await request(
      { hasSerialNumber: "true", countOnly: "true", includeTotal: "false" }, { db: db.db }
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
  });
});

describe("followable presence pages", () => {
  it.each([
    ["serial present asc", { hasSerialNumber: "true" }, "asc", SERIAL_PRESENT],
    ["rfid absent asc", { hasRfid: "false" }, "asc", RFID_ABSENT],
    ["serial present desc", { hasSerialNumber: "true" }, "desc", [213, 211, 209, 208, 207, 206, 202, 201]],
    ["rfid absent desc", { hasRfid: "false" }, "desc", [211, 210, 205, 204, 202]],
    ["serial only asc", { hasSerialNumber: "true", hasRfid: "false" }, "asc", [202, 211]]
  ] as const)("walks %s by returned relative links without duplicates", async (_name, filters, order, expected) => {
    const query = { ...filters, order, limit: "1", includeTotal: "false" };
    let current = await page(query);
    const seen: unknown[] = [];
    for (let i = 0; i <= expected.length; i++) {
      if (i < expected.length) {
        expect(ids(current.body)).toEqual([expected[i]]);
        expect(current.body.total).toBeNull();
        expect(current.body.nextCursor).toBe(expected[i]);
        seen.push(...ids(current.body));
        current = await page(next(current));
      } else {
        expect(current.body).toEqual({ rows: [], total: null, nextCursor: null });
        expect(current.response.headers.get("link")).toBeNull();
      }
    }
    expect(seen).toEqual([...expected]);
  });

  it("retains both selectors across counted links with cursor-relative totals", async () => {
    const filters = { hasSerialNumber: "true", hasRfid: "true", fields: "rfid", limit: "2" };
    let current = await page(filters);
    const seen: unknown[] = [];
    for (const [expected, total, cursor] of [
      [[201, 206], 6, 206], [[207, 208], 4, 208], [[209, 213], 2, 213], [[], 0, null]
    ] as const) {
      expect(ids(current.body)).toEqual([...expected]);
      expect(current.body.total).toBe(total);
      expect(current.body.nextCursor).toBe(cursor);
      seen.push(...ids(current.body));
      if (cursor === null) {
        expect(current.response.headers.get("link")).toBeNull();
      } else {
        current = await page(next(current));
      }
    }
    expect(seen).toEqual([201, 206, 207, 208, 209, 213]);
  });

  it("starts with offset, then follows keyset links with cursor-relative totals", async () => {
    const filters = { hasSerialNumber: "true", hasRfid: "true", limit: "2" };
    const first = await page({ ...filters, offset: "2" });
    expect(ids(first.body)).toEqual([207, 208]);
    expect(first.body.total).toBe(6);
    expect(first.body.nextCursor).toBe(208);
    const second = await page(next(first));
    expect(ids(second.body)).toEqual([209, 213]);
    expect(second.body.total).toBe(2);
  });

  it("honors a supplied cursor over a conflicting offset without dropping filters", async () => {
    const result = await page({ hasSerialNumber: "true", hasRfid: "true", cursor: "206", offset: "99", limit: "2" });
    expect(ids(result.body)).toEqual([207, 208]);
    expect(result.body.total).toBe(4);
    expect(result.body.nextCursor).toBe(208);
  });

  it("preserves parent, material, text, enabled, fields and both selectors in continuation", async () => {
    const filters = {
      hasSerialNumber: "true", hasRfid: "any", customerId: "1", parentRouteId: "7",
      materialStream: "Metal", q: "north", enabled: "true", fields: "enabled", limit: "1", includeTotal: "false"
    };
    const first = await page(filters);
    expect(first.body.rows).toEqual([{ container_id: 201, enabled: 1 }]);
    const second = await page(next(first));
    expect(second.body.rows).toEqual([{ container_id: 202, enabled: 1 }]);
    const terminal = await page(next(second));
    expect(terminal.body).toEqual({ rows: [], total: null, nextCursor: null });
    expect(terminal.response.headers.get("link")).toBeNull();
  });

  it.each([{}, { hasSerialNumber: "any", hasRfid: "any" }] as Array<Record<string, string>>)("control: %j omits default presence from next links", async (filter) => {
    const first = await page({ ...filter, limit: "12" });
    expect(ids(first.body)).toEqual(ALL.slice(0, 12));
    expect(first.body.total).toBe(13);
    expect(first.body.nextCursor).toBe(212);
    const target = next(first);
    expect(target.searchParams.has("hasSerialNumber")).toBe(false);
    expect(target.searchParams.has("hasRfid")).toBe(false);
    const last = await page(target);
    expect(ids(last.body)).toEqual([213]);
    expect(last.body.total).toBe(1);
    expect(last.response.headers.get("link")).toBeNull();
  });

  it("drops unknown keys and credential markers from links without changing results", async () => {
    const clean = await page({ hasSerialNumber: "true", hasRfid: "false", limit: "1", includeTotal: "false" });
    const tainted = await page(new URL(`${PATH}?hasSerialNumber=true&hasRfid=false&limit=1&includeTotal=false&token=query-credential-marker&bogus_param=unknown-marker&unknown=x&redirect=https%3A%2F%2Fredirect-marker.invalid`, ORIGIN));
    expect(ids(tainted.body)).toEqual(ids(clean.body));
    expect(tainted.recorder.statements).toEqual(clean.recorder.statements);
    expect(tainted.response.headers.get("link")).toBe(clean.response.headers.get("link"));
    expect(tainted.response.headers.get("link")).not.toMatch(/marker|Bearer|test-read-token|https?:|\/\//);
    expect(ids((await page(next(tainted))).body)).toEqual([211]);
  });

  it("keeps exact-next lookahead terminal behavior under presence filters", async () => {
    const first = await page({ hasSerialNumber: "true", hasRfid: "true", limit: "2", exactNext: "true" });
    expect(ids(first.body)).toEqual([201, 206]);
    expect(first.body.total).toBe(6);
    expect(first.body.nextCursor).toBe(206);
    const second = await page(next(first));
    expect(ids(second.body)).toEqual([207, 208]);
    const terminal = await page({ hasSerialNumber: "true", hasRfid: "true", limit: "6", exactNext: "true" });
    expect(ids(terminal.body)).toEqual([201, 206, 207, 208, 209, 213]);
    expect(terminal.body.nextCursor).toBeNull();
    expect(terminal.response.headers.get("link")).toBeNull();
  });
});

describe("presence conditional representations", () => {
  it.each(["true", "false"] as const)("hasSerialNumber=%s replays the exact sparse envelope as an empty 304", async (value) => {
    const query = { hasSerialNumber: value, fields: "serial_number", limit: "2", includeTotal: "false" };
    const first = await request(query);
    expect(first.response.status).toBe(200);
    const bytes = await first.response.text();
    expect(ids(JSON.parse(bytes) as Body)).toEqual(value === "true" ? [201, 202] : [203, 204]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
    const computed = `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
    expect(first.response.headers.get("etag")).toBe(computed);
    const link = first.response.headers.get("link");
    expect(link).not.toBeNull();
    for (const validator of [computed, `W/${computed}`, "*"]) {
      const replay = await request(query, { headers: { "if-none-match": validator } });
      expect(replay.response.status).toBe(304);
      expect(replay.response.body).toBeNull();
      expect((await replay.response.arrayBuffer()).byteLength).toBe(0);
      expect(replay.response.headers.get("etag")).toBe(computed);
      expect(replay.response.headers.get("cache-control")).toBe("no-store");
      expect(replay.response.headers.get("link")).toBe(link);
      expect(replay.recorder.statements).toHaveLength(1);
      expect(replay.recorder.statements.filter(isCount)).toHaveLength(0);
    }
  });

  it.each([
    ["opposite selector", { hasSerialNumber: "false", fields: "serial_number", limit: "2", includeTotal: "false" }],
    ["counted envelope", { hasSerialNumber: "true", fields: "serial_number", limit: "2" }],
    ["different fieldset", { hasSerialNumber: "true", fields: "rfid", limit: "2", includeTotal: "false" }],
    ["different page", { hasSerialNumber: "true", fields: "serial_number", limit: "2", cursor: "202", includeTotal: "false" }]
  ] as const)("does not 304 a %s using another representation's tag", async (_name, query) => {
    const first = await request({ hasSerialNumber: "true", fields: "serial_number", limit: "2", includeTotal: "false" });
    const bytes = await first.response.text();
    const other = await request(query, { headers: { "if-none-match": first.response.headers.get("etag")! } });
    expect(other.response.status).toBe(200);
    expect(other.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
    expect(await other.response.text()).not.toBe(bytes);
  });
});

describe.each(["hasSerialNumber", "hasRfid"] as const)("%s: value-free validation before D1, after authentication", (selector: Selector) => {
  const encodedDuplicate = selector === "hasSerialNumber"
    ? "hasSerialNumber=true&hasSerial%4Eumber=true"
    : "hasRfid=true&has%52fid=true";
  const invalid: Array<[string, string]> = [
    ...["", "TRUE", "False", "Any", "1", "0", " true", "false ", "any\n", "true,false"].map(
      (value): [string, string] => [JSON.stringify(value), `${selector}=${encodeURIComponent(value)}`]),
    ["bare key", selector],
    ["repeated identical", `${selector}=any&${selector}=any`],
    ["repeated conflicting", `${selector}=true&${selector}=false`],
    ["repeated empty plus valid", `${selector}=&${selector}=true`],
    ["encoded duplicate", encodedDuplicate]
  ];

  it.each(invalid)("rejects %s before any D1 access, without logging or reflecting the value", async (_name, search) => {
    const db = forbiddenDb();
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
    const { response } = await request(search, { db: db.db, headers: { "if-none-match": "*" } });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("link")).toBeNull();
    expect(response.headers.get("etag")).toBeNull();
    expect(await response.json()).toEqual({
      type: BAD_REQUEST, title: "Bad Request", status: 400,
      detail: `Invalid request query (${selector}). See docs/PROBLEMS.md#bad-request.`
    });
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each([null, "synthetic-wrong-token"])("authenticates before malformed selector validation (token %s)", async (token) => {
    const db = forbiddenDb();
    const { response } = await request(`${selector}=secret-marker-xyz&${selector}=true`, { token, db: db.db, headers: { "if-none-match": "*" } });
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("link")).toBeNull();
    const problem = await response.json() as Record<string, unknown>;
    expect(problem).toMatchObject({ status: 401, title: "Unauthorized" });
    expect(String(problem.type)).toMatch(/#unauthorized$/);
    expect(JSON.stringify(problem)).not.toContain("secret-marker-xyz");
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
  });

  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("preserves authorized read access via %s", async (token) => {
    const result = await page(selector === "hasSerialNumber" ? { hasSerialNumber: "true" } : { hasRfid: "false" }, token);
    expect(ids(result.body)).toEqual(selector === "hasSerialNumber" ? SERIAL_PRESENT : RFID_ABSENT);
  });
});

describe("presence mounted machine-readable discovery", () => {
  type Parameter = {
    name: string; in: string; required?: boolean; description?: string; example?: unknown;
    schema?: { type?: unknown; enum?: unknown; default?: unknown; example?: unknown; description?: string };
  };
  type Operation = { operationId?: string; description?: string; parameters?: Parameter[]; responses?: Record<string, { description?: string }>; "x-access"?: string; "x-effect"?: string };

  async function document() {
    const url = new URL("/openapi.json", ORIGIN);
    const { response } = await request(url, { token: null });
    expect(response.status).toBe(200);
    return await response.json() as { paths: Record<string, Record<string, Operation>> };
  }

  it.each(["hasSerialNumber", "hasRfid"] as const)("publishes optional %s as exact true|false|any with a replayable example", async (selector) => {
    const doc = await document();
    const operation = doc.paths[PATH].get;
    expect(operation).toMatchObject({ operationId: "listContainerSnapshot", "x-access": "read", "x-effect": "local-read" });
    const matches = operation.parameters?.filter((p) => p.in === "query" && p.name === selector) ?? [];
    expect(matches).toHaveLength(1);
    const param = matches[0];
    expect(param.required ?? false).toBe(false);
    expect(param.schema).toMatchObject({ type: "string", enum: ["true", "false", "any"], default: "any" });
    const example = param.example ?? param.schema?.example;
    expect(["true", "false", "any"]).toContain(example);
    const replay = await page({ [selector]: String(example) });
    const want = selector === "hasSerialNumber"
      ? example === "true" ? SERIAL_PRESENT : example === "false" ? SERIAL_ABSENT : ALL
      : example === "true" ? RFID_PRESENT : example === "false" ? RFID_ABSENT : ALL;
    expect(ids(replay.body)).toEqual(want);
  });

  it("describes stored-text presence per field without promising live tag truth", async () => {
    const doc = await document();
    const params = doc.paths[PATH].get.parameters ?? [];
    const serial = params.find((p) => p.name === "hasSerialNumber")!;
    const rfid = params.find((p) => p.name === "hasRfid")!;
    expect(serial).toBeDefined();
    expect(rfid).toBeDefined();
    expect(`${serial.description ?? ""} ${serial.schema?.description ?? ""}`).toMatch(/serial/i);
    expect(`${rfid.description ?? ""} ${rfid.schema?.description ?? ""}`).toMatch(/rfid/i);
    for (const param of [serial, rfid]) {
      const prose = `${param.description ?? ""} ${param.schema?.description ?? ""}`;
      expect(prose).toMatch(/mirror|stored/i);
      expect(prose).toMatch(/whitespace/i);
      expect(prose).toMatch(/empty/i);
      expect(prose).toMatch(/one|single/i);
      expect(prose).toMatch(/omit/i);
      expect(prose).toMatch(/retry/i);
    }
  });

  it("documents AND composition and the new rejection cases without losing legacy query guidance", async () => {
    const doc = await document();
    const operation = doc.paths[PATH].get;
    const description = operation.description ?? "";
    for (const key of ["hasSerialNumber", "hasRfid", "customerId", "pickupAddressId", "containerId", "q", "enabled", "cursor", "offset"]) {
      expect(description, key).toContain(key);
    }
    expect(description).toMatch(/\bAND\b/i);
    const error = operation.responses?.["400"]?.description ?? "";
    for (const key of ["hasSerialNumber", "hasRfid", "q", "limit", "offset", "enabled", "fields"]) {
      expect(error, key).toContain(key);
    }
    expect(error).toContain("application/problem+json");
    expect(error).toMatch(/before.*D1/i);
    expect(error).toMatch(/repeat|duplicate/i);
    expect(error).toMatch(/empty|blank/i);
    expect(error).toMatch(/true.*false.*any/);
  });

  it("keeps the machine-readable query inventory aligned with the served parameter names", async () => {
    const doc = await document();
    const row = policyDoc.split("\n").find((line) => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    const inventory = [...(row!.split("|")[2]).matchAll(/`([^`]+)`/g)].map((match) => match[1]).sort();
    const published = (doc.paths[PATH].get.parameters ?? []).filter((param) => param.in === "query").map((param) => param.name).sort();
    expect(inventory).toEqual(published);
  });

  it("keeps presence selectors off siblings, changes and by-ID operations", async () => {
    const doc = await document();
    expect(doc.paths[PATH].get.operationId).toBe("listContainerSnapshot");
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/address-snapshot", "/api/v1/customer-snapshot/changes", "/api/v1/customer-snapshot/{customerId}", "/api/v1/address-snapshot/{pickupAddressId}", "/api/v1/container-snapshot/{containerId}"]) {
      const params = doc.paths[path].get.parameters?.map((p) => p.name) ?? [];
      expect(params, path).not.toContain("hasSerialNumber");
      expect(params, path).not.toContain("hasRfid");
    }
    expect(app.routes.filter((r) => /(?:hasSerialNumber|hasRfid)/i.test(r.path))).toEqual([]);
  });
});

// Machine-consumed selection/safety instructions, not human prose style
// pins: an agent must discover tagged-vs-untagged cohorts without inferring
// live tag scans, deployment proof or identifier uniqueness from stored text.
describe("presence agent guidance", () => {
  it("inventories both selectors only on the container list and links the focused oracle", () => {
    const row = (path: string) => policyDoc.split("\n").find((line) => line.startsWith(`| \`${path}\` |`)) ?? "";
    expect(row(PATH)).toContain("`hasSerialNumber`");
    expect(row(PATH)).toContain("`hasRfid`");
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/address-snapshot"]) {
      expect(row(path)).not.toContain("hasSerialNumber");
      expect(row(path)).not.toContain("hasRfid");
    }
    expect(policyDoc).toContain("test/containerSerialRfidPresence.acceptance.test.ts");
  });

  it("explains mirrored-report absence and forbids inferring live tag truth from it", () => {
    const sections = policyDoc.split(/^#{1,6} /m).filter((section) => section.includes("hasSerialNumber"));
    const guidance = sections.join("\n");
    expect(guidance).toMatch(/hasRfid/);
    expect(guidance).toMatch(/mirror/i);
    expect(guidance).toMatch(/report/i);
    expect(guidance).toMatch(/upstream/i);
    expect(guidance).toMatch(/not (?:proof|evidence)|does not (?:prove|mean)|no (?:proof|guarantee)/i);
    expect(guidance).toMatch(/live/i);
    expect(guidance).toMatch(/scan/i);
    expect(guidance).toMatch(/deplo/i);
    expect(guidance).toMatch(/uniq/i);
    expect(guidance).toMatch(/gap/i);
    expect(guidance).toMatch(/never|does not authori[sz]e|must not|not permission/i);
    const listRow = snapshotDoc.split("\n").find((line) => line.includes("GET") && line.includes(PATH)) ?? "";
    expect(listRow).toMatch(/hasSerialNumber/);
    expect(listRow).toMatch(/hasRfid/);
    expect(problemsDoc).toContain("hasSerialNumber");
    expect(problemsDoc).toContain("hasRfid");
  });

  it("publishes local synthetic tagged-vs-untagged count-only recipes that can be traversed", () => {
    const blocks = [...quickstartDoc.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((m) => m[1]);
    for (const selector of ["hasSerialNumber", "hasRfid"]) {
      const recipe = blocks.find((b) => b.includes(`${selector}=`) && b.includes("countOnly=true"));
      expect(recipe, `local ${selector} count-only recipe`).toBeDefined();
      expect(recipe).toContain(PATH);
      expect(recipe).toContain("localhost:8787");
      expect(recipe).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
    }
    expect(blocks.some((b) => b.includes("hasSerialNumber=") && /cursor|rel=.next|[Ll]ink/.test(b))).toBe(true);
    expect(changelog.split(/^## /m)[1]).toContain("hasSerialNumber");
    expect(changelog.split(/^## /m)[1]).toContain("hasRfid");
  });

  it("exposes a named local-only focused check that includes this acceptance suite", () => {
    const scripts = packageJson.scripts as Record<string, string>;
    const command = scripts["check:container-serial-rfid-presence"];
    expect(command).toEqual(expect.any(String));
    expect(command).toMatch(/vitest\s+run/);
    expect(command).toContain("test/containerSerialRfidPresence.acceptance.test.ts");
    expect(command).not.toMatch(/--remote|deploy|probe:post-deploy/);
  });
});
