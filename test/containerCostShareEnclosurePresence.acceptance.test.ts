import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent Test-Author oracle; all expected IDs/pages are hand-derived.
 * Mutation targets: presence tested on the wrong column or the joined parent;
 * trimming/coercing stored text (whitespace-only must count as present);
 * empty-string/NULL asymmetry between true and false; OR leakage between the
 * two controls; COUNT/page drift; lost next-link scopes, unsafe reflection,
 * stale sparse ETags and auth bypass.
 * Real local D1 evaluates product SQL. Only fixture setup may write. Requests
 * deny D1 writes/batch/exec, R2, browser and fetch; no production/staging probes.
 * Builder: incorporate this test commit unchanged; oracle corrections stay
 * Test-Author-owned. Expected RED until the paired implementation arrives.
 * Run: npx vitest run test/containerCostShareEnclosurePresence.acceptance.test.ts --maxWorkers=2
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/container-snapshot";
const ORIGIN = "https://container-presence.test.invalid";
const STAMP = "2026-01-02T03:04:05.000Z";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
type Query = Record<string, string> | string | URL;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
// Parent: id, customer, scalar route, opaque franchise, parent enabled.
const PARENTS = [
  [11, 1, 7, "001", 1], [12, 1, 7, "001", 0], [13, 2, 8, "002", 1],
] as const;
// Container: id, parent, enabled, cost-share text, enclosure-doors text,
// material stream, color, zip, serial, rfid. NULL/empty are absent; any
// nonempty text (including whitespace-only) is present.
const CONTAINERS = [
  [10, 11, 1, null, null, null, null, "02139", "asset", "tag"],
  [20, 11, 1, "", "", null, null, "02139", "asset", "tag"],
  [30, 11, 0, null, "", null, null, "02139", "asset", "tag"],
  [40, 11, 1, "", null, null, null, "02139", "asset", "tag"],
  [50, 11, 1, "   ", null, null, null, "02139", "asset", "tag"],
  [60, 11, 1, null, "\t\n", null, null, "02139", "asset", "tag"],
  [70, 11, 1, "Share-A", "Doors-A", "Stream-X", "Blue", "02139", "asset", "tag"],
  [80, 12, 1, "Share-B", null, "Stream-X", null, "99999", "asset", "tag"],
  [90, 12, 0, null, "Doors-B", "Stream-X", null, "02139", "special-90", "tag-90"],
  [100, 13, 1, "Share-C", "Doors-C", "Stream-Y", "Blue", "02139", "asset", "tag"],
  [110, 13, 1, "雪", "", null, null, "02139", "asset", "tag"],
  [120, 11, 1, " x ", "0", null, null, "02139", "asset", "tag"],
] as const;
const ALL = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
const COST = [50, 70, 80, 100, 110, 120];
const NOCOST = [10, 20, 30, 40, 60, 90];
const DOORS = [60, 70, 90, 100, 120];
const NODOORS = [10, 20, 30, 40, 50, 80, 110];
const STORED_MARKERS = ["Share-A", "Share-B", "Share-C", "Doors-A", "Doors-B", "Doors-C", "雪"];
const ids = (body: Body) => body.rows.map(row => row.container_id);
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
let denied: string[];
let beforeState: unknown;

function recordedDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const forbid = (operation: string): never => {
    denied.push(operation);
    throw new Error("Unexpected effect in container presence oracle");
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
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Presence-oracle", ...options.headers });
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
  expect(response.headers.get("x-request-id")).toBe("Presence-oracle");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
function budget(result: Awaited<ReturnType<typeof request>>) {
  const q = result.url.searchParams;
  const countFree = q.get("includeTotal") === "false";
  const countOnly = q.get("countOnly") === "true";
  const statements = result.recorder.statements;
  if (countOnly) {
    expect(statements).toHaveLength(1);
    expect(statements.filter(isCount)).toHaveLength(1);
    return;
  }
  expect(statements).toHaveLength(countFree ? 1 : 2);
  expect(statements.filter(isCount)).toHaveLength(countFree ? 0 : 1);
  const select = statements.find(s => !isCount(s))!;
  const tail = /\bOFFSET\b/i.test(select.sql) ? 2 : 1;
  expect(select.binds[select.binds.length - tail]).toBe(Number(q.get("limit") ?? 50) + (q.get("exactNext") === "true" ? 1 : 0));
  if (!countFree) expect(select.binds.slice(0, -tail)).toEqual(statements.find(isCount)!.binds);
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
  if (result.url.searchParams.get("countOnly") === "true") {
    expect(body.rows).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  }
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
    if (["hasCostShare", "hasEnclosureDoors", "parentEnabled", "enabled"].includes(key) && value === "any") expect(url.searchParams.has(key)).toBe(false);
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
  vi.stubGlobal("fetch", vi.fn(async () => { denied.push("network"); throw new Error("Unexpected outbound network in presence oracle"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, enabled, synced_at) VALUES (1, 1, ?), (2, 1, ?)").bind(STAMP, STAMP),
  ]);
  await db.batch(PARENTS.map(row => db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, enabled, address, city, zip, synced_at) VALUES (?, ?, ?, ?, ?, 'Parent Depot', 'Parent City', '99999', ?)",
  ).bind(...row, STAMP)));
  await db.batch([...CONTAINERS].reverse().map(([id, parent, enabled, cost, doors, stream, color, zip, serial, rfid]) => db.prepare(
    "INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, route_ids, frequency_ids, serial_number, rfid, location_address, city, state, zip, ud_cost_share_ud, ud_enclosure_doors_ud, ud_material_stream_ud, color, synced_at) VALUES (?, ?, ?, '8,99', '7,0', ?, ?, ?, 'Equipment City', 'ZZ', ?, ?, ?, ?, ?, ?)",
  ).bind(id, parent, enabled, serial, rfid, `Depot ${id}`, zip, cost, doors, stream, color, STAMP)));
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denied).toEqual([]);
    expect(await state(), "HTTP GET must not mutate the synthetic snapshot").toEqual(beforeState);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe("container presence: stored cost-share and enclosure-door text", () => {
  it.each([
    ["cost-share present", { hasCostShare: "true" }, COST],
    ["cost-share absent", { hasCostShare: "false" }, NOCOST],
    ["enclosure-doors present", { hasEnclosureDoors: "true" }, DOORS],
    ["enclosure-doors absent", { hasEnclosureDoors: "false" }, NODOORS],
    ["both present", { hasCostShare: "true", hasEnclosureDoors: "true" }, [70, 100, 120]],
    ["cost-only", { hasCostShare: "true", hasEnclosureDoors: "false" }, [50, 80, 110]],
    ["doors-only", { hasCostShare: "false", hasEnclosureDoors: "true" }, [60, 90]],
    ["neither", { hasCostShare: "false", hasEnclosureDoors: "false" }, [10, 20, 30, 40]],
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
    ["spaces-only cost-share counts as present", 50, "hasCostShare", "true", [50]],
    ["spaces-only cost-share is not absent", 50, "hasCostShare", "false", []],
    ["tab/newline doors count as present", 60, "hasEnclosureDoors", "true", [60]],
    ["tab/newline doors are not absent", 60, "hasEnclosureDoors", "false", []],
    ["padded and zero text are present", 120, "hasCostShare", "true", [120]],
    ["zero doors text is present", 120, "hasEnclosureDoors", "true", [120]],
    ["empty/empty row is absent on both", 20, "hasCostShare", "false", [20]],
    ["null/null row is absent on both", 10, "hasEnclosureDoors", "false", [10]],
    ["null cost-share is not present", 10, "hasCostShare", "true", []],
    ["empty doors are not present", 20, "hasEnclosureDoors", "true", []],
  ] as const)("%s", async (_name, id, key, value, want) => {
    const result = await page({ containerId: String(id), [key]: value });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
  });
  it("omission and any preserve the same old no-join list and full stored row", async () => {
    const plain = await page();
    const any = await page({ hasCostShare: "any", hasEnclosureDoors: "any" });
    expect(ids(plain.body)).toEqual(ALL);
    expect(any.body).toEqual(plain.body);
    expect(any.recorder.statements).toEqual(plain.recorder.statements);
    expect(plain.body.rows[0]).toMatchObject({ container_id: 10, pickup_address_id: 11, ud_cost_share_ud: null, ud_enclosure_doors_ud: null, city: "Equipment City", zip: "02139", enabled: 1, synced_at: STAMP });
    expect(plain.body.rows.find(row => row.container_id === 50)).toMatchObject({ ud_cost_share_ud: "   ", ud_enclosure_doors_ud: null });
    expect(Object.keys(plain.body.rows[0])).not.toContain("hasCostShare");
    expect(Object.keys(plain.body.rows[0])).not.toContain("hasEnclosureDoors");
  });
  it("keeps legacy missing/null parent links visible when no effective parent/customer scope is used", async () => {
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
      db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, route_ids, frequency_ids, ud_cost_share_ud, ud_enclosure_doors_ud, synced_at) VALUES (220, 999, 1, '7', '7', 'Share-orphan', NULL, ?), (230, NULL, 1, '7', '7', NULL, 'Doors-orphan', ?)").bind(STAMP, STAMP),
    ]);
    beforeState = await state();
    expect(ids((await page()).body)).toEqual([...ALL, 220, 230]);
    expect(ids((await page({ hasCostShare: "any", hasEnclosureDoors: "any" })).body)).toEqual([...ALL, 220, 230]);
    expect(ids((await page({ hasCostShare: "true" })).body)).toEqual([...COST, 220]);
    expect(ids((await page({ hasEnclosureDoors: "true" })).body)).toEqual([...DOORS, 230]);
    expect(ids((await page({ hasCostShare: "false" })).body)).toEqual([...NOCOST, 230]);
    expect(ids((await page({ hasEnclosureDoors: "false" })).body)).toEqual([...NODOORS, 220]);
    const scopes: Record<string, string>[] = [{ hasCostShare: "true", parentRouteId: "7" }, { hasEnclosureDoors: "true", customerId: "1" }];
    for (const filters of scopes) {
      const result = await page(filters);
      expect(ids(result.body)).not.toContain(220);
      expect(ids(result.body)).not.toContain(230);
    }
    expect(ids((await page({ containerId: "220" })).body)).toEqual([220]);
    expect(ids((await page({ containerId: "220", parentRouteId: "7" })).body)).toEqual([]);
  });
});

