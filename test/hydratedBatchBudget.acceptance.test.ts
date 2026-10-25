import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Independent HTTP oracle for request-local hydrated batch budgets.
 * Catches duplicate reads (including misses), unbounded root fanout, releasing
 * a slot before nested hydration finishes, cross-request memoization, and
 * fail-fast responses that abandon in-flight work. No implementation helpers
 * are mocked/imported: only D1, Cache API and outbound network boundaries.
 * FOUR bounds root jobs, NOT nested D1 queries, graph size, or response bytes.
 * The Builder must preserve this oracle; RED is expected before implementation.
 */
const denied = vi.hoisted(() => ({ cache: 0 }));
vi.mock("../src/lib/entityDataCache", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/lib/entityDataCache")>(),
  getCachedDataEntity: () => { denied.cache++; throw new Error("Batch cache read forbidden"); },
  putCachedDataEntity: () => { denied.cache++; throw new Error("Batch cache write forbidden"); }
}));
const { default: app } = await import("../src/app");
const SECRET = "synthetic-budget-secret";
const FAILURE = "SYNTHETIC-PRIVATE-D1-FAILURE";
const PROBLEMS = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md";
const specs = [
  { kind: "customer", table: "customer_snapshot", key: "customer_id", alias: "customerId" },
  { kind: "address", table: "address_snapshot", key: "pickup_address_id", alias: "pickupAddressId" },
  { kind: "container", table: "container_snapshot", key: "container_id", alias: "containerId" }
] as const;
type Spec = typeof specs[number];
type Row = Record<string, unknown>;
type Operation = { table: string; column: string; method: "first" | "all"; params: unknown[] };
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
// A bounded microtask checkpoint, never a wall-clock/latency assertion. Held
// promises, not elapsed time, determine which D1 operations can finish.
async function checkpoint(): Promise<void> {
  for (let i = 0; i < 64; i++) await Promise.resolve();
}
function rootRow(spec: Spec, id: number): Row {
  if (spec.kind === "customer") return { customer_id: id, company_name: `Synthetic ${id}` };
  if (spec.kind === "address") return { pickup_address_id: id, customer_id: null, city: `Synthetic ${id}` };
  return { container_id: id, pickup_address_id: 1000 + id, serial_number: `Synthetic ${id}` };
}
function bundle(spec: Spec, id: number): Row {
  if (spec.kind === "customer") return { customer: rootRow(spec, id), addresses: [] };
  if (spec.kind === "address") return { address: rootRow(spec, id), customer: null, containers: [] };
  return { container: rootRow(spec, id), address: null, customer: null };
}

/** Every query is selected by table, WHERE key, operation and bound parameters.
 * Roots and their last nested read have separate controllable gates. Thus a
 * root read completing cannot masquerade as a completed hydration job.
 */
