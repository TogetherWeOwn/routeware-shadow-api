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
 * Independent review regressions: test-only handoff, intentionally RED before
 * the Builder's fixes. The original 19 acceptance pins remain unmodified.
 *
 * Real app.fetch + synthetic local D1. Only the external session/upstream are
 * doubled; every unexpected network origin/path is denied. Explicit tokens
 * keep the modal-fetch path out of these ID-classification tests.
 *
 * Breaks caught: snapshotting after mutation can attribute B's id to A;
 * camelCase form keys can turn creates into updates; a failed baseline read
 * can prevent a successful upstream save or invent a diff from an empty set.
 */
const ORIGIN = "https://upstream.test";
const OLD = "2000-01-01T00:00:00.000Z";
const db = env.CUSTOMER_DB;
const customerCacheKey = new Request("https://routeware-shadow-entity/v1/customer/5");
const siblingCacheKeys = [
  new Request("https://routeware-shadow-entity/v1/address/11"),
  new Request("https://routeware-shadow-entity/v1/container/110")
];
const entityCache = (caches as unknown as { default: Cache }).default;
const NAKED_SUCCESS = '{"success":true}';
const SAVE_PATHS = {
  address: "/WebRW/PickupAddress/SaveAddressForm",
  container: "/WebRW/Container/SaveContainerForm"
} as const;
type Entity = keyof typeof SAVE_PATHS;
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

