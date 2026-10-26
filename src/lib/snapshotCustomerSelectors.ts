import { z } from "@hono/zod-openapi";
import { snapshotSearchQuery } from "./snapshotSearchQuery";

/** Validate raw length before trimming; blank means no comments predicate. */
export const customerCommentsQuery = snapshotSearchQuery
  .transform((value) => value.trim() || undefined).optional()
  .describe("Literal substring of stored customer comments only; q searches company_name, first_name or last_name. Maximum 100 Unicode code points before trimming boundary whitespace; blank means omitted. Send a single comments key; repeated or overlength values fail before D1. SQLite lower() folds ASCII A-Z only: non-ASCII case and Unicode spelling remain exact; quotes, % and _ are literal, never LIKE wildcards. Null stored comments never match a nonblank fragment. AND-composes with all other filters. Substring-only reads may scan; no dedicated comments index or latency guarantee. GET is an idempotent local-read; --dry-run is not applicable.")
  .openapi({ type: "string", maxLength: 100, example: "handoff" });

/** Exact enum: repeated query keys arrive as arrays and fail before D1. */
export const customerAddressPresenceQuery = z.enum(["true", "false", "any"]).optional().default("any")
  .describe('Mirrored address presence: "true" selects customers with at least one stored address, "false" selects those with none; "any" or omission adds no filter. Counts all stored addresses including disabled children; customer enabled stays independent. Absence is not proof of no upstream site and never authorizes deletion, reconciliation or sync. Send one hasAddresses=true, false or any, or omit the selector and retry.')
  .openapi({ example: "true" });

/** Indexed child lookup, no binds or join expansion; disabled addresses count. */
export function customerAddressPresencePredicate(value: "true" | "false"): string {
  return `${value === "false" ? "NOT " : ""}EXISTS (SELECT 1 FROM address_snapshot WHERE address_snapshot.customer_id = customer_snapshot.customer_id)`;
}

/** Exact enum: repeated query keys arrive as arrays and fail before D1. */
export const customerContainerPresenceQuery = z.enum(["true", "false", "any"]).optional().default("any")
  .describe('Mirrored container presence: "true" selects customers with at least one stored container reachable through any stored address they own, "false" selects those with none; "any" or omission adds no filter. Counts all stored addresses and containers including disabled rows; customer enabled stays independent. Presence is global to the customer across all owned addresses, never same-site membership for any separate site cohort. Absence is not proof of no upstream equipment or active service and never authorizes deletion, reconciliation or sync. Send one hasContainers=true, false or any, or omit the selector and retry.')
  .openapi({ example: "true" });

/** Nested correlated grandchild lookup, no binds or join expansion; disabled rows count. */
export function customerContainerPresencePredicate(value: "true" | "false"): string {
  return `${value === "false" ? "NOT " : ""}EXISTS (SELECT 1 FROM address_snapshot WHERE address_snapshot.customer_id = customer_snapshot.customer_id AND EXISTS (SELECT 1 FROM container_snapshot WHERE container_snapshot.pickup_address_id = address_snapshot.pickup_address_id))`;
}

/** Exact stored enabled state, independent of the customer's own enabled flag. */
export const customerEnabledAddressPresenceQuery = z.enum(["true", "false", "any"]).optional().default("any")
  .describe('Mirrored enabled-address presence: "true" selects customers with at least one stored address whose enabled is exactly 1; "false" is the exact NOT EXISTS complement, including zero stored addresses and addresses all non-1. Noncanonical stored enabled values never count as enabled. "any" or omission adds no predicate. Customer enabled stays independent. Global across owned sites, not same-site membership for a separate cohort. Mirrored report state is not current account eligibility, live service status, deployment proof or authorization. Send one hasEnabledAddresses=true, false or any, or omit the selector and retry.')
  .openapi({ example: "true" });

