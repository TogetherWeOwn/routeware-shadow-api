import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Tests-first, independent address q contract. Real local D1 executes the SQL;
 * literal IDs/pages below are hand-derived, never computed by route helpers.
 * Catches missing OR legs, ungrouped OR leakage, wildcard/numeric conversion,
 * lost scopes/cursors/projection, extra queries and stale representation tags.
 * Fixture setup alone may write; HTTP requests may only read local D1.
 * Focus: npx vitest run test/addressLocalitySearch.acceptance.test.ts
 */
const TEST_ENV = env as unknown as Env;
const PATH = "/api/v1/address-snapshot";
const ORIGIN = "https://locality-client.invalid";
const READ_TOKEN = "test-read-token";
const LITERAL = 'O\'Ridge 50%_ &+/#? "雪\\tail';
const HUNDRED = "🧭".repeat(100);
const ASCII_HUNDRED = "a".repeat(100);
const ALL_IDS = [11, 23, 37, 42, 58, 69, 73, 83, 89, 97, 101, 109, 113, 127, 131, 137, 139, 149];
const FIELDS = "address,city,zip";
type Query = Record<string, string | number>;
type Row = Record<string, unknown>;
type Envelope = { rows: Row[]; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[]; method: string };
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);

const FIXTURES: Array<[number, number, string | null, string | null, string | null, number]> = [
  [11, 101, "741 Synthetic Way", null, null, 1],
  [23, 101, "Plain Lane", "North 741 Borough", null, 1],
  [37, 101, "Plain Lane", "", "00741-1234", 1],
  [42, 101, "741 Synthetic Way", "741", "741", 1],
  [58, 202, "Other Lane", "741", "741", 1],
  [69, 101, "Other Lane", "741", "741", 0],
  [73, 101, "Different Lane", "Elsewhere", "98000", 1],
  [83, 101, LITERAL, null, null, 1],
  [89, 101, "Literal City Lane", LITERAL, null, 1],
  [97, 101, "Literal Zip Lane", null, LITERAL, 1],
  [101, 101, "Zero Lane", null, "00123", 1],
  [109, 101, "Extended Lane", null, "00123-4567", 1],
  [113, 101, "Short Lane", null, "123", 1],
  [127, 101, null, null, null, 1],
  [131, 101, "", "", "", 1],
  [137, 101, "Unicode Lane", HUNDRED, null, 1],
  [139, 101, "Case Lane", "ÅBC", null, 1],
  [149, 101, ASCII_HUNDRED, null, null, 1]
];

let denied: string[];
let outbound: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

/** Record executed reads, deny every unapproved operation even if caught. */
function readOnlyDb(options: { forbidAll?: boolean; fail?: "count" | "page" } = {}) {
  const statements: Statement[] = [];
  function reject(operation: string): never {
    denied.push(operation);
    throw new Error("Unexpected D1 effect in address locality acceptance");
  }
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[]): D1PreparedStatement {
    return new Proxy(stmt, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values), sql, values);
        if (property === "run") return () => reject("run");
        const method = Reflect.get(target, property, target);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          if (!["all", "first", "raw"].includes(String(property))) return reject(String(property));
          statements.push({ sql, binds, method: String(property) });
          if ((options.fail === "count" && /\bCOUNT\s*\(/i.test(sql)) ||
              (options.fail === "page" && !/\bCOUNT\s*\(/i.test(sql))) {
            throw new Error(`synthetic private D1 marker ${LITERAL}`);
          }
          return Reflect.apply(method, target, args);
        };
      }
    });
  }
  const db = {
    prepare(sql: string) {
      if (options.forbidAll || !/^\s*SELECT\b/i.test(sql)) return reject("prepare");
      return wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql, []);
    },
    batch: () => reject("batch"),
    exec: () => reject("exec"),
    dump: () => reject("dump")
  } as unknown as D1Database;
  return { db, statements };
}

