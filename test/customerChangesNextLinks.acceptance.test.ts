import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

// Focused command: npx vitest run test/customerChangesNextLinks.acceptance.test.ts
// Test-first HTTP contract, real migrated D1, synthetic rows only. The starting
// baseline recognizes neither fields nor until on this feed; do not add either
// selector just to satisfy these tests. Ordinary-list links have a separate suite.
const PATH = "/api/v1/customer-snapshot/changes";
const ORIGIN = "https://changes-client.invalid";
const TOKEN = "test-read-token";
const REQUEST_ID = "synthetic-changes-next-link";
const TEST_ENV = env as unknown as Env;
const ZERO = "2026-09-01T00:00:00.000Z";
const TENTH = "2026-09-01T00:00:00.100Z";
const HALF = "2026-09-01T00:00:00.500Z";
const NEXT = "2026-09-01T00:00:01.000Z";
const LATER = "2026-09-02T00:00:00.000Z";
const FIXTURES = [
  [9206, HALF], [9203, ZERO], [9208, NEXT], [9207, TENTH],
  [9201, ZERO], [9205, NEXT], [9204, HALF], [9202, TENTH]
] as const;
const IDS = [9201, 9203, 9202, 9207, 9204, 9206, 9205, 9208];
const STAMPS = [ZERO, ZERO, TENTH, TENTH, HALF, HALF, NEXT, NEXT];
const COLUMNS = [
  "customer_id", "customer_type_id", "company_name", "first_name", "middle_initial",
  "last_name", "name_suffix", "customer_number", "sub_customer_number", "phone1",
  "phone2", "comments", "enabled", "synced_at"
];
type Query = Record<string, string>;
type Cursor = { since: string; since_id: number };
type Body = { rows: Array<Record<string, unknown>>; total: number; nextCursor: Cursor | null };
type Statement = { sql: string; binds: unknown[]; method: string };

// Record real SQL executions, not canned results. Reject every write or alternate
// execution entry point before it can mutate D1; record attempts even if app.fetch
// catches the exception. Seed/migration writes use the unwrapped fixture DB only.
function recordDb(real: D1Database) {
  const prepared: string[] = [];
  const statements: Statement[] = [];
  const forbidden = vi.fn((method: string) => { throw new Error(`Forbidden D1 ${method}`); });
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return {
      bind: (...values: unknown[]) => wrap(stmt.bind(...values), sql, values),
      all: () => { statements.push({ sql, binds, method: "all" }); return stmt.all(); },
      first: (...args: unknown[]) => {
        statements.push({ sql, binds, method: "first" });
        return Reflect.apply(stmt.first, stmt, args);
      },
      raw: (...args: unknown[]) => {
        statements.push({ sql, binds, method: "raw" });
        return Reflect.apply(stmt.raw, stmt, args);
      },
      run: () => forbidden("run")
    } as unknown as D1PreparedStatement;
  }
  const db = new Proxy(real, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => {
        prepared.push(sql);
        if (!/^\s*SELECT\b/i.test(sql)) return forbidden("non-SELECT prepare");
        return wrap(target.prepare(sql), sql, []);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? () => forbidden(String(property)) : value;
    }
  });
  return { db, prepared, statements, forbidden };
}
const observers: ReturnType<typeof recordDb>[] = [];

async function request(
  target: URL | Query = {},
  options: { token?: string | null; headers?: Record<string, string>; db?: D1Database } = {}
) {
  const recorder = recordDb(TEST_ENV.CUSTOMER_DB);
  observers.push(recorder);
  const url = target instanceof URL ? target : new URL(`${PATH}?${new URLSearchParams(target)}`, ORIGIN);
  const headers = new Headers({ origin: ORIGIN, "x-request-id": REQUEST_ID, ...options.headers });
  const token = options.token === undefined ? TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const input = new Request(url, { headers, redirect: "manual" });
  for (const [key, value] of Object.entries(options.headers ?? {})) {
    expect(input.headers.get(key), `injection fixture actually sends ${key}`).toBe(value);
  }
  const response = await app.fetch(input, { ...TEST_ENV, CUSTOMER_DB: options.db ?? recorder.db });
  return { response, url, recorder };
}

