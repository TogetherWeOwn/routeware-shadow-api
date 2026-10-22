import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * HTTP acceptance contract: bounded batch ID lookup on the hydrated
 * data-entity GETs (`GET /api/v1/data/{customer,address,container}?ids=1,2,3`).
 *
 * Contract pinned here (batch v1):
 * - One comma-separated `ids` param (never repeated `?id=` keys: repeated
 *   keys reach zod as arrays and the validator 400s); explicit max 50.
 *   Over-max and any malformed entry fail the whole request with the existing
 *   value-free 400 before any read — zero partial work.
 * - Every entry is validated against the canonical positive-safe-ID contract
 *   (canonical decimal, 1..9007199254740991, no leading zeros, whitespace,
 *   signs, fractions, exponents or hex). `ids` mixed with `id`/alias is
 *   rejected rather than silently picking a winner: a silent pick could serve
 *   a different record's PII than the one asked for.
 * - 200 returns `{ entries }` in request order: found entries carry
 *   `{ id, found: true, <kind>: <single-GET bundle> }`; missing entries are
 *   exactly `{ id, found: false }` (no 404-whole, no submitted values beyond
 *   canonical numeric ids).
 * - Batch 200s send `no-store` and no ETag; `If-None-Match` is ignored on
 *   batch (composite ETags are future work). Single-id behavior, auth
 *   ordering and single-GET ETag/304 are unchanged.
 *
 * Keep routing, validation, hydration and ETag calculation real; replace only
 * external cache/D1/network boundaries. Handler wrappers observe entry
 * without replacing the behavior with canned responses.
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
const SECRET = "synthetic-batch-read-secret";
const MAX_ID = 9007199254740991;
const BATCH_MAX = 50;
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
const primaryKey = {
  customer_snapshot: "customer_id",
  address_snapshot: "pickup_address_id",
  container_snapshot: "container_id"
} as const;

/**
 * Bound IDs determine results; an unknown ID cannot get a canned success.
 * Serves both the single-id hydration shapes (`= ?` by primary or foreign
 * key, `IN (...)` by foreign key for container chunks) and batch primary-key
 * `IN (...)` lookups: the WHERE column decides which key the binds match.
 */
