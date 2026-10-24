/// <reference types="vite/client" />
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import {
  SNAPSHOT_FIELDSETS,
  parseSnapshotFields,
  snapshotFieldsQuery,
  type SnapshotFieldsetResource
} from "../src/lib/sparseFieldsets";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Acceptance-first oracle: discover selectors from the MOUNTED /openapi.json,
 * then use them on synthetic, authenticated reads without inspecting records
 * or making invalid trial requests to discover column names.
 *
 * x-snapshot-fieldset v1 may live on the fields parameter or its string schema:
 *   schemaVersion: 1; resource: customer | address | container;
 *   selectableFields: every canonical column, INCLUDING the selectable id;
 *   alwaysIncludedFields: [primary id]; delimiter: ","; rules: RULES below.
 * If present at both locations the payloads must agree. This is a vendor
 * extension, NOT an enum of whole selectors or a new OpenAPI schema keyword.
 *
 * Missing/misplaced/stale metadata, a docs-only duplicate dictionary, advertising
 * unsupported routes, selector/parser disagreement, data-dependent discovery,
 * projection/auth regressions and upstream work must each fail this oracle.
 * Registry replacement below is process-local and restored in finally; it
 * exercises a fresh shared declaration, not a change to source or the database.
 *
 * Test Author owns this file and the narrow metadata projection in
 * openapiContract.test.ts. Builder owns implementation, discovery docs (including
 * the <=25-line synthetic extraction/selection example), focused command and
 * changelog. No static docs/openapi.json publication. Expected RED before build.
 * Run: npx vitest run test/sparseFieldsetDiscovery.acceptance.test.ts
 */

const EXTENSION = "x-snapshot-fieldset";
const RULES = {
  caseSensitive: true,
  whitespace: "reject",
  emptySegments: "reject",
  duplicates: "reject",
  unknownNames: "reject",
  repeatedKeys: "reject"
} as const;
const TEST_ENV = env as unknown as Env;
const READ_TOKEN = "test-read-token";
const API_TOKEN = "test-api-token";
const ORIGIN = "https://fieldset-discovery.invalid";
const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"];

type JsonObject = Record<string, unknown>;
type Parameter = JsonObject & { name?: string; in?: string; schema?: JsonObject };
type Operation = JsonObject & { parameters?: Parameter[] };
type Document = {
  security?: unknown;
  paths: Record<string, Record<string, Operation>>;
};
type Fieldset = {
  schemaVersion: number;
  resource: SnapshotFieldsetResource;
  selectableFields: string[];
  alwaysIncludedFields: string[];
  delimiter: string;
  rules: typeof RULES;
};
type Spec = {
  resource: SnapshotFieldsetResource;
  listPath: string;
  detailPath: string;
  id: number;
  idColumn: string;
  sampleField: string;
  operationIds: [string, string];
  hydratedPath: string;
  hydratedOperationId: string;
};
const SPECS: Spec[] = [
  {
    resource: "customer", listPath: "/api/v1/customer-snapshot",
    detailPath: "/api/v1/customer-snapshot/{customerId}", id: 98101,
    idColumn: "customer_id", sampleField: "company_name",
    operationIds: ["listCustomerSnapshot", "getCustomerSnapshot"],
    hydratedPath: "/api/v1/data/customer", hydratedOperationId: "getDataCustomer"
  },
  {
    resource: "address", listPath: "/api/v1/address-snapshot",
    detailPath: "/api/v1/address-snapshot/{pickupAddressId}", id: 98201,
    idColumn: "pickup_address_id", sampleField: "city",
    operationIds: ["listAddressSnapshot", "getAddressSnapshot"],
    hydratedPath: "/api/v1/data/address", hydratedOperationId: "getDataAddress"
  },
  {
    resource: "container", listPath: "/api/v1/container-snapshot",
    detailPath: "/api/v1/container-snapshot/{containerId}", id: 98301,
    idColumn: "container_id", sampleField: "serial_number",
    operationIds: ["listContainerSnapshot", "getContainerSnapshot"],
    hydratedPath: "/api/v1/data/container", hydratedOperationId: "getDataContainer"
  }
];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("Unexpected outbound fetch in fieldset discovery acceptance");
  }));
});

