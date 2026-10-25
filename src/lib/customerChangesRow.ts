import { z } from "@hono/zod-openapi";

/**
 * Typed customer delta row for `GET /api/v1/customer-snapshot/changes`.
 *
 * Declaration-only: the feed handler keeps serving raw D1 rows untouched —
 * response schemas install no runtime validator — while agents discover
 * storage-faithful integer/text/null types from `/openapi.json` instead of
 * guessing from an untyped record. Same rows, truthful types.
 *
 * Property set mirrors `SNAPSHOT_FIELDSETS.customer`
 * (`src/lib/sparseFieldsets.ts`) exactly: every stored customer column from
 * `migrations/d1/0001_customer_snapshot.sql`, in SELECT order. The mounted
 * document's property set is proven equal to that registry by
 * `test/typedCustomerChangesDelta.acceptance.test.ts` — never by importing
 * this declaration, so the check stays independent of this source.
 *
 * Only the replay/cursor identities (`customer_id`, `synced_at`) are
 * required: this schema describes the full delta row. Sparse `fields=`
 * pages project to the resource id plus the selector (`synced_at` omitted
 * unless selected), so validate sparse pages against the projection, not
 * this full-row shape. Other columns are optional with storage-faithful
 * nullability when present. Stored flags stay
 * integers (`enabled` is `0`/`1`, never boolean). Text stays text: no
 * format, pattern, enum, range or safe-integer promises the writers never
 * made — `synced_at` is deliberately a plain string, not a datetime.
 */
export const customerSnapshotChangesRow = z
  .object({
    customer_id: z.number().int(),
    customer_type_id: z.number().int().nullable().optional(),
    company_name: z.string().nullable().optional(),
    first_name: z.string().nullable().optional(),
    middle_initial: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    name_suffix: z.string().nullable().optional(),
    customer_number: z.string().nullable().optional(),
    sub_customer_number: z.string().nullable().optional(),
    phone1: z.string().nullable().optional(),
    phone2: z.string().nullable().optional(),
    comments: z.string().nullable().optional(),
    enabled: z.number().int().optional(),
    synced_at: z.string()
  })
  .openapi("CustomerSnapshotChangesRow");

export type CustomerSnapshotChangesRow = z.infer<typeof customerSnapshotChangesRow>;
