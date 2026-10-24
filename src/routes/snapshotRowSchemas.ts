import { z } from "@hono/zod-openapi";
import { SNAPSHOT_FIELDSETS, type SnapshotFieldsetResource } from "../lib/sparseFieldsets";

/**
 * Typed flat snapshot row contracts for the six EXISTING flat reads
 * (`GET /api/v1/{customer,address,container}-snapshot` and the three flat
 * by-ID GETs). Declaration-only: these schemas shape `/openapi.json`, never
 * runtime validation — handlers keep serving the same D1 bytes.
 *
 * Authority order, mirrored from the acceptance contract:
 * `SNAPSHOT_FIELDSETS` owns the property sets (each row schema is built by
 * iterating the registry, so a registry column can never be missing and no
 * second allowlist can add one); `migrations/d1/0001` + `0002` own the
 * storage base types and nullability below. The load-time partition check
 * fails closed when the two drift apart instead of publishing a wrong type.
 *
 * Each resource gets one reusable row schema (by-ID 200) plus one
 * resource-specific list envelope (list 200) whose `rows.items` is the same
 * row `$ref`. Only the primary identity is required: sparse `?fields=`
 * output omits every other key, so the rest are optional — with accurate
 * nullability when present. Stored INTEGER flags stay integers (never JSON
 * booleans); coordinate/date/route-list TEXT stays unconstrained text with
 * no format, pattern, enum, range or length facets; nothing invents
 * positivity, timestamp-format or safe-integer guarantees the writers never
 * promised. `total` keeps its nullable count-free semantics and `nextCursor`
 * its page-cursor meaning; both are documented on the envelopes.
 *
 * Out of scope on purpose: hydrated `/data` bundles, the customer changes
 * feed (its composite cursor keeps its own schema), sync/save outcomes,
 * exports and error-policy work.
 */

type ColumnBase = "integer" | "string";

/**
 * Storage base type per selectable column, from the table DDL
 * (`migrations/d1/0001_customer_snapshot.sql`,
 * `migrations/d1/0002_address_container.sql`). Keys must partition each
 * resource's `SNAPSHOT_FIELDSETS` columns exactly — see the check below.
 */
const SNAPSHOT_COLUMN_BASE_TYPES: Record<SnapshotFieldsetResource, Record<string, ColumnBase>> = {
  customer: {
    customer_id: "integer",
    customer_type_id: "integer",
    company_name: "string",
    first_name: "string",
    middle_initial: "string",
    last_name: "string",
    name_suffix: "string",
    customer_number: "string",
    sub_customer_number: "string",
    phone1: "string",
    phone2: "string",
    comments: "string",
    enabled: "integer",
    synced_at: "string"
  },
  address: {
    pickup_address_id: "integer",
    customer_id: "integer",
    route_id: "integer",
    address: "string",
    city: "string",
    state: "string",
    zip: "string",
    franchise_id: "string",
    comments: "string",
    extras_allowed: "integer",
    enabled: "integer",
    driver_note: "string",
    latitude: "string",
    longitude: "string",
    last_audit_date: "string",
    synced_at: "string"
  },
  container: {
    container_id: "integer",
    pickup_address_id: "integer",
    container_type_id: "integer",
    serial_number: "string",
    rfid: "string",
    oncall: "integer",
    event_code: "string",
    gps_locked: "integer",
    latitude: "string",
    longitude: "string",
    enabled: "integer",
    location_address: "string",
    city: "string",
    state: "string",
    zip: "string",
    container_note: "string",
    ud_cost_share_ud: "string",
    ud_enclosure_doors_ud: "string",
    ud_last_compactor_inspection_ud: "string",
    ud_last_enclosure_inspection_ud: "string",
    ud_material_stream_ud: "string",
    color: "string",
    service_code_type: "string",
    service_code_input: "string",
    service_code: "string",
    service_date: "string",
    route_ids: "string",
    frequency_ids: "string",
    synced_at: "string"
  }
};

/**
 * `NOT NULL` columns: primary keys, required foreign keys, stored INTEGER
 * flags and `synced_at`. Every other column is nullable in storage. Each
 * entry must name a registry column — see the check below.
 */
const SNAPSHOT_NOT_NULL_COLUMNS: Record<SnapshotFieldsetResource, ReadonlySet<string>> = {
  customer: new Set(["customer_id", "enabled", "synced_at"]),
  address: new Set([
    "pickup_address_id",
    "customer_id",
    "extras_allowed",
    "enabled",
    "synced_at"
  ]),
  container: new Set([
    "container_id",
    "pickup_address_id",
    "oncall",
    "gps_locked",
    "enabled",
    "synced_at"
  ])
};

