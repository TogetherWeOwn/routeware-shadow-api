import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned oracle: ordinary snapshot JSON lists only.
 *
 * A validator is the quoted SHA-256 of the EXACT served UTF-8 envelope, after
 * projection and pagination. Conditional success saves bytes, never D1 work.
 * Mutation targets: hash raw rows/metadata/request instead of served bytes;
 * skip auth/validation/D1 on a match; match a substring; cache a stale list;
 * serialize a body for 304; lose no-store/CORS/security/correlation headers.
 *
 * Synthetic fixtures, real local test D1, real app.fetch; outbound fetch fails
 * even if a handler catches it. No source helpers compute the expected hash.
 * New-capability assertions are intentionally RED before the paired build.
 */
const TEST_ENV = env as unknown as Env;
const READ_TOKEN = "test-read-token";
const API_TOKEN = "test-api-token";
const SYNC_SECRET = "test-sync-secret";
const ORIGIN = "https://conditional-client.invalid";
const IDS = [101, 102, 103, 104];
// Includes multibyte text and JSON escapes: hash bytes, not string length or rows.
const LABEL = 'synthetic-needle-101-雪-"\\\n';
const LABELS = [LABEL, "synthetic-other-102", "synthetic-needle-103", "synthetic-other-104"];

type Spec = {
  name: "customer" | "address" | "container";
  id: string;
  field: string;
  qIds: number[];
  customerIds: number[];
};
const SPECS: Spec[] = [
  { name: "customer", id: "customer_id", field: "company_name", qIds: [101, 103], customerIds: [101] },
  { name: "address", id: "pickup_address_id", field: "address", qIds: [101, 103], customerIds: [101, 102] },
  { name: "container", id: "container_id", field: "location_address", qIds: [101, 102, 103], customerIds: [101, 102] }
];
const pathOf = (spec: Spec) => `/api/v1/${spec.name}-snapshot`;
type Envelope = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };
type Statement = { sql: string; binds: unknown[]; method: string };
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);

/** Record executions, not merely prepare calls; retain the real SQL semantics. */
function recordedDb(fail?: "count" | "page") {
  const statements: Statement[] = [];
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[] = []): D1PreparedStatement {
    return new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql, args);
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          statements.push({ sql, binds, method: String(prop) });
          if ((fail === "count" && isCount({ sql, binds, method: String(prop) })) ||
              (fail === "page" && !/\bCOUNT\s*\(/i.test(sql))) {
            throw new Error("Synthetic conditional-list D1 failure");
          }
          return Reflect.apply(value, target, args);
        };
      }
    });
  }
  const db = {
    prepare: (sql: string) => wrap(TEST_ENV.CUSTOMER_DB.prepare(sql), sql)
  } as unknown as D1Database;
  return { db, statements };
}

let requestNumber = 0;
async function get(
  path: string,
  options: { token?: string | null; db?: D1Database; headers?: Record<string, string> } = {}
): Promise<Response> {
  requestNumber++;
  const headers = new Headers({
    origin: ORIGIN,
    "x-request-id": `Conditional-${requestNumber}`,
    ...options.headers
  });
  const token = options.token === undefined ? READ_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return app.fetch(new Request(`http://test.local${path}`, { headers }), {
    ...TEST_ENV,
    CUSTOMER_DB: options.db ?? TEST_ENV.CUSTOMER_DB
  });
}

async function validator(bytes: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

function posture(res: Response, requestId?: string): void {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(res.headers.get("vary")).toMatch(/\borigin\b/i);
  expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("x-request-id")).toBe(requestId ?? `Conditional-${requestNumber}`);
  const exposed = (res.headers.get("access-control-expose-headers") ?? "")
    .split(",").map((h) => h.trim().toLowerCase());
  expect(exposed).toEqual(expect.arrayContaining([
    "etag", "retry-after", "content-disposition", "x-ratelimit-limit",
    "x-ratelimit-remaining", "x-ratelimit-reset", "ratelimit",
    "ratelimit-policy", "x-request-id"
  ]));
}

