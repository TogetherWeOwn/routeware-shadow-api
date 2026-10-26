import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent Test-Author oracle; all expected IDs/pages are hand-derived.
 * Mutation targets: reading the container's own city/state/zip instead of the
 * parent address's; trimming/case-folding/zero-stripping stored locality;
 * abbreviation conversion; unconditional, absent or duplicate joins; OR
 * leakage between parent and own locality; COUNT/page drift; lost next-link
 * scopes; stale sparse ETags; auth bypass. Real local D1 evaluates product
 * SQL. Only fixture setup may write. Requests deny D1 writes/batch/exec, R2,
 * browser and fetch; no production/staging probes. Builder: incorporate this
 * test commit unchanged; oracle corrections stay Test-Author-owned. Expected
 * RED until the paired implementation arrives.
 * Run: npx vitest run test/containerParentLocality.acceptance.test.ts --maxWorkers=2
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/container-snapshot";
const ORIGIN = "https://container-parent-locality.test.invalid";
const STAMP = "2026-01-02T03:04:05.000Z";
const OPAQUE = " 雪'\"%_ /+?&#🚛 ";
const HUNDRED = "🚛".repeat(100);
type Query = Record<string, string> | string | URL;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
// Parent: id, customer, route, franchise, enabled, stored city/state/zip.
// 11/12/21 share one locality (duplicate decoys); 14 is the lowercase and
// zero-stripped decoy; 15 keeps significant whitespace; 16/17/18 null one
// locality column each; 19 is opaque text; 20 is 100 astral code points.
const PARENTS = [
  [11, 1, 7, "F-1", 1, "Riverton", "TX", "02139"], [12, 1, 7, "F-1", 1, "Riverton", "TX", "02139"],
  [13, 1, 8, "F-2", 0, "Riverton", "OK", "73001"], [14, 2, 7, "F-1", 1, "riverton", "tx", "2139"],
  [15, 1, 7, "F-1", 1, " Riverton ", " TX", " 02139"], [16, 1, 7, "F-1", 1, null, "TX", "02139"],
  [17, 1, 7, "F-1", 1, "Riverton", null, "02139"], [18, 1, 7, "F-1", 1, "Riverton", "TX", null],
  [19, 1, 7, "F-1", 1, OPAQUE, "T\tX", "0'2139"], [20, 1, 7, "F-1", 1, HUNDRED, "TX", "02139"],
  [21, 3, 7, "F-1", 1, "Riverton", "TX", "02139"], [22, 1, 9, "F-9", 1, "Elsewhere", "NM", "87001"],
] as const;
// Container: id, parent, equipment enabled, OWN stored city/state/zip.
// 30's own locality equals its parent's; 50's own locality equals site 11's
// parent locality while its own parent (14) differs in case and zeros; 130
// has null own locality. Every other row's own locality is the ZZ/99999 decoy.
const EQ = "Equipment City";
const CONTAINERS = [
  [10, 11, 1, EQ, "ZZ", "99999"], [20, 11, 0, EQ, "ZZ", "99999"], [30, 12, 1, "Riverton", "TX", "02139"],
  [40, 13, 1, EQ, "ZZ", "99999"], [50, 14, 1, "Riverton", "TX", "02139"], [60, 15, 1, EQ, "ZZ", "99999"],
  [70, 16, 1, EQ, "ZZ", "99999"], [80, 17, 1, EQ, "ZZ", "99999"], [90, 18, 1, EQ, "ZZ", "99999"],
  [100, 19, 1, EQ, "ZZ", "99999"], [110, 20, 1, EQ, "ZZ", "99999"], [120, 21, 1, EQ, "ZZ", "99999"],
  [130, 22, 1, null, null, null], [140, 11, 1, EQ, "ZZ", "99999"],
] as const;
const ALL = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140];
const THREE = { parentCity: "Riverton", parentState: "TX", parentZip: "02139" };
const ids = (body: Body) => body.rows.map(row => row.container_id);
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
let denied: string[];
let beforeState: unknown;

function recordedDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const forbid = (operation: string): never => {
    denied.push(operation);
    throw new Error("Unexpected effect in container parent locality oracle");
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
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Parent-locality-oracle", ...options.headers });
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
  expect(response.headers.get("x-request-id")).toBe("Parent-locality-oracle");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
function budget(result: Awaited<ReturnType<typeof request>>) {
  const countFree = result.url.searchParams.get("includeTotal") === "false";
  const statements = result.recorder.statements;
  expect(statements).toHaveLength(countFree ? 1 : 2);
  expect(statements.filter(isCount)).toHaveLength(countFree ? 0 : 1);
  const select = statements.find(s => !isCount(s))!;
  const tail = /\bOFFSET\b/i.test(select.sql) ? 2 : 1;
  const limit = Number(result.url.searchParams.get("limit") ?? 50) + (result.url.searchParams.get("exactNext") === "true" ? 1 : 0);
  expect(select.binds[select.binds.length - tail]).toBe(limit);
  if (!countFree) expect(select.binds.slice(0, -tail)).toEqual(statements.find(isCount)!.binds);
  const q = result.url.searchParams;
  const joined = q.has("customerId") || q.has("parentRouteId") || q.has("parentFranchiseId")
    || q.has("parentCity") || q.has("parentState") || q.has("parentZip")
    || ["true", "false"].includes(q.get("parentEnabled") ?? "");
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
async function counted(query: Record<string, string>) {
  const result = await request({ ...query, countOnly: "true" });
  expect(result.response.status).toBe(200);
  posture(result.response);
  expect(result.response.headers.get("link")).toBeNull();
  expect(result.recorder.statements).toHaveLength(1);
  expect(result.recorder.statements.filter(isCount)).toHaveLength(1);
  expect(result.recorder.statements[0].sql.match(/\bJOIN\b/gi) ?? []).toHaveLength(1);
  expect(result.recorder.statements[0].sql).toMatch(/\bJOIN\s+address_snapshot\b/i);
  const body = await result.response.json() as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  expect(body.rows).toEqual([]);
  expect(body.nextCursor).toBeNull();
  return { ...result, body };
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
  vi.stubGlobal("fetch", vi.fn(async () => { denied.push("network"); throw new Error("Unexpected outbound network in parent locality oracle"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, enabled, synced_at) VALUES (1, 1, ?), (2, 1, ?), (3, 0, ?)").bind(STAMP, STAMP, STAMP),
  ]);
  await db.batch(PARENTS.map(row => db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, enabled, address, city, state, zip, synced_at) VALUES (?, ?, ?, ?, ?, 'Parent Depot', ?, ?, ?, ?)",
  ).bind(row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7], STAMP)));
  await db.batch([...CONTAINERS].reverse().map(([id, parent, enabled, city, stateRow, zip]) => db.prepare(
    "INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, serial_number, rfid, location_address, city, state, zip, synced_at) VALUES (?, ?, ?, 'asset', 'tag', ?, ?, ?, ?, ?)",
  ).bind(id, parent, enabled, id === 130 ? null : `Depot ${id}`, city, stateRow, zip, STAMP)));
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denied).toEqual([]);
    expect(await state(), "HTTP GET must not mutate the synthetic snapshot").toEqual(beforeState);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe("container parent locality: stored parent city/state/zip, never the equipment's own", () => {
  it.each([
    ["parent city cohort across duplicate sites", { parentCity: "Riverton" }, [10, 20, 30, 40, 80, 90, 120, 140]],
    ["parent city is case-sensitive lowercase", { parentCity: "riverton" }, [50]],
    ["parent city uppercase matches nothing", { parentCity: "RIVERTON" }, []],
    ["parent city keeps significant whitespace", { parentCity: " Riverton " }, [60]],
    ["parent city opaque quotes/Unicode/wildcard text", { parentCity: OPAQUE }, [100]],
    ["parent city 100 astral code points", { parentCity: HUNDRED }, [110]],
    ["parent city sole other site", { parentCity: "Elsewhere" }, [130]],
    ["own city never satisfies parentCity", { parentCity: EQ }, []],
    ["unknown parent city", { parentCity: "missing" }, []],
    ["SQL-looking parent city cannot widen", { parentCity: "' OR 1=1 --" }, []],
    ["parent city percent/underscore are not wildcards", { parentCity: "%_" }, []],
    ["parent state cohort", { parentState: "TX" }, [10, 20, 30, 70, 90, 110, 120, 140]],
    ["parent state is case-sensitive lowercase", { parentState: "tx" }, [50]],
    ["parent state keeps leading whitespace", { parentState: " TX" }, [60]],
    ["parent state keeps internal tab", { parentState: "T\tX" }, [100]],
    ["parent state other site", { parentState: "OK" }, [40]],
    ["parent state is not expanded from an abbreviation", { parentState: "Texas" }, []],
    ["own state never satisfies parentState", { parentState: "ZZ" }, []],
    ["parent zip cohort keeps leading zero", { parentZip: "02139" }, [10, 20, 30, 70, 80, 110, 120, 140]],
    ["parent zip without leading zero is a different value", { parentZip: "2139" }, [50]],
    ["parent zip keeps leading whitespace", { parentZip: " 02139" }, [60]],
    ["parent zip quote is bound text", { parentZip: "0'2139" }, [100]],
    ["parent zip other site", { parentZip: "73001" }, [40]],
    ["own zip never satisfies parentZip", { parentZip: "99999" }, []],
    ["parent zip percent/underscore are not wildcards", { parentZip: "%_" }, []],
    ["all three AND on the same parent", THREE, [10, 20, 30, 120, 140]],
    ["city and state pair", { parentCity: "Riverton", parentState: "OK" }, [40]],
    ["city and zip pair spans the null-state parent", { parentCity: "Riverton", parentZip: "02139" }, [10, 20, 30, 80, 120, 140]],
    ["state and zip pair spans the null-city parent", { parentState: "TX", parentZip: "02139" }, [10, 20, 30, 70, 110, 120, 140]],
    ["contradicting parent locality parts", { parentCity: "Riverton", parentState: "TX", parentZip: "73001" }, []],
    ["lowercase parent contradicts uppercase parts", { parentCity: "riverton", parentState: "TX", parentZip: "02139" }, []],
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
    ["parent city differs from own zip on the matching row", { parentCity: "riverton", zip: "02139" }, [50]],
    ["parent zip differs from own state on the matching row", { parentZip: "2139", state: "TX" }, [50]],
    ["own state narrows the parent-city cohort to the equal-locality row", { parentCity: "Riverton", state: "TX" }, [30]],
    ["own zip narrows the parent-city cohort likewise", { parentCity: "Riverton", zip: "02139" }, [30]],
    ["parent scope plus null own zip cannot match an own-zip selector", { parentCity: "Elsewhere", zip: "99999" }, []],
    ["q still searches only own columns beside a parent scope", { parentCity: "Riverton", q: "Riverton" }, [30]],
    ["q never reaches the parent city", { parentCity: "Riverton", q: "Elsewhere" }, []],
  ] as const)("%s", async (_name, filters, want) => {
    const result = await page(filters);
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
  });
  it("own locality selectors alone stay unjoined and unchanged", async () => {
    expect(ids((await page({ zip: "02139" })).body)).toEqual([30, 50]);
    expect(ids((await page({ state: "TX" })).body)).toEqual([30, 50]);
    expect(ids((await page({ zip: "99999" })).body)).toEqual([10, 20, 40, 60, 70, 80, 90, 100, 110, 120, 140]);
  });
  it("omission preserves the same old no-join list, statements and full stored row", async () => {
    const plain = await page();
    const any = await page({ parentEnabled: "any", enabled: "any" });
    expect(ids(plain.body)).toEqual(ALL);
    expect(any.body).toEqual(plain.body);
    expect(any.recorder.statements).toEqual(plain.recorder.statements);
    expect(plain.body.rows[0]).toMatchObject({ container_id: 10, pickup_address_id: 11, city: EQ, state: "ZZ", zip: "99999", enabled: 1, synced_at: STAMP });
    for (const key of ["parentCity", "parentState", "parentZip"]) expect(Object.keys(plain.body.rows[0])).not.toContain(key);
  });
  it("parent locality keys are known under strictQuery", async () => {
    const result = await page({ ...THREE, strictQuery: "true" });
    expect(ids(result.body)).toEqual([10, 20, 30, 120, 140]);
  });
  it("countOnly shares the parent-locality predicates on one joined COUNT", async () => {
    expect((await counted({ parentCity: "Riverton" })).body.total).toBe(8);
    expect((await counted(THREE)).body.total).toBe(5);
    expect((await counted({ parentState: "TX", parentZip: "73001" })).body.total).toBe(0);
    expect((await counted({ parentZip: "02139", customerId: "3" })).body.total).toBe(1);
  });
  it("keeps legacy missing/null parent links visible only when no parent locality is supplied", async () => {
    // Local fixture-only legacy table: AS SELECT preserves every real column,
    // but omits FK/NOT NULL constraints so historical dangling links can exist.
    // Production migrations/constraints are NOT changed; all other tests use them.
    const db = TEST_ENV.CUSTOMER_DB;
    const triggers = await db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all<{ name: string; sql: string }>();
    await db.batch([
      ...triggers.results.map(t => db.prepare(`DROP TRIGGER "${t.name.replace(/"/g, '""')}"`)),
      db.prepare("CREATE TABLE legacy_container_snapshot AS SELECT * FROM container_snapshot"),
      db.prepare("DROP TABLE container_snapshot"),
      db.prepare("ALTER TABLE legacy_container_snapshot RENAME TO container_snapshot"),
      ...triggers.results.map(t => db.prepare(t.sql)),
      db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, city, state, zip, synced_at) VALUES (220, 999, 1, 'Riverton', 'TX', '02139', ?), (230, NULL, 1, 'Riverton', 'TX', '02139', ?)").bind(STAMP, STAMP),
    ]);
    beforeState = await state();
    expect(ids((await page()).body)).toEqual([...ALL, 220, 230]);
    const orphanScopes: Record<string, string>[] = [{ parentCity: "Riverton" }, { parentState: "TX" }, { parentZip: "02139" }, THREE];
    for (const filters of orphanScopes) {
      const result = await page(filters);
      expect(ids(result.body)).not.toContain(220);
      expect(ids(result.body)).not.toContain(230);
    }
    expect(ids((await page({ containerId: "220" })).body)).toEqual([220]);
    expect(ids((await page({ containerId: "220", parentCity: "Riverton" })).body)).toEqual([]);
  });
});

