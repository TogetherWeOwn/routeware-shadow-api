import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
 * Container post-refresh id-read failure preserves sync and graph eviction.
 *
 * Independent regression pin for the save-created-id review finding: a
 * successful container create whose owner-scoped post-refresh id SELECT fails
 * must still report the completed sync and still evict the full customer
 * graph. The id stays null (unavailable), but the refresh is not rewritten
 * as a failure and cached address bundles are not left stale.
 *
 * Contract pinned here:
 *
 * - Container create with naked upstream JSON + singleton post-refresh diff,
 *   where the post-refresh container SELECT throws after a successful sync:
 *   201, containerId null, localSync done:true, D1 holds the new row, and
 *   the customer + sibling entity-cache entries are all evicted.
 * - Upstream-JSON-id create resolves without needing the diff (control).
 * - Singleton diff resolves without fault (control).
 * - Pre-baseline read failure still saves with null diff and done:true
 *   (control proving the fault boundary is the post-refresh read, not the
 *   baseline).
 *
 * RED on the pre-fix head: the outer catch skips graph invalidation and
 * reports localSync sync_failed despite the completed refresh, leaving
 * sibling cache entries stale. Only Test Authors edit this file; the Builder
 * fixes source and never edits Test Author files.
 *
 * Harness: `app.fetch` + real D1 + stubbed upstream on `globalThis.fetch`;
 * any unexpected origin/path throws, so no test can reach a live host.
 * Explicit `__RequestVerificationToken` values skip the anti-forgery modal
 * fetch (modal paths throw when hit). All fixtures are synthetic.
 */

const ORIGIN = "https://upstream.test";
const OLD = "2000-01-01T00:00:00.000Z";
const SYNC_SECRET = "test-sync-secret";
const db = env.CUSTOMER_DB;

const customerCacheKey = new Request("https://routeware-shadow-entity/v1/customer/5");
const siblingCacheKeys = [
  new Request("https://routeware-shadow-entity/v1/address/11"),
  new Request("https://routeware-shadow-entity/v1/container/110")
];
const entityCache = (caches as unknown as { default: Cache }).default;

const NAKED_SUCCESS = '{"success":true}';
const SAVE_PATH = "/WebRW/Container/SaveContainerForm";
const DETAIL_PATH = "/WebRW/Customer/GetCustomerDetailFull";
const MODAL_PATHS = new Set([
  "/WebRW/Container/LoadContainerModal",
  "/WebRW/Container/CreateBlankContainer"
]);

type Graph = ReturnType<typeof graph>;

function graph(customerId: number, addresses: Array<[number, number[]]>) {
  return {
    currentCustomer: { CustomerID: customerId, CompanyName: "Synthetic customer" },
    data: addresses.map(([addressId, containers]) => ({
      PickupAddressID: addressId,
      CustomerID: customerId,
      Containers: containers.map((containerId) => ({ ContainerID: containerId }))
    }))
  };
}

function baseline(): Graph {
  return graph(5, [[10, [100, 101]], [11, [110]]]);
}

function afterSingleton(): Graph {
  return graph(5, [[10, [100, 101, 177]], [11, [110]]]);
}

const behavior: {
  save: (form: URLSearchParams) => Promise<Response>;
  detail: (customerId: number) => Promise<Response>;
} = {
  save: async () => new Response(NAKED_SUCCESS, { headers: { "content-type": "application/json" } }),
  detail: async () => Response.json(baseline())
};

const calls: { saves: number; detail: number[]; unexpected: string[] } = {
  saves: 0,
  detail: [],
  unexpected: []
};

