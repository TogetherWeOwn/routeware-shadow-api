/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import snapshotDoc from "../CUSTOMER_SNAPSHOT.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import changelog from "../CHANGELOG.md?raw";
import { focusedChecks } from "./focusedChecks";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-author-owned contract, written without implementation diffs.
 * Run: npx vitest run --maxWorkers=2 test/customerAddressPresence.acceptance.test.ts
 *
 * Hand-derived fixture oracle (all synthetic):
 * customer 11: enabled, Needle company, CUST+& 001 / SITE/one, no addresses
 * customer 12: enabled, Needle company, CUST+& 001 / SITE/two, one enabled address
 * customer 13: disabled, Other company, CUST-200 / BRANCH-1, three mixed addresses
 * customer 14: enabled, Needle company, CUST-201 / BRANCH-2, one disabled address
 * customer 15: disabled, Other company, CUST+& 001 / ARCHIVE, no addresses
 * customer 16: enabled, Needle company, CUST-300 / NULL, no addresses
 * Present = [12,13,14]; absent = [11,15,16]. Address IDs deliberately differ
 * from customer IDs, catching a correlation against pickup_address_id.
 *
 * Mutations caught: ignored/reversed selector, uncorrelated EXISTS, enabled-child
 * filtering, join-expanded parents, OR leakage from q/ids, divergent COUNT/page
 * predicates or binds, count/lookahead work in count-free mode, dropped link
 * filters, reflected query/credential markers, and representation-wrong 304s.
 *
 * Normal FK fixtures only; no production/staging calls or real PII. Every list
 * read executes against migrated local D1. Fetch and R2 are denied. EXPLAIN
 * evidence is local planner evidence, not a production latency claim. GET is
 * an idempotent local read; CLI --dry-run is not applicable.
 * Intentional RED handoff: Builder consumes the commit without editing this
 * file. Oracle corrections belong to the Test Author, not implementation work.
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/customer-snapshot";
const ORIGIN = "https://customer-presence.invalid";
const TOKEN = "test-read-token";
const PROBLEM_TYPE = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
type Query = Record<string, string | number>;
type Statement = { sql: string; binds: unknown[]; method: string };
type Body = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };

function recordDb() {
  const statements: Statement[] = [];
  function wrap(real: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return new Proxy(real, {
      get(target, member) {
        const value = Reflect.get(target, member, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (member === "bind") return wrap(Reflect.apply(value, target, args), sql, args);
          statements.push({ sql, binds, method: String(member) });
          if (!["first", "all", "raw"].includes(String(member)) || !/^\s*SELECT\b/i.test(sql)) {
            throw new Error("Customer presence list must only execute SELECT reads");
          }
          return Reflect.apply(value, target, args);
        };
      }
    });
  }
  const db = {
    prepare: (sql: string) => wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []),
    batch: () => { throw new Error("List must not hide additional D1 work in batch"); },
    exec: () => { throw new Error("List must not exec D1 work"); }
  } as unknown as D1Database;
  return { db, statements };
}

function forbiddenDb() {
  const calls: string[] = [];
  const db = new Proxy({}, {
    get(_target, member) {
      return () => { calls.push(String(member)); throw new Error("Rejected request touched D1"); };
    }
  }) as D1Database;
  return { db, calls };
}

const r2Calls: string[] = [];
const deniedR2 = new Proxy({}, {
  get(_target, member) {
    return () => { r2Calls.push(String(member)); throw new Error("Local list touched R2"); };
  }
}) as R2Bucket;
const qs = (q: Query) => new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)])).toString();
const ids = (body: Body) => body.rows.map((row) => row.customer_id);

async function request(search = "", options: {
  token?: string | null; headers?: Record<string, string>; db?: D1Database;
} = {}) {
  const recorder = recordDb();
  const headers = new Headers(options.headers);
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const url = new URL(search ? `${PATH}?${search}` : PATH, ORIGIN);
  const response = await app.fetch(new Request(url, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: options.db ?? recorder.db, SNAPSHOTS: deniedR2
  });
  return { response, url, recorder };
}

