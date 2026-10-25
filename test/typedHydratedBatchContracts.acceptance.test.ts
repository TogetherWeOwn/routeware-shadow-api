import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import packageJson from "../package.json";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Declaration-only acceptance oracle. Breaks caught: a single-only 200, any/
 * unknown batch payloads, wrong resource wiring, permissive found/missing
 * variants, lost request order/duplicates, cross-parent hydration and input echo.
 * Expected graphs come from literal fixtures, never another GET or a production
 * projector/schema/column registry. Only external cache/network are replaced;
 * SQL executes against hermetic local D1 with its real foreign keys enabled.
 *
 * Run: npx vitest run test/typedHydratedBatchContracts.acceptance.test.ts --maxWorkers=2
 * Test Author-owned; consume the pushed ref without editing this oracle.
 */
type Kind = "customer" | "address" | "container";
type Row = Record<string, string | number | null>;
type Bundle = Record<string, unknown>;
type Schema = {
  $ref?: string; type?: string | string[]; nullable?: boolean;
  properties?: Record<string, Schema>; required?: string[]; items?: Schema;
  anyOf?: Schema[]; oneOf?: Schema[]; allOf?: Schema[];
  [key: string]: unknown;
};
type Example = { value?: unknown; $ref?: string };
type Media = { schema: Schema; example?: unknown; examples?: Record<string, Example> };
type Operation = {
  parameters?: Array<{ name: string; in: string }>;
  responses: Record<string, { content?: Record<string, Media> }>;
};
type Document = {
  paths: Record<string, { get: Operation }>;
  components: { schemas: Record<string, Schema>; examples?: Record<string, Example> };
};
const kinds: Kind[] = ["customer", "address", "container"];
const singleRefs: Record<Kind, string> = {
  customer: "#/components/schemas/HydratedCustomerBundle",
  address: "#/components/schemas/HydratedAddressBundle",
  container: "#/components/schemas/HydratedContainerBundle"
};
const SECRET = "synthetic-batch-contract-sync";
const MISSING = 98999;
const MAX_ID = 9007199254740991;
const db = env.CUSTOMER_DB;
const cache = new Map<string, Response>();
const work = { sql: [] as string[], cacheReads: 0, cacheWrites: 0 };
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

