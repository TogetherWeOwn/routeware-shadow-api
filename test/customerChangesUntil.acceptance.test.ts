import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

// Test-first HTTP contract, exercised against migrated, synthetic local D1.
// A missing/strict upper bound, a misgrouped tuple OR, lossy normalization or
// post-LIMIT filtering must each change a hand-derived page below.
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/customer-snapshot/changes";
const ORIGIN = "https://bounded-consumer.invalid";
const PROBLEM_BASE =
  "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#";
const ZERO = "2026-09-01T00:00:00.000Z";
const TENTH = "2026-09-01T00:00:00.100Z";
const UPPER = "2026-09-01T00:00:00.500Z";
const NEXT = "2026-09-01T00:00:01.000Z";
const FIXTURES = [
  [8706, UPPER], [8701, "2026-09-01T00:00:00.120Z"], [8709, NEXT],
  [8708, ZERO], [8704, "2026-09-01T00:00:00.501Z"], [8703, UPPER],
  [8707, TENTH], [8705, "2026-09-01T00:00:00.499Z"],
  [8702, "2026-09-01T00:00:00.099Z"]
] as const;
const ALL_IDS = [8708, 8702, 8707, 8701, 8705, 8703, 8706, 8704, 8709];
const BOUNDED_IDS = [8708, 8702, 8707, 8701, 8705, 8703, 8706];
const BOUNDED_STAMPS = [
  ZERO, "2026-09-01T00:00:00.099Z", TENTH, "2026-09-01T00:00:00.120Z",
  "2026-09-01T00:00:00.499Z", UPPER, UPPER
];
const ROW_COLUMNS = [
  "customer_id", "customer_type_id", "company_name", "first_name", "middle_initial",
  "last_name", "name_suffix", "customer_number", "sub_customer_number", "phone1",
  "phone2", "comments", "enabled", "synced_at"
];
type Cursor = { since: string; since_id: number };
type Body = { rows: Array<Record<string, unknown>>; total: number; nextCursor: Cursor | null };
type Statement = { sql: string; binds: unknown[]; method: string };
type Parameter = {
  in: string; name: string; required?: boolean; description?: string;
  schema?: Record<string, unknown>;
};
type Operation = {
  operationId: string; description?: string; parameters: Parameter[];
  responses: Record<string, { description?: string }>;
  "x-access": string; "x-effect": string;
};

// Pass through reads to real D1 rather than implement predicates in a fake.
// Record prepares too: invalid bounds must not even reach D1.prepare().
function recordDb() {
  const statements: Statement[] = [];
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return new Proxy(stmt, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (property === "bind") {
            return wrap(Reflect.apply(value, target, args), sql, args);
          }
          statements.push({ sql, binds, method: String(property) });
          if (!/^\s*SELECT\b/i.test(sql) || property === "run") {
            throw new Error("Changes reads must not mutate D1");
          }
          return Reflect.apply(value, target, args);
        };
      }
    });
  }
  const prepare = vi.fn((sql: string) => wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []));
  const batch = vi.fn(() => { throw new Error("Unexpected changes-feed batch"); });
  const exec = vi.fn(() => { throw new Error("Unexpected changes-feed exec"); });
  const db = { prepare, batch, exec } as unknown as D1Database;
  return { db, prepare, batch, exec, statements };
}
const traces: ReturnType<typeof recordDb>[] = [];

function query(params: Record<string, string | undefined>) {
  return new URLSearchParams(Object.entries(params).filter(
    (entry): entry is [string, string] => entry[1] !== undefined
  )).toString();
}

async function request(search = "", token: string | null = "test-read-token") {
  const trace = recordDb();
  traces.push(trace);
  const headers = new Headers({ origin: ORIGIN });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(
    new Request(`http://test.local${PATH}${search ? `?${search}` : ""}`, { headers }),
    { ...TEST_ENV, CUSTOMER_DB: trace.db }
  );
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  return { response, trace };
}

async function page(params: Record<string, string | undefined> = {}) {
  const result = await request(query(params));
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  const body = await result.response.json() as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  expect(body.total).toBe(body.rows.length);
  expect(result.trace.statements).toHaveLength(1);
  return { ...result, body };
}

function ids(body: Body) {
  return body.rows.map((row) => row.customer_id);
}

