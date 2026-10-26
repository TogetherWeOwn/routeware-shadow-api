import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent Test-Author oracle; all expected IDs/pages are hand-derived.
 * Mutation targets: ignored/reversed/swapped presence selectors; NULL/empty
 * conflation; whitespace-only treated as absent; OR leakage; COUNT/page drift;
 * joins that drop orphans; lost next-link scopes, unsafe reflection, stale
 * sparse ETags and auth bypass.
 * Real local D1 evaluates product SQL. Only fixture setup may write. Requests
 * deny D1 writes/batch/exec, R2, browser and fetch; no production/staging probes.
 * Builder: incorporate this test commit unchanged; oracle corrections stay
 * Test-Author-owned. Expected RED until the paired implementation arrives.
 * Run: npx vitest run test/containerInspectionPresence.acceptance.test.ts --maxWorkers=2
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/container-snapshot";
const ORIGIN = "https://container-inspection.test.invalid";
const STAMP = "2026-01-02T03:04:05.000Z";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
type Query = Record<string, string> | string | URL;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
// Parent: id, customer, scalar route, opaque franchise, parent enabled.
const PARENTS = [
  [11, 1, 7, "001", 1], [12, 1, 8, "002", 0], [13, 2, 7, "001", 1],
] as const;
// Container: id, parent, compactor text, enclosure text, equipment enabled.
const COMPACTOR: Record<number, string | null> = {
  101: "2026-01-05", 102: "2026-01-05", 103: null, 104: null, 105: "", 106: "",
  107: null, 108: "   ", 109: null, 110: "  2026-03-01  ", 111: "2026-04-01",
  112: null, 113: "2026-05-01", 114: null,
};
const ENCLOSURE: Record<number, string | null> = {
  101: "2026-02-06", 102: null, 103: "2026-02-06", 104: null, 105: "", 106: null,
  107: "", 108: null, 109: "\t\n ", 110: " x ", 111: "2026-04-02",
  112: null, 113: null, 114: "",
};
const CONTAINERS = [
  [101, 11, 1], [102, 11, 0], [103, 11, 1], [104, 11, 1], [105, 11, 1],
  [106, 11, 0], [107, 11, 1], [108, 11, 1], [109, 11, 1], [110, 11, 1],
  [111, 12, 1], [112, 12, 0], [113, 13, 1], [114, 13, 1],
] as const;
const ALL = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114];
// Present means stored text IS NOT NULL AND <> ''; nonempty whitespace-only
// stored text counts as present. False is the exact null-or-empty complement.
const COMPACTOR_TRUE = [101, 102, 108, 110, 111, 113];
const COMPACTOR_FALSE = [103, 104, 105, 106, 107, 109, 112, 114];
const ENCLOSURE_TRUE = [101, 103, 109, 110, 111];
const ENCLOSURE_FALSE = [102, 104, 105, 106, 107, 108, 112, 113, 114];
const ids = (body: Body) => body.rows.map(row => row.container_id);
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
let denied: string[];
let beforeState: unknown;