async function readPage(search: string) {
  const result = await request(search);
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  expect(result.response.headers.get("cache-control")).toBe("no-store");
  const bytes = await result.response.clone().text();
  const body = JSON.parse(bytes) as Body;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  const expectedTag = `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
  expect(result.response.headers.get("etag")).toBe(expectedTag);
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  const counted = new URLSearchParams(search).get("includeTotal") !== "false";
  expect(result.recorder.statements).toHaveLength(counted ? 2 : 1);
  expect(result.recorder.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(counted ? 1 : 0);
  if (!counted) expect(body.total).toBeNull();
  expect(new Set(ids(body)).size).toBe(body.rows.length);
  for (const row of body.rows) {
    expect(typeof row.customer_id).toBe("number");
    expect(row).not.toHaveProperty("addresses");
    expect(row).not.toHaveProperty("address_count");
    expect(row).not.toHaveProperty("pickup_address_id");
  }
  return { ...result, body, bytes };
}
const page = (query: Query = {}) => readPage(qs(query));

function nextTarget(result: Awaited<ReturnType<typeof page>>, expected: Query) {
  const link = result.response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/customer-snapshot\?[^<>\s]*>; rel="next"$/);
  const raw = /^<([^>]+)>; rel="next"$/.exec(link!)![1];
  const target = new URL(raw, result.url);
  expect(target.origin).toBe(ORIGIN);
  expect(target.pathname).toBe(PATH);
  expect(target.hash + target.username + target.password).toBe("");
  const actual = new URLSearchParams(target.search);
  if (expected.includeTotal !== "false") {
    expect([null, "true"]).toContain(actual.get("includeTotal"));
    expect(actual.getAll("includeTotal").length).toBeLessThanOrEqual(1);
    actual.delete("includeTotal");
  }
  expect([...actual.keys()]).toHaveLength(Object.keys(expected).length);
  expect(Object.fromEntries(actual)).toEqual(Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, String(v)])));
  expect(actual.has("offset")).toBe(false);
  return target;
}

function expectPage(result: Awaited<ReturnType<typeof page>>, want: number[], total: number | null, next: number | null = null) {
  expect(ids(result.body)).toEqual(want);
  expect(result.body.total).toBe(total);
  expect(result.body.nextCursor).toBe(next);
  if (next === null) expect(result.response.headers.get("link")).toBeNull();
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  r2Calls.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound fetch in local presence acceptance"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  const customers: Array<[number, number, string, string, string, string, string | null]> = [
    [11, 1, "Synthetic Needle Eleven", "Alpha", "Local", "CUST+& 001", "SITE/one"],
    [12, 1, "Synthetic Needle Twelve", "Beta", "Local", "CUST+& 001", "SITE/two"],
    [13, 0, "Synthetic Other Thirteen", "Gamma", "Local", "CUST-200", "BRANCH-1"],
    [14, 1, "Synthetic Needle Fourteen", "Needle", "Local", "CUST-201", "BRANCH-2"],
    [15, 0, "Synthetic Other Fifteen", "Delta", "Local", "CUST+& 001", "ARCHIVE"],
    [16, 1, "Synthetic Needle Sixteen", "Epsilon", "Needle", "CUST-300", null]
  ];
  for (const [id, enabled, company, first, last, number, sub] of customers) {
    await db.prepare("INSERT INTO customer_snapshot (customer_id, enabled, company_name, first_name, last_name, customer_number, sub_customer_number, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'synthetic')")
      .bind(id, enabled, company, first, last, number, sub).run();
  }
  for (const [id, owner, enabled] of [[101, 12, 1], [102, 13, 1], [103, 13, 1], [104, 13, 0], [105, 14, 0]]) {
    await db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, ?, ?, 'synthetic')")
      .bind(id, owner, `Synthetic site ${id}`, enabled).run();
  }
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(r2Calls).toEqual([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("customer address presence selection", () => {
  it.each([
    ["true", [12, 13, 14]], ["false", [11, 15, 16]]
  ] as const)("%s selects the exact parent set, without expanding many children", async (value, want) => {
    const result = await page({ hasAddresses: value });
    expectPage(result, [...want], 3);
    expect(result.body.rows.every((row) => Object.values(row).every((v) => v === null || typeof v !== "object"))).toBe(true);
  });

  it("control: omission and any preserve the existing flat envelope, bytes and SQL", async () => {
    const omitted = await page();
    const any = await page({ hasAddresses: "any" });
    expectPage(omitted, [11, 12, 13, 14, 15, 16], 6);
    expectPage(any, [11, 12, 13, 14, 15, 16], 6);
    expect(any.bytes).toBe(omitted.bytes);
    expect(any.recorder.statements).toEqual(omitted.recorder.statements);
    for (const statement of omitted.recorder.statements) expect(statement.sql).not.toMatch(/address_snapshot|\bEXISTS\b/i);
  });

  it.each([
    ["true", "true", [12, 14]], ["true", "false", [13]],
    ["false", "true", [11, 16]], ["false", "false", [15]]
  ] as const)("hasAddresses=%s and enabled=%s keep parent and child enabled independent", async (presence, enabled, want) => {
    expectPage(await page({ hasAddresses: presence, enabled }), [...want], want.length);
  });

  it("a second identical GET is an idempotent local read", async () => {
    const first = await page({ hasAddresses: "true" });
    const again = await page({ hasAddresses: "true" });
    expectPage(again, [12, 13, 14], 3);
    expect(again.bytes).toBe(first.bytes);
    expect(again.response.headers.get("etag")).toBe(first.response.headers.get("etag"));
    const stored = await TEST_ENV.CUSTOMER_DB.prepare("SELECT COUNT(*) AS n FROM address_snapshot").first<{ n: number }>();
    expect(stored?.n).toBe(5);
  });
});

describe("customer address presence AND intersections", () => {
  const cases: Array<[string, Query, number[]]> = [
    ["true with ids", { hasAddresses: "true", ids: "11,12,13,15" }, [12, 13]],
    ["false with ids", { hasAddresses: "false", ids: "11,12,13,15" }, [11, 15]],
    ["true with absent ids", { hasAddresses: "true", ids: "11,15" }, []],
    ["false with present ids", { hasAddresses: "false", ids: "12,13,14" }, []],
    ["true with matching ID", { hasAddresses: "true", customerId: 13 }, [13]],
    ["false with matching ID", { hasAddresses: "false", customerId: 11 }, [11]],
    ["true with absent ID", { hasAddresses: "true", customerId: 11 }, []],
    ["false with present ID", { hasAddresses: "false", customerId: 13 }, []],
    ["true with q", { hasAddresses: "true", q: "needle" }, [12, 14]],
    ["false with q", { hasAddresses: "false", q: "needle" }, [11, 16]],
    ["true with other q", { hasAddresses: "true", q: "other" }, [13]],
    ["false with other q", { hasAddresses: "false", q: "other" }, [15]],
    ["true with exact customer number", { hasAddresses: "true", customerNumber: "CUST+& 001" }, [12]],
    ["false with exact customer number", { hasAddresses: "false", customerNumber: "CUST+& 001" }, [11, 15]],
    ["true with exact sub-account", { hasAddresses: "true", subCustomerNumber: "SITE/two" }, [12]],
    ["false with exact sub-account", { hasAddresses: "false", subCustomerNumber: "SITE/one" }, [11]],
    ["combined true", { hasAddresses: "true", customerId: 12, q: "needle", enabled: "true", upperId: 12 }, [12]],
    ["combined false", { hasAddresses: "false", customerId: 15, customerNumber: "CUST+& 001", enabled: "false" }, [15]],
    ["no text match", { hasAddresses: "true", q: "synthetic-no-match" }, []]
  ];
  it.each(cases)("%s constrains both rows and total", async (_label, query, want) => {
    expectPage(await page(query), want, want.length);
  });
});

describe("customer address presence pagination and SQL", () => {
  it.each(["true", "false"] as const)("%s uses the same correlated predicate and binds for COUNT and rows", async (value) => {
    const result = await page({ hasAddresses: value, ids: "11,12,13,14,15,16", customerNumber: "CUST+& 001", q: "needle", enabled: "true", upperId: 15, limit: 1 });
    const count = result.recorder.statements.find((s) => /\bCOUNT\s*\(/i.test(s.sql))!;
    const select = result.recorder.statements.find((s) => !/\bCOUNT\s*\(/i.test(s.sql))!;
    for (const statement of [count, select]) {
      expect(statement.sql).toMatch(value === "false" ? /NOT\s+EXISTS\s*\(/i : /(?<!NOT\s)\bEXISTS\s*\(/i);
      expect(statement.sql).toMatch(/address_snapshot/i);
      expect(statement.sql).not.toMatch(/\bJOIN\b/i);
      expect(statement.sql).not.toMatch(/\bIS\s+NULL\b/i);
      expect(statement.binds).not.toContain(value);
    }
    const where = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).replace(/\s+ORDER\s+BY[\s\S]*$/i, "").trim();
    expect(where(count.sql)).toBe(where(select.sql));
    expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
    expect(select.binds.length - count.binds.length).toBeLessThanOrEqual(2);
    expectPage(result, value === "true" ? [12] : [11], 1, value === "true" ? 12 : 11);
  });

  it.each([
    ["asc seek", { hasAddresses: "true", cursor: 12, limit: 1 }, [13], 2, 13],
    ["desc seek", { hasAddresses: "true", order: "desc", cursor: 14, limit: 1 }, [13], 2, 13],
    ["false desc", { hasAddresses: "false", order: "desc", limit: 2 }, [16, 15], 3, 15],
    ["cursor wins over offset", { hasAddresses: "true", cursor: 12, offset: 99, limit: 5 }, [13, 14], 2, null],
    ["offset middle", { hasAddresses: "false", offset: 1, limit: 2 }, [15, 16], 3, 16],
    ["offset partial end", { hasAddresses: "true", offset: 2, limit: 2 }, [14], 3, null],
    ["offset empty end", { hasAddresses: "true", offset: 3, limit: 1 }, [], 3, null],
    ["inclusive upperId", { hasAddresses: "true", upperId: 13, limit: 5 }, [12, 13], 2, null],
    ["upperId with desc cursor", { hasAddresses: "false", upperId: 15, cursor: 15, order: "desc", limit: 5 }, [11], 1, null],
    ["empty upperId", { hasAddresses: "true", upperId: 11 }, [], 0, null]
  ] as Array<[string, Query, number[], number, number | null]>)("%s preserves seek/offset/ceiling semantics", async (_label, query, want, total, next) => {
    expectPage(await page(query), want, total, next);
  });

  it.each(["true", "false", "any"] as const)("%s count-free uses one SELECT and no COUNT or lookahead", async (value) => {
    const counted = await page({ hasAddresses: value, limit: 2 });
    const free = await page({ hasAddresses: value, limit: 2, includeTotal: "false" });
    const want = value === "true" ? [12, 13] : value === "false" ? [11, 15] : [11, 12];
    expectPage(free, want, null, want[1]);
    expect(free.body.rows).toEqual(counted.body.rows);
    expect(free.body.nextCursor).toBe(counted.body.nextCursor);
    expect(free.recorder.statements[0]).toEqual(counted.recorder.statements.find((s) => !/\bCOUNT\s*\(/i.test(s.sql)));
  });

  it("sparse output always retains canonical customer_id, never a child ID", async () => {
    const present = await page({ hasAddresses: "true", fields: "enabled" });
    expect(present.body.rows).toEqual([
      { customer_id: 12, enabled: 1 }, { customer_id: 13, enabled: 0 }, { customer_id: 14, enabled: 1 }
    ]);
    const absent = await page({ hasAddresses: "false", fields: "customer_number" });
    expect(absent.body.rows).toEqual([
      { customer_id: 11, customer_number: "CUST+& 001" },
      { customer_id: 15, customer_number: "CUST+& 001" },
      { customer_id: 16, customer_number: "CUST-300" }
    ]);
  });

  it.each(["true", "false"] as const)("%s EXPLAIN uses the existing child customer index for both statements", async (value) => {
    const result = await page({ hasAddresses: value, limit: 2 });
    for (const statement of result.recorder.statements) {
      const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.binds).all<{ detail: string }>();
      const details = (plan.results ?? []).map((r) => r.detail).join("\n");
      expect(details).toContain("idx_address_snapshot_customer_id");
      expect(details).toMatch(/SEARCH/i);
    }
  });
});

describe("customer address presence next-link traversal", () => {
  it.each([
    ["true", "asc", [12, 13, 14]], ["false", "asc", [11, 15, 16]],
    ["true", "desc", [14, 13, 12]], ["false", "desc", [16, 15, 11]]
  ] as const)("walks %s %s by returned relative links without duplicate parents", async (value, order, want) => {
    const filters = { hasAddresses: value, order, limit: 1, includeTotal: "false" };
    let current = await page(filters);
    const seen: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      expectPage(current, i < 3 ? [want[i]] : [], null, i < 3 ? want[i] : null);
      seen.push(...ids(current.body));
      if (i < 3) {
        const target = nextTarget(current, { ...filters, cursor: want[i] });
        current = await readPage(target.search.slice(1));
      }
    }
    expect(seen).toEqual([...want]);
    expect(new Set(seen).size).toBe(3);
  });

  it("counted links preserve the selector and cursor-relative total through the empty terminal page", async () => {
    let current = await page({ hasAddresses: "true", limit: 1 });
    for (const [want, total, next] of [[[12], 3, 12], [[13], 2, 13], [[14], 1, 14], [[], 0, null]] as const) {
      expectPage(current, [...want], total, next);
      if (next !== null) current = await readPage(nextTarget(current, { hasAddresses: "true", limit: 1, cursor: next }).search.slice(1));
    }
  });

  it.each([{}, { hasAddresses: "any" }] as Query[])("control: %j omits default presence from next links", async (filter) => {
    const first = await page({ ...filter, limit: 5 });
    expectPage(first, [11, 12, 13, 14, 15], 6, 15);
    const target = nextTarget(first, { limit: 5, cursor: 15 });
    expect(target.searchParams.has("hasAddresses")).toBe(false);
    expectPage(await readPage(target.search.slice(1)), [16], 1);
  });

  it("round-trips encoded business numbers, ids, q, false-like values and fields without echoing unknowns", async () => {
    const filters = {
      hasAddresses: "false", ids: "11,12,13,15", customerId: 15, customerNumber: "CUST+& 001", subCustomerNumber: "ARCHIVE",
      q: "other", enabled: "false", upperId: 15, order: "desc", fields: "customer_id,customer_number", limit: 1, includeTotal: "false"
    };
    const clean = await page(filters);
    expectPage(clean, [15], null, 15);
    const tainted = await readPage(`${qs(filters)}&token=query-credential-marker&bogus_param=unknown-marker&url=https%3A%2F%2Fredirect-marker.invalid`);
    expect(tainted.bytes).toBe(clean.bytes);
    expect(tainted.recorder.statements).toEqual(clean.recorder.statements);
    const target = nextTarget(tainted, { ...filters, cursor: 15 });
    expect(tainted.response.headers.get("link")).not.toMatch(/marker|Bearer|test-read-token|https?:|\/\//);
    expectPage(await readPage(target.search.slice(1)), [], null);
  });

  it("ignores untrusted host/origin headers when choosing a fixed relative target", async () => {
    const baseline = await page({ hasAddresses: "true", limit: 1 });
    const tainted = await request(qs({ hasAddresses: "true", limit: 1 }), {
      headers: { host: "host-marker.invalid", origin: "https://origin-marker.invalid", "x-forwarded-host": "forwarded-marker.invalid" }
    });
    expect(tainted.response.status).toBe(200);
    expect(tainted.response.headers.get("link")).toBe(baseline.response.headers.get("link"));
    expect(tainted.response.headers.get("link")).not.toMatch(/marker|https?:|\/\//);
    expectPage(baseline, [12], 3, 12);
  });
});

describe("customer address presence conditional representations", () => {
  it.each(["true", "false"] as const)("%s replays the exact envelope as an empty 304", async (value) => {
    const query = { hasAddresses: value, fields: "enabled", limit: 2, includeTotal: "false" };
    const first = await page(query);
    const tag = first.response.headers.get("etag");
    expect(tag).toMatch(/^".+"$/);
    const replay = await request(qs(query), { headers: { "if-none-match": tag! } });
    expect(replay.response.status).toBe(304);
    expect(await replay.response.text()).toBe("");
    expect(replay.response.headers.get("etag")).toBe(tag);
    expect(replay.response.headers.get("cache-control")).toBe("no-store");
    expect(replay.response.headers.get("link")).toBe(first.response.headers.get("link"));
  });

  it.each([
    ["opposite selector", { hasAddresses: "false", fields: "enabled", limit: 2, includeTotal: "false" }],
    ["counted envelope", { hasAddresses: "true", fields: "enabled", limit: 2 }],
    ["different fieldset", { hasAddresses: "true", fields: "company_name", limit: 2, includeTotal: "false" }],
    ["different page", { hasAddresses: "true", fields: "enabled", limit: 2, cursor: 12, includeTotal: "false" }]
  ] as Array<[string, Query]>)("does not 304 a %s using another representation's tag", async (_label, query) => {
    const first = await page({ hasAddresses: "true", fields: "enabled", limit: 2, includeTotal: "false" });
    const other = await request(qs(query), { headers: { "if-none-match": first.response.headers.get("etag")! } });
    expect(other.response.status).toBe(200);
    expect(other.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
    expect(await other.response.text()).not.toBe(first.bytes);
  });
});

describe("customer address presence strict validation and auth", () => {
  const invalid = [
    "hasAddresses", "hasAddresses=", "hasAddresses=TRUE", "hasAddresses=True", "hasAddresses=1", "hasAddresses=0",
    "hasAddresses=yes", "hasAddresses=%20true", "hasAddresses=false%20", "hasAddresses=true%2Cfalse",
    "hasAddresses=null", "hasAddresses=secret-marker-xyz", "hasAddresses=true&hasAddresses=false",
    "hasAddresses=any&hasAddresses=any", "hasAddresses=false&hasAddresses=false"
  ];
  it.each(invalid)("rejects %s before D1 with value-free actionable problem JSON", async (search) => {
    const denied = forbiddenDb();
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((m) => vi.spyOn(console, m));
    const result = await request(search, { db: denied.db });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    expect(result.response.headers.get("link")).toBeNull();
    const body = await result.response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["detail", "status", "title", "type"]);
    expect(body).toMatchObject({ type: PROBLEM_TYPE, title: "Bad Request", status: 400 });
    expect(body.detail).toEqual(expect.any(String));
    expect(String(body.detail)).toMatch(/hasAddresses/);
    expect(String(body.detail)).toMatch(/true[\s\S]*false[\s\S]*any/);
    expect(String(body.detail)).toMatch(/one|single/i);
    expect(String(body.detail)).toMatch(/omit/i);
    expect(String(body.detail)).toMatch(/retry/i);
    expect(JSON.stringify(body)).not.toMatch(/secret-marker-xyz|%20|%2C|TRUE|True|yes|null/);
    expect(denied.calls).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each(["hasAddresses=true", "hasAddresses=secret-marker-xyz", "hasAddresses=true&hasAddresses=false"])("control: auth precedes validation for %s", async (search) => {
    for (const token of [null, "synthetic-wrong-token"]) {
      const denied = forbiddenDb();
      const result = await request(search, { token, db: denied.db });
      expect(result.response.status).toBe(401);
      expect(result.response.headers.get("content-type")).toContain("application/problem+json");
      expect(result.response.headers.get("link")).toBeNull();
      expect(await result.response.text()).not.toContain("secret-marker-xyz");
      expect(denied.calls).toEqual([]);
    }
  });
});

describe("customer address presence mounted discovery", () => {
  type Param = { name: string; in: string; required?: boolean; description?: string; schema?: { description?: string; [key: string]: unknown } };
  type Operation = { operationId?: string; parameters?: Param[]; responses?: Record<string, { description?: string }>; [key: string]: unknown };
  async function openApi() {
    const response = await exports.default.fetch("http://test.local/openapi.json");
    expect(response.status).toBe(200);
    return await response.json() as { paths: Record<string, { get?: Operation }> };
  }

  it("serves optional true|false|any discovery with the local-read and idempotent agent contract", async () => {
    const doc = await openApi();
    const operation = doc.paths[PATH]?.get;
    expect(operation).toMatchObject({ operationId: "listCustomerSnapshot", "x-access": "read", "x-effect": "local-read" });
    const params = operation?.parameters?.filter((p) => p.name === "hasAddresses");
    expect(params).toHaveLength(1);
    expect(params![0]).toMatchObject({ in: "query", required: false, schema: { type: "string", enum: ["true", "false", "any"], default: "any" } });
    const prose = `${params![0].description ?? ""} ${params![0].schema?.description ?? ""}`;
    expect(prose).toMatch(/address|site/i);
    expect(prose).toMatch(/mirror|stored/i);
    expect(prose).toMatch(/disabled/i);
    expect(prose).toMatch(/one|single/i);
    expect(prose).toMatch(/omit/i);
    expect(prose).toMatch(/retry/i);
    expect(operation?.responses?.["400"]?.description).toMatch(/hasAddresses/);
  });

  it("keeps hasAddresses off siblings, changes and by-ID operations", async () => {
    const doc = await openApi();
    for (const path of ["/api/v1/address-snapshot", "/api/v1/container-snapshot", "/api/v1/customer-snapshot/changes", "/api/v1/customer-snapshot/{customerId}", "/api/v1/address-snapshot/{pickupAddressId}", "/api/v1/container-snapshot/{containerId}"]) {
      expect((doc.paths[path]?.get?.parameters ?? []).map((p) => p.name), path).not.toContain("hasAddresses");
    }
  });

  it("provides a schema-valid parameter example an agent can replay", async () => {
    const doc = await openApi();
    const param = doc.paths[PATH]?.get?.parameters?.find((p) => p.name === "hasAddresses");
    const example = (param as (Param & { example?: unknown }) | undefined)?.example ?? param?.schema?.example;
    expect(["true", "false", "any"]).toContain(example);
    const result = await page({ hasAddresses: String(example) });
    const want = example === "true" ? [12, 13, 14] : example === "false" ? [11, 15, 16] : [11, 12, 13, 14, 15, 16];
    expectPage(result, want, want.length);
  });
});

// These are machine-consumed selection/safety instructions, not human prose
// style pins: an agent must discover the selector without inferring upstream
// completeness or permission to write from the absence of a mirrored child.
describe("customer address presence agent guidance", () => {
  it("inventories the selector only on the customer list and links the focused oracle", () => {
    const row = (path: string) => policyDoc.split("\n").find((line) => line.startsWith(`| \`${path}\` |`)) ?? "";
    expect(row(PATH)).toContain("`hasAddresses`");
    for (const path of ["/api/v1/address-snapshot", "/api/v1/container-snapshot"]) expect(row(path)).not.toContain("hasAddresses");
    expect(policyDoc).toContain("test/customerAddressPresence.acceptance.test.ts");
  });

  it("explains mirrored-only absence and forbids treating it as authority to mutate upstream", () => {
    const sections = policyDoc.split(/^#{1,6} /m).filter((section) => section.includes("hasAddresses"));
    const guidance = sections.join("\n");
    expect(guidance).toMatch(/hasAddresses/);
    expect(guidance).toMatch(/mirror/i);
    expect(guidance).toMatch(/upstream/i);
    expect(guidance).toMatch(/not (?:proof|evidence)|does not (?:prove|mean)|no (?:proof|guarantee)/i);
    expect(guidance).toMatch(/delet/i);
    expect(guidance).toMatch(/reconcil/i);
    expect(guidance).toMatch(/sync/i);
    expect(guidance).toMatch(/never|does not authori[sz]e|must not|not permission/i);
    expect(snapshotDoc).toContain("hasAddresses");
  });

  it("publishes local synthetic present/absent recipes that can be traversed", () => {
    const blocks = [...quickstartDoc.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((m) => m[1]);
    for (const value of ["true", "false"]) {
      const recipe = blocks.find((b) => b.includes(`hasAddresses=${value}`));
      expect(recipe, `local ${value} recipe`).toBeDefined();
      expect(recipe).toContain(PATH);
      expect(recipe).toContain("localhost:8787");
      expect(recipe).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
    }
    expect(blocks.some((b) => b.includes("hasAddresses=") && /cursor|rel=.next|[Ll]ink/.test(b))).toBe(true);
    expect(changelog.split(/^## /m)[1]).toContain("hasAddresses");
  });

  it("exposes a named local-only focused check that includes this acceptance suite", () => {
    const command = focusedChecks["customer-address-presence"];
    expect(command).toEqual(expect.any(String));
    expect(command).toMatch(/vitest\s+run/);
    expect(command).toContain("test/customerAddressPresence.acceptance.test.ts");
    expect(command).not.toMatch(/--remote|deploy|probe:post-deploy/);
  });
});
