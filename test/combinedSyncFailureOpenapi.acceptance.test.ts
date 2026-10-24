import { env } from "cloudflare:workers";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PartialDataSnapshotSyncError } from "../src/lib/snapshot/orchestration";

// Exercise the real chain except for causes only injectable at its boundary:
// unknown causes and ChainedHttpError without a numeric status (both existing
// route behaviors). Never replace the response mapper or schema generation.
const injection: { error: Error | null } = { error: null };
vi.mock("../src/lib/d1SnapshotSync", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/d1SnapshotSync")>();
  return {
    ...real,
    runDataSnapshotSyncChainedHttp: async (...args: Parameters<typeof real.runDataSnapshotSyncChainedHttp>) => {
      if (injection.error) throw injection.error;
      return real.runDataSnapshotSyncChainedHttp(...args);
    }
  };
});
const { default: app } = await import("../src/app");

/**
 * Test-only oracle for the EXISTING combined-sync failure contract. Missing
 * response declarations must fail independently of runtime controls. The
 * Builder supplies declarations/docs, not new behavior, and keeps this file
 * unchanged. All subrequests terminate in synthetic doubles; no provider, D1,
 * R2 or live sync is used. Existing byte/status locks remain in their suites.
 *
 * Mutations caught: drop either 500 media type, widen a classification/table,
 * lose a required nullable count, require HTTP status, allow non-HTTP status,
 * advertise private fields, or publish examples the runtime schema rejects.
 */
type Schema = {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  example?: unknown;
  examples?: unknown[];
  [key: string]: unknown;
};
type Media = {
  schema?: Schema;
  example?: unknown;
  examples?: Record<string, { value?: unknown; externalValue?: string }>;
};
type ApiResponse = { description?: string; content?: Record<string, Media> };
type Document = {
  paths: Record<string, { post?: { responses: Record<string, ApiResponse> } }>;
  components: { schemas: Record<string, Schema> };
};

const base = "http://test.local";
const path = "/api/v1/data-snapshot/sync";
const tables = ["customer", "address", "container"] as const;
type Table = typeof tables[number];
const codes = [
  "ChainedHttpError", "ChainedNetworkError", "ChainedResponseReadError",
  "ChainedResponseTooLargeError", "ChainedInvalidJsonError", "ChainedTimeoutError"
] as const;
const secret = "synthetic-openapi-sync-secret";
const requestId = "combined-failure-openapi-01";
const marker = "SYNTHETIC-PRIVATE-UPSTREAM-MARKER";
const completed = { upserted: 3, rowCount: 4 };
const partial = {
  customer: completed, address: null, container: null,
  failure: { table: "address", code: "ChainedNetworkError" }
};
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const testEnv = {
  ...env,
  CUSTOMER_SNAPSHOT_SYNC_SECRET: secret,
  CUSTOMER_REPORT_QUERY_ID: "23",
  ADDRESS_REPORT_QUERY_ID: "24",
  CONTAINER_REPORT_QUERY_ID: "25",
  CHAINED_SYNC_TIMEOUT_MS: "50"
} as unknown as Env;
let replies: Map<Table, () => Response | Promise<Response>>;
let attempted: Table[];
let unexpected: string[];
let forwarded: URL[];

beforeEach(() => {
  injection.error = null;
  replies = new Map();
  attempted = [];
  unexpected = [];
  forwarded = [];
  for (const level of ["info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation(() => {});
  }
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const table = tables.find((t) => url.pathname === `/api/v1/${t}-snapshot/sync`);
    if (url.origin !== base || request.method !== "POST" || !table) {
      unexpected.push(request.url);
      throw new Error("Unexpected network request in failure-schema acceptance");
    }
    attempted.push(table);
    forwarded.push(url);
    return replies.get(table)?.() ?? Response.json(completed);
  });
});
afterEach(() => {
  injection.error = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  expect(unexpected).toEqual([]);
});

async function document(): Promise<Document> {
  const res = await app.fetch(new Request(`${base}/openapi.json`), testEnv, ctx);
  expect(res.status).toBe(200);
  return await res.json() as Document;
}
function response(doc: Document, status: number): ApiResponse {
  const result = doc.paths[path]?.post?.responses[String(status)];
  expect(result, `mounted combined-sync must declare HTTP ${status}`).toBeDefined();
  return result!;
}
function media(doc: Document, status: number, contentType: string): Media {
  const result = response(doc, status).content?.[contentType];
  expect(result, `HTTP ${status} must declare ${contentType}`).toBeDefined();
  expect(result?.schema, `${contentType} needs a machine-readable schema`).toBeDefined();
  return result!;
}