function recorder(spec: Spec, options: { held?: boolean; holdTail?: boolean; missing?: number[] } = {}) {
  const operations: Operation[] = [];
  const starts: number[] = [];
  const tails: number[] = [];
  const rootGates = new Map<number, ReturnType<typeof deferred>[]>();
  const tailGates = new Map<number, ReturnType<typeof deferred>[]>();
  const listeners: Array<{ count: number; list: number[]; gate: ReturnType<typeof deferred> }> = [];
  let releasing = !options.held;
  let active = 0;
  let peak = 0;
  function notify() {
    for (const listener of listeners) if (listener.list.length >= listener.count) listener.gate.resolve();
  }
  function reached(list: number[], count: number): Promise<void> {
    if (list.length >= count) return Promise.resolve();
    const gate = deferred();
    listeners.push({ list, count, gate });
    return gate.promise;
  }
  async function hold(map: typeof rootGates, id: number, enabled: boolean) {
    if (releasing || !enabled) return;
    const gate = deferred();
    map.set(id, [...map.get(id) ?? [], gate]);
    await gate.promise;
  }
  function release(map: typeof rootGates, id: number, fail = false) {
    const gates = map.get(id) ?? [];
    map.delete(id);
    for (const gate of gates) {
      if (fail) gate.reject(new Error(`${FAILURE} ${id}`));
      else gate.resolve();
    }
  }
  const db = {
    prepare(sql: string) {
      const match = /\bFROM\s+(customer_snapshot|address_snapshot|container_snapshot)\b/i.exec(sql);
      const where = /\bWHERE\s+([a-z_]+)\s*(?:=|IN\s*\()/i.exec(sql);
      if (!/^\s*SELECT\b/i.test(sql) || !match || !where) throw new Error(`Unexpected fixture SQL: ${sql}`);
      const table = match[1].toLowerCase();
      const column = where[1].toLowerCase();
      return { bind(...params: unknown[]) {
        async function run(method: Operation["method"]) {
          operations.push({ table, column, method, params });
          const id = Number(params[0]);
          const isRoot = table === spec.table && column === spec.key;
          if (isRoot) {
            starts.push(id);
            active++;
            peak = Math.max(peak, active);
            // Install the gate before announcing the start to the test.
            const held = hold(rootGates, id, true);
            notify();
            try { await held; } catch (error) { active--; throw error; }
            if (options.missing?.includes(id)) { active--; return null; }
            return rootRow(spec, id);
          }
          // Address hydration also looks up its (absent) customer. This is
          // not the terminal read: the root slot spans the containers query.
          if (spec.kind === "address" && table === "customer_snapshot" && column === "customer_id"
            && method === "first" && params.length === 1 && params[0] === null) return null;
          const tailId = spec.kind === "container" ? id - 1000 : id;
          const tailTable = spec.kind === "address" ? "container_snapshot" : "address_snapshot";
          const tailColumn = spec.kind === "customer" ? "customer_id" : "pickup_address_id";
          if (table !== tailTable || column !== tailColumn || params.length !== 1) {
            throw new Error(`Unexpected nested fixture query: ${JSON.stringify({ table, column, method, params })}`);
          }
          tails.push(tailId);
          const held = hold(tailGates, tailId, !!options.holdTail);
          notify();
          try { await held; } finally { active--; }
          return method === "first" ? null : [];
        }
        return {
          first: () => run("first"),
          all: async () => {
            const result = await run("all");
            return { results: Array.isArray(result) ? result : result === null ? [] : [result] };
          }
        };
      } };
    }
  } as unknown as D1Database;
  return {
    db, operations, starts, tails,
    get active() { return active; }, get peak() { return peak; },
    rootStarted: (count: number) => reached(starts, count),
    tailStarted: (count: number) => reached(tails, count),
    releaseRoot: (id: number) => release(rootGates, id),
    rejectRoot: (id: number) => release(rootGates, id, true),
    releaseTail: (id: number) => release(tailGates, id),
    rejectTail: (id: number) => release(tailGates, id, true),
    releaseAll() {
      releasing = true;
      for (const id of rootGates.keys()) release(rootGates, id);
      for (const id of tailGates.keys()) release(tailGates, id);
    }
  };
}
function appEnv(db: D1Database): Env {
  const session = { async fetch(input: RequestInfo | URL) {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === "/throttle/failure") return Response.json({ blocked: false, retryAfterSec: 0 });
    if (path === "/throttle/clear") return new Response("OK");
    throw new Error("Unexpected auth service call");
  } };
  return {
    CUSTOMER_DB: db, CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET,
    SHADOW_API_TOKEN: "synthetic-api-token", SHADOW_API_READ_TOKEN: "synthetic-read-token",
    AUTH_SESSION: { idFromName: (name: string) => name, get: () => session }
  } as unknown as Env;
}
function request(spec: Spec, db: D1Database, pairs: Array<[string, string]>, authorization = `Bearer ${SECRET}`) {
  const background: Promise<unknown>[] = [];
  // Do not await background in this function: the tests must observe whether
  // the HTTP handler itself drains hydration, not whether the harness does it.
  const response = app.fetch(new Request(`https://synthetic.example.test/api/v1/data/${spec.kind}?${new URLSearchParams(pairs)}`, {
    headers: { authorization, "if-none-match": "*", "x-request-id": "synthetic-budget-request" }
  }), appEnv(db), {
    waitUntil(promise: Promise<unknown>) { background.push(promise); }, passThroughOnException() {}
  } as ExecutionContext);
  return { response: Promise.resolve(response), background };
}
function batch(spec: Spec, db: D1Database, ids: number[]) {
  return request(spec, db, [["ids", ids.join(",")]]);
}
function expectHeaders(response: Response, status = 200) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("etag")).toBeNull();
  expect(response.headers.get("x-entity-etag")).toBeNull();
  expect(response.headers.get("content-type")).toMatch(status === 200 ? /^application\/json\b/ : /^application\/problem\+json\b/);
}
async function expectFailure(response: Response) {
  expectHeaders(response, 500);
  const text = await response.text();
  expect(text).not.toContain(FAILURE);
  expect(text).not.toMatch(/snapshot|"entries"/);
  expect(JSON.parse(text)).toEqual({
    type: `${PROBLEMS}#internal`, title: "Internal Server Error", status: 500,
    detail: "An unexpected error occurred. See Worker logs for details. See docs/PROBLEMS.md#internal.",
    requestId: "synthetic-budget-request"
  });
}
function expectRootOperations(spec: Spec, rec: ReturnType<typeof recorder>, ids: number[]) {
  expect(rec.operations.filter((op) => op.table === spec.table && op.column === spec.key)).toEqual(
    ids.map((id) => ({ table: spec.table, column: spec.key, method: "first", params: [id] }))
  );
}
const network = vi.fn(() => { throw new Error("Outbound network forbidden in batch-budget oracle"); });
const cacheCall = vi.fn(() => { throw new Error("Cache API forbidden in batch-budget oracle"); });
beforeEach(() => {
  denied.cache = 0;
  network.mockClear(); cacheCall.mockClear();
  vi.stubGlobal("fetch", network);
  vi.stubGlobal("caches", { default: { match: cacheCall, put: cacheCall, delete: cacheCall }, open: cacheCall });
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(network).not.toHaveBeenCalled();
  expect(cacheCall).not.toHaveBeenCalled();
  expect(denied.cache).toBe(0);
});

