import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Caller-held inclusive ID ceiling, not a database snapshot or a timestamp.
 * Run: npx vitest run test/snapshotUpperId.acceptance.test.ts
 *
 * Real migrated local D1, synthetic rows, denied outbound fetch. These tests
 * catch ignored/coerced caps, a cap on the wrong joined key, uncapped COUNTs,
 * extra watermark queries, and lost caps on resume. No product implementation
 * is supplied here. Inserts below the cap, updates and deletions remain visible;
 * this promises neither snapshot isolation, exact-once delivery nor automatic
 * watermark discovery. The caller explicitly supplies and retains upperId=6.
 */
const TEST_ENV = env as unknown as Env;
const ORIGIN = "https://upper-id-client.invalid";
const REQUEST_ID = "synthetic-upper-id-request";
const READ_TOKEN = "test-read-token";
const MAX_ID = 9007199254740991;
const PROBLEM_BASE = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#";
const IDS = [2, 4, 6, 8];
const OWNERS = [2, 2, 4, 2];
// Deliberately different from container IDs: bounding the joined address key
// instead of the container primary key must not satisfy the result assertions.
const CONTAINER_PARENTS = [8, 6, 4, 2];

type Spec = {
  name: "customer" | "address" | "container";
  path: string;
  table: string;
  key: string;
  field: string;
  operationId: string;
};
const SPECS: Spec[] = [
  { name: "customer", path: "/api/v1/customer-snapshot", table: "customer_snapshot", key: "customer_id", field: "company_name", operationId: "listCustomerSnapshot" },
  { name: "address", path: "/api/v1/address-snapshot", table: "address_snapshot", key: "pickup_address_id", field: "address", operationId: "listAddressSnapshot" },
  { name: "container", path: "/api/v1/container-snapshot", table: "container_snapshot", key: "container_id", field: "location_address", operationId: "listContainerSnapshot" }
];
type Query = Record<string, string | number>;
type Statement = { sql: string; binds: unknown[] };
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Schema = { type?: string | string[]; minimum?: number; maximum?: number; default?: unknown; enum?: string[]; description?: string };
type Operation = {
  operationId: string;
  "x-access": string;
  "x-effect": string;
  parameters?: Array<{ name: string; in: string; required?: boolean; description?: string; schema?: Schema }>;
  responses?: Record<string, unknown>;
};
type Document = { paths: Record<string, { get?: Operation }> };

// Every D1 entry point is observed, not just prepare. SQL executes against the
// real database; neither filtering nor pagination is interpreted by a fake.
function observeDb() {
  const methods: string[] = [];
  const statements: Statement[] = [];
  const executions: Statement[] = [];
  const prepared = new WeakMap<D1PreparedStatement, { real: D1PreparedStatement; record: Statement }>();
  function observeStatement(real: D1PreparedStatement, record: Statement): D1PreparedStatement {
    const proxy = new Proxy(real, {
      get(statement, member) {
        const method = Reflect.get(statement, member, statement);
        if (typeof method !== "function") return method;
        return (...values: unknown[]) => {
          if (member === "bind") {
            record.binds = values;
            return observeStatement(Reflect.apply(method, statement, values), { sql: record.sql, binds: values });
          }
          if (["all", "first", "raw", "run"].includes(String(member))) executions.push({ ...record });
          return Reflect.apply(method, statement, values);
        };
      }
    });
    prepared.set(proxy, { real, record });
    return proxy;
  }
  const db = new Proxy(TEST_ENV.CUSTOMER_DB, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        methods.push(String(property));
        if (property === "batch") {
          const batch = (args[0] as D1PreparedStatement[]).map((statement) => {
            const known = prepared.get(statement);
            if (!known) throw new Error("Unobserved D1 batch statement");
            executions.push({ ...known.record });
            return known.real;
          });
          return Reflect.apply(value, target, [batch]);
        }
        const result = Reflect.apply(value, target, args);
        if (property !== "prepare") return result;
        const record = { sql: String(args[0]), binds: [] as unknown[] };
        statements.push(record);
        return observeStatement(result as D1PreparedStatement, record);
      };
    }
  });
  return { db, methods, statements, executions };
}

