/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import loggingMd from "../docs/LOGGING.md?raw";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Cache.match is the fault boundary, not the cache helper or hydrated handlers.
 * Real auth, routing, cache counters, D1 hydration and ETag serialization execute.
 * Removing read recovery must fail the 200/304/404 assertions; broadening recovery
 * to D1 or invalidation must fail the loud-error controls. All rows are synthetic.
 */
const entries = new Map<string, Response>();
const work = { matches: [] as string[], puts: [] as string[], deletes: [] as string[], sql: [] as string[] };
const fault: { lookup?: { reason: unknown }; put?: Error; delete?: Error; d1?: Error } = {};
const fakeCache = {
  async match(request: Request): Promise<Response | undefined> {
    work.matches.push(request.url);
    if (fault.lookup) throw fault.lookup.reason;
    return entries.get(request.url)?.clone();
  },
  async put(request: Request, response: Response): Promise<void> {
    work.puts.push(request.url);
    if (fault.put) throw fault.put;
    entries.set(request.url, response.clone());
  },
  async delete(request: Request): Promise<boolean> {
    work.deletes.push(request.url);
    if (fault.delete) throw fault.delete;
    return entries.delete(request.url);
  }
};
// cloudflare:workers can preload the Worker graph before this test module.
// Re-import that graph after replacing the boundary captured at module scope.
vi.resetModules();
vi.stubGlobal("caches", { default: fakeCache });
const {
  getCachedDataEntity, getEntityDataCacheStats, resetEntityDataCacheStats,
  putCachedDataEntity, invalidateDataEntity, invalidateCustomerGraphWithRetry
} = await import("../src/lib/entityDataCache");
const { default: app } = await import("../src/app");
const DB = (env as unknown as Env).CUSTOMER_DB;
const SECRET = "synthetic-cache-outage-secret";
const ORIGIN = "https://synthetic-cache-client.invalid";
const POISON = "CACHE-LOOKUP-POISON-DO-NOT-LOG";
const PROBLEMS = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md";
type Row = Record<string, string | number | null>;
const customer: Row = {
  customer_id: 98101, customer_type_id: 2, company_name: "Synthetic cache customer",
  first_name: "Synthetic", middle_initial: null, last_name: "Fixture", name_suffix: "",
  customer_number: "SYN-CACHE", sub_customer_number: null, phone1: "555-0100", phone2: null,
  comments: "Synthetic cache note", enabled: 1, synced_at: "2026-10-01T00:00:00.000Z"
};
const address: Row = {
  pickup_address_id: 98201, customer_id: 98101, route_id: 7, address: "1 Synthetic Way",
  city: "Syntheticville", state: "ZZ", zip: "00000", franchise_id: "3", comments: null,
  extras_allowed: 0, enabled: 1, driver_note: null, latitude: "0", longitude: "-10.5",
  last_audit_date: "2026-09-01", synced_at: "2026-10-02T00:00:00.000Z"
};
const container: Row = {
  container_id: 98301, pickup_address_id: 98201, container_type_id: 4, serial_number: "SYN-CACHE-SERIAL",
  rfid: null, oncall: 0, event_code: "SYN", gps_locked: 1, latitude: "0", longitude: "-11.5", enabled: 1,
  location_address: "Synthetic enclosure", city: "Syntheticville", state: "ZZ", zip: "00000",
  container_note: null, ud_cost_share_ud: "0", ud_enclosure_doors_ud: "2",
  ud_last_compactor_inspection_ud: null, ud_last_enclosure_inspection_ud: "2026-09-02",
  ud_material_stream_ud: "synthetic-paper", color: "blue", service_code_type: "SYN",
  service_code_input: "SYN-INPUT", service_code: "SYN-CODE", service_date: "2026-10-03",
  route_ids: "7,8", frequency_ids: "1,2", synced_at: "2026-10-03T00:00:00.000Z"
};
const specs = [
  { kind: "customer", id: 98101, alias: "customerId", key: "customer_id", field: "company_name", row: customer,
    bundle: { customer, addresses: [{ ...address, containers: [container] }] } },
  { kind: "address", id: 98201, alias: "pickupAddressId", key: "pickup_address_id", field: "city", row: address,
    bundle: { address, customer, containers: [container] } },
  { kind: "container", id: 98301, alias: "containerId", key: "container_id", field: "serial_number", row: container,
    bundle: { container, address, customer } }
] as const;
type Spec = (typeof specs)[number];
type Log = Record<string, unknown>;
const logs: Log[] = [];
const network = vi.fn(() => { throw new Error("Unexpected outbound fetch in cache-read acceptance"); });

