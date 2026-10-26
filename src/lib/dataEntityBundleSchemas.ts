import { z } from "@hono/zod-openapi";

/**
 * Typed hydrated `/api/v1/data/*` bundle declarations.
 *
 * Docs-only: these schemas render into `/openapi.json` so generated agent
 * clients stop receiving `any` for hydrated customer/address/container
 * aggregates. They are never used to parse live responses — GET handlers
 * return D1 bytes untouched (unknown extension keys pass through, key order
 * and ETags unchanged) — and they install no runtime validator.
 *
 * Column sets equal the `SNAPSHOT_FIELDSETS` registry per resource (pinned by
 * a machine parity check in the acceptance oracle); storage types mirror
 * `migrations/d1/0001_customer_snapshot.sql` and
 * `migrations/d1/0002_address_container.sql` (D1 INTEGER → integer,
 * D1 TEXT → string, nullable unless the column is NOT NULL). Every property
 * within a row is optional except its primary id, so `fields`/`fields[TYPE]`
 * projections validate. Bundle/relationship keys are always present; batch
 * payloads require full rows derived from the same column authority.
 */

const customerRowFields = {
  customer_id: z.number().int().openapi({ description: "Primary identity; always present, even on projections." }),
  customer_type_id: z.number().int().nullable().optional().openapi({ description: "Stored customer_type_id (D1 INTEGER, nullable)." }),
  company_name: z.string().nullable().optional().openapi({ description: "Stored company_name (D1 TEXT, nullable)." }),
  first_name: z.string().nullable().optional().openapi({ description: "Stored first_name (D1 TEXT, nullable)." }),
  middle_initial: z.string().nullable().optional().openapi({ description: "Stored middle_initial (D1 TEXT, nullable)." }),
  last_name: z.string().nullable().optional().openapi({ description: "Stored last_name (D1 TEXT, nullable)." }),
  name_suffix: z.string().nullable().optional().openapi({ description: "Stored name_suffix (D1 TEXT, nullable)." }),
  customer_number: z.string().nullable().optional().openapi({ description: "Stored customer_number (D1 TEXT, nullable)." }),
  sub_customer_number: z.string().nullable().optional().openapi({ description: "Stored sub_customer_number (D1 TEXT, nullable)." }),
  phone1: z.string().nullable().optional().openapi({ description: "Stored phone1 (D1 TEXT, nullable)." }),
  phone2: z.string().nullable().optional().openapi({ description: "Stored phone2 (D1 TEXT, nullable)." }),
  comments: z.string().nullable().optional().openapi({ description: "Stored comments (D1 TEXT, nullable)." }),
  enabled: z.number().int().optional().openapi({ description: "Stored enabled flag (D1 INTEGER NOT NULL); numeric, never boolean." }),
  synced_at: z.string().optional().openapi({ description: "Stored synced_at snapshot timestamp (D1 TEXT NOT NULL)." })
};

const addressRowFields = {
  pickup_address_id: z.number().int().openapi({ description: "Primary identity; always present, even on projections." }),
  customer_id: z.number().int().optional().openapi({ description: "Owning customer (D1 INTEGER NOT NULL)." }),
  route_id: z.number().int().nullable().optional().openapi({ description: "Stored route_id (D1 INTEGER, nullable)." }),
  address: z.string().nullable().optional().openapi({ description: "Stored address (D1 TEXT, nullable)." }),
  city: z.string().nullable().optional().openapi({ description: "Stored city (D1 TEXT, nullable)." }),
  state: z.string().nullable().optional().openapi({ description: "Stored state (D1 TEXT, nullable)." }),
  zip: z.string().nullable().optional().openapi({ description: "Stored zip (D1 TEXT, nullable)." }),
  franchise_id: z.string().nullable().optional().openapi({ description: "Stored franchise_id (D1 TEXT, nullable)." }),
  comments: z.string().nullable().optional().openapi({ description: "Stored comments (D1 TEXT, nullable)." }),
  extras_allowed: z.number().int().optional().openapi({ description: "Stored extras_allowed flag (D1 INTEGER NOT NULL); numeric, never boolean." }),
  enabled: z.number().int().optional().openapi({ description: "Stored enabled flag (D1 INTEGER NOT NULL); numeric, never boolean." }),
  driver_note: z.string().nullable().optional().openapi({ description: "Stored driver_note (D1 TEXT, nullable)." }),
  latitude: z.string().nullable().optional().openapi({ description: "Stored latitude (D1 TEXT, nullable)." }),
  longitude: z.string().nullable().optional().openapi({ description: "Stored longitude (D1 TEXT, nullable)." }),
  last_audit_date: z.string().nullable().optional().openapi({ description: "Stored last_audit_date (D1 TEXT, nullable)." }),
  synced_at: z.string().optional().openapi({ description: "Stored synced_at snapshot timestamp (D1 TEXT NOT NULL)." })
};