async function fakeUpstream(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== ORIGIN) {
    calls.unexpected.push(`${request.method} ${url.origin}${url.pathname}`);
    throw new Error(`Unexpected upstream origin denied by harness: ${url.origin}`);
  }
  if (MODAL_PATHS.has(url.pathname)) {
    calls.unexpected.push(`${request.method} ${url.origin}${url.pathname}`);
    throw new Error(`Unexpected modal fetch in test (token was posted): ${url.pathname}`);
  }
  if (request.method === "POST" && url.pathname === SAVE_PATH) {
    calls.saves += 1;
    return behavior.save(new URLSearchParams(await request.text()));
  }
  if (request.method === "POST" && url.pathname === DETAIL_PATH) {
    const { customerID } = (await request.json()) as { customerID: number };
    calls.detail.push(customerID);
    return behavior.detail(customerID);
  }
  calls.unexpected.push(`${request.method} ${url.origin}${url.pathname}`);
  throw new Error(`Unexpected upstream path denied by harness: ${url.pathname}`);
}

const sessionStub = {
  fetch: async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/get") {
      return Response.json({ cookieHeader: "session=FAKE", expiresAtMs: Date.now() + 600_000, refreshing: false });
    }
    if (url.pathname === "/throttle/failure" || url.pathname === "/throttle/clear") {
      return Response.json({ blocked: false, retryAfterSec: 0 });
    }
    throw new Error(`Unexpected session operation: ${url.pathname}`);
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

async function scopedContainerIds(): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT container_id AS id FROM container_snapshot WHERE pickup_address_id = 10 ORDER BY container_id")
    .all<{ id: number }>();
  return results.map((row) => row.id);
}

function createForm(): URLSearchParams {
  return new URLSearchParams({
    ContainerID: "0",
    PickupAddressID: "10",
    CustomerID: "5",
    SerialNumber: "SYN-POST-REFRESH-ONLY",
    __RequestVerificationToken: "client-token"
  });
}

function callSave(values = createForm(), bindings = testEnv): Promise<Response> {
  return app.fetch(
    new Request("http://test.local/api/v1/data/container", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SYNC_SECRET}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: values.toString()
    }),
    bindings
  ) as Promise<Response>;
}

type SaveBody = {
  ok: boolean;
  routewareStatus: number;
  customerId: number | null;
  pickupAddressId?: number | null;
  containerId?: number | null;
  upstreamBytes: number;
  localSync: { done: boolean; customerId?: number; addressIds?: number[]; containerIds?: number[]; code?: string };
};

function expectSuccess(body: SaveBody): void {
  expect.soft(body.ok).toBe(true);
  expect.soft(body.routewareStatus).toBe(200);
  expect.soft(body.customerId).toBe(5);
  expect.soft(body.pickupAddressId).toBe(10);
  expect.soft(typeof body.upstreamBytes).toBe("number");
  expect.soft(body).not.toHaveProperty("posted");
  expect.soft(body).not.toHaveProperty("upstream");
  for (const forbidden of ["SYN-POST-REFRESH-ONLY", "client-token", "session=FAKE", "Synthetic"]) {
    expect.soft(JSON.stringify(body)).not.toContain(forbidden);
  }
}

async function seedStaleCache(): Promise<void> {
  for (const key of [customerCacheKey, ...siblingCacheKeys]) {
    await entityCache.put(
      key,
      new Response('{"stale":true}', { headers: { "cache-control": "public, max-age=600" } })
    );
    expect(await entityCache.match(key)).toBeDefined();
  }
}

/**
 * Fail container SELECTs that run after the upstream save has been called.
 * The pre-POST baseline (calls.saves === 0) still succeeds, the sync writes
 * still succeed (writes, not SELECTs), and only the post-refresh id read
 * throws. Preserves binding/batch/upsert behavior otherwise.
 */