async function request(
  query: Query | URL | string = {},
  options: { token?: string | null; headers?: Record<string, string>; forbidAll?: boolean; fail?: "count" | "page" } = {}
) {
  const url = query instanceof URL ? query : new URL(PATH, "http://test.local");
  if (!(query instanceof URL)) {
    url.search = typeof query === "string" ? query : new URLSearchParams(
      Object.entries(query).map(([key, value]) => [key, String(value)])
    ).toString();
  }
  const recorder = readOnlyDb(options);
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "Locality-acceptance", ...options.headers });
  const token = options.token === undefined ? READ_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await app.fetch(new Request(url, { headers }), { ...TEST_ENV, CUSTOMER_DB: recorder.db });
  return { response, url, statements: recorder.statements };
}

function posture(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("vary")).toMatch(/\borigin\b/i);
  expect(response.headers.get("x-request-id")).toBe("Locality-acceptance");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  const exposed = (response.headers.get("access-control-expose-headers") ?? "").toLowerCase().split(/,\s*/);
  expect(exposed).toEqual(expect.arrayContaining(["link", "etag", "x-request-id"]));
}

function budget(statements: Statement[], countFree: boolean) {
  expect(statements).toHaveLength(countFree ? 1 : 2);
  expect(statements.filter(isCount)).toHaveLength(countFree ? 0 : 1);
  for (const s of statements) {
    expect(s.sql).toMatch(/^\s*SELECT\b/i);
    expect(s.sql).not.toMatch(/\bJOIN\b/i);
  }
}

async function page(query: Query | URL | string = {}, headers?: Record<string, string>) {
  const result = await request(query, { headers });
  expect(result.response.status).toBe(200);
  expect(result.response.headers.get("content-type")).toContain("application/json");
  posture(result.response);
  const bytes = await result.response.text();
  const body = JSON.parse(bytes) as Envelope;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  budget(result.statements, result.url.searchParams.get("includeTotal") === "false");
  return { ...result, body, bytes };
}
const ids = (body: Envelope) => body.rows.map((row) => row.pickup_address_id);

async function hash(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

function nextTarget(response: Response, current: URL, expected: Record<string, string>): URL {
  const link = response.headers.get("link");
  expect(link).toMatch(/^<\/api\/v1\/address-snapshot\?[^<>\s]*>; rel="next"$/);
  const target = new URL(/^<([^>]+)>; rel="next"$/.exec(link!)![1], current);
  expect(target.origin).toBe(current.origin);
  expect(target.pathname).toBe(PATH);
  expect(target.hash).toBe("");
  const actual = new URLSearchParams(target.search);
  if (expected.includeTotal !== "false") {
    expect([null, "true"]).toContain(actual.get("includeTotal"));
    actual.delete("includeTotal");
    delete expected.includeTotal;
  }
  expect([...actual.keys()]).toHaveLength(Object.keys(expected).length);
  expect(Object.fromEntries(actual)).toEqual(expected);
  expect(actual.has("offset")).toBe(false);
  return target;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  denied = [];
  outbound = vi.fn(async () => { throw new Error("Unexpected network in address locality acceptance"); });
  globalThis.fetch = outbound as typeof fetch;
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot")
  ]);
  await db.batch([101, 202].map((id) => db.prepare(
    "INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'synthetic-locality', 1, 'fixed-time')"
  ).bind(id)));
  for (const row of [...FIXTURES].reverse()) {
    await db.prepare(
      "INSERT INTO address_snapshot (pickup_address_id, customer_id, address, city, zip, enabled, route_id, franchise_id, state, synced_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ZZ', 'fixed-time')"
    ).bind(...row, row[0] === 42 ? 8 : 7, row[0] === 42 ? 4 : 3).run();
  }
});
afterEach(() => {
  try {
    expect(outbound).not.toHaveBeenCalled();
    expect(denied).toEqual([]);
  } finally {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  }
});

