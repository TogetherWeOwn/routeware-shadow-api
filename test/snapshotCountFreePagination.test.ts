/// <reference types="vite/client" />

import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { problemType } from "../src/lib/problem";
import policyDoc from "../docs/SNAPSHOT-LIST-QUERY-POLICY.md?raw";
import quickstartDoc from "../docs/CONSUMER-QUICKSTART.md?raw";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Acceptance contract for the opt-in count-free page (`includeTotal=false`) on
 * the three ordinary snapshot lists. Invariants pinned here:
 *
 *  - `includeTotal` is an exact-string `true|false` query key, default `true`;
 *    absent and `true` keep today's body and today's two statements
 *    (COUNT + page SELECT) byte for byte.
 *  - `false` returns the identical `rows` and `nextCursor` with `total: null`
 *    and executes zero COUNT statements — exactly one page SELECT, with the
 *    same SQL and binds the default mode uses for its page.
 *  - Any other value is a value-free 400 before D1 is touched.
 *  - The shared OpenAPI contract, the query-policy inventory and the
 *    quickstart tell an agent that `null` means "deliberately not computed".
 *
 * Fixtures are synthetic and the suite is hermetic: the real local test D1 is
 * wrapped in a pass-through recorder; outbound fetch throws.
 */

const API_TOKEN = "test-api-token";
const READ_TOKEN = "test-read-token";
const TEST_ENV = env as unknown as Env;

type Fixture = {
  id: number;
  customerId: number;
  /** Row's own `enabled` flag. */
  enabled: boolean;
  /** Whether the free-text `q=needle` filter matches this row. */
  needle: boolean;
};

// Six rows per table, same primary keys 1..6 in all three. Addresses belong to
// customers [1,1,2,3,3,1]; container N sits at address N, so `customerId=1`
// reaches containers 1, 2 and 6 only through the address join.
const OWNER = [1, 1, 2, 3, 3, 1];
const ENABLED = [true, true, true, false, true, false];
// Customer/address text matches rows 2 and 5; containers also match through
// serial_number on row 3 (the OR leg of the container `q` filter).
const NEEDLE_TEXT = [false, true, false, false, true, false];
const NEEDLE_SERIAL = [false, false, true, false, false, false];

function fixturesFor(table: "customer" | "address" | "container"): Fixture[] {
  return [1, 2, 3, 4, 5, 6].map((id, i) => ({
    id,
    customerId: table === "customer" ? id : OWNER[i],
    enabled: ENABLED[i],
    needle: NEEDLE_TEXT[i] || (table === "container" && NEEDLE_SERIAL[i])
  }));
}

type Spec = {
  name: "customer" | "address" | "container";
  path: string;
  idColumn: string;
  fixtures: Fixture[];
  /** Filters this route accepts beyond the common set. */
  extra: Array<[string, Record<string, string | number | boolean>, (f: Fixture) => boolean]>;
};

const SPECS: Spec[] = [
  {
    name: "customer",
    path: "/api/v1/customer-snapshot",
    idColumn: "customer_id",
    fixtures: fixturesFor("customer"),
    extra: []
  },
  {
    name: "address",
    path: "/api/v1/address-snapshot",
    idColumn: "pickup_address_id",
    fixtures: fixturesFor("address"),
    extra: [["pickupAddressId=4", { pickupAddressId: 4 }, (f) => f.id === 4]]
  },
  {
    name: "container",
    path: "/api/v1/container-snapshot",
    idColumn: "container_id",
    fixtures: fixturesFor("container"),
    extra: [
      ["pickupAddressId=4", { pickupAddressId: 4 }, (f) => f.id === 4],
      ["containerId=3", { containerId: 3 }, (f) => f.id === 3],
      [
        "customerId=1 joined with pickupAddressId=2",
        { customerId: 1, pickupAddressId: 2 },
        (f) => f.customerId === 1 && f.id === 2
      ],
      // The join must still apply when the cursor is set.
      ["customerId=1 with cursor=1", { customerId: 1, cursor: 1 }, (f) => f.customerId === 1 && f.id > 1]
    ]
  }
];

