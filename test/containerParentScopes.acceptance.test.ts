import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent Test-Author oracle; all expected IDs/pages are hand-derived.
 * Mutation targets: selecting equipment route_ids instead of parent route_id;
 * coercing opaque franchises; conflating parent/container/customer enabled;
 * unconditional, absent or duplicate joins; OR leakage; COUNT/page drift;
 * lost next-link scopes, unsafe reflection, stale sparse ETags and auth bypass.
 * Real local D1 evaluates product SQL. Only fixture setup may write. Requests
 * deny D1 writes/batch/exec, R2, browser and fetch; no production/staging probes.
 * Builder: incorporate this test commit unchanged; oracle corrections stay
 * Test-Author-owned. Expected RED until the paired implementation arrives.
 * Run: npx vitest run test/containerParentScopes.acceptance.test.ts --maxWorkers=2
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/container-snapshot";
const ORIGIN = "https://container-parent.test.invalid";
const STAMP = "2026-01-02T03:04:05.000Z";
const OPAQUE = " 雪'\"%_ /+?&#🚛 ";
const HUNDRED = "🚛".repeat(100);
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
type Query = Record<string, string> | string | URL;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
// Parent: id, customer, scalar route, opaque franchise, parent enabled.
const PARENTS = [
  [11, 1, 0, "001", 1], [12, 1, 7, "001", 1], [13, 1, 7, "001", 0],
  [14, 2, 7, "001", 1], [15, 1, 8, "1", 1], [16, 1, 7, "Acme", 1],
  [17, 1, 7, "acme", 1], [18, 1, null, null, 1], [19, 1, 0, null, 0],
  [20, 1, null, "001", 1], [21, 1, Number.MAX_SAFE_INTEGER, HUNDRED, 1],
  [22, 1, 7, OPAQUE, 1], [23, 1, 7, OPAQUE, 1], [24, 1, 7, " Acme ", 1],
  [25, 1, 7, "x\t\ny", 1], [26, 1, 7, "a".repeat(100), 1], [27, 3, 7, "001", 1],
] as const;
// Container: id, parent, equipment enabled. Siblings/cohorts must never dedupe.
const CONTAINERS = [
  [10, 11, 1], [20, 12, 1], [30, 12, 0], [40, 13, 1], [50, 13, 0],
  [60, 14, 1], [70, 15, 1], [80, 16, 1], [90, 17, 1], [100, 18, 1],
  [110, 19, 1], [120, 20, 1], [130, 21, 1], [140, 22, 1], [150, 23, 1],
  [160, 12, 1], [170, 12, 1], [180, 24, 1], [190, 25, 1], [200, 26, 1], [210, 27, 1],
] as const;
const ALL = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210];
const ids = (body: Body) => body.rows.map(row => row.container_id);
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
let denied: string[];
let beforeState: unknown;

function recordedDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const forbid = (operation: string): never => {
    denied.push(operation);
    throw new Error("Unexpected effect in container parent oracle");
  };
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql, values),
      first: (...args: unknown[]) => {
        statements.push({ sql, binds });
        return (stmt.first as (...args: unknown[]) => unknown)(...args);
      },
      all: () => { statements.push({ sql, binds }); return stmt.all(); },
      raw: (...args: unknown[]) => {
        statements.push({ sql, binds });
        return (stmt.raw as (...args: unknown[]) => unknown)(...args);
      },
      run: () => forbid("D1 run"),
    } as unknown as D1PreparedStatement;
  }
  const db = {
    prepare: (sql: string) => {
      prepared.push(sql);
      if (!/^\s*SELECT\b/i.test(sql)) return forbid("D1 non-SELECT");
      return wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []);
    },
    batch: () => forbid("D1 batch"), exec: () => forbid("D1 exec"), dump: () => forbid("D1 dump"),
  } as unknown as D1Database;
  return { db, prepared, statements, external: () => forbid("external binding") };
}
async function state() {
  return Promise.all(["customer_snapshot", "address_snapshot", "container_snapshot"].map(table =>
    TEST_ENV.CUSTOMER_DB.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())).then(rows => rows.map(r => r.results));
}
async function request(query: Query = {}, options: { token?: string | null; headers?: Record<string, string> } = {}) {
  const recorder = recordedDb();
  const url = query instanceof URL ? query : new URL(PATH, ORIGIN);
  if (!(query instanceof URL)) url.search = typeof query === "string" ? query : new URLSearchParams(query).toString();
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Parent-oracle", ...options.headers });
  const token = options.token === undefined ? "test-read-token" : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: recorder.db,
    SNAPSHOTS: Object.fromEntries(["get", "head", "list", "put", "delete", "createMultipartUpload", "resumeMultipartUpload"].map(key => [key, recorder.external])) as unknown as R2Bucket,
    BROWSER: { fetch: recorder.external } as unknown as Fetcher,
  });
  return { response, recorder, url };
}
function posture(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("vary")).toMatch(/\borigin\b/i);
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  expect(response.headers.get("x-request-id")).toBe("Parent-oracle");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
function budget(result: Awaited<ReturnType<typeof request>>) {
  const countFree = result.url.searchParams.get("includeTotal") === "false";
  const statements = result.recorder.statements;
  expect(statements).toHaveLength(countFree ? 1 : 2);
  expect(statements.filter(isCount)).toHaveLength(countFree ? 0 : 1);
  const select = statements.find(s => !isCount(s))!;
  const tail = /\bOFFSET\b/i.test(select.sql) ? 2 : 1;
  expect(select.binds[select.binds.length - tail]).toBe(Number(result.url.searchParams.get("limit") ?? 50));
  if (!countFree) expect(select.binds.slice(0, -tail)).toEqual(statements.find(isCount)!.binds);
  const q = result.url.searchParams;
  const joined = q.has("customerId") || q.has("parentRouteId") || q.has("parentFranchiseId") || ["true", "false"].includes(q.get("parentEnabled") ?? "");
  for (const s of statements) {
    expect(s.sql.match(/\bJOIN\b/gi) ?? []).toHaveLength(joined ? 1 : 0);
    if (joined) expect(s.sql).toMatch(/\bJOIN\s+address_snapshot\b/i);
  }
}
async function page(query: Query = {}, headers?: Record<string, string>) {
  const result = await request(query, { headers });
  expect(result.response.status).toBe(200);
  posture(result.response);
  budget(result);
  const bytes = await result.response.text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  if (result.url.searchParams.get("includeTotal") === "false") expect(body.total).toBeNull();
  return { ...result, body, bytes };
}
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
    if (["offset", "cursor", "unknown", "redirect"].includes(key)) continue;
    const value = key === "q" ? raw.trim() : raw;
    if (["parentEnabled", "enabled"].includes(key) && value === "any") expect(url.searchParams.has(key)).toBe(false);
    else if ((key === "order" && value === "asc") || (key === "includeTotal" && value === "true")) {
      expect([[], [value]]).toContainEqual(url.searchParams.getAll(key));
    } else expect(url.searchParams.getAll(key), key).toEqual([value]);
  }
  expect(url.searchParams.has("unknown")).toBe(false);
  expect(url.searchParams.has("redirect")).toBe(false);
  expect(link).not.toContain(result.url.origin);
  return url;
}
async function hash(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}"`;
}
beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  denied = [];
  vi.stubGlobal("fetch", vi.fn(async () => { denied.push("network"); throw new Error("Unexpected outbound network in parent oracle"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, enabled, synced_at) VALUES (1, 1, ?), (2, 1, ?), (3, 0, ?)").bind(STAMP, STAMP, STAMP),
  ]);
  await db.batch(PARENTS.map(row => db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, enabled, address, city, zip, synced_at) VALUES (?, ?, ?, ?, ?, 'Parent Depot', 'Parent City', '99999', ?)",
  ).bind(...row, STAMP)));
  await db.batch([...CONTAINERS].reverse().map(([id, parent, enabled]) => db.prepare(
    "INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, route_ids, frequency_ids, serial_number, rfid, location_address, city, state, zip, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Equipment City', 'ZZ', ?, ?)",
  ).bind(id, parent, enabled, id === 10 || id === 70 || id === 100 ? "7,8" : "8,99", "7,0", id === 170 ? "other" : "asset", id === 170 ? "other-tag" : "tag", id === 170 ? "Other" : `Depot ${id}`, id === 170 ? "99999" : "02139", STAMP)));
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denied).toEqual([]);
    expect(await state(), "HTTP GET must not mutate the synthetic snapshot").toEqual(beforeState);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe("container parent scopes: scalar parent assignment, not equipment lists", () => {
  it.each([
    ["literal zero", { parentRouteId: "0" }, [10, 110]],
    ["route equality and duplicate cohorts", { parentRouteId: "7" }, [20, 30, 40, 50, 60, 80, 90, 140, 150, 160, 170, 180, 190, 200, 210]],
    ["maximum safe route", { parentRouteId: "9007199254740991" }, [130]],
    ["leading-zero franchise", { parentFranchiseId: "001" }, [10, 20, 30, 40, 50, 60, 120, 160, 170, 210]],
    ["numeric-looking franchise is not coerced", { parentFranchiseId: "1" }, [70]],
    ["case-sensitive uppercase", { parentFranchiseId: "Acme" }, [80]],
    ["case-sensitive lowercase", { parentFranchiseId: "acme" }, [90]],
    ["significant nonblank whitespace", { parentFranchiseId: " Acme " }, [180]],
    ["internal tab/newline", { parentFranchiseId: "x\t\ny" }, [190]],
    ["quotes, reserved URL text, wildcards and Unicode", { parentFranchiseId: OPAQUE }, [140, 150]],
    ["100 astral code points", { parentFranchiseId: HUNDRED }, [130]],
    ["100 ASCII code points", { parentFranchiseId: "a".repeat(100) }, [200]],
    ["SQL-looking text cannot widen", { parentFranchiseId: "' OR 1=1 --" }, []],
    ["percent/underscore are not wildcards", { parentFranchiseId: "%_" }, []],
    ["unknown route", { parentRouteId: "99" }, []],
    ["unknown franchise", { parentFranchiseId: "missing" }, []],
    ["null is not a string scope", { parentFranchiseId: "null" }, []],
    ["both scopes AND", { parentRouteId: "7", parentFranchiseId: "001" }, [20, 30, 40, 50, 60, 160, 170, 210]],
    ["zero AND franchise", { parentRouteId: "0", parentFranchiseId: "001" }, [10]],
    ["disjoint scopes", { parentRouteId: "8", parentFranchiseId: "001" }, []],
  ] as const)("%s", async (_name, filters, want) => {
    for (const includeTotal of ["true", "false"]) {
      const result = await page({ ...filters, includeTotal });
      expect(ids(result.body)).toEqual(want);
      expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
      expect(result.body.nextCursor).toBeNull();
      expect(result.response.headers.get("link")).toBeNull();
    }
  });
  it.each([
    ["true", "true", [20, 60, 160, 170, 210]], ["true", "false", [30]],
    ["false", "true", [40]], ["false", "false", [50]],
    ["any", "any", [20, 30, 40, 50, 60, 160, 170, 210]],
  ] as const)("independent parentEnabled=%s / equipment enabled=%s", async (parentEnabled, enabled, want) => {
    const result = await page({ parentRouteId: "7", parentFranchiseId: "001", parentEnabled, enabled });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
  });
  it("parentEnabled alone includes null route/franchise parents, without customer-enabled inference", async () => {
    const enabled = await page({ parentEnabled: "true" });
    expect(ids(enabled.body)).toEqual([10, 20, 30, 60, 70, 80, 90, 100, 120, 130, 140, 150, 160, 170, 180, 190, 200, 210]);
    const disabled = await page({ parentEnabled: "false" });
    expect(ids(disabled.body)).toEqual([40, 50, 110]);
    expect(disabled.body.total).toBe(3);
  });
  it("omission and any preserve the same old no-join list and full stored row", async () => {
    const plain = await page();
    const any = await page({ parentEnabled: "any", enabled: "any" });
    expect(ids(plain.body)).toEqual(ALL);
    expect(any.body).toEqual(plain.body);
    expect(any.recorder.statements).toEqual(plain.recorder.statements);
    expect(plain.body.rows[0]).toMatchObject({ container_id: 10, pickup_address_id: 11, route_ids: "7,8", frequency_ids: "7,0", city: "Equipment City", zip: "02139", enabled: 1, synced_at: STAMP });
    expect(Object.keys(plain.body.rows[0])).not.toContain("parentEnabled");
    expect(Object.keys(plain.body.rows[0])).not.toContain("franchise_id");
  });
  it("uses one shared customer/parent join without duplicating siblings", async () => {
    const scopes = { parentRouteId: "7", parentFranchiseId: "001", parentEnabled: "true" };
    const plain = await page(scopes);
    expect(ids(plain.body)).toEqual([20, 30, 60, 160, 170, 210]);
    expect(ids((await page({ ...scopes, customerId: "1" })).body)).toEqual([20, 30, 160, 170]);
    expect(ids((await page({ ...scopes, customerId: "2" })).body)).toEqual([60]);
    expect(ids((await page({ ...scopes, customerId: "3" })).body)).toEqual([210]);
    const existing = await page({ customerId: "1" });
    const any = await page({ customerId: "1", parentEnabled: "any" });
    expect(any.body).toEqual(existing.body);
    expect(any.recorder.statements).toEqual(existing.recorder.statements);
  });
  it("keeps legacy missing/null parent links visible only when no effective parent/customer scope is used", async () => {
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
      db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, route_ids, frequency_ids, synced_at) VALUES (220, 999, 1, '7', '7', ?), (230, NULL, 1, '7', '7', ?)").bind(STAMP, STAMP),
    ]);
    beforeState = await state();
    expect(ids((await page()).body)).toEqual([...ALL, 220, 230]);
    expect(ids((await page({ parentEnabled: "any" })).body)).toEqual([...ALL, 220, 230]);
    const scopes: Record<string, string>[] = [{ parentRouteId: "7" }, { parentFranchiseId: "001" }, { parentEnabled: "true" }, { parentEnabled: "false" }, { customerId: "1", parentEnabled: "any" }];
    for (const filters of scopes) {
      const result = await page(filters);
      expect(ids(result.body)).not.toContain(220);
      expect(ids(result.body)).not.toContain(230);
    }
    expect(ids((await page({ containerId: "220" })).body)).toEqual([220]);
    expect(ids((await page({ containerId: "220", parentRouteId: "7" })).body)).toEqual([]);
  });
});

