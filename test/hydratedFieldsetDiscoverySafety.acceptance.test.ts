/// <reference types="vite/client" />
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUNDLE_TYPED_FIELD_KEYS, SNAPSHOT_FIELDSETS, typedBundleFieldsQuery,
  type SnapshotFieldsetResource
} from "../src/lib/sparseFieldsets";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Acceptance-first: missing typed discovery and reflected unknown query keys
 * must fail independently. No implementation diff informed this oracle.
 *
 * x-snapshot-fieldset v1 keeps the shipped flat catalog shape. The adjacent
 * x-snapshot-fieldset-mode v1 on each hydrated fields/fields[type] declaration
 * describes its rootResource, projectionScope (root | type), omittedTypes:
 * full, singleIdOnly: true, and sorted conflictsWith/composesWith query names.
 * Flat conflicts with its typed root and ids; a typed root conflicts with flat
 * and ids; non-root types conflict only with ids. Every other selector composes.
 * Parameter or string-schema placement is allowed, but duplicates must agree.
 * This is local query guidance, not a new operation/global capability registry.
 *
 * A consumer extracts catalogs + modes from mounted /openapi.json, then makes
 * synthetic requests. Missing/stale/hard-coded catalogs, wrong-root guidance,
 * false batch support, scope/identity/byte/cache regressions, reflected keys or
 * values and work before validation must fail. Denial doubles wrap only the
 * cache/network boundary; local D1, routing, validators and hashing remain real.
 * Test Author owns this oracle; Builder must not edit it to make a build pass.
 */
const EXT = "x-snapshot-fieldset";
const MODE = "x-snapshot-fieldset-mode";
const RULES = {
  caseSensitive: true, whitespace: "reject", emptySegments: "reject",
  duplicates: "reject", unknownNames: "reject", repeatedKeys: "reject"
} as const;
const TYPES = ["customer", "address", "container"] as const;
const SELECTORS = ["fields", "fields[address]", "fields[container]", "fields[customer]"];
const SECRET = "synthetic-discovery-sync-secret";
const ORIGIN = "https://hydrated-discovery.invalid";
const PROBLEMS = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md";
const MARKER = "SYNTHETIC-SECRET-SHAPED-MARKER";
const METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];
type Kind = SnapshotFieldsetResource;
type ObjectValue = Record<string, unknown>;
type Row = Record<string, string | number | null>;
type Parameter = ObjectValue & { name: string; in: string; schema?: ObjectValue };
type Operation = ObjectValue & { parameters?: Parameter[]; responses?: ObjectValue };
type Document = { security?: unknown; paths: Record<string, Record<string, Operation>> };
type Catalog = {
  schemaVersion: number; resource: Kind; selectableFields: string[];
  alwaysIncludedFields: string[]; delimiter: string; rules: typeof RULES;
};
type Mode = {
  schemaVersion: number; rootResource: Kind; projectionScope: "root" | "type";
  omittedTypes: "full"; singleIdOnly: boolean; conflictsWith: string[]; composesWith: string[];
};
const SPECS = [
  { kind: "customer", alias: "customerId", id: 99101, primary: "customer_id", sample: "company_name" },
  { kind: "address", alias: "pickupAddressId", id: 99201, primary: "pickup_address_id", sample: "city" },
  { kind: "container", alias: "containerId", id: 99301, primary: "container_id", sample: "serial_number" }
] as const;
type Spec = (typeof SPECS)[number];

const cache = new Map<string, Response>();
const work = { cacheReads: 0, cacheWrites: 0, statements: [] as string[] };
let denyWork = false;
vi.mock("../src/lib/entityDataCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/entityDataCache")>();
  return {
    ...actual,
    getCachedDataEntity: async (kind: string, id: number) => {
      work.cacheReads++;
      if (denyWork) throw new Error("Validation must precede cache read");
      return cache.get(`${kind}:${id}`)?.clone();
    },
    putCachedDataEntity: async (kind: string, id: number, response: Response) => {
      work.cacheWrites++;
      if (denyWork) throw new Error("Validation must precede cache write");
      cache.set(`${kind}:${id}`, response.clone());
    }
  };
});
const { default: app } = await import("../src/app");
const DB = (env as unknown as Env).CUSTOMER_DB;
const network = vi.fn(() => { throw new Error("No outbound network in discovery acceptance"); });

