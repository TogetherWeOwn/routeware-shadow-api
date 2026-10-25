/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { SNAPSHOT_FIELDSETS, type SnapshotFieldsetResource } from "../src/lib/sparseFieldsets";
import { problemType } from "../src/lib/problem";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Acceptance contract for R25-04: publish typed flat snapshot row contracts.
 *
 * SCOPE: the six EXISTING flat snapshot reads only —
 *   lists:   GET /api/v1/customer-snapshot, /address-snapshot, /container-snapshot
 *   by-ID:   GET /api/v1/customer-snapshot/{customerId},
 *            GET /api/v1/address-snapshot/{pickupAddressId},
 *            GET /api/v1/container-snapshot/{containerId}
 * Hydrated /data bundles, the changes feed, sync/save outcomes, exports and
 * error-policy work are explicitly out of scope and must not move.
 *
 * Each test is labeled RED (must fail before the paired build for the
 * documented missing declaration) or control (must already pass: behavior the
 * declaration-only build must preserve byte for byte). The file as a whole is
 * RED until the builder publishes the contracts.
 *
 * What the builder publishes (declaration-only, no runtime change):
 *  - one reusable flat row schema per resource plus one resource-specific list
 *    envelope per resource; every list rows.items and every by-ID 200 resolves
 *    through a $ref to its resource's row schema;
 *  - row property sets exactly equal to SNAPSHOT_FIELDSETS (the field/identity
 *    authority); only the primary identity is required (sparse output omits
 *    the rest); nullability is storage-faithful (migrations/d1/0001 + 0002);
 *  - stored flags stay integers (never JSON booleans); coordinate/date/list
 *    text stays unconstrained text (no numeric/format/array guessing); no
 *    invented positivity/enum/timestamp-format/safe-integer guarantees;
 *  - total:number|null and nextCursor keep their semantics and document them.
 *
 * Authority order inside this file: the MOUNTED /openapi.json (resolved $refs,
 * never source imports of the zod declarations) for what agents discover;
 * SNAPSHOT_FIELDSETS for field/identity sets; migrations for storage types;
 * synthetic real-local-D1 app.fetch rows for value behavior. Outbound fetch
 * throws (even a caught attempt fails the file); GETs must issue SELECTs only.
 *
 * Owned by the Test Author: the builder consumes this commit without editing
 * this file; oracle corrections come back through a new bounded child card.
 *
 * Run: npx vitest run test/typedFlatSnapshotRows.acceptance.test.ts
 */

const API_TOKEN = "test-api-token";
const READ_TOKEN = "test-read-token";
const SYNC_SECRET = "test-sync-secret";
const TEST_ENV = env as unknown as Env;
const ORIGIN = "https://typed-rows-client.invalid";
const FIELDS_400_DETAIL = "Invalid request query (fields). See docs/PROBLEMS.md#bad-request.";
const AUTH_401_DETAIL =
  "Send Authorization: Bearer <SHADOW_API_TOKEN>. See docs/PROBLEMS.md#unauthorized.";

type Resource = SnapshotFieldsetResource;
type SeedRow = Record<string, string | number | null>;

/** Storage-faithful column contract, from migrations/d1/0001 + 0002. */
type ColumnType = { base: "integer" | "string"; nullable: boolean };

const EXPECTED_COLUMNS: Record<Resource, string[]> = {
  customer: [
    "customer_id", "customer_type_id", "company_name", "first_name", "middle_initial",
    "last_name", "name_suffix", "customer_number", "sub_customer_number",
    "phone1", "phone2", "comments", "enabled", "synced_at"
  ],
  address: [
    "pickup_address_id", "customer_id", "route_id", "address", "city", "state", "zip",
    "franchise_id", "comments", "extras_allowed", "enabled", "driver_note",
    "latitude", "longitude", "last_audit_date", "synced_at"
  ],
  container: [
    "container_id", "pickup_address_id", "container_type_id", "serial_number", "rfid",
    "oncall", "event_code", "gps_locked", "latitude", "longitude", "enabled",
    "location_address", "city", "state", "zip", "container_note",
    "ud_cost_share_ud", "ud_enclosure_doors_ud", "ud_last_compactor_inspection_ud",
    "ud_last_enclosure_inspection_ud", "ud_material_stream_ud", "color",
    "service_code_type", "service_code_input", "service_code", "service_date",
    "route_ids", "frequency_ids", "synced_at"
  ]
};

const COLUMN_TYPES: Record<Resource, Record<string, ColumnType>> = {
  customer: {
    customer_id: { base: "integer", nullable: false },
    customer_type_id: { base: "integer", nullable: true },
    company_name: { base: "string", nullable: true },
    first_name: { base: "string", nullable: true },
    middle_initial: { base: "string", nullable: true },
    last_name: { base: "string", nullable: true },
    name_suffix: { base: "string", nullable: true },
    customer_number: { base: "string", nullable: true },
    sub_customer_number: { base: "string", nullable: true },
    phone1: { base: "string", nullable: true },
    phone2: { base: "string", nullable: true },
    comments: { base: "string", nullable: true },
    enabled: { base: "integer", nullable: false },
    synced_at: { base: "string", nullable: false }
  },
  address: {
    pickup_address_id: { base: "integer", nullable: false },
    customer_id: { base: "integer", nullable: false },
    route_id: { base: "integer", nullable: true },
    address: { base: "string", nullable: true },
    city: { base: "string", nullable: true },
    state: { base: "string", nullable: true },
    zip: { base: "string", nullable: true },
    franchise_id: { base: "string", nullable: true },
    comments: { base: "string", nullable: true },
    extras_allowed: { base: "integer", nullable: false },
    enabled: { base: "integer", nullable: false },
    driver_note: { base: "string", nullable: true },
    latitude: { base: "string", nullable: true },
    longitude: { base: "string", nullable: true },
    last_audit_date: { base: "string", nullable: true },
    synced_at: { base: "string", nullable: false }
  },
  container: {
    container_id: { base: "integer", nullable: false },
    pickup_address_id: { base: "integer", nullable: false },
    container_type_id: { base: "integer", nullable: true },
    serial_number: { base: "string", nullable: true },
    rfid: { base: "string", nullable: true },
    oncall: { base: "integer", nullable: false },
    event_code: { base: "string", nullable: true },
    gps_locked: { base: "integer", nullable: false },
    latitude: { base: "string", nullable: true },
    longitude: { base: "string", nullable: true },
    enabled: { base: "integer", nullable: false },
    location_address: { base: "string", nullable: true },
    city: { base: "string", nullable: true },
    state: { base: "string", nullable: true },
    zip: { base: "string", nullable: true },
    container_note: { base: "string", nullable: true },
    ud_cost_share_ud: { base: "string", nullable: true },
    ud_enclosure_doors_ud: { base: "string", nullable: true },
    ud_last_compactor_inspection_ud: { base: "string", nullable: true },
    ud_last_enclosure_inspection_ud: { base: "string", nullable: true },
    ud_material_stream_ud: { base: "string", nullable: true },
    color: { base: "string", nullable: true },
    service_code_type: { base: "string", nullable: true },
    service_code_input: { base: "string", nullable: true },
    service_code: { base: "string", nullable: true },
    service_date: { base: "string", nullable: true },
    route_ids: { base: "string", nullable: true },
    frequency_ids: { base: "string", nullable: true },
    synced_at: { base: "string", nullable: false }
  }
};