describe.each(["true", "false"])("container presence: intersection includeTotal=%s", includeTotal => {
  it.each([
    [{ hasCostShare: "true" }, COST],
    [{ hasEnclosureDoors: "true" }, DOORS],
    [{ hasCostShare: "true", materialStream: "Stream-X" }, [70, 80]],
    [{ hasCostShare: "false", materialStream: "Stream-X" }, [90]],
    [{ hasEnclosureDoors: "true", materialStream: "Stream-X" }, [70, 90]],
    [{ hasEnclosureDoors: "false", materialStream: "Stream-X" }, [80]],
    [{ hasCostShare: "true", hasEnclosureDoors: "true", color: "Blue" }, [70, 100]],
    [{ hasEnclosureDoors: "false", color: "Blue" }, []],
    [{ hasCostShare: "true", zip: "99999" }, [80]],
    [{ hasEnclosureDoors: "true", parentRouteId: "8" }, [100]],
    [{ hasCostShare: "false", parentEnabled: "false" }, [90]],
    [{ hasEnclosureDoors: "false", customerId: "2" }, [110]],
    [{ hasCostShare: "true", enabled: "false" }, []],
    [{ hasEnclosureDoors: "true", enabled: "false" }, [90]],
    [{ hasCostShare: "true", q: "Depot 1" }, [100, 110, 120]],
    [{ hasEnclosureDoors: "true", q: "Depot 1" }, [100, 120]],
    [{ hasEnclosureDoors: "true", q: "special-90" }, [90]],
    [{ hasCostShare: "true", parentFranchiseId: "001" }, [50, 70, 80, 120]],
    [{ hasCostShare: "false", hasEnclosureDoors: "false", serialNumber: "asset" }, [10, 20, 30, 40]],
    [{ hasEnclosureDoors: "true", rfid: "tag-90" }, [90]],
    [{ hasCostShare: "true", pickupAddressId: "11" }, [50, 70, 120]],
    [{ hasEnclosureDoors: "true", containerId: "60" }, [60]],
    [{ hasCostShare: "false", ids: "90,50,10" }, [10, 90]],
    [{ hasCostShare: "true", hasEnclosureDoors: "true", upperId: "100" }, [70, 100]],
    [{ hasCostShare: "true", hasEnclosureDoors: "true", cursor: "70" }, [100, 120]],
    [{ hasCostShare: "true", hasEnclosureDoors: "false", parentRouteId: "7", materialStream: "Stream-X" }, [80]],
    [{ hasCostShare: "true", hasEnclosureDoors: "true", parentEnabled: "false" }, []],
  ] as const)("AND-composes %j", async (filters, want) => {
    const result = await page({ ...filters, includeTotal });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
  });
});

