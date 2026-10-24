import { env, exports } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Customer changes sparse fields: HTTP + migrated local D1, no product helpers.
 * Breaks caught: ignored/lenient selectors, leaked columns, projection-before-
 * cursor, lost same-stamp ties, COUNT totals, auth-after-validation, and writes.
 * Run: npx vitest run test/customerChangesFields.acceptance.test.ts
 * This is an intentionally RED test-first handoff; no implementation is bundled.
 */
const PATH = "/api/v1/customer-snapshot/changes";
const TEST_ENV = env as unknown as Env;
const ORIGIN = "https://changes-fields-client.invalid";
const PROBLEMS = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#";
const FIELDS_DETAIL = "Invalid request query (fields). See docs/PROBLEMS.md#bad-request.";
const ZERO = "2026-09-01T00:00:00.000Z";
const HALF = "2026-09-01T00:00:00.500Z";
const NEXT = "2026-09-01T00:00:01.000Z";
const COLUMNS = [
  "customer_id", "customer_type_id", "company_name", "first_name", "middle_initial",
  "last_name", "name_suffix", "customer_number", "sub_customer_number", "phone1",
  "phone2", "comments", "enabled", "synced_at"
] as const;
type Row = Record<string, unknown>;
type Cursor = { since: string; since_id: number };
type Page = { rows: Row[]; total: number; nextCursor: Cursor | null };

// Deliberately not id order: three equal stamps cross the limit=2 boundary;
// the final timestamp has the smallest id. Nullable and disabled rows are upserts.
const FIXTURES: Row[] = [
  { customer_id: 8751, synced_at: ZERO, enabled: 1 },
  { customer_id: 8752, synced_at: ZERO, enabled: 0 },
  { customer_id: 8754, synced_at: ZERO, enabled: 1 },
  { customer_id: 8753, synced_at: HALF, enabled: 1 },
  { customer_id: 8750, synced_at: NEXT, enabled: 1 }
].map((row) => ({
  customer_type_id: 2, company_name: `Synthetic company ${row.customer_id}`,
  first_name: "Synthetic", middle_initial: null, last_name: "Fixture", name_suffix: null,
  customer_number: `S-${row.customer_id}`, sub_customer_number: null,
  phone1: `555-${row.customer_id}`, phone2: null, comments: `Synthetic private note ${row.customer_id}`,
  ...row
}));
const IDS = [8751, 8752, 8754, 8753, 8750];
const STAMPS = [ZERO, ZERO, ZERO, HALF, NEXT];

function query(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

// Read-through observer: SQL results, tuple comparisons and LIMIT are all real
// SQLite. No fake interprets the cursor or supplies pre-projected canned rows.
function observeDb() {
  const calls = vi.fn<(method: string) => void>();
  const writes = vi.fn<(sql: string) => void>();
  const db = new Proxy(TEST_ENV.CUSTOMER_DB, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls(String(property));
        if (property === "exec" || (property === "prepare" && !/^\s*SELECT\b/i.test(String(args[0])))) {
          writes(String(args[0]));
          throw new Error("Unexpected non-read SQL in customer changes fields acceptance test");
        }
        return Reflect.apply(value, target, args);
      };
    }
  });
  return { db, calls, writes };
}
let observed: ReturnType<typeof observeDb>;
const unexpectedBinding = vi.fn<(binding: string, method: string) => never>((binding, method) => {
  throw new Error(`Unexpected ${binding}.${method} access in local changes read`);
});
function denyBinding<T extends object>(binding: string): T {
  return new Proxy({} as T, {
    get: (_target, method) => (..._args: unknown[]) => unexpectedBinding(binding, String(method))
  });
}

async function get(search = "", token: string | null = "test-read-token"): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "synthetic-changes-fields-request" });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return app.fetch(new Request(`http://test.local${PATH}${search ? `?${search}` : ""}`, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: observed.db,
    SNAPSHOTS: denyBinding<R2Bucket>("SNAPSHOTS"),
    BROWSER: denyBinding<Fetcher>("BROWSER"),
    // The middleware constructs a stub on every request and records local auth
    // throttle outcomes. Permit only those local messages, never session/login.
    AUTH_SESSION: {
      idFromName: (name: string) => name,
      get: () => ({
        async fetch(input: RequestInfo | URL) {
          const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
          if (path === "/throttle/failure") return Response.json({ blocked: false, retryAfterSec: 0 });
          if (path === "/throttle/clear") return new Response("OK");
          return unexpectedBinding("AUTH_SESSION", path);
        }
      })
    } as unknown as Env["AUTH_SESSION"]
  });
}

