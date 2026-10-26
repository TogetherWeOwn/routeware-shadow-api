import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent Test Author oracle. Run:
 * npx vitest run test/snapshotLowerId.acceptance.test.ts --maxWorkers=2
 *
 * Mutation targets: ignored/exclusive/coerced floor; bounding a joined parent;
 * different COUNT/page predicates or binds; reversed bound on descending seeks;
 * lost bounds/selectors in Link; validation/auth bypass on conditional reads.
 * Real migrated local D1 with synthetic rows; HTTP reads deny network/R2/writes.
 * ID windows select numbers, not time, stable snapshots, deletion CDC or exactly
 * once delivery. No implementation or unmerged sibling API is supplied here.
 */
const TEST_ENV = env as unknown as Env;
const ORIGIN = "https://lower-id.test.invalid";
const TOKEN = "test-read-token";
const MAX_ID = 9007199254740991;
const PROBLEM = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
const IDS = [1, 2, 4, 6, 8, 10, 12];
// Parent ownership intentionally disagrees with primary ID order. Address 10
// has no equipment; only customers 2 and 4 have service sites.
const OWNERS = [2, 2, 4, 2, 4, 2, 2];
const PARENTS = [12, 8, 8, 6, 4, 2, 2];
type Query = Record<string, string | number>;
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[] };
type Spec = { name: "customer" | "address" | "container"; id: string; field: string; operationId: string };
const SPECS: Spec[] = [
  { name: "customer", id: "customer_id", field: "company_name", operationId: "listCustomerSnapshot" },
  { name: "address", id: "pickup_address_id", field: "address", operationId: "listAddressSnapshot" },
  { name: "container", id: "container_id", field: "location_address", operationId: "listContainerSnapshot" }
];
const pathOf = (spec: Spec) => `/api/v1/${spec.name}-snapshot`;
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
let denied: string[];
let authProbe = 0;

/** Execute actual SQL; observe all D1 entry points and reject non-read effects. */
function recordDb() {
  const methods: string[] = [];
  const statements: Statement[] = [];
  const originals = new WeakMap<D1PreparedStatement, { real: D1PreparedStatement; record: Statement }>();
  const forbid = (method: string): never => {
    denied.push(method);
    throw new Error("Effect forbidden by lowerId acceptance oracle");
  };
  function observe(record: Statement) {
    if (!/^\s*SELECT\b/i.test(record.sql)) forbid("D1 non-SELECT");
    statements.push(record);
  }
  function wrap(real: D1PreparedStatement, record: Statement): D1PreparedStatement {
    const proxy = new Proxy(real, {
      get(target, key) {
        if (key === "bind") return (...binds: unknown[]) => wrap(target.bind(...binds), { sql: record.sql, binds });
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (!["first", "all", "raw"].includes(String(key))) return forbid(`D1 ${String(key)}`);
          observe(record);
          return Reflect.apply(value, target, args);
        };
      }
    });
    originals.set(proxy, { real, record });
    return proxy;
  }
  const db = new Proxy(TEST_ENV.CUSTOMER_DB, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        methods.push(String(key));
        if (key === "prepare") {
          const sql = String(args[0]);
          if (!/^\s*SELECT\b/i.test(sql)) return forbid("D1 prepare non-SELECT");
          return wrap(target.prepare(sql), { sql, binds: [] });
        }
        if (key === "batch") {
          const batch = (args[0] as D1PreparedStatement[]).map(stmt => {
            const original = originals.get(stmt);
            if (!original) return forbid("D1 unobserved batch");
            observe(original.record);
            return original.real;
          });
          return target.batch(batch);
        }
        return forbid(`D1 ${String(key)}`);
      };
    }
  });
  return { db, methods, statements, forbid };
}