function recordedDb() {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const forbid = (operation: string): never => {
    denied.push(operation);
    throw new Error("Unexpected effect in container inspection oracle");
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
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Inspection-oracle", ...options.headers });
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
  expect(response.headers.get("x-request-id")).toBe("Inspection-oracle");
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
const ANY_DEFAULTED = ["parentEnabled", "enabled", "hasCompactorInspection", "hasEnclosureInspection"];
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
    if (ANY_DEFAULTED.includes(key) && value === "any") expect(url.searchParams.has(key)).toBe(false);
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
  vi.stubGlobal("fetch", vi.fn(async () => { denied.push("network"); throw new Error("Unexpected outbound network in inspection oracle"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, enabled, synced_at) VALUES (1, 1, ?), (2, 1, ?)").bind(STAMP, STAMP),
  ]);
  await db.batch(PARENTS.map(row => db.prepare(
    "INSERT INTO address_snapshot (pickup_address_id, customer_id, route_id, franchise_id, enabled, address, city, zip, synced_at) VALUES (?, ?, ?, ?, ?, 'Parent Depot', 'Parent City', '99999', ?)",
  ).bind(...row, STAMP)));
  await db.batch([...CONTAINERS].reverse().map(([id, parent, enabled]) => db.prepare(
    "INSERT INTO container_snapshot (container_id, pickup_address_id, enabled, ud_last_compactor_inspection_ud, ud_last_enclosure_inspection_ud, ud_material_stream_ud, color, location_address, city, state, zip, serial_number, rfid, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(
    id, parent, enabled, COMPACTOR[id], ENCLOSURE[id],
    id === 111 || id === 112 ? "MSW" : id === 113 ? "C&D" : null,
    id === 111 || id === 113 ? "Blue" : id === 112 ? "Red" : null,
    id <= 110 ? "Core Bay" : `Depot ${id}`,
    id <= 110 ? "Core City" : id <= 112 ? "Depot City" : "Harbor City",
    id <= 110 ? "ZZ" : id <= 112 ? "TX" : "CA",
    id <= 110 ? "99999" : id <= 112 ? "02139" : "90001",
    id <= 110 ? "SN-CORE" : `SN-${id}`, id <= 110 ? "TAG-CORE" : `RF-${id}`,
    STAMP)));
  beforeState = await state();
});
afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denied).toEqual([]);
    expect(await state(), "HTTP GET must not mutate the synthetic snapshot").toEqual(beforeState);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe("container inspection presence: stored text is countable without reading values", () => {
  it.each([
    ["compactor present", { hasCompactorInspection: "true" }, COMPACTOR_TRUE],
    ["compactor absent", { hasCompactorInspection: "false" }, COMPACTOR_FALSE],
    ["enclosure present", { hasEnclosureInspection: "true" }, ENCLOSURE_TRUE],
    ["enclosure absent", { hasEnclosureInspection: "false" }, ENCLOSURE_FALSE],
    ["both present", { hasCompactorInspection: "true", hasEnclosureInspection: "true" }, [101, 110, 111]],
    ["compactor only", { hasCompactorInspection: "true", hasEnclosureInspection: "false" }, [102, 108, 113]],
    ["enclosure only", { hasCompactorInspection: "false", hasEnclosureInspection: "true" }, [103, 109]],
    ["neither", { hasCompactorInspection: "false", hasEnclosureInspection: "false" }, [104, 105, 106, 107, 112, 114]],
  ] as const)("%s", async (_name, filters, want) => {
    for (const includeTotal of ["true", "false"]) {
      const result = await page({ ...filters, includeTotal });
      expect(ids(result.body)).toEqual([...want]);
      expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
      expect(result.body.nextCursor).toBeNull();
      expect(result.response.headers.get("link")).toBeNull();
    }
  });
  it("counts whitespace-only stored text as present and empty string as absent", async () => {
    expect(ids((await page({ hasCompactorInspection: "true" })).body)).toContain(108);
    expect(ids((await page({ hasEnclosureInspection: "true" })).body)).toContain(109);
    expect(ids((await page({ hasCompactorInspection: "false" })).body)).toEqual(expect.arrayContaining([105, 106]));
    expect(ids((await page({ hasEnclosureInspection: "false" })).body)).toEqual(expect.arrayContaining([105, 107, 114]));
    expect(ids((await page({ hasCompactorInspection: "false" })).body)).not.toContain(108);
    expect(ids((await page({ hasEnclosureInspection: "false" })).body)).not.toContain(109);
  });
  it("omission and any preserve the same old no-join list and full stored row", async () => {
    const plain = await page();
    const any = await page({ hasCompactorInspection: "any", hasEnclosureInspection: "any", enabled: "any" });
    expect(ids(plain.body)).toEqual(ALL);
    expect(any.body).toEqual(plain.body);
    expect(any.recorder.statements).toEqual(plain.recorder.statements);
    expect(plain.body.rows[0]).toMatchObject({ container_id: 101, pickup_address_id: 11, ud_last_compactor_inspection_ud: "2026-01-05", ud_last_enclosure_inspection_ud: "2026-02-06", enabled: 1, synced_at: STAMP });
    expect(Object.keys(plain.body.rows[0])).not.toContain("hasCompactorInspection");
    expect(Object.keys(plain.body.rows[0])).not.toContain("hasEnclosureInspection");
  });
  it.each([
    ["true", "true", [101, 108, 110, 111, 113]], ["true", "false", [102]],
    ["false", "true", [103, 104, 105, 107, 109, 114]], ["false", "false", [106, 112]],
  ] as const)("compactor=%s keeps equipment enabled=%s independent", async (presence, enabled, want) => {
    const result = await page({ hasCompactorInspection: presence, enabled });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
  });
  it("is idempotent and never logs successful presence selections", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const first = await page({ hasCompactorInspection: "true", hasEnclosureInspection: "false" });
    const second = await page({ hasCompactorInspection: "true", hasEnclosureInspection: "false" });
    expect(ids(first.body)).toEqual([102, 108, 113]);
    expect(second.body).toEqual(first.body);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
});

describe.each(["true", "false"])("container inspection presence: intersection includeTotal=%s", includeTotal => {
  it.each([
    [{}, COMPACTOR_TRUE],
    [{ hasEnclosureInspection: "true" }, [101, 110, 111]],
    [{ hasEnclosureInspection: "false" }, [102, 108, 113]],
    [{ customerId: "1" }, [101, 102, 108, 110, 111]],
    [{ customerId: "2" }, [113]],
    [{ pickupAddressId: "11" }, [101, 102, 108, 110]],
    [{ pickupAddressId: "12" }, [111]],
    [{ containerId: "108" }, [108]],
    [{ containerId: "103" }, []],
    [{ ids: "101,103,105,108,113" }, [101, 108, 113]],
    [{ ids: "103,104,105" }, []],
    [{ serialNumber: "SN-111" }, [111]],
    [{ serialNumber: "SN-CORE" }, [101, 102, 108, 110]],
    [{ rfid: "TAG-CORE" }, [101, 102, 108, 110]],
    [{ rfid: "RF-113" }, [113]],
    [{ materialStream: "MSW" }, [111]],
    [{ materialStream: "C&D" }, [113]],
    [{ color: "Blue" }, [111, 113]],
    [{ color: "Red" }, []],
    [{ zip: "02139" }, [111]],
    [{ zip: "99999" }, [101, 102, 108, 110]],
    [{ locationAddress: "Core Bay" }, [101, 102, 108, 110]],
    [{ state: "CA" }, [113]],
    [{ q: "depot" }, [111, 113]],
    [{ q: "core" }, [101, 102, 108, 110]],
    [{ q: "synthetic-no-match" }, []],
    [{ enabled: "false" }, [102]],
    [{ parentRouteId: "7" }, [101, 102, 108, 110, 113]],
    [{ parentRouteId: "8" }, [111]],
    [{ parentFranchiseId: "001" }, [101, 102, 108, 110, 113]],
    [{ parentFranchiseId: "002" }, [111]],
    [{ parentEnabled: "false" }, [111]],
    [{ parentEnabled: "true" }, [101, 102, 108, 110, 113]],
    [{ upperId: "108" }, [101, 102, 108]],
    [{ cursor: "108" }, [110, 111, 113]],
    [{ order: "desc", cursor: "108" }, [102, 101]],
  ] as const)("compactor=true AND-composes %j", async (filters, want) => {
    const result = await page({ hasCompactorInspection: "true", ...filters, includeTotal });
    expect(ids(result.body)).toEqual([...want]);
    expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
  });
  it.each([
    [{}, ENCLOSURE_TRUE],
    [{ hasCompactorInspection: "true" }, [101, 110, 111]],
    [{ hasCompactorInspection: "false" }, [103, 109]],
    [{ customerId: "1" }, [101, 103, 109, 110, 111]],
    [{ customerId: "2" }, []],
    [{ pickupAddressId: "12" }, [111]],
    [{ ids: "101,103,105,108,113" }, [101, 103]],
    [{ materialStream: "MSW", color: "Blue" }, [111]],
    [{ materialStream: "MSW", color: "Red" }, []],
    [{ state: "TX" }, [111]],
    [{ zip: "99999" }, [101, 103, 109, 110]],
    [{ locationAddress: "Depot 111" }, [111]],
    [{ q: "depot" }, [111]],
    [{ q: "core" }, [101, 103, 109, 110]],
    [{ serialNumber: "SN-CORE", rfid: "TAG-CORE" }, [101, 103, 109, 110]],
    [{ enabled: "false" }, []],
    [{ parentRouteId: "7", parentFranchiseId: "001", parentEnabled: "true" }, [101, 103, 109, 110]],
    [{ parentEnabled: "false" }, [111]],
    [{ upperId: "103" }, [101, 103]],
    [{ cursor: "103" }, [109, 110, 111]],
    [{ order: "desc", cursor: "109" }, [103, 101]],
  ] as const)("enclosure=true AND-composes %j", async (filters, want) => {
    const result = await page({ hasEnclosureInspection: "true", ...filters, includeTotal });
    expect(ids(result.body)).toEqual([...want]);
    expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
  });
  it.each([
    [{ hasCompactorInspection: "false", customerId: "2" }, [114]],
    [{ hasCompactorInspection: "false", hasEnclosureInspection: "false", parentRouteId: "8" }, [112]],
    [{ hasCompactorInspection: "false", hasEnclosureInspection: "false", parentEnabled: "true" }, [104, 105, 106, 107, 114]],
    [{ hasCompactorInspection: "false", q: "core" }, [103, 104, 105, 106, 107, 109]],
    [{ hasEnclosureInspection: "false", rfid: "TAG-CORE" }, [102, 104, 105, 106, 107, 108]],
    [{ hasEnclosureInspection: "false", state: "CA" }, [113, 114]],
  ] as const)("absent cohorts AND-compose %j", async (filters, want) => {
    const result = await page({ ...filters, includeTotal });
    expect(ids(result.body)).toEqual([...want]);
    expect(result.body.total).toBe(includeTotal === "false" ? null : want.length);
  });
});

describe("container inspection presence: shared COUNT/page predicates and count modes", () => {
  it.each([
    ["true", "true"], ["true", "false"], ["false", "true"], ["false", "false"],
  ] as const)("uses identical WHERE/binds for COUNT and page at %s/%s", async (compactor, enclosure) => {
    const result = await page({ hasCompactorInspection: compactor, hasEnclosureInspection: enclosure, customerId: "1", q: "core", enabled: "true", upperId: "110", limit: "1" });
    const count = result.recorder.statements.find(isCount)!;
    const select = result.recorder.statements.find(s => !isCount(s))!;
    const where = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).replace(/\s+ORDER\s+BY[\s\S]*$/i, "").trim();
    expect(where(count.sql)).toBe(where(select.sql));
    expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
    expect(select.binds.length - count.binds.length).toBeLessThanOrEqual(2);
  });
  it.each([
    [{ hasCompactorInspection: "true" }, 6], [{ hasCompactorInspection: "false" }, 8],
    [{ hasEnclosureInspection: "true" }, 5], [{ hasEnclosureInspection: "false" }, 9],
    [{ hasCompactorInspection: "true", hasEnclosureInspection: "true" }, 3],
    [{ hasCompactorInspection: "false", hasEnclosureInspection: "false" }, 6],
    [{ hasCompactorInspection: "true", customerId: "2" }, 1],
    [{ hasEnclosureInspection: "true", parentRouteId: "8" }, 1],
  ] as const)("countOnly counts %j with one COUNT, no rows and no Link", async (filters, total) => {
    const result = await request({ ...filters, countOnly: "true" });
    expect(result.response.status).toBe(200);
    posture(result.response);
    expect(result.recorder.statements).toHaveLength(1);
    expect(result.recorder.statements.filter(isCount)).toHaveLength(1);
    expect(await result.response.json()).toEqual({ rows: [], total, nextCursor: null });
    expect(result.response.headers.get("link")).toBeNull();
  });
  it("countOnly keeps the representation ETag and replays a 304", async () => {
    const first = await request({ hasCompactorInspection: "true", hasEnclosureInspection: "true", countOnly: "true" });
    expect(first.response.status).toBe(200);
    const bytes = await first.response.text();
    expect(JSON.parse(bytes)).toEqual({ rows: [], total: 3, nextCursor: null });
    const tag = await hash(bytes);
    expect(first.response.headers.get("etag")).toBe(tag);
    const replay = await request({ hasCompactorInspection: "true", hasEnclosureInspection: "true", countOnly: "true" }, { headers: { "if-none-match": tag } });
    expect(replay.response.status).toBe(304);
    expect(await replay.response.text()).toBe("");
    expect(replay.response.headers.get("etag")).toBe(tag);
  });
  it("count-free pages share the exact row SELECT with counted pages", async () => {
    const counted = await page({ hasCompactorInspection: "true", hasEnclosureInspection: "any", limit: "2" });
    const free = await page({ hasCompactorInspection: "true", hasEnclosureInspection: "any", limit: "2", includeTotal: "false" });
    expect(ids(free.body)).toEqual([101, 102]);
    expect(free.body.total).toBeNull();
    expect(free.body.rows).toEqual(counted.body.rows);
    expect(free.body.nextCursor).toBe(counted.body.nextCursor);
    expect(free.recorder.statements[0]).toEqual(counted.recorder.statements.find(s => !isCount(s)));
  });
  it("filters before sparse projection and always keeps the canonical ID", async () => {
    const present = await page({ hasCompactorInspection: "true", hasEnclosureInspection: "true", fields: "enabled" });
    expect(present.body.rows).toEqual([
      { container_id: 101, enabled: 1 }, { container_id: 110, enabled: 1 }, { container_id: 111, enabled: 1 },
    ]);
    const absent = await page({ hasEnclosureInspection: "false", fields: "city" });
    expect(absent.body.rows).toEqual([
      { container_id: 102, city: "Core City" }, { container_id: 104, city: "Core City" },
      { container_id: 105, city: "Core City" }, { container_id: 106, city: "Core City" },
      { container_id: 107, city: "Core City" }, { container_id: 108, city: "Core City" },
      { container_id: 112, city: "Depot City" }, { container_id: 113, city: "Harbor City" },
      { container_id: 114, city: "Harbor City" },
    ]);
  });
});