type Query = Record<string, string | number | boolean>;

type Scenario = { label: string; query: Query; filter?: (f: Fixture) => boolean };

function scenariosFor(spec: Spec): Scenario[] {
  const common: Scenario[] = [
    { label: "bare request (final page, under the limit)", query: {} },
    { label: "offset page, full with more rows after it", query: { limit: 2 } },
    { label: "offset page in the middle", query: { limit: 2, offset: 2 } },
    { label: "offset page, final page exactly full", query: { limit: 2, offset: 4 } },
    { label: "offset page, final page partial", query: { limit: 4, offset: 4 } },
    { label: "offset past the end (empty page)", query: { limit: 2, offset: 6 } },
    { label: "cursor page", query: { limit: 2, cursor: 2 } },
    { label: "cursor page, final page exactly full", query: { limit: 2, cursor: 4 } },
    { label: "cursor at the last key (empty page)", query: { limit: 10, cursor: 6 } },
    { label: "cursor wins over offset", query: { limit: 2, cursor: 2, offset: 1 } },
    {
      label: "enabled=true filter",
      query: { enabled: "true", limit: 2 },
      filter: (f) => f.enabled
    },
    {
      label: "enabled=false filter",
      query: { enabled: "false" },
      filter: (f) => !f.enabled
    },
    {
      label: "q filter",
      query: { q: "needle" },
      filter: (f) => f.needle
    },
    {
      label: "q filter matching nothing (empty result)",
      query: { q: "no-such-synthetic-label" },
      filter: () => false
    },
    {
      label: "q + enabled + cursor combined",
      query: { q: "needle", enabled: "true", cursor: 2, limit: 1 },
      filter: (f) => f.needle && f.enabled
    },
    {
      label: "customerId filter",
      query: { customerId: 1, limit: 2 },
      filter: (f) => f.customerId === 1
    },
    {
      label: "customerId filter with cursor",
      query: { customerId: 1, cursor: 1, limit: 1 },
      filter: (f) => f.customerId === 1
    }
  ];
  const extra: Scenario[] = spec.extra.map(([label, query, filter]) => ({ label, query, filter }));
  return [...common, ...extra];
}

type Expected = { ids: number[]; total: number; nextCursor: number | null };

/** Independent JS model of the documented list semantics over the fixtures. */
function expectedFor(spec: Spec, scenario: Scenario): Expected {
  const q = scenario.query;
  const limit = Number(q.limit ?? 50);
  const offset = Number(q.offset ?? 0);
  const cursor = q.cursor === undefined ? undefined : Number(q.cursor);
  const matching = spec.fixtures
    .filter(scenario.filter ?? (() => true))
    // `total` is cursor-relative today: the cursor is part of the WHERE.
    .filter((f) => cursor === undefined || f.id > cursor);
  const page = cursor === undefined ? matching.slice(offset, offset + limit) : matching.slice(0, limit);
  const ids = page.map((f) => f.id);
  return {
    ids,
    total: matching.length,
    nextCursor: ids.length === limit ? ids[ids.length - 1] : null
  };
}

function queryString(query: Query, includeTotal?: string): string {
  const parts = Object.entries(query).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  if (includeTotal !== undefined) parts.push(`includeTotal=${includeTotal}`);
  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

type Statement = { sql: string; binds: unknown[] };

/** Pass-through wrapper over the real test D1 that records every statement. */
function spyDb(real: D1Database): { db: D1Database; statements: Statement[] } {
  const statements: Statement[] = [];
  const db = {
    prepare(sql: string) {
      const rec: Statement = { sql, binds: [] };
      statements.push(rec);
      const stmt = real.prepare(sql);
      return {
        bind(...binds: unknown[]) {
          rec.binds = binds;
          const bound = stmt.bind(...binds);
          return bound;
        },
        first: (...a: unknown[]) => (stmt.first as (...x: unknown[]) => unknown)(...a),
        all: () => stmt.all(),
        run: () => stmt.run(),
        raw: () => stmt.raw()
      };
    },
    batch: (...a: unknown[]) => (real.batch as (...x: unknown[]) => unknown)(...a)
  };
  return { db: db as unknown as D1Database, statements };
}

const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);