export const customerEnabledContainerPresenceQuery = z.enum(["true", "false", "any"]).optional().default("any")
  .describe('Mirrored enabled-container presence: "true" selects customers with at least one stored container whose enabled is exactly 1 reachable through any stored address they own; the intermediate address enabled state is irrelevant. "false" is the exact NOT EXISTS complement, including zero reachable containers and reachable containers all non-1. Noncanonical stored enabled values never count as enabled. "any" or omission adds no predicate. Customer enabled stays independent. Global across owned sites, not same-site membership for a separate cohort. Mirrored report state is not current account eligibility, live service status, deployment proof or authorization. Send one hasEnabledContainers=true, false or any, or omit the selector and retry.')
  .openapi({ example: "true" });

/** Indexed correlated child lookup; false includes zero children and all-non-1 children. */
export function customerEnabledAddressPresencePredicate(value: "true" | "false"): string {
  return `${value === "false" ? "NOT " : ""}EXISTS (SELECT 1 FROM address_snapshot WHERE address_snapshot.customer_id = customer_snapshot.customer_id AND address_snapshot.enabled = 1)`;
}

/** Indexed grandchild reachability: the intermediate address need not be enabled. */
export function customerEnabledContainerPresencePredicate(value: "true" | "false"): string {
  return `${value === "false" ? "NOT " : ""}EXISTS (SELECT 1 FROM address_snapshot WHERE address_snapshot.customer_id = customer_snapshot.customer_id AND EXISTS (SELECT 1 FROM container_snapshot WHERE container_snapshot.pickup_address_id = address_snapshot.pickup_address_id AND container_snapshot.enabled = 1))`;
}

/**
 * Ordinary customer-list child-cohort scopes: `addressRouteId`,
 * `addressFranchiseId` and `addressEnabled`.
 *
 * Single source of truth for the lexical contracts, so the shape cannot
 * drift between the route schema, the served OpenAPI and the SQL below.
 * The route-id policy mirrors the address `routeId` contract (canonical
 * unpadded ASCII safe integer, literal zero); the franchise policy mirrors
 * the customer opaque-string contract (trim only detects blank input, never
 * transforms it; the UTF-16 guard bounds allocation before counting code
 * points). Validation lives in the query zod schema so the module
 * `defaultHook` (`validationFailureHook`) answers rejections with the
 * existing anchored 400 before the handler — and therefore before any D1
 * work — runs. A repeated key reaches zod as an array and fails the schema.
 */
export const customerAddressRouteIdQuery = z.string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .refine((value) => Number.isSafeInteger(Number(value)) && String(Number(value)) === value)
  .transform(Number)
  .optional()
  .describe("Exact child route_id equality on the SAME stored address as the other cohort scopes: one canonical unpadded ASCII decimal safe integer, 0..9007199254740991. Zero matches literal stored 0, never nulls. No signs, whitespace, fractions, exponents or repeated keys. Send one value or omit it and retry.")
  .openapi({ type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, example: 7 });

export const customerAddressFranchiseIdQuery = z.string()
  .refine((value) => value.length <= 200 && [...value].length <= 100 && value.trim() !== "")
  .optional()
  .describe("Opaque case-sensitive exact child franchise_id equality on the SAME stored address as the other cohort scopes: 1..100 Unicode code points containing a non-whitespace character. Leading zeros and significant whitespace are preserved, never trimmed or normalized; quotes, % and _ are literal data. URL-encode one value or omit it and retry; repeated keys are invalid.")
  .openapi({ type: "string", minLength: 1, maxLength: 100, example: "001" });

export const customerAddressEnabledQuery = z.enum(["true", "false", "any"]).optional().default("any")
  .describe('Child address enabled state on the SAME stored address as the other cohort scopes: "true" requires stored enabled = 1, "false" requires stored 0; "any" or omission adds no state scope. Customer enabled stays independent. All stored children, including disabled, remain eligible unless this scope explicitly filters them. Send one addressEnabled=true, false or any, or omit the selector and retry.')
  .openapi({ example: "true" });

export type CustomerAddressCohortScope = {
  addressRouteId?: number;
  addressFranchiseId?: string;
  addressEnabled: "true" | "false" | "any";
};