/** Stored INTEGER flags: declared integer, served 0/1, never JSON boolean. */
const FLAG_COLUMNS: Record<Resource, string[]> = {
  customer: ["enabled"],
  address: ["extras_allowed", "enabled"],
  container: ["oncall", "gps_locked", "enabled"]
};

/**
 * Coordinate/date/route-list TEXT that must stay unconstrained text: no
 * numeric type, no format/pattern, no ISO/array guessing. synced_at is stored
 * TEXT and likewise carries no timestamp-format guarantee.
 */
const PLAIN_TEXT_COLUMNS: Record<Resource, string[]> = {
  customer: ["synced_at"],
  address: ["latitude", "longitude", "last_audit_date", "synced_at"],
  container: [
    "latitude", "longitude", "service_date", "route_ids", "frequency_ids",
    "ud_last_compactor_inspection_ud", "ud_last_enclosure_inspection_ud", "synced_at"
  ]
};

/** Constraints the writers never promised; no row property may invent them. */
const FORBIDDEN_FACETS = [
  "format", "pattern", "enum", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "multipleOf"
] as const;

// Synthetic primary keys, disjoint from other suites' fixtures.
const CUSTOMER_FULL: SeedRow = {
  customer_id: 95101, customer_type_id: 7, company_name: "synthetic-typed-co-95101",
  first_name: "Ada", middle_initial: "L", last_name: "Lovelace", name_suffix: "Jr",
  customer_number: "C-95101", sub_customer_number: "S-1", phone1: "555-95101",
  phone2: "555-95102", comments: "synthetic typed comment", enabled: 1,
  synced_at: "2026-10-01T00:00:00.123Z"
};
const CUSTOMER_NULL: SeedRow = {
  customer_id: 95102, customer_type_id: null, company_name: null, first_name: null,
  middle_initial: null, last_name: null, name_suffix: null, customer_number: null,
  sub_customer_number: null, phone1: null, phone2: null, comments: null, enabled: 0,
  synced_at: "2026-10-02T00:00:00.000Z"
};
const ADDRESS_FULL: SeedRow = {
  pickup_address_id: 95201, customer_id: 95101, route_id: 42, address: "1 Synthetic Way",
  city: "Syntheticville", state: "TX", zip: "76541", franchise_id: "F-9",
  comments: "addr comment", extras_allowed: 1, enabled: 0, driver_note: "gate code 1234",
  latitude: "30.123456", longitude: "-97.654321", last_audit_date: "2026-01-15",
  synced_at: "2026-10-01T00:00:00.123Z"
};
const ADDRESS_NULL: SeedRow = {
  pickup_address_id: 95202, customer_id: 95101, route_id: null, address: null, city: null,
  state: null, zip: null, franchise_id: null, comments: null, extras_allowed: 0, enabled: 1,
  driver_note: null, latitude: null, longitude: null, last_audit_date: null,
  synced_at: "2026-10-02T00:00:00.000Z"
};
const CONTAINER_FULL: SeedRow = {
  container_id: 95301, pickup_address_id: 95201, container_type_id: 3, serial_number: "SN-95301",
  rfid: "RFID-1", oncall: 1, event_code: "EVT", gps_locked: 0, latitude: "30.100000",
  longitude: "-97.600000", enabled: 1, location_address: "1 Synthetic Way", city: "Syntheticville",
  state: "TX", zip: "76541", container_note: "container note", ud_cost_share_ud: "50/50",
  ud_enclosure_doors_ud: "2", ud_last_compactor_inspection_ud: "2026-02-01",
  ud_last_enclosure_inspection_ud: "2026-02-02", ud_material_stream_ud: "MSW", color: "Blue",
  service_code_type: "SCT", service_code_input: "SCI", service_code: "SC", service_date: "2026-03-01",
  route_ids: "1,2,3", frequency_ids: "W,M", synced_at: "2026-10-01T00:00:00.123Z"
};
const CONTAINER_NULL: SeedRow = {
  container_id: 95302, pickup_address_id: 95201, container_type_id: null, serial_number: null,
  rfid: null, oncall: 0, event_code: null, gps_locked: 1, latitude: null, longitude: null,
  enabled: 0, location_address: null, city: null, state: null, zip: null, container_note: null,
  ud_cost_share_ud: null, ud_enclosure_doors_ud: null, ud_last_compactor_inspection_ud: null,
  ud_last_enclosure_inspection_ud: null, ud_material_stream_ud: null, color: null,
  service_code_type: null, service_code_input: null, service_code: null, service_date: null,
  route_ids: null, frequency_ids: null, synced_at: "2026-10-02T00:00:00.000Z"
};

