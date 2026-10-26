/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

// Test-first contract: links are followable continuations of the existing lists,
// not a second pagination algorithm. Real local D1 executes every recorded read;
// fixture keys and expected pages below are hand-derived. No upstream is allowed.
const TEST_ENV = env as unknown as Env;
const TOKEN = "test-read-token";
const ORIGIN = "https://pagination.test.invalid";
const SEARCH = 'synthetic & +/雪? #"<x>';
const OWNERS = [1, 1, 2, 1, 3, 1];
const ENABLED = [1, 1, 0, 1, 1, 1];
const TEXT_MATCH = [true, true, false, true, false, true];

const RESOURCES = [
  { name: "customer", path: "/api/v1/customer-snapshot", id: "customer_id" },
  { name: "address", path: "/api/v1/address-snapshot", id: "pickup_address_id" },
  { name: "container", path: "/api/v1/container-snapshot", id: "container_id" }
] as const;
type Resource = (typeof RESOURCES)[number];
type Query = Record<string, string>;
type Statement = { sql: string; binds: unknown[]; method: string };
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };

// Observe actual executions (including batch/exec), not merely prepare calls, so
// a count/lookahead hidden behind a different D1 method cannot evade the budget.
function recordDb(real: D1Database) {
  const statements: Statement[] = [];
  const batch = vi.fn(() => { throw new Error("List must not batch D1 work"); });
  const exec = vi.fn(() => { throw new Error("List must not exec D1 work"); });
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql, values),
      first: (...args: unknown[]) => {
        statements.push({ sql, binds, method: "first" });
        return (stmt.first as (...a: unknown[]) => unknown)(...args);
      },
      all: () => {
        statements.push({ sql, binds, method: "all" });
        return stmt.all();
      },
      raw: (...args: unknown[]) => {
        statements.push({ sql, binds, method: "raw" });
        return (stmt.raw as (...a: unknown[]) => unknown)(...args);
      },
      run: () => {
        statements.push({ sql, binds, method: "run" });
        throw new Error("List must not mutate D1");
      }
    } as unknown as D1PreparedStatement;
  }
  const db = {
    prepare: (sql: string) => wrap(real.prepare(sql), sql, []),
    batch,
    exec
  } as unknown as D1Database;
  return { db, statements, batch, exec };
}

function forbiddenDb() {
  const fail = () => { throw new Error("Rejected request must not touch D1"); };
  const prepare = vi.fn(fail);
  const batch = vi.fn(fail);
  const exec = vi.fn(fail);
  return { db: { prepare, batch, exec } as unknown as D1Database, prepare, batch, exec };
}

async function request(
  path: string,
  query: Query = {},
  options: { token?: string | null; headers?: Record<string, string>; db?: D1Database } = {}
) {
  const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
  const headers = new Headers(options.headers);
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const url = new URL(path, ORIGIN);
  if (Object.keys(query).length > 0) url.search = new URLSearchParams(query).toString();
  const input = new Request(url, { headers });
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    expect(input.headers.get(name), `injection fixture must actually send ${name}`).toBe(value);
  }
  const response = await app.fetch(input, {
    ...TEST_ENV,
    CUSTOMER_DB: options.db ?? recorder.db
  });
  return { response, url, recorder };
}