// Resolve only local schema refs. Zod's existing JSON Schema reader is the
// validator, rather than a permissive home-grown subset that ignores oneOf,
// required or additionalProperties. No dependency/package additions needed.
function dereference(doc: Document, value: unknown, seen: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => dereference(doc, v, seen));
  if (!value || typeof value !== "object") return value;
  const node = value as Schema;
  if (node.$ref) {
    expect(node.$ref).toMatch(/^#\/components\/schemas\//);
    expect(seen).not.toContain(node.$ref);
    const name = node.$ref.slice("#/components/schemas/".length);
    const target = doc.components.schemas[name];
    expect(target, `schema ref ${node.$ref} must resolve`).toBeDefined();
    const { $ref: _ref, ...siblings } = node;
    return { ...dereference(doc, target, [...seen, node.$ref]) as object, ...dereference(doc, siblings, seen) as object };
  }
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, dereference(doc, v, seen)]));
}
function validator(doc: Document, status = 500, contentType = "application/json") {
  const schema = dereference(doc, media(doc, status, contentType).schema);
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
}
async function post(query = "?partialProgress=true", overrides: Partial<Env> = {}, token: string | null = secret) {
  const headers = new Headers({ "X-Request-Id": requestId });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const res = await app.fetch(new Request(`${base}${path}${query}`, { method: "POST", headers }), {
    ...testEnv, ...overrides
  } as Env, ctx);
  const raw = await res.text();
  expect(res.headers.get("X-Request-Id")).toBe(requestId);
  expect(res.headers.get("cache-control")).toContain("no-store");
  expect(raw).not.toContain(marker);
  expect(raw).not.toContain(secret);
  return { res, raw, body: JSON.parse(raw) as Record<string, unknown> };
}
function expectAccepted(schema: ReturnType<typeof validator>, body: unknown) {
  const result = schema.safeParse(body);
  expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
}
function injectedCause(name: string, status?: number) {
  const cause = Object.assign(new Error(marker), { name }, status === undefined ? {} : { status });
  return new PartialDataSnapshotSyncError(
    "address", "address", "[chained address] synthetic failure",
    { customer: completed, address: null, container: null }, { cause }
  );
}

