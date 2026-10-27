/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import problemsDoc from "../docs/PROBLEMS.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-author-owned oracle: `hasEnabledContainers=true|false|any` on the
 * EXISTING address list (`GET /api/v1/address-snapshot` only), selecting
 * sites by ENABLED mirrored-container presence. Written from the card spec
 * without reading any implementation diff; every expected page below is
 * hand-derived from the fixtures.
 *
 * Fixture map (synthetic ids, no PII). Child `enabled` values are the stored
 * integers; only exactly 1 is an enabled child (0 is disabled; 2 and -1 are
 * noncanonical and never count):
 *   addr 11 (cust 100, addr-enabled 1, "Needle") children: none          -> EC=false, C=false
 *   addr 12 (cust 100, addr-enabled 1, "Needle") children: [1]           -> EC=true,  C=true
 *   addr 13 (cust 200, addr-enabled 0, "Other")  children: [1, 1, 0]     -> EC=true,  C=true
 *   addr 14 (cust 200, addr-enabled 1, "Needle") children: [0]           -> EC=false, C=true
 *   addr 15 (cust 100, addr-enabled 0, "Other")  children: none          -> EC=false, C=false
 *   addr 16 (cust 300, addr-enabled 1, "Needle") children: [2]           -> EC=false, C=true
 *   addr 17 (cust 300, addr-enabled 1, "Other")  children: [2, 0]        -> EC=false, C=true
 *   addr 18 (cust 200, addr-enabled 0, "Needle") children: [-1, 1]       -> EC=true,  C=true
 * EC=true = {12,13,18}; EC=false = {11,14,15,16,17} (zero-container sites,
 * disabled-only sites and noncanonical-only sites alike).
 * C=true (sibling `hasContainers`) = {12,13,14,16,17,18}; C=false = {11,15}.
 * `q=needle` matches 11,12,14,16,18; `q=other` matches 13,15,17 (address
 * text only; city/state/zip carry neither word).
 *
 * Contract pinned here:
 *  - exact case-sensitive `true|false|any` enum, default `any`; invalid,
 *    blank or repeated keys (including percent-encoded duplicate keys) 400
 *    value-free before D1; auth precedes validation.
 *  - `true` = EXISTS a stored child container with the same
 *    pickup_address_id AND stored enabled exactly 1; `false` = the exact
 *    NOT-EXISTS complement of that same predicate (never "exists a disabled
 *    child" and never "all children disabled" formulated so zero-container
 *    sites drop out); `any`/omission adds no predicate. Noncanonical child
 *    enabled (2, -1) never counts toward `true`. The address row's own
 *    `enabled` stays fully independent of the child predicate.
 *  - full `hasContainers` x `hasEnabledContainers` truth table:
 *    false+true = empty 200; true+false = sites that have equipment but no
 *    enabled equipment {14,16,17}; any/omission on either selector leaves
 *    the other selector's set untouched.
 *  - correlated EXISTS/NOT EXISTS over the existing
 *    `idx_container_snapshot_pickup_address_id`, no join expanding parent
 *    rows, no per-row D1 calls, no child payload/count expansion; the
 *    enabled-exactly-1 condition is a literal predicate, not a bind (the
 *    established stored-flag convention: `enabled = 1`, `extras_allowed = 1`,
 *    `oncall = 1`).
 *  - AND-composition with customerId/pickupAddressId/ids/q/enabled/cursor/
 *    lowerId/upperId in COUNT, page and countOnly SQL; cursor-relative
 *    totals; offset mode and offset-to-seek continuation; both seek
 *    directions; count-free mode; sparse fields; conditional envelope;
 *    next links carry non-any values of BOTH presence selectors through
 *    terminal/empty pages and omit any/omitted ones.
 *
 * Real local D1 executes every recorded read; outbound fetch throws; no
 * network, no writes outside fixture seeding, no production-latency claim.
 * Expected RED before the paired build; do not skip or weaken these
 * assertions. Builder: consume this commit without editing this file;
 * request oracle corrections through a new bounded child card.
 */

const TEST_ENV = env as unknown as Env;
const READ_TOKEN = "test-read-token";
const ORIGIN = "https://enabled-presence.test.invalid";
const PATH = "/api/v1/address-snapshot";
const ID = "pickup_address_id";
const BAD_REQUEST_DETAIL = "Invalid request query (hasEnabledContainers). See docs/PROBLEMS.md#bad-request.";

type Query = Record<string, string | number>;
type Statement = { sql: string; binds: unknown[]; method: string };
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };

// Observe actual executions (including batch/exec), not merely prepare calls,
// so a count/lookahead hidden behind a different D1 method cannot evade the budget.
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

function qs(query: Query): string {
  return new URLSearchParams(
    Object.entries(query).map(([key, value]) => [key, String(value)])
  ).toString();
}

async function request(
  search: string,
  options: { token?: string | null; headers?: Record<string, string>; db?: D1Database } = {}
) {
  const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
  const headers = new Headers(options.headers);
  const token = options.token === undefined ? READ_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const url = new URL(search ? `${PATH}?${search}` : PATH, ORIGIN);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV,
    CUSTOMER_DB: options.db ?? recorder.db
  });
  return { response, url, recorder };
}

async function page(query: Query = {}) {
  const search = qs(query);
  const result = await request(search);
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  const bytes = await result.response.clone().text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const counted = query.includeTotal !== "false";
  expect(result.recorder.statements).toHaveLength(counted ? 2 : 1);
  expect(result.recorder.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(counted ? 1 : 0);
  expect(result.recorder.statements.every((s) => /^\s*SELECT\b/i.test(s.sql))).toBe(true);
  expect(result.recorder.statements.every((s) => s.method === "first" || s.method === "all")).toBe(true);
  expect(result.recorder.batch).not.toHaveBeenCalled();
  expect(result.recorder.exec).not.toHaveBeenCalled();
  if (!counted) expect(body.total).toBeNull();
  return { ...result, body, bytes };
}

async function countOnly(query: Query, total: number) {
  const result = await request(qs({ ...query, countOnly: "true" }));
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  expect(result.response.headers.get("link")).toBeNull();
  const body = JSON.parse(await result.response.clone().text()) as Body;
  expect(body).toEqual({ rows: [], total, nextCursor: null });
  expect(result.recorder.statements).toHaveLength(1);
  expect(result.recorder.statements[0].sql).toMatch(/^\s*SELECT\s+COUNT\s*\([^)]*\)\s*(?:AS\s+\w+)?\s+FROM\b/i);
  expect(result.recorder.statements[0].sql).not.toMatch(/\bLIMIT\b|\bOFFSET\b/i);
  expect(result.recorder.batch).not.toHaveBeenCalled();
  expect(result.recorder.exec).not.toHaveBeenCalled();
  return result;
}