function noStoreCors(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
}

async function page(search = "", token?: string): Promise<Page> {
  const response = await get(search, token);
  expect(response.status).toBe(200);
  noStoreCors(response);
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = await response.json() as Page;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  expect(body.total).toBe(body.rows.length);
  return body;
}

// Independent literal fixtures, not the response or the production projection.
function selected(rows: Row[], fields: string): Row[] {
  const names = new Set(["customer_id", ...fields.split(",")]);
  return rows.map((row) => Object.fromEntries([...names].map((name) => [name, row[name]])));
}

async function fields400(search: string): Promise<unknown> {
  const response = await get(search);
  expect.soft(observed.calls.mock.calls, "malformed fields must fail before all D1 entry points").toEqual([]);
  expect.soft(response.status).toBe(400);
  noStoreCors(response);
  expect.soft(response.headers.get("content-type")).toContain("application/problem+json");
  const body = await response.json();
  expect(body).toEqual({ type: `${PROBLEMS}bad-request`, title: "Bad Request", status: 400, detail: FIELDS_DETAIL });
  return body;
}

beforeAll(async () => {
  await ensureD1TestTables();
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  // Seed out of tuple order so accidental insertion-order paging cannot pass.
  await db.batch([...FIXTURES].reverse().map((row) => db.prepare(
    `INSERT INTO customer_snapshot (${COLUMNS.join(",")}) VALUES (${COLUMNS.map(() => "?").join(",")})`
  ).bind(...COLUMNS.map((name) => row[name]))));
});

beforeEach(() => {
  observed = observeDb();
  unexpectedBinding.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("Unexpected outbound fetch in customer changes fields acceptance test");
  }));
});