describe("address q: any-one-column literal substring", () => {
  it.each([
    { label: "street-only including null locality", q: "Synthetic", want: [11, 42] },
    { label: "city-only", q: "north 741", want: [23] },
    { label: "postcode-only", q: "00741", want: [37] },
    { label: "all OR legs without duplicate IDs", q: "741", want: [11, 23, 37, 42, 58, 69] },
    { label: "leading-zero postcode", q: "00123", want: [101, 109] },
    { label: "extended postcode fragment", q: "-4567", want: [109] },
    { label: "postcodes remain text, not exact numeric IDs", q: "123", want: [37, 101, 109, 113] },
    { label: "null and empty do not manufacture matches", q: "no-synthetic-match", want: [] },
    { label: "ASCII case folding", q: "NORTH", want: [23] },
    { label: "SQLite preserves non-ASCII case distinction", q: "åbc", want: [] },
    { label: "SQLite still folds ASCII within Unicode text", q: "Åbc", want: [139] },
    { label: "state is not searched", q: "ZZ", want: [] },
    { label: "no concatenated full-address parser", q: "Lane North", want: [] },
    { label: "no postal/geographic scope expansion", q: "00124", want: [] }
  ])("$label", async ({ q, want }) => {
    const result = await page({ q, fields: FIELDS });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
    expect(result.body.nextCursor).toBeNull();
    expect(new Set(ids(result.body)).size).toBe(want.length);
  });

  it.each([LITERAL, "'", "%", "_", "\\", "&+/#?", '"雪'])("treats %s literally in each OR leg and binds it", async (q) => {
    const { body, statements } = await page({ q });
    expect(ids(body)).toEqual([83, 89, 97]);
    expect(body.total).toBe(3);
    for (const s of statements) {
      expect(s.sql).not.toContain(LITERAL);
      expect(s.binds).toContain(q);
      expect(s.sql).not.toMatch(/\bLIKE\b/i);
    }
  });

  it("trims q before matching city/postcode and keeps the validated value in Link", async () => {
    const result = await page({ q: "  741 \t", customerId: 101, enabled: "true", fields: FIELDS, limit: 2 });
    expect(ids(result.body)).toEqual([11, 23]);
    expect(result.body.total).toBe(4);
    nextTarget(result.response, result.url, { q: "741", customerId: "101", enabled: "true", fields: FIELDS, limit: "2", cursor: "23" });
    expect(result.statements.flatMap((s) => s.binds)).not.toContain("  741 \t");
  });

  it.each(["", "  \t\n "])("empty/whitespace q preserves omitted-q rows and SQL: %j", async (q) => {
    const plain = await page();
    const blank = await page({ q });
    expect(ids(blank.body)).toEqual(ALL_IDS);
    expect(blank.body).toEqual(plain.body);
    expect(blank.statements).toEqual(plain.statements);
  });

  describe.each(["true", "false"])("blank q continuation includeTotal=%s", (includeTotal) => {
    it.each(["", "  \t\n "])("omits blank q from full-page continuation Links: %j", async (q) => {
      const filters = { customerId: "101", enabled: "true", upperId: "73", order: "asc", fields: FIELDS, limit: "2", includeTotal };
      const first = await page({ ...filters, q });
      expect(first.body).toEqual({
        rows: [
          { pickup_address_id: 11, address: "741 Synthetic Way", city: null, zip: null },
          { pickup_address_id: 23, address: "Plain Lane", city: "North 741 Borough", zip: null }
        ],
        total: includeTotal === "false" ? null : 5,
        nextCursor: 23
      });
      expect(first.response.headers.get("link")).not.toBeNull();
      const firstLink = first.response.headers.get("link")!;
      expect(new URL(firstLink.slice(1, firstLink.indexOf(">")), first.url).searchParams.has("q")).toBe(false);
      const secondTarget = nextTarget(first.response, first.url, { ...filters, cursor: "23" });
      const second = await page(secondTarget);
      expect(second.body).toEqual({
        rows: [
          { pickup_address_id: 37, address: "Plain Lane", city: "", zip: "00741-1234" },
          { pickup_address_id: 42, address: "741 Synthetic Way", city: "741", zip: "741" }
        ],
        total: includeTotal === "false" ? null : 3,
        nextCursor: 42
      });
      const lastTarget = nextTarget(second.response, second.url, { ...filters, cursor: "42" });
      expect(lastTarget.searchParams.has("q")).toBe(false);
      const last = await page(lastTarget);
      expect(last.body).toEqual({
        rows: [{ pickup_address_id: 73, address: "Different Lane", city: "Elsewhere", zip: "98000" }],
        total: includeTotal === "false" ? null : 1,
        nextCursor: null
      });
      expect(last.response.headers.get("link")).toBeNull();
    });
  });

  it("preserves leading zeros and extended postcodes as response strings", async () => {
    const { body } = await page({ q: "00123", fields: "zip" });
    expect(body.rows).toEqual([
      { pickup_address_id: 101, zip: "00123" },
      { pickup_address_id: 109, zip: "00123-4567" }
    ]);
  });

  it("accepts the existing 100-character ASCII street boundary", async () => {
    const { body } = await page({ q: ASCII_HUNDRED });
    expect(ids(body)).toEqual([149]);
    expect(body.total).toBe(1);
  });

  it("accepts 100 Unicode code points, not 100 UTF-16 units", async () => {
    const { body } = await page({ q: HUNDRED });
    expect(ids(body)).toEqual([137]);
    expect(body.total).toBe(1);
  });
});