const ids = (body: Body) => body.rows.map((row) => row[ID]);

function expectNoDuplicates(body: Body) {
  const seen = ids(body);
  expect(new Set(seen).size).toBe(seen.length);
  for (const row of body.rows) {
    expect(typeof row[ID]).toBe("number");
  }
}

function nextTarget(response: Response, current: URL, expected: Query): URL {
  const link = response.headers.get("link");
  expect(link, "non-null nextCursor requires Link: <relative-target>; rel=\"next\"").not.toBeNull();
  expect(link).toMatch(/^<\/api\/v1\/address-snapshot\?[^<>\s]*>; rel="next"$/);
  const raw = /^<([^>]+)>; rel="next"$/.exec(link!)![1];
  expect(raw.startsWith("//")).toBe(false);
  const target = new URL(raw, current);
  expect(target.origin).toBe(current.origin);
  expect(target.pathname).toBe(PATH);
  expect(target.hash).toBe("");
  expect(target.username).toBe("");
  expect(target.password).toBe("");
  const actualParams = new URLSearchParams(target.searchParams);
  const expectedParams = { ...expected } as Record<string, string | number>;
  // Default-true may be omitted or spelled out; only false must round-trip.
  if (expectedParams.includeTotal !== "false") {
    expect([null, "true"]).toContain(actualParams.get("includeTotal"));
    expect(actualParams.getAll("includeTotal").length).toBeLessThanOrEqual(1);
    actualParams.delete("includeTotal");
    delete expectedParams.includeTotal;
  }
  expect([...actualParams.keys()]).toHaveLength(Object.keys(expectedParams).length);
  expect(Object.fromEntries(actualParams)).toEqual(
    Object.fromEntries(Object.entries(expectedParams).map(([k, v]) => [k, String(v)]))
  );
  expect(target.searchParams.has("offset")).toBe(false);
  return target;
}

async function follow(target: URL) {
  // Follow exactly the server's path/query. Do not reconstruct any cursor/filter.
  const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
  const headers = new Headers();
  headers.set("authorization", `Bearer ${READ_TOKEN}`);
  const response = await app.fetch(new Request(target, { headers }), {
    ...TEST_ENV,
    CUSTOMER_DB: recorder.db
  });
  expect(response.status).toBe(200);
  const bytes = await response.clone().text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const counted = target.searchParams.get("includeTotal") !== "false";
  expect(recorder.statements).toHaveLength(counted ? 2 : 1);
  if (!counted) expect(body.total).toBeNull();
  return { response, url: target, recorder, body, bytes };
}

async function explain(sql: string, binds: unknown[]): Promise<string> {
  const r = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...binds)
    .all<{ detail: string }>();
  return (r.results ?? []).map((x) => x.detail).join("\n");
}

beforeAll(async () => {
  await ensureD1TestTables();
});

beforeEach(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound fetch in enabled-presence acceptance"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  for (const id of [100, 200, 300]) {
    await db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, 1, 'synthetic')")
      .bind(id, `synthetic-customer-${id}`).run();
  }
  const addresses: Array<[number, number, number, string]> = [
    [11, 100, 1, "11 Synthetic Needle Way"],
    [12, 100, 1, "12 Synthetic Needle Way"],
    [13, 200, 0, "13 Synthetic Other Road"],
    [14, 200, 1, "14 Synthetic Needle Lane"],
    [15, 100, 0, "15 Synthetic Other Road"],
    [16, 300, 1, "16 Synthetic Needle Court"],
    [17, 300, 1, "17 Synthetic Other Court"],
    [18, 200, 0, "18 Synthetic Needle Court"]
  ];
  for (const [id, owner, enabled, label] of addresses) {
    await db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, city, state, zip, enabled, synced_at) VALUES (?, ?, ?, 'Synthetic City', 'TS', ?, ?, 'synthetic')")
      .bind(id, owner, label, `7000${id}`, enabled).run();
  }
  const containers: Array<[number, number, number]> = [
    [101, 12, 1],
    [102, 13, 1],
    [103, 13, 1],
    [104, 13, 0],
    [105, 14, 0],
    [106, 16, 2],
    [107, 17, 2],
    [108, 17, 0],
    [109, 18, -1],
    [110, 18, 1]
  ];
  for (const [id, owner, enabled] of containers) {
    await db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, enabled, synced_at) VALUES (?, ?, ?, ?, ?, 'synthetic')")
      .bind(id, owner, `synthetic-container-${id}`, `synthetic-serial-${id}`, enabled).run();
  }
});

afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("address hasEnabledContainers presence selection", () => {
  it("true returns exactly the sites with a stored enabled-exactly-1 child, one row each", async () => {
    const result = await page({ hasEnabledContainers: "true" });
    expect(ids(result.body)).toEqual([12, 13, 18]);
    expect(result.body.total).toBe(3);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    expectNoDuplicates(result.body);
  });

  it("false is the exact complement: zero-container, disabled-only and noncanonical-only sites", async () => {
    const result = await page({ hasEnabledContainers: "false" });
    expect(ids(result.body)).toEqual([11, 14, 15, 16, 17]);
    expect(result.body.total).toBe(5);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    expectNoDuplicates(result.body);
  });

  it("true and false partition the whole list with no overlap or gap", async () => {
    const yes = await page({ hasEnabledContainers: "true" });
    const no = await page({ hasEnabledContainers: "false" });
    const all = await page({});
    expect([...ids(yes.body), ...ids(no.body)].sort((a, b) => Number(a) - Number(b)))
      .toEqual(ids(all.body));
    expect(yes.body.total! + no.body.total!).toBe(all.body.total);
  });

  it("omitted and explicit any select every address with identical bytes and SQL", async () => {
    const omitted = await page({});
    const explicit = await page({ hasEnabledContainers: "any" });
    for (const result of [omitted, explicit]) {
      expect(ids(result.body)).toEqual([11, 12, 13, 14, 15, 16, 17, 18]);
      expect(result.body.total).toBe(8);
      expect(result.body.nextCursor).toBeNull();
    }
    expect(explicit.bytes).toBe(omitted.bytes);
    expect(explicit.recorder.statements).toEqual(omitted.recorder.statements);
  });

  it("never counts a noncanonical child enabled value as enabled equipment", async () => {
    // 16's only child stores enabled=2 and 17's children store 2 and 0:
    // neither site has enabled equipment. 18 stores -1 beside a real 1 and
    // is selected only because of the 1.
    const noncanonicalOnly = await page({ hasEnabledContainers: "true", customerId: 300 });
    expect(ids(noncanonicalOnly.body)).toEqual([]);
    expect(noncanonicalOnly.body.total).toBe(0);
    const complement = await page({ hasEnabledContainers: "false", customerId: 300 });
    expect(ids(complement.body)).toEqual([16, 17]);
    const mixedNoncanonical = await page({ hasEnabledContainers: "true", pickupAddressId: 18 });
    expect(ids(mixedNoncanonical.body)).toEqual([18]);
  });

  it("keeps the address row's own enabled fully independent of child enabled", async () => {
    // 13 and 18 are disabled addresses carrying enabled equipment; 14, 16
    // and 17 are enabled addresses with no enabled equipment.
    const presentEnabled = await page({ hasEnabledContainers: "true", enabled: "true" });
    expect(ids(presentEnabled.body)).toEqual([12]);
    const presentDisabled = await page({ hasEnabledContainers: "true", enabled: "false" });
    expect(ids(presentDisabled.body)).toEqual([13, 18]);
    const absentEnabled = await page({ hasEnabledContainers: "false", enabled: "true" });
    expect(ids(absentEnabled.body)).toEqual([11, 14, 16, 17]);
    const absentDisabled = await page({ hasEnabledContainers: "false", enabled: "false" });
    expect(ids(absentDisabled.body)).toEqual([15]);
  });

  it("does not leak a sibling's enabled child across addresses of the same customer", async () => {
    // Customer 200 owns 13 (enabled equipment), 14 (disabled-only) and 18
    // (enabled beside noncanonical): only the equipment's own sites match.
    const present = await page({ hasEnabledContainers: "true", customerId: 200 });
    expect(ids(present.body)).toEqual([13, 18]);
    expect(present.body.total).toBe(2);
    const absent = await page({ hasEnabledContainers: "false", customerId: 200 });
    expect(ids(absent.body)).toEqual([14]);
    expect(absent.body.total).toBe(1);
  });

  it.each([
    ["disabled-only id under true", { hasEnabledContainers: "true", pickupAddressId: 14 }, []],
    ["noncanonical-only id under true", { hasEnabledContainers: "true", pickupAddressId: 16 }, []],
    ["enabled-equipment id under false", { hasEnabledContainers: "false", pickupAddressId: 12 }, []],
    ["unmatched text under true", { hasEnabledContainers: "true", q: "synthetic-no-match" }, []],
    ["unmatched text under false", { hasEnabledContainers: "false", q: "synthetic-no-match" }, []]
  ] as const)("empty selection %s: no rows, zero total, null cursor, no Link", async (_label, query, expectedIds) => {
    const result = await page({ ...query });
    expect(ids(result.body)).toEqual(expectedIds);
    expect(result.body.total).toBe(0);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  });
});

