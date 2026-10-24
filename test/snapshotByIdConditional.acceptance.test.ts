import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Test-Author-owned oracle: conditional JSON on the three existing FLAT by-ID
 * reads. Synthetic rows + real local D1 + mounted app.fetch, never a provider.
 *
 * Mutation targets: hashing before projection or hashing metadata/request rather
 * than served UTF-8 bytes; substring/split-on-comma matching; returning a 304 body;
 * skipping auth, validation or lookup; caching away D1; dropping no-store/CORS or
 * correlation headers; accidentally adopting hydrated strict-query semantics.
 * Bandwidth only: a 304 must perform the same single read as its ordinary 200.
 * Expected hashes use Web Crypto independently, never a production helper.
 */
const TEST_ENV = env as unknown as Env;
const READ_TOKEN = "test-read-token";
const API_TOKEN = "test-api-token";
const SYNC_SECRET = "test-sync-secret";
const ORIGIN = "https://flat-conditional-client.invalid";
const LABEL = 'synthetic-flat-雪-"\\\n';
const ID = 9411;

type Spec = {
  name: "customer" | "address" | "container";
  id: string;
  field: string;
  hidden: string;
  param: string;
  operationId: string;
  columns: string[];
};
const SPECS: Spec[] = [
  {
    name: "customer", id: "customer_id", field: "company_name", hidden: "comments",
    param: "customerId", operationId: "getCustomerSnapshot",
    columns: ["customer_id", "customer_type_id", "company_name", "first_name", "middle_initial",
      "last_name", "name_suffix", "customer_number", "sub_customer_number", "phone1", "phone2",
      "comments", "enabled", "synced_at"]
  },
  {
    name: "address", id: "pickup_address_id", field: "address", hidden: "comments",
    param: "pickupAddressId", operationId: "getAddressSnapshot",
    columns: ["pickup_address_id", "customer_id", "route_id", "address", "city", "state", "zip",
      "franchise_id", "comments", "extras_allowed", "enabled", "driver_note", "latitude",
      "longitude", "last_audit_date", "synced_at"]
  },
  {
    name: "container", id: "container_id", field: "location_address", hidden: "container_note",
    param: "containerId", operationId: "getContainerSnapshot",
    columns: ["container_id", "pickup_address_id", "container_type_id", "serial_number", "rfid",
      "oncall", "event_code", "gps_locked", "latitude", "longitude", "enabled", "location_address",
      "city", "state", "zip", "container_note", "ud_cost_share_ud", "ud_enclosure_doors_ud",
      "ud_last_compactor_inspection_ud", "ud_last_enclosure_inspection_ud", "ud_material_stream_ud",
      "color", "service_code_type", "service_code_input", "service_code", "service_date", "route_ids",
      "frequency_ids", "synced_at"]
  }
];
const pathOf = (spec: Spec, id: string | number = ID) => `/api/v1/${spec.name}-snapshot/${id}`;
const sparsePath = (spec: Spec) => `${pathOf(spec)}?fields=${spec.field}`;
const selectedRow = (spec: Spec, value: string | null = LABEL) => ({ [spec.id]: ID, [spec.field]: value });
type Statement = { sql: string; binds: unknown[]; method: string };

/** Observe executions without replacing SQL or row/projection semantics. */
function recordedDb(rejectRead = false) {
  const statements: Statement[] = [];
  const forbidden: string[] = [];
  function wrap(stmt: D1PreparedStatement, sql: string, binds: unknown[] = []): D1PreparedStatement {
    return new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrap(target.bind(...args), sql, args);
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          statements.push({ sql, binds, method: String(prop) });
          if (!/^\s*SELECT\b/i.test(sql) || prop === "run") {
            forbidden.push(sql);
            throw new Error("Unexpected write in flat by-ID request");
          }
          if (rejectRead) return Promise.reject(new Error("Synthetic flat by-ID D1 rejection"));
          return Reflect.apply(value, target, args);
        };
      }
    });
  }
  const db = new Proxy(TEST_ENV.CUSTOMER_DB, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === "batch" || prop === "exec") return () => {
        forbidden.push(String(prop));
        throw new Error("Unexpected batch/exec in flat by-ID request");
      };
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  observed.push({ statements, forbidden });
  return { db, statements };
}