function resetWork(): void {
  work.cacheReads = 0;
  work.cacheWrites = 0;
  work.statements.length = 0;
}
function bindings(): Env {
  const session = {
    async fetch(input: RequestInfo | URL) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname === "/throttle/failure") return Response.json({ blocked: false, retryAfterSec: 0 });
      if (url.pathname === "/throttle/clear") return new Response("OK");
      throw new Error("Unexpected auth/network operation in discovery acceptance");
    }
  };
  return {
    OPENAPI_DOCS_ENABLED: "true", CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET,
    SHADOW_API_TOKEN: "synthetic-api-token", SHADOW_API_READ_TOKEN: "synthetic-read-token",
    CUSTOMER_DB: {
      prepare(sql: string) {
        work.statements.push(sql);
        if (denyWork || !/^\s*SELECT\b/i.test(sql)) throw new Error("Unexpected D1 work");
        return DB.prepare(sql);
      }
    },
    AUTH_SESSION: { idFromName: (name: string) => name, get: () => session }
  } as unknown as Env;
}
async function request(path: string, authorization = `Bearer ${SECRET}`, extra: HeadersInit = {}, testEnv = bindings()): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers({ origin: ORIGIN, authorization, "x-request-id": "synthetic-discovery-request" });
  new Headers(extra).forEach((value, key) => headers.set(key, value));
  const res = await app.fetch(new Request(`https://synthetic.example.test${path}`, { headers }), testEnv, {
    waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {}
  } as ExecutionContext);
  await Promise.all(pending);
  return res;
}
function path(spec: Spec): string { return `/api/v1/data/${spec.kind}`; }
function read(spec: Spec, pairs: Array<[string, string]> = [], authorization?: string, extra?: HeadersInit): Promise<Response> {
  return request(`${path(spec)}?${new URLSearchParams([["id", String(spec.id)], ...pairs])}`, authorization, extra);
}
async function document(testEnv?: Env): Promise<Document> {
  const response = await request("/openapi.json", "", {}, testEnv);
  expect(response.status).toBe(200);
  return await response.json() as Document;
}
function parameter(doc: Document, route: string, name: string): Parameter {
  const matches = (doc.paths[route]?.get?.parameters ?? []).filter((p) => p.in === "query" && p.name === name);
  expect(matches, `${route}: exactly one ${name} query parameter`).toHaveLength(1);
  return matches[0];
}
function extension<T>(param: Parameter, key: string): T {
  const outer = param[key];
  const inner = param.schema?.[key];
  expect(outer ?? inner, `${param.name}: missing ${key}`).toBeDefined();
  if (outer !== undefined && inner !== undefined) expect(outer).toEqual(inner);
  return (outer ?? inner) as T;
}
function assertCatalog(meta: Catalog, type: Kind): void {
  const registry = SNAPSHOT_FIELDSETS[type];
  expect(meta).toEqual({
    schemaVersion: 1, resource: type, selectableFields: [...registry.columns],
    alwaysIncludedFields: [registry.idColumn], delimiter: ",", rules: RULES
  });
  expect(meta.selectableFields).toContain(registry.idColumn);
  expect(new Set(meta.selectableFields).size).toBe(meta.selectableFields.length);
}
function modeExpected(root: Kind, name: string): Mode {
  const rootKey = BUNDLE_TYPED_FIELD_KEYS[root];
  const otherRoot = name === "fields" ? rootKey : name === rootKey ? "fields" : undefined;
  return {
    schemaVersion: 1, rootResource: root, projectionScope: name === "fields" ? "root" : "type",
    omittedTypes: "full", singleIdOnly: true,
    conflictsWith: ["ids", ...(otherRoot ? [otherRoot] : [])].sort(),
    composesWith: SELECTORS.filter((key) => key !== name && key !== otherRoot).sort()
  };
}
function freshDeclaration(type: Kind): Document {
  const probe = new OpenAPIHono();
  probe.openapi(createRoute({
    method: "get", path: "/synthetic-typed-read",
    request: { query: z.object({ [BUNDLE_TYPED_FIELD_KEYS[type]]: typedBundleFieldsQuery(type) }) },
    responses: { 200: { description: "Declaration probe only; never invoked" } }
  }), (c) => c.body(null, 200));
  return probe.getOpenAPI31Document({
    openapi: "3.1.0", info: { title: "Synthetic typed discovery", version: "1" }
  }) as unknown as Document;
}
function hasExtension(value: unknown): boolean {
  return !!value && typeof value === "object" && Object.entries(value).some(
    ([key, child]) => key === EXT || key === MODE || hasExtension(child)
  );
}
beforeEach(() => {
  cache.clear(); resetWork(); denyWork = false; network.mockClear();
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  try { expect(network).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); denyWork = false; }
});