function failPostRefreshContainerRead(): {
  bindings: Env;
  failures: string[];
  contexts: Array<{ saves: number; detail: number }>;
} {
  const failures: string[] = [];
  const contexts: Array<{ saves: number; detail: number }> = [];
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function wrapStatement(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const wrapped = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") {
          return (...values: unknown[]) => {
            const bound = target.bind(...values);
            const rewrapped = wrapStatement(bound, sql);
            originals.set(rewrapped, bound);
            return rewrapped;
          };
        }
        if (["all", "first", "raw", "run"].includes(String(key))) {
          return (...args: unknown[]) => {
            const isContainerSelect =
              /^\s*SELECT\b/i.test(sql) && /\bcontainer_snapshot\b/i.test(sql);
            if (isContainerSelect && calls.saves > 0) {
              failures.push(sql);
              contexts.push({ saves: calls.saves, detail: calls.detail.length });
              return Promise.reject(new Error("Synthetic post-refresh container id-read failure"));
            }
            return Reflect.apply(Reflect.get(target, key), target, args);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    originals.set(wrapped, statement);
    return wrapped;
  }
  const faultBinding = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrapStatement(target.prepare(sql), sql);
      if (key === "batch") {
        return (items: D1PreparedStatement[]) =>
          target.batch(items.map((item) => originals.get(item) ?? item));
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { bindings: { ...testEnv, CUSTOMER_DB: faultBinding } as Env, failures, contexts };
}

/** Fail the very first container SELECT (the pre-POST baseline). Control only. */
function failFirstContainerBaselineRead(): { bindings: Env; failures: string[] } {
  const failures: string[] = [];
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function wrapStatement(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const wrapped = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") {
          return (...values: unknown[]) => {
            const bound = target.bind(...values);
            const rewrapped = wrapStatement(bound, sql);
            originals.set(rewrapped, bound);
            return rewrapped;
          };
        }
        if (["all", "first", "raw", "run"].includes(String(key))) {
          return (...args: unknown[]) => {
            if (
              failures.length === 0 &&
              /^\s*SELECT\b/i.test(sql) &&
              /\bcontainer_snapshot\b/i.test(sql)
            ) {
              failures.push(sql);
              return Promise.reject(new Error("Synthetic baseline read failure"));
            }
            return Reflect.apply(Reflect.get(target, key), target, args);
          };
        }
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    originals.set(wrapped, statement);
    return wrapped;
  }
  const faultBinding = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrapStatement(target.prepare(sql), sql);
      if (key === "batch") {
        return (items: D1PreparedStatement[]) =>
          target.batch(items.map((item) => originals.get(item) ?? item));
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { bindings: { ...testEnv, CUSTOMER_DB: faultBinding } as Env, failures };
}

const realFetch = globalThis.fetch;
const realConsoleError = console.error;

beforeAll(async () => {
  await ensureD1TestTables();
});

beforeEach(async () => {
  clearAntiForgeryTokenCache();
  calls.saves = 0;
  calls.detail = [];
  calls.unexpected = [];
  behavior.save = async () => new Response(NAKED_SUCCESS, { headers: { "content-type": "application/json" } });
  behavior.detail = async () => Response.json(baseline());
  console.error = () => {};
  globalThis.fetch = fakeUpstream as typeof fetch;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  await seed(baseline());
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  console.error = realConsoleError;
  await Promise.all([customerCacheKey, ...siblingCacheKeys].map((key) => entityCache.delete(key)));
  expect(calls.unexpected).toEqual([]);
});

describe("container post-refresh id-read failure preserves sync and graph eviction", () => {
  it("null id + done:true + full graph eviction when the post-refresh SELECT throws after a successful sync", async () => {
    // Arrange — naked upstream success; the refresh introduces exactly one
    // new container under the owning address. Baseline succeeds; only the
    // post-refresh id read is faulted.
    const fault = failPostRefreshContainerRead();
    let failuresAtSave = -1;
    behavior.save = async () => {
      failuresAtSave = fault.failures.length;
      return new Response(NAKED_SUCCESS, { headers: { "content-type": "application/json" } });
    };
    behavior.detail = async (customerId) => {
      expect(customerId).toBe(5);
      return Response.json(afterSingleton());
    };
    expect(await scopedContainerIds()).toEqual([100, 101]);
    await seedStaleCache();

    // Act
    const response = await callSave(createForm(), fault.bindings);
    const body = (await response.json()) as SaveBody;

    // Assert — RED on the pre-fix head: outer catch reports sync_failed and
    // leaves sibling cache entries stale instead of done:true + full eviction.
    expect.soft(response.status).toBe(201);
    expectSuccess(body);
    expect.soft(body.containerId).toBeNull();
    expect.soft(body.localSync).toMatchObject({ done: true, customerId: 5 });
    expect.soft(failuresAtSave).toBe(0);
    expect.soft(fault.failures.length).toBeGreaterThanOrEqual(1);
    // The fault fired after the save reached upstream and after the refresh
    // detail fetch started, proving a post-sync read (not the baseline).
    expect.soft(calls.saves).toBe(1);
    expect.soft(calls.detail.length).toBeGreaterThan(0);
    expect.soft(calls.detail.every((customerId) => customerId === 5)).toBe(true);
    for (const context of fault.contexts) {
      expect.soft(context.saves).toBeGreaterThanOrEqual(1);
      expect.soft(context.detail).toBeGreaterThanOrEqual(1);
    }
    // The sync really landed: D1 holds the new row even though its id is null.
    expect.soft(await scopedContainerIds()).toEqual([100, 101, 177]);
    // Full graph invalidation still ran: customer + every sibling evicted.
    expect.soft(await entityCache.match(customerCacheKey)).toBeUndefined();
    for (const key of siblingCacheKeys) {
      expect.soft(await entityCache.match(key)).toBeUndefined();
    }
    expect.soft(JSON.stringify(body)).not.toContain("Synthetic");
  });
});

describe("container post-refresh controls", () => {
  it("control: upstream JSON id resolves without needing the diff", async () => {
    behavior.save = async () =>
      new Response('{"success":true,"data":{"ContainerID":177}}', {
        headers: { "content-type": "application/json" }
      });
    behavior.detail = async () => Response.json(afterSingleton());
    await seedStaleCache();

    const response = await callSave();
    const body = (await response.json()) as SaveBody;

    expect(response.status).toBe(201);
    expect(body.containerId).toBe(177);
    expectSuccess(body);
    expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
    expect(calls.saves).toBe(1);
    expect(calls.detail).toEqual([5]);
    expect(await scopedContainerIds()).toEqual([100, 101, 177]);
    expect(await entityCache.match(customerCacheKey)).toBeUndefined();
    for (const key of siblingCacheKeys) {
      expect(await entityCache.match(key)).toBeUndefined();
    }
  });

  it("control: singleton diff resolves without fault", async () => {
    behavior.save = async () => new Response(NAKED_SUCCESS, { headers: { "content-type": "application/json" } });
    behavior.detail = async () => Response.json(afterSingleton());
    await seedStaleCache();

    const response = await callSave();
    const body = (await response.json()) as SaveBody;

    expect(response.status).toBe(201);
    expect(body.containerId).toBe(177);
    expectSuccess(body);
    expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
    expect(calls.saves).toBe(1);
    expect(calls.detail).toEqual([5]);
    expect(await scopedContainerIds()).toEqual([100, 101, 177]);
    expect(await entityCache.match(customerCacheKey)).toBeUndefined();
    for (const key of siblingCacheKeys) {
      expect(await entityCache.match(key)).toBeUndefined();
    }
  });

  it("control: pre-baseline read failure still saves with null diff and done:true", async () => {
    const fault = failFirstContainerBaselineRead();
    let failuresAtSave = -1;
    behavior.save = async () => {
      failuresAtSave = fault.failures.length;
      return new Response(NAKED_SUCCESS, { headers: { "content-type": "application/json" } });
    };
    behavior.detail = async () => Response.json(afterSingleton());
    await seedStaleCache();

    const response = await callSave(createForm(), fault.bindings);
    const body = (await response.json()) as SaveBody;

    expect(response.status).toBe(201);
    expect(body.containerId).toBeNull();
    expectSuccess(body);
    expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
    expect(fault.failures).toHaveLength(1);
    expect(failuresAtSave).toBe(1);
    expect(calls.saves).toBe(1);
    expect(calls.detail.length).toBeGreaterThan(0);
    expect(await scopedContainerIds()).toEqual([100, 101, 177]);
    expect(await entityCache.match(customerCacheKey)).toBeUndefined();
    for (const key of siblingCacheKeys) {
      expect(await entityCache.match(key)).toBeUndefined();
    }
  });
});
