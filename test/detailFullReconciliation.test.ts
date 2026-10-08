import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { ensureD1TestTables } from "./d1TestMigrations";

const state = vi.hoisted(() => ({
  detail: {} as Record<string, unknown>,
  invalidated: [] as Array<{ customerId: number; addressIds: number[]; containerIds: number[] }>,
  report: undefined as (() => Promise<Response>) | undefined
}));
vi.mock("../src/lib/sessionState", () => ({ readSessionState: async () => ({
  cookieHeader: ".WebRW=SYNTHETIC-RECONCILIATION-NOT-A-CREDENTIAL",
  expiresAtMs: Date.now() + 60_000,
  refreshing: false
}) }));
vi.mock("../src/lib/establishSession", () => ({ establishSession: async () => {
  throw new Error("Unexpected login in reconciliation test");
} }));
vi.mock("../src/lib/upstreamForward", () => ({
  forwardToUpstream: async (_req: Request, url: URL) => {
    if (!url.pathname.endsWith("/Customer/GetCustomerDetailFull")) {
      throw new Error("Unexpected upstream URL in reconciliation test");
    }
    return Response.json(state.detail);
  }
}));
vi.mock("../src/lib/customerSaveAutoToken", () => ({
  prepareSaveCustomerLongFormBody: async (_env: Env, _session: unknown, _req: Request, body: ArrayBuffer) => body,
  // TOG-8149: the handlers evict the rejected token on the silent-failure
  // path; this double carries no cache, so the evict is a no-op.
  evictAntiForgeryTokenCacheForBody: () => false
}));
vi.mock("../src/lib/forwardWithSessionRetry", () => ({
  forwardWithSessionRetry: async () => new Response("true")
}));
vi.mock("../src/lib/entityDataCache", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/entityDataCache")>(),
  invalidateCustomerGraphWithRetry: async (graph: typeof state.invalidated[number]) => {
    state.invalidated.push(graph);
  }
}));
vi.mock("../src/lib/routewareQueryReportCsv", () => ({
  fetchReportCsvByQueryId: async () => {
    if (!state.report) throw new Error("Unexpected report request");
    return state.report();
  }
}));
vi.mock("../src/lib/snapshot/reportFetch", () => ({
  fetchReportCsvForPath: async () => {
    if (!state.report) throw new Error("Unexpected report request");
    return state.report();
  }
}));

import { handlePostDataCustomer } from "../src/lib/dataEntityHandlers";
import { mapDetailFullToRows, syncCustomerDetailFullToD1 } from "../src/lib/detailFullSync";
import { upsertAddressSnapshotRows, upsertContainerSnapshotRows, upsertCustomerSnapshotRows } from "../src/lib/snapshot/upsert";
import { runAddressSnapshotSync, runContainerSnapshotSync, runCustomerSnapshotSync } from "../src/lib/snapshot/orchestration";

const OLD = "2000-01-01T00:00:00.000Z";
const START = "2030-01-01T00:00:00.000Z";
const POST = "2030-01-01T00:00:01.000Z";
const DOWNLOAD = "2030-01-01T00:00:02.000Z";
const db = env.CUSTOMER_DB;
const testEnv = {
  ...env,
  TARGET_ORIGIN: "https://routeware.example.test",
  TARGET_BASE_PATH: "/WebRW",
  SNAPSHOTS_R2_ENABLED: "false"
} as unknown as Env;
const stub = {} as DurableObjectStub;

function graph(customerId: number, addresses: Array<[number, number[]]>) {
  return {
    currentCustomer: { CustomerID: customerId, CompanyName: "Synthetic customer" },
    data: addresses.map(([id, containers]) => ({
      PickupAddressID: id, CustomerID: customerId,
      Containers: containers.map((containerId) => ({ ContainerID: containerId }))
    }))
  };
}

async function seed(full: ReturnType<typeof graph>, timestamp = OLD) {
  const { customer, addresses, containers } = mapDetailFullToRows(full);
  await upsertCustomerSnapshotRows(db, [customer], 80, timestamp);
  await upsertAddressSnapshotRows(db, addresses, 80, timestamp);
  await upsertContainerSnapshotRows(db, containers, 50, timestamp);
}

async function post(customerId = 5) {
  const req = new Request("https://test.local/api/v1/data/customer", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ CustomerID: String(customerId) })
  });
  const response = await handlePostDataCustomer({
    env: testEnv,
    var: { bodyBuffer: await req.arrayBuffer(), sessionStub: stub },
    req: { raw: req, header: () => undefined }
  } as Parameters<typeof handlePostDataCustomer>[0]);
  expect(response.status).toBe(200);
  const body = await response.json() as { localSync: { done: boolean } };
  expect(body.localSync.done).toBe(true);
}

async function ids(table: string, column: string) {
  const rows = await db.prepare(`SELECT ${column} AS id FROM ${table} ORDER BY ${column}`).all<{ id: number }>();
  return rows.results.map((r) => r.id);
}

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  state.invalidated = [];
  state.report = undefined;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  await seed(graph(5, [[10, [100, 101]], [11, [110]]]));
  await seed(graph(6, [[20, [200]]]));
});
afterEach(() => vi.useRealTimers());