async function invalid(search: string) {
  const { response, trace } = await request(search);
  expect.soft(trace.prepare.mock.calls, "invalid window must do zero D1 work").toEqual([]);
  expect.soft(response.status).toBe(400);
  expect(response.headers.get("content-type")).toContain("application/problem+json");
  const body = await response.json();
  expect(body).toEqual({
    type: `${PROBLEM_BASE}bad-request`, title: "Bad Request", status: 400,
    detail: expect.stringMatching(
      /^Invalid request query \((?:until|since|since_id|limit|query)(?:, (?:until|since|since_id|limit|query))*\)\. See docs\/PROBLEMS\.md#bad-request\.$/
    )
  });
  return body;
}

async function operation(): Promise<Operation> {
  const response = await app.fetch(new Request("http://test.local/openapi.json"), TEST_ENV);
  expect(response.status).toBe(200);
  const doc = await response.json() as { paths: Record<string, { get: Operation }> };
  return doc.paths[PATH].get;
}

beforeAll(async () => {
  await ensureD1TestTables();
});

beforeEach(async () => {
  // Reset the local fixture per test, including the concurrent-overwrite case.
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  await db.batch(FIXTURES.map(([id, stamp]) => db.prepare(
    "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, 1, ?)"
  ).bind(id, `Synthetic bounded fixture ${id}`, stamp)));
  traces.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("Unexpected outbound fetch in bounded changes acceptance");
  }));
});

afterEach(async () => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    for (const trace of traces) {
      expect(trace.batch).not.toHaveBeenCalled();
      expect(trace.exec).not.toHaveBeenCalled();
      expect(trace.statements.every((s) => /^\s*SELECT\b/i.test(s.sql) && s.method !== "run")).toBe(true);
    }
    const stored = await TEST_ENV.CUSTOMER_DB.prepare(
      "SELECT customer_id, company_name, enabled, synced_at FROM customer_snapshot ORDER BY customer_id"
    ).all();
    expect(stored.results).toEqual([...FIXTURES].sort((a, b) => a[0] - b[0]).map(([id, stamp]) => ({
      customer_id: id, company_name: `Synthetic bounded fixture ${id}`, enabled: 1,
      synced_at: stamp
    })));
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe("customer changes until: green compatibility controls", () => {
  it("retains the published changes operation identity and read-only access", async () => {
    const get = await operation();
    expect(get.operationId).toBe("listCustomerSnapshotChanges");
    expect(get["x-access"]).toBe("read");
    expect(get["x-effect"]).toBe("local-read");
  });

  it("omitted until retains the full row payload, page total and initial SQL semantics", async () => {
    const { body, trace } = await page();
    expect(ids(body)).toEqual(ALL_IDS);
    expect(body.nextCursor).toBeNull();
    expect(Object.keys(body.rows[0]).sort()).toEqual([...ROW_COLUMNS].sort());
    expect(trace.statements[0].sql).not.toMatch(/synced_at\s*<=/i);
    expect(trace.statements[0].binds).toEqual(["0000-01-01T00:00:00.000Z", 50]);
  });

  it("omitted until retains strict bare-since and tie-safe composite reads", async () => {
    const bare = await page({ since: "2026-09-01T00:00:00.5Z" });
    expect(ids(bare.body)).toEqual([8704, 8709]);
    expect(bare.trace.statements[0].binds).toEqual([UPPER, 50]);
    const tuple = await page({ since: UPPER, since_id: "8703", limit: "1" });
    expect(ids(tuple.body)).toEqual([8706]);
    expect(tuple.body.nextCursor).toEqual({ since: UPPER, since_id: 8706 });
    expect(tuple.trace.statements[0].binds).toEqual([UPPER, UPPER, 8703, 1]);
  });

  it("omitted until preserves legacy empty-since JSON and query parity", async () => {
    const omitted = await page({ limit: "3" });
    const empty = await page({ since: "", limit: "3" });
    expect(empty.body).toEqual(omitted.body);
    expect(empty.trace.statements).toEqual(omitted.trace.statements);
  });

  it.each([null, "synthetic-wrong-token"])("auth precedes invalid until for token=%j", async (token) => {
    const { response, trace } = await request(query({ until: "sensitive-synthetic-invalid-bound" }), token);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ type: `${PROBLEM_BASE}unauthorized`, status: 401 });
    expect(trace.prepare).not.toHaveBeenCalled();
  });
});