type Spec = {
  resource: Resource;
  listPath: string;
  detailPath: string;
  detailIdParam: string;
  listOperationId: string;
  detailOperationId: string;
  idColumn: string;
  fullSeed: SeedRow;
  nullSeed: SeedRow;
  /** A sparse selector of two business columns with distinct synthetic values. */
  sampleFields: [string, string];
};

const SPECS: Spec[] = [
  {
    resource: "customer",
    listPath: "/api/v1/customer-snapshot",
    detailPath: "/api/v1/customer-snapshot/{customerId}",
    detailIdParam: "customerId",
    listOperationId: "listCustomerSnapshot",
    detailOperationId: "getCustomerSnapshot",
    idColumn: "customer_id",
    fullSeed: CUSTOMER_FULL,
    nullSeed: CUSTOMER_NULL,
    sampleFields: ["company_name", "phone1"]
  },
  {
    resource: "address",
    listPath: "/api/v1/address-snapshot",
    detailPath: "/api/v1/address-snapshot/{pickupAddressId}",
    detailIdParam: "pickupAddressId",
    listOperationId: "listAddressSnapshot",
    detailOperationId: "getAddressSnapshot",
    idColumn: "pickup_address_id",
    fullSeed: ADDRESS_FULL,
    nullSeed: ADDRESS_NULL,
    sampleFields: ["city", "address"]
  },
  {
    resource: "container",
    listPath: "/api/v1/container-snapshot",
    detailPath: "/api/v1/container-snapshot/{containerId}",
    detailIdParam: "containerId",
    listOperationId: "listContainerSnapshot",
    detailOperationId: "getContainerSnapshot",
    idColumn: "container_id",
    fullSeed: CONTAINER_FULL,
    nullSeed: CONTAINER_NULL,
    sampleFields: ["serial_number", "location_address"]
  }
];

// ---------------------------------------------------------------------------
// Mounted-document helpers: resolve what agents actually discover.
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;
type SchemaObject = JsonObject & {
  $ref?: unknown;
  properties?: Record<string, JsonObject>;
  required?: unknown;
  items?: JsonObject;
};
type OperationObject = JsonObject & {
  operationId?: unknown;
  parameters?: Array<Record<string, unknown>>;
  responses?: Record<string, {
    content?: Record<string, { schema?: SchemaObject; example?: unknown }>;
    headers?: Record<string, unknown>;
  }>;
};
type Document = {
  paths: Record<string, Record<string, OperationObject>>;
  components?: { schemas?: Record<string, SchemaObject> };
};

async function mountedDocument(): Promise<Document> {
  const res = await app.fetch(new Request("http://test.local/openapi.json"), TEST_ENV);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/json");
  return (await res.json()) as Document;
}

function operationOf(doc: Document, path: string): OperationObject {
  const op = doc.paths[path]?.get;
  expect(op, `${path}: GET operation is mounted`).toBeDefined();
  return op as OperationObject;
}

function json200Schema(op: OperationObject, label: string): SchemaObject {
  const schema = op.responses?.["200"]?.content?.["application/json"]?.schema;
  expect(schema, `${label}: 200 application/json schema is declared`).toBeDefined();
  return schema as SchemaObject;
}

/** Component name behind a `#/components/schemas/<Name>` reference, else null. */
function refName(schema: JsonObject | undefined): string | null {
  const ref = schema?.["$ref"];
  if (typeof ref !== "string") return null;
  const prefix = "#/components/schemas/";
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}

function resolveComponent(doc: Document, name: string, label: string): SchemaObject {
  const schema = doc.components?.schemas?.[name];
  expect(schema, `${label}: components.schemas.${name} exists`).toBeDefined();
  return schema as SchemaObject;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") {
    expect(value, message).toEqual(expect.any(String));
    throw new Error(`unreachable: ${message}`);
  }
  return value;
}

/**
 * Base type + nullability across the OpenAPI 3.1 spellings the generator may
 * emit: `type: "integer"`, `type: ["integer", "null"]`, `nullable: true`, or
 * an anyOf/oneOf union with a null arm.
 */
function typeFacets(prop: JsonObject): { bases: string[]; nullable: boolean } {
  const bases = new Set<string>();
  let nullable = false;
  const collect = (t: unknown) => {
    if (typeof t === "string") bases.add(t);
    else if (Array.isArray(t)) {
      for (const e of t) if (typeof e === "string") bases.add(e);
    }
  };
  collect(prop["type"]);
  if (prop["nullable"] === true) nullable = true;
  for (const key of ["anyOf", "oneOf"]) {
    const arms = prop[key];
    if (Array.isArray(arms)) {
      for (const arm of arms) {
        if (arm !== null && typeof arm === "object") collect((arm as JsonObject)["type"]);
      }
    }
  }
  if (bases.has("null")) {
    nullable = true;
    bases.delete("null");
  }
  return { bases: [...bases].sort(), nullable };
}

// ---------------------------------------------------------------------------
// Request harness: synthetic D1, real app.fetch, no network, no writes.
// ---------------------------------------------------------------------------

type Statement = { sql: string; binds: unknown[] };
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);
const isWrite = (s: Statement) => /^\s*(INSERT|UPDATE|DELETE|REPLACE|UPSERT|DROP|ALTER|CREATE)\b/i.test(s.sql);

/** Pass-through recorder over the real test D1. */
function spyDb(real: D1Database): { db: D1Database; statements: Statement[] } {
  const statements: Statement[] = [];
  const db = {
    prepare(sql: string) {
      const rec: Statement = { sql, binds: [] };
      statements.push(rec);
      const stmt = real.prepare(sql);
      return {
        bind(...binds: unknown[]) {
          rec.binds = binds;
          return stmt.bind(...binds);
        },
        first: (...a: unknown[]) => (stmt.first as (...x: unknown[]) => unknown)(...a),
        all: () => stmt.all(),
        run: () => stmt.run(),
        raw: () => stmt.raw()
      };
    },
    batch: (...a: unknown[]) => (real.batch as (...x: unknown[]) => unknown)(...a)
  };
  return { db: db as unknown as D1Database, statements };
}

