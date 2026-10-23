import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-author-owned oracle: ordinary snapshot lists traverse indexed primary IDs
 * in either direction. Literal pages below are independent of query builders.
 * Regressions caught: ignored/lenient order, inverted seek, offset on seek,
 * lookahead/count work, lost filters/joins/fieldsets and changed auth/envelopes.
 * Real local D1 executes every recorded statement; unexpected network fails.
 * Expected RED before the paired build; do not skip or weaken these assertions.
 */
const TEST_ENV = env as unknown as Env;
const READ_TOKEN = "test-read-token";
const IDS = [11, 23, 37, 42, 58, 91];
const OWNERS = [11, 11, 23, 37, 37, 11];
const ENABLED = [1, 1, 1, 0, 1, 0];
const TEXT_MATCH = [false, true, false, false, true, false];
const ORIGINAL_FETCH = globalThis.fetch;

type Spec = {
  name: string;
  path: string;
  id: string;
  text: string;
  operationId: string;
};
const SPECS: Spec[] = [
  { name: "customer", path: "/api/v1/customer-snapshot", id: "customer_id", text: "company_name", operationId: "listCustomerSnapshot" },
  { name: "address", path: "/api/v1/address-snapshot", id: "pickup_address_id", text: "address", operationId: "listAddressSnapshot" },
  { name: "container", path: "/api/v1/container-snapshot", id: "container_id", text: "location_address", operationId: "listContainerSnapshot" }
];
type Query = Record<string, string | number>;
type Statement = { sql: string; binds: unknown[] };
type ListBody = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type PageCase = { label: string; query: Query; ids: number[]; total: number; next: number | null };

function recordingDb() {
  const statements: Statement[] = [];
  const db = {
    prepare(sql: string) {
      const record = { sql, binds: [] as unknown[] };
      statements.push(record);
      const statement = TEST_ENV.CUSTOMER_DB.prepare(sql);
      return {
        bind(...binds: unknown[]) {
          record.binds = binds;
          return statement.bind(...binds);
        },
        first: () => statement.first(),
        all: () => statement.all(),
        raw: () => statement.raw(),
        run: () => statement.run()
      };
    },
    batch: (statements: D1PreparedStatement[]) => TEST_ENV.CUSTOMER_DB.batch(statements)
  } as unknown as D1Database;
  return { db, statements };
}

async function call(spec: Spec, query: Query | string, token: string | null = READ_TOKEN) {
  const search = typeof query === "string" ? query : new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)])
  ).toString();
  const { db, statements } = recordingDb();
  const headers = new Headers();
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(`http://test.local${spec.path}?${search}`, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: db
  });
  return { response, statements };
}

async function page(spec: Spec, query: Query) {
  const result = await call(spec, query);
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  const body = await result.response.json() as ListBody;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  // Link pagination is separately owned. Do not require its introduction, but
  // any next target present must carry direction and cursor together.
  const link = result.response.headers.get("link");
  if (link !== null && body.nextCursor !== null) {
    const target = /<([^>]+)>;\s*rel="?next"?/.exec(link);
    expect(target, "present pagination Link must identify its next target").not.toBeNull();
    const next = new URL(target![1], "http://test.local");
    expect(next.origin).toBe("http://test.local");
    expect(next.pathname).toBe(spec.path);
    expect(next.searchParams.get("cursor")).toBe(String(body.nextCursor));
    expect(next.searchParams.has("offset")).toBe(false);
    for (const [key, value] of Object.entries(query)) {
      if (key !== "cursor" && key !== "offset") expect(next.searchParams.get(key), key).toBe(String(value));
    }
    const allowed = ["order", "cursor", "limit", "includeTotal", "fields", "enabled", "q", "customerId", "pickupAddressId", "containerId"];
    for (const key of next.searchParams.keys()) expect(allowed).toContain(key);
  }
  return { ...result, body };
}