describe("customer changes until: inclusive windows", () => {
  it.each([
    ["seconds", "2026-09-01T00:00:00Z", [8708]],
    ["one zero", "2026-09-01T00:00:00.0Z", [8708]],
    ["two zeroes", "2026-09-01T00:00:00.00Z", [8708]],
    ["milliseconds", ZERO, [8708]],
    ["one fraction", "2026-09-01T00:00:00.1Z", [8708, 8702, 8707]],
    ["two fractions", "2026-09-01T00:00:00.10Z", [8708, 8702, 8707]],
    ["three fractions", TENTH, [8708, 8702, 8707]],
    ["hundredths", "2026-09-01T00:00:00.12Z", [8708, 8702, 8707, 8701]],
    ["one-half", "2026-09-01T00:00:00.5Z", BOUNDED_IDS],
    ["two-half", "2026-09-01T00:00:00.50Z", BOUNDED_IDS],
    ["three-half", UPPER, BOUNDED_IDS],
    ["below one tenth", "2026-09-01T00:00:00.099Z", [8708, 8702]],
    ["below one half", "2026-09-01T00:00:00.499Z", [8708, 8702, 8707, 8701, 8705]]
  ] as const)("normalizes %s and includes exactly rows at/below until", async (_label, until, want) => {
    const { body } = await page({ until });
    expect(ids(body)).toEqual(want);
    expect(body.nextCursor).toBeNull();
  });

  it("conjoins the strict bare lower bound with the inclusive upper bound", async () => {
    const { body } = await page({ since: "2026-09-01T00:00:00.1Z", until: "2026-09-01T00:00:00.5Z" });
    expect(ids(body)).toEqual([8701, 8705, 8703, 8706]);
  });

  it.each([undefined, ""])("until still bounds an initial page with since=%j", async (since) => {
    const { body } = await page(since === undefined ? { until: UPPER } : { until: UPPER, since });
    expect(ids(body)).toEqual(BOUNDED_IDS);
  });

  it("accepts normalized since == until but a bare since excludes that instant", async () => {
    const { body } = await page({ since: "2026-09-01T00:00:00.5Z", until: "2026-09-01T00:00:00.50Z" });
    expect(body).toEqual({ rows: [], total: 0, nextCursor: null });
  });

  it.each(["0", "8703", "8706", "9007199254740991"])(
    "equal endpoints allow only remaining same-stamp IDs after %s", async (since_id) => {
      const { body } = await page({ since: "2026-09-01T00:00:00.5Z", since_id, until: UPPER });
      const want = since_id === "0" ? [8703, 8706] : since_id === "8703" ? [8706] : [];
      expect(ids(body)).toEqual(want);
      expect(body.nextCursor).toBeNull();
    }
  );

  it.each([1, 2, 3, 500])("walks the finite bounded tuple order once with limit=%i", async (limit) => {
    const seen: unknown[] = [];
    let params: Record<string, string> = { until: "2026-09-01T00:00:00.5Z", limit: String(limit) };
    for (let attempt = 0; attempt <= BOUNDED_IDS.length; attempt++) {
      const { body, response } = await page(params);
      const offset = seen.length;
      expect(ids(body)).toEqual(BOUNDED_IDS.slice(offset, offset + limit));
      expect(body.rows.map((row) => row.synced_at)).toEqual(BOUNDED_STAMPS.slice(offset, offset + limit));
      seen.push(...ids(body));
      if (body.rows.length < limit) {
        expect(body.nextCursor).toBeNull();
        expect(seen).toEqual(BOUNDED_IDS);
        return;
      }
      const last = seen.length - 1;
      expect(body.nextCursor).toEqual({ since: BOUNDED_STAMPS[last], since_id: BOUNDED_IDS[last] });
      // Changes-feed Link is not a prerequisite on this baseline. If published,
      // follow each actual link and verify it keeps the same normalized window.
      const link = response.headers.get("link");
      if (link !== null) {
        const target = link.match(/<([^>]+)>;\s*rel="next"/);
        expect(target).not.toBeNull();
        const next = new URL(target![1], "http://test.local");
        expect(next.pathname).toBe(PATH);
        expect(next.searchParams.getAll("until")).toEqual([UPPER]);
        expect(next.searchParams.get("since")).toBe(body.nextCursor!.since);
        expect(next.searchParams.get("since_id")).toBe(String(body.nextCursor!.since_id));
        expect(next.searchParams.get("limit")).toBe(String(limit));
        params = Object.fromEntries(next.searchParams);
      } else {
        params = {
          until: UPPER, limit: String(limit), since: body.nextCursor!.since,
          since_id: String(body.nextCursor!.since_id)
        };
      }
    }
    throw new Error("Bounded traversal exceeded the synthetic fixture size");
  });

  it("keeps the maybe-more cursor on a full terminal page, then returns an empty page", async () => {
    const first = await page({ since: UPPER, since_id: "8703", until: UPPER, limit: "1" });
    expect(ids(first.body)).toEqual([8706]);
    expect(first.body.nextCursor).toEqual({ since: UPPER, since_id: 8706 });
    const terminal = await page({ since: UPPER, since_id: "8706", until: UPPER, limit: "1" });
    expect(terminal.body).toEqual({ rows: [], total: 0, nextCursor: null });
  });

  it("returns an empty initial window when until precedes every synthetic row", async () => {
    const { body } = await page({ until: "2026-08-31T23:59:59.999Z" });
    expect(body).toEqual({ rows: [], total: 0, nextCursor: null });
  });

  it("remains current-row reads rather than a historical snapshot after an overwrite", async () => {
    const first = await page({ until: UPPER, limit: "1" });
    expect(ids(first.body)).toEqual([8708]);
    // Synthetic fixture edit between reads, never an application write/probe.
    await TEST_ENV.CUSTOMER_DB.prepare("UPDATE customer_snapshot SET synced_at = ? WHERE customer_id = ?")
      .bind(NEXT, 8702).run();
    try {
      const next = await page({ until: UPPER, since: ZERO, since_id: "8708" });
      expect(ids(next.body)).toEqual([8707, 8701, 8705, 8703, 8706]);
    } finally {
      await TEST_ENV.CUSTOMER_DB.prepare("UPDATE customer_snapshot SET synced_at = ? WHERE customer_id = ?")
        .bind("2026-09-01T00:00:00.099Z", 8702).run();
    }
  });
});