describe.each(["true", "false"])("container parent scopes: intersection includeTotal=%s", includeTotal => {
  it.each([
    [{}, [20, 30, 40, 50, 60, 160, 170, 210]],
    [{ customerId: "1" }, [20, 30, 40, 50, 160, 170]], [{ customerId: "2" }, [60]],
    [{ pickupAddressId: "12" }, [20, 30, 160, 170]], [{ pickupAddressId: "11" }, []],
    [{ containerId: "40" }, [40]], [{ containerId: "10" }, []],
    [{ ids: "210,10,40,20" }, [20, 40, 210]],
    [{ ids: "20,40,210", parentEnabled: "false" }, [40]],
    [{ ids: "20,40,210", containerId: "20", customerId: "1" }, [20]],
    [{ ids: "20,40,210", containerId: "10" }, []],
    [{ serialNumber: "other" }, [170]], [{ rfid: "other-tag" }, [170]],
    [{ q: "Depot", zip: "02139" }, [20, 30, 40, 50, 60, 160, 210]],
    [{ q: "Equipment City", zip: "02139" }, [20, 30, 40, 50, 60, 160, 210]],
    [{ q: "Parent City" }, []], [{ zip: "99999" }, [170]],
    [{ parentEnabled: "false", enabled: "true", customerId: "1", pickupAddressId: "13", containerId: "40", serialNumber: "asset", rfid: "tag", q: "Depot", zip: "02139" }, [40]],
    [{ parentEnabled: "true", enabled: "false", pickupAddressId: "13" }, []],
    [{ upperId: "50" }, [20, 30, 40, 50]], [{ cursor: "50" }, [60, 160, 170, 210]],
    [{ order: "desc", cursor: "50" }, [40, 30, 20]],
  ] as const)("AND-composes %j", async (filters, want) => {
    const result = await page({ parentRouteId: "7", parentFranchiseId: "001", ...filters, includeTotal });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
  });
});

