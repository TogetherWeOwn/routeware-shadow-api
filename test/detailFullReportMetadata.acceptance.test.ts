import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { ensureD1TestTables } from "./d1TestMigrations";

// Independent source-availability oracle. Real local D1, mapping, upserts,
// reconciliation and reads; only external session/network/cache storage is fake.
// Replacing report-only columns with detail-full's unavailable values must fail.
const state = vi.hoisted(() => ({
  detail: {} as Record<string, unknown>,
  unexpected: [] as string[],
  logs: [] as unknown[][]
}));
function unexpected(kind: string): never {
  state.unexpected.push(kind);
  throw new Error("Unexpected external operation in metadata acceptance fixture");
}
vi.mock("../src/lib/sessionState", () => ({ readSessionState: async () => null }));
vi.mock("../src/lib/establishSession", () => ({ establishSession: async () => unexpected("login") }));
vi.mock("../src/lib/upstreamForward", () => ({
  forwardToUpstream: async (req: Request, url: URL, _session: unknown, body: ArrayBuffer | null) => {
    if (req.method !== "POST" || url.toString() !== "https://upstream.invalid/WebRW/Customer/GetCustomerDetailFull" ||
        !body || new TextDecoder().decode(body) !== '{"customerID":5,"showDisabled":true}') {
      return unexpected("detail-full request");
    }
    return Response.json(state.detail);
  }
}));

vi.mock("../src/lib/customerSaveAutoToken", () => ({
  prepareSaveCustomerLongFormBody: async (_env: Env, _session: unknown, _req: Request, body: ArrayBuffer) => body,
  evictAntiForgeryTokenCacheForBody: () => false
}));
vi.mock("../src/lib/forwardWithSessionRetry", () => ({
  forwardWithSessionRetry: async (_env: Env, _session: unknown, req: Request, url: URL) => {
    if (req.method !== "POST" || url.toString() !== "https://upstream.invalid/WebRW/Customer/SaveCustomerLongForm") {
      return unexpected("save request");
    }
    return new Response("true");
  }
}));

const OLD = "2029-01-01T00:00:00.000Z";
const NOW = "2030-01-01T00:00:00.000Z";
const LATER = "2031-01-01T00:00:00.000Z";
const MARKER = "SYNTHETIC_REPORT_ONLY_DO_NOT_LOG";
const reportValues = {
  ud_cost_share_ud: `${MARKER}_cost`,
  ud_enclosure_doors_ud: `${MARKER}_doors`,
  ud_last_compactor_inspection_ud: `${MARKER}_compactor`,
  ud_last_enclosure_inspection_ud: `${MARKER}_enclosure`,
  ud_material_stream_ud: `${MARKER}_material`,
  service_code_type: `${MARKER}_type`,
  service_code_input: `${MARKER}_input`,
  service_date: "2028-06-17"
};
const nullReport = Object.fromEntries(Object.keys(reportValues).map((column) => [column, null]));
const db = env.CUSTOMER_DB;
const stub = {} as DurableObjectStub;
const cacheEntries = new Map<string, Response>();
const deletedKeys: string[] = [];
const cacheKey = (kind: string, id: number) => `https://routeware-shadow-entity/v1/${kind}/${id}`;
const cache = {
  async match(request: Request) { return cacheEntries.get(request.url)?.clone(); },
  async put(request: Request, response: Response) { cacheEntries.set(request.url, response.clone()); },
  async delete(request: Request) { deletedKeys.push(request.url); return cacheEntries.delete(request.url); }
};
vi.resetModules();
vi.stubGlobal("caches", { default: cache });
const { mapDetailFullToRows, syncCustomerDetailFullToD1, detailFullD1Ops } = await import("../src/lib/detailFullSync");
const { upsertContainerSnapshotRows } = await import("../src/lib/snapshot/upsert");
const { default: app } = await import("../src/app");
const { handlePostDataCustomer } = await import("../src/lib/dataEntityHandlers");
async function saveCustomer(expectedDone = true) {
  const req = new Request("https://test.invalid/api/v1/data/customer", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ CustomerID: "5" })
  });
  const response = await handlePostDataCustomer({
    env: testEnv, var: { bodyBuffer: await req.arrayBuffer(), sessionStub: stub },
    req: { raw: req, header: () => undefined }
  } as Parameters<typeof handlePostDataCustomer>[0]);
  expect(response.status).toBe(200);
  const body = await response.json() as { ok: boolean; localSync: unknown };
  expect(body.ok).toBe(true);
  expect(body.localSync).toMatchObject(expectedDone ? { done: true } : { done: false, code: "sync_failed" });
  expect(JSON.stringify(body)).not.toContain(MARKER);
}
const operations = { executed: [] as string[], bindCounts: [] as number[], batches: 0 };
let beforeContainerWrite: (() => Promise<void>) | undefined;

