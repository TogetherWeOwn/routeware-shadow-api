import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { SNAPSHOT_FIELDSETS } from "../src/lib/sparseFieldsets";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Declaration-only oracle. Breaks caught: unknown/miswired 200 schemas, missing
 * nested columns, boolean/string coercion of D1 integers, wrong nullability,
 * required non-identity fields that reject projections, and invalid examples.
 * HTTP controls catch accidental validators, normalization or auth/ETag changes.
 *
 * Run: npx vitest run test/typedHydratedBundles.acceptance.test.ts --maxWorkers=2
 * Synthetic fixtures, real hermetic local D1; no upstream or production access.
 * Test Author-owned: Builder consumes the immutable ref without editing this file.
 */
type Kind = "customer" | "address" | "container";
type Row = Record<string, string | number | null>;
type Schema = {
  $ref?: string; type?: string | string[]; nullable?: boolean;
  properties?: Record<string, Schema>; required?: string[]; items?: Schema;
  anyOf?: Schema[]; oneOf?: Schema[]; allOf?: Schema[];
  [key: string]: unknown;
};
type Media = { schema: Schema; example?: unknown; examples?: Record<string, { value?: unknown; $ref?: string }> };
type Operation = {
  operationId: string; parameters?: Array<{ in: string; name: string }>;
  responses: Record<string, { content?: Record<string, Media> }>;
};
type Document = {
  paths: Record<string, { get: Operation }>;
  components?: { schemas?: Record<string, Schema> };
};
const kinds: Kind[] = ["customer", "address", "container"];
const db = env.CUSTOMER_DB;
const SECRET = "synthetic-bundle-contract-sync";
const BAD_REQUEST = "https://github.com/TogetherWeOwn/routeware-shadow-api/blob/main/docs/PROBLEMS.md#bad-request";
const work = { sql: [] as string[], cacheReads: 0, cacheWrites: 0 };
const cache = new Map<string, Response>();
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