describe.each(["true", "false"])("container parent scopes: followed links includeTotal=%s", includeTotal => {
  it.each(["asc", "desc"])("traverses every %s page, keeps the upper fence and omits unknown values/origins", async order => {
    const filters = { parentRouteId: "7", parentFranchiseId: "001", parentEnabled: "true", enabled: "any", serialNumber: "asset", rfid: "tag", q: " Depot ", zip: "02139", upperId: "160", fields: "enabled,city", limit: "2", includeTotal, order, unknown: "private-marker", redirect: "https://untrusted.invalid/private" };
    let result = await page(filters);
    const pages = order === "asc" ? [[20, 30], [60, 160], []] : [[160, 60], [30, 20], []];
    const seen: unknown[] = [];
    for (let i = 0; i < pages.length; i++) {
      expect(ids(result.body)).toEqual(pages[i]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : [4, 2, 0][i]);
      for (const row of result.body.rows) expect(Object.keys(row).sort()).toEqual(["city", "container_id", "enabled"]);
      seen.push(...ids(result.body));
      expect(result.body.nextCursor).toBe(i === 2 ? null : pages[i][1]);
      if (i === 2) expect(result.response.headers.get("link")).toBeNull();
      else result = await page(next(result));
    }
    expect(seen).toEqual(order === "asc" ? [20, 30, 60, 160] : [160, 60, 30, 20]);
    expect(new Set(seen).size).toBe(4);
  });
  it.each([
    ["asc", { offset: "1" }, [30, 40], 8, 40, [50, 60]],
    ["desc", { offset: "1" }, [170, 160], 8, 160, [60, 50]],
    ["asc", { cursor: "40", offset: "999" }, [50, 60], 5, 60, [160, 170]],
    ["desc", { cursor: "160", offset: "999" }, [60, 50], 5, 50, [40, 30]],
  ] as const)("%s offset/seek %j", async (order, paging, want, total, cursor, following) => {
    const result = await page({ parentRouteId: "7", parentFranchiseId: "001", parentEnabled: "any", order, ...paging, limit: "2", includeTotal });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(includeTotal === "false" ? null : total);
    expect(result.body.nextCursor).toBe(cursor);
    if ("cursor" in paging) for (const s of result.recorder.statements) expect(s.sql).not.toMatch(/\bOFFSET\b/i);
    expect(ids((await page(next(result))).body)).toEqual(following);
  });
  it.each(["asc", "desc"])("follows exact opaque franchises through the terminal %s page", async order => {
    const first = await page({ parentRouteId: "7", parentFranchiseId: OPAQUE, parentEnabled: "true", customerId: "1", enabled: "true", q: "Depot", zip: "02139", serialNumber: "asset", rfid: "tag", fields: "enabled", limit: "1", order, includeTotal });
    expect(ids(first.body)).toEqual(order === "asc" ? [140] : [150]);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 2);
    const target = next(first);
    expect(target.searchParams.get("parentFranchiseId")).toBe(OPAQUE);
    expect(first.response.headers.get("link")).not.toContain(OPAQUE);
    const last = await page(target);
    expect(ids(last.body)).toEqual(order === "asc" ? [150] : [140]);
    const empty = await page(next(last));
    expect(empty.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(empty.response.headers.get("link")).toBeNull();
  });
  it.each(["asc", "desc"])("retains the finite ids selector through every %s page", async order => {
    let result = await page({ parentRouteId: "7", parentFranchiseId: "001", parentEnabled: "any", ids: "10,20,40,60,130", limit: "2", includeTotal, order });
    const expected = order === "asc" ? [[20, 40], [60]] : [[60, 40], [20]];
    expect(ids(result.body)).toEqual(expected[0]);
    expect(result.body.total).toBe(includeTotal === "false" ? null : 3);
    // ids may be canonically sorted, but this input already is canonical.
    result = await page(next(result));
    expect(ids(result.body)).toEqual(expected[1]);
    expect(result.body.total).toBe(includeTotal === "false" ? null : 1);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  });
  it("retains false parent state and literal zero on continuation", async () => {
    const first = await page({ parentRouteId: "7", parentFranchiseId: "001", parentEnabled: "false", limit: "1", includeTotal });
    expect(ids(first.body)).toEqual([40]);
    expect(ids((await page(next(first))).body)).toEqual([50]);
    const zero = await page({ parentRouteId: "0", parentEnabled: "any", limit: "1", includeTotal });
    expect(ids(zero.body)).toEqual([10]);
    expect(ids((await page(next(zero))).body)).toEqual([110]);
  });
});