const isCount = (statement: Statement) => /\bCOUNT\s*\(/i.test(statement.sql);

function assertStatements(spec: Spec, statements: Statement[], query: Query, countFree: boolean) {
  expect(statements.filter(isCount)).toHaveLength(countFree ? 0 : 1);
  expect(statements).toHaveLength(countFree ? 1 : 2);
  for (const statement of statements) expect(statement.sql).toMatch(/^\s*SELECT\b/i);
  const select = statements.find((statement) => !isCount(statement))!;
  const direction = query.order === "desc" ? "DESC" : "ASC";
  const sqlDirection = direction === "DESC" ? "\\s+DESC\\b" : "(?:\\s+ASC)?(?=\\s+LIMIT\\b)";
  expect(select.sql).toMatch(new RegExp(`\\bORDER\\s+BY\\s+(?:\\w+\\.)?${spec.id}${sqlDirection}`, "i"));
  expect(select.binds).not.toContain(query.order);
  if (query.cursor !== undefined) {
    for (const statement of statements) {
      expect(statement.sql).toMatch(new RegExp(`\\b${spec.id}\\s*${direction === "DESC" ? "<" : ">"}\\s*\\?`));
      expect(statement.sql).not.toMatch(/\bOFFSET\b/i);
      expect(statement.binds).toContain(query.cursor);
    }
  }
  // Exact bind counts on unfiltered requests catch lookahead LIMIT+1 and an
  // ignored-but-still-bound OFFSET on seek pages, not just result ordering.
  if (!query.q && !query.enabled && !query.customerId && !query.pickupAddressId && !query.containerId) {
    expect(select.binds).toEqual(query.cursor === undefined
      ? [query.limit ?? 50, query.offset ?? 0]
      : [query.cursor, query.limit ?? 50]);
    if (!countFree) expect(statements.find(isCount)!.binds).toEqual(query.cursor === undefined ? [] : [query.cursor]);
  }
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  globalThis.fetch = vi.fn(async () => { throw new Error("Unexpected network in snapshot direction acceptance"); }) as typeof fetch;
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  // Gaps, reversed insertion order and timestamps deliberately unrelated to ID:
  // descending means highest primary ID first, never chronological recency.
  for (let i = IDS.length - 1; i >= 0; i--) {
    const id = IDS[i];
    const label = `synthetic-${TEXT_MATCH[i] ? "needle" : "other"}-${id}`;
    const synced = `2026-01-0${IDS.length - i}T00:00:00.000Z`;
    await db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, ?, ?)")
      .bind(id, label, ENABLED[i], synced).run();
  }
  for (let i = IDS.length - 1; i >= 0; i--) {
    const id = IDS[i];
    const label = `synthetic-${TEXT_MATCH[i] ? "needle" : "other"}-${id}`;
    const synced = `2026-01-0${IDS.length - i}T00:00:00.000Z`;
    await db.batch([
      db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, ?, ?, ?)")
        .bind(id, OWNERS[i], label, ENABLED[i], synced),
      db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, id, label, `serial-${id === 37 ? "needle" : "other"}-${id}`, ENABLED[i], synced)
    ]);
  }
});
afterEach(() => {
  const outbound = globalThis.fetch;
  globalThis.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
  expect(outbound).not.toHaveBeenCalled();
});