describe("customer changes until: value-free rejection before D1", () => {
  it.each([
    "", " ", "\t", "not-a-date", "2026-09-01", "2026-09-01T00:00:00",
    "2026-09-01T00:00:00+00:00", "2026-09-01T01:00:00+01:00",
    "2026-09-01T00:00:00.0000Z", "2026-09-01T00:00:00.5000Z",
    "2026-09-01T00:00:00.4999Z", "2026-09-01T00:00:00.123456789Z",
    "2026-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z",
    "2026-13-01T00:00:00Z", "2026-00-01T00:00:00Z", "2026-09-00T00:00:00Z",
    "2026-09-01T24:00:00Z", "2026-09-01T00:00:60Z",
    "2026-09-01T00:00:00Z' OR 1=1 --"
  ])("rejects malformed or lossy until=%j", async (until) => {
    await invalid(query({ until }));
  });

  it.each([
    `until=${encodeURIComponent(UPPER)}&until=${encodeURIComponent(UPPER)}`,
    `until=${encodeURIComponent(ZERO)}&until=${encodeURIComponent(UPPER)}`,
    `until=&until=${encodeURIComponent(UPPER)}`,
    `until=${encodeURIComponent(UPPER)}&until=`
  ])("rejects ambiguous repeated until keys: %s", async (search) => {
    await invalid(search);
  });

  it.each([
    { since: NEXT, until: UPPER },
    { since: "2026-09-01T00:00:00.501Z", until: "2026-09-01T00:00:00.5Z" },
    { since: NEXT, since_id: "0", until: "2026-09-01T00:00:00.50Z" }
  ])("rejects normalized reversed endpoints before D1: %j", async (params) => {
    await invalid(query(params));
  });

  it.each([
    { since: "", since_id: "0", until: UPPER },
    { since: UPPER, since_id: "08703", until: UPPER },
    { since: UPPER, since_id: "9007199254740993", until: UPPER },
    { until: UPPER, limit: "0" }, { until: UPPER, limit: "501" }
  ])("adding until does not bypass existing cursor/limit rejection: %j", async (params) => {
    await invalid(query(params));
  });

  it("uses identical fixed correction guidance without reflecting submitted values or logging them", async () => {
    const logs = ["error", "warn", "info", "log"].map((method) =>
      vi.spyOn(console, method as "log").mockImplementation(() => {})
    );
    const first = await invalid(query({ until: "private-synthetic-upper-marker-a" }));
    const second = await invalid(query({ until: "private-synthetic-upper-marker-b" }));
    expect(first).toEqual(second);
    expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toMatch(/private-synthetic-upper-marker/);
  });
});