describe("address locality q stays AND-grouped with every established selector", () => {
  it.each<{ query: Query; want: number[] }>([
    { query: { customerId: 101, enabled: "true" }, want: [11, 23, 37, 42] },
    { query: { customerId: 202, enabled: "true" }, want: [58] },
    { query: { customerId: 101, enabled: "false" }, want: [69] },
    { query: { pickupAddressId: 23 }, want: [23] },
    { query: { pickupAddressId: 37 }, want: [37] },
    { query: { pickupAddressId: 73 }, want: [] },
    { query: { customerId: 202, pickupAddressId: 23 }, want: [] },
    { query: { customerId: 101, pickupAddressId: 58 }, want: [] },
    { query: { enabled: "true", pickupAddressId: 69 }, want: [] },
    { query: { customerId: 101, enabled: "true", cursor: 23 }, want: [37, 42] },
    { query: { customerId: 101, enabled: "true", order: "desc", cursor: 37 }, want: [23, 11] }
  ])("no locality OR leakage for $query", async ({ query, want }) => {
    const result = await page({ ...query, q: "741" });
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(want.length);
    expect(result.body.nextCursor).toBeNull();
  });
});

describe.each(["true", "false"])("address locality pagination includeTotal=%s", (includeTotal) => {
  it.each([
    { label: "offset asc", query: { offset: 1 }, want: [23, 37], total: 4, next: 37 },
    { label: "offset desc", query: { offset: 1, order: "desc" }, want: [37, 23], total: 4, next: 23 },
    { label: "seek asc wins over offset", query: { cursor: 23, offset: 999 }, want: [37, 42], total: 2, next: 42 },
    { label: "seek desc wins over offset", query: { cursor: 37, offset: 999, order: "desc" }, want: [23, 11], total: 2, next: 11 },
    { label: "cursor in gap", query: { cursor: 30 }, want: [37, 42], total: 2, next: 42 },
    { label: "partial page", query: { cursor: 37 }, want: [42], total: 1, next: null },
    { label: "empty seek", query: { cursor: 42 }, want: [], total: 0, next: null },
    { label: "empty offset", query: { offset: 4 }, want: [], total: 4, next: null }
  ])("$label", async ({ query, want, total, next }) => {
    const result = await page({ ...query, q: "741", customerId: 101, enabled: "true", limit: 2, includeTotal, fields: FIELDS } as Query);
    expect(ids(result.body)).toEqual(want);
    expect(result.body.total).toBe(includeTotal === "false" ? null : total);
    expect(result.body.nextCursor).toBe(next);
    for (const row of result.body.rows) expect(Object.keys(row).sort()).toEqual(["address", "city", "pickup_address_id", "zip"]);
    if (query.cursor !== undefined) for (const s of result.statements) expect(s.sql).not.toMatch(/\bOFFSET\b/i);
    if (next === null) expect(result.response.headers.get("link")).toBeNull();
  });

  it.each(["asc", "desc"])("follows server Links through each matching ID once in %s order, then empty", async (order) => {
    const filters = { q: "741", customerId: "101", enabled: "true", order, fields: FIELDS, limit: "2", includeTotal };
    let current = await page(filters);
    const expected = order === "asc" ? [[11, 23], [37, 42], []] : [[42, 37], [23, 11], []];
    const seen: unknown[] = [];
    for (let index = 0; index < expected.length; index++) {
      expect(ids(current.body)).toEqual(expected[index]);
      expect(current.body.total).toBe(includeTotal === "false" ? null : [4, 2, 0][index]);
      seen.push(...ids(current.body));
      if (index === 2) {
        expect(current.body.nextCursor).toBeNull();
        expect(current.response.headers.get("link")).toBeNull();
      } else {
        const cursor = expected[index][1];
        expect(current.body.nextCursor).toBe(cursor);
        const target = nextTarget(current.response, current.url, { ...filters, cursor: String(cursor) });
        current = await page(target);
      }
    }
    expect(seen).toEqual(order === "asc" ? [11, 23, 37, 42] : [42, 37, 23, 11]);
    expect(new Set(seen).size).toBe(4);
  });

  it("keeps the singular address/customer scope in Link while searching unprojected locality", async () => {
    const filters = { q: "741", customerId: "101", pickupAddressId: "37", enabled: "true", order: "desc", fields: "pickup_address_id", limit: "1", includeTotal };
    const first = await page(filters);
    expect(first.body).toEqual({ rows: [{ pickup_address_id: 37 }], total: includeTotal === "false" ? null : 1, nextCursor: 37 });
    const target = nextTarget(first.response, first.url, { ...filters, cursor: "37" });
    const last = await page(target);
    expect(last.body).toEqual({ rows: [], total: includeTotal === "false" ? null : 0, nextCursor: null });
    expect(last.response.headers.get("link")).toBeNull();
  });

  it("preserves literal encoded locality in a followable next link", async () => {
    const filters = { q: LITERAL, limit: "2", includeTotal, fields: FIELDS };
    const first = await page(filters);
    expect(ids(first.body)).toEqual([83, 89]);
    expect(first.body.total).toBe(includeTotal === "false" ? null : 3);
    const target = nextTarget(first.response, first.url, { ...filters, cursor: "89" });
    const last = await page(target);
    expect(ids(last.body)).toEqual([97]);
    expect(last.body.total).toBe(includeTotal === "false" ? null : 1);
    expect(last.body.nextCursor).toBeNull();
    expect(last.response.headers.get("link")).toBeNull();
  });
});