function fakeDb(): D1Database {
  return {
    prepare(sql: string) {
      work.dbReads += 1;
      const lowered = sql.toLowerCase();
      const matched = (Object.keys(tables) as Array<keyof typeof tables>)
        .filter((name) => lowered.includes(`from ${name}`));
      if (matched.length !== 1) {
        throw new Error(`Unexpected SQL in synthetic batch-read fixture: ${sql}`);
      }
      const table = matched[0];
      const rows: Row[] = tables[table];
      const pk: string = primaryKey[table];
      const whereCol = /where\s+([a-z_]+)\s*(=|in)\b/i.exec(sql)?.[1];
      return {
        bind(...ids: unknown[]) {
          return {
            async first() {
              return rows.find((row) => row[pk] === ids[0]) ?? null;
            },
            async all() {
              // Foreign-key lookup (single-bundle hydration path); otherwise
              // the binds are primary keys (batch IN or single =).
              const key = whereCol && whereCol !== pk ? whereCol : pk;
              return { results: rows.filter((row) => ids.includes(row[key])) };
            }
          };
        }
      };
    }
  } as unknown as D1Database;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const network = vi.fn(() => { throw new Error("Unexpected network in batch-read acceptance test"); });

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
      throw new Error("Unexpected AUTH_SESSION call in batch-read acceptance test");
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

function idList(count: number): string {
  return Array.from({ length: count }, (_, index) => index + 1).join(",");
}

async function expectBatchBadRequest(response: Response): Promise<string> {
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
  expect.soft(detail).toContain("ids");
  expect.soft(detail).toContain("See docs/PROBLEMS.md#bad-request.");
  expect.soft(detail).not.toMatch(/SYNTHETIC-MARKER|received|invalid_type|invalid_format|\[\{|"input"/i);
  expectNoWork();
  return detail;
}

type BatchEntry = { id: number; found: boolean; [key: string]: unknown };

function expectBatchHeaders(response: Response): void {
  expect(response.headers.get("content-type")).toMatch(/^application\/json\b/);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("etag")).toBeNull();
  expect(response.headers.get("x-entity-etag")).toBeNull();
}

async function singleBody(spec: Spec, id: number): Promise<unknown> {
  const response = await get(spec, [["id", String(id)]]);
  expect(response.status).toBe(200);
  return await response.json();
}

function expectFoundEntry(spec: Spec, entry: BatchEntry, id: number, single: unknown): void {
  expect(Object.keys(entry).sort()).toEqual([spec.kind, "found", "id"].sort());
  expect(entry.id).toBe(id);
  expect(entry.found).toBe(true);
  expect(entry[spec.kind]).toEqual(single);
}

function expectMissingEntry(entry: BatchEntry, id: number): void {
  expect(entry).toEqual({ id, found: false });
}

// Each malformed spelling is tested in the middle of a valid batch, so a
// validator that stops at the first valid entry cannot pass.
const invalidEntries = [
  ["leading zero", "01"], ["zero", "0"], ["negative", "-1"], ["plus sign", "+1"],
  ["fraction", "1.5"], ["exponent", "1e2"], ["hex", "0x10"], ["suffix", "1junk"],
  ["nonnumeric", "not-an-id-SYNTHETIC-MARKER"], ["whitespace", " "],
  ["first unsafe integer", "9007199254740992"], ["non-ASCII digit", "１"]
] as const;

it("publishes the ids batch param on all three hydrated GETs", async () => {
  type Operation = {
    parameters: Array<{
      in: string; name: string; required?: boolean; description?: string;
      example?: unknown; schema: Record<string, unknown>;
    }>;
  };
  const response = await app.fetch(new Request("https://synthetic.example.test/openapi.json"), appEnv(), ctx);
  expect(response.status).toBe(200);
  const doc = await response.json() as { paths: Record<string, { get: Operation }> };
  for (const spec of specs) {
    const operation = doc.paths[`/api/v1/data/${spec.kind}`].get;
    const ids = operation.parameters.find((parameter) => parameter.in === "query" && parameter.name === "ids");
    expect(ids, `${spec.kind} ids param`).toBeDefined();
    expect(ids!.required).not.toBe(true);
    expect(ids!.schema?.type).toBe("string");
    const schema = (ids!.schema ?? {}) as { description?: string; example?: unknown };
    const prose = `${ids!.description ?? ""}\n${schema.description ?? ""}`;
    expect(prose).toContain("comma");
    expect(prose).toContain(String(BATCH_MAX));
    const example = ids!.example ?? schema.example;
    expect(typeof example).toBe("string");
    expect(String(example)).toMatch(/^[1-9][0-9]*(,[1-9][0-9]*)*$/);
  }
  expectNoWork();
});

describe.each(specs)("batch $kind positive contract", (spec) => {
  it("serves request-order entries for a valid multi-id batch", async () => {
    const ids = [42, 1, MAX_ID];
    const response = await get(spec, [["ids", ids.join(",")]]);
    expect(response.status).toBe(200);
    expectBatchHeaders(response);
    const body = await response.json() as { entries: BatchEntry[] };
    expect(Object.keys(body).sort()).toEqual(["entries"]);
    expect(body.entries.map((entry) => entry.id)).toEqual(ids);
    for (const [index, id] of ids.entries()) {
      expectFoundEntry(spec, body.entries[index], id, await singleBody(spec, id));
    }
    expect(work.dbReads).toBeGreaterThan(0);
  });

  it("preserves duplicate ids in request order", async () => {
    const response = await get(spec, [["ids", "2,1,2"]]);
    expect(response.status).toBe(200);
    const body = await response.json() as { entries: BatchEntry[] };
    expect(body.entries.map((entry) => entry.id)).toEqual([2, 1, 2]);
    for (const [index, id] of [2, 1, 2].entries()) {
      expectFoundEntry(spec, body.entries[index], id, await singleBody(spec, id));
    }
  });

  it("serves a single-element batch", async () => {
    const response = await get(spec, [["ids", "2"]]);
    expect(response.status).toBe(200);
    expectBatchHeaders(response);
    const body = await response.json() as { entries: BatchEntry[] };
    expect(body.entries).toHaveLength(1);
    expectFoundEntry(spec, body.entries[0], 2, await singleBody(spec, 2));
  });

  it("accepts exactly 50 ids in request order", async () => {
    const response = await get(spec, [["ids", idList(BATCH_MAX)]]);
    expect(response.status).toBe(200);
    const body = await response.json() as { entries: BatchEntry[] };
    expect(body.entries).toHaveLength(BATCH_MAX);
    expect(body.entries.map((entry) => entry.id))
      .toEqual(Array.from({ length: BATCH_MAX }, (_, index) => index + 1));
    expect(body.entries[0]).toMatchObject({ id: 1, found: true });
    expect(body.entries[1]).toMatchObject({ id: 2, found: true });
    expect(body.entries[2]).toEqual({ id: 3, found: false });
    expect(body.entries[41]).toMatchObject({ id: 42, found: true });
    expect(work.dbReads).toBeGreaterThan(0);
  });

  it("returns per-ID found:false entries for an all-missing batch", async () => {
    const response = await get(spec, [["ids", "999,998,997"]]);
    expect(response.status).toBe(200);
    expectBatchHeaders(response);
    expect(await response.json()).toEqual({
      entries: [
        { id: 999, found: false },
        { id: 998, found: false },
        { id: 997, found: false }
      ]
    });
    expect(work.dbReads).toBeGreaterThan(0);
  });

  it("preserves order across found and missing entries", async () => {
    const response = await get(spec, [["ids", "999,2,998,1"]]);
    expect(response.status).toBe(200);
    const body = await response.json() as { entries: BatchEntry[] };
    expect(body.entries.map((entry) => entry.id)).toEqual([999, 2, 998, 1]);
    expect(body.entries.map((entry) => entry.found)).toEqual([false, true, false, true]);
    expectMissingEntry(body.entries[0], 999);
    expectFoundEntry(spec, body.entries[1], 2, await singleBody(spec, 2));
    expectMissingEntry(body.entries[2], 998);
    expectFoundEntry(spec, body.entries[3], 1, await singleBody(spec, 1));
  });

  it("ignores If-None-Match on batch (no batch ETag in v1)", async () => {
    const single = await get(spec, [["id", "1"]]);
    expect(single.status).toBe(200);
    const validators = ["*", "\"stale\"", single.headers.get("etag")!];
    for (const validator of validators) {
      const response = await get(spec, [["ids", "1,2"]], { "if-none-match": validator });
      expect(response.status).toBe(200);
      expectBatchHeaders(response);
      const body = await response.json() as { entries: BatchEntry[] };
      expect(body.entries.map((entry) => entry.id)).toEqual([1, 2]);
    }
  });

  it("rejects missing selectors before handler/cache/D1", async () => {
    const response = await get(spec, []);
    expect(response.status).toBe(400);
    expectNoWork();
    expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json\b/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ type: BAD_REQUEST, title: "Bad Request", status: 400 });
    // Guidance text intentionally unpinned: the single-id missing-param
    // wording is owned by the existing suites and must not churn for batch.
    expectNoWork();
  });

  it.each(invalidEntries)("rejects %s in the middle before handler/cache/D1", async (_label, value) => {
    const detail = await expectBatchBadRequest(await get(spec, [["ids", `1,${value},2`]]));
    if (value.length > 1 && value.trim()) expect(detail).not.toContain(value);
  });

  it.each([
    ["trailing comma", "1,2,"],
    ["leading comma", ",1,2"],
    ["empty middle entry", "1,,2"],
    ["space after comma", "1, 2"],
    ["space before comma", "1 ,2"],
    ["empty value", ""],
    ["blank value", " "]
  ])("rejects %s before handler/cache/D1", async (_label, value) => {
    await expectBatchBadRequest(await get(spec, [["ids", value]]));
  });

  it.each([
    ["first", "01,1,2"],
    ["last", "1,2,01"]
  ])("rejects a malformed entry in %s position before handler/cache/D1", async (_label, value) => {
    await expectBatchBadRequest(await get(spec, [["ids", value]]));
  });

  it("keeps validation detail fixed when rejected input changes", async () => {
    const first = await expectBatchBadRequest(await get(spec, [["ids", "1,not-an-id-SYNTHETIC-MARKER,2"]]));
    const second = await expectBatchBadRequest(await get(spec, [["ids", "1,different-SYNTHETIC-MARKER,2"]]));
    expect(second).toBe(first);
  });

  it("rejects 51 ids before handler/cache/D1", async () => {
    const detail = await expectBatchBadRequest(await get(spec, [["ids", idList(BATCH_MAX + 1)]]));
    expect.soft(detail).toContain(String(BATCH_MAX));
  });

  it("keeps over-max detail fixed when the list changes", async () => {
    const first = await expectBatchBadRequest(await get(spec, [["ids", idList(BATCH_MAX + 1)]]));
    const second = await expectBatchBadRequest(await get(spec, [["ids", idList(BATCH_MAX * 2)]]));
    expect(second).toBe(first);
  });

  it.each([["id", "1"], [spec.alias, "1"]] as Array<[string, string]>)
  ("rejects ids mixed with %s instead of picking a winner", async (param, value) => {
    await expectBatchBadRequest(await get(spec, [["ids", "1,2"], [param, value]]));
  });

  it("rejects repeated ids keys before handler/cache/D1", async () => {
    // Repeated keys reach zod as an array, so the shared validation hook
    // 400s before the handler (and its auth gate) ever runs — the same layer
    // that rejects schema-level single-id input. Auth ordering for this
    // layer is intentionally unpinned here, exactly as for singles.
    await expectBatchBadRequest(await get(spec, [["ids", "1"], ["ids", "2"]]));
  });

  it("single-id reads are unchanged: unknown id stays 404", async () => {
    const response = await get(spec, [["id", "999"]]);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ title: "Not Found", status: 404 });
  });

  it("single-id reads are unchanged: malformed id stays 400", async () => {
    const response = await get(spec, [["id", "01"]]);
    expect(response.status).toBe(400);
  });

  it("single-id reads are unchanged: ETag/304 round-trip still works", async () => {
    const first = await get(spec, [["id", "1"]]);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const conditional = await get(spec, [["id", "1"]], { "if-none-match": etag! });
    expect(conditional.status).toBe(304);
  });

  describe.each([
    { role: "missing bearer", authorization: "", gate: "SHADOW_API_TOKEN" },
    { role: "wrong bearer", authorization: "Bearer synthetic-wrong", gate: "SHADOW_API_TOKEN" },
    { role: "API token", authorization: "Bearer synthetic-api-token", gate: "CUSTOMER_SNAPSHOT_SYNC_SECRET" },
    { role: "read token", authorization: "Bearer synthetic-read-token", gate: "CUSTOMER_SNAPSHOT_SYNC_SECRET" }
  ])("$role preserves authorization ordering", ({ authorization, gate }) => {
    it.each([
      { label: "missing ids", pairs: [] },
      { label: "valid ids", pairs: [["ids", "1,2"]] },
      { label: "malformed ids", pairs: [["ids", "1,01"]] },
      { label: "over-max ids", pairs: [["ids", idList(BATCH_MAX + 1)]] }
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
