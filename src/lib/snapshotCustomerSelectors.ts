import { z } from "@hono/zod-openapi";

/** Exact enum: repeated query keys arrive as arrays and fail before D1. */
export const customerAddressPresenceQuery = z.enum(["true", "false", "any"]).optional().default("any")
  .describe('Mirrored address presence: "true" selects customers with at least one stored address, "false" selects those with none; "any" or omission adds no filter. Counts all stored addresses including disabled children; customer enabled stays independent. Absence is not proof of no upstream site and never authorizes deletion, reconciliation or sync. Send one hasAddresses=true, false or any, or omit the selector and retry.')
  .openapi({ example: "true" });

/** Indexed child lookup, no binds or join expansion; disabled addresses count. */
export function customerAddressPresencePredicate(value: "true" | "false"): string {
  return `${value === "false" ? "NOT " : ""}EXISTS (SELECT 1 FROM address_snapshot WHERE address_snapshot.customer_id = customer_snapshot.customer_id)`;
}

/**
 * Opaque-string selectors for the ordinary customer list.
 *
 * Single source of truth for the account-number and stored-phone-fragment
 * query contracts, so the lexical shape cannot drift between the route
 * schema, the served OpenAPI and the SQL below. Values stay opaque: trim
 * only detects blank input, never transforms it. The UTF-16 guard bounds
 * allocation before counting code points.
 *
 * Validation lives in the query zod schema so the module `defaultHook`
 * (`validationFailureHook`) answers rejections with the existing anchored
 * 400 (e.g. `Invalid request query (phone)`) before the handler — and
 * therefore before any D1 work — runs. A repeated key reaches zod as an
 * array and fails the string schema.
 */

// Keep account references opaque: trim only to detect blank input, never to
// transform it. The UTF-16 guard bounds allocation before counting code points.
export const customerAccountNumberQuery = z.string()
  .refine((value) => value.length <= 200 && [...value].length <= 100 && value.trim() !== "")
  .openapi({ minLength: 1, maxLength: 100 });

// Stored-phone fragments share the opaque-string lexical contract above
// (1..100 Unicode code points, single nonblank key, UTF-16 allocation guard).
// Unlike `q` (trimmed and skippable when blank), blank fragments are rejected:
// every nonblank character, including edge whitespace, is match data.
export const customerPhoneFragmentQuery = z.string()
  .refine((value) => value.length <= 200 && [...value].length <= 100 && value.trim() !== "")
  .describe("Stored phone1/phone2 fragment (ASCII case-insensitive substring; 1..100 Unicode code points, never blank). Matches stored text as stored: SQLite lower() folds ASCII A-Z only, so non-ASCII case variants (é vs É) match only on exact case; no normalization, digit-stripping, trimming, or other case folding. Quotes, %/_ and URL delimiters are literal data. Supply a single phone key; repeated keys are rejected. AND-composes with every other filter.")
  .openapi({ minLength: 1, maxLength: 100 });

/**
 * Stored-phone two-term OR predicate (the container-`q` shape): literal
 * ASCII case-insensitive substring across both stored columns (SQLite
 * lower() folds A-Z only, so non-ASCII case variants match only on exact
 * case). The caller binds
 * one value twice. No trim: validation already rejected blank input, and
 * inner whitespace is data. NULL/empty columns never match (`coalesce` +
 * `> 0`). Substring-only selections scan; see the `q`-alone boundary pinned
 * by `migrations/d1/0003_text_filter_indexes.sql` — no new index here.
 */
export function customerPhoneFragmentPredicate(): string {
  return "(instr(lower(coalesce(phone1, '')), lower(?)) > 0 OR instr(lower(coalesce(phone2, '')), lower(?)) > 0)";
}