describe("address locality final-envelope conditional semantics", () => {
  it.each(["true", "false"].flatMap((includeTotal) => [
    { includeTotal, q: "741", second: { pickup_address_id: 37, city: "", zip: "00741-1234" } },
    { includeTotal, q: "Synthetic", second: { pickup_address_id: 11, city: null, zip: null } }
  ]))("hashes sparse envelope and still executes reads for 304 (q=$q, includeTotal=$includeTotal)", async ({ includeTotal, q, second }) => {
    const query = { q, customerId: 101, enabled: "true", fields: "city,zip", limit: 2, order: "desc", includeTotal };
    const first = await page(query);
    expect(first.body.rows).toEqual([
      { pickup_address_id: 42, city: "741", zip: "741" },
      second
    ]);
    const tag = await hash(first.bytes);
    expect(first.response.headers.get("etag")).toBe(tag);
    const conditional = await request(query, { headers: { "if-none-match": tag } });
    expect(conditional.response.status).toBe(304);
    expect(conditional.response.body).toBeNull();
    expect(await conditional.response.text()).toBe("");
    expect(conditional.response.headers.get("etag")).toBe(tag);
    posture(conditional.response);
    expect(conditional.response.headers.get("link")).toBe(first.response.headers.get("link"));
    expect(conditional.statements).toEqual(first.statements);
    const changed = await page({ ...query, fields: "address" }, { "if-none-match": tag });
    expect(changed.response.headers.get("etag")).not.toBe(tag);
    const differentTotal = await page({ ...query, includeTotal: includeTotal === "true" ? "false" : "true" }, { "if-none-match": tag });
    expect(differentTotal.response.headers.get("etag")).not.toBe(tag);
  });

  it("recomputes membership when an unprojected city changes, without relying on synced_at", async () => {
    const query = { q: "741", customerId: 101, enabled: "true", fields: "address" };
    const first = await page(query);
    expect(ids(first.body)).toEqual([11, 23, 37, 42]);
    const tag = await hash(first.bytes);
    // Test fixture mutation is outside the read-only HTTP binding.
    await TEST_ENV.CUSTOMER_DB.prepare("UPDATE address_snapshot SET city = 'Elsewhere' WHERE pickup_address_id = 23").run();
    const changed = await page(query, { "if-none-match": tag });
    expect(ids(changed.body)).toEqual([11, 37, 42]);
    expect(changed.body.total).toBe(3);
    expect(changed.response.headers.get("etag")).not.toBe(tag);
  });
});

