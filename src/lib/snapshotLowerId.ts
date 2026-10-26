import { z } from "@hono/zod-openapi";

/**
 * Caller-held inclusive ID floor (`?lowerId=`) for the three ordinary
 * snapshot list GETs (`/api/v1/customer|address|container-snapshot`).
 *
 * One canonical ASCII decimal integer, positive and safe (`1` through
 * `9007199254740991`), unpadded, with no signs, whitespace, fractions,
 * exponents or prefixes. The handler binds it as a fixed
 * `<resource-primary-key> >= ?` predicate into both the page `SELECT` and the
 * `COUNT`, so lower-ID arrivals outside the window cannot extend a
 * traversal the caller chose to bound. In-window arrivals after the first
 * page, updates and deletions remain visible: numeric IDs are not timestamps,
 * and this promises neither snapshot isolation, exact-once delivery nor
 * automatic watermark discovery. Omission preserves existing behavior and
 * runs no `MIN` query.
 *
 * Strict string validation, never `z.coerce.number()`: coercion accepts
 * non-canonical spellings (`" 4"`, `"+4"`, `"4.0"`, `"0x4"`) and can round
 * unsafe IDs before the handler sees them. A repeated `lowerId` key reaches
 * zod as an array and fails the string schema, as does an empty value or a
 * bare key (Hono parses those as `""`). Rejections answer with the existing
 * value-free anchored 400 via the module `defaultHook` before any D1 work,
 * after the app-wide read-role bearer gate in `app.ts` (which runs first, so
 * 401 precedes 400).
 *
 * The OpenAPI facet is an integer (`minimum: 1`, `maximum: 2^53 - 1`) even
 * though runtime validation is string-based: the `.openapi()` metadata below
 * overrides the generated string type so machine clients discover the numeric
 * contract, bounds and correction guidance.
 */
export const SNAPSHOT_LOWER_ID_MIN = 1;
export const SNAPSHOT_LOWER_ID_MAX = 9007199254740991;

const SNAPSHOT_LOWER_ID_GUIDANCE =
  "Inclusive caller-held ID floor: only rows whose resource primary key is " +
  "at or above this value are listed and counted. Send one canonical unpadded " +
  "ASCII decimal integer from 1 to 9007199254740991 (no signs, whitespace, " +
  "fractions, exponents or prefixes; a repeated lowerId key is a 400). " +
  "Lower-ID arrivals outside the window cannot extend the traversal; " +
  "in-window arrivals, updates and deletions remain visible. Omit to " +
  "page from the start of the table. Invalid values are value-free 400s before any D1 work.";

/**
 * Shared `lowerId` query fragment for the three ordinary snapshot lists.
 * Valid values arrive in the handler as a plain `number`; omission arrives
 * as `undefined` and must not add any predicate or query.
 */
export const snapshotLowerIdQuery = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .refine((v) => Number.isSafeInteger(Number(v)))
  .transform(Number)
  .optional()
  .describe(SNAPSHOT_LOWER_ID_GUIDANCE)
  .openapi({
    type: "integer",
    minimum: SNAPSHOT_LOWER_ID_MIN,
    maximum: SNAPSHOT_LOWER_ID_MAX,
    example: 4
  });
