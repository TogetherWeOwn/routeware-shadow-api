import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { ensureD1TestTables } from "./d1TestMigrations";

// Acceptance boundary: a confirmed save followed by a real detail-full sync,
// real upserts/reconciliation and real cache invalidation. Only network/session
// acquisition and the external Cache API are replaced. No implementation diff
// or numeric parsing helper is used to derive the cases or expected rows.
const state = vi.hoisted(() => ({
  detail: {} as unknown,
  saves: 0,
  refreshes: 0,
  unexpected: [] as string[],
  puts: [] as string[],
  deletes: [] as string[],
  entries: new Set<string>(),
  logs: [] as unknown[][]
}));

function unexpected(kind: string): never {
  state.unexpected.push(kind);
  throw new Error("Unexpected request in identity acceptance fixture");
}

vi.mock("../src/lib/sessionState", () => ({ readSessionState: async () => null }));
vi.mock("../src/lib/establishSession", () => ({ establishSession: async () => unexpected("login") }));
vi.mock("../src/lib/upstreamForward", () => ({
  forwardToUpstream: async (req: Request, url: URL, _session: unknown, body: ArrayBuffer | null) => {
    if (req.method !== "POST" || url.toString() !== "https://upstream.invalid/WebRW/Customer/GetCustomerDetailFull" ||
        !body || new TextDecoder().decode(body) !== '{"customerID":5,"showDisabled":true}') {
      return unexpected("detail-full request");
    }
    state.refreshes++;
    return Response.json(state.detail);
  }
}));
vi.mock("../src/lib/customerSaveAutoToken", () => ({
  prepareSaveCustomerLongFormBody: async (_env: Env, _stub: unknown, _req: Request, body: ArrayBuffer) => body,
  evictAntiForgeryTokenCacheForBody: () => false
}));
vi.mock("../src/lib/forwardWithSessionRetry", () => ({
  forwardWithSessionRetry: async (_env: Env, _stub: unknown, req: Request, url: URL) => {
    if (req.method !== "POST" || url.toString() !== "https://upstream.invalid/WebRW/Customer/SaveCustomerLongForm") {
      return unexpected("save request");
    }
    state.saves++;
    return new Response("true");
  }
}));

const key = (kind: string, id: number) => `https://routeware-shadow-entity/v1/${kind}/${id}`;
const cache = {
  async match() { return undefined; },
  async put(request: Request) { state.puts.push(request.url); state.entries.add(request.url); },
  async delete(request: Request) { state.deletes.push(request.url); return state.entries.delete(request.url); }
};
// entityDataCache captures caches.default when imported; keep its real logic.
// The worker entrypoint may already have imported it while the pool started.
vi.resetModules();
vi.stubGlobal("caches", { default: cache });
const { handlePostDataCustomer } = await import("../src/lib/dataEntityHandlers");
const { mapDetailFullToRows, syncCustomerDetailFullToD1 } = await import("../src/lib/detailFullSync");

const OLD = "2000-01-01T00:00:00.000Z";
const NOW = "2030-01-01T00:00:00.000Z";
const MARKER = "SYNTHETIC_GRAPH_VALUE_MUST_NOT_ESCAPE";
const realDb = env.CUSTOMER_DB;
const stub = {} as DurableObjectStub;
const executed: string[] = [];

// Execute against local test D1, recording mutation attempts as well as checking
// final rows. A rollback, no-op upsert or failed FK cannot hide a prevalidation
// write. Preparing a statement is not itself a write.
function recordingDb(db: D1Database): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const sqls = new WeakMap<D1PreparedStatement, string>();
  function statement(real: D1PreparedStatement, sql: string): D1PreparedStatement {
    const wrapped = new Proxy(real, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => statement(target.bind(...values), sql);
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          if (["run", "all", "first", "raw"].includes(String(property))) executed.push(sql);
          return Reflect.apply(value, target, args);
        };
      }
    });
    originals.set(wrapped, real);
    sqls.set(wrapped, sql);
    return wrapped;
  }
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => statement(target.prepare(sql), sql);
      if (property === "batch") return (items: D1PreparedStatement[]) => {
        executed.push(...items.map((item) => sqls.get(item) ?? "UNRECORDED BATCH"));
        return target.batch(items.map((item) => originals.get(item) ?? item));
      };
      if (property === "exec") return (sql: string) => { executed.push(sql); return target.exec(sql); };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