const containerRowFields = {
  container_id: z.number().int().openapi({ description: "Primary identity; always present, even on projections." }),
  pickup_address_id: z.number().int().optional().openapi({ description: "Owning address (D1 INTEGER NOT NULL)." }),
  container_type_id: z.number().int().nullable().optional().openapi({ description: "Stored container_type_id (D1 INTEGER, nullable)." }),
  serial_number: z.string().nullable().optional().openapi({ description: "Stored serial_number (D1 TEXT, nullable)." }),
  rfid: z.string().nullable().optional().openapi({ description: "Stored rfid (D1 TEXT, nullable)." }),
  oncall: z.number().int().optional().openapi({ description: "Stored oncall flag (D1 INTEGER NOT NULL); numeric, never boolean." }),
  event_code: z.string().nullable().optional().openapi({ description: "Stored event_code (D1 TEXT, nullable)." }),
  gps_locked: z.number().int().optional().openapi({ description: "Stored gps_locked flag (D1 INTEGER NOT NULL); numeric, never boolean." }),
  latitude: z.string().nullable().optional().openapi({ description: "Stored latitude (D1 TEXT, nullable)." }),
  longitude: z.string().nullable().optional().openapi({ description: "Stored longitude (D1 TEXT, nullable)." }),
  enabled: z.number().int().optional().openapi({ description: "Stored enabled flag (D1 INTEGER NOT NULL); numeric, never boolean." }),
  location_address: z.string().nullable().optional().openapi({ description: "Stored location_address (D1 TEXT, nullable)." }),
  city: z.string().nullable().optional().openapi({ description: "Stored city (D1 TEXT, nullable)." }),
  state: z.string().nullable().optional().openapi({ description: "Stored state (D1 TEXT, nullable)." }),
  zip: z.string().nullable().optional().openapi({ description: "Stored zip (D1 TEXT, nullable)." }),
  container_note: z.string().nullable().optional().openapi({ description: "Stored container_note (D1 TEXT, nullable)." }),
  ud_cost_share_ud: z.string().nullable().optional().openapi({ description: "Stored ud_cost_share_ud (D1 TEXT, nullable)." }),
  ud_enclosure_doors_ud: z.string().nullable().optional().openapi({ description: "Stored ud_enclosure_doors_ud (D1 TEXT, nullable)." }),
  ud_last_compactor_inspection_ud: z.string().nullable().optional().openapi({ description: "Stored ud_last_compactor_inspection_ud (D1 TEXT, nullable)." }),
  ud_last_enclosure_inspection_ud: z.string().nullable().optional().openapi({ description: "Stored ud_last_enclosure_inspection_ud (D1 TEXT, nullable)." }),
  ud_material_stream_ud: z.string().nullable().optional().openapi({ description: "Stored ud_material_stream_ud (D1 TEXT, nullable)." }),
  color: z.string().nullable().optional().openapi({ description: "Stored color (D1 TEXT, nullable)." }),
  service_code_type: z.string().nullable().optional().openapi({ description: "Stored service_code_type (D1 TEXT, nullable)." }),
  service_code_input: z.string().nullable().optional().openapi({ description: "Stored service_code_input (D1 TEXT, nullable)." }),
  service_code: z.string().nullable().optional().openapi({ description: "Stored service_code (D1 TEXT, nullable)." }),
  service_date: z.string().nullable().optional().openapi({ description: "Stored service_date (D1 TEXT, nullable)." }),
  route_ids: z.string().nullable().optional().openapi({ description: "Stored route_ids (D1 TEXT, nullable)." }),
  frequency_ids: z.string().nullable().optional().openapi({ description: "Stored frequency_ids (D1 TEXT, nullable)." }),
  synced_at: z.string().optional().openapi({ description: "Stored synced_at snapshot timestamp (D1 TEXT NOT NULL)." })
};

/** One customer snapshot row: exactly the registry columns, only the id required. */
export const snapshotCustomerRowSchema = z.object(customerRowFields).openapi("SnapshotCustomerRow", {
  description: "One customer_snapshot row. Only customer_id is required; every other stored column is optional so field projections validate."
});

/** One address snapshot row: exactly the registry columns, only the id required. */
export const snapshotAddressRowSchema = z.object(addressRowFields).openapi("SnapshotAddressRow", {
  description: "One address_snapshot row. Only pickup_address_id is required; every other stored column is optional so field projections validate."
});

/** One container snapshot row: exactly the registry columns, only the id required. */
export const snapshotContainerRowSchema = z.object(containerRowFields).openapi("SnapshotContainerRow", {
  description: "One container_snapshot row. Only container_id is required; every other stored column is optional so field projections validate."
});

/**
 * An address nested under a customer bundle: the registry columns plus its
 * containers. The standalone row schema stays container-free so its property
 * set still equals the registry.
 */
export const snapshotAddressWithContainersSchema = z.object({
  ...addressRowFields,
  containers: z.array(snapshotContainerRowSchema).openapi({
    description: "Containers homed at this address, in container_id order; empty when none are stored."
  })
}).openapi("SnapshotAddressWithContainers", {
  description: "One address_snapshot row nested in a customer bundle. pickup_address_id and containers are required; other row columns may be projected out."
});

