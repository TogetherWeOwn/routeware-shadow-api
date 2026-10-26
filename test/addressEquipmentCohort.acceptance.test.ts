/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import policy from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import quickstart from "../docs/CONSUMER-QUICKSTART.md?raw";
import changelog from "../CHANGELOG.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned, implementation-blind oracle for the ordinary address list.
 * Breaks caught: separate child EXISTS clauses (split-child false positives),
 * missing/normalized scopes, fanout, COUNT drift, dropped continuation scopes,
 * validation after SQL/304, and accidentally widened API discovery.
 * Builder: consume this commit without editing this file; corrections require
 * a bounded Test Author child. No source changes, snapshots, remote calls or
 * impossible orphan fixtures. All reads execute against real synthetic D1.
 *
 * Child truth table (stream, type, enabled):
 * 11: X,5,1; 12: X,7,1 + Y,5,1 (split attributes);
 * 13: X,5,0 + Y,5,1 (split enabled); 14: TWO X,5,1 children;
 * 15: none; 16: null,null,1; 17: X,null,0; 18: null,5,0;
 * 19: x,5,1 (case decoy); 20: " X ",0,0 (opaque whitespace + zero);
 * 21/22: X,5,1 at different site/parent scopes; 23: X,5,2;
 * 24: X,5,0 only. No child may leak to a sibling site of the same customer.
 * hasEnabledContainers/synced-window are NOT merged at this starting base;
 * do not require those sibling features. Their documented independence is
 * pinned, not their unavailable runtime behavior.
 */
const E = env as unknown as Env;
const PATH = "/api/v1/address-snapshot";
const ORIGIN = "https://equipment-cohort.test.invalid";
const STAMP = "2026-01-02T03:04:05.000Z";
const AUDIT = "2026-01-15";
const ALL = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24];
const MATCH = [11, 14, 21, 22];
const COHORT = { equipmentMaterialStream: "X", equipmentTypeId: "5", equipmentEnabled: "true" };
const KEYS = ["equipmentMaterialStream", "equipmentTypeId", "equipmentEnabled"] as const;
const CHILDREN: Array<[number, number, string | null, number | null, number]> = [
  [101, 11, "X", 5, 1],
  [102, 12, "X", 7, 1], [103, 12, "Y", 5, 1],
  [104, 13, "X", 5, 0], [105, 13, "Y", 5, 1],
  [106, 14, "X", 5, 1], [107, 14, "X", 5, 1],
  [108, 16, null, null, 1], [109, 17, "X", null, 0],
  [110, 18, null, 5, 0], [111, 19, "x", 5, 1],
  [112, 20, " X ", 0, 0], [113, 21, "X", 5, 1],
  [114, 22, "X", 5, 1], [115, 23, "X", 5, 2], [116, 24, "X", 5, 0]
];
type Query = Record<string, string | number>;
type Statement = { sql: string; binds: unknown[]; method: string };
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
const ids = (body: Body) => body.rows.map((r) => r.pickup_address_id);
const qs = (query: Query) => new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();

function observeDb() {
  const statements: Statement[] = [];
  const prepared: string[] = [];
  const denied = vi.fn(() => { throw new Error("List attempted D1 mutation/batch/exec"); });
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    const read = (method: "first" | "all" | "raw", args: unknown[]) => {
      if (!/^\s*SELECT\b/i.test(sql)) return denied();
      statements.push({ sql, binds, method });
      return Reflect.apply(stmt[method], stmt, args);
    };
    return {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql, values),
      first: (...args: unknown[]) => read("first", args),
      all: (...args: unknown[]) => read("all", args),
      raw: (...args: unknown[]) => read("raw", args),
      run: denied
    } as unknown as D1PreparedStatement;
  }
  const db = {
    prepare: (sql: string) => { prepared.push(sql); return wrap(E.CUSTOMER_DB.prepare(sql), sql, []); },
    batch: denied, exec: denied
  } as unknown as D1Database;
  return { db, statements, prepared, denied };
}