const testEnv = {
  ...env,
  CUSTOMER_DB: recordingDb(realDb),
  TARGET_ORIGIN: "https://upstream.invalid",
  TARGET_BASE_PATH: "/WebRW",
  SNAPSHOTS_R2_ENABLED: "false"
} as unknown as Env;

type Item = Record<string, unknown>;
type Graph = { currentCustomer: Item; data: Item[] };
function graph(): Graph {
  return {
    currentCustomer: { CustomerID: 5, CompanyName: MARKER },
    data: [
      { PickupAddressID: 10, CustomerID: 5, Address: MARKER, Containers: [{ ContainerID: 100, SerialNumber: MARKER }] },
      { PickupAddressID: 11, CustomerID: 5, Containers: [{ ContainerID: 110, PickupAddressID: 11 }] }
    ]
  };
}
function address(full: Graph): Item { return full.data[0]!; }
function container(full: Graph): Item { return (address(full).Containers as Item[])[0]!; }

type Field = { name: string; primary: string; alias: string; id: number; item: (full: Graph) => Item };
const fields: Field[] = [
  { name: "customer primary", primary: "CustomerID", alias: "customerID", id: 5, item: (full) => full.currentCustomer },
  { name: "address primary", primary: "PickupAddressID", alias: "pickupAddressID", id: 10, item: address },
  { name: "address owner", primary: "CustomerID", alias: "customerID", id: 5, item: address },
  { name: "container primary", primary: "ContainerID", alias: "containerID", id: 100, item: container },
  { name: "container parent", primary: "PickupAddressID", alias: "pickupAddressID", id: 10, item: container }
];
const invalidValues: Array<{ name: string; value: (id: number) => unknown }> = [
  { name: "prefix", value: (id) => `${id}${MARKER}` },
  { name: "fraction string", value: (id) => `${id}.5` },
  { name: "integer decimal string", value: (id) => `${id}.0` },
  { name: "exponent string", value: (id) => `${id}e0` },
  { name: "hex string", value: (id) => `0x${id.toString(16)}` },
  { name: "leading whitespace", value: (id) => ` ${id}` },
  { name: "trailing whitespace", value: (id) => `${id} ` },
  { name: "plus sign", value: (id) => `+${id}` },
  { name: "fraction number", value: (id) => id + 0.5 },
  { name: "zero number", value: () => 0 },
  { name: "zero string", value: () => "0" },
  { name: "negative number", value: () => -1 },
  { name: "negative string", value: () => "-1" },
  { name: "unsafe number", value: () => Number.MAX_SAFE_INTEGER + 1 },
  { name: "unsafe string", value: () => "9007199254740993" },
  { name: "empty string", value: () => "" },
  { name: "boolean", value: () => true },
  { name: "array", value: (id) => [id] },
  { name: "object", value: () => ({ value: MARKER }) },
  { name: "null", value: () => null }
];