describe("address hasContainers x hasEnabledContainers truth table", () => {
  const CASES: Array<[string, Query, number[]]> = [
    ["true x true", { hasContainers: "true", hasEnabledContainers: "true" }, [12, 13, 18]],
    ["true x false (equipment, none enabled)", { hasContainers: "true", hasEnabledContainers: "false" }, [14, 16, 17]],
    ["false x true (contradiction)", { hasContainers: "false", hasEnabledContainers: "true" }, []],
    ["false x false (no equipment at all)", { hasContainers: "false", hasEnabledContainers: "false" }, [11, 15]],
    ["any x true", { hasContainers: "any", hasEnabledContainers: "true" }, [12, 13, 18]],
    ["any x false", { hasContainers: "any", hasEnabledContainers: "false" }, [11, 14, 15, 16, 17]],
    ["true x any", { hasContainers: "true", hasEnabledContainers: "any" }, [12, 13, 14, 16, 17, 18]],
    ["false x any", { hasContainers: "false", hasEnabledContainers: "any" }, [11, 15]],
    ["any x any", { hasContainers: "any", hasEnabledContainers: "any" }, [11, 12, 13, 14, 15, 16, 17, 18]]
  ];

  it.each(CASES)("%s intersects by AND in rows and total", async (_label, query, expectedIds) => {
    const result = await page(query);
    expect(ids(result.body)).toEqual(expectedIds);
    expect(result.body.total).toBe(expectedIds.length);
    expectNoDuplicates(result.body);
    if (expectedIds.length === 0) {
      expect(result.response.status).toBe(200);
      expect(result.body.nextCursor).toBeNull();
      expect(result.response.headers.get("link")).toBeNull();
    }
  });

  it("omitting either selector is byte- and SQL-identical to spelling it any", async () => {
    const ecOnly = await page({ hasEnabledContainers: "false", limit: 3 });
    const ecPlusAny = await page({ hasEnabledContainers: "false", hasContainers: "any", limit: 3 });
    expect(ecPlusAny.bytes).toBe(ecOnly.bytes);
    expect(ecPlusAny.recorder.statements).toEqual(ecOnly.recorder.statements);

    const cOnly = await page({ hasContainers: "true", limit: 3 });
    const cPlusAny = await page({ hasContainers: "true", hasEnabledContainers: "any", limit: 3 });
    expect(cPlusAny.bytes).toBe(cOnly.bytes);
    expect(cPlusAny.recorder.statements).toEqual(cOnly.recorder.statements);
  });

  it("keeps both selectors in COUNT and page SQL without a join when both are non-any", async () => {
    const result = await page({ hasContainers: "true", hasEnabledContainers: "false", limit: 2 });
    expect(ids(result.body)).toEqual([14, 16]);
    expect(result.body.total).toBe(3);
    for (const statement of result.recorder.statements) {
      expect(statement.sql).toMatch(/EXISTS\s*\(/i);
      expect(statement.sql).toMatch(/container_snapshot/i);
      expect(statement.sql).toMatch(/enabled\s*=\s*1\b/);
      expect(statement.sql).not.toMatch(/\bJOIN\b/i);
    }
  });
});

describe("address hasEnabledContainers selector intersections", () => {
  const CASES: Array<[string, Query, number[]]> = [
    ["true + customerId=100", { hasEnabledContainers: "true", customerId: 100 }, [12]],
    ["false + customerId=100", { hasEnabledContainers: "false", customerId: 100 }, [11, 15]],
    ["true + customerId=200", { hasEnabledContainers: "true", customerId: 200 }, [13, 18]],
    ["false + customerId=200", { hasEnabledContainers: "false", customerId: 200 }, [14]],
    ["true + customerId=300", { hasEnabledContainers: "true", customerId: 300 }, []],
    ["false + customerId=300", { hasEnabledContainers: "false", customerId: 300 }, [16, 17]],
    ["true + pickupAddressId=18", { hasEnabledContainers: "true", pickupAddressId: 18 }, [18]],
    ["false + pickupAddressId=16", { hasEnabledContainers: "false", pickupAddressId: 16 }, [16]],
    ["true + ids subset", { hasEnabledContainers: "true", ids: "11,12,14,18" }, [12, 18]],
    ["false + ids subset", { hasEnabledContainers: "false", ids: "11,12,14,18" }, [11, 14]],
    ["true + q=needle", { hasEnabledContainers: "true", q: "needle" }, [12, 18]],
    ["false + q=needle", { hasEnabledContainers: "false", q: "needle" }, [11, 14, 16]],
    ["true + q=other", { hasEnabledContainers: "true", q: "other" }, [13]],
    ["false + q=other", { hasEnabledContainers: "false", q: "other" }, [15, 17]],
    ["true + enabled=true", { hasEnabledContainers: "true", enabled: "true" }, [12]],
    ["true + enabled=false", { hasEnabledContainers: "true", enabled: "false" }, [13, 18]],
    ["false + enabled=true", { hasEnabledContainers: "false", enabled: "true" }, [11, 14, 16, 17]],
    ["false + enabled=false", { hasEnabledContainers: "false", enabled: "false" }, [15]],
    ["false + upperId=16 (inclusive)", { hasEnabledContainers: "false", upperId: 16 }, [11, 14, 15, 16]],
    ["true + lowerId=13 (inclusive)", { hasEnabledContainers: "true", lowerId: 13 }, [13, 18]],
    ["true + customerId + enabled + q", { hasEnabledContainers: "true", customerId: 200, enabled: "false", q: "needle" }, [18]],
    ["false + hasContainers=true + enabled=true", { hasEnabledContainers: "false", hasContainers: "true", enabled: "true" }, [14, 16, 17]],
    ["true + q + cursor", { hasEnabledContainers: "true", q: "needle", cursor: 12, limit: 5 }, [18]],
    ["false + customerId + cursor", { hasEnabledContainers: "false", customerId: 100, cursor: 11, limit: 5 }, [15]]
  ];

  it.each(CASES)("%s composes by AND in rows and cursor-relative total", async (_label, query, expectedIds) => {
    const result = await page(query);
    expect(ids(result.body)).toEqual(expectedIds);
    const cursor = query.cursor === undefined ? undefined : Number(query.cursor);
    const expectedTotal = cursor === undefined
      ? expectedIds.length
      : expectedIds.filter((id) => id > cursor).length;
    // All table cursors sit below their expected remainder, so total equals
    // the remainder length; the seek predicate is part of the WHERE.
    expect(result.body.total).toBe(expectedTotal);
    expectNoDuplicates(result.body);
    for (const statement of result.recorder.statements) {
      expect(statement.sql).toMatch(/EXISTS\s*\(/i);
      expect(statement.sql).toMatch(/container_snapshot/i);
      expect(statement.sql).not.toMatch(/\bJOIN\b/i);
    }
  });
});

describe("address hasEnabledContainers SQL mechanism", () => {
  it("true uses correlated EXISTS with a literal enabled = 1 in COUNT and page SQL, exact binds, no join", async () => {
    const result = await page({ hasEnabledContainers: "true", limit: 2 });
    expect(result.recorder.statements).toHaveLength(2);
    const count = result.recorder.statements.find((s) => /\bCOUNT\s*\(/i.test(s.sql))!;
    const select = result.recorder.statements.find((s) => !/\bCOUNT\s*\(/i.test(s.sql))!;
    for (const statement of [count, select]) {
      expect(statement.sql).toMatch(/EXISTS\s*\(/i);
      expect(statement.sql).not.toMatch(/NOT\s+EXISTS/i);
      expect(statement.sql).toMatch(/container_snapshot/i);
      expect(statement.sql).toMatch(/pickup_address_id/i);
      // No address-enabled filter is in play on this request, so the only
      // `enabled = 1` predicate either statement may carry is the child's.
      expect(statement.sql).toMatch(/enabled\s*=\s*1\b/);
      expect(statement.sql).not.toMatch(/\bJOIN\b/i);
      expect(statement.sql).not.toMatch(/\bIS\s+NULL\b/i);
    }
    // The enum and the stored-flag value become predicates, not binds:
    // only the page window binds.
    expect(count.binds).toEqual([]);
    expect(select.binds).toEqual([2, 0]);
    for (const bind of [...count.binds, ...select.binds]) expect(typeof bind).toBe("number");
  });

  it("false negates the same enabled-exactly-1 EXISTS: NOT EXISTS in COUNT and page SQL", async () => {
    const result = await page({ hasEnabledContainers: "false", limit: 2 });
    expect(result.recorder.statements).toHaveLength(2);
    const count = result.recorder.statements.find((s) => /\bCOUNT\s*\(/i.test(s.sql))!;
    const select = result.recorder.statements.find((s) => !/\bCOUNT\s*\(/i.test(s.sql))!;
    for (const statement of [count, select]) {
      expect(statement.sql).toMatch(/NOT\s+EXISTS\s*\(/i);
      expect(statement.sql).toMatch(/container_snapshot/i);
      expect(statement.sql).toMatch(/pickup_address_id/i);
      expect(statement.sql).toMatch(/enabled\s*=\s*1\b/);
      expect(statement.sql).not.toMatch(/\bJOIN\b/i);
      expect(statement.sql).not.toMatch(/\bIS\s+NULL\b/i);
    }
    expect(count.binds).toEqual([]);
    expect(select.binds).toEqual([2, 0]);
  });

  it("omitted and any add no child predicate to either statement", async () => {
    const omitted = await page({ limit: 2 });
    const explicit = await page({ hasEnabledContainers: "any", limit: 2 });
    expect(explicit.recorder.statements).toEqual(omitted.recorder.statements);
    for (const statement of omitted.recorder.statements) {
      expect(statement.sql).not.toMatch(/EXISTS/i);
      expect(statement.sql).not.toMatch(/container_snapshot/i);
    }
  });

  it("any beside hasContainers=true adds no enabled condition to the sibling predicate", async () => {
    const result = await page({ hasContainers: "true", hasEnabledContainers: "any", limit: 2 });
    for (const statement of result.recorder.statements) {
      expect(statement.sql).toMatch(/EXISTS\s*\(/i);
      expect(statement.sql).toMatch(/container_snapshot/i);
      expect(statement.sql).not.toMatch(/enabled\s*=\s*1\b/);
    }
  });

  it("keeps the seek cursor bound once per statement with the enabled-presence predicate", async () => {
    const result = await page({ hasEnabledContainers: "true", cursor: 12, limit: 1 });
    expect(ids(result.body)).toEqual([13]);
    expect(result.body.total).toBe(2);
    const count = result.recorder.statements.find((s) => /\bCOUNT\s*\(/i.test(s.sql))!;
    const select = result.recorder.statements.find((s) => !/\bCOUNT\s*\(/i.test(s.sql))!;
    expect(count.binds).toEqual([12]);
    expect(select.binds).toEqual([12, 1]);
    expect(select.sql).not.toMatch(/\bOFFSET\b/i);
  });
});

describe("address hasEnabledContainers pagination and modes", () => {
  it("pages both directions with cursor-relative totals", async () => {
    const ascTrue = await page({ hasEnabledContainers: "true", limit: 1 });
    expect(ids(ascTrue.body)).toEqual([12]);
    expect(ascTrue.body.total).toBe(3);
    const descTrue = await page({ hasEnabledContainers: "true", limit: 1, order: "desc" });
    expect(ids(descTrue.body)).toEqual([18]);
    expect(descTrue.body.total).toBe(3);
    const descFalse = await page({ hasEnabledContainers: "false", limit: 2, order: "desc" });
    expect(ids(descFalse.body)).toEqual([17, 16]);
    expect(descFalse.body.total).toBe(5);
    const seekDesc = await page({ hasEnabledContainers: "true", order: "desc", cursor: 18, limit: 1 });
    expect(ids(seekDesc.body)).toEqual([13]);
    expect(seekDesc.body.total).toBe(2);
    const seekAsc = await page({ hasEnabledContainers: "false", cursor: 14, limit: 2 });
    expect(ids(seekAsc.body)).toEqual([15, 16]);
    expect(seekAsc.body.total).toBe(3);
  });

  it("omitted order and explicit asc stay identical under the enabled-presence filter", async () => {
    const omitted = await page({ hasEnabledContainers: "false", limit: 2 });
    const explicit = await page({ hasEnabledContainers: "false", limit: 2, order: "asc" });
    expect(explicit.body).toEqual(omitted.body);
    expect(explicit.recorder.statements).toEqual(omitted.recorder.statements);
  });

  it("cursor wins over offset under the enabled-presence filter", async () => {
    const result = await page({ hasEnabledContainers: "true", cursor: 12, offset: 99, limit: 5 });
    expect(ids(result.body)).toEqual([13, 18]);
    expect(result.body.total).toBe(2);
  });

  it.each([
    ["offset middle", { hasEnabledContainers: "false", limit: 2, offset: 1 }, [14, 15], 5, 15],
    ["offset partial terminal", { hasEnabledContainers: "true", limit: 2, offset: 2 }, [18], 3, null],
    ["offset past the end", { hasEnabledContainers: "true", limit: 1, offset: 3 }, [], 3, null]
  ] as const)("offset %s keeps the full filtered total", async (_label, query, expectedIds, total, cursor) => {
    const result = await page({ ...query });
    expect(ids(result.body)).toEqual(expectedIds);
    expect(result.body.total).toBe(total);
    expect(result.body.nextCursor).toBe(cursor);
    if (cursor === null) expect(result.response.headers.get("link")).toBeNull();
  });

  it("follows an offset page's link into cursor-relative seek pages to the terminal empty page", async () => {
    const first = await page({ hasEnabledContainers: "false", limit: 2, offset: 1 });
    expect(ids(first.body)).toEqual([14, 15]);
    expect(first.body.total).toBe(5);
    expect(first.body.nextCursor).toBe(15);
    // The continuation drops offset and seeks from the cursor instead; its
    // total is cursor-relative (2), not the offset page's full total.
    const target = nextTarget(first.response, first.url, { hasEnabledContainers: "false", limit: "2", cursor: "15" });
    const second = await follow(target);
    expect(ids(second.body)).toEqual([16, 17]);
    expect(second.body.total).toBe(2);
    expect(second.body.nextCursor).toBe(17);
    const third = await follow(nextTarget(second.response, second.url, { hasEnabledContainers: "false", limit: "2", cursor: "17" }));
    expect(ids(third.body)).toEqual([]);
    expect(third.body.total).toBe(0);
    expect(third.body.nextCursor).toBeNull();
    expect(third.response.headers.get("link")).toBeNull();
  });

  it("count-free mode returns the same rows with null total and zero COUNT", async () => {
    for (const value of ["true", "false"] as const) {
      const counted = await page({ hasEnabledContainers: value, limit: 1 });
      const free = await page({ hasEnabledContainers: value, limit: 1, includeTotal: "false" });
      expect(free.body.rows).toEqual(counted.body.rows);
      expect(free.body.nextCursor).toBe(counted.body.nextCursor);
      expect(free.body.total).toBeNull();
      expect(free.recorder.statements).toHaveLength(1);
      const countedPage = counted.recorder.statements.find((s) => !/\bCOUNT\s*\(/i.test(s.sql));
      expect(free.recorder.statements[0]).toEqual(countedPage);
    }
  });

  it("walks each filtered set by nextCursor alone, never issuing a COUNT", async () => {
    for (const [value, expected] of [["true", [12, 13, 18]], ["false", [11, 14, 15, 16, 17]]] as const) {
      const seen: unknown[] = [];
      let cursor: number | null = null;
      for (let walk = 0; walk < 8; walk++) {
        const query: Query = cursor === null
          ? { hasEnabledContainers: value, limit: 1, includeTotal: "false" }
          : { hasEnabledContainers: value, limit: 1, includeTotal: "false", cursor };
        const result = await page(query);
        expect(result.body.total).toBeNull();
        seen.push(...ids(result.body));
        if (result.body.nextCursor === null) break;
        cursor = result.body.nextCursor;
      }
      expect(seen).toEqual(expected);
    }
  });

  it("countOnly returns the filtered cursor-relative total with one COUNT and no rows or Link", async () => {
    await countOnly({ hasEnabledContainers: "true" }, 3);
    await countOnly({ hasEnabledContainers: "false" }, 5);
    await countOnly({ hasEnabledContainers: "any" }, 8);
    await countOnly({ hasEnabledContainers: "true", limit: 1, offset: 2 }, 3);
    await countOnly({ hasEnabledContainers: "true", cursor: 12 }, 2);
    await countOnly({ hasEnabledContainers: "false", customerId: 200 }, 1);
    await countOnly({ hasContainers: "false", hasEnabledContainers: "true" }, 0);
    await countOnly({ hasContainers: "true", hasEnabledContainers: "false" }, 3);
    // countOnly is a representation mode: its total equals the counted page's.
    const counted = await page({ hasEnabledContainers: "false", q: "needle" });
    await countOnly({ hasEnabledContainers: "false", q: "needle" }, counted.body.total!);
  });

  it("countOnly still rejects an invalid enabled-presence value before any D1 access", async () => {
    const db = forbiddenDb();
    const result = await request("countOnly=true&hasEnabledContainers=secret-marker-xyz", { db: db.db });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const text = await result.response.clone().text();
    expect(JSON.parse(text)).toMatchObject({ type: problemType("bad-request"), title: "Bad Request", status: 400 });
    expect(text).not.toContain("secret-marker-xyz");
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
  });

  it("trims filtered rows to sparse fieldsets with the id always present", async () => {
    const present = await page({ hasEnabledContainers: "true", fields: "address" });
    expect(present.body.rows).toEqual([
      { [ID]: 12, address: "12 Synthetic Needle Way" },
      { [ID]: 13, address: "13 Synthetic Other Road" },
      { [ID]: 18, address: "18 Synthetic Needle Court" }
    ]);
    const absent = await page({ hasEnabledContainers: "false", fields: "enabled", limit: 3 });
    expect(absent.body.rows).toEqual([
      { [ID]: 11, enabled: 1 },
      { [ID]: 14, enabled: 1 },
      { [ID]: 15, enabled: 0 }
    ]);
  });

  it.each(["true", "false"] as const)("replays a sparse filtered envelope as an empty 304", async (value) => {
    const query = `hasEnabledContainers=${value}&fields=enabled&limit=2&includeTotal=false`;
    const first = await request(query);
    expect(first.response.status).toBe(200);
    const tag = first.response.headers.get("etag");
    expect(tag).toMatch(/^".+"$/);
    const headers = new Headers();
    headers.set("authorization", `Bearer ${READ_TOKEN}`);
    headers.set("if-none-match", tag!);
    const replay = await app.fetch(new Request(new URL(`${PATH}?${query}`, ORIGIN), { headers }), TEST_ENV);
    expect(replay.status).toBe(304);
    expect(replay.headers.get("etag")).toBe(tag);
    expect((await replay.arrayBuffer()).byteLength).toBe(0);
    expect(replay.headers.get("cache-control")).toBe("no-store");
    // The opposite selector serves different bytes, so the same validator
    // must not replay it as a 304.
    const opposite = value === "true" ? "false" : "true";
    const other = await app.fetch(
      new Request(new URL(`${PATH}?hasEnabledContainers=${opposite}&fields=enabled&limit=2&includeTotal=false`, ORIGIN), { headers }),
      TEST_ENV
    );
    expect(other.status).toBe(200);
  });
});

describe("address hasEnabledContainers next links", () => {
  it.each(["true", "false"] as const)("carries %s through every page to a terminal empty page", async (value) => {
    const expected = value === "true" ? [12, 13, 18] : [11, 14, 15, 16, 17];
    const steps = expected.length + 1;
    let current = await page({ hasEnabledContainers: value, limit: 1 });
    const seen: unknown[] = [];
    for (let index = 0; index < steps; index++) {
      const pageIds = index < expected.length ? [expected[index]] : [];
      expect(ids(current.body)).toEqual(pageIds);
      expect(current.body.total).toBe(expected.length - index);
      seen.push(...ids(current.body));
      if (index === steps - 1) {
        expect(current.body.nextCursor).toBeNull();
        expect(current.response.headers.get("link")).toBeNull();
      } else {
        const cursor = String(expected[index]);
        expect(current.body.nextCursor).toBe(Number(cursor));
        const target = nextTarget(current.response, current.url, { hasEnabledContainers: value, limit: "1", cursor });
        current = await follow(target);
      }
    }
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(expected.length);
  });

  it("walks descending by returned links carrying the enabled-presence value", async () => {
    const filters = { hasEnabledContainers: "true", order: "desc", limit: "1", includeTotal: "false" };
    let current = await page({ ...filters });
    const seen: unknown[] = [];
    for (const expectedId of [18, 13, 12]) {
      expect(ids(current.body)).toEqual([expectedId]);
      seen.push(...ids(current.body));
      expect(current.body.nextCursor).toBe(expectedId);
      current = await follow(nextTarget(current.response, current.url, { ...filters, cursor: String(expectedId) }));
    }
    expect(ids(current.body)).toEqual([]);
    expect(current.body.nextCursor).toBeNull();
    expect(current.response.headers.get("link")).toBeNull();
    expect(seen).toEqual([18, 13, 12]);
  });

  it("links a full terminal page to an empty page without lookahead", async () => {
    const first = await page({ hasEnabledContainers: "true", limit: 3 });
    expect(ids(first.body)).toEqual([12, 13, 18]);
    expect(first.body.nextCursor).toBe(18);
    const empty = await follow(nextTarget(first.response, first.url, { hasEnabledContainers: "true", limit: "3", cursor: "18" }));
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.total).toBe(0);
    expect(empty.body.nextCursor).toBeNull();
    expect(empty.response.headers.get("link")).toBeNull();
  });

  it("carries both non-any presence selectors together and drops neither false-like value", async () => {
    const filters = { hasContainers: "true", hasEnabledContainers: "false", limit: "2", includeTotal: "false" };
    const first = await page({ ...filters });
    expect(ids(first.body)).toEqual([14, 16]);
    expect(first.body.nextCursor).toBe(16);
    const second = await follow(nextTarget(first.response, first.url, { ...filters, cursor: "16" }));
    expect(ids(second.body)).toEqual([17]);
    expect(second.body.total).toBeNull();
    expect(second.body.nextCursor).toBeNull();
    expect(second.response.headers.get("link")).toBeNull();
  });

  it("keeps enabled=false and the enabled-presence value instead of dropping false-like filters", async () => {
    const first = await page({ hasEnabledContainers: "true", enabled: "false", limit: 1, includeTotal: "false" });
    expect(ids(first.body)).toEqual([13]);
    expect(first.body.nextCursor).toBe(13);
    const target = nextTarget(first.response, first.url, {
      hasEnabledContainers: "true", enabled: "false", limit: "1", includeTotal: "false", cursor: "13"
    });
    const second = await follow(target);
    expect(ids(second.body)).toEqual([18]);
    const empty = await follow(nextTarget(second.response, second.url, {
      hasEnabledContainers: "true", enabled: "false", limit: "1", includeTotal: "false", cursor: "18"
    }));
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.nextCursor).toBeNull();
  });

  it("echoes explicit order, fields and count-free mode with the enabled-presence value", async () => {
    const filters = { hasEnabledContainers: "false", order: "desc", fields: `${ID},enabled`, limit: "1", includeTotal: "false" };
    const first = await page({ ...filters });
    expect(ids(first.body)).toEqual([17]);
    expect(first.body.rows).toEqual([{ [ID]: 17, enabled: 1 }]);
    const target = nextTarget(first.response, first.url, { ...filters, cursor: "17" });
    const second = await follow(target);
    expect(ids(second.body)).toEqual([16]);
    expect(second.body.rows).toEqual([{ [ID]: 16, enabled: 1 }]);
  });

  it.each([{}, { hasEnabledContainers: "any" }] as Array<Query>)("omits the enabled-presence key from continuations when %s", async (base) => {
    const first = await page({ ...base, limit: 5 });
    expect(ids(first.body)).toEqual([11, 12, 13, 14, 15]);
    expect(first.body.nextCursor).toBe(15);
    const target = nextTarget(first.response, first.url, { limit: "5", cursor: "15" });
    expect(target.searchParams.has("hasEnabledContainers")).toBe(false);
    const last = await follow(target);
    expect(ids(last.body)).toEqual([16, 17, 18]);
  });

  it("omits each selector spelled any while carrying the other selector's non-any value", async () => {
    const ecAny = await page({ hasContainers: "true", hasEnabledContainers: "any", limit: 2 });
    expect(ids(ecAny.body)).toEqual([12, 13]);
    const ecTarget = nextTarget(ecAny.response, ecAny.url, { hasContainers: "true", limit: "2", cursor: "13" });
    expect(ecTarget.searchParams.has("hasEnabledContainers")).toBe(false);

    const cAny = await page({ hasContainers: "any", hasEnabledContainers: "false", limit: 2 });
    expect(ids(cAny.body)).toEqual([11, 14]);
    const cTarget = nextTarget(cAny.response, cAny.url, { hasEnabledContainers: "false", limit: "2", cursor: "14" });
    expect(cTarget.searchParams.has("hasContainers")).toBe(false);
  });

  it("uses a fixed relative target and never reflects unknown keys or credentials", async () => {
    const clean = { hasEnabledContainers: "true", limit: "1", includeTotal: "false" };
    const baseline = await page(clean);
    const tainted = await request(
      `${qs(clean)}&bogus_param=1&token=query-token-marker&url=https%3A%2F%2Fredirect-marker.invalid%2F`,
      { headers: { host: "host-marker.invalid", origin: "https://origin-marker.invalid" } }
    );
    expect(tainted.response.status).toBe(200);
    expect(await tainted.response.clone().text()).toBe(baseline.bytes);
    expect(tainted.response.headers.get("link")).toBe(baseline.response.headers.get("link"));
    expect(tainted.response.headers.get("link")).not.toMatch(/marker|Bearer|test-read-token|https?:|\/\//);
    const target = nextTarget(tainted.response, tainted.url, { ...clean, cursor: "12" });
    const second = await follow(target);
    expect(ids(second.body)).toEqual([13]);
  });
});

describe("address hasEnabledContainers validation and auth precedence", () => {
  it.each([
    ["empty string", ""],
    ["upper-case TRUE", "TRUE"],
    ["capitalised True", "True"],
    ["numeric 1", "1"],
    ["numeric 0", "0"],
    ["yes", "yes"],
    ["leading space", "%20true"],
    ["trailing space", "true%20"],
    ["comma list", "true%2Cfalse"],
    ["null", "null"],
    ["marker value", "secret-marker-xyz"]
  ])("rejects %s with a value-free 400 before any D1 access", async (_name, value) => {
    const db = forbiddenDb();
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((m) => vi.spyOn(console, m));
    const result = await request(`hasEnabledContainers=${value}`, { db: db.db });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("link")).toBeNull();
    const text = await result.response.clone().text();
    expect(JSON.parse(text)).toEqual({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail: BAD_REQUEST_DETAIL
    });
    expect(text).not.toContain("secret-marker-xyz");
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each([
    "hasEnabledContainers=true&hasEnabledContainers=false",
    "hasEnabledContainers=any&hasEnabledContainers=any",
    "hasEnabledContainers=false&hasEnabledContainers=false",
    "hasEnabledContainers=true&%68asEnabledContainers=false",
    "%68asEnabledContainers=true&hasEnabledContainers=true"
  ])("rejects a repeated key (plain or percent-encoded) before any D1 access: %s", async (search) => {
    const db = forbiddenDb();
    const result = await request(search, { db: db.db });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("link")).toBeNull();
    expect(await result.response.json()).toMatchObject({ status: 400, detail: BAD_REQUEST_DETAIL });
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
  });

  it("rejects when both presence selectors are invalid, before any D1 access and without echo", async () => {
    const db = forbiddenDb();
    const result = await request("hasContainers=secret-marker-xyz&hasEnabledContainers=also-bad", { db: db.db });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const text = await result.response.clone().text();
    // The hook may name one or both offending keys; never pin their order or
    // the full sentence for a multi-key rejection.
    expect(text).toMatch(/hasContainers|hasEnabledContainers/);
    expect(text).not.toContain("secret-marker-xyz");
    expect(text).not.toContain("also-bad");
    expect(db.prepare).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
    expect(db.exec).not.toHaveBeenCalled();
  });

  it.each([
    "hasEnabledContainers=true",
    "hasEnabledContainers=secret-marker-xyz",
    "hasEnabledContainers=true&hasEnabledContainers=false",
    "hasContainers=false&hasEnabledContainers=true"
  ])("keeps authorization before validation, with no error Link or D1 access: %s", async (search) => {
    for (const token of [null, "synthetic-invalid-token"]) {
      const db = forbiddenDb();
      const result = await request(search, { token, db: db.db });
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get("content-type")).toContain("application/problem+json");
      expect(result.response.headers.get("link")).toBeNull();
      expect((await result.response.clone().text())).not.toContain("secret-marker-xyz");
      expect(db.prepare).not.toHaveBeenCalled();
      expect(db.batch).not.toHaveBeenCalled();
      expect(db.exec).not.toHaveBeenCalled();
    }
  });

  it("ignores an unknown key alongside the enabled-presence filter without changing bytes or SQL", async () => {
    const baseline = await page({ hasEnabledContainers: "true", limit: 2 });
    const tainted = await request(`${qs({ hasEnabledContainers: "true", limit: 2 })}&bogus_param=1`);
    expect(tainted.response.status).toBe(200);
    expect(await tainted.response.clone().text()).toBe(baseline.bytes);
    expect(tainted.recorder.statements).toEqual(baseline.recorder.statements);
  });

  it("serves a filtered page to the read token with no-store, CORS and request-ID correlation", async () => {
    const response = await exports.default.fetch(`http://test.local${PATH}?hasEnabledContainers=true&limit=1&includeTotal=false`, {
      headers: {
        authorization: `Bearer ${READ_TOKEN}`,
        origin: "https://app.example.com",
        "x-request-id": "synthetic-enabled-presence-trace"
      }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("synthetic-enabled-presence-trace");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeTruthy();
    expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("x-request-id");
    const body = (await response.json()) as Body;
    expect(ids(body)).toEqual([12]);
    expect(body.total).toBeNull();
  });

  it("keeps request-ID echo and the anchored body on a rejected enabled-presence value", async () => {
    const response = await exports.default.fetch(`http://test.local${PATH}?hasEnabledContainers=secret-marker-xyz`, {
      headers: {
        authorization: `Bearer ${READ_TOKEN}`,
        origin: "https://app.example.com",
        "x-request-id": "synthetic-enabled-presence-error"
      }
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("synthetic-enabled-presence-error");
    expect(response.headers.get("access-control-allow-origin")).toBeTruthy();
    expect(await response.json()).toEqual({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail: BAD_REQUEST_DETAIL
    });
  });
});

describe("address hasEnabledContainers served OpenAPI contract", () => {
  type Param = {
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    example?: unknown;
    schema?: { type?: unknown; enum?: unknown[]; default?: unknown; description?: string; example?: unknown };
  };
  type Operation = {
    operationId?: string;
    parameters?: Param[];
    responses?: Record<string, { description?: string }>;
    [key: string]: unknown;
  };
  type Doc = { paths: Record<string, { get?: Operation }> };

  async function openApi(): Promise<Doc> {
    const res = await exports.default.fetch("http://test.local/openapi.json");
    expect(res.status).toBe(200);
    return (await res.json()) as Doc;
  }

  it("publishes hasEnabledContainers as an optional true|false|any query enum, default any, with a replayable example", async () => {
    const doc = await openApi();
    const operation = doc.paths[PATH]?.get;
    expect(operation?.operationId).toBe("listAddressSnapshot");
    expect(operation?.["x-access"]).toBe("read");
    expect(operation?.["x-effect"]).toBe("local-read");
    const params = (operation?.parameters ?? []).filter((p) => p.name === "hasEnabledContainers");
    expect(params).toHaveLength(1);
    const param = params[0];
    expect(param).toMatchObject({
      in: "query",
      required: false,
      schema: { type: "string", enum: ["true", "false", "any"], default: "any" }
    });
    const description = param?.description ?? param?.schema?.description ?? "";
    expect(description).toMatch(/container/i);
    expect(description).toMatch(/enabled/i);
    expect(description).toMatch(/mirror|stored/i);
    expect(operation?.responses?.["400"]?.description).toMatch(/hasEnabledContainers/);
    const example = param?.example ?? param?.schema?.example;
    expect(["true", "false", "any"]).toContain(example);
    const replay = await page({ hasEnabledContainers: String(example) });
    expect(replay.response.status).toBe(200);
  });

  it("keeps hasEnabledContainers off the sibling lists, the changes feed and the by-id reads", async () => {
    const doc = await openApi();
    for (const path of [
      "/api/v1/customer-snapshot",
      "/api/v1/container-snapshot",
      "/api/v1/customer-snapshot/changes",
      "/api/v1/customer-snapshot/{customerId}",
      "/api/v1/address-snapshot/{pickupAddressId}",
      "/api/v1/container-snapshot/{containerId}"
    ]) {
      const names = (doc.paths[path]?.get?.parameters ?? []).map((p) => p.name);
      expect(names, path).not.toContain("hasEnabledContainers");
    }
  });
});

describe("address hasEnabledContainers query-policy inventory and recipe", () => {
  it("lists hasEnabledContainers in the canonical query-policy inventory for the address list only", () => {
    const row = (path: string) =>
      policyDoc.split("\n").find((line) => line.startsWith(`| \`${path}\` |`)) ?? "";
    expect(row("/api/v1/address-snapshot"), "address row").toContain("`hasEnabledContainers`");
    expect(row("/api/v1/customer-snapshot"), "customer row").not.toContain("hasEnabledContainers");
    expect(row("/api/v1/container-snapshot"), "container row").not.toContain("hasEnabledContainers");
    expect(policyDoc).toContain("test/addressEnabledContainerPresence.acceptance.test.ts");
  });

  it("states absence as no currently mirrored enabled child, not upstream proof", () => {
    const guidance = policyDoc.split(/^#{1,6} /m)
      .filter((section) => section.includes("hasEnabledContainers")).join("\n");
    expect(guidance).toMatch(/hasEnabledContainers/);
    expect(guidance).toMatch(/mirror/i);
    expect(guidance).toMatch(/upstream/i);
    expect(guidance).toMatch(/enabled/i);
  });

  it("documents the fixed value-free rejection detail in the problems catalogue", () => {
    expect(problemsDoc).toContain("hasEnabledContainers");
    expect(problemsDoc).toContain(BAD_REQUEST_DETAIL);
  });

  it("shows synthetic enabled-present/absent multi-page quickstart recipes without credentials", () => {
    const blocks = [...quickstartDoc.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((m) => m[1]);
    const present = blocks.find((b) => b.includes("hasEnabledContainers=true"));
    const absent = blocks.find((b) => b.includes("hasEnabledContainers=false"));
    expect(present, "enabled-present recipe").toBeDefined();
    expect(absent, "enabled-absent recipe").toBeDefined();
    for (const block of [present!, absent!]) {
      expect(block).toContain("/api/v1/address-snapshot");
      expect(block).toContain("localhost:8787");
      // The recipes stay credential-free: only the documented $TOKEN variable.
      expect(block).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
    }
    expect([present!, absent!].some((b) => b.includes("cursor")), "multi-page recipe").toBe(true);
  });
});

describe("address hasEnabledContainers local query-plan evidence", () => {
  it.each(["true", "false"] as const)("the correlated %s lookup can use idx_container_snapshot_pickup_address_id", async (value) => {
    const result = await page({ hasEnabledContainers: value, limit: 2 });
    expect(result.recorder.statements).toHaveLength(2);
    for (const statement of result.recorder.statements) {
      const plan = await explain(statement.sql, statement.binds);
      expect(plan, `${statement.method} plan:\n${plan}`).toContain("idx_container_snapshot_pickup_address_id");
      expect(plan).toContain("SEARCH");
    }
    // Local planner evidence only; no production-latency claim is made here.
  });

  it("the omitted/any plan touches no child table", async () => {
    const result = await page({});
    for (const statement of result.recorder.statements) {
      const plan = await explain(statement.sql, statement.binds);
      expect(plan).not.toContain("container_snapshot");
    }
  });
});