/**
 * One customer-correlated EXISTS over the stored child addresses: route,
 * franchise and enabled-state scopes AND inside the same child, so split
 * scopes across different children never match and duplicate matching sites
 * never duplicate the customer. Null stored scalars never match equality.
 * Returns null when no scope is effective (omitted scalars, or
 * `addressEnabled=any` alone), leaving the caller's SQL/binds untouched.
 * The caller appends `binds` in order; COUNT and page share both.
 */
export function customerAddressCohortPredicate(scope: CustomerAddressCohortScope): { sql: string; binds: unknown[] } | null {
  const predicates: string[] = [];
  const binds: unknown[] = [];
  if (scope.addressRouteId !== undefined) {
    predicates.push("route_id = ?");
    binds.push(scope.addressRouteId);
  }
  if (scope.addressFranchiseId !== undefined) {
    predicates.push("franchise_id = ?");
    binds.push(scope.addressFranchiseId);
  }
  if (scope.addressEnabled !== "any") {
    predicates.push("enabled = ?");
    binds.push(scope.addressEnabled === "true" ? 1 : 0);
  }
  if (predicates.length === 0) return null;
  return {
    sql: `EXISTS (SELECT 1 FROM address_snapshot WHERE address_snapshot.customer_id = customer_snapshot.customer_id AND ${predicates.join(" AND ")})`,
    binds
  };
}

/**
 * Stored phone-slot presence selectors for the ordinary customer list.
 *
 * One shared enum shape so the two slots cannot drift; per-slot aliases
 * below name their stored column and carry the fixed remedy. Present means
 * stored `phoneN IS NOT NULL AND phoneN <> ''`; absent is the exact
 * null-or-empty complement — whitespace-only stored text counts as present.
 * No trimming, normalization, digit-stripping, number validation, consent or
 * reachability is inferred. Validation lives in the query zod schema so the
 * module `defaultHook` answers rejections before any D1 work runs; a
 * repeated key reaches zod as an array and fails the enum schema.
 */
const customerPhonePresenceQuery = z.enum(["true", "false", "any"]).optional().default("any");

/** Primary stored-phone (phone1) presence; see the shared contract above. */
export const customerPhone1PresenceQuery = customerPhonePresenceQuery
  .describe('Stored primary-phone presence: "true" selects rows where stored phone1 is present (IS NOT NULL AND <> \'\'), "false" selects the exact null-or-empty complement; "any" or omission adds no filter. Whitespace-only stored text counts as present: no trimming, normalization, number validation or digit-stripping. Stored presence is NOT a valid number, preferred channel, contact consent, deliverability or reachability. AND-composes with every other filter. Presence-only selections may scan; no phone index exists and none is added. Send one hasPhone1=true, false or any, or omit the selector and retry.')
  .openapi({ example: "false" });

/** Secondary stored-phone (phone2) presence; see the shared contract above. */
export const customerPhone2PresenceQuery = customerPhonePresenceQuery
  .describe('Stored secondary-phone presence: "true" selects rows where stored phone2 is present (IS NOT NULL AND <> \'\'), "false" selects the exact null-or-empty complement; "any" or omission adds no filter. Whitespace-only stored text counts as present: no trimming, normalization, number validation or digit-stripping. Stored presence is NOT a valid number, preferred channel, contact consent, deliverability or reachability. AND-composes with every other filter. Presence-only selections may scan; no phone index exists and none is added. Send one hasPhone2=true, false or any, or omit the selector and retry.')
  .openapi({ example: "false" });

/**
 * Stored phone-slot presence predicate (no binds): the caller supplies the
 * slot column. Present is stored `phoneN IS NOT NULL AND phoneN <> ''`;
 * absent is the exact null-or-empty complement, parenthesized so it ANDs
 * safely with sibling predicates. Whitespace-only text stays present.
 */
export function customerPhonePresencePredicate(slot: "phone1" | "phone2", value: "true" | "false"): string {
  return value === "true" ? `${slot} IS NOT NULL AND ${slot} <> ''` : `(${slot} IS NULL OR ${slot} = '')`;
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