/** Single-ID 200: root customer plus nested addresses with containers. */
export const hydratedCustomerBundleSchema = z.strictObject({
  customer: snapshotCustomerRowSchema,
  addresses: z.array(snapshotAddressWithContainersSchema)
}).openapi("HydratedCustomerBundle", {
  description: "Hydrated customer aggregate: required root customer and addresses, each with containers. Row columns may be projected out, but primary ids and relationship keys remain."
});

/** Single-ID 200: root address plus its customer and containers. */
export const hydratedAddressBundleSchema = z.strictObject({
  address: snapshotAddressRowSchema,
  customer: z.object(customerRowFields).nullable().openapi({
    description: "Owning customer row, or null when the parent is missing (stale/racing reads)."
  }),
  containers: z.array(snapshotContainerRowSchema)
}).openapi("HydratedAddressBundle", {
  description: "Hydrated address aggregate: required address, customer and containers. Row columns may be projected out; primary ids remain. A missing parent is null and empty children are []."
});

/** Single-ID 200: root container plus its address and customer. */
export const hydratedContainerBundleSchema = z.strictObject({
  container: snapshotContainerRowSchema,
  address: z.object(addressRowFields).nullable().openapi({
    description: "Owning address row, or null when the parent is missing (stale/racing reads)."
  }),
  customer: z.object(customerRowFields).nullable().openapi({
    description: "Owning customer row, or null when the parent is missing (stale/racing reads)."
  })
}).openapi("HydratedContainerBundle", {
  description: "Hydrated container aggregate: required container, address and customer. Row columns may be projected out; primary ids remain. Missing parents are null."
});

// Batch does not support fieldsets. Intersect the stable bundle references with
// full rows derived from the same schemas, never a second column registry.
// Inline nullable objects: OpenAPI 3.0 allOf($ref, nullable) does not make the
// referenced non-null object nullable for independent schema consumers.
const fullCustomerRow = z.object(customerRowFields).required();
const fullAddressRow = z.object(addressRowFields).required();
const fullContainerRow = z.object(containerRowFields).required();
const fullCustomerBundle = z.intersection(hydratedCustomerBundleSchema, z.object({
  customer: fullCustomerRow,
  addresses: z.array(fullAddressRow.extend({ containers: z.array(fullContainerRow) }))
}));
const fullAddressBundle = z.intersection(hydratedAddressBundleSchema, z.object({
  address: fullAddressRow,
  customer: fullCustomerRow.nullable(),
  containers: z.array(fullContainerRow)
}));
const fullContainerBundle = z.intersection(hydratedContainerBundleSchema, z.object({
  container: fullContainerRow,
  address: fullAddressRow.nullable(),
  customer: fullCustomerRow.nullable()
}));
const batchId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const missingEntry = z.strictObject({ id: batchId, found: z.literal(false) });
const batchDescription =
  "Batch ids response: 1..50 entries in request order, preserving duplicates. " +
  "found=true carries the full hydrated bundle; found=false carries only id/found. " +
  "No fieldsets, no-store, no ETag or conditional 304; all-missing is still 200.";

export const hydratedCustomerBatchSchema = z.strictObject({
  entries: z.array(z.discriminatedUnion("found", [
    z.strictObject({ id: batchId, found: z.literal(true), customer: fullCustomerBundle }),
    missingEntry
  ])).min(1).max(50)
}).openapi("HydratedCustomerBatch", { description: batchDescription });

export const hydratedAddressBatchSchema = z.strictObject({
  entries: z.array(z.discriminatedUnion("found", [
    z.strictObject({ id: batchId, found: z.literal(true), address: fullAddressBundle }),
    missingEntry
  ])).min(1).max(50)
}).openapi("HydratedAddressBatch", { description: batchDescription });

export const hydratedContainerBatchSchema = z.strictObject({
  entries: z.array(z.discriminatedUnion("found", [
    z.strictObject({ id: batchId, found: z.literal(true), container: fullContainerBundle }),
    missingEntry
  ])).min(1).max(50)
}).openapi("HydratedContainerBatch", { description: batchDescription });

export const hydratedCustomerResponseSchema = z.union([hydratedCustomerBundleSchema, hydratedCustomerBatchSchema]);
export const hydratedAddressResponseSchema = z.union([hydratedAddressBundleSchema, hydratedAddressBatchSchema]);
export const hydratedContainerResponseSchema = z.union([hydratedContainerBundleSchema, hydratedContainerBatchSchema]);

export type SnapshotCustomerRow = z.infer<typeof snapshotCustomerRowSchema>;
export type SnapshotAddressRow = z.infer<typeof snapshotAddressRowSchema>;
export type SnapshotContainerRow = z.infer<typeof snapshotContainerRowSchema>;
export type HydratedCustomerBundle = z.infer<typeof hydratedCustomerBundleSchema>;
export type HydratedAddressBundle = z.infer<typeof hydratedAddressBundleSchema>;
export type HydratedContainerBundle = z.infer<typeof hydratedContainerBundleSchema>;