describe("write-through customer reconciliation", () => {
  it("POST removes missing children and their cache ids without touching another customer", async () => {
    state.detail = graph(5, [[10, [100]]]);
    await post();
    expect(await ids("address_snapshot", "pickup_address_id")).toEqual([10, 20]);
    expect(await ids("container_snapshot", "container_id")).toEqual([100, 200]);
    expect(state.invalidated).toEqual([{
      customerId: 5, addressIds: [10, 11], containerIds: [100, 101, 110]
    }]);
  });

  it("an explicitly empty graph removes the last children, containers before addresses", async () => {
    state.detail = graph(5, []);
    await post();
    expect(await ids("address_snapshot", "pickup_address_id")).toEqual([20]);
    expect(await ids("container_snapshot", "container_id")).toEqual([200]);
    expect(state.invalidated[0].addressIds).toEqual([10, 11]);
    expect(state.invalidated[0].containerIds).toEqual([100, 101, 110]);
  });

  it.each([
    { currentCustomer: { CustomerID: 5 } },
    { currentCustomer: { CustomerID: 5 }, data: [null] },
    { currentCustomer: { CustomerID: 5 }, data: [{ PickupAddressID: 10, CustomerID: 5, Containers: {} }] },
    { currentCustomer: { CustomerID: 5 }, data: [{ PickupAddressID: 10, CustomerID: 5, Containers: [null] }] },
    graph(6, []),
    { currentCustomer: { CustomerID: 5 }, data: [{ PickupAddressID: 10, CustomerID: 6 }] },
    { currentCustomer: { CustomerID: 5 }, data: [{ PickupAddressID: 10, CustomerID: 5, Containers: [{ ContainerID: 100, PickupAddressID: 20 }] }] }
  ])("rejects a malformed or mismatched graph before any D1 changes (%#)", async (detail) => {
    state.detail = detail;
    await expect(syncCustomerDetailFullToD1(testEnv, stub, 5)).rejects.toThrow(/GetCustomerDetailFull/);
    expect(await ids("address_snapshot", "pickup_address_id")).toEqual([10, 11, 20]);
    expect(await ids("container_snapshot", "container_id")).toEqual([100, 101, 110, 200]);
    expect(await db.prepare("SELECT synced_at FROM customer_snapshot WHERE customer_id = 5").first("synced_at")).toBe(OLD);
  });

  it("keeps a later child update while deleting genuinely stale siblings", async () => {
    await seed(graph(5, [[11, [110]]]), POST);
    state.detail = graph(5, [[10, [100]]]);
    await post();
    expect(await ids("address_snapshot", "pickup_address_id")).toEqual([10, 11, 20]);
    expect(await ids("container_snapshot", "container_id")).toEqual([100, 110, 200]);
  });
});

const tables = [
  { table: "customer_snapshot", id: "customer_id", freshId: 7, run: runCustomerSnapshotSync,
    query: "CUSTOMER_REPORT_QUERY_ID", path: "CUSTOMER_REPORT_EXPORT_PATH", csv: "CustomerID,CompanyName\n5,Old export\n" },
  { table: "address_snapshot", id: "pickup_address_id", freshId: 70, run: runAddressSnapshotSync,
    query: "ADDRESS_REPORT_QUERY_ID", path: "ADDRESS_REPORT_EXPORT_PATH", csv: "PickupAddressID,CustomerID\n10,5\n" },
  { table: "container_snapshot", id: "container_id", freshId: 700, run: runContainerSnapshotSync,
    query: "CONTAINER_REPORT_QUERY_ID", path: "CONTAINER_REPORT_EXPORT_PATH", csv: "ContainerID,PickupAddressID\n100,10\n" }
];

describe.each(tables)("$table report/POST race", ({ table, id, freshId, run, query, path, csv }) => {
  beforeEach(async () => {
    // Stale parents must be leaves for a single-table cron delete. Real D1
    // enforces these FKs; the detail refresh test above covers graph deletion.
    if (table !== "container_snapshot") await db.prepare("DELETE FROM container_snapshot").run();
    if (table === "customer_snapshot") await db.prepare("DELETE FROM address_snapshot").run();
  });

  it.each(["query", "path"])("preserves a POST-created row while an older %s export is in flight", async (mode) => {
    let release!: (response: Response) => void;
    state.report = () => new Promise<Response>((resolve) => { release = resolve; });
    const pending = run({ ...testEnv, [query]: mode === "query" ? "23" : "", [path]: "/export" });
    vi.setSystemTime(POST);
    state.detail = graph(7, [[70, [700]]]);
    await post(7);
    // The old export omits every new id and returns only after POST has finished.
    vi.setSystemTime(DOWNLOAD);
    release(new Response(csv));
    const result = await pending;
    expect(result?.deleted).toBeGreaterThan(0);
    expect(await db.prepare(`SELECT synced_at FROM ${table} WHERE ${id} = ?`).bind(freshId).first("synced_at")).toBe(POST);
  });

  it("does not overwrite a newer POST row with older report contents or timestamps", async () => {
    let release!: (response: Response) => void;
    state.report = () => new Promise<Response>((resolve) => { release = resolve; });
    const pending = run({ ...testEnv, [query]: "23" });
    vi.setSystemTime(POST);
    state.detail = graph(5, [[10, [100]]]);
    await post();
    vi.setSystemTime(DOWNLOAD);
    release(new Response(csv));
    await pending;
    const retainedId = table === "customer_snapshot" ? 5 : table === "address_snapshot" ? 10 : 100;
    expect(await db.prepare(`SELECT synced_at FROM ${table} WHERE ${id} = ?`).bind(retainedId).first("synced_at")).toBe(POST);
    expect(await db.prepare("SELECT company_name FROM customer_snapshot WHERE customer_id = 5").first("company_name")).toBe("Synthetic customer");
  });
});
