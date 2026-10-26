import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent Test Author oracle: countOnly is a representation mode, not a new
 * selector or cached statistic. Mutation targets: returning a page; skipping or
 * duplicating COUNT; dropping a predicate/cursor; subtracting limit/offset;
 * bypassing validation/auth on 304; hashing payload values not served bytes.
 * Real local D1, literal fixture-derived totals, forbidden network/R2/writes.
 */
const TEST_ENV = env as unknown as Env;
const READ_TOKEN = "test-read-token";
const ORIGIN = "https://count-only.invalid";
type Query = Record<string, string>;
type Envelope = { rows: Record<string, unknown>[]; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[]; method: string };
type Spec = {
  name: "customer" | "address" | "container";
  id: string;
  field: string;
  filters: Array<{ query: Query; total: number }>;
  invalid: string[];
};
const SPECS: Spec[] = [
  {
    name: "customer", id: "customer_id", field: "company_name",
    filters: [
      { query: { customerId: "2" }, total: 1 },
      { query: { customerNumber: "A" }, total: 2 },
      { query: { subCustomerNumber: "B" }, total: 2 },
      { query: { customerNumber: "A", subCustomerNumber: "B", enabled: "true" }, total: 1 },
      { query: { phone: "000-0002" }, total: 2 },
      { query: { phone: "no-synthetic-match" }, total: 0 },
      { query: { comments: "needle" }, total: 2 },
      { query: { comments: "" }, total: 6 },
      { query: { hasAddresses: "true" }, total: 2 },
      { query: { hasAddresses: "false" }, total: 4 },
      { query: { hasAddresses: "true", customerId: "2" }, total: 0 }
    ],
    invalid: ["customerNumber=", "subCustomerNumber=", "phone=", `comments=${"x".repeat(101)}`, "hasAddresses=bogus"]
  },
  {
    name: "address", id: "pickup_address_id", field: "address",
    filters: [
      { query: { customerId: "1" }, total: 3 },
      { query: { pickupAddressId: "2" }, total: 1 },
      { query: { routeId: "7" }, total: 2 },
      { query: { franchiseId: "F" }, total: 2 },
      { query: { city: "North" }, total: 2 },
      { query: { state: "ZZ" }, total: 2 },
      { query: { zip: "00123" }, total: 2 },
      { query: { hasContainers: "true" }, total: 4 },
      { query: { hasContainers: "false" }, total: 2 },
      { query: { customerId: "1", routeId: "7", city: "North", state: "ZZ", zip: "00123" }, total: 1 }
    ],
    invalid: ["pickupAddressId=bad", "routeId=bad", "franchiseId=", "city=", "state=", "zip=", "hasContainers=bogus"]
  },
  {
    name: "container", id: "container_id", field: "location_address",
    filters: [
      { query: { customerId: "1" }, total: 4 },
      { query: { pickupAddressId: "2" }, total: 2 },
      { query: { containerId: "2" }, total: 1 },
      { query: { serialNumber: "serial-needle" }, total: 1 },
      { query: { rfid: "tag" }, total: 2 },
      { query: { zip: "00123" }, total: 2 },
      { query: { q: "North" }, total: 2 },
      { query: { customerId: "1", pickupAddressId: "2", rfid: "tag", zip: "00123" }, total: 1 }
    ],
    invalid: ["pickupAddressId=bad", "containerId=bad", "serialNumber=", "rfid=", "zip="]
  }
];
const pathOf = (s: Spec) => `/api/v1/${s.name}-snapshot`;
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);