describe("mounted typed-fieldset catalogs and legal modes", () => {
  it.each(SPECS)("$kind: every typed selector has its own registry-derived v1 catalog", async (spec) => {
    const doc = await document();
    const op = doc.paths[path(spec)].get;
    expect(op).toMatchObject({
      operationId: `getData${spec.kind[0].toUpperCase()}${spec.kind.slice(1)}`,
      "x-access": "sync-secret", "x-effect": "local-read"
    });
    expect(op.security).toBeUndefined();
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(op.parameters?.filter((p) => p.in === "query").map((p) => p.name).sort())
      .toEqual([...SELECTORS, "id", "ids", spec.alias].sort());
    for (const type of TYPES) {
      const param = parameter(doc, path(spec), BUNDLE_TYPED_FIELD_KEYS[type]);
      expect(param).toMatchObject({ required: false, schema: { type: "string" } });
      expect(param).not.toHaveProperty("enum");
      expect(param.schema).not.toHaveProperty("enum");
      assertCatalog(extension<Catalog>(param, EXT), type);
    }
    // Existing flat discovery remains exactly its original root catalog.
    assertCatalog(extension<Catalog>(parameter(doc, path(spec), "fields"), EXT), spec.kind);
  });

  it.each(SPECS)("$kind: each declared selector carries deterministic root-specific mode guidance", async (spec) => {
    const doc = await document();
    for (const name of SELECTORS) {
      expect(extension<Mode>(parameter(doc, path(spec), name), MODE)).toEqual(modeExpected(spec.kind, name));
    }
  });

  it.each(TYPES)("%s: replacing the registry changes a fresh shared typed declaration and validator", (type) => {
    const original = SNAPSHOT_FIELDSETS[type];
    try {
      SNAPSHOT_FIELDSETS[type] = { idColumn: "synthetic_primary_id", columns: ["synthetic_primary_id", "synthetic_extra"] };
      const meta = extension<Catalog>(parameter(freshDeclaration(type), "/synthetic-typed-read", BUNDLE_TYPED_FIELD_KEYS[type]), EXT);
      assertCatalog(meta, type);
      const schema = typedBundleFieldsQuery(type);
      expect(schema.safeParse("synthetic_extra")).toMatchObject({ success: true, data: ["synthetic_extra"] });
      expect(schema.safeParse(SPECS.find((s) => s.kind === type)!.sample).success).toBe(false);
    } finally { SNAPSHOT_FIELDSETS[type] = original; }
  });

  it("never advertises typed projection or modes outside the three hydrated GETs", async () => {
    const doc = await document();
    const supported = SPECS.map((s) => `get ${path(s)}`);
    for (const [route, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!METHODS.includes(method)) continue;
        if (supported.includes(`${method} ${route}`)) continue;
        const params = op.parameters ?? [];
        expect(params.filter((p) => p.name.startsWith("fields[")), `${method} ${route}`).toEqual([]);
        // Flat catalogs are already supported elsewhere; typed-mode guidance is not.
        expect(JSON.stringify(op), `${method} ${route}`).not.toContain(MODE);
        for (const p of params.filter((p) => p.name !== "fields")) expect(hasExtension(p)).toBe(false);
      }
    }
  });

  it("discovery is anonymous and byte-deterministic without reading data or credentials", async () => {
    const unavailable = new Proxy({ OPENAPI_DOCS_ENABLED: "true" }, {
      get(target, key, receiver) {
        if (key === "OPENAPI_DOCS_ENABLED") return Reflect.get(target, key, receiver);
        throw new Error(`Discovery attempted binding access: ${String(key)}`);
      }
    }) as unknown as Env;
    const first = await document(unavailable);
    expect(JSON.stringify(await document(unavailable))).toBe(JSON.stringify(first));
    expect(first).toEqual(await document());
    for (const spec of SPECS) for (const type of TYPES) {
      const param = parameter(first, path(spec), BUNDLE_TYPED_FIELD_KEYS[type]);
      assertCatalog(extension<Catalog>(param, EXT), type);
      for (const value of [MARKER, SECRET, "synthetic-api-token", "synthetic-read-token"]) {
        expect(JSON.stringify(param)).not.toContain(value);
      }
    }
    expect(work).toEqual({ cacheReads: 0, cacheWrites: 0, statements: [] });
  });
});

