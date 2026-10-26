import { z } from "@hono/zod-openapi";
import { snapshotIdSelectionQuery } from "./snapshotIdSelection";
import { snapshotUpperIdQuery } from "./snapshotUpperId";
import { snapshotOrderQuery } from "./snapshotListOrder";
import { snapshotSearchQuery } from "./snapshotSearchQuery";
import { snapshotFieldsQuery } from "./sparseFieldsets";
import { customerAccountNumberQuery, customerAddressPresenceQuery, customerCommentsQuery, customerPhoneFragmentQuery } from "./snapshotCustomerSelectors";
import { snapshotExactNextQuery } from "./snapshotNextLink";
import { snapshotCountOnlyQuery, snapshotCountModeCompatible } from "./snapshotCountOnly";
import { snapshotStrictQuery } from "./snapshotStrictQuery";

/**
 * Query contract for `GET /api/v1/customer-snapshot` (operation
 * `listCustomerSnapshot`).
 *
 * Lives here instead of `src/routes/customerSnapshot.ts` so that route file
 * stays under the 800-line source guard. The route references this object
 * by name, reusing the canonical account-number, phone, comments and
 * address-presence fragments from `snapshotCustomerSelectors`; the
 * classification fragment stays private.
 */

// Stored-classification selector: exact `customer_type_id` equality, never a
// type-name lookup. Strict string validation like `snapshotUpperIdQuery`
// (coercion would accept "+2"/"2.0" spellings and round unsafe IDs); `0` is
// a literal stored value, so the regex admits a lone zero while still
// rejecting padding. A repeated key reaches zod as an array and fails the
// string schema, as do empty values and bare keys (Hono parses those as
// `""`). Rejections answer with the existing value-free anchored 400 via the
// module `defaultHook` before any D1 work, after the app-wide read-role
// bearer gate. The OpenAPI facet is an integer so machine clients discover
// the numeric contract and bounds.
const customerTypeIdQuery = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((v) => Number.isSafeInteger(Number(v)))
  .transform(Number)
  .optional()
  .describe(
    "Exact stored snapshot classification: one canonical unpadded ASCII decimal integer from 0 to 9007199254740991 " +
    "(no signs, whitespace, fractions, exponents or prefixes; a repeated customerTypeId key is a 400). " +
    "0 matches literal stored 0, never null or all rows; stored NULL classifications never match. " +
    "AND-composes with every other filter. Omit to list all classifications. " +
    "Invalid values are value-free 400s before any D1 work."
  )
  .openapi({
    type: "integer",
    minimum: 0,
    maximum: 9007199254740991,
    example: 2
  });

/**
 * Validated list query: every filter AND-composes in the handler's shared
 * WHERE, and every validated selector round-trips into follow-next Links.
 * Omitted keys preserve previous matches; unknown keys stay ignored.
 */
export const customerSnapshotListQuery = z.object({
  customerId: z.coerce.number().int().optional().openapi({ example: 345734 }),
  ids: snapshotIdSelectionQuery(),
  customerTypeId: customerTypeIdQuery,
  customerNumber: customerAccountNumberQuery.optional()
    .describe("Exact case-sensitive customer_number; opaque string of 1..100 Unicode code points, not whitespace-only. Leading zeros and supplied nonblank whitespace are preserved; quotes, % and _ are literal data. Supply this key once; AND-composes with every other filter.")
    .openapi({ example: "00042" }),
  subCustomerNumber: customerAccountNumberQuery.optional()
    .describe("Exact case-sensitive sub_customer_number; opaque string of 1..100 Unicode code points, not whitespace-only. Leading zeros and supplied nonblank whitespace are preserved; quotes, % and _ are literal data. Supply this key once; AND-composes with every other filter.")
    .openapi({ example: "North" }),
  q: snapshotSearchQuery.optional().describe("Company name substring (case-insensitive; maximum 100 Unicode code points)").openapi({ example: "ExampleCo" }),
  phone: customerPhoneFragmentQuery.optional().openapi({ example: "5550107" }),
  comments: customerCommentsQuery,
  hasAddresses: customerAddressPresenceQuery,
  enabled: z.enum(["true", "false", "any"]).optional().default("any").openapi({ example: "true" }),
  limit: z.coerce.number().int().min(1).max(500).default(50).openapi({ example: 10 }),
  offset: z.coerce.number().int().min(0).default(0).openapi({ example: 0 }),
  cursor: z.coerce
    .number()
    .int()
    .optional()
    .describe("Last customer_id from the previous page's nextCursor in the same order; takes precedence over offset. Changing direction starts a new traversal.")
    .openapi({ example: 345733 }),
  upperId: snapshotUpperIdQuery,
  includeTotal: z
    .enum(["true", "false"])
    .optional()
    .default("true")
    .describe(
      "Count opt-out: \"false\" skips the COUNT query and returns total null (deliberately not computed) with the same rows and nextCursor"
    )
    .openapi({ example: "false" }),
  exactNext: snapshotExactNextQuery,
  order: snapshotOrderQuery,
  fields: snapshotFieldsQuery("customer"), countOnly: snapshotCountOnlyQuery, strictQuery: snapshotStrictQuery
}).refine(snapshotCountModeCompatible, { path: ["countOnly"] });