describe.each(["true", "false"])("container inspection presence: followed links includeTotal=%s", includeTotal => {
  it.each(["asc", "desc"])("traverses every %s page and omits unknown values/origins", async order => {
    const filters = { hasCompactorInspection: "true", hasEnclosureInspection: "any", parentRouteId: "7", customerId: "1", q: " core ", fields: "enabled,city", limit: "2", includeTotal, order, unknown: "private-marker", redirect: "https://untrusted.invalid/private" };
    let result = await page(filters);
    const pages = order === "asc" ? [[101, 102], [108, 110], []] : [[110, 108], [102, 101], []];
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
    expect(seen).toEqual(order === "asc" ? [101, 102, 108, 110] : [110, 108, 102, 101]);
    expect(new Set(seen).size).toBe(4);
  });
  it.each([
    ["asc", { offset: "1" }, [103, 109], 5, 109, [110, 111]],
    ["desc", { offset: "1" }, [110, 109], 5, 109, [103, 101]],
    ["asc", { cursor: "103", offset: "999" }, [109, 110], 3, 110, [111]],
    ["desc", { cursor: "109", offset: "999" }, [103, 101], 2, 101, []],
  ] as const)("%s offset/seek %j", async (order, paging, want, total, cursor, following) => {
    const result = await page({ hasEnclosureInspection: "true", order, ...paging, limit: "2", includeTotal });
    expect(ids(result.body)).toEqual([...want]);
    expect(result.body.total).toBe(includeTotal === "false" ? null : total);
    expect(result.body.nextCursor).toBe(cursor);
    if ("cursor" in paging) for (const s of result.recorder.statements) expect(s.sql).not.toMatch(/\bOFFSET\b/i);
    const followed = await page(next(result));
    expect(ids(followed.body)).toEqual([...following]);
    if (following.length === 0) expect(followed.response.headers.get("link")).toBeNull();
  });
  it.each(["asc", "desc"])("retains both presence controls through the terminal %s page", async order => {
    const first = await page({ hasCompactorInspection: "true", hasEnclosureInspection: "true", limit: "1", order, includeTotal });
    expect(ids(first.body)).toEqual(order === "asc" ? [101] : [111]);
    const target = next(first);
    expect(target.searchParams.get("hasCompactorInspection")).toBe("true");
    expect(target.searchParams.get("hasEnclosureInspection")).toBe("true");
    const second = await page(target);
    expect(ids(second.body)).toEqual(order === "asc" ? [110] : [110]);
    const last = await page(next(second));
    expect(ids(last.body)).toEqual(order === "asc" ? [111] : [101]);
    const empty = await page(next(last));
    expect(empty.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(empty.response.headers.get("link")).toBeNull();
  });
  it("retains false presence and omits any/default on continuation", async () => {
    const first = await page({ hasCompactorInspection: "false", hasEnclosureInspection: "false", limit: "2", includeTotal });
    expect(ids(first.body)).toEqual([104, 105]);
    const target = next(first);
    expect(target.searchParams.get("hasCompactorInspection")).toBe("false");
    expect(target.searchParams.get("hasEnclosureInspection")).toBe("false");
    expect(ids((await page(target)).body)).toEqual([106, 107]);
    const any = await page({ hasCompactorInspection: "any", hasEnclosureInspection: "any", limit: "13", includeTotal });
    expect(ids(any.body)).toEqual(ALL.slice(0, 13));
    const anyTarget = next(any);
    expect(anyTarget.searchParams.has("hasCompactorInspection")).toBe(false);
    expect(anyTarget.searchParams.has("hasEnclosureInspection")).toBe(false);
    expect(ids((await page(anyTarget)).body)).toEqual([114]);
  });
});

const invalid = [
  ...["", "TRUE", "False", "Any", "1", "0", " true", "false ", "any\n", "true,false", "null", "secret-marker-xyz"].map(value => [`hasCompactorInspection=${encodeURIComponent(value)}`, "hasCompactorInspection"]),
  ["hasCompactorInspection", "hasCompactorInspection"],
  ["hasCompactorInspection=any&hasCompactorInspection=any", "hasCompactorInspection"],
  ["hasCompactorInspection=true&hasCompactorInspection=false", "hasCompactorInspection"],
  ["hasCompactorInspection=&hasCompactorInspection=true", "hasCompactorInspection"],
  ["hasCompactorInspection=true&hasCompactor%49nspection=true", "hasCompactorInspection"],
  ...["", "TRUE", "False", "Any", "1", "0", " true", "false ", "any\n", "true,false", "null", "secret-marker-xyz"].map(value => [`hasEnclosureInspection=${encodeURIComponent(value)}`, "hasEnclosureInspection"]),
  ["hasEnclosureInspection", "hasEnclosureInspection"],
  ["hasEnclosureInspection=any&hasEnclosureInspection=any", "hasEnclosureInspection"],
  ["hasEnclosureInspection=true&hasEnclosureInspection=false", "hasEnclosureInspection"],
  ["hasEnclosureInspection=&hasEnclosureInspection=true", "hasEnclosureInspection"],
  ["hasEnclosureInspection=true&hasEnclosure%49nspection=true", "hasEnclosureInspection"],
];
describe("container inspection presence: value-free validation before D1, after authentication", () => {
  it.each(invalid)("rejects query %s even on conditional GET", async (query, key) => {
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
  it.each([null, "invalid-read-token"])("authenticates %s before malformed presence query/304 handling", async token => {
    const result = await request("hasCompactorInspection=private-marker&hasEnclosureInspection=&strictQuery=invalid", { token, headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(401);
    expect(await result.response.json()).toMatchObject({ status: 401, title: "Unauthorized" });
    expect(result.recorder.prepared).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
  });
  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("preserves authorized read access via %s", async token => {
    const result = await request({ hasCompactorInspection: "true", hasEnclosureInspection: "true" }, { token });
    expect(result.response.status).toBe(200);
    expect(ids(await result.response.json() as Body)).toEqual([101, 110, 111]);
  });
  it("does not reflect successful or rejected presence selectors in logs/errors", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map(method => vi.spyOn(console, method));
    const first = await page({ hasCompactorInspection: "true" });
    expect(ids(first.body)).toEqual(COMPACTOR_TRUE);
    const marker = "synthetic-private-presence-marker";
    const rejected = await request({ hasEnclosureInspection: marker });
    expect(rejected.response.status).toBe(400);
    expect(await rejected.response.text()).not.toContain(marker);
    expect(rejected.recorder.prepared).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it("unknown keys remain ignored but are not reflected in next links", async () => {
    const filters = { hasCompactorInspection: "true", limit: "1" };
    const plain = await page(filters);
    const unknown = await page({ ...filters, unknown: "private-marker" });
    expect(unknown.body).toEqual(plain.body);
    expect(unknown.recorder.statements).toEqual(plain.recorder.statements);
    next(unknown);
  });
  it("retains old validation caps and sparse-field rejection before D1", async () => {
    const invalidLegacy: Record<string, string>[] = [{ limit: "501" }, { fields: "hasCompactorInspection" }, { fields: "hasEnclosureInspection" }];
    for (const filters of invalidLegacy) {
      const result = await request({ hasCompactorInspection: "true", ...filters });
      expect(result.response.status).toBe(400);
      expect(result.recorder.prepared).toEqual([]);
    }
  });
  it("composes strictQuery=true with both presence selectors", async () => {
    const result = await page({ hasCompactorInspection: "true", hasEnclosureInspection: "false", strictQuery: "true" });
    expect(ids(result.body)).toEqual([102, 108, 113]);
    expect(result.body.total).toBe(3);
  });
});

it.each(["true", "false"])("presence-scoped representation ETags and 304 includeTotal=%s", async includeTotal => {
  const query = { hasCompactorInspection: "true", hasEnclosureInspection: "true", fields: "enabled", limit: "2", includeTotal };
  const first = await page(query);
  expect(first.body.rows).toEqual([{ container_id: 101, enabled: 1 }, { container_id: 110, enabled: 1 }]);
  expect(first.body.total).toBe(includeTotal === "false" ? null : 3);
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
  const changed = await page({ ...query, hasEnclosureInspection: "false" }, { "if-none-match": tag });
  expect(ids(changed.body)).toEqual([102, 108]);
  expect(changed.response.headers.get("etag")).not.toBe(tag);
  const projected = await page({ ...query, fields: "city" }, { "if-none-match": tag });
  expect(projected.response.headers.get("etag")).not.toBe(tag);
});
it.each([
  ["hasCompactorInspection", "true", "ud_last_compactor_inspection_ud", "ud_last_enclosure_inspection_ud"],
  ["hasCompactorInspection", "false", "ud_last_compactor_inspection_ud", "ud_last_enclosure_inspection_ud"],
  ["hasEnclosureInspection", "true", "ud_last_enclosure_inspection_ud", "ud_last_compactor_inspection_ud"],
  ["hasEnclosureInspection", "false", "ud_last_enclosure_inspection_ud", "ud_last_compactor_inspection_ud"],
] as const)("binds only its own stored-text column for %s=%s on joined and unjoined paths", async (selector, value, column, other) => {
  const where = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).replace(/\s+ORDER\s+BY[\s\S]*$/i, "").trim();
  for (const join of [{}, { customerId: "1" }] as Record<string, string>[]) {
    const result = await page({ [selector]: value, ...join, limit: "1" });
    expect(result.response.status).toBe(200);
    for (const { sql, binds } of result.recorder.statements) {
      const predicate = where(sql);
      expect(predicate).toMatch(new RegExp(`\\b${column}\\b`, "i"));
      expect(predicate).not.toMatch(new RegExp(`\\b${other}\\b`, "i"));
      // Presence is null-or-empty complement; the empty literal must appear
      // while LIKE/GLOB wildcards and case folding must never appear.
      expect(sql).toContain("''");
      expect(sql).not.toMatch(/\b(?:LIKE|GLOB|REGEXP|COLLATE\s+NOCASE)\b/i);
      if (value === "true") expect(sql).toMatch(/\bIS\s+NOT\s+NULL\b/i);
      else expect(sql).toMatch(/\bIS\s+NULL\b|= ''|NOT\s*\(/i);
      for (const bind of binds) {
        expect(typeof bind === "string" ? bind : "").not.toMatch(/2026-|^true$|^false$|^any$/);
      }
      const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...binds).all<{ detail: string }>();
      const details = plan.results.map(row => row.detail).join("\n");
      expect(plan.results.length, `Synthetic local plan (not production latency): ${details}`).toBeGreaterThan(0);
      expect(details).toMatch(/\bSCAN\b|\bSEARCH\b/i);
    }
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
describe("container inspection presence: mounted machine-readable discovery", () => {
  it("publishes both optional selectors with exact bounds and useful examples", async () => {
    const op = (await document()).paths[PATH].get;
    expect(op).toMatchObject({ operationId: "listContainerSnapshot", "x-effect": "local-read", "x-access": "read" });
    for (const name of ["hasCompactorInspection", "hasEnclosureInspection"] as const) {
      const params = op.parameters.filter(p => p.in === "query" && p.name === name);
      expect(params).toHaveLength(1);
      expect(params[0].required ?? false).toBe(false);
      expect(params[0].schema).toMatchObject({ type: "string", enum: ["true", "false", "any"], default: "any" });
      const examples = [params[0].example, params[0].schema.example, ...Object.values(params[0].examples ?? {}).map(e => e.value)];
      expect(["true", "false", "any"]).toContain(examples.find(value => value !== undefined));
      const prose = `${params[0].description ?? ""} ${JSON.stringify(params[0].schema)}`;
      expect(prose).toMatch(/inspect/i);
      expect(prose).toMatch(/stored|mirror/i);
      expect(prose).toMatch(/one|single/i);
      expect(prose).toMatch(/omit/i);
      expect(prose).toMatch(/retry/i);
    }
  });
  it("explains mirrored report metadata, AND scopes and supported value-free recovery", async () => {
    const op = (await document()).paths[PATH].get;
    for (const name of ["hasCompactorInspection", "hasEnclosureInspection"]) expect(op.description).toContain(name);
    expect(op.description).toMatch(/\bAND\b|intersect/i);
    expect(op.description).toMatch(/mirror|stored/i);
    expect(op.description).toMatch(/report/i);
    expect(op.description).toMatch(/compliance/i);
    const recovery = op.responses["400"].description;
    for (const name of ["hasCompactorInspection", "hasEnclosureInspection"]) expect(recovery).toContain(name);
    for (const pattern of [/repeat|duplicate/i, /blank|empty/i, /before.*D1/i, /application\/problem\+json/, /docs\/PROBLEMS\.md#bad-request/]) expect(recovery).toMatch(pattern);
    expect(recovery).toMatch(/true.*false.*any/);
  });
  it("retains every existing query and aligns the served inventory with the canonical query-policy table", async () => {
    const op = (await document()).paths[PATH].get;
    const names = op.parameters.filter(p => p.in === "query").map(p => p.name).sort();
    for (const key of ["hasCompactorInspection", "hasEnclosureInspection", "customerId", "pickupAddressId", "containerId", "ids", "parentRouteId", "parentFranchiseId", "parentEnabled", "serialNumber", "rfid", "materialStream", "color", "zip", "locationAddress", "state", "q", "enabled", "upperId", "order", "cursor", "offset", "includeTotal", "fields", "limit"]) expect(names).toContain(key);
    const row = policyDoc.split("\n").find(line => line.startsWith(`| \`${PATH}\` |`));
    expect(row).toBeDefined();
    expect([...row!.split("|")[2].matchAll(/`([^`]+)`/g)].map(m => m[1]).sort()).toEqual(names);
  });
  it("CONTROL: keeps presence selectors off siblings, by-ID, export and adds no endpoint", async () => {
    const doc = await document();
    for (const path of ["/api/v1/customer-snapshot", "/api/v1/address-snapshot", `${PATH}/{containerId}`, `${PATH}/export`]) {
      const names = doc.paths[path].get.parameters?.map(p => p.name) ?? [];
      expect(names, path).not.toContain("hasCompactorInspection");
      expect(names, path).not.toContain("hasEnclosureInspection");
    }
    expect(app.routes.filter(route => /hasCompactorInspection|hasEnclosureInspection/i.test(route.path))).toEqual([]);
  });
});
