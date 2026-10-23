import { z } from "@hono/zod-openapi";

/**
 * Bounded primary-ID selection (`?ids=`) for the three ordinary flat
 * snapshot lists.
 *
 * Single source of truth for parsing, validating and binding the selector:
 * the customer, address and container list routes share this parser and
 * query fragment, so the contract cannot drift between resources. Each
 * route passes only its own resource key; the SQL column is fixed here and
 * every selected id travels as a bound `?` placeholder, never as SQL text.
 *
 * Parsing is strict by design: one to fifty distinct canonical ASCII
 * positive safe-integer decimals, comma-separated, with no whitespace,
 * padding, signs, fractions, exponents, empty segments or coercion. A
 * repeated `ids` key reaches zod as an array and fails the string schema.
 *
 * Validation lives in the query zod schema so the module `defaultHook`
 * (`validationFailureHook`) answers rejections with the existing anchored
 * 400 (`Invalid request query (ids)`) before the handler — and therefore
 * before any D1 work — runs.
 */

/** Maximum distinct ids in one selector: 50 plus the existing predicates stays far below D1's bind budget. */
export const SNAPSHOT_ID_SELECTION_MAX_IDS = 50;

/** Largest selectable id: ids are JSON-safe positive safe integers. */
export const SNAPSHOT_ID_SELECTION_MAX_VALUE = Number.MAX_SAFE_INTEGER;

/** Canonical positive decimal: unpadded ASCII digits, no zero, no sign. */
const CANONICAL_ID = /^[1-9][0-9]*$/;

export type SnapshotIdSelectionResource = "customer" | "address" | "container";

/**
 * Fixed resource-local primary-key columns. The container list aliases its
 * table (`FROM container_snapshot c`), so its column carries that qualifier;
 * the other two lists query their table unaliased.
 */
const ID_COLUMN: Record<SnapshotIdSelectionResource, string> = {
  customer: "customer_id",
  address: "pickup_address_id",
  container: "c.container_id"
};

/**
 * Strictly parse a raw `ids=` selector. Returns the selected ids in selector
 * order, or `null` when the selector is invalid: empty value, empty segment
 * (leading/trailing/doubled comma), non-canonical member (whitespace,
 * padding, sign, fraction, exponent, non-ASCII digits, unsafe integer),
 * duplicate id, or more than fifty members.
 */
export function parseSnapshotIdSelection(raw: string): number[] | null {
  const members = raw.split(",");
  if (members.length > SNAPSHOT_ID_SELECTION_MAX_IDS) {
    return null;
  }
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const member of members) {
    if (!CANONICAL_ID.test(member)) {
      return null;
    }
    const id = Number(member);
    if (!Number.isSafeInteger(id) || seen.has(id)) {
      return null;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * The `ids` query fragment for the three ordinary snapshot list routes.
 * Invalid selectors fail the string schema in the hook (`Invalid request
 * query (ids)`); valid selectors arrive in the handler as parsed ids.
 */
export function snapshotIdSelectionQuery() {
  return z
    .string()
    .refine((v) => parseSnapshotIdSelection(v) !== null)
    .transform((v) => parseSnapshotIdSelection(v) as number[])
    .optional()
    .describe(
      "Comma-separated primary-ID selector: 1 to 50 distinct canonical ASCII positive safe-integer " +
        "decimals (unpadded digits, at most 9007199254740991; no whitespace, signs, fractions, exponents, " +
        "empty segments or duplicate IDs, single key only). Matching rows keep the existing result order; " +
        "selected IDs with no row simply do not match. Anything else is a value-free 400 before any D1 work."
    )
    .openapi({ example: "101,103,105" });
}

/**
 * Build the bound `IN` predicate for one resource's fixed primary-key
 * column. `count` is the parsed selector length (1..50); every slot is a
 * `?` placeholder bound to a selected id by the caller.
 */
export function snapshotIdSelectionPredicate(
  resource: SnapshotIdSelectionResource,
  count: number
): string {
  const slots = Array.from({ length: count }, () => "?").join(",");
  return `${ID_COLUMN[resource]} IN (${slots})`;
}