let observed: Array<{ statements: Statement[]; forbidden: string[] }>;
let requestNumber = 0;
async function get(
  path: string,
  options: { token?: string | null; db?: D1Database; headers?: Record<string, string> } = {}
): Promise<Response> {
  requestNumber++;
  const headers = new Headers({ origin: ORIGIN, "x-request-id": `Flat-${requestNumber}`, ...options.headers });
  const token = options.token === undefined ? READ_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return app.fetch(new Request(`http://test.local${path}`, { headers }), {
    ...TEST_ENV, CUSTOMER_DB: options.db ?? recordedDb().db
  });
}

async function validator(bytes: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

function posture(res: Response, origin = ORIGIN, requestId = `Flat-${requestNumber}`): void {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("access-control-allow-origin")).toBe(origin);
  expect(res.headers.get("vary")).toMatch(/\borigin\b/i);
  expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("x-request-id")).toBe(requestId);
  const exposed = (res.headers.get("access-control-expose-headers") ?? "")
    .split(",").map((h) => h.trim().toLowerCase());
  expect(exposed).toEqual(expect.arrayContaining(["etag", "x-request-id", "retry-after", "ratelimit"]));
}

async function representation(path: string, headers: Record<string, string> = {}) {
  const res = await get(path, { headers });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  posture(res);
  const bytes = await res.text();
  const tag = await validator(bytes);
  expect.soft(res.headers.get("etag")).toBe(tag);
  return { bytes, tag, row: JSON.parse(bytes) as Record<string, unknown> };
}

async function empty304(res: Response, tag: string, origin = ORIGIN, requestId = `Flat-${requestNumber}`) {
  // Soft checks expose subsequent invariants during RED rather than stopping at
  // the first absent validator. They still fail the test, never skip a contract.
  expect.soft(res.status).toBe(304);
  expect.soft(res.body).toBeNull();
  expect.soft((await res.arrayBuffer()).byteLength).toBe(0);
  expect.soft(res.headers.get("etag")).toBe(tag);
  posture(res, origin, requestId);
}

function oneLookup(statements: Statement[], id = ID): void {
  expect(statements).toHaveLength(1);
  expect(statements[0].sql).toMatch(/^\s*SELECT\b/i);
  expect(statements[0].binds).toEqual([id]);
}

const originalFetch = globalThis.fetch;
let outbound: ReturnType<typeof vi.fn>;
let cacheAccess: ReturnType<typeof vi.fn>;
beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  observed = [];
  outbound = vi.fn(async () => { throw new Error("Unexpected outbound fetch in flat by-ID oracle"); });
  globalThis.fetch = outbound as typeof fetch;
  cacheAccess = vi.fn(async () => { throw new Error("Unexpected cache access in flat by-ID oracle"); });
  vi.stubGlobal("caches", {
    default: { match: cacheAccess, put: cacheAccess, delete: cacheAccess, keys: cacheAccess },
    open: cacheAccess, match: cacheAccess, has: cacheAccess, keys: cacheAccess, delete: cacheAccess
  });
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  await db.batch([
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, comments, enabled, synced_at) VALUES (?, ?, 'hidden', 1, 'synthetic-fixed-time')").bind(ID, LABEL),
    db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, comments, enabled, synced_at) VALUES (?, ?, ?, 'hidden', 1, 'synthetic-fixed-time')").bind(ID, ID, LABEL),
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, location_address, container_note, enabled, synced_at) VALUES (?, ?, ?, 'hidden', 1, 'synthetic-fixed-time')").bind(ID, ID, LABEL)
  ]);
});
afterEach(() => {
  try {
    expect(outbound).not.toHaveBeenCalled();
    expect(cacheAccess).not.toHaveBeenCalled();
    for (const recorder of observed) expect(recorder.forbidden).toEqual([]);
  } finally { globalThis.fetch = originalFetch; vi.unstubAllGlobals(); vi.restoreAllMocks(); }
});