afterEach(() => {
  try {
    // Caught upstream errors must not silently turn a network attempt into a pass.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

async function document(bindings: Env = TEST_ENV): Promise<Document> {
  const res = await app.fetch(new Request("http://test.local/openapi.json"), bindings);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  return await res.json() as Document;
}

function fieldsParameter(doc: Document, path: string): Parameter {
  const params = (doc.paths[path]?.get?.parameters ?? []).filter(
    (p) => p.name === "fields" && p.in === "query"
  );
  expect(params, `${path}: one actual fields query parameter`).toHaveLength(1);
  return params[0];
}

function fieldset(param: Parameter, label: string): Fieldset {
  const onParameter = param[EXTENSION];
  const onSchema = param.schema?.[EXTENSION];
  expect(onParameter ?? onSchema, `${label}: missing ${EXTENSION}`).toBeDefined();
  if (onParameter !== undefined && onSchema !== undefined) {
    expect(onParameter, `${label}: conflicting extension locations`).toEqual(onSchema);
  }
  return (onParameter ?? onSchema) as Fieldset;
}

function assertCatalog(meta: Fieldset, resource: SnapshotFieldsetResource): void {
  const canonical = SNAPSHOT_FIELDSETS[resource];
  expect(meta).toEqual({
    schemaVersion: 1,
    resource,
    selectableFields: [...canonical.columns],
    alwaysIncludedFields: [canonical.idColumn],
    delimiter: ",",
    rules: RULES
  });
  expect(new Set(meta.selectableFields).size).toBe(meta.selectableFields.length);
  expect(meta.selectableFields).toContain(canonical.idColumn);
}

function occurrences(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  return Object.entries(value).reduce(
    (sum, [key, child]) => sum + (key === EXTENSION ? 1 : 0) + occurrences(child), 0
  );
}

function freshDeclaration(resource: SnapshotFieldsetResource): Document {
  const probe = new OpenAPIHono();
  probe.openapi(createRoute({
    method: "get", path: "/synthetic-flat-read",
    request: { query: z.object({ fields: snapshotFieldsQuery(resource) }) },
    responses: { 200: { description: "Synthetic declaration only; never invoked" } }
  }), (c) => c.body(null, 200));
  return probe.getOpenAPI31Document({
    openapi: "3.1.0", info: { title: "Synthetic fieldset declaration", version: "1" }
  }) as unknown as Document;
}

describe("mounted sparse-fieldset discovery contract", () => {
  it.each(SPECS)("$resource: publishes matching versioned metadata on list and by-id fields", async (spec) => {
    const doc = await document();
    for (const [index, path] of [spec.listPath, spec.detailPath].entries()) {
      const param = fieldsParameter(doc, path);
      const meta = fieldset(param, path);
      assertCatalog(meta, spec.resource);
      expect(param.required).toBe(false);
      expect(param.schema?.type).toBe("string");
      // Single names are not an enum of every legal comma-separated selector.
      expect(param.schema).not.toHaveProperty("enum");
      expect(param).not.toHaveProperty("enum");
      expect(doc.paths[path].get).toMatchObject({
        operationId: spec.operationIds[index], "x-access": "read", "x-effect": "local-read"
      });
      expect(doc.paths[path].get.security).toBeUndefined();
    }
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });

  it.each(SPECS)("$resource: hydrated single-ID discovery matches its catalog and sync-secret access", async (spec) => {
    const doc = await document();
    const param = fieldsParameter(doc, spec.hydratedPath);
    const meta = fieldset(param, spec.hydratedPath);
    assertCatalog(meta, spec.resource);
    expect(meta).toEqual(fieldset(fieldsParameter(doc, spec.listPath), spec.listPath));
    expect(param.required).toBe(false);
    expect(param.schema?.type).toBe("string");
    expect(param.schema).not.toHaveProperty("enum");
    expect(param).not.toHaveProperty("enum");
    expect(doc.paths[spec.hydratedPath].get).toMatchObject({
      operationId: spec.hydratedOperationId, "x-access": "sync-secret", "x-effect": "local-read"
    });
    expect(doc.paths[spec.hydratedPath].get.security).toBeUndefined();
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });

  it("customer changes: publishes the canonical customer catalog, identity and strict rules without changing read authority", async () => {
    const doc = await document();
    const path = "/api/v1/customer-snapshot/changes";
    const param = fieldsParameter(doc, path);
    const meta = fieldset(param, path);
    assertCatalog(meta, "customer");
    expect(meta).toEqual(fieldset(fieldsParameter(doc, "/api/v1/customer-snapshot"), "customer list"));
    expect(meta.alwaysIncludedFields).toEqual(["customer_id"]);
    expect(param.required).toBe(false);
    expect(param.schema?.type).toBe("string");
    expect(param.schema).not.toHaveProperty("enum");
    expect(param).not.toHaveProperty("enum");
    expect(doc.paths[path].get).toMatchObject({
      operationId: "listCustomerSnapshotChanges", "x-access": "read", "x-effect": "local-read"
    });
    expect(doc.paths[path].get.security).toBeUndefined();
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
  });

  it("advertises fields on exactly ten supported flat, single-ID hydrated and customer changes reads, never on exports, other feeds, POSTs or batches", async () => {
    const doc = await document();
    const supported = [
      ...SPECS.flatMap((s) => [s.listPath, s.detailPath, s.hydratedPath]),
      "/api/v1/customer-snapshot/changes"
    ].map((p) => `get ${p}`).sort();
    expect(supported).toHaveLength(10);
    const advertised: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        if (!HTTP_METHODS.includes(method)) continue;
        const key = `${method} ${path}`;
        const params = (op.parameters ?? []).filter((p) => p.name === "fields" && p.in === "query");
        if (params.length) advertised.push(key);
        if (!supported.includes(key)) {
          expect(params, key).toEqual([]);
          expect(occurrences(op), `${key}: false projection capability`).toBe(0);
        }
      }
    }
    expect(advertised.sort()).toEqual(supported);
  });

  it.each(SPECS)("$resource: a new shared fields declaration inherits the same catalog", async (spec) => {
    const mounted = fieldset(fieldsParameter(await document(), spec.listPath), spec.listPath);
    const fresh = fieldset(fieldsParameter(freshDeclaration(spec.resource), "/synthetic-flat-read"), "shared declaration");
    assertCatalog(fresh, spec.resource);
    expect(fresh).toEqual(mounted);
  });

  it.each(SPECS)("$resource: registry replacement changes both the shared catalog and parser, with no docs-only dictionary", (spec) => {
    const original = SNAPSHOT_FIELDSETS[spec.resource];
    try {
      SNAPSHOT_FIELDSETS[spec.resource] = {
        idColumn: "synthetic_primary_id", columns: ["synthetic_primary_id", "synthetic_new_field"]
      };
      const fresh = fieldset(fieldsParameter(freshDeclaration(spec.resource), "/synthetic-flat-read"), "changed registry");
      expect(fresh.selectableFields).toEqual(["synthetic_primary_id", "synthetic_new_field"]);
      expect(fresh.alwaysIncludedFields).toEqual(["synthetic_primary_id"]);
      expect(parseSnapshotFields(spec.resource, "synthetic_new_field")).toEqual(["synthetic_new_field"]);
      expect(parseSnapshotFields(spec.resource, spec.sampleField)).toBeNull();
      assertCatalog(fresh, spec.resource);
    } finally {
      SNAPSHOT_FIELDSETS[spec.resource] = original;
    }
  });

  it("serves deterministic discovery anonymously with no data bindings or credential access", async () => {
    const baseline = await document();
    const unavailable = new Proxy({ OPENAPI_DOCS_ENABLED: "true" }, {
      get(target, key, receiver) {
        if (key === "OPENAPI_DOCS_ENABLED") return Reflect.get(target, key, receiver);
        throw new Error(`Discovery must not access binding ${String(key)}`);
      }
    }) as unknown as Env;
    const first = await document(unavailable);
    const second = await document(unavailable);
    expect(first).toEqual(baseline);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    for (const spec of SPECS) {
      const meta = fieldset(fieldsParameter(first, spec.listPath), spec.listPath);
      assertCatalog(meta, spec.resource);
      const text = JSON.stringify(meta);
      for (const value of [READ_TOKEN, API_TOKEN, "test-sync-secret", "SYNTHETIC-RECORD-MARKER"]) {
        expect(text).not.toContain(value);
      }
    }
  });
});

async function seedSyntheticRows(): Promise<void> {
  await ensureD1TestTables();
  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot"),
    db.prepare("INSERT INTO customer_snapshot (customer_id, company_name, enabled, synced_at) VALUES (98101, 'SYNTHETIC-RECORD-MARKER-customer', 1, '2026-01-01T00:00:00.000Z')"),
    db.prepare("INSERT INTO address_snapshot (pickup_address_id, customer_id, city, enabled, synced_at) VALUES (98201, 98101, 'SYNTHETIC-RECORD-MARKER-address', 1, '2026-01-01T00:00:00.000Z')"),
    db.prepare("INSERT INTO container_snapshot (container_id, pickup_address_id, serial_number, enabled, synced_at) VALUES (98301, 98201, 'SYNTHETIC-RECORD-MARKER-container', 1, '2026-01-01T00:00:00.000Z')")
  ]);
}