it("retains the existing discoverable read operation and optional string q", async () => {
  const result = await request(new URL("/openapi.json", "http://test.local"), { forbidAll: true });
  expect(result.response.status).toBe(200);
  const doc = await result.response.json() as {
    paths: Record<string, { get?: {
      operationId?: string;
      "x-access"?: string;
      "x-effect"?: string;
      parameters?: Array<{ name: string; in: string; required?: boolean; schema?: { type?: string } }>;
    } }>;
  };
  const operation = doc.paths[PATH]?.get;
  expect(operation).toMatchObject({ operationId: "listAddressSnapshot", "x-access": "read", "x-effect": "local-read" });
  const q = operation?.parameters?.filter((parameter) => parameter.name === "q");
  expect(q).toHaveLength(1);
  expect(q![0]).toMatchObject({ in: "query", required: false, schema: { type: "string" } });
  expect(result.statements).toEqual([]);
});

describe("address locality validation, auth and value-free failures", () => {
  it.each([null, "incorrect-synthetic-token"])("auth rejects %s before q validation or D1, including conditional requests", async (token) => {
    const result = await request({ q: `${HUNDRED}🧭` }, { token, forbidAll: true, headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(401);
    expect(result.statements).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
  });

  it.each([
    { label: "101 code points", query: new URLSearchParams({ q: `${HUNDRED}🧭` }).toString(), marker: "🧭" },
    { label: "101 ASCII characters", query: new URLSearchParams({ q: `${ASCII_HUNDRED}a` }).toString(), marker: ASCII_HUNDRED },
    { label: "raw oversized padding still rejected before trimming", query: new URLSearchParams({ q: `741${" ".repeat(98)}` }).toString(), marker: "741" },
    { label: "repeated q", query: "q=private-first&q=private-second", marker: "private-" },
    { label: "repeated blank q", query: "q=&q=private-value", marker: "private-value" }
  ])("rejects $label without D1 or submitted values", async ({ query, marker }) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
    const result = await request(query, { forbidAll: true, headers: { "if-none-match": "*" } });
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const bytes = await result.response.text();
    const body = JSON.parse(bytes) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 400, type: expect.stringMatching(/#bad-request$/), title: "Bad Request",
      detail: "Invalid request query (q). See docs/PROBLEMS.md#bad-request."
    });
    expect(bytes).not.toContain(marker);
    expect(body.instance).toBeUndefined();
    expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain(marker);
    expect(result.statements).toEqual([]);
    expect(result.response.headers.get("link")).toBeNull();
    expect(result.response.headers.get("etag")).toBeNull();
  });

  it("ignores unknown GET keys without changing results, queries or continuation scope", async () => {
    const query = { q: "741", customerId: 101, enabled: "true", fields: FIELDS, limit: 2 };
    const plain = await page(query);
    const unknown = await page({ ...query, bogus_param: "private-unknown" });
    expect(ids(unknown.body)).toEqual([11, 23]);
    expect(unknown.body).toEqual(plain.body);
    expect(unknown.statements).toEqual(plain.statements);
    expect(unknown.response.headers.get("link")).toBe(plain.response.headers.get("link"));
    expect(unknown.response.headers.get("etag")).toBe(plain.response.headers.get("etag"));
    expect(unknown.bytes).not.toContain("private-unknown");
  });

  it.each(["count", "page"] as const)("D1 %s failures stay value-free", async (fail) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((level) => vi.spyOn(console, level));
    const result = await request({ q: LITERAL }, { fail });
    expect(result.response.status).toBe(500);
    expect(result.response.headers.get("content-type")).toContain("application/problem+json");
    const bytes = await result.response.text();
    expect(JSON.parse(bytes)).toMatchObject({ status: 500, type: expect.stringMatching(/#internal$/) });
    for (const marker of [LITERAL, "synthetic private D1 marker"]) {
      expect(bytes).not.toContain(marker);
      expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain(marker);
    }
    expect(result.response.headers.get("etag")).toBeNull();
    expect(result.response.headers.get("link")).toBeNull();
  });
});