async function request(spec: Spec, search: string, options: {
  db?: D1Database; token?: string | null; headers?: Record<string, string>;
} = {}) {
  const headers = new Headers({ origin: ORIGIN, "x-request-id": REQUEST_ID, ...options.headers });
  const token = options.token === undefined ? READ_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return app.fetch(new Request(`http://test.local${spec.path}${search ? `?${search}` : ""}`, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: options.db ?? TEST_ENV.CUSTOMER_DB
  });
}

function commonHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
}

async function page(spec: Spec, query: Query = {}, headers: Record<string, string> = {}) {
  const observed = observeDb();
  const response = await request(spec, new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)])
  ).toString(), { db: observed.db, headers });
  expect(response.status).toBe(200);
  commonHeaders(response);
  expect(response.headers.get("content-type")).toContain("application/json");
  // ETag presence belongs to the conditional-list contract, not the ID ceiling.
  const body = await response.clone().json() as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  return { response, body, ...observed };
}

function expectPage(result: Awaited<ReturnType<typeof page>>, spec: Spec, ids: number[], total: number | null, next: number | null) {
  expect(result.body.rows.map((row) => row[spec.key])).toEqual(ids);
  expect(result.body.total).toBe(total);
  expect(result.body.nextCursor).toBe(next);
}

function expectQueries(result: Awaited<ReturnType<typeof page>>, spec: Spec, count: boolean, cap: number | null) {
  expect(result.methods.every((method) => ["prepare", "batch"].includes(method))).toBe(true);
  expect(result.executions).toHaveLength(count ? 2 : 1);
  expect(result.executions.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(count ? 1 : 0);
  for (const statement of result.executions) {
    expect(statement.sql).toMatch(/^\s*SELECT\b/i);
    expect(statement.sql).not.toMatch(/\b(?:MAX|INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i);
    const bound = new RegExp(`(?:\\b\\w+\\.)?${spec.key}\\s*<=\\s*\\?`, "i");
    if (cap !== null) {
      // Fixed resource key, parameterized inclusive bound, in COUNT and page.
      expect(statement.sql).toMatch(bound);
      expect(statement.binds).toContain(cap);
    } else {
      expect(statement.sql).not.toMatch(bound);
    }
  }
}

async function openApi(): Promise<Document> {
  const response = await app.fetch(new Request("http://test.local/openapi.json"), TEST_ENV);
  expect(response.status).toBe(200);
  return await response.json() as Document;
}

async function insert(spec: Spec, id: number) {
  const db = TEST_ENV.CUSTOMER_DB;
  if (spec.name === "customer") {
    await db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, 1, 'test')")
      .bind(id, `synthetic-insert-${id}`).run();
  } else if (spec.name === "address") {
    await db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, 2, ?, 1, 'test')")
      .bind(id, `synthetic-insert-${id}`).run();
  } else {
    await db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, enabled, synced_at) VALUES (?, 2, ?, 1, 'test')")
      .bind(id, `synthetic-insert-${id}`).run();
  }
}

beforeAll(async () => {
  await ensureD1TestTables();
});
beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("Unexpected outbound fetch in snapshot upperId acceptance test");
  }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  for (const [i, id] of IDS.entries()) {
    const label = id === 4 || id === 8 ? `synthetic-needle-${id}` : `synthetic-other-${id}`;
    await db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, ?, 'test')")
      .bind(id, label, i === 2 ? 0 : 1).run();
  }
  for (const [i, id] of IDS.entries()) {
    const label = id === 4 || id === 8 ? `synthetic-needle-${id}` : `synthetic-other-${id}`;
    await db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, ?, ?, 'test')")
      .bind(id, OWNERS[i], label, i === 2 ? 0 : 1).run();
  }
  for (const [i, id] of IDS.entries()) {
    const label = id === 4 || id === 8 ? `synthetic-needle-${id}` : `synthetic-other-${id}`;
    await db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, enabled, synced_at) VALUES (?, ?, ?, ?, ?, 'test')")
      .bind(id, CONTAINER_PARENTS[i], label, id === 6 ? "serial-needle-6" : `serial-other-${id}`, i === 2 ? 0 : 1).run();
  }
});
afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

