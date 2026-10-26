/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import snapshotDoc from "../CUSTOMER_SNAPSHOT.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import changelog from "../CHANGELOG.md?raw";
import packageJson from "../package.json";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-author-owned contract, written without implementation diffs.
 * Run: npx vitest run --maxWorkers=2 test/customerContainerPresence.acceptance.test.ts
 *
 * Hand-derived fixture oracle (all synthetic):
 * customer 11: enabled, Needle company, CUST+& 001 / SITE/one, no addresses
 * customer 12: enabled, Needle company, CUST+& 001 / SITE/two, one enabled address (101) with one enabled container
 * customer 13: disabled, Other company, CUST-200 / BRANCH-1, three addresses:
 *   102 enabled with one enabled + one disabled container, 103 enabled with none,
 *   104 disabled with one disabled + one enabled container
 * customer 14: enabled, Needle company, CUST-201 / BRANCH-2, one disabled address (105) with no containers
 * customer 15: disabled, Other company, CUST+& 001 / ARCHIVE, no addresses
 * customer 16: enabled, Needle company, CUST-300 / NULL, no addresses
 * Present (hasContainers=true) = [12,13]; absent (false) = [11,14,15,16].
 * Address/container IDs deliberately differ from customer IDs, catching a
 * correlation against the wrong key. Container IDs (201-205) differ from both.
 *
 * Presence is GLOBAL to the customer: at least one stored container reachable
 * through ANY stored address owned by that customer. Customer 13 proves it —
 * address 103 has no equipment yet 13 is present via 102/104. If site-cohort
 * controls ever merge on this list, descendant presence stays global, never
 * restricted to the site matching that separate cohort; no same-site
 * membership is claimed. At this baseline no site-cohort control exists on
 * the customer list, so no cohort interaction is pinned here.
 *
 * Mutations caught: ignored/reversed selector, uncorrelated or single-level
 * EXISTS, disabled-address/container filtering, join-expanded parents,
 * cross-customer equipment leakage, OR leakage from q/ids, divergent
 * COUNT/page predicates or binds, count/lookahead work in count-free or
 * count-only modes, dropped link filters, reflected query/credential
 * markers, and representation-wrong 304s.
 *
 * Normal FK fixtures only; no production/staging calls or real PII. Every
 * list read executes against migrated local D1. Fetch and R2 are denied.
 * EXPLAIN evidence is local planner evidence, not a production latency
 * claim. GET is an idempotent local read; CLI --dry-run is not applicable.
 * Orphan/null links are unrepresentable (local D1 enforces the snapshot FK
 * chain and NOT NULL); they are covered at the SQL-semantics level instead:
 * the predicate must be correlated equalities with no null-tolerant
 * (`IS NULL`, `OR`) or outer-join shape. Intentional RED handoff: Builder
 * consumes the commit without editing this file. Oracle corrections belong
 * to the Test Author, not implementation work.
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/customer-snapshot";
const ORIGIN = "https://customer-container-presence.invalid";
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
  const params = new URLSearchParams(search);
  const counted = params.get("includeTotal") !== "false";
  const countOnly = params.get("countOnly") === "true";
  if (countOnly) {
    expect(body.rows).toEqual([]);
    expect(body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.recorder.statements).toHaveLength(1);
    expect(result.recorder.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(1);
  } else {
    expect(result.recorder.statements).toHaveLength(counted ? 2 : 1);
    expect(result.recorder.statements.filter((s) => /\bCOUNT\s*\(/i.test(s.sql))).toHaveLength(counted ? 1 : 0);
    if (!counted) expect(body.total).toBeNull();
  }
  expect(new Set(ids(body)).size).toBe(body.rows.length);
  for (const row of body.rows) {
    expect(typeof row.customer_id).toBe("number");
    expect(row).not.toHaveProperty("addresses");
    expect(row).not.toHaveProperty("address_count");
    expect(row).not.toHaveProperty("containers");
    expect(row).not.toHaveProperty("container_count");
    expect(row).not.toHaveProperty("pickup_address_id");
    expect(row).not.toHaveProperty("container_id");
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
  const customers: Array<[number, number, string, string, string, string, string | null, string, string]> = [
    [11, 1, "Synthetic Needle Eleven", "Alpha", "Local", "CUST+& 001", "SITE/one", "5550101", "Synthetic handoff eleven"],
    [12, 1, "Synthetic Needle Twelve", "Beta", "Local", "CUST+& 001", "SITE/two", "5550102", "Synthetic handoff twelve"],
    [13, 0, "Synthetic Other Thirteen", "Gamma", "Local", "CUST-200", "BRANCH-1", "5550103", "Synthetic other thirteen"],
    [14, 1, "Synthetic Needle Fourteen", "Needle", "Local", "CUST-201", "BRANCH-2", "5550104", "Synthetic handoff fourteen"],
    [15, 0, "Synthetic Other Fifteen", "Delta", "Local", "CUST+& 001", "ARCHIVE", "5550105", "Synthetic other fifteen"],
    [16, 1, "Synthetic Needle Sixteen", "Epsilon", "Needle", "CUST-300", null, "5550106", "Synthetic handoff sixteen"]
  ];
  for (const [id, enabled, company, first, last, number, sub, phone, comments] of customers) {
    await db.prepare("INSERT INTO customer_snapshot (customer_id, enabled, company_name, first_name, last_name, customer_number, sub_customer_number, phone1, comments, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'synthetic')")
      .bind(id, enabled, company, first, last, number, sub, phone, comments).run();
  }
  for (const [id, owner, enabled] of [[101, 12, 1], [102, 13, 1], [103, 13, 1], [104, 13, 0], [105, 14, 0]]) {
    await db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, ?, ?, 'synthetic')")
      .bind(id, owner, `Synthetic site ${id}`, enabled).run();
  }
  for (const [id, owner, enabled] of [[201, 101, 1], [202, 102, 1], [203, 102, 0], [204, 104, 0], [205, 104, 1]]) {
    await db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, enabled, synced_at) VALUES (?, ?, ?, ?, ?, 'synthetic')")
      .bind(id, owner, `synthetic-container-${id}`, `synthetic-serial-${id}`, enabled).run();
  }
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(r2Calls).toEqual([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("customer container presence selection", () => {
  it.each([
    ["true", [12, 13]], ["false", [11, 14, 15, 16]]
  ] as const)("%s selects the exact account set, without expanding many sites or equipment", async (value, want) => {
    const result = await page({ hasContainers: value });
    expectPage(result, [...want], want.length);
    expect(result.body.rows.every((row) => Object.values(row).every((v) => v === null || typeof v !== "object"))).toBe(true);
  });

  it("control: omission and any preserve the existing flat envelope, bytes and SQL", async () => {
    const omitted = await page();
    const any = await page({ hasContainers: "any" });
    expectPage(omitted, [11, 12, 13, 14, 15, 16], 6);
    expectPage(any, [11, 12, 13, 14, 15, 16], 6);
    expect(any.bytes).toBe(omitted.bytes);
    expect(any.recorder.statements).toEqual(omitted.recorder.statements);
    for (const statement of omitted.recorder.statements) expect(statement.sql).not.toMatch(/container_snapshot|\bEXISTS\b/i);
  });

  it.each([
    ["true", "true", [12]], ["true", "false", [13]],
    ["false", "true", [11, 14, 16]], ["false", "false", [15]]
  ] as const)("hasContainers=%s and enabled=%s keep account and equipment enabled independent", async (presence, enabled, want) => {
    expectPage(await page({ hasContainers: presence, enabled }), [...want], want.length);
  });

  it("presence is global: an account with an unequipped site stays present via another site", async () => {
    // Customer 13 owns empty site 103 alongside equipped 102/104: ANY-site
    // reachability selects 13. Never read this as same-site membership.
    expectPage(await page({ hasContainers: "true", customerId: 13 }), [13], 1);
    expectPage(await page({ hasContainers: "false", customerId: 13 }), [], 0);
  });

  it("never selects an unequipped account via another account's equipment", async () => {
    // CUST+& 001 spans unequipped 11/15 and equipped 12: only 12 matches.
    expectPage(await page({ hasContainers: "true", customerNumber: "CUST+& 001" }), [12], 1);
    expectPage(await page({ hasContainers: "false", customerNumber: "CUST+& 001" }), [11, 15], 2);
  });

  it("a second identical GET is an idempotent local read", async () => {
    const first = await page({ hasContainers: "true" });
    const again = await page({ hasContainers: "true" });
    expectPage(again, [12, 13], 2);
    expect(again.bytes).toBe(first.bytes);
    expect(again.response.headers.get("etag")).toBe(first.response.headers.get("etag"));
    const stored = await TEST_ENV.CUSTOMER_DB.prepare("SELECT COUNT(*) AS n FROM container_snapshot").first<{ n: number }>();
    expect(stored?.n).toBe(5);
  });
});

describe("customer container presence AND intersections", () => {
  const cases: Array<[string, Query, number[]]> = [
    ["true with ids", { hasContainers: "true", ids: "11,12,13,15" }, [12, 13]],
    ["false with ids", { hasContainers: "false", ids: "11,12,13,15" }, [11, 15]],
    ["true with absent ids", { hasContainers: "true", ids: "11,14,15,16" }, []],
    ["false with present ids", { hasContainers: "false", ids: "12,13" }, []],
    ["true with matching ID", { hasContainers: "true", customerId: 12 }, [12]],
    ["false with matching ID", { hasContainers: "false", customerId: 14 }, [14]],
    ["true with absent ID", { hasContainers: "true", customerId: 14 }, []],
    ["false with present ID", { hasContainers: "false", customerId: 12 }, []],
    ["true with q", { hasContainers: "true", q: "needle" }, [12]],
    ["false with q", { hasContainers: "false", q: "needle" }, [11, 14, 16]],
    ["true with other q", { hasContainers: "true", q: "other" }, [13]],
    ["false with other q", { hasContainers: "false", q: "other" }, [15]],
    ["true with phone fragment", { hasContainers: "true", phone: "5550102" }, [12]],
    ["false with phone fragment", { hasContainers: "false", phone: "5550104" }, [14]],
    ["true with comments fragment", { hasContainers: "true", comments: "handoff" }, [12]],
    ["false with comments fragment", { hasContainers: "false", comments: "handoff" }, [11, 14, 16]],
    ["true with other comments", { hasContainers: "true", comments: "other" }, [13]],
    ["false with other comments", { hasContainers: "false", comments: "other" }, [15]],
    ["true with exact customer number", { hasContainers: "true", customerNumber: "CUST-200" }, [13]],
    ["false with exact customer number", { hasContainers: "false", customerNumber: "CUST-201" }, [14]],
    ["true with exact sub-account", { hasContainers: "true", subCustomerNumber: "BRANCH-1" }, [13]],
    ["false with exact sub-account", { hasContainers: "false", subCustomerNumber: "SITE/one" }, [11]],
    ["combined true", { hasContainers: "true", customerId: 12, q: "needle", phone: "5550102", enabled: "true", upperId: 12 }, [12]],
    ["combined false", { hasContainers: "false", customerId: 15, customerNumber: "CUST+& 001", comments: "other", enabled: "false" }, [15]],
    ["no text match", { hasContainers: "true", q: "synthetic-no-match" }, []]
  ];
  it.each(cases)("%s constrains both rows and total", async (_label, query, want) => {
    expectPage(await page(query), want, want.length);
  });
});

describe("customer container presence with hasAddresses", () => {
  it.each([
    ["true", "true", [12, 13]],
    ["true", "false", [14]],
    ["false", "true", []],
    ["false", "false", [11, 15, 16]]
  ] as const)("hasAddresses=%s and hasContainers=%s intersect at the account level", async (sites, equipment, want) => {
    expectPage(await page({ hasAddresses: sites, hasContainers: equipment }), [...want], want.length);
  });

  it("sites-false plus equipment-true is an empty 200 contradiction, not an error", async () => {
    const result = await page({ hasAddresses: "false", hasContainers: "true" });
    expectPage(result, [], 0);
  });

  it("sites-true plus equipment-false keeps the account with sites but no equipment", async () => {
    expectPage(await page({ hasAddresses: "true", hasContainers: "false" }), [14], 1);
  });
});

describe("customer container presence pagination and SQL", () => {
  it.each(["true", "false"] as const)("%s uses the same correlated grandchild predicate and binds for COUNT and rows", async (value) => {
    const result = await page({ hasContainers: value, ids: "11,12,13,14,15,16", customerNumber: "CUST+& 001", q: "needle", phone: "5550101", enabled: "true", upperId: 16, limit: 1 });
    const count = result.recorder.statements.find((s) => /\bCOUNT\s*\(/i.test(s.sql))!;
    const select = result.recorder.statements.find((s) => !/\bCOUNT\s*\(/i.test(s.sql))!;
    for (const statement of [count, select]) {
      expect(statement.sql).toMatch(value === "false" ? /NOT\s+EXISTS\s*\(/i : /(?<!NOT\s)\bEXISTS\s*\(/i);
      expect(statement.sql).toMatch(/address_snapshot/i);
      expect(statement.sql).toMatch(/container_snapshot/i);
      expect(statement.sql).toMatch(/customer_id/i);
      expect(statement.sql).toMatch(/pickup_address_id/i);
      expect(statement.sql).not.toMatch(/\bJOIN\b/i);
      expect(statement.sql).not.toMatch(/\bIS\s+NULL\b/i);
      expect(statement.binds).not.toContain(value);
    }
    const where = (sql: string) => sql.slice(sql.search(/\bWHERE\b/i)).replace(/\s+ORDER\s+BY[\s\S]*$/i, "").trim();
    expect(where(count.sql)).toBe(where(select.sql));
    expect(select.binds.slice(0, count.binds.length)).toEqual(count.binds);
    expect(select.binds.length - count.binds.length).toBeLessThanOrEqual(2);
    // CUST+& 001 + needle + phone 5550101 + enabled + upperId 16: only 11
    // matches every conjunct, and 11 is unequipped.
    expectPage(result, value === "true" ? [] : [11], value === "true" ? 0 : 1, value === "true" ? null : 11);
  });

  it.each([
    ["asc seek", { hasContainers: "true", cursor: 12, limit: 1 }, [13], 1, 13],
    ["desc seek", { hasContainers: "false", order: "desc", cursor: 16, limit: 1 }, [15], 3, 15],
    ["false desc", { hasContainers: "false", order: "desc", limit: 2 }, [16, 15], 4, 15],
    ["true desc", { hasContainers: "true", order: "desc", limit: 1 }, [13], 2, 13],
    ["cursor wins over offset", { hasContainers: "false", cursor: 11, offset: 99, limit: 5 }, [14, 15, 16], 3, null],
    ["offset middle", { hasContainers: "false", offset: 1, limit: 2 }, [14, 15], 4, 15],
    ["offset partial end", { hasContainers: "true", offset: 1, limit: 2 }, [13], 2, null],
    ["offset empty end", { hasContainers: "false", offset: 4, limit: 1 }, [], 4, null],
    ["inclusive upperId", { hasContainers: "false", upperId: 14, limit: 5 }, [11, 14], 2, null],
    ["upperId with desc cursor", { hasContainers: "false", upperId: 15, cursor: 15, order: "desc", limit: 5 }, [14, 11], 2, null],
    ["empty upperId", { hasContainers: "true", upperId: 11 }, [], 0, null]
  ] as Array<[string, Query, number[], number, number | null]>)("%s preserves seek/offset/ceiling semantics", async (_label, query, want, total, next) => {
    expectPage(await page(query), want, total, next);
  });

  it.each(["true", "false", "any"] as const)("%s count-free uses one SELECT and no COUNT or lookahead", async (value) => {
    const counted = await page({ hasContainers: value, limit: 2 });
    const free = await page({ hasContainers: value, limit: 2, includeTotal: "false" });
    const want = value === "true" ? [12, 13] : value === "false" ? [11, 14] : [11, 12];
    expectPage(free, want, null, value === "true" ? null : want[1]);
    expect(free.body.rows).toEqual(counted.body.rows);
    expect(free.body.nextCursor).toBe(counted.body.nextCursor);
    expect(free.recorder.statements[0]).toEqual(counted.recorder.statements.find((s) => !/\bCOUNT\s*\(/i.test(s.sql)));
  });

  it("sparse output always retains canonical customer_id, never a child ID", async () => {
    const present = await page({ hasContainers: "true", fields: "enabled" });
    expect(present.body.rows).toEqual([
      { customer_id: 12, enabled: 1 }, { customer_id: 13, enabled: 0 }
    ]);
    const absent = await page({ hasContainers: "false", fields: "customer_number" });
    expect(absent.body.rows).toEqual([
      { customer_id: 11, customer_number: "CUST+& 001" },
      { customer_id: 14, customer_number: "CUST-201" },
      { customer_id: 15, customer_number: "CUST+& 001" },
      { customer_id: 16, customer_number: "CUST-300" }
    ]);
  });

  it.each(["true", "false"] as const)("%s EXPLAIN uses the existing FK lookup indexes for both statements", async (value) => {
    const result = await page({ hasContainers: value, limit: 2 });
    for (const statement of result.recorder.statements) {
      const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).bind(...statement.binds).all<{ detail: string }>();
      const details = (plan.results ?? []).map((r) => r.detail).join("\n");
      expect(details).toContain("idx_address_snapshot_customer_id");
      expect(details).toContain("idx_container_snapshot_pickup_address_id");
      expect(details).toMatch(/SEARCH/i);
    }
  });
});

describe("customer container presence countOnly and exactNext", () => {
  it.each([
    ["true", { hasContainers: "true" }, 2],
    ["false", { hasContainers: "false" }, 4],
    ["any", { hasContainers: "any" }, 6],
    ["true past cursor", { hasContainers: "true", cursor: 12 }, 1],
    ["false past cursor", { hasContainers: "false", cursor: 11 }, 3],
    ["sites with no equipment", { hasAddresses: "true", hasContainers: "false" }, 1],
    ["contradiction", { hasAddresses: "false", hasContainers: "true" }, 0]
  ] as Array<[string, Query, number]>)("countOnly %s returns the cursor-relative count with no rows or Link", async (_label, query, total) => {
    const result = await page({ ...query, countOnly: "true" });
    expect(result.body.rows).toEqual([]);
    expect(result.body.total).toBe(total);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  });

  it("exactNext emits an exact terminal signal under the equipment filter", async () => {
    const first = await page({ hasContainers: "true", limit: 1, exactNext: "true" });
    expectPage(first, [12], 2, 12);
    const second = await readPage(nextTarget(first, { hasContainers: "true", limit: 1, exactNext: "true", cursor: 12 }).search.slice(1));
    expectPage(second, [13], 1, null);
  });

  it("default exactNext=false preserves the full-terminal link to an empty page", async () => {
    const first = await page({ hasContainers: "true", limit: 2 });
    expectPage(first, [12, 13], 2, 13);
    const terminal = await readPage(nextTarget(first, { hasContainers: "true", limit: 2, cursor: 13 }).search.slice(1));
    expectPage(terminal, [], 0, null);
  });
});

describe("customer container presence next-link traversal", () => {
  it.each([
    ["true", "asc", [12, 13]], ["false", "asc", [11, 14, 15, 16]],
    ["true", "desc", [13, 12]], ["false", "desc", [16, 15, 14, 11]]
  ] as const)("walks %s %s by returned relative links without duplicate accounts", async (value, order, want) => {
    const filters = { hasContainers: value, order, limit: 1, includeTotal: "false" };
    let current = await page(filters);
    const seen: unknown[] = [];
    for (let i = 0; i <= want.length; i++) {
      expectPage(current, i < want.length ? [want[i]] : [], null, i < want.length ? want[i] : null);
      seen.push(...ids(current.body));
      if (i < want.length) {
        const target = nextTarget(current, { ...filters, cursor: want[i] });
        current = await readPage(target.search.slice(1));
      }
    }
    expect(seen).toEqual([...want]);
    expect(new Set(seen).size).toBe(want.length);
  });

  it("counted links preserve the selector and cursor-relative total through the empty terminal page", async () => {
    let current = await page({ hasContainers: "true", limit: 1 });
    for (const [want, total, next] of [[[12], 2, 12], [[13], 1, 13], [[], 0, null]] as const) {
      expectPage(current, [...want], total, next);
      if (next !== null) current = await readPage(nextTarget(current, { hasContainers: "true", limit: 1, cursor: next }).search.slice(1));
    }
  });

  it("offset starts convert to seek continuations that retain the selector", async () => {
    const first = await page({ hasContainers: "false", offset: 1, limit: 2 });
    expectPage(first, [14, 15], 4, 15);
    const target = nextTarget(first, { hasContainers: "false", limit: 2, cursor: 15 });
    expectPage(await readPage(target.search.slice(1)), [16], 1);
  });

  it.each([{}, { hasContainers: "any" }] as Query[])("control: %j omits default presence from next links", async (filter) => {
    const first = await page({ ...filter, limit: 5 });
    expectPage(first, [11, 12, 13, 14, 15], 6, 15);
    const target = nextTarget(first, { limit: 5, cursor: 15 });
    expect(target.searchParams.has("hasContainers")).toBe(false);
    expectPage(await readPage(target.search.slice(1)), [16], 1);
  });

  it("round-trips encoded business numbers, ids, q, false-like values and fields without echoing unknowns", async () => {
    const filters = {
      hasContainers: "false", hasAddresses: "false", ids: "11,12,13,15", customerId: 15, customerNumber: "CUST+& 001", subCustomerNumber: "ARCHIVE",
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
    const baseline = await page({ hasContainers: "true", limit: 1 });
    const tainted = await request(qs({ hasContainers: "true", limit: 1 }), {
      headers: { host: "host-marker.invalid", origin: "https://origin-marker.invalid", "x-forwarded-host": "forwarded-marker.invalid" }
    });
    expect(tainted.response.status).toBe(200);
    expect(tainted.response.headers.get("link")).toBe(baseline.response.headers.get("link"));
    expect(tainted.response.headers.get("link")).not.toMatch(/marker|https?:|\/\//);
    expectPage(baseline, [12], 2, 12);
  });
});

describe("customer container presence conditional representations", () => {
  it.each(["true", "false"] as const)("%s replays the exact envelope as an empty 304", async (value) => {
    const query = { hasContainers: value, fields: "enabled", limit: 2, includeTotal: "false" };
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
    ["opposite selector", { hasContainers: "false", fields: "enabled", limit: 2, includeTotal: "false" }],
    ["counted envelope", { hasContainers: "true", fields: "enabled", limit: 2 }],
    ["different fieldset", { hasContainers: "true", fields: "company_name", limit: 2, includeTotal: "false" }],
    ["different page", { hasContainers: "true", fields: "enabled", limit: 2, cursor: 12, includeTotal: "false" }]
  ] as Array<[string, Query]>)("does not 304 a %s using another representation's tag", async (_label, query) => {
    const first = await page({ hasContainers: "true", fields: "enabled", limit: 2, includeTotal: "false" });
    const other = await request(qs(query), { headers: { "if-none-match": first.response.headers.get("etag")! } });
    expect(other.response.status).toBe(200);
    expect(other.response.headers.get("etag")).not.toBe(first.response.headers.get("etag"));
    expect(await other.response.text()).not.toBe(first.bytes);
  });
});

describe("customer container presence strict validation and auth", () => {
  const invalid = [
    "hasContainers", "hasContainers=", "hasContainers=TRUE", "hasContainers=True", "hasContainers=1", "hasContainers=0",
    "hasContainers=yes", "hasContainers=%20true", "hasContainers=false%20", "hasContainers=%20", "hasContainers=true%2Cfalse",
    "hasContainers=null", "hasContainers=secret-marker-xyz", "hasContainers=true&hasContainers=false",
    "hasContainers=any&hasContainers=any", "hasContainers=false&hasContainers=false",
    "hasContainers=true&has%43ontainers=false"
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
    expect(String(body.detail)).toMatch(/hasContainers/);
    expect(String(body.detail)).toMatch(/true[\s\S]*false[\s\S]*any/);
    expect(String(body.detail)).toMatch(/one|single/i);
    expect(String(body.detail)).toMatch(/omit/i);
    expect(String(body.detail)).toMatch(/retry/i);
    expect(JSON.stringify(body)).not.toMatch(/secret-marker-xyz|%20|%2C|%43|TRUE|True|yes|null/);
    expect(denied.calls).toEqual([]);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it.each(["hasContainers=true", "hasContainers=secret-marker-xyz", "hasContainers=true&hasContainers=false"])("control: auth precedes validation for %s", async (search) => {
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

  it("strictQuery=true accepts the declared selector and retains it in continuations", async () => {
    const first = await page({ hasContainers: "true", limit: 1, strictQuery: "true" });
    expectPage(first, [12], 2, 12);
    const target = nextTarget(first, { hasContainers: "true", limit: 1, strictQuery: "true", cursor: 12 });
    expect(target.searchParams.get("strictQuery")).toBe("true");
    expectPage(await readPage(target.search.slice(1)), [13], 1, 13);
  });

  it("strictQuery=true still rejects unknown names before D1 with fixed guidance", async () => {
    const denied = forbiddenDb();
    const result = await request("hasContainers=true&strictQuery=true&bogus_param=1", { db: denied.db });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const body = await result.response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ type: PROBLEM_TYPE, title: "Bad Request", status: 400 });
    expect(String(body.detail)).toMatch(/Unknown query parameter/);
    expect(JSON.stringify(body)).not.toContain("bogus_param");
    expect(denied.calls).toEqual([]);
  });
});

describe("customer container presence mounted discovery", () => {
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
    const params = operation?.parameters?.filter((p) => p.name === "hasContainers");
    expect(params).toHaveLength(1);
    expect(params![0]).toMatchObject({ in: "query", required: false, schema: { type: "string", enum: ["true", "false", "any"], default: "any" } });
    const prose = `${params![0].description ?? ""} ${params![0].schema?.description ?? ""}`;
    expect(prose).toMatch(/container|equipment/i);
    expect(prose).toMatch(/mirror|stored/i);
    expect(prose).toMatch(/disabled/i);
    expect(prose).toMatch(/one|single/i);
    expect(prose).toMatch(/omit/i);
    expect(prose).toMatch(/retry/i);
    expect(operation?.responses?.["400"]?.description).toMatch(/hasContainers/);
  });

  it("keeps customer hasContainers off the container list, changes and by-ID operations", async () => {
    // The address list keeps its own direct-child hasContainers with different
    // (single-level) semantics; only the remaining operations stay excluded.
    const doc = await openApi();
    for (const path of ["/api/v1/container-snapshot", "/api/v1/customer-snapshot/changes", "/api/v1/customer-snapshot/{customerId}", "/api/v1/address-snapshot/{pickupAddressId}", "/api/v1/container-snapshot/{containerId}"]) {
      expect((doc.paths[path]?.get?.parameters ?? []).map((p) => p.name), path).not.toContain("hasContainers");
    }
    expect((doc.paths["/api/v1/address-snapshot"]?.get?.parameters ?? []).map((p) => p.name)).toContain("hasContainers");
  });

  it("provides a schema-valid parameter example an agent can replay", async () => {
    const doc = await openApi();
    const param = doc.paths[PATH]?.get?.parameters?.find((p) => p.name === "hasContainers");
    const example = (param as (Param & { example?: unknown }) | undefined)?.example ?? param?.schema?.example;
    expect(["true", "false", "any"]).toContain(example);
    const result = await page({ hasContainers: String(example) });
    const want = example === "true" ? [12, 13] : example === "false" ? [11, 14, 15, 16] : [11, 12, 13, 14, 15, 16];
    expectPage(result, want, want.length);
  });
});

// These are machine-consumed selection/safety instructions, not human prose
// style pins: an agent must discover the selector without inferring upstream
// completeness, active service, or permission to write from the absence of
// mirrored equipment. Path-scoped: the address list has its own hasContainers
// recipes sharing the enum spelling.
describe("customer container presence agent guidance", () => {
  it("inventories the selector on the customer list and links the focused oracle", () => {
    const row = (path: string) => policyDoc.split("\n").find((line) => line.startsWith(`| \`${path}\` |`)) ?? "";
    expect(row(PATH)).toContain("`hasContainers`");
    expect(row("/api/v1/container-snapshot")).not.toContain("hasContainers");
    expect(policyDoc).toContain("test/customerContainerPresence.acceptance.test.ts");
  });

  it("explains mirrored-only absence and forbids treating it as authority to mutate upstream", () => {
    const sections = policyDoc.split(/^#{1,6} /m).filter((section) => /^customer/i.test(section) && section.includes("hasContainers"));
    expect(sections.length).toBeGreaterThanOrEqual(1);
    const guidance = sections.join("\n");
    expect(guidance).toMatch(/hasContainers/);
    expect(guidance).toMatch(/mirror/i);
    expect(guidance).toMatch(/upstream/i);
    expect(guidance).toMatch(/not (?:proof|evidence)|does not (?:prove|mean)|no (?:proof|guarantee)/i);
    expect(guidance).toMatch(/delet/i);
    expect(guidance).toMatch(/reconcil/i);
    expect(guidance).toMatch(/sync/i);
    expect(guidance).toMatch(/never|does not authori[sz]e|must not|not permission/i);
    expect(guidance).toMatch(/any|global/i);
    const customerRow = snapshotDoc.split("\n").find((line) => line.includes("`/api/v1/customer-snapshot`") && line.includes("List rows")) ?? "";
    expect(customerRow).toContain("hasContainers");
    expect(snapshotDoc).toContain("check:customer-container-presence");
  });

  it("publishes local synthetic present/absent recipes that can be traversed", () => {
    const blocks = [...quickstartDoc.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((m) => m[1]);
    for (const value of ["true", "false"]) {
      const recipe = blocks.find((b) => b.includes(`hasContainers=${value}`) && b.includes(PATH));
      expect(recipe, `local ${value} recipe`).toBeDefined();
      expect(recipe).toContain(PATH);
      expect(recipe).toContain("localhost:8787");
      expect(recipe).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
    }
    const customerBlocks = blocks.filter((b) => b.includes(PATH) && b.includes("hasContainers="));
    expect(customerBlocks.some((b) => /cursor|rel=.next|[Ll]ink/.test(b))).toBe(true);
    const unreleased = changelog.split(/^## /m)[1];
    const customerBullet = unreleased.split(/(?=^- #)/m).find((b) => b.includes("hasContainers") && /customer/i.test(b));
    expect(customerBullet, "customer hasContainers changelog bullet").toBeDefined();
  });

  it("exposes a named local-only focused check that includes this acceptance suite", () => {
    const scripts = packageJson.scripts as Record<string, string>;
    const command = scripts["check:customer-container-presence"];
    expect(command).toEqual(expect.any(String));
    expect(command).toMatch(/vitest\s+run/);
    expect(command).toContain("test/customerContainerPresence.acceptance.test.ts");
    expect(command).not.toMatch(/--remote|deploy|probe:post-deploy/);
  });
});