function resetWork(): void {
  for (const values of Object.values(work)) values.length = 0;
  resetEntityDataCacheStats();
  logs.length = 0;
}
function appEnv(): Env {
  const authStub = {
    async fetch(input: RequestInfo | URL) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/throttle/failure") return Response.json({ blocked: false, retryAfterSec: 0 });
      if (url.pathname === "/throttle/clear") return new Response("OK");
      throw new Error("Unexpected auth-session operation in cache-read acceptance");
    }
  };
  return {
    CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET, SHADOW_API_TOKEN: "synthetic-api-token",
    SHADOW_API_READ_TOKEN: "synthetic-read-token",
    CUSTOMER_DB: {
      prepare(sql: string) {
        work.sql.push(sql);
        if (!/^\s*SELECT\b/i.test(sql)) throw new Error("Hydrated GET attempted a D1 mutation");
        if (fault.d1) throw fault.d1;
        return DB.prepare(sql);
      }
    },
    AUTH_SESSION: { idFromName: (name: string) => name, get: () => authStub }
  } as unknown as Env;
}
async function get(spec: Spec, options: { query?: string; headers?: HeadersInit; token?: string | null } = {}): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN, "x-request-id": "synthetic-cache-read-request" });
  if (options.token !== null) headers.set("authorization", `Bearer ${options.token ?? SECRET}`);
  new Headers(options.headers).forEach((value, key) => headers.set(key, value));
  const pending: Promise<unknown>[] = [];
  const response = await app.fetch(new Request(
    `https://synthetic.example.test/api/v1/data/${spec.kind}?${options.query ?? `id=${spec.id}`}`, { headers }
  ), appEnv(), {
    waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {}
  } as ExecutionContext);
  await Promise.all(pending);
  return response;
}
async function hash(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function served(response: Response, expected: unknown): Promise<string> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toMatch(/^application\/json\b/);
  expect(response.headers.get("cache-control")).toBe("private, max-age=60");
  expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  expect(response.headers.get("x-request-id")).toBe("synthetic-cache-read-request");
  const text = await response.text();
  expect(JSON.parse(text)).toEqual(expected);
  const digest = await hash(text);
  expect(response.headers.get("etag")).toBe(`"${digest}"`);
  expect(response.headers.get("x-entity-etag")).toBe(digest);
  return text;
}
function stats(spec: Spec, hits: number, misses: number): void {
  expect(getEntityDataCacheStats()).toEqual(Object.fromEntries(specs.map(({ kind }) => [
    kind, kind === spec.kind ? { hits, misses } : { hits: 0, misses: 0 }
  ])));
}
function noWork(): void {
  expect(work).toEqual({ matches: [], puts: [], deletes: [], sql: [] });
  expect(getEntityDataCacheStats()).toEqual({
    customer: { hits: 0, misses: 0 }, address: { hits: 0, misses: 0 }, container: { hits: 0, misses: 0 }
  });
}
async function problem(response: Response, status: number, type: string): Promise<Record<string, unknown>> {
  expect(response.status).toBe(status);
  expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json\b/);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject({ type: `${PROBLEMS}#${type}`, status });
  expect(JSON.stringify(body)).not.toContain(POISON);
  return body;
}
async function insert(table: string, row: Row): Promise<void> {
  const columns = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .bind(...Object.values(row)).run();
}
beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  entries.clear();
  for (const key of Object.keys(fault)) delete fault[key as keyof typeof fault];
  vi.stubGlobal("caches", { default: fakeCache });
  vi.stubGlobal("fetch", network);
  network.mockClear();
  for (const method of ["info", "warn", "error", "log"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.length === 1 && typeof args[0] === "object" && args[0] !== null
        ? args[0] as Log : { unexpectedConsoleArguments: args });
    });
  }
  await DB.batch([
    DB.prepare("DELETE FROM container_snapshot"), DB.prepare("DELETE FROM address_snapshot"), DB.prepare("DELETE FROM customer_snapshot")
  ]);
  await insert("customer_snapshot", customer);
  await insert("address_snapshot", address);
  await insert("container_snapshot", container);
  resetWork();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  expect(network).not.toHaveBeenCalled();
});