describe("container presence: count-only parity", () => {
  it.each([
    [{ hasCostShare: "true" }, 6],
    [{ hasCostShare: "false" }, 6],
    [{ hasEnclosureDoors: "true" }, 5],
    [{ hasEnclosureDoors: "false" }, 7],
    [{ hasCostShare: "true", hasEnclosureDoors: "true" }, 3],
    [{ hasCostShare: "true", hasEnclosureDoors: "false", materialStream: "Stream-X" }, 1],
    [{ hasCostShare: "true", parentRouteId: "7", parentFranchiseId: "001", parentEnabled: "true" }, 3],
  ] as const)("countOnly %j", async (filters, total) => {
    const counted = await page({ ...filters, countOnly: "true" });
    expect(counted.body.total).toBe(total);
    const normal = await page(filters);
    expect(normal.body.total).toBe(total);
    expect(ids(normal.body)).toHaveLength(total);
  });
});

describe.each(["true", "false"])("container presence: followed links includeTotal=%s", includeTotal => {
  it.each(["asc", "desc"])("traverses every %s page, keeps the upper fence and omits unknown values/origins", async order => {
    const filters = { hasCostShare: "true", hasEnclosureDoors: "any", upperId: "100", fields: "enabled,city", limit: "2", includeTotal, order, unknown: "private-marker", redirect: "https://untrusted.invalid/private" };
    let result = await page(filters);
    const pages = order === "asc" ? [[50, 70], [80, 100], []] : [[100, 80], [70, 50], []];
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
    expect(seen).toEqual(order === "asc" ? [50, 70, 80, 100] : [100, 80, 70, 50]);
    expect(new Set(seen).size).toBe(4);
  });
  it.each([
    ["asc", { offset: "1" }, [70, 80], 6, 80, [100, 110]],
    ["desc", { offset: "1" }, [110, 100], 6, 100, [80, 70]],
    ["asc", { cursor: "80", offset: "999" }, [100, 110], 3, 110, [120]],
    ["desc", { cursor: "100", offset: "999" }, [80, 70], 3, 70, [50]],
  ] as const)("%s offset/seek %j", async (order, paging, want, total, cursor, following) => {
    const result = await page({ hasCostShare: "true", order, ...paging, limit: "2", includeTotal });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(includeTotal === "false" ? null : total);
    expect(result.body.nextCursor).toBe(cursor);
    if ("cursor" in paging) for (const s of result.recorder.statements) expect(s.sql).not.toMatch(/\bOFFSET\b/i);
    expect(ids((await page(next(result))).body)).toEqual(following);
  });
  it("carries filtering presence values while omitting any/default", async () => {
    const first = await page({ hasCostShare: "any", hasEnclosureDoors: "true", limit: "2", includeTotal });
    expect(ids(first.body)).toEqual([60, 70]);
    const target = next(first);
    expect(target.searchParams.has("hasCostShare")).toBe(false);
    expect(target.searchParams.getAll("hasEnclosureDoors")).toEqual(["true"]);
    expect(ids((await page(target)).body)).toEqual([90, 100]);
    const both = await page({ hasCostShare: "false", hasEnclosureDoors: "false", limit: "3", includeTotal });
    expect(ids(both.body)).toEqual([10, 20, 30]);
    const terminal = next(both);
    expect(terminal.searchParams.getAll("hasCostShare")).toEqual(["false"]);
    expect(terminal.searchParams.getAll("hasEnclosureDoors")).toEqual(["false"]);
    const last = await page(terminal);
    expect(ids(last.body)).toEqual([40]);
    expect(last.body.total).toBe(includeTotal === "false" ? null : 1);
  });
  it("retains false presence on continuation", async () => {
    const first = await page({ hasCostShare: "false", limit: "1", includeTotal });
    expect(ids(first.body)).toEqual([10]);
    expect(ids((await page(next(first))).body)).toEqual([20]);
  });
  it("exactNext suppresses the terminal false positive on a full last page", async () => {
    let result = await page({ hasCostShare: "true", limit: "2", exactNext: "true", includeTotal });
    expect(ids(result.body)).toEqual([50, 70]);
    result = await page(next(result));
    expect(ids(result.body)).toEqual([80, 100]);
    result = await page(next(result));
    expect(ids(result.body)).toEqual([110, 120]);
    expect(result.body.total).toBe(includeTotal === "false" ? null : 2);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  });
});