async function page(resource: Resource, query: Query | URL = {}, headers?: Record<string, string>) {
  const result = query instanceof URL
    ? await request(query.toString(), {}, { headers })
    : await request(resource.path, query, { headers });
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  const bytes = await result.response.clone().text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const counted = result.url.searchParams.get("includeTotal") !== "false";
  expect(result.recorder.statements).toHaveLength(counted ? 2 : 1);
  expect(result.recorder.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(counted ? 1 : 0);
  expect(result.recorder.statements.every((s) => /^\s*SELECT\b/i.test(s.sql))).toBe(true);
  expect(result.recorder.statements.every((s) => s.method === "first" || s.method === "all")).toBe(true);
  expect(result.recorder.batch).not.toHaveBeenCalled();
  expect(result.recorder.exec).not.toHaveBeenCalled();
  if (!counted) expect(body.total).toBeNull();
  return { ...result, body, bytes };
}

function nextTarget(response: Response, current: URL, resource: Resource, expected: Query): URL {
  const link = response.headers.get("link");
  expect(link, "non-null nextCursor requires Link: <relative-target>; rel=\"next\"").not.toBeNull();
  expect(link).toMatch(/^<\/api\/v1\/(?:customer|address|container)-snapshot\?[^<>\s]*>; rel="next"$/);
  const raw = /^<([^>]+)>; rel="next"$/.exec(link!)![1];
  expect(raw.startsWith("//")).toBe(false);
  const target = new URL(raw, current);
  expect(target.origin).toBe(current.origin);
  expect(target.pathname).toBe(resource.path);
  expect(target.hash).toBe("");
  expect(target.username).toBe("");
  expect(target.password).toBe("");
  const actualParams = new URLSearchParams(target.searchParams);
  const expectedParams = { ...expected };
  // Default-true may be omitted or spelled out; only false must round-trip.
  if (expected.includeTotal !== "false") {
    expect([null, "true"]).toContain(actualParams.get("includeTotal"));
    expect(actualParams.getAll("includeTotal").length).toBeLessThanOrEqual(1);
    actualParams.delete("includeTotal");
    delete expectedParams.includeTotal;
  }
  expect([...actualParams.keys()]).toHaveLength(Object.keys(expectedParams).length);
  expect(Object.fromEntries(actualParams)).toEqual(expectedParams);
  expect(target.searchParams.has("offset")).toBe(false);
  return target;
}

async function follow(resource: Resource, target: URL) {
  // Follow exactly the server's path/query. Do not reconstruct any cursor/filter.
  return page(resource, target);
}

async function seed(id: number, owner: number, enabled: number, label: string, serial: string) {
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, ?, 'synthetic')")
      .bind(id, label, enabled),
    db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, ?, ?, 'synthetic')")
      .bind(id, owner, label, enabled),
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, enabled, synced_at) VALUES (?, ?, ?, ?, ?, 'synthetic')")
      .bind(id, id, label, serial, enabled)
  ]);
}