async function get(
  spec: Spec,
  search: string,
  options: { token?: string | null; db?: D1Database } = {}
): Promise<Response> {
  const headers = new Headers();
  const token = options.token === undefined ? API_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return app.fetch(
    new Request(`http://test.local${spec.path}${search}`, { headers }),
    options.db ? { ...TEST_ENV, CUSTOMER_DB: options.db } : TEST_ENV
  );
}

type ListBody = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };

async function listWith(spec: Spec, search: string) {
  const { db, statements } = spyDb(TEST_ENV.CUSTOMER_DB);
  const response = await get(spec, search, { db });
  return { response, statements, body: (await response.clone().json()) as ListBody };
}

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  await ensureD1TestTables();
});

beforeEach(async () => {
  globalThis.fetch = vi.fn(async () => {
    throw new Error("Unexpected outbound fetch in count-free pagination test");
  }) as typeof fetch;

  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  // Synthetic labels only: no names, addresses, report exports or real PII.
  for (let i = 0; i < 6; i++) {
    const id = i + 1;
    const enabled = ENABLED[i] ? 1 : 0;
    const label = NEEDLE_TEXT[i] ? `synthetic-needle-${id}` : `synthetic-other-${id}`;
    const serial = NEEDLE_SERIAL[i] ? `serial-needle-${id}` : `serial-other-${id}`;
    await db.batch([
      db
        .prepare(
          "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, ?, 'test')"
        )
        .bind(id, label, enabled),
      db
        .prepare(
          "INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, ?, ?, 'test')"
        )
        .bind(id, OWNER[i], label, enabled),
      db
        .prepare(
          "INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, enabled, synced_at) VALUES (?, ?, ?, ?, ?, 'test')"
        )
        .bind(id, id, label, serial, enabled)
    ]);
  }
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe.each(SPECS)("$name snapshot list: includeTotal default is unchanged", (spec) => {
  it.each(scenariosFor(spec).map((s) => [s.label, s] as const))(
    "default mode keeps rows, total and nextCursor, one COUNT then one page SELECT: %s",
    async (_label, scenario) => {
      const expected = expectedFor(spec, scenario);
      const absent = await listWith(spec, queryString(scenario.query));
      const explicit = await listWith(spec, queryString(scenario.query, "true"));

      for (const result of [absent, explicit]) {
        expect(result.response.status).toBe(200);
        expect(result.body.rows.map((r) => r[spec.idColumn])).toEqual(expected.ids);
        expect(result.body.total).toBe(expected.total);
        expect(result.body.nextCursor).toBe(expected.nextCursor);
        expect(result.statements.filter(isCount)).toHaveLength(1);
        expect(result.statements).toHaveLength(2);
      }
      // `includeTotal=true` is the default spelled out: same bytes, same SQL.
      expect(await explicit.response.text()).toBe(await absent.response.text());
      expect(explicit.statements).toEqual(absent.statements);
    }
  );
});

describe.each(SPECS)("$name snapshot list: includeTotal=false is count-free", (spec) => {
  it.each(scenariosFor(spec).map((s) => [s.label, s] as const))(
    "same rows and nextCursor, total null, zero COUNT, one page SELECT: %s",
    async (_label, scenario) => {
      const expected = expectedFor(spec, scenario);
      const dflt = await listWith(spec, queryString(scenario.query));
      const free = await listWith(spec, queryString(scenario.query, "false"));

      expect(free.response.status).toBe(200);
      expect(free.response.headers.get("content-type")).toContain("application/json");
      expect(free.body.rows).toEqual(dflt.body.rows);
      expect(free.body.rows.map((r) => r[spec.idColumn])).toEqual(expected.ids);
      expect(free.body.nextCursor).toBe(expected.nextCursor);
      expect(free.body.nextCursor).toBe(dflt.body.nextCursor);
      // null means "deliberately not computed" — never 0, never omitted.
      expect(Object.keys(free.body).sort()).toEqual(["nextCursor", "rows", "total"]);
      expect(free.body.total).toBeNull();

      expect(free.statements.filter(isCount)).toEqual([]);
      expect(free.statements).toHaveLength(1);
      expect(free.statements[0].sql).toMatch(/^\s*SELECT\b/i);
      expect(free.statements[0].sql).toMatch(/\bLIMIT\b/i);
      // Same page statement as the default mode's page: filters, join, cursor
      // seek / OFFSET and ordering are untouched.
      const defaultPage = dflt.statements.find((s) => !isCount(s));
      expect(free.statements[0]).toEqual(defaultPage);
    }
  );

  it("walks every row by nextCursor alone, never issuing a COUNT", async () => {
    const seen: unknown[] = [];
    let cursor: number | null = null;
    for (let page = 0; page < 10; page++) {
      const query: Query = cursor === null ? { limit: 2 } : { limit: 2, cursor };
      const { body, statements } = await listWith(spec, queryString(query, "false"));
      expect(statements.filter(isCount)).toEqual([]);
      expect(body.total).toBeNull();
      seen.push(...body.rows.map((r) => r[spec.idColumn]));
      if (body.nextCursor === null) break;
      cursor = body.nextCursor;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("keeps the default total cursor-relative while the count-free page matches it", async () => {
    const dflt = await listWith(spec, "?limit=2&cursor=2");
    const free = await listWith(spec, "?limit=2&cursor=2&includeTotal=false");
    // Rows 3..6 remain after cursor 2, so today's total is 4, not the table's 6.
    expect(dflt.body.total).toBe(4);
    expect(free.body.total).toBeNull();
    expect(free.body.rows).toEqual(dflt.body.rows);
    expect(free.body.nextCursor).toBe(dflt.body.nextCursor);
  });

  it("works with the read-only token and keeps Cache-Control: no-store", async () => {
    const { db, statements } = spyDb(TEST_ENV.CUSTOMER_DB);
    const response = await get(spec, "?limit=1&includeTotal=false", { token: READ_TOKEN, db });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(((await response.json()) as ListBody).total).toBeNull();
    expect(statements.filter(isCount)).toEqual([]);
  });

  it("still 401s without a token, before D1 and before validating includeTotal", async () => {
    const { db, statements } = spyDb(TEST_ENV.CUSTOMER_DB);
    const ok = await get(spec, "?includeTotal=false", { token: null, db });
    const bad = await get(spec, "?includeTotal=bogus", { token: null, db });
    for (const response of [ok, bad]) {
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
    }
    expect(statements).toEqual([]);
  });
});

describe.each(SPECS)("$name snapshot list: invalid includeTotal", (spec) => {
  it.each([
    ["empty string", ""],
    ["upper-case TRUE", "TRUE"],
    ["capitalised False", "False"],
    ["numeric 1", "1"],
    ["numeric 0", "0"],
    ["yes", "yes"],
    ["trailing space", "false%20"],
    ["comma list", "false%2Ctrue"],
    ["marker value", "secret-marker-xyz"]
  ])("rejects %s with a value-free 400 before any D1 access", async (_name, value) => {
    const prepare = vi.fn(() => {
      throw new Error("Rejected query must not reach D1");
    });
    const logs = (["error", "warn", "info", "log", "debug"] as const).map((m) => vi.spyOn(console, m));
    const response = await get(spec, `?includeTotal=${value}`, { db: { prepare } as unknown as D1Database });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      type: problemType("bad-request"),
      title: "Bad Request",
      status: 400,
      detail: "Invalid request query (includeTotal). See docs/PROBLEMS.md#bad-request."
    });
    expect(text).not.toContain("secret-marker-xyz");
    expect(prepare).not.toHaveBeenCalled();
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("rejects a repeated includeTotal key before any D1 access", async () => {
    const prepare = vi.fn(() => {
      throw new Error("Rejected query must not reach D1");
    });
    const response = await get(spec, "?includeTotal=false&includeTotal=true", {
      db: { prepare } as unknown as D1Database
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(prepare).not.toHaveBeenCalled();
  });

  it("rejects an invalid includeTotal with the read-only token as well", async () => {
    const prepare = vi.fn();
    const response = await get(spec, "?includeTotal=nope", {
      token: READ_TOKEN,
      db: { prepare } as unknown as D1Database
    });
    expect(response.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("OpenAPI and docs describe the opt-in", () => {
  type Param = {
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: { type?: unknown; enum?: unknown[]; default?: unknown; description?: string };
  };
  type Doc = {
    paths: Record<string, Record<string, { parameters?: Param[] }>>;
    components?: {
      schemas?: Record<
        string,
        { required?: string[]; properties?: Record<string, { type?: unknown; description?: string }> }
      >;
    };
  };

  async function openApi(): Promise<Doc> {
    const res = await exports.default.fetch("http://test.local/openapi.json");
    expect(res.status).toBe(200);
    return (await res.json()) as Doc;
  }

  it.each(SPECS.map((s) => [s.path] as const))(
    "%s publishes includeTotal as an optional exact true|false query enum, default true",
    async (path) => {
      const doc = await openApi();
      const param = doc.paths[path]?.get?.parameters?.find((p) => p.name === "includeTotal");
      expect(param).toMatchObject({
        in: "query",
        required: false,
        schema: { type: "string", enum: ["true", "false"], default: "true" }
      });
      const description = param?.description ?? param?.schema?.description ?? "";
      expect(description).toMatch(/count/i);
      expect(description).toMatch(/\bnull\b/);
    }
  );

  it("does not add includeTotal to the changes feed or the single-row reads", async () => {
    const doc = await openApi();
    for (const path of [
      "/api/v1/customer-snapshot/changes",
      "/api/v1/customer-snapshot/{customerId}",
      "/api/v1/address-snapshot/{pickupAddressId}",
      "/api/v1/container-snapshot/{containerId}"
    ]) {
      const names = (doc.paths[path]?.get?.parameters ?? []).map((p) => p.name);
      expect(names, path).not.toContain("includeTotal");
    }
  });

  it("makes each resource list envelope total nullable, still required, and explains null", async () => {
    const doc = await openApi();
    for (const envelope of ["CustomerSnapshotList", "AddressSnapshotList", "ContainerSnapshotList"]) {
      const schema = doc.components?.schemas?.[envelope];
      expect(schema?.required, envelope).toEqual(expect.arrayContaining(["rows", "total", "nextCursor"]));
      expect(
        ([] as string[]).concat(schema?.properties?.total?.type as string | string[]).sort(),
        envelope
      ).toEqual(["integer", "null"]);
      const description = schema?.properties?.total?.description ?? "";
      expect(description, envelope).toMatch(/includeTotal=false/);
      expect(description, envelope).toMatch(/\bnull\b/);
      expect(description, envelope).toMatch(/not computed/i);
      expect(description, envelope).toMatch(/not (?:zero|0)|rather than (?:zero|0)/i);
    }
  });

  it("lists includeTotal in the query-policy inventory for the three ordinary lists only", () => {
    const row = (path: string) =>
      policyDoc.split("\n").find((line) => line.startsWith(`| \`${path}\` |`)) ?? "";
    for (const spec of SPECS) {
      expect(row(spec.path), spec.path).toContain("`includeTotal`");
    }
    expect(row("/api/v1/customer-snapshot/changes")).not.toContain("includeTotal");
    expect(policyDoc).toMatch(/total: null|"total":\s*null/);
    expect(policyDoc).toMatch(/not computed/i);
    expect(policyDoc).toContain("test/snapshotCountFreePagination.test.ts");
  });

  it("shows a synthetic count-free quickstart example that explains null", () => {
    const blocks = [...quickstartDoc.matchAll(/^```bash\n([\s\S]*?)^```/gm)].map((m) => m[1]);
    const block = blocks.find((b) => b.includes("includeTotal=false"));
    expect(block).toBeDefined();
    expect(block).toContain("/api/v1/customer-snapshot");
    expect(block).toContain("localhost:8787");
    expect(block).toMatch(/"total":\s*null/);
    expect(quickstartDoc).toMatch(/not computed/i);
    // The example must stay credential-free: only the documented $TOKEN variable.
    expect(block).not.toMatch(/Bearer (?!\$TOKEN)\S+/);
  });
});
