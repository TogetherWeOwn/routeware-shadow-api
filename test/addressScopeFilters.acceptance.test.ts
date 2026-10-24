import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

const TEST_ENV = env as unknown as Env;
const origin = "https://address-scope.test.invalid";
const path = "/api/v1/address-snapshot";
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };

// Public-contract fixtures: route 0 is a real scope, franchises are opaque,
// and duplicate scope pairs must remain separate address rows.
const opaqueFranchise = " 雪'\"%_ /+?&#🚛 ";
const hundredCodePoints = "🚛".repeat(100);
const syncedAt = "2026-01-02T03:04:05.000Z";
const addresses = [
  { id: 10, customer: 1, route: 0, franchise: "001", address: "Zero Street", enabled: 1 },
  { id: 20, customer: 1, route: 7, franchise: "001", address: "Cedar One", enabled: 1 },
  { id: 30, customer: 1, route: 7, franchise: "001", address: "Cedar Disabled", enabled: 0 },
  { id: 40, customer: 1, route: 7, franchise: "1", address: "Numeric Street", enabled: 1 },
  { id: 50, customer: 1, route: 8, franchise: "001", address: "Other Route", enabled: 1 },
  { id: 60, customer: 1, route: 7, franchise: "Acme", address: "Upper Street", enabled: 1 },
  { id: 70, customer: 1, route: 7, franchise: "acme", address: "Lower Street", enabled: 1 },
  { id: 80, customer: 1, route: null, franchise: null, address: "No Scope", enabled: 1 },
  { id: 90, customer: 1, route: 0, franchise: null, address: "Zero Null", enabled: 1 },
  { id: 100, customer: 1, route: null, franchise: "001", address: "Null Route", enabled: 1 },
  { id: 110, customer: 1, route: 7, franchise: opaqueFranchise, address: "Opaque One", enabled: 1 },
  { id: 120, customer: 1, route: 7, franchise: "001", address: "Cedar Two", enabled: 1 },
  { id: 130, customer: 2, route: 7, franchise: "001", address: "Cedar Three", enabled: 1 },
  { id: 140, customer: 1, route: Number.MAX_SAFE_INTEGER, franchise: hundredCodePoints, address: "Boundary Street", enabled: 1 },
  { id: 150, customer: 1, route: 7, franchise: opaqueFranchise, address: "Opaque Two", enabled: 1 },
] as const;

const scopeCases: Array<{ name: string; query: string; ids: number[] }> = [
  { name: "omitted scopes retain the existing list", query: "", ids: [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150] },
  { name: "route zero is literal, not an all-routes sentinel", query: "routeId=0", ids: [10, 90] },
  { name: "route equality keeps every matching address", query: "routeId=7", ids: [20, 30, 40, 60, 70, 110, 120, 130, 150] },
  { name: "maximum safe route ID", query: "routeId=9007199254740991", ids: [140] },
  { name: "franchise preserves leading zeros", query: "franchiseId=001", ids: [10, 20, 30, 50, 100, 120, 130] },
  { name: "numeric-looking franchise is not coerced", query: "franchiseId=1", ids: [40] },
  { name: "uppercase franchise is exact", query: "franchiseId=Acme", ids: [60] },
  { name: "lowercase franchise is exact", query: "franchiseId=acme", ids: [70] },
  { name: "opaque franchise preserves whitespace and punctuation", query: `franchiseId=${encodeURIComponent(opaqueFranchise)}`, ids: [110, 150] },
  { name: "100 astral code points are allowed", query: `franchiseId=${encodeURIComponent(hundredCodePoints)}`, ids: [140] },
  { name: "both scopes intersect by AND", query: "routeId=7&franchiseId=001", ids: [20, 30, 120, 130] },
  { name: "zero and franchise intersect", query: "routeId=0&franchiseId=001", ids: [10] },
  { name: "disjoint scopes return an empty success", query: "routeId=8&franchiseId=acme", ids: [] },
  { name: "unknown route returns an empty success", query: "routeId=99", ids: [] },
  { name: "unknown franchise returns an empty success", query: "franchiseId=missing", ids: [] },
  { name: "SQL-looking franchise remains an opaque value", query: `franchiseId=${encodeURIComponent("' OR 1=1 --")}`, ids: [] },
  { name: "percent and underscore are not wildcard filters", query: "franchiseId=%25_", ids: [] },
  { name: "customer selector intersects", query: "routeId=7&franchiseId=001&customerId=2", ids: [130] },
  { name: "pickup address selector intersects", query: "routeId=7&franchiseId=001&pickupAddressId=120", ids: [120] },
  { name: "pickup address cannot escape scope", query: "routeId=0&pickupAddressId=20", ids: [] },
  { name: "text selector intersects", query: "routeId=7&franchiseId=001&q=Two", ids: [120] },
  { name: "enabled true intersects", query: "routeId=7&franchiseId=001&enabled=true", ids: [20, 120, 130] },
  { name: "enabled false intersects", query: "routeId=7&franchiseId=001&enabled=false", ids: [30] },
  { name: "all existing selectors intersect with both scopes", query: "routeId=7&franchiseId=001&customerId=1&pickupAddressId=120&q=Cedar&enabled=true", ids: [120] },
  { name: "unrelated unknown keys keep list-ignore behavior", query: "routeId=7&franchiseId=001&unrelated=ignored", ids: [20, 30, 120, 130] },
];