const DESCENDING: PageCase[] = [
  { label: "default limit", query: {}, ids: [91, 58, 42, 37, 23, 11], total: 6, next: null },
  { label: "highest IDs first", query: { limit: 2 }, ids: [91, 58], total: 6, next: 58 },
  { label: "offset start", query: { limit: 2, offset: 2 }, ids: [42, 37], total: 6, next: 37 },
  { label: "exactly full terminal page", query: { limit: 2, offset: 4 }, ids: [23, 11], total: 6, next: 11 },
  { label: "partial terminal page", query: { limit: 3, offset: 4 }, ids: [23, 11], total: 6, next: null },
  { label: "empty offset page", query: { limit: 2, offset: 6 }, ids: [], total: 6, next: null },
  { label: "cursor start with relative total", query: { limit: 2, cursor: 58 }, ids: [42, 37], total: 4, next: 37 },
  { label: "cursor in a primary-ID gap", query: { limit: 2, cursor: 50 }, ids: [42, 37], total: 4, next: 37 },
  { label: "partial cursor terminal page", query: { limit: 2, cursor: 23 }, ids: [11], total: 1, next: null },
  { label: "empty cursor terminal page", query: { limit: 2, cursor: 11 }, ids: [], total: 0, next: null },
  { label: "cursor overrides out-of-range offset", query: { limit: 2, cursor: 58, offset: 999 }, ids: [42, 37], total: 4, next: 37 },
  { label: "enabled filter", query: { limit: 2, enabled: "true" }, ids: [58, 37], total: 4, next: 37 },
  { label: "disabled filter", query: { limit: 2, enabled: "false" }, ids: [91, 42], total: 2, next: 42 },
  { label: "empty filtered page", query: { q: "synthetic-no-match", limit: 2 }, ids: [], total: 0, next: null }
];
const ASCENDING: PageCase[] = [
  { label: "default limit", query: {}, ids: [11, 23, 37, 42, 58, 91], total: 6, next: null },
  { label: "offset start", query: { limit: 2, offset: 2 }, ids: [37, 42], total: 6, next: 42 },
  { label: "cursor overrides offset", query: { limit: 2, cursor: 37, offset: 999 }, ids: [42, 58], total: 3, next: 58 },
  { label: "filter with cursor", query: { enabled: "true", cursor: 23, limit: 2 }, ids: [37, 58], total: 2, next: 58 },
  { label: "empty terminal page", query: { cursor: 91, limit: 2 }, ids: [], total: 0, next: null }
];