describe.each(specs)("hydrated $kind request budget", (spec) => {
  it("reads each first-occurrence ID once, including repeated misses, and reconstructs exact entries", async () => {
    const rec = recorder(spec, { missing: [99] });
    const req = batch(spec, rec.db, [2, 99, 1, 2, 99, 1]);
    const response = await req.response;
    expectHeaders(response);
    expect(await response.json()).toEqual({ entries: [
      { id: 2, found: true, [spec.kind]: bundle(spec, 2) }, { id: 99, found: false },
      { id: 1, found: true, [spec.kind]: bundle(spec, 1) },
      { id: 2, found: true, [spec.kind]: bundle(spec, 2) }, { id: 99, found: false },
      { id: 1, found: true, [spec.kind]: bundle(spec, 1) }
    ] });
    expectRootOperations(spec, rec, [2, 99, 1]);
    expect(rec.tails).toEqual([2, 1]);
    expect(req.background).toEqual([]);
  });

  it("admits four of 50 roots, and holds a slot until its nested hydration settles", async () => {
    const rec = recorder(spec, { held: true, holdTail: true });
    const ids = Array.from({ length: 50 }, (_, i) => i + 1);
    const req = batch(spec, rec.db, ids);
    let initial: number[] = [], whileNested: number[] = [], next: number[] = [];
    try {
      await rec.rootStarted(4); await checkpoint();
      initial = [...rec.starts];
      rec.releaseRoot(3);
      await rec.tailStarted(1); await checkpoint();
      whileNested = [...rec.starts];
      rec.releaseTail(3);
      await rec.rootStarted(5); await checkpoint();
      next = [...rec.starts];
    } finally { rec.releaseAll(); await req.response; }
    expect(initial).toEqual([1, 2, 3, 4]);
    expect(whileNested).toEqual([1, 2, 3, 4]);
    expect(next).toEqual([1, 2, 3, 4, 5]);
    expect(rec.peak).toBe(4);
    expect(rec.active).toBe(0);
    expectRootOperations(spec, rec, ids);
    const response = await req.response;
    expectHeaders(response);
    expect(await response.json()).toEqual({ entries: ids.map((id) => ({ id, found: true, [spec.kind]: bundle(spec, id) })) });
    expect(req.background).toEqual([]);
  });

  it.each([false, true])("uses one root slot for 50 identical IDs (missing=%s)", async (missing) => {
    const rec = recorder(spec, { held: true, missing: missing ? [7] : [] });
    const req = batch(spec, rec.db, Array(50).fill(7));
    let initial: number[] = [];
    try { await rec.rootStarted(1); await checkpoint(); initial = [...rec.starts]; }
    finally { rec.releaseAll(); await req.response; }
    expect(initial).toEqual([7]);
    expectRootOperations(spec, rec, [7]);
    expect(rec.peak).toBe(1);
    const response = await req.response;
    expectHeaders(response);
    expect(await response.json()).toEqual({ entries: Array.from({ length: 50 }, () => missing
      ? { id: 7, found: false } : { id: 7, found: true, [spec.kind]: bundle(spec, 7) }) });
  });

  it("admits only the three first-occurrence roots when fewer than four unique misses are requested", async () => {
    const rec = recorder(spec, { held: true, missing: [9, 8, 7] });
    const req = batch(spec, rec.db, [9, 8, 9, 7, 8]);
    let initial: number[] = [];
    try { await rec.rootStarted(3); await checkpoint(); initial = [...rec.starts]; }
    finally { rec.releaseAll(); await req.response; }
    expect(initial).toEqual([9, 8, 7]);
    expect(rec.peak).toBe(3);
    expectRootOperations(spec, rec, [9, 8, 7]);
    expect(rec.tails).toEqual([]);
    const response = await req.response;
    expectHeaders(response);
    expect(await response.json()).toEqual({ entries: [
      { id: 9, found: false }, { id: 8, found: false }, { id: 9, found: false },
      { id: 7, found: false }, { id: 8, found: false }
    ] });
  });

  it("keeps simultaneous requests independent and rehydrates again on a later request", async () => {
    const a = recorder(spec, { held: true });
    const b = recorder(spec, { held: true, missing: [1] });
    const first = batch(spec, a.db, [1]);
    const second = batch(spec, b.db, [1]);
    try { await Promise.all([a.rootStarted(1), b.rootStarted(1)]); }
    finally { a.releaseAll(); b.releaseAll(); await Promise.all([first.response, second.response]); }
    expectRootOperations(spec, a, [1]); expectRootOperations(spec, b, [1]);
    expect(await (await first.response).json()).toEqual({ entries: [{ id: 1, found: true, [spec.kind]: bundle(spec, 1) }] });
    expect(await (await second.response).json()).toEqual({ entries: [{ id: 1, found: false }] });
    const later = recorder(spec, { missing: [1] });
    expect(await (await batch(spec, later.db, [1]).response).json()).toEqual({ entries: [{ id: 1, found: false }] });
    expectRootOperations(spec, later, [1]);
  });

  it.each(["root", "nested"] as const)("stops queued starts on %s failure and drains already-started successes and rejections before responding", async (failureAt) => {
    const rec = recorder(spec, { held: true, holdTail: true });
    const req = batch(spec, rec.db, [1, 2, 3, 4, 5, 6, 7, 8]);
    let resolved = false;
    void req.response.then(() => { resolved = true; });
    let afterFailure: number[] = [], afterSibling: number[] = [], premature = false;
    try {
      await rec.rootStarted(4);
      if (failureAt === "nested") {
        rec.releaseRoot(1); await rec.tailStarted(1); rec.rejectTail(1);
      } else rec.rejectRoot(1);
      await checkpoint();
      afterFailure = [...rec.starts];
      premature = resolved;
      // Another in-flight failure must be handled, not an unhandled rejection.
      rec.rejectRoot(2);
      rec.releaseRoot(3); await rec.tailStarted(failureAt === "nested" ? 2 : 1);
      rec.releaseTail(3); await checkpoint();
      afterSibling = [...rec.starts];
      premature ||= resolved; // root 4 is deliberately still held.
    } finally { rec.releaseAll(); await req.response; await checkpoint(); }
    expect.soft(afterFailure).toEqual([1, 2, 3, 4]);
    expect.soft(afterSibling).toEqual([1, 2, 3, 4]);
    expect.soft(premature).toBe(false);
    await expectFailure(await req.response);
    expectRootOperations(spec, rec, [1, 2, 3, 4]);
    expect(rec.active).toBe(0);
    const finished = [...rec.operations]; await checkpoint();
    expect(rec.operations).toEqual(finished);
    expect(req.background).toEqual([]);
  });

  it.each(["1,01,2", "", Array.from({ length: 51 }, (_, i) => i + 1).join(","), "1,9007199254740992"])(
    "rejects invalid ids=%s before any D1 work", async (ids) => {
      const rec = recorder(spec);
      const response = await request(spec, rec.db, [["ids", ids]]).response;
      expectHeaders(response, 400);
      expect(await response.json()).toMatchObject({ type: `${PROBLEMS}#bad-request`, status: 400 });
      expect(rec.operations).toEqual([]);
    }
  );
  it.each<{ pairs: Array<[string, string]> }>([
    { pairs: [["ids", "1"], ["ids", "2"]] },
    { pairs: [["ids", "1"], ["id", "2"]] },
    { pairs: [["ids", "1"], [spec.alias, "2"]] }
  ])("rejects ambiguous selectors %# before D1 work", async ({ pairs }) => {
    const rec = recorder(spec);
    const response = await request(spec, rec.db, pairs).response;
    expectHeaders(response, 400); expect(rec.operations).toEqual([]);
  });
  it.each(["", "Bearer synthetic-wrong", "Bearer synthetic-api-token", "Bearer synthetic-read-token"])(
    "preserves auth-before-hydration for authorization=%s", async (authorization) => {
      const rec = recorder(spec);
      for (const ids of ["1,2", "1,01", Array(51).fill(1).join(",")]) {
        const response = await request(spec, rec.db, [["ids", ids]], authorization).response;
        expectHeaders(response, 401);
        expect(await response.json()).toMatchObject({ type: `${PROBLEMS}#unauthorized`, status: 401 });
      }
      expect(rec.operations).toEqual([]);
    }
  );
});