const invalidScopes = [
  ["empty route", "routeId="],
  ["negative route", "routeId=-1"],
  ["negative zero", "routeId=-0"],
  ["encoded duplicate route key", "routeId=7&route%49d=7"],
  ["encoded duplicate franchise key", "franchiseId=001&franchise%49d=001"],
  ["explicit plus", "routeId=%2B7"],
  ["padded route", "routeId=07"],
  ["padded zero", "routeId=00"],
  ["decimal route", "routeId=7.0"],
  ["fractional route", "routeId=7.5"],
  ["exponent route", "routeId=7e0"],
  ["hex route", "routeId=0x7"],
  ["leading space", "routeId=%207"],
  ["trailing space", "routeId=7%20"],
  ["newline route", "routeId=7%0A"],
  ["non-ASCII digit", "routeId=%EF%BC%97"],
  ["Arabic digit", "routeId=%D9%A7"],
  ["unsafe integer", "routeId=9007199254740992"],
  ["long integer", `routeId=${"9".repeat(100)}`],
  ["not a number", "routeId=NaN"],
  ["infinity", "routeId=Infinity"],
  ["comma-separated routes", "routeId=7,8"],
  ["same route repeated", "routeId=7&routeId=7"],
  ["different routes repeated", "routeId=7&routeId=8"],
  ["empty route repeated", "routeId=7&routeId="],
  ["empty franchise", "franchiseId="],
  ["blank franchise", "franchiseId=%20%20"],
  ["tab/newline franchise", "franchiseId=%09%0A"],
  ["Unicode blank franchise", `franchiseId=${encodeURIComponent(" 　")}`],
  ["101 ASCII code points", `franchiseId=${"f".repeat(101)}`],
  ["101 astral code points", `franchiseId=${encodeURIComponent("🚛".repeat(101))}`],
  ["same franchise repeated", "franchiseId=001&franchiseId=001"],
  ["different franchises repeated", "franchiseId=001&franchiseId=1"],
  ["empty franchise repeated", "franchiseId=001&franchiseId="],
] as const;

// Only the external boundary is doubled: actual local D1 evaluates the SQL.
// Record prepare as well as execution, so rejected queries cannot touch D1.
function readOnlyDb() {
  const prepared: string[] = [];
  const executed: Statement[] = [];
  const forbid = vi.fn(() => { throw new Error("Address reads must not write/batch/exec D1"); });
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    const record = () => {
      expect(sql.trim()).toMatch(/^SELECT\b/i);
      executed.push({ sql, binds });
    };
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
      expect(sql.trim()).toMatch(/^SELECT\b/i);
      return wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []);
    },
    batch: forbid,
    exec: forbid,
  } as unknown as D1Database;
  return { db, prepared, executed, forbid };
}

let requestNumber = 0;
async function request(query: string | URL = "", token: string | null = "test-read-token") {
  const recorder = readOnlyDb();
  const url = query instanceof URL ? query : new URL(`${path}${query ? `?${query}` : ""}`, origin);
  const headers = new Headers({ "cf-connecting-ip": `192.0.2.${++requestNumber}` });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV,
    CUSTOMER_DB: recorder.db,
    SNAPSHOTS: {
      get: recorder.forbid, head: recorder.forbid, list: recorder.forbid,
      put: recorder.forbid, delete: recorder.forbid,
    } as unknown as R2Bucket,
    BROWSER: { fetch: recorder.forbid } as unknown as Fetcher,
  });
  return { response, recorder, url };
}