describe("mounted combined-sync failure declarations", () => {
  it("publishes both existing 500 media types and named, required partial members", async () => {
    const doc = await document();
    const failure = response(doc, 500);
    expect(Object.keys(failure.content ?? {}).sort()).toEqual(["application/json", "application/problem+json"]);
    const partialMedia = media(doc, 500, "application/json");
    expect(partialMedia.schema?.$ref).toMatch(/^#\/components\/schemas\//);
    const schema = dereference(doc, partialMedia.schema) as Schema;
    expect(schema.type).toBe("object");
    expect([...(schema.required ?? [])].sort()).toEqual(["address", "container", "customer", "failure"]);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["address", "container", "customer", "failure"]);
    const root = doc.components.schemas[partialMedia.schema!.$ref!.split("/").at(-1)!];
    expect(root.properties?.failure.$ref, "classification must be a reusable named schema").toMatch(/^#\/components\/schemas\//);
    expect(validator(doc).safeParse({ type: "internal", status: 500 }).success).toBe(false);
    expect(validator(doc, 500, "application/problem+json").safeParse(partial).success).toBe(false);
  });

  it("advertises no deleted counts, storage metadata, exceptions, keys or row data", async () => {
    const doc = await document();
    const schema = dereference(doc, media(doc, 500, "application/json").schema);
    const propertyNames: string[] = [];
    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const node = value as Schema;
      propertyNames.push(...Object.keys(node.properties ?? {}));
      Object.values(node).forEach(visit);
    };
    visit(schema);
    expect([...new Set(propertyNames)].sort()).toEqual([
      "address", "code", "container", "customer", "failure", "rowCount", "status", "table", "upserted"
    ]);
  });

  it("publishes closed code and table enums, not unconstrained classification strings", async () => {
    const doc = await document();
    const schema = dereference(doc, media(doc, 500, "application/json").schema);
    const literals = { code: new Set<unknown>(), table: new Set<unknown>() };
    function visit(value: unknown): void {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(visit); return; }
      const node = value as Schema;
      for (const field of ["code", "table"] as const) {
        const property = node.properties?.[field];
        if (!property) continue;
        const values = property.enum ?? ("const" in property ? [property.const] : undefined);
        expect(Array.isArray(values), `${field} must advertise fixed enum/const values`).toBe(true);
        for (const literal of values as unknown[]) literals[field].add(literal);
      }
      Object.values(node).forEach(visit);
    }
    visit(schema);
    expect([...literals.code].sort()).toEqual([...codes].sort());
    expect([...literals.table].sort()).toEqual([...tables].sort());
  });

  it.each(codes)("accepts only the fixed %s variant, with status optional only for HTTP", async (code) => {
    const schema = validator(await document());
    expectAccepted(schema, { ...partial, failure: { table: "address", code } });
    const withStatus = { ...partial, failure: { table: "address", code, status: 503 } };
    expect(schema.safeParse(withStatus).success).toBe(code === "ChainedHttpError");
  });

  it.each<readonly [string, unknown]>([
    ["unknown code", { ...partial, failure: { table: "address", code: "OtherError" } }],
    ["unknown table", { ...partial, failure: { table: "invoice", code: "ChainedHttpError" } }],
    ["missing failure", { customer: completed, address: null, container: null }],
    ["missing failed table", { ...partial, failure: { code: "ChainedNetworkError" } }],
    ["missing code", { ...partial, failure: { table: "address" } }],
    ["string status", { ...partial, failure: { table: "address", code: "ChainedHttpError", status: "503" } }],
    ["null status", { ...partial, failure: { table: "address", code: "ChainedHttpError", status: null } }],
    ...tables.flatMap((table) => [
      [`${table}: missing upserted`, { ...partial, [table]: { rowCount: 4 } }] as const,
      [`${table}: missing rowCount`, { ...partial, [table]: { upserted: 3 } }] as const,
      [`${table}: string count`, { ...partial, [table]: { upserted: "3", rowCount: 4 } }] as const,
      [`${table}: fractional count`, { ...partial, [table]: { upserted: 0.5, rowCount: 4 } }] as const,
      [`${table}: null count`, { ...partial, [table]: { upserted: null, rowCount: 4 } }] as const,
      [`${table}: array counts`, { ...partial, [table]: [3, 4] }] as const,
      [`${table}: skipped object instead of null`, { ...partial, [table]: { skipped: true } }] as const,
      [`${table}: boolean instead of null`, { ...partial, [table]: false }] as const,
      ["missing " + table, Object.fromEntries(Object.entries(partial).filter(([key]) => key !== table))] as const
    ])
  ])("rejects malformed synthetic payload: %s", async (_label, body) => {
    expect(validator(await document()).safeParse(body).success).toBe(false);
  });

  it.each(tables)("admits the fixed failed-table identity %s with all-null unknown outcomes", async (table) => {
    expectAccepted(validator(await document()), {
      customer: null, address: null, container: null,
      failure: { table, code: "ChainedHttpError" }
    });
  });

  it("includes locally valid synthetic examples for all classifications, completed prefixes and skipped nulls", async () => {
    const doc = await document();
    const entry = media(doc, 500, "application/json");
    const resolved = dereference(doc, entry.schema) as Schema;
    const examples = [
      ...(entry.example === undefined ? [] : [entry.example]),
      ...Object.values(entry.examples ?? {}).map((example) => {
        expect(example.externalValue, "examples must be hermetic, not fetched from a provider").toBeUndefined();
        return example.value;
      }),
      ...(resolved.example === undefined ? [] : [resolved.example]),
      ...(resolved.examples ?? [])
    ] as Array<Record<string, unknown> & { failure: { code: string; table: string } }>;
    expect(examples.length).toBeGreaterThanOrEqual(6);
    for (const example of examples) expectAccepted(validator(doc), example);
    expect([...new Set(examples.map((example) => example.failure.code))].sort()).toEqual([...codes].sort());
    expect(examples.some((example) => example.customer !== null && example.address !== null &&
      example.container === null && example.failure.table === "container")).toBe(true);
    expect(examples.some((example) => example.customer !== null && example.address === null &&
      example.container === null && example.failure.table === "container")).toBe(true);
  });
});