let authProbe = 0;
const MODES = ["omitted", "true", "false"] as const;
function modeQuery(mode: typeof MODES[number]): Query {
  return mode === "omitted" ? {} : { includeTotal: mode };
}

describe.each(SPECS)("$name: caller-held upperId", (spec) => {
  it("keeps omitted-cap behavior, default total and two queries without MAX discovery", async () => {
    const result = await page(spec, { limit: 2 });
    expectPage(result, spec, [2, 4], 4, 4);
    expectQueries(result, spec, true, null);
    const explicit = await page(spec, { limit: 2, includeTotal: "true" });
    expect(await explicit.response.text()).toBe(await result.response.text());
    expect(explicit.statements).toEqual(result.statements);
  });

  it.each(MODES)("omission stays count-compatible in %s mode", async (mode) => {
    const result = await page(spec, { ...modeQuery(mode), cursor: 4, limit: 2, offset: 100 });
    expectPage(result, spec, [6, 8], mode === "false" ? null : 2, 8);
    expectQueries(result, spec, mode !== "false", null);
  });

  describe.each(MODES)("%s total mode", (mode) => {
    const query = modeQuery(mode);
    const counted = mode !== "false";
    it.each([
      ["inclusive equality", { upperId: 6, limit: 2 }, [2, 4], 3, 4],
      ["one-row equality", { upperId: 2, limit: 1 }, [2], 1, 2],
      ["empty range below first ID", { upperId: 1 }, [], 0, null],
      ["offset start", { upperId: 6, offset: 1, limit: 2 }, [4, 6], 3, 6],
      ["offset beyond cap", { upperId: 6, offset: 3, limit: 2 }, [], 3, null],
      ["cursor wins over offset", { upperId: 6, cursor: 2, offset: 100, limit: 2 }, [4, 6], 2, 6],
      ["cursor-relative partial page", { upperId: 6, cursor: 4, limit: 2 }, [6], 1, null],
      ["cursor equals ceiling", { upperId: 6, cursor: 6, limit: 2 }, [], 0, null],
      ["cursor above ceiling", { upperId: 6, cursor: 8, limit: 2 }, [], 0, null]
    ] as Array<[string, Query, number[], number, number | null]>)("%s", async (_label, input, ids, total, next) => {
      const result = await page(spec, { ...input, ...query });
      expectPage(result, spec, ids, counted ? total : null, next);
      expectQueries(result, spec, counted, Number(input.upperId));
    });

    it("resumes under the same explicit ceiling while higher arrivals cannot extend the walk", async () => {
      const first = await page(spec, { upperId: 6, limit: 2, ...query });
      expectPage(first, spec, [2, 4], counted ? 3 : null, 4);
      await insert(spec, 10); // Arrival above the caller's chosen ceiling.
      const second = await page(spec, { upperId: 6, cursor: first.body.nextCursor!, limit: 2, ...query });
      expectPage(second, spec, [6], counted ? 1 : null, null);
      expectQueries(second, spec, counted, 6);
      // Positive control: it really arrived and is visible without the cap.
      expectPage(await page(spec, { cursor: 8, ...query }), spec, [10], counted ? 1 : null, null);
    });

    it("sees inserts below the ceiling: numeric caps are not snapshot isolation or exact-once delivery", async () => {
      const first = await page(spec, { upperId: 6, limit: 2, ...query });
      expectPage(first, spec, [2, 4], counted ? 3 : null, 4);
      await insert(spec, 5);
      await insert(spec, 10);
      const second = await page(spec, { upperId: 6, cursor: first.body.nextCursor!, limit: 2, ...query });
      expectPage(second, spec, [5, 6], counted ? 2 : null, 6);
      expectPage(await page(spec, { upperId: 6, cursor: second.body.nextCursor!, limit: 2, ...query }), spec, [], counted ? 0 : null, null);
      await insert(spec, 3); // Behind the cursor: intentionally not delivered.
      expectPage(await page(spec, { upperId: 6, cursor: 6, ...query }), spec, [], counted ? 0 : null, null);
      expectPage(await page(spec, { upperId: 6, ...query }), spec, [2, 3, 4, 5, 6], counted ? 5 : null, null);
    });
  });

  it("keeps later updates and deletions visible within the chosen ID scope", async () => {
    const first = await page(spec, { upperId: 8, limit: 2 });
    expectPage(first, spec, [2, 4], 4, 4);
    const db = TEST_ENV.CUSTOMER_DB;
    await db.prepare(`UPDATE ${spec.table} SET ${spec.field} = ? WHERE ${spec.key} = ?`).bind("synthetic-updated", 6).run();
    // Address 8 has a synthetic container child; remove it before its parent.
    if (spec.name === "address") await db.prepare("DELETE FROM container_snapshot WHERE pickup_address_id = 8").run();
    await db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.key} = ?`).bind(8).run();
    const resumed = await page(spec, { upperId: 8, cursor: first.body.nextCursor!, limit: 2 });
    expectPage(resumed, spec, [6], 1, null);
    expect(resumed.body.rows[0][spec.field]).toBe("synthetic-updated");
  });

  it("accepts the maximum safe ID inclusively without coercing it", async () => {
    await insert(spec, MAX_ID);
    const inclusive = await page(spec, { upperId: MAX_ID, cursor: MAX_ID - 1, limit: 1 });
    expectPage(inclusive, spec, [MAX_ID], 1, MAX_ID);
    expectQueries(inclusive, spec, true, MAX_ID);
    const terminal = await page(spec, { upperId: MAX_ID, cursor: MAX_ID });
    expectPage(terminal, spec, [], 0, null);
    expectQueries(terminal, spec, true, MAX_ID);
  });

  it("preserves decoded repeated-key rejection on an existing query key", async () => {
    const observed = observeDb();
    const response = await request(spec, "includeTotal=false&%69ncludeTotal=false", { db: observed.db });
    expect(response.status).toBe(400);
    expect(observed.methods).toEqual([]);
    expect(await response.json()).toMatchObject({ status: 400, detail: "Invalid request query (includeTotal). See docs/PROBLEMS.md#bad-request." });
  });

  it.each(["test-api-token", READ_TOKEN, "test-sync-secret"])("keeps the existing read authority for %s", async (token) => {
    const observed = observeDb();
    const response = await request(spec, "upperId=6", { token, db: observed.db });
    expect(response.status).toBe(200);
    commonHeaders(response);
    expect((await response.json() as Body).rows.map((row) => row[spec.key])).toEqual([2, 4, 6]);
    expect(observed.statements).toHaveLength(2);
  });

  it.each(MODES)("serves the same capped envelope for a nonmatching validator in %s total mode", async (mode) => {
    const query = { ...modeQuery(mode), upperId: 6, fields: "synced_at" };
    const plain = await page(spec, query);
    // A valid opaque token that cannot match a SHA-256 representation validator.
    // Unlike '*', this must serve 200 both before and after conditional GETs land.
    const result = await page(spec, query, { "if-none-match": '"synthetic-nonmatching-upper-id-validator"' });
    expectPage(result, spec, [2, 4, 6], mode === "false" ? null : 3, null);
    expect(result.body.rows).toEqual([
      { [spec.key]: 2, synced_at: "test" }, { [spec.key]: 4, synced_at: "test" }, { [spec.key]: 6, synced_at: "test" }
    ]);
    expectQueries(result, spec, mode !== "false", 6);
    expect(await result.response.text()).toBe(await plain.response.text());
    expect(result.response.headers.get("link")).toBe(plain.response.headers.get("link"));
    expect(result.executions).toEqual(plain.executions);
  });

  it.each([null, "synthetic-invalid-token"])("auth precedes invalid upperId for token %s", async (token) => {
    for (const search of ["upperId=6", "upperId=secret-marker", "upperId=6&upperId=6", "upperId=0&cursor=bad"]) {
      const observed = observeDb();
      const response = await request(spec, search, { token, db: observed.db, headers: { "cf-connecting-ip": `192.0.2.${++authProbe}` } });
      expect(response.status).toBe(401);
      commonHeaders(response);
      expect(await response.json()).toMatchObject({ status: 401, title: "Unauthorized" });
      expect(observed.methods).toEqual([]);
    }
  });
});

const INVALID = [
  "", "0", "00", "01", "0006", "+6", "-6", " 6", "6 ", "\t6", "6\n", "6\r\n",
  "6.0", "6.5", "6e0", "6E+0", "0x6", "0b110", "0o6", "Infinity", "NaN", "null", "true",
  "6,8", "6/8", "6_000", "６", "٦", "9007199254740992", "99999999999999999999999999999999",
  "synthetic-secret-marker", "6 OR 1=1", "6); DROP TABLE customer_snapshot;--"
];
describe.each(SPECS)("$name: strict upperId validation", (spec) => {
  it.each(INVALID)("rejects canonicality/range violation %j before all D1 access", async (value) => {
    const observed = observeDb();
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((method) => vi.spyOn(console, method));
    const response = await request(spec, `upperId=${encodeURIComponent(value)}`, { db: observed.db });
    expect.soft(observed.methods, "invalid upperId must never touch D1").toEqual([]);
    expect(response.status).toBe(400);
    commonHeaders(response);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toEqual({
      type: `${PROBLEM_BASE}bad-request`, title: "Bad Request", status: 400,
      detail: "Invalid request query (upperId). See docs/PROBLEMS.md#bad-request."
    });
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each(["upperId", "upperId=6&upperId=6", "upperId=6&upperId=8", "upperId=&upperId=6", "upperId=6&%75pperId=6"])("rejects empty or repeated query %s", async (search) => {
    const observed = observeDb();
    const response = await request(spec, search, { db: observed.db });
    expect.soft(observed.methods).toEqual([]);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      type: `${PROBLEM_BASE}bad-request`, title: "Bad Request", status: 400,
      detail: "Invalid request query (upperId). See docs/PROBLEMS.md#bad-request."
    });
  });
});

function filters(spec: Spec): Array<[string, Query, number[]]> {
  const common: Array<[string, Query, number[]]> = [
    ["enabled true", { enabled: "true" }, [2, 4]],
    ["enabled false", { enabled: "false" }, [6]],
    ["q including serial-number OR arm", { q: "needle" }, spec.name === "container" ? [4, 6] : [4]],
    ["q and enabled", { q: "needle", enabled: "true" }, [4]],
    ["combined q/enabled/cursor/offset", { q: "needle", enabled: "true", cursor: 2, offset: 99 }, [4]],
    ["customer relationship", { customerId: 2 }, spec.name === "customer" ? [2] : spec.name === "address" ? [2, 4] : [2, 6]],
    ["customer above ceiling", { customerId: 8 }, []]
  ];
  if (spec.name !== "customer") common.push(["pickup address selector", { pickupAddressId: 8 }, spec.name === "container" ? [2] : []]);
  if (spec.name === "container") common.push(
    ["pickup selector above cap's container key", { pickupAddressId: 2 }, []],
    ["singular container equality", { containerId: 6 }, [6]],
    ["singular container above cap", { containerId: 8 }, []],
    ["joined customer plus address", { customerId: 2, pickupAddressId: 4 }, [6]],
    ["joined customer mismatch", { customerId: 4, pickupAddressId: 4 }, []]
  );
  return common;
}
describe.each(SPECS)("$name: cap composes without requiring ids selection", (spec) => {
  it.each(filters(spec))("retains cap with %s in both count modes and sparse projection", async (_label, query, ids) => {
    for (const includeTotal of ["true", "false"]) {
      const result = await page(spec, { ...query, upperId: 6, includeTotal, fields: spec.field, limit: 10 });
      expectPage(result, spec, ids, includeTotal === "false" ? null : ids.length, null);
      for (const row of result.body.rows) expect(Object.keys(row).sort()).toEqual([spec.key, spec.field].sort());
      expectQueries(result, spec, includeTotal !== "false", 6);
    }
  });

  it("ignores unknown names without allowing SQL-column selection or changing results", async () => {
    const plain = await page(spec, { upperId: 6, limit: 2 });
    const unknown = await page(spec, { upperId: 6, limit: 2, upperIdColumn: "customer_id", bogus_param: "synthetic-marker" });
    expectPage(unknown, spec, [2, 4], 3, 4);
    expect(unknown.body).toEqual(plain.body);
    expect(unknown.statements).toEqual(plain.statements);
  });

  it("preserves the cap in next links if this head advertises them, excluding unknown names", async () => {
    const first = await page(spec, { upperId: 6, limit: 2, includeTotal: "false", fields: spec.field, bogus_param: "synthetic-marker" });
    expectPage(first, spec, [2, 4], null, 4);
    const link = first.response.headers.get("link");
    if (link === null) return; // No Link feature on the source baseline; not a prerequisite.
    const next = link.match(/<([^>]+)>;\s*rel="?next"?/i);
    expect(next).not.toBeNull();
    const target = new URL(next![1], "http://test.local");
    expect(target.pathname).toBe(spec.path);
    expect(target.searchParams.getAll("upperId")).toEqual(["6"]);
    expect(target.searchParams.get("cursor")).toBe("4");
    expect(target.searchParams.has("bogus_param")).toBe(false);
    const known = new Set(["upperId", "cursor", "limit", "offset", "includeTotal", "fields", "q", "enabled", "customerId", "pickupAddressId", "containerId", "order", "direction"]);
    for (const key of target.searchParams.keys()) expect(known.has(key)).toBe(true);
    const response = await request(spec, target.search.slice(1));
    expect(response.status).toBe(200);
    const body = await response.json() as Body;
    expect(body.rows).toEqual([{ [spec.key]: 6, [spec.field]: "synthetic-other-6" }]);
    expect(body.total).toBeNull();
  });

  it("uses the same inclusive cap in descending traversal if advertised at this head", async () => {
    const operation = (await openApi()).paths[spec.path]?.get;
    const direction = operation?.parameters?.find((p) => ["order", "direction"].includes(p.name) && p.schema?.enum?.includes("desc"));
    if (!direction) return; // Unknown parameters returning 200 are not feature detection.
    const first = await page(spec, { upperId: 6, [direction.name]: "desc", cursor: 8, limit: 2 });
    expectPage(first, spec, [6, 4], 3, 4);
    expectQueries(first, spec, true, 6);
    const second = await page(spec, { upperId: 6, [direction.name]: "desc", cursor: 4, limit: 2, includeTotal: "false" });
    expectPage(second, spec, [2], null, null);
    expectQueries(second, spec, false, 6);
  });
});

// Integration oracle: unlike the baseline's optional feature probes, direction,
// next links and conditional reads are now required. Literal fixture pages catch
// an ascending empty-range shortcut, uncapped COUNT, lost link state, and a cap
// applied to the joined address ID instead of the container's own primary ID.
describe.each(SPECS)("$name: descending upperId integration", (spec) => {
  describe.each(["true", "false"])("includeTotal=%s", (includeTotal) => {
    const counted = includeTotal === "true";
    const query = { upperId: 6, order: "desc", includeTotal, limit: 2 };

    it.each([
      ["first page includes the ceiling", {}, [6, 4], 3, 4],
      ["cursor equals ceiling but lower rows remain", { cursor: 6 }, [4, 2], 2, 2],
      ["cursor exceeds ceiling without emptying range", { cursor: 8 }, [6, 4], 3, 4],
      ["strict-lower continuation", { cursor: 4 }, [2], 1, null],
      ["cursor overrides offset", { cursor: 6, offset: 100 }, [4, 2], 2, 2]
    ] as Array<[string, Query, number[], number, number | null]>)
    ("%s", async (_label, input, ids, total, next) => {
      const result = await page(spec, { ...query, ...input });
      expectPage(result, spec, ids, counted ? total : null, next);
      expectQueries(result, spec, counted, 6);
      const select = result.executions.find((s) => !/\bCOUNT\s*\(/i.test(s.sql))!;
      expect(select.sql).toMatch(new RegExp(`ORDER\\s+BY\\s+(?:\\w+\\.)?${spec.key}\\s+DESC\\b`, "i"));
      if (input.cursor !== undefined) {
        for (const statement of result.executions) {
          expect(statement.sql).toMatch(new RegExp(`\\b${spec.key}\\s*<\\s*\\?`));
          expect(statement.sql).not.toMatch(/\bOFFSET\b/i);
        }
      }
    });

    it("follows the actual capped descending Link across an above-cap arrival", async () => {
      const first = await page(spec, query);
      expectPage(first, spec, [6, 4], counted ? 3 : null, 4);
      expectQueries(first, spec, counted, 6);
      const link = first.response.headers.get("link");
      expect(link).toMatch(/^<\/api\/v1\/[^<>\s]+>; rel="next"$/);
      const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], "http://test.local");
      expect(target.origin).toBe("http://test.local");
      expect(target.pathname).toBe(spec.path);
      expect([...target.searchParams.entries()].sort()).toEqual([
        ["cursor", "4"], ["includeTotal", includeTotal], ["limit", "2"], ["order", "desc"], ["upperId", "6"]
      ]);
      await insert(spec, 10);
      // Positive control: the arrival exists and uncapped descending reads see it.
      expectPage(await page(spec, { order: "desc", includeTotal, limit: 2 }), spec, [10, 8], counted ? 5 : null, 8);
      const observed = observeDb();
      const response = await app.fetch(new Request(target, { headers: {
        authorization: `Bearer ${READ_TOKEN}`, origin: ORIGIN, "x-request-id": REQUEST_ID
      } }), { ...TEST_ENV, CUSTOMER_DB: observed.db });
      expect(response.status).toBe(200);
      commonHeaders(response);
      const resumed = { response, body: await response.json() as Body, ...observed };
      expectPage(resumed, spec, [2], counted ? 1 : null, null);
      expectQueries(resumed, spec, counted, 6);
      expect(response.headers.get("link")).toBeNull();
    });

    it("keeps text/enabled filters and exact sparse projection inside the cap", async () => {
      const result = await page(spec, { ...query, cursor: 8, q: "needle", enabled: "true", fields: spec.field });
      expectPage(result, spec, [4], counted ? 1 : null, null);
      expect(result.body.rows).toEqual([{ [spec.key]: 4, [spec.field]: "synthetic-needle-4" }]);
      expectQueries(result, spec, counted, 6);
    });

    it("hashes capped descending bytes and preserves no-store/Link on bodyless 304", async () => {
      const input = { ...query, fields: spec.field };
      const first = await page(spec, input);
      expectPage(first, spec, [6, 4], counted ? 3 : null, 4);
      expectQueries(first, spec, counted, 6);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(await first.response.text()));
      const tag = `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
      expect(first.response.headers.get("etag")).toBe(tag);
      const observed = observeDb();
      const response = await request(spec, new URLSearchParams(
        Object.entries(input).map(([key, value]) => [key, String(value)])
      ).toString(), { db: observed.db, headers: { "if-none-match": tag } });
      expect(response.status).toBe(304);
      expect(response.body).toBeNull();
      expect(await response.text()).toBe("");
      commonHeaders(response);
      expect(response.headers.get("etag")).toBe(tag);
      expect(response.headers.get("link")).toBe(first.response.headers.get("link"));
      expect(observed.executions).toEqual(first.executions);
      expectQueries({ ...first, ...observed }, spec, counted, 6);
    });
  });

  it.each([null, "synthetic-invalid-token"])("auth precedes direction/cap validation and wildcard conditional for %s", async (token) => {
    for (const search of ["upperId=6&order=desc", "upperId=0&order=desc", "upperId=6&order=invalid"]) {
      const observed = observeDb();
      const response = await request(spec, search, { db: observed.db, token, headers: {
        "if-none-match": "*", "cf-connecting-ip": `192.0.2.${++authProbe}`
      } });
      expect(response.status).toBe(401);
      commonHeaders(response);
      expect(await response.json()).toMatchObject({ status: 401, title: "Unauthorized" });
      expect(observed.methods).toEqual([]);
    }
  });
});