async function page(query: string | URL = "") {
  const result = await request(query);
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  const body = await result.response.json() as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const counted = result.url.searchParams.get("includeTotal") !== "false";
  expect(result.recorder.executed).toHaveLength(counted ? 2 : 1);
  expect(result.recorder.executed.filter(s => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(counted ? 1 : 0);
  expect(result.recorder.forbid).not.toHaveBeenCalled();
  if (!counted) expect(body.total).toBeNull();
  return { ...result, body };
}

const rowIds = (body: Body) => body.rows.map(row => row.pickup_address_id);
function next(result: Awaited<ReturnType<typeof page>>) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/address-snapshot\?[^<>\s]*>; rel="next"$/);
  const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(target.origin).toBe(origin);
  expect(target.pathname).toBe(path);
  expect(target.hash).toBe("");
  expect(target.searchParams.has("offset")).toBe(false);
  expect(target.searchParams.get("cursor")).toBe(String(result.body.nextCursor));
  for (const [key, value] of result.url.searchParams) {
    if (key === "includeTotal" && value === "true") {
      // Default-true may be omitted; false and all scope/filter values stay exact.
      expect([[], ["true"]]).toContainEqual(target.searchParams.getAll(key));
    } else if (key !== "offset" && key !== "cursor") expect(target.searchParams.getAll(key)).toEqual([value]);
  }
  return target;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  requestNumber = 0;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound network in address scope acceptance"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, synced_at) VALUES (1, 'Synthetic One', ?), (2, 'Synthetic Two', ?)")
      .bind(syncedAt, syncedAt),
  ]);
  await db.batch(addresses.map(row => db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, address, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(row.id, row.customer, row.route, row.franchise, row.address, row.enabled, syncedAt)));
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("address scope: exact read selectors", () => {
  it.each(scopeCases)("$name", async ({ query, ids }) => {
    const result = await page(query);
    expect(rowIds(result.body)).toEqual(ids);
    expect(result.body.total).toBe(ids.length);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  });

  it.each([
    ["franchise with padding is distinct", "franchiseId=%20Acme%20"],
    ["nonblank embedded whitespace is valid", "franchiseId=x%09%0Ay"],
    ["100 ASCII code points are valid", `franchiseId=${"f".repeat(100)}`],
  ])("%s", async (_name, query) => {
    const result = await page(query);
    expect(result.body).toEqual({ rows: [], total: 0, nextCursor: null });
  });

  it("keeps the full stored row shape and literal scope values by default", async () => {
    const { body } = await page("routeId=0&franchiseId=001");
    expect(body.rows).toEqual([{
      pickup_address_id: 10, customer_id: 1, route_id: 0, franchise_id: "001",
      address: "Zero Street", city: null, state: null, zip: null, comments: null,
      extras_allowed: 1, enabled: 1, driver_note: null, latitude: null, longitude: null,
      last_audit_date: null, synced_at: syncedAt,
    }]);
  });

  it("applies scopes before sparse projection and always retains the address ID", async () => {
    const result = await page("routeId=7&franchiseId=001&fields=enabled&limit=10");
    expect(result.body.rows).toEqual([
      { pickup_address_id: 20, enabled: 1 }, { pickup_address_id: 30, enabled: 0 },
      { pickup_address_id: 120, enabled: 1 }, { pickup_address_id: 130, enabled: 1 },
    ]);
    expect(result.body.total).toBe(4);
  });

  it("is idempotent and leaves all stored rows unchanged", async () => {
    const db = TEST_ENV.CUSTOMER_DB;
    const before = await db.prepare("SELECT * FROM address_snapshot ORDER BY pickup_address_id").all();
    const first = await page("routeId=7&franchiseId=001");
    const second = await page("routeId=7&franchiseId=001");
    expect(first.body).toEqual(second.body);
    expect(rowIds(first.body)).toEqual([20, 30, 120, 130]);
    const after = await db.prepare("SELECT * FROM address_snapshot ORDER BY pickup_address_id").all();
    expect(after.results).toEqual(before.results);
  });

  it("binds both equality predicates on every SELECT and admits a local EXPLAIN without claiming an index", async () => {
    const result = await page(`routeId=7&franchiseId=${encodeURIComponent(opaqueFranchise)}&limit=1`);
    expect(result.recorder.executed).toHaveLength(2);
    for (const statement of result.recorder.executed) {
      const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.binds).all();
      expect(plan.results.length).toBeGreaterThan(0);
      expect(plan.results.every(row => typeof row.detail === "string")).toBe(true);
      const sql = statement.sql.replace(/["`\[\]]/g, "");
      // Failure evidence contains only local plan rows and value-free SQL.
      expect(sql, `Local EXPLAIN: ${JSON.stringify(plan.results)}`).toMatch(/(?:\broute_id\s*=\s*\?\d*|\?\d*\s*=\s*(?:\w+\.)?route_id\b)/i);
      expect(sql).toMatch(/(?:\bfranchise_id\s*=\s*\?\d*|\?\d*\s*=\s*(?:\w+\.)?franchise_id\b)/i);
      expect(sql).toMatch(/\bAND\b/i);
      expect(statement.binds.map(String)).toContain("7");
      expect(statement.binds).toContain(opaqueFranchise);
      expect(statement.sql).not.toContain(opaqueFranchise);
    }
    expect(rowIds(result.body)).toEqual([110]);
    expect(result.body.total).toBe(2);
  });
});

describe("address scope: pagination compatibility", () => {
  it.each(["true", "false"])("follows scoped offset and seek pages, includeTotal=%s", async includeTotal => {
    const filters = `routeId=7&franchiseId=001&fields=enabled&limit=2&includeTotal=${includeTotal}`;
    const first = await page(`${filters}&offset=1`);
    expect(first.body.rows).toEqual([{ pickup_address_id: 30, enabled: 0 }, { pickup_address_id: 120, enabled: 1 }]);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 4);
    expect(first.body.nextCursor).toBe(120);
    const last = await page(next(first));
    expect(last.body.rows).toEqual([{ pickup_address_id: 130, enabled: 1 }]);
    expect(last.body.total).toBe(includeTotal === "false" ? null : 1);
    expect(last.body.nextCursor).toBeNull();
    expect(last.response.headers.get("link")).toBeNull();
  });

  it("keeps seek precedence and cursor-relative scoped totals", async () => {
    const result = await page("routeId=7&franchiseId=001&cursor=20&offset=99&limit=2");
    expect(rowIds(result.body)).toEqual([30, 120]);
    expect(result.body.total).toBe(3);
    expect(result.body.nextCursor).toBe(120);
    const last = await page(next(result));
    expect(rowIds(last.body)).toEqual([130]);
    expect(last.body.total).toBe(1);
  });

  it("does not skip duplicate scope pairs or invent count-free lookahead", async () => {
    const first = await page("routeId=7&franchiseId=001&includeTotal=false&limit=2");
    expect(rowIds(first.body)).toEqual([20, 30]);
    const second = await page(next(first));
    expect(rowIds(second.body)).toEqual([120, 130]);
    expect(second.body.nextCursor).toBe(130);
    const terminal = await page(next(second));
    expect(terminal.body).toEqual({ rows: [], total: null, nextCursor: null });
    expect(terminal.response.headers.get("link")).toBeNull();
  });

  it("follows the exact URL-encoded opaque scope with all existing selectors", async () => {
    const query = new URLSearchParams({
      routeId: "7", franchiseId: opaqueFranchise, customerId: "1", q: "Opaque", enabled: "true",
      fields: "route_id,franchise_id", includeTotal: "false", limit: "1", offset: "0",
    });
    const first = await page(query.toString());
    expect(first.body.rows).toEqual([{ pickup_address_id: 110, route_id: 7, franchise_id: opaqueFranchise }]);
    const target = next(first);
    expect(target.searchParams.get("franchiseId")).toBe(opaqueFranchise);
    expect(first.response.headers.get("link")).not.toContain(opaqueFranchise);
    const last = await page(target);
    expect(last.body.rows).toEqual([{ pickup_address_id: 150, route_id: 7, franchise_id: opaqueFranchise }]);
    const empty = await page(next(last));
    expect(empty.body.rows).toEqual([]);
  });

  it("retains the list upper cap before D1 even when scoped", async () => {
    const result = await request("routeId=7&franchiseId=001&limit=501");
    expect(result.response.status).toBe(400);
    expect(result.recorder.prepared).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
  });
});