async function expect304(res: Response, tag: string): Promise<void> {
  // Soft assertions still fail the test, but exercise subsequent body/D1/mutation
  // checks during the pre-build RED run rather than stopping at the first gap.
  expect.soft(res.status).toBe(304);
  expect.soft(res.body).toBeNull();
  expect.soft((await res.arrayBuffer()).byteLength).toBe(0);
  expect.soft(res.headers.get("etag")).toBe(tag);
  posture(res);
}

async function expect200(res: Response): Promise<{ bytes: string; body: Envelope; tag: string }> {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  posture(res);
  const bytes = await res.text();
  const tag = await validator(bytes);
  expect.soft(res.headers.get("etag")).toBe(tag);
  const body = JSON.parse(bytes) as Envelope;
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  return { bytes, body, tag };
}

function selectedRows(spec: Spec, ids: number[]) {
  return ids.map((id) => ({ [spec.id]: id, [spec.field]: LABELS[IDS.indexOf(id)] }));
}

const originalFetch = globalThis.fetch;
let outbound: ReturnType<typeof vi.fn>;
beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  outbound = vi.fn(async () => { throw new Error("Unexpected outbound fetch in conditional-list oracle"); });
  globalThis.fetch = outbound as typeof fetch;
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  for (let i = 0; i < IDS.length; i++) {
    const id = IDS[i];
    const owner = [101, 101, 102, 103][i];
    const enabled = i === 1 ? 0 : 1;
    await db.batch([
      db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, comments, enabled, synced_at) VALUES (?, ?, 'hidden', ?, 'synthetic-fixed-time')")
        .bind(id, LABELS[i], enabled),
      db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, comments, enabled, synced_at) VALUES (?, ?, ?, 'hidden', ?, 'synthetic-fixed-time')")
        .bind(id, owner, LABELS[i], enabled),
      db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, serial_number, container_note, enabled, synced_at) VALUES (?, ?, ?, ?, 'hidden', ?, 'synthetic-fixed-time')")
        .bind(id, id, LABELS[i], i === 1 ? "serial-needle" : "serial-other", enabled)
    ]);
  }
});
afterEach(() => {
  try { expect(outbound).not.toHaveBeenCalled(); }
  finally { globalThis.fetch = originalFetch; vi.restoreAllMocks(); }
});