// Observe real SQL execution rather than substituting an in-memory row store.
// The interleave hook writes a real report update immediately before the
// container INSERT executes, exposing stale read/modify/write implementations.
function recordingDb(realDb: D1Database): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const sqls = new WeakMap<D1PreparedStatement, string>();
  function statement(real: D1PreparedStatement, sql: string): D1PreparedStatement {
    const wrapped = new Proxy(real, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => {
          operations.bindCounts.push(values.length);
          return statement(target.bind(...values), sql);
        };
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if (["run", "all", "first", "raw"].includes(String(property))) {
            operations.executed.push(sql);
            if (/INSERT\s+INTO\s+container_snapshot/i.test(sql) && beforeContainerWrite) {
              const hook = beforeContainerWrite; beforeContainerWrite = undefined; await hook();
            }
          }
          return Reflect.apply(value, target, args);
        };
      }
    });
    originals.set(wrapped, real); sqls.set(wrapped, sql);
    return wrapped;
  }
  return new Proxy(realDb, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => statement(target.prepare(sql), sql);
      if (property === "batch") return async (items: D1PreparedStatement[]) => {
        const sql = items.map((item) => sqls.get(item) ?? "UNRECORDED BATCH");
        operations.executed.push(...sql); operations.batches++;
        if (sql.some((text) => /INSERT\s+INTO\s+container_snapshot/i.test(text)) && beforeContainerWrite) {
          const hook = beforeContainerWrite; beforeContainerWrite = undefined; await hook();
        }
        return target.batch(items.map((item) => originals.get(item) ?? item));
      };
      if (property === "exec") return (sql: string) => { operations.executed.push(sql); return target.exec(sql); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
const SECRET = "synthetic-report-metadata-secret";
const authStub = {
  async fetch(input: RequestInfo | URL) {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/throttle/failure") return Response.json({ blocked: false, retryAfterSec: 0 });
    if (url.pathname === "/throttle/clear") return new Response("OK");
    return unexpected("auth session");
  }
};
const testEnv = {
  ...env, TARGET_ORIGIN: "https://upstream.invalid", TARGET_BASE_PATH: "/WebRW",
  CUSTOMER_DB: recordingDb(db), CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET,
  AUTH_SESSION: { idFromName: (name: string) => name, get: () => authStub },
  SNAPSHOTS_R2_ENABLED: "false",
  SNAPSHOTS: new Proxy({}, { get: () => () => unexpected("R2") })
} as unknown as Env;
async function request(path: string, csv?: string) {
  const pending: Promise<unknown>[] = [];
  const response = await app.fetch(new Request(`https://test.invalid${path}`, {
    method: csv === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${SECRET}`, ...(csv === undefined ? {} : { "content-type": "text/csv" }) },
    body: csv
  }), testEnv, { waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {} } as ExecutionContext);
  await Promise.all(pending);
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}
const reportHeaders = [
  "UD-Cost_Share-UD", "UD-Enclosure_Doors-UD", "UD-Last_Compactor_Inspection-UD",
  "UD-Last_Enclosure_Inspection-UD", "UD-Material_Stream-UD", "ServiceCodeType", "ServiceCode_input", "ServiceDate"
];
async function importReport(values: Record<string, unknown>, timestamp: string) {
  vi.setSystemTime(timestamp);
  const csv = [
    ["ContainerID", "PickupAddressID", "Color", ...reportHeaders].join(","),
    [100, 10, "report color", ...Object.values(values).map((value) => value ?? "")].join(",")
  ].join("\n");
  return request("/api/v1/container-snapshot/import?dryRun=false", csv);
}
function resetOperations() {
  operations.executed = []; operations.bindCounts = []; operations.batches = 0;
}

function graph(ids = [100]) {
  return {
    currentCustomer: { CustomerID: 5, CompanyName: "Synthetic customer" },
    data: [{ PickupAddressID: 10, CustomerID: 5, Containers: ids.map((id) => ({
      ContainerID: id, PickupAddressID: 10, Color: "new color", SerialNumber: "new serial", Note: "new note"
    })) }]
  };
}
async function row(id = 100) {
  return db.prepare("SELECT * FROM container_snapshot WHERE container_id = ?").bind(id).first<Record<string, unknown>>();
}
async function seedReport(values: Record<string, unknown> = reportValues, timestamp = OLD, id = 100) {
  const columns = ["container_id", "pickup_address_id", "color", "serial_number", "container_note", "enabled", "synced_at", ...Object.keys(values)];
  await db.prepare(`INSERT INTO container_snapshot (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .bind(id, 10, "old color", "old serial", "old note", 1, timestamp, ...Object.values(values)).run();
}
const savedConsole = { error: console.error, warn: console.warn, log: console.log, info: console.info };
beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  state.detail = graph();
  state.unexpected = [];
  state.logs = [];
  cacheEntries.clear(); deletedKeys.length = 0;
  beforeContainerWrite = undefined;
  resetOperations();
  vi.stubGlobal("fetch", async () => unexpected("network"));
  for (const level of ["error", "warn", "log", "info"] as const) console[level] = (...args: unknown[]) => { state.logs.push(args); };
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("DELETE FROM customer_snapshot_erasure_address"),
    db.prepare("DELETE FROM customer_snapshot_erasure"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (5, 'Synthetic customer', 1, ?)").bind(OLD),
    db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, enabled, synced_at) VALUES (10, 5, 1, ?)").bind(OLD)
  ]);
});
afterEach(() => {
  vi.useRealTimers();
  Object.assign(console, savedConsole);
  expect(state.unexpected).toEqual([]);
  for (const value of [MARKER, SECRET, ...Object.values(reportValues), "new color", "new serial", "new note"]) {
    expect(JSON.stringify(state.logs)).not.toContain(value);
  }
});
afterAll(() => { vi.unstubAllGlobals(); });

describe("detail-full report-only container metadata acceptance", () => {
  it("preserves all eight seeded report-only values while refreshing supported fields", async () => {
    await seedReport();
    expect(await row()).toMatchObject(reportValues);
    await syncCustomerDetailFullToD1(testEnv, stub, 5);
    const actual = await row();
    // Soft assertions expose every lost column in the baseline reproduction.
    for (const [column, value] of Object.entries(reportValues)) expect.soft(actual?.[column], column).toBe(value);
    expect(actual).toMatchObject({ color: "new color", serial_number: "new serial", container_note: "new note", synced_at: NOW });
  });

  it("inserts unavailable report-only fields as null, without inventing values from unrelated detail fields", async () => {
    await syncCustomerDetailFullToD1(testEnv, stub, 5);
    expect(await row()).toMatchObject({ ...nullReport, color: "new color", serial_number: "new serial", container_note: "new note", synced_at: NOW });
    const mapped = mapDetailFullToRows(state.detail).containers[0]!;
    expect(mapped).toMatchObject({
      udCostShareUd: null, udEnclosureDoorsUd: null, udLastCompactorInspectionUd: null,
      udLastEnclosureInspectionUd: null, udMaterialStreamUd: null,
      serviceCodeType: null, serviceCodeInput: null, serviceDate: null
    });
  });

  it("keeps existing null report values null while allowing supported fields to clear", async () => {
    await seedReport(nullReport);
    const full = graph();
    Object.assign(full.data[0]!.Containers[0]!, { Color: null, SerialNumber: null, Note: null });
    state.detail = full;
    await syncCustomerDetailFullToD1(testEnv, stub, 5);
    expect(await row()).toMatchObject({ ...nullReport, color: null, serial_number: null, container_note: null, synced_at: NOW });
  });

  it.each([
    ["older", LATER, "old color", LATER],
    ["equal", NOW, "new color", NOW],
    ["newer", OLD, "new color", NOW]
  ])("%s incoming refresh respects the timestamp guard without changing report values", async (_name, stored, color, timestamp) => {
    await seedReport(reportValues, stored);
    const before = await row();
    await syncCustomerDetailFullToD1(testEnv, stub, 5);
    expect(await row()).toMatchObject({ ...reportValues, color, synced_at: timestamp });
    if (stored === LATER) expect(await row()).toEqual(before);
  });

  it("does not normalize existing empty, zero-string or null report-only values during refresh", async () => {
    const mixed = { ...reportValues, ud_cost_share_ud: "", ud_enclosure_doors_ud: "0", service_code_input: null, service_date: null };
    await seedReport(mixed);
    await syncCustomerDetailFullToD1(testEnv, stub, 5);
    expect(await row()).toMatchObject({ ...mixed, color: "new color", synced_at: NOW });
  });

  it("refuses malformed graph identity without writes or fixture values in the save problem", async () => {
    await seedReport();
    const before = await row();
    const full = graph();
    Object.assign(full.data[0]!.Containers[0]!, { ContainerID: `100${MARKER}`, Note: MARKER });
    state.detail = full;
    resetOperations();
    await saveCustomer(false);
    expect(await row()).toEqual(before);
    expect(operations.executed.filter((sql) => /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql))).toEqual([]);
  });

  it("later authoritative CSV imports replace then deliberately clear all eight values", async () => {
    await seedReport();
    await syncCustomerDetailFullToD1(testEnv, stub, 5);
    const replacement = Object.fromEntries(Object.entries(reportValues).map(([key, value]) => [key, `${value}_report`]));
    await importReport(replacement, LATER);
    expect(await row()).toMatchObject({ ...replacement, color: "report color", synced_at: LATER });
    await importReport(nullReport, "2032-01-01T00:00:00.000Z");
    expect(await row()).toMatchObject({ ...nullReport, color: "report color", synced_at: "2032-01-01T00:00:00.000Z" });
  });

  it("default upsert callers remain authoritative for explicit nulls", async () => {
    await seedReport();
    // Mapping creates the unavailable nulls, but ordinary callers must still
    // apply those nulls. Preservation is not a new global upsert default.
    const incoming = mapDetailFullToRows(graph()).containers;
    await upsertContainerSnapshotRows(db, incoming, 50, NOW);
    expect(await row()).toMatchObject({ ...nullReport, color: "new color", synced_at: NOW });
  });

  it("does not lose a concurrent report update committed immediately before the detail-full write", async () => {
    await seedReport();
    const concurrent = Object.fromEntries(Object.entries(reportValues).map(([key, value]) => [key, `${value}_concurrent`]));
    beforeContainerWrite = async () => {
      await db.prepare(`UPDATE container_snapshot SET ${Object.keys(concurrent).map((column) => `${column} = ?`).join(",")}, synced_at = ? WHERE container_id = 100`)
        .bind(...Object.values(concurrent), NOW).run();
    };
    await syncCustomerDetailFullToD1(testEnv, stub, 5);
    expect(beforeContainerWrite).toBeUndefined();
    expect(await row()).toMatchObject({ ...concurrent, color: "new color", synced_at: NOW });
  });

  it("flat and warm hydrated reads retain metadata and publish supported save changes after graph eviction", async () => {
    await seedReport();
    await seedReport(reportValues, OLD, 101);
    const before = await request("/api/v1/data/container?id=100");
    expect(before.container).toMatchObject({ ...reportValues, color: "old color" });
    expect(cacheEntries.has(cacheKey("container", 100))).toBe(true);
    // A removed child's warm cache must be evicted together with retained rows.
    await request("/api/v1/data/container?id=101");
    await saveCustomer();
    expect(deletedKeys).toEqual(expect.arrayContaining([
      cacheKey("customer", 5), cacheKey("address", 10), cacheKey("container", 100), cacheKey("container", 101)
    ]));
    expect(cacheEntries.has(cacheKey("container", 100))).toBe(false);
    expect(cacheEntries.has(cacheKey("container", 101))).toBe(false);
    expect(await row(101)).toBeNull();
    const flat = await request("/api/v1/container-snapshot/100");
    const hydrated = await request("/api/v1/data/container?id=100");
    const want = { ...reportValues, color: "new color", serial_number: "new serial", container_note: "new note", synced_at: NOW };
    expect.soft(flat).toMatchObject(want);
    expect(hydrated.container).toMatchObject(want);
    expect(hydrated.address).toMatchObject({ pickup_address_id: 10, customer_id: 5 });
    expect(hydrated.customer).toMatchObject({ customer_id: 5 });
  });

  it.each([1, 51])("refreshes %s containers within existing batch/bind budgets without per-container SELECTs", async (count) => {
    const ids = Array.from({ length: count }, (_, index) => 100 + index);
    for (const id of ids) await seedReport(reportValues, OLD, id);
    state.detail = graph(ids);
    resetOperations();
    await syncCustomerDetailFullToD1(testEnv, stub, 5);
    const expectedBatches = count === 1 ? 4 : 5;
    expect(operations.batches).toBe(expectedBatches);
    expect(detailFullD1Ops(1, count)).toBe(expectedBatches);
    expect(operations.executed).toHaveLength(count === 1 ? 5 : 22);
    expect(Math.max(...operations.bindCounts)).toBeLessThanOrEqual(100);
    // Baseline reconciliation obtains deleted ids through DELETE RETURNING,
    // not a SELECT. Recovering unavailable values must not add container reads.
    const containerReads = operations.executed.filter((sql) => /^\s*(?:SELECT|WITH)\b/i.test(sql) && /\bcontainer_snapshot\b/i.test(sql));
    expect(containerReads).toEqual([]);
    for (const id of ids) expect.soft(await row(id), `container ${id}`).toMatchObject({ ...reportValues, color: "new color", synced_at: NOW });
  });

  it("repeated equal-timestamp refreshes are idempotent without erasing report metadata", async () => {
    await seedReport();
    await syncCustomerDetailFullToD1(testEnv, stub, 5);
    const first = await row();
    await syncCustomerDetailFullToD1(testEnv, stub, 5);
    expect(await row()).toEqual(first);
    expect(await row()).toMatchObject({ ...reportValues, synced_at: NOW });
  });
});