async function read(path: string, token: string | null = READ_TOKEN, bindings = TEST_ENV): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return app.fetch(new Request(`http://test.local${path}`, { headers }), bindings);
}

function concrete(spec: Spec, kind: "list" | "detail"): string {
  return kind === "list" ? spec.listPath : spec.detailPath.replace(/\{[^}]+\}/, String(spec.id));
}

async function rows(res: Response, kind: "list" | "detail"): Promise<JsonObject[]> {
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  const body = await res.json() as JsonObject;
  if (kind === "detail") return [body];
  expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
  expect(body.total).toBe(1);
  expect(body.nextCursor).toBeNull();
  expect(body.rows).toHaveLength(1);
  return body.rows as JsonObject[];
}

function noDataBindings(): { bindings: Env; prepare: ReturnType<typeof vi.fn> } {
  const prepare = vi.fn(() => { throw new Error("Refusal must precede D1"); });
  return { bindings: { ...TEST_ENV, CUSTOMER_DB: { prepare } as unknown as D1Database }, prepare };
}

describe("discovered selectors work against synthetic authenticated snapshot reads", () => {
  beforeEach(seedSyntheticRows);

  describe.each(SPECS)("$resource", (spec) => {
    it.each(["list", "detail"] as const)("%s: every advertised name is usable, with exact projection and mandatory identity", async (kind) => {
      const path = concrete(spec, kind);
      const meta = fieldset(fieldsParameter(await document(), kind === "list" ? spec.listPath : spec.detailPath), path);
      assertCatalog(meta, spec.resource);
      const [full] = await rows(await read(path), kind);
      for (const field of meta.selectableFields) {
        const [projected] = await rows(await read(`${path}?fields=${encodeURIComponent(field)}`), kind);
        expect(Object.keys(projected).sort(), `${path}: ${field}`).toEqual([...new Set([...meta.alwaysIncludedFields, field])].sort());
        expect(projected[spec.idColumn]).toBe(spec.id);
        expect(projected[field]).toEqual(full[field]);
        expect(parseSnapshotFields(spec.resource, field)).toEqual([field]);
      }
      const [all] = await rows(await read(`${path}?fields=${encodeURIComponent(meta.selectableFields.join(meta.delimiter))}`), kind);
      expect(all).toEqual(full);
      const withoutId = meta.selectableFields.filter((field) => !meta.alwaysIncludedFields.includes(field));
      const [implicitId] = await rows(await read(`${path}?fields=${encodeURIComponent(withoutId.join(meta.delimiter))}`), kind);
      expect(implicitId).toEqual(full);
    });

    it.each(["list", "detail"] as const)("%s: advertised rules match strict refusals before D1, including cross-resource names", async (kind) => {
      const doc = await document();
      const path = concrete(spec, kind);
      const meta = fieldset(fieldsParameter(doc, kind === "list" ? spec.listPath : spec.detailPath), path);
      expect(meta.rules).toEqual(RULES);
      const field = spec.sampleField;
      const foreign = SPECS.filter((s) => s.resource !== spec.resource).flatMap((s) =>
        fieldset(fieldsParameter(doc, s.listPath), s.listPath).selectableFields
      ).filter((name) => !meta.selectableFields.includes(name));
      expect(foreign.length).toBeGreaterThan(0);
      const invalid = [...new Set([
        "", ",", `,${field}`, `${field},`, `${field},,${spec.idColumn}`,
        `${field},${field}`, `${spec.idColumn},${spec.idColumn}`,
        ` ${field}`, `${field} `, `${field}, ${spec.idColumn}`, field.toUpperCase(),
        "rowid", "erased_at", "unknown-SYNTHETIC-RECORD-MARKER", ...foreign
      ])];
      const { bindings, prepare } = noDataBindings();
      for (const selector of invalid) {
        expect(parseSnapshotFields(spec.resource, selector), selector).toBeNull();
        const res = await read(`${path}?fields=${encodeURIComponent(selector)}`, READ_TOKEN, bindings);
        expect(res.status, selector).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/problem+json");
        const body = await res.json() as JsonObject;
        expect(body).toMatchObject({ status: 400, title: "Bad Request", detail: "Invalid request query (fields). See docs/PROBLEMS.md#bad-request." });
        expect(JSON.stringify(body)).not.toContain("SYNTHETIC-RECORD-MARKER");
      }
      const repeated = await read(`${path}?fields=${field}&fields=${spec.idColumn}`, READ_TOKEN, bindings);
      expect(repeated.status).toBe(400);
      await repeated.arrayBuffer();
      expect(prepare).not.toHaveBeenCalled();
    });

    it.each(["list", "detail"] as const)("%s: omission remains full-row and auth still precedes selector validation", async (kind) => {
      const path = concrete(spec, kind);
      const [full] = await rows(await read(path), kind);
      expect(Object.keys(full).sort()).toEqual([...SNAPSHOT_FIELDSETS[spec.resource].columns].sort());
      expect(full[spec.idColumn]).toBe(spec.id);
      expect(full[spec.sampleField]).toBe(`SYNTHETIC-RECORD-MARKER-${spec.resource}`);
      const [selected] = await rows(await read(`${path}?fields=${spec.sampleField}`, API_TOKEN), kind);
      expect(selected).toEqual({ [spec.idColumn]: spec.id, [spec.sampleField]: full[spec.sampleField] });
      const { bindings, prepare } = noDataBindings();
      for (const selector of [spec.sampleField, "unknown-SYNTHETIC-RECORD-MARKER"]) {
        const res = await read(`${path}?fields=${selector}`, null, bindings);
        expect(res.status).toBe(401);
        await res.arrayBuffer();
      }
      expect(prepare).not.toHaveBeenCalled();
    });

    it("keeps discovery identical after synthetic values change, and count-free projection stays row-scoped", async () => {
      const before = await document();
      const db = TEST_ENV.CUSTOMER_DB;
      await db.prepare(`UPDATE ${spec.resource}_snapshot SET ${spec.sampleField} = ?`).bind("SYNTHETIC-RECORD-MARKER-changed").run();
      const after = await document();
      expect(after).toEqual(before);
      const res = await read(`${spec.listPath}?fields=${spec.sampleField}&includeTotal=false`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        rows: [{ [spec.idColumn]: spec.id, [spec.sampleField]: "SYNTHETIC-RECORD-MARKER-changed" }],
        total: null, nextCursor: null
      });
      const meta = fieldset(fieldsParameter(after, spec.listPath), spec.listPath);
      expect(JSON.stringify(meta)).not.toContain("SYNTHETIC-RECORD-MARKER");
    });
  });
});

