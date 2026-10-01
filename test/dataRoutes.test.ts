import { beforeEach, describe, expect, it, vi } from "vitest";
import { problemType } from "../src/lib/problem";

/**
 * `src/routes/dataSnapshot.ts` and `src/routes/dataEntity.ts` are thin: an auth
 * guard, some parameter resolution, then delegation. `test/snapshotAuth.test.ts`
 * pins their 401 bodies and `test/dataEntity*.test.ts` pin the handlers they
 * delegate to — but nothing covered the wiring in between, which is where the
 * id actually gets chosen.
 *
 * Two things here are worth a test rather than a glance:
 *
 * 1. `/api/v1/data-snapshot/sync` chains three internal HTTP calls to the
 *    per-table sync routes, and it must derive the origin from the **incoming
 *    request**. A hardcoded or misread origin would send the chained calls to
 *    the wrong Worker — or to production from a preview deployment.
 * 2. The `id` guards unify the `customerId`-style alias across all three
 *    GETs, and both halves are reachable. Each route accepts `id` **or** its
 *    alias (`customerId` / `pickupAddressId` / `containerId`), prefers `id`
 *    when both are supplied, and 400s when both are absent; address and
 *    container additionally reject `0` and negatives, which the zod `int()`
 *    schema alone lets through. An id of `0` reaching D1 is a silent empty
 *    result, not an error.
 *
 * The route modules are fetched directly rather than through `src/app.ts`, so
 * the app-wide `/api/v1/*` gate is out of the picture and only the narrower
 * snapshot-secret check applies.
 */

type Call = { args: unknown[] };

/** Records every delegation. Reset in `beforeEach`. */
const calls: Record<string, Call[]> = {};

