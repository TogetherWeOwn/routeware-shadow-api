import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
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
 * R21-05 created-id resolution on saves (acceptance, RED-before-build).
 *
 * User value: an agent creating an address or container learns its id from the
 * save response itself, instead of a follow-up read that can mis-attribute
 * under concurrent creates.
 *
 * Contract pinned here (data tier only; routeware tier stays passthrough):
 *
 * - Address/container creates resolve their ids: upstream-JSON parse first
 *   (`data.PickupAddressID` / `data.ContainerID`, positive integers only),
 *   else post-refresh D1 diff when upstream carries no id (exactly one new
 *   row id), else documented `null` only when ambiguous (zero or 2+ new ids).
 * - HTTP 201 on creates vs 200 on updates (RFC 9110 §15.3.2). Customer saves
 *   are OUT OF SCOPE for R21-05 and stay 200 on creates (regression-pinned).
 * - Update-echo unchanged: updates echo the posted id with 200.
 * - Failed saves preserve the current failure shape (mirrored status,
 *   `ok:false`, `localSync.not_attempted`, no id, no PII).
 * - `localSync` parity: creates carry the same `done:true` sync summary as
 *   updates (customerId + addressIds + containerIds from the refresh).
 * - No submitted-field echo: responses carry ids + byte counts only, never
 *   submitted PII or upstream bodies.
 * - Customer-save regression: customer creates still resolve via
 *   `data.CustomerID` with 200 (unchanged).
 *
 * RED-before-build: on the pre-implementation head the create id + 201
 * assertions fail (creates answer 200 with `null`); update/failed/customer
 * pins pass. Only Test Authors edit this file; the Builder builds on this
 * branch and never edits Test Author files.
 *
 * Harness: `app.fetch` + real D1 + stubbed upstream on `globalThis.fetch`;
 * any unexpected origin/path throws, so no test can reach a live host.
 * Explicit `__RequestVerificationToken` values skip the anti-forgery modal
 * fetch (modal paths throw when hit). All fixtures are synthetic.
 */

const ORIGIN = "https://upstream.test";
const SYNC_SECRET = "test-sync-secret";
const OLD = "2000-01-01T00:00:00.000Z";
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

/** Baseline customer 5 graph seeded before every test. */
const BASELINE: Array<[number, number[]]> = [[10, [100, 101]], [11, [110]]];
const BASELINE_GRAPH = () => graph(5, "Seeded customer", BASELINE);

/** New-customer graph for the customer-create regression (mirrors concurrentDuplicateSave). */
function createdGraph(customerId: number): Graph {
  return graph(customerId, "New customer", [[customerId * 10, [customerId * 100]]]);
}

const SAVE_PATHS = {
  address: "/WebRW/PickupAddress/SaveAddressForm",
  container: "/WebRW/Container/SaveContainerForm",
  customer: "/WebRW/Customer/SaveCustomerLongForm"
} as const;
type SaveEntity = keyof typeof SAVE_PATHS;

const MODAL_PATHS = new Set([
  "/WebRW/Customer/AddNewLong",
  "/WebRW/Customer/LoadLongCustomerModal",
  "/WebRW/PickupAddress/LoadAddressModal",
  "/WebRW/PickupAddress/CreateBlankAddress",
  "/WebRW/Container/LoadContainerModal",
  "/WebRW/Container/CreateBlankContainer"
]);
const DETAIL_PATH = "/WebRW/Customer/GetCustomerDetailFull";

const UPSTREAM_OK_NAKED = '{"success":true}';

const behavior: {
  saves: Record<SaveEntity, { status: number; body: string }>;
  detail: (customerId: number) => Graph;
} = {
  saves: {
    address: { status: 200, body: UPSTREAM_OK_NAKED },
    container: { status: 200, body: UPSTREAM_OK_NAKED },
    customer: { status: 200, body: UPSTREAM_OK_NAKED }
  },
  detail: () => BASELINE_GRAPH()
};