// Independently transcribed storage oracle: migrations/d1/0001 and 0002.
// Registry use below is ONLY the explicit declaration parity assertion, never
// the source of expected values, column types or projection expectations.
const columns: Record<Kind, { id: string; numeric: string[]; text: string[]; notNull: string[] }> = {
  customer: {
    id: "customer_id", numeric: ["customer_id", "customer_type_id", "enabled"],
    text: ["company_name", "first_name", "middle_initial", "last_name", "name_suffix", "customer_number",
      "sub_customer_number", "phone1", "phone2", "comments", "synced_at"],
    notNull: ["customer_id", "enabled", "synced_at"]
  },
  address: {
    id: "pickup_address_id", numeric: ["pickup_address_id", "customer_id", "route_id", "extras_allowed", "enabled"],
    text: ["address", "city", "state", "zip", "franchise_id", "comments", "driver_note", "latitude", "longitude",
      "last_audit_date", "synced_at"],
    notNull: ["pickup_address_id", "customer_id", "extras_allowed", "enabled", "synced_at"]
  },
  container: {
    id: "container_id", numeric: ["container_id", "pickup_address_id", "container_type_id", "oncall", "gps_locked", "enabled"],
    text: ["serial_number", "rfid", "event_code", "latitude", "longitude", "location_address", "city", "state", "zip",
      "container_note", "ud_cost_share_ud", "ud_enclosure_doors_ud", "ud_last_compactor_inspection_ud",
      "ud_last_enclosure_inspection_ud", "ud_material_stream_ud", "color", "service_code_type", "service_code_input",
      "service_code", "service_date", "route_ids", "frequency_ids", "synced_at"],
    notNull: ["container_id", "pickup_address_id", "oncall", "gps_locked", "enabled", "synced_at"]
  }
};
const customer: Row = {
  customer_id: 97101, customer_type_id: 0, company_name: "Synthetic bundle company", first_name: "Synthetic",
  middle_initial: "", last_name: "Fixture", name_suffix: "", customer_number: "0001", sub_customer_number: "00",
  phone1: "555-0100", phone2: "", comments: "Synthetic-only comment", enabled: 0, synced_at: "2026-10-01T00:00:00.000Z"
};
const address: Row = {
  pickup_address_id: 97201, customer_id: 97101, route_id: 0, address: "1 Synthetic Way", city: "Syntheticville",
  state: "ZZ", zip: "00000", franchise_id: "0003", comments: "", extras_allowed: 0, enabled: 0,
  driver_note: "", latitude: "0", longitude: "-10.5", last_audit_date: "", synced_at: "2026-10-02T00:00:00.000Z"
};
const container: Row = {
  container_id: 97301, pickup_address_id: 97201, container_type_id: 0, serial_number: "SYNTHETIC-001", rfid: "",
  oncall: 0, event_code: "", gps_locked: 0, latitude: "0", longitude: "-11.5", enabled: 0,
  location_address: "Synthetic enclosure", city: "Syntheticville", state: "ZZ", zip: "00000", container_note: "",
  ud_cost_share_ud: "0", ud_enclosure_doors_ud: "2", ud_last_compactor_inspection_ud: "",
  ud_last_enclosure_inspection_ud: "", ud_material_stream_ud: "synthetic-paper", color: "blue",
  service_code_type: "SYN", service_code_input: "", service_code: "SYN-CODE", service_date: "",
  route_ids: "7,8", frequency_ids: "1,2", synced_at: "2026-10-03T00:00:00.000Z"
};
const rows = { customer, address, container };
const aliases: Record<Kind, string> = { customer: "customerId", address: "pickupAddressId", container: "containerId" };
const projected: Record<Kind, Row> = {
  customer: { customer_id: 97101, company_name: "Synthetic bundle company" },
  address: { pickup_address_id: 97201, city: "Syntheticville" },
  container: { container_id: 97301, serial_number: "SYNTHETIC-001" }
};
const selectors: Record<Kind, string> = { customer: "company_name", address: "city", container: "serial_number" };
const session = {
  async fetch(input: RequestInfo | URL) {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === "/throttle/failure" || path === "/throttle/clear") return Response.json({ blocked: false, retryAfterSec: 0 });
    throw new Error(`Unexpected auth/session action: ${path}`);
  }
};
function bindings(): Env {
  return {
    ...env, OPENAPI_DOCS_ENABLED: "true", CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET,
    SHADOW_API_TOKEN: "synthetic-bundle-api", SHADOW_API_READ_TOKEN: "synthetic-bundle-read",
    CUSTOMER_DB: {
      prepare(sql: string) {
        work.sql.push(sql);
        if (!/^\s*SELECT\b/i.test(sql)) throw new Error("GET attempted a D1 mutation");
        return db.prepare(sql);
      }
    },
    AUTH_SESSION: { idFromName: (name: string) => name, get: () => session }
  } as unknown as Env;
}
async function request(path: string, headers: HeadersInit = {}): Promise<Response> {
  const pending: Promise<unknown>[] = [];
  const requestHeaders = new Headers({ authorization: `Bearer ${SECRET}`, "x-request-id": "synthetic-bundle-request" });
  new Headers(headers).forEach((value, key) => requestHeaders.set(key, value));
  const response = await app.fetch(new Request(`https://synthetic-bundles.invalid${path}`, {
    headers: requestHeaders
  }), bindings(), {
    waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {}
  } as ExecutionContext);
  await Promise.all(pending);
  return response;
}
function get(kind: Kind, query = `id=${rows[kind][columns[kind].id]}`, headers: HeadersInit = {}) {
  return request(`/api/v1/data/${kind}?${query}`, headers);
}
function full(kind: Kind): Record<string, unknown> {
  if (kind === "customer") return { customer, addresses: [{ ...address, containers: [container] }] };
  if (kind === "address") return { address, customer, containers: [container] };
  return { container, address, customer };
}
function resetWork() { work.sql.length = 0; work.cacheReads = 0; work.cacheWrites = 0; }
function noWork() { expect(work).toEqual({ sql: [], cacheReads: 0, cacheWrites: 0 }); }
async function insert(kind: Kind, row: Row) {
  const keys = Object.keys(row);
  await db.prepare(`INSERT INTO ${kind}_snapshot (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
    .bind(...Object.values(row)).run();
}

// Only local refs; no fetch, no expected shape injected into the validator.
function resolve(value: unknown, doc: Document): unknown {
  if (Array.isArray(value)) return value.map(item => resolve(item, doc));
  if (value === null || typeof value !== "object") return value;
  const node = value as Schema;
  if (node.$ref) {
    expect(node.$ref.startsWith("#/"), "contract must be self-contained").toBe(true);
    const target = node.$ref.slice(2).split("/").reduce<unknown>((part, key) =>
      (part as Record<string, unknown>)[key.replace(/~1/g, "/").replace(/~0/g, "~")], doc);
    expect(target, `unresolved ${node.$ref}`).toBeDefined();
    const { $ref: _ref, ...siblings } = node;
    return resolve({ ...(target as Schema), ...siblings }, doc);
  }
  const result = Object.fromEntries(Object.entries(node).map(([key, item]) => [key, resolve(item, doc)]));
  if (node.nullable === true) {
    delete result.nullable;
    return { anyOf: [result, { type: "null" }] };
  }
  return result;
}
function validator(schema: Schema) {
  return z.fromJSONSchema(resolve(schema, document) as Parameters<typeof z.fromJSONSchema>[0]);
}
function shape(schema: Schema): Schema {
  const node = resolve(schema, document) as Schema;
  const union = node.anyOf ?? node.oneOf;
  if (union) {
    const objects = union.map(shape).filter(part => part.properties !== undefined);
    expect(objects, "expected exactly one non-null object branch").toHaveLength(1);
    return objects[0];
  }
  if (!node.allOf) return node;
  const parts = node.allOf.map(shape);
  return { ...node, properties: Object.assign({}, ...parts.map(part => part.properties), node.properties),
    required: [...new Set([...parts.flatMap(part => part.required ?? []), ...(node.required ?? [])])] };
}
function media(kind: Kind): Media {
  return document.paths[`/api/v1/data/${kind}`].get.responses["200"].content!["application/json"];
}
function bundleSchema(kind: Kind): Schema {
  const root = media(kind).schema;
  const resolved = resolve(root, document) as Schema;
  // Batch typing may compose independently. Select by structure, never branch
  // position, and never make publishing a batch schema a prerequisite here.
  const union = root.anyOf ?? root.oneOf ?? resolved.anyOf ?? resolved.oneOf;
  if (union) {
    const candidates = union.filter(part => shape(part).properties?.[kind] !== undefined);
    expect(candidates, `${kind}: single-bundle branch`).toHaveLength(1);
    return candidates[0];
  }
  return root;
}
const locations: Array<{ root: Kind; kind: Kind; path: string[] }> = [
  { root: "customer", kind: "customer", path: ["customer"] },
  { root: "customer", kind: "address", path: ["addresses", "[]"] },
  { root: "customer", kind: "container", path: ["addresses", "[]", "containers", "[]"] },
  { root: "address", kind: "address", path: ["address"] },
  { root: "address", kind: "customer", path: ["customer"] },
  { root: "address", kind: "container", path: ["containers", "[]"] },
  { root: "container", kind: "container", path: ["container"] },
  { root: "container", kind: "address", path: ["address"] },
  { root: "container", kind: "customer", path: ["customer"] }
];
function rowSchema(location: typeof locations[number]): Schema {
  let schema = bundleSchema(location.root);
  for (const key of location.path) {
    const node = shape(schema);
    if (key === "[]") {
      expect(node.type, `${location.path.join(".")} must be a typed array`).toBe("array");
      expect(node.items).toBeDefined();
      schema = node.items!;
    } else {
      expect(node.properties?.[key], `${location.root}.${location.path.join(".")}: missing ${key}`).toBeDefined();
      schema = node.properties![key];
    }
  }
  return schema;
}
let document: Document;
const network = vi.fn(() => { throw new Error("Outbound network forbidden in typed bundle acceptance"); });
beforeAll(async () => {
  vi.stubGlobal("fetch", network);
  await ensureD1TestTables();
  const response = await request("/openapi.json");
  expect(response.status).toBe(200);
  document = await response.json() as Document;
});
beforeEach(async () => {
  vi.stubGlobal("fetch", network);
  network.mockClear();
  cache.clear();
  await db.batch([db.prepare("DELETE FROM container_snapshot"), db.prepare("DELETE FROM address_snapshot"), db.prepare("DELETE FROM customer_snapshot")]);
  for (const kind of kinds) await insert(kind, rows[kind]);
  resetWork();
});
afterEach(() => {
  vi.unstubAllGlobals();
  expect(network).not.toHaveBeenCalled();
});

describe("mounted hydrated bundle declarations", () => {
  it("publishes three distinct resolvable named bundle schemas, not any", () => {
    const refs = kinds.map(kind => {
      const schema = bundleSchema(kind);
      expect(schema.$ref, `${kind}: generated clients need a named bundle`).toBeTypeOf("string");
      expect(schema.$ref).toMatch(/^#\/components\/schemas\//);
      expect(shape(schema).type).toBe("object");
      return schema.$ref;
    });
    expect(new Set(refs).size).toBe(3);
    noWork();
  });
  it.each(kinds)("%s keeps the existing bundle composition", kind => {
    const expected = kind === "customer" ? ["customer", "addresses"] : kind === "address" ? ["address", "customer", "containers"] : ["container", "address", "customer"];
    expect(Object.keys(shape(bundleSchema(kind)).properties ?? {}).sort()).toEqual(expected.sort());
  });
  for (const location of locations) {
    const label = `${location.root}.${location.path.join(".")}`;
    it(`${label}: exact fieldset parity and only the primary identity required`, () => {
      const node = shape(rowSchema(location));
      const nestedAddress = location.path.join(".") === "addresses.[]";
      const properties = Object.keys(node.properties ?? {}).filter(key => !(nestedAddress && key === "containers"));
      expect(properties.sort()).toEqual([...SNAPSHOT_FIELDSETS[location.kind].columns].sort());
      expect(properties.sort()).toEqual([...columns[location.kind].numeric, ...columns[location.kind].text].sort());
      expect([...(node.required ?? [])].filter(key => key !== "containers")).toEqual([columns[location.kind].id]);
      const minimal = { [columns[location.kind].id]: rows[location.kind][columns[location.kind].id],
        ...(location.path.join(".") === "addresses.[]" ? { containers: [] } : {}) };
      expect(validator(rowSchema(location)).safeParse(minimal).success, "projected rows must not require foreign keys, flags or synced_at").toBe(true);
    });
    for (const key of [...columns[location.kind].numeric, ...columns[location.kind].text]) {
      it(`${label}.${key}: storage-faithful type and nullability`, () => {
        const node = shape(rowSchema(location)).properties?.[key];
        expect(node, `missing typed column ${key}`).toBeDefined();
        const validate = validator(node!);
        const numeric = columns[location.kind].numeric.includes(key);
        expect(validate.safeParse(rows[location.kind][key]).success).toBe(true);
        expect(validate.safeParse(numeric ? "1" : 1).success, "no unknown/any or numeric-text confusion").toBe(false);
        expect(validate.safeParse(false).success, "D1 flags are numeric, never boolean").toBe(false);
        expect(validate.safeParse({}).success).toBe(false);
        expect(validate.safeParse(null).success).toBe(!columns[location.kind].notNull.includes(key));
      });
    }
  }
  it.each(kinds)("%s validates published full AND projected examples", kind => {
    const entry = media(kind);
    const examples: unknown[] = [];
    if (entry.example !== undefined) examples.push(entry.example);
    for (const example of Object.values(entry.examples ?? {})) {
      const resolved = resolve(example, document) as { value?: unknown };
      expect(resolved.value, "no externalValue/example fetch").toBeDefined();
      examples.push(resolved.value);
    }
    const resolvedSchema = resolve(bundleSchema(kind), document) as Schema;
    if (resolvedSchema.example !== undefined) examples.push(resolvedSchema.example);
    if (Array.isArray(resolvedSchema.examples)) examples.push(...resolvedSchema.examples);
    const values = examples.filter(value => value !== null && typeof value === "object" && kind in value) as Record<string, unknown>[];
    expect(values.length, `${kind}: publish full and projected synthetic bundle examples`).toBeGreaterThanOrEqual(2);
    const rootKeys = (value: Record<string, unknown>) => Object.keys(value[kind] as object);
    expect(values.some(value => rootKeys(value).length === SNAPSHOT_FIELDSETS[kind].columns.length), "full example").toBe(true);
    expect(values.some(value => rootKeys(value).length < SNAPSHOT_FIELDSETS[kind].columns.length && rootKeys(value).includes(columns[kind].id)), "projected example").toBe(true);
    for (const value of values) expect(validator(bundleSchema(kind)).safeParse(value).success, JSON.stringify(value)).toBe(true);
  });
});

describe("seeded relation composition", () => {
  it("groups and orders addresses/containers without leaking a different customer's graph", async () => {
    const secondAddress = { ...address, pickup_address_id: 97202 };
    const secondContainer = { ...container, container_id: 97302 };
    const thirdContainer = { ...container, container_id: 97303, pickup_address_id: 97202 };
    await insert("customer", { ...customer, customer_id: 97102 });
    await insert("address", { ...address, pickup_address_id: 97203, customer_id: 97102 });
    await insert("container", { ...container, container_id: 97304, pickup_address_id: 97203 });
    await insert("address", secondAddress);
    await insert("container", thirdContainer);
    await insert("container", secondContainer);
    const response = await get("customer");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ customer, addresses: [
      { ...address, containers: [container, secondContainer] }, { ...secondAddress, containers: [thirdContainer] }
    ] });
  });
});

describe.each(kinds)("%s mounted runtime preservation", kind => {
  it("returns exact populated D1 values, bytes, key order and a stable cold/warm ETag", async () => {
    const cold = await get(kind);
    expect(cold.status).toBe(200);
    const text = await cold.text();
    expect(text).toBe(JSON.stringify(full(kind)));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    expect(cold.headers.get("etag")).toBe(`"${hash}"`);
    expect(cold.headers.get("x-entity-etag")).toBe(hash);
    expect(cold.headers.get("cache-control")).toBe("private, max-age=60");
    const sql = [...work.sql];
    const warm = await get(kind);
    expect(await warm.text()).toBe(text);
    expect(warm.headers.get("etag")).toBe(cold.headers.get("etag"));
    expect(work.sql).toEqual(sql);
    expect(sql.length).toBeGreaterThan(0);
    expect(sql.every(statement => !/\bCOUNT\s*\(/i.test(statement))).toBe(true);
  });
  it("preserves id-over-alias precedence and keeps single bundles count/cursor/link-free", async () => {
    const response = await get(kind, `id=${rows[kind][columns[kind].id]}&${aliases[kind]}=97999`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(full(kind));
    expect(response.headers.has("link")).toBe(false);
    // These are detail bundles, not paginated list envelopes. Declaration work
    // must not add order/cursor/includeTotal parameters to invent a list API.
    const names = document.paths[`/api/v1/data/${kind}`].get.parameters?.filter(parameter => parameter.in === "query").map(parameter => parameter.name) ?? [];
    for (const name of ["order", "cursor", "afterId", "includeTotal", "limit"]) expect(names).not.toContain(name);
  });
  it("does not install a GET response parser that strips extension keys or reorders cached bytes", async () => {
    const text = JSON.stringify({ future_relation: { synthetic: true }, ...full(kind),
      [kind]: { future_column: "synthetic-extension", ...rows[kind] } });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    cache.set(`${kind}:${rows[kind][columns[kind].id]}`, new Response(text, { headers: {
      "content-type": "application/json; charset=utf-8", "cache-control": "private, max-age=60",
      etag: `"${hash}"`, "x-entity-etag": hash
    } }));
    const response = await get(kind);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(text);
    expect(response.headers.get("etag")).toBe(`"${hash}"`);
    expect(work.sql).toEqual([]);
  });
  it("validates actual populated and SQL NULL rows against the declaration", async () => {
    for (const resource of kinds) {
      const nullable = [...columns[resource].numeric, ...columns[resource].text].filter(key => !columns[resource].notNull.includes(key));
      await db.prepare(`UPDATE ${resource}_snapshot SET ${nullable.map(key => `${key} = NULL`).join(",")}`).run();
    }
    const response = await get(kind);
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, Row>;
    for (const key of [...columns[kind].numeric, ...columns[kind].text]) {
      expect(body[kind][key]).toBe(columns[kind].notNull.includes(key) ? rows[kind][key] : null);
    }
    expect(validator(bundleSchema(kind)).safeParse(body).success).toBe(true);
    cache.clear();
    for (const resource of kinds) {
      const row = rows[resource];
      const keys = Object.keys(row).filter(key => key !== columns[resource].id);
      await db.prepare(`UPDATE ${resource}_snapshot SET ${keys.map(key => `${key} = ?`).join(",")}`).bind(...keys.map(key => row[key])).run();
    }
    const populated = await (await get(kind)).json();
    expect(populated).toEqual(full(kind));
    expect(validator(bundleSchema(kind)).safeParse(populated).success).toBe(true);
  });
  it("keeps root field selection, alias semantics and bodyless conditional 304", async () => {
    const query = `${aliases[kind]}=${rows[kind][columns[kind].id]}&fields=${selectors[kind]}`;
    const response = await get(kind, query);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ ...full(kind), [kind]: projected[kind] });
    expect(validator(bundleSchema(kind)).safeParse(body).success).toBe(true);
    const etag = response.headers.get("etag");
    expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
    const conditional = await get(kind, query, { "if-none-match": etag! });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
    expect(conditional.headers.get("etag")).toBe(etag);
    expect(document.paths[`/api/v1/data/${kind}`].get.responses["304"].content).toBeUndefined();
  });
  it("accepts identity-only sparse relations independent of their implementation landing", () => {
    const minimal = {
      customer: { customer_id: 97101 }, address: { pickup_address_id: 97201 }, container: { container_id: 97301 }
    };
    const body = kind === "customer" ? { customer: minimal.customer, addresses: [{ ...minimal.address, containers: [minimal.container] }] }
      : kind === "address" ? { address: minimal.address, customer: minimal.customer, containers: [minimal.container] } : minimal;
    expect(validator(bundleSchema(kind)).safeParse(body).success).toBe(true);
  });
  it("keeps nullable missing parents and empty relations representable", async () => {
    if (kind === "customer") {
      await db.prepare("DELETE FROM container_snapshot").run();
      await db.prepare("DELETE FROM address_snapshot").run();
      const response = await get(kind);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ customer, addresses: [] });
      expect(validator(bundleSchema(kind)).safeParse(body).success).toBe(true);
    } else {
      // Local D1 enforces foreign keys. Do not disable them to manufacture an
      // impossible stored graph; existing missing-parent handler tests cover
      // stale/racing parents. The declaration must still represent their nulls.
      const body = kind === "address" ? { address, customer: null, containers: [] }
        : { container, address: null, customer: null };
      expect(validator(bundleSchema(kind)).safeParse(body).success).toBe(true);
      if (kind === "container") {
        expect(validator(bundleSchema(kind)).safeParse({ container, address, customer: null }).success).toBe(true);
      }
    }
  });
  it("retains optional batch lookup without making batch typing a new dependency", async () => {
    const response = await get(kind, `ids=${rows[kind][columns[kind].id]},97999`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [
      { id: rows[kind][columns[kind].id], found: true, [kind]: full(kind) }, { id: 97999, found: false }
    ] });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("etag")).toBe(false);
  });
  it.each(["id=01", "id=1e2", "id=1&id=2", "id=97101&fields=", "id=97101&fields=city&fields=city", "id=97101&unknown=SYNTHETIC-MARKER"])("rejects strict lexical/repeated queries before D1: %s", async query => {
    const response = await get(kind, query);
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
    expect(await response.json()).toMatchObject({ type: BAD_REQUEST, status: 400 });
    noWork();
  });
  it("authenticates before malformed query processing or D1", async () => {
    const response = await get(kind, "id=01&fields=invalid&unknown=marker", { authorization: "Bearer synthetic-invalid" });
    expect(response.status).toBe(401);
    noWork();
  });
});
