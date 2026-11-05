/// <reference types="vite/client" />

import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import { focusedCheckEntries } from "./focusedChecks";

/**
 * Independent test-author oracle; consume unchanged in the paired implementation.
 * Real local D1, synthetic fixtures, literal expected IDs. No coordinate parser or
 * product query builder computes expectations. Expected RED at the baseline.
 *
 * Address IDs 11..20 / container IDs 101..110 have these OWN stored TEXT pairs:
 *   1: NULL/NULL, 2: NULL/"2", 3: "1"/NULL, 4: "1"/"2", 5: "0"/"0",
 *   6: "-1"/"-2", 7: ""/" ", 8: "north"/"east", 9: "1"/"2", 10: NULL/NULL.
 * Present = positions 4..9; absent = 1,2,3,10. Positions 5,8,10 are disabled.
 * Container parents deliberately disagree: 101..103 have present parents,
 * 104..109 have absent parents. Duplicate pairs are separate stable rows.
 *
 * Breaks caught: truthiness/numeric/range normalization; inherited coordinates;
 * OR-composed filters; divergent COUNT/page predicates; hidden COUNT/lookahead;
 * lost false-like continuation filters; reflected unknown input; auth regression.
 * Product implementation, docs and package scripts remain the Builder's work.
 */
const TEST_ENV = env as unknown as Env;
const ORIGIN = "https://coordinates.test.invalid";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
type Query = Record<string, string | number>;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[]; method: string };
const resources = [
  { name: "address", path: "/api/v1/address-snapshot", id: "pickup_address_id", base: 10,
    operation: "listAddressSnapshot", present: [14, 15, 16, 17, 18, 19], absent: [11, 12, 13, 20],
    all: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20] },
  { name: "container", path: "/api/v1/container-snapshot", id: "container_id", base: 100,
    operation: "listContainerSnapshot", present: [104, 105, 106, 107, 108, 109], absent: [101, 102, 103, 110],
    all: [101, 102, 103, 104, 105, 106, 107, 108, 109, 110] }
] as const;
type Resource = typeof resources[number];
const pairs: Array<[string | null, string | null]> = [
  [null, null], [null, "2"], ["1", null], ["1", "2"], ["0", "0"],
  ["-1", "-2"], ["", " "], ["north", "east"], ["1", "2"], [null, null]
];
const parents = [14, 15, 16, 11, 12, 13, 11, 12, 13, 20];
const denyExternal = vi.fn(() => { throw new Error("Coordinate list must not use network, R2 or browser"); });
const bucket = Object.fromEntries([
  "get", "head", "list", "put", "delete", "createMultipartUpload", "resumeMultipartUpload"
].map((key) => [key, denyExternal])) as unknown as R2Bucket;
const recorders: ReturnType<typeof recordDb>[] = [];
let requestNumber = 0;

function recordDb(real: D1Database) {
  const statements: Statement[] = [];
  const fail = () => { throw new Error("List must only SELECT from local D1"); };
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
  return { db: { prepare: (sql: string) => wrap(real.prepare(sql), sql, []), batch, exec } as unknown as D1Database,
    statements, batch, exec };
}

function forbiddenDb() {
  const fail = () => { throw new Error("Rejected request must not touch D1"); };
  const prepare = vi.fn(fail), batch = vi.fn(fail), exec = vi.fn(fail);
  return { db: { prepare, batch, exec } as unknown as D1Database, prepare, batch, exec };
}

async function request(resource: Resource, query: Query | URLSearchParams | URL = {}, options: {
  token?: string | null; db?: D1Database; headers?: Record<string, string>
} = {}) {
  const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
  recorders.push(recorder);
  const url = query instanceof URL ? query : new URL(resource.path, ORIGIN);
  if (!(query instanceof URL)) {
    url.search = query instanceof URLSearchParams ? query.toString()
      : new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
  }
  const headers = new Headers(options.headers);
  headers.set("cf-connecting-ip", `192.0.2.${++requestNumber}`);
  const token = options.token === undefined ? "test-read-token" : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: options.db ?? recorder.db, SNAPSHOTS: bucket,
    BROWSER: { fetch: denyExternal } as unknown as Fetcher
  });
  return { response, recorder, url };
}