describe("served schema versus hermetic existing runtime", () => {
  const failures: Array<{ code: typeof codes[number]; reply: () => Response | Promise<Response>; status?: number }> = [
    { code: "ChainedHttpError", status: 503, reply: () => new Response(marker, { status: 503 }) },
    { code: "ChainedNetworkError", reply: () => { throw new TypeError(marker); } },
    { code: "ChainedResponseReadError", reply: () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error(marker)); }
    })) },
    { code: "ChainedResponseTooLargeError", reply: () => new Response("x".repeat(65_537)) },
    { code: "ChainedInvalidJsonError", reply: () => new Response(`{"private":"${marker}"`) },
    { code: "ChainedTimeoutError", reply: () => new Promise<Response>(() => {}) }
  ];
  it.each(failures)("validates the real $code 500 response against mounted application/json", async ({ code, reply, status }) => {
    replies.set("address", reply);
    const result = await post();
    expect(result.res.status).toBe(500);
    expect(result.res.headers.get("content-type")).toContain("application/json");
    expect(result.body).toEqual({
      customer: completed, address: null, container: null,
      failure: { table: "address", code, ...(status === undefined ? {} : { status }) }
    });
    expect(attempted).toEqual(["customer", "address"]);
    expectAccepted(validator(await document()), result.body);
  });

  it("validates HTTP without status, rather than advertising a stricter contract than runtime", async () => {
    injection.error = injectedCause("ChainedHttpError");
    const result = await post();
    expect(result.res.status).toBe(500);
    expect(result.body).toEqual({ ...partial, failure: { table: "address", code: "ChainedHttpError" } });
    expectAccepted(validator(await document()), result.body);
  });

  it.each(["", "?partialProgress=false", "?partialProgress=true"])("keeps an unknown cause generic and validates problem+json (%s)", async (query) => {
    injection.error = injectedCause("UnknownSyntheticError");
    const result = await post(query);
    expect(result.res.status).toBe(500);
    expect(result.res.headers.get("content-type")).toContain("application/problem+json");
    expect(result.body).toMatchObject({ status: 500, title: "Internal Server Error" });
    expect(result.body).not.toHaveProperty("failure");
    expect(result.body).not.toHaveProperty("customer");
    expect(result.raw).not.toContain("UnknownSyntheticError");
    expectAccepted(validator(await document(), 500, "application/problem+json"), result.body);
  });

  it.each(["", "?partialProgress=false"])("keeps a classified default failure as generic problem+json (%s)", async (query) => {
    replies.set("address", () => new Response(marker, { status: 500 }));
    const result = await post(query);
    expect(result.res.status).toBe(500);
    expect(result.res.headers.get("content-type")).toContain("application/problem+json");
    expect(result.body).not.toHaveProperty("failure");
    expectAccepted(validator(await document(), 500, "application/problem+json"), result.body);
  });

  it.each([false, true])("validates container failure with skipped address=%s and strips private completed metadata", async (skipped) => {
    replies.set("customer", () => Response.json({ ...completed, deleted: 1, r2: { key: marker } }));
    replies.set("address", () => Response.json(skipped ? { skipped: true } : { upserted: 7, rowCount: 9 }));
    replies.set("container", () => { throw new TypeError(marker); });
    const result = await post("?dryRun=true&partialProgress=true");
    expect(result.res.status).toBe(500);
    expect(result.body).toEqual({
      customer: completed, address: skipped ? null : { upserted: 7, rowCount: 9 }, container: null,
      failure: { table: "container", code: "ChainedNetworkError" }
    });
    expect(attempted).toEqual(tables);
    for (const url of forwarded) {
      expect(url.searchParams.get("dryRun")).toBe("true");
      expect(url.searchParams.has("partialProgress")).toBe(false);
    }
    expectAccepted(validator(await document()), result.body);
  });

  it("validates a first-table failure with no completed tables", async () => {
    replies.set("customer", () => new Response(marker, { status: 429 }));
    const result = await post();
    expect(result.res.status).toBe(500);
    expect(result.body).toEqual({
      customer: null, address: null, container: null,
      failure: { table: "customer", code: "ChainedHttpError", status: 429 }
    });
    expect(attempted).toEqual(["customer"]);
    expectAccepted(validator(await document()), result.body);
  });

  it("validates unchanged success with and without opt-in, without a failure member", async () => {
    const implicit = await post("");
    const opted = await post();
    expect(implicit.res.status).toBe(200);
    expect(opted.res.status).toBe(200);
    expect(implicit.raw).toBe(opted.raw);
    expect(opted.body).toEqual({ customer: completed, address: completed, container: completed });
    expectAccepted(validator(await document(), 200), opted.body);
  });

  it("documents and validates existing invalid-query 400 before any table runs", async () => {
    const result = await post("?partialProgress=not-a-boolean");
    expect(result.res.status).toBe(400);
    expect(result.body).toMatchObject({ status: 400, title: "Bad Request" });
    expect(result.raw).not.toContain("not-a-boolean");
    expect(attempted).toEqual([]);
    expectAccepted(validator(await document(), 400, "application/problem+json"), result.body);
  });

  it("documents auth and preserves auth-before-validation/missing-secret order", async () => {
    const result = await post("?partialProgress=invalid", { CUSTOMER_SNAPSHOT_SYNC_SECRET: undefined }, null);
    expect(result.res.status).toBe(401);
    expect(result.body).toMatchObject({ status: 401, title: "Unauthorized" });
    expect(attempted).toEqual([]);
    expectAccepted(validator(await document(), 401, "application/problem+json"), result.body);
  });

  it("documents the existing guarded pre-work 503 without making missing-secret auth reachable", async () => {
    // Missing-secret HTTP requests above remain 401. This is a declaration of
    // the existing pre-work guard, not permission to reorder auth or invent a
    // runtime fixture that could never pass that gate.
    const prework = response(await document(), 503);
    expect(prework.description).toMatch(/secret|configur/i);
    expect(prework.description).toMatch(/before|pre.work|auth/i);
  });
});