describe.each(SPECS)("$name flat by-ID green controls", (spec) => {
  it("preserves bare full and exact projected JSON, content type, identity and one lookup", async () => {
    for (const sparse of [false, true]) {
      const { db, statements } = recordedDb();
      const res = await get(sparse ? sparsePath(spec) : pathOf(spec), { db });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
      posture(res);
      const bytes = await res.text();
      const row = JSON.parse(bytes) as Record<string, unknown>;
      expect(row).toMatchObject(selectedRow(spec));
      expect(Object.keys(row).sort()).toEqual(sparse ? [spec.id, spec.field].sort() : [...spec.columns].sort());
      if (sparse) expect(bytes).toBe(JSON.stringify(selectedRow(spec)));
      oneLookup(statements);
    }
  });

  it("keeps unknown and list-only queries ignored rather than importing hydrated strictness", async () => {
    const baseline = recordedDb();
    const first = await get(sparsePath(spec), { db: baseline.db });
    expect(first.status).toBe(200);
    const bytes = await first.text();
    const decorated = recordedDb();
    const res = await get(`${sparsePath(spec)}&unknown=ignored&unknown=twice&limit=0&cursor=no&includeTotal=FALSE&enabled=maybe`, { db: decorated.db });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(bytes);
    expect(decorated.statements).toEqual(baseline.statements);
  });

  it.each([READ_TOKEN, API_TOKEN, SYNC_SECRET])("preserves the existing authorized role %s", async (token) => {
    const { db, statements } = recordedDb();
    const res = await get(sparsePath(spec), { token, db });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(selectedRow(spec));
    oneLookup(statements);
  });
});

describe.each(SPECS)("$name flat by-ID representation validators", (spec) => {
  it.each([false, true])("200 -> bodyless 304 -> changed selected row 200, sparse=%s", async (sparse) => {
    const path = sparse ? sparsePath(spec) : pathOf(spec);
    const first = await representation(path);
    expect(first.row).toMatchObject(selectedRow(spec));
    const { db, statements } = recordedDb();
    await empty304(await get(path, { db, headers: { "if-none-match": first.tag } }), first.tag);
    oneLookup(statements);
    expect(statements).toEqual(observed[0].statements);
    await TEST_ENV.CUSTOMER_DB.prepare(`UPDATE ${spec.name}_snapshot SET ${spec.field} = ? WHERE ${spec.id} = ?`)
      .bind("synthetic-changed-selected", ID).run();
    const changed = await representation(path, { "if-none-match": first.tag });
    expect(changed.row).toMatchObject(selectedRow(spec, "synthetic-changed-selected"));
    expect(changed.row.synced_at ?? "synthetic-fixed-time").toBe("synthetic-fixed-time");
    expect(changed.tag).not.toBe(first.tag);
    oneLookup(observed[2].statements);
  });

  it("hashes selected nulls as served JSON, and a null-to-value change invalidates them", async () => {
    await TEST_ENV.CUSTOMER_DB.prepare(`UPDATE ${spec.name}_snapshot SET ${spec.field} = NULL WHERE ${spec.id} = ?`).bind(ID).run();
    const first = await representation(sparsePath(spec));
    expect(first.bytes).toBe(JSON.stringify(selectedRow(spec, null)));
    await empty304(await get(sparsePath(spec), { headers: { "if-none-match": first.tag } }), first.tag);
    await TEST_ENV.CUSTOMER_DB.prepare(`UPDATE ${spec.name}_snapshot SET ${spec.field} = ? WHERE ${spec.id} = ?`).bind(LABEL, ID).run();
    const changed = await representation(sparsePath(spec), { "if-none-match": first.tag });
    expect(changed.row).toEqual(selectedRow(spec));
    expect(changed.tag).not.toBe(first.tag);
    for (const recorder of observed) oneLookup(recorder.statements);
  });

  it("selected-out values and synced_at do not invalidate sparse bytes, but do invalidate full bytes", async () => {
    const sparse = await representation(sparsePath(spec));
    const full = await representation(pathOf(spec));
    await TEST_ENV.CUSTOMER_DB.prepare(`UPDATE ${spec.name}_snapshot SET ${spec.hidden} = 'changed-hidden', synced_at = 'changed-time' WHERE ${spec.id} = ?`).bind(ID).run();
    const same = await representation(sparsePath(spec));
    expect(same.bytes).toBe(sparse.bytes);
    expect(same.tag).toBe(sparse.tag);
    await empty304(await get(sparsePath(spec), { headers: { "if-none-match": sparse.tag } }), sparse.tag);
    const changed = await representation(pathOf(spec), { "if-none-match": full.tag });
    expect(changed.tag).not.toBe(full.tag);
    expect(changed.row[spec.hidden]).toBe("changed-hidden");
    expect(changed.row.synced_at).toBe("changed-time");
    for (const recorder of observed) oneLookup(recorder.statements);
  });

  it("different bytes cannot share full/sparse validators; all-fields with equal bytes can", async () => {
    const full = await representation(pathOf(spec));
    const sparse = await representation(sparsePath(spec), { "if-none-match": full.tag });
    expect(sparse.bytes).not.toBe(full.bytes);
    expect(sparse.tag).not.toBe(full.tag);
    const allPath = `${pathOf(spec)}?fields=${spec.columns.join(",")}`;
    const all = await representation(allPath);
    expect(all.bytes).toBe(full.bytes);
    expect(all.tag).toBe(full.tag);
    await empty304(await get(allPath, { headers: { "if-none-match": full.tag } }), full.tag);
    const explicitId = await representation(`${pathOf(spec)}?fields=${spec.id},${spec.field}`);
    expect(explicitId.bytes).toBe(sparse.bytes);
    expect(explicitId.tag).toBe(sparse.tag);
  });

  it("equivalent requests share validators, while 304 uses current auth/CORS/request metadata", async () => {
    const first = await representation(sparsePath(spec));
    const origin = "https://another-flat-client.invalid";
    const requestId = "Flat-current-response";
    const { db, statements } = recordedDb();
    const res = await get(`${sparsePath(spec)}&unused=1`, {
      db, token: API_TOKEN, headers: { origin, "x-request-id": requestId, "if-none-match": first.tag }
    });
    await empty304(res, first.tag, origin, requestId);
    oneLookup(statements);
  });
});