afterEach(() => {
  try {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(unexpectedBinding).not.toHaveBeenCalled();
    expect(observed.writes.mock.calls, "GET changes must never attempt writes").toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});

describe("customer changes fields: selectors and preserved defaults", () => {
  it("absent fields returns complete rows and the unchanged envelope", async () => {
    const body = await page();
    expect(body).toEqual({ rows: FIXTURES, total: 5, nextCursor: null });
    expect(observed.calls).toHaveBeenCalled();
  });

  it.each(COLUMNS)("selects only customer_id plus %s, retaining nulls and stored values", async (fields) => {
    const body = await page(query({ fields }));
    expect(body).toEqual({ rows: selected(FIXTURES, fields), total: 5, nextCursor: null });
  });

  it("all and explicit-id selectors use exactly the existing customer allowlist", async () => {
    expect((await page(query({ fields: COLUMNS.join(",") }))).rows).toEqual(FIXTURES);
    const implicit = await page(query({ fields: "company_name,enabled" }));
    const explicit = await page(query({ fields: "enabled,customer_id,company_name" }));
    expect(implicit.rows).toEqual(selected(FIXTURES, "company_name,enabled"));
    expect(explicit).toEqual(implicit);
  });

  it.each(["test-read-token", "test-api-token", "test-sync-secret"])(
    "accepts the existing bearer role %s without exposing unselected phone/comments",
    async (token) => {
      const body = await page(query({ fields: "company_name" }), token);
      expect(body.rows).toEqual(selected(FIXTURES, "company_name"));
    }
  );

  it("ignores unrelated unknown keys even when repeated, without enabling other filters", async () => {
    const params = { fields: "company_name", limit: "2" };
    const plain = await page(query(params));
    const extra = await page(`${query(params)}&unknown=SYNTHETIC&unknown=other&include=addresses&until=invalid&enabled=true&includeTotal=false&offset=99`);
    expect(extra).toEqual(plain);
    expect(extra.rows).toEqual(selected(FIXTURES.slice(0, 2), "company_name"));
    expect(extra.total).toBe(2);
  });

  it("is an idempotent upserts-only read, including disabled rows and no tombstone markers", async () => {
    const before = await TEST_ENV.CUSTOMER_DB.prepare("SELECT * FROM customer_snapshot ORDER BY customer_id").all();
    const search = query({ fields: "company_name,enabled", limit: "2" });
    const first = await page(search);
    expect(await page(search)).toEqual(first);
    expect(first.rows).toEqual(selected(FIXTURES.slice(0, 2), "company_name,enabled"));
    const after = await TEST_ENV.CUSTOMER_DB.prepare("SELECT * FROM customer_snapshot ORDER BY customer_id").all();
    expect(after.results).toEqual(before.results);
  });
});

describe.each(["customer_id", "company_name", "company_name,synced_at"])(
  "customer changes fields: projection %s cannot alter page membership or cursor",
  (fields) => {
    it.each([1, 2, 3, 5])("walks sparse and full pages identically with limit=%i", async (limit) => {
      let cursor: Cursor | null = null;
      const visited: unknown[] = [];
      // Fixed fixture-sized bound, including empty tail after a full terminal page.
      for (let offset = 0; offset <= FIXTURES.length; offset += limit) {
        const params = { limit: String(limit), ...(cursor ? { since: cursor.since, since_id: String(cursor.since_id) } : {}) };
        const full = await page(query(params));
        const sparse = await page(query({ ...params, fields }));
        const expected = FIXTURES.slice(offset, offset + limit);
        const last = offset + expected.length - 1;
        const next = expected.length === limit ? { since: STAMPS[last], since_id: IDS[last] } : null;
        expect(full.rows).toEqual(expected);
        expect(sparse.rows.map((row) => row.customer_id)).toEqual(IDS.slice(offset, offset + limit));
        expect(sparse.total).toBe(full.total);
        expect(sparse.nextCursor).toEqual(full.nextCursor);
        expect(sparse.nextCursor).toEqual(next);
        expect.soft(sparse.rows, "only selected keys may cross the HTTP boundary").toEqual(selected(expected, fields));
        visited.push(...sparse.rows.map((row) => row.customer_id));
        cursor = sparse.nextCursor;
        if (cursor === null) {
          expect(visited).toEqual(IDS);
          return;
        }
      }
      throw new Error("Customer changes sparse cursor did not terminate");
    });
  }
);

describe("customer changes fields: cursor and limit contracts compose", () => {
  it.each([undefined, ""])("empty/omitted since=%j still starts at the first row", async (since) => {
    const body = await page(query({ fields: "customer_id", ...(since === undefined ? {} : { since }) }));
    expect(body).toEqual({ rows: selected(FIXTURES, "customer_id"), total: 5, nextCursor: null });
  });

  it.each(["2026-09-01T00:00:00Z", "2026-09-01T00:00:00.0Z", ZERO])(
    "keeps strict bare replay versus lossless tie resume for %s",
    async (since) => {
      const fields = "company_name";
      const bare = await page(query({ since, fields, limit: "1" }));
      expect(bare.rows).toEqual(selected([FIXTURES[3]], fields));
      expect(bare.nextCursor).toEqual({ since: HALF, since_id: 8753 });
      const composite = await page(query({ since, since_id: "8752", fields, limit: "1" }));
      expect(composite.rows).toEqual(selected([FIXTURES[2]], fields));
      expect(composite.nextCursor).toEqual({ since: ZERO, since_id: 8754 });
    }
  );

  it("keeps the maximum limit and an empty selected page", async () => {
    expect(await page(query({ fields: "customer_id", limit: "500" }))).toEqual({
      rows: selected(FIXTURES, "customer_id"), total: 5, nextCursor: null
    });
    expect(await page(query({ fields: "company_name", since: NEXT }))).toEqual({ rows: [], total: 0, nextCursor: null });
  });

  it.each<Record<string, string>>([
    { limit: "0" }, { limit: "501" }, { limit: "1.5" },
    { since: "2026-09-01T00:00:00.0001Z" }, { since: "2026-09-01T01:00:00+01:00" },
    { since_id: "0" }, { since: ZERO, since_id: "08752" },
    { since: ZERO, since_id: "9007199254740993" }
  ])("still rejects invalid cursor/limit %j before D1 with a valid selector", async (params) => {
    const response = await get(query({ ...params, fields: "company_name" }));
    expect(response.status).toBe(400);
    noStoreCors(response);
    expect(response.headers.get("content-type")).toContain("application/problem+json");
    expect(await response.json()).toMatchObject({ type: `${PROBLEMS}bad-request`, status: 400 });
    expect(observed.calls).not.toHaveBeenCalled();
  });
});

describe("customer changes fields: value-free errors and auth-before-D1", () => {
  it.each([
    "", ",", "company_name,", ",company_name", "company_name,,phone1",
    "company_name,company_name", "customer_id,customer_id", "company_name,customer_id,company_name",
    " company_name", "company_name ", "company_name, phone1", "COMPANY_NAME",
    "rowid", "erased_at", "pickup_address_id", "container_id", "city", "serial_number",
    "customer.company_name", "*", "SYNTHETIC-REJECTED-FIELD", "company_name,SYNTHETIC-REJECTED-FIELD"
  ])("rejects selector %j before D1 with fixed recovery guidance", async (fields) => {
    await fields400(query({ fields }));
  });

  it.each([
    "fields=company_name&fields=phone1", "fields=company_name&fields=company_name",
    "fields=&fields=company_name", "fields"
  ])("rejects ambiguous/empty raw query %s before D1", async (search) => {
    await fields400(search);
  });

  it("returns identical stable problem type and correction for distinct submitted values", async () => {
    const first = await fields400(query({ fields: "SYNTHETIC-FIRST-REJECTED" }));
    const second = await fields400(query({ fields: "SYNTHETIC-SECOND-REJECTED" }));
    expect(second).toEqual(first);
  });

  it.each([null, "wrong-token", ""])("authenticates token=%j before valid or malformed selectors", async (token) => {
    for (const search of ["fields=company_name", "fields=SYNTHETIC-REJECTED", "fields=", "fields=company_name&fields=phone1"]) {
      const response = await get(search, token);
      expect(response.status).toBe(401);
      noStoreCors(response);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(await response.json()).toEqual({
        type: `${PROBLEMS}unauthorized`, title: "Unauthorized", status: 401,
        detail: "Send Authorization: Bearer <SHADOW_API_TOKEN>. See docs/PROBLEMS.md#unauthorized.",
        instance: PATH, requestId: "synthetic-changes-fields-request"
      });
    }
    expect(observed.calls).not.toHaveBeenCalled();
  });
});

describe("customer changes fields: mounted machine-readable contract", () => {
  type Parameter = { name: string; in: string; required?: boolean; description?: string; schema?: Record<string, unknown> };
  type Operation = {
    operationId?: string; description?: string; parameters?: Parameter[];
    responses?: Record<string, { description?: string; content?: Record<string, { schema?: unknown }> }>;
    [key: string]: unknown;
  };
  async function document() {
    const response = await exports.default.fetch("http://test.local/openapi.json");
    expect(response.status).toBe(200);
    return await response.json() as { paths: Record<string, { get?: Operation }> };
  }

  it("publishes the same optional fields contract as the customer list, keeping operation identity and envelope", async () => {
    const doc = await document();
    const operation = doc.paths[PATH]?.get;
    expect(operation?.operationId).toBe("listCustomerSnapshotChanges");
    expect(operation?.["x-access"]).toBe("read");
    expect(operation?.["x-effect"]).toBe("local-read");
    const fields = operation?.parameters?.find((p) => p.name === "fields");
    expect(fields).toMatchObject({ in: "query", required: false, schema: { type: "string" } });
    expect(fields).toEqual(doc.paths["/api/v1/customer-snapshot"]?.get?.parameters?.find((p) => p.name === "fields"));
    expect(operation?.parameters?.filter((p) => p.in === "query").map((p) => p.name).sort()).toEqual(["fields", "limit", "since", "since_id"]);
    expect(operation?.responses?.["200"]?.content?.["application/json"]?.schema).toEqual({ $ref: "#/components/schemas/CustomerSnapshotChanges" });
  });

  it("documents projection without changing the composite cursor and fixed selector correction guidance", async () => {
    const operation = (await document()).paths[PATH]?.get;
    expect(operation?.description).toMatch(/fields[\s\S]*(?:project|select)|(?:project|select)[\s\S]*fields/i);
    expect(operation?.description).toMatch(/always[\s\S]*customer_id|customer_id[\s\S]*always/i);
    expect(operation?.description).toMatch(/cursor/i);
    const badRequest = operation?.responses?.["400"]?.description ?? "";
    expect(badRequest).toMatch(/fields.*selector|selector.*fields/i);
    expect(badRequest).toMatch(/before.*D1/i);
    expect(badRequest).toContain("docs/PROBLEMS.md#bad-request");
  });
});