describe.each(SPECS)("$name ordinary JSON list: representation validators", (spec) => {
  const selected = `fields=${spec.field}`;
  const scenarios = [
    { label: "counted default", query: "", ids: IDS, total: 4, next: null },
    { label: "count-free", query: "includeTotal=false", ids: IDS, total: null, next: null },
    { label: "first offset page", query: "limit=2", ids: [101, 102], total: 4, next: 102 },
    { label: "middle offset page", query: "limit=2&offset=1", ids: [102, 103], total: 4, next: 103 },
    { label: "seek with cursor-relative total", query: "limit=2&cursor=102", ids: [103, 104], total: 2, next: 104 },
    { label: "seek wins over offset", query: "limit=2&cursor=102&offset=3&includeTotal=false", ids: [103, 104], total: null, next: 104 },
    { label: "empty offset page", query: "offset=4", ids: [], total: 4, next: null },
    { label: "empty seek page", query: "cursor=104&includeTotal=false", ids: [], total: null, next: null },
    { label: "empty filtered result", query: "q=no-synthetic-match", ids: [], total: 0, next: null },
    { label: "enabled filter", query: "enabled=false", ids: [102], total: 1, next: null },
    { label: "text filter including container serial OR leg", query: "q=needle", ids: spec.qIds, total: spec.qIds.length, next: null },
    { label: "customer filter including address join", query: "customerId=101", ids: spec.customerIds, total: spec.customerIds.length, next: null },
    { label: "filters plus seek plus count-free", query: "enabled=true&q=needle&cursor=101&limit=1&includeTotal=false", ids: [103], total: null, next: 103 },
    ...(spec.name === "customer" ? [] : [
      { label: "pickup address filter", query: "pickupAddressId=102", ids: [102], total: 1, next: null }
    ]),
    ...(spec.name !== "container" ? [] : [
      { label: "container filter", query: "containerId=103", ids: [103], total: 1, next: null },
      { label: "combined parent filters", query: "customerId=101&pickupAddressId=102&containerId=102", ids: [102], total: 1, next: null }
    ])
  ];

  it.each(scenarios)("200 -> empty 304 preserves bytes and D1 work: $label", async (s) => {
    const path = `${pathOf(spec)}?${selected}&${s.query}`;
    const plain = recordedDb();
    const first = await expect200(await get(path, { db: plain.db }));
    expect(first.body).toEqual({ rows: selectedRows(spec, s.ids), total: s.total, nextCursor: s.next });
    expect(plain.statements).toHaveLength(s.total === null ? 1 : 2);
    expect(plain.statements.filter(isCount)).toHaveLength(s.total === null ? 0 : 1);
    const conditional = recordedDb();
    const res = await get(path, { db: conditional.db, headers: { "if-none-match": first.tag } });
    await expect304(res, first.tag);
    expect(conditional.statements).toEqual(plain.statements);
  });

  it("hashes the full default envelope too, not only projected requests", async () => {
    const first = await expect200(await get(pathOf(spec)));
    expect(first.body.rows).toHaveLength(4);
    expect(Object.keys(first.body.rows[0])).toContain("synced_at");
    await expect304(await get(pathOf(spec), { headers: { "if-none-match": first.tag } }), first.tag);
  });

  it.each([READ_TOKEN, API_TOKEN, SYNC_SECRET])("accepts existing authorized role %s without widening scope", async (token) => {
    const path = `${pathOf(spec)}?${selected}`;
    const first = await expect200(await get(path, { token }));
    await expect304(await get(path, { token, headers: { "if-none-match": first.tag } }), first.tag);
  });

  it("200 -> 304 -> selected-value change returns fresh 200 even when synced_at is unchanged", async () => {
    const path = `${pathOf(spec)}?${selected}`;
    const first = await expect200(await get(path));
    await expect304(await get(path, { headers: { "if-none-match": first.tag } }), first.tag);
    await TEST_ENV.CUSTOMER_DB.prepare(`UPDATE ${spec.name}_snapshot SET ${spec.field} = ? WHERE ${spec.id} = 101`)
      .bind("synthetic-changed-value").run();
    const changed = await expect200(await get(path, { headers: { "if-none-match": first.tag } }));
    expect(changed.tag).not.toBe(first.tag);
    expect(changed.body.rows[0]).toEqual({ [spec.id]: 101, [spec.field]: "synthetic-changed-value" });
    expect(changed.body.total).toBe(first.body.total);
    expect(changed.body.nextCursor).toBe(first.body.nextCursor);
  });

  it("selected-out business values and metadata do not invalidate unchanged served bytes", async () => {
    const path = `${pathOf(spec)}?${selected}`;
    const first = await expect200(await get(path));
    const hidden = spec.name === "container" ? "container_note" : "comments";
    await TEST_ENV.CUSTOMER_DB.prepare(`UPDATE ${spec.name}_snapshot SET ${hidden} = 'changed-hidden', synced_at = 'changed-time' WHERE ${spec.id} = 101`).run();
    const plain = await expect200(await get(path));
    expect(plain.bytes).toBe(first.bytes);
    expect(plain.tag).toBe(first.tag);
    await expect304(await get(path, { headers: { "if-none-match": first.tag } }), first.tag);
  });

  it("changing total alone invalidates counted pages, not the identical count-free page", async () => {
    const path = `${pathOf(spec)}?${selected}&limit=1&enabled=true`;
    const counted = await expect200(await get(path));
    const free = await expect200(await get(`${path}&includeTotal=false`));
    expect(counted.body.total).toBe(3);
    await TEST_ENV.CUSTOMER_DB.prepare(`UPDATE ${spec.name}_snapshot SET enabled = 0 WHERE ${spec.id} = 104`).run();
    const changed = await expect200(await get(path, { headers: { "if-none-match": counted.tag } }));
    expect(changed.body).toEqual({ ...counted.body, total: 2 });
    expect(changed.tag).not.toBe(counted.tag);
    await expect304(await get(`${path}&includeTotal=false`, { headers: { "if-none-match": free.tag } }), free.tag);
  });

  it("changing nextCursor alone invalidates otherwise identical rows and total", async () => {
    // Both requests serve every matching row; only the full-page sentinel differs.
    const path = `${pathOf(spec)}?${selected}&customerId=101`;
    const limit = spec.name === "customer" ? 1 : 2;
    const first = await expect200(await get(`${path}&limit=${limit}`));
    expect(first.body.nextCursor).toBe(spec.name === "customer" ? 101 : 102);
    const changed = await expect200(await get(`${path}&limit=${limit + 1}`, { headers: { "if-none-match": first.tag } }));
    expect(changed.body).toEqual({ ...first.body, nextCursor: null });
    expect(changed.tag).not.toBe(first.tag);
  });

  it("identical served bytes share validators across requests, tokens, origins and request IDs", async () => {
    const path = `${pathOf(spec)}?${selected}`;
    const first = await expect200(await get(path));
    const res = await get(`${path}&includeTotal=true&offset=0&limit=50`, {
      token: API_TOKEN,
      headers: { "if-none-match": first.tag, origin: "https://other-client.invalid", "x-request-id": "Different-ID" }
    });
    expect(res.status).toBe(304);
    expect(res.body).toBeNull();
    expect(await res.text()).toBe("");
    expect(res.headers.get("etag")).toBe(first.tag);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://other-client.invalid");
    expect(res.headers.get("x-request-id")).toBe("Different-ID");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("changed fieldset cannot reuse the full representation validator", async () => {
    const full = await expect200(await get(pathOf(spec)));
    const small = await expect200(await get(`${pathOf(spec)}?${selected}`, { headers: { "if-none-match": full.tag } }));
    expect(small.tag).not.toBe(full.tag);
    expect(small.body.rows).toEqual(selectedRows(spec, IDS));
  });

  it("preserves the existing next-page Link on 304 if the route already emits it", async () => {
    const path = `${pathOf(spec)}?${selected}&limit=1`;
    const first = await get(path);
    const bytes = await first.text();
    const tag = await validator(bytes);
    const res = await get(path, { headers: { "if-none-match": tag } });
    await expect304(res, tag);
    // Do not require pagination work that is not merged into this base.
    expect(res.headers.get("link")).toBe(first.headers.get("link"));
  });
});

type MatchCase = { label: string; header: (tag: string) => string; status: 200 | 304 };
const MATCH_CASES: MatchCase[] = [
  { label: "exact strong", header: (t) => t, status: 304 },
  { label: "weak", header: (t) => `W/${t}`, status: 304 },
  { label: "strong in list with whitespace", header: (t) => `"other",\t${t} , "last"`, status: 304 },
  { label: "weak in list", header: (t) => `"other", W/${t}`, status: 304 },
  { label: "wildcard", header: () => "*", status: 304 },
  { label: "unrelated token", header: () => '"unrelated"', status: 200 },
  { label: "empty", header: () => "", status: 200 },
  { label: "opaque hash prefix is not a token match", header: (t) => `"${t.slice(1, -2)}"`, status: 200 },
  { label: "opaque hash suffix is not a token match", header: (t) => `"${t.slice(2, -1)}"`, status: 200 },
  { label: "superstring is not a token match", header: (t) => `"prefix-${t.slice(1, -1)}-suffix"`, status: 200 },
  { label: "malformed unquoted hash", header: (t) => t.slice(1, -1), status: 200 },
  { label: "malformed unquoted weak hash", header: (t) => `W/${t.slice(1, -1)}`, status: 200 },
  { label: "malformed missing closing quote", header: (t) => t.slice(0, -1), status: 200 },
  { label: "malformed weak missing closing quote", header: (t) => `W/${t.slice(0, -1)}`, status: 200 },
  { label: "malformed lowercase weak prefix", header: (t) => `w/${t}`, status: 200 },
  { label: "malformed double weak prefix", header: (t) => `W/W/${t}`, status: 200 },
  { label: "quoted wildcard is an ordinary nonmatching tag", header: () => '"*"', status: 200 },
  { label: "arbitrary text wrapping a matching token", header: (t) => `junk${t}junk`, status: 200 },
  { label: "comma inside quoted opaque token cannot hide a match", header: (t) => `"prefix,${t.slice(1, -1)},suffix"`, status: 200 }
];

describe.each(SPECS)("$name If-None-Match exact token semantics", (spec) => {
  it.each(MATCH_CASES)("$label -> $status", async ({ header, status }) => {
    const path = `${pathOf(spec)}?fields=${spec.field}&limit=2`;
    const baseline = recordedDb();
    const first = await get(path, { db: baseline.db });
    expect(first.status).toBe(200);
    const bytes = await first.text();
    const tag = await validator(bytes);
    const conditional = recordedDb();
    const res = await get(path, { db: conditional.db, headers: { "if-none-match": header(tag) } });
    expect(res.status).toBe(status);
    if (status === 304) await expect304(res, tag);
    else {
      expect(await res.text()).toBe(bytes);
      expect(res.headers.get("etag")).toBe(tag);
      posture(res);
    }
    expect(conditional.statements).toEqual(baseline.statements);
  });
});

describe.each(SPECS)("$name conditional success cannot outrun errors", (spec) => {
  it("a known exact tag cannot skip authentication or query validation", async () => {
    const first = await get(pathOf(spec));
    expect(first.status).toBe(200);
    const tag = await validator(await first.text());
    for (const token of [null, "incorrect-synthetic-token", READ_TOKEN]) {
      const { db, statements } = recordedDb();
      const suffix = token === READ_TOKEN ? "?limit=0" : "";
      const res = await get(`${pathOf(spec)}${suffix}`, {
        token, db, headers: { "if-none-match": tag, "cf-connecting-ip": `203.0.113.${180 + requestNumber % 20}` }
      });
      expect(res.status).toBe(token === READ_TOKEN ? 400 : 401);
      expect(res.headers.get("etag")).toBeNull();
      posture(res);
      expect(statements).toEqual([]);
    }
  });

  it.each([null, "incorrect-synthetic-token"])("401 before validation or D1 for token %s even with wildcard", async (token) => {
    const { db, statements } = recordedDb();
    const res = await get(`${pathOf(spec)}?limit=0&fields=unknown-marker`, {
      token, db, headers: { "if-none-match": "*", "cf-connecting-ip": `203.0.113.${180 + requestNumber % 20}` }
    });
    expect(res.status).toBe(401);
    posture(res);
    expect(res.headers.get("etag")).toBeNull();
    expect((await res.json()) as object).toMatchObject({ status: 401 });
    expect(statements).toEqual([]);
  });

  it.each([
    "limit=0", "limit=501", "cursor=not-a-number", "offset=-1", "includeTotal=FALSE",
    "fields=unknown-marker", "fields=comments&fields=comments", "enabled=maybe"
  ])("400 before D1 for %s even with wildcard", async (query) => {
    const { db, statements } = recordedDb();
    const res = await get(`${pathOf(spec)}?${query}`, { db, headers: { "if-none-match": "*" } });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.headers.get("etag")).toBeNull();
    posture(res);
    const body = (await res.json()) as { status: number; detail: string; requestId: string };
    expect(body.status).toBe(400);
    expect(body.detail).not.toContain("unknown-marker");
    expect(statements).toEqual([]);
  });

  it.each(["count", "page"] as const)("D1 %s failure is 500, never wildcard 304", async (fail) => {
    const { db, statements } = recordedDb(fail);
    const res = await get(pathOf(spec), { db, headers: { "if-none-match": "*" } });
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.headers.get("etag")).toBeNull();
    posture(res);
    expect(await res.json()).toMatchObject({ status: 500, requestId: `Conditional-${requestNumber}` });
    expect(statements).toHaveLength(fail === "count" ? 1 : 2);
  });

  it("a previously valid exact tag cannot conceal a later D1 page failure", async () => {
    const path = `${pathOf(spec)}?fields=${spec.field}&includeTotal=false`;
    const first = await get(path);
    expect(first.status).toBe(200);
    const tag = await validator(await first.text());
    const { db, statements } = recordedDb("page");
    const res = await get(path, { db, headers: { "if-none-match": tag } });
    expect(res.status).toBe(500);
    expect(res.headers.get("etag")).toBeNull();
    posture(res);
    expect(await res.json()).toMatchObject({ status: 500 });
    expect(statements).toHaveLength(1);
  });

  it("does not broaden read-token access to CSV or hydrated reads", async () => {
    for (const path of [`${pathOf(spec)}/export`, `/api/v1/data/${spec.name}?id=101`]) {
      const { db, statements } = recordedDb();
      const res = await get(path, { db, headers: { "if-none-match": "*" } });
      expect(res.status).toBe(401);
      expect(res.headers.get("etag")).toBeNull();
      expect(statements).toEqual([]);
    }
  });

  it("does not introduce conditional responses on flat details", async () => {
    const res = await get(`${pathOf(spec)}/101`, { headers: { "if-none-match": "*" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeNull();
    expect((await res.json()) as object).toMatchObject({ [spec.id]: 101 });
  });
});

type ResponseDoc = {
  description?: string;
  headers?: Record<string, { schema?: { type?: string }; description?: string }>;
  content?: Record<string, unknown>;
};
type Operation = {
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: { type?: string } }>;
  responses?: Record<string, ResponseDoc>;
};
type OpenApi = { paths: Record<string, { get?: Operation }> };

describe("discoverable conditional list contract", () => {
  it("does not add conditional semantics to the changes feed", async () => {
    const res = await get("/api/v1/customer-snapshot/changes?limit=2", { headers: { "if-none-match": "*" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("content-type")).toContain("application/json");
    posture(res);
  });

  it.each(SPECS)("$name publishes optional request validator and bodyless 304 with ETag", async (spec) => {
    const res = await get("/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as OpenApi;
    const op = doc.paths[pathOf(spec)]?.get;
    const conditional = op?.parameters?.find((p) => p.in === "header" && p.name.toLowerCase() === "if-none-match");
    expect(conditional).toMatchObject({ in: "header", required: false, schema: { type: "string" } });
    for (const status of ["200", "304"]) {
      const response = op?.responses?.[status];
      expect(response, status).toBeDefined();
      const etag = Object.entries(response?.headers ?? {}).find(([key]) => key.toLowerCase() === "etag")?.[1];
      expect(etag?.schema?.type, `${status} ETag schema`).toBe("string");
    }
    expect(Object.keys(op?.responses?.["304"]?.content ?? {})).toEqual([]);
    expect(op?.responses?.["200"]?.content).toHaveProperty("application/json");
    expect(op?.responses?.["400"]).toBeDefined();
  });

  it("preflight grants If-None-Match and keeps the other existing browser headers", async () => {
    const res = await app.fetch(new Request("http://test.local/api/v1/customer-snapshot", {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization, if-none-match, x-request-id"
      }
    }), TEST_ENV);
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").toLowerCase().split(",").map((h) => h.trim());
    expect(allowed).toEqual(expect.arrayContaining(["authorization", "if-none-match", "x-request-id"]));
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });
});
