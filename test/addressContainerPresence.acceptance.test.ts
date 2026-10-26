/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-author-owned oracle: `hasContainers=true|false|any` on the EXISTING
 * address list (`GET /api/v1/address-snapshot`), selecting addresses by
 * mirrored container presence. Independent of any implementation: every
 * expected page below is hand-derived from the fixtures.
 *
 * Fixture map (synthetic ids, no PII):
 *   address 11 (cust 100, enabled, "Needle")  children: none            -> absent
 *   address 12 (cust 100, enabled, "Needle")  children: 1 enabled        -> present
 *   address 13 (cust 200, DISABLED, "Other")  children: 2 enabled + 1 disabled -> present
 *   address 14 (cust 200, enabled, "Needle")  children: 1 DISABLED-only  -> present
 *   address 15 (cust 100, DISABLED, "Other")  children: none            -> absent
 *   address 16 (cust 300, enabled, "Needle")  children: none            -> absent
 * Present = {12,13,14}; absent = {11,15,16}. `q=needle` matches 11,12,14,16;
 * `q=other` matches 13,15 (address text only; city/state/zip carry neither
 * word so a sibling locality-`q` expansion stays compatible).
 *
 * Contract pinned here:
 *  - exact case-sensitive `true|false|any` enum, default `any`; invalid,
 *    blank or repeated keys 400 value-free before D1; auth precedes validation.
 *  - `true` = EXISTS a stored container with the same pickup_address_id;
 *    `false` = NOT EXISTS; `any`/omission adds no predicate. Disabled
 *    children count as present; address `enabled` stays independent.
 *  - correlated EXISTS/NOT EXISTS over the existing
 *    `idx_container_snapshot_pickup_address_id`, no join expanding parent
 *    rows, no per-row D1 calls, no child payload/count expansion.
 *  - AND-composition with customerId/pickupAddressId/q/enabled/cursor in both
 *    COUNT and page SQL; cursor-relative totals; offset; both seek directions;
 *    count-free mode; sparse fields; conditional envelope; next links carry
 *    non-any values through terminal/empty pages.
 *
 * Null/orphan links: the child column is NOT NULL and local D1 enforces the
 * snapshot FK chain (probed 2026-10-24: orphan insert -> FOREIGN KEY
 * constraint failed; NULL insert -> NOT NULL constraint failed; import-path
 * enforcement is pinned by `test/snapshotImportForeignKey.test.ts`), so
 * stored null/orphan fixtures are unrepresentable here. They are covered at
 * the SQL-semantics level instead: the presence predicate must be a plain
 * correlated equality with no null-tolerant (`IS NULL`, `OR`) or outer-join
 * shape, which by SQL semantics cannot match a null or dangling link.
 *
 * Real local D1 executes every recorded read; outbound fetch throws; no
 * network, no writes outside fixture seeding, no production-latency claim.
 * Expected RED before the paired build; do not skip or weaken these
 * assertions. Builder: consume this commit without editing this file;
 * request oracle corrections through a new bounded child card.
 */

const TEST_ENV = env as unknown as Env;
const READ_TOKEN = "test-read-token";
const ORIGIN = "https://presence.test.invalid";
const PATH = "/api/v1/address-snapshot";
const ID = "pickup_address_id";
const BAD_REQUEST_DETAIL = "Invalid request query (hasContainers). See docs/PROBLEMS.md#bad-request.";

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
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound fetch in presence acceptance"); }));
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
    [16, 300, 1, "16 Synthetic Needle Court"]
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
    [105, 14, 0]
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