// The registry is the field authority: every registry column needs exactly
// one storage type, and every type/nullability entry must name a registry
// column. Throw at import — a drifted table must break the boot loudly,
// never publish a mistyped contract.
for (const resource of Object.keys(SNAPSHOT_FIELDSETS) as SnapshotFieldsetResource[]) {
  const registry = new Set<string>(SNAPSHOT_FIELDSETS[resource].columns);
  const typed = new Set(Object.keys(SNAPSHOT_COLUMN_BASE_TYPES[resource]));
  const missing = [...registry].filter((column) => !typed.has(column));
  const extra = [...typed].filter((column) => !registry.has(column));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `snapshot row contract drift for ${resource}: ` +
        `untyped registry columns [${missing.join(", ")}], ` +
        `non-registry typed columns [${extra.join(", ")}]`
    );
  }
  const stray = [...SNAPSHOT_NOT_NULL_COLUMNS[resource]].filter(
    (column) => !registry.has(column)
  );
  if (stray.length > 0) {
    throw new Error(
      `snapshot row contract drift for ${resource}: ` +
        `NOT NULL entries outside the registry [${stray.join(", ")}]`
    );
  }
}

/**
 * One flat row schema per resource, derived from the registry: every
 * selectable column becomes a storage-faithful integer/text property with
 * accurate nullability, and only the primary identity is required (sparse
 * output omits the rest). Registered under its own component name so list
 * `rows.items` and the by-ID 200 resolve through one shared `$ref`.
 */
function flatRowSchema(resource: SnapshotFieldsetResource) {
  const { idColumn, columns } = SNAPSHOT_FIELDSETS[resource];
  const bases = SNAPSHOT_COLUMN_BASE_TYPES[resource];
  const notNull = SNAPSHOT_NOT_NULL_COLUMNS[resource];
  const shape: Record<string, z.ZodType> = {};
  for (const column of columns) {
    let prop: z.ZodType = bases[column] === "integer" ? z.number().int() : z.string();
    if (!notNull.has(column)) {
      prop = prop.nullable();
    }
    if (column !== idColumn) {
      prop = prop.optional();
    }
    shape[column] = prop;
  }
  return z.object(shape);
}

/** Flat customer row: the by-ID 200 and the customer list `rows.items`. */
export const customerSnapshotRowSchema = flatRowSchema("customer").openapi("CustomerSnapshotRow");
/** Flat address row: the by-ID 200 and the address list `rows.items`. */
export const addressSnapshotRowSchema = flatRowSchema("address").openapi("AddressSnapshotRow");
/** Flat container row: the by-ID 200 and the container list `rows.items`. */
export const containerSnapshotRowSchema = flatRowSchema("container").openapi("ContainerSnapshotRow");

/** `total` keeps its count-free meaning: null was deliberately not computed. */
const SNAPSHOT_LIST_TOTAL_DESCRIPTION =
  "Exact row count for this page's filters. Pass includeTotal=false to skip the COUNT query: total is then null, meaning deliberately not computed rather than zero, with the same rows and nextCursor.";

/**
 * `nextCursor` is the last row's primary key when the page came back full
 * (there may be more rows), or `null` at the end of the result set — set on
 * every list response, not just cursor-driven ones, so an offset caller can
 * switch to cursor pagination once OFFSET gets expensive.
 */
const SNAPSHOT_LIST_NEXT_CURSOR_DESCRIPTION =
  "Primary-key page cursor: the last row's primary key when the page came back full (there may be more rows), or null at the end of the result set. Set on every list response, not just cursor-driven ones, so an offset caller can switch to cursor pagination once OFFSET gets expensive.";

/**
 * One list envelope per resource: `rows` items are the resource's row `$ref`,
 * and `total`/`nextCursor` keep their existing nullable semantics with their
 * meanings documented. Registered under its own component name — the three
 * lists no longer share one untyped envelope.
 */
function snapshotListEnvelope(row: z.ZodType, name: string) {
  return z
    .object({
      rows: z.array(row),
      total: z.number().int().nullable().describe(SNAPSHOT_LIST_TOTAL_DESCRIPTION),
      nextCursor: z.number().int().nullable().describe(SNAPSHOT_LIST_NEXT_CURSOR_DESCRIPTION)
    })
    .openapi(name);
}

/** Customer list 200: typed rows plus the documented count/cursor pair. */
export const customerSnapshotListResponse = snapshotListEnvelope(
  customerSnapshotRowSchema,
  "CustomerSnapshotList"
);
/** Address list 200: typed rows plus the documented count/cursor pair. */
export const addressSnapshotListResponse = snapshotListEnvelope(
  addressSnapshotRowSchema,
  "AddressSnapshotList"
);
/** Container list 200: typed rows plus the documented count/cursor pair. */
export const containerSnapshotListResponse = snapshotListEnvelope(
  containerSnapshotRowSchema,
  "ContainerSnapshotList"
);