const invalid = [
  ...["", "TRUE", "False", "Any", "1", "0", " true", "false ", "any\n", "true,false"].map(value => ["hasCostShare", `hasCostShare=${encodeURIComponent(value)}`]),
  ["hasCostShare", "hasCostShare"], ["hasCostShare", "hasCostShare=true&hasCostShare=true"],
  ["hasCostShare", "hasCostShare=true&hasCostShare=false"], ["hasCostShare", "hasCostShare=&hasCostShare=true"],
  ["hasCostShare", "hasCostShare=true&hasCost%53hare=true"],
  ...["", "TRUE", "False", "Any", "1", "0", " true", "false ", "any\n", "true,false"].map(value => ["hasEnclosureDoors", `hasEnclosureDoors=${encodeURIComponent(value)}`]),
  ["hasEnclosureDoors", "hasEnclosureDoors"], ["hasEnclosureDoors", "hasEnclosureDoors=true&hasEnclosureDoors=true"],
  ["hasEnclosureDoors", "hasEnclosureDoors=true&hasEnclosureDoors=false"], ["hasEnclosureDoors", "hasEnclosureDoors=&hasEnclosureDoors=true"],
  ["hasEnclosureDoors", "hasEnclosureDoors=true&has%45nclosureDoors=true"],
];
describe("container presence: value-free validation before D1, after authentication", () => {
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
  it("rejects doubly invalid presence controls without naming values", async () => {
    const result = await request("hasCostShare=yes&hasEnclosureDoors=no");
    expect(result.response.status).toBe(400);
    const detail = ((await result.response.json()) as { detail: string }).detail;
    expect(detail).toContain("hasCostShare");
    expect(detail).toContain("hasEnclosureDoors");
    expect(detail).not.toContain("yes");
    expect(detail).not.toContain("no");
    expect(result.recorder.prepared).toEqual([]);
  });
  it.each([null, "invalid-read-token"])("authenticates %s before malformed presence query/304 handling", async token => {
    const result = await request("hasCostShare=private-marker&hasEnclosureDoors=", { token, headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toMatchObject({ status: 401, title: "Unauthorized" });
    expect(result.recorder.prepared).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
  });
  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("preserves authorized read access via %s", async token => {
    const result = await request({ hasCostShare: "true", hasEnclosureDoors: "false" }, { token });
    expect(result.response.status).toBe(200);
    expect(ids(await result.response.json() as Body)).toEqual([50, 80, 110]);
  });
  it("does not reflect successful or rejected opaque selectors in logs/errors", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const first = await page({ hasCostShare: "true" });
    expect(ids(first.body)).toEqual(COST);
    const marker = `synthetic-private-${"x".repeat(200)}`;
    const rejected = await request({ hasEnclosureDoors: marker });
    expect(rejected.response.status).toBe(400);
    expect(await rejected.response.text()).not.toContain(marker);
    expect(rejected.recorder.prepared).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it("unknown keys remain ignored but are not reflected in next links", async () => {
    const filters = { hasCostShare: "true", limit: "1" };
    const plain = await page(filters);
    const unknown = await page({ ...filters, unknown: "private-marker" });
    expect(unknown.body).toEqual(plain.body);
    expect(unknown.recorder.statements).toEqual(plain.recorder.statements);
    next(unknown);
  });
  it("retains old validation caps and sparse-field rejection before D1", async () => {
    const invalidLegacy: Record<string, string>[] = [{ limit: "501" }, { fields: "hasCostShare" }, { fields: "cost_share" }];
    for (const filters of invalidLegacy) {
      const result = await request({ hasCostShare: "true", ...filters });
      expect(result.response.status).toBe(400);
      expect(result.recorder.prepared).toEqual([]);
    }
  });
});

it.each(["true", "false"])("presence-scoped representation ETags and 304 includeTotal=%s", async includeTotal => {
  const query = { hasCostShare: "true", hasEnclosureDoors: "any", fields: "enabled", limit: "2", includeTotal };
  const first = await page(query);
  expect(first.body.rows).toEqual([{ container_id: 50, enabled: 1 }, { container_id: 70, enabled: 1 }]);
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
  const changed = await page({ ...query, hasEnclosureDoors: "true" }, { "if-none-match": tag });
  expect(ids(changed.body)).toEqual([70, 100]);
  expect(changed.response.headers.get("etag")).not.toBe(tag);
  const projected = await page({ ...query, fields: "city" }, { "if-none-match": tag });
  expect(projected.response.headers.get("etag")).not.toBe(tag);
});
it.each([
  ["ud_cost_share_ud", { hasCostShare: "true", containerId: "50" }, ""],
  ["ud_enclosure_doors_ud", { hasEnclosureDoors: "false", containerId: "50" }, "Doors-now"],
] as const)("recomputes sparse membership after an unprojected %s change", async (column, filters, value) => {
  const query = { ...filters, fields: "enabled" };
  const first = await page(query);
  expect(first.body.rows).toEqual([{ container_id: 50, enabled: 1 }]);
  // Direct fixture mutation only; deliberately leave synced_at unchanged.
  await TEST_ENV.CUSTOMER_DB.prepare(`UPDATE container_snapshot SET ${column} = ? WHERE container_id = 50`).bind(value).run();
  beforeState = await state();
  const changed = await page(query, { "if-none-match": await hash(first.bytes) });
  expect(changed.body).toEqual({ rows: [], total: 0, nextCursor: null });
  expect(changed.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
});
it("shares the presence predicate between COUNT and page and executes synthetic EXPLAIN without promising an index", async () => {
  const result = await page({ hasCostShare: "true", hasEnclosureDoors: "false", limit: "1" });
  expect(ids(result.body)).toEqual([50]);
  expect(result.body.total).toBe(3);
  expect(result.recorder.statements).toHaveLength(2);
  const whereOf = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).split(" ORDER BY ")[0];
  const [count, select] = [result.recorder.statements.find(isCount)!, result.recorder.statements.find(s => !isCount(s))!];
  expect(whereOf(select.sql)).toBe(whereOf(count.sql));
  for (const { sql, binds } of result.recorder.statements) {
    expect(sql).toMatch(/ud_cost_share_ud/i);
    expect(sql).toMatch(/ud_enclosure_doors_ud/i);
    expect(sql).not.toMatch(/\bJOIN\b/i);
    expect(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP|COLLATE\s+NOCASE)\b/i);
    for (const marker of STORED_MARKERS) {
      expect(sql).not.toContain(marker);
      expect(binds.map(String)).not.toContain(marker);
    }
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
describe("container presence: mounted machine-readable discovery", () => {
  it("publishes both optional presence selectors with exact bounds and useful examples", async () => {
    const op = (await document()).paths[PATH].get;
    expect(op).toMatchObject({ operationId: "listContainerSnapshot", "x-effect": "local-read", "x-access": "read" });
    for (const name of ["hasCostShare", "hasEnclosureDoors"]) {
      const params = op.parameters.filter(p => p.in === "query" && p.name === name);
      expect(params).toHaveLength(1);
      expect(params[0].required ?? false).toBe(false);
      expect(params[0].schema).toMatchObject({ type: "string", enum: ["true", "false", "any"], default: "any" });
      const examples = [params[0].example, params[0].schema.example, ...Object.values(params[0].examples ?? {}).map(e => e.value)];
      expect(examples.some(value => value !== undefined), name).toBe(true);
    }
    const combined = op.parameters.filter(p => p.name === "hasCostShare" || p.name === "hasEnclosureDoors").map(p => p.description ?? "").join("\n");
    for (const pattern of [/present/i, /null|empty/i, /whitespace/i]) expect(combined).toMatch(pattern);
  });
  it("explains mirrored report metadata, AND scopes and supported value-free recovery", async () => {
    const op = (await document()).paths[PATH].get;
    for (const name of ["hasCostShare", "hasEnclosureDoors"]) expect(op.description).toContain(name);
    expect(op.description).toMatch(/\bAND\b|intersect/i);
    expect(op.description).toMatch(/mirror/i);
    expect(op.description).toMatch(/infer/i);
    const recovery = op.responses["400"].description;
    for (const name of ["hasCostShare", "hasEnclosureDoors"]) expect(recovery).toContain(name);
    for (const pattern of [/repeat|duplicate/i, /blank|empty/i, /before.*D1/i, /application\/problem\+json/, /docs\/PROBLEMS\.md#bad-request/]) expect(recovery).toMatch(pattern);
    expect(recovery).toMatch(/true.*false.*any/);
  });
  it("retains every existing query and aligns the served inventory with the canonical query-policy table", async () => {
    const op = (await document()).paths[PATH].get;
    const names = op.parameters.filter(p => p.in === "query").map(p => p.name).sort();
    for (const key of ["hasCostShare", "hasEnclosureDoors", "parentRouteId", "parentFranchiseId", "parentEnabled", "customerId", "pickupAddressId", "containerId", "ids", "serialNumber", "rfid", "materialStream", "color", "zip", "locationAddress", "state", "q", "enabled", "upperId", "order", "cursor", "offset", "includeTotal", "countOnly", "exactNext", "fields", "limit", "strictQuery"]) expect(names).toContain(key);
    const row = policyDoc.split("\n").find(line => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    expect([...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map(m => m[1]).sort()).toEqual(names);
  });
});