beforeAll(async () => {
  await ensureD1TestTables();
});

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound fetch in next-link acceptance"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  for (let i = 0; i < 6; i++) {
    await seed(i + 1, OWNERS[i], ENABLED[i], TEXT_MATCH[i] ? SEARCH : `synthetic-other-${i + 1}`,
      i === 2 ? SEARCH : `synthetic-serial-${i + 1}`);
  }
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(RESOURCES)("$name snapshot: followable next links", (resource) => {
  const fields = `${resource.id},enabled`;
  const ids = (body: Body) => body.rows.map((r) => r[resource.id]);

  it("follows a filtered offset start as keyset pages, preserving encoded q, fields and count-free mode", async () => {
    const filters = { q: SEARCH, enabled: "true", fields, includeTotal: "false", limit: "2" };
    const first = await page(resource, { ...filters, offset: "1" });
    expect(ids(first.body)).toEqual([2, 4]);
    expect(first.body.rows).toEqual([{ [resource.id]: 2, enabled: 1 }, { [resource.id]: 4, enabled: 1 }]);
    expect(first.body.nextCursor).toBe(4);
    const target = nextTarget(first.response, first.url, resource, { ...filters, cursor: "4" });
    expect(target.searchParams.get("q")).toBe(SEARCH);
    const last = await follow(resource, target);
    expect(ids(last.body)).toEqual([6]);
    expect(last.body.total).toBeNull();
    expect(last.body.nextCursor).toBeNull();
    expect(last.response.headers.get("link")).toBeNull();
    expect([...ids(first.body), ...ids(last.body)]).toEqual([2, 4, 6]);
  });

  it("replaces a seek cursor, drops even a conflicting offset, and keeps cursor-relative totals", async () => {
    const filters = { q: SEARCH, enabled: "true", fields, includeTotal: "true", limit: "2" };
    const first = await page(resource, { ...filters, cursor: "1", offset: "4" });
    expect(ids(first.body)).toEqual([2, 4]);
    expect(first.body.total).toBe(3);
    expect(first.body.nextCursor).toBe(4);
    const target = nextTarget(first.response, first.url, resource, { ...filters, cursor: "4" });
    const last = await follow(resource, target);
    expect(ids(last.body)).toEqual([6]);
    expect(last.body.total).toBe(1);
    expect(last.body.nextCursor).toBeNull();
    expect(last.response.headers.get("link")).toBeNull();
  });

  it("visits every static row once and links a full terminal page to an empty page without lookahead", async () => {
    let current = await page(resource, { fields, limit: "2" });
    const seen: unknown[] = [];
    const expectedPages = [[1, 2], [3, 4], [5, 6], []];
    const expectedTotals = [6, 4, 2, 0];
    for (let index = 0; index < expectedPages.length; index++) {
      expect(ids(current.body)).toEqual(expectedPages[index]);
      expect(current.body.total).toBe(expectedTotals[index]);
      seen.push(...ids(current.body));
      if (index === 3) {
        expect(current.body.nextCursor).toBeNull();
        expect(current.response.headers.get("link")).toBeNull();
      } else {
        const cursor = String([2, 4, 6][index]);
        expect(current.body.nextCursor).toBe(Number(cursor));
        const target = nextTarget(current.response, current.url, resource, { fields, limit: "2", cursor });
        current = await follow(resource, target);
      }
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(seen).size).toBe(6);
  });

  it("keeps count-free mode through two links from an offset start, never reintroducing offset", async () => {
    const filters = { fields, limit: "2", includeTotal: "false" };
    const first = await page(resource, { ...filters, offset: "2" });
    expect(ids(first.body)).toEqual([3, 4]);
    expect(first.body.nextCursor).toBe(4);
    const second = await follow(resource,
      nextTarget(first.response, first.url, resource, { ...filters, cursor: "4" }));
    expect(ids(second.body)).toEqual([5, 6]);
    expect(second.body.nextCursor).toBe(6);
    const empty = await follow(resource,
      nextTarget(second.response, second.url, resource, { ...filters, cursor: "6" }));
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.nextCursor).toBeNull();
    expect(empty.response.headers.get("link")).toBeNull();
  });

  it("carries the effective default limit on a bare list and follows its remaining rows", async () => {
    for (let id = 7; id <= 52; id++) {
      await seed(id, 1, 1, `synthetic-extra-${id}`, `synthetic-extra-serial-${id}`);
    }
    const first = await page(resource);
    expect(ids(first.body)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(first.body.total).toBe(52);
    expect(first.body.nextCursor).toBe(50);
    const target = nextTarget(first.response, first.url, resource, { limit: "50", cursor: "50" });
    const last = await follow(resource, target);
    expect(ids(last.body)).toEqual([51, 52]);
    expect(last.body.total).toBe(2);
    expect(last.body.nextCursor).toBeNull();
    expect(last.response.headers.get("link")).toBeNull();
  });

  it("preserves explicit fields and the existing always-present primary key in linked pages", async () => {
    const filters = { fields: "enabled", limit: "2", includeTotal: "false" };
    const first = await page(resource, filters);
    expect(first.body.rows).toEqual([{ [resource.id]: 1, enabled: 1 }, { [resource.id]: 2, enabled: 1 }]);
    expect(first.body.nextCursor).toBe(2);
    const target = nextTarget(first.response, first.url, resource, { ...filters, cursor: "2" });
    const second = await follow(resource, target);
    expect(second.body.rows).toEqual([{ [resource.id]: 3, enabled: 0 }, { [resource.id]: 4, enabled: 1 }]);
    expect(second.body.nextCursor).toBe(4);
  });

  it("keeps enabled=false instead of dropping a false-like recognized filter", async () => {
    const filters: Query = { enabled: "false", fields, limit: "1", includeTotal: "false" };
    // Only container row 3 matches via serial_number rather than address text.
    if (resource.name === "container") filters.q = SEARCH;
    const first = await page(resource, filters);
    expect(ids(first.body)).toEqual([3]);
    expect(first.body.nextCursor).toBe(3);
    const target = nextTarget(first.response, first.url, resource, { ...filters, cursor: "3" });
    const empty = await follow(resource, target);
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.nextCursor).toBeNull();
    expect(empty.response.headers.get("link")).toBeNull();
  });

  const selectors: Query = resource.name === "customer" ? { customerId: "2" }
    : resource.name === "address" ? { customerId: "1", pickupAddressId: "2" }
    : { customerId: "1", pickupAddressId: "2", containerId: "2" };

  it("preserves every resource-specific selector, including the container customer/address join", async () => {
    const filters = { ...selectors, q: SEARCH, enabled: "true", fields, limit: "1", includeTotal: "false" };
    const first = await page(resource, filters);
    expect(ids(first.body)).toEqual([2]);
    expect(first.body.nextCursor).toBe(2);
    const target = nextTarget(first.response, first.url, resource, { ...filters, cursor: "2" });
    const empty = await follow(resource, target);
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.nextCursor).toBeNull();
    expect(empty.response.headers.get("link")).toBeNull();
  });

  it("uses a fixed relative resource path and never reflects unknown keys, credentials or proxy origins", async () => {
    const clean = { fields, limit: "1", includeTotal: "false" };
    const baseline = await page(resource, clean);
    const tainted = await page(resource, {
      ...clean,
      bogus_param: "unknown-marker",
      authorization: "Bearer query-credential-marker",
      token: "query-token-marker",
      url: "https://redirect-marker.invalid/elsewhere",
      host: "query-host-marker.invalid",
      __proto_marker: "</x>; rel=\"next\""
    }, {
      host: "host-marker.invalid",
      forwarded: "host=forwarded-marker.invalid;proto=http",
      "x-forwarded-host": "x-forwarded-marker.invalid",
      "x-forwarded-proto": "http",
      origin: "https://origin-marker.invalid"
    });
    expect(tainted.bytes).toBe(baseline.bytes);
    expect(tainted.recorder.statements).toEqual(baseline.recorder.statements);
    const target = nextTarget(tainted.response, tainted.url, resource, { ...clean, cursor: "1" });
    expect(tainted.response.headers.get("link")).toBe(baseline.response.headers.get("link"));
    expect(tainted.response.headers.get("link")).not.toMatch(/marker|Bearer|test-read-token|https?:|\/\//);
    const second = await follow(resource, target);
    expect(ids(second.body)).toEqual([2]);
  });

  it.each([
    ["empty offset", { limit: "2", offset: "6" }, [], 6],
    ["empty seek", { limit: "2", cursor: "6" }, [], 0],
    ["partial terminal", { limit: "4", cursor: "4" }, [5, 6], 2],
    ["unmatched filter", { limit: "1", q: "synthetic-no-match" }, [], 0]
  ] as const)("omits Link on a null-cursor %s page", async (_label, query, expectedIds, total) => {
    const result = await page(resource, { ...query, fields });
    expect(ids(result.body)).toEqual(expectedIds);
    expect(result.body.total).toBe(total);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  });

  it.each([
    ["offset-counted", { fields, enabled: "true", limit: "2", offset: "2" }, [4, 5], 5, 5],
    ["seek-count-free", { fields, enabled: "true", limit: "2", cursor: "2", includeTotal: "false" }, [4, 5], null, 5],
    ["empty-counted", { fields, limit: "2", cursor: "6" }, [], 0, null],
    ["filtered-selectors-count-free", { ...selectors, q: SEARCH, enabled: "true", fields, limit: "1", includeTotal: "false" }, [2], null, 2],
    ["full-row-terminal", { limit: "1", cursor: "5" }, [6], 1, 6]
  ] as const)("preserves pre-feature JSON bytes and exact executed SQL/binds: %s", async (_label, query, expectedIds, total, cursor) => {
    const result = await page(resource, query);
    expect(ids(result.body)).toEqual(expectedIds);
    expect(result.body.total).toBe(total);
    expect(result.body.nextCursor).toBe(cursor);
    // Goldens began on the pre-link baseline; the customer q oracle now includes
    // its deliberate three-name OR extension. Pagination must preserve the rest.
    expect({ bytes: result.bytes, statements: result.recorder.statements }).toMatchSnapshot();
  });

  it.each([
    ["oversized limit", { limit: "501" }, "limit"],
    ["invalid fields", { fields: "secret-field-marker" }, "fields"],
    ["invalid count mode", { includeTotal: "secret-count-marker" }, "includeTotal"]
  ] as const)("keeps the fixed value-free 400 and no Link or DB work: %s", async (_label, query, key) => {
    const db = forbiddenDb();
    const result = await request(resource.path, query, { db: db.db });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("link")).toBeNull();
    const body = await result.response.json();
    expect(body).toMatchObject({
      title: "Bad Request", status: 400,
      detail: `Invalid request query (${key}). See docs/PROBLEMS.md#bad-request.`
    });
    expect(JSON.stringify(body)).not.toContain("secret-");
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
  });

  it("keeps authorization before validation, with no error Link or D1 access", async () => {
    const db = forbiddenDb();
    const result = await request(resource.path, { limit: "501" }, { token: null, db: db.db });
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("link")).toBeNull();
    expect((await result.response.json() as { status: number }).status).toBe(401);
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
  });

  it("does not attach a continuation to a D1 error", async () => {
    const prepare = vi.fn(() => { throw new Error("synthetic database failure"); });
    const result = await request(resource.path, { limit: "1" }, { db: { prepare } as unknown as D1Database });
    expect(result.response.status).toBe(500);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("link")).toBeNull();
    expect((await result.response.json() as { status: number }).status).toBe(500);
  });
});