describe("address hasContainers presence selection", () => {
  it("true returns exactly the addresses with a stored child, one row each", async () => {
    const result = await page({ hasContainers: "true" });
    expect(ids(result.body)).toEqual([12, 13, 14]);
    expect(result.body.total).toBe(3);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    expectNoDuplicates(result.body);
  });

  it("false returns exactly the addresses with no stored child", async () => {
    const result = await page({ hasContainers: "false" });
    expect(ids(result.body)).toEqual([11, 15, 16]);
    expect(result.body.total).toBe(3);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    expectNoDuplicates(result.body);
  });

  it("omitted and explicit any select every address with identical bytes and SQL", async () => {
    const omitted = await page({});
    const explicit = await page({ hasContainers: "any" });
    for (const result of [omitted, explicit]) {
      expect(ids(result.body)).toEqual([11, 12, 13, 14, 15, 16]);
      expect(result.body.total).toBe(6);
      expect(result.body.nextCursor).toBeNull();
    }
    expect(explicit.bytes).toBe(omitted.bytes);
    expect(explicit.recorder.statements).toEqual(omitted.recorder.statements);
  });

  it("counts a disabled-only child as present while address enabled stays independent", async () => {
    // Address 14's only child (105) is disabled, yet 14 is present; address
    // 13 is itself disabled with mixed children and is also present.
    const presentEnabled = await page({ hasContainers: "true", enabled: "true" });
    expect(ids(presentEnabled.body)).toEqual([12, 14]);
    const presentDisabled = await page({ hasContainers: "true", enabled: "false" });
    expect(ids(presentDisabled.body)).toEqual([13]);
    const absentEnabled = await page({ hasContainers: "false", enabled: "true" });
    expect(ids(absentEnabled.body)).toEqual([11, 16]);
    const absentDisabled = await page({ hasContainers: "false", enabled: "false" });
    expect(ids(absentDisabled.body)).toEqual([15]);
  });

  it("does not leak a sibling's child across addresses of the same customer", async () => {
    // Customer 100 owns 11 (absent), 12 (present) and 15 (absent): the child
    // at 12 must select only 12.
    const present = await page({ hasContainers: "true", customerId: 100 });
    expect(ids(present.body)).toEqual([12]);
    expect(present.body.total).toBe(1);
    const absent = await page({ hasContainers: "false", customerId: 100 });
    expect(ids(absent.body)).toEqual([11, 15]);
    expect(absent.body.total).toBe(2);
  });

  it.each([
    ["absent id under true", { hasContainers: "true", pickupAddressId: 11 }, []],
    ["present id under false", { hasContainers: "false", pickupAddressId: 13 }, []],
    ["unmatched text under true", { hasContainers: "true", q: "synthetic-no-match" }, []],
    ["unmatched text under false", { hasContainers: "false", q: "synthetic-no-match" }, []]
  ] as const)("empty selection %s: no rows, zero total, null cursor, no Link", async (_label, query, expectedIds) => {
    const result = await page({ ...query });
    expect(ids(result.body)).toEqual(expectedIds);
    expect(result.body.total).toBe(0);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  });
});