// Real local D1 parity complements the scheduler denial-double cases. Nullable
// columns, empty strings/zero and sorted/empty relations are checked here;
// orphan/null relations use denial doubles above (real D1 enforces foreign keys).
// Expectations never come from a production single-read/bundle helper.
const DB = (env as unknown as Env).CUSTOMER_DB;
async function insert(table: string, row: Row) {
  const keys = Object.keys(row);
  await DB.prepare(`INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .bind(...Object.values(row)).run();
}
describe("synthetic local D1 batch output parity", () => {
  beforeAll(async () => { await ensureD1TestTables(); });
  beforeEach(async () => {
    await DB.batch([
      DB.prepare("DELETE FROM container_snapshot"), DB.prepare("DELETE FROM address_snapshot"), DB.prepare("DELETE FROM customer_snapshot")
    ]);
    await insert("customer_snapshot", { customer_id: 98101, company_name: "Synthetic budget", enabled: 0, phone1: "", synced_at: "2026-10-25" });
    await insert("customer_snapshot", { customer_id: 98102, synced_at: "2026-10-25" });
    await insert("address_snapshot", { pickup_address_id: 98202, customer_id: 98101, city: "Second", synced_at: "2026-10-25" });
    await insert("address_snapshot", { pickup_address_id: 98201, customer_id: 98101, city: "First", synced_at: "2026-10-25" });
    await insert("container_snapshot", { container_id: 98302, pickup_address_id: 98201, synced_at: "2026-10-25" });
    await insert("container_snapshot", { container_id: 98301, pickup_address_id: 98201, serial_number: "Synthetic first", synced_at: "2026-10-25" });
  });
  it.each(specs)("preserves full $kind bundles, sorted relations, duplicates, misses and empty shapes", async (spec) => {
    // SELECTs here are independent test-fixture reads, not production hydration.
    const c = await DB.prepare("SELECT * FROM customer_snapshot WHERE customer_id = ?").bind(98101).first<Row>();
    const a1 = await DB.prepare("SELECT * FROM address_snapshot WHERE pickup_address_id = ?").bind(98201).first<Row>();
    const a2 = await DB.prepare("SELECT * FROM address_snapshot WHERE pickup_address_id = ?").bind(98202).first<Row>();
    const k1 = await DB.prepare("SELECT * FROM container_snapshot WHERE container_id = ?").bind(98301).first<Row>();
    const k2 = await DB.prepare("SELECT * FROM container_snapshot WHERE container_id = ?").bind(98302).first<Row>();
    const primary = spec.kind === "customer" ? 98101 : spec.kind === "address" ? 98201 : 98301;
    const sparse = spec.kind === "customer" ? 98102 : spec.kind === "address" ? 98202 : 98302;
    const sparseRow = await DB.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.key} = ?`).bind(sparse).first<Row>();
    const full = spec.kind === "customer" ? { customer: c, addresses: [{ ...a1, containers: [k1, k2] }, { ...a2, containers: [] }] }
      : spec.kind === "address" ? { address: a1, customer: c, containers: [k1, k2] }
      : { container: k1, address: a1, customer: c };
    const empty = spec.kind === "customer" ? { customer: sparseRow, addresses: [] }
      : spec.kind === "address" ? { address: sparseRow, customer: c, containers: [] }
      : { container: sparseRow, address: a1, customer: c };
    const response = await batch(spec, DB, [primary, 98999, sparse, primary, 98999]).response;
    expectHeaders(response);
    expect(await response.json()).toEqual({ entries: [
      { id: primary, found: true, [spec.kind]: full }, { id: 98999, found: false },
      { id: sparse, found: true, [spec.kind]: empty },
      { id: primary, found: true, [spec.kind]: full }, { id: 98999, found: false }
    ] });
  });
});
