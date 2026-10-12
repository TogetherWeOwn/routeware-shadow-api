import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import app from "../src/app";
import { clearAntiForgeryTokenCache } from "../src/lib/customerSaveAutoToken";
import { mapDetailFullToRows } from "../src/lib/detailFullSync";
import {
  upsertAddressSnapshotRows,
  upsertContainerSnapshotRows,
  upsertCustomerSnapshotRows
} from "../src/lib/snapshot/upsert";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * R3-15 (TOG-8891): concurrent identical saves.
 *
 * Clients retry and double-submit, so the same customer, address or container
 * save can arrive several times at once. Each save is forwarded upstream, then
 * re-syncs the customer graph into D1 (`syncCustomerDetailFullToD1`: upserts
 * guarded by `synced_at`, then a reconcile-delete of older children). These
 * tests fire N identical saves at every save route through `app.fetch`, with
 * real D1 and the Cache API, and pin that:
 *
 * - every request answers 200: no 5xx from a lost race;
 * - each request is forwarded upstream exactly once: no retry amplification;
 * - D1 holds exactly one row per id and the whole graph: no duplicate rows and
 *   no children lost to a concurrent reconcile;
 * - an older sync that lands last never overwrites the newest one.
 *
 * Upstream is a stub on `globalThis.fetch`; nothing reaches a live host.
 */

const N = 8;
const ORIGIN = "https://upstream.test";
const OLD = "2000-01-01T00:00:00.000Z";
const BASE_MS = Date.parse("2030-01-01T00:00:00.000Z");
const FIRST_CREATED_ID = 900;
const db = env.CUSTOMER_DB;

type Graph = ReturnType<typeof graph>;

function graph(customerId: number, companyName: string, addresses: Array<[number, number[]]>) {
  return {
    currentCustomer: { CustomerID: customerId, CompanyName: companyName },
    data: addresses.map(([id, containers]) => ({
      PickupAddressID: id,
      CustomerID: customerId,
      Containers: containers.map((containerId) => ({ ContainerID: containerId }))
    }))
  };
}

const CHILDREN: Array<[number, number[]]> = [[10, [100, 101]], [11, [110]]];
const SAVED = graph(5, "Saved customer", CHILDREN);

function createdGraph(customerId: number): Graph {
  return graph(customerId, "New customer", [[customerId * 10, [customerId * 100]]]);
}

type SaveRoute = { name: string; path: string; body: string; tier: "routeware" | "data" };

const UPDATE_BODIES = {
  customer: "CustomerID=5&CompanyName=Saved+customer&Enabled=true",
  address: "PickupAddressID=10&CustomerID=5&Address=1+Synthetic+Way",
  // No CustomerID: the owning customer is resolved from D1 mid-race.
  container: "ContainerID=100&PickupAddressID=10&SerialNumber=SYN-100"
};

const SAVES: SaveRoute[] = [
  { name: "routeware customer", path: "/api/v1/routeware/customer/save-long-form", body: UPDATE_BODIES.customer, tier: "routeware" },
  { name: "routeware address", path: "/api/v1/routeware/address/save-address-form", body: UPDATE_BODIES.address, tier: "routeware" },
  { name: "routeware container", path: "/api/v1/routeware/container/save-container-form", body: UPDATE_BODIES.container, tier: "routeware" },
  { name: "data customer", path: "/api/v1/data/customer", body: UPDATE_BODIES.customer, tier: "data" },
  { name: "data address", path: "/api/v1/data/address", body: UPDATE_BODIES.address, tier: "data" },
  { name: "data container", path: "/api/v1/data/container", body: UPDATE_BODIES.container, tier: "data" }
];

/** The data tier authenticates with the snapshot sync secret, not the API token. */
const TOKENS = { routeware: "test-api-token", data: "test-sync-secret" } as const;

const CREATE_BODY = "CustomerID=0&CompanyName=New+customer&Enabled=true";
const CUSTOMER_SAVES = SAVES.filter((route) => route.name.endsWith("customer"));

const MODAL_PATHS = new Set([
  "/WebRW/Customer/AddNewLong",
  "/WebRW/Customer/LoadLongCustomerModal",
  "/WebRW/PickupAddress/LoadAddressModal",
  "/WebRW/Container/LoadContainerModal"
]);
const SAVE_PATHS = new Set([
  "/WebRW/Customer/SaveCustomerLongForm",
  "/WebRW/PickupAddress/SaveAddressForm",
  "/WebRW/Container/SaveContainerForm"
]);

/** A gate that, while `held`, parks each arriving upstream call in order. */
type Hold = { held: boolean; waiting: Array<() => void> };

const upstream = {
  saves: 0,
  createdIds: [] as number[],
  detail: [] as number[],
  saveHold: { held: false, waiting: [] } as Hold,
  detailHold: { held: false, waiting: [] } as Hold
};

function pass(hold: Hold): Promise<void> {
  return hold.held ? new Promise((resolve) => hold.waiting.push(resolve)) : Promise.resolve();
}

function bodyText(body: BodyInit | null | undefined): string {
  if (typeof body === "string") return body;
  return body ? new TextDecoder().decode(body as ArrayBuffer) : "";
}