type InvalidCase = { name: string; make: () => unknown };
const invalidCases: InvalidCase[] = fields.flatMap((field) => [
  ...[field.primary, field.alias].flatMap((spelling) => invalidValues.map((invalid) => ({
    name: `${field.name} ${spelling}: ${invalid.name}`,
    make() {
      const full = graph();
      const item = field.item(full);
      delete item[field.primary];
      item[spelling] = invalid.value(field.id);
      return full;
    }
  }))),
  ...[
    { name: "conflicting valid alias", value: field.id + 1 },
    { name: "malformed shadowed alias", value: `${field.id}${MARKER}` },
    { name: "null shadowed alias", value: null }
  ].map(({ name, value }) => ({
    name: `${field.name}: ${name}`,
    make() {
      const full = graph();
      field.item(full)[field.primary] = field.id;
      field.item(full)[field.alias] = value;
      return full;
    }
  })),
  ...["conflicting", "malformed"].map((kind) => ({
    name: `${field.name}: ${kind} primary with valid alias`,
    make() {
      const full = graph();
      field.item(full)[field.primary] = kind === "conflicting" ? field.id + 1 : `${field.id}${MARKER}`;
      field.item(full)[field.alias] = field.id;
      return full;
    }
  }))
]);
const graphCases: InvalidCase[] = [
  { name: "duplicate address", make: () => { const full = graph(); full.data.push({ PickupAddressID: 10, CustomerID: 5, Containers: [] }); return full; } },
  { name: "numeric/string duplicate address", make: () => { const full = graph(); full.data.push({ PickupAddressID: "0010", CustomerID: "5", Containers: [] }); return full; } },
  { name: "duplicate container in one address", make: () => { const full = graph(); (address(full).Containers as Item[]).push({ ContainerID: 100 }); return full; } },
  { name: "duplicate container across addresses", make: () => { const full = graph(); full.data[1]!.Containers = [{ ContainerID: "00100" }]; return full; } },
  { name: "explicit parent is another address in the same graph", make: () => { const full = graph(); container(full).PickupAddressID = 11; return full; } },
  { name: "alias parent is another address in the same graph", make: () => { const full = graph(); container(full).pickupAddressID = "11"; return full; } },
  { name: "parent exists only in another local customer's graph", make: () => { const full = graph(); container(full).PickupAddressID = 20; return full; } },
  { name: "address belongs to another customer", make: () => { const full = graph(); address(full).CustomerID = 6; return full; } },
  { name: "response belongs to another customer", make: () => { const full = graph(); full.currentCustomer.CustomerID = 6; return full; } },
  ...["currentCustomer", "data"].map((field) => ({ name: `missing ${field}`, make: () => { const full: Item = graph(); delete full[field]; return full; } })),
  ...[null, {}, MARKER].map((value, index) => ({ name: `malformed address collection ${index}`, make: () => ({ currentCustomer: { CustomerID: 5 }, data: value }) })),
  ...[null, MARKER, 0].map((value, index) => ({ name: `malformed address member ${index}`, make: () => { const full = graph(); full.data.push(value as unknown as Item); return full; } })),
  ...[null, {}, MARKER].map((value, index) => ({ name: `malformed container collection ${index}`, make: () => { const full = graph(); address(full).Containers = value; return full; } })),
  ...[null, MARKER, 0].map((value, index) => ({ name: `malformed container member ${index}`, make: () => { const full = graph(); (address(full).Containers as unknown[]).push(value); return full; } })),
  ...fields.filter((field) => field.name !== "container parent").map((field) => ({ name: `missing ${field.name}`, make: () => { const full = graph(); delete field.item(full)[field.primary]; return full; } }))
];

async function snapshot() {
  return Promise.all([
    realDb.prepare("SELECT * FROM customer_snapshot ORDER BY customer_id").all(),
    realDb.prepare("SELECT * FROM address_snapshot ORDER BY pickup_address_id").all(),
    realDb.prepare("SELECT * FROM container_snapshot ORDER BY container_id").all()
  ]).then((tables) => tables.map((table) => table.results));
}
let before: Awaited<ReturnType<typeof snapshot>>;
const savedConsole = { error: console.error, warn: console.warn, log: console.log, info: console.info };

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", async () => unexpected("network"));
  for (const level of ["error", "warn", "log", "info"] as const) console[level] = (...args: unknown[]) => { state.logs.push(args); };
  state.detail = graph();
  state.saves = 0;
  state.refreshes = 0;
  state.unexpected = [];
  state.logs = [];
  state.puts = [];
  state.deletes = [];
  state.entries = new Set([
    key("customer", 5), key("customer", 6), key("address", 10), key("address", 11), key("address", 20),
    key("container", 100), key("container", 101), key("container", 110), key("container", 200)
  ]);
  await realDb.batch([
    realDb.prepare("DELETE FROM container_snapshot"),
    realDb.prepare("DELETE FROM address_snapshot"),
    realDb.prepare("DELETE FROM customer_snapshot"),
    realDb.prepare("DELETE FROM customer_snapshot_erasure_address"),
    realDb.prepare("DELETE FROM customer_snapshot_erasure"),
    ...[5, 6].map((id) => realDb.prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (?, 'Seed customer', 1, ?)").bind(id, OLD)),
    ...[[10, 5], [11, 5], [20, 6]].map(([id, owner]) => realDb.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, address, enabled, synced_at) VALUES (?, ?, 'Seed address', 1, ?)").bind(id, owner, OLD)),
    ...[[100, 10], [101, 10], [110, 11], [200, 20]].map(([id, parent]) => realDb.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, serial_number, enabled, synced_at) VALUES (?, ?, 'Seed container', 1, ?)").bind(id, parent, OLD))
  ]);
  before = await snapshot();
  executed.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  Object.assign(console, savedConsole);
  expect(state.unexpected).toEqual([]);
});
afterAll(() => { vi.unstubAllGlobals(); });

