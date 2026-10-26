/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/app";
import { SNAPSHOT_FIELDSETS } from "../src/lib/sparseFieldsets";
import { problemType } from "../src/lib/problem";
import { ensureD1TestTables } from "./d1TestMigrations";

/**
 * Acceptance contract for R26-03: publish typed customer changes-feed delta rows.
 *
 * SCOPE: the EXISTING `GET /api/v1/customer-snapshot/changes` 200 only. Flat
 * lists/by-ID (R25-04), hydrated /data bundles, combined-sync/save outcomes,
 * exports, error-policy work and new surfaces are explicitly out of scope and
 * must not move. Sparse `fields=` merged per #364: it projects rows and Link
 * retains the selector; `until` and unknown keys stay ignored (controls pin that).
 * The builder must NOT implement `until` to satisfy this file.
 *
 * Each test is labeled RED (must fail before the paired build for the
 * documented missing declaration) or control (must already pass: behavior the
 * declaration-only build must preserve byte for byte). The file as a whole is
 * RED until the builder publishes the contract.
 *
 * What the builder publishes (declaration-only, no runtime change):
 *  - one reusable customer delta row schema; the changes 200 `rows.items`
 *    resolves through a $ref to it (today: inline untyped object);
 *  - row property set exactly equals SNAPSHOT_FIELDSETS.customer (the
 *    field/identity authority); only `customer_id` + `synced_at` are required
 *    on full rows (replay/cursor identity), with storage-faithful nullability
 *    when present (migrations/d1/0001); sparse `fields=` pages project to
 *    `customer_id` plus selected columns and may omit `synced_at`;
 *  - stored flags stay integers (never JSON booleans); text stays text with
 *    no invented positivity/enum/timestamp-format/safe-integer guarantees;
 *  - total:int and the typed composite nextCursor keep their semantics and
 *    document their meaning; operationId, headers, examples and codes stay.
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
 * Run: npx vitest run test/typedCustomerChangesDelta.acceptance.test.ts
 */

const READ_TOKEN = "test-read-token";
const API_TOKEN = "test-api-token";
const SYNC_SECRET = "test-sync-secret";
const TEST_ENV = env as unknown as Env;
const ORIGIN = "https://typed-delta-client.invalid";
const PATH = "/api/v1/customer-snapshot/changes";
const OPERATION_ID = "listCustomerSnapshotChanges";
const AUTH_401_DETAIL =
  "Send Authorization: Bearer <SHADOW_API_TOKEN>. See docs/PROBLEMS.md#unauthorized.";

type SeedRow = Record<string, string | number | null>;

/** Storage-faithful column contract, from migrations/d1/0001_customer_snapshot.sql. */
type ColumnType = { base: "integer" | "string"; nullable: boolean };

const EXPECTED_COLUMNS = [
  "customer_id",
  "customer_type_id",
  "company_name",
  "first_name",
  "middle_initial",
  "last_name",
  "name_suffix",
  "customer_number",
  "sub_customer_number",
  "phone1",
  "phone2",
  "comments",
  "enabled",
  "synced_at"
] as const;

const COLUMN_TYPES: Record<string, ColumnType> = {
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
};

/** Replay/cursor identity: required on full rows; sparse fields= may omit synced_at. */
const REQUIRED_IDENTITIES = ["customer_id", "synced_at"] as const;

/** Stored INTEGER flags: declared integer, served 0/1, never JSON boolean. */
const FLAG_COLUMNS = ["enabled"] as const;

/** TEXT that must stay unconstrained: no format/pattern/enum guessing. */
const PLAIN_TEXT_COLUMNS = [
  "company_name",
  "first_name",
  "middle_initial",
  "last_name",
  "name_suffix",
  "customer_number",
  "sub_customer_number",
  "phone1",
  "phone2",
  "comments",
  "synced_at"
] as const;

/** Constraints the writers never promised; no row property may invent them. */
const FORBIDDEN_FACETS = [
  "format",
  "pattern",
  "enum",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "multipleOf"
] as const;

// Synthetic multi-run delta: two rows share the run-1 stamp, three share the
// run-2 stamp. 96xx ids are disjoint from other suites' fixtures.
const RUN_1_AT = "2026-09-01T00:00:00.000Z";
const RUN_2_AT = "2026-09-02T00:00:00.000Z";

