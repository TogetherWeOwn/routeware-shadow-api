import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { clearAntiForgeryTokenCache } from "../src/lib/customerSaveAutoToken";

/**
 * Save-path request-id correlation acceptance (R20-05).
 *
 * When a save reports an ambiguous outcome, the operator must join the
 * server-side failure lines to the exact request instead of guessing across
 * concurrent saves. The earliest `/api/v1/*` middleware already resolves the
 * request id once per request (`src/app.ts:123-124`) and every response
 * echoes it; this suite pins that the same id rides every save-path error
 * line in the customer, address and container save flows.
 *
 * Scope: the 11 save-route error lines —
 * - data tier (`src/lib/dataEntitySave.ts`): "Local {customer,address,
 *   container} snapshot sync failed" + "Post-save fallback cache eviction
 *   failed" (all three routes share the eviction msg);
 * - routeware refresh (`src/lib/routewareSaveRefresh.ts`): "Post-save
 *   snapshot sync failed; evicting affected cache keys", "Post-save refresh
 *   failed", "Post-save customer cache invalidation failed",
 *   "Post-save entity cache invalidation failed";
 * - routeware auto-token (`src/routes/{customer,address,container}.ts`):
 *   "{Customer,Address,Container} save token preparation failed".
 * `cache.customerGraph.invalidate` ("Customer cache graph invalidation
 * failed") is out of scope: it is a cache-tier route, not a save route, and
 * R20-05 does not re-plumb the cache retry helper.
 *
 * Contract pinned here:
 * - every listed line carries `requestId` equal to the id resolved once per
 *   request: the exact inbound `X-Request-Id` when valid, else the single
 *   minted UUID that the response header echoes (response header and every
 *   log line agree — no double-mint);
 * - multiple lines from one request (sync failure + fallback eviction
 *   failures) all carry that same id;
 * - a defensively-missing var omits the field without crashing and without
 *   logging an `undefined` sentinel;
 * - outcome codes (`sync_failed`, `unknown_customer_id`, `not_attempted`),
 *   HTTP statuses and response bodies are byte-identical (no `requestId`
 *   added to route-level bodies — header correlation only);
 * - valid saves emit no new error lines.
 *
 * Status at authoring: the correlation assertions are RED (no save-path
 * logEvent passes `requestId` today). The success-silence, missing-var
 * omission and body-shape assertions are GREEN characterization locks the
 * Builder must keep green. Builder: build on this branch, never edit this
 * file; plumb the id from the request var into the 11 logEvents as an
 * optional field (omitted when missing), keep every existing exact-shape
 * test green without editing it, and do not add `requestId` to any
 * route-level response body.
 *
 * Conventions: synthetic upstream (`https://upstream.test`, stubbed
 * `globalThis.fetch` fails loudly on anything else); explicit
 * `__RequestVerificationToken` skips the modal fetch except where the modal
 * flow itself is the point; sync/eviction failures are injected through the
 * mocked `detailFullSync` / `entityDataCache` doubles below (real D1 and
 * real Cache API are never touched); distinct `save-corr-*` inbound ids per
 * test so cross-test log bleed is visible.
 *
 * Focused check:
 * npx vitest run test/saveRequestCorrelation.acceptance.test.ts \
 *   test/dataEntityPostHandlers.test.ts test/routewareSaveRefresh.test.ts \
 *   test/xRequestIdPropagation.acceptance.test.ts
 * npm run typecheck
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API_TOKEN = "test-api-token";
const SYNC_SECRET = "test-sync-secret";
const ORIGIN = "https://upstream.test";
const EXPLICIT_TOKEN = "explicit-client-token-7f3a";

const SAVE_PATHS = new Set([
  "/WebRW/Customer/SaveCustomerLongForm",
  "/WebRW/PickupAddress/SaveAddressForm",
  "/WebRW/Container/SaveContainerForm"
]);
const MODAL_PATHS = new Set([
  "/WebRW/Customer/AddNewLong",
  "/WebRW/Customer/LoadLongCustomerModal",
  "/WebRW/PickupAddress/CreateBlankAddress",
  "/WebRW/PickupAddress/LoadAddressModal",
  "/WebRW/Container/CreateBlankContainer",
  "/WebRW/Container/LoadContainerModal"
]);

type Graph = { customerId: number; addressIds: number[]; containerIds: number[] };

const behavior = vi.hoisted(() => ({
  syncError: null as string | null,
  syncResult: { addressIds: [10], containerIds: [100] },
  evictionErrors: {} as Partial<Record<"customer" | "address" | "container", Error>>,
  graphError: null as string | null
}));

const calls = vi.hoisted(() => ({
  synced: [] as number[],
  entity: [] as Array<{ kind: string; id: number }>,
  graph: [] as Graph[]
}));

vi.mock("../src/lib/detailFullSync", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/detailFullSync")>();
  return {
    ...actual,
    syncCustomerDetailFullToD1: async (
      _env: unknown,
      _stub: unknown,
      customerId: number
    ) => {
      calls.synced.push(customerId);
      if (behavior.syncError) {
        throw new Error(behavior.syncError);
      }
      return behavior.syncResult;
    }
  };
});

vi.mock("../src/lib/entityDataCache", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/entityDataCache")>();
  return {
    ...actual,
    invalidateCustomerGraph: async (p: Graph) => {
      if (behavior.graphError) {
        throw new Error(behavior.graphError);
      }
      calls.graph.push(p);
    },
    invalidateCustomerGraphWithRetry: async (p: Graph) => {
      if (behavior.graphError) {
        throw new Error(behavior.graphError);
      }
      calls.graph.push(p);
    },
    invalidateDataEntity: async (
      kind: "customer" | "address" | "container",
      id: number
    ) => {
      calls.entity.push({ kind, id });
      const failure = behavior.evictionErrors[kind];
      if (failure) {
        throw failure;
      }
    }
  };
});

const { handlePostDataAddress, handlePostDataContainer, handlePostDataCustomer } =
  await import("../src/lib/dataEntitySave");
const { refreshAfterRoutewareSave } = await import(
  "../src/lib/routewareSaveRefresh"
);
type DataCtx = Parameters<typeof handlePostDataCustomer>[0];

/** `console.error` is swapped directly: under the workers pool the console methods are bound accessors. */
const loggedErrors: Array<Record<string, unknown>> = [];
const realConsoleError = console.error;
const realFetch = globalThis.fetch;