// Complete storage rows, independently transcribed from migrations 0001/0002.
// Distinct root/foreign IDs and out-of-order inserts expose wrong predicates,
// ordering and grouping. Null, empty text and zero flags must survive unchanged.
const customer: Row = {
  customer_id: 98111, customer_type_id: 0, company_name: "Synthetic batch Alpha",
  first_name: "Synthetic", middle_initial: null, last_name: "Fixture", name_suffix: "",
  customer_number: "0001", sub_customer_number: "00", phone1: "555-0100", phone2: null,
  comments: "Synthetic only", enabled: 0, synced_at: "2026-10-01T00:00:00.000Z"
};
const otherCustomer: Row = { ...customer, customer_id: 98112, company_name: "Synthetic batch Beta" };
const emptyCustomer: Row = { ...customer, customer_id: 98113, company_name: "Synthetic batch Empty" };
const address: Row = {
  pickup_address_id: 98211, customer_id: 98111, route_id: 0, address: "1 Synthetic Way",
  city: "Synthetic Alpha", state: "ZZ", zip: "00000", franchise_id: "0003", comments: null,
  extras_allowed: 0, enabled: 0, driver_note: "", latitude: "0", longitude: "-10.5",
  last_audit_date: null, synced_at: "2026-10-02T00:00:00.000Z"
};
const otherAddress: Row = { ...address, pickup_address_id: 98212, customer_id: 98112, city: "Synthetic Beta" };
const secondAddress: Row = { ...address, pickup_address_id: 98213, city: "Synthetic Alpha second" };
const emptyAddress: Row = { ...address, pickup_address_id: 98214, customer_id: 98112, city: "Synthetic Empty" };
const container: Row = {
  container_id: 98311, pickup_address_id: 98211, container_type_id: 0, serial_number: "SYNTHETIC-ALPHA-1",
  rfid: null, oncall: 0, event_code: "", gps_locked: 0, latitude: "0", longitude: "-11.5", enabled: 0,
  location_address: "Synthetic enclosure", city: "Synthetic Alpha", state: "ZZ", zip: "00000",
  container_note: null, ud_cost_share_ud: "0", ud_enclosure_doors_ud: "2",
  ud_last_compactor_inspection_ud: null, ud_last_enclosure_inspection_ud: "",
  ud_material_stream_ud: "synthetic-paper", color: "blue", service_code_type: "SYN",
  service_code_input: "", service_code: "SYN-CODE", service_date: "", route_ids: "7,8",
  frequency_ids: "1,2", synced_at: "2026-10-03T00:00:00.000Z"
};
const otherContainer: Row = { ...container, container_id: 98312, pickup_address_id: 98212, serial_number: "SYNTHETIC-BETA" };
const secondContainer: Row = { ...container, container_id: 98313, serial_number: "SYNTHETIC-ALPHA-2" };
const thirdContainer: Row = { ...container, container_id: 98314, pickup_address_id: 98213, serial_number: "SYNTHETIC-ALPHA-3" };
const bundles: Record<Kind, Record<number, Bundle>> = {
  customer: {
    98111: { customer, addresses: [{ ...address, containers: [container, secondContainer] }, { ...secondAddress, containers: [thirdContainer] }] },
    98112: { customer: otherCustomer, addresses: [{ ...otherAddress, containers: [otherContainer] }, { ...emptyAddress, containers: [] }] },
    98113: { customer: emptyCustomer, addresses: [] }
  },
  address: {
    98211: { address, customer, containers: [container, secondContainer] },
    98212: { address: otherAddress, customer: otherCustomer, containers: [otherContainer] },
    98214: { address: emptyAddress, customer: otherCustomer, containers: [] }
  },
  container: {
    98311: { container, address, customer },
    98312: { container: otherContainer, address: otherAddress, customer: otherCustomer }
  }
};
const specs = [
  { kind: "customer", id: 98111, other: 98112, key: "customer_id", field: "company_name", alias: "customerId",
    selected: { customer_id: 98111, company_name: "Synthetic batch Alpha" } },
  { kind: "address", id: 98211, other: 98212, key: "pickup_address_id", field: "city", alias: "pickupAddressId",
    selected: { pickup_address_id: 98211, city: "Synthetic Alpha" } },
  { kind: "container", id: 98311, other: 98312, key: "container_id", field: "serial_number", alias: "containerId",
    selected: { container_id: 98311, serial_number: "SYNTHETIC-ALPHA-1" } }
] as const;
type Spec = typeof specs[number];
const session = {
  async fetch(input: RequestInfo | URL) {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path === "/throttle/failure" || path === "/throttle/clear") return Response.json({ blocked: false, retryAfterSec: 0 });
    throw new Error(`Unexpected auth action: ${path}`);
  }
};
// A parent SELECT returning null models a racing/missing parent without turning
// off D1 foreign keys or inventing invalid persistent data. Other reads stay real.
type HiddenParent = "customer" | "address";
function bindings(hidden?: HiddenParent): Env {
  return {
    ...env, OPENAPI_DOCS_ENABLED: "true", CUSTOMER_SNAPSHOT_SYNC_SECRET: SECRET,
    SHADOW_API_TOKEN: "synthetic-batch-api", SHADOW_API_READ_TOKEN: "synthetic-batch-read",
    CUSTOMER_DB: {
      prepare(sql: string) {
        work.sql.push(sql);
        if (!/^\s*SELECT\b/i.test(sql)) throw new Error("GET attempted a D1 mutation");
        const statement = db.prepare(sql);
        if (!hidden || !new RegExp(`\\bFROM\\s+${hidden}_snapshot\\b`, "i").test(sql)) return statement;
        return { bind: (...values: unknown[]) => {
          const bound = statement.bind(...values);
          return { first: async () => null, all: () => bound.all(), raw: () => bound.raw(), run: () => { throw new Error("GET attempted run()"); } };
        } };
      }
    },
    AUTH_SESSION: { idFromName: (name: string) => name, get: () => session }
  } as unknown as Env;
}
async function request(path: string, headers: HeadersInit = {}, hidden?: HiddenParent) {
  const pending: Promise<unknown>[] = [];
  const h = new Headers({ authorization: `Bearer ${SECRET}`, "x-request-id": "synthetic-batch-contract" });
  new Headers(headers).forEach((value, key) => h.set(key, value));
  const response = await app.fetch(new Request(`https://synthetic-batch.invalid${path}`, { headers: h }), bindings(hidden), {
    waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {}
  } as ExecutionContext);
  await Promise.all(pending);
  return response;
}
function get(spec: Spec, query: string, headers: HeadersInit = {}, hidden?: HiddenParent) {
  return request(`/api/v1/data/${spec.kind}?${query}`, headers, hidden);
}
function expectedBatch(kind: Kind, ids: number[]) {
  return { entries: ids.map(id => bundles[kind][id]
    ? { id, found: true, [kind]: bundles[kind][id] } : { id, found: false }) };
}
function resetWork() { work.sql.length = 0; work.cacheReads = 0; work.cacheWrites = 0; }
function noWork() { expect(work).toEqual({ sql: [], cacheReads: 0, cacheWrites: 0 }); }
function batchHeaders(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.has("etag")).toBe(false);
  expect(response.headers.has("x-entity-etag")).toBe(false);
}