// Independent complete stored rows: no production projector supplies expected bytes.
const ROWS: Record<Kind, Row> = {
  customer: {
    customer_id: 99101, customer_type_id: 2, company_name: "Synthetic discovery safety company",
    first_name: "Synthetic", middle_initial: null, last_name: "Fixture", name_suffix: "",
    customer_number: "SYN-991", sub_customer_number: "S1", phone1: "555-0199", phone2: null,
    comments: "Synthetic note", enabled: 1, synced_at: "2026-10-01T00:00:00.000Z"
  },
  address: {
    pickup_address_id: 99201, customer_id: 99101, route_id: 7, address: "1 Synthetic Way",
    city: "Syntheticville", state: "ZZ", zip: "00000", franchise_id: "3", comments: null,
    extras_allowed: 0, enabled: 1, driver_note: null, latitude: "0", longitude: "-10.5",
    last_audit_date: "2026-09-01", synced_at: "2026-10-02T00:00:00.000Z"
  },
  container: {
    container_id: 99301, pickup_address_id: 99201, container_type_id: 4,
    serial_number: "SYNTHETIC-DISCOVERY-SERIAL", rfid: null, oncall: 0, event_code: "SYN",
    gps_locked: 1, latitude: "0", longitude: "-11.5", enabled: 1,
    location_address: "Synthetic enclosure", city: "Syntheticville", state: "ZZ", zip: "00000",
    container_note: null, ud_cost_share_ud: "0", ud_enclosure_doors_ud: "2",
    ud_last_compactor_inspection_ud: null, ud_last_enclosure_inspection_ud: "2026-09-02",
    ud_material_stream_ud: "synthetic-paper", color: "blue", service_code_type: "SYN",
    service_code_input: "SYN-INPUT", service_code: "SYN-CODE", service_date: "2026-10-03",
    route_ids: "7,8", frequency_ids: "1,2", synced_at: "2026-10-03T00:00:00.000Z"
  }
};
function expectedBundle(root: Kind, selections: Partial<Record<Kind, string[]>> = {}): ObjectValue {
  const project = (type: Kind): Row => {
    const spec = SPECS.find((s) => s.kind === type)!;
    const selected = selections[type];
    if (!selected) return { ...ROWS[type] };
    const result: Row = { [spec.primary]: ROWS[type][spec.primary] };
    for (const field of selected) if (field !== spec.primary) result[field] = ROWS[type][field];
    return result;
  };
  const customer = project("customer"), address = project("address"), container = project("container");
  if (root === "customer") return { customer, addresses: [{ ...address, containers: [container] }] };
  if (root === "address") return { address, customer, containers: [container] };
  return { container, address, customer };
}
async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function served(res: Response, expected: ObjectValue): Promise<{ text: string; etag: string }> {
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, max-age=60");
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  const text = await res.text();
  expect(text).toBe(JSON.stringify(expected));
  const hash = await digest(text);
  expect(res.headers.get("etag")).toBe(`"${hash}"`);
  expect(res.headers.get("x-entity-etag")).toBe(hash);
  return { text, etag: `"${hash}"` };
}
async function problem(res: Response, status: 400 | 401): Promise<ObjectValue> {
  expect(res.status).toBe(status);
  expect(res.headers.get("content-type")).toMatch(/^application\/problem\+json\b/);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  const text = await res.text();
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => { headers[key] = value; });
  const diagnostics = text + JSON.stringify(headers);
  expect(diagnostics).not.toContain(MARKER);
  expect(diagnostics).not.toContain(encodeURIComponent(MARKER));
  expect(diagnostics).not.toMatch(/received|invalid_type|"input"|\?/i);
  const body = JSON.parse(text) as ObjectValue;
  expect(body).toMatchObject({
    type: `${PROBLEMS}#${status === 400 ? "bad-request" : "unauthorized"}`,
    title: status === 400 ? "Bad Request" : "Unauthorized", status
  });
  expect(String(body.detail)).toContain(`See docs/PROBLEMS.md#${status === 400 ? "bad-request" : "unauthorized"}.`);
  expect(Object.keys(body).filter((key) => key !== "instance" && key !== "requestId").sort()).toEqual(["detail", "status", "title", "type"]);
  if (body.requestId !== undefined) expect(body.requestId).toBe("synthetic-discovery-request");
  if (body.instance !== undefined) expect(body.instance).toMatch(/^\/api\/v1\/data\/(customer|address|container)$/);
  expect(work).toEqual({ cacheReads: 0, cacheWrites: 0, statements: [] });
  return body;
}
async function seed(): Promise<void> {
  await DB.batch([DB.prepare("DELETE FROM container_snapshot"), DB.prepare("DELETE FROM address_snapshot"), DB.prepare("DELETE FROM customer_snapshot")]);
  for (const type of TYPES) {
    const row = ROWS[type], columns = Object.keys(row);
    await DB.prepare(`INSERT INTO ${type}_snapshot (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
      .bind(...Object.values(row)).run();
  }
}

describe("discovered typed selectors and advertised modes execute against synthetic local reads", () => {
  beforeAll(async () => { await ensureD1TestTables(); });
  beforeEach(seed);
  describe.each(SPECS)("$kind", (spec) => {
    it.each(TYPES)("every discovered %s field projects that type everywhere and leaves omitted types full", async (type) => {
      const param = parameter(await document(), path(spec), BUNDLE_TYPED_FIELD_KEYS[type]);
      const meta = extension<Catalog>(param, EXT);
      assertCatalog(meta, type);
      const full = await served(await read(spec), expectedBundle(spec.kind));
      const canonical = await cache.get(`${spec.kind}:${spec.id}`)!.clone().text();
      resetWork();
      for (const field of meta.selectableFields) {
        await served(await read(spec, [[param.name, field]]), expectedBundle(spec.kind, { [type]: [field] }));
        expect(await cache.get(`${spec.kind}:${spec.id}`)!.clone().text()).toBe(canonical);
      }
      await served(await read(spec, [[param.name, meta.selectableFields.join(meta.delimiter)]]), expectedBundle(spec.kind));
      expect(await served(await read(spec), expectedBundle(spec.kind))).toEqual(full);
      expect(work.statements).toEqual([]);
      expect(work.cacheWrites).toBe(0);
    });

    it.each(TYPES)("mounted %s selector example executes with exact scope and omitted-type fullness", async (type) => {
      const param = parameter(await document(), path(spec), BUNDLE_TYPED_FIELD_KEYS[type]);
      const meta = extension<Catalog>(param, EXT);
      assertCatalog(meta, type);
      const example = param.example ?? param.schema?.example;
      expect(typeof example).toBe("string");
      if (param.example !== undefined && param.schema?.example !== undefined) expect(param.example).toEqual(param.schema.example);
      const fields = String(example).split(meta.delimiter);
      expect(fields.length).toBeGreaterThan(0);
      for (const field of fields) expect(meta.selectableFields).toContain(field);
      const full = await served(await read(spec), expectedBundle(spec.kind));
      await served(await read(spec, [[param.name, String(example)]]), expectedBundle(spec.kind, { [type]: fields }));
      expect(await cache.get(`${spec.kind}:${spec.id}`)!.clone().text()).toBe(full.text);
      expect(await served(await read(spec), expectedBundle(spec.kind))).toEqual(full);
    });

    it("independent synthetic scope/byte oracle is runnable before discovery exists", async () => {
      const pairs: Array<[string, string]> = TYPES.map((type) => [
        BUNDLE_TYPED_FIELD_KEYS[type], SPECS.find((s) => s.kind === type)!.sample
      ]);
      const selections = { customer: ["company_name"], address: ["city"], container: ["serial_number"] };
      const full = await served(await read(spec), expectedBundle(spec.kind));
      const projected = await served(await read(spec, pairs), expectedBundle(spec.kind, selections));
      expect(projected.etag).not.toBe(full.etag);
      const conditional = await read(spec, pairs, undefined, { "if-none-match": projected.etag });
      expect(conditional.status).toBe(304);
      expect(await conditional.text()).toBe("");
      expect(conditional.headers.get("etag")).toBe(projected.etag);
      expect(await served(await read(spec), expectedBundle(spec.kind))).toEqual(full);
      for (const [type, key] of Object.entries(BUNDLE_TYPED_FIELD_KEYS)) {
        const primary = SPECS.find((s) => s.kind === type)!.primary;
        await served(await read(spec, [[key, primary]]), expectedBundle(spec.kind, { [type]: [primary] }));
      }
    });

    it("uses the declared modes for every legal selector pair and illegal conflict before work", async () => {
      const doc = await document();
      for (const name of SELECTORS) {
        const param = parameter(doc, path(spec), name);
        const mode = extension<Mode>(param, MODE);
        expect(mode).toEqual(modeExpected(spec.kind, name));
        const type = name === "fields" ? spec.kind : TYPES.find((t) => BUNDLE_TYPED_FIELD_KEYS[t] === name)!;
        const sample = SPECS.find((s) => s.kind === type)!.sample;
        for (const other of mode.composesWith) {
          const otherType = other === "fields" ? spec.kind : TYPES.find((t) => BUNDLE_TYPED_FIELD_KEYS[t] === other)!;
          const otherSample = SPECS.find((s) => s.kind === otherType)!.sample;
          await served(await read(spec, [[name, sample], [other, otherSample]]),
            expectedBundle(spec.kind, { [type]: [sample], [otherType]: [otherSample] }));
        }
        for (const conflict of mode.conflictsWith) {
          resetWork(); denyWork = true;
          const otherType = conflict === "fields" ? spec.kind : TYPES.find((t) => BUNDLE_TYPED_FIELD_KEYS[t] === conflict);
          const otherValue = conflict === "ids" ? String(spec.id) : SPECS.find((s) => s.kind === otherType)!.sample;
          const pairs: Array<[string, string]> = [[name, sample], [conflict, otherValue]];
          // ids conflict must be exercised without an id/alias confounder.
          const res = conflict === "ids" ? await request(`${path(spec)}?${new URLSearchParams(pairs)}`) : await read(spec, pairs);
          await problem(res, 400);
          denyWork = false;
        }
      }
    });

    it("discovered projected validators hash served bytes without contaminating the canonical full cache", async () => {
      const doc = await document();
      const selections: Partial<Record<Kind, string[]>> = {};
      const pairs: Array<[string, string]> = [];
      for (const type of TYPES) {
        const param = parameter(doc, path(spec), BUNDLE_TYPED_FIELD_KEYS[type]);
        const meta = extension<Catalog>(param, EXT);
        const field = SPECS.find((s) => s.kind === type)!.sample;
        expect(meta.selectableFields).toContain(field);
        selections[type] = [field]; pairs.push([param.name, field]);
      }
      const full = await served(await read(spec), expectedBundle(spec.kind));
      const selected = await served(await read(spec, pairs, undefined, { "if-none-match": full.etag }), expectedBundle(spec.kind, selections));
      expect(selected.etag).not.toBe(full.etag);
      const conditional = await read(spec, pairs, undefined, { "if-none-match": selected.etag });
      expect(conditional.status).toBe(304);
      expect(await conditional.text()).toBe("");
      expect(conditional.headers.get("etag")).toBe(selected.etag);
      expect(await served(await read(spec), expectedBundle(spec.kind))).toEqual(full);
      expect(await cache.get(`${spec.kind}:${spec.id}`)!.clone().text()).toBe(full.text);
    });

    it("full and batch success representations stay unchanged without selector metadata leaking into JSON", async () => {
      await served(await read(spec), expectedBundle(spec.kind));
      const res = await request(`${path(spec)}?ids=${spec.id}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("etag")).toBeNull();
      expect(await res.json()).toEqual({ entries: [{ id: spec.id, found: true, [spec.kind]: expectedBundle(spec.kind) }] });
    });
  });
});