describe("address hasContainers selector intersections", () => {
  const CASES: Array<[string, Query, number[]]> = [
    ["true + customerId=100", { hasContainers: "true", customerId: 100 }, [12]],
    ["false + customerId=100", { hasContainers: "false", customerId: 100 }, [11, 15]],
    ["true + customerId=200", { hasContainers: "true", customerId: 200 }, [13, 14]],
    ["false + customerId=200", { hasContainers: "false", customerId: 200 }, []],
    ["false + customerId=300", { hasContainers: "false", customerId: 300 }, [16]],
    ["true + customerId=300", { hasContainers: "true", customerId: 300 }, []],
    ["true + pickupAddressId=13", { hasContainers: "true", pickupAddressId: 13 }, [13]],
    ["false + pickupAddressId=11", { hasContainers: "false", pickupAddressId: 11 }, [11]],
    ["true + q=needle", { hasContainers: "true", q: "needle" }, [12, 14]],
    ["false + q=needle", { hasContainers: "false", q: "needle" }, [11, 16]],
    ["true + q=other", { hasContainers: "true", q: "other" }, [13]],
    ["false + q=other", { hasContainers: "false", q: "other" }, [15]],
    ["true + enabled=true", { hasContainers: "true", enabled: "true" }, [12, 14]],
    ["true + enabled=false", { hasContainers: "true", enabled: "false" }, [13]],
    ["false + enabled=true", { hasContainers: "false", enabled: "true" }, [11, 16]],
    ["false + enabled=false", { hasContainers: "false", enabled: "false" }, [15]],
    ["true + customerId + enabled + q", { hasContainers: "true", customerId: 200, enabled: "true", q: "needle" }, [14]],
    ["false + customerId + enabled", { hasContainers: "false", customerId: 100, enabled: "false" }, [15]],
    ["true + q + cursor", { hasContainers: "true", q: "needle", cursor: 12, limit: 5 }, [14]],
    ["false + customerId + cursor", { hasContainers: "false", customerId: 100, cursor: 11, limit: 5 }, [15]]
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

describe("address hasContainers SQL mechanism", () => {
  it("true uses correlated EXISTS in COUNT and page SQL with exact binds and no join", async () => {
    const result = await page({ hasContainers: "true", limit: 2 });
    expect(result.recorder.statements).toHaveLength(2);
    const count = result.recorder.statements.find((s) => /\bCOUNT\s*\(/i.test(s.sql))!;
    const select = result.recorder.statements.find((s) => !/\bCOUNT\s*\(/i.test(s.sql))!;
    for (const statement of [count, select]) {
      expect(statement.sql).toMatch(/EXISTS\s*\(/i);
      expect(statement.sql).not.toMatch(/NOT\s+EXISTS/i);
      expect(statement.sql).toMatch(/container_snapshot/i);
      expect(statement.sql).toMatch(/pickup_address_id/i);
      expect(statement.sql).not.toMatch(/\bJOIN\b/i);
      expect(statement.sql).not.toMatch(/\bIS\s+NULL\b/i);
    }
    // The enum becomes a predicate, not a bind: only the page window binds.
    expect(count.binds).toEqual([]);
    expect(select.binds).toEqual([2, 0]);
    for (const bind of [...count.binds, ...select.binds]) expect(typeof bind).toBe("number");
  });

  it("false uses correlated NOT EXISTS in COUNT and page SQL with exact binds and no join", async () => {
    const result = await page({ hasContainers: "false", limit: 2 });
    expect(result.recorder.statements).toHaveLength(2);
    const count = result.recorder.statements.find((s) => /\bCOUNT\s*\(/i.test(s.sql))!;
    const select = result.recorder.statements.find((s) => !/\bCOUNT\s*\(/i.test(s.sql))!;
    for (const statement of [count, select]) {
      expect(statement.sql).toMatch(/NOT\s+EXISTS\s*\(/i);
      expect(statement.sql).toMatch(/container_snapshot/i);
      expect(statement.sql).toMatch(/pickup_address_id/i);
      expect(statement.sql).not.toMatch(/\bJOIN\b/i);
      expect(statement.sql).not.toMatch(/\bIS\s+NULL\b/i);
    }
    expect(count.binds).toEqual([]);
    expect(select.binds).toEqual([2, 0]);
  });

  it("omitted and any add no child predicate to either statement", async () => {
    const omitted = await page({ limit: 2 });
    const explicit = await page({ hasContainers: "any", limit: 2 });
    expect(explicit.recorder.statements).toEqual(omitted.recorder.statements);
    for (const statement of omitted.recorder.statements) {
      expect(statement.sql).not.toMatch(/EXISTS/i);
      expect(statement.sql).not.toMatch(/container_snapshot/i);
    }
  });

  it("keeps the seek cursor bound once per statement with the presence predicate", async () => {
    const result = await page({ hasContainers: "true", cursor: 12, limit: 1 });
    expect(ids(result.body)).toEqual([13]);
    expect(result.body.total).toBe(2);
    const count = result.recorder.statements.find((s) => /\bCOUNT\s*\(/i.test(s.sql))!;
    const select = result.recorder.statements.find((s) => !/\bCOUNT\s*\(/i.test(s.sql))!;
    expect(count.binds).toEqual([12]);
    expect(select.binds).toEqual([12, 1]);
    expect(select.sql).not.toMatch(/\bOFFSET\b/i);
  });
});

describe("address hasContainers pagination", () => {
  it("pages both directions with cursor-relative totals", async () => {
    const ascTrue = await page({ hasContainers: "true", limit: 1 });
    expect(ids(ascTrue.body)).toEqual([12]);
    expect(ascTrue.body.total).toBe(3);
    const descTrue = await page({ hasContainers: "true", limit: 1, order: "desc" });
    expect(ids(descTrue.body)).toEqual([14]);
    expect(descTrue.body.total).toBe(3);
    const descFalse = await page({ hasContainers: "false", limit: 2, order: "desc" });
    expect(ids(descFalse.body)).toEqual([16, 15]);
    const seekDesc = await page({ hasContainers: "true", order: "desc", cursor: 14, limit: 1 });
    expect(ids(seekDesc.body)).toEqual([13]);
    expect(seekDesc.body.total).toBe(2);
    const seekAsc = await page({ hasContainers: "false", cursor: 11, limit: 2 });
    expect(ids(seekAsc.body)).toEqual([15, 16]);
    expect(seekAsc.body.total).toBe(2);
  });

  it("omitted order and explicit asc stay identical under the presence filter", async () => {
    const omitted = await page({ hasContainers: "false", limit: 2 });
    const explicit = await page({ hasContainers: "false", limit: 2, order: "asc" });
    expect(explicit.body).toEqual(omitted.body);
    expect(explicit.recorder.statements).toEqual(omitted.recorder.statements);
  });

  it("cursor wins over offset under the presence filter", async () => {
    const result = await page({ hasContainers: "true", cursor: 12, offset: 99, limit: 5 });
    expect(ids(result.body)).toEqual([13, 14]);
    expect(result.body.total).toBe(2);
  });

  it.each([
    ["offset middle", { hasContainers: "false", limit: 2, offset: 1 }, [15, 16], 3, 16],
    ["offset partial terminal", { hasContainers: "true", limit: 2, offset: 2 }, [14], 3, null],
    ["offset past the end", { hasContainers: "true", limit: 1, offset: 3 }, [], 3, null]
  ] as const)("offset %s keeps the full filtered total", async (_label, query, expectedIds, total, cursor) => {
    const result = await page({ ...query });
    expect(ids(result.body)).toEqual(expectedIds);
    expect(result.body.total).toBe(total);
    expect(result.body.nextCursor).toBe(cursor);
    if (cursor === null) expect(result.response.headers.get("link")).toBeNull();
  });

  it("count-free mode returns the same rows with null total and zero COUNT", async () => {
    for (const value of ["true", "false"] as const) {
      const counted = await page({ hasContainers: value, limit: 1 });
      const free = await page({ hasContainers: value, limit: 1, includeTotal: "false" });
      expect(free.body.rows).toEqual(counted.body.rows);
      expect(free.body.nextCursor).toBe(counted.body.nextCursor);
      expect(free.body.total).toBeNull();
      expect(free.recorder.statements).toHaveLength(1);
      const countedPage = counted.recorder.statements.find((s) => !/\bCOUNT\s*\(/i.test(s.sql));
      expect(free.recorder.statements[0]).toEqual(countedPage);
    }
  });

  it("walks each filtered set by nextCursor alone, never issuing a COUNT", async () => {
    for (const [value, expected] of [["true", [12, 13, 14]], ["false", [11, 15, 16]]] as const) {
      const seen: unknown[] = [];
      let cursor: number | null = null;
      for (let walk = 0; walk < 6; walk++) {
        const query: Query = cursor === null
          ? { hasContainers: value, limit: 1, includeTotal: "false" }
          : { hasContainers: value, limit: 1, includeTotal: "false", cursor };
        const result = await page(query);
        expect(result.body.total).toBeNull();
        seen.push(...ids(result.body));
        if (result.body.nextCursor === null) break;
        cursor = result.body.nextCursor;
      }
      expect(seen).toEqual(expected);
    }
  });

  it("trims filtered rows to sparse fieldsets with the id always present", async () => {
    const present = await page({ hasContainers: "true", fields: "address" });
    expect(present.body.rows).toEqual([
      { [ID]: 12, address: "12 Synthetic Needle Way" },
      { [ID]: 13, address: "13 Synthetic Other Road" },
      { [ID]: 14, address: "14 Synthetic Needle Lane" }
    ]);
    const absent = await page({ hasContainers: "false", fields: "enabled" });
    expect(absent.body.rows).toEqual([
      { [ID]: 11, enabled: 1 },
      { [ID]: 15, enabled: 0 },
      { [ID]: 16, enabled: 1 }
    ]);
  });

  it.each(["true", "false"] as const)("replays a filtered envelope as an empty 304", async (value) => {
    const first = await page({ hasContainers: value });
    const tag = first.response.headers.get("etag");
    expect(tag).toMatch(/^".+"$/);
    const headers = new Headers();
    headers.set("authorization", `Bearer ${READ_TOKEN}`);
    headers.set("if-none-match", tag!);
    const replay = await app.fetch(new Request(new URL(`${PATH}?hasContainers=${value}`, ORIGIN), { headers }), TEST_ENV);
    expect(replay.status).toBe(304);
    expect(replay.headers.get("etag")).toBe(tag);
    expect((await replay.arrayBuffer()).byteLength).toBe(0);
    expect(replay.headers.get("cache-control")).toBe("no-store");
  });
});

describe("address hasContainers next links", () => {
  it.each(["true", "false"] as const)("carries %s through every page to a terminal empty page", async (value) => {
    const expected = value === "true" ? [12, 13, 14] : [11, 15, 16];
    const expectedTotals = [3, 2, 1, 0];
    let current = await page({ hasContainers: value, limit: 1 });
    const seen: unknown[] = [];
    for (let index = 0; index < 4; index++) {
      const pageIds = index < 3 ? [expected[index]] : [];
      expect(ids(current.body)).toEqual(pageIds);
      expect(current.body.total).toBe(expectedTotals[index]);
      seen.push(...ids(current.body));
      if (index === 3) {
        expect(current.body.nextCursor).toBeNull();
        expect(current.response.headers.get("link")).toBeNull();
      } else {
        const cursor = String(expected[index]);
        expect(current.body.nextCursor).toBe(Number(cursor));
        const target = nextTarget(current.response, current.url, { hasContainers: value, limit: "1", cursor });
        current = await follow(target);
      }
    }
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(3);
  });

  it("links a full terminal page to an empty page without lookahead", async () => {
    const first = await page({ hasContainers: "true", limit: 2 });
    expect(ids(first.body)).toEqual([12, 13]);
    expect(first.body.nextCursor).toBe(13);
    const second = await follow(nextTarget(first.response, first.url, { hasContainers: "true", limit: "2", cursor: "13" }));
    expect(ids(second.body)).toEqual([14]);
    expect(second.body.total).toBe(1);
    expect(second.body.nextCursor).toBeNull();
    expect(second.response.headers.get("link")).toBeNull();
  });

  it("keeps enabled=false and the presence value instead of dropping false-like filters", async () => {
    const first = await page({ hasContainers: "true", enabled: "false", limit: 1, includeTotal: "false" });
    expect(ids(first.body)).toEqual([13]);
    expect(first.body.nextCursor).toBe(13);
    const target = nextTarget(first.response, first.url, {
      hasContainers: "true", enabled: "false", limit: "1", includeTotal: "false", cursor: "13"
    });
    const empty = await follow(target);
    expect(ids(empty.body)).toEqual([]);
    expect(empty.body.total).toBeNull();
    expect(empty.body.nextCursor).toBeNull();
    expect(empty.response.headers.get("link")).toBeNull();
  });

  it("echoes explicit order, fields and count-free mode with the presence value", async () => {
    const filters = { hasContainers: "false", order: "desc", fields: `${ID},enabled`, limit: "1", includeTotal: "false" };
    const first = await page({ ...filters });
    expect(ids(first.body)).toEqual([16]);
    expect(first.body.rows).toEqual([{ [ID]: 16, enabled: 1 }]);
    const target = nextTarget(first.response, first.url, { ...filters, cursor: "16" });
    const second = await follow(target);
    expect(ids(second.body)).toEqual([15]);
    expect(second.body.rows).toEqual([{ [ID]: 15, enabled: 0 }]);
  });

  it.each([{}, { hasContainers: "any" }] as Array<Query>)("omits the presence key from continuations when %s", async (base) => {
    const first = await page({ ...base, limit: 5 });
    expect(ids(first.body)).toEqual([11, 12, 13, 14, 15]);
    expect(first.body.nextCursor).toBe(15);
    const target = nextTarget(first.response, first.url, { limit: "5", cursor: "15" });
    expect(target.searchParams.has("hasContainers")).toBe(false);
    const last = await follow(target);
    expect(ids(last.body)).toEqual([16]);
  });

  it("uses a fixed relative target and never reflects unknown keys or credentials", async () => {
    const clean = { hasContainers: "true", limit: "1", includeTotal: "false" };
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

describe("address hasContainers validation and auth precedence", () => {
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
    const result = await request(`hasContainers=${value}`, { db: db.db });
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
    "hasContainers=true&hasContainers=false",
    "hasContainers=any&hasContainers=any",
    "hasContainers=false&hasContainers=false"
  ])("rejects a repeated key before any D1 access: %s", async (search) => {
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

  it.each([
    "hasContainers=true",
    "hasContainers=secret-marker-xyz",
    "hasContainers=true&hasContainers=false"
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

  it("ignores an unknown key alongside the presence filter without changing bytes or SQL", async () => {
    const baseline = await page({ hasContainers: "true", limit: 2 });
    const tainted = await request(`${qs({ hasContainers: "true", limit: 2 })}&bogus_param=1`);
    expect(tainted.response.status).toBe(200);
    expect(await tainted.response.clone().text()).toBe(baseline.bytes);
    expect(tainted.recorder.statements).toEqual(baseline.recorder.statements);
  });

  it("serves a filtered page to the read token with no-store, CORS and request-ID correlation", async () => {
    const response = await exports.default.fetch(`http://test.local${PATH}?hasContainers=true&limit=1&includeTotal=false`, {
      headers: {
        authorization: `Bearer ${READ_TOKEN}`,
        origin: "https://app.example.com",
        "x-request-id": "synthetic-presence-trace"
      }
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe("synthetic-presence-trace");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeTruthy();
    expect(response.headers.get("access-control-expose-headers")?.toLowerCase()).toContain("x-request-id");
    const body = (await response.json()) as Body;
    expect(ids(body)).toEqual([12]);
    expect(body.total).toBeNull();
  });

  it("keeps request-ID echo and the anchored body on a rejected presence value", async () => {
    const response = await exports.default.fetch(`http://test.local${PATH}?hasContainers=secret-marker-xyz`, {
      headers: {
        authorization: `Bearer ${READ_TOKEN}`,
        origin: "https://app.example.com",
        "x-request-id": "synthetic-presence-error"
      }
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("x-request-id")).toBe("synthetic-presence-error");
    expect(response.headers.get("access-control-allow-origin")).toBeTruthy();
    expect(await response.json()).toEqual({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail: BAD_REQUEST_DETAIL
    });
  });
});

describe("address hasContainers served OpenAPI contract", () => {
  type Param = {
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: { type?: unknown; enum?: unknown[]; default?: unknown; description?: string };
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

  it("publishes hasContainers as an optional true|false|any query enum, default any", async () => {
    const doc = await openApi();
    const operation = doc.paths[PATH]?.get;
    expect(operation?.operationId).toBe("listAddressSnapshot");
    expect(operation?.["x-access"]).toBe("read");
    expect(operation?.["x-effect"]).toBe("local-read");
    const param = operation?.parameters?.find((p) => p.name === "hasContainers");
    expect(param).toMatchObject({
      in: "query",
      required: false,
      schema: { type: "string", enum: ["true", "false", "any"], default: "any" }
    });
    const description = param?.description ?? param?.schema?.description ?? "";
    expect(description).toMatch(/container/i);
    expect(description).toMatch(/mirror|stored|presence/i);
    expect(operation?.responses?.["400"]?.description).toMatch(/hasContainers/);
  });

  it("keeps hasContainers off the sibling lists, the changes feed and the by-id reads", async () => {
    const doc = await openApi();
    // The customer list has its own grandchild hasContainers (containers via
    // any owned address), pinned by test/customerContainerPresence.acceptance.test.ts;
    // only the remaining sibling list stays excluded here.
    for (const path of [
      "/api/v1/container-snapshot",
      "/api/v1/customer-snapshot/changes",
      "/api/v1/customer-snapshot/{customerId}",
      "/api/v1/address-snapshot/{pickupAddressId}",
      "/api/v1/container-snapshot/{containerId}"
    ]) {
      const names = (doc.paths[path]?.get?.parameters ?? []).map((p) => p.name);
      expect(names, path).not.toContain("hasContainers");
    }
  });
});

describe("address hasContainers query-policy inventory and recipe", () => {
  it("lists hasContainers in the canonical query-policy inventory for the address list only", () => {
    const row = (path: string) =>
      policyDoc.split("\n").find((line) => line.startsWith(`| \`${path}\` |`)) ?? "";
    expect(row("/api/v1/address-snapshot"), "address row").toContain("`hasContainers`");
    // The customer list carries its own grandchild hasContainers (see
    // test/customerContainerPresence.acceptance.test.ts); only the container
    // list stays excluded.
    expect(row("/api/v1/customer-snapshot"), "customer row").toContain("`hasContainers`");
    expect(row("/api/v1/container-snapshot"), "container row").not.toContain("hasContainers");
    expect(policyDoc).toContain("test/addressContainerPresence.acceptance.test.ts");
  });

  it("states absence as no currently mirrored child, not upstream proof", () => {
    const first = policyDoc.indexOf("hasContainers");
    expect(first).toBeGreaterThanOrEqual(0);
    const section = policyDoc.slice(first, first + 1200);
    expect(section).toMatch(/mirror/i);
    expect(section).toMatch(/upstream/i);
  });

  it("shows synthetic present/absent multi-page quickstart recipes without credentials", () => {
    const blocks = [...quickstartDoc.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((m) => m[1]);
    // Path-scoped: the customer list has its own hasContainers recipes sharing
    // the enum spelling (see test/customerContainerPresence.acceptance.test.ts).
    const present = blocks.find((b) => b.includes("hasContainers=true") && b.includes("/api/v1/address-snapshot"));
    const absent = blocks.find((b) => b.includes("hasContainers=false") && b.includes("/api/v1/address-snapshot"));
    expect(present, "present recipe").toBeDefined();
    expect(absent, "absent recipe").toBeDefined();
    for (const block of [present!, absent!]) {
      expect(block).toContain("/api/v1/address-snapshot");
      expect(block).toContain("localhost:8787");
      // The recipes stay credential-free: only the documented $TOKEN variable.
      expect(block).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
    }
    expect([present!, absent!].some((b) => b.includes("cursor")), "multi-page recipe").toBe(true);
  });
});

describe("address hasContainers local query-plan evidence", () => {
  it.each(["true", "false"] as const)("the correlated %s lookup can use idx_container_snapshot_pickup_address_id", async (value) => {
    const result = await page({ hasContainers: value, limit: 2 });
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