// Resolve only self-contained local references. Feed the SERVED declaration to
// an independent JSON Schema consumer; never inject a desired contract into it.
function resolve(value: unknown, seen: string[] = []): unknown {
  if (Array.isArray(value)) return value.map(item => resolve(item, seen));
  if (value === null || typeof value !== "object") return value;
  const node = value as Schema;
  if (node.$ref) {
    expect(node.$ref.startsWith("#/"), "no external schema/example reads").toBe(true);
    expect(seen, "cyclic schema reference").not.toContain(node.$ref);
    const target = node.$ref.slice(2).split("/").reduce<unknown>((part, key) =>
      (part as Record<string, unknown>)?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], document);
    expect(target, `unresolved ${node.$ref}`).toBeDefined();
    const { $ref: _ref, ...siblings } = node;
    return resolve({ ...(target as Schema), ...siblings }, [...seen, node.$ref]);
  }
  const result = Object.fromEntries(Object.entries(node).map(([key, item]) => [key, resolve(item, seen)]));
  if (node.nullable === true) {
    delete result.nullable;
    return { anyOf: [result, { type: "null" }] };
  }
  return result;
}
function validator(schema: Schema) {
  return z.fromJSONSchema(resolve(schema) as Parameters<typeof z.fromJSONSchema>[0]);
}
function media(kind: Kind): Media {
  return document.paths[`/api/v1/data/${kind}`].get.responses["200"].content!["application/json"];
}
function shape(schema: Schema): Schema {
  const node = resolve(schema) as Schema;
  if (!node.allOf) return node;
  const parts = node.allOf.map(shape);
  return { ...node, properties: Object.assign({}, ...parts.map(part => part.properties), node.properties) };
}
function branches(kind: Kind) {
  const node = resolve(media(kind).schema) as Schema;
  const options = node.anyOf ?? node.oneOf;
  expect(options, `${kind}: explicit single-or-batch 200 composition is absent (${JSON.stringify(media(kind).schema)})`).toBeDefined();
  expect(options).toHaveLength(2);
  const batch = options!.filter(part => shape(part).properties?.entries !== undefined);
  const single = options!.filter(part => shape(part).properties?.[kind] !== undefined);
  expect(batch, `${kind}: one batch branch`).toHaveLength(1);
  expect(single, `${kind}: one single branch`).toHaveLength(1);
  return { batch: batch[0], single: single[0] };
}
function refs(schema: unknown, seen = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) { for (const part of schema) refs(part, seen); }
  else if (schema !== null && typeof schema === "object") {
    const node = schema as Schema;
    if (node.$ref && !seen.has(node.$ref)) {
      seen.add(node.$ref);
      const name = node.$ref.replace("#/components/schemas/", "");
      refs(document.components.schemas[name], seen);
    }
    for (const [key, part] of Object.entries(node)) if (key !== "$ref") refs(part, seen);
  }
  return seen;
}
function publishedExamples(kind: Kind): unknown[] {
  const entry = media(kind);
  return [entry.example, ...Object.values(entry.examples ?? {}).map(example => (resolve(example) as Example).value)]
    .filter(value => value !== undefined);
}
let document: Document;
const network = vi.fn(() => { throw new Error("Outbound network forbidden in batch contract acceptance"); });
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
  for (const [kind, rows] of [
    ["customer", [otherCustomer, emptyCustomer, customer]],
    ["address", [emptyAddress, secondAddress, otherAddress, address]],
    ["container", [thirdContainer, secondContainer, otherContainer, container]]
  ] as Array<[Kind, Row[]]>) {
    for (const row of rows) {
      const keys = Object.keys(row);
      await db.prepare(`INSERT INTO ${kind}_snapshot (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
        .bind(...Object.values(row)).run();
    }
  }
  resetWork();
});
afterEach(() => { vi.unstubAllGlobals(); expect(network).not.toHaveBeenCalled(); });

// These controls intentionally do not depend on new declarations: they must be
// GREEN on the baseline, distinguishing meaningful contract RED from bad setup.
describe.each(specs)("$kind existing-behavior controls", spec => {
  it("preserves exact batch bytes, grouping, request order, duplicates and all-missing results", async () => {
    for (const ids of [[spec.id], [spec.other, spec.id], [spec.other, MISSING, spec.id, spec.other], [MISSING, MAX_ID]]) {
      const response = await get(spec, `ids=${ids.join(",")}`, { "if-none-match": "*" });
      batchHeaders(response);
      expect(await response.text()).toBe(JSON.stringify(expectedBatch(spec.kind, ids)));
    }
  });
  it("keeps full/projected singles and their bodyless conditional 304", async () => {
    for (const projected of [false, true]) {
      const query = `${spec.alias}=${spec.id}${projected ? `&fields=${spec.field}` : ""}`;
      const expected = projected ? { ...bundles[spec.kind][spec.id], [spec.kind]: spec.selected } : bundles[spec.kind][spec.id];
      const response = await get(spec, query);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toBe(JSON.stringify(expected));
      expect(validator(media(spec.kind).schema).safeParse(JSON.parse(text)).success).toBe(true);
      expect(response.headers.get("cache-control")).toBe("private, max-age=60");
      const etag = response.headers.get("etag");
      expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
      const conditional = await get(spec, query, { "if-none-match": etag! });
      expect(conditional.status).toBe(304);
      expect(await conditional.text()).toBe("");
      expect(conditional.headers.get("etag")).toBe(etag);
      const batch = await get(spec, `ids=${spec.id}`, { "if-none-match": etag! });
      batchHeaders(batch);
      expect(await batch.json()).toEqual(expectedBatch(spec.kind, [spec.id]));
    }
    const missing = await get(spec, `id=${MISSING}`);
    expect(missing.status).toBe(404);
  });
  it("rejects malformed/unknown/mixed-fieldset queries without work or input echo", async () => {
    const fieldsets = new Set(["fields", ...(document.paths[`/api/v1/data/${spec.kind}`].get.parameters ?? [])
      .filter(parameter => parameter.in === "query" && /fields/i.test(parameter.name)).map(parameter => parameter.name)]);
    const queries = [
      `ids=${spec.id},01`, `ids=${spec.id}&ids=${spec.other}`, `ids=${spec.id}&id=${spec.id}`,
      `ids=${spec.id}&${spec.alias}=${spec.id}`, `ids=${Array(51).fill(spec.id).join(",")}`,
      `ids=${spec.id}&unknown=SYNTHETIC-MARKER`,
      ...[...fieldsets].flatMap(field => [`ids=${spec.id}&${field}=SYNTHETIC-MARKER`, `ids=${spec.id}&${field}=`])
    ];
    for (const query of queries) {
      const response = await get(spec, query);
      expect(response.status, query).toBe(400);
      expect(response.headers.get("content-type")).toMatch(/^application\/problem\+json/);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const text = await response.text();
      expect(text).not.toContain("SYNTHETIC-MARKER");
      expect(text).not.toMatch(/received|invalid_type|invalid_format|"input"/);
      expect(JSON.parse(text)).toMatchObject({ status: 400, title: "Bad Request" });
      noWork();
    }
  });
  it("keeps sync-secret authorization ahead of valid/malformed selector reads", async () => {
    for (const authorization of ["", "Bearer synthetic-wrong", "Bearer synthetic-batch-api", "Bearer synthetic-batch-read"]) {
      for (const query of [`ids=${spec.id}`, "ids=01&unknown=SYNTHETIC-MARKER"]) {
        const response = await get(spec, query, { authorization });
        expect(response.status).toBe(401);
        expect(await response.text()).not.toContain("SYNTHETIC-MARKER");
        noWork();
      }
    }
  });
});

describe("served single-or-batch declarations", () => {
  it("makes this oracle discoverable through a named agent check", () => {
    const checks = Object.entries(packageJson.scripts).filter(([name, command]) =>
      name.startsWith("check:") && command.includes("test/typedHydratedBatchContracts.acceptance.test.ts"));
    expect(checks.length, "publish an npm check that runs the single-or-batch oracle").toBeGreaterThan(0);
  });
  it("exposes distinct named batch components and retains each existing single authority by reference", () => {
    const names = new Set<string>();
    for (const kind of kinds) {
      branches(kind);
      const schemaRefs = [...refs(media(kind).schema)];
      const batchRefs = schemaRefs.filter(ref => shape({ $ref: ref }).properties?.entries !== undefined);
      expect(batchRefs, `${kind}: discoverable named batch`).toHaveLength(1);
      names.add(batchRefs[0]);
      const resolvedSingles = schemaRefs.filter(ref => {
        const properties = shape({ $ref: ref }).properties;
        // The stored address TEXT column is not a hydrated resource object.
        return properties?.[kind] !== undefined && shape(properties[kind]).type === "object" && properties.found === undefined;
      });
      expect(resolvedSingles, `${kind}: retain stable existing single reference`).toEqual([singleRefs[kind]]);
      expect([...refs(document.components.schemas[batchRefs[0].split("/").pop()!])], `${kind}: batch must reuse single bundle authority`)
        .toContain(singleRefs[kind]);
    }
    expect(names.size).toBe(3);
    noWork();
  });
  it.each(specs)("$kind accepts actual full/projected single responses through the mounted union", async spec => {
    for (const query of [`id=${spec.id}`, `id=${spec.id}&fields=${spec.field}`]) {
      const response = await get(spec, query);
      expect(response.status).toBe(200);
      expect(validator(media(spec.kind).schema).safeParse(await response.json()).success).toBe(true);
    }
    branches(spec.kind);
    expect(document.paths[`/api/v1/data/${spec.kind}`].get.responses["304"].content).toBeUndefined();
  });
  for (const spec of specs) {
    for (const [label, ids] of [
      ["one found", [spec.id]], ["many found", [spec.other, spec.id]],
      ["mixed with duplicates", [MISSING, spec.other, spec.id, spec.other]],
      ["all missing", [MISSING, MAX_ID]], ["maximum length", Array(50).fill(spec.id) as number[]]
    ] as Array<[string, number[]]>) {
      it(`${spec.kind}: validates real D1 ${label} against both batch and mounted 200`, async () => {
        const response = await get(spec, `ids=${ids.join(",")}`);
        batchHeaders(response);
        const body = await response.json();
        expect(body).toEqual(expectedBatch(spec.kind, ids));
        expect(validator(media(spec.kind).schema).safeParse(body).success, `${spec.kind}: mounted response rejected`).toBe(true);
        const { batch } = branches(spec.kind);
        expect(validator(batch).safeParse(body).success, `${spec.kind}: batch response rejected`).toBe(true);
      });
    }
  }
  it.each(specs)("$kind mounts conforming mixed/all-missing batch examples beside full/projected singles", spec => {
    const values = publishedExamples(spec.kind) as Bundle[];
    const batches = values.filter(value => value && typeof value === "object" && Array.isArray(value.entries));
    expect(batches.some(value => {
      const entries = value.entries as Array<{ found?: unknown }>;
      return entries.some(entry => entry.found === true) && entries.some(entry => entry.found === false);
    }), `${spec.kind}: missing mounted mixed example`).toBe(true);
    expect(batches.some(value => {
      const entries = value.entries as Array<{ found?: unknown }>;
      return entries.length > 0 && entries.every(entry => entry.found === false);
    }), `${spec.kind}: missing mounted all-missing example`).toBe(true);
    const singles = values.filter(value => value && typeof value === "object" && spec.kind in value);
    const fullSize = Object.keys(bundles[spec.kind][spec.id][spec.kind] as Row).length;
    expect(singles.some(value => Object.keys(value[spec.kind] as Row).length === fullSize), "retain full example").toBe(true);
    expect(singles.some(value => {
      const keys = Object.keys(value[spec.kind] as Row);
      return keys.includes(spec.key) && keys.length < fullSize;
    }), "retain projected example").toBe(true);
    for (const value of values) expect(validator(media(spec.kind).schema).safeParse(value).success, JSON.stringify(value)).toBe(true);
  });
});

// Both schema branches must reject mutations; accepting them via an any/single
// escape hatch is as broken as accepting them through the batch component.
describe.each(specs)("$kind rejects malformed response mutations", spec => {
  const found = () => ({ id: spec.id, found: true, [spec.kind]: bundles[spec.kind][spec.id] });
  const wrong = specs.find(candidate => candidate.kind !== spec.kind)!;
  const cases: Array<[string, () => unknown]> = [
    ["absent entries", () => ({})], ["null entries", () => ({ entries: null })],
    ["non-array entries", () => ({ entries: {} })], ["empty entries", () => ({ entries: [] })],
    ["51 entries", () => ({ entries: Array(51).fill(found()) })],
    ["null entry", () => ({ entries: [null] })],
    ["found without payload", () => ({ entries: [{ id: spec.id, found: true }] })],
    ["found null payload", () => ({ entries: [{ id: spec.id, found: true, [spec.kind]: null }] })],
    ["found untyped payload", () => ({ entries: [{ id: spec.id, found: true, [spec.kind]: {} }] })],
    ["wrong resource key", () => ({ entries: [{ id: spec.id, found: true, [wrong.kind]: bundles[wrong.kind][wrong.id] }] })],
    ["wrong resource bundle", () => ({ entries: [{ id: spec.id, found: true, [spec.kind]: bundles[wrong.kind][wrong.id] }] })],
    ["missing discriminator", () => ({ entries: [{ id: spec.id, [spec.kind]: bundles[spec.kind][spec.id] }] })],
    ["string discriminator", () => ({ entries: [{ ...found(), found: "true" }] })],
    ["missing entry id", () => ({ entries: [{ found: true, [spec.kind]: bundles[spec.kind][spec.id] }] })],
    ["missing id on not-found", () => ({ entries: [{ found: false }] })],
    ["not-found carries payload", () => ({ entries: [{ id: spec.id, found: false, [spec.kind]: bundles[spec.kind][spec.id] }] })],
    ["not-found carries another resource", () => ({ entries: [{ id: MISSING, found: false, [wrong.kind]: {} }] })],
    ["not-found carries null payload", () => ({ entries: [{ id: MISSING, found: false, [spec.kind]: null }] })],
    ["root identity missing", () => {
      const bundle = structuredClone(bundles[spec.kind][spec.id]);
      delete (bundle[spec.kind] as Row)[spec.key];
      return { entries: [{ ...found(), [spec.kind]: bundle }] };
    }],
    ["root identity coerced to text", () => {
      const bundle = structuredClone(bundles[spec.kind][spec.id]);
      (bundle[spec.kind] as Row)[spec.key] = String(spec.id);
      return { entries: [{ ...found(), [spec.kind]: bundle }] };
    }],
    ["D1 numeric flag coerced to boolean", () => {
      const bundle = structuredClone(bundles[spec.kind][spec.id]);
      (bundle[spec.kind] as Record<string, unknown>).enabled = false;
      return { entries: [{ ...found(), [spec.kind]: bundle }] };
    }],
    ["D1 text coerced to number", () => {
      const bundle = structuredClone(bundles[spec.kind][spec.id]);
      (bundle[spec.kind] as Row)[spec.field] = 42;
      return { entries: [{ ...found(), [spec.kind]: bundle }] };
    }]
  ];
  for (const key of Object.keys(bundles[spec.kind][spec.id])) {
    cases.push([`bundle member ${key} absent`, () => {
      const bundle = structuredClone(bundles[spec.kind][spec.id]);
      delete bundle[key];
      return { entries: [{ ...found(), [spec.kind]: bundle }] };
    }]);
  }
  const nested: Array<{ path: Array<string | number>; key: string }> = spec.kind === "customer"
    ? [{ path: ["addresses", 0], key: "pickup_address_id" }, { path: ["addresses", 0, "containers", 0], key: "container_id" }]
    : spec.kind === "address"
      ? [{ path: ["customer"], key: "customer_id" }, { path: ["containers", 0], key: "container_id" }]
      : [{ path: ["address"], key: "pickup_address_id" }, { path: ["customer"], key: "customer_id" }];
  for (const { path, key } of nested) {
    for (const mutation of ["missing identity", "string identity", "boolean flag"]) {
      cases.push([`${path.join(".")}: ${mutation}`, () => {
        const bundle = structuredClone(bundles[spec.kind][spec.id]);
        const row = path.reduce<unknown>((part, segment) => (part as Record<string, unknown>)[String(segment)], bundle) as Record<string, unknown>;
        if (mutation === "missing identity") delete row[key];
        else if (mutation === "string identity") row[key] = String(row[key]);
        else row.enabled = false;
        return { entries: [{ ...found(), [spec.kind]: bundle }] };
      }]);
    }
  }
  for (const badId of ["98111", 0, -1, 1.5, MAX_ID + 1, null]) {
    cases.push([`noncanonical found id ${String(badId)}`, () => ({ entries: [{ ...found(), id: badId }] })]);
    cases.push([`noncanonical missing id ${String(badId)}`, () => ({ entries: [{ id: badId, found: false }] })]);
  }
  it.each(cases)("%s", (_label, mutate) => {
    const body = mutate();
    expect(validator(media(spec.kind).schema).safeParse(body).success, "single branch must not mask invalid batch").toBe(false);
    const { batch } = branches(spec.kind);
    expect(validator(batch).safeParse(body).success, JSON.stringify(body)).toBe(false);
  });
});

describe("actual empty and racing-parent relationship responses", () => {
  const cases: Array<{ kind: Kind; id: number; hidden?: HiddenParent; bundle: Bundle }> = [
    { kind: "customer", id: 98113, bundle: { customer: emptyCustomer, addresses: [] } },
    { kind: "address", id: 98214, bundle: { address: emptyAddress, customer: otherCustomer, containers: [] } },
    { kind: "address", id: 98214, hidden: "customer", bundle: { address: emptyAddress, customer: null, containers: [] } },
    { kind: "container", id: 98311, hidden: "address", bundle: { container, address: null, customer: null } },
    { kind: "container", id: 98311, hidden: "customer", bundle: { container, address, customer: null } }
  ];
  it.each(cases)("$kind id=$id hidden=$hidden preserves runtime null/empty shape", async ({ kind, id, hidden, bundle }) => {
    const spec = specs.find(candidate => candidate.kind === kind)!;
    const response = await get(spec, `ids=${id},${MISSING}`, {}, hidden);
    batchHeaders(response);
    expect(await response.json()).toEqual({ entries: [{ id, found: true, [kind]: bundle }, { id: MISSING, found: false }] });
  });
  it.each(cases)("$kind id=$id hidden=$hidden validates runtime null/empty shape", async ({ kind, id, hidden }) => {
    const spec = specs.find(candidate => candidate.kind === kind)!;
    const response = await get(spec, `ids=${id},${MISSING}`, {}, hidden);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(validator(media(kind).schema).safeParse(body).success, `${kind}: mounted null/empty response rejected`).toBe(true);
    expect(validator(branches(kind).batch).safeParse(body).success).toBe(true);
  });
});