// Same complete row shapes as hydratedFields.acceptance.test.ts, with disjoint
// synthetic IDs. Expected bundles never use the production projector or catalog.
const HYDRATED_ROWS: Record<SnapshotFieldsetResource, Record<string, string | number | null>> = {
  customer: {
    customer_id: 98101, customer_type_id: 2, company_name: "Synthetic discovery company",
    first_name: "Synthetic", middle_initial: null, last_name: "Fixture",
    name_suffix: "", customer_number: "SYN-001", sub_customer_number: "SUB-1",
    phone1: "555-0100", phone2: null, comments: "Synthetic discovery note",
    enabled: 1, synced_at: "2026-10-01T00:00:00.000Z"
  },
  address: {
    pickup_address_id: 98201, customer_id: 98101, route_id: 7,
    address: "1 Synthetic Way", city: "Syntheticville", state: "ZZ", zip: "00000",
    franchise_id: "3", comments: null, extras_allowed: 0, enabled: 1,
    driver_note: null, latitude: "0", longitude: "-10.5",
    last_audit_date: "2026-09-01", synced_at: "2026-10-02T00:00:00.000Z"
  },
  container: {
    container_id: 98301, pickup_address_id: 98201, container_type_id: 4,
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

async function seedHydratedRows(): Promise<void> {
  await seedSyntheticRows();
  // Enrich the existing three related fixtures with independently known values,
  // including null, zero and empty string, without changing flat-read fixtures.
  for (const spec of SPECS) {
    const row = HYDRATED_ROWS[spec.resource];
    const columns = Object.keys(row);
    await TEST_ENV.CUSTOMER_DB.prepare(
      `UPDATE ${spec.resource}_snapshot SET ${columns.map((column) => `${column} = ?`).join(",")} WHERE ${spec.idColumn} = ?`
    ).bind(...columns.map((column) => row[column]), spec.id).run();
  }
}

function hydratedBundle(resource: SnapshotFieldsetResource): JsonObject {
  const { customer, address, container } = HYDRATED_ROWS;
  if (resource === "customer") return { customer, addresses: [{ ...address, containers: [container] }] };
  if (resource === "address") return { address, customer, containers: [container] };
  return { container, address, customer };
}

async function hydratedBody(path: string): Promise<JsonObject> {
  const res = await read(path, "test-sync-secret");
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, max-age=60");
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  return await res.json() as JsonObject;
}

// Auth/ETag/canonical-cache permutations remain owned by the unchanged hydrated
// acceptance suite. This integration specifically connects discovery to usage.
describe("discovered selectors project only the matching hydrated root", () => {
  beforeEach(seedHydratedRows);

  it.each(SPECS)("$resource: every discovered field retains identity and the complete related bundle; omission stays full", async (spec) => {
    const meta = fieldset(fieldsParameter(await document(), spec.hydratedPath), spec.hydratedPath);
    assertCatalog(meta, spec.resource);
    const path = `${spec.hydratedPath}?id=${spec.id}`;
    const full = hydratedBundle(spec.resource);
    const root = HYDRATED_ROWS[spec.resource];
    expect(await hydratedBody(path)).toEqual(full);
    for (const field of meta.selectableFields) {
      const projectedRoot = { [spec.idColumn]: spec.id, [field]: root[field] };
      const projected = await hydratedBody(`${path}&fields=${encodeURIComponent(field)}`);
      // Exact bundle equality also pins non-root objects, nested arrays and values.
      expect(projected, `${spec.hydratedPath}: ${field}`).toEqual({ ...full, [spec.resource]: projectedRoot });
      expect((projected[spec.resource] as JsonObject)[spec.idColumn]).toBe(spec.id);
    }
    const all = meta.selectableFields.join(meta.delimiter);
    expect(await hydratedBody(`${path}&fields=${encodeURIComponent(all)}`)).toEqual(full);
    // Selected requests must not contaminate a later omitted-fields response.
    expect(await hydratedBody(path)).toEqual(full);
  });
});