const ROW_9601_FULL: SeedRow = {
  customer_id: 9601,
  customer_type_id: 7,
  company_name: "synthetic-delta-co-9601",
  first_name: "Ada",
  middle_initial: "L",
  last_name: "Lovelace",
  name_suffix: "Jr",
  customer_number: "C-9601",
  sub_customer_number: "S-1",
  phone1: "555-9601",
  phone2: "555-9602",
  comments: "synthetic delta comment 9601",
  enabled: 1,
  synced_at: RUN_1_AT
};
const ROW_9602_NULL: SeedRow = {
  customer_id: 9602,
  customer_type_id: null,
  company_name: null,
  first_name: null,
  middle_initial: null,
  last_name: null,
  name_suffix: null,
  customer_number: null,
  sub_customer_number: null,
  phone1: null,
  phone2: null,
  comments: null,
  enabled: 0,
  synced_at: RUN_1_AT
};
const ROW_9603_FULL: SeedRow = {
  customer_id: 9603,
  customer_type_id: 3,
  company_name: "synthetic-delta-co-9603",
  first_name: "Grace",
  middle_initial: "B",
  last_name: "Hopper",
  name_suffix: null,
  customer_number: "C-9603",
  sub_customer_number: null,
  phone1: "+1 (555) 9603",
  phone2: null,
  comments: "second run full row",
  enabled: 0,
  synced_at: RUN_2_AT
};
const ROW_9604_NULL: SeedRow = {
  customer_id: 9604,
  customer_type_id: null,
  company_name: null,
  first_name: null,
  middle_initial: null,
  last_name: null,
  name_suffix: null,
  customer_number: null,
  sub_customer_number: null,
  phone1: null,
  phone2: null,
  comments: null,
  enabled: 1,
  synced_at: RUN_2_AT
};
const ROW_9605_TEXT: SeedRow = {
  customer_id: 9605,
  customer_type_id: null,
  company_name: "Δ synthetic 9605 — dashes_and_underscores",
  first_name: "Alan",
  middle_initial: null,
  last_name: "Turing",
  name_suffix: "Sr",
  customer_number: "C-9605/X",
  sub_customer_number: "S-2",
  phone1: "555-9605 ext 1",
  phone2: "x",
  comments: "line1 line2\ttab",
  enabled: 1,
  synced_at: RUN_2_AT
};

const SEEDS = [ROW_9601_FULL, ROW_9602_NULL, ROW_9603_FULL, ROW_9604_NULL, ROW_9605_TEXT];
const ORDERED_IDS = [9601, 9602, 9603, 9604, 9605];
const ORDERED_STAMPS = [RUN_1_AT, RUN_1_AT, RUN_2_AT, RUN_2_AT, RUN_2_AT];

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
  responses?: Record<
    string,
    {
      description?: unknown;
      content?: Record<string, { schema?: SchemaObject; example?: unknown }>;
      headers?: Record<string, unknown>;
    }
  >;
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

function changesOperation(doc: Document): OperationObject {
  const op = doc.paths[PATH]?.get;
  expect(op, `${PATH}: GET operation is mounted`).toBeDefined();
  return op as OperationObject;
}