describe("customer changes until: bound SQL and published contract", () => {
  it.each([
    { until: "2026-09-01T00:00:00.5Z", limit: "2" },
    { since: "2026-09-01T00:00:00.1Z", until: "2026-09-01T00:00:00.5Z", limit: "2" },
    { since: UPPER, since_id: "8703", until: "2026-09-01T00:00:00.5Z", limit: "1" }
  ])("binds a normalized upper predicate and produces a synthetic EXPLAIN plan: %j", async (params) => {
    const { trace } = await page(params);
    const statement = trace.statements[0];
    const plan = await TEST_ENV.CUSTOMER_DB.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`)
      .bind(...statement.binds).all<{ detail: string }>();
    expect(plan.results.length).toBeGreaterThan(0);
    expect(plan.results.every((row) => typeof row.detail === "string")).toBe(true);
    console.info("Synthetic changes EXPLAIN (not a production latency claim)", {
      sql: statement.sql, binds: statement.binds, plan: plan.results
    });
    expect(statement.sql).toMatch(/\bsynced_at\s*<=\s*\?/i);
    expect(statement.sql).not.toContain("2026-");
    expect(statement.binds).toContain(UPPER);
    expect(statement.binds.at(-1)).toBe(Number(params.limit));
  });

  it("unknown keys retain identical bounded JSON and SQL, not a second filter language", async () => {
    const params = { until: UPPER, since: TENTH, limit: "2" };
    const baseline = await page(params);
    const unknown = await page({ ...params, bogus_param: "synthetic" });
    expect(ids(baseline.body)).toEqual([8701, 8705]);
    expect(unknown.body).toEqual(baseline.body);
    expect(unknown.trace.statements).toEqual(baseline.trace.statements);
  });

  it("preserves fields/Link compatibility only if those changes-feed features are published", async () => {
    const get = await operation();
    const projected = get.parameters.some((param) => param.in === "query" && param.name === "fields");
    const result = await page({ until: "2026-09-01T00:00:00.5Z", since: UPPER, since_id: "8703", limit: "1", fields: "company_name" });
    expect(result.body.nextCursor).toEqual({ since: UPPER, since_id: 8706 });
    expect(Object.keys(result.body.rows[0]).sort()).toEqual(projected ? ["company_name"] : [...ROW_COLUMNS].sort());
    const link = result.response.headers.get("link");
    if (link !== null) {
      const target = link.match(/<([^>]+)>;\s*rel="next"/);
      expect(target).not.toBeNull();
      const next = new URL(target![1], "http://test.local");
      expect(next.pathname).toBe(PATH);
      expect(next.searchParams.get("until")).toBe(UPPER);
      expect(next.searchParams.get("since")).toBe(UPPER);
      expect(next.searchParams.get("since_id")).toBe("8706");
      const terminal = await request(next.search.slice(1));
      expect(terminal.response.status).toBe(200);
      expect(await terminal.response.json()).toEqual({ rows: [], total: 0, nextCursor: null });
    }
  });

  it("publishes the optional lossless upper schema and interval/error guidance without changing access or identity", async () => {
    const get = await operation();
    const until = get.parameters.filter((param) => param.in === "query" && param.name === "until");
    expect(until).toHaveLength(1);
    expect(until[0]).toMatchObject({ required: false, schema: {
      type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?Z$"
    } });
    expect(until[0].schema).not.toHaveProperty("format");
    expect(until[0].description).toMatch(/inclusive|<=|≤/i);
    expect(until[0].description).toMatch(/millisecond/i);
    expect(get.description).toMatch(/until/);
    expect(get.responses["400"].description).toMatch(/until/);
    expect(get.responses["400"].description).toContain("docs/PROBLEMS.md#bad-request");
    expect(get["x-access"]).toBe("read");
    expect(get["x-effect"]).toBe("local-read");
    expect(get.operationId).toBe("listCustomerSnapshotChanges");
  });
});