describe.each(specs)("$kind shared cache read boundary", (spec) => {
  it.each([
    ["Error", new Error(POISON)], ["string", POISON], ["object", { message: POISON }], ["null", null], ["undefined", undefined]
  ])("treats a rejected %s match as one miss without retrying", async (_label, reason) => {
    fault.lookup = { reason };
    await expect(getCachedDataEntity(spec.kind, spec.id)).resolves.toBeUndefined();
    stats(spec, 0, 1);
    expect(work.matches).toHaveLength(1);
    expect(work.puts).toEqual([]);
    expect(work.deletes).toEqual([]);
    expect(work.sql).toEqual([]);
  });

  it("counts ordinary miss, rejected miss, and subsequent hit exactly once each", async () => {
    expect(await getCachedDataEntity(spec.kind, spec.id)).toBeUndefined();
    fault.lookup = { reason: new Error(POISON) };
    await expect(getCachedDataEntity(spec.kind, spec.id)).resolves.toBeUndefined();
    delete fault.lookup;
    await putCachedDataEntity(spec.kind, spec.id, Response.json({ synthetic: "cached" }));
    const cached = await getCachedDataEntity(spec.kind, spec.id);
    expect(await cached?.json()).toEqual({ synthetic: "cached" });
    stats(spec, 1, 2);
    expect(work.matches).toHaveLength(3);
  });

  it("emits one bounded sanitized diagnostic and no duplicate miss accounting", async () => {
    const id = 987654321;
    const message = `${POISON} https://private.invalid/data/${id} cookie=session-poison token=token-poison SyntheticPrivateRow`;
    const error = new Error(message);
    error.stack = `${POISON}-STACK ${message}`;
    fault.lookup = { reason: error };
    await expect(getCachedDataEntity(spec.kind, id)).resolves.toBeUndefined();
    stats(spec, 0, 1);
    const events = logs.filter((line) => line.route === "cache.entityData");
    const diagnostics = events.filter((line) => line.level === "warn" || line.level === "error");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ entity: spec.kind, ms: null, kind: "Error" });
    const allowed = ["level", "msg", "route", "entity", "kind", "ms", "hits", "misses"];
    for (const line of events) expect(Object.keys(line).filter((key) => !allowed.includes(key))).toEqual([]);
    const cataloguedMessages = [...loggingMd.matchAll(/^\|\s*`(.+?)`\s*\|/gm)].map((match) => match[1]);
    expect(cataloguedMessages).toContain(diagnostics[0].msg);
    expect(typeof diagnostics[0].msg).toBe("string");
    expect(String(diagnostics[0].msg).length).toBeGreaterThan(0);
    expect(String(diagnostics[0].msg).length).toBeLessThanOrEqual(160);
    // One diagnostic may accompany the normal count-only miss event, not two misses.
    expect(events.length).toBeLessThanOrEqual(2);
    const counted = events.filter((line) => "hits" in line || "misses" in line);
    expect(counted).toHaveLength(1);
    for (const line of counted) expect(line).toMatchObject({ hits: 0, misses: 1 });
    const serialized = JSON.stringify(logs);
    for (const secret of [POISON, String(id), "private.invalid", "session-poison", "token-poison", "SyntheticPrivateRow", work.matches[0]]) {
      expect(serialized).not.toContain(secret);
    }
    const fixedMessage = diagnostics[0].msg;
    logs.length = 0;
    fault.lookup = { reason: "different-untrusted-exception" };
    await expect(getCachedDataEntity(spec.kind, id + 1)).resolves.toBeUndefined();
    const next = logs.filter((line) => line.route === "cache.entityData" && (line.level === "warn" || line.level === "error"));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ msg: fixedMessage, kind: "unknown", entity: spec.kind });
    expect(JSON.stringify(logs)).not.toContain("different-untrusted-exception");
    stats(spec, 0, 2);
  });
});

