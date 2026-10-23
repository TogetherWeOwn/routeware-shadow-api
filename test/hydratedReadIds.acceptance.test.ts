import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HTTP acceptance contract: query text must never select a different row through
 * numeric coercion. Keep routing, validation, hydration and ETag calculation real;
 * replace only external cache/D1/network boundaries. Handler wrappers observe
 * entry without replacing the behavior with canned responses.
 */
const work = {
  handlers: [] as Array<{ kind: string; id: number }>,
  cacheReads: 0,
  cacheWrites: 0,
  dbReads: 0
};
const cache = new Map<string, Response>();

vi.mock("../src/lib/dataEntityHandlers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/dataEntityHandlers")>();
  type Ctx = Parameters<typeof actual.handleGetDataCustomer>[0];
  return {
    ...actual,
    handleGetDataCustomer: (ctx: Ctx, id: number) => {
      work.handlers.push({ kind: "customer", id });
      return actual.handleGetDataCustomer(ctx, id);
    },
    handleGetDataAddress: (ctx: Ctx, id: number) => {
      work.handlers.push({ kind: "address", id });
      return actual.handleGetDataAddress(ctx, id);
    },
    handleGetDataContainer: (ctx: Ctx, id: number) => {
      work.handlers.push({ kind: "container", id });
      return actual.handleGetDataContainer(ctx, id);
    }
  };
});

vi.mock("../src/lib/entityDataCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/entityDataCache")>();
  return {
    ...actual,
    getCachedDataEntity: async (kind: string, id: number) => {
      work.cacheReads += 1;
      return cache.get(`${kind}:${id}`)?.clone();
    },
    putCachedDataEntity: async (kind: string, id: number, response: Response) => {
      work.cacheWrites += 1;
      cache.set(`${kind}:${id}`, response.clone());
    }
  };
});

const { default: app } = await import("../src/app");
const SECRET = "synthetic-hydrated-read-secret";
const MAX_ID = 9007199254740991;
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
const specs = [
  { kind: "customer", alias: "customerId", key: "customer_id", field: "company_name" },
  { kind: "address", alias: "pickupAddressId", key: "pickup_address_id", field: "city" },
  { kind: "container", alias: "containerId", key: "container_id", field: "serial_number" }
] as const;
type Spec = (typeof specs)[number];
type Row = Record<string, unknown>;
const tables = {
  customer_snapshot: [1, 2, 42, MAX_ID].map((id) => ({
    customer_id: id, company_name: `Synthetic customer ${id}`
  })),
  address_snapshot: [1, 2, 42, MAX_ID].map((id) => ({
    pickup_address_id: id, customer_id: id, city: `Synthetic address ${id}`
  })),
  container_snapshot: [1, 2, 42, MAX_ID].map((id) => ({
    container_id: id, pickup_address_id: id, serial_number: `Synthetic container ${id}`
  }))
};

/** Bound IDs determine results; an unknown ID cannot get a canned success. */
function fakeDb(): D1Database {
  return {
    prepare(sql: string) {
      work.dbReads += 1;
      const table = Object.keys(tables).find((name) => sql.includes(`FROM ${name}`));
      if (!table) throw new Error("Unexpected SQL in synthetic hydrated-read fixture");
      const rows: Row[] = tables[table as keyof typeof tables];
      return {
        bind(...ids: unknown[]) {
          return {
            async first() {
              const key = table === "customer_snapshot" ? "customer_id"
                : table === "address_snapshot" ? "pickup_address_id" : "container_id";
              return rows.find((row) => row[key] === ids[0]) ?? null;
            },
            async all() {
              const key = table === "address_snapshot" ? "customer_id" : "pickup_address_id";
              return { results: rows.filter((row) => ids.includes(row[key])) };
            }
          };
        }
      };
    }
  } as unknown as D1Database;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const network = vi.fn(() => { throw new Error("Unexpected network in hydrated-read acceptance test"); });

function resetWork(): void {
  work.handlers.length = 0;
  work.cacheReads = 0;
  work.cacheWrites = 0;
  work.dbReads = 0;
}

beforeEach(() => {
  cache.clear();
  resetWork();
  vi.stubGlobal("fetch", network);
  network.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(network).not.toHaveBeenCalled();
});

function appEnv(): Env {
  const stub = {
    async fetch(input: RequestInfo | URL) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/throttle/failure") return Response.json({ blocked: false, retryAfterSec: 0 });
      if (url.pathname === "/throttle/clear") return new Response("OK");
      throw new Error("Unexpected AUTH_SESSION call in hydrated-read acceptance test");
    }
  };
  return {
    CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET,
    SHADOW_API_TOKEN: "synthetic-api-token",
    SHADOW_API_READ_TOKEN: "synthetic-read-token",
    OPENAPI_DOCS_ENABLED: "true",
    CUSTOMER_DB: fakeDb(),
    AUTH_SESSION: { idFromName: (name: string) => name, get: () => stub }
  } as unknown as Env;
}