async function post() {
  const req = new Request("https://test.invalid/api/v1/data/customer", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ CustomerID: "5" })
  });
  const response = await handlePostDataCustomer({
    env: testEnv, var: { bodyBuffer: await req.arrayBuffer(), sessionStub: stub },
    req: { raw: req, header: () => undefined }
  } as Parameters<typeof handlePostDataCustomer>[0]);
  const body = await response.json() as { ok: boolean; localSync: unknown };
  return { response, body };
}
function expectNoLeak(value: unknown) {
  expect.soft(JSON.stringify(value)).not.toContain(MARKER);
}

// Removing any identity/shape/duplicate/enclosing-parent guard must fail here.
// Every case checks the real handler's fixed classification AND its durable
// effects; an upstream save is not rolled back or retried on refresh refusal.
describe("detail-full identity acceptance: invalid graphs", () => {
  it.each([...invalidCases, ...graphCases].map(({ name, make }) => [name, make] as const))(
    "%s refuses before the first write", async (_name, make) => {
    state.detail = make();
    const { response, body } = await post();
    expect.soft(response.status).toBe(200);
    expect.soft(body.ok).toBe(true);
    expect.soft(body.localSync).toEqual({ done: false, code: "sync_failed" });
    expect.soft(state.saves).toBe(1);
    expect.soft(state.refreshes).toBe(1);
    expect.soft(executed.filter((sql) => /\b(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(sql))).toEqual([]);
    expect.soft(await snapshot()).toEqual(before);
    expect.soft(state.puts).toEqual([]);
    // Single-customer fallback eviction remains valid, not a graph publication.
    expect.soft(state.deletes.filter((url) => url !== key("customer", 5))).toEqual([]);
    expectNoLeak(body);
    expectNoLeak(state.logs);
  });

  it.each([
    { name: "malformed primary", make: () => { const full = graph(); container(full).ContainerID = `100${MARKER}`; return full; } },
    { name: "duplicate", make: graphCases[0]!.make },
    { name: "intra-graph parent", make: graphCases[4]!.make }
  ].map(({ name, make }) => [name, make] as const))("direct sync propagates a safe refusal for %s", async (_name, make) => {
    state.detail = make();
    const result = await syncCustomerDetailFullToD1(testEnv, stub, 5).then(
      () => null, (error: unknown) => error
    );
    expect.soft(result).toBeInstanceOf(Error);
    expectNoLeak(result instanceof Error ? { ...result, message: result.message } : result);
    expectNoLeak(state.logs);
    expect.soft(executed.filter((sql) => /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql))).toEqual([]);
    expect.soft(await snapshot()).toEqual(before);
    expect.soft(state.puts).toEqual([]);
    expect.soft(state.deletes).toEqual([]);
    expect(state.refreshes).toBe(1);
    expect(state.saves).toBe(0);
  });
});

const validCases = [
  { name: "positive numeric identities and inherited parent", change: (_full: Graph) => {} },
  { name: "digit-only string identities", change: (full: Graph) => { for (const field of fields) field.item(full)[field.primary] = String(field.id); } },
  { name: "zero-padded decimal identities", change: (full: Graph) => { for (const field of fields) field.item(full)[field.primary] = `00${field.id}`; } },
  { name: "recognized alternate spellings", change: (full: Graph) => { for (const field of fields) { const item = field.item(full); delete item[field.primary]; item[field.alias] = String(field.id); } } },
  { name: "equivalent supplied aliases", change: (full: Graph) => { for (const field of fields) field.item(full)[field.alias] = `00${field.id}`; } },
  { name: "tolerant non-identity fields", change: (full: Graph) => { full.currentCustomer.CustomerTypeID = "2legacy"; address(full).RouteID = "3legacy"; container(full).ContainerTypeID = "4legacy"; } }
];