describe("next-link discoverability", () => {
  it.each(RESOURCES)("$name CORS exposes Link without losing existing exposure fields", async (resource) => {
    const { response } = await page(resource, { limit: "1" }, { origin: "https://app.example.com" });
    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.com");
    expect(response.headers.get("vary")).toMatch(/origin/i);
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    const exposed = (response.headers.get("access-control-expose-headers") ?? "")
      .split(",").map((name) => name.trim().toLowerCase());
    expect(exposed).toEqual(expect.arrayContaining([
      "etag", "retry-after", "content-disposition",
      "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
      "ratelimit", "ratelimit-policy", "link"
    ]));
  });

  it.each(RESOURCES)("$name list publishes an optional Link response header in the served OpenAPI", async (resource) => {
    const response = await exports.default.fetch("https://pagination.test.invalid/openapi.json");
    expect(response.status).toBe(200);
    const doc = await response.json() as {
      paths: Record<string, { get: { responses: Record<string, { headers?: Record<string, { required?: boolean; schema?: { type?: string } }> }> } }>
    };
    const headers = doc.paths[resource.path].get.responses["200"].headers ?? {};
    const header = Object.entries(headers).find(([name]) => name.toLowerCase() === "link")?.[1];
    expect(header, "agents must discover the optional continuation header").toBeDefined();
    expect(header?.required).not.toBe(true);
    expect(header?.schema?.type).toBe("string");
  });
});