type MatchCase = { label: string; header: (tag: string) => string; status: 200 | 304 };
const MATCH_CASES: MatchCase[] = [
  { label: "strong", header: (t) => t, status: 304 },
  { label: "weak", header: (t) => `W/${t}`, status: 304 },
  { label: "list with whitespace", header: (t) => `"other",\t${t} , "last"`, status: 304 },
  { label: "weak in list", header: (t) => `"other", W/${t}`, status: 304 },
  { label: "quoted comma before matching token", header: (t) => `"opaque,comma", ${t}`, status: 304 },
  { label: "quoted comma after matching token", header: (t) => `${t}, "opaque,comma"`, status: 304 },
  { label: "standalone wildcard", header: () => "*", status: 304 },
  { label: "nonmatch", header: () => '"unrelated"', status: 200 },
  { label: "empty", header: () => "", status: 200 },
  { label: "quoted wildcard", header: () => '"*"', status: 200 },
  { label: "hash prefix", header: (t) => `"${t.slice(1, -2)}"`, status: 200 },
  { label: "hash superstring", header: (t) => `"prefix-${t.slice(1, -1)}-suffix"`, status: 200 },
  { label: "matching bytes inside comma-containing token", header: (t) => `"prefix,${t.slice(1, -1)},suffix"`, status: 200 },
  { label: "unquoted hash", header: (t) => t.slice(1, -1), status: 200 },
  { label: "unquoted weak hash", header: (t) => `W/${t.slice(1, -1)}`, status: 200 },
  { label: "unterminated quote", header: (t) => t.slice(0, -1), status: 200 },
  { label: "lowercase weak prefix", header: (t) => `w/${t}`, status: 200 },
  { label: "double weak prefix", header: (t) => `W/W/${t}`, status: 200 },
  { label: "arbitrary text around matching token", header: (t) => `junk${t}junk`, status: 200 },
  { label: "wildcard mixed with tag", header: (t) => `*, ${t}`, status: 200 },
  { label: "trailing comma", header: (t) => `${t},`, status: 200 },
  { label: "malformed list suffix", header: (t) => `${t}, junk`, status: 200 }
];
describe.each(SPECS)("$name flat by-ID quoted-token grammar", (spec) => {
  it.each(MATCH_CASES)("$label -> $status", async ({ header, status }) => {
    const plain = recordedDb();
    const first = await get(sparsePath(spec), { db: plain.db });
    expect(first.status).toBe(200);
    const bytes = await first.text();
    const tag = await validator(bytes);
    const conditional = recordedDb();
    const res = await get(sparsePath(spec), { db: conditional.db, headers: { "if-none-match": header(tag) } });
    if (status === 304) await empty304(res, tag);
    else {
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(bytes);
      expect.soft(res.headers.get("etag")).toBe(tag);
      expect(res.headers.get("content-type")).toBe("application/json");
      posture(res);
    }
    oneLookup(plain.statements);
    expect(conditional.statements).toEqual(plain.statements);
  });
});