it.each(["true", "false"])("descending upperId bounds the container key, not its joined address, with includeTotal=%s", async (includeTotal) => {
  const spec = SPECS[2];
  const query = { order: "desc", includeTotal, cursor: 8, customerId: 2, q: "needle", enabled: "false", fields: "serial_number", limit: 2 };
  const result = await page(spec, { ...query, upperId: 6 });
  expectPage(result, spec, [6], includeTotal === "true" ? 1 : null, null);
  expect(result.body.rows).toEqual([{ container_id: 6, serial_number: "serial-needle-6" }]);
  expectQueries(result, spec, includeTotal === "true", 6);
  const below = await page(spec, { ...query, upperId: 5 });
  expectPage(below, spec, [], includeTotal === "true" ? 0 : null, null);
  expectQueries(below, spec, includeTotal === "true", 5);
});

describe("upperId machine discovery and unchanged operation authority", () => {
  it.each(SPECS)("publishes an optional safe integer ceiling on $name, with fixed validation guidance", async (spec) => {
    const operation = (await openApi()).paths[spec.path]?.get;
    expect(operation).toMatchObject({ operationId: spec.operationId, "x-access": "read", "x-effect": "local-read" });
    const parameters = operation?.parameters?.filter((p) => p.name === "upperId") ?? [];
    expect(parameters).toHaveLength(1);
    const parameter = parameters[0];
    expect(parameter).toMatchObject({ in: "query", required: false });
    expect([parameter.schema?.type].flat()).toContain("integer");
    expect(parameter.schema).toMatchObject({ minimum: 1, maximum: MAX_ID });
    expect(parameter.schema?.default).toBeUndefined();
    const guidance = parameter.description ?? parameter.schema?.description ?? "";
    expect(guidance).toMatch(/inclusive|<=|at or below/i);
    expect(guidance).toMatch(/canonical|unpadded/i);
    expect(guidance).toMatch(/ASCII/i);
    expect(guidance).toMatch(/repeat|single|once/i);
    expect(guidance).toMatch(/400/);
    expect(operation?.responses).toHaveProperty("400");
  });

  it("publishes the same type and bounds for all three resources", async () => {
    const doc = await openApi();
    const schemas = SPECS.map((spec) => {
      const parameter = doc.paths[spec.path]?.get?.parameters?.find((p) => p.name === "upperId");
      expect(parameter).toBeDefined();
      return { type: parameter?.schema?.type, minimum: parameter?.schema?.minimum, maximum: parameter?.schema?.maximum };
    });
    expect(schemas[1]).toEqual(schemas[0]);
    expect(schemas[2]).toEqual(schemas[0]);
  });

  it("does not broaden upperId into exports, details, changes, or hydrated reads", async () => {
    const doc = await openApi();
    for (const [path, value] of Object.entries(doc.paths)) {
      if (SPECS.some((spec) => spec.path === path)) continue;
      expect(value.get?.parameters?.filter((p) => p.in === "query").map((p) => p.name) ?? [], path).not.toContain("upperId");
    }
  });
});