describe.each(SPECS)("$kind malformed-selector safety", (spec) => {
  beforeEach(() => { denyWork = true; });
  it.each(TYPES)("advertised %s rules match strict validation with zero cache/D1/network work", async (type) => {
    const key = BUNDLE_TYPED_FIELD_KEYS[type];
    const sample = SPECS.find((s) => s.kind === type)!.sample;
    const malformed = ["", ",", `,${sample}`, `${sample},`, `${sample},,${sample}`, `${sample},${sample}`,
      ` ${sample}`, `${sample} `, sample.toUpperCase(), `unknown-${MARKER}`, "rowid"];
    // Validation runs independently of discovery, so missing metadata cannot mask a safety regression.
    for (const value of malformed) {
      const body = await problem(await read(spec, [[key, value]]), 400);
      expect(body.detail).toBe(`Invalid request query (${key}). See docs/PROBLEMS.md#bad-request.`);
    }
    await problem(await read(spec, [[key, sample], [key, sample]]), 400);
  });

  it.each([false, true])("unknown key correction guidance is fixed and never reflects input (warm cache: %s)", async (warm) => {
    if (warm) cache.set(`${spec.kind}:${spec.id}`, new Response(JSON.stringify(expectedBundle(spec.kind)), {
      headers: { etag: '"synthetic-full-validator"', "content-type": "application/json" }
    }));
    const keys = [`fields[${MARKER}]`, `fields[Bearer-${MARKER}]`, `fields[${MARKER}`, "fields[foo]", "fields[]", "fields[customer]suffix"];
    const details: unknown[] = [];
    for (const key of keys) {
      const body = await problem(await read(spec, [[key, `sk_test_${MARKER}`]], undefined, { "if-none-match": "*" }), 400);
      const detail = String(body.detail);
      const named = detail.match(/fields\[[^\]]*\]/g) ?? [];
      expect(named.sort()).toEqual(Object.values(BUNDLE_TYPED_FIELD_KEYS).sort());
      expect(detail).not.toContain(key);
      details.push(body.detail);
    }
    expect(new Set(details).size).toBe(1);
    const multi = await problem(await read(spec, [[keys[0], MARKER], [keys[3], MARKER], ["fields[address]", "city"]]), 400);
    expect(multi.detail).toBe(details[0]);
  });

  describe.each([
    { label: "valid id", ids: [["id", String(spec.id)]], invalid: false },
    { label: "malformed id", ids: [["id", "abc"]], invalid: true },
    { label: "malformed alias", ids: [[spec.alias, "abc"]], invalid: true },
    { label: "bad id beside valid alias", ids: [["id", "abc"], [spec.alias, String(spec.id)]], invalid: true },
    { label: "bad alias beside valid id", ids: [[spec.alias, "abc"], ["id", String(spec.id)]], invalid: true }
  ])("$label with an unknown secret-shaped key", ({ ids, invalid }) => {
    it.each([
      { label: "sync secret", auth: `Bearer ${SECRET}`, status: 400, gate: null },
      { label: "API token", auth: "Bearer synthetic-api-token", status: 401, gate: "CUSTOMER_SNAPSHOT_SYNC_SECRET" },
      { label: "read token", auth: "Bearer synthetic-read-token", status: 401, gate: "CUSTOMER_SNAPSHOT_SYNC_SECRET" },
      { label: "wrong bearer", auth: "Bearer synthetic-wrong", status: 401, gate: "SHADOW_API_TOKEN" },
      { label: "no bearer", auth: "", status: 401, gate: "SHADOW_API_TOKEN" }
    ] as const)("$label preserves auth order and zero work without reflection", async ({ auth, status, gate }) => {
      const pairs = [...ids, [`fields[${MARKER}]`, `sk_test_${MARKER}`]] as Array<[string, string]>;
      const body = await problem(await request(`${path(spec)}?${new URLSearchParams(pairs)}`, auth), status);
      if (gate) expect(body.detail).toBe(`Send Authorization: Bearer <${gate}>. See docs/PROBLEMS.md#unauthorized.`);
      // Existing preliminary ID-only errors remain their own diagnostic, not selector guidance.
      if (invalid && status === 400) expect(String(body.detail)).not.toContain(MARKER);
    });
  });

  it.each(["synthetic-api-token", "synthetic-read-token"])("%s keeps preliminary ID-only 400s when selectors are valid", async (token) => {
    for (const pairs of [[], [["fields[address]", "city"]], [["fields", spec.sample]]]) {
      const query = new URLSearchParams([["id", "abc"], ...pairs] as Array<[string, string]>);
      await problem(await request(`${path(spec)}?${query}`, `Bearer ${token}`), 400);
    }
  });
});