describe("detail-full identity acceptance: valid controls", () => {
  it.each(validCases.map(({ name, change }) => [name, change] as const))(
    "%s still refreshes, reconciles and evicts the full graph", async (_name, change) => {
    const full = graph();
    change(full);
    state.detail = full;
    const { response, body } = await post();
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.localSync).toMatchObject({ done: true, customerId: 5, addressIds: [10, 11], containerIds: expect.arrayContaining([100, 101, 110]) });
    const rows = await snapshot();
    expect(rows[0]).toEqual([expect.objectContaining({ customer_id: 5, company_name: MARKER, synced_at: NOW }), before[0]![1]]);
    expect(rows[1]).toEqual([expect.objectContaining({ pickup_address_id: 10, customer_id: 5, synced_at: NOW }), expect.objectContaining({ pickup_address_id: 11, customer_id: 5, synced_at: NOW }), before[1]![2]]);
    expect(rows[2]).toEqual([expect.objectContaining({ container_id: 100, pickup_address_id: 10, synced_at: NOW }), expect.objectContaining({ container_id: 110, pickup_address_id: 11, synced_at: NOW }), before[2]![3]]);
    expect(state.entries).toEqual(new Set([key("customer", 6), key("address", 20), key("container", 200)]));
    expect(state.saves).toBe(1);
    expect(state.refreshes).toBe(1);
    expectNoLeak(state.logs);
  });

  it.each(["empty addresses", "empty containers"])("%s preserves explicit deletion semantics", async (mode) => {
    const full = graph();
    if (mode === "empty addresses") full.data = [];
    else for (const item of full.data) item.Containers = [];
    state.detail = full;
    const { body } = await post();
    expect(body.localSync).toMatchObject({ done: true });
    const rows = await snapshot();
    expect(rows[1]!.map((row) => row.pickup_address_id)).toEqual(mode === "empty addresses" ? [20] : [10, 11, 20]);
    expect(rows[2]).toEqual([before[2]![3]]);
    expect(state.entries).toEqual(new Set([key("customer", 6), key("address", 20), key("container", 200)]));
  });

  it.each([Number.MAX_SAFE_INTEGER, "9007199254740991"])(
    "accepts the largest safe integer %s and returns fresh plus deleted ids", async (id) => {
    const full = graph();
    (address(full).Containers as Item[]).push({ ContainerID: id, PickupAddressID: "10" });
    state.detail = full;
    const result = await syncCustomerDetailFullToD1(testEnv, stub, 5);
    expect(result.addressIds).toEqual([10, 11]);
    expect([...result.containerIds].sort((a, b) => a - b)).toEqual([100, 101, 110, 9007199254740991]);
    expect(await realDb.prepare("SELECT pickup_address_id FROM container_snapshot WHERE container_id = ?").bind(Number.MAX_SAFE_INTEGER).first("pickup_address_id")).toBe(10);
  });

  it("does not resurrect an erased customer or its descendants on a valid refresh", async () => {
    await realDb.batch([
      realDb.prepare("DELETE FROM container_snapshot WHERE pickup_address_id IN (10, 11)"),
      realDb.prepare("DELETE FROM address_snapshot WHERE customer_id = 5"),
      realDb.prepare("DELETE FROM customer_snapshot WHERE customer_id = 5"),
      realDb.prepare("INSERT INTO customer_snapshot_erasure (customer_id, erased_at) VALUES (5, ?)").bind(OLD)
    ]);
    await syncCustomerDetailFullToD1(testEnv, stub, 5);
    const rows = await snapshot();
    expect(rows).toEqual([[before[0]![1]], [before[1]![2]], [before[2]![3]]]);
    expect(await realDb.prepare("SELECT erased_at FROM customer_snapshot_erasure WHERE customer_id = 5").first("erased_at")).toBe(OLD);
    expect(state.refreshes).toBe(1);
    expectNoLeak(state.logs);
  });

  it("keeps tolerant read-only mapping separate from the strict write boundary", () => {
    const full = graph();
    full.currentCustomer.CustomerID = "5legacy";
    address(full).PickupAddressID = "10legacy";
    container(full).ContainerID = "100legacy";
    const rows = mapDetailFullToRows(full);
    expect(rows.customer.customerId).toBe(5);
    expect(rows.addresses[0]!.pickupAddressId).toBe(10);
    expect(rows.containers[0]!.containerId).toBe(100);
  });
});