describe.each(["true", "false"])("container parent locality: intersection includeTotal=%s", includeTotal => {
  it.each([
    [{}, [10, 20, 30, 120, 140]],
    [{ customerId: "1" }, [10, 20, 30, 140]], [{ customerId: "3" }, [120]], [{ customerId: "2" }, []],
    [{ parentRouteId: "7" }, [10, 20, 30, 120, 140]], [{ parentRouteId: "8" }, []],
    [{ parentFranchiseId: "F-1" }, [10, 20, 30, 120, 140]], [{ parentFranchiseId: "F-2" }, []],
    [{ parentEnabled: "true" }, [10, 20, 30, 120, 140]], [{ parentEnabled: "false" }, []],
    [{ enabled: "false" }, [20]], [{ enabled: "true" }, [10, 30, 120, 140]],
    [{ pickupAddressId: "11" }, [10, 20, 140]], [{ pickupAddressId: "12" }, [30]], [{ pickupAddressId: "13" }, []],
    [{ containerId: "30" }, [30]], [{ containerId: "50" }, []],
    [{ ids: "140,10,50,30" }, [10, 30, 140]],
    [{ serialNumber: "asset", rfid: "tag" }, [10, 20, 30, 120, 140]], [{ serialNumber: "other" }, []],
    [{ zip: "02139" }, [30]], [{ zip: "99999" }, [10, 20, 120, 140]],
    [{ state: "TX" }, [30]], [{ state: "ZZ" }, [10, 20, 120, 140]],
    [{ q: "Riverton" }, [30]], [{ q: "Elsewhere" }, []],
    [{ lowerId: "30" }, [30, 120, 140]], [{ upperId: "30" }, [10, 20, 30]],
    [{ lowerId: "30", upperId: "120" }, [30, 120]],
    [{ cursor: "30" }, [120, 140]], [{ order: "desc", cursor: "120" }, [30, 20, 10]],
  ] as const)("AND-composes %j", async (filters, want) => {
    const result = await page({ ...THREE, ...filters, includeTotal });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
  });
  it("composes with the older parent scopes in both directions of contradiction", async () => {
    expect(ids((await page({ parentCity: "Riverton", parentEnabled: "false", includeTotal })).body)).toEqual([40]);
    expect(ids((await page({ parentZip: "02139", parentEnabled: "false", includeTotal })).body)).toEqual([]);
    expect(ids((await page({ parentState: "OK", parentFranchiseId: "F-2", parentRouteId: "8", includeTotal })).body)).toEqual([40]);
    expect(ids((await page({ parentState: "OK", parentFranchiseId: "F-1", includeTotal })).body)).toEqual([]);
  });
});