function recordsWith(msg: string): Array<Record<string, unknown>> {
  return loggedErrors.filter((record) => record.msg === msg);
}

function expectNoRequestIdLeakInBody(body: unknown): void {
  expect(body).not.toHaveProperty("requestId");
  expect(JSON.stringify(body)).not.toContain("requestId");
}

function expectOmissionWithoutSentinel(
  records: Array<Record<string, unknown>>
): void {
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) {
    expect(Object.hasOwn(record, "requestId")).toBe(false);
    expect(record.requestId).toBeUndefined();
  }
  expect(JSON.stringify(records)).not.toContain("undefined");
}

function throwingDb(): D1Database {
  return {
    prepare() {
      throw new TypeError("SYNTHETIC-D1-DOWN");
    }
  } as unknown as D1Database;
}

function missingRowDb(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(..._args: unknown[]) {
          return {
            async first<T>() {
              expect(String(sql)).toContain("FROM address_snapshot");
              return null as unknown as T;
            }
          };
        }
      };
    }
  } as unknown as D1Database;
}

function sessionStub(): DurableObjectStub {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const path = new URL(
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url
      ).pathname;
      if (path === "/get") {
        return Response.json({
          cookieHeader: "session=FAKE",
          expiresAtMs: Date.now() + 600_000,
          refreshing: false
        });
      }
      if (path === "/throttle/failure" || path === "/throttle/clear") {
        return Response.json({ blocked: false, retryAfterSec: 0 });
      }
      throw new Error(`Unexpected session operation: ${path}`);
    }
  } as unknown as DurableObjectStub;
}

function testEnv(db: D1Database = missingRowDb()): Env {
  const stub = sessionStub();
  return {
    SHADOW_API_TOKEN: API_TOKEN,
    CUSTOMER_SNAPSHOT_SYNC_SECRET: SYNC_SECRET,
    TARGET_ORIGIN: ORIGIN,
    TARGET_BASE_PATH: "/WebRW",
    LOGIN_URL: `${ORIGIN}/WebRW/Account/Login`,
    SESSION_TTL_SECONDS: 1800,
    CUSTOMER_SAVE_AUTO_TOKEN: "true",
    CUSTOMER_DB: db,
    AUTH_SESSION: { idFromName: (name: string) => name, get: () => stub }
  } as unknown as Env;
}

/**
 * Upstream double: saves succeed with the JSON shape
 * `routewarePostLooksSuccessful` accepts; modals answer per `modalHtml`
 * (default: a token-bearing form, though explicit-token tests must never
 * fetch a modal at all). Anything else fails loudly — no live host.
 */