async function fakeUpstream(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== ORIGIN) {
    throw new Error(`Unexpected upstream origin: ${url.origin}`);
  }
  if (MODAL_PATHS.has(url.pathname)) {
    return new Response('<input name="__RequestVerificationToken" value="FAKE-TOKEN" />', {
      headers: { "content-type": "text/html" }
    });
  }
  if (SAVE_PATHS.has(url.pathname)) {
    upstream.saves += 1;
    // Upstream has no idempotency key: every create makes a new customer.
    const isCreate = new URLSearchParams(bodyText(init?.body)).get("CustomerID") === "0";
    const createdId = isCreate ? FIRST_CREATED_ID + upstream.createdIds.length : null;
    if (createdId !== null) upstream.createdIds.push(createdId);
    await pass(upstream.saveHold);
    return Response.json(createdId === null ? { success: true } : { success: true, data: { CustomerID: createdId } });
  }
  if (url.pathname === "/WebRW/Customer/GetCustomerDetailFull") {
    const { customerID } = JSON.parse(bodyText(init?.body)) as { customerID: number };
    upstream.detail.push(customerID);
    await pass(upstream.detailHold);
    return Response.json(customerID === 5 ? SAVED : createdGraph(customerID));
  }
  throw new Error(`Unexpected upstream path: ${url.pathname}`);
}

/** A valid stored session (expiry follows the possibly faked clock) and an open throttle. */
const sessionStub = {
  fetch: async (input: RequestInfo | URL) => {
    const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
    if (path === "/get") {
      return Response.json({ cookieHeader: "session=FAKE", expiresAtMs: Date.now() + 600_000, refreshing: false });
    }
    if (path === "/throttle/failure" || path === "/throttle/clear") {
      return Response.json({ blocked: false, retryAfterSec: 0 });
    }
    throw new Error(`Unexpected session operation: ${path}`);
  }
} as unknown as DurableObjectStub;

const testEnv = {
  ...env,
  TARGET_ORIGIN: ORIGIN,
  TARGET_BASE_PATH: "/WebRW",
  LOGIN_URL: `${ORIGIN}/WebRW/Account/Login`,
  SNAPSHOTS_R2_ENABLED: "false",
  AUTH_SESSION: { idFromName: (name: string) => name, get: () => sessionStub }
} as unknown as Env;

async function seed(full: Graph): Promise<void> {
  const { customer, addresses, containers } = mapDetailFullToRows(full);
  await upsertCustomerSnapshotRows(db, [customer], 80, OLD);
  await upsertAddressSnapshotRows(db, addresses, 80, OLD);
  await upsertContainerSnapshotRows(db, containers, 50, OLD);
}

/** The current test's requests, settled in `afterEach` so none outlives its test. */
let inFlight: Promise<unknown> = Promise.resolve();

/** Fires N identical saves at once; `settled` counts finished requests. */
function fire(route: SaveRoute, body: string): { responses: Promise<Response[]>; settled: () => number } {
  let settled = 0;
  const requests = Array.from({ length: N }, () =>
    Promise.resolve(
      app.fetch(
        new Request(`http://test.local${route.path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${TOKENS[route.tier]}`, "content-type": "application/x-www-form-urlencoded" },
          body
        }),
        testEnv
      )
    ).finally(() => {
      settled += 1;
    })
  );
  inFlight = Promise.allSettled(requests);
  return { responses: Promise.all(requests), settled: () => settled };
}

async function until(done: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2_000; i++) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function ids(table: string, column: string): Promise<number[]> {
  const rows = await db.prepare(`SELECT ${column} AS id FROM ${table} ORDER BY ${column}`).all<{ id: number }>();
  return rows.results.map((row) => row.id);
}

/** Independent of the PRIMARY KEYs, so a schema change cannot hide duplicates. */
async function expectOneRowPerId(): Promise<void> {
  for (const [table, column] of [
    ["customer_snapshot", "customer_id"],
    ["address_snapshot", "pickup_address_id"],
    ["container_snapshot", "container_id"]
  ]) {
    const dupes = await db
      .prepare(`SELECT ${column} AS id, COUNT(*) AS n FROM ${table} GROUP BY ${column} HAVING COUNT(*) > 1`)
      .all();
    expect(dupes.results, table).toEqual([]);
  }
}