async function page(resource: Resource, query: Query | URL = {}) {
  const result = await request(resource, query);
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  const bytes = await result.response.clone().text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const counted = result.url.searchParams.get("includeTotal") !== "false";
  expect(result.recorder.statements).toHaveLength(counted ? 2 : 1);
  expect(result.recorder.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(counted ? 1 : 0);
  if (!counted) expect(body.total).toBeNull();
  for (const row of body.rows) expect(typeof row[resource.id]).toBe("number");
  const ids = body.rows.map((row) => row[resource.id] as number);
  expect(new Set(ids).size).toBe(ids.length);
  return { ...result, body, bytes, ids };
}

function next(resource: Resource, response: Response, current: URL, expected: Query) {
  const link = response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/(?:address|container)-snapshot\?[^<>\s]*>; rel="next"$/);
  const raw = /^<([^>]+)>; rel="next"$/.exec(link!)![1];
  expect(raw).not.toMatch(/https?:|\/\/|marker|Bearer|test-read-token/);
  const url = new URL(raw, current);
  expect(url.origin).toBe(ORIGIN);
  expect(url.pathname).toBe(resource.path);
  expect(url.username + url.password + url.hash).toBe("");
  const actual = new URLSearchParams(url.searchParams);
  if (expected.includeTotal !== "false") {
    expect([null, "true"]).toContain(actual.get("includeTotal"));
    expect(actual.getAll("includeTotal").length).toBeLessThanOrEqual(1);
    actual.delete("includeTotal");
  }
  const expectedParams = { ...expected };
  if (expectedParams.includeTotal === "true") delete expectedParams.includeTotal;
  expect([...actual.keys()].length).toBe(Object.keys(expectedParams).length);
  expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(Object.entries(expectedParams).map(([k, v]) => [k, String(v)])));
  return url;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(denyExternal));
  denyExternal.mockClear();
  recorders.length = 0;
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (100, 'Synthetic One', 1, 'synthetic'), (200, 'Synthetic Two', 0, 'synthetic')")
  ]);
  for (let i = 0; i < pairs.length; i++) {
    const id = 11 + i, [latitude, longitude] = pairs[i];
    const enabled = [4, 7, 9].includes(i) ? 0 : 1;
    const label = [0, 1, 3, 5, 6, 8].includes(i) ? "Needle" : "Other";
    await db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, city, state, zip, latitude, longitude, enabled, route_id, franchise_id, synced_at) VALUES (?, ?, ?, 'Synthetic City', 'TS', ?, ?, ?, ?, ?, ?, 'synthetic')")
      .bind(id, i < 5 ? 100 : 200, `Synthetic ${label} ${id}`, [0, 3, 6, 8].includes(i) ? "70000" : "70001",
        latitude, longitude, enabled, i % 2 === 0 ? 0 : 7, i < 6 ? "001" : "1").run();
  }
  for (let i = 0; i < pairs.length; i++) {
    const id = 101 + i, [latitude, longitude] = pairs[i];
    const enabled = [4, 7, 9].includes(i) ? 0 : 1;
    const label = [0, 1, 3, 5, 6, 8].includes(i) ? "Needle" : "Other";
    await db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, rfid, latitude, longitude, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synthetic')")
      .bind(id, parents[i], `Synthetic ${label} ${id}`, [3, 4, 8].includes(i) ? "DUP" : `SER-${id}`,
        [3, 5, 7].includes(i) ? "TAG" : `RF-${id}`, latitude, longitude, enabled).run();
  }
});
afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denyExternal).not.toHaveBeenCalled();
    for (const recorder of recorders) {
      expect(recorder.batch).not.toHaveBeenCalled();
      expect(recorder.exec).not.toHaveBeenCalled();
      expect(recorder.statements.every((s) => /^\s*SELECT\b/i.test(s.sql) && s.method !== "run")).toBe(true);
    }
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe.each(resources)("$name stored coordinate-pair presence", (resource) => {
  it.each(["true", "false"] as const)("%s selects SQL NULL presence, not geographic validity or enabled status", async (value) => {
    const result = await page(resource, { hasCoordinates: value });
    expect(result.ids).toEqual(value === "true" ? resource.present : resource.absent);
    expect(result.body.total).toBe(value === "true" ? 6 : 4);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    if (value === "true") {
      expect(result.body.rows.map((r) => [r.latitude, r.longitude])).toEqual([
        ["1", "2"], ["0", "0"], ["-1", "-2"], ["", " "], ["north", "east"], ["1", "2"]
      ]);
    }
  });

  it("omission and any preserve all rows, bytes, ETag and executed queries", async () => {
    const omitted = await page(resource);
    const any = await page(resource, { hasCoordinates: "any" });
    expect(omitted.ids).toEqual(resource.all);
    expect(omitted.body.total).toBe(10);
    expect(any.bytes).toBe(omitted.bytes);
    expect(any.response.headers.get("etag")).toBe(omitted.response.headers.get("etag"));
    expect(any.recorder.statements).toEqual(omitted.recorder.statements);
  });

  it.each([
    ["true", "true", [4, 6, 7, 9]], ["true", "false", [5, 8]],
    ["false", "true", [1, 2, 3]], ["false", "false", [10]]
  ] as const)("hasCoordinates=%s AND enabled=%s", async (value, enabled, positions) => {
    const result = await page(resource, { hasCoordinates: value, enabled });
    expect(result.ids).toEqual(positions.map((n) => resource.base + n));
    expect(result.body.total).toBe(positions.length);
  });

  it.each(["true", "false"] as const)("%s composes with q and yields no rows for an incompatible ID", async (value) => {
    const result = await page(resource, { hasCoordinates: value, q: "needle" });
    expect(result.ids).toEqual((value === "true" ? [4, 6, 7, 9] : [1, 2]).map((n) => resource.base + n));
    expect(result.body.total).toBe(value === "true" ? 4 : 2);
    const ownId = resource.name === "address" ? "pickupAddressId" : "containerId";
    const miss = await page(resource, { hasCoordinates: value, [ownId]: resource.base + (value === "true" ? 1 : 4) });
    expect(miss.ids).toEqual([]);
    expect(miss.body.total).toBe(0);
    expect(miss.body.nextCursor).toBeNull();
    expect(miss.response.headers.get("link")).toBeNull();
  });

  it.each(["true", "false"] as const)("%s uses identical COUNT/page filters and binds; count-free performs one read", async (value) => {
    const query = { hasCoordinates: value, q: "needle", enabled: "true", upperId: resource.base + 7, limit: 2 };
    const counted = await page(resource, query);
    expect(counted.ids).toEqual((value === "true" ? [4, 6] : [1, 2]).map((n) => resource.base + n));
    expect(counted.body.total).toBe(value === "true" ? 3 : 2);
    const count = counted.recorder.statements.find((s) => /\bCOUNT\s*\(/i.test(s.sql))!;
    const select = counted.recorder.statements.find((s) => !/\bCOUNT\s*\(/i.test(s.sql))!;
    const where = (sql: string) => sql.split(/\bWHERE\b/i)[1]?.split(/\bORDER\s+BY\b|\bLIMIT\b/i)[0].trim().replace(/\s+/g, " ");
    expect(where(count.sql)).toBeTruthy();
    expect(where(select.sql)).toBe(where(count.sql));
    expect(select.binds.slice(0, -2)).toEqual(count.binds);
    expect(select.binds.slice(-2)).toEqual([2, 0]); // No LIMIT+1 lookahead.
    const free = await page(resource, { ...query, includeTotal: "false" });
    expect(free.body.rows).toEqual(counted.body.rows);
    expect(free.body.nextCursor).toBe(counted.body.nextCursor);
    expect(free.body.total).toBeNull();
    expect(free.recorder.statements).toEqual([select]);
  });

  it("offset preserves full filtered total; cursor overrides offset and makes totals seek-relative", async () => {
    const offset = await page(resource, { hasCoordinates: "true", limit: 2, offset: 2 });
    expect(offset.ids).toEqual([resource.base + 6, resource.base + 7]);
    expect(offset.body.total).toBe(6);
    const seek = await page(resource, { hasCoordinates: "true", cursor: resource.base + 6, offset: 99, limit: 2 });
    expect(seek.ids).toEqual([resource.base + 7, resource.base + 8]);
    expect(seek.body.total).toBe(3);
    const beyond = await page(resource, { hasCoordinates: "false", offset: 4, limit: 2 });
    expect(beyond.ids).toEqual([]);
    expect(beyond.body.total).toBe(4);
    expect(beyond.body.nextCursor).toBeNull();
  });

  it.each(["asc", "desc"] as const)("upperId bounds %s seek pages without losing the coordinate predicate", async (order) => {
    const result = await page(resource, {
      hasCoordinates: "true", upperId: resource.base + 7, order, limit: 2,
      cursor: resource.base + (order === "asc" ? 4 : 8)
    });
    // Asc excludes 4 and includes 5: disabled rows remain eligible.
    expect(result.ids).toEqual((order === "asc" ? [5, 6] : [7, 6]).map((n) => resource.base + n));
    expect(result.body.total).toBe(order === "asc" ? 3 : 4);
  });

  it.each(["true", "false"] as const)("%s sparse pages keep stable IDs and conditional 304 envelopes", async (value) => {
    const query = { hasCoordinates: value, fields: "latitude,longitude", limit: 2 };
    const first = await page(resource, query);
    expect(first.ids).toEqual(value === "true" ? resource.present.slice(0, 2) : resource.absent.slice(0, 2));
    for (const row of first.body.rows) expect(Object.keys(row).sort()).toEqual([resource.id, "latitude", "longitude"].sort());
    const tag = first.response.headers.get("etag");
    expect(tag).toMatch(/^".+"$/);
    const replay = await request(resource, query, { headers: { "if-none-match": tag! } });
    expect(replay.response.status).toBe(304);
    expect(replay.response.headers.get("etag")).toBe(tag);
    expect(replay.response.headers.get("cache-control")).toBe("no-store");
    expect((await replay.response.arrayBuffer()).byteLength).toBe(0);
    const opposite = await page(resource, { ...query, hasCoordinates: value === "true" ? "false" : "true" });
    expect(opposite.response.headers.get("etag")).not.toBe(tag);
  });

  for (const value of ["true", "false"] as const) for (const order of ["asc", "desc"] as const) for (const includeTotal of ["true", "false"] as const) {
    it(`walks ${value}/${order}/includeTotal=${includeTotal} relative links without duplicates`, async () => {
      const expected = [...(value === "true" ? resource.present : resource.absent)];
      if (order === "desc") expected.reverse();
      const filters: Query = { hasCoordinates: value, order, limit: 2, includeTotal, fields: `${resource.id},enabled`, upperId: resource.base + 10 };
      let current = await page(resource, filters);
      const seen: number[] = [];
      for (let index = 0; index <= expected.length / 2; index++) {
        expect(current.ids).toEqual(expected.slice(index * 2, index * 2 + 2));
        expect(current.body.total).toBe(includeTotal === "true" ? expected.length - index * 2 : null);
        seen.push(...current.ids);
        if (current.ids.length === 0) {
          expect(current.body.nextCursor).toBeNull();
          expect(current.response.headers.get("link")).toBeNull();
          break;
        }
        const cursor = current.ids[current.ids.length - 1];
        expect(current.body.nextCursor).toBe(cursor);
        current = await page(resource, next(resource, current.response, current.url, { ...filters, cursor }));
      }
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(expected.length);
    });
  }

  it.each([{}, { hasCoordinates: "any" }] as Query[])("omits any/default from next links: %j", async (filter) => {
    const first = await page(resource, { ...filter, limit: 2 });
    const target = next(resource, first.response, first.url, { limit: 2, cursor: resource.base + 2 });
    expect(target.searchParams.has("hasCoordinates")).toBe(false);
    expect((await page(resource, target)).ids).toEqual([resource.base + 3, resource.base + 4]);
  });

  it("never reflects unknown keys, origins or credentials into filtered bytes or relative links", async () => {
    const query = { hasCoordinates: "false", limit: 1, includeTotal: "false" };
    const clean = await page(resource, query);
    const tainted = await request(resource, { ...query, "unknown-marker": "value-marker", token: "credential-marker", url: "https://redirect-marker.invalid" },
      { headers: { origin: "https://origin-marker.invalid", host: "host-marker.invalid" } });
    expect(tainted.response.status).toBe(200);
    expect(await tainted.response.clone().text()).toBe(clean.bytes);
    expect(tainted.response.headers.get("link")).toBe(clean.response.headers.get("link"));
    next(resource, tainted.response, tainted.url, { ...query, cursor: resource.base + 1 });
  });

  const invalid = ["", "TRUE", "True", "0", "1", "yes", "null", " true", "false ", "true,false", "secret-marker"];
  it.each(invalid)("rejects unsupported hasCoordinates=%j before D1 with fixed value-free remediation", async (value) => {
    const db = forbiddenDb();
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((m) => vi.spyOn(console, m));
    const result = await request(resource, { hasCoordinates: value, "unknown-marker": "secret-marker" }, { db: db.db });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("link")).toBeNull();
    const text = await result.response.text();
    expect(JSON.parse(text)).toMatchObject({ type: BAD_REQUEST, title: "Bad Request", status: 400 });
    expect(text).toContain("hasCoordinates");
    expect(text).not.toMatch(/secret-marker|unknown-marker|TRUE|True|true,false/);
    // Remediation may live in detail or an extension; do not prescribe a new shape.
    expect(text).toMatch(/true/);
    expect(text).toMatch(/false/);
    expect(text).toMatch(/any/);
    expect(text).toMatch(/omit/i);
    const other = await request(resource, { hasCoordinates: "another-marker" }, { db: db.db });
    expect(await other.response.text()).toBe(text);
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each(["true&hasCoordinates=false", "false&hasCoordinates=false", "any&hasCoordinates=any", "&hasCoordinates=true"])(
    "rejects repeated hasCoordinates=%s, including identical or blank entries", async (suffix) => {
      const db = forbiddenDb();
      const result = await request(resource, new URLSearchParams(`hasCoordinates=${suffix}`), { db: db.db });
      expect(result.response.status).toBe(400);
      expect(result.response.headers.get("content-type")).toContain("application/problem+json");
      expect(await result.response.json()).toMatchObject({ type: BAD_REQUEST, status: 400 });
      expect(db.prepare).not.toHaveBeenCalled();
      expect(db.batch).not.toHaveBeenCalled();
      expect(db.exec).not.toHaveBeenCalled();
    }
  );

  it.each([null, "synthetic-invalid-token"])("auth precedes valid, invalid and repeated values for token %j", async (token) => {
    for (const search of ["hasCoordinates=true", "hasCoordinates=secret-marker", "hasCoordinates=true&hasCoordinates=false"]) {
      const db = forbiddenDb();
      const result = await request(resource, new URLSearchParams(search), { token, db: db.db });
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get("content-type")).toContain("application/problem+json");
      expect(result.response.headers.get("link")).toBeNull();
      expect(await result.response.text()).not.toContain("secret-marker");
      expect(db.prepare).not.toHaveBeenCalled();
      expect(db.batch).not.toHaveBeenCalled();
      expect(db.exec).not.toHaveBeenCalled();
    }
  });
});

describe("coordinate presence intersects resource-specific selectors", () => {
  it.each([
    ["true", { customerId: 100 }, [14, 15]], ["false", { customerId: 100 }, [11, 12, 13]],
    ["true", { pickupAddressId: 14 }, [14]], ["false", { pickupAddressId: 11 }, [11]],
    ["true", { zip: "70000" }, [14, 17, 19]], ["false", { zip: "70000" }, [11]],
    ["true", { ids: "11,14,15,19" }, [14, 15, 19]], ["false", { ids: "11,14,15,19" }, [11]],
    ["true", { routeId: 0 }, [15, 17, 19]], ["false", { routeId: 0 }, [11, 13]],
    ["true", { franchiseId: "001" }, [14, 15, 16]], ["false", { franchiseId: "001" }, [11, 12, 13]],
    ["true", { hasContainers: "true" }, [14, 15, 16]], ["true", { hasContainers: "false" }, [17, 18, 19]],
    ["false", { hasContainers: "true" }, [11, 12, 13, 20]], ["false", { hasContainers: "false" }, []],
    ["true", { customerId: 200, zip: "70000", q: "needle", enabled: "true", upperId: 18 }, [17]]
  ] as Array<[string, Query, number[]]>)("address %s AND %j", async (value, filters, expected) => {
    const result = await page(resources[0], { hasCoordinates: value, ...filters });
    expect(result.ids).toEqual(expected);
    expect(result.body.total).toBe(expected.length);
  });

  it.each([
    ["true", { customerId: 100 }, [104, 105, 106, 107, 108, 109]],
    ["false", { customerId: 100 }, [101, 102]],
    ["true", { customerId: 200 }, []], ["false", { customerId: 200 }, [103, 110]],
    ["true", { pickupAddressId: 11 }, [104, 107]], ["false", { pickupAddressId: 14 }, [101]],
    ["true", { containerId: 105 }, [105]], ["false", { containerId: 102 }, [102]],
    ["true", { ids: "101,104,105,109" }, [104, 105, 109]], ["false", { ids: "101,104,105,109" }, [101]],
    ["true", { serialNumber: "DUP" }, [104, 105, 109]], ["false", { serialNumber: "DUP" }, []],
    ["true", { rfid: "TAG" }, [104, 106, 108]], ["false", { rfid: "TAG" }, []],
    ["true", { customerId: 100, pickupAddressId: 11, serialNumber: "DUP", rfid: "TAG", enabled: "true", q: "needle" }, [104]]
  ] as Array<[string, Query, number[]]>)("container %s AND %j uses its own coordinates, including customer joins", async (value, filters, expected) => {
    const result = await page(resources[1], { hasCoordinates: value, ...filters });
    expect(result.ids).toEqual(expected);
    expect(result.body.total).toBe(expected.length);
  });

  it.each(["true", "false"] as const)("container customer-join %s shares COUNT/page predicates, binds and count-free rows", async (value) => {
    const filters = { hasCoordinates: value, customerId: 100, limit: 2 };
    const counted = await page(resources[1], filters);
    expect(counted.ids).toEqual(value === "true" ? [104, 105] : [101, 102]);
    expect(counted.body.total).toBe(value === "true" ? 6 : 2);
    const count = counted.recorder.statements.find((s) => /\bCOUNT\s*\(/i.test(s.sql))!;
    const select = counted.recorder.statements.find((s) => !/\bCOUNT\s*\(/i.test(s.sql))!;
    const where = (sql: string) => sql.split(/\bWHERE\b/i)[1]?.split(/\bORDER\s+BY\b|\bLIMIT\b/i)[0].trim().replace(/\s+/g, " ");
    expect(where(count.sql)).toBeTruthy();
    expect(where(select.sql)).toBe(where(count.sql));
    expect(select.binds.slice(0, -2)).toEqual(count.binds);
    expect(select.binds.slice(-2)).toEqual([2, 0]);
    const free = await page(resources[1], { ...filters, includeTotal: "false" });
    expect(free.body).toEqual({ ...counted.body, total: null });
    expect(free.recorder.statements).toEqual([select]);
  });

  for (const value of ["true", "false"] as const) for (const order of ["asc", "desc"] as const) {
    it(`container customer-join ${value}/${order} follows complete filtered links`, async () => {
      const expected = value === "true" ? [104, 105, 106, 107, 108, 109] : [101, 102];
      if (order === "desc") expected.reverse();
      const filters = { hasCoordinates: value, customerId: 100, order, limit: 2, includeTotal: "false" };
      const seen: number[] = [];
      let current = await page(resources[1], filters);
      for (let i = 0; i <= expected.length / 2; i++) {
        expect(current.ids).toEqual(expected.slice(i * 2, i * 2 + 2));
        seen.push(...current.ids);
        if (current.body.nextCursor === null) {
          expect(current.ids).toEqual([]);
          expect(current.response.headers.get("link")).toBeNull();
          break;
        }
        current = await page(resources[1], next(resources[1], current.response, current.url, { ...filters, cursor: current.body.nextCursor }));
      }
      expect(seen).toEqual(expected);
      expect(new Set(seen).size).toBe(expected.length);
    });
  }
});

describe("coordinate-presence agent discovery", () => {
  it("inventories the selector on exactly the two ordinary lists", () => {
    const row = (path: string) => policyDoc.split("\n").find((line) => line.startsWith(`| \`${path}\` |`)) ?? "";
    for (const resource of resources) expect(row(resource.path), resource.path).toContain("`hasCoordinates`");
    expect(row("/api/v1/customer-snapshot")).not.toContain("hasCoordinates");
  });

  it("provides a named agent-runnable check for this independent oracle", () => {
    const checks = focusedCheckEntries.filter(([name, command]) =>
      name.startsWith("check:") && command.includes("test/snapshotCoordinatePresence.acceptance.test.ts"));
    expect(checks.length).toBeGreaterThan(0);
  });

  it.each(resources)("offers localhost present/absent recipes for $name without embedded credentials", (resource) => {
    const blocks = [...quickstartDoc.matchAll(/^```(?:bash|sh)\n([\s\S]*?)^```/gm)].map((match) => match[1]);
    for (const value of ["true", "false"]) {
      const recipe = blocks.find((block) => block.includes(`${resource.path}?`) && block.includes(`hasCoordinates=${value}`));
      expect(recipe, `${resource.name} ${value} recipe`).toBeDefined();
      expect(recipe).toContain("localhost:8787");
      expect(recipe).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
    }
  });
});

describe("mounted coordinate-presence discovery contract", () => {
  it.each(resources)("publishes the optional enum on $name with NULL-only semantics and examples", async (resource) => {
    const result = await app.fetch(new Request(`${ORIGIN}/openapi.json`), { ...TEST_ENV, SNAPSHOTS: bucket });
    expect(result.status).toBe(200);
    const doc = await result.json() as { paths: Record<string, { get?: {
      operationId?: string; parameters?: Array<{ name: string; in: string; required?: boolean; description?: string;
        schema?: { description?: string }; [key: string]: unknown }>; [key: string]: unknown
    } }> };
    const operation = doc.paths[resource.path]?.get;
    expect(operation).toMatchObject({ operationId: resource.operation, "x-access": "read", "x-effect": "local-read" });
    const parameter = operation?.parameters?.find((p) => p.in === "query" && p.name === "hasCoordinates");
    expect(parameter).toMatchObject({ required: false, schema: { type: "string", enum: ["true", "false", "any"], default: "any" } });
    const description = parameter?.description ?? parameter?.schema?.description ?? "";
    expect(description).toMatch(/null/i);
    expect(description).toMatch(/latitude/i);
    expect(description).toMatch(/longitude/i);
    // The existing route-example oracle requires an example for every named
    // parameter; do not prescribe where the OpenAPI generator puts it.
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/customer-snapshot/changes",
      "/api/v1/address-snapshot/{pickupAddressId}", "/api/v1/container-snapshot/{containerId}"]) {
      expect(doc.paths[path]?.get?.parameters?.map((p) => p.name), path).not.toContain("hasCoordinates");
    }
  });
});