async function request(spec: Spec, query: Query | string | URL = {}, options: {
  token?: string | null; headers?: Record<string, string>;
} = {}) {
  const recorder = recordDb();
  const url = query instanceof URL ? query : new URL(pathOf(spec), ORIGIN);
  if (!(query instanceof URL)) url.search = typeof query === "string" ? query : new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)])
  ).toString();
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "synthetic-lower-id", ...options.headers });
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const external = new Proxy({}, { get() { return recorder.forbid("external binding"); } });
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: recorder.db,
    SNAPSHOTS: external as R2Bucket, BROWSER: external as Fetcher
  });
  return { response, recorder, url };
}
function posture(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("x-request-id")).toBe("synthetic-lower-id");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
async function page(spec: Spec, query: Query | URL = {}, headers?: Record<string, string>) {
  const result = await request(spec, query, { headers });
  expect(result.response.status).toBe(200);
  posture(result.response);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  const bytes = await result.response.text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  return { ...result, body, bytes };
}
function members(result: Awaited<ReturnType<typeof page>>, spec: Spec, ids: number[], total: number | null, next: number | null) {
  expect(result.body.rows.map(row => row[spec.id])).toEqual(ids);
  expect(result.body.total).toBe(total);
  expect(result.body.nextCursor).toBe(next);
}
function budget(result: Awaited<ReturnType<typeof request>>, spec: Spec) {
  const q = result.url.searchParams;
  const counted = q.get("includeTotal") !== "false";
  const countOnly = q.get("countOnly") === "true";
  const statements = result.recorder.statements;
  expect(result.recorder.methods.every(method => ["prepare", "batch"].includes(method))).toBe(true);
  expect(statements).toHaveLength(countOnly ? 1 : counted ? 2 : 1);
  expect(statements.filter(isCount)).toHaveLength(counted ? 1 : 0);
  for (const s of statements) {
    const sql = s.sql.replace(/["`\[\]]/g, "");
    expect(sql).toMatch(/^\s*SELECT\b/i);
    expect(sql).not.toMatch(/\b(?:MAX|MIN)\s*\(|\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i);
    for (const [key, operator] of [["lowerId", ">="], ["upperId", "<="]]) {
      const pattern = new RegExp(`\\b${spec.id}\\s*${operator}\\s*\\?`, "i");
      if (!q.has(key)) { expect(sql).not.toMatch(pattern); continue; }
      const match = pattern.exec(sql);
      expect(match, `${key} must bind the resource primary key in every read`).not.toBeNull();
      if (match) {
        const position = (sql.slice(0, match.index).match(/\?/g) ?? []).length;
        expect(s.binds[position], `${key} bind must correspond to its placeholder`).toBe(Number(q.get(key)));
      }
    }
    if (q.has("cursor")) expect(sql).not.toMatch(/\bOFFSET\b/i);
    if (isCount(s)) expect(sql).not.toMatch(/\b(?:LIMIT|OFFSET)\b/i);
  }
  const select = statements.find(s => !isCount(s));
  const count = statements.find(isCount);
  if (countOnly) expect(select).toBeUndefined();
  if (select && count) {
    const where = (s: Statement) => s.sql.split(/\bWHERE\b/i)[1]?.split(/\bORDER\s+BY\b|\bLIMIT\b/i)[0].replace(/\s+/g, " ").trim();
    expect(where(select)).toBe(where(count));
    expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
  }
}
function next(result: Awaited<ReturnType<typeof page>>, spec: Spec) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/[^<>\s]+>; rel="next"$/);
  const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], result.url);
  expect(target.origin).toBe(result.url.origin);
  expect(target.pathname).toBe(pathOf(spec));
  expect(target.hash).toBe("");
  expect(target.searchParams.has("offset")).toBe(false);
  expect(target.searchParams.getAll("cursor")).toEqual([String(result.body.nextCursor)]);
  for (const [key, value] of result.url.searchParams) {
    if (["offset", "cursor", "unknown", "redirect"].includes(key)) continue;
    if ((key === "order" && value === "asc") || (key === "includeTotal" && value === "true") || (key === "strictQuery" && value === "false")) {
      expect([[], [value]]).toContainEqual(target.searchParams.getAll(key));
    } else expect(target.searchParams.getAll(key), key).toEqual([value]);
  }
  expect(target.searchParams.has("unknown")).toBe(false);
  expect(target.searchParams.has("redirect")).toBe(false);
  return target;
}
async function hash(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("")}"`;
}
async function insert(spec: Spec, id: number) {
  const db = TEST_ENV.CUSTOMER_DB;
  const parent = spec.name === "customer" ? "" : spec.name === "address" ? ", customer_id" : ", pickup_address_id";
  const relation = spec.name === "customer" ? "" : ", 2";
  await db.prepare(`INSERT INTO ${spec.name}_snapshot (${spec.id}, ${spec.field}, enabled, synced_at${parent}) VALUES (?, 'synthetic-arrival', 1, 'fixed'${relation})`).bind(id).run();
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  denied = [];
  vi.stubGlobal("fetch", vi.fn(async () => { denied.push("network"); throw new Error("Unexpected network in lowerId oracle"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot")
  ]);
  for (const id of [...IDS].reverse()) {
    const match = [2, 4, 8, 12].includes(id);
    const label = match ? "synthetic-needle" : "synthetic-other";
    await db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, customer_number, sub_customer_number, phone1, phone2, comments, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fixed')")
      .bind(id, label, match ? "0007" : "Other", match ? "North" : "South", match && id !== 8 ? "(555) 010-0007" : "(555) 999-9999", id === 8 ? "(555) 010-0007" : null, label, [6, 10].includes(id) ? 0 : 1).run();
  }
  for (const id of [...IDS].reverse()) {
    const match = [2, 4, 8, 12].includes(id);
    await db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, city, state, zip, route_id, franchise_id, driver_note, extras_allowed, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixed')")
      .bind(id, OWNERS[IDS.indexOf(id)], match ? "synthetic-needle" : "synthetic-other", match ? "North" : "South", match ? "ZZ" : "YY", match ? "00123" : "99999", match ? 7 : 9, match ? "0007" : "Other", match ? "synthetic needle note" : "other", match ? 1 : 0, [6, 10].includes(id) ? 0 : 1).run();
  }
  for (const id of [...IDS].reverse()) {
    const match = [2, 4, 8, 12].includes(id);
    await db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, city, state, zip, serial_number, rfid, ud_material_stream_ud, color, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixed')")
      .bind(id, PARENTS[IDS.indexOf(id)], match ? "synthetic-needle" : "synthetic-other", match ? "North" : "South", match ? "ZZ" : "YY", match ? "00123" : "99999", match ? "asset" : id === 6 ? "serial-needle" : "other", match ? "tag" : "other-tag", match ? "Recycling" : "Other", match ? "Blue" : "Other", [6, 10].includes(id) ? 0 : 1).run();
  }
});
afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(denied).toEqual([]);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

const MODES = ["omitted", "true", "false"] as const;
const modeQuery = (mode: typeof MODES[number]): Query => mode === "omitted" ? {} : { includeTotal: mode };
type Scenario = [string, Query, number[], number, number | null];
const ASC: Scenario[] = [
  ["inclusive window", {}, [4, 6], 4, 6],
  ["equal bounds", { lowerId: 6, upperId: 6, limit: 1 }, [6], 1, 6],
  ["no row at equal gap", { lowerId: 3, upperId: 3 }, [], 0, null],
  ["crossed bounds are an empty cohort", { lowerId: 10, upperId: 4 }, [], 0, null],
  ["below-window cursor", { cursor: 2 }, [4, 6], 4, 6],
  ["at-floor cursor stays exclusive", { cursor: 4 }, [6, 8], 3, 8],
  ["inside cursor partial page", { cursor: 8 }, [10], 1, null],
  ["at-ceiling cursor", { cursor: 10 }, [], 0, null],
  ["above-window cursor", { cursor: 12 }, [], 0, null],
  ["offset start", { offset: 1 }, [6, 8], 4, 8],
  ["offset beyond cohort does not alter COUNT", { offset: 4 }, [], 4, null],
  ["seek overrides offset", { cursor: 4, offset: 99 }, [6, 8], 3, 8]
];
const DESC: Scenario[] = [
  ["inclusive window", {}, [10, 8], 4, 8],
  ["equal bounds", { lowerId: 6, upperId: 6, limit: 1 }, [6], 1, 6],
  ["no row at equal gap", { lowerId: 3, upperId: 3 }, [], 0, null],
  ["crossed bounds are an empty cohort", { lowerId: 10, upperId: 4 }, [], 0, null],
  ["above-window cursor", { cursor: 12 }, [10, 8], 4, 8],
  ["at-ceiling cursor stays exclusive", { cursor: 10 }, [8, 6], 3, 6],
  ["inside cursor partial page", { cursor: 6 }, [4], 1, null],
  ["at-floor cursor", { cursor: 4 }, [], 0, null],
  ["below-window cursor", { cursor: 2 }, [], 0, null],
  ["offset start", { offset: 1 }, [8, 6], 4, 6],
  ["offset beyond cohort does not alter COUNT", { offset: 4 }, [], 4, null],
  ["seek overrides offset", { cursor: 10, offset: 99 }, [8, 6], 3, 6]
];

describe.each(SPECS)("$name: inclusive primary-ID windows", spec => {
  describe.each(MODES)("includeTotal=%s", mode => {
    describe.each(["asc", "desc"])("order=%s", order => {
      it.each(order === "asc" ? ASC : DESC)("%s", async (_label, query, ids, total, cursor) => {
        const result = await page(spec, { lowerId: 4, upperId: 10, limit: 2, order, ...modeQuery(mode), ...query });
        members(result, spec, ids, mode === "false" ? null : total, cursor);
        budget(result, spec);
      });
      it("follows every relative Link with both bounds, including the final full-page empty probe", async () => {
        let result = await page(spec, { lowerId: 4, upperId: 10, limit: 2, order, ...modeQuery(mode), fields: spec.field, strictQuery: "true" });
        const wants = order === "asc" ? [[4, 6], [8, 10], []] : [[10, 8], [6, 4], []];
        const seen: unknown[] = [];
        for (const [i, ids] of wants.entries()) {
          members(result, spec, ids, mode === "false" ? null : [4, 2, 0][i], ids.length ? ids[1] : null);
          budget(result, spec);
          for (const row of result.body.rows) expect(Object.keys(row).sort()).toEqual([spec.id, spec.field].sort());
          seen.push(...result.body.rows.map(row => row[spec.id]));
          if (i < 2) result = await page(spec, next(result, spec));
        }
        expect(seen).toEqual(order === "asc" ? [4, 6, 8, 10] : [10, 8, 6, 4]);
        expect(new Set(seen).size).toBe(4);
        expect(result.response.headers.get("link")).toBeNull();
      });
    });
    it("omitting lowerId preserves the upper-only query, bytes and no extra reads", async () => {
      const plain = await page(spec, { upperId: 10, limit: 2, ...modeQuery(mode) });
      const minimum = await page(spec, { lowerId: 1, upperId: 10, limit: 2, ...modeQuery(mode) });
      members(plain, spec, [1, 2], mode === "false" ? null : 6, 2);
      expect(minimum.bytes).toBe(plain.bytes);
      expect(minimum.response.headers.get("etag")).toBe(plain.response.headers.get("etag"));
      budget(plain, spec); budget(minimum, spec);
      expect(next(plain, spec).searchParams.has("lowerId")).toBe(false);
    });
    it.each(["asc", "desc"])("a floor needs no upper bound in %s order", async order => {
      const result = await page(spec, { lowerId: 4, limit: 10, order, ...modeQuery(mode) });
      members(result, spec, order === "asc" ? [4, 6, 8, 10, 12] : [12, 10, 8, 6, 4], mode === "false" ? null : 5, null);
      budget(result, spec);
    });
  });
  it.each([
    ["floor only", { lowerId: 4 }, 5],
    ["minimum and upper ceiling", { lowerId: 1, upperId: 4 }, 3],
    ["crossed", { lowerId: 10, upperId: 4 }, 0],
    ["equal", { lowerId: 6, upperId: 6 }, 1],
    ["ascending cursor", { lowerId: 4, upperId: 10, cursor: 6 }, 2],
    ["descending cursor", { lowerId: 4, upperId: 10, order: "desc", cursor: 6 }, 1]
  ] as Array<[string, Query, number]>)("countOnly retains %s bounds and cursor, ignoring page limit/offset", async (_label, query, total) => {
    const result = await page(spec, { ...query, countOnly: "true", limit: 1, offset: 99 });
    members(result, spec, [], total, null); budget(result, spec);
    expect(result.response.headers.get("link")).toBeNull();
  });
  it.each(["asc", "desc"])("accepts the maximum safe ID as both bounds in %s order", async order => {
    await insert(spec, MAX_ID);
    const first = await page(spec, { lowerId: MAX_ID, upperId: MAX_ID, limit: 1, order });
    members(first, spec, [MAX_ID], 1, MAX_ID); budget(first, spec);
    const last = await page(spec, next(first, spec));
    members(last, spec, [], 0, null); budget(last, spec);
  });
  it.each(["asc", "desc"])("offset-to-seek keeps both bounds and drops OFFSET in %s order", async order => {
    const first = await page(spec, { lowerId: 4, upperId: 10, offset: 1, limit: 2, order, includeTotal: "false" });
    members(first, spec, order === "asc" ? [6, 8] : [8, 6], null, order === "asc" ? 8 : 6);
    budget(first, spec);
    const last = await page(spec, next(first, spec));
    members(last, spec, order === "asc" ? [10] : [4], null, null); budget(last, spec);
    expect(last.response.headers.get("link")).toBeNull();
  });
  it.each(["asc", "desc"])("numeric windows allow in-window arrivals during %s traversal", async order => {
    const first = await page(spec, { lowerId: 4, upperId: 10, limit: 2, order });
    members(first, spec, order === "asc" ? [4, 6] : [10, 8], 4, order === "asc" ? 6 : 8);
    const target = next(first, spec);
    await insert(spec, 3); await insert(spec, 7); await insert(spec, 11);
    const second = await page(spec, target);
    members(second, spec, order === "asc" ? [7, 8] : [7, 6], 3, order === "asc" ? 8 : 6);
    budget(second, spec);
    const last = await page(spec, next(second, spec));
    members(last, spec, order === "asc" ? [10] : [4], 1, null); budget(last, spec);
    const control = await page(spec, { ids: "3,7,11" });
    members(control, spec, [3, 7, 11], 3, null);
  });
});

function selectors(spec: Spec): Array<[string, Query, number[]]> {
  const cases: Array<[string, Query, number[]]> = [
    ["IDs intersection, not selector order", { ids: "12,8,1,4" }, [4, 8]],
    ["IDs outside window", { ids: "1,2,12" }, []],
    ["enabled", { enabled: "true" }, [4, 8]],
    ["disabled", { enabled: "false" }, [6, 10]],
    ["text OR arms cannot escape the window", { q: "needle" }, spec.name === "container" ? [4, 6, 8] : [4, 8]],
    ["text plus enabled", { q: "needle", enabled: "true" }, [4, 8]],
    ["customer equality/join", { customerId: 4 }, spec.name === "customer" ? [4] : [4, 8]],
    ["combined ids/text/enabled/customer", { ids: "12,8,4,2", q: "needle", enabled: "true", customerId: 4 }, spec.name === "customer" ? [4] : [4, 8]]
  ];
  if (spec.name === "customer") cases.push(
    ["customer number", { customerNumber: "0007" }, [4, 8]],
    ["sub-customer number", { subCustomerNumber: "North" }, [4, 8]],
    ["phone, including second-phone OR arm", { phone: "010-0007" }, [4, 8]],
    ["comments", { comments: "needle" }, [4, 8]],
    ["address presence", { hasAddresses: "true" }, [4]],
    ["address absence", { hasAddresses: "false" }, [6, 8, 10]]
  );
  if (spec.name === "address") cases.push(
    ["address equality", { pickupAddressId: 8 }, [8]],
    ["route", { routeId: 7 }, [4, 8]],
    ["franchise", { franchiseId: "0007" }, [4, 8]],
    ["city", { city: "North" }, [4, 8]],
    ["state", { state: "ZZ" }, [4, 8]],
    ["zip", { zip: "00123" }, [4, 8]],
    ["driver note", { driverNote: "needle" }, [4, 8]],
    ["extras allowed", { extrasAllowed: "true" }, [4, 8]],
    ["extras disallowed", { extrasAllowed: "false" }, [6, 10]],
    ["container presence", { hasContainers: "true" }, [4, 6, 8]],
    ["container absence", { hasContainers: "false" }, [10]]
  );
  if (spec.name === "container") cases.push(
    ["parent outside window must not bound the joined key", { pickupAddressId: 2 }, [10]],
    ["equipment equality", { containerId: 6 }, [6]],
    ["serial number", { serialNumber: "asset" }, [4, 8]],
    ["RFID", { rfid: "tag" }, [4, 8]],
    ["material", { materialStream: "Recycling" }, [4, 8]],
    ["color", { color: "Blue" }, [4, 8]],
    ["own exact location", { locationAddress: "synthetic-needle" }, [4, 8]],
    ["own state", { state: "ZZ" }, [4, 8]],
    ["own zip", { zip: "00123" }, [4, 8]],
    ["parent scalar route", { parentRouteId: 7 }, [4, 8, 10]],
    ["parent franchise", { parentFranchiseId: "0007" }, [4, 8, 10]],
    ["enabled parent, independent of own enabled", { parentEnabled: "true" }, [4, 8, 10]],
    ["disabled parent", { parentEnabled: "false" }, [6]]
  );
  return cases;
}
describe.each(SPECS)("$name: lowerId composes with every merged selector", spec => {
  it.each(selectors(spec))("baseline fixture control: %s has independently verified window membership", async (_label, query, expected) => {
    // Existing ascending cursor=3 plus upperId=10 selects this fixture's 4..10
    // cohort without requiring lowerId. This green control catches fixture or
    // selector mistakes that an early missing-feature failure would otherwise hide.
    let result = await page(spec, { ...query, cursor: 3, upperId: 10, limit: 1, fields: spec.field, strictQuery: "true" });
    for (let i = 0; i <= expected.length; i++) {
      members(result, spec, i < expected.length ? [expected[i]] : [], expected.length - i, i < expected.length ? expected[i] : null);
      budget(result, spec);
      if (i < expected.length) result = await page(spec, next(result, spec));
    }
    expect(result.response.headers.get("link")).toBeNull();
  });
  it.each(selectors(spec))("retains the window and %s through both directions, total modes, sparse links and countOnly", async (_label, query, expected) => {
    for (const order of ["asc", "desc"]) {
      const ids = order === "asc" ? expected : [...expected].reverse();
      const input = { ...query, lowerId: 4, upperId: 10, order, strictQuery: "true", fields: spec.field };
      for (const includeTotal of ["true", "false"]) {
        let result = await page(spec, { ...input, includeTotal, limit: 1 });
        const seen: unknown[] = [];
        // The extra iteration is the documented full-page empty probe, not a
        // timing poll: every iteration consumes the preceding HTTP Link.
        for (let i = 0; i <= ids.length; i++) {
          members(result, spec, i < ids.length ? [ids[i]] : [], includeTotal === "false" ? null : ids.length - i, i < ids.length ? ids[i] : null);
          budget(result, spec);
          for (const row of result.body.rows) expect(Object.keys(row).sort()).toEqual([spec.id, spec.field].sort());
          seen.push(...result.body.rows.map(row => row[spec.id]));
          if (i < ids.length) result = await page(spec, next(result, spec));
        }
        expect(seen).toEqual(ids);
        expect(result.response.headers.get("link")).toBeNull();
      }
      const counted = await page(spec, { ...input, countOnly: "true", limit: 1, offset: 99 });
      members(counted, spec, [], expected.length, null); budget(counted, spec);
      expect(counted.response.headers.get("link")).toBeNull();
    }
  });
});

const INVALID = [
  "", "0", "00", "01", "0004", "+4", "-4", " 4", "4 ", "\t4", "4\n", "4\r\n",
  "4.0", "4.5", "4e0", "4E+0", "0x4", "0b100", "0o4", "Infinity", "NaN", "null", "true",
  "4,6", "4/6", "4_000", "４", "٤", "9007199254740992", "99999999999999999999999999999999",
  "synthetic-private-lower", "4 OR 1=1", "4); DROP TABLE customer_snapshot;--"
];
async function bad(spec: Spec, query: string, key = "lowerId") {
  const result = await request(spec, query, { headers: { "if-none-match": "*" } });
  expect.soft(result.recorder.methods, "validation must precede every D1 entry point").toEqual([]);
  expect(result.response.status).toBe(400);
  posture(result.response);
  expect(result.response.headers.get("content-type")).toContain("application/problem+json");
  expect(result.response.headers.get("etag")).toBeNull();
  expect(await result.response.json()).toEqual({
    type: PROBLEM, title: "Bad Request", status: 400,
    detail: `Invalid request query (${key}). See docs/PROBLEMS.md#bad-request.`
  });
}
describe.each(SPECS)("$name: canonical lowerId validation and auth precedence", spec => {
  it.each(INVALID)("rejects %j without coercion, logging values or touching D1/304", async value => {
    const logs = (["error", "warn", "info", "log", "debug"] as const).map(method => vi.spyOn(console, method));
    await bad(spec, `lowerId=${encodeURIComponent(value)}&upperId=10`);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });
  it.each(["lowerId", "lowerId=4&lowerId=4", "lowerId=4&lowerId=6", "lowerId=&lowerId=4", "lowerId=4&%6cowerId=4"])("rejects bare/repeated decoded names: %s", async query => {
    await bad(spec, query);
  });
  it("still validates lowerId in countOnly/count-free/strict modes", async () => {
    for (const mode of ["countOnly=true", "includeTotal=false", "strictQuery=true", "strictQuery=false"]) {
      await bad(spec, `lowerId=synthetic-private-lower&${mode}`);
    }
    await bad(spec, "lowerId=4&upperId=01", "upperId");
    // The countOnly=true&includeTotal=false conflict body is owned by the count-only
    // oracle (test/snapshotCountOnly.acceptance.test.ts): the hook appends fixed
    // next-action guidance, so mirror its matchers here instead of the exact body.
    const conflict = await request(spec, "lowerId=10&upperId=4&countOnly=true&includeTotal=false", { headers: { "if-none-match": "*" } });
    expect.soft(conflict.recorder.methods, "validation must precede every D1 entry point").toEqual([]);
    expect(conflict.response.status).toBe(400);
    posture(conflict.response);
    expect(conflict.response.headers.get("content-type")).toContain("application/problem+json");
    expect(conflict.response.headers.get("etag")).toBeNull();
    const conflictText = await conflict.response.text();
    expect(conflictText).toMatch(/(?:omit|remove).*includeTotal=false|includeTotal=false.*(?:omit|remove)/i);
    expect(conflictText).toMatch(/countOnly=false/);
  });
  it.each([null, "synthetic-invalid-token"])("auth wins over bounds, strictQuery and wildcard 304 for %s", async token => {
    for (const query of ["lowerId=4&upperId=10", "lowerId=synthetic-private-lower", "lowerId=4&lowerId=6", "lowerId=10&upperId=4", "lowerId=4&upperId=bad", "lowerId=0&countOnly=true", "lowerId=0&strictQuery=true&unknown=synthetic-private"]) {
      const result = await request(spec, query, { token, headers: { "if-none-match": "*", "cf-connecting-ip": `192.0.2.${++authProbe}` } });
      expect(result.response.status).toBe(401); posture(result.response);
      expect(await result.response.json()).toMatchObject({ title: "Unauthorized", status: 401 });
      expect(result.recorder.methods).toEqual([]);
    }
  });
  it.each([TOKEN, "test-api-token", "test-sync-secret"])("does not broaden read authority for %s", async token => {
    const result = await request(spec, { lowerId: 4, upperId: 10 }, { token });
    expect(result.response.status).toBe(200);
    expect((await result.response.json() as Body).rows.map(row => row[spec.id])).toEqual([4, 6, 8, 10]);
    budget(result, spec);
  });
  it("drops unknown controls from permissive continuations but rejects them before D1 in strict mode", async () => {
    const result = await page(spec, { lowerId: 4, upperId: 10, limit: 2, strictQuery: "false", unknown: "synthetic-private", redirect: "https://outside.invalid" });
    members(result, spec, [4, 6], 4, 6); budget(result, spec); next(result, spec);
    const strict = await request(spec, { lowerId: 4, upperId: 10, strictQuery: "true", unknown: "synthetic-private" }, { headers: { "if-none-match": "*" } });
    expect(strict.response.status).toBe(400);
    expect(strict.recorder.methods).toEqual([]);
    expect(await strict.response.text()).not.toContain("synthetic-private");
  });
});

describe.each(SPECS)("$name: ID-window conditional representation parity", spec => {
  it.each(["asc", "desc"])("hashes the exact %s bytes, preserves Link on 304, and reruns the same bounded SQL", async order => {
    for (const mode of MODES) {
      const shapes: Query[] = [{ fields: spec.field, limit: 2 }, { countOnly: "true" }, { lowerId: 10, upperId: 4 }];
      for (const shape of shapes) {
        if ("countOnly" in shape && mode === "false") continue;
        const query = { lowerId: 4, upperId: 10, order, ...modeQuery(mode), ...shape };
        const first = await page(spec, query);
        budget(first, spec);
        const tag = await hash(first.bytes);
        expect(first.response.headers.get("etag")).toBe(tag);
        const matching = await request(spec, query, { headers: { "if-none-match": `W/${tag}` } });
        expect(matching.response.status).toBe(304);
        expect(matching.response.body).toBeNull();
        expect(await matching.response.text()).toBe(""); posture(matching.response);
        expect(matching.response.headers.get("etag")).toBe(tag);
        expect(matching.response.headers.get("link")).toBe(first.response.headers.get("link"));
        expect(matching.recorder.statements).toEqual(first.recorder.statements); budget(matching, spec);
        const miss = await page(spec, query, { "if-none-match": '"synthetic-unmatched-window"' });
        expect(miss.bytes).toBe(first.bytes);
        expect(miss.response.headers.get("link")).toBe(first.response.headers.get("link")); budget(miss, spec);
      }
    }
  });
  it("a floor change that changes bytes cannot reuse the prior ETag", async () => {
    const before = await page(spec, { upperId: 10, fields: spec.field });
    const after = await page(spec, { lowerId: 4, upperId: 10, fields: spec.field }, { "if-none-match": before.response.headers.get("etag")! });
    members(after, spec, [4, 6, 8, 10], 4, null); budget(after, spec);
    expect(after.response.headers.get("etag")).not.toBe(before.response.headers.get("etag"));
  });
});

type Parameter = { name: string; in: string; required?: boolean; description?: string; schema?: { type?: string; minimum?: number; maximum?: number; default?: unknown; description?: string } };
type Operation = { operationId?: string; "x-access"?: string; "x-effect"?: string; parameters?: Parameter[]; responses?: Record<string, unknown> };
type Document = { paths: Record<string, Record<string, Operation>> };
async function openApi() {
  const response = await app.fetch(new Request("http://test.local/openapi.json"), TEST_ENV);
  expect(response.status).toBe(200);
  return await response.json() as Document;
}
describe("lowerId mounted machine contract", () => {
  it.each(SPECS)("publishes one optional inclusive canonical safe-integer floor on $name", async spec => {
    const operation = (await openApi()).paths[pathOf(spec)].get;
    expect(operation).toMatchObject({ operationId: spec.operationId, "x-access": "read", "x-effect": "local-read" });
    const parameters = operation.parameters?.filter(p => p.name === "lowerId") ?? [];
    expect(parameters).toHaveLength(1);
    const p = parameters[0];
    expect(p).toMatchObject({ in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: MAX_ID } });
    expect(p.schema?.default).toBeUndefined();
    const guidance = p.description ?? p.schema?.description ?? "";
    for (const pattern of [/inclusive|>=|at or above/i, /canonical|unpadded/i, /ASCII/, /9007199254740991/, /repeat|single|once/i, /400/]) expect(guidance).toMatch(pattern);
    expect(operation.responses).toHaveProperty("400");
  });
  it("does not advertise lowerId on exports, by-ID, changes, hydrated reads or POSTs", async () => {
    for (const [path, item] of Object.entries((await openApi()).paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (method === "get" && SPECS.some(spec => pathOf(spec) === path)) continue;
        expect(operation.parameters?.filter(p => p.in === "query").map(p => p.name) ?? [], `${method} ${path}`).not.toContain("lowerId");
      }
    }
  });
});