const invalid = [
  ...["", "-1", "-0", "+7", "07", "00", "7.0", "7.5", "7e0", "0x7", " 7", "7 ", "7\n", "７", "٧", "9007199254740992", "9".repeat(100), "NaN", "Infinity", "7,8"].map(value => ["parentRouteId", `parentRouteId=${encodeURIComponent(value)}`]),
  ["parentRouteId", "parentRouteId"], ["parentRouteId", "parentRouteId=7&parentRouteId=7"],
  ["parentRouteId", "parentRouteId=7&parentRouteId=8"], ["parentRouteId", "parentRouteId=&parentRouteId=7"],
  ["parentRouteId", "parentRouteId=7&parentRoute%49d=7"],
  ...["", " ", "\t\n", " 　", "f".repeat(101), `${HUNDRED}🚛`].map(value => ["parentFranchiseId", `parentFranchiseId=${encodeURIComponent(value)}`]),
  ["parentFranchiseId", "parentFranchiseId"], ["parentFranchiseId", "parentFranchiseId=001&parentFranchiseId=001"],
  ["parentFranchiseId", "parentFranchiseId=001&parentFranchiseId=1"], ["parentFranchiseId", "parentFranchiseId=001&parentFranchiseId="],
  ["parentFranchiseId", "parentFranchiseId=001&parentFranchise%49d=001"],
  ...["", "TRUE", "False", "Any", "1", "0", " true", "false ", "any\n", "true,false"].map(value => ["parentEnabled", `parentEnabled=${encodeURIComponent(value)}`]),
  ["parentEnabled", "parentEnabled"], ["parentEnabled", "parentEnabled=any&parentEnabled=any"],
  ["parentEnabled", "parentEnabled=true&parentEnabled=false"], ["parentEnabled", "parentEnabled=&parentEnabled=true"],
  ["parentEnabled", "parentEnabled=true&parent%45nabled=true"],
];
describe("container parent scopes: value-free validation before D1, after authentication", () => {
  it.each(invalid)("rejects %s query %s even on conditional GET", async (key, query) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const result = await request(query, { headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    posture(result.response);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(await result.response.json()).toEqual({ type: BAD_REQUEST, title: "Bad Request", status: 400, detail: `Invalid request query (${key}). See docs/PROBLEMS.md#bad-request.` });
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it.each([null, "invalid-read-token"])("authenticates %s before malformed parent query/304 handling", async token => {
    const result = await request("parentRouteId=private-marker&parentFranchiseId=&parentEnabled=invalid", { token, headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toMatchObject({ status: 401, title: "Unauthorized" });
    expect(result.recorder.prepared).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
  });
  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("preserves authorized read access via %s", async token => {
    const result = await request({ parentRouteId: "0", parentFranchiseId: "001", parentEnabled: "true" }, { token });
    expect(result.response.status).toBe(200);
    expect(ids(await result.response.json() as Body)).toEqual([10]);
  });
  it("does not reflect successful or rejected opaque selectors in logs/errors", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const first = await page({ parentFranchiseId: OPAQUE });
    expect(ids(first.body)).toEqual([140, 150]);
    const marker = `synthetic-private-franchise-${"x".repeat(101)}`;
    const rejected = await request({ parentFranchiseId: marker });
    expect(rejected.response.status).toBe(400);
    expect(await rejected.response.text()).not.toContain(marker);
    expect(rejected.recorder.prepared).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it("unknown keys remain ignored but are not reflected in next links", async () => {
    const filters = { parentRouteId: "7", parentEnabled: "any", limit: "1" };
    const plain = await page(filters);
    const unknown = await page({ ...filters, unknown: "private-marker" });
    expect(unknown.body).toEqual(plain.body);
    expect(unknown.recorder.statements).toEqual(plain.recorder.statements);
    next(unknown);
  });
  it("retains old validation caps and sparse-field rejection before D1", async () => {
    const invalidLegacy: Record<string, string>[] = [{ limit: "501" }, { fields: "parentEnabled" }, { fields: "parent_route_id" }];
    for (const filters of invalidLegacy) {
      const result = await request({ parentRouteId: "7", ...filters });
      expect(result.response.status).toBe(400);
      expect(result.recorder.prepared).toEqual([]);
    }
  });
});

it.each(["true", "false"])("parent-scoped representation ETags and 304 includeTotal=%s", async includeTotal => {
  const query = { parentRouteId: "7", parentFranchiseId: "001", parentEnabled: "true", fields: "enabled", limit: "2", includeTotal };
  const first = await page(query);
  expect(first.body.rows).toEqual([{ container_id: 20, enabled: 1 }, { container_id: 30, enabled: 0 }]);
  expect(first.body.total).toBe(includeTotal === "false" ? null : 6);
  const tag = await hash(first.bytes);
  expect(first.response.headers.get("etag")).toBe(tag);
  next(first);
  for (const validator of [tag, `W/${tag}`, "*"]) {
    const same = await request(query, { headers: { "if-none-match": validator } });
    expect(same.response.status).toBe(304);
    expect(same.response.body).toBeNull();
    expect(await same.response.text()).toBe("");
    expect(same.response.headers.get("etag")).toBe(tag);
    expect(same.response.headers.get("link")).toBe(first.response.headers.get("link"));
    posture(same.response);
    budget(same);
    expect(same.recorder.statements).toEqual(first.recorder.statements);
  }
  const changed = await page({ ...query, parentEnabled: "false" }, { "if-none-match": tag });
  expect(ids(changed.body)).toEqual([40, 50]);
  expect(changed.response.headers.get("etag")).not.toBe(tag);
  const projected = await page({ ...query, fields: "city" }, { "if-none-match": tag });
  expect(projected.response.headers.get("etag")).not.toBe(tag);
});
it.each(["route_id", "franchise_id", "enabled"])("recomputes sparse membership after an unprojected parent %s change", async column => {
  const query = { parentRouteId: "7", parentFranchiseId: "001", parentEnabled: "true", containerId: "20", fields: "enabled" };
  const first = await page(query);
  expect(first.body.rows).toEqual([{ container_id: 20, enabled: 1 }]);
  // Direct fixture mutation only; deliberately leave synced_at unchanged.
  await TEST_ENV.CUSTOMER_DB.prepare(`UPDATE address_snapshot SET ${column} = ? WHERE pickup_address_id = 12`).bind(column === "franchise_id" ? "different" : 0).run();
  beforeState = await state();
  const changed = await page(query, { "if-none-match": await hash(first.bytes) });
  expect(changed.body).toEqual({ rows: [], total: 0, nextCursor: null });
  expect(changed.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
});
it("binds parent equality on both SELECTs and executes synthetic EXPLAIN without promising an index", async () => {
  const result = await page({ parentRouteId: "7", parentFranchiseId: OPAQUE, parentEnabled: "true", limit: "1" });
  expect(ids(result.body)).toEqual([140]);
  expect(result.body.total).toBe(2);
  for (const { sql, binds } of result.recorder.statements) {
    const join = sql.match(/\bJOIN\s+address_snapshot(?:\s+(?:AS\s+)?(?!ON\b)(\w+))?\s+ON\b/i);
    expect(join).not.toBeNull();
    const parent = join![1] ?? "address_snapshot";
    expect(sql).toMatch(new RegExp(`\\b${parent}\\.route_id\\s*=\\s*\\?`, "i"));
    expect(sql).toMatch(new RegExp(`\\b${parent}\\.franchise_id\\s*=\\s*\\?`, "i"));
    // Exact enum state can safely use a fixed SQL literal or a bound value.
    expect(sql).toMatch(new RegExp(`\\b${parent}\\.enabled\\s*=\\s*(?:\\?|1\\b)`, "i"));
    expect(binds.map(String)).toContain("7");
    expect(binds).toContain(OPAQUE);
    expect(sql).not.toContain(OPAQUE);
    expect(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP|COLLATE\s+NOCASE)\b/i);
    const where = sql.split(/\bWHERE\b/i)[1] ?? "";
    expect(where).not.toMatch(/\b(?:route_ids|frequency_ids)\b/i);
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
    const details = plan.results.map(row => row.detail).join("\n");
    expect(plan.results.length, `Synthetic local plan (not production latency): ${details}`).toBeGreaterThan(0);
    expect(details).toMatch(/\bSCAN\b|\bSEARCH\b/i);
  }
});

type Parameter = { name: string; in: string; required?: boolean; description?: string; example?: unknown; examples?: Record<string, { value?: unknown }>; schema: Record<string, unknown> };
type Operation = { operationId: string; description: string; parameters: Parameter[]; responses: Record<string, { description: string }>; "x-effect"?: string; "x-access"?: string };
async function document() {
  const result = await request(new URL("/openapi.json", ORIGIN), { token: null });
  expect(result.response.status).toBe(200);
  expect(result.recorder.prepared).toEqual([]);
  return await result.response.json() as { paths: Record<string, { get: Operation }> };
}
describe("container parent scopes: mounted machine-readable discovery", () => {
  it("publishes all three optional selectors with exact bounds and useful examples", async () => {
    const op = (await document()).paths[PATH].get;
    expect(op).toMatchObject({ operationId: "listContainerSnapshot", "x-effect": "local-read", "x-access": "read" });
    for (const name of ["parentRouteId", "parentFranchiseId", "parentEnabled"]) {
      const params = op.parameters.filter(p => p.in === "query" && p.name === name);
      expect(params).toHaveLength(1);
      expect(params[0].required ?? false).toBe(false);
      const examples = [params[0].example, params[0].schema.example, ...Object.values(params[0].examples ?? {}).map(e => e.value)];
      expect(examples.some(value => value !== undefined), name).toBe(true);
    }
    const route = op.parameters.find(p => p.name === "parentRouteId")!;
    expect(route.schema).toMatchObject({ type: "integer", minimum: 0, maximum: 9007199254740991 });
    expect(`${route.description ?? ""} ${JSON.stringify(route.schema)}`).toMatch(/ASCII|decimal/i);
    expect(route.description).toMatch(/unpadded|canonical|leading zero/i);
    const franchise = op.parameters.find(p => p.name === "parentFranchiseId")!;
    expect(franchise.schema).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
    for (const pattern of [/case.sensitive/i, /code points/i, /opaque|exact/i, /whitespace/i, /leading zeros/i]) expect(franchise.description).toMatch(pattern);
    expect(op.parameters.find(p => p.name === "parentEnabled")!.schema).toMatchObject({ type: "string", enum: ["true", "false", "any"], default: "any" });
  });
  it("explains parent versus equipment state, AND scopes and supported value-free recovery", async () => {
    const op = (await document()).paths[PATH].get;
    for (const name of ["parentRouteId", "parentFranchiseId", "parentEnabled", "enabled"]) expect(op.description).toContain(name);
    expect(op.description).toMatch(/\bAND\b|intersect/i);
    expect(op.description).toMatch(/independent|separate/i);
    expect(op.description).toMatch(/route_ids|frequency_ids|equipment.*route|container.*route/i);
    const recovery = op.responses["400"].description;
    for (const name of ["parentRouteId", "parentFranchiseId", "parentEnabled"]) expect(recovery).toContain(name);
    for (const pattern of [/repeat|duplicate/i, /blank|empty/i, /before.*D1/i, /application\/problem\+json/, /docs\/PROBLEMS\.md#bad-request/]) expect(recovery).toMatch(pattern);
    expect(recovery).toMatch(/true.*false.*any/);
  });
  it("retains every existing query and aligns the served inventory with the canonical query-policy table", async () => {
    const op = (await document()).paths[PATH].get;
    const names = op.parameters.filter(p => p.in === "query").map(p => p.name).sort();
    for (const key of ["parentRouteId", "parentFranchiseId", "parentEnabled", "customerId", "pickupAddressId", "containerId", "ids", "serialNumber", "rfid", "zip", "q", "enabled", "upperId", "order", "cursor", "offset", "includeTotal", "fields", "limit"]) expect(names).toContain(key);
    const row = policyDoc.split("\n").find(line => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    expect([...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map(m => m[1]).sort()).toEqual(names);
  });
});