function throwingDb() {
  const prepare = vi.fn(() => {
    throw new Error("Auth/validation rejection must not reach D1");
  });
  return { db: { prepare } as unknown as D1Database, prepare };
}

async function get(
  path: string,
  options: { token?: string | null; db?: D1Database; headers?: Record<string, string> } = {}
): Promise<Response> {
  const headers = new Headers({ origin: ORIGIN, ...options.headers });
  const token = options.token === undefined ? READ_TOKEN : options.token;
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return app.fetch(
    new Request(`http://test.local${path}`, { headers }),
    options.db ? { ...TEST_ENV, CUSTOMER_DB: options.db } : TEST_ENV
  );
}

type ListBody = { rows: Array<Record<string, unknown>>; total: number | null; nextCursor: number | null };

function expectNoStoreCors(res: Response): void {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
}

/** Seed row with keys in SELECT/registry order, for byte-exact pins. */
function orderedRow(resource: Resource, seed: SeedRow): Record<string, unknown> {
  return Object.fromEntries(EXPECTED_COLUMNS[resource].map((c) => [c, seed[c]]));
}

async function sha256Quoted(bytes: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes));
  return `"${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  await ensureD1TestTables();
});

beforeEach(async () => {
  globalThis.fetch = vi.fn(async () => {
    throw new Error("Unexpected outbound fetch in typed-rows acceptance");
  }) as typeof fetch;

  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  const insert = (table: string, cols: string[], seed: SeedRow) =>
    db
      .prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
      .bind(...cols.map((c) => seed[c]));
  // FK chain order: customers, then addresses, then containers.
  await db.batch([
    insert("customer_snapshot", EXPECTED_COLUMNS.customer, CUSTOMER_FULL),
    insert("customer_snapshot", EXPECTED_COLUMNS.customer, CUSTOMER_NULL)
  ]);
  await db.batch([
    insert("address_snapshot", EXPECTED_COLUMNS.address, ADDRESS_FULL),
    insert("address_snapshot", EXPECTED_COLUMNS.address, ADDRESS_NULL)
  ]);
  await db.batch([
    insert("container_snapshot", EXPECTED_COLUMNS.container, CONTAINER_FULL),
    insert("container_snapshot", EXPECTED_COLUMNS.container, CONTAINER_NULL)
  ]);
});

afterEach(() => {
  try {
    // A caught upstream error must not silently turn a network attempt into a pass.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  }
});

// ---------------------------------------------------------------------------
// Mounted contract: reusable references for all six operations.
// ---------------------------------------------------------------------------

describe("mounted contract: reusable row and envelope references", () => {
  it("RED: the three list 200s reference resource-specific envelopes (distinct $refs)", async () => {
    const doc = await mountedDocument();
    const names = SPECS.map((spec) => {
      const schema = json200Schema(operationOf(doc, spec.listPath), `GET ${spec.listPath}`);
      const name = refName(schema);
      expect(
        name,
        `GET ${spec.listPath}: 200 schema is a reusable $ref (pre-build shape reuses one shared CustomerSnapshotList)`
      ).toEqual(expect.any(String));
      return name;
    });
    expect(
      new Set(names).size,
      `list envelopes are resource-specific, not one shared schema: ${names.join(", ")}`
    ).toBe(SPECS.length);
  });

  it("RED: the three by-ID 200s reference reusable row schemas ($ref, not inline)", async () => {
    const doc = await mountedDocument();
    for (const spec of SPECS) {
      const schema = json200Schema(operationOf(doc, spec.detailPath), `GET ${spec.detailPath}`);
      expect(
        refName(schema),
        `GET ${spec.detailPath}: 200 schema is a $ref to a reusable ${spec.resource} row schema (pre-build shape is an inline record(unknown))`
      ).toEqual(expect.any(String));
    }
  });

  it("RED: each list rows.items resolves to the same row schema as its by-ID", async () => {
    const doc = await mountedDocument();
    for (const spec of SPECS) {
      const listSchema = json200Schema(operationOf(doc, spec.listPath), `GET ${spec.listPath}`);
      const envelopeName = refName(listSchema);
      if (typeof envelopeName !== "string") {
        expect(envelopeName, `GET ${spec.listPath}: 200 schema is an envelope $ref`).toEqual(
          expect.any(String)
        );
        return;
      }
      const envelope = resolveComponent(doc, envelopeName, `GET ${spec.listPath}`);
      const itemsRef = refName(envelope.properties?.["rows"]?.["items"] as JsonObject | undefined);
      const detailSchema = json200Schema(operationOf(doc, spec.detailPath), `GET ${spec.detailPath}`);
      const detailRef = refName(detailSchema);
      expect(
        itemsRef,
        `GET ${spec.listPath}: rows.items is a $ref (pre-build items are an untyped object)`
      ).toEqual(expect.any(String));
      expect(
        detailRef,
        `GET ${spec.detailPath}: 200 schema is the reusable row $ref`
      ).toEqual(expect.any(String));
      if (typeof itemsRef === "string" && typeof detailRef === "string") {
        expect(itemsRef, `${spec.resource}: list and by-ID share one row schema`).toBe(detailRef);
      }
    }
  });

  it("RED: row schema names are distinct per resource", async () => {
    const doc = await mountedDocument();
    const names: string[] = [];
    for (const spec of SPECS) {
      const schema = json200Schema(operationOf(doc, spec.detailPath), `GET ${spec.detailPath}`);
      const name = refName(schema);
      expect(name, `GET ${spec.detailPath}: reusable ${spec.resource} row $ref`).toEqual(
        expect.any(String)
      );
      if (typeof name === "string") names.push(name);
    }
    expect(
      new Set(names).size,
      `row schemas are distinct per resource: ${names.join(", ")}`
    ).toBe(SPECS.length);
  });

  it("control: envelopes preserve the rows/total/nextCursor envelope shape", async () => {
    const doc = await mountedDocument();
    for (const spec of SPECS) {
      const listSchema = json200Schema(operationOf(doc, spec.listPath), `GET ${spec.listPath}`);
      const envelopeName = requireString(
        refName(listSchema),
        `GET ${spec.listPath}: 200 schema is an envelope $ref`
      );
      const envelope = resolveComponent(doc, envelopeName, `GET ${spec.listPath}`);
      expect(envelope["type"]).toBe("object");
      expect(Object.keys(envelope.properties ?? {}).sort()).toEqual(
        ["nextCursor", "rows", "total"]
      );
      expect([...((envelope["required"] as unknown[] | undefined) ?? [])].sort()).toEqual([
        "nextCursor", "rows", "total"
      ]);
      const rows = envelope.properties?.["rows"] as JsonObject;
      expect(rows?.["type"]).toBe("array");
    }
  });

  it("control: total stays nullable integer and keeps its not-computed meaning", async () => {
    const doc = await mountedDocument();
    for (const spec of SPECS) {
      const listSchema = json200Schema(operationOf(doc, spec.listPath), `GET ${spec.listPath}`);
      const envelope = resolveComponent(
        doc,
        requireString(refName(listSchema), `GET ${spec.listPath}: envelope $ref`),
        `GET ${spec.listPath}`
      );
      const total = envelope.properties?.["total"] as JsonObject;
      expect(typeFacets(total).bases).toEqual(["integer"]);
      expect(typeFacets(total).nullable).toBe(true);
      expect(String(total?.["description"] ?? "")).toContain("deliberately not computed");
    }
  });

  it("RED: nextCursor stays nullable integer and documents its meaning", async () => {
    const doc = await mountedDocument();
    for (const spec of SPECS) {
      const listSchema = json200Schema(operationOf(doc, spec.listPath), `GET ${spec.listPath}`);
      const envelope = resolveComponent(
        doc,
        requireString(refName(listSchema), `GET ${spec.listPath}: envelope $ref`),
        `GET ${spec.listPath}`
      );
      const nextCursor = envelope.properties?.["nextCursor"] as JsonObject;
      expect(typeFacets(nextCursor).bases).toEqual(["integer"]);
      expect(typeFacets(nextCursor).nullable).toBe(true);
      const description = String(nextCursor?.["description"] ?? "");
      expect(
        description.length >= 10 && /cursor|page/i.test(description),
        `${spec.resource}: nextCursor documents its page/cursor meaning (pre-build shape has no description)`
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Mounted contract: SNAPSHOT_FIELDSETS is the property-set authority.
// ---------------------------------------------------------------------------

describe("mounted contract: fieldset authority and storage-faithful types", () => {
  it("control: the registry matches the pinned selectable-column snapshot", () => {
    for (const spec of SPECS) {
      expect(
        [...SNAPSHOT_FIELDSETS[spec.resource].columns],
        `${spec.resource}: registry columns are the pinned SELECT list`
      ).toEqual(EXPECTED_COLUMNS[spec.resource]);
      expect(SNAPSHOT_FIELDSETS[spec.resource].idColumn).toBe(spec.idColumn);
    }
  });

  it("RED: every row schema property set equals its SNAPSHOT_FIELDSETS registry", async () => {
    const doc = await mountedDocument();
    for (const spec of SPECS) {
      const schema = json200Schema(operationOf(doc, spec.detailPath), `GET ${spec.detailPath}`);
      const name = refName(schema);
      if (typeof name !== "string") {
        expect(name, `GET ${spec.detailPath}: reusable ${spec.resource} row $ref`).toEqual(
          expect.any(String)
        );
        return;
      }
      const row = resolveComponent(doc, name, `GET ${spec.detailPath}`);
      expect(row["type"]).toBe("object");
      expect(
        Object.keys(row.properties ?? {}).sort(),
        `${spec.resource}: row properties equal SNAPSHOT_FIELDSETS (no second allowlist, no missing column)`
      ).toEqual([...SNAPSHOT_FIELDSETS[spec.resource].columns].sort());
    }
  });

  it("RED: only the primary identity is required (sparse output omits the rest)", async () => {
    const doc = await mountedDocument();
    for (const spec of SPECS) {
      const schema = json200Schema(operationOf(doc, spec.detailPath), `GET ${spec.detailPath}`);
      const name = refName(schema);
      if (typeof name !== "string") {
        expect(name, `GET ${spec.detailPath}: reusable ${spec.resource} row $ref`).toEqual(
          expect.any(String)
        );
        return;
      }
      const row = resolveComponent(doc, name, `GET ${spec.detailPath}`);
      expect([...((row["required"] as unknown[] | undefined) ?? [])]).toEqual([spec.idColumn]);
    }
  });

  it("RED: every column carries its storage-faithful numeric/text/null type", async () => {
    const doc = await mountedDocument();
    for (const spec of SPECS) {
      const schema = json200Schema(operationOf(doc, spec.detailPath), `GET ${spec.detailPath}`);
      const name = refName(schema);
      if (typeof name !== "string") {
        expect(name, `GET ${spec.detailPath}: reusable ${spec.resource} row $ref`).toEqual(
          expect.any(String)
        );
        return;
      }
      const row = resolveComponent(doc, name, `GET ${spec.detailPath}`);
      const properties = row.properties ?? {};
      for (const column of EXPECTED_COLUMNS[spec.resource]) {
        const prop = properties[column];
        expect(prop, `${spec.resource}.${column}: declared in the row schema`).toBeDefined();
        if (prop === undefined) continue;
        const expected = COLUMN_TYPES[spec.resource][column] as ColumnType;
        const facets = typeFacets(prop);
        expect(facets.bases, `${spec.resource}.${column}: base type`).toEqual([expected.base]);
        expect(facets.nullable, `${spec.resource}.${column}: nullability`).toBe(expected.nullable);
      }
    }
  });

  it("RED: stored flags are integers, never JSON booleans or numbers", async () => {
    const doc = await mountedDocument();
    for (const spec of SPECS) {
      const schema = json200Schema(operationOf(doc, spec.detailPath), `GET ${spec.detailPath}`);
      const name = refName(schema);
      if (typeof name !== "string") {
        expect(name, `GET ${spec.detailPath}: reusable ${spec.resource} row $ref`).toEqual(
          expect.any(String)
        );
        return;
      }
      const row = resolveComponent(doc, name, `GET ${spec.detailPath}`);
      for (const flag of FLAG_COLUMNS[spec.resource]) {
        const prop = (row.properties ?? {})[flag] as JsonObject | undefined;
        expect(prop, `${spec.resource}.${flag}: declared`).toBeDefined();
        if (prop === undefined) continue;
        expect(typeFacets(prop).bases, `${spec.resource}.${flag}: integer, not boolean`).toEqual([
          "integer"
        ]);
        expect(typeFacets(prop).nullable, `${spec.resource}.${flag}: NOT NULL`).toBe(false);
      }
    }
  });

  it("RED: coordinate/date/list text stays unconstrained text (no format guessing)", async () => {
    const doc = await mountedDocument();
    for (const spec of SPECS) {
      const schema = json200Schema(operationOf(doc, spec.detailPath), `GET ${spec.detailPath}`);
      const name = refName(schema);
      if (typeof name !== "string") {
        expect(name, `GET ${spec.detailPath}: reusable ${spec.resource} row $ref`).toEqual(
          expect.any(String)
        );
        return;
      }
      const row = resolveComponent(doc, name, `GET ${spec.detailPath}`);
      for (const column of PLAIN_TEXT_COLUMNS[spec.resource]) {
        const prop = (row.properties ?? {})[column] as JsonObject | undefined;
        expect(prop, `${spec.resource}.${column}: declared`).toBeDefined();
        if (prop === undefined) continue;
        expect(typeFacets(prop).bases, `${spec.resource}.${column}: text`).toEqual(["string"]);
        for (const facet of ["format", "pattern", "enum"] as const) {
          expect(prop, `${spec.resource}.${column}: no invented ${facet}`).not.toHaveProperty(facet);
        }
      }
    }
  });

  it("RED: no row property invents positivity/enum/format/safe-integer guarantees", async () => {
    const doc = await mountedDocument();
    for (const spec of SPECS) {
      const schema = json200Schema(operationOf(doc, spec.detailPath), `GET ${spec.detailPath}`);
      const name = refName(schema);
      if (typeof name !== "string") {
        expect(name, `GET ${spec.detailPath}: reusable ${spec.resource} row $ref`).toEqual(
          expect.any(String)
        );
        return;
      }
      const row = resolveComponent(doc, name, `GET ${spec.detailPath}`);
      for (const column of EXPECTED_COLUMNS[spec.resource]) {
        const prop = (row.properties ?? {})[column] as JsonObject | undefined;
        if (prop === undefined) continue;
        for (const facet of FORBIDDEN_FACETS) {
          expect(prop, `${spec.resource}.${column}: no invented ${facet}`).not.toHaveProperty(facet);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Mounted contract: stable operations, headers, codes, conforming examples.
// ---------------------------------------------------------------------------

describe("mounted contract: stable operations and conforming examples (controls)", () => {
  it("keeps stable operationIds on all six reads", async () => {
    const doc = await mountedDocument();
    for (const spec of SPECS) {
      expect(operationOf(doc, spec.listPath)["operationId"]).toBe(spec.listOperationId);
      expect(operationOf(doc, spec.detailPath)["operationId"]).toBe(spec.detailOperationId);
    }
  });

  it("keeps list ETag/Link headers with 304 + 400, and by-ID 400 + 404", async () => {
    const doc = await mountedDocument();
    for (const spec of SPECS) {
      const list = operationOf(doc, spec.listPath);
      const headers = list.responses?.["200"]?.headers ?? {};
      expect(Object.keys(headers).map((h) => h.toLowerCase()).sort()).toEqual(
        expect.arrayContaining(["etag", "link"])
      );
      expect(list.responses?.["304"], `GET ${spec.listPath}: 304 declared`).toBeDefined();
      expect(list.responses?.["400"], `GET ${spec.listPath}: 400 declared`).toBeDefined();
      const detail = operationOf(doc, spec.detailPath);
      expect(detail.responses?.["400"], `GET ${spec.detailPath}: 400 declared`).toBeDefined();
      expect(detail.responses?.["404"], `GET ${spec.detailPath}: 404 declared`).toBeDefined();
    }
  });

  it("list examples are full rows: required identity present, flags are integers", async () => {
    const doc = await mountedDocument();
    for (const spec of SPECS) {
      const example = operationOf(doc, spec.listPath).responses?.["200"]?.content?.[
        "application/json"
      ]?.example as unknown as ListBody | undefined;
      expect(example, `GET ${spec.listPath}: worked example`).toBeDefined();
      if (example === undefined) continue;
      expect(Object.keys(example).sort()).toEqual(["nextCursor", "rows", "total"]);
      expect(example.rows.length).toBeGreaterThan(0);
      const row = example.rows[0] as Record<string, unknown>;
      expect(Object.keys(row).sort()).toEqual([...EXPECTED_COLUMNS[spec.resource]].sort());
      expect(typeof row[spec.idColumn]).toBe("number");
      for (const flag of FLAG_COLUMNS[spec.resource]) {
        expect(typeof row[flag], `${spec.resource} example.${flag}: integer, not boolean`).toBe(
          "number"
        );
        expect([0, 1]).toContain(row[flag]);
      }
    }
  });

  it("by-ID examples are full rows: required identity present, flags are integers", async () => {
    const doc = await mountedDocument();
    for (const spec of SPECS) {
      const example = operationOf(doc, spec.detailPath).responses?.["200"]?.content?.[
        "application/json"
      ]?.example as unknown as Record<string, unknown> | undefined;
      expect(example, `GET ${spec.detailPath}: worked example`).toBeDefined();
      if (example === undefined) continue;
      expect(Object.keys(example).sort()).toEqual([...EXPECTED_COLUMNS[spec.resource]].sort());
      expect(typeof example[spec.idColumn]).toBe("number");
      for (const flag of FLAG_COLUMNS[spec.resource]) {
        expect(typeof example[flag], `${spec.resource} example.${flag}: integer`).toBe("number");
        expect([0, 1]).toContain(example[flag]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Synthetic D1 behavior: full/sparse/null values without normalization.
// ---------------------------------------------------------------------------

describe.each(SPECS)("$resource list: full and sparse values (controls)", (spec) => {
  it("bare request returns both seeded rows with exact stored values", async () => {
    const res = await get(spec.listPath);
    expect(res.status).toBe(200);
    expectNoStoreCors(res);
    const body = (await res.json()) as ListBody;
    expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
    expect(body.total).toBe(2);
    expect(body.nextCursor).toBeNull();
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0]).toEqual(orderedRow(spec.resource, spec.fullSeed));
    expect(body.rows[1]).toEqual(orderedRow(spec.resource, spec.nullSeed));
  });

  it("nullable keys stay present as null; flags stay 0/1 numbers", async () => {
    const res = await get(spec.listPath);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    for (const row of body.rows) {
      expect(Object.keys(row).sort()).toEqual([...EXPECTED_COLUMNS[spec.resource]].sort());
      for (const column of EXPECTED_COLUMNS[spec.resource]) {
        const expected = COLUMN_TYPES[spec.resource][column] as ColumnType;
        const value = row[column];
        if (value === null) {
          expect(expected.nullable, `${spec.resource}.${column}: null is declared`).toBe(true);
        } else if (expected.base === "integer") {
          expect(typeof value, `${spec.resource}.${column}: integer`).toBe("number");
          expect(Number.isInteger(value)).toBe(true);
        } else {
          expect(typeof value, `${spec.resource}.${column}: string`).toBe("string");
        }
      }
    }
    const [full, sparse] = body.rows;
    for (const flag of FLAG_COLUMNS[spec.resource]) {
      expect(typeof full[flag]).toBe("number");
      expect(typeof sparse[flag]).toBe("number");
    }
    // The null seed exercises every nullable arm; the full seed every value arm.
    expect(Object.values(spec.nullSeed).filter((v) => v === null).length).toBeGreaterThan(0);
  });

  it("coordinate/date/list text arrives as unconstrained strings", async () => {
    const res = await get(spec.listPath);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListBody;
    const full = body.rows[0] as Record<string, unknown>;
    for (const column of PLAIN_TEXT_COLUMNS[spec.resource]) {
      expect(typeof full[column], `${spec.resource}.${column}: stored text, not a number`).toBe(
        "string"
      );
      expect(full[column]).toBe(spec.fullSeed[column]);
    }
  });

  it("sparse selection returns exactly id + requested fields with identical values", async () => {
    const [a, b] = spec.sampleFields;
    const res = await get(`${spec.listPath}?fields=${a},${b}`);
    expect(res.status).toBe(200);
    expectNoStoreCors(res);
    const body = (await res.json()) as ListBody;
    expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
    expect(body.total).toBe(2);
    expect(body.rows).toHaveLength(2);
    const [full, sparse] = body.rows;
    for (const row of [full, sparse]) {
      expect(Object.keys(row).sort()).toEqual([spec.idColumn, a, b].sort());
    }
    expect(full[a]).toBe(spec.fullSeed[a]);
    expect(full[b]).toBe(spec.fullSeed[b]);
    expect(sparse[a]).toBe(spec.nullSeed[a]);
    expect(sparse[b]).toBe(spec.nullSeed[b]);
  });

  it("works with the read-only token, the full token and the sync secret", async () => {
    for (const token of [READ_TOKEN, API_TOKEN, SYNC_SECRET]) {
      const res = await get(spec.listPath, { token });
      expect(res.status).toBe(200);
      expectNoStoreCors(res);
    }
  });
});

describe.each(SPECS)("$resource by-ID: full and sparse values (controls)", (spec) => {
  function detailPath(id: number): string {
    return spec.detailPath.replace(`{${spec.detailIdParam}}`, String(id));
  }

  it("bare request returns the exact stored row", async () => {
    const fullId = spec.fullSeed[spec.idColumn] as number;
    const nullId = spec.nullSeed[spec.idColumn] as number;
    for (const [id, seed] of [[fullId, spec.fullSeed], [nullId, spec.nullSeed]] as const) {
      const res = await get(detailPath(id));
      expect(res.status).toBe(200);
      expectNoStoreCors(res);
      expect(res.headers.get("etag")).toBeNull();
      const row = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(row).sort()).toEqual([...EXPECTED_COLUMNS[spec.resource]].sort());
      expect(row).toEqual(orderedRow(spec.resource, seed));
    }
  });

  it("sparse selection returns exactly id + requested field with the stored value", async () => {
    const [field] = spec.sampleFields;
    const id = spec.fullSeed[spec.idColumn] as number;
    const res = await get(`${detailPath(id)}?fields=${field}`);
    expect(res.status).toBe(200);
    expectNoStoreCors(res);
    const row = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([spec.idColumn, field].sort());
    expect(row[spec.idColumn]).toBe(id);
    expect(row[field]).toBe(spec.fullSeed[field]);
  });

  it("unknown id is a value-free 404 naming only the key", async () => {
    const res = await get(detailPath(999999937));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expectNoStoreCors(res);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      type: problemType("not-found"),
      title: "Not Found",
      status: 404
    });
    expect(String(body["detail"])).toContain("999999937");
  });
});

describe("byte pins: representative served bytes never change (controls)", () => {
  it("pins each by-ID full row byte for byte", async () => {
    for (const spec of SPECS) {
      const id = spec.fullSeed[spec.idColumn] as number;
      const path = spec.detailPath.replace(`{${spec.detailIdParam}}`, String(id));
      const res = await get(path);
      expect(res.status).toBe(200);
      const bytes = await res.text();
      expect(bytes, `${spec.resource} by-ID bytes: no normalization, no key reorder`).toBe(
        JSON.stringify(orderedRow(spec.resource, spec.fullSeed))
      );
    }
  });

  it("pins the customer list envelope byte for byte", async () => {
    const spec = SPECS[0] as Spec;
    const res = await get(spec.listPath);
    expect(res.status).toBe(200);
    const bytes = await res.text();
    expect(bytes, "customer list bytes: rows/total/nextCursor envelope is stable").toBe(
      JSON.stringify({
        rows: [orderedRow(spec.resource, spec.fullSeed), orderedRow(spec.resource, spec.nullSeed)],
        total: 2,
        nextCursor: null
      })
    );
  });
});

describe("query plans: SELECT shape is frozen, writes are denied (controls)", () => {
  it("default list runs COUNT + one page SELECT; count-free skips COUNT with the same page", async () => {
    for (const spec of SPECS) {
      const full = spyDb(TEST_ENV.CUSTOMER_DB);
      const fullRes = await get(spec.listPath, { db: full.db });
      expect(fullRes.status).toBe(200);
      const fullBody = (await fullRes.json()) as ListBody;
      expect(full.statements.filter(isCount)).toHaveLength(1);
      expect(full.statements).toHaveLength(2);
      expect(full.statements.every((s) => !isWrite(s))).toBe(true);

      const free = spyDb(TEST_ENV.CUSTOMER_DB);
      const freeRes = await get(`${spec.listPath}?includeTotal=false`, { db: free.db });
      expect(freeRes.status).toBe(200);
      const freeBody = (await freeRes.json()) as ListBody;
      expect(free.statements.filter(isCount)).toHaveLength(0);
      expect(free.statements).toHaveLength(1);
      expect(free.statements.every((s) => !isWrite(s))).toBe(true);

      // Same page SQL and binds with and without the count; total null means
      // deliberately not computed, with identical rows and nextCursor.
      const pageSql = (stmts: Statement[]) => stmts.filter((s) => !isCount(s));
      expect(pageSql(free.statements).map((s) => s.sql)).toEqual(
        pageSql(full.statements).map((s) => s.sql)
      );
      expect(pageSql(free.statements).map((s) => s.binds)).toEqual(
        pageSql(full.statements).map((s) => s.binds)
      );
      expect(freeBody.total).toBeNull();
      expect(freeBody.rows).toEqual(fullBody.rows);
      expect(freeBody.nextCursor).toBe(fullBody.nextCursor);
    }
  });

  it("by-ID runs a single SELECT and writes nothing", async () => {
    for (const spec of SPECS) {
      const id = spec.fullSeed[spec.idColumn] as number;
      const path = spec.detailPath.replace(`{${spec.detailIdParam}}`, String(id));
      const { db, statements } = spyDb(TEST_ENV.CUSTOMER_DB);
      const res = await get(path, { db });
      expect(res.status).toBe(200);
      expect(statements).toHaveLength(1);
      expect(statements[0]?.sql).toMatch(/^\s*SELECT\b/i);
      expect(statements.every((s) => !isWrite(s))).toBe(true);
    }
  });
});

describe("conditional, auth and value-free errors (controls)", () => {
  it("list ETag is the SHA-256 of the exact served bytes; a match answers 304 with no body", async () => {
    for (const spec of SPECS) {
      const res = await get(spec.listPath);
      expect(res.status).toBe(200);
      const bytes = await res.text();
      const tag = res.headers.get("etag");
      expect(tag).toBe(await sha256Quoted(bytes));
      const replay = await get(spec.listPath, { headers: { "if-none-match": tag as string } });
      expect(replay.status).toBe(304);
      expect(replay.headers.get("etag")).toBe(tag);
      expectNoStoreCors(replay);
      expect((await replay.arrayBuffer()).byteLength).toBe(0);
    }
  });

  it("missing bearer is a value-free 401 before any D1 work", async () => {
    for (const spec of SPECS) {
      const { db, prepare } = throwingDb();
      const res = await get(spec.listPath, { token: null, db });
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expectNoStoreCors(res);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({
        type: problemType("unauthorized"),
        title: "Unauthorized",
        status: 401,
        detail: AUTH_401_DETAIL
      });
      expect(text).not.toContain("SYNTHETIC-MARKER");
      expect(prepare).not.toHaveBeenCalled();
    }
  });

  it("auth precedes validation: bad fields without a bearer still answers 401", async () => {
    for (const spec of SPECS) {
      const { db, prepare } = throwingDb();
      const res = await get(`${spec.listPath}?fields=nope-SYNTHETIC-MARKER`, { token: null, db });
      expect(res.status).toBe(401);
      expect(prepare).not.toHaveBeenCalled();
    }
  });

  it("unknown fields are a value-free 400 before any D1 work", async () => {
    for (const spec of SPECS) {
      const { db, prepare } = throwingDb();
      const res = await get(`${spec.listPath}?fields=${spec.idColumn},nope-SYNTHETIC-MARKER`, {
        db
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expectNoStoreCors(res);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({
        type: problemType("bad-request"),
        title: "Bad Request",
        status: 400,
        detail: FIELDS_400_DETAIL
      });
      expect(text).not.toContain("SYNTHETIC-MARKER");
      expect(prepare).not.toHaveBeenCalled();
    }
  });
});