function afterCreates(entity: Entity, count: 0 | 1 | 2): Graph {
  if (entity === "address") {
    const addresses: Array<[number, number[]]> = [[10, [100, 101]], [11, [110]]];
    if (count >= 1) addresses.push([77, []]);
    if (count === 2) addresses.push([78, []]);
    return graph(5, addresses);
  }
  return graph(5, [[10, count === 0 ? [100, 101] : count === 1 ? [100, 101, 177] : [100, 101, 177, 178]], [11, [110]]]);
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const behavior: {
  save: (entity: Entity, form: URLSearchParams) => Promise<Response>;
  detail: (customerId: number) => Promise<Response>;
} = {
  save: async () => Response.json({ success: true }),
  detail: async () => Response.json(baseline())
};
const calls: { saves: Entity[]; detail: number[]; unexpected: string[] } = {
  saves: [], detail: [], unexpected: []
};

async function fakeUpstream(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const entity = (Object.keys(SAVE_PATHS) as Entity[]).find((key) => SAVE_PATHS[key] === url.pathname);
  if (url.origin === ORIGIN && request.method === "POST" && entity) {
    calls.saves.push(entity);
    return behavior.save(entity, new URLSearchParams(await request.text()));
  }
  if (url.origin === ORIGIN && request.method === "POST" && url.pathname === "/WebRW/Customer/GetCustomerDetailFull") {
    const { customerID } = await request.json() as { customerID: number };
    calls.detail.push(customerID);
    return behavior.detail(customerID);
  }
  calls.unexpected.push(`${request.method} ${url.origin}${url.pathname}`);
  throw new Error("Unexpected network request denied by created-id regression harness");
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

async function scopedIds(entity: Entity): Promise<number[]> {
  const statement = entity === "address"
    ? db.prepare("SELECT pickup_address_id AS id FROM address_snapshot WHERE customer_id = 5 ORDER BY pickup_address_id")
    : db.prepare("SELECT container_id AS id FROM container_snapshot WHERE pickup_address_id = 10 ORDER BY container_id");
  const { results } = await statement.all<{ id: number }>();
  return results.map((row) => row.id);
}

function form(entity: Entity, postedId = "0", camelCase = false): URLSearchParams {
  const values = new URLSearchParams({ CustomerID: "5", __RequestVerificationToken: "client-token" });
  if (entity === "address") {
    values.set(camelCase ? "pickupAddressID" : "PickupAddressID", postedId);
    values.set("Address", "9 Synthetic Way Apt 4B");
  } else {
    values.set(camelCase ? "containerID" : "ContainerID", postedId);
    values.set("PickupAddressID", "10");
    values.set("SerialNumber", "SYN-REVIEW-ONLY");
  }
  return values;
}

function callSave(entity: Entity, values = form(entity), bindings = testEnv): Promise<Response> {
  return app.fetch(new Request(`http://test.local/api/v1/data/${entity}`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-sync-secret",
      "content-type": "application/x-www-form-urlencoded"
    },
    body: values.toString()
  }), bindings) as Promise<Response>;
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

function createdId(entity: Entity, body: SaveBody): number | null | undefined {
  return entity === "address" ? body.pickupAddressId : body.containerId;
}

function jsonId(entity: Entity, id: number): string {
  return JSON.stringify({ success: true, data: { [entity === "address" ? "PickupAddressID" : "ContainerID"]: id } });
}

function expectSuccess(body: SaveBody) {
  expect.soft(body.ok).toBe(true);
  expect.soft(body.routewareStatus).toBe(200);
  expect.soft(body.customerId).toBe(5);
  expect.soft(typeof body.upstreamBytes).toBe("number");
  expect.soft(body).not.toHaveProperty("posted");
  expect.soft(body).not.toHaveProperty("upstream");
  for (const forbidden of ["9 Synthetic Way", "Apt 4B", "SYN-REVIEW-ONLY", "client-token", "session=FAKE"]) {
    expect.soft(JSON.stringify(body)).not.toContain(forbidden);
  }
}

/** Fail one real SELECT, preserving binding/batch/upsert/refresh behavior. */
function failFirstBaselineRead(entity: Entity) {
  const table = entity === "address" ? "address_snapshot" : "container_snapshot";
  const failures: string[] = [];
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function wrapStatement(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const wrapped = new Proxy(statement, {
      get(target, key) {
        if (key === "bind") {
          return (...values: unknown[]) => wrapStatement(target.bind(...values), sql);
        }
        if (["all", "first", "raw", "run"].includes(String(key))) {
          return (...args: unknown[]) => {
            if (failures.length === 0 && /^\s*SELECT\b/i.test(sql) && new RegExp(`\\b${table}\\b`, "i").test(sql)) {
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
  const binding = new Proxy(db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => wrapStatement(target.prepare(sql), sql);
      if (key === "batch") return (items: D1PreparedStatement[]) => target.batch(items.map((item) => originals.get(item) ?? item));
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  return { bindings: { ...testEnv, CUSTOMER_DB: binding } as Env, failures };
}

const realFetch = globalThis.fetch;
const realConsoleError = console.error;

beforeAll(async () => { await ensureD1TestTables(); });
beforeEach(async () => {
  clearAntiForgeryTokenCache();
  calls.saves = [];
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

for (const entity of ["address", "container"] as const) {
  const oldId = entity === "address" ? 10 : 100;
  const newId = entity === "address" ? 77 : 177;
  const otherId = entity === "address" ? 78 : 178;

  describe(`${entity} created-id review regressions`, () => {
    it("takes the baseline before upstream mutation: A never receives B's id after an overlapping update publishes A", async () => {
      const aEntered = gate();
      const releaseA = gate();
      const bEntered = gate();
      const releaseB = gate();
      let current = baseline();
      behavior.detail = async (customerId) => {
        expect(customerId).toBe(5);
        return Response.json(current);
      };
      behavior.save = async (actualEntity, values) => {
        expect(actualEntity).toBe(entity);
        if (values.get("TestRequest") === "A") {
          current = afterCreates(entity, 1);
          aEntered.release();
          await releaseA.promise;
          return Response.json({ success: true });
        }
        if (values.get("TestRequest") === "B") {
          current = afterCreates(entity, 2);
          bEntered.release();
          await releaseB.promise;
          return new Response(jsonId(entity, otherId), { headers: { "content-type": "application/json" } });
        }
        return Response.json({ success: true });
      };
      expect(await scopedIds(entity)).toEqual(entity === "address" ? [10, 11] : [100, 101]);
      const aForm = form(entity);
      aForm.set("TestRequest", "A");
      const aRequest = callSave(entity, aForm);
      let bRequest: Promise<Response> | undefined;
      try {
        await Promise.race([
          aEntered.promise,
          aRequest.then(() => { throw new Error("A completed before reaching the held upstream save"); })
        ]);
        const update = await callSave(entity, form(entity, String(oldId)));
        expect(update.status).toBe(200);
        const updateBody = await update.json() as SaveBody;
        expect(createdId(entity, updateBody)).toBe(oldId);
        expect(updateBody.localSync.done).toBe(true);
        expect(await scopedIds(entity)).toEqual(entity === "address" ? [10, 11, 77] : [100, 101, 177]);

        const bForm = form(entity);
        bForm.set("TestRequest", "B");
        bRequest = callSave(entity, bForm);
        await Promise.race([
          bEntered.promise,
          bRequest.then(() => { throw new Error("B completed before reaching the held upstream save"); })
        ]);
        // B has mutated upstream, but cannot publish a local refresh yet.
        // A's refresh sees both new ids after the overlapping update stored A.
        releaseA.release();
        const aResponse = await aRequest;
        const aBody = await aResponse.json() as SaveBody;
        expect.soft(aResponse.status).toBe(201);
        expectSuccess(aBody);
        expect.soft(aBody.localSync).toMatchObject({ done: true, customerId: 5 });
        expect.soft(createdId(entity, aBody)).toBeNull();
        expect.soft(createdId(entity, aBody)).not.toBe(otherId);
        expect(await scopedIds(entity)).toEqual(entity === "address" ? [10, 11, 77, 78] : [100, 101, 177, 178]);
        releaseB.release();
        const bResponse = await bRequest;
        expect(bResponse.status).toBe(201);
        expect(createdId(entity, await bResponse.json() as SaveBody)).toBe(otherId);
        expect(calls.saves).toEqual([entity, entity, entity]);
        expect(calls.detail).toEqual([5, 5, 5]);
      } finally {
        releaseA.release();
        releaseB.release();
        await Promise.allSettled([aRequest, ...(bRequest ? [bRequest] : [])]);
      }
    });

    it("resolves only within the customer/address owner scope, ignoring concurrent rows elsewhere", async () => {
      await seed(graph(6, [[60, [600]]]));
      behavior.detail = async () => {
        await seed(graph(6, [[60, [600]], [88, [288]]]));
        return Response.json(entity === "address"
          ? afterCreates(entity, 1)
          : graph(5, [[10, [100, 101, 177]], [11, [110, 188]]]));
      };
      const response = await callSave(entity);
      const body = await response.json() as SaveBody;
      expect(response.status).toBe(201);
      expect(createdId(entity, body)).toBe(newId);
      expectSuccess(body);
      expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
      expect(await scopedIds(entity)).toEqual(entity === "address" ? [10, 11, 77] : [100, 101, 177]);
      const foreignAddress = await db.prepare("SELECT customer_id FROM address_snapshot WHERE pickup_address_id = 88").first<{ customer_id: number }>();
      expect(foreignAddress?.customer_id).toBe(6);
      if (entity === "container") {
        const sibling = await db.prepare("SELECT pickup_address_id FROM container_snapshot WHERE container_id = 188").first<{ pickup_address_id: number }>();
        expect(sibling?.pickup_address_id).toBe(11);
      }
    });

    for (const scenario of [
      { name: "upstream JSON wins even with an ambiguous refresh", json: true, count: 2, want: newId },
      { name: "naked JSON uses the singleton scoped diff", json: false, count: 1, want: newId },
      { name: "naked JSON stays null for an ambiguous diff", json: false, count: 2, want: null },
      { name: "naked JSON stays null for an unchanged refresh", json: false, count: 0, want: null }
    ] as const) {
      it(`ignores camelCase posted ${entity === "address" ? "pickupAddressID" : "containerID"}: ${scenario.name}`, async () => {
        const upstreamBody = scenario.json ? jsonId(entity, newId) : NAKED_SUCCESS;
        behavior.save = async () => new Response(upstreamBody, { headers: { "content-type": "application/json" } });
        behavior.detail = async () => Response.json(afterCreates(entity, scenario.count));
        const response = await callSave(entity, form(entity, String(oldId), true));
        const body = await response.json() as SaveBody;
        expect.soft(response.status).toBe(201);
        expect.soft(createdId(entity, body)).toBe(scenario.want);
        expect.soft(createdId(entity, body)).not.toBe(oldId);
        expectSuccess(body);
        expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
        expect(calls.saves).toEqual([entity]);
        expect(calls.detail).toEqual([5]);
      });
    }

    it("keeps PascalCase updates at 200 and echoes the posted id even if upstream JSON carries another id", async () => {
      behavior.save = async () => new Response(jsonId(entity, newId), { headers: { "content-type": "application/json" } });
      const response = await callSave(entity, form(entity, String(oldId)));
      const body = await response.json() as SaveBody;
      expect(response.status).toBe(200);
      expect(createdId(entity, body)).toBe(oldId);
      expectSuccess(body);
      expect(body.localSync).toMatchObject({ done: true, customerId: 5 });
    });

    for (const upstreamHasId of [true, false]) {
      for (const refreshSucceeds of [true, false]) {
        it(`a baseline-read failure still forwards once, ${refreshSucceeds ? "refreshes and evicts the graph" : "attempts refresh and evicts the customer after refresh failure"}, ${upstreamHasId ? "preserving the upstream JSON id" : "never fabricating a diff without a baseline"}`, async () => {
          const fault = failFirstBaselineRead(entity);
          let failuresAtSave = -1;
          behavior.save = async () => {
            failuresAtSave = fault.failures.length;
            return new Response(upstreamHasId ? jsonId(entity, newId) : NAKED_SUCCESS, {
              headers: { "content-type": "application/json" }
            });
          };
          behavior.detail = async () => refreshSucceeds
            ? Response.json(afterCreates(entity, 1))
            : new Response("Synthetic detail unavailable", { status: 503 });
          for (const key of [customerCacheKey, ...siblingCacheKeys]) {
            await entityCache.put(key, new Response('{"stale":true}', {
              headers: { "cache-control": "public, max-age=600" }
            }));
            expect(await entityCache.match(key)).toBeDefined();
          }

          const response = await callSave(entity, form(entity), fault.bindings);
          const body = await response.json() as SaveBody;
          expect.soft(response.status).toBe(201);
          expect.soft(fault.failures).toHaveLength(1);
          expect.soft(failuresAtSave).toBe(1);
          expect.soft(calls.saves).toEqual([entity]);
          // Detail reads may retry; the successful upstream mutation must not.
          expect.soft(calls.detail.length).toBeGreaterThan(0);
          expect.soft(calls.detail.every((customerId) => customerId === 5)).toBe(true);
          expectSuccess(body);
          expect.soft(createdId(entity, body)).toBe(upstreamHasId ? newId : null);
          if (refreshSucceeds) {
            expect.soft(body.localSync).toMatchObject({ done: true, customerId: 5 });
            for (const key of siblingCacheKeys) {
              expect.soft(await entityCache.match(key)).toBeUndefined();
            }
            expect.soft(await scopedIds(entity)).toEqual(entity === "address" ? [10, 11, 77] : [100, 101, 177]);
          } else {
            expect.soft(body.localSync).toEqual({ done: false, code: "sync_failed" });
            expect.soft(await scopedIds(entity)).toEqual(entity === "address" ? [10, 11] : [100, 101]);
          }
          expect.soft(await entityCache.match(customerCacheKey)).toBeUndefined();
          expect(JSON.stringify(body)).not.toContain("Synthetic");
        });
      }
    }
  });
}