describe.each(["true", "false"])("container parent locality: followed links includeTotal=%s", includeTotal => {
  it.each(["asc", "desc"])("traverses every %s page and retains all three selectors", async order => {
    const filters = { ...THREE, parentEnabled: "any", enabled: "any", fields: "enabled,city", limit: "2", includeTotal, order, unknown: "private-marker", redirect: "https://untrusted.invalid/private" };
    let result = await page(filters);
    const pages = order === "asc" ? [[10, 20], [30, 120], [140]] : [[140, 120], [30, 20], [10]];
    const totals = [5, 3, 1];
    const seen: unknown[] = [];
    for (let i = 0; i < pages.length; i++) {
      expect(ids(result.body)).toEqual(pages[i]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : totals[i]);
      for (const row of result.body.rows) expect(Object.keys(row).sort()).toEqual(["city", "container_id", "enabled"]);
      seen.push(...ids(result.body));
      if (i === pages.length - 1) {
        // A partial page is terminal: no cursor, no link, no trailing empty page.
        expect(result.body.nextCursor).toBeNull();
        expect(result.response.headers.get("link")).toBeNull();
      } else {
        expect(result.body.nextCursor).toBe(pages[i][1]);
        result = await page(next(result));
      }
    }
    expect(seen).toEqual(order === "asc" ? [10, 20, 30, 120, 140] : [140, 120, 30, 20, 10]);
    expect(new Set(seen).size).toBe(5);
  });
  it.each([
    ["asc", { offset: "1" }, [20, 30], [120, 140]],
    ["desc", { offset: "1" }, [120, 30], [20, 10]],
    ["asc", { cursor: "20", offset: "999" }, [30, 120], [140]],
    ["desc", { cursor: "120", offset: "999" }, [30, 20], [10]],
  ] as const)("%s offset/seek %j keeps the selectors across the switch to seek", async (order, paging, want, following) => {
    const result = await page({ ...THREE, order, ...paging, limit: "2", includeTotal });
    expect(ids(result.body)).toEqual(want);
    if ("cursor" in paging) for (const s of result.recorder.statements) expect(s.sql).not.toMatch(/\bOFFSET\b/i);
    expect(ids((await page(next(result))).body)).toEqual(following);
  });
  it("exactNext suppresses the terminal cursor only when the cohort is exhausted", async () => {
    const exact = await page({ ...THREE, limit: "5", exactNext: "true", includeTotal });
    expect(ids(exact.body)).toEqual([10, 20, 30, 120, 140]);
    expect(exact.body.nextCursor).toBeNull();
    expect(exact.response.headers.get("link")).toBeNull();
    const probe = await page({ ...THREE, limit: "2", exactNext: "true", includeTotal });
    expect(ids(probe.body)).toEqual([10, 20]);
    expect(probe.body.nextCursor).toBe(20);
    const plain = await page({ ...THREE, limit: "5", includeTotal });
    expect(plain.body.nextCursor).toBe(140);
    const empty = await page(next(plain));
    expect(empty.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(empty.response.headers.get("link")).toBeNull();
  });
});

const KEYS = ["parentCity", "parentState", "parentZip"] as const;
const invalid = KEYS.flatMap(key => [
  ...["", " ", "\t\n", " 　", "x".repeat(101), `${HUNDRED}🚛`].map(value => [key, `${key}=${encodeURIComponent(value)}`, value]),
  [key, key, ""],
  [key, `${key}=Riverton&${key}=Riverton`, "Riverton"],
  [key, `${key}=Riverton&${key}=Elsewhere`, "Elsewhere"],
  [key, `${key}=&${key}=Riverton`, "Riverton"],
  [key, `${key}=Riverton&${key.replace("C", "%43").replace("S", "%53").replace("Z", "%5A")}=Riverton`, "Riverton"],
]);
describe("container parent locality: value-free validation before D1, after authentication", () => {
  it.each(invalid)("rejects %s query %s even on conditional GET", async (key, query, submitted) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const result = await request(query, { headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    posture(result.response);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const problem = await result.response.json() as Record<string, unknown>;
    expect(problem).toMatchObject({ title: "Bad Request", status: 400 });
    expect(String(problem.detail ?? "")).toContain(key);
    if (submitted.trim().length > 2) expect(String(problem.detail ?? "")).not.toContain(submitted);
    expect(result.recorder.prepared).toEqual([]);
    expect(result.recorder.statements).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it.each([null, "invalid-read-token"])("authenticates %s before malformed parent locality query/304 handling", async token => {
    const result = await request("parentCity=&parentState=%20&parentZip=", { token, headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toMatchObject({ status: 401, title: "Unauthorized" });
    expect(result.recorder.prepared).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
  });
  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("preserves authorized read access via %s", async token => {
    const result = await request(THREE, { token });
    expect(result.response.status).toBe(200);
    expect(ids(await result.response.json() as Body)).toEqual([10, 20, 30, 120, 140]);
  });
  it("does not reflect successful or rejected opaque selectors in logs/errors", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const first = await page({ parentCity: OPAQUE, parentState: "T\tX", parentZip: "0'2139" });
    expect(ids(first.body)).toEqual([100]);
    const marker = `synthetic-private-locality-${"x".repeat(101)}`;
    const rejected = await request({ parentCity: marker });
    expect(rejected.response.status).toBe(400);
    expect(await rejected.response.text()).not.toContain(marker);
    expect(rejected.recorder.prepared).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it("unknown keys remain ignored but are not reflected in next links", async () => {
    const filters = { ...THREE, limit: "1" };
    const plain = await page(filters);
    const unknown = await page({ ...filters, unknown: "private-marker" });
    expect(unknown.body).toEqual(plain.body);
    expect(unknown.recorder.statements).toEqual(plain.recorder.statements);
    next(unknown);
  });
  it("retains sparse-field rejection of parent locality names before D1", async () => {
    for (const fields of ["parentCity", "parent_city"]) {
      const result = await request({ ...THREE, fields });
      expect(result.response.status).toBe(400);
      expect(result.recorder.prepared).toEqual([]);
    }
  });
});

it.each(["true", "false"])("parent-locality representation ETags and 304 includeTotal=%s", async includeTotal => {
  const query = { ...THREE, fields: "enabled", limit: "2", includeTotal };
  const first = await page(query);
  expect(first.body.rows).toEqual([{ container_id: 10, enabled: 1 }, { container_id: 20, enabled: 0 }]);
  expect(first.body.total).toBe(includeTotal === "false" ? null : 5);
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
  const changed = await page({ ...query, parentState: "OK", parentZip: "73001" }, { "if-none-match": tag });
  expect(ids(changed.body)).toEqual([40]);
  expect(changed.response.headers.get("etag")).not.toBe(tag);
});
it.each(["city", "state", "zip"])("recomputes sparse membership after an unprojected parent %s change", async column => {
  const query = { ...THREE, containerId: "10", fields: "enabled" };
  const first = await page(query);
  expect(first.body.rows).toEqual([{ container_id: 10, enabled: 1 }]);
  // Direct fixture mutation only; deliberately leave synced_at unchanged.
  await TEST_ENV.CUSTOMER_DB.prepare(`UPDATE address_snapshot SET ${column} = 'Moved' WHERE pickup_address_id = 11`).run();
  beforeState = await state();
  const changed = await page(query, { "if-none-match": await hash(first.bytes) });
  expect(changed.body).toEqual({ rows: [], total: 0, nextCursor: null });
  expect(changed.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
});
it("binds parent locality equality on both SELECTs and executes synthetic EXPLAIN without promising an index", async () => {
  const result = await page({ parentCity: OPAQUE, parentState: "T\tX", parentZip: "0'2139", limit: "1" });
  expect(ids(result.body)).toEqual([100]);
  expect(result.body.total).toBe(1);
  for (const { sql, binds } of result.recorder.statements) {
    const join = sql.match(/\bJOIN\s+address_snapshot(?:\s+(?:AS\s+)?(?!ON\b)(\w+))?\s+ON\b/i);
    expect(join).not.toBeNull();
    const parent = join![1] ?? "address_snapshot";
    expect(sql).toMatch(new RegExp(`\\b${parent}\\.pickup_address_id\\b`, "i"));
    for (const column of ["city", "state", "zip"]) expect(sql).toMatch(new RegExp(`\\b${parent}\\.${column}\\s*=\\s*\\?`, "i"));
    for (const value of [OPAQUE, "T\tX", "0'2139"]) {
      expect(binds).toContain(value);
      expect(sql).not.toContain(value);
    }
    expect(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP|COLLATE\s+NOCASE)\b/i);
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
describe("container parent locality: mounted machine-readable discovery", () => {
  it("publishes all three optional selectors with exact bounds and useful examples", async () => {
    const op = (await document()).paths[PATH].get;
    expect(op).toMatchObject({ operationId: "listContainerSnapshot", "x-effect": "local-read", "x-access": "read" });
    for (const name of KEYS) {
      const params = op.parameters.filter(p => p.in === "query" && p.name === name);
      expect(params).toHaveLength(1);
      expect(params[0].required ?? false).toBe(false);
      expect(params[0].schema).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
      const examples = [params[0].example, params[0].schema.example, ...Object.values(params[0].examples ?? {}).map(e => e.value)];
      expect(examples.some(value => typeof value === "string" && value.trim() !== ""), name).toBe(true);
      for (const pattern of [/case.sensitive/i, /code points/i, /parent|address|site/i, /whitespace/i]) expect(params[0].description, name).toMatch(pattern);
    }
    expect(op.parameters.find(p => p.name === "parentZip")!.description).toMatch(/leading zeros/i);
    expect(op.parameters.find(p => p.name === "parentState")!.description).toMatch(/abbreviation|enum/i);
  });
  it("explains stored site locality versus equipment locality, AND scopes and value-free recovery", async () => {
    const op = (await document()).paths[PATH].get;
    for (const name of [...KEYS, "state", "zip"]) expect(op.description).toContain(name);
    expect(op.description).toMatch(/\bAND\b|intersect/i);
    expect(op.description).toMatch(/stored/i);
    expect(op.description).toMatch(/GPS|geolocation/i);
    expect(op.description).toMatch(/not|never/i);
    const recovery = op.responses["400"].description;
    for (const name of KEYS) expect(recovery).toContain(name);
    for (const pattern of [/repeat|duplicate/i, /blank|empty/i, /before.*D1/i, /application\/problem\+json/, /docs\/PROBLEMS\.md#bad-request/]) expect(recovery).toMatch(pattern);
  });
  it("adds the selectors only to the ordinary list, not the detail operation", async () => {
    const paths = (await document()).paths;
    const detail = paths["/api/v1/container-snapshot/{containerId}"].get;
    const names = detail.parameters.map(p => p.name);
    for (const name of KEYS) expect(names).not.toContain(name);
  });
  it("retains every existing query and aligns the served inventory with the canonical query-policy table", async () => {
    const op = (await document()).paths[PATH].get;
    const names = op.parameters.filter(p => p.in === "query").map(p => p.name).sort();
    for (const key of [...KEYS, "parentRouteId", "parentFranchiseId", "parentEnabled", "customerId", "pickupAddressId", "containerId", "ids", "serialNumber", "rfid", "zip", "locationAddress", "state", "q", "enabled", "upperId", "lowerId", "order", "cursor", "offset", "includeTotal", "exactNext", "countOnly", "fields", "limit", "strictQuery"]) expect(names).toContain(key);
    const row = policyDoc.split("\n").find(line => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    expect([...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map(m => m[1]).sort()).toEqual(names);
  });
});