describe.each(SPECS)("$name flat by-ID errors precede conditional success", (spec) => {
  it("missing rows remain 404 for wildcard, and a deleted row cannot reuse its old validator", async () => {
    const first = await get(sparsePath(spec));
    expect(first.status).toBe(200);
    const tag = await validator(await first.text());
    for (const header of ["*", tag]) {
      if (header === tag) {
        // Remove synthetic dependents first: these tables enforce foreign keys.
        const db = TEST_ENV.CUSTOMER_DB;
        await db.batch([
          db.prepare("DELETE FROM container_snapshot WHERE container_id = ?").bind(ID),
          db.prepare("DELETE FROM address_snapshot WHERE pickup_address_id = ?").bind(ID),
          db.prepare("DELETE FROM customer_snapshot WHERE customer_id = ?").bind(ID)
        ]);
      }
      const id = header === "*" ? 999999 : ID;
      const { db, statements } = recordedDb();
      const res = await get(`${pathOf(spec, id)}?fields=${spec.field}`, { db, headers: { "if-none-match": header } });
      expect(res.status).toBe(404);
      expect(res.headers.get("etag")).toBeNull();
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      posture(res);
      expect(await res.json()).toMatchObject({ status: 404 });
      oneLookup(statements, id);
    }
  });

  it.each([null, "incorrect-synthetic-token"])("auth rejects %s before invalid input or D1, even for wildcard", async (token) => {
    const { db, statements } = recordedDb();
    const res = await get(`${pathOf(spec, "bad-id")}?fields=unknown-SYNTHETIC-MARKER`, {
      token, db, headers: { "if-none-match": "*" }
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("etag")).toBeNull();
    posture(res);
    expect(await res.json()).toMatchObject({ status: 401 });
    expect(statements).toEqual([]);
  });

  it.each(["0", "-1", "1.5", "NaN", "9007199254740992"])("invalid ID %s is 400 before D1 even for wildcard", async (id) => {
    const { db, statements } = recordedDb();
    const res = await get(pathOf(spec, id), { db, headers: { "if-none-match": "*" } });
    expect(res.status).toBe(400);
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    posture(res);
    expect(await res.json()).toMatchObject({ status: 400 });
    expect(statements).toEqual([]);
  });

  it.each([
    "", "unknown-SYNTHETIC-MARKER", "rowid", "erased_at", `${spec.field},`,
    `${spec.field},${spec.field}`, `${spec.field}&fields=${spec.field}`,
    `%20${spec.field}`, spec.field.toUpperCase()
  ])("invalid fields %s is value-free 400 before D1, never wildcard 304", async (fields) => {
    const { db, statements } = recordedDb();
    const res = await get(`${pathOf(spec)}?fields=${fields}`, { db, headers: { "if-none-match": "*" } });
    expect(res.status).toBe(400);
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    posture(res);
    const bytes = await res.text();
    expect(JSON.parse(bytes)).toMatchObject({ status: 400, detail: "Invalid request query (fields). See docs/PROBLEMS.md#bad-request." });
    expect(bytes).not.toContain("SYNTHETIC-MARKER");
    expect(statements).toEqual([]);
  });

  it("known exact tag cannot bypass auth, invalid fields or invalid ID", async () => {
    const first = await get(sparsePath(spec));
    const tag = await validator(await first.text());
    for (const scenario of [
      { path: sparsePath(spec), token: null, status: 401 },
      { path: `${pathOf(spec)}?fields=unknown-SYNTHETIC-MARKER`, token: READ_TOKEN, status: 400 },
      { path: pathOf(spec, "0"), token: READ_TOKEN, status: 400 }
    ]) {
      const { db, statements } = recordedDb();
      const res = await get(scenario.path, { token: scenario.token, db, headers: { "if-none-match": tag } });
      expect(res.status).toBe(scenario.status);
      expect(res.headers.get("etag")).toBeNull();
      posture(res);
      expect(statements).toEqual([]);
    }
  });

  it("D1 rejection remains an error for wildcard and a formerly valid exact tag", async () => {
    const first = await get(sparsePath(spec));
    expect(first.status).toBe(200);
    const tag = await validator(await first.text());
    for (const header of ["*", tag]) {
      const { db, statements } = recordedDb(true);
      const res = await get(sparsePath(spec), { db, headers: { "if-none-match": header } });
      expect(res.status).toBe(500);
      expect(res.headers.get("etag")).toBeNull();
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      posture(res);
      expect(await res.json()).toMatchObject({ status: 500, requestId: `Flat-${requestNumber}` });
      oneLookup(statements);
    }
  });

  it("read token still cannot access CSV exports or hydrated data", async () => {
    for (const path of [`/api/v1/${spec.name}-snapshot/export`, `/api/v1/data/${spec.name}?id=${ID}`]) {
      const { db, statements } = recordedDb();
      const res = await get(path, { db, headers: { "if-none-match": "*" } });
      expect(res.status).toBe(401);
      expect(res.headers.get("etag")).toBeNull();
      expect(statements).toEqual([]);
    }
  });
});

type Operation = {
  operationId?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: { type?: string } }>;
  responses?: Record<string, { headers?: Record<string, { schema?: { type?: string } }>; content?: Record<string, unknown> }>;
  [key: string]: unknown;
};
type OpenApi = { paths: Record<string, { get?: Operation }> };
describe("mounted flat by-ID conditional contract", () => {
  it.each(SPECS)("$name publishes optional If-None-Match, ETag on 200/304 and bodyless 304 without changing identity", async (spec) => {
    const res = await get("/openapi.json");
    expect(res.status).toBe(200);
    const doc = await res.json() as OpenApi;
    const op = doc.paths[pathOf(spec, `{${spec.param}}`)]?.get;
    expect(op?.operationId).toBe(spec.operationId);
    expect(op?.["x-access"]).toBe("read");
    expect(op?.["x-effect"]).toBe("local-read");
    expect(op?.parameters?.find((p) => p.name === "fields")).toMatchObject({ in: "query", required: false });
    expect.soft(op?.parameters?.find((p) => p.in === "header" && p.name.toLowerCase() === "if-none-match"))
      .toMatchObject({ required: false, schema: { type: "string" } });
    for (const status of ["200", "304"]) {
      const response = op?.responses?.[status];
      expect.soft(response, status).toBeDefined();
      const etag = Object.entries(response?.headers ?? {}).find(([name]) => name.toLowerCase() === "etag")?.[1];
      expect.soft(etag?.schema?.type, `${status} ETag schema`).toBe("string");
    }
    expect(Object.keys(op?.responses?.["304"]?.content ?? {})).toEqual([]);
    expect(op?.responses?.["200"]?.content).toHaveProperty("application/json");
    expect(op?.responses?.["400"]).toBeDefined();
    expect(op?.responses?.["404"]).toBeDefined();
  });

  it.each(SPECS)("$name preflight already permits conditional browser reads without credentials", async (spec) => {
    const res = await app.fetch(new Request(`http://test.local${pathOf(spec)}`, {
      method: "OPTIONS", headers: {
        origin: ORIGIN, "access-control-request-method": "GET",
        "access-control-request-headers": "authorization, if-none-match, x-request-id"
      }
    }), TEST_ENV);
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    const allowed = (res.headers.get("access-control-allow-headers") ?? "").split(",").map((h) => h.trim().toLowerCase());
    expect(allowed).toEqual(expect.arrayContaining(["authorization", "if-none-match", "x-request-id"]));
  });
});