/** Observe executions, including bound and batched statements, without faking SQL. */
function recordDb() {
  const statements: Statement[] = [];
  const prepared: string[] = [];
  const violations: string[] = [];
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const records = new WeakMap<D1PreparedStatement, Omit<Statement, "method">>();
  function observe(sql: string, binds: unknown[], method: string) {
    statements.push({ sql, binds, method });
    if (!/^\s*SELECT\b/i.test(sql) || method === "run") {
      violations.push("non-read D1 execution");
      throw new Error("Count-only GET attempted a D1 write");
    }
  }
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[] = []): D1PreparedStatement {
    const wrapped = new Proxy(stmt, {
      get(target, key) {
        if (key === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql, args);
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          observe(sql, binds, String(key));
          return Reflect.apply(value, target, args);
        };
      }
    });
    originals.set(wrapped, stmt);
    records.set(wrapped, { sql, binds });
    return wrapped;
  }
  const db = {
    prepare(sql: string) {
      prepared.push(sql);
      return wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql);
    },
    batch(stmts: D1PreparedStatement[]) {
      for (const stmt of stmts) {
        const record = records.get(stmt)!;
        observe(record.sql, record.binds, "batch");
      }
      return TEST_ENV.CUSTOMER_DB.batch(stmts.map((stmt) => originals.get(stmt)!));
    },
    exec() { violations.push("D1 exec"); throw new Error("Unbound D1 exec forbidden"); }
  } as unknown as D1Database;
  return { db, statements, prepared, violations };
}

let outbound: ReturnType<typeof vi.fn>;
let r2: ReturnType<typeof vi.fn<() => void>>;
const recorders: ReturnType<typeof recordDb>[] = [];
async function request(
  spec: Spec, query: Query | string = {},
  options: { token?: string | null; tag?: string } = {}
) {
  const recorder = recordDb();
  recorders.push(recorder);
  const headers = new Headers({ origin: ORIGIN });
  const token = options.token === undefined ? READ_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  if (options.tag !== undefined) headers.set("if-none-match", options.tag);
  const search = typeof query === "string" ? query : new URLSearchParams(query).toString();
  const response = await app.fetch(new Request(`http://test.local${pathOf(spec)}?${search}`, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: recorder.db,
    SNAPSHOTS: new Proxy({} as R2Bucket, { get() { r2(); throw new Error("R2 forbidden"); } })
  });
  return { response, recorder };
}