function json200Schema(op: OperationObject): SchemaObject {
  const schema = op.responses?.["200"]?.content?.["application/json"]?.schema;
  expect(schema, "GET changes: 200 application/json schema is declared").toBeDefined();
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

/** Resolve the envelope (200 $ref target) for the changes feed. */
function changesEnvelope(doc: Document): { name: string; schema: SchemaObject } {
  const op = changesOperation(doc);
  const schema = json200Schema(op);
  const name = requireString(
    refName(schema),
    "GET changes: 200 schema is a reusable envelope $ref"
  );
  return { name, schema: resolveComponent(doc, name, "GET changes") };
}

/**
 * Resolve the delta row schema behind `rows.items`. Returns nulls (after a
 * soft RED assertion) when the pre-build inline untyped object is still there,
 * so downstream RED tests fail with the documented cause instead of crashing.
 */
function deltaRowSchema(
  doc: Document,
  envelope: SchemaObject
): { name: string | null; schema: SchemaObject | null } {
  const rows = envelope.properties?.["rows"] as JsonObject | undefined;
  const items = rows?.["items"] as JsonObject | undefined;
  const name = refName(items);
  expect(
    name,
    "GET changes: rows.items is a $ref to a reusable delta row schema " +
      "(pre-build shape is an inline untyped object)"
  ).toEqual(expect.any(String));
  if (typeof name !== "string") return { name: null, schema: null };
  return { name, schema: resolveComponent(doc, name, "GET changes delta row") };
}

// ---------------------------------------------------------------------------
// Request harness: synthetic D1, real app.fetch, no network, no writes.
// ---------------------------------------------------------------------------

type Statement = { sql: string; binds: unknown[] };
const isCount = (s: Statement) => /\bCOUNT\s*\(/i.test(s.sql);

/** Pass-through recorder that rejects every write before it can mutate D1. */
function spyDb(real: D1Database): { db: D1Database; statements: Statement[] } {
  const statements: Statement[] = [];
  const db = {
    prepare(sql: string) {
      if (!/^\s*SELECT\b/i.test(sql)) {
        throw new Error(`Forbidden non-SELECT prepare in delta acceptance: ${sql.slice(0, 80)}`);
      }
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
        run: () => {
          throw new Error("Forbidden D1 run in delta acceptance");
        },
        raw: () => stmt.raw()
      };
    },
    batch: () => {
      throw new Error("Forbidden D1 batch in delta acceptance");
    }
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

type Cursor = { since: string; since_id: number };
type ChangesBody = {
  rows: Array<Record<string, unknown>>;
  total: number;
  nextCursor: Cursor | null;
};

function expectNoStoreCors(res: Response): void {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
}

/** Seed row with keys in SELECT/registry order, for byte-exact pins. */
function orderedRow(seed: SeedRow): Record<string, unknown> {
  return Object.fromEntries(EXPECTED_COLUMNS.map((c) => [c, seed[c]]));
}

function query(params: Record<string, string>): string {
  const qs = new URLSearchParams(params).toString();
  return qs ? `${PATH}?${qs}` : PATH;
}

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  await ensureD1TestTables();
});

beforeEach(async () => {
  globalThis.fetch = vi.fn(async () => {
    throw new Error("Unexpected outbound fetch in delta acceptance");
  }) as typeof fetch;

  const db = TEST_ENV.CUSTOMER_DB;
  await db.batch([
    db.prepare("DELETE FROM container_snapshot"),
    db.prepare("DELETE FROM address_snapshot"),
    db.prepare("DELETE FROM customer_snapshot")
  ]);
  const cols = [...EXPECTED_COLUMNS];
  await db.batch(
    SEEDS.map((seed) =>
      db
        .prepare(`INSERT INTO customer_snapshot (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
        .bind(...cols.map((c) => seed[c]))
    )
  );
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
// Mounted contract: reusable delta row reference.
// ---------------------------------------------------------------------------

describe("mounted contract: reusable delta row reference (RED)", () => {
  it("control: the changes 200 stays a reusable envelope $ref", async () => {
    const doc = await mountedDocument();
    const schema = json200Schema(changesOperation(doc));
    expect(refName(schema), "GET changes: 200 schema is a reusable envelope $ref").toEqual(
      expect.any(String)
    );
  });

  it("RED: rows.items is a $ref to a reusable delta row schema, not an inline object", async () => {
    const doc = await mountedDocument();
    const { schema: envelope } = changesEnvelope(doc);
    const rows = envelope.properties?.["rows"] as JsonObject | undefined;
    expect(rows?.["type"], "changes envelope rows is an array").toBe("array");
    expect(
      refName(rows?.["items"] as JsonObject | undefined),
      "GET changes: rows.items is a $ref (pre-build items are an inline untyped object)"
    ).toEqual(expect.any(String));
  });

  it("RED: the delta row schema is a named component distinct from the envelope", async () => {
    const doc = await mountedDocument();
    const { name: envelopeName, schema: envelope } = changesEnvelope(doc);
    const { name } = deltaRowSchema(doc, envelope);
    expect(name, "delta row $ref name").toEqual(expect.any(String));
    if (typeof name === "string") {
      expect(name, "delta row is its own component, not the envelope").not.toBe(envelopeName);
      expect(doc.components?.schemas?.[name]?.["type"]).toBe("object");
    }
  });
});

// ---------------------------------------------------------------------------
// Mounted contract: SNAPSHOT_FIELDSETS is the property-set authority.
// ---------------------------------------------------------------------------

describe("mounted contract: fieldset authority and storage-faithful types (RED)", () => {
  it("control: the customer registry matches the pinned SELECT list", () => {
    expect([...SNAPSHOT_FIELDSETS.customer.columns]).toEqual([...EXPECTED_COLUMNS]);
    expect(SNAPSHOT_FIELDSETS.customer.idColumn).toBe("customer_id");
  });

  it("RED: delta row property set equals SNAPSHOT_FIELDSETS.customer", async () => {
    const doc = await mountedDocument();
    const { schema: envelope } = changesEnvelope(doc);
    const { schema: row } = deltaRowSchema(doc, envelope);
    if (!row) return;
    expect(row["type"]).toBe("object");
    expect(
      Object.keys(row.properties ?? {}).sort(),
      "delta row properties equal SNAPSHOT_FIELDSETS.customer (no second allowlist, no missing column)"
    ).toEqual([...SNAPSHOT_FIELDSETS.customer.columns].sort());
  });

  it("RED: only customer_id + synced_at are required (required on full rows)", async () => {
    const doc = await mountedDocument();
    const { schema: envelope } = changesEnvelope(doc);
    const { schema: row } = deltaRowSchema(doc, envelope);
    if (!row) return;
    expect([...((row["required"] as unknown[] | undefined) ?? [])].sort()).toEqual(
      [...REQUIRED_IDENTITIES].sort()
    );
  });

  it("RED: every column carries its storage-faithful numeric/text/null type", async () => {
    const doc = await mountedDocument();
    const { schema: envelope } = changesEnvelope(doc);
    const { schema: row } = deltaRowSchema(doc, envelope);
    if (!row) return;
    const properties = row.properties ?? {};
    for (const column of EXPECTED_COLUMNS) {
      const prop = properties[column];
      expect(prop, `delta.${column}: declared in the row schema`).toBeDefined();
      if (prop === undefined) continue;
      const expected = COLUMN_TYPES[column] as ColumnType;
      const facets = typeFacets(prop);
      expect(facets.bases, `delta.${column}: base type`).toEqual([expected.base]);
      expect(facets.nullable, `delta.${column}: nullability`).toBe(expected.nullable);
    }
  });

  it("RED: stored flags are integers, never JSON booleans", async () => {
    const doc = await mountedDocument();
    const { schema: envelope } = changesEnvelope(doc);
    const { schema: row } = deltaRowSchema(doc, envelope);
    if (!row) return;
    for (const flag of FLAG_COLUMNS) {
      const prop = (row.properties ?? {})[flag] as JsonObject | undefined;
      expect(prop, `delta.${flag}: declared`).toBeDefined();
      if (prop === undefined) continue;
      expect(typeFacets(prop).bases, `delta.${flag}: integer, not boolean`).toEqual(["integer"]);
      expect(typeFacets(prop).nullable, `delta.${flag}: NOT NULL`).toBe(false);
    }
  });

  it("RED: text stays unconstrained text (no format/pattern/enum guessing)", async () => {
    const doc = await mountedDocument();
    const { schema: envelope } = changesEnvelope(doc);
    const { schema: row } = deltaRowSchema(doc, envelope);
    if (!row) return;
    for (const column of PLAIN_TEXT_COLUMNS) {
      const prop = (row.properties ?? {})[column] as JsonObject | undefined;
      expect(prop, `delta.${column}: declared`).toBeDefined();
      if (prop === undefined) continue;
      expect(typeFacets(prop).bases, `delta.${column}: text`).toEqual(["string"]);
      for (const facet of ["format", "pattern", "enum"] as const) {
        expect(prop, `delta.${column}: no invented ${facet}`).not.toHaveProperty(facet);
      }
    }
  });

  it("RED: no row property invents positivity/enum/format/safe-integer guarantees", async () => {
    const doc = await mountedDocument();
    const { schema: envelope } = changesEnvelope(doc);
    const { schema: row } = deltaRowSchema(doc, envelope);
    if (!row) return;
    for (const column of EXPECTED_COLUMNS) {
      const prop = (row.properties ?? {})[column] as JsonObject | undefined;
      expect(prop, `delta.${column}: declared`).toBeDefined();
      if (prop === undefined) continue;
      for (const facet of FORBIDDEN_FACETS) {
        expect(prop, `delta.${column}: no invented ${facet}`).not.toHaveProperty(facet);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Mounted contract: preserved total/nextCursor envelope semantics.
// ---------------------------------------------------------------------------

describe("mounted contract: total and composite nextCursor (RED descriptions, control types)", () => {
  it("control: envelope keeps rows/total/nextCursor shape, all required", async () => {
    const doc = await mountedDocument();
    const { schema: envelope } = changesEnvelope(doc);
    expect(envelope["type"]).toBe("object");
    expect(Object.keys(envelope.properties ?? {}).sort()).toEqual([
      "nextCursor",
      "rows",
      "total"
    ]);
    expect([...((envelope["required"] as unknown[] | undefined) ?? [])].sort()).toEqual([
      "nextCursor",
      "rows",
      "total"
    ]);
  });

  it("control: total stays a non-nullable integer (page length, never a count query)", async () => {
    const doc = await mountedDocument();
    const { schema: envelope } = changesEnvelope(doc);
    const total = envelope.properties?.["total"] as JsonObject;
    expect(typeFacets(total).bases).toEqual(["integer"]);
    expect(typeFacets(total).nullable).toBe(false);
  });

  it("RED: total documents its page-length meaning", async () => {
    const doc = await mountedDocument();
    const { schema: envelope } = changesEnvelope(doc);
    const total = envelope.properties?.["total"] as JsonObject;
    const description = String(total?.["description"] ?? "");
    expect(
      description.length >= 10 && /page|rows|length/i.test(description),
      "changes total documents its page-length meaning (pre-build shape has no description)"
    ).toBe(true);
  });

  it("control: nextCursor stays a nullable composite {since, since_id} pair", async () => {
    const doc = await mountedDocument();
    const { schema: envelope } = changesEnvelope(doc);
    const nextCursor = envelope.properties?.["nextCursor"] as JsonObject;
    expect(typeFacets(nextCursor).bases).toEqual(["object"]);
    expect(typeFacets(nextCursor).nullable).toBe(true);
    const props = (nextCursor["properties"] as Record<string, JsonObject> | undefined) ?? {};
    expect(Object.keys(props).sort()).toEqual(["since", "since_id"]);
    expect([...((nextCursor["required"] as unknown[] | undefined) ?? [])].sort()).toEqual([
      "since",
      "since_id"
    ]);
    expect(typeFacets(props["since"] as JsonObject).bases).toEqual(["string"]);
    expect(typeFacets(props["since_id"] as JsonObject).bases).toEqual(["integer"]);
  });

  it("RED: nextCursor documents its composite-resume meaning", async () => {
    const doc = await mountedDocument();
    const { schema: envelope } = changesEnvelope(doc);
    const nextCursor = envelope.properties?.["nextCursor"] as JsonObject;
    const description = String(nextCursor?.["description"] ?? "");
    expect(
      description.length >= 10 && /cursor|resume|since/i.test(description),
      "changes nextCursor documents its composite-resume meaning (pre-build shape has no description)"
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mounted contract: stable operation, headers, codes, conforming examples.
// ---------------------------------------------------------------------------

describe("mounted contract: stable operation and conforming examples (controls)", () => {
  it("keeps the stable operationId and read/local-read agent metadata", async () => {
    const doc = await mountedDocument();
    const op = changesOperation(doc);
    expect(op["operationId"]).toBe(OPERATION_ID);
    expect(op["x-access"]).toBe("read");
    expect(op["x-effect"]).toBe("local-read");
  });

  it("keeps the optional string Link header and the 400 cursor rejection", async () => {
    const doc = await mountedDocument();
    const op = changesOperation(doc);
    const headers = op.responses?.["200"]?.headers ?? {};
    const link = Object.entries(headers).find(([name]) => name.toLowerCase() === "link")?.[1] as
      | { required?: unknown; schema?: { type?: unknown } }
      | undefined;
    expect(link, "mounted OpenAPI advertises the optional composite continuation").toBeDefined();
    expect(link?.required).not.toBe(true);
    expect(link?.schema?.type).toBe("string");
    expect(op.responses?.["400"], "GET changes: 400 declared").toBeDefined();
  });

  it("documents the composite-resume consumer note on the operation", async () => {
    const doc = await mountedDocument();
    const op = changesOperation(doc);
    const description = String((op as JsonObject)["description"] ?? "");
    expect(description).toContain("nextCursor");
    expect(description).toContain("since_id");
  });

  it("200 example is a full delta row: identities present, flags are integers", async () => {
    const doc = await mountedDocument();
    const op = changesOperation(doc);
    const example = op.responses?.["200"]?.content?.["application/json"]?.example as
      | ChangesBody
      | undefined;
    expect(example, "GET changes: worked example").toBeDefined();
    if (example === undefined) return;
    expect(Object.keys(example).sort()).toEqual(["nextCursor", "rows", "total"]);
    expect(example.rows.length).toBeGreaterThan(0);
    const row = example.rows[0] as Record<string, unknown>;
    expect(Object.keys(row).sort()).toEqual([...EXPECTED_COLUMNS].sort());
    for (const identity of REQUIRED_IDENTITIES) {
      expect(row[identity], `example.${identity}: replay identity present`).not.toBeNull();
      expect(row[identity]).not.toBeUndefined();
    }
    expect(typeof row["customer_id"]).toBe("number");
    expect(typeof row["synced_at"]).toBe("string");
    for (const flag of FLAG_COLUMNS) {
      expect(typeof row[flag], `example.${flag}: integer, not boolean`).toBe("number");
      expect([0, 1]).toContain(row[flag]);
    }
  });

  it("RED: the worked example row conforms to the published delta row schema", async () => {
    const doc = await mountedDocument();
    const op = changesOperation(doc);
    const { schema: envelope } = changesEnvelope(doc);
    const { schema: row } = deltaRowSchema(doc, envelope);
    if (!row) return;
    const example = op.responses?.["200"]?.content?.["application/json"]?.example as
      | ChangesBody
      | undefined;
    expect(example, "GET changes: worked example").toBeDefined();
    if (example === undefined) return;
    const properties = row.properties ?? {};
    const sample = example.rows[0] as Record<string, unknown>;
    // Every served key is declared; every required identity is served.
    expect(Object.keys(sample).sort()).toEqual(Object.keys(properties).sort());
    for (const identity of REQUIRED_IDENTITIES) {
      expect(sample[identity]).not.toBeNull();
      expect(sample[identity]).not.toBeUndefined();
    }
    // Declared nullability matches the example's null arms: a null example
    // value must sit on a nullable property; a non-null value must match base.
    for (const [key, value] of Object.entries(sample)) {
      const prop = properties[key] as JsonObject | undefined;
      expect(prop, `example key ${key} is declared`).toBeDefined();
      if (prop === undefined) continue;
      const facets = typeFacets(prop);
      if (value === null) {
        expect(facets.nullable, `example.${key}: null is declared`).toBe(true);
      } else if (typeof value === "number") {
        expect(facets.bases, `example.${key}: numeric`).toEqual(["integer"]);
      } else if (typeof value === "string") {
        expect(facets.bases, `example.${key}: text`).toEqual(["string"]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Synthetic D1 behavior: multi-run deltas without normalization.
// ---------------------------------------------------------------------------

describe("delta pages: ordering, replay and tiebreak (controls)", () => {
  it("omitted since returns every row in (synced_at, customer_id) order", async () => {
    const res = await get(PATH);
    expect(res.status).toBe(200);
    expectNoStoreCors(res);
    const body = (await res.json()) as ChangesBody;
    expect(Object.keys(body).sort()).toEqual(["nextCursor", "rows", "total"]);
    expect(body.total).toBe(5);
    expect(body.rows.map((r) => r.customer_id)).toEqual(ORDERED_IDS);
    expect(body.rows.map((r) => r.synced_at)).toEqual(ORDERED_STAMPS);
    expect(body.nextCursor).toBeNull();
    for (const row of body.rows) {
      expect(Object.keys(row).sort()).toEqual([...EXPECTED_COLUMNS].sort());
    }
  });

  it("empty since is the epoch, not a 400", async () => {
    const res = await get(query({ since: "" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangesBody;
    expect(body.total).toBe(5);
    expect(body.rows.map((r) => r.customer_id)).toEqual(ORDERED_IDS);
  });

  it("bare since replays the whole later run (strict >, no tiebreak)", async () => {
    const res = await get(query({ since: RUN_1_AT }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangesBody;
    expect(body.total).toBe(3);
    expect(body.rows.map((r) => r.customer_id)).toEqual([9603, 9604, 9605]);
    expect(body.rows.map((r) => r.synced_at)).toEqual([RUN_2_AT, RUN_2_AT, RUN_2_AT]);
    expect(body.nextCursor).toBeNull();
  });

  it("composite since_id resumes the same-timestamp remainder without skipping", async () => {
    // Tiebreak at the run-1 boundary: the remainder of run 1 plus all of run 2.
    const boundary = (await (await get(query({ since: RUN_1_AT, since_id: "9601" }))).json()) as ChangesBody;
    expect(boundary.rows.map((r) => r.customer_id)).toEqual([9602, 9603, 9604, 9605]);

    // Tiebreak mid-run-2: only the larger ids at the boundary stamp.
    const mid = (await (await get(query({ since: RUN_2_AT, since_id: "9603" }))).json()) as ChangesBody;
    expect(mid.rows.map((r) => r.customer_id)).toEqual([9604, 9605]);

    // Zero is the boundary sentinel: the whole table replays.
    const zero = (await (await get(query({ since: RUN_1_AT, since_id: "0" }))).json()) as ChangesBody;
    expect(zero.rows.map((r) => r.customer_id)).toEqual(ORDERED_IDS);
  });

  it("limit pages cross the timestamp boundary and visit every row exactly once", async () => {
    const seen: unknown[] = [];
    let search = query({ limit: "2" });
    for (let attempt = 0; attempt <= ORDERED_IDS.length; attempt++) {
      const res = await get(search);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ChangesBody;
      expect(body.total).toBe(body.rows.length);
      const offset = seen.length;
      expect(body.rows.map((r) => r.customer_id)).toEqual(
        ORDERED_IDS.slice(offset, offset + 2)
      );
      seen.push(...body.rows.map((r) => r.customer_id));
      if (body.rows.length < 2) {
        expect(body.nextCursor).toBeNull();
        expect(res.headers.get("link")).toBeNull();
        expect(seen).toEqual(ORDERED_IDS);
        return;
      }
      const last = seen.length - 1;
      expect(body.nextCursor).toEqual({
        since: ORDERED_STAMPS[last],
        since_id: ORDERED_IDS[last]
      });
      const cursor = body.nextCursor as Cursor;
      expect(res.headers.get("link")).toMatch(/^<\/api\/v1\/customer-snapshot\/changes\?[^>]+>; rel="next"$/);
      search = query({ since: cursor.since, since_id: String(cursor.since_id), limit: "2" });
    }
    throw new Error("Delta walk did not terminate within the fixture-sized bound");
  });

  it("empty tail is an empty page with total 0 and no Link", async () => {
    const res = await get(query({ since: RUN_2_AT, since_id: "9605", limit: "2" }));
    expect(res.status).toBe(200);
    expectNoStoreCors(res);
    const body = (await res.json()) as ChangesBody;
    expect(body).toEqual({ rows: [], total: 0, nextCursor: null });
    expect(res.headers.get("link")).toBeNull();
  });

  it("works with the read-only token, the full token and the sync secret", async () => {
    for (const token of [READ_TOKEN, API_TOKEN, SYNC_SECRET]) {
      const res = await get(PATH, { token });
      expect(res.status).toBe(200);
      expectNoStoreCors(res);
    }
  });
});

describe("delta values: nullable arms and unconstrained strings (controls)", () => {
  it("nullable keys stay present as null with storage-faithful value types", async () => {
    const res = await get(PATH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangesBody;
    for (const row of body.rows) {
      expect(Object.keys(row).sort()).toEqual([...EXPECTED_COLUMNS].sort());
      for (const column of EXPECTED_COLUMNS) {
        const expected = COLUMN_TYPES[column] as ColumnType;
        const value = row[column];
        if (value === null) {
          expect(expected.nullable, `delta.${column}: null is declared`).toBe(true);
        } else if (expected.base === "integer") {
          expect(typeof value, `delta.${column}: integer`).toBe("number");
          expect(Number.isInteger(value)).toBe(true);
        } else {
          expect(typeof value, `delta.${column}: string`).toBe("string");
        }
      }
    }
    // Both null seeds exercise every nullable arm; both full seeds every value arm.
    expect(Object.values(ROW_9602_NULL).filter((v) => v === null).length).toBeGreaterThan(0);
    expect(Object.values(ROW_9604_NULL).filter((v) => v === null).length).toBeGreaterThan(0);
  });

  it("serves exact stored values with no normalization", async () => {
    const res = await get(PATH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangesBody;
    expect(body.rows).toHaveLength(5);
    expect(body.rows[0]).toEqual(orderedRow(ROW_9601_FULL));
    expect(body.rows[1]).toEqual(orderedRow(ROW_9602_NULL));
    expect(body.rows[2]).toEqual(orderedRow(ROW_9603_FULL));
    expect(body.rows[3]).toEqual(orderedRow(ROW_9604_NULL));
    expect(body.rows[4]).toEqual(orderedRow(ROW_9605_TEXT));
  });

  it("unconstrained text arrives byte-identical, including unicode and whitespace", async () => {
    const res = await get(query({ since: RUN_2_AT, since_id: "9604" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangesBody;
    expect(body.rows.map((r) => r.customer_id)).toEqual([9605]);
    const row = body.rows[0] as Record<string, unknown>;
    expect(row["company_name"]).toBe(ROW_9605_TEXT["company_name"]);
    expect(row["comments"]).toBe(ROW_9605_TEXT["comments"]);
    expect(row["phone1"]).toBe(ROW_9605_TEXT["phone1"]);
  });

  it("flags stay 0/1 numbers, never JSON booleans", async () => {
    const res = await get(PATH);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ChangesBody;
    for (const row of body.rows) {
      for (const flag of FLAG_COLUMNS) {
        expect(typeof row[flag], `delta.${flag}: integer`).toBe("number");
        expect([0, 1]).toContain(row[flag]);
      }
    }
  });
});

describe("byte pins: representative served bytes never change (controls)", () => {
  it("pins the full first-page envelope byte for byte", async () => {
    const res = await get(PATH);
    expect(res.status).toBe(200);
    const bytes = await res.text();
    expect(bytes, "delta first-page bytes: rows/total/nextCursor envelope is stable").toBe(
      JSON.stringify({
        rows: SEEDS.map(orderedRow),
        total: 5,
        nextCursor: null
      })
    );
  });

  it("pins the bare-since whole-run replay byte for byte", async () => {
    const res = await get(query({ since: RUN_1_AT }));
    expect(res.status).toBe(200);
    const bytes = await res.text();
    expect(bytes, "bare-since replay bytes: whole later run, no tiebreak").toBe(
      JSON.stringify({
        rows: [ROW_9603_FULL, ROW_9604_NULL, ROW_9605_TEXT].map(orderedRow),
        total: 3,
        nextCursor: null
      })
    );
  });

  it("pins the empty tail byte for byte", async () => {
    const res = await get(query({ since: RUN_2_AT, since_id: "9605" }));
    expect(res.status).toBe(200);
    const bytes = await res.text();
    expect(bytes).toBe(JSON.stringify({ rows: [], total: 0, nextCursor: null }));
  });
});

describe("query plans: one SELECT, no COUNT, no writes (controls)", () => {
  it("each page runs exactly one SELECT with no COUNT and no writes", async () => {
    for (const search of [
      PATH,
      query({ since: RUN_1_AT }),
      query({ since: RUN_2_AT, since_id: "9603", limit: "1" }),
      query({ since: RUN_2_AT, since_id: "9605" })
    ]) {
      const { db, statements } = spyDb(TEST_ENV.CUSTOMER_DB);
      const res = await get(search, { db });
      expect(res.status).toBe(200);
      expect(statements).toHaveLength(1);
      expect(statements.filter(isCount)).toHaveLength(0);
      expect(statements[0]?.sql).toMatch(/^\s*SELECT\b/i);
      expect(statements[0]?.sql).toMatch(/ORDER BY synced_at,\s*customer_id/i);
      expect(statements[0]?.sql).toMatch(/LIMIT \?/);
    }
  });

  it("bare and composite resumes bind the normalized cursor without extra reads", async () => {
    const bare = spyDb(TEST_ENV.CUSTOMER_DB);
    const bareRes = await get(query({ since: RUN_1_AT, limit: "1" }), { db: bare.db });
    expect(bareRes.status).toBe(200);
    expect(bare.statements).toHaveLength(1);
    expect(bare.statements[0]?.binds).toEqual([RUN_1_AT, 1]);

    const composite = spyDb(TEST_ENV.CUSTOMER_DB);
    const compositeRes = await get(query({ since: RUN_2_AT, since_id: "9603", limit: "1" }), {
      db: composite.db
    });
    expect(compositeRes.status).toBe(200);
    expect(composite.statements).toHaveLength(1);
    expect(composite.statements[0]?.binds).toEqual([RUN_2_AT, RUN_2_AT, 9603, 1]);
  });
});

describe("wire stability: conditional, auth, errors and ignored keys (controls)", () => {
  it("sets no ETag and answers If-None-Match with the same 200 bytes", async () => {
    const plain = await get(PATH);
    expect(plain.status).toBe(200);
    expect(plain.headers.get("etag")).toBeNull();
    const plainBytes = await plain.text();

    const replay = await get(PATH, { headers: { "if-none-match": '"synthetic-etag"' } });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("etag")).toBeNull();
    expectNoStoreCors(replay);
    expect(await replay.text()).toBe(plainBytes);
  });

  it("missing or invalid bearer is a value-free 401 before any D1 work", async () => {
    for (const token of [null, "synthetic-invalid-token"] as const) {
      const { db, prepare } = throwingDb();
      const res = await get(query({ since: "invalid", limit: "501" }), { token, db });
      expect(res.status).toBe(401);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(res.headers.get("link")).toBeNull();
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

  it("invalid cursors are value-free 400s before any D1 work, with no Link", async () => {
    for (const search of [
      query({ since: "secret-bad-timestamp" }),
      query({ since_id: "0" }),
      query({ since: RUN_1_AT, since_id: "secret-bad-id" }),
      query({ limit: "501" }),
      query({ limit: "0" })
    ]) {
      const { db, prepare } = throwingDb();
      const res = await get(search, { db });
      expect(res.status).toBe(400);
      expect(res.headers.get("content-type")).toContain("application/problem+json");
      expect(res.headers.get("link")).toBeNull();
      expectNoStoreCors(res);
      const text = await res.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      expect(body).toMatchObject({
        type: problemType("bad-request"),
        title: "Bad Request",
        status: 400
      });
      expect(String(body["detail"])).toMatch(
        /^Invalid request query \((?:since|since_id|limit|query)(?:, (?:since|since_id|limit|query))*\)\. See docs\/PROBLEMS\.md#bad-request\.$/
      );
      expect(text).not.toContain("secret-bad-");
      expect(prepare).not.toHaveBeenCalled();
    }
  });

  it("composes until with sparse fields while ignoring unknown keys: stable rows/cursors, bounded SQL and Link", async () => {
    // `fields=` projects rows; `until` bounds reads and is retained in Link.
    // This fixture's page is inside the bound, so bytes/cursors stay unchanged.
    // Unknown keys affect neither rows nor SQL and never echo into Link.
    const { db: cleanDb, statements: cleanStatements } = spyDb(TEST_ENV.CUSTOMER_DB);
    const clean = await get(query({ limit: "2" }), { db: cleanDb });
    expect(clean.status).toBe(200);
    const cleanBytes = await clean.text();
    const cleanLink = clean.headers.get("link");
    expect(cleanLink, "full page links to the composite remainder").toMatch(
      /^<\/api\/v1\/customer-snapshot\/changes\?[^>]+>; rel="next"$/
    );
    expect(cleanLink).not.toMatch(/SYNTHETIC|fields|until|bogus/);
    expect(cleanStatements).toHaveLength(1);
    expect(cleanStatements.filter(isCount)).toHaveLength(0);
    const cleanBody = JSON.parse(cleanBytes) as ChangesBody;
    for (const row of cleanBody.rows) {
      expect(Object.keys(row).sort()).toEqual([...EXPECTED_COLUMNS].sort());
    }

    // until + unknown keys (no fields): same in-window bytes, bounded SQL/Link.
    const { db: boundedDb, statements: boundedStatements } = spyDb(TEST_ENV.CUSTOMER_DB);
    const bounded = await get(
      `${PATH}?limit=2&until=${encodeURIComponent(RUN_2_AT)}&bogus=unknown-marker-SYNTHETIC`,
      { db: boundedDb }
    );
    expect(bounded.status).toBe(200);
    expect(await bounded.text()).toBe(cleanBytes);
    expect(bounded.headers.get("link")).toBe(
      '</api/v1/customer-snapshot/changes?since=2026-09-01T00%3A00%3A00.000Z&since_id=9602&limit=2&until=2026-09-02T00%3A00%3A00.000Z>; rel="next"'
    );
    expect(bounded.headers.get("link")).not.toMatch(/SYNTHETIC|fields|bogus/);
    expect(boundedStatements).toHaveLength(1);
    expect(boundedStatements.filter(isCount)).toHaveLength(0);
    expect(boundedStatements[0]?.sql).toMatch(
      /\bWHERE\s+synced_at\s*>\s*\?\s+AND\s+synced_at\s*<=\s*\?\s+ORDER BY synced_at,\s*customer_id\s+LIMIT \?\s*$/i
    );
    expect(boundedStatements[0]?.binds).toEqual(["0000-01-01T00:00:00.000Z", RUN_2_AT, 2]);

    // fields=company_name projects to id + selector, keeping total/cursor; Link retains fields.
    const { db: sparseDb, statements: sparseStatements } = spyDb(TEST_ENV.CUSTOMER_DB);
    const sparse = await get(`${PATH}?limit=2&fields=company_name`, { db: sparseDb });
    expect(sparse.status).toBe(200);
    const sparseBytes = await sparse.text();
    const sparseLink = sparse.headers.get("link");
    expect(sparseLink, "sparse Link retains the validated fields selector").toMatch(
      /fields=company_name/
    );
    expect(sparseLink).not.toMatch(/SYNTHETIC|until|bogus/);
    expect(sparseStatements).toHaveLength(1);
    expect(sparseStatements.filter(isCount)).toHaveLength(0);
    expect(sparseStatements[0]?.sql).toBe(cleanStatements[0]?.sql);
    expect(sparseStatements[0]?.binds).toEqual(cleanStatements[0]?.binds);
    const sparseBody = JSON.parse(sparseBytes) as ChangesBody;
    expect(sparseBody.total).toBe(cleanBody.total);
    expect(sparseBody.nextCursor).toEqual(cleanBody.nextCursor);
    expect(sparseBody.rows).toEqual([
      { customer_id: 9601, company_name: ROW_9601_FULL.company_name },
      { customer_id: 9602, company_name: null }
    ]);
    expect(sparseBytes).toBe(
      JSON.stringify({
        rows: [
          { customer_id: 9601, company_name: ROW_9601_FULL.company_name },
          { customer_id: 9602, company_name: null }
        ],
        total: cleanBody.total,
        nextCursor: cleanBody.nextCursor
      })
    );

    // The bound composes with sparse fields; only unknown keys stay ignored.
    const { db: boundedSparseDb, statements: boundedSparseStatements } = spyDb(TEST_ENV.CUSTOMER_DB);
    const boundedSparse = await get(
      `${PATH}?limit=2&fields=company_name&until=${encodeURIComponent(RUN_2_AT)}&bogus=unknown-marker-SYNTHETIC`,
      { db: boundedSparseDb }
    );
    expect(boundedSparse.status).toBe(200);
    expect(await boundedSparse.text()).toBe(sparseBytes);
    const boundedSparseLink = boundedSparse.headers.get("link");
    expect(boundedSparseLink).toMatch(/^<\/api\/v1\/customer-snapshot\/changes\?[^>]+>; rel="next"$/);
    expect(boundedSparseLink).not.toMatch(/SYNTHETIC|bogus/);
    const boundedSparseNext = new URL(boundedSparseLink?.match(/^<([^>]+)>/)?.[1] ?? "", "http://test.local");
    expect(Object.fromEntries(boundedSparseNext.searchParams)).toEqual({
      since: RUN_1_AT,
      since_id: "9602",
      limit: "2",
      fields: "company_name",
      until: RUN_2_AT
    });
    expect(boundedSparseLink).toContain("until=2026-09-02T00%3A00%3A00.000Z");
    expect(boundedSparseStatements).toHaveLength(1);
    expect(boundedSparseStatements.filter(isCount)).toHaveLength(0);
    expect(boundedSparseStatements[0]?.sql).toBe(boundedStatements[0]?.sql);
    expect(boundedSparseStatements[0]?.binds).toEqual(["0000-01-01T00:00:00.000Z", RUN_2_AT, 2]);
  });
});