describe.each(SPECS)("$name primary-ID direction contract", (spec) => {
  describe.each(["true", "false"])("includeTotal=%s", (includeTotal) => {
    const countFree = includeTotal === "false";
    it.each(DESCENDING)("descending: $label", async (scenario) => {
      const query = { ...scenario.query, order: "desc", includeTotal };
      const { body, statements } = await page(spec, query);
      expect(body.rows.map((row) => row[spec.id])).toEqual(scenario.ids);
      expect(body.total).toBe(countFree ? null : scenario.total);
      expect(body.nextCursor).toBe(scenario.next);
      assertStatements(spec, statements, query, countFree);
    });

    it.each(ASCENDING)("omitted order and explicit asc preserve the envelope/SQL: $label", async (scenario) => {
      const query = { ...scenario.query, includeTotal };
      const omitted = await page(spec, query);
      const explicit = await page(spec, { ...query, order: "asc" });
      expect(explicit.body).toEqual(omitted.body);
      expect(explicit.statements).toEqual(omitted.statements);
      expect(explicit.body.rows.map((row) => row[spec.id])).toEqual(scenario.ids);
      expect(explicit.body.total).toBe(countFree ? null : scenario.total);
      expect(explicit.body.nextCursor).toBe(scenario.next);
      assertStatements(spec, explicit.statements, { ...query, order: "asc" }, countFree);
    });

    it.each(["asc", "desc"])("visits each enabled row once in %s order, including the final empty page", async (order) => {
      const expected = order === "desc" ? [[58, 37], [23, 11], []] : [[11, 23], [37, 58], []];
      const seen: unknown[] = [];
      let cursor: number | null = null;
      for (const [index, ids] of expected.entries()) {
        const query: Query = { order, includeTotal, enabled: "true", limit: 2 };
        if (cursor !== null) query.cursor = cursor;
        const { body, statements } = await page(spec, query);
        expect(body.rows.map((row) => row[spec.id])).toEqual(ids);
        expect(body.total).toBe(countFree ? null : [4, 2, 0][index]);
        expect(body.nextCursor).toBe(ids.length === 0 ? null : ids[1]);
        assertStatements(spec, statements, query, countFree);
        seen.push(...body.rows.map((row) => row[spec.id]));
        cursor = body.nextCursor;
      }
      expect(seen).toEqual(order === "desc" ? [58, 37, 23, 11] : [11, 23, 37, 58]);
      expect(new Set(seen).size).toBe(4);
    });

    it.each([false, true])("descending text + enabled filters compose with sparse fields (cursor=%s)", async (cursorStart) => {
      const query: Query = { order: "desc", includeTotal, q: "needle", enabled: "true", limit: 2 };
      if (cursorStart) Object.assign(query, { cursor: 91, offset: 999 });
      const full = await page(spec, query);
      const sparse = await page(spec, { ...query, fields: spec.text });
      const ids = spec.name === "container" ? [58, 37] : [58, 23];
      expect(sparse.body.rows).toEqual(full.body.rows.map((row) => ({ [spec.id]: row[spec.id], [spec.text]: row[spec.text] })));
      expect(sparse.body.rows.map((row) => row[spec.id])).toEqual(ids);
      expect(sparse.body.total).toBe(countFree ? null : spec.name === "container" ? 3 : 2);
      expect(sparse.body.nextCursor).toBe(ids[1]);
      assertStatements(spec, sparse.statements, { ...query, fields: spec.text }, countFree);
    });

    it("keeps customerId filtering, including the container address join, on descending cursor pages", async () => {
      const query = { order: "desc", includeTotal, customerId: 11, cursor: 58, offset: 999, limit: 2 };
      const { body, statements } = await page(spec, query);
      expect(body.rows.map((row) => row[spec.id])).toEqual(spec.name === "customer" ? [11] : [23, 11]);
      expect(body.total).toBe(countFree ? null : spec.name === "customer" ? 1 : 2);
      expect(body.nextCursor).toBe(spec.name === "customer" ? null : 11);
      assertStatements(spec, statements, query, countFree);
      if (spec.name === "container") expect(statements.find((statement) => !isCount(statement))!.sql).toMatch(/\bJOIN\s+address_snapshot\b/i);
    });
  });

  it.each([{ limit: 2, offset: 2 } as Query, { limit: 2, cursor: 58, offset: 999 } as Query])(
    "count-free mode changes only total and removes COUNT: %s", async (start) => {
      const query = { ...start, order: "desc", fields: spec.text };
      const counted = await page(spec, query);
      const free = await page(spec, { ...query, includeTotal: "false" });
      expect(free.body.rows).toEqual(counted.body.rows);
      expect(free.body.nextCursor).toBe(counted.body.nextCursor);
      expect(free.body.rows.map((row) => row[spec.id])).toEqual([42, 37]);
      expect(free.body.total).toBeNull();
      expect(free.statements).toEqual(counted.statements.filter((statement) => !isCount(statement)));
      assertStatements(spec, counted.statements, query, false);
      assertStatements(spec, free.statements, query, true);
    }
  );

  it("omitted includeTotal still counts a descending page", async () => {
    const query = { order: "desc", cursor: 58, limit: 2 };
    const { body, statements } = await page(spec, query);
    expect(body.rows.map((row) => row[spec.id])).toEqual([42, 37]);
    expect(body.total).toBe(4);
    assertStatements(spec, statements, query, false);
  });

  it.each(["asc", "desc"])("retains limit validation in %s order before D1", async (order) => {
    for (const limit of [0, 501]) {
      const { response, statements } = await call(spec, { order, limit });
      expect(response.status).toBe(400);
      expect(statements).toEqual([]);
    }
  });

  it.each([
    "order=", "order=ASC", "order=Desc", "order=descending", "order=asc%20", "order=%20desc",
    "order=desc%2Casc", "order=1", "order=null", "order=desc%00", "order=des%D1%81",
    "order=secret-direction-marker", "order=desc%3BDROP%20TABLE%20customer_snapshot",
    "order=asc&order=desc", "order=desc&order=desc", "order=&order=desc"
  ])("rejects %s with value-free fixed correction guidance before D1", async (query) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
    const { response, statements } = await call(spec, query);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toEqual({
      type: problemType("bad-request"), title: "Bad Request", status: 400,
      detail: "Invalid request query (order). See docs/PROBLEMS.md#bad-request."
    });
    expect(statements).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each(["order=desc", "order=secret-direction-marker", "order=asc&order=desc"])("auth precedes order validation and D1: %s", async (query) => {
    for (const token of [null, "synthetic-invalid-token"]) {
      const { response, statements } = await call(spec, query, token);
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(await response.text()).not.toContain("secret-direction-marker");
      expect(statements).toEqual([]);
    }
  });

  it("keeps request-ID header correlation, unchanged problem body and CORS on rejected order", async () => {
    const response = await exports.default.fetch(`http://test.local${spec.path}?order=secret-direction-marker`, {
      headers: { authorization: `Bearer ${READ_TOKEN}`, origin: "https://app.example.com", "x-request-id": "synthetic-direction-error" }
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("synthetic-direction-error");
    expect(response.headers.get("access-control-allow-origin")).toBeTruthy();
    expect(await response.json()).toEqual({
      type: problemType("bad-request"), title: "Bad Request", status: 400,
      detail: "Invalid request query (order). See docs/PROBLEMS.md#bad-request."
    });
  });

  it("keeps request-ID echo, no-store and CORS on the deployed Worker boundary", async () => {
    const response = await exports.default.fetch(`http://test.local${spec.path}?order=desc&limit=2&includeTotal=false`, {
      headers: { authorization: `Bearer ${READ_TOKEN}`, origin: "https://app.example.com", "x-request-id": "synthetic-direction-trace" }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("synthetic-direction-trace");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeTruthy();
    expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("x-request-id");
    const body = await response.json() as ListBody;
    expect(body.rows.map((row) => row[spec.id])).toEqual([91, 58]);
    expect(body.total).toBeNull();
  });
});

describe("descending resource-specific identity filters", () => {
  it.each([
    { spec: SPECS[1], query: { pickupAddressId: 23 } as Query, ids: [23] },
    { spec: SPECS[2], query: { pickupAddressId: 23 } as Query, ids: [23] },
    { spec: SPECS[2], query: { containerId: 37 } as Query, ids: [37] },
    { spec: SPECS[2], query: { customerId: 11, pickupAddressId: 37 } as Query, ids: [] }
  ])("$spec.name keeps $query", async ({ spec, query, ids }) => {
    const { body } = await page(spec, { ...query, order: "desc", cursor: 58, limit: 2 });
    expect(body.rows.map((row) => row[spec.id])).toEqual(ids);
    expect(body.total).toBe(ids.length);
    expect(body.nextCursor).toBeNull();
  });
});

type Parameter = { name: string; in: string; required?: boolean; schema?: { type?: string; enum?: string[]; default?: string } };
type Operation = {
  operationId?: string;
  parameters?: Parameter[];
  responses?: Record<string, { description?: string }>;
  [key: string]: unknown;
};

it("publishes one identical optional asc|desc parameter/default across the three existing operations", async () => {
  const response = await exports.default.fetch("http://test.local/openapi.json");
  expect(response.status).toBe(200);
  const doc = await response.json() as { paths: Record<string, { get?: Operation }> };
  const params = SPECS.map((spec) => {
    const operation = doc.paths[spec.path]?.get;
    expect(operation?.operationId).toBe(spec.operationId);
    expect(operation?.["x-access"]).toBe("read");
    expect(operation?.["x-effect"]).toBe("local-read");
    expect(operation?.responses?.["400"]?.description).toMatch(/\border\b/i);
    const parameter = operation?.parameters?.find((param) => param.name === "order");
    expect(parameter).toMatchObject({ in: "query", required: false, schema: { type: "string", enum: ["asc", "desc"], default: "asc" } });
    return parameter;
  });
  expect(params[1]).toEqual(params[0]);
  expect(params[2]).toEqual(params[0]);
  for (const path of ["/api/v1/customer-snapshot/changes", "/api/v1/customer-snapshot/{customerId}", "/api/v1/address-snapshot/{pickupAddressId}", "/api/v1/container-snapshot/{containerId}"]) {
    expect((doc.paths[path]?.get?.parameters ?? []).map((param) => param.name)).not.toContain("order");
  }
});