async function get(spec: Spec, pairs: Array<[string, string]>, headers: HeadersInit = {}): Promise<Response> {
  const h = new Headers(headers);
  if (!h.has("authorization")) h.set("authorization", `Bearer ${SECRET}`);
  const url = new URL(`https://synthetic.example.test/api/v1/data/${spec.kind}`);
  url.search = new URLSearchParams(pairs).toString();
  return await app.fetch(new Request(url, { headers: h }), appEnv(), ctx);
}

function expectNoWork(): void {
  expect(work).toEqual({ handlers: [], cacheReads: 0, cacheWrites: 0, dbReads: 0 });
}

async function expectBadRequest(response: Response, spec: Spec, parameter?: string): Promise<string> {
  expect(response.status).toBe(400);
  expectNoWork();
  expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json\b/);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.json() as Record<string, unknown>;
  expect(body).toMatchObject({ type: BAD_REQUEST, title: "Bad Request", status: 400 });
  // Preserve the optional RFC problem instance; never add validation input dumps.
  expect(Object.keys(body).filter((key) => key !== "instance").sort()).toEqual(["detail", "status", "title", "type"]);
  expect.soft(body.detail).toEqual(expect.any(String));
  if (body.instance !== undefined) {
    expect(String(body.instance)).not.toMatch(/\?|SYNTHETIC-MARKER/);
  }
  const detail = String(body.detail);
  expect.soft(detail).toContain(parameter ?? "id");
  if (!parameter) expect.soft(detail).toContain(spec.alias);
  expect.soft(detail).toContain("See docs/PROBLEMS.md#bad-request.");
  expect.soft(detail).not.toMatch(/SYNTHETIC-MARKER|received|invalid_type|invalid_format|\[\{|"input"/i);
  expectNoWork();
  return detail;
}

// Each malformed spelling is tested alone AND beside a valid alternative. The
// latter catches an implementation that validates only the winning parameter.
const invalid = [
  ["empty", ""], ["space", " "], ["tabs/newlines", "\t\n"],
  ["nonnumeric", "not-an-id-SYNTHETIC-MARKER"], ["suffix", "1junk"],
  ["fraction", "1.5"], ["integral fraction", "1.0"], ["exponent", "1e2"],
  ["hex", "0x10"], ["zero", "0"], ["negative", "-1"], ["negative zero", "-0"],
  ["plus sign", "+1"], ["leading zero", "01"],
  ["leading whitespace", " 1"], ["trailing whitespace", "1 "],
  ["first unsafe integer", "9007199254740992"], ["rounded unsafe integer", "9007199254740993"],
  ["rounded unsafe fraction", "9007199254740991.1"], ["non-ASCII digit", "１"]
] as const;

it("publishes aligned query constraints and 400 descriptions for all three hydrated GETs", async () => {
  type Operation = {
    parameters: Array<{ in: string; name: string; required?: boolean; schema: Record<string, unknown> }>;
    responses: Record<string, { description: string }>;
  };
  const response = await app.fetch(new Request("https://synthetic.example.test/openapi.json"), appEnv(), ctx);
  expect(response.status).toBe(200);
  const doc = await response.json() as { paths: Record<string, { get: Operation }> };
  const constraints: Record<string, unknown>[] = [];
  const descriptions: string[] = [];
  for (const spec of specs) {
    const operation = doc.paths[`/api/v1/data/${spec.kind}`].get;
    const parameters = operation.parameters.filter((parameter) => parameter.in === "query");
    expect(parameters.map((parameter) => parameter.name).sort()).toEqual(["fields", "id", spec.alias].sort());
    for (const parameter of parameters.filter((parameter) => parameter.name !== "fields")) {
      expect(parameter.required).not.toBe(true);
      expect(parameter.schema).toBeDefined();
      constraints.push(Object.fromEntries(Object.entries(parameter.schema).filter(([key]) =>
        !["description", "title", "example", "examples"].includes(key)
      )));
    }
    // Compare the published semantics, ignoring only entity/field names. This
    // consumes runtime OpenAPI, not source text or an implementation export.
    descriptions.push(operation.responses["400"].description.replace(
      /customerId|pickupAddressId|containerId|customer_id|pickup_address_id|container_id|customer|address|container/g,
      "entity"
    ));
  }
  expect(constraints).toHaveLength(6);
  for (const schema of constraints) expect(schema).toEqual(constraints[0]);
  expect(descriptions[0]).toBeTruthy();
  expect(descriptions).toEqual([descriptions[0], descriptions[0], descriptions[0]]);
  expectNoWork();
});

describe.each(specs)("hydrated $kind positive safe-ID contract", (spec) => {
  describe.each(["id", spec.alias])("query %s", (parameter) => {
    it.each([1, 42, MAX_ID])("serves the exact synthetic row for canonical decimal %s", async (id) => {
      const response = await get(spec, [[parameter, String(id)]]);
      expect(response.status).toBe(200);
      expect((await response.json() as Record<string, Row>)[spec.kind]).toMatchObject({
        [spec.key]: id, [spec.field]: `Synthetic ${spec.kind} ${id}`
      });
      expect(work.handlers).toEqual([{ kind: spec.kind, id }]);
      expect(work.dbReads).toBeGreaterThan(0);
      expect(response.headers.get("etag")).toBe(`"${response.headers.get("x-entity-etag")}"`);
    });

    describe.each([false, true])("valid alternative present: %s", (withAlternative) => {
      it.each(invalid)("rejects %s before handler/cache/D1", async (_label, value) => {
        const other = parameter === "id" ? spec.alias : "id";
        const pairs: Array<[string, string]> = [[parameter, value]];
        if (withAlternative) pairs.unshift([other, "1"]);
        const detail = await expectBadRequest(await get(spec, pairs), spec, parameter);
        if (value.trim()) expect(detail).not.toContain(value);
      });
    });

    it("keeps validation detail fixed when rejected input changes", async () => {
      const first = await expectBadRequest(await get(spec, [[parameter, "not-an-id-SYNTHETIC-MARKER"]]), spec, parameter);
      const second = await expectBadRequest(await get(spec, [[parameter, "different-SYNTHETIC-MARKER"]]), spec, parameter);
      expect(second).toBe(first);
    });

    it("keeps a valid unknown ID as 404, not a malformed-query 400", async () => {
      const response = await get(spec, [[parameter, "999"]]);
      expect(response.status).toBe(404);
      expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json\b/);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ title: "Not Found", status: 404 });
      expect(work.handlers).toEqual([{ kind: spec.kind, id: 999 }]);
      expect(work.dbReads).toBeGreaterThan(0);
    });
  });

  it("rejects missing parameters before handler/cache/D1", async () => {
    await expectBadRequest(await get(spec, []), spec);
  });

  it.each([false, true])("id wins when two valid values differ (alias first: %s)", async (aliasFirst) => {
    const pairs: Array<[string, string]> = [["id", "1"], [spec.alias, "2"]];
    const response = await get(spec, aliasFirst ? pairs.reverse() : pairs);
    expect(response.status).toBe(200);
    expect((await response.json() as Record<string, Row>)[spec.kind][spec.key]).toBe(1);
    expect(work.handlers).toEqual([{ kind: spec.kind, id: 1 }]);
  });

  it("accepts both spellings with the same valid ID", async () => {
    const response = await get(spec, [["id", "1"], [spec.alias, "1"]]);
    expect(response.status).toBe(200);
    expect((await response.json() as Record<string, Row>)[spec.kind][spec.key]).toBe(1);
  });

  it("does not fall back to a known alias when a valid winning id is unknown", async () => {
    const response = await get(spec, [["id", "999"], [spec.alias, "1"]]);
    expect(response.status).toBe(404);
    expect(work.handlers).toEqual([{ kind: spec.kind, id: 999 }]);
  });

  it("canonical and alias reads have identical hydrated rows and ETags on cold and warm cache", async () => {
    const canonical = await get(spec, [["id", "1"]]);
    expect(canonical.status).toBe(200);
    const body = await canonical.json();
    const etag = canonical.headers.get("etag");
    expect(canonical.headers.get("x-entity-etag")).toMatch(/^[0-9a-f]{64}$/);
    expect(canonical.headers.get("cache-control")).toBe("private, max-age=60");
    cache.clear();
    resetWork();
    const alias = await get(spec, [[spec.alias, "1"]]);
    expect(alias.status).toBe(200);
    expect(await alias.json()).toEqual(body);
    expect(alias.headers.get("etag")).toBe(etag);
    expect(alias.headers.get("x-entity-etag")).toBe(canonical.headers.get("x-entity-etag"));
    expect(work.dbReads).toBeGreaterThan(0);
    resetWork();
    const warm = await get(spec, [["id", "1"]]);
    expect(warm.status).toBe(200);
    expect(await warm.json()).toEqual(body);
    expect(warm.headers.get("etag")).toBe(etag);
    expect(work.dbReads).toBe(0);
    for (const parameter of ["id", spec.alias]) {
      for (const validator of [etag!, `W/${etag}`, `"unrelated", ${etag}`, "*"]) {
        const conditional = await get(spec, [[parameter, "1"]], { "if-none-match": validator });
        expect(conditional.status).toBe(304);
        expect(conditional.headers.get("etag")).toBe(etag);
        expect(await conditional.text()).toBe("");
        expect(work.dbReads).toBe(0);
      }
    }
    const stale = await get(spec, [[spec.alias, "1"]], { "if-none-match": '"stale"' });
    expect(stale.status).toBe(200);
    expect(await stale.json()).toEqual(body);
  });

  it("a matching cached ETag cannot rescue a malformed unused alias", async () => {
    const first = await get(spec, [["id", "1"]]);
    expect(first.status).toBe(200);
    resetWork();
    await expectBadRequest(await get(spec, [["id", "1"], [spec.alias, "01"]], {
      "if-none-match": first.headers.get("etag")!
    }), spec);
  });

  describe.each([
    { role: "missing bearer", authorization: "", gate: "SHADOW_API_TOKEN" },
    { role: "wrong bearer", authorization: "Bearer synthetic-wrong", gate: "SHADOW_API_TOKEN" },
    { role: "API token", authorization: "Bearer synthetic-api-token", gate: "CUSTOMER_SNAPSHOT_SYNC_SECRET" },
    { role: "read token", authorization: "Bearer synthetic-read-token", gate: "CUSTOMER_SNAPSHOT_SYNC_SECRET" }
  ])("$role preserves authorization ordering", ({ authorization, gate }) => {
    it.each([
      { label: "missing ID", pairs: [] },
      { label: "valid ID", pairs: [["id", "1"]] },
      { label: "coercible noncanonical ID", pairs: [["id", "01"]] }
    ])("rejects at the existing auth gate for $label", async ({ pairs }) => {
      const response = await get(spec, pairs as Array<[string, string]>, { authorization });
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        type: BAD_REQUEST.replace("#bad-request", "#unauthorized"),
        title: "Unauthorized", status: 401,
        detail: `Send Authorization: Bearer <${gate}>. See docs/PROBLEMS.md#unauthorized.`
      });
      expectNoWork();
    });
  });
});