async function syncedAtOfCustomer5Graph(): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT synced_at FROM customer_snapshot WHERE customer_id = 5
     UNION ALL SELECT synced_at FROM address_snapshot WHERE customer_id = 5
     UNION ALL SELECT synced_at FROM container_snapshot WHERE pickup_address_id IN (
       SELECT pickup_address_id FROM address_snapshot WHERE customer_id = 5)`
  ).all<{ synced_at: string }>();
  return rows.results.map((row) => row.synced_at);
}

async function expectAllSaved(route: SaveRoute, responses: Response[]): Promise<void> {
  expect(responses.map((response) => response.status)).toEqual(Array(N).fill(200));
  for (const response of responses) {
    const body = (await response.json()) as { localSync?: { done: boolean } };
    if (route.tier === "data") {
      expect(body.localSync?.done).toBe(true);
    }
  }
  expect(upstream.saves).toBe(N);
  // Routeware-tier refresh failures are logged, not returned: none may occur.
  expect(loggedErrors).toEqual([]);
}

async function expectSavedGraph(): Promise<void> {
  await expectOneRowPerId();
  expect(await ids("customer_snapshot", "customer_id")).toEqual([5, 6]);
  expect(await ids("address_snapshot", "pickup_address_id")).toEqual([10, 11, 20]);
  expect(await ids("container_snapshot", "container_id")).toEqual([100, 101, 110, 200]);
  expect(await db.prepare("SELECT company_name FROM customer_snapshot WHERE customer_id = 5").first("company_name"))
    .toBe("Saved customer");
  await expectBystanderUntouched();
}

async function expectBystanderUntouched(): Promise<void> {
  expect(await db.prepare("SELECT synced_at FROM customer_snapshot WHERE customer_id = 6").first("synced_at")).toBe(OLD);
}

/**
 * `console.error` is swapped directly: under `@cloudflare/vitest-pool-workers`
 * the console methods are bound accessors, so `vi.spyOn` does not stick.
 */
const loggedErrors: unknown[] = [];
const realConsoleError = console.error;
const realFetch = globalThis.fetch;

beforeAll(async () => {
  await ensureD1TestTables();
});

beforeEach(async () => {
  clearAntiForgeryTokenCache();
  upstream.saves = 0;
  upstream.createdIds = [];
  upstream.detail = [];
  upstream.saveHold = { held: false, waiting: [] };
  upstream.detailHold = { held: false, waiting: [] };
  loggedErrors.length = 0;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args);
  };
  globalThis.fetch = fakeUpstream as typeof fetch;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  await seed(graph(5, "Seeded customer", CHILDREN));
  await seed(graph(6, "Bystander", [[20, [200]]]));
});

afterEach(async () => {
  // Never leave a parked request behind for the next test.
  for (const hold of [upstream.saveHold, upstream.detailHold]) {
    hold.held = false;
    hold.waiting.splice(0).forEach((release) => release());
  }
  await inFlight;
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
});

describe.each(SAVES)("$name: N identical concurrent saves", (route) => {
  it("all overlap in the D1 sync: every save answers 200 and D1 keeps one row per id", async () => {
    upstream.detailHold.held = true;
    const { responses } = fire(route, route.body);
    await until(() => upstream.detail.length === N, "every sync to be in flight");
    upstream.detailHold.waiting.forEach((release) => release());

    await expectAllSaved(route, await responses);
    expect(upstream.detail).toEqual(Array(N).fill(5));
    await expectSavedGraph();
  });

  it("the newest sync lands first: older syncs landing later neither overwrite nor delete it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    upstream.saveHold.held = true;
    upstream.detailHold.held = true;
    const { responses, settled } = fire(route, route.body);
    await until(() => upstream.saveHold.waiting.length === N, "every save to reach upstream");
    // Release saves one by one, so sync i stamps synced_at BASE + i seconds.
    for (let i = 0; i < N; i++) {
      vi.setSystemTime(BASE_MS + i * 1_000);
      upstream.saveHold.waiting[i]();
      await until(() => upstream.detail.length === i + 1, `sync ${i} to start`);
    }
    // Then let the syncs write newest first, each finishing before the next.
    for (let i = N - 1; i >= 0; i--) {
      upstream.detailHold.waiting[i]();
      await until(() => settled() === N - i, `sync ${i} to finish`);
    }

    await expectAllSaved(route, await responses);
    await expectSavedGraph();
    const newest = new Date(BASE_MS + (N - 1) * 1_000).toISOString();
    expect(await syncedAtOfCustomer5Graph()).toEqual(Array(1 + 2 + 3).fill(newest));
  });
});

describe.each(CUSTOMER_SAVES)("$name: N identical concurrent creates", (route) => {
  it("forwards each create once and mirrors exactly the customers upstream made", async () => {
    upstream.detailHold.held = true;
    const { responses } = fire(route, CREATE_BODY);
    await until(() => upstream.detail.length === N, "every sync to be in flight");
    upstream.detailHold.waiting.forEach((release) => release());

    await expectAllSaved(route, await responses);
    const created = Array.from({ length: N }, (_, i) => FIRST_CREATED_ID + i);
    expect(upstream.createdIds).toEqual(created);
    expect([...upstream.detail].sort((a, b) => a - b)).toEqual(created);
    await expectOneRowPerId();
    expect(await ids("customer_snapshot", "customer_id")).toEqual([5, 6, ...created]);
    expect(await ids("address_snapshot", "pickup_address_id")).toEqual([10, 11, 20, ...created.map((id) => id * 10)]);
    expect(await ids("container_snapshot", "container_id"))
      .toEqual([100, 101, 110, 200, ...created.map((id) => id * 100)]);
    expect(await syncedAtOfCustomer5Graph()).toEqual(Array(1 + 2 + 3).fill(OLD));
    await expectBystanderUntouched();
  });
});