const calls: { saves: SaveEntity[]; detail: number[] } = { saves: [], detail: [] };

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
    throw new Error(`Unexpected modal fetch in test (token was posted): ${url.pathname}`);
  }
  const saveEntity = (Object.keys(SAVE_PATHS) as SaveEntity[]).find(
    (entity) => SAVE_PATHS[entity] === url.pathname
  );
  if (saveEntity) {
    calls.saves.push(saveEntity);
    const { status, body } = behavior.saves[saveEntity];
    return new Response(body, {
      status,
      headers: { "content-type": "application/json" }
    });
  }
  if (url.pathname === DETAIL_PATH) {
    const { customerID } = JSON.parse(bodyText(init?.body)) as { customerID: number };
    calls.detail.push(customerID);
    return Response.json(behavior.detail(customerID));
  }
  throw new Error(`Unexpected upstream path: ${url.pathname}`);
}

/** Valid stored session + open throttle (same shape as concurrentDuplicateSave). */
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

async function ids(table: string, column: string): Promise<number[]> {
  const rows = await db.prepare(`SELECT ${column} AS id FROM ${table} ORDER BY ${column}`).all<{ id: number }>();
  return rows.results.map((row) => row.id);
}

type LocalSync =
  | { done: false; code: string }
  | { done: true; customerId: number; addressIds: number[]; containerIds: number[] };

type SaveBody = {
  ok: boolean;
  routewareStatus: number;
  customerId?: number | null;
  pickupAddressId?: number | null;
  containerId?: number | null;
  upstreamBytes?: number;
  localSync?: LocalSync;
  posted?: unknown;
  upstream?: unknown;
};