function stubUpstream(modalHtml?: string): {
  saves: string[];
  modals: string[];
} {
  const seen = { saves: [] as string[], modals: [] as string[] };
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    _init?: RequestInit
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    );
    if (url.origin !== ORIGIN) {
      throw new Error(`Unexpected upstream origin: ${url.origin}`);
    }
    if (SAVE_PATHS.has(url.pathname)) {
      seen.saves.push(url.pathname);
      return new Response('{"success":true}', {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (MODAL_PATHS.has(url.pathname)) {
      seen.modals.push(url.pathname);
      return new Response(
        modalHtml ??
          '<form><input name="__RequestVerificationToken" value="FAKE-MODAL-TOKEN" /></form>',
        { status: 200, headers: { "content-type": "text/html" } }
      );
    }
    throw new Error(`Unexpected upstream path: ${url.pathname}`);
  }) as typeof fetch;
  return seen;
}

async function post(
  env: Env,
  path: string,
  body: string,
  token: string,
  requestId?: string
): Promise<Response> {
  return app.fetch(
    new Request(`http://test.local${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-www-form-urlencoded",
        ...(requestId === undefined ? {} : { "X-Request-Id": requestId })
      },
      body
    }),
    env
  );
}

function dataCtx(env: Env, body: string): DataCtx {
  return {
    env,
    var: {
      bodyBuffer: new TextEncoder().encode(body).buffer as ArrayBuffer,
      sessionStub: sessionStub()
    },
    req: {
      raw: new Request("http://test.local/api/v1/data/customer", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" }
      }),
      header: () => undefined
    }
  } as DataCtx;
}

const CUSTOMER_BODY =
  `CustomerID=5&CompanyName=ExampleCo&Enabled=true&__RequestVerificationToken=${EXPLICIT_TOKEN}`;
const ADDRESS_BODY =
  `CustomerID=5&PickupAddressID=10&Address=1+Synthetic+Way&__RequestVerificationToken=${EXPLICIT_TOKEN}`;
const CONTAINER_BODY =
  `CustomerID=5&PickupAddressID=10&ContainerID=100&SerialNumber=SYN-100&__RequestVerificationToken=${EXPLICIT_TOKEN}`;

beforeEach(() => {
  clearAntiForgeryTokenCache();
  behavior.syncError = null;
  behavior.syncResult = { addressIds: [10], containerIds: [100] };
  behavior.evictionErrors = {};
  behavior.graphError = null;
  calls.synced = [];
  calls.entity = [];
  calls.graph = [];
  loggedErrors.length = 0;
  console.error = (...args: unknown[]) => {
    loggedErrors.push(args[0] as Record<string, unknown>);
  };
});

afterEach(() => {
  console.error = realConsoleError;
  globalThis.fetch = realFetch;
});

describe("data-tier local-sync failures carry the request id", () => {
  const specs = [
    {
      name: "customer",
      path: "/api/v1/data/customer",
      body: CUSTOMER_BODY,
      msg: "Local customer snapshot sync failed",
      route: "POST /api/v1/data/customer",
      id: "save-corr-data-customer-01"
    },
    {
      name: "address",
      path: "/api/v1/data/address",
      body: ADDRESS_BODY,
      msg: "Local address snapshot sync failed",
      route: "POST /api/v1/data/address",
      id: "save-corr-data-address-01"
    },
    {
      name: "container",
      path: "/api/v1/data/container",
      body: CONTAINER_BODY,
      msg: "Local container snapshot sync failed",
      route: "POST /api/v1/data/container",
      id: "save-corr-data-container-01"
    }
  ] as const;

  it.each(specs)(
    "$name: sync failure logs the exact inbound id and keeps sync_failed",
    async (spec) => {
      behavior.syncError = "SYNTHETIC-SYNC-DOWN";
      const seen = stubUpstream();
      const env = testEnv();

      const res = await post(env, spec.path, spec.body, SYNC_SECRET, spec.id);

      expect(res.status).toBe(200);
      expect(res.headers.get("X-Request-Id")).toBe(spec.id);
      expect(seen.modals).toEqual([]);
      expect(calls.synced).toEqual([5]);
      const body = (await res.json()) as {
        ok: boolean;
        routewareStatus: number;
        localSync: unknown;
      };
      expect(body.ok).toBe(true);
      expect(body.routewareStatus).toBe(200);
      expect(body.localSync).toEqual({ done: false, code: "sync_failed" });
      expectNoRequestIdLeakInBody(body);
      const lines = recordsWith(spec.msg);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: "error",
        route: spec.route,
        kind: "Error",
        requestId: spec.id
      });
    }
  );

  it("customer: sync + fallback eviction failures share the one inbound id", async () => {
    const id = "save-corr-data-customer-evict-01";
    behavior.syncError = "SYNTHETIC-SYNC-DOWN";
    behavior.evictionErrors = {
      customer: new TypeError("SYNTHETIC-EVICT-DOWN")
    };
    stubUpstream();

    const res = await post(
      testEnv(),
      "/api/v1/data/customer",
      CUSTOMER_BODY,
      SYNC_SECRET,
      id
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe(id);
    const body = (await res.json()) as { localSync: unknown };
    expect(body.localSync).toEqual({ done: false, code: "sync_failed" });
    expectNoRequestIdLeakInBody(body);
    expect(calls.entity).toEqual([{ kind: "customer", id: 5 }]);
    const syncLines = recordsWith("Local customer snapshot sync failed");
    const evictLines = recordsWith("Post-save fallback cache eviction failed");
    expect(syncLines).toHaveLength(1);
    expect(evictLines).toHaveLength(1);
    expect(syncLines[0]).toMatchObject({ requestId: id });
    expect(evictLines[0]).toMatchObject({
      route: "POST /api/v1/data/customer",
      kind: "TypeError",
      requestId: id
    });
  });

  it("address: both fallback evictions carry the same inbound id as the sync failure", async () => {
    const id = "save-corr-data-address-evict-01";
    behavior.syncError = "SYNTHETIC-SYNC-DOWN";
    behavior.evictionErrors = {
      customer: new TypeError("SYNTHETIC-EVICT-CUSTOMER"),
      address: new RangeError("SYNTHETIC-EVICT-ADDRESS")
    };
    stubUpstream();

    const res = await post(
      testEnv(),
      "/api/v1/data/address",
      ADDRESS_BODY,
      SYNC_SECRET,
      id
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { localSync: unknown };
    expect(body.localSync).toEqual({ done: false, code: "sync_failed" });
    expect(calls.entity).toEqual([
      { kind: "customer", id: 5 },
      { kind: "address", id: 10 }
    ]);
    const syncLines = recordsWith("Local address snapshot sync failed");
    const evictLines = recordsWith("Post-save fallback cache eviction failed");
    expect(syncLines).toHaveLength(1);
    expect(evictLines).toHaveLength(2);
    for (const line of [...syncLines, ...evictLines]) {
      expect(line).toMatchObject({ requestId: id });
    }
  });

  it("minted id: an invalid inbound id mints once — header and log agree", async () => {
    const inbound = "trace id with spaces (invalid)";
    behavior.syncError = "SYNTHETIC-SYNC-DOWN";
    stubUpstream();

    const res = await post(
      testEnv(),
      "/api/v1/data/customer",
      CUSTOMER_BODY,
      SYNC_SECRET,
      inbound
    );

    expect(res.status).toBe(200);
    const echoed = res.headers.get("X-Request-Id");
    expect(echoed).toMatch(UUID_RE);
    expect(echoed).not.toBe(inbound);
    const body = (await res.json()) as { localSync: unknown };
    expect(body.localSync).toEqual({ done: false, code: "sync_failed" });
    expectNoRequestIdLeakInBody(body);
    const lines = recordsWith("Local customer snapshot sync failed");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ requestId: echoed });
  });

  it("valid save: no error lines and no requestId in the body", async () => {
    const id = "save-corr-data-customer-ok-01";
    stubUpstream();

    const res = await post(
      testEnv(),
      "/api/v1/data/customer",
      CUSTOMER_BODY,
      SYNC_SECRET,
      id
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe(id);
    const body = (await res.json()) as {
      ok: boolean;
      localSync: { done: boolean; customerId: number };
    };
    expect(body.ok).toBe(true);
    expect(body.localSync.done).toBe(true);
    expect(body.localSync.customerId).toBe(5);
    expectNoRequestIdLeakInBody(body);
    expect(loggedErrors).toEqual([]);
  });
});

describe("routeware refresh failures carry the request id", () => {
  const specs = [
    {
      name: "customer",
      path: "/api/v1/routeware/customer/save-long-form",
      body: CUSTOMER_BODY,
      id: "save-corr-rw-customer-01"
    },
    {
      name: "address",
      path: "/api/v1/routeware/address/save-address-form",
      body: ADDRESS_BODY,
      id: "save-corr-rw-address-01"
    },
    {
      name: "container",
      path: "/api/v1/routeware/container/save-container-form",
      body: CONTAINER_BODY,
      id: "save-corr-rw-container-01"
    }
  ] as const;

  it.each(specs)(
    "$name: snapshot-sync failure logs the inbound id and keeps the 200 passthrough",
    async (spec) => {
      behavior.syncError = "SYNTHETIC-SYNC-DOWN";
      const seen = stubUpstream();
      const env = testEnv();

      const res = await post(env, spec.path, spec.body, API_TOKEN, spec.id);

      expect(res.status).toBe(200);
      expect(res.headers.get("X-Request-Id")).toBe(spec.id);
      expect(seen.modals).toEqual([]);
      expect(await res.text()).toBe('{"success":true}');
      const lines = recordsWith(
        "Post-save snapshot sync failed; evicting affected cache keys"
      );
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: "error",
        route: "routeware.saveRefresh",
        entity: spec.name,
        kind: "Error",
        requestId: spec.id
      });
    }
  );

  it("address: sync + customer + entity eviction failures share the one inbound id", async () => {
    const id = "save-corr-rw-address-evict-01";
    behavior.syncError = "SYNTHETIC-SYNC-DOWN";
    behavior.evictionErrors = {
      customer: new TypeError("SYNTHETIC-EVICT-CUSTOMER"),
      address: new RangeError("SYNTHETIC-EVICT-ADDRESS")
    };
    stubUpstream();

    const res = await post(
      testEnv(),
      "/api/v1/routeware/address/save-address-form",
      ADDRESS_BODY,
      API_TOKEN,
      id
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe(id);
    expect(calls.entity).toEqual([
      { kind: "customer", id: 5 },
      { kind: "address", id: 10 }
    ]);
    const syncLines = recordsWith(
      "Post-save snapshot sync failed; evicting affected cache keys"
    );
    const customerLines = recordsWith(
      "Post-save customer cache invalidation failed"
    );
    const entityLines = recordsWith(
      "Post-save entity cache invalidation failed"
    );
    expect(syncLines).toHaveLength(1);
    expect(customerLines).toHaveLength(1);
    expect(entityLines).toHaveLength(1);
    expect(customerLines[0]).toMatchObject({
      route: "routeware.saveRefresh.invalidate",
      entity: "customer",
      kind: "TypeError",
      requestId: id
    });
    expect(entityLines[0]).toMatchObject({
      route: "routeware.saveRefresh.invalidate",
      entity: "address",
      kind: "RangeError",
      requestId: id
    });
    for (const line of [...syncLines, ...customerLines, ...entityLines]) {
      expect(line).toMatchObject({ requestId: id });
    }
  });

  it("container: owner-lookup throw logs Post-save refresh failed with the inbound id", async () => {
    const id = "save-corr-rw-container-refresh-01";
    stubUpstream();
    // No CustomerID posted: the container refresh must consult D1 for the
    // owner, and that lookup throws before any sync is attempted.
    const env = testEnv(throwingDb());

    const res = await post(
      env,
      "/api/v1/routeware/container/save-container-form",
      `PickupAddressID=10&ContainerID=100&__RequestVerificationToken=${EXPLICIT_TOKEN}`,
      API_TOKEN,
      id
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe(id);
    expect(calls.synced).toEqual([]);
    const lines = recordsWith("Post-save refresh failed");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "error",
      route: "routeware.saveRefresh",
      entity: "container",
      kind: "TypeError",
      requestId: id
    });
    expect(JSON.stringify(lines)).not.toContain("SYNTHETIC-D1-DOWN");
  });

  it("valid save: no error lines on the routeware tier", async () => {
    const id = "save-corr-rw-customer-ok-01";
    stubUpstream();

    const res = await post(
      testEnv(),
      "/api/v1/routeware/customer/save-long-form",
      CUSTOMER_BODY,
      API_TOKEN,
      id
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe(id);
    expect(await res.text()).toBe('{"success":true}');
    expect(loggedErrors).toEqual([]);
  });
});

describe("routeware auto-token failures carry the request id", () => {
  it("address: missing CustomerID answers 400 and logs the inbound id", async () => {
    const id = "save-corr-rw-address-token-01";
    stubUpstream();

    const res = await post(
      testEnv(),
      "/api/v1/routeware/address/save-address-form",
      "PickupAddressID=0",
      API_TOKEN,
      id
    );

    expect(res.status).toBe(400);
    expect(res.headers.get("X-Request-Id")).toBe(id);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain(
      "New address requires CustomerID in POST body"
    );
    expectNoRequestIdLeakInBody(body);
    const lines = recordsWith("Address save token preparation failed");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "error",
      route: "POST /api/v1/routeware/address/save-address-form",
      requestId: id
    });
  });

  it("container: missing PickupAddressID answers 400 and logs the inbound id", async () => {
    const id = "save-corr-rw-container-token-01";
    stubUpstream();

    const res = await post(
      testEnv(),
      "/api/v1/routeware/container/save-container-form",
      "ContainerID=0",
      API_TOKEN,
      id
    );

    expect(res.status).toBe(400);
    expect(res.headers.get("X-Request-Id")).toBe(id);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain(
      "New container requires PickupAddressID in POST body"
    );
    expectNoRequestIdLeakInBody(body);
    const lines = recordsWith("Container save token preparation failed");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "error",
      route: "POST /api/v1/routeware/container/save-container-form",
      requestId: id
    });
  });

  it("customer: token-less modal without a token answers 502 and logs the inbound id", async () => {
    const id = "save-corr-rw-customer-token-01";
    stubUpstream("<form><p>synthetic modal with no token field</p></form>");

    const res = await post(
      testEnv(),
      "/api/v1/routeware/customer/save-long-form",
      "CustomerID=5&CompanyName=ExampleCo",
      API_TOKEN,
      id
    );

    expect(res.status).toBe(502);
    expect(res.headers.get("X-Request-Id")).toBe(id);
    expect(res.headers.get("content-type")).toContain("problem+json");
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("Anti-forgery token preparation failed");
    expectNoRequestIdLeakInBody(body);
    const lines = recordsWith("Customer save token preparation failed");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "error",
      route: "POST /api/v1/routeware/customer/save-long-form",
      requestId: id
    });
  });
});

describe("missing request var omits the field without crashing", () => {
  it.each([
    {
      name: "customer",
      run: (env: Env) =>
        handlePostDataCustomer(dataCtx(env, CUSTOMER_BODY)),
      msg: "Local customer snapshot sync failed"
    },
    {
      name: "address",
      run: (env: Env) =>
        handlePostDataAddress(dataCtx(env, ADDRESS_BODY)),
      msg: "Local address snapshot sync failed"
    },
    {
      name: "container",
      run: (env: Env) =>
        handlePostDataContainer(dataCtx(env, CONTAINER_BODY)),
      msg: "Local container snapshot sync failed"
    }
  ])("$name handler without the var keeps sync_failed and omits requestId", async ({ run, msg }) => {
    behavior.syncError = "SYNTHETIC-SYNC-DOWN";
    stubUpstream();

    // The ctx carries no request var at all (pre-middleware shape): the
    // handler must not crash and must not log an `undefined` sentinel.
    const res = await run(testEnv());

    expect(res.status).toBe(200);
    const body = (await res.json()) as { localSync: unknown };
    expect(body.localSync).toEqual({ done: false, code: "sync_failed" });
    expectOmissionWithoutSentinel(recordsWith(msg));
  });

  it("refresh helper without the id resolves and omits requestId on every line", async () => {
    behavior.syncError = "SYNTHETIC-SYNC-DOWN";
    behavior.evictionErrors = {
      customer: new TypeError("SYNTHETIC-EVICT-CUSTOMER"),
      address: new RangeError("SYNTHETIC-EVICT-ADDRESS")
    };
    const env = testEnv();
    const forwarded = new TextEncoder().encode(
      "CustomerID=5&PickupAddressID=10"
    ).buffer as ArrayBuffer;

    await expect(
      refreshAfterRoutewareSave(env, sessionStub(), "address", forwarded, '{"success":true}')
    ).resolves.toBeUndefined();

    expect(calls.entity).toEqual([
      { kind: "customer", id: 5 },
      { kind: "address", id: 10 }
    ]);
    expectOmissionWithoutSentinel(
      recordsWith("Post-save snapshot sync failed; evicting affected cache keys")
    );
    expectOmissionWithoutSentinel(
      recordsWith("Post-save customer cache invalidation failed")
    );
    expectOmissionWithoutSentinel(
      recordsWith("Post-save entity cache invalidation failed")
    );
  });
});