function posture(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
}
async function validator(bytes: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
}
async function countOnly(spec: Spec, query: Query, total: number) {
  const result = await request(spec, { ...query, countOnly: "true" });
  expect(result.response.status).toBe(200);
  const bytes = await result.response.clone().text();
  expect.soft(JSON.parse(bytes)).toEqual({ rows: [], total, nextCursor: null });
  expect.soft(result.recorder.statements).toHaveLength(1);
  expect.soft(result.recorder.statements.filter(isCount)).toHaveLength(1);
  expect.soft(result.recorder.statements.filter((s) => !isCount(s))).toEqual([]);
  for (const statement of result.recorder.statements.filter(isCount)) {
    // A SELECT that also transfers payload columns is not a count-only read.
    expect(statement.sql).toMatch(/^\s*SELECT\s+COUNT\s*\([^)]*\)\s*(?:AS\s+\w+)?\s+FROM\b/i);
    expect(statement.sql).not.toMatch(/\bLIMIT\b|\bOFFSET\b/i);
  }
  expect.soft(result.response.headers.get("link")).toBeNull();
  expect(result.response.headers.get("etag")).toBe(await validator(bytes));
  expect(result.response.headers.get("content-type")).toContain("application/json");
  posture(result.response);
  return { ...result, bytes, tag: result.response.headers.get("etag")! };
}
async function badRequest(spec: Spec, query: string, tag = "*") {
  const result = await request(spec, query, { tag });
  expect.soft(result.response.status).toBe(400);
  expect.soft(result.response.headers.get("content-type") ?? "").toContain("application/problem+json");
  expect.soft(result.recorder.prepared).toEqual([]);
  expect.soft(result.recorder.statements).toEqual([]);
  const text = await result.response.text();
  expect(text).not.toMatch(/private-marker|private-first|private-second/);
  if (result.response.status === 400) {
    const problem = JSON.parse(text);
    expect(problem).toMatchObject({ title: "Bad Request", status: 400 });
    expect(problem.type).toMatch(/[\/#]bad-request$/);
  }
  return text;
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  outbound = vi.fn(async () => { throw new Error("Count-only oracle forbids external fetch"); });
  r2 = vi.fn();
  vi.stubGlobal("fetch", outbound);
  recorders.length = 0;
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  // Every fixture is synthetic. Only customers 1 and 3 have addresses; only
  // addresses 1..4 have containers. Different parent ownership catches join loss.
  for (let id = 1; id <= 6; id++) {
    const needle = id === 2 || id === 5;
    const enabled = id === 3 || id === 5 ? 0 : 1;
    const label = needle ? `synthetic-needle-${id}` : `synthetic-other-${id}`;
    await db.prepare(
      "INSERT INTO customer_snapshot (customer_id, company_name, customer_number, sub_customer_number, phone1, phone2, comments, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fixed')"
    ).bind(id, label, needle ? "A" : "Other", needle ? "B" : "Other", id === 2 ? "(555) 000-0002" : "(555) 999-9999", id === 5 ? "(555) 000-0002" : null, needle ? "synthetic needle" : "synthetic other", enabled).run();
  }
  for (let id = 1; id <= 6; id++) {
    const needle = id === 2 || id === 5;
    const enabled = id === 3 || id === 5 ? 0 : 1;
    const label = needle ? `synthetic-needle-${id}` : `synthetic-other-${id}`;
    await db.prepare(
      "INSERT INTO address_snapshot (pickup_address_id, customer_id, address, route_id, franchise_id, city, state, zip, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'fixed')"
    ).bind(id, [1, 1, 3, 3, 3, 1][id - 1], label, needle ? 7 : 8, needle ? "F" : "G", needle ? "North" : "South", needle ? "ZZ" : "YY", needle ? "00123" : "99999", enabled).run();
  }
  for (let id = 1; id <= 6; id++) {
    const needle = id === 2 || id === 5;
    const enabled = id === 3 || id === 5 ? 0 : 1;
    const label = needle ? `synthetic-needle-${id}` : `synthetic-other-${id}`;
    await db.prepare(
      "INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, rfid, city, zip, enabled, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fixed')"
    ).bind(id, [1, 2, 3, 4, 1, 2][id - 1], label, id === 3 ? "serial-needle" : "serial-other", needle ? "tag" : "other-tag", needle ? "North" : "South", needle ? "00123" : "99999", enabled).run();
  }
});
afterEach(() => {
  try {
    expect(outbound).not.toHaveBeenCalled();
    expect(r2).not.toHaveBeenCalled();
    for (const recorder of recorders) expect(recorder.violations).toEqual([]);
  } finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe.each(SPECS)("$name count-only local cohort", (spec) => {
  const scenarios: Array<{ label: string; query: Query; total: number }> = [
    { label: "nonempty", query: {}, total: 6 },
    { label: "limit does not truncate total", query: { limit: "1" }, total: 6 },
    { label: "offset does not subtract", query: { limit: "2", offset: "99" }, total: 6 },
    { label: "ascending cursor is exclusive", query: { cursor: "2", order: "asc" }, total: 4 },
    { label: "descending cursor is exclusive", query: { cursor: "5", order: "desc" }, total: 4 },
    { label: "upperId inclusive", query: { upperId: "4" }, total: 4 },
    { label: "ascending bounded cursor", query: { cursor: "2", upperId: "4", offset: "99", limit: "1" }, total: 2 },
    { label: "descending bounded cursor", query: { cursor: "5", upperId: "3", order: "desc", offset: "99" }, total: 3 },
    { label: "upper bound below ascending cursor", query: { cursor: "5", upperId: "3" }, total: 0 },
    { label: "last cursor empty", query: { cursor: "6" }, total: 0 },
    { label: "first descending cursor empty", query: { cursor: "1", order: "desc" }, total: 0 },
    { label: "ID selection", query: { ids: "2,4,6" }, total: 3 },
    { label: "ID selection intersects seek and bound", query: { ids: "1,2,4,6", cursor: "1", upperId: "4" }, total: 2 },
    { label: "ID selection descending seek", query: { ids: "1,2,4,6", cursor: "4", order: "desc" }, total: 2 },
    { label: "sparse fields don't change count", query: { fields: spec.field, limit: "1" }, total: 6 },
    { label: "explicit includeTotal=true", query: { includeTotal: "true" }, total: 6 },
    { label: "enabled true", query: { enabled: "true" }, total: 4 },
    { label: "enabled false", query: { enabled: "false" }, total: 2 },
    { label: "enabled any", query: { enabled: "any" }, total: 6 },
    { label: "text OR legs", query: { q: "needle" }, total: spec.name === "container" ? 3 : 2 },
    { label: "empty filter", query: { q: "no-synthetic-match" }, total: 0 },
    { label: "filter/seek/IDs/fields intersection", query: { q: "needle", enabled: "false", cursor: "2", upperId: "5", ids: "1,2,4,5", fields: spec.field }, total: 1 },
    ...spec.filters.map((s) => ({ label: JSON.stringify(s.query), ...s }))
  ];
  it.each(scenarios)("one COUNT, no page/Link: $label", async ({ query, total }) => {
    const baseline = await request(spec, { ...query, includeTotal: "true" });
    expect(baseline.response.status).toBe(200);
    const before = await baseline.response.json() as Envelope;
    // Literal total catches a shared bug in both modes; equality also protects
    // every existing selector when the Builder reuses the ordinary predicates.
    expect(before.total).toBe(total);
    expect(baseline.recorder.statements.filter(isCount)).toHaveLength(1);
    const counted = await countOnly(spec, query, total);
    expect(counted.recorder.statements.filter(isCount)).toEqual(baseline.recorder.statements.filter(isCount));
  });

  it("counts an actually empty table as zero, not null", async () => {
    await TEST_ENV.CUSTOMER_DB.batch([
      TEST_ENV.CUSTOMER_DB.prepare("DELETE FROM container_snapshot"),
      TEST_ENV.CUSTOMER_DB.prepare("DELETE FROM address_snapshot"),
      TEST_ENV.CUSTOMER_DB.prepare("DELETE FROM customer_snapshot")
    ]);
    await countOnly(spec, {}, 0);
  });

  it.each(["test-read-token", "test-api-token", "test-sync-secret"])("retains existing token %s", async (token) => {
    const { response, recorder } = await request(spec, { countOnly: "true" }, { token });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rows: [], total: 6, nextCursor: null });
    expect(recorder.statements).toHaveLength(1);
    expect(recorder.statements.filter(isCount)).toHaveLength(1);
    expect(response.headers.get("link")).toBeNull();
    posture(response);
  });

  it.each([undefined, "true", "false"])("explicit false preserves bytes, ETag, SQL and pagination (includeTotal=%s)", async (includeTotal) => {
    const query: Query = { limit: "2", fields: spec.field };
    if (includeTotal !== undefined) query.includeTotal = includeTotal;
    const absent = await request(spec, query);
    const explicit = await request(spec, { ...query, countOnly: "false" });
    expect(absent.response.status).toBe(200);
    expect(explicit.response.status).toBe(200);
    const bytes = await absent.response.text();
    expect(await explicit.response.text()).toBe(bytes);
    const body = JSON.parse(bytes) as Envelope;
    expect(body.rows.map((r) => r[spec.id])).toEqual([1, 2]);
    expect(body.total).toBe(includeTotal === "false" ? null : 6);
    expect(body.nextCursor).toBe(2);
    expect(explicit.response.headers.get("etag")).toBe(absent.response.headers.get("etag"));
    // The explicit default may be preserved in the link, but the next request
    // must still serve the same second page, with no lost fields/mode filters.
    for (const response of [absent.response, explicit.response]) {
      const link = response.headers.get("link");
      expect(link).toMatch(/^<[^>]+>; rel="next"$/);
      const url = new URL(/^<([^>]+)>/.exec(link!)![1], ORIGIN);
      const next = await request(spec, url.search.slice(1));
      expect(next.response.status).toBe(200);
      expect((await next.response.json() as Envelope).rows.map((r) => r[spec.id])).toEqual([3, 4]);
    }
    expect(explicit.recorder.statements).toEqual(absent.recorder.statements);
    expect(explicit.recorder.statements).toHaveLength(includeTotal === "false" ? 1 : 2);
    expect(explicit.recorder.statements.filter(isCount)).toHaveLength(includeTotal === "false" ? 0 : 1);
  });
});

describe.each(SPECS)("$name count-only validates before D1 and conditional success", (spec) => {
  it.each([
    "countOnly", "countOnly=", "countOnly=TRUE", "countOnly=False", "countOnly=0", "countOnly=1",
    "countOnly=yes", "countOnly=true%20", "countOnly=%20true", "countOnly=true,false",
    "countOnly=private-marker", "countOnly=true&countOnly=true", "countOnly=true&countOnly=false",
    "countOnly=private-first&countOnly=private-second"
  ])("invalid exact boolean: %s", async (query) => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((key) => vi.spyOn(console, key));
    await badRequest(spec, query);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it("rejects the conflicting count-free mode with a fixed next action and no value leak", async () => {
    const logs = (["log", "info", "warn", "error", "debug"] as const).map((key) => vi.spyOn(console, key));
    const text = await badRequest(spec, "countOnly=true&includeTotal=false&unknown=private-marker");
    expect(text).toMatch(/(?:omit|remove).*includeTotal=false|includeTotal=false.*(?:omit|remove)/i);
    expect(text).toMatch(/countOnly=false/);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  const invalidKnown = [
    "limit=0", "limit=bad", "offset=-1", "cursor=bad", "upperId=bad", "order=sideways",
    "customerId=bad", "enabled=bogus", "includeTotal=bogus", "fields=private-marker",
    "fields=", "ids=bad", "ids=", "ids=1&ids=2", "fields=enabled&fields=enabled",
    "q=first&q=second", "includeTotal=true&includeTotal=true", ...spec.invalid
  ];
  it.each(invalidKnown)("control: known invalid parameter already rejects without count-only: %s", async (invalid) => {
    await badRequest(spec, `countOnly=false&${invalid}`);
  });
  it.each(invalidKnown)("still validates another known parameter: %s", async (invalid) => {
    await badRequest(spec, `countOnly=true&${invalid}`);
  });

  it.each([null, "wrong-synthetic-token"])("auth precedes mode/parameter validation (%s)", async (token) => {
    for (const query of ["countOnly=true", "countOnly=private-marker", "countOnly=true&includeTotal=false", "countOnly=true&fields=private-marker"]) {
      const { response, recorder } = await request(spec, query, { token, tag: "*" });
      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/problem+json");
      expect(await response.text()).not.toContain("private-marker");
      expect(recorder.prepared).toEqual([]);
      expect(recorder.statements).toEqual([]);
    }
  });
});

describe.each(SPECS)("$name count-only query-time representation validators", (spec) => {
  it("304 is empty, carries no Link, and still executes exactly one fresh COUNT", async () => {
    const first = await countOnly(spec, { limit: "1" }, 6);
    for (const tag of [first.tag, `W/${first.tag}`, "*"]) {
      const { response, recorder } = await request(spec, { countOnly: "true", limit: "1" }, { tag });
      expect(response.status).toBe(304);
      expect(response.body).toBeNull();
      expect((await response.arrayBuffer()).byteLength).toBe(0);
      expect(response.headers.get("etag")).toBe(first.tag);
      expect(response.headers.get("link")).toBeNull();
      posture(response);
      expect(recorder.statements).toEqual(first.recorder.statements);
    }
  });

  it("business/metadata mutations leave count bytes unchanged, cohort changes invalidate immediately", async () => {
    const first = await countOnly(spec, { enabled: "true" }, 4);
    await TEST_ENV.CUSTOMER_DB.prepare(`UPDATE ${spec.name}_snapshot SET ${spec.field} = 'synthetic-changed', synced_at = 'changed' WHERE ${spec.id} = 1`).run();
    const same = await request(spec, { countOnly: "true", enabled: "true" }, { tag: first.tag });
    expect(same.response.status).toBe(304);
    expect(same.response.headers.get("etag")).toBe(first.tag);
    expect(same.response.headers.get("link")).toBeNull();
    expect(same.recorder.statements).toHaveLength(1);
    expect(same.recorder.statements.filter(isCount)).toHaveLength(1);
    await TEST_ENV.CUSTOMER_DB.prepare(`UPDATE ${spec.name}_snapshot SET enabled = 0 WHERE ${spec.id} = 1`).run();
    const changed = await countOnly(spec, { enabled: "true" }, 3);
    expect(changed.tag).not.toBe(first.tag);
    const stale = await request(spec, { countOnly: "true", enabled: "true" }, { tag: first.tag });
    expect(stale.response.status).toBe(200);
    expect(await stale.response.text()).toBe(changed.bytes);
    expect(stale.response.headers.get("etag")).toBe(changed.tag);
    expect(stale.recorder.statements).toHaveLength(1);
    expect(stale.recorder.statements.filter(isCount)).toHaveLength(1);
  });

  it("equal served count envelopes share an ETag across selection and paging queries", async () => {
    const first = await countOnly(spec, { q: "needle", limit: "1", fields: spec.field }, spec.name === "container" ? 3 : 2);
    const same = await request(spec, { countOnly: "true", q: "needle", fields: "enabled", order: "desc", offset: "99", limit: "3" }, { tag: first.tag });
    expect(same.response.status).toBe(304);
    expect(same.response.headers.get("etag")).toBe(first.tag);
    expect(same.response.headers.get("link")).toBeNull();
    expect(same.recorder.statements).toHaveLength(1);
    expect(same.recorder.statements.filter(isCount)).toHaveLength(1);
  });
});

// Mounted schema checks exercise what an agent actually discovers. No future
// exactNext/strictQuery/parent-scope API is assumed by this baseline oracle.
type Operation = {
  description?: string;
  parameters?: Array<{ name: string; in: string; required: boolean; description?: string; schema?: { description?: string } }>;
  responses?: Record<string, {
    description?: string;
    content?: Record<string, { example?: Envelope; examples?: Record<string, { value?: Envelope }> }>;
  }>;
};
async function mountedDocument() {
  const response = await app.fetch(new Request("http://test.local/openapi.json"), TEST_ENV);
  expect(response.status).toBe(200);
  return await response.json() as { paths: Record<string, Record<string, Operation>> };
}
describe("mounted count-only discovery", () => {
  it("adds an optional exact true|false enum, default false, to only the three ordinary flat GETs", async () => {
    const doc = await mountedDocument();
    const published: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        const param = operation.parameters?.find((p) => p.name === "countOnly" && p.in === "query");
        if (!param) continue;
        published.push(`${method} ${path}`);
        expect(param).toMatchObject({ required: false, schema: { type: "string", enum: ["true", "false"], default: "false" } });
      }
    }
    expect(published.sort()).toEqual(SPECS.map((s) => `get ${pathOf(s)}`).sort());
  });

  it.each(SPECS)("$name describes cursor-relative query-time counts and conflict recovery", async (spec) => {
    const operation = (await mountedDocument()).paths[pathOf(spec)].get;
    const parameter = operation.parameters?.find((p) => p.name === "countOnly");
    const guidance = [parameter?.description, parameter?.schema?.description, operation.description].join(" ");
    expect(guidance).toMatch(/cursor[- ]relative/i);
    expect(guidance).toMatch(/query[- ]time|at (?:the )?time of (?:the )?(?:query|request)/i);
    expect(guidance).toMatch(/offset/i);
    expect(guidance).toMatch(/limit/i);
    expect(guidance).toMatch(/includeTotal=false/);
    expect(guidance).toMatch(/no (?:page|row)|zero (?:page|row)|without.*(?:page|row)/i);
    const correction = [guidance, operation.responses?.["400"]?.description].join(" ");
    expect(correction).toMatch(/countOnly=false/);
    expect(correction).toMatch(/(?:omit|remove).*includeTotal=false|includeTotal=false.*(?:omit|remove)/i);
  });

  it.each(SPECS)("$name publishes a count-only example without losing the normal full-row example", async (spec) => {
    const media = (await mountedDocument()).paths[pathOf(spec)].get.responses?.["200"]?.content?.["application/json"];
    const examples = media?.examples ? Object.values(media.examples).map((entry) => entry.value) : [media?.example];
    const count = examples.find((value) => value && Array.isArray(value.rows) && value.rows.length === 0 && Number.isInteger(value.total) && value.nextCursor === null);
    expect(count).toBeDefined();
    expect(Object.keys(count ?? {}).sort()).toEqual(["nextCursor", "rows", "total"]);
    expect(count?.total).toBeGreaterThanOrEqual(0);
    expect(examples.some((value) => value && value.rows.length > 0 && typeof value.total === "number")).toBe(true);
  });
});
