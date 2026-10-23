import { z } from "@hono/zod-openapi";

/**
 * Sparse fieldsets (`?fields=`) for the six flat snapshot reads.
 *
 * Single source of truth for which response keys a client may select: each
 * whitelist below mirrors the route's D1 SELECT list exactly (id + stored
 * business columns + `synced_at`). Anything not listed here — `rowid`,
 * cross-resource columns, erasure-tombstone columns — is not selectable and
 * not probeable: an unknown name is a fixed value-free 400, identical for
 * every rejected selector, so rejection reveals nothing about other tables.
 *
 * Parsing is strict by design: exact snake_case names, comma-separated, no
 * whitespace trimming, no case folding, no empty segments, no duplicates, and
 * a single `fields` key (a repeated key reaches zod as an array and fails the
 * string schema). The resource id is always present in responses even when
 * omitted from the selector; naming it explicitly is not a duplicate.
 *
 * Validation lives in the query zod schema so the module `defaultHook`
 * (`validationFailureHook`) answers rejections with the existing anchored
 * 400 before the handler — and therefore before any D1 work — runs.
 */

export type SnapshotFieldsetResource = "customer" | "address" | "container";

/** Exact `SELECT` column list of the customer snapshot list/detail reads. */
const CUSTOMER_SNAPSHOT_FIELDS = [
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

/** Exact `SELECT` column list of the address snapshot list/detail reads. */
const ADDRESS_SNAPSHOT_FIELDS = [
  "pickup_address_id",
  "customer_id",
  "route_id",
  "address",
  "city",
  "state",
  "zip",
  "franchise_id",
  "comments",
  "extras_allowed",
  "enabled",
  "driver_note",
  "latitude",
  "longitude",
  "last_audit_date",
  "synced_at"
] as const;

/** Exact `SELECT` column list of the container snapshot list/detail reads. */
const CONTAINER_SNAPSHOT_FIELDS = [
  "container_id",
  "pickup_address_id",
  "container_type_id",
  "serial_number",
  "rfid",
  "oncall",
  "event_code",
  "gps_locked",
  "latitude",
  "longitude",
  "enabled",
  "location_address",
  "city",
  "state",
  "zip",
  "container_note",
  "ud_cost_share_ud",
  "ud_enclosure_doors_ud",
  "ud_last_compactor_inspection_ud",
  "ud_last_enclosure_inspection_ud",
  "ud_material_stream_ud",
  "color",
  "service_code_type",
  "service_code_input",
  "service_code",
  "service_date",
  "route_ids",
  "frequency_ids",
  "synced_at"
] as const;

export const SNAPSHOT_FIELDSETS: Record<
  SnapshotFieldsetResource,
  { idColumn: string; columns: readonly string[] }
> = {
  customer: { idColumn: "customer_id", columns: CUSTOMER_SNAPSHOT_FIELDS },
  address: { idColumn: "pickup_address_id", columns: ADDRESS_SNAPSHOT_FIELDS },
  container: { idColumn: "container_id", columns: CONTAINER_SNAPSHOT_FIELDS }
};

const FIELDS_EXAMPLES: Record<SnapshotFieldsetResource, string> = {
  customer: "company_name,phone1",
  address: "city,address",
  container: "serial_number,location_address"
};

/**
 * Strictly parse a raw `fields=` selector. Returns the requested column names
 * in selector order, or `null` when the selector is invalid: empty value,
 * empty segment (leading/trailing/doubled comma), unknown name, or duplicate.
 * Matching is exact — no trimming, no case folding — so `" Company_Name "`
 * fails closed instead of guessing.
 */
export function parseSnapshotFields(
  resource: SnapshotFieldsetResource,
  raw: string
): string[] | null {
  const allowed = new Set<string>(SNAPSHOT_FIELDSETS[resource].columns);
  const seen = new Set<string>();
  const names = raw.split(",");
  for (const name of names) {
    if (name === "" || seen.has(name) || !allowed.has(name)) {
      return null;
    }
    seen.add(name);
  }
  return names;
}

/**
 * Trim a full D1 row to exactly the requested columns plus the resource id.
 * The id leads and is always present even when omitted from the selector;
 * an explicitly requested id collapses into that same key (it appeared once
 * in the selector, so it was never a duplicate).
 */
export function projectSnapshotRow(
  resource: SnapshotFieldsetResource,
  row: Record<string, unknown>,
  columns: string[]
): Record<string, unknown> {
  const idColumn = SNAPSHOT_FIELDSETS[resource].idColumn;
  const out: Record<string, unknown> = { [idColumn]: row[idColumn] };
  for (const column of columns) {
    if (column !== idColumn) {
      out[column] = row[column];
    }
  }
  return out;
}

/**
 * The `fields` query fragment for one resource's list and by-id routes.
 * Invalid selectors fail the string schema in the hook (`Invalid request
 * query (fields)`); valid selectors arrive in the handler as parsed columns.
 */
export function snapshotFieldsQuery(resource: SnapshotFieldsetResource) {
  return z
    .string()
    .refine((v) => parseSnapshotFields(resource, v) !== null)
    .transform((v) => parseSnapshotFields(resource, v) as string[])
    .optional()
    .describe(
      "Comma-separated sparse fieldset: exact stored column names from this route's allowlist " +
        "(case-sensitive, no spaces, no empty segments, no duplicates, single key only). " +
        "Response rows contain exactly these fields plus the resource id, which is always " +
        "present even when omitted. Unknown names are a value-free 400 before any D1 work."
    )
    .openapi({ example: FIELDS_EXAMPLES[resource] });
}