let requestSequence = 0;
async function call(query: Query | string = {}, options: {
  token?: string | null; headers?: Record<string, string>; path?: string;
} = {}) {
  const recorder = observeDb();
  const token = options.token === undefined ? "test-read-token" : options.token;
  // Give each synthetic failure its own IP bucket; this is not a throttle test.
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Equipment-oracle", "cf-connecting-ip": `2001:db8::${(++requestSequence).toString(16)}`, ...options.headers });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const url = new URL(`${options.path ?? PATH}?${typeof query === "string" ? query : qs(query)}`, ORIGIN);
  const deny = vi.fn(() => { throw new Error("Local list touched an external binding"); });
  const response = await app.fetch(new Request(url, { headers }), {
    ...E, CUSTOMER_DB: recorder.db,
    SNAPSHOTS: Object.fromEntries(["get", "head", "list", "put", "delete", "createMultipartUpload", "resumeMultipartUpload"].map((k) => [k, deny])) as unknown as R2Bucket,
    BROWSER: { fetch: deny } as unknown as Fetcher
  });
  expect(deny).not.toHaveBeenCalled();
  expect(recorder.denied).not.toHaveBeenCalled();
  return { response, url, recorder };
}

async function page(query: Query | string = {}, headers?: Record<string, string>) {
  const result = await call(query, { headers });
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  expect(result.response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(result.response.headers.get("x-request-id")).toBe("Equipment-oracle");
  const bytes = await result.response.clone().text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const params = result.url.searchParams;
  const countOnly = params.get("countOnly") === "true";
  const counted = params.get("includeTotal") !== "false";
  expect(result.recorder.statements).toHaveLength(countOnly || !counted ? 1 : 2);
  expect(result.recorder.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(counted ? 1 : 0);
  if (!counted) expect(body.total).toBeNull();
  if (countOnly) {
    expect(body.rows).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  }
  expect(new Set(ids(body)).size).toBe(body.rows.length);
  for (const row of body.rows) expect(typeof row.pickup_address_id).toBe("number");
  return { ...result, body, bytes };
}

async function seed() {
  const db = E.CUSTOMER_DB;
  await db.batch([db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot")]);
  for (const [id, enabled] of [[201, 1], [202, 0]]) {
    await db.prepare("INSERT INTO customer_snapshot (customer_id, enabled, synced_at) VALUES (?, ?, ?)").bind(id, enabled, STAMP).run();
  }
  for (const id of [...ALL].reverse()) {
    const other = id === 22;
    await db.prepare(
      "INSERT INTO address_snapshot (pickup_address_id, customer_id, address, city, state, zip, route_id, franchise_id, enabled, extras_allowed, last_audit_date, driver_note, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(id, id === 21 ? 202 : 201, `${id} synthetic-needle Way`, other ? "Other" : "Riverton", other ? "OT" : "ST", other ? "99999" : "02139", other ? 8 : 7, other ? "002" : "001", id === 21 ? 0 : 1, id === 21 ? 0 : 1, id === 21 ? null : AUDIT, other ? null : "Gate amber", STAMP).run();
  }
  for (const [id, site, stream, type, enabled] of CHILDREN) {
    await db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, ud_material_stream_ud, container_type_id, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, site, stream, type, enabled, STAMP).run();
  }
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected upstream fetch"); }));
  await seed();
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("equipment cohort same-child truth table", () => {
  it.each([
    [{ equipmentMaterialStream: "X" }, [11, 12, 13, 14, 17, 21, 22, 23, 24]],
    [{ equipmentTypeId: "5" }, [11, 12, 13, 14, 18, 19, 21, 22, 23, 24]],
    [{ equipmentEnabled: "true" }, [11, 12, 13, 14, 16, 19, 21, 22]],
    [{ equipmentEnabled: "false" }, [13, 17, 18, 20, 24]],
    [{ equipmentMaterialStream: "X", equipmentTypeId: "5" }, [11, 13, 14, 21, 22, 23, 24]],
    [{ equipmentMaterialStream: "X", equipmentEnabled: "true" }, MATCH],
    [{ equipmentTypeId: "5", equipmentEnabled: "true" }, [11, 12, 13, 14, 19, 21, 22]],
    [COHORT, MATCH],
    [{ ...COHORT, equipmentEnabled: "false" }, [13, 24]],
    [{ ...COHORT, equipmentEnabled: "any" }, [11, 13, 14, 21, 22, 23, 24]],
    [{ equipmentMaterialStream: "x" }, [19]],
    [{ equipmentMaterialStream: " X " }, [20]],
    [{ equipmentTypeId: "0" }, [20]],
    [{ equipmentMaterialStream: "unknown-valid-stream", equipmentTypeId: "5" }, []],
    [{ equipmentMaterialStream: "X", equipmentTypeId: "999" }, []]
  ] as Array<[Query, number[]]>) ("%j has the hand-derived membership %j", async (query, want) => {
    for (const includeTotal of ["true", "false"]) {
      const result = await page({ ...query, includeTotal });
      expect(ids(result.body)).toEqual(want);
      expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
      expect(result.body.nextCursor).toBeNull();
      expect(result.response.headers.get("link")).toBeNull();
    }
  });

  it("omission/any alone has byte, ETag and SQL parity, including no-container site 15", async () => {
    const bare = await page({});
    const any = await page({ equipmentEnabled: "any" });
    expect(ids(bare.body)).toEqual(ALL);
    expect(any.bytes).toBe(bare.bytes);
    expect(any.response.headers.get("etag")).toBe(bare.response.headers.get("etag"));
    expect(any.recorder.statements).toEqual(bare.recorder.statements);
    for (const statement of any.recorder.statements) expect(statement.sql).not.toContain("container_snapshot");
    const stream = await page({ equipmentMaterialStream: "X" });
    const streamAny = await page({ equipmentMaterialStream: "X", equipmentEnabled: "any" });
    expect(streamAny.bytes).toBe(stream.bytes);
    expect(streamAny.recorder.statements).toEqual(stream.recorder.statements);
  });

  it("returns site 14 once despite two matching children, with no expanded attributes", async () => {
    const full = await page({ ...COHORT, pickupAddressId: "14" });
    const ordinary = await page({ pickupAddressId: "14" });
    expect(ids(full.body)).toEqual([14]);
    expect(full.body.total).toBe(1);
    expect(full.body.rows).toEqual(ordinary.body.rows);
    for (const key of [...KEYS, "containers", "container_count", "container_id", "container_type_id", "ud_material_stream_ud"]) {
      expect(full.body.rows[0]).not.toHaveProperty(key);
    }
  });

  it("proves satisfiability independently in real D1, including both split-child decoys", async () => {
    const rows = await E.CUSTOMER_DB.prepare(
      "SELECT pickup_address_id FROM address_snapshot WHERE EXISTS (SELECT 1 FROM container_snapshot c WHERE c.pickup_address_id = address_snapshot.pickup_address_id AND c.ud_material_stream_ud = 'X' AND c.container_type_id = 5 AND c.enabled = 1) ORDER BY pickup_address_id"
    ).all<{ pickup_address_id: number }>();
    expect(rows.results.map((r) => r.pickup_address_id)).toEqual(MATCH);
    const split = await E.CUSTOMER_DB.prepare(
      "SELECT container_id, ud_material_stream_ud, container_type_id, enabled FROM container_snapshot WHERE pickup_address_id IN (12,13) ORDER BY container_id"
    ).all();
    expect(split.results).toEqual([
      { container_id: 102, ud_material_stream_ud: "X", container_type_id: 7, enabled: 1 },
      { container_id: 103, ud_material_stream_ud: "Y", container_type_id: 5, enabled: 1 },
      { container_id: 104, ud_material_stream_ud: "X", container_type_id: 5, enabled: 0 },
      { container_id: 105, ud_material_stream_ud: "Y", container_type_id: 5, enabled: 1 }
    ]);
  });

  it.each(["0", "9007199254740991"])("accepts the exact type boundary %s", async (value) => {
    await E.CUSTOMER_DB.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, container_type_id, enabled, synced_at) VALUES (117, 15, ?, 1, ?)").bind(Number(value), STAMP).run();
    expect(ids((await page({ equipmentTypeId: value, pickupAddressId: "15" })).body)).toEqual([15]);
  });

  it.each(["0", " X ", "é", "é", "😀".repeat(100), "Z".repeat(100)])("preserves opaque stream %s without trim, folding or Unicode normalization", async (value) => {
    await E.CUSTOMER_DB.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, ud_material_stream_ud, enabled, synced_at) VALUES (117, 15, ?, 1, ?)").bind(value, STAMP).run();
    expect(ids((await page({ equipmentMaterialStream: value, pickupAddressId: "15" })).body)).toEqual([15]);
    if (value === "é" || value === "é") {
      const other = value === "é" ? "é" : "é";
      expect(ids((await page({ equipmentMaterialStream: other, pickupAddressId: "15" })).body)).toEqual([]);
    }
  });
});

describe("equipment composition with selectors merged at the starting base", () => {
  it.each([
    [{ customerId: "201" }, [11, 14, 22]], [{ customerId: "202" }, [21]],
    [{ pickupAddressId: "12" }, []], [{ pickupAddressId: "11" }, [11]],
    [{ ids: "11,12,14,15,21" }, [11, 14, 21]],
    [{ zip: "02139" }, [11, 14, 21]], [{ city: "Other" }, [22]],
    [{ state: "ST" }, [11, 14, 21]], [{ streetAddress: "14 synthetic-needle Way" }, [14]],
    [{ q: "Other" }, [22]], [{ driverNote: "amber" }, [11, 14, 21]],
    [{ routeId: "7" }, [11, 14, 21]], [{ franchiseId: "002" }, [22]],
    [{ extrasAllowed: "false" }, [21]], [{ enabled: "false" }, [21]],
    [{ parentCustomerEnabled: "true" }, [11, 14, 22]], [{ parentCustomerEnabled: "false" }, [21]],
    [{ lastAuditDate: AUDIT }, [11, 14, 22]], [{ hasLastAuditDate: "false" }, [21]],
    [{ hasContainers: "true" }, MATCH], [{ hasContainers: "false" }, []],
    [{ lowerId: "14", upperId: "21" }, [14, 21]],
    [{ cursor: "14" }, [21, 22]], [{ order: "desc", cursor: "21" }, [14, 11]],
    [{ customerId: "201", city: "Other", routeId: "7" }, []],
    [{ customerId: "201", pickupAddressId: "11", ids: "11,12,14", city: "Riverton", state: "ST", zip: "02139", streetAddress: "11 synthetic-needle Way", q: "synthetic-needle", driverNote: "amber", routeId: "7", franchiseId: "001", extrasAllowed: "true", enabled: "true", parentCustomerEnabled: "true", hasContainers: "true", lastAuditDate: AUDIT, hasLastAuditDate: "true", lowerId: "11", upperId: "14", strictQuery: "true" }, [11]]
  ] as Array<[Query, number[]]>) ("AND-composes %j", async (filters, want) => {
    for (const includeTotal of ["true", "false"]) {
      const result = await page({ ...COHORT, ...filters, includeTotal });
      expect(ids(result.body)).toEqual(want);
      expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
    }
    const count = await page({ ...COHORT, ...filters, countOnly: "true" });
    expect(count.body).toEqual({ rows: [], total: want.length, nextCursor: null });
  });

  it("counts before offset/limit, skips COUNT in count-free mode and lets cursor win", async () => {
    const counted = await page({ ...COHORT, limit: "2", offset: "1" });
    const free = await page({ ...COHORT, limit: "2", offset: "1", includeTotal: "false" });
    expect(ids(counted.body)).toEqual([14, 21]);
    expect(counted.body.total).toBe(4);
    expect(free.body.rows).toEqual(counted.body.rows);
    expect(free.body.nextCursor).toBe(counted.body.nextCursor);
    expect((await page({ ...COHORT, countOnly: "true", limit: "1", offset: "999" })).body.total).toBe(4);
    expect(ids((await page({ ...COHORT, cursor: "14", offset: "999" })).body)).toEqual([21, 22]);
  });
});

describe("single correlated equipment EXISTS, shared predicates and local plan", () => {
  it.each([COHORT, { equipmentMaterialStream: "X" }, { equipmentTypeId: "5" }, { equipmentEnabled: "false" }] as Query[])("uses one child lookup for %j", async (query) => {
    const { recorder } = await page(query);
    for (const { sql, binds } of recorder.statements) {
      expect(sql.match(/\bEXISTS\s*\(/gi) ?? []).toHaveLength(1);
      expect(sql).toContain("container_snapshot");
      expect(sql).toMatch(/\b\w+\.pickup_address_id\s*=\s*\w+\.pickup_address_id/);
      expect(sql).not.toMatch(/\bJOIN\b|\bLIKE\b|\bGLOB\b|\bREGEXP\b|COLLATE\s+NOCASE/i);
      if ("equipmentMaterialStream" in query) {
        expect(sql).toMatch(/ud_material_stream_ud\s*=\s*\?/);
        expect(binds).toContain(query.equipmentMaterialStream);
      }
      if ("equipmentTypeId" in query) {
        expect(sql).toMatch(/container_type_id\s*=\s*\?/);
        expect(binds).toContain(Number(query.equipmentTypeId));
      }
      const plan = await E.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
      expect(plan.results.map((r) => r.detail).join("\n")).toContain("idx_container_snapshot_pickup_address_id");
    }
    const [count, select] = recorder.statements;
    const where = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).split(/\bORDER\s+BY\b/i)[0].trim();
    expect(where(select.sql)).toBe(where(count.sql));
    expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
  });
});

async function walk(filters: Query, want: number[], offset = 0) {
  let result = await page({ ...filters, ...(offset ? { offset } : {}) });
  const seen: unknown[] = [];
  const limit = Number(filters.limit);
  const windowed = want.slice(offset);
  const exact = filters.exactNext === "true";
  // Non-exact full terminal pages link to []; partial pages never do.
  const pages = Math.ceil(windowed.length / limit) + (!exact && windowed.length % limit === 0 ? 1 : 0);
  for (let index = 0; index < pages; index++) {
    const expected = windowed.slice(index * limit, (index + 1) * limit);
    expect(ids(result.body)).toEqual(expected);
    expect(result.body.total).toBe(filters.includeTotal === "false" ? null : (index === 0 ? want.length : windowed.length - index * limit));
    seen.push(...ids(result.body));
    if (index === pages - 1) {
      expect(result.body.nextCursor).toBeNull();
      expect(result.response.headers.get("link")).toBeNull();
      break;
    }
    expect(result.body.nextCursor).toBe(expected[expected.length - 1]);
    const link = result.response.headers.get("link");
    expect(link).toMatch(/^<\/api\/v1\/address-snapshot\?[^<>\s]*>; rel="next"$/);
    const target = new URL(/^<([^>]+)>/.exec(link!)![1], result.url);
    expect(target.origin).toBe(ORIGIN);
    const actual = Object.fromEntries(target.searchParams);
    const effective = Object.fromEntries(Object.entries(filters).map(([k, v]) => [k, String(v)]));
    if (effective.includeTotal !== "false") { delete actual.includeTotal; delete effective.includeTotal; }
    if (effective.order === "asc") { delete actual.order; delete effective.order; }
    if (effective.exactNext !== "true") { delete actual.exactNext; delete effective.exactNext; }
    if (effective.equipmentEnabled === "any") delete effective.equipmentEnabled;
    expect([...target.searchParams.keys()].length).toBe(new Set(target.searchParams.keys()).size);
    expect(actual).toEqual({ ...effective, cursor: String(result.body.nextCursor) });
    expect(target.searchParams.has("offset")).toBe(false);
    result = await page(target.search.slice(1)); // Follow supplied URL, never reconstruct filters.
  }
  expect(seen).toEqual(windowed);
  expect(new Set(seen).size).toBe(windowed.length);
}

describe("traversal oracle compatibility without equipment selectors", () => {
  it("proves full/partial terminal and offset arithmetic on the merged baseline", async () => {
    for (const order of ["asc", "desc"]) {
      const want = order === "asc" ? ALL : [...ALL].reverse();
      for (const exactNext of ["true", "false"]) {
        await walk({ order, exactNext, limit: "7", fields: "address" }, want);
        await walk({ order, exactNext, limit: "4", includeTotal: "false" }, want, 1);
      }
    }
  });
});

describe("equipment links fully followed in both directions", () => {
  for (const includeTotal of ["true", "false"]) {
    for (const order of ["asc", "desc"]) {
      for (const exactNext of ["true", "false"]) {
        it(`walks ${order}, includeTotal=${includeTotal}, exactNext=${exactNext}`, async () => {
          const filters = { ...COHORT, includeTotal, order, exactNext, strictQuery: "true", fields: "address", lowerId: "11", upperId: "22", limit: "2" };
          const want = order === "asc" ? MATCH : [22, 21, 14, 11];
          await walk(filters, want);
          await walk({ ...filters, limit: "2" }, want, 1); // Offset -> seek, partial terminal.
        });
      }
    }
  }
  it("retains every active merged site/parent selector alongside the cohort", async () => {
    await walk({ ...COHORT, customerId: "201", ids: "11,12,14,15", routeId: "7", franchiseId: "001", city: "Riverton", state: "ST", zip: "02139", q: "synthetic-needle", driverNote: "amber", extrasAllowed: "true", enabled: "true", parentCustomerEnabled: "true", hasContainers: "true", lastAuditDate: AUDIT, hasLastAuditDate: "true", strictQuery: "true", limit: "1" }, [11, 14]);
    await walk({ ...COHORT, pickupAddressId: "11", streetAddress: "11 synthetic-needle Way", limit: "1" }, [11]);
  });
  it("preserves false and opaque whitespace through continuations", async () => {
    await walk({ equipmentMaterialStream: "X", equipmentTypeId: "5", equipmentEnabled: "false", limit: "1", strictQuery: "true" }, [13, 24]);
    await walk({ equipmentMaterialStream: " X ", equipmentTypeId: "0", equipmentEnabled: "false", limit: "1" }, [20]);
  });
  it("canonically omits any while retaining the active stream and type", async () => {
    await walk({ equipmentMaterialStream: "X", equipmentTypeId: "5", equipmentEnabled: "any", limit: "3" }, [11, 13, 14, 21, 22, 23, 24]);
  });
});

describe("equipment sparse conditional representations", () => {
  it.each(["true", "false"])("hashes the sparse envelope and replays empty 304 (%s)", async (includeTotal) => {
    const query = { ...COHORT, fields: "address", limit: "2", includeTotal };
    const first = await page(query);
    expect(first.body.rows).toEqual([
      { pickup_address_id: 11, address: "11 synthetic-needle Way" },
      { pickup_address_id: 14, address: "14 synthetic-needle Way" }
    ]);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(first.bytes));
    const tag = `"${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
    expect(first.response.headers.get("etag")).toBe(tag);
    for (const validator of [tag, `W/${tag}`, "*"]) {
      const replay = await call(query, { headers: { "if-none-match": validator } });
      expect(replay.response.status).toBe(304);
      expect(replay.response.body).toBeNull();
      expect(await replay.response.text()).toBe("");
      for (const header of ["etag", "link", "cache-control", "x-request-id", "access-control-allow-origin"]) {
        expect(replay.response.headers.get(header)).toBe(first.response.headers.get(header));
      }
      expect(replay.recorder.statements).toEqual(first.recorder.statements);
    }
    await E.CUSTOMER_DB.prepare("UPDATE container_snapshot SET enabled = 0 WHERE container_id = 101").run();
    const changed = await page(query, { "if-none-match": tag });
    expect(ids(changed.body)).toEqual([14, 21]);
    expect(changed.response.headers.get("etag")).not.toBe(tag);
  });
});

const INVALID: Array<[string, string]> = [
  ...["", " ", "\t", "\n", "Z".repeat(101), "😀".repeat(101)].map((v): [string, string] => ["equipmentMaterialStream", v]),
  ...["", " ", " 5", "5 ", "05", "00", "-1", "+5", "5.0", "5e0", "0x5", "５", "٥", "9007199254740992", "9".repeat(201)].map((v): [string, string] => ["equipmentTypeId", v]),
  ...["", " ", "TRUE", "False", "ANY", "1", "0", "yes", "true ", " true", "true,false", "null", "secret-equipment-marker", "x".repeat(201)].map((v): [string, string] => ["equipmentEnabled", v])
];
async function rejected(search: string, status = 400, token?: string | null) {
  const result = await call(search, { token, headers: { "if-none-match": "*" } });
  expect(result.response.status).toBe(status);
  expect(result.recorder.prepared).toEqual([]);
  expect(result.recorder.statements).toEqual([]);
  expect(result.response.headers.get("content-type")).toContain("application/problem+json");
  expect(result.response.headers.get("link")).toBeNull();
  expect(result.response.headers.get("etag")).toBeNull();
  expect(result.response.headers.get("x-request-id")).toBe("Equipment-oracle");
  const body = await result.response.json() as { detail: string };
  if (status === 400) {
    expect(body).toMatchObject({ type: problemType("bad-request"), title: "Bad Request", status: 400 });
    expect(body.detail).toMatch(/docs\/PROBLEMS\.md#bad-request|next.action|use|remove|supply|provide/i);
  }
  expect(JSON.stringify(body)).not.toContain("secret-equipment-marker");
  return body;
}

describe("equipment validation before SQL and 304, after auth", () => {
  it.each(INVALID)("rejects malformed %s=%j with fixed value-free guidance", async (name, value) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const body = await rejected(qs({ [name]: value }));
    const sameClass = await rejected(qs({ [name]: "" }));
    expect(body).toEqual(sameClass); // Stable guidance, not an exact generic prose pin.
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it.each(KEYS)("rejects bare and repeated %s, including encoded duplicate names", async (name) => {
    const value = name === "equipmentEnabled" ? "any" : name === "equipmentTypeId" ? "5" : "X";
    const encodedName = name.replace("equipment", "%65quipment");
    for (const search of [name, `${name}=${value}&${name}=${value}`, `${name}=&${name}=${value}`, `${name}=${value}&${encodedName}=${value}`]) {
      await rejected(search);
    }
  });
  it.each(KEYS)("auth wins over valid, malformed and repeated %s", async (name) => {
    const valid = name === "equipmentEnabled" ? "true" : name === "equipmentTypeId" ? "5" : "X";
    for (const token of [null, "synthetic-invalid-token"]) {
      for (const value of [valid, "", "secret-equipment-marker"]) await rejected(qs({ [name]: value }), 401, token);
      await rejected(`${name}=${valid}&${name}=${valid}`, 401, token);
    }
  });
  it("allows all existing bearer roles", async () => {
    for (const token of ["test-read-token", "test-api-token", "test-sync-secret"]) {
      const result = await call(COHORT, { token });
      expect(result.response.status).toBe(200);
      expect(ids(await result.response.json() as Body)).toEqual(MATCH);
    }
  });
  it("strictQuery accepts equipment keys but not unrelated/sibling keys", async () => {
    expect(ids((await page({ ...COHORT, strictQuery: "true" })).body)).toEqual(MATCH);
    await rejected(`${qs(COHORT)}&strictQuery=true&containerTypeId=5`);
    const clean = await page(COHORT);
    const ignored = await page(`${qs(COHORT)}&bogus_param=secret-equipment-marker`);
    expect(ignored.bytes).toBe(clean.bytes);
    expect(ignored.recorder.statements).toEqual(clean.recorder.statements);
  });
  it("keeps countOnly conflict/invalid field/window checks before SQL", async () => {
    for (const extra of ["countOnly=true&includeTotal=false", "fields=nope", "limit=501", "lowerId=-1"]) {
      await rejected(`${qs(COHORT)}&${extra}`);
    }
  });
});

type Param = { name: string; in: string; required?: boolean; description?: string; example?: unknown; schema?: Record<string, unknown> };
type Operation = { operationId?: string; description?: string; parameters?: Param[]; responses?: Record<string, { description?: string }>; "x-access"?: string; "x-effect"?: string };
async function operations() {
  const response = await exports.default.fetch(`${ORIGIN}/openapi.json`);
  expect(response.status).toBe(200);
  return (await response.json() as { paths: Record<string, { get?: Operation }> }).paths;
}
function independence(prose: string) {
  expect(prose).toMatch(/same[- ]container|same (?:stored )?(?:child|container)|one (?:stored )?(?:child|container)/i);
  expect(prose).toContain("hasContainers");
  expect(prose).toContain("hasEnabledContainers");
  expect(prose).toMatch(/independent/i);
  expect(prose).toMatch(/different (?:stored )?(?:child|container)/i);
  expect(prose).toMatch(/mirror|stored/i);
  for (const term of ["live inventory", "material acceptance", "service eligibility", "recycling[- ]outcome"]) {
    expect(prose).toMatch(new RegExp(`not[^.]{0,250}${term}`, "i"));
  }
}

describe("equipment mounted discovery and consumer guidance", () => {
  it("advertises optional exact scopes only on the ordinary address GET", async () => {
    const paths = await operations();
    const op = paths[PATH].get!;
    expect(op).toMatchObject({ operationId: "listAddressSnapshot", "x-access": "read", "x-effect": "local-read" });
    const params = KEYS.map((name) => op.parameters?.find((p) => p.in === "query" && p.name === name));
    for (let i = 0; i < KEYS.length; i++) {
      expect(params[i], KEYS[i]).toBeDefined();
      expect(params[i]!.required).toBe(false);
      expect(params[i]!.example ?? params[i]!.schema?.example).toBeDefined();
      expect(op.responses?.["400"]?.description).toContain(KEYS[i]);
    }
    expect(params[0]!.schema).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
    expect(params[1]!.schema).toMatchObject({ type: "integer", minimum: 0, maximum: 9007199254740991 });
    expect(params[2]!.schema).toMatchObject({ type: "string", enum: ["true", "false", "any"], default: "any" });
    independence([op.description, ...params.map((p) => p!.description ?? p!.schema?.description)].join(" "));
    for (const [path, methods] of Object.entries(paths)) {
      if (path === PATH) continue;
      const names = methods.get?.parameters?.filter((p) => p.in === "query").map((p) => p.name) ?? [];
      for (const key of KEYS) expect(names, path).not.toContain(key);
    }
  });
  it("leaves equipment names unknown on sibling lists and by-id responses", async () => {
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/container-snapshot", `${PATH}/11`]) {
      const ordinary = await call({}, { path });
      const tainted = await call(COHORT, { path });
      expect(tainted.response.status).toBe(200);
      expect(await tainted.response.text()).toBe(await ordinary.response.text());
      expect(tainted.recorder.statements).toEqual(ordinary.recorder.statements);
    }
  });
  it("inventories address-only keys and explains same-child/any-child independence", () => {
    const row = (path: string) => policy.split("\n").find((line) => line.startsWith(`| \`${path}\` |`)) ?? "";
    for (const key of KEYS) {
      expect(row(PATH)).toContain(`\`${key}\``);
      for (const path of ["/api/v1/customer-snapshot", "/api/v1/container-snapshot"]) expect(row(path)).not.toContain(key);
    }
    independence(policy);
    expect(policy).toContain("test/addressEquipmentCohort.acceptance.test.ts");
  });
  it("provides a local credential-free cohort recipe with continuation guidance and changelog", () => {
    const blocks = [...quickstart.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((m) => m[1]);
    const recipe = blocks.find((b) => b.includes(PATH) && KEYS.every((k) => b.includes(`${k}=`)));
    expect(recipe).toBeDefined();
    expect(recipe).toContain("localhost:8787");
    expect(recipe).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
    expect(recipe).toMatch(/cursor|[Ll]ink|rel=.next/);
    for (const key of KEYS) expect(changelog.split(/^## /m)[1]).toContain(key);
  });
});