describe("address scope: validation and read authority", () => {
  it.each(invalidScopes)("rejects %s before D1 with stable value-free recovery", async (_name, query) => {
    const key = query.startsWith("routeId") ? "routeId" : "franchiseId";
    const result = await request(query);
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    expect(result.response.headers.get("link")).toBeNull();
    const problem = await result.response.json() as Record<string, unknown>;
    expect(problem).toMatchObject({
      title: "Bad Request", status: 400,
      detail: `Invalid request query (${key}). See docs/PROBLEMS.md#bad-request.`,
    });
    expect(String(problem.type)).toMatch(/#bad-request$/);
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.executed).toEqual([]);
    expect(result.recorder.forbid).not.toHaveBeenCalled();
  });

  it.each([null, "invalid-read-token"])(
    "preserves authentication precedence for unauthorized requests: %s", async token => {
      const result = await request("routeId=not-an-id&franchiseId=", token);
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get("content-type")).toContain("application/problem+json");
      expect(result.response.headers.get("link")).toBeNull();
      expect(await result.response.json()).toMatchObject({ title: "Unauthorized", status: 401 });
      expect(result.recorder.prepared).toEqual([]);
    }
  );

  it.each(["test-api-token", "test-sync-secret"])("retains existing authorized read access for %s", async token => {
    const result = await request("routeId=7&franchiseId=001", token);
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    expect(rowIds(await result.response.json() as Body)).toEqual([20, 30, 120, 130]);
  });

  it("does not echo submitted opaque values in validation errors or logs", async () => {
    const logs = ["log", "info", "warn", "error", "debug"].map(method =>
      vi.spyOn(console, method as "log").mockImplementation(() => undefined));
    const valid = await request(`routeId=7&franchiseId=${encodeURIComponent(opaqueFranchise)}`);
    expect(valid.response.status).toBe(200);
    expect(JSON.stringify(logs.flatMap(log => log.mock.calls))).not.toContain(opaqueFranchise);
    const marker = `synthetic-private-franchise-${"x".repeat(101)}`;
    const result = await request(`franchiseId=${encodeURIComponent(marker)}`);
    expect(result.response.status).toBe(400);
    expect(await result.response.text()).not.toContain(marker);
    expect(JSON.stringify(logs.flatMap(log => log.mock.calls))).not.toContain(marker);
    expect(result.recorder.prepared).toEqual([]);
  });
});