async function callSave(path: string, body: string): Promise<Response> {
  return app.fetch(
    new Request(`http://test.local${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SYNC_SECRET}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body
    }),
    testEnv
  );
}

async function jsonBody(res: Response): Promise<SaveBody> {
  return (await res.json()) as SaveBody;
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
  behavior.saves.address = { status: 200, body: UPSTREAM_OK_NAKED };
  behavior.saves.container = { status: 200, body: UPSTREAM_OK_NAKED };
  behavior.saves.customer = { status: 200, body: UPSTREAM_OK_NAKED };
  behavior.detail = () => BASELINE_GRAPH();
  calls.saves = [];
  calls.detail = [];
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
  await seed(BASELINE_GRAPH());
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
});

describe("R21-05 address creates resolve their id with 201", () => {
  it("resolves the id from upstream JSON (data.PickupAddressID) and answers 201", async () => {
    // Arrange — upstream carries the created id; the refresh contains it too.
    behavior.saves.address = {
      status: 200,
      body: '{"success":true,"data":{"PickupAddressID":77}}'
    };
    behavior.detail = () => graph(5, "Seeded customer", [[10, [100, 101]], [11, [110]], [77, []]]);

    // Act — PickupAddressID=0 marks a create.
    const res = await callSave(
      "/api/v1/data/address",
      "PickupAddressID=0&CustomerID=5&Address=9+Synthetic+Way+Apt+4B&__RequestVerificationToken=client-token"
    );

    // Assert — RED on the pre-implementation head (200 + null).
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
    expect(body.routewareStatus).toBe(200);
    expect(body.customerId).toBe(5);
    expect(body.pickupAddressId).toBe(77);
    expect(body.upstreamBytes).toBe(behavior.saves.address.body.length);
    expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
    expect(loggedErrors).toEqual([]);
  });

  it("resolves via post-refresh D1 diff when upstream carries no id and answers 201", async () => {
    // Arrange — upstream naked success; the refresh introduces exactly one new address.
    behavior.saves.address = { status: 200, body: UPSTREAM_OK_NAKED };
    behavior.detail = () => graph(5, "Seeded customer", [[10, [100, 101]], [11, [110]], [77, []]]);

    // Act
    const res = await callSave(
      "/api/v1/data/address",
      "PickupAddressID=0&CustomerID=5&Address=7+Synthetic+Way&__RequestVerificationToken=client-token"
    );

    // Assert — RED on the pre-implementation head (200 + null).
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
    expect(body.pickupAddressId).toBe(77);
    expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
    // The diff source is real: D1 now holds the new row.
    expect(await ids("address_snapshot", "pickup_address_id")).toContain(77);
    expect(loggedErrors).toEqual([]);
  });

  it("prefers upstream JSON over the D1 diff when both carry ids", async () => {
    // Arrange — upstream says 77; the refresh is ambiguous (77 + 78), so a
    // D1-diff-only resolution would stay null. JSON must win.
    behavior.saves.address = {
      status: 200,
      body: '{"success":true,"data":{"PickupAddressID":77}}'
    };
    behavior.detail = () =>
      graph(5, "Seeded customer", [[10, [100, 101]], [11, [110]], [77, []], [78, []]]);

    // Act
    const res = await callSave(
      "/api/v1/data/address",
      "PickupAddressID=0&CustomerID=5&Address=3+Synthetic+Way&__RequestVerificationToken=client-token"
    );

    // Assert — RED on the pre-implementation head (200 + null).
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.pickupAddressId).toBe(77);
    expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
  });

  it("stays null (documented) when two new ids make the diff ambiguous, but still answers 201", async () => {
    // Arrange — naked upstream + two new addresses: no single id to resolve.
    behavior.saves.address = { status: 200, body: UPSTREAM_OK_NAKED };
    behavior.detail = () =>
      graph(5, "Seeded customer", [[10, [100, 101]], [11, [110]], [77, []], [78, []]]);

    // Act
    const res = await callSave(
      "/api/v1/data/address",
      "PickupAddressID=0&CustomerID=5&Address=5+Synthetic+Way&__RequestVerificationToken=client-token"
    );

    // Assert — id null is the documented contract (GREEN); 201 is RED (now 200).
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
    expect(body.pickupAddressId).toBeNull();
    expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
  });

  it("stays null when the refresh shows zero new ids, but still answers 201", async () => {
    // Arrange — naked upstream + unchanged graph: nothing to diff to.
    behavior.saves.address = { status: 200, body: UPSTREAM_OK_NAKED };
    behavior.detail = () => BASELINE_GRAPH();

    // Act
    const res = await callSave(
      "/api/v1/data/address",
      "PickupAddressID=0&CustomerID=5&Address=1+Synthetic+Way&__RequestVerificationToken=client-token"
    );

    // Assert — null GREEN (documented); 201 RED (now 200).
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.pickupAddressId).toBeNull();
    expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
  });
});

describe("R21-05 container creates resolve their id with 201", () => {
  it("resolves the id from upstream JSON (data.ContainerID) and answers 201", async () => {
    // Arrange
    behavior.saves.container = {
      status: 200,
      body: '{"success":true,"data":{"ContainerID":177}}'
    };
    behavior.detail = () =>
      graph(5, "Seeded customer", [[10, [100, 101, 177]], [11, [110]]]);

    // Act — ContainerID=0 marks a create.
    const res = await callSave(
      "/api/v1/data/container",
      "ContainerID=0&PickupAddressID=10&CustomerID=5&SerialNumber=SYN-RESOLVE-001&__RequestVerificationToken=client-token"
    );

    // Assert — RED on the pre-implementation head (200 + null).
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
    expect(body.routewareStatus).toBe(200);
    expect(body.customerId).toBe(5);
    expect(body.pickupAddressId).toBe(10);
    expect(body.containerId).toBe(177);
    expect(body.upstreamBytes).toBe(behavior.saves.container.body.length);
    expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
    expect(loggedErrors).toEqual([]);
  });

  it("resolves via post-refresh D1 diff when upstream carries no id and answers 201", async () => {
    // Arrange
    behavior.saves.container = { status: 200, body: UPSTREAM_OK_NAKED };
    behavior.detail = () =>
      graph(5, "Seeded customer", [[10, [100, 101, 177]], [11, [110]]]);

    // Act
    const res = await callSave(
      "/api/v1/data/container",
      "ContainerID=0&PickupAddressID=10&CustomerID=5&SerialNumber=SYN-RESOLVE-002&__RequestVerificationToken=client-token"
    );

    // Assert — RED on the pre-implementation head (200 + null).
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
    expect(body.containerId).toBe(177);
    expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
    expect(await ids("container_snapshot", "container_id")).toContain(177);
    expect(loggedErrors).toEqual([]);
  });

  it("prefers upstream JSON over the D1 diff when both carry ids", async () => {
    // Arrange — upstream says 177; the refresh is ambiguous (177 + 178).
    behavior.saves.container = {
      status: 200,
      body: '{"success":true,"data":{"ContainerID":177}}'
    };
    behavior.detail = () =>
      graph(5, "Seeded customer", [[10, [100, 101, 177, 178]], [11, [110]]]);

    // Act
    const res = await callSave(
      "/api/v1/data/container",
      "ContainerID=0&PickupAddressID=10&CustomerID=5&SerialNumber=SYN-RESOLVE-003&__RequestVerificationToken=client-token"
    );

    // Assert — RED on the pre-implementation head (200 + null).
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.containerId).toBe(177);
    expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
  });

  it("stays null (documented) when two new ids make the diff ambiguous, but still answers 201", async () => {
    // Arrange
    behavior.saves.container = { status: 200, body: UPSTREAM_OK_NAKED };
    behavior.detail = () =>
      graph(5, "Seeded customer", [[10, [100, 101, 177, 178]], [11, [110]]]);

    // Act
    const res = await callSave(
      "/api/v1/data/container",
      "ContainerID=0&PickupAddressID=10&CustomerID=5&SerialNumber=SYN-RESOLVE-004&__RequestVerificationToken=client-token"
    );

    // Assert — null GREEN (documented); 201 RED (now 200).
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
    expect(body.containerId).toBeNull();
    expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
  });

  it("stays null when the refresh shows zero new ids, but still answers 201", async () => {
    // Arrange
    behavior.saves.container = { status: 200, body: UPSTREAM_OK_NAKED };
    behavior.detail = () => BASELINE_GRAPH();

    // Act
    const res = await callSave(
      "/api/v1/data/container",
      "ContainerID=0&PickupAddressID=10&CustomerID=5&SerialNumber=SYN-RESOLVE-005&__RequestVerificationToken=client-token"
    );

    // Assert — null GREEN (documented); 201 RED (now 200).
    expect(res.status).toBe(201);
    const body = await jsonBody(res);
    expect(body.containerId).toBeNull();
    expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
  });
});

describe("R21-05 update-echo unchanged (200)", () => {
  it("address update echoes the posted id with 200", async () => {
    // Arrange — an edit posts its id; upstream naked success.
    behavior.saves.address = { status: 200, body: UPSTREAM_OK_NAKED };
    behavior.detail = () => BASELINE_GRAPH();

    // Act
    const res = await callSave(
      "/api/v1/data/address",
      "PickupAddressID=10&CustomerID=5&Address=1+Synthetic+Way&__RequestVerificationToken=client-token"
    );

    // Assert — GREEN pin of existing behavior.
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
    expect(body.customerId).toBe(5);
    expect(body.pickupAddressId).toBe(10);
    expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
  });

  it("container update echoes the posted id with 200", async () => {
    // Arrange
    behavior.saves.container = { status: 200, body: UPSTREAM_OK_NAKED };
    behavior.detail = () => BASELINE_GRAPH();

    // Act
    const res = await callSave(
      "/api/v1/data/container",
      "ContainerID=100&PickupAddressID=10&CustomerID=5&SerialNumber=SYN-100&__RequestVerificationToken=client-token"
    );

    // Assert — GREEN pin.
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
    expect(body.customerId).toBe(5);
    expect(body.pickupAddressId).toBe(10);
    expect(body.containerId).toBe(100);
    expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
  });
});

describe("R21-05 201-on-create vs 200-on-update status split", () => {
  it("creates answer 201 while updates answer 200 in the same run", async () => {
    // Arrange — JSON-id creates + naked-success updates, all under customer 5.
    behavior.saves.address = {
      status: 200,
      body: '{"success":true,"data":{"PickupAddressID":77}}'
    };
    behavior.saves.container = {
      status: 200,
      body: '{"success":true,"data":{"ContainerID":177}}'
    };
    behavior.detail = () =>
      graph(5, "Seeded customer", [[10, [100, 101, 177]], [11, [110]], [77, []]]);

    // Act — two creates then two updates.
    const addressCreate = await callSave(
      "/api/v1/data/address",
      "PickupAddressID=0&CustomerID=5&Address=9+Synthetic+Way&__RequestVerificationToken=client-token"
    );
    const containerCreate = await callSave(
      "/api/v1/data/container",
      "ContainerID=0&PickupAddressID=10&CustomerID=5&SerialNumber=SYN-SPLIT-001&__RequestVerificationToken=client-token"
    );
    // Updates use naked upstream success (edits carry no created id).
    behavior.saves.address = { status: 200, body: UPSTREAM_OK_NAKED };
    behavior.saves.container = { status: 200, body: UPSTREAM_OK_NAKED };
    const addressUpdate = await callSave(
      "/api/v1/data/address",
      "PickupAddressID=10&CustomerID=5&Address=1+Synthetic+Way&__RequestVerificationToken=client-token"
    );
    const containerUpdate = await callSave(
      "/api/v1/data/container",
      "ContainerID=100&PickupAddressID=10&CustomerID=5&SerialNumber=SYN-100&__RequestVerificationToken=client-token"
    );

    // Assert — creates RED (now 200), updates GREEN (200).
    expect(addressCreate.status).toBe(201);
    expect(containerCreate.status).toBe(201);
    expect(addressUpdate.status).toBe(200);
    expect(containerUpdate.status).toBe(200);
    expect((await jsonBody(addressCreate)).pickupAddressId).toBe(77);
    expect((await jsonBody(containerCreate)).containerId).toBe(177);
    expect((await jsonBody(addressUpdate)).pickupAddressId).toBe(10);
    expect((await jsonBody(containerUpdate)).containerId).toBe(100);
  });
});

describe("R21-05 failed-save preservation (no 201, no id, no sync)", () => {
  it("address create with upstream 503 mirrors the failure and never attempts a sync", async () => {
    // Arrange — the save never reached Routeware as a success.
    behavior.saves.address = { status: 503, body: "upstream down" };

    // Act
    const res = await callSave(
      "/api/v1/data/address",
      "PickupAddressID=0&CustomerID=5&Address=9+Synthetic+Way+Apt+9Z&__RequestVerificationToken=client-token"
    );

    // Assert — GREEN pin of the current failure shape.
    expect(res.status).toBe(503);
    const body = await jsonBody(res);
    expect(body.ok).toBe(false);
    expect(body.routewareStatus).toBe(503);
    expect(body.localSync).toEqual({ done: false, code: "not_attempted" });
    expect(calls.detail).toEqual([]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("9 Synthetic Way");
    expect(raw).not.toContain("upstream down");
  });

  it("container create with upstream 503 mirrors the failure and never attempts a sync", async () => {
    // Arrange
    behavior.saves.container = { status: 503, body: "upstream down" };

    // Act
    const res = await callSave(
      "/api/v1/data/container",
      "ContainerID=0&PickupAddressID=10&CustomerID=5&SerialNumber=SYN-FAIL-009&__RequestVerificationToken=client-token"
    );

    // Assert — GREEN pin.
    expect(res.status).toBe(503);
    const body = await jsonBody(res);
    expect(body.ok).toBe(false);
    expect(body.routewareStatus).toBe(503);
    expect(body.localSync).toEqual({ done: false, code: "not_attempted" });
    expect(calls.detail).toEqual([]);
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("SYN-FAIL-009");
    expect(raw).not.toContain("upstream down");
  });
});

describe("R21-05 localSync parity on creates", () => {
  it("creates carry the same done:true sync summary as updates", async () => {
    // Arrange — a JSON-id address create and a plain update, same customer.
    behavior.saves.address = {
      status: 200,
      body: '{"success":true,"data":{"PickupAddressID":77}}'
    };
    behavior.detail = () => graph(5, "Seeded customer", [[10, [100, 101]], [11, [110]], [77, []]]);

    // Act
    const createRes = await callSave(
      "/api/v1/data/address",
      "PickupAddressID=0&CustomerID=5&Address=9+Synthetic+Way&__RequestVerificationToken=client-token"
    );
    behavior.saves.address = { status: 200, body: UPSTREAM_OK_NAKED };
    const updateRes = await callSave(
      "/api/v1/data/address",
      "PickupAddressID=10&CustomerID=5&Address=1+Synthetic+Way&__RequestVerificationToken=client-token"
    );

    // Assert — parity holds on the pre-implementation head too (GREEN); the
    // Builder must keep it while adding 201 + id resolution.
    const createBody = await jsonBody(createRes);
    const updateBody = await jsonBody(updateRes);
    expect(createBody.localSync).toMatchObject({ done: true, customerId: 5 });
    expect(updateBody.localSync).toMatchObject({ done: true, customerId: 5 });
    for (const localSync of [createBody.localSync, updateBody.localSync] as Array<
      Extract<LocalSync, { done: true }>
    >) {
      expect(Array.isArray(localSync.addressIds)).toBe(true);
      expect(Array.isArray(localSync.containerIds)).toBe(true);
    }
    // The refresh really ran for the create (not a skipped sync).
    expect(calls.detail).toContain(5);
  });
});

describe("R21-05 no submitted-field echo sweep", () => {
  it("create responses carry ids + byte counts only, never submitted PII or upstream bytes", async () => {
    // Arrange — distinctive synthetic PII per entity; JSON-id upstreams.
    behavior.saves.address = {
      status: 200,
      body: '{"success":true,"data":{"PickupAddressID":77}}'
    };
    behavior.saves.container = {
      status: 200,
      body: '{"success":true,"data":{"ContainerID":177}}'
    };
    behavior.detail = () =>
      graph(5, "Seeded customer", [[10, [100, 101, 177]], [11, [110]], [77, []]]);

    // Act
    const addressRes = await callSave(
      "/api/v1/data/address",
      "PickupAddressID=0&CustomerID=5&Address=9+Synthetic+Way+Apt+4B&Notes=Call+555-0199&__RequestVerificationToken=client-token"
    );
    const containerRes = await callSave(
      "/api/v1/data/container",
      "ContainerID=0&PickupAddressID=10&CustomerID=5&SerialNumber=SYN-PII-SWEEP-7&LocationAddress=9+Synthetic+Way&__RequestVerificationToken=client-token"
    );

    // Assert — GREEN pin: the envelope already excludes PII; R21-05 must keep it.
    for (const res of [addressRes, containerRes]) {
      const body = await jsonBody(res);
      expect("posted" in body).toBe(false);
      expect("upstream" in body).toBe(false);
      expect(typeof body.upstreamBytes).toBe("number");
      const raw = JSON.stringify(body);
      for (const secret of [
        "9 Synthetic Way",
        "Apt 4B",
        "555-0199",
        "SYN-PII-SWEEP-7",
        "success",
        "PickupAddressID",
        "ContainerID"
      ]) {
        // PascalCase wire keys must not leak either (camelCase ids only).
        expect(raw).not.toContain(secret);
      }
    }
  });
});

describe("R21-05 customer-save regression (out of scope, unchanged)", () => {
  it("customer create still resolves via data.CustomerID with 200", async () => {
    // Arrange — the existing customer contract (see concurrentDuplicateSave).
    behavior.saves.customer = {
      status: 200,
      body: '{"success":true,"data":{"CustomerID":900}}'
    };
    behavior.detail = (customerId: number) =>
      customerId === 900 ? createdGraph(900) : BASELINE_GRAPH();

    // Act
    const res = await callSave(
      "/api/v1/data/customer",
      "CustomerID=0&CompanyName=Acme-Resolve-Co&Enabled=true&__RequestVerificationToken=client-token"
    );

    // Assert — GREEN pin: R21-05 must not change customer saves (still 200).
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
    expect(body.customerId).toBe(900);
    expect(body.localSync).toMatchObject({ done: true, customerId: 900 });
    expect(calls.detail).toEqual([900]);
    expect(JSON.stringify(body)).not.toContain("Acme-Resolve-Co");
  });

  it("customer update still echoes with 200", async () => {
    // Arrange
    behavior.saves.customer = { status: 200, body: UPSTREAM_OK_NAKED };
    behavior.detail = () => BASELINE_GRAPH();

    // Act
    const res = await callSave(
      "/api/v1/data/customer",
      "CustomerID=5&CompanyName=Seeded+customer&Enabled=true&__RequestVerificationToken=client-token"
    );

    // Assert — GREEN pin.
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
    expect(body.customerId).toBe(5);
    expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
  });
});