function metadata(response: Response, origin = ORIGIN) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-request-id")).toBe(REQUEST_ID);
  expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  expect(response.headers.get("vary")).toMatch(/origin/i);
  expect(response.headers.get("access-control-allow-credentials")).toBeNull();
}

async function page(target: URL | Query = {}, headers?: Record<string, string>) {
  const result = await request(target, { headers });
  expect(result.response.status).toBe(200);
  metadata(result.response, headers?.origin ?? ORIGIN);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  const bytes = await result.response.clone().text();
  const body = JSON.parse(bytes) as Body;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  expect(body.total).toBe(body.rows.length);
  for (const row of body.rows) expect(Object.keys(row).sort()).toEqual([...COLUMNS].sort());
  expect(result.recorder.prepared).toHaveLength(1);
  expect(result.recorder.statements).toHaveLength(1);
  expect(result.recorder.statements[0].method).toBe("all");
  expect(result.recorder.statements[0].sql).not.toMatch(/\bCOUNT\s*\(/i);
  return { ...result, body, bytes };
}

function next(result: Awaited<ReturnType<typeof page>>, expected: Cursor, limit: number): URL {
  expect(result.body.nextCursor).toEqual(expected);
  const link = result.response.headers.get("link");
  expect(link, "non-null composite nextCursor requires a relative rel=next Link").not.toBeNull();
  expect(link).toMatch(/^<\/api\/v1\/customer-snapshot\/changes\?[^<>\s]*>; rel="next"$/);
  const raw = /^<([^>]+)>; rel="next"$/.exec(link!)![1];
  expect(raw, "timestamp must be percent-encoded in the URL").toContain("%3A");
  const target = new URL(raw, result.url);
  expect(target.origin).toBe(result.url.origin);
  expect(target.pathname).toBe(PATH);
  expect(target.hash).toBe("");
  expect(target.username).toBe("");
  expect(target.password).toBe("");
  // Exactly one of each recognized key; no unknowns, old cursor, or list cursor.
  expect([...target.searchParams.keys()].sort()).toEqual(["limit", "since", "since_id"]);
  expect(Object.fromEntries(target.searchParams)).toEqual({
    since: expected.since, since_id: String(expected.since_id), limit: String(limit)
  });
  return target;
}

async function seed(id: number, stamp: string) {
  await TEST_ENV.CUSTOMER_DB.prepare(
    "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, ?, 1, ?)"
  ).bind(id, `Synthetic changes link ${id}`, stamp).run();
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  observers.length = 0;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected outbound fetch in changes next-link acceptance"); }));
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  for (const [id, stamp] of FIXTURES) await seed(id, stamp);
});
afterEach(() => {
  try {
    expect(globalThis.fetch, "all requests must remain hermetic").not.toHaveBeenCalled();
    for (const recorder of observers) expect(recorder.forbidden, "zero writes or unobserved DB entry points").not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

describe("customer changes: follow the server-supplied composite next link", () => {
  it.each([1, 2, 3])("walks static timestamp ties and runs exactly once at limit=%i", async (limit) => {
    let current = await page({ limit: String(limit) });
    const seen: unknown[] = [];
    for (let index = 0; index <= IDS.length; index++) {
      const offset = seen.length;
      expect(current.body.rows.map((row) => row.customer_id)).toEqual(IDS.slice(offset, offset + limit));
      expect(current.body.rows.map((row) => row.synced_at)).toEqual(STAMPS.slice(offset, offset + limit));
      seen.push(...current.body.rows.map((row) => row.customer_id));
      if (current.body.rows.length < limit) {
        expect(current.body.nextCursor).toBeNull();
        expect(current.response.headers.get("link")).toBeNull();
        expect(seen).toEqual(IDS);
        expect(new Set(seen).size).toBe(8);
        return;
      }
      const last = seen.length - 1;
      // Pass the emitted URL unchanged, never reconstruct a request from JSON.
      current = await page(next(current, { since: STAMPS[last], since_id: IDS[last] }, limit));
    }
    throw new Error("server next links did not terminate within the static fixture bound");
  });

  it("carries effective default limit=50 and follows the short remaining page", async () => {
    for (let id = 9301; id <= 9344; id++) await seed(id, LATER);
    const first = await page();
    expect(first.body.rows.map((row) => row.customer_id)).toEqual([
      ...IDS, ...Array.from({ length: 42 }, (_, index) => 9301 + index)
    ]);
    const tail = await page(next(first, { since: LATER, since_id: 9342 }, 50));
    expect(tail.body.rows.map((row) => row.customer_id)).toEqual([9343, 9344]);
    expect(tail.body.nextCursor).toBeNull();
    expect(tail.response.headers.get("link")).toBeNull();
  });

  it("replaces a bare normalized since with both halves of the returned cursor", async () => {
    const first = await page({ since: "2026-09-01T00:00:00.1Z", limit: "2" });
    expect(first.body.rows.map((row) => row.customer_id)).toEqual([9204, 9206]);
    const terminalFull = await page(next(first, { since: HALF, since_id: 9206 }, 2));
    expect(terminalFull.body.rows.map((row) => row.customer_id)).toEqual([9205, 9208]);
    const empty = await page(next(terminalFull, { since: NEXT, since_id: 9208 }, 2));
    expect(empty.body).toEqual({ rows: [], total: 0, nextCursor: null });
    expect(empty.response.headers.get("link")).toBeNull();
  });

  it("replaces both old tuple values and retains the same-timestamp remainder", async () => {
    const first = await page({ since: "2026-09-01T00:00:00.1Z", since_id: "9202", limit: "1" });
    expect(first.body.rows.map((row) => row.customer_id)).toEqual([9207]);
    const second = await page(next(first, { since: TENTH, since_id: 9207 }, 1));
    expect(second.body.rows.map((row) => row.customer_id)).toEqual([9204]);
    next(second, { since: HALF, since_id: 9204 }, 1);
  });

  it.each([undefined, ""])("uses the initial-page cursor when since=%j and links the timestamp tie", async (since) => {
    const first = await page(since === undefined ? { limit: "1" } : { limit: "1", since });
    expect(first.body.rows.map((row) => row.customer_id)).toEqual([9201]);
    const second = await page(next(first, { since: ZERO, since_id: 9201 }, 1));
    expect(second.body.rows.map((row) => row.customer_id)).toEqual([9203]);
  });

  it("normalizes a coerced numeric limit rather than reflecting its raw spelling", async () => {
    const first = await page({ limit: "2e0" });
    expect(first.body.rows.map((row) => row.customer_id)).toEqual([9201, 9203]);
    next(first, { since: ZERO, since_id: 9203 }, 2);
  });

  it("ignores unknown keys without echoing request origins, credentials or arbitrary paths", async () => {
    const clean = await page({ limit: "1" });
    const tainted = await page({
      limit: "1", bogus: "unknown-marker", token: "query-token-marker",
      authorization: "Bearer query-credential-marker", cursor: "ordinary-cursor-marker",
      offset: "offset-marker", url: "https://redirect-marker.invalid/elsewhere",
      path: "</elsewhere>; rel=\"next\"", host: "query-host-marker.invalid"
    }, {
      host: "host-marker.invalid", forwarded: "host=forwarded-marker.invalid;proto=http",
      "x-forwarded-host": "x-forwarded-marker.invalid", "x-forwarded-proto": "http",
      cookie: "synthetic=query-cookie-marker", origin: "https://origin-marker.invalid"
    });
    expect(tainted.bytes).toBe(clean.bytes);
    expect(tainted.recorder.statements).toEqual(clean.recorder.statements);
    const target = next(tainted, { since: ZERO, since_id: 9201 }, 1);
    expect(tainted.response.headers.get("link")).toBe(clean.response.headers.get("link"));
    expect(tainted.response.headers.get("link")).not.toMatch(/marker|Bearer|test-read-token|https?:|\/\//);
    const second = await page(target);
    expect(second.body.rows.map((row) => row.customer_id)).toEqual([9203]);
  });
});

describe("customer changes: unchanged wire and database controls", () => {
  it.each([
    ["initial", { limit: "2" }],
    ["bare normalized timestamp", { since: "2026-09-01T00:00:00.1Z", limit: "3" }],
    ["tuple remainder", { since: TENTH, since_id: "9202", limit: "2" }],
    ["full terminal page", { since: HALF, limit: "2" }],
    ["short terminal page", { since: HALF, limit: "3" }],
    ["empty tail", { since: NEXT, since_id: "9208", limit: "2" }]
  ] as const)("preserves pre-feature JSON bytes and exact SQL/binds: %s", async (_label, query) => {
    const result = await page(query);
    // Recorded before any feature implementation, at 55bf1bd5. Do not update
    // these goldens when implementing headers; they deliberately exclude Link.
    expect({ bytes: result.bytes, statements: result.recorder.statements }).toMatchSnapshot();
  });

  it.each([
    ["short", { limit: "500" }, IDS],
    ["empty bare since", { since: NEXT, limit: "1" }, []],
    ["empty tuple", { since: NEXT, since_id: "9208", limit: "2" }, []]
  ] as const)("omits Link on a null-cursor %s page", async (_label, query, ids) => {
    const result = await page(query);
    expect(result.body.rows.map((row) => row.customer_id)).toEqual(ids);
    expect(result.body.nextCursor).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  });

  it.each([
    ["invalid timestamp", { since: "secret-bad-timestamp" }],
    ["unpaired id", { since_id: "0" }],
    ["invalid id", { since: ZERO, since_id: "secret-bad-id" }],
    ["excessive limit", { limit: "501" }],
    ["zero limit", { limit: "0" }]
  ] as const)("keeps value-free problem+json and no Link or D1: %s", async (_label, query) => {
    const { response, recorder } = await request(query);
    expect(response.status).toBe(400);
    metadata(response);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("link")).toBeNull();
    const body = await response.json();
    expect(body).toMatchObject({
      type: expect.stringMatching(/#bad-request$/), title: "Bad Request", status: 400,
      detail: expect.stringMatching(/^Invalid request query \((?:since|since_id|limit)\)\. See docs\/PROBLEMS\.md#bad-request\.$/)
    });
    expect(JSON.stringify(body)).not.toContain("secret-bad-");
    expect(recorder.prepared).toEqual([]);
    expect(recorder.statements).toEqual([]);
  });

  it.each([null, "synthetic-invalid-token"])("keeps auth before validation and D1 with token=%j", async (token) => {
    const { response, recorder } = await request({ since: "invalid", limit: "501" }, { token });
    expect(response.status).toBe(401);
    metadata(response);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("link")).toBeNull();
    expect(await response.json()).toMatchObject({ status: 401, type: expect.stringMatching(/#unauthorized$/) });
    expect(recorder.prepared).toEqual([]);
    expect(recorder.statements).toEqual([]);
  });

  it("does not attach a Link to a D1 failure or disclose its cause", async () => {
    const db = { prepare: () => { throw new Error("synthetic-secret-database-cause"); } } as unknown as D1Database;
    const { response } = await request({ limit: "1" }, { db });
    expect(response.status).toBe(500);
    metadata(response);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(response.headers.get("link")).toBeNull();
    const body = await response.json();
    expect(body).toMatchObject({ status: 500 });
    expect(JSON.stringify(body)).not.toContain("synthetic-secret-database-cause");
  });

  it("keeps Link exposed alongside every existing CORS exposure field", async () => {
    const { response } = await page({ limit: "1" });
    const exposed = (response.headers.get("access-control-expose-headers") ?? "")
      .split(",").map((name) => name.trim().toLowerCase());
    expect(exposed).toEqual(expect.arrayContaining([
      "etag", "retry-after", "content-disposition", "x-request-id",
      "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset",
      "ratelimit", "ratelimit-policy", "link"
    ]));
  });
});

it("publishes an optional string Link on the mounted changes operation without renaming it", async () => {
  const response = await exports.default.fetch(`${ORIGIN}/openapi.json`);
  expect(response.status).toBe(200);
  const doc = await response.json() as {
    paths: Record<string, { get: {
      operationId: string; "x-access": string; "x-effect": string;
      responses: Record<string, { headers?: Record<string, { required?: boolean; schema?: { type?: string } }> }>;
    } }>;
  };
  const operation = doc.paths[PATH].get;
  expect(operation.operationId).toBe("listCustomerSnapshotChanges");
  expect(operation["x-access"]).toBe("read");
  expect(operation["x-effect"]).toBe("local-read");
  const link = Object.entries(operation.responses["200"].headers ?? {})
    .find(([name]) => name.toLowerCase() === "link")?.[1];
  expect(link, "mounted OpenAPI must advertise optional composite continuation").toBeDefined();
  expect(link?.required).not.toBe(true);
  expect(link?.schema?.type).toBe("string");
});