type Parameter = { name: string; in: string; required?: boolean; description?: string; schema: Record<string, unknown> };
type Operation = {
  operationId: string; description: string; parameters: Parameter[];
  responses: Record<string, { description: string }>;
};

describe("address scope: machine-readable discovery", () => {
  it("preserves existing filter and recovery discoverability outside the legacy golden", async () => {
    const response = await exports.default.fetch(`${origin}/openapi.json`);
    expect(response.status).toBe(200);
    const document = await response.json() as { paths: Record<string, { get: Operation }> };
    const operation = document.paths[path].get;
    expect(operation.operationId).toBe("listAddressSnapshot");
    for (const name of ["customerId", "pickupAddressId", "q", "enabled", "cursor", "offset"]) {
      expect(operation.description).toContain(name);
      expect(operation.parameters.some(parameter => parameter.in === "query" && parameter.name === name)).toBe(true);
    }
    const recovery = operation.responses["400"].description;
    for (const name of ["q", "limit", "offset", "enabled", "fields"]) expect(recovery).toContain(name);
    expect(recovery).toMatch(/application\/problem\+json/);
    expect(recovery).toMatch(/before.*D1/i);
  });

  it("publishes bounds, fixed correction guidance and the existing stable operation", async () => {
    const response = await exports.default.fetch(`${origin}/openapi.json`);
    expect(response.status).toBe(200);
    const document = await response.json() as { paths: Record<string, { get: Operation }> };
    const operation = document.paths[path].get;
    expect(operation.operationId).toBe("listAddressSnapshot");
    const route = operation.parameters.filter(p => p.in === "query" && p.name === "routeId");
    const franchise = operation.parameters.filter(p => p.in === "query" && p.name === "franchiseId");
    expect(route).toHaveLength(1);
    expect(franchise).toHaveLength(1);
    expect(route[0].required ?? false).toBe(false);
    expect(franchise[0].required ?? false).toBe(false);
    expect(route[0].schema).toMatchObject({ type: "integer", minimum: 0, maximum: 9007199254740991 });
    expect(franchise[0].schema).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
    const routeGuidance = `${route[0].description ?? ""} ${JSON.stringify(route[0].schema)}`;
    expect(routeGuidance).toMatch(/ASCII|decimal/i);
    expect(routeGuidance).toMatch(/unpadded|canonical|leading zero/i);
    expect(franchise[0].description).toMatch(/case.sensitive/i);
    expect(franchise[0].description).toMatch(/code points/i);
    expect(franchise[0].description).toMatch(/opaque|exact/i);
    expect(operation.description).toMatch(/routeId/);
    expect(operation.description).toMatch(/franchiseId/);
    expect(operation.description).toMatch(/\bAND\b|intersect/i);
    expect(operation.responses["400"].description).toMatch(/routeId/);
    expect(operation.responses["400"].description).toMatch(/franchiseId/);
    expect(operation.responses["400"].description).toMatch(/docs\/PROBLEMS\.md#bad-request/);
  });
});