function record(name: string, ...args: unknown[]): Response {
  (calls[name] ??= []).push({ args });
  return new Response(JSON.stringify({ handler: name }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

const chainedResult = {
  customer: { upserted: 3, rowCount: 3 },
  address: { upserted: 2, rowCount: 2 },
  container: null
};

/**
 * Plain functions, not `vi.fn()`: a spy wrapping a double that rejects records
 * the settled result and turns a deliberate rejection into an unhandled
 * rejection under `@cloudflare/vitest-pool-workers`.
 */
vi.mock("../src/lib/dataEntityHandlers", () => ({
  handleGetDataCustomer: async (ctx: unknown, id: number) => record("getCustomer", ctx, id),
  handleGetDataAddress: async (ctx: unknown, id: number) => record("getAddress", ctx, id),
  handleGetDataContainer: async (ctx: unknown, id: number) => record("getContainer", ctx, id),
  handlePostDataCustomer: async (ctx: unknown) => record("postCustomer", ctx),
  handlePostDataAddress: async (ctx: unknown) => record("postAddress", ctx),
  handlePostDataContainer: async (ctx: unknown) => record("postContainer", ctx)
}));

vi.mock("../src/lib/d1SnapshotSync", () => ({
  runDataSnapshotSyncChainedHttp: async (origin: string, env: unknown) => {
    (calls.chained ??= []).push({ args: [origin, env] });
    return chainedResult;
  }
}));

const { dataSnapshotRoutes } = await import("../src/routes/dataSnapshot");
const { dataEntityRoutes } = await import("../src/routes/dataEntity");

type RouteModule = typeof dataEntityRoutes;

const SECRET = "sync-secret";
const BAD_REQUEST_TYPE = problemType("bad-request");

type ProblemBody = { type: string; title: string; status: number; detail?: string };

function makeEnv(): Env {
  return { CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET } as unknown as Env;
}

const ctx = {
  waitUntil() {},
  passThroughOnException() {}
} as unknown as ExecutionContext;

async function call(
  routes: RouteModule,
  url: string,
  init: RequestInit = {},
  env: Env = makeEnv()
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${SECRET}`);
  return await routes.fetch(new Request(url, { ...init, headers }), env, ctx);
}

/** Same call with a bearer that is not the sync secret. */
async function callUnauthorized(
  routes: RouteModule,
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  return await routes.fetch(
    new Request(url, { ...init, headers: { authorization: "Bearer not-the-secret" } }),
    makeEnv(),
    ctx
  );
}

beforeEach(() => {
  for (const key of Object.keys(calls)) {
    delete calls[key];
  }
});

describe("POST /api/v1/data-snapshot/sync", () => {
  it("derives the chain origin from the incoming request URL", async () => {
    // Arrange — the chained calls go back to this same Worker, so the origin
    // has to come from the request. A fixed origin would make a preview
    // deployment drive the production Worker's D1.
    const env = makeEnv();

    // Act
    const res = await call(
      dataSnapshotRoutes,
      "https://shadow-preview.example.com/api/v1/data-snapshot/sync",
      { method: "POST" },
      env
    );

    // Assert
    expect(res.status).toBe(200);
    expect(calls.chained).toHaveLength(1);
    expect(calls.chained[0].args[0]).toBe("https://shadow-preview.example.com");
    expect(calls.chained[0].args[1]).toBe(env);
  });

  it("passes the origin only, not the full request path", async () => {
    // Arrange — `new URL(url).origin` must drop the path; appending
    // `/api/v1/customer-snapshot/sync` to a full URL would 404 the chain.
    // Act
    await call(dataSnapshotRoutes, "http://test.local/api/v1/data-snapshot/sync", {
      method: "POST"
    });

    // Assert
    expect(calls.chained[0].args[0]).toBe("http://test.local");
  });

  it("returns the per-table chain result verbatim", async () => {
    // Arrange — `container: null` means that table was skipped; it must survive
    // as null rather than being coerced into a zero-row success.
    // Act
    const res = await call(dataSnapshotRoutes, "http://test.local/api/v1/data-snapshot/sync", {
      method: "POST"
    });

    // Assert
    expect(await res.json()).toEqual(chainedResult);
  });

  it("does not run the chain for a request carrying the wrong bearer", async () => {
    // Arrange / Act
    const res = await callUnauthorized(
      dataSnapshotRoutes,
      "http://test.local/api/v1/data-snapshot/sync",
      { method: "POST" }
    );

    // Assert
    expect(res.status).toBe(401);
    expect(calls.chained).toBeUndefined();
  });
});

describe("GET /api/v1/data/customer", () => {
  it("delegates the id from the `id` query parameter", async () => {
    // Arrange / Act
    const res = await call(dataEntityRoutes, "http://test.local/api/v1/data/customer?id=42");

    // Assert
    expect(res.status).toBe(200);
    expect(calls.getCustomer[0].args[1]).toBe(42);
  });

  it("accepts the documented `customerId` alias", async () => {
    // Arrange / Act
    await call(dataEntityRoutes, "http://test.local/api/v1/data/customer?customerId=7");

    // Assert
    expect(calls.getCustomer[0].args[1]).toBe(7);
  });

  it("prefers `id` when both spellings are supplied", async () => {
    // Arrange — `q.id ?? q.customerId`; a swap here would silently serve a
    // different customer's PII than the one the caller asked for.
    // Act
    await call(dataEntityRoutes, "http://test.local/api/v1/data/customer?id=1&customerId=2");

    // Assert
    expect(calls.getCustomer[0].args[1]).toBe(1);
  });

  it("returns 400 problem+json when neither spelling is supplied", async () => {
    // Arrange / Act
    const res = await call(dataEntityRoutes, "http://test.local/api/v1/data/customer");

    // Assert
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(BAD_REQUEST_TYPE);
    expect(body.title).toBe("Bad Request");
    expect(body.detail).toBe("Query `id` or `customerId` (customer_id) is required. See docs/PROBLEMS.md#bad-request.");
    expect(calls.getCustomer).toBeUndefined();
  });

  it("rejects a non-numeric id at the schema", async () => {
    // Arrange / Act
    const res = await call(dataEntityRoutes, "http://test.local/api/v1/data/customer?id=abc");

    // Assert
    expect(res.status).toBe(400);
    expect(calls.getCustomer).toBeUndefined();
  });

  it("passes env through to the handler context", async () => {
    // Arrange — the handler reads D1 and the Workers cache off this object.
    const env = makeEnv();

    // Act
    await call(dataEntityRoutes, "http://test.local/api/v1/data/customer?id=5", {}, env);

    // Assert
    expect((calls.getCustomer[0].args[0] as { env: Env }).env).toBe(env);
  });
});

/**
 * Address and container unify the customer route's alias pattern: `id` or the
 * camelCase alias, with `id` winning when both are supplied. `0`/negatives
 * are rejected by the handler on top of the schema. Both halves are live —
 * `z.coerce.number().int()` accepts `0`.
 */
describe.each([
  {
    name: "address",
    path: "/api/v1/data/address",
    handler: "getAddress",
    alias: "pickupAddressId",
    detail: "Query `id` or `pickupAddressId` (pickup_address_id) is required and must be a positive integer. See docs/PROBLEMS.md#bad-request."
  },
  {
    name: "container",
    path: "/api/v1/data/container",
    handler: "getContainer",
    alias: "containerId",
    detail: "Query `id` or `containerId` (container_id) is required and must be a positive integer. See docs/PROBLEMS.md#bad-request."
  }
])("GET $path", (spec) => {
  it("delegates a positive id", async () => {
    // Arrange / Act
    const res = await call(dataEntityRoutes, `http://test.local${spec.path}?id=42`);

    // Assert
    expect(res.status).toBe(200);
    expect(calls[spec.handler][0].args[1]).toBe(42);
  });

  it("accepts the documented camelCase alias", async () => {
    // Arrange / Act
    const res = await call(dataEntityRoutes, `http://test.local${spec.path}?${spec.alias}=7`);

    // Assert
    expect(res.status).toBe(200);
    expect(calls[spec.handler][0].args[1]).toBe(7);
  });

  it("prefers `id` when both spellings are supplied", async () => {
    // Arrange — `q.id ?? q.alias`; a swap here would silently serve a
    // different record's PII than the one the caller asked for.
    // Act
    const res = await call(dataEntityRoutes, `http://test.local${spec.path}?id=1&${spec.alias}=2`);

    // Assert
    expect(res.status).toBe(200);
    expect(calls[spec.handler][0].args[1]).toBe(1);
  });

  it("rejects id=0, which the int schema accepts but D1 never matches", async () => {
    // Arrange — without this guard a `0` reaches D1 and returns an empty
    // aggregate as a 200, which reads to a client as "no such row".
    // Act
    const res = await call(dataEntityRoutes, `http://test.local${spec.path}?id=0`);

    // Assert
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(BAD_REQUEST_TYPE);
    expect(body.detail).toBe(spec.detail);
    expect(calls[spec.handler]).toBeUndefined();
  });

  it("rejects a negative alias id", async () => {
    // Arrange / Act
    const res = await call(dataEntityRoutes, `http://test.local${spec.path}?${spec.alias}=-5`);

    // Assert
    expect(res.status).toBe(400);
    expect(calls[spec.handler]).toBeUndefined();
  });

  it("rejects a negative id", async () => {
    // Arrange / Act
    const res = await call(dataEntityRoutes, `http://test.local${spec.path}?id=-5`);

    // Assert
    expect(res.status).toBe(400);
    expect(calls[spec.handler]).toBeUndefined();
  });

  it("returns 400 problem+json when neither spelling is supplied", async () => {
    // Arrange / Act
    const res = await call(dataEntityRoutes, `http://test.local${spec.path}`);

    // Assert
    expect(res.status).toBe(400);
    const body = (await res.json()) as ProblemBody;
    expect(body.type).toBe(BAD_REQUEST_TYPE);
    expect(body.detail).toBe(spec.detail);
    expect(calls[spec.handler]).toBeUndefined();
  });
});

describe.each([
  { name: "customer", path: "/api/v1/data/customer", handler: "postCustomer" },
  { name: "address", path: "/api/v1/data/address", handler: "postAddress" },
  { name: "container", path: "/api/v1/data/container", handler: "postContainer" }
])("POST $path", (spec) => {
  it("delegates to its own handler after the auth gate", async () => {
    // Arrange — the three POST routes are wired to three different handlers;
    // a copy-paste slip would send a container save to the address handler.
    // Act
    const res = await call(dataEntityRoutes, `http://test.local${spec.path}`, {
      method: "POST",
      body: "CustomerID=0",
      headers: { "content-type": "application/x-www-form-urlencoded" }
    });

    // Assert
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ handler: spec.handler });
    expect(calls[spec.handler]).toHaveLength(1);
  });

  it("does not reach the handler without the sync secret", async () => {
    // Arrange / Act
    const res = await callUnauthorized(dataEntityRoutes, `http://test.local${spec.path}`, {
      method: "POST"
    });

    // Assert
    expect(res.status).toBe(401);
    expect(calls[spec.handler]).toBeUndefined();
  });
});