describe.each(specs)("$kind hydrated read during cache lookup outage", (spec) => {
  it("control: hydrates a normal miss and serves a positive cache hit without D1", async () => {
    const text = await served(await get(spec), spec.bundle);
    expect(work.sql.length).toBeGreaterThan(0);
    resetWork();
    fault.d1 = new Error("A positive cache hit must not query D1");
    expect(await served(await get(spec), spec.bundle)).toBe(text);
    expect(work.sql).toEqual([]);
    stats(spec, 1, 0);
  });

  it("returns existing D1 rows as 200 after exactly one rejected lookup", async () => {
    fault.lookup = { reason: new Error(POISON) };
    await served(await get(spec), spec.bundle);
    expect(work.sql.length).toBeGreaterThan(0);
    expect(work.matches).toHaveLength(1);
    expect(work.puts).toHaveLength(1);
    stats(spec, 0, 1);
  });

  it("computes an empty-body conditional 304 from D1, not a stale cached response", async () => {
    const text = await served(await get(spec), spec.bundle);
    const etag = `"${await hash(text)}"`;
    resetWork();
    fault.lookup = { reason: new Error(POISON) };
    const response = await get(spec, { headers: { "if-none-match": etag } });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe(etag);
    expect(response.headers.get("cache-control")).toBe("private, max-age=60");
    expect(response.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(work.sql.length).toBeGreaterThan(0);
    expect(work.matches).toHaveLength(1);
    stats(spec, 0, 1);
  });

  it("does not invent a 304 for a stale validator when match rejects", async () => {
    fault.lookup = { reason: new Error(POISON) };
    await served(await get(spec, { headers: { "if-none-match": '"stale-synthetic-validator"' } }), spec.bundle);
    stats(spec, 0, 1);
  });

  it("preserves normal not-found behavior when D1 has no row", async () => {
    const query = `${spec.alias}=98999`;
    const normal = await problem(await get(spec, { query }), 404, "not-found");
    expect(normal).toMatchObject({
      title: "Not Found",
      detail: spec.kind === "customer"
        ? "No snapshot data for customer_id=98999 (import/sync first). See docs/PROBLEMS.md#not-found."
        : `No snapshot for ${spec.key}=98999. See docs/PROBLEMS.md#not-found.`,
      instance: `/api/v1/data/${spec.kind}?id=98999`
    });
    resetWork();
    fault.lookup = { reason: new Error(POISON) };
    expect(await problem(await get(spec, { query }), 404, "not-found")).toEqual(normal);
    expect(work.sql.length).toBeGreaterThan(0);
    expect(work.matches).toHaveLength(1);
    expect(work.puts).toEqual([]);
    stats(spec, 0, 1);
  });

  it.each([false, true])("keeps genuine D1 errors loud (lookup rejected: %s)", async (rejected) => {
    if (rejected) fault.lookup = { reason: new Error(POISON) };
    fault.d1 = new Error(`${POISON} D1 unavailable`);
    const body = await problem(await get(spec), 500, "internal");
    expect(body).toMatchObject({ title: "Internal Server Error", requestId: "synthetic-cache-read-request" });
    expect(work.sql.length).toBeGreaterThan(0);
    expect(work.puts).toEqual([]);
    stats(spec, 0, 1);
  });

  it.each([null, "wrong-synthetic-token", "synthetic-read-token", "synthetic-api-token"])(
    "auth precedes cache and D1 work for token %s", async (token) => {
      fault.lookup = { reason: new Error(POISON) };
      const response = await get(spec, { token });
      expect(response.status).toBe(401);
      noWork();
    }
  );

  it.each(["", "id=not-a-number", "id=-1", "id=0"])("validation precedes cache and D1 work for %s", async (query) => {
    fault.lookup = { reason: new Error(POISON) };
    await problem(await get(spec, { query }), 400, "bad-request");
    noWork();
  });

  it("keeps population best effort even after a lookup outage", async () => {
    fault.lookup = { reason: new Error(POISON) };
    fault.put = new Error(`${POISON} put unavailable`);
    await served(await get(spec), spec.bundle);
    expect(work.puts).toHaveLength(1);
    stats(spec, 0, 1);
  });

  it("sparse-root compatibility: fallback preserves projection and its conditional validator", async () => {
    const projected = { ...spec.bundle, [spec.kind]: { [spec.key]: spec.id, [spec.field]: spec.row[spec.field] } };
    const query = `id=${spec.id}&fields=${spec.field}`;
    const text = await served(await get(spec, { query }), projected);
    resetWork();
    fault.lookup = { reason: new Error(POISON) };
    expect(await served(await get(spec, { query }), projected)).toBe(text);
    expect(work.sql.length).toBeGreaterThan(0);
    const response = await get(spec, { query, headers: { "if-none-match": `"${await hash(text)}"` } });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe("");
    expect(response.headers.get("etag")).toBe(`"${await hash(text)}"`);
    stats(spec, 0, 2);
  });
});

describe("invalidation is not cache-read recovery", () => {
  it("keeps direct deletes loud even with a rejected lookup configured", async () => {
    fault.lookup = { reason: new Error(POISON) };
    const error = new Error("Synthetic invalidation failure");
    fault.delete = error;
    await expect(invalidateDataEntity("customer", 98101)).rejects.toBe(error);
    expect(work.deletes).toHaveLength(1);
    expect(work.matches).toEqual([]);
  });

  it("preserves graph retry and terminal failure rather than reporting healthy", async () => {
    fault.lookup = { reason: new Error(POISON) };
    const error = new Error("Synthetic persistent graph failure");
    fault.delete = error;
    await expect(invalidateCustomerGraphWithRetry({ customerId: 98101, addressIds: [], containerIds: [] })).rejects.toBe(error);
    expect(work.deletes).toHaveLength(2);
    expect(work.matches).toEqual([]);
    expect(logs.filter((line) => line.route === "cache.customerGraph.invalidate")).toHaveLength(2);
  });
});
